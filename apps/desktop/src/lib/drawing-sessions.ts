import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawElement,
  OrderedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import { deleteEntry } from "./tauri";
import { saveDrawing, type DrawingScene } from "./drawings";

// No subscriptions or timers: drawing events only replace these references.
export function createDrawingSession(path: string, initial: DrawingScene) {
  let elements: readonly ExcalidrawElement[] = initial.elements;
  let appState = initial.appState;
  let files = initial.files;
  let armed = elements.length === 0;
  const serialize = () =>
    JSON.stringify({
      elements: elements.filter((element) => !element.isDeleted),
      background: appState.viewBackgroundColor,
      files,
    });
  let saved = serialize();
  let queue = Promise.resolve();

  return {
    change(next: readonly OrderedExcalidrawElement[], state: AppState, images: BinaryFiles) {
      if (state.isLoading || (!armed && next.length === 0)) return;
      armed = true;
      elements = next;
      appState = state;
      files = images;
    },
    settled: () => queue,
    save(this: void): Promise<void> {
      // Capture before yielding: Excalidraw mutates elements during a stroke.
      const signature = serialize();
      const snapshot = JSON.parse(signature) as {
        elements: DrawingScene["elements"];
        files: BinaryFiles;
      };
      const scene = { ...snapshot, appState: { ...appState } };
      const result = queue
        .catch(() => {})
        .then(async () => {
          if (signature === saved) return;
          await saveDrawing(path, scene);
          saved = signature;
        });
      queue = result;
      return result;
    },
  };
}

type SessionEntry = { save: () => Promise<void>; settled: () => Promise<void>; retired: boolean };
const sessions = new Map<string, Set<SessionEntry>>();

function saveEntry(path: string, entries: Set<SessionEntry>, entry: SessionEntry) {
  return entry.save().then(() => {
    if (!entry.retired) return;
    entries.delete(entry);
    if (entries.size === 0 && sessions.get(path) === entries) sessions.delete(path);
  });
}

export function registerDrawingSession(
  path: string,
  save: () => Promise<void>,
  settled: () => Promise<void> = () => Promise.resolve(),
) {
  const entries = sessions.get(path) ?? new Set<SessionEntry>();
  const entry = { save, settled, retired: false };
  entries.add(entry);
  sessions.set(path, entries);
  return () => {
    if (!entries.has(entry)) return;
    // Keep a retiring session until its write succeeds, including retries.
    entry.retired = true;
    void saveEntry(path, entries, entry).catch(reportDrawingSaveError);
  };
}

export function hasDrawingSession(path?: string): boolean {
  return path
    ? [...sessions.keys()].some((key) => key === path || key.startsWith(`${path}/`))
    : sessions.size > 0;
}

export async function saveDrawingSessions(path?: string): Promise<void> {
  const targets = path
    ? [...sessions.entries()].filter(([key]) => key === path || key.startsWith(`${path}/`))
    : [...sessions.entries()];
  const results = await Promise.allSettled(
    targets.flatMap(([target, entries]) =>
      [...entries].map((entry) => saveEntry(target, entries, entry)),
    ),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

export function reportDrawingSaveError(error: unknown) {
  console.error("Drawing save failed", error);
  window.alert(
    `The drawing could not be saved. Your changes are still in memory. Try saving again.\n\n${String(error)}`,
  );
}

// A deleted or moved path must never be recreated by an unmount cleanup.
export function discardDrawingSessions(prefix: string) {
  for (const [path, entries] of sessions) {
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      entries.clear();
      sessions.delete(path);
    }
  }
}

let freezeCount = 0;
let previousInert = false;
export function freezeDrawingInput() {
  if (typeof document === "undefined") return () => {};
  if (freezeCount++ === 0) {
    previousInert = document.body.inert;
    document.body.inert = true;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--freezeCount === 0) document.body.inert = previousInert;
  };
}

export async function withDrawingSaveBoundary<T>(
  operation: () => T | Promise<T>,
  path?: string,
): Promise<T> {
  if (!hasDrawingSession(path)) return operation();
  const release = freezeDrawingInput();
  try {
    await saveDrawingSessions(path);
    return await operation();
  } finally {
    release();
  }
}

export async function deleteEntryAfterDrawingWrites(path: string): Promise<void> {
  const release = freezeDrawingInput();
  try {
    const entries = [...sessions.entries()].filter(
      ([key]) => key === path || key.startsWith(`${path}/`),
    );
    // An earlier Cmd+S must finish before deletion. Failed writes cannot recreate
    // the file either, and must not block an explicit request to delete it.
    await Promise.allSettled(
      entries.flatMap(([, set]) => [...set].map((entry) => entry.settled())),
    );
    await deleteEntry(path);
    discardDrawingSessions(path);
  } finally {
    release();
  }
}
