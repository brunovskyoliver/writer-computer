/**
 * What the caret is sitting in, as far as the snippet engine cares: prose,
 * code, inline math, display math, or the prose inside a `\text{}` group.
 *
 * Callers own parsing: run `ensureSyntaxTree` for the current line first if
 * the tree may be stale (the input handler does, once per keystroke).
 *
 * Rules: SPECs/latex-suite/contracts/editor-extension.md ("Math context rules")
 */

import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { mathFormulaSpan } from "@/lib/prosemark-core/main";

/** The enclosing `Math` node: the whole node including `$` delimiters, plus
 *  the formula span between them. */
export type MathNode = {
  from: number;
  to: number;
  formulaFrom: number;
  formulaTo: number;
};

export type MathContext =
  | { kind: "prose" }
  | { kind: "code" }
  | { kind: "inline"; node: MathNode }
  | { kind: "display"; node: MathNode }
  | { kind: "text"; node: MathNode };

const CODE_NODES = new Set(["InlineCode", "FencedCode", "CodeBlock", "HTMLBlock"]);

const PROSE: MathContext = { kind: "prose" };
const CODE: MathContext = { kind: "code" };

function mathNodeOf(math: SyntaxNode, display: boolean): MathNode {
  // Read from the delimiters, not the `MathFormula` child: the LaTeX
  // highlighter mounts a nested tree over that node and hides it.
  const delimiter = display ? 2 : 1;
  const formula = mathFormulaSpan(math);
  return {
    from: math.from,
    to: math.to,
    formulaFrom: formula?.from ?? math.from + delimiter,
    formulaTo: formula?.to ?? math.to - delimiter,
  };
}

/** `\text{…}` opened before the caret and not yet closed: the caret is in
 *  prose again, so no math snippet should fire there. */
function insideTextGroup(state: EditorState, node: MathNode, pos: number): boolean {
  const prefix = state.doc.sliceString(node.formulaFrom, Math.min(pos, node.formulaTo));
  const opened = prefix.lastIndexOf("\\text{");
  if (opened === -1) return false;

  let depth = 0;
  for (const char of prefix.slice(opened + "\\text{".length)) {
    if (char === "{") depth += 1;
    else if (char === "}") {
      if (depth === 0) return false;
      depth -= 1;
    }
  }
  return true;
}

export function mathContext(state: EditorState, pos: number): MathContext {
  // `side: -1` looks at the token before the caret, which gives the delimiter
  // rule for free: on the opening `$` the caret is still outside the node, on
  // the closing `$` it is inside.
  for (
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
    node;
    node = node.parent
  ) {
    if (CODE_NODES.has(node.name)) return CODE;
    if (node.name !== "Math") continue;

    const display = state.doc.sliceString(node.from, node.from + 2) === "$$";
    const math = mathNodeOf(node, display);
    if (insideTextGroup(state, math, pos)) return { kind: "text", node: math };
    return display ? { kind: "display", node: math } : { kind: "inline", node: math };
  }
  return PROSE;
}
