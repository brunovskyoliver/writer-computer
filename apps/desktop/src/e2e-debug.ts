/**
 * Runtime retention probe for the e2e perf harness
 * (`e2e/perf/perf-retention.spec.js`).
 *
 * `window.__writerDebug()` reports the sizes of every table named in
 * `SPECs/Agent/worksheet-webcontent-retention.md` — store maps, the pdf.js
 * refcount cache, drawing sessions, keep-alive ranks — plus DOM canvas
 * accounting, which is the half of the WebContent graphics footprint that a
 * process-level `footprint` dump cannot attribute.
 *
 * Gated at call time, not install time: `navigator.webdriver` only turns
 * true once a driver session exists, and the fallback flag is set by the
 * spec itself after page load. Returns `null` anywhere else, so in a normal
 * run the hook is a dead function on `window`.
 */
import { drawingSessionDebugCounts } from "./lib/drawing-sessions";
import { editorViewDebugCounts } from "./lib/editor-views";
import { keepAliveTrackedCount } from "./lib/keep-alive";
import { pdfRetentionSnapshot } from "./lib/pdf";
import { editorRetentionSnapshot } from "./stores/editor-store";

declare global {
  interface Window {
    __writerDebug?: () => Record<string, unknown> | null;
    __WRITER_E2E_DEBUG?: boolean;
  }
}

/** Canvas backing stores are 4 bytes/px — the only part of the "graphics"
 *  footprint bucket reachable from JS. */
function domSnapshot() {
  let canvases = 0;
  let canvasBytes = 0;
  for (const canvas of document.querySelectorAll("canvas")) {
    canvases += 1;
    canvasBytes += canvas.width * canvas.height * 4;
  }
  return {
    canvases,
    canvasMb: +(canvasBytes / 1024 / 1024).toFixed(1),
    cmEditors: document.querySelectorAll(".cm-editor").length,
    images: document.querySelectorAll("img").length,
  };
}

window.__writerDebug = () => {
  if (!import.meta.env.DEV && !navigator.webdriver && !window.__WRITER_E2E_DEBUG) return null;
  return {
    ...editorRetentionSnapshot(),
    ...editorViewDebugCounts(),
    keepAliveRanks: keepAliveTrackedCount(),
    pdf: pdfRetentionSnapshot(),
    drawings: drawingSessionDebugCounts(),
    dom: domSnapshot(),
  };
};
