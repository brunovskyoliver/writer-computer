import { useSettingsStore } from "@/stores/settings-store";
import type { OpenFile } from "@/hooks/editor-api";
import { serializeDocument } from "@/lib/frontmatter";
import * as tauri from "@/lib/tauri";

const THROTTLE_MS = 1000;

/**
 * The slice of editor-store behavior the save engine needs. The store injects
 * it via `registerSaveStore` at startup so this `lib/` module never imports
 * `stores/editor-store` — that back-edge would invert the stores → lib layering
 * and form an import cycle (the store already imports the save engine).
 */
export interface SaveStoreAccess {
  getOpenFile: (path: string) => OpenFile | undefined;
  markSaved: (path: string, diskContent: string, hasNewerChanges: boolean) => void;
  setSaveError: (path: string, error: string) => void;
}

let storeAccess: SaveStoreAccess | null = null;

/** Wire the save engine to the editor store. Called once from editor-store at
 *  module init. */
export function registerSaveStore(access: SaveStoreAccess) {
  storeAccess = access;
}

function requireStore(): SaveStoreAccess {
  if (!storeAccess) {
    throw new Error("[save] used before registerSaveStore() — editor store not wired");
  }
  return storeAccess;
}

interface SaveController {
  lastSaveTime: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Resolves when the current write has settled (follow-up queued or
   *  controller cleaned up). Null while idle. */
  inFlight: Promise<void> | null;
  pending: boolean;
}

/**
 * `saved`: the write landed and the file is clean. `clean`: nothing to write.
 * `superseded`: the write landed but newer edits arrived meanwhile (a follow-up
 * is queued). `failed`: the write threw and the error is on the file. `busy`:
 * another write owns the controller.
 */
type SaveOutcome = "saved" | "clean" | "superseded" | "failed" | "busy";

const saveControllers = new Map<string, SaveController>();

function getSaveController(path: string): SaveController {
  let controller = saveControllers.get(path);
  if (!controller) {
    controller = {
      lastSaveTime: 0,
      timer: null,
      inFlight: null,
      pending: false,
    };
    saveControllers.set(path, controller);
  }
  return controller;
}

function clearSaveTimer(controller: SaveController) {
  if (!controller.timer) return;
  clearTimeout(controller.timer);
  controller.timer = null;
}

function cleanupSaveController(path: string, controller: SaveController) {
  if (controller.inFlight || controller.pending || controller.timer) return;
  saveControllers.delete(path);
}

export function scheduleSave(path: string) {
  const controller = getSaveController(path);
  controller.pending = true;
  queueSave(path, controller);
}

export function isSaveInFlight(path: string) {
  return saveControllers.get(path)?.inFlight != null;
}

/**
 * Write `path` now, ignoring the throttle. Waits for a write already in
 * flight, then writes again so the latest content lands. Resolves `true` when
 * the file is clean afterwards and `false` when the write threw — the error is
 * already recorded on the file through `setSaveError`, so callers must not
 * surface it a second time.
 */
export async function saveNow(path: string): Promise<boolean> {
  const controller = getSaveController(path);
  for (;;) {
    if (controller.inFlight) {
      await controller.inFlight;
      continue;
    }
    clearSaveTimer(controller);
    const outcome = await performSave(path, controller);
    if (outcome === "superseded" || outcome === "busy") continue;
    return outcome !== "failed";
  }
}

export function cancelSave(path: string) {
  const controller = saveControllers.get(path);
  if (!controller) return;

  controller.pending = false;
  clearSaveTimer(controller);
  cleanupSaveController(path, controller);
}

function queueSave(path: string, controller: SaveController) {
  if (controller.inFlight) return;

  clearSaveTimer(controller);

  const elapsed = Date.now() - controller.lastSaveTime;
  if (elapsed >= THROTTLE_MS) {
    void performSave(path, controller);
    return;
  }

  controller.timer = setTimeout(() => {
    controller.timer = null;
    void performSave(path, controller);
  }, THROTTLE_MS - elapsed);
}

function applyFileProcessing(content: string): string {
  const settings = useSettingsStore.getState().settings;
  let result = content;

  if (settings["files.trim-trailing-whitespace"]) {
    result = result
      .split("\n")
      .map((line) => line.replace(/\s+$/, ""))
      .join("\n");
  }

  if (settings["files.insert-final-newline"]) {
    if (!result.endsWith("\n")) {
      result += "\n";
    }
  }

  return result;
}

function serializeForSave(file: OpenFile) {
  return applyFileProcessing(serializeDocument(file.frontmatter, file.content));
}

async function performSave(
  path: string,
  controller = getSaveController(path),
): Promise<SaveOutcome> {
  if (controller.inFlight) return "busy";

  const store = requireStore();
  const file = store.getOpenFile(path);
  if (!file || !file.isDirty) {
    controller.pending = false;
    cleanupSaveController(path, controller);
    return "clean";
  }

  let settle!: () => void;
  controller.inFlight = new Promise<void>((resolve) => {
    settle = resolve;
  });
  controller.pending = false;
  controller.lastSaveTime = Date.now();

  const full = serializeForSave(file);
  let shouldReschedule = false;
  let outcome: SaveOutcome = "saved";

  try {
    await tauri.writeFile(path, full);

    const latestFile = store.getOpenFile(path);
    if (!latestFile) return "clean";

    shouldReschedule = serializeForSave(latestFile) !== full;
    if (shouldReschedule) outcome = "superseded";
    store.markSaved(path, full, shouldReschedule);
  } catch (err) {
    console.error(`[save] Failed to save ${path}:`, err);
    const message = err instanceof Error ? err.message : String(err);
    store.setSaveError(path, message);
    outcome = "failed";
  } finally {
    controller.inFlight = null;

    const needsFollowUpSave = controller.pending || shouldReschedule;
    if (needsFollowUpSave) {
      queueSave(path, controller);
    } else {
      cleanupSaveController(path, controller);
    }
    settle();
  }
  return outcome;
}
