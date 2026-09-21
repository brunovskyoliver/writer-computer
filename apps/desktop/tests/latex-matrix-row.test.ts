import { describe, expect, test } from "vite-plus/test";
import { matrixRowBreak } from "../src/lib/latex-snippets/matrix-row";

/** caret marker: `|` inside the formula string. */
function check(formula: string): boolean {
  const caret = formula.indexOf("|");
  return matrixRowBreak(formula.replace("|", ""), caret);
}

describe("matrixRowBreak", () => {
  test("is true on a filled row inside a matrix env", () => {
    expect(check("\\begin{pmatrix}\na & b|\n\\end{pmatrix}")).toBe(true);
    expect(check("\\begin{bmatrix} a & b| \\end{bmatrix}")).toBe(true);
    expect(check("\\begin{cases} x & x>0| \\\\ y & x<0 \\end{cases}")).toBe(true);
  });

  test("is true mid-row, not just at row end", () => {
    expect(check("\\begin{pmatrix}\na &| b\n\\end{pmatrix}")).toBe(true);
  });

  test("is false on the \\begin line with no row content yet", () => {
    expect(check("\\begin{pmatrix}|\n\\end{pmatrix}")).toBe(false);
    expect(check("\\begin{pmatrix}\n|\n\\end{pmatrix}")).toBe(false);
  });

  test("is false on an empty row — Enter leaves the env instead of stacking breaks", () => {
    expect(check("\\begin{pmatrix}\na & b \\\\\n|\n\\end{pmatrix}")).toBe(false);
  });

  test("is false outside any environment", () => {
    expect(check("a + b = c|")).toBe(false);
    expect(check("\\frac{a}{b}|")).toBe(false);
  });

  test("is false after the environment closes", () => {
    expect(check("\\begin{pmatrix}\na & b\n\\end{pmatrix} + |")).toBe(false);
  });

  test("respects the env that actually wraps the caret, not an inner or outer one", () => {
    // caret inside a plain formula after the env ended
    expect(check("\\begin{pmatrix} a \\end{pmatrix} x|")).toBe(false);
    // nested: caret in a matrix inside an align block still counts
    expect(check("\\begin{align}\n\\begin{pmatrix} a & b| \\end{pmatrix}\n\\end{align}")).toBe(
      true,
    );
  });

  test("a `\\\\begin` on the same row is not an opener", () => {
    // `\\` (row break) + `begin{pmatrix}` — the second backslash's "begin" is
    // literal text, not an environment opener.
    expect(check("a \\\\begin{pmatrix} x|")).toBe(false);
  });

  test("skips an array column spec when measuring the row", () => {
    expect(check("\\begin{array}{cc}|")).toBe(false);
    expect(check("\\begin{array}{cc} a|")).toBe(true);
  });
});
