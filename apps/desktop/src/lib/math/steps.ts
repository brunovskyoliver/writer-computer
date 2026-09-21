/**
 * Derivation-step helpers: the pure half of "Enter opens the next step's
 * block" and "Mod-Enter copies this step into the next block". All offsets
 * are relative to the formula text between the `$$` marks, so the module
 * stays testable without a view.
 *
 * Rules: SPECs/math-workflow/spec.md (FR-1, FR-2).
 */

import { innermostEnvAt } from "../latex-snippets/matrix-row";

/** Text that closes the current `$$` block and opens a fresh one below it.
 *  Appended content (a copied formula) goes right before the trailing
 *  newline so the old block's closing `$$` doubles as the new closer. */
const STEP_SEPARATOR = "\n$$\n\n$$\n";

export interface StepInsert {
  /** Text to insert at the formula's content end (trailing whitespace
   *  excluded). */
  insert: string;
  /** Caret offset into `insert`. */
  caretOffset: number;
}

/**
 * True when a plain Enter at `caret` should open the next step's block:
 * only whitespace sits between the caret and the closing `$$`, some content
 * precedes the caret, and the caret is not inside an unclosed `\begin{…}`
 * environment (those belong to matrix-rows or a plain newline). Mid-formula
 * Enter stays a plain newline.
 */
export function atFormulaEnd(formula: string, caret: number): boolean {
  if (caret < 0 || caret > formula.length) return false;
  if (formula.slice(caret).trim() !== "") return false;
  if (formula.slice(0, caret).trim() === "") return false;
  if (innermostEnvAt(formula, caret) !== null) return false;
  return true;
}

/** Enter at the end of a formula: close this block, open an empty `$$`
 *  block below, caret on its empty content line. */
export function emptyStepInsert(): StepInsert {
  return { insert: STEP_SEPARATOR, caretOffset: STEP_SEPARATOR.length };
}

/** Mod-Enter anywhere in a display block: close it and reopen with a copy
 *  of the whole formula, caret at the end of the copy. The old block's
 *  closing `$$` doubles as the new block's closer, so no trailing newline
 *  is appended here. */
export function copyStepInsert(formula: string): StepInsert {
  const content = formula.trim();
  return {
    insert: STEP_SEPARATOR + content,
    caretOffset: STEP_SEPARATOR.length + content.length,
  };
}

/** Offset of the formula's content end within itself: where a step
 *  separator belongs so the formula keeps its shape and no whitespace
 *  trails the copy. */
export function formulaContentEnd(formula: string): number {
  return formula.trimEnd().length;
}
