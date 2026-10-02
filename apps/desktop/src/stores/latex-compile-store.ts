import { create } from "zustand";
import { editorGeneration, onEditorReset } from "@/lib/editor-reset";
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

let requestOrder = 0;
let buildOrders = new WeakMap<LatexBuild, number>();

function setBuild(key: string, build: LatexBuild, order = ++requestOrder) {
  buildOrders.set(build, order);
  useLatexCompileStore.setState((state) => {
    const current = state.builds[key];
    if (current && (buildOrders.get(current) ?? 0) > order) return state;
    return { builds: { ...state.builds, [key]: build } };
  });
}

function rememberRoot(source: string, root: string) {
  const { roots } = useLatexCompileStore.getState();
  if (roots[source] === root) return;
  useLatexCompileStore.setState({ roots: { ...roots, [source]: root } });
}

const running = new Map<string, Promise<LatexCompileResult>>();
const rerun = new Map<string, string>();

async function runCompile(
  source: string,
  key: string,
  generation: number,
): Promise<LatexCompileResult> {
  const previous = useLatexCompileStore.getState().builds[key];
  const order = ++requestOrder;
  const compiling: LatexBuild = {
    state: "compiling",
    diagnostics: previous?.diagnostics ?? [],
    durationMs: previous?.durationMs ?? null,
    pdfPath: previous?.pdfPath ?? null,
  };
  setBuild(key, compiling, order);

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

  if (generation !== editorGeneration()) return result;
  if (result.root && useLatexCompileStore.getState().roots[source] === key)
    rememberRoot(source, result.root);
  const completedRoot = result.root;
  const previousAtRoot =
    completedRoot && completedRoot !== key
      ? useLatexCompileStore.getState().builds[completedRoot]
      : previous;
  const build: LatexBuild = {
    state: result.status === "ok" ? "ok" : result.status,
    diagnostics: result.diagnostics,
    durationMs: result.duration_ms,
    // A failed compile keeps pointing at the last good PDF.
    pdfPath: result.pdf_path ?? previousAtRoot?.pdfPath ?? null,
  };
  buildOrders.set(build, order);
  if (completedRoot && completedRoot !== key) {
    // A magic comment changed between lookup and the native compile. Keep
    // the result with its actual root, restoring the old root's last status.
    useLatexCompileStore.setState((state) => {
      const builds = { ...state.builds };
      if (state.builds[key] === compiling) {
        if (previous) builds[key] = previous;
        else delete builds[key];
      }
      const destination = state.builds[completedRoot];
      // The actual root may have another active or newer queue owner.
      if (
        !running.has(completedRoot) &&
        (!destination || (buildOrders.get(destination) ?? 0) <= order)
      )
        builds[completedRoot] = build;
      return { builds };
    });
  } else setBuild(key, build, order);
  if (result.status === "ok" && result.pdf_path) {
    usePdfRevisionStore.getState().bumpPdfRevision(result.pdf_path);
  }
  return result;
}

/** Compile the document `source` belongs to. A call during a running compile
 *  of the same root queues one rerun and resolves with the running result.
 *  Null means the request was superseded or reset before it could start. */
export async function compileLatexSource(source: string): Promise<LatexCompileResult | null> {
  const generation = editorGeneration();
  let root: string | null | undefined;
  try {
    root = await resolveRoot(source, true);
  } catch (error) {
    const result = withoutCompile("failed", String(error));
    if (generation === editorGeneration()) recordLookupFailure(source, result);
    return result;
  }
  if (generation !== editorGeneration() || root === undefined) return null;
  if (!root) {
    const result = withoutCompile(
      "no-root",
      "No main document found. Add `% !TEX root = main.tex` at the top of this file.",
    );
    setBuild(source, {
      state: "no-root",
      diagnostics: result.diagnostics,
      durationMs: 0,
      pdfPath: null,
    });
    return result;
  }
  const key = root;
  const inFlight = running.get(key);
  if (inFlight) {
    rerun.set(key, source);
    // This source owns its fresh lookup. Another chapter's native call may
    // migrate independently, and its result must not replace that association.
    return inFlight;
  }
  const promise = runCompile(source, key, generation).finally(() => {
    if (generation !== editorGeneration() || running.get(key) !== promise) return;
    running.delete(key);
    const nextSource = rerun.get(key);
    rerun.delete(key);
    if (nextSource) void compileLatexSource(nextSource);
  });
  running.set(key, promise);
  return promise;
}

function withoutCompile(status: "failed" | "no-root", message: string): LatexCompileResult {
  return {
    status,
    root: null,
    pdf_path: null,
    diagnostics: [{ file: null, line: null, message, severity: "error" }],
    duration_ms: 0,
    log: "",
  };
}

function recordLookupFailure(source: string, result: LatexCompileResult) {
  forgetRoot(source);
  setBuild(source, {
    state: "failed",
    diagnostics: result.diagnostics,
    durationMs: 0,
    pdfPath: null,
  });
}

function forgetRoot(source: string) {
  const { roots } = useLatexCompileStore.getState();
  if (!(source in roots)) return;
  const next = { ...roots };
  delete next[source];
  useLatexCompileStore.setState({ roots: next });
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

// Tokens live only while lookups are pending. A newer lookup owns publication;
// deleting its token on completion also prevents older results from publishing.
const rootLookups = new Map<string, { promise?: Promise<string | null | undefined> }>();

/** Undefined means a request was superseded or its workspace reset. Background
 * lookups join pending work so autosaves cannot cancel a foreground request. */
function resolveRoot(source: string, fresh = false): Promise<string | null | undefined> {
  if (!fresh) {
    const pending = rootLookups.get(source)?.promise;
    if (pending) return pending;
    const known = useLatexCompileStore.getState().roots[source];
    if (known) return Promise.resolve(known);
  }
  const generation = editorGeneration();
  const token: { promise?: Promise<string | null | undefined> } = {};
  rootLookups.set(source, token);
  const current = () => generation === editorGeneration() && rootLookups.get(source) === token;
  token.promise = (async () => {
    try {
      const root = await tauri.latexRoot(source);
      if (!current()) return undefined;
      if (root) rememberRoot(source, root);
      else forgetRoot(source);
      // Store subscribers run synchronously and may request a newer lookup.
      return current() ? root : undefined;
    } catch (error) {
      if (!current()) return undefined;
      throw error;
    } finally {
      if (rootLookups.get(source) === token) rootLookups.delete(source);
    }
  })();
  return token.promise;
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
  const generation = editorGeneration();
  let root: string | null | undefined;
  try {
    root = await resolveRoot(source);
  } catch (error) {
    if (generation === editorGeneration()) {
      const failure = withoutCompile("failed", String(error));
      recordLookupFailure(source, failure);
      reportFailure(failure, sourceTabId);
    }
    return;
  }
  if (generation !== editorGeneration() || root === undefined) return;
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

  const saved = await saveNow(source);
  if (!saved || generation !== editorGeneration()) return;
  const result = await compileLatexSource(source);
  if (generation !== editorGeneration() || result === null) return;
  const exists = result.status === "ok" || (await tauri.fileExists(pdfPath));
  if (generation !== editorGeneration()) return;
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
  const generation = editorGeneration();
  const saved = await saveNow(source);
  if (!saved || generation !== editorGeneration()) return;
  const result = await compileLatexSource(source);
  if (generation !== editorGeneration() || result === null) return;
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
    const generation = editorGeneration();
    void resolveRoot(path)
      .then((root) => {
        if (generation !== editorGeneration()) return;
        if (!root || pdfTabIds(pdfPathForRoot(root)).length === 0) return;
        const pending = pendingAuto.get(root);
        if (pending) clearTimeout(pending);
        pendingAuto.set(
          root,
          setTimeout(() => {
            if (generation !== editorGeneration()) return;
            pendingAuto.delete(root);
            void compileLatexSource(path);
          }, AUTO_COMPILE_DELAY_MS),
        );
      })
      .catch((error) => {
        if (generation === editorGeneration())
          recordLookupFailure(path, withoutCompile("failed", String(error)));
      });
  });
}

onEditorReset(() => {
  for (const timer of pendingAuto.values()) clearTimeout(timer);
  pendingAuto.clear();
  running.clear();
  rootLookups.clear();
  rerun.clear();
  requestOrder = 0;
  buildOrders = new WeakMap();
  useLatexCompileStore.setState({ builds: {}, roots: {} });
});
