import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import * as editorApi from "@/hooks/editor-api";
import { parseDocument, parseFrontmatter } from "@/lib/frontmatter";
import { formatMarkdownDestination } from "@/lib/paths";
import * as tauri from "@/lib/tauri";
import { showEditorNotice } from "./editor-notice-store";

const MAX_IMAGE_SIZE_MB = 5;
const MAX_IMAGE_SIZE = MAX_IMAGE_SIZE_MB * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 2560;
// Each attempt is (long-edge cap, quality). WKWebView silently falls back to
// PNG when it cannot encode the requested type, so trust blob.type, not the
// requested one, and step down until the result fits.
const COMPRESSION_ATTEMPTS: ReadonlyArray<[number, number]> = [
  [MAX_IMAGE_DIMENSION, 0.85],
  [1920, 0.75],
  [1440, 0.65],
  [1024, 0.6],
];

/** Re-encode an oversized image, shrinking until it fits under the limit.
 *  Returns null when the browser cannot decode it (e.g. SVG, HEIC) or when
 *  even the smallest attempt stays too big. */
async function compressImage(
  file: File,
  limit: number,
): Promise<{ bytes: Uint8Array<ArrayBufferLike>; format: string; size: number } | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }

  let smallest: { bytes: Uint8Array<ArrayBufferLike>; format: string; size: number } | null = null;
  try {
    for (const [maxDimension, quality] of COMPRESSION_ATTEMPTS) {
      const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
      const canvas = new OffscreenCanvas(
        Math.max(1, Math.round(bitmap.width * scale)),
        Math.max(1, Math.round(bitmap.height * scale)),
      );
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

      let blob = await canvas.convertToBlob({ type: "image/webp", quality });
      // No WebP encoder: PNG is the fallback and is far worse for photos.
      if (blob.type !== "image/webp") {
        blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
      }
      const result = {
        bytes: new Uint8Array(await blob.arrayBuffer()),
        format: blob.type.split("/")[1] || "png",
        size: blob.size,
      };
      if (result.size <= limit) return result;
      smallest = result;
    }
  } finally {
    bitmap.close();
  }

  return smallest;
}

async function handleImagePaste(
  file: File,
  view: EditorView,
  filePath: string,
  isDisposed: () => boolean,
) {
  const buffer = await file.arrayBuffer();
  if (isDisposed()) return;

  let bytes: Uint8Array<ArrayBufferLike> = new Uint8Array(buffer);
  let format = file.type.split("/")[1] || "png";
  if (bytes.byteLength > MAX_IMAGE_SIZE) {
    const compressed = await compressImage(file, MAX_IMAGE_SIZE);
    if (isDisposed()) return;
    if (!compressed || compressed.size > MAX_IMAGE_SIZE) {
      const sizeMb = ((compressed?.size ?? bytes.byteLength) / (1024 * 1024)).toFixed(1);
      showEditorNotice(
        `Image not pasted: ${sizeMb} MB is over the ${MAX_IMAGE_SIZE_MB} MB limit`,
        editorApi.getTabIdForView(view),
      );
      return;
    }
    console.debug(
      `[editor] compressed pasted image: ${buffer.byteLength} -> ${compressed.size} bytes as ${compressed.format}`,
    );
    bytes = compressed.bytes;
    format = compressed.format;
  }

  const imageData = Array.from(bytes);
  const result = await tauri.saveClipboardImage(filePath, imageData, format);
  if (isDisposed()) return;
  const imageMarkdown = `![${file.name}](${formatMarkdownDestination(result.relative_path)})`;
  const cursor = view.state.selection.main.head;
  view.dispatch({ changes: { from: cursor, insert: imageMarkdown } });
}

// Pasting a whole document (frontmatter + body) into a file without
// frontmatter adopts the frontmatter into the panel and inserts only the body.
function handleFrontmatterPaste(event: ClipboardEvent, view: EditorView, filePath: string) {
  const text = event.clipboardData?.getData("text/plain");
  if (!text) return false;

  const parsedFrontmatter = parseFrontmatter(text);
  if (parsedFrontmatter.frontmatter === null) return false;

  const parsedDocument = parseDocument(text);

  const file = editorApi.getOpenFile(filePath);
  if (!file || file.frontmatter !== null) return false;

  event.preventDefault();
  editorApi.updateFrontmatter(filePath, parsedFrontmatter.frontmatter);
  if (parsedDocument.body) {
    view.dispatch(view.state.replaceSelection(parsedDocument.body));
  }
  return true;
}

// Typing `---` on the first line of a file without frontmatter opens an empty
// frontmatter panel instead of leaving a horizontal rule in the body.
function handleFrontmatterStart(event: KeyboardEvent, view: EditorView, filePath: string) {
  if (event.key !== "-") return false;

  const { doc, selection } = view.state;
  const pos = selection.main.head;
  const firstLine = doc.line(1);

  if (pos !== firstLine.from + 2) return false;
  if (firstLine.text !== "--") return false;

  const file = editorApi.getOpenFile(filePath);
  if (!file || file.frontmatter !== null) return false;

  editorApi.updateFrontmatter(filePath, "");
  view.dispatch({
    changes: { from: firstLine.from, to: firstLine.from + 2 },
  });
  event.preventDefault();
  return true;
}

/** Paste and keyboard handling that touches files: image paste to disk,
 *  frontmatter adoption on paste, and the `---` frontmatter shortcut. */
export function editorClipboardExtension(
  getFilePath: () => string,
  isDisposed: () => boolean,
): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      if (handleFrontmatterPaste(event, view, getFilePath())) return true;

      const items = event.clipboardData?.items;
      if (!items) return false;

      for (const item of items) {
        if (!item.type.startsWith("image/")) continue;
        const imageFile = item.getAsFile();
        if (!imageFile) continue;

        event.preventDefault();
        void handleImagePaste(imageFile, view, getFilePath(), isDisposed).catch((error) => {
          console.error("[editor] Failed to paste image:", error);
        });
        return true;
      }

      return false;
    },
    keydown(event, view) {
      return handleFrontmatterStart(event, view, getFilePath());
    },
  });
}
