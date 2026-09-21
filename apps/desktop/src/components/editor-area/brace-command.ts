/**
 * Wrap the selection in `\underbrace` / `\overbrace` with an empty annotation
 * group; the caret lands inside it so the note is typed next. Inside math the
 * selection wraps in place; in prose the command emits
 * `$\underbrace{\text{…}}_{\text{…}}$` so the bracket renders in either
 * context. KaTeX sizes the brace and its note to the content, which is what
 * makes the annotation adapt to whatever is typed.
 *
 * `emitBraceWrap` is the pure half — the command only resolves context,
 * validates, and dispatches. Rules: SPECs/matrix-brace-tools/spec.md.
 */

import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, type StateCommand } from "@codemirror/state";
import { highlightContext } from "@/lib/highlight/emit";
import { showEditorNotice } from "./editor-notice-store";
import { validateMath } from "./math-renderer";

export type BraceSide = "under" | "over";

export interface BraceWrap {
  insert: string;
  /** Caret offset inside `insert` — inside the annotation braces. */
  caret: number;
}

export function emitBraceWrap(fragment: string, side: BraceSide, math: boolean): BraceWrap {
  const macro = side === "under" ? "\\underbrace" : "\\overbrace";
  const script = side === "under" ? "_" : "^";
  const annotation = math ? "" : "\\text{}";
  const body = math ? fragment : `\\text{${fragment}}`;
  const insert = math
    ? `${macro}{${body}}${script}{}`
    : `$${macro}{${body}}${script}{${annotation}}$`;
  return { insert, caret: insert.length - (math ? 1 : 3) };
}

const PARSE_BUDGET_MS = 50;

/** The one write path for both commands (FR-4, FR-5). Returns whether the
 *  keypress was consumed — the notices explain the cases that write nothing. */
export function braceAnnotation(side: BraceSide): StateCommand {
  return ({ state, dispatch }) => {
    const sel = state.selection.main;
    if (state.selection.ranges.length > 1) return false;
    if (sel.empty) {
      showEditorNotice("Select the text the brace should cover first.");
      return true;
    }

    ensureSyntaxTree(state, state.doc.lineAt(sel.to).to, PARSE_BUDGET_MS);
    const context = highlightContext(state, sel.from, sel.to);
    if (context === null) {
      showEditorNotice("The selection has to be all math or all prose — not a mix of both.");
      return true;
    }

    if (context.kind === "prose") {
      const fragment = state.doc.sliceString(sel.from, sel.to);
      // A blank line ends the paragraph, and the emitted `$…$` only parses
      // inside one — a crossing selection would leave raw `$` in the source.
      if (/\n\s*\n/.test(fragment)) {
        showEditorNotice("The brace can't cross a paragraph break — shorten the selection.");
        return true;
      }
      const { insert, caret } = emitBraceWrap(fragment, side, false);
      if (!validateMath(insert.slice(1, -1))) {
        showEditorNotice(
          "That selection can't be bracketed — it contains characters that would break the formula.",
        );
        return true;
      }
      dispatch(
        state.update({
          changes: { from: sel.from, to: sel.to, insert },
          selection: EditorSelection.cursor(sel.from + caret),
          userEvent: "input.format.brace",
        }),
      );
      return true;
    }

    const node = context.node;
    const from = Math.max(sel.from, node.formulaFrom);
    const to = Math.min(sel.to, node.formulaTo);
    if (from >= to) {
      showEditorNotice("Select the part of the formula the brace should cover.");
      return true;
    }
    const formula = state.doc.sliceString(node.formulaFrom, node.formulaTo);
    const fragment = formula.slice(from - node.formulaFrom, to - node.formulaFrom);
    const { insert, caret } = emitBraceWrap(fragment, side, true);
    const next =
      formula.slice(0, from - node.formulaFrom) + insert + formula.slice(to - node.formulaFrom);
    if (!validateMath(next)) {
      showEditorNotice("That selection can't be bracketed — the formula would stop rendering.");
      return true;
    }
    dispatch(
      state.update({
        changes: { from, to, insert },
        selection: EditorSelection.cursor(from + caret),
        userEvent: "input.format.brace",
      }),
    );
    return true;
  };
}
