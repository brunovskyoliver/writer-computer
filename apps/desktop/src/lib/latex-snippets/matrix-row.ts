/**
 * Enter inside a matrix-like environment ends the current row: the caller
 * inserts `\\` + a newline and the caret lands on a fresh row. Pure string
 * logic so the decision is unit-testable without a view.
 *
 * Rules: SPECs/matrix-brace-tools/spec.md (FR-2, FR-3).
 */

/** Environments whose rows are separated by `\\`. */
const MATRIX_ENV =
  /^(?:[pbBvV]?matrix\*?|smallmatrix|array|subarray|[dr]?cases|aligned?|alignedat|gathered|split)$/;

/** Environments that take a `{…}` column spec between the name and the body. */
const COLSPEC_ENV = new Set(["array", "subarray", "alignedat"]);

const ENV_RE = /\\(begin|end)\{([^}]*)\}/g;

/** The `}` closing the `{` at `openIndex`, or null when unbalanced. */
function matchBrace(text: string, openIndex: number): number | null {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === "\\") {
      i += 1;
      continue;
    }
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return null;
}

/**
 * @param formula the math node's content between its `$`/`$$` delimiters
 * @param caret   the caret position as an offset into `formula`
 * @returns true when Enter should emit `\\` + newline rather than a plain
 *          newline: the caret is inside an unclosed matrix-like environment
 *          and the row it sits on has content. On the `\begin{…}` line or an
 *          empty row the answer is false — Enter then means "leave".
 */
export function matrixRowBreak(formula: string, caret: number): boolean {
  const before = formula.slice(0, caret);

  const stack: { name: string; end: number }[] = [];
  for (const match of before.matchAll(ENV_RE)) {
    // `\\begin` is a row break followed by the word "begin", not an opener.
    if (match.index > 0 && before[match.index - 1] === "\\") continue;
    const name = match[2]!;
    if (match[1] === "begin") {
      stack.push({ name, end: match.index + match[0].length });
    } else {
      for (let at = stack.length - 1; at >= 0; at -= 1) {
        if (stack[at]!.name === name) {
          stack.length = at;
          break;
        }
      }
    }
  }

  const env = stack[stack.length - 1];
  if (!env || !MATRIX_ENV.test(env.name)) return false;

  let rowStart = env.end;
  if (COLSPEC_ENV.has(env.name) && formula[rowStart] === "{") {
    const close = matchBrace(formula, rowStart);
    if (close !== null) rowStart = close + 1;
  }
  const lastBreak = before.lastIndexOf("\\\\");
  if (lastBreak !== -1 && lastBreak + 2 > rowStart) rowStart = lastBreak + 2;

  return formula.slice(rowStart, caret).trim() !== "";
}
