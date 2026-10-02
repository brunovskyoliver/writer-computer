import { describe, expect, it } from "vite-plus/test";
import { tidyFormula } from "../src/lib/math/tidy";

describe("tidyFormula", () => {
  it.each([
    "\\operatorname*{argmax} x",
    "\\tag*{A}",
    "\\begin{align*}x&=1\\end{align*}",
    "\\begin{matrix*}a&b\\end{matrix*}",
    "\\begin{array} {*{2}{c}} a&b\\end{array}",
    "x^{a*b} + y^{a+{b*c}}",
    "x ^ {a*b}",
    "\\text {a*b}",
    "\\operatorname{a*b}",
    "\\tag{a*b} + \\label{a*b}",
    "\\myCommand*{x}",
    "\\myCommand*{a*b}",
    "\\text{a % } note*b\nc*d}",
    "*x",
    "x*",
    "x**y",
    "x*=2",
  ])("preserves stars that are not multiplication: %s", (formula) => {
    expect(tidyFormula(formula)).toEqual({ text: formula, changes: 0 });
  });

  it("preserves syntax stars while tidying real products in the same formula", () => {
    expect(tidyFormula("\\operatorname*{argmax} x^{a*b} + 2*x").text).toBe(
      "\\operatorname*{argmax} x^{a*b} + 2 \\cdot x",
    );
  });

  it("tidies Greek, fraction, grouped and signed operands", () => {
    expect(tidyFormula("\\pi*\\theta + \\frac{a}{b}*{x+y} + (x+1)*-2").text).toBe(
      "\\pi \\cdot \\theta + \\frac{a}{b} \\cdot {x+y} + (x+1) \\cdot -2",
    );
  });

  it("preserves comment stars while tidying real products on both lines", () => {
    expect(tidyFormula("a*b % note*c\n+d*e").text).toBe("a \\cdot b % note*c\n+d \\cdot e");
    expect(tidyFormula("a\\% + b*c").text).toBe("a\\% + b \\cdot c");
  });

  it.each([
    ["\\text % note*c\n{a*b} + x*y", "\\text % note*c\n{a*b} + x \\cdot y"],
    ["x^% note*c\n{a*b} + y*z", "x^% note*c\n{a*b} + y \\cdot z"],
    ["\\operatorname* % note\n{a*b}", "\\operatorname* % note\n{a*b}"],
    ["\\href{https://example.com/a*b}{x*y}", "\\href{https://example.com/a*b}{x \\cdot y}"],
    ["\\url{https://example.com/a*b} + x*y", "\\url{https://example.com/a*b} + x \\cdot y"],
  ])("preserves literal syntax across comments and in URLs: %s", (formula, expected) => {
    expect(tidyFormula(formula).text).toBe(expected);
  });

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

  it("rewrites each separator once across overlapping nested matrix bodies", () => {
    const formula = "\\begin{bmatrix}a\\;\\begin{pmatrix}b\\;c\\end{pmatrix}\\end{bmatrix}";
    expect(tidyFormula(formula)).toEqual({
      text: "\\begin{bmatrix}a & \\begin{pmatrix}b & c\\end{pmatrix}\\end{bmatrix}",
      changes: 2,
    });
  });

  it.each([
    [
      "\\begin{bmatrix}\\text{a\\;b}\\;c\\end{bmatrix}",
      "\\begin{bmatrix}\\text{a\\;b} & c\\end{bmatrix}",
    ],
    [
      "\\begin{bmatrix}\\frac{a\\,b}{c\\:d}\\;e\\end{bmatrix}",
      "\\begin{bmatrix}\\frac{a\\,b}{c\\:d} & e\\end{bmatrix}",
    ],
    ["\\begin{bmatrix}a^{b\\;c}\\;d\\end{bmatrix}", "\\begin{bmatrix}a^{b\\;c} & d\\end{bmatrix}"],
    ["\\begin{array} {c@{\\,}c} a\\;b\\end{array}", "\\begin{array} {c@{\\,}c} a & b\\end{array}"],
    [
      "\\begin{subarray}% columns\\;\n{c} a\\;b\\end{subarray}",
      "\\begin{subarray}% columns\\;\n{c} a & b\\end{subarray}",
    ],
    ["\\begin{array}a\\;b\\end{array}", "\\begin{array}a\\;b\\end{array}"],
    ["\\begin{array}{cc a\\;b\\end{array}", "\\begin{array}{cc a\\;b\\end{array}"],
    [
      "\\begin{bmatrix}a\\;b % }\\end{bmatrix} \\;ignored\nc\\;d\\end{bmatrix}",
      "\\begin{bmatrix}a & b % }\\end{bmatrix} \\;ignored\nc & d\\end{bmatrix}",
    ],
    [
      "% \\begin{bmatrix}a\\;b\\end{bmatrix}\nx\\;y",
      "% \\begin{bmatrix}a\\;b\\end{bmatrix}\nx\\;y",
    ],
    [
      "\\begin{bmatrix}a\\;\\begin{cases}b\\;c\\end{cases}\\end{bmatrix}",
      "\\begin{bmatrix}a & \\begin{cases}b\\;c\\end{cases}\\end{bmatrix}",
    ],
    [
      "\\begin{bmatrix}\\sqrt[3\\,n]{x}\\;b\\end{bmatrix}",
      "\\begin{bmatrix}\\sqrt[3\\,n]{x} & b\\end{bmatrix}",
    ],
    ["\\begin{array}[t]{cc}a\\;b\\end{array}", "\\begin{array}[t]{cc}a & b\\end{array}"],
    [
      "\\begin{bmatrix}\\sqrt[3% ]\\;ignored\n\\,n]{x}\\;b\\end{bmatrix}",
      "\\begin{bmatrix}\\sqrt[3% ]\\;ignored\n\\,n]{x} & b\\end{bmatrix}",
    ],
    [
      "\\begin{bmatrix}\\sqrt[{]}3\\,n]{x}\\;b\\end{bmatrix}",
      "\\begin{bmatrix}\\sqrt[{]}3\\,n]{x} & b\\end{bmatrix}",
    ],
    [
      "\\begin{bmatrix}\\sqrt[3\\,n{x}\\;b\\end{bmatrix}",
      "\\begin{bmatrix}\\sqrt[3\\,n{x}\\;b\\end{bmatrix}",
    ],
    ["\\begin{array}[t{cc}a\\;b\\end{array}", "\\begin{array}[t{cc}a\\;b\\end{array}"],
  ])("preserves spacing outside the cell grammar: %s", (formula, expected) => {
    expect(tidyFormula(formula).text).toBe(expected);
  });

  it.each(["\\sqrt*{x}", "\\xrightarrow*{x}"])(
    "preserves a command's star argument while tidying an external product: %s",
    (command) => {
      expect(tidyFormula(`${command} + 2*x`).text).toBe(`${command} + 2 \\cdot x`);
    },
  );

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
