import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawElement,
  OrderedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import { deleteEntry } from "./tauri";
import { saveDrawing, type DrawingScene } from "./drawings";

/**
 * One drawing session per canonical path, however many panes show it.
 *
 * A drawing can be open in two panes at once, and two independent export
 * queues writing the same `.excalidraw.svg` would race. So the scene, its
 * assets, the dirty state and the single write queue belong to the path; each
 * attached view contributes edits and receives the others'. Viewport and
 * selection stay inside Excalidraw, per view — they are not scene state.
 */

/** What a session needs from a mounted Excalidraw instance to keep it in sync. */
export interface DrawingViewHandle {
  applyScene: (scene: { elements: readonly ExcalidrawElement[]; files: BinaryFiles }) => void;
}

interface AttachedView {
  handle: DrawingViewHandle;
  /**
   * Fingerprint of the scene last pushed into this view. Excalidraw reports an
   * applied `updateScene` back through `onChange`, and republishing that would
   * bounce the scene between panes forever. Comparing fingerprints identifies
   * the echo without walking the scene, which the per-stroke path cannot
   * afford.
   *
   * ponytail: element count + newest version + asset count. Two genuinely
   * different scenes could collide; if that ever shows up, hash element ids
   * instead, still without a deep traversal.
   */
  echo: string | null;
}

function fingerprint(elements: readonly ExcalidrawElement[], files: BinaryFiles) {
  const last = elements[elements.length - 1];
  return `${elements.length}:${last?.version ?? 0}:${last?.id ?? ""}:${Object.keys(files).length}`;
}

function createSession(path: string, initial: DrawingScene) {
  let elements: readonly ExcalidrawElement[] = initial.elements;
  let appState = initial.appState;
  let files = initial.files;
  // An empty scene is not "armed" until something is drawn, so a load that
  // reports zero elements cannot overwrite a real drawing with nothing.
  let armed = elements.length === 0;
  const serialize = () =>
    JSON.stringify({
      elements: elements.filter((element) => !element.isDeleted),
      background: appState.viewBackgroundColor,
      files,
    });
  let saved = serialize();
  let queue = Promise.resolve();
  let pendingSaves = 0;
  const views = new Map<string, AttachedView>();

  const session = {
    path,
    views,
    deleting: undefined as Promise<void> | undefined,

    /** The live scene — what a newly attached view must open at, rather than
     *  re-reading a stale copy from disk. */
    scene(): DrawingScene {
      return { elements: elements as DrawingScene["elements"], appState, files };
    },

    attach(viewId: string, handle: DrawingViewHandle) {
      views.set(viewId, { handle, echo: null });
    },

    /** Detach a view without writing. A tab moving between panes remounts its
     *  editor, and a move must never trigger a save. */
    detach(viewId: string) {
      views.delete(viewId);
    },

    canRelease() {
      return views.size === 0 && pendingSaves === 0 && !session.isDirty();
    },

    isDirty() {
      return serialize() !== saved;
    },

    change(
      viewId: string,
      next: readonly OrderedExcalidrawElement[],
      state: AppState,
      images: BinaryFiles,
    ) {
      if (state.isLoading || (!armed && next.length === 0)) return;

      const view = views.get(viewId);
      // The usual single-view drawing path only stores references.
      const incoming = views.size > 1 ? fingerprint(next, images) : null;
      if (incoming !== null && view?.echo === incoming) {
        // This is the scene we just pushed into this view coming back.
        view.echo = null;
        return;
      }
      if (view) view.echo = null;

      armed = true;
      elements = next;
      appState = state;
      files = images;

      for (const [otherId, other] of views) {
        if (otherId === viewId) continue;
        other.echo = incoming;
        other.handle.applyScene({ elements: next, files: images });
      }
    },

    settled: () => queue,

    /**
     * The one writer for this path. Serializing through `queue` is what makes
     * two panes safe: a second request never starts a second export, it waits
     * for the first and then no-ops if the content is unchanged.
     */
    save(): Promise<void> {
      if (session.deleting) return session.deleting;
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
      pendingSaves++;
      queue = result.finally(() => {
        pendingSaves--;
      });
      return queue;
    },
  };
  return session;
}

export type DrawingSession = ReturnType<typeof createSession>;

const sessions = new Map<string, DrawingSession>();

/**
 * Attach a mounted editor to this path's session, creating it from `initial`
 * if this is the first view. Returns the scene to open at — the *live* one, so
 * a second pane joins mid-edit rather than reverting to what is on disk.
 *
 * Detaching does not save. Writes happen at explicit boundaries: Cmd+S, tab
 * close, and quit.
 */
export function attachDrawingView(
  path: string,
  viewId: string,
  initial: DrawingScene,
  handle: DrawingViewHandle,
): { scene: DrawingScene; detach: () => void } {
  let session = sessions.get(path);
  if (!session) {
    session = createSession(path, initial);
    sessions.set(path, session);
  }
  session.attach(viewId, handle);
  const attached = session;
  return {
    scene: attached.scene(),
    detach: () => {
      attached.detach(viewId);
      // A clean session with nothing attached has nothing left to own. A dirty
      // one is kept so quit and explicit-save boundaries can still flush it.
      if (attached.canRelease() && sessions.get(path) === attached) {
        sessions.delete(path);
      }
    },
  };
}

/** Record an edit from one view and mirror it into this path's other views. */
export function changeDrawing(
  path: string,
  viewId: string,
  elements: readonly OrderedExcalidrawElement[],
  appState: AppState,
  files: BinaryFiles,
) {
  sessions.get(path)?.change(viewId, elements, appState, files);
}

export function getDrawingSession(path: string): DrawingSession | undefined {
  return sessions.get(path);
}

export function hasDrawingSession(path?: string): boolean {
  return path
    ? [...sessions.keys()].some((key) => key === path || key.startsWith(`${path}/`))
    : sessions.size > 0;
}

function matching(path?: string) {
  return [...sessions.values()].filter(
    (session) => !path || session.path === path || session.path.startsWith(`${path}/`),
  );
}

export async function saveDrawingSessions(path?: string): Promise<void> {
  const results = await Promise.allSettled(
    matching(path).map((session) =>
      session.save().then(() => {
        // A closed drawing whose write has landed can be released.
        if (session.canRelease() && sessions.get(session.path) === session) {
          sessions.delete(session.path);
        }
      }),
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
  for (const path of [...sessions.keys()]) {
    if (path === prefix || path.startsWith(`${prefix}/`)) sessions.delete(path);
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
  const entries = matching(path);
  const pending = entries.map((entry) => entry.deleting ?? entry.settled());
  const deletion = (async () => {
    // Capture existing writes, then block new exports until deletion completes.
    // Native Quit can arrive while this operation is awaiting an older Cmd+S.
    await Promise.allSettled(pending);
    await deleteEntry(path);
    discardDrawingSessions(path);
  })();
  for (const entry of entries) entry.deleting = deletion;
  try {
    await deletion;
  } finally {
    for (const entry of entries) {
      if (entry.deleting === deletion) entry.deleting = undefined;
    }
    release();
  }
}
