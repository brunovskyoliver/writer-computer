import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { NonDeletedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { getFileName } from "./paths";
import { readFile, writeFile } from "./tauri";

/**
 * Drawings are `.excalidraw.svg` files: the rendered picture and the editable
 * scene in one file, the scene riding in the SVG's metadata. See
 * SPECs/excalidraw-embed/spec.md.
 *
 * Everything Excalidraw is behind `await import()` on purpose — `isDrawingPath`
 * is called from the editor store, which is in the main module graph, and the
 * bundle is ~1.13 MB. Only opening a drawing tab may pay for it.
 */
export const DRAWING_EXTENSION = ".excalidraw.svg";

/**
 * True for the compound `.excalidraw.svg` extension only. A plain `.svg` is an
 * image, not a drawing, and must keep opening as one. A file whose whole name
 * is the extension has no stem and is not treated as a drawing.
 */
export function isDrawingPath(path: string): boolean {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  return name.length > DRAWING_EXTENSION.length && name.toLowerCase().endsWith(DRAWING_EXTENSION);
}

export type DrawingScene = {
  elements: readonly NonDeletedExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
};

export type DrawingLoadResult = { ok: true; scene: DrawingScene } | { ok: false; error: string };

/**
 * Read a drawing off disk. Returns an error rather than an empty scene: the
 * caller must suppress autosave on failure, or the next save overwrites the
 * user's real drawing with nothing.
 */
export async function loadDrawing(path: string): Promise<DrawingLoadResult> {
  try {
    const { content } = await readFile(path);
    const { loadFromBlob } = await import("@excalidraw/excalidraw");
    const restored = await loadFromBlob(new Blob([content], { type: "image/svg+xml" }), null, null);
    return {
      ok: true,
      scene: { elements: restored.elements, appState: restored.appState, files: restored.files },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// Exports are async (font subsetting runs in a worker), so a debounced caller can
// finish export N after N+1 and write a stale SVG over a newer one. Chain writes
// per path so the last save requested is the last one on disk.
const writeQueue = new Map<string, Promise<unknown>>();

/**
 * Write a drawing back to `path` through the normal Rust write path, so
 * `watcher.rs` self-write detection suppresses the echo.
 *
 * The two export flags are set on every write and never read back off the file:
 * `loadFromBlob` returns them at their defaults regardless of what was written.
 */
export async function saveDrawing(path: string, scene: DrawingScene): Promise<void> {
  const run = async () => {
    const { exportToSvg } = await import("@excalidraw/excalidraw");
    const svg = await exportToSvg({
      elements: scene.elements,
      appState: { ...scene.appState, exportEmbedScene: true, exportBackground: false },
      files: scene.files,
    });
    await writeFile(path, new XMLSerializer().serializeToString(svg));
  };

  const chained = (writeQueue.get(path) ?? Promise.resolve()).then(run, run);
  writeQueue.set(path, chained);
  try {
    await chained;
  } finally {
    if (writeQueue.get(path) === chained) writeQueue.delete(path);
  }
}

/** The drawing's display name — the filename with the compound extension
 *  stripped. `notes/sketch.excalidraw.svg` → `sketch`. */
export function drawingName(path: string): string {
  const name = getFileName(path);
  return name.slice(0, -DRAWING_EXTENSION.length);
}
