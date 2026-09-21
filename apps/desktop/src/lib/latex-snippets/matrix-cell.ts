/**
 * Tab inside a matrix-like environment walks the row's elements: it lands just
 * past the next `&` or thin-space separator (`\;`, `\,`, `\:`) in the same
 * row, and when the row has no separator left it appends one so a new element
 * opens — Enter already owns new rows. Pure string logic so the decision is
 * unit-testable without a view.
 *
 * Rules: SPECs/matrix-brace-tools/spec.md (FR-10).
 */

import { innermostEnvAt } from "./matrix-row";

/** Environments whose rows split into elements. `gathered` is excluded — it
 *  typesets a single column, so a separator there is never an element edge. */
const CELL_ENV =
  /^(?:[pbBvV]?matrix\*?|smallmatrix|array|subarray|[dr]?cases|aligned?|alignedat|split)$/;

/** Separator characters a `\` introduces: `\;` `\,` `\:` thin spaces. */
const THIN_SEPARATORS = new Set([";", ",", ":"]);

const ENV_TOKEN = /^\\(begin|end)\{/;

export type MatrixCellTarget =
  /** Caret lands just past the next element separator in the row. */
  | { kind: "move"; to: number }
  /** The row's last element is reached: insert `text` at `at` and put the
   *  caret in the fresh element. */
  | { kind: "insert"; at: number; text: string; caret: number };

/** First position after `from` that is not a space/tab/newline, capped at `to`. */
function skipSpaces(text: string, from: number, to: number): number {
  let at = from;
  while (at < to && /\s/.test(text[at]!)) at += 1;
  return at;
}

/**
 * The next element separator in `[from, to)`: an unescaped `&` or a thin-space
 * command, skipping anything inside `{…}` groups or nested environments.
 */
function nextSeparator(
  formula: string,
  from: number,
  to: number,
): { index: number; raw: string } | null {
  let braces = 0;
  let nested = 0;
  for (let i = from; i < to; i += 1) {
    const ch = formula[i]!;
    if (ch === "\\") {
      const token = ENV_TOKEN.exec(formula.slice(i, i + 8));
      if (token) {
        nested += token[1] === "begin" ? 1 : -1;
        i += token[0].length - 1;
        continue;
      }
      const next = formula[i + 1]!;
      if (braces === 0 && nested === 0 && THIN_SEPARATORS.has(next)) {
        return { index: i, raw: formula.slice(i, i + 2) };
      }
      i += 1; // macro or escaped char — the second char is never a separator
      continue;
    }
    if (braces === 0 && nested === 0 && ch === "&") return { index: i, raw: "&" };
    if (ch === "{") braces += 1;
    else if (ch === "}") braces -= 1;
  }
  return null;
}

/**
 * Where Tab goes inside a matrix row, or null when the caret is not on a
 * matrix row with content — the caller then falls back to plain tab-out.
 *
 * The row spans from the env's body start (or the last `\\`) to the next
 * top-level `\\` or `\end{…}`. A separator ahead moves the caret past it;
 * none means the last element, so a separator matching the env's existing
 * style (` & ` or `\;`/`\,`/`\:`) is appended instead.
 */
export function matrixCellTarget(formula: string, caret: number): MatrixCellTarget | null {
  const env = innermostEnvAt(formula, caret);
  if (!env || !CELL_ENV.test(env.name) || caret < env.bodyStart) return null;

  // Caret straddling the `\\` pair itself is on neither row — leave it to
  // tab-out, which jumps past the break.
  if (formula[caret - 1] === "\\" && formula[caret] === "\\") return null;

  let rowStart = env.bodyStart;
  const lastBreak = formula.slice(0, caret).lastIndexOf("\\\\");
  if (lastBreak !== -1 && lastBreak + 2 > rowStart) rowStart = lastBreak + 2;
  if (caret < rowStart) return null;

  // The row ends at the first `\\` or `\end{…}` outside a nested environment.
  let depth = 0;
  let rowEnd = formula.length;
  for (let i = caret; i < formula.length; i += 1) {
    if (formula[i] !== "\\") continue;
    if (formula[i + 1] === "\\") {
      if (depth === 0) {
        rowEnd = i;
        break;
      }
      i += 1;
      continue;
    }
    const token = ENV_TOKEN.exec(formula.slice(i, i + 8));
    if (token) {
      if (token[1] === "begin") depth += 1;
      else if (depth > 0) depth -= 1;
      else {
        rowEnd = i;
        break;
      }
      i += token[0].length - 1;
      continue;
    }
    i += 1;
  }

  const ahead = nextSeparator(formula, caret, rowEnd);
  if (ahead) {
    return { kind: "move", to: skipSpaces(formula, ahead.index + ahead.raw.length, rowEnd) };
  }

  // Last element: an empty row has nothing to extend — leave Tab alone.
  if (formula.slice(rowStart, rowEnd).trim() === "") return null;

  let at = rowEnd;
  while (at > caret && /\s/.test(formula[at - 1]!)) at -= 1;

  const style = nextSeparator(formula, env.bodyStart, rowEnd);
  const text = style === null || style.raw === "&" ? " & " : style.raw;
  return { kind: "insert", at, text, caret: at + text.length };
}
