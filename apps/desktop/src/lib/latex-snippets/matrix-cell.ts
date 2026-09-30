/**
 * Tab inside a matrix-like environment walks the row's elements: it lands just
 * past the next `&` or thin-space separator (`\;`, `\,`, `\:`) in the same
 * row, and when the row has no separator left it appends one so a new element
 * opens — Enter already owns new rows. Pure string logic so the decision is
 * unit-testable without a view.
 *
 * Rules: SPECs/matrix-brace-tools/spec.md (FR-10).
 */

import { innermostEnvAt, rowEndAt } from "./matrix-row";

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
  | { kind: "insert"; at: number; text: string; caret: number }
  /** The caret sits in an empty trailing element: delete `[from, to)` — the
   *  separator that opened it — and put the caret at `caret` (an offset in
   *  the formula *after* the delete): the next row's first element, or past
   *  `\end{…}` on the last row. Tab twice at a row's end leaves the matrix. */
  | { kind: "leave"; from: number; to: number; caret: number };

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
        nested = Math.max(0, nested + (token[1] === "begin" ? 1 : -1));
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
    // A `}` with no `{` since `from` closes the group the caret started in
    // (`a_{1|1} & …`); the separators after it are top-level again.
    else if (ch === "}") braces = Math.max(0, braces - 1);
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

  const rowEnd = rowEndAt(formula, caret);

  const ahead = nextSeparator(formula, caret, rowEnd);
  if (ahead) {
    return { kind: "move", to: skipSpaces(formula, ahead.index + ahead.raw.length, rowEnd) };
  }

  // Last element: an empty row has nothing to extend — leave Tab alone.
  if (formula.slice(rowStart, rowEnd).trim() === "") return null;

  const leave = leaveEmptyElement(formula, rowStart, rowEnd, caret);
  if (leave) return leave;

  let at = rowEnd;
  while (at > caret && /\s/.test(formula[at - 1]!)) at -= 1;

  const style = nextSeparator(formula, env.bodyStart, rowEnd);
  const text = style === null || style.raw === "&" ? " & " : style.raw;
  return { kind: "insert", at, text, caret: at + text.length };
}

/**
 * The caret is in an empty last element (`1 & 2 & |`): the element was opened
 * by a Tab that found nothing more to type. Undo it and move on — to the next
 * row, or out past `\end{…}` when this is the last row. Null when the last
 * element has content or the environment is not closed.
 */
function leaveEmptyElement(
  formula: string,
  rowStart: number,
  rowEnd: number,
  caret: number,
): MatrixCellTarget | null {
  let last: { index: number; raw: string } | null = null;
  for (let at = rowStart; ; ) {
    const separator = nextSeparator(formula, at, caret);
    if (!separator) break;
    last = separator;
    at = separator.index + separator.raw.length;
  }
  if (!last) return null;
  const elementFrom = last.index + last.raw.length;
  if (formula.slice(elementFrom, rowEnd).trim() !== "") return null;

  let from = last.index;
  while (from > rowStart && (formula[from - 1] === " " || formula[from - 1] === "\t")) from -= 1;
  // Up to the caret: whitespace past it (before `\end{…}`) stays put.
  const to = Math.max(elementFrom, caret);
  const removed = to - from;

  if (formula.startsWith("\\\\", rowEnd)) {
    return {
      kind: "leave",
      from,
      to,
      caret: skipSpaces(formula, rowEnd + 2, formula.length) - removed,
    };
  }
  const close = /^\\end\{[^}]*\}/.exec(formula.slice(rowEnd));
  if (!close) return null;
  return { kind: "leave", from, to, caret: rowEnd + close[0].length - removed };
}
