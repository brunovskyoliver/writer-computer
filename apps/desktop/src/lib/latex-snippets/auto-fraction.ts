/**
 * `/` inside math turns the expression before it into `\frac{…}{}`.
 *
 * Rules: SPECs/latex-suite/contracts/editor-extension.md ("Auto-fraction").
 * All offsets are relative to the start of the line.
 */

export type AutoFraction = {
  /** Line offset where the replacement starts (the operand's first character).
   *  The replaced range ends at the `/` that was just typed. */
  operandFrom: number;
  text: string;
  stops: { group: number; offset: number }[];
};

const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/** Characters that end the operand when scanning backwards over a plain run. */
const BREAKERS = new Set(["+", "-", "=", "<", ">", ",", "(", "[", "{"]);

/** Start of the balanced group ending at `end` (exclusive), or `null` when the
 *  brackets do not balance. */
function balancedStart(text: string, end: number): number | null {
  const open = CLOSERS[text[end - 1]!]!;
  const close = text[end - 1]!;
  let depth = 0;
  for (let at = end - 1; at >= 0; at -= 1) {
    if (text[at] === close) depth += 1;
    else if (text[at] === open) {
      depth -= 1;
      if (depth === 0) return at;
    }
  }
  return null;
}

export function autoFraction(lineBefore: string): AutoFraction | null {
  // The `/` is already in the text; the operand is everything before it.
  const end = lineBefore.length - 1;
  if (end <= 0) return null;

  let start: number;
  if (CLOSERS[lineBefore[end - 1]!]) {
    const balanced = balancedStart(lineBefore, end);
    if (balanced === null) return null;
    // `\sqrt{x}` — pull in the control sequence the group belongs to.
    const command = /\\[A-Za-z]+$/.exec(lineBefore.slice(0, balanced));
    start = command ? command.index : balanced;
  } else {
    start = end;
    while (start > 0) {
      const char = lineBefore[start - 1]!;
      if (/\s/.test(char) || BREAKERS.has(char)) break;
      start -= 1;
    }
  }

  let operand = lineBefore.slice(start, end);
  if (operand.length === 0) return null;
  // `(a+b)/` reads as "a+b over …": a plain parenthesised group loses its
  // parentheses inside `\frac`. Square brackets and `\cmd{…}` keep theirs,
  // where they carry meaning.
  if (operand.startsWith("(") && operand.endsWith(")")) operand = operand.slice(1, -1);
  if (operand.length === 0) return null;

  const text = `\\frac{${operand}}{}`;
  return {
    operandFrom: start,
    text,
    // `$0` inside the empty denominator, `$1` just after its closing brace.
    stops: [
      { group: 0, offset: text.length - 1 },
      { group: 1, offset: text.length },
    ],
  };
}
