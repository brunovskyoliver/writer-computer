import { convertFileSrc } from "@tauri-apps/api/core";
import { obsidianDrawings } from "./obsidian-drawings";
import { isDrawingPath, isObsidianDrawingPath } from "./drawings";

const drawingRevisions = new Map<string, number>();
let globalRevision = 0;

export function getDrawingRevision(path: string): number | undefined {
  return drawingRevisions.get(path) ?? (globalRevision > 0 ? globalRevision : undefined);
}

export function bumpDrawingRevision(path?: string): number {
  const next = Date.now();
  if (path) {
    drawingRevisions.set(path, next);
  }
  globalRevision = next;
  return next;
}

export function resetDrawingRevisions(): void {
  drawingRevisions.clear();
  globalRevision = 0;
}

export function getVersionedImageSrc(absolutePath: string): string {
  const base = convertFileSrc(absolutePath);
  const rev = getDrawingRevision(absolutePath);
  return rev ? `${base}?v=${rev}` : base;
}

export interface ImageElementLike {
  dataset: Record<string, string | undefined>;
  src: string;
}

export interface DomRootLike {
  querySelectorAll: (selector: string) => Iterable<ImageElementLike>;
}

/**
 * Update the `src` attribute of rendered drawing `<img>` elements in the DOM
 * with an updated cache-busting timestamp so the browser immediately fetches
 * and displays the newly saved SVG from disk.
 */
export function refreshDrawingEmbeds(targetPath?: string, rootNode?: DomRootLike): void {
  if (targetPath && isObsidianDrawingPath(targetPath)) {
    obsidianDrawings.invalidate(targetPath);
    return;
  }
  const revision = bumpDrawingRevision(targetPath);
  const root =
    rootNode ??
    (typeof document !== "undefined" ? (document as unknown as DomRootLike) : undefined);
  if (!root) return;

  const targetFilename = targetPath ? (targetPath.split("/").pop() ?? null) : null;
  const images = root.querySelectorAll(".cm-image img, .cm-image-embed img");

  for (const img of images) {
    const canonical = img.dataset.canonicalPath;
    const currentSrc = img.src;
    if (!currentSrc || currentSrc.startsWith("blob:") || currentSrc.startsWith("data:")) continue;

    const isMatch = targetPath
      ? canonical === targetPath ||
        (targetFilename !== null &&
          (currentSrc.includes(targetFilename) ||
            decodeURIComponent(currentSrc).includes(targetFilename)))
      : isDrawingPath(canonical ?? "") || currentSrc.includes(".excalidraw.svg");

    if (isMatch) {
      try {
        const url = new URL(currentSrc);
        url.searchParams.set("v", String(revision));
        img.src = url.toString();
      } catch {
        const base = currentSrc.split("?")[0]!;
        img.src = `${base}?v=${revision}`;
      }
    }
  }
}

export function notifyDrawingSaved(path: string): void {
  refreshDrawingEmbeds(path);
}
