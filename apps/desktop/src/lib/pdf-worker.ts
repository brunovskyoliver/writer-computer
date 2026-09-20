/**
 * The pdf.js worker entry, wrapped so the polyfill lands in the worker
 * global before the library installs its message handler. Referenced
 * through `?worker` in `lib/pdf.ts` — bundling it through Vite keeps the
 * emitted URL correct in both dev and the packaged app (a bare
 * `pdf.worker.min.mjs` URL string 404s there).
 */
import "./readable-stream-polyfill";
import "pdfjs-dist/build/pdf.worker.min.mjs";
