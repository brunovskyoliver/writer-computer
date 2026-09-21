/**
 * Re-bracket the matrix environment the caret sits in: `cases` ↔ `bmatrix`
 * and friends differ only in the env name, so the change is two small
 * rewrites — the `\begin{…}`/`\end{…}` name spans — and one undo step.
 * `enclosingMatrixEnv` resolves the nearest delimited ancestor, so a caret
 * inside a nested `aligned` still reaches the bracketed env around it.
 *
 * Rules: SPECs/matrix-brace-tools/spec.md (FR-9).
 */

import { ensureSyntaxTree } from "@codemirror/language";
import type { StateCommand } from "@codemirror/state";
import { mathContext, type MathContext, type MathNode } from "@/lib/latex-snippets/math-context";
import { enclosingMatrixEnv } from "@/lib/latex-snippets/matrix-row";
import { showEditorNotice } from "./editor-notice-store";

const MATH_KINDS = new Set<MathContext["kind"]>(["inline", "display", "text"]);
const PARSE_BUDGET_MS = 50;

export function matrixDelimiters(env: string): StateCommand {
  return ({ state, dispatch }) => {
    const sel = state.selection.main;
    ensureSyntaxTree(state, state.doc.lineAt(sel.head).to, PARSE_BUDGET_MS);
    const context = mathContext(state, sel.head);
    if (!MATH_KINDS.has(context.kind)) {
      showEditorNotice("Put the caret inside a matrix first.");
      return true;
    }

    const node = (context as { node: MathNode }).node;
    const formula = state.doc.sliceString(node.formulaFrom, node.formulaTo);
    const span = enclosingMatrixEnv(formula, sel.head - node.formulaFrom);
    if (!span) {
      showEditorNotice("No bracketed matrix environment around the caret.");
      return true;
    }
    if (span.name === env) return true;

    dispatch(
      state.update({
        changes: [
          {
            from: node.formulaFrom + span.beginName.from,
            to: node.formulaFrom + span.beginName.to,
            insert: env,
          },
          {
            from: node.formulaFrom + span.endName.from,
            to: node.formulaFrom + span.endName.to,
            insert: env,
          },
        ],
        userEvent: "input.format.matrixDelimiters",
      }),
    );
    return true;
  };
}
