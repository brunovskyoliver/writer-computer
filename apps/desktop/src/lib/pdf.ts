import { convertFileSrc } from "@tauri-apps/api/core";
import type { PDFDocumentProxy } from "pdfjs-dist";
import PdfWorker from "./pdf-worker?worker";
import "./readable-stream-polyfill";
import { getFileName } from "./paths";
import {
  isCaseSensitiveQuery,
  matchPdfPageLines,
  pdfTextItemsToLines,
  type PdfTextItemLike,
} from "./pdf-search";
import type { SearchMatch } from "@/types/fs";

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

/** Grace before tearing down the worker once the last document lets go —
 *  a content search pumps files through acquire/release at concurrency with
 *  idle gaps between them, and a respawn per file would pay worker init
 *  (~100 ms of parse + handshake) for every candidate. */
const WORKER_IDLE_MS = 30_000;
let workerIdleTimer: ReturnType<typeof setTimeout> | null = null;

async function pdfjs(): Promise<typeof import("pdfjs-dist")> {
  const loaded = (lib ??= await import("pdfjs-dist"));
  // `workerPort` over `workerSrc`: the `?worker` import gives Vite an emitted
  // entry it can bundle — including the stream polyfill — instead of pointing
  // at a packaged URL that the wrapper cannot patch. Rebuilt lazily because
  // `releasePdf` terminates it once nothing references a document — the
  // worker's parsed code and font caches are the tens of MB a closed PDF
  // session would otherwise hold for the life of the window.
  if (!loaded.GlobalWorkerOptions.workerPort) {
    loaded.GlobalWorkerOptions.workerPort = new PdfWorker();
  }
  return loaded;
}

/**
 * The text-layer constructor, behind the same lazy boundary as everything else
 * here. Narrowed to the one export the viewer needs rather than handing the
 * whole module out, so `await import("pdfjs-dist")` stays confined to this
 * file and there is still no way to reach pdf.js without `workerSrc` set.
 */
export async function pdfjsTextLayer(): Promise<Pick<typeof import("pdfjs-dist"), "TextLayer">> {
  const { TextLayer } = await pdfjs();
  return { TextLayer };
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

async function loadPdf(path: string, revision: number): Promise<LoadedPdf> {
  // Starts as a no-op so a failure *before* the task exists — the lazy import
  // itself — still returns a named result instead of rejecting the promise
  // every caller is awaiting.
  let destroy = async () => {};
  try {
    const { getDocument } = await pdfjs();
    // A revision past 0 is a rewritten file (a LaTeX recompile): the query
    // string keeps WebKit from answering with the bytes it already has.
    const url = convertFileSrc(path) + (revision > 0 ? `?v=${revision}` : "");
    const task = getDocument({ url });
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

/** Cache key: one entry per path *and* revision, so a reload is a fresh
 *  document while the previous one stays alive for the tab still showing it. */
function cacheKey(path: string, revision: number): string {
  return `${path}\u0000${revision}`;
}

const documents = new Map<string, CacheEntry>();

/**
 * Take a reference to the document at `path`, loading it if this is the first.
 * Every successful `acquirePdf` must be paired with exactly one `releasePdf`.
 *
 * The entry holds the in-flight promise, not the resolved document, so two
 * tabs opening the same PDF at once share one parse instead of racing.
 */
export function acquirePdf(path: string, revision = 0): Promise<PdfLoadResult> {
  const key = cacheKey(path, revision);
  let entry = documents.get(key);
  if (!entry) {
    entry = { refs: 0, loaded: loadPdf(path, revision) };
    documents.set(key, entry);
    // Any acquire keeps the worker alive — cancel a pending idle teardown.
    if (workerIdleTimer) {
      clearTimeout(workerIdleTimer);
      workerIdleTimer = null;
    }
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
export async function releasePdf(path: string, revision = 0): Promise<void> {
  const key = cacheKey(path, revision);
  const entry = documents.get(key);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs > 0) return;
  documents.delete(key);
  await (await entry.loaded).destroy();
  // The map entry is already gone, so a re-open during this await starts a
  // fresh load — and any acquire that has landed is visible in `size`, which
  // keeps its in-flight document off the worker we're about to kill.
  if (documents.size === 0) {
    if (workerIdleTimer) clearTimeout(workerIdleTimer);
    workerIdleTimer = setTimeout(() => {
      workerIdleTimer = null;
      if (documents.size > 0 || !lib) return;
      const worker = lib.GlobalWorkerOptions.workerPort;
      lib.GlobalWorkerOptions.workerPort = null;
      worker?.terminate?.();
    }, WORKER_IDLE_MS);
  }
}

/** Test seam: how many paths are currently held. */
export function cachedPdfCount(): number {
  return documents.size;
}

/**
 * Extracted per-page line text for content search, keyed by path and tagged
 * with the file index's `modified_at` — a file that changed on disk misses
 * automatically, so no extra stat I/O is needed. Extraction is the expensive
 * half of a PDF search (~1–3 MB of text and seconds of worker time on a
 * large file), so entries outlive a single query; the bound keeps the whole
 * cache smaller than one big document's extraction.
 */
const TEXT_CACHE_LIMIT = 8;

interface PdfTextEntry {
  modifiedAt: number;
  /** Pages extracted so far — grows while `complete` is false. */
  pages: string[][];
  complete: boolean;
}

const textCache = new Map<string, PdfTextEntry>();
/** Per-path serialization for extraction: a second search on the same file
 *  waits on the chain rather than double-extracting pages into the shared
 *  entry. Values resolve; a waiting search re-checks `entry.pages` when its
 *  turn comes. */
const extractionChains = new Map<string, Promise<void>>();

/** Drop every cached extraction — workspace reset/close, where the keyed
 *  absolute paths stop meaning anything. */
export function clearPdfTextCache(): void {
  textCache.clear();
}

/** Test/e2e seam: held documents plus the size of the extraction cache. */
export function pdfRetentionSnapshot() {
  let textPages = 0;
  let textChars = 0;
  for (const entry of textCache.values()) {
    textPages += entry.pages.length;
    for (const page of entry.pages) for (const line of page) textChars += line.length;
  }
  return {
    docs: documents.size,
    textEntries: textCache.size,
    textPages,
    textChars,
    workerAlive: Boolean(lib?.GlobalWorkerOptions.workerPort),
  };
}

function cachedTextEntry(path: string, modifiedAt: number): PdfTextEntry {
  const existing = textCache.get(path);
  if (existing && existing.modifiedAt === modifiedAt) {
    // LRU touch — reinsert at the end.
    textCache.delete(path);
    textCache.set(path, existing);
    return existing;
  }
  const fresh: PdfTextEntry = { modifiedAt, pages: [], complete: false };
  textCache.set(path, fresh);
  while (textCache.size > TEXT_CACHE_LIMIT) {
    const oldest = textCache.keys().next().value;
    if (oldest === undefined) break;
    textCache.delete(oldest);
  }
  return fresh;
}

/**
 * Match `query` inside `path`'s text, extracting pages lazily and stopping
 * once `MAX_MATCHES_PER_FILE` is reached — a superseded or satisfied search
 * leaves the partial extraction cached for the next query to resume.
 * `isCancelled` should report the caller's staleness guard so a dropped
 * query stops pulling pages instead of finishing an extraction nobody reads.
 *
 * The document goes through `acquirePdf`/`releasePdf`, so extraction shares
 * the parse with any tab already showing the file. `null` when the document
 * won't load — a corrupt, encrypted or missing file simply doesn't match
 * (the spec's skip rule), so callers don't need a failure channel.
 */
export async function searchPdfText(
  path: string,
  query: string,
  base: { path: string; relativePath: string; modifiedAt: number },
  isCancelled: () => boolean = () => false,
): Promise<{ matches: SearchMatch[]; truncated: boolean } | null> {
  const entry = cachedTextEntry(path, base.modifiedAt);
  const caseSensitive = isCaseSensitiveQuery(query);
  const matches: SearchMatch[] = [];
  let truncated = false;
  // How far into `entry.pages` this search has matched — pages a concurrent
  // extractor appended after this count are matched, not re-extracted.
  let matched = 0;

  const matchThroughCache = () => {
    while (matched < entry.pages.length) {
      if (matchPdfPageLines(entry.pages[matched]!, matched, query, caseSensitive, base, matches)) {
        truncated = true;
        return;
      }
      matched++;
    }
  };

  matchThroughCache();
  if (!truncated && !entry.complete && !isCancelled()) {
    const result = await acquirePdf(path);
    if (!result.ok) return null;
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const predecessor = extractionChains.get(path) ?? Promise.resolve();
      const tail = predecessor.then(() => gate);
      extractionChains.set(path, tail);
      try {
        // A predecessor's failure must not starve this turn — the cache
        // state is re-checked on entry either way.
        await predecessor.catch(() => {});
        while (!truncated && !isCancelled()) {
          matchThroughCache();
          if (truncated) break;
          const nextPage = entry.pages.length + 1;
          if (nextPage > result.doc.pageCount) {
            entry.complete = true;
            break;
          }
          const page = await result.doc.proxy.getPage(nextPage);
          const content = await page.getTextContent();
          // `TextMarkedContent` items carry no `str`; the splitter skips
          // them. The cast bridges pdf.js's union to the structural shape.
          entry.pages.push(pdfTextItemsToLines(content.items as readonly PdfTextItemLike[]));
        }
      } finally {
        release();
        if (extractionChains.get(path) === tail) extractionChains.delete(path);
      }
    } finally {
      await releasePdf(path);
    }
  }

  return { matches, truncated };
}
