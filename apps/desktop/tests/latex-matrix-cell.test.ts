import { describe, expect, test } from "vite-plus/test";
import { matrixCellTarget, type MatrixCellTarget } from "../src/lib/latex-snippets/matrix-cell";

/** caret marker: `|` inside the formula string. */
function targetAt(formula: string): MatrixCellTarget | null {
  const caret = formula.indexOf("|");
  return matrixCellTarget(formula.replace("|", ""), caret);
}

/** Apply the target and re-render the formula with `|` at the caret. */
function apply(formula: string): string | null {
  const caret = formula.indexOf("|");
  const plain = formula.replace("|", "");
  const target = matrixCellTarget(plain, caret);
  if (!target) return null;
  const at = target.kind === "move" ? target.to : target.caret;
  const text =
    target.kind === "insert"
      ? plain.slice(0, target.at) + target.text + plain.slice(target.at)
      : plain;
  return text.slice(0, at) + "|" + text.slice(at);
}

describe("matrixCellTarget — move", () => {
  test("jumps past the next & in the same row", () => {
    expect(apply("\\begin{pmatrix} a| & b \\\\ c & d \\end{pmatrix}")).toBe(
      "\\begin{pmatrix} a & |b \\\\ c & d \\end{pmatrix}",
    );
  });

  test("skips the space after &", () => {
    expect(apply("\\begin{pmatrix} a |& b \\end{pmatrix}")).toBe(
      "\\begin{pmatrix} a & |b \\end{pmatrix}",
    );
  });

  test("jumps past \\; thin-space separators (SDU matrix style)", () => {
    expect(apply("\\begin{bmatrix} 2\\;|1\\;0 \\end{bmatrix}")).toBe(
      "\\begin{bmatrix} 2\\;1\\;|0 \\end{bmatrix}",
    );
    expect(apply("\\begin{bmatrix} |2\\;1\\;0 \\end{bmatrix}")).toBe(
      "\\begin{bmatrix} 2\\;|1\\;0 \\end{bmatrix}",
    );
  });

  test("ignores & inside a brace group", () => {
    expect(apply("\\begin{pmatrix} \\frac{a&b}{c}| & d \\end{pmatrix}")).toBe(
      "\\begin{pmatrix} \\frac{a&b}{c} & |d \\end{pmatrix}",
    );
  });

  test("ignores separators inside a nested environment", () => {
    expect(apply("\\begin{cases} \\begin{aligned} a &= b \\end{aligned} |& c \\end{cases}")).toBe(
      "\\begin{cases} \\begin{aligned} a &= b \\end{aligned} & |c \\end{cases}",
    );
  });

  test("does not cross the row break", () => {
    // no separator ahead in this row → insert, not a jump past `\\`
    expect(apply("\\begin{pmatrix} a & b| \\\\ c & d \\end{pmatrix}")).toBe(
      "\\begin{pmatrix} a & b & | \\\\ c & d \\end{pmatrix}",
    );
  });
});

describe("matrixCellTarget — caret inside a group", () => {
  test("a subscript's closing brace does not hide the next &", () => {
    expect(apply("\\begin{bmatrix} a_{1|1} & a_{12} \\end{bmatrix}")).toBe(
      "\\begin{bmatrix} a_{11} & |a_{12} \\end{bmatrix}",
    );
  });

  test("works from inside a \\textcolor argument", () => {
    expect(apply("\\begin{bmatrix}\\textcolor{#e0a000}{2|} & 3 & 1\\end{bmatrix}")).toBe(
      "\\begin{bmatrix}\\textcolor{#e0a000}{2} & |3 & 1\\end{bmatrix}",
    );
  });
});

describe("matrixCellTarget — insert", () => {
  test("appends ` & ` at the end of an &-style row", () => {
    expect(apply("\\begin{pmatrix} a & b| \\end{pmatrix}")).toBe(
      "\\begin{pmatrix} a & b & | \\end{pmatrix}",
    );
  });

  test("appends `\\;` at the end of a \\;-style row", () => {
    expect(apply("\\begin{bmatrix} 2\\;1\\;0| \\end{bmatrix}")).toBe(
      "\\begin{bmatrix} 2\\;1\\;0\\;| \\end{bmatrix}",
    );
  });

  test("takes the separator style from an earlier row", () => {
    expect(apply("\\begin{bmatrix} 2\\;1 \\\\ 3| \\end{bmatrix}")).toBe(
      "\\begin{bmatrix} 2\\;1 \\\\ 3\\;| \\end{bmatrix}",
    );
  });

  test("defaults to ` & ` when the env has no separator yet", () => {
    expect(apply("\\begin{pmatrix} a b| \\end{pmatrix}")).toBe(
      "\\begin{pmatrix} a b & | \\end{pmatrix}",
    );
  });

  test("inserts at the element end, not mid-element", () => {
    expect(apply("\\begin{pmatrix} a & b| c \\end{pmatrix}")).toBe(
      "\\begin{pmatrix} a & b c & | \\end{pmatrix}",
    );
  });

  test("a caret right after a separator already sits on a fresh element — next Tab creates one", () => {
    expect(apply("\\begin{pmatrix} a &| b \\end{pmatrix}")).toBe(
      "\\begin{pmatrix} a & b & | \\end{pmatrix}",
    );
  });
});

describe("matrixCellTarget — refuses", () => {
  test("outside any environment", () => {
    expect(targetAt("a &| b")).toBeNull();
  });

  test("outside the env, after it closes", () => {
    expect(targetAt("\\begin{pmatrix} a & b \\end{pmatrix} x|")).toBeNull();
  });

  test("on an empty row — Tab keeps its plain tab-out job there", () => {
    expect(targetAt("\\begin{pmatrix} a & b \\\\ | \\end{pmatrix}")).toBeNull();
  });

  test("inside the \\\\ row break itself", () => {
    expect(targetAt("\\begin{pmatrix} a \\|\\ b \\end{pmatrix}")).toBeNull();
  });

  test("inside gathered — a single-column env has no cells", () => {
    expect(targetAt("\\begin{gathered} a| \\end{gathered}")).toBeNull();
  });
});
