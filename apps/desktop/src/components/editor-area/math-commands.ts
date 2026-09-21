/**
 * The StateCommand half of the math-workflow commands: tidy notation,
 * align/split derivation steps, and numeric step checking. Each resolves
 * the Math node(s) in play through the same `mathContext` probe the snippet
 * engine uses, delegates the rewrite to a pure module in `src/lib/math/`,
 * and reports through `showEditorNotice` — the same contract the matrix and
 * brace commands follow.
 *
 * Rules: SPECs/math-workflow/spec.md.
 */

import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorSelection, type StateCommand } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { mathContext, type MathContext, type MathNode } from "@/lib/latex-snippets/math-context";
import { mathFormulaSpan } from "@/lib/prosemark-core/main";
import { tidyFormula } from "@/lib/math/tidy";
import { alignRun, splitAligned } from "@/lib/math/align";
import { checkEquivalent, formatComplex } from "@/lib/math/evaluate";
import { showEditorNotice } from "./editor-notice-store";

const PARSE_BUDGET_MS = 50;
const MATH_KINDS = new Set<MathContext["kind"]>(["inline", "display", "text"]);

function mathNodeAt(state: Parameters<StateCommand>[0]["state"], pos: number) {
  ensureSyntaxTree(state, state.doc.lineAt(pos).to, PARSE_BUDGET_MS);
  const context = mathContext(state, pos);
  return MATH_KINDS.has(context.kind) && "node" in context ? context.node : null;
}

/** Every top-level `Math` node intersecting `[from, to)`. Math nodes never
 *  nest, so iteration order is document order. */
function mathNodesIn(
  state: Parameters<StateCommand>[0]["state"],
  from: number,
  to: number,
): MathNode[] {
  const nodes: MathNode[] = [];
  syntaxTree(state).iterate({
    from,
    to,
    enter: (ref) => {
      if (ref.name !== "Math") return;
      const node: SyntaxNode = ref.node;
      const span = mathFormulaSpan(node);
      if (!span) return;
      nodes.push({ from: node.from, to: node.to, formulaFrom: span.from, formulaTo: span.to });
    },
  });
  return nodes;
}

/**
 * `math.tidy` — rewrite `\;`/`\,`/`\:` separators inside matrix bodies as
 * `&` cells and `*` as `\cdot` (conjugates kept). Scope: every Math node
 * touching the selection, else the Math node around the caret.
 */
export const mathTidy: StateCommand = ({ state, dispatch }) => {
  const sel = state.selection.main;
  const nodes = sel.empty
    ? ([mathNodeAt(state, sel.head)].filter(Boolean) as MathNode[])
    : (ensureSyntaxTree(state, sel.to, PARSE_BUDGET_MS), mathNodesIn(state, sel.from, sel.to));

  if (nodes.length === 0) {
    showEditorNotice("Put the caret inside a formula, or select formulas, first.");
    return true;
  }

  let changes = 0;
  const edits = nodes.flatMap((node) => {
    const formula = state.doc.sliceString(node.formulaFrom, node.formulaTo);
    const result = tidyFormula(formula);
    changes += result.changes;
    return result.changes === 0
      ? []
      : [{ from: node.formulaFrom, to: node.formulaTo, insert: result.text }];
  });

  if (edits.length === 0) {
    showEditorNotice("Nothing to tidy.");
    return true;
  }

  dispatch(
    state.update({
      changes: edits,
      userEvent: "input.format.mathTidy",
    }),
  );
  showEditorNotice(`Tidied ${changes} ${changes === 1 ? "spot" : "spots"}.`);
  return true;
};

/** The `$$`-block run a position belongs to: consecutive display-math
 *  blocks separated only by blank lines, found by walking the syntax tree.
 *  Returns null outside a run. */
function displayMathRunAt(
  state: Parameters<StateCommand>[0]["state"],
  pos: number,
): MathNode[] | null {
  const node = mathNodeAt(state, pos);
  if (!node || state.doc.lineAt(node.from).text.trim() !== "$$") return null;

  const all: MathNode[] = [];
  syntaxTree(state).iterate({
    enter: (ref) => {
      if (ref.name !== "Math") return;
      const n: SyntaxNode = ref.node;
      // Block-level only: opener line must be a bare `$$`.
      if (state.doc.lineAt(n.from).text.trim() !== "$$") return;
      const span = mathFormulaSpan(n);
      if (span) all.push({ from: n.from, to: n.to, formulaFrom: span.from, formulaTo: span.to });
    },
  });

  const index = all.findIndex((n) => n.from === node.from && n.to === node.to);
  if (index === -1) return null;

  // Expand over runs joined by blank lines only.
  let lo = index;
  let hi = index;
  while (lo > 0 && state.doc.sliceString(all[lo - 1]!.to, all[lo]!.from).trim() === "") lo -= 1;
  while (
    hi < all.length - 1 &&
    state.doc.sliceString(all[hi]!.to, all[hi + 1]!.from).trim() === ""
  ) {
    hi += 1;
  }
  return all.slice(lo, hi + 1);
}

/**
 * `math.align` — collapse the `$$` run around the caret into a single
 * `$$\begin{aligned}…\end{aligned}$$` block, `&` marking the first
 * top-level relation of each step.
 */
export const mathAlign: StateCommand = ({ state, dispatch }) => {
  const sel = state.selection.main;
  if (!sel.empty) {
    showEditorNotice("Align works from a caret inside the run — collapse the selection first.");
    return true;
  }
  const run = displayMathRunAt(state, sel.head);
  if (!run) {
    showEditorNotice("Put the caret inside a $$ block first.");
    return true;
  }
  if (run.length < 2) {
    showEditorNotice("No run of $$ steps to align — the block stands alone.");
    return true;
  }

  const steps = run.map((node) => state.doc.sliceString(node.formulaFrom, node.formulaTo).trim());
  const aligned = alignRun(steps);
  if (!aligned) {
    showEditorNotice("Could not align these steps — the formulas are empty.");
    return true;
  }

  dispatch(
    state.update({
      changes: {
        from: run[0]!.from,
        to: run[run.length - 1]!.to,
        insert: `$$\n\\begin{aligned}\n${aligned}\n\\end{aligned}\n$$`,
      },
      // Inside the first row — on the `$$` delimiter boundary mathContext
      // reads as outside math, which would refuse a follow-up split.
      selection: EditorSelection.cursor(run[0]!.from + 3),
      userEvent: "input.format.mathAlign",
    }),
  );
  return true;
};

/**
 * `math.split` — a `$$` block containing `\begin{aligned}`/`align`/
 * `gathered` becomes one `$$` block per row again, `&` markers stripped.
 */
export const mathSplit: StateCommand = ({ state, dispatch }) => {
  const sel = state.selection.main;
  const node = mathNodeAt(state, sel.head);
  if (!node) {
    showEditorNotice("Put the caret inside an aligned $$ block first.");
    return true;
  }
  const formula = state.doc.sliceString(node.formulaFrom, node.formulaTo);
  const rows = splitAligned(formula);
  if (!rows) {
    showEditorNotice("No aligned environment around the caret.");
    return true;
  }

  const insert = rows.map((row) => `$$\n${row}\n$$`).join("\n\n");
  dispatch(
    state.update({
      changes: { from: node.from, to: node.to, insert },
      // `+3` lands on the first row inside the first new $$ block.
      selection: EditorSelection.cursor(node.from + 3),
      userEvent: "input.format.mathSplit",
    }),
  );
  return true;
};

/**
 * `math.check` — numerically compare the caret's `$$` step with the one
 *  before it in the same run. Sampling, not a CAS: three deterministic
 *  trials over the free variables must all agree within epsilon.
 */
export const mathCheck: StateCommand = ({ state, dispatch: _dispatch }) => {
  const sel = state.selection.main;
  const node = mathNodeAt(state, sel.head);
  if (!node) {
    showEditorNotice("Put the caret inside a $$ step first.");
    return true;
  }
  const run = displayMathRunAt(state, sel.head);
  const index = run?.findIndex((n) => n.from === node.from && n.to === node.to) ?? -1;
  if (!run || index < 0) {
    showEditorNotice("Put the caret inside a $$ block first.");
    return true;
  }
  if (index === 0) {
    showEditorNotice("No previous step to check against.");
    return true;
  }

  const prev = state.doc.sliceString(run[index - 1]!.formulaFrom, run[index - 1]!.formulaTo);
  const next = state.doc.sliceString(node.formulaFrom, node.formulaTo);
  const result = checkEquivalent(prev, next);

  if (result.kind === "equal") {
    showEditorNotice("Step looks equal to the previous one (checked numerically).");
  } else if (result.kind === "differs") {
    const at = result.varName ? ` at ${result.varName}=${result.sample}` : "";
    showEditorNotice(
      `Step differs from the previous one${at}: ${formatComplex(result.prev)} vs ${formatComplex(result.next)}.`,
    );
  } else {
    const detail = result.kind === "open" ? result.reason : result.message;
    showEditorNotice(`Cannot check this step — ${detail}.`);
  }
  return true;
};
