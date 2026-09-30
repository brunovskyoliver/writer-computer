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

/** Environments that can be re-bracketed: they share the `\\`-row/`&`-cell
 *  grammar and take no arguments, so swapping the env name never invalidates
 *  the body. `array` is excluded — its `{…}` colspec would become a literal
 *  group — and `aligned`/`gathered` have no delimiters of their own. */
const DELIMITED_ENV = /^(?:[pbBvV]?matrix|[dr]?cases)$/;

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
 * The innermost `\begin{env}` still open at `caret`, or null when the caret
 * sits outside every environment. `bodyStart` is the end of the `\begin{…}`
 * marker, past an `{…}` column spec for envs that take one.
 */
export function innermostEnvAt(
  formula: string,
  caret: number,
): { name: string; bodyStart: number } | null {
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
  if (!env) return null;

  let bodyStart = env.end;
  if (COLSPEC_ENV.has(env.name) && formula[bodyStart] === "{") {
    const close = matchBrace(formula, bodyStart);
    if (close !== null) bodyStart = close + 1;
  }
  return { name: env.name, bodyStart };
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
  const env = innermostEnvAt(formula, caret);
  if (!env || !MATRIX_ENV.test(env.name)) return false;

  let rowStart = env.bodyStart;
  const lastBreak = formula.slice(0, caret).lastIndexOf("\\\\");
  if (lastBreak !== -1 && lastBreak + 2 > rowStart) rowStart = lastBreak + 2;

  return formula.slice(rowStart, caret).trim() !== "";
}

const ENV_TOKEN = /^\\(begin|end)\{/;

/** Where the row containing `caret` ends: the first `\\` or `\end{…}` at
 *  or after it outside a nested environment, or the formula's end. */
export function rowEndAt(formula: string, caret: number): number {
  let depth = 0;
  for (let i = caret; i < formula.length; i += 1) {
    if (formula[i] !== "\\") continue;
    if (formula[i + 1] === "\\") {
      if (depth === 0) return i;
      i += 1;
      continue;
    }
    const token = ENV_TOKEN.exec(formula.slice(i, i + 8));
    if (token) {
      if (token[1] === "begin") depth += 1;
      else if (depth > 0) depth -= 1;
      else return i;
      i += token[0].length - 1;
      continue;
    }
    i += 1;
  }
  return formula.length;
}

/**
 * Enter on an empty last row (`3 & 4\\` then Enter on the blank line below):
 * the row break was one too many. Returns the edit that deletes the `\\` and
 * the blank row, and the caret offset (after the edit) just past `\end{…}` —
 * Enter twice at the end of a matrix leaves it. Null anywhere else, including
 * an empty row with more rows below it.
 */
export function matrixRowExit(
  formula: string,
  caret: number,
): { from: number; to: number; insert: string; caret: number } | null {
  const env = innermostEnvAt(formula, caret);
  if (!env || !MATRIX_ENV.test(env.name)) return null;

  const lastBreak = formula.slice(0, caret).lastIndexOf("\\\\");
  if (lastBreak === -1 || lastBreak < env.bodyStart) return null;
  if (formula.slice(lastBreak + 2, caret).trim() !== "") return null;

  const end = rowEndAt(formula, caret);
  if (formula.slice(caret, end).trim() !== "") return null;
  const close = /^\\end\{[^}]*\}/.exec(formula.slice(end));
  if (!close) return null;

  const insert = formula.slice(lastBreak, end).includes("\n") ? "\n" : " ";
  return {
    from: lastBreak,
    to: end,
    insert,
    caret: lastBreak + insert.length + close[0].length,
  };
}

export interface MatrixEnvSpan {
  name: string;
  /** The env-name ranges inside the `\begin{…}` and `\end{…}` markers —
   *  rewriting these two spans changes the brackets and nothing else. */
  beginName: { from: number; to: number };
  endName: { from: number; to: number };
}

/**
 * The `\begin{…}`/`\end{…}` pair enclosing `caret`, resolved to the nearest
 * *re-bracketable* ancestor: a caret inside `aligned` nested in `cases`
 * still reports the `cases` span. Returns null outside such an env.
 */
export function enclosingMatrixEnv(formula: string, caret: number): MatrixEnvSpan | null {
  const stack: { name: string; from: number; nameFrom: number }[] = [];
  for (const match of formula.matchAll(ENV_RE)) {
    // `\\begin` is a row break followed by the word "begin", not an opener.
    if (match.index > 0 && formula[match.index - 1] === "\\") continue;
    const name = match[2]!;
    const nameFrom = match.index + match[0].length - name.length - 1;
    if (match[1] === "begin") {
      stack.push({ name, from: match.index, nameFrom });
      continue;
    }
    for (let at = stack.length - 1; at >= 0; at -= 1) {
      if (stack[at]!.name !== name) continue;
      const open = stack.splice(at, 1)[0]!;
      if (
        open.from <= caret &&
        caret <= match.index + match[0].length &&
        DELIMITED_ENV.test(name)
      ) {
        return {
          name,
          beginName: { from: open.nameFrom, to: open.nameFrom + name.length },
          endName: { from: nameFrom, to: nameFrom + name.length },
        };
      }
      break;
    }
  }
  return null;
}
