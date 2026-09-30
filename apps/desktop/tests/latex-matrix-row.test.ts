import { describe, expect, test } from "vite-plus/test";
import {
  enclosingMatrixEnv,
  matrixRowBreak,
  matrixRowExit,
} from "../src/lib/latex-snippets/matrix-row";

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

describe("enclosingMatrixEnv", () => {
  /** caret marker: `|` inside the formula string. */
  function envAt(formula: string) {
    const caret = formula.indexOf("|");
    return enclosingMatrixEnv(formula.replace("|", ""), caret);
  }

  test("reports the env name and both marker spans", () => {
    const span = envAt("\\begin{cases}\na \\\\\nb|\n\\end{cases}")!;
    expect(span.name).toBe("cases");
    const clean = "\\begin{cases}\na \\\\\nb\n\\end{cases}";
    expect(clean.slice(span.beginName.from, span.beginName.to)).toBe("cases");
    expect(clean.slice(span.endName.from, span.endName.to)).toBe("cases");
  });

  test("caret anywhere in the env counts, including the markers", () => {
    expect(envAt("\\begin{|pmatrix} a \\end{pmatrix}")!.name).toBe("pmatrix");
    expect(envAt("\\begin{pmatrix} a \\end{pmat|rix}")!.name).toBe("pmatrix");
    expect(envAt("\\begin{pmatrix} a \\end{pmatrix} |")).toBeNull();
  });

  test("innermost delimited env wins over outer pairs", () => {
    expect(envAt("\\begin{cases} \\begin{bmatrix} a| \\end{bmatrix} \\end{cases}")!.name).toBe(
      "bmatrix",
    );
  });

  test("a caret inside a non-delimited inner env reaches the outer matrix", () => {
    // `aligned` has no brackets of its own — the re-bracket target is cases.
    expect(envAt("\\begin{cases} \\begin{aligned} a| \\end{aligned} \\end{cases}")!.name).toBe(
      "cases",
    );
  });

  test("array refuses — its colspec would be left as a literal group", () => {
    expect(envAt("\\begin{array}{cc} a| \\end{array}")).toBeNull();
    expect(envAt("a + b|")).toBeNull();
  });

  test("an unclosed \\end or `\\\\begin` row text never matches", () => {
    expect(envAt("\\begin{pmatrix} a \\\\begin{pmatrix} |")).toBeNull();
  });
});

/** Apply `matrixRowExit` at the `|` and re-render with `|` at the new caret. */
function exitAt(formula: string): string | null {
  const caret = formula.indexOf("|");
  const plain = formula.replace("|", "");
  const edit = matrixRowExit(plain, caret);
  if (!edit) return null;
  const text = plain.slice(0, edit.from) + edit.insert + plain.slice(edit.to);
  return text.slice(0, edit.caret) + "|" + text.slice(edit.caret);
}

describe("matrixRowExit", () => {
  test("Enter on the empty last row drops it and lands past \\end", () => {
    expect(exitAt("\\begin{bmatrix}\n1 & 2\\\\\n3 & 4\\\\\n|\n\\end{bmatrix}")).toBe(
      "\\begin{bmatrix}\n1 & 2\\\\\n3 & 4\n\\end{bmatrix}|",
    );
  });

  test("works on one line too", () => {
    expect(exitAt("\\begin{bmatrix}1 & 2\\\\ |\\end{bmatrix}")).toBe(
      "\\begin{bmatrix}1 & 2 \\end{bmatrix}|",
    );
  });

  test("an empty row with rows below it is left alone", () => {
    expect(exitAt("\\begin{bmatrix}\n1\\\\\n|\\\\\n2\n\\end{bmatrix}")).toBeNull();
  });

  test("a row with content, or the first row, is left alone", () => {
    expect(exitAt("\\begin{bmatrix}\n1\\\\\n2|\n\\end{bmatrix}")).toBeNull();
    expect(exitAt("\\begin{bmatrix}\n|\n\\end{bmatrix}")).toBeNull();
  });
});
