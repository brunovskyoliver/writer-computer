import { describe, expect, it } from "vite-plus/test";
import { tidyFormula } from "../src/lib/math/tidy";

describe("tidyFormula", () => {
  it("converts \\; separators to & inside matrix bodies", () => {
    expect(tidyFormula("\\begin{bmatrix} 2\\;1\\;0 \\end{bmatrix}").text).toBe(
      "\\begin{bmatrix} 2 & 1 & 0 \\end{bmatrix}",
    );
  });

  it("converts \\, and \\: separators too", () => {
    expect(tidyFormula("\\begin{pmatrix} a\\,b\\:c \\end{pmatrix}").text).toBe(
      "\\begin{pmatrix} a & b & c \\end{pmatrix}",
    );
  });

  it("leaves \\; alone outside matrix environments", () => {
    const formula = "x\\;y + \\begin{gathered} a\\;b \\end{gathered}";
    const result = tidyFormula(formula);
    expect(result.text).toBe(formula);
    expect(result.changes).toBe(0);
  });

  it("handles a cases environment", () => {
    expect(tidyFormula("\\begin{cases} x & x>0 \\; -x & x<0 \\end{cases}").text).toBe(
      "\\begin{cases} x & x>0 \\; -x & x<0 \\end{cases}",
    );
  });

  it("rewrites * to \\cdot between operands", () => {
    expect(tidyFormula("2*x + y*z").text).toBe("2 \\cdot x + y \\cdot z");
  });

  it("keeps conjugate stars", () => {
    const formula = "z^* + w^{*} + v^{ * }";
    expect(tidyFormula(formula).text).toBe(formula);
  });

  it("keeps stars inside \\text groups", () => {
    const formula = "x*2 \\text{ a*b } y*3";
    expect(tidyFormula(formula).text).toBe("x \\cdot 2 \\text{ a*b } y \\cdot 3");
  });

  it("skips a column spec before tidying an array body", () => {
    expect(tidyFormula("\\begin{array}{cc} a\\;b \\\\ c\\;d \\end{array}").text).toBe(
      "\\begin{array}{cc} a & b \\\\ c & d \\end{array}",
    );
  });

  it("counts every rewrite", () => {
    expect(tidyFormula("a*b + \\begin{bmatrix} c\\;d \\end{bmatrix}").changes).toBe(2);
  });

  it("returns the input untouched when nothing needs fixing", () => {
    const formula = "\\frac{a}{b} = c & d \\\\ e";
    const result = tidyFormula(formula);
    expect(result.text).toBe(formula);
    expect(result.changes).toBe(0);
  });
});
