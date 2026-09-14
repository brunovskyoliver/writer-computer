import { convertFileSrc } from "@tauri-apps/api/core";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { getFileName } from "./paths";

/**
 * The renderer boundary for pdf.js. See SPECs/pdf-quote-links/.
 *
 * Everything pdf.js is behind `await import()` for the same reason
 * `lib/drawings.ts` hides Excalidraw: the bundle is large and only opening a
 * PDF tab should pay for it. The worker is configured inside that same lazy
 * module, so there is no way to reach `getDocument` before `workerSrc` is set.
 *
 * Bytes come in over the Tauri asset protocol (`convertFileSrc`), the path the
 * app already uses for binary attachments in `image-src-resolver.ts`. pdf.js
 * fetches the URL itself, so it streams and range-requests rather than holding
 * a whole document in a `Uint8Array` — which is what keeps SC-003 reachable.
 */

/** Mirrors `PDF_EXTENSION` in `apps/desktop/src-tauri/src/commands/fs.rs` —
 *  the sidebar filter and this predicate must agree on what a PDF is. */
export const PDF_EXTENSION = ".pdf";

/**
 * True for a `.pdf` file. Called from the editor store, which is in the main
 * module graph — which is why every pdf.js touch below is behind
 * `await import()`, exactly as `isDrawingPath` sits beside the lazy Excalidraw
 * boundary in `lib/drawings.ts`. A file whose whole name is `.pdf` has no stem
 * and is not a document.
 */
export function isPdfPath(path: string): boolean {
  const name = getFileName(path);
  return name.length > PDF_EXTENSION.length && name.toLowerCase().endsWith(PDF_EXTENSION);
}

/** Tab title: the filename stem. FR-002 — never extracted from the contents. */
export function pdfName(path: string): string {
  return getFileName(path).slice(0, -PDF_EXTENSION.length);
}

/** A loaded document. Runtime only — never serialized. */
export type PdfDocument = {
  path: string;
  proxy: PDFDocumentProxy;
  pageCount: number;
};

/**
 * Why a load failed, named rather than collapsed into a string, so FR-012 and
 * FR-026 can tell the user which of the three it was.
 */
export type PdfLoadErrorCause = "missing" | "corrupt" | "encrypted" | "unknown";

export type PdfLoadError = { cause: PdfLoadErrorCause; message: string };

export type PdfLoadResult = { ok: true; doc: PdfDocument } | { ok: false; error: PdfLoadError };

let lib: typeof import("pdfjs-dist") | null = null;

async function pdfjs(): Promise<typeof import("pdfjs-dist")> {
  if (lib) return lib;
  const loaded = await import("pdfjs-dist");
  // Vite resolves this `new URL(..., import.meta.url)` form at build time; it
  // must be a literal specifier for that to happen. If worker resolution ever
  // fails here, log what `workerSrc` actually resolved to before changing the
  // approach — research.md R2 flags this as the one item likely to need
  // iteration, and guessing a second path is how that turns into four.
  loaded.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).href;
  lib = loaded;
  return lib;
}

/**
 * Map a pdf.js failure onto a named cause.
 *
 * Matching on `error.name` rather than `instanceof`: these exceptions are
 * reconstructed across the worker boundary, so identity against this module's
 * copy of the class is not reliable. pdf.js sets `name` explicitly in every
 * `BaseException` subclass, which is.
 */
function classifyError(error: unknown): PdfLoadError {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";
  if (name === "PasswordException") return { cause: "encrypted", message };
  if (name === "InvalidPDFException") return { cause: "corrupt", message };
  if (name === "ResponseException") {
    const missing = (error as { missing?: boolean }).missing === true;
    return { cause: missing ? "missing" : "unknown", message };
  }
  return { cause: "unknown", message };
}

/**
 * The teardown handle lives on the *loading task*, not on the document proxy —
 * `PDFDocumentProxy` has no public `destroy`, and dropping the task is what
 * actually aborts in-flight network requests and tears down the worker. So the
 * cache holds a closure over the task rather than the proxy alone.
 */
type LoadedPdf = { result: PdfLoadResult; destroy: () => Promise<void> };

async function loadPdf(path: string): Promise<LoadedPdf> {
  // Starts as a no-op so a failure *before* the task exists — the lazy import
  // itself — still returns a named result instead of rejecting the promise
  // every caller is awaiting.
  let destroy = async () => {};
  try {
    const { getDocument } = await pdfjs();
    const task = getDocument({ url: convertFileSrc(path) });
    destroy = () => task.destroy();
    const proxy = await task.promise;
    return { result: { ok: true, doc: { path, proxy, pageCount: proxy.numPages } }, destroy };
  } catch (error) {
    return { result: { ok: false, error: classifyError(error) }, destroy };
  }
}

/**
 * One document per path, shared by every tab showing it and destroyed when the
 * last one goes away.
 *
 * Refcounted rather than LRU-cached on purpose: "cached while at least one tab
 * references it" is an ownership rule, not a size heuristic, so there is no
 * eviction policy to tune and no way for a live tab to lose its document.
 */
type CacheEntry = { refs: number; loaded: Promise<LoadedPdf> };

const documents = new Map<string, CacheEntry>();

/**
 * Take a reference to the document at `path`, loading it if this is the first.
 * Every successful `acquirePdf` must be paired with exactly one `releasePdf`.
 *
 * The entry holds the in-flight promise, not the resolved document, so two
 * tabs opening the same PDF at once share one parse instead of racing.
 */
export function acquirePdf(path: string): Promise<PdfLoadResult> {
  let entry = documents.get(path);
  if (!entry) {
    entry = { refs: 0, loaded: loadPdf(path) };
    documents.set(path, entry);
  }
  entry.refs += 1;
  return entry.loaded.then((l) => l.result);
}

/**
 * Drop a reference. The document is destroyed once the last tab lets go.
 *
 * The entry leaves the map before the `await`, so a re-open during teardown
 * starts a fresh load rather than handing back a proxy about to be destroyed.
 */
export async function releasePdf(path: string): Promise<void> {
  const entry = documents.get(path);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs > 0) return;
  documents.delete(path);
  await (await entry.loaded).destroy();
}

/** Test seam: how many paths are currently held. */
export function cachedPdfCount(): number {
  return documents.size;
}
