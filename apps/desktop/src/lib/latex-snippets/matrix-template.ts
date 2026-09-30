/**
 * A filled matrix from a size and an element letter: `2x3 a` becomes a
 * `bmatrix` whose cells are `a_{11}` … `a_{23}`. Pure so the parsing and the
 * layout are unit-testable without the dialog that asks for them.
 */

export type MatrixSpec = { rows: number; cols: number; letter: string };

/** Beyond this the matrix is unreadable as source and KaTeX's own column cap
 *  gets close; nobody types a 30×30 by hand. */
export const MATRIX_MAX_SIZE = 20;

const DEFAULT_LETTER = "a";

/** `3x3 a`, `3 3 a`, `3*3a`, `3×3`, `2 by 4 b`, `3,3,\lambda`. The letter is
 *  one Latin letter or a macro like `\lambda`; it defaults to `a`. */
const SPEC_RE =
  /^\s*(\d{1,2})\s*(?:x|×|\*|,|by|\s)\s*(\d{1,2})\s*,?\s*([A-Za-z]|\\[A-Za-z]+)?\s*$/i;

export function parseMatrixSpec(input: string): MatrixSpec | null {
  const match = SPEC_RE.exec(input);
  if (!match) return null;
  const rows = Number(match[1]);
  const cols = Number(match[2]);
  if (rows < 1 || cols < 1 || rows > MATRIX_MAX_SIZE || cols > MATRIX_MAX_SIZE) return null;
  return { rows, cols, letter: match[3] ?? DEFAULT_LETTER };
}

/**
 * The environment, one row per line for display math or on a single line for
 * inline math. Indices run together (`a_{12}`) while both fit in one digit and
 * take a comma (`a_{1,10}`) once either does, so `a_{111}` is never ambiguous.
 */
export function matrixTemplate(
  spec: MatrixSpec,
  options: { env?: string; inline?: boolean } = {},
): string {
  const env = options.env ?? "bmatrix";
  const comma = spec.rows > 9 || spec.cols > 9 ? "," : "";
  const rows: string[] = [];
  for (let i = 1; i <= spec.rows; i += 1) {
    const cells: string[] = [];
    for (let j = 1; j <= spec.cols; j += 1) cells.push(`${spec.letter}_{${i}${comma}${j}}`);
    rows.push(cells.join(" & "));
  }
  return options.inline
    ? `\\begin{${env}} ${rows.join(" \\\\ ")} \\end{${env}}`
    : `\\begin{${env}}\n${rows.join("\\\\\n")}\n\\end{${env}}`;
}
