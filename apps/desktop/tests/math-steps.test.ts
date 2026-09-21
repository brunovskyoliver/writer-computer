import { describe, expect, test } from "vite-plus/test";
import {
  atFormulaEnd,
  copyStepInsert,
  emptyStepInsert,
  formulaContentEnd,
} from "../src/lib/math/steps";

describe("atFormulaEnd", () => {
  test("caret on the last content line, formula content before it", () => {
    expect(atFormulaEnd("\nx^2+3x\n", 7)).toBe(true);
  });

  test("caret mid-formula is not the end", () => {
    expect(atFormulaEnd("\nx^2+3x\n", 4)).toBe(false);
  });

  test("trailing spaces after the caret still count as end", () => {
    expect(atFormulaEnd("\nx^2+3x   \n", 9)).toBe(true);
  });

  test("empty formula refuses", () => {
    expect(atFormulaEnd("\n\n", 1)).toBe(false);
  });

  test("caret inside an unclosed environment stays a matrix/plain Enter", () => {
    const formula = "\n\\begin{bmatrix}\n1 & 2\n";
    expect(atFormulaEnd(formula, formula.length)).toBe(false);
  });

  test("caret after a closed environment counts as end", () => {
    const formula = "\n\\begin{bmatrix}\n1 & 2\\\\3 & 4\n\\end{bmatrix}\n";
    expect(atFormulaEnd(formula, formula.length - 1)).toBe(true);
  });
});

describe("emptyStepInsert", () => {
  test("closes the block and opens an empty one with the caret inside", () => {
    const doc = "$$\nx^2+3x\n$$\n";
    const caret = 9; // after the last content char, before "\n$$"
    const step = emptyStepInsert();
    const next = doc.slice(0, caret) + step.insert + doc.slice(caret);
    expect(next).toBe("$$\nx^2+3x\n$$\n\n$$\n\n$$\n");
    expect(next.slice(0, caret + step.caretOffset).endsWith("$$\n")).toBe(true);
    // Caret sits on the empty content line of the new block.
    const caretAt = caret + step.caretOffset;
    expect(next[caretAt]).toBe("\n");
  });
});

describe("copyStepInsert", () => {
  test("duplicates the formula into a new block, caret at the copy's end", () => {
    const formula = "\nx^2+3x\n";
    const step = copyStepInsert(formula);
    expect(step.insert).toBe("\n$$\n\n$$\nx^2+3x");
    // Applied at the formula's content end, the old closing $$ closes the new block.
    const doc = "$$\nx^2+3x\n$$\n";
    const at = 2 + formulaContentEnd(formula); // formulaFrom is 2
    const next = doc.slice(0, at) + step.insert + doc.slice(at);
    expect(next).toBe("$$\nx^2+3x\n$$\n\n$$\nx^2+3x\n$$\n");
  });

  test("multiline formulas copy whole", () => {
    const step = copyStepInsert("\n\\begin{bmatrix}\n1\\\\2\n\\end{bmatrix}\n");
    expect(step.insert).toContain("\\begin{bmatrix}\n1\\\\2\n\\end{bmatrix}");
  });
});
