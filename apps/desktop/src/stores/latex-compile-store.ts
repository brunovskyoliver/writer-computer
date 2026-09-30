import { create } from "zustand";
import { showEditorNotice } from "@/components/editor-area/editor-notice-store";
import {
  firstError,
  isLatexSourcePath,
  pdfPathForRoot,
  type LatexCompileResult,
  type LatexDiagnostic,
} from "@/lib/latex-document";
import { onFileSaved, saveNow } from "@/lib/save";
import { paneOfTab } from "@/lib/editor-layout";
import * as tauri from "@/lib/tauri";
import { useEditorStore } from "./editor-store";
import { usePdfRevisionStore } from "./pdf-revision-store";

/**
 * LaTeX compiles and the PDF preview beside a `.tex` tab
 * (SPECs/latex-documents US2–US5, FR-3).
 *
 * Compiles are keyed by root: every `.tex`/`.bib` of one document shares its
 * status, and at most one compile of a root runs — a request during a run
 * sets a single rerun flag instead of stacking engines.
 */

export type LatexBuild = {
  state: "compiling" | "ok" | "failed" | "engine-missing" | "no-root";
  diagnostics: LatexDiagnostic[];
  durationMs: number | null;
  pdfPath: string | null;
};

interface LatexCompileState {
  /** root (or the source itself while its root is unknown) → last build. */
  builds: Record<string, LatexBuild>;
  /** source path → root, learned from compiles and root lookups. */
  roots: Record<string, string>;
}

export const useLatexCompileStore = create<LatexCompileState>(() => ({
  builds: {},
  roots: {},
}));

/** How long autosaves may keep coming before the preview recompiles. */
const AUTO_COMPILE_DELAY_MS = 400;

function keyFor(source: string): string {
  return useLatexCompileStore.getState().roots[source] ?? source;
}

function setBuild(key: string, build: LatexBuild) {
  useLatexCompileStore.setState((state) => ({ builds: { ...state.builds, [key]: build } }));
}

function rememberRoot(source: string, root: string) {
  const { roots } = useLatexCompileStore.getState();
  if (roots[source] === root) return;
  useLatexCompileStore.setState({ roots: { ...roots, [source]: root } });
}

const running = new Map<string, Promise<LatexCompileResult>>();
const rerun = new Set<string>();

async function runCompile(source: string, key: string): Promise<LatexCompileResult> {
  const previous = useLatexCompileStore.getState().builds[key];
  setBuild(key, {
    state: "compiling",
    diagnostics: previous?.diagnostics ?? [],
    durationMs: previous?.durationMs ?? null,
    pdfPath: previous?.pdfPath ?? null,
  });

  let result: LatexCompileResult;
  try {
    result = await tauri.compileLatex(source);
  } catch (error) {
    // The engine could not even start: a failed build with the reason.
    result = {
      status: "failed",
      root: null,
      pdf_path: null,
      diagnostics: [{ file: null, line: null, message: String(error), severity: "error" }],
      duration_ms: 0,
      log: "",
    };
  }

  if (result.root) rememberRoot(source, result.root);
  const build: LatexBuild = {
    state: result.status === "ok" ? "ok" : result.status,
    diagnostics: result.diagnostics,
    durationMs: result.duration_ms,
    // A failed compile keeps pointing at the last good PDF.
    pdfPath: result.pdf_path ?? previous?.pdfPath ?? null,
  };
  setBuild(key, build);
  // The builds of a root are shared; a source compiled under its own path
  // before its root was known moves over.
  if (result.root && result.root !== key) setBuild(result.root, build);
  if (result.status === "ok" && result.pdf_path) {
    usePdfRevisionStore.getState().bumpPdfRevision(result.pdf_path);
  }
  return result;
}

/** Compile the document `source` belongs to. A call during a running compile
 *  of the same root queues one rerun and resolves with the running result. */
export function compileLatexSource(source: string): Promise<LatexCompileResult> {
  const key = keyFor(source);
  const inFlight = running.get(key);
  if (inFlight) {
    rerun.add(key);
    return inFlight;
  }
  const promise = runCompile(source, key).finally(() => {
    running.delete(key);
    if (rerun.delete(key)) void compileLatexSource(source);
  });
  running.set(key, promise);
  return promise;
}

/** The build a source tab reports: its root's, once known. */
export function useLatexBuild(source: string): LatexBuild | null {
  return useLatexCompileStore((state) => state.builds[state.roots[source] ?? source] ?? null);
}

function pdfTabIds(pdfPath: string): string[] {
  return useEditorStore
    .getState()
    .tabs.filter((tab) => tab.location.kind === "pdf" && tab.location.path === pdfPath)
    .map((tab) => tab.id);
}

async function resolveRoot(source: string): Promise<string | null> {
  const known = useLatexCompileStore.getState().roots[source];
  if (known) return known;
  const root = await tauri.latexRoot(source);
  if (root) rememberRoot(source, root);
  return root;
}

/** Keep focus on the source after the preview opened beside it. */
function refocusSourcePane(sourceTabId: string) {
  const store = useEditorStore.getState();
  const pane = paneOfTab(store.layout, sourceTabId);
  if (pane) store.setFocusedPane(pane.id);
}

/**
 * `Cmd+Alt+P`: close the root's PDF wherever it is open, or compile (when the
 * PDF is missing or the source was just edited) and open it beside the source.
 */
export async function toggleLatexPreview(source: string, sourceTabId: string): Promise<void> {
  const root = await resolveRoot(source);
  if (!root) {
    showEditorNotice(
      "No main document found. Add `% !TEX root = main.tex` at the top of this file.",
      sourceTabId,
    );
    return;
  }
  const pdfPath = pdfPathForRoot(root);

  const open = pdfTabIds(pdfPath);
  if (open.length > 0) {
    for (const tabId of open) useEditorStore.getState().closeTab(tabId);
    return;
  }

  await saveNow(source);
  const result = await compileLatexSource(source);
  const exists = result.status === "ok" || (await tauri.fileExists(pdfPath));
  if (!exists) {
    reportFailure(result, sourceTabId);
    return;
  }
  if (result.status !== "ok") reportFailure(result, sourceTabId);
  useEditorStore.getState().revealPdfAnchor(pdfPath, null, sourceTabId);
  refocusSourcePane(sourceTabId);
}

/** `Cmd+Enter`: save now and compile, whether or not the preview is open. */
export async function compileLatexNow(source: string, sourceTabId: string): Promise<void> {
  await saveNow(source);
  const result = await compileLatexSource(source);
  if (result.status !== "ok") reportFailure(result, sourceTabId);
}

function reportFailure(result: LatexCompileResult, tabId: string) {
  const error = firstError(result.diagnostics);
  if (!error) return;
  const where = error.line !== null ? `line ${error.line}: ` : "";
  showEditorNotice(`LaTeX: ${where}${error.message}`, tabId);
}

// Auto-compile (US3): a save of a LaTeX source recompiles its root, but only
// while that root's PDF is open somewhere — nobody asked for a preview
// otherwise. Debounced per root so a burst of autosaves is one compile.
const pendingAuto = new Map<string, ReturnType<typeof setTimeout>>();

let autoCompileWired = false;

/** Start recompiling on save. Idempotent; called when a LaTeX source view
 *  mounts, so a session that never opens one never listens. */
export function ensureLatexAutoCompile() {
  if (autoCompileWired) return;
  autoCompileWired = true;
  onFileSaved((path) => {
    if (!isLatexSourcePath(path)) return;
    void resolveRoot(path).then((root) => {
      if (!root || pdfTabIds(pdfPathForRoot(root)).length === 0) return;
      const pending = pendingAuto.get(root);
      if (pending) clearTimeout(pending);
      pendingAuto.set(
        root,
        setTimeout(() => {
          pendingAuto.delete(root);
          void compileLatexSource(path);
        }, AUTO_COMPILE_DELAY_MS),
      );
    });
  });
}
