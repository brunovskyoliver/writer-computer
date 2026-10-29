import { createDrawingSourceCache } from "./drawing-source-cache";
import { exportDrawing, drawingName, DRAWING_EXTENSION, type DrawingScene } from "./drawings";
import { loadDrawingRuntime } from "./drawing-runtime";
import { onEditorReset } from "./editor-reset";
import { readDrawingSource, writeFile } from "./tauri";
import { getParentDir } from "./paths";
import { FileConflictError } from "./file-conflict";
import type { readObsidianDrawing } from "./obsidian-drawing-format";

type RawScene = ReturnType<typeof readObsidianDrawing>;
export function decodeObsidianDrawing(
  source: string,
  signal: AbortSignal,
  createWorker: () => Pick<Worker, "postMessage" | "terminate" | "onmessage" | "onerror"> = () =>
    new Worker(new URL("./obsidian-drawing-worker.ts", import.meta.url), { type: "module" }),
): Promise<RawScene> {
  return new Promise((resolve, reject) => {
    const worker = createWorker();
    const finish = (error?: Error, scene?: RawScene) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
      if (error) reject(error);
      else resolve(scene!);
    };
    const cancel = () => finish(new Error("Drawing load cancelled."));
    const timer = setTimeout(() => finish(new Error("Drawing decoding took too long.")), 6000);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) {
      cancel();
      return;
    }
    worker.onerror = (event) => finish(new Error(event.message || "Drawing decoder failed."));
    worker.onmessage = (event: MessageEvent<{ ok: boolean; scene?: RawScene; error?: string }>) => {
      if (event.data.ok) finish(undefined, event.data.scene);
      else finish(new Error(event.data.error || "Drawing could not be decoded."));
    };
    worker.postMessage(source);
  });
}

export const obsidianDrawings = createDrawingSourceCache({
  async load(path, signal) {
    const source = await readDrawingSource(path);
    signal.throwIfAborted();
    const raw = await decodeObsidianDrawing(source, signal);
    signal.throwIfAborted();
    const { restore } = await loadDrawingRuntime();
    signal.throwIfAborted();
    const restored = restore(raw as unknown as Parameters<typeof restore>[0], null, null, {
      refreshDimensions: true,
      repairBindings: true,
    });
    const scene: DrawingScene = {
      elements: restored.elements,
      appState: restored.appState,
      files: restored.files,
    };
    const svg = await exportDrawing(scene, { embedScene: false });
    signal.throwIfAborted();
    return { scene, svg, bytes: 2 * (JSON.stringify(scene).length + svg.length) };
  },
  createUrl: (svg) => URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" })),
  revokeUrl: (url) => URL.revokeObjectURL(url),
});
onEditorReset(() => obsidianDrawings.reset());

/** Read the latest source, then publish a separate copy without overwriting. */
export async function copyObsidianDrawing(
  path: string,
  isCurrent: () => boolean,
): Promise<string | null> {
  obsidianDrawings.invalidate(path);
  const lease = obsidianDrawings.acquire(path);
  try {
    const { scene } = await lease.result;
    if (!isCurrent()) return null;
    const svg = await exportDrawing(scene);
    return publishDrawingCopy(path, svg, isCurrent);
  } finally {
    lease.release();
  }
}

export async function publishDrawingCopy(
  path: string,
  svg: string,
  isCurrent: () => boolean,
): Promise<string | null> {
  const base = `${getParentDir(path)}/${drawingName(path)}`;
  for (let n = 0; n < 1000; n++) {
    if (!isCurrent()) return null;
    const destination = `${base}${n ? `-${n}` : ""}${DRAWING_EXTENSION}`;
    try {
      await writeFile(destination, svg, null);
      return destination;
    } catch (error) {
      if (
        !(error instanceof FileConflictError) &&
        !(typeof error === "string" && error.startsWith("Already exists:"))
      )
        throw error;
    }
  }
  throw new Error("No available drawing name. Rename the source and try again.");
}
