/**
 * Tab in math with no active tabstop: jump past the next closing delimiter.
 *
 * Rules: SPECs/latex-suite/contracts/editor-extension.md ("Tab-out").
 */

import type { MathContext } from "./math-context";

const CLOSERS = new Set(["}", ")", "]", "|"]);

/**
 * @param lineAfter text from the caret to the end of its line
 * @param caret absolute caret position
 * @param lineTo absolute end of the caret's line
 * @returns where to move the caret, or `null` when there is nothing to leave
 */
export function tabOutTarget(
  lineAfter: string,
  caret: number,
  context: MathContext,
  lineTo: number,
): number | null {
  for (let at = 0; at < lineAfter.length; at += 1) {
    if (CLOSERS.has(lineAfter[at]!)) return caret + at + 1;
  }

  // Nothing left to close on this line: leave the formula entirely, but only
  // when its closing delimiter is on this line too.
  if (context.kind !== "inline" && context.kind !== "display") return null;
  return context.node.to <= lineTo ? context.node.to : null;
}
