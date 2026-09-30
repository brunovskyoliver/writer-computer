import { describe, expect, test } from "vite-plus/test";
import { matrixTemplate, parseMatrixSpec } from "../src/lib/latex-snippets/matrix-template";

describe("parseMatrixSpec", () => {
  test.each([
    ["3x3 a", { rows: 3, cols: 3, letter: "a" }],
    ["2X4b", { rows: 2, cols: 4, letter: "b" }],
    ["2 3 c", { rows: 2, cols: 3, letter: "c" }],
    ["2*3", { rows: 2, cols: 3, letter: "a" }],
    ["2×3 A", { rows: 2, cols: 3, letter: "A" }],
    ["2 by 4 b", { rows: 2, cols: 4, letter: "b" }],
    ["3,3,\\lambda", { rows: 3, cols: 3, letter: "\\lambda" }],
    ["  1x1  ", { rows: 1, cols: 1, letter: "a" }],
  ])("%s", (input, spec) => {
    expect(parseMatrixSpec(input)).toEqual(spec);
  });

  test.each(["", "3", "3x", "0x2", "2x0", "21x2", "3x3 ab", "axb"])("rejects %j", (input) => {
    expect(parseMatrixSpec(input)).toBeNull();
  });
});

describe("matrixTemplate", () => {
  test("display matrix puts one row per line", () => {
    expect(matrixTemplate({ rows: 2, cols: 3, letter: "a" })).toBe(
      "\\begin{bmatrix}\na_{11} & a_{12} & a_{13}\\\\\na_{21} & a_{22} & a_{23}\n\\end{bmatrix}",
    );
  });

  test("inline matrix stays on one line", () => {
    expect(matrixTemplate({ rows: 2, cols: 1, letter: "x" }, { inline: true })).toBe(
      "\\begin{bmatrix} x_{11} \\\\ x_{21} \\end{bmatrix}",
    );
  });

  test("two-digit sizes separate the indices with a comma", () => {
    const text = matrixTemplate({ rows: 1, cols: 10, letter: "a" });
    expect(text).toContain("a_{1,1} & ");
    expect(text).toContain("a_{1,10}");
  });
});
