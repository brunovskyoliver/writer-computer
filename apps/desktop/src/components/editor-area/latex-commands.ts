/**
 * The editor half of LaTeX documents (SPECs/latex-documents): which view is a
 * LaTeX source, the compile/preview commands the registry binds, the compile
 * diagnostics drawn in the source, and jumping to an error's line.
 */

import { setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { EditorSelection, Facet, type Extension, type StateCommand } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { mathSource } from "@/lib/latex-snippets/math-context";
import type { LatexDiagnostic } from "@/lib/latex-document";
import { getEditorView } from "@/lib/editor-views";
import { useEditorStore } from "@/stores/editor-store";
import {
  compileLatexNow,
  ensureLatexAutoCompile,
  toggleLatexPreview,
  useLatexCompileStore,
} from "@/stores/latex-compile-store";

/** Present only in a LaTeX source view: where it lives and which tab it is. */
const latexSourceInfo = Facet.define<
  { path: () => string; tabId: () => string },
  { path: () => string; tabId: () => string } | null
>({ combine: (values) => values[0] ?? null });

function latexCommand(run: (path: string, tabId: string) => Promise<void>): StateCommand {
  return (target) => {
    if (!(target instanceof EditorView)) return false;
    const info = target.state.facet(latexSourceInfo);
    // Not a LaTeX source: fall through so the key keeps its note meaning.
    if (!info) return false;
    void run(info.path(), info.tabId());
    return true;
  };
}

export const toggleLatexPreviewCommand = latexCommand(toggleLatexPreview);
export const compileLatexCommand = latexCommand(compileLatexNow);

/** Put the caret on `line` of a live view and bring it into sight. */
export function jumpToLine(view: EditorView, line: number) {
  const doc = view.state.doc;
  const target = doc.line(Math.min(Math.max(1, line), doc.lines));
  view.dispatch({
    selection: EditorSelection.cursor(target.from),
    effects: EditorView.scrollIntoView(target.from, { y: "center" }),
    userEvent: "select",
  });
  view.focus();
  // A click that led here may still hand focus to what was clicked once its
  // handler returns; take it back on the next frame.
  requestAnimationFrame(() => {
    if (!view.hasFocus) view.focus();
  });
}

/** Go to a diagnostic: in this tab when it is about this file, otherwise open
 *  the file it names at that line. */
export async function revealDiagnostic(
  diagnostic: LatexDiagnostic,
  sourcePath: string,
  sourceTabId: string,
) {
  if (diagnostic.line === null) return;
  const file = diagnostic.file ?? sourcePath;
  if (file === sourcePath) {
    const view = getEditorView(sourceTabId);
    if (view) jumpToLine(view, diagnostic.line);
    return;
  }
  const tab = await useEditorStore.getState().openFile(file, {
    pendingTarget: { kind: "line", line: diagnostic.line, offset: 0, length: 0, needle: "" },
  });
  // An open that focused an existing tab does not apply the pending target.
  const view = tab ? getEditorView(tab.id) : null;
  if (view) jumpToLine(view, diagnostic.line);
}

/** The compile's diagnostics for this file, as lint marks (underline plus
 *  hover text). Redrawn whenever the file's build changes. */
function compileDiagnostics(getFilePath: () => string): Extension {
  return ViewPlugin.define((view) => {
    let destroyed = false;
    const draw = () => {
      if (destroyed) return;
      const state = useLatexCompileStore.getState();
      const path = getFilePath();
      const build = state.builds[state.roots[path] ?? path];
      const doc = view.state.doc;
      const marks: Diagnostic[] = [];
      for (const item of build?.diagnostics ?? []) {
        if (item.line === null || (item.file ?? path) !== path) continue;
        const line = doc.line(Math.min(Math.max(1, item.line), doc.lines));
        marks.push({
          from: line.from,
          to: Math.max(line.from, line.to),
          severity: item.severity,
          message: item.message,
          source: "LaTeX",
        });
      }
      view.dispatch(setDiagnostics(view.state, marks));
    };
    let last = useLatexCompileStore.getState().builds;
    const unsubscribe = useLatexCompileStore.subscribe((state) => {
      if (state.builds === last) return;
      last = state.builds;
      draw();
    });
    queueMicrotask(draw);
    return {
      destroy: () => {
        destroyed = true;
        unsubscribe();
      },
    };
  });
}

/** What a LaTeX source view adds to the plain code editor. */
export function latexSourceExtensions(
  getFilePath: () => string,
  getTabId: () => string,
): Extension {
  ensureLatexAutoCompile();
  return [
    latexSourceInfo.of({ path: getFilePath, tabId: getTabId }),
    // Snippets and math commands find math in the source text (FR-5).
    mathSource.of("latex"),
    compileDiagnostics(getFilePath),
  ];
}
