/**
 * Completions inside a ` ```plot ` fence: the evaluator's functions and
 * constants anywhere, plus the line forms (`domain=`, `range=`, `x =`,
 * `T(x,y) =`) at the start of a line. Syntax: SPECs/math-workflow/spec.md (FR-8).
 */

import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { FUNCTION_NAMES } from "@/lib/math/evaluate";

/** Insert `before` + `after` and leave the caret between them. */
function wrap(before: string, after = ""): Completion["apply"] {
  return (view: EditorView, _completion: Completion, from: number, to: number) => {
    view.dispatch({
      changes: { from, to, insert: before + after },
      selection: EditorSelection.cursor(from + before.length),
      userEvent: "input.complete",
    });
  };
}

const ANYWHERE: Completion[] = [
  ...FUNCTION_NAMES.map((name) => ({
    label: name,
    detail: `${name}(…)`,
    type: "function",
    apply: wrap(`${name}(`, ")"),
  })),
  { label: "pi", detail: "π", type: "constant" },
  { label: "e", detail: "Euler's number", type: "constant" },
];

const LINE_START: Completion[] = [
  {
    label: "domain",
    detail: "x extent, e.g. domain=-6:6",
    type: "keyword",
    apply: wrap("domain="),
  },
  { label: "range", detail: "y extent, e.g. range=-2:2", type: "keyword", apply: wrap("range=") },
  { label: "x =", detail: "vertical line", type: "keyword", apply: wrap("x = ") },
  { label: "y =", detail: "curve in x", type: "keyword", apply: wrap("y = ") },
  { label: "T(x,y) =", detail: "heatmap of x and y", type: "keyword", apply: wrap("T(x,y) = ") },
];

/** True when `pos` is on a body line of a ` ```plot ` fence. */
function inPlotBody(context: CompletionContext): boolean {
  const { state, pos } = context;
  for (let node = syntaxTree(state).resolveInner(pos, -1); node.parent; node = node.parent) {
    if (node.name !== "FencedCode") continue;
    const info = node.getChild("CodeInfo");
    if (!info || state.sliceDoc(info.from, info.to).trim().toLowerCase() !== "plot") return false;
    const close = node.lastChild?.name === "CodeMark" && node.lastChild.from > info.to;
    return pos > state.doc.lineAt(node.from).to && (!close || pos < node.lastChild!.from);
  }
  return false;
}

export function plotCompletions(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/[a-zA-Z]*$/)!;
  if (word.from === word.to && !context.explicit) return null;
  if (!inPlotBody(context)) return null;
  const line = context.state.doc.lineAt(context.pos);
  const atLineStart = context.state.sliceDoc(line.from, word.from).trim() === "";
  return {
    from: word.from,
    options: atLineStart ? [...LINE_START, ...ANYWHERE] : ANYWHERE,
    validFor: /^[a-zA-Z]*$/,
  };
}
