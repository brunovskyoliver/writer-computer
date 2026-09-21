/**
 * Tab in math with no active tabstop: jump past the next closing delimiter.
 *
 * Rules: SPECs/latex-suite/contracts/editor-extension.md ("Tab-out").
 */

import type { MathContext } from "./math-context";

const CLOSERS = new Set(["}", ")", "]", "|"]);

/**
 * The next position Tab lands on, scanning `lineAfter`: a closing bracket or
 * `|` jumps one char, an `&` (matrix/align cell) jumps one, and a `\\` row
 * break jumps two. A lone `\` is a macro start, not a target.
 */
function nextTarget(lineAfter: string): number | null {
  for (let at = 0; at < lineAfter.length; at += 1) {
    const char = lineAfter[at]!;
    if (CLOSERS.has(char) || char === "&") return at + 1;
    if (char === "\\" && lineAfter[at + 1] === "\\") return at + 2;
  }
  return null;
}

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
  const target = nextTarget(lineAfter);
  if (target !== null) return caret + target;

  // Nothing left to close on this line: leave the formula entirely, but only
  // when its closing delimiter is on this line too.
  if (context.kind !== "inline" && context.kind !== "display") return null;
  return context.node.to <= lineTo ? context.node.to : null;
}
