import katex from "katex";
import { describe, expect, it } from "vite-plus/test";
import {
  checkEquivalent,
  equalitySides,
  evaluateSource,
  evaluateExpr,
  parseExpression,
  formatComplex,
  sameValue,
} from "../src/lib/math/evaluate";

const val = (src: string) => {
  const out = evaluateSource(src);
  if (out.kind !== "value") throw new Error(`expected value, got ${JSON.stringify(out)}`);
  return out.value;
};
const re = (src: string) => val(src).re;
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

describe("evaluateSource", () => {
  it("evaluates arithmetic with LaTeX operators", () => {
    expect(near(re("2+3*4"), 14)).toBe(true);
    expect(near(re("2 \\cdot 3 + 4 \\times 5"), 26)).toBe(true);
    expect(near(re("10 \\div 4"), 2.5)).toBe(true);
    expect(near(re("-2^2"), -4)).toBe(true);
    expect(near(re("(-2)^2"), 4)).toBe(true);
  });

  it("evaluates \\frac, roots and powers", () => {
    expect(near(re("\\frac{3}{4}"), 0.75)).toBe(true);
    expect(near(re("\\frac12"), 0.5)).toBe(true);
    expect(near(re("\\sqrt{9}"), 3)).toBe(true);
    expect(near(re("\\sqrt[3]{27}"), 3)).toBe(true);
    expect(near(re("2^{10}"), 1024)).toBe(true);
  });

  it.each([
    ["2^12", 4],
    ["2^{12}", 4096],
    ["2^0.5", 0.5],
    ["2^{2^12}", 16],
    ["2^{\\sqrt{4}}", 4],
    ["2^\\frac12", Math.sqrt(2)],
    ["2^\\frac{\\sqrt4}3", Math.pow(2, 2 / 3)],
    ["2^\\pi", Math.pow(2, Math.PI)],
  ])("follows TeX superscript token boundaries: %s", (source, expected) => {
    expect(() => katex.renderToString(source)).not.toThrow();
    expect(re(source)).toBeCloseTo(expected, 10);
  });

  it("ends a bare letter exponent before the next letter", () => {
    const env = { x: { re: 2, im: 0 }, a: { re: 3, im: 0 }, b: { re: 4, im: 0 } };
    expect(evaluateExpr(parseExpression("x^ab"), env).re).toBe(32);
    expect(evaluateExpr(parseExpression("x^{ab}"), env).re).toBe(4096);
  });

  it.each([
    "2^-2",
    "2^(1+2)",
    "2^3^2",
    "2^{3}^2",
    "2^\\sin(0)",
    "2^x_1",
    "2^pi",
    "2^sin(0)",
    "2^\\sqrt{4}",
    "2^\\left(4\\right)",
    "2^\\frac(1+2)3",
    "\\sin^(2)(0)",
    "\\frac(1+2)3",
    "\\sqrt(9)",
    "2^\\frac\\frac123",
    "2^\\frac\\sqrt43",
  ])("leaves unsupported or malformed TeX scripts open: %s", (source) => {
    expect(evaluateSource(source).kind).toBe("open");
  });

  it("does not swallow a base subscript into an unbraced exponent", () => {
    expect(() => parseExpression("2^x_1")).toThrow();
  });

  it.each(["sin(0)", "cos(0)", "pi"])(
    "keeps bare plot aliases open in rendered TeX: %s",
    (source) => {
      expect(evaluateSource(source).kind).toBe("open");
    },
  );

  it("evaluates functions and inverses", () => {
    expect(near(re("\\sin{\\frac{\\pi}{2}}"), 1)).toBe(true);
    expect(near(re("\\cosh^{-1}(2)"), Math.acosh(2))).toBe(true);
    expect(near(re("\\ln(e^2)"), 2)).toBe(true);
    expect(near(re("\\log(1000)"), 3)).toBe(true);
    expect(near(re("\\sin^2(0.5) + \\cos^2(0.5)"), 1)).toBe(true);
    expect(near(re("\\sin(0) + \\cos(0)"), 1)).toBe(true);
  });

  it("evaluates \\left(\\right) and absolute values", () => {
    expect(near(re("\\left( 1+2 \\right) \\cdot 3"), 9)).toBe(true);
    expect(near(re("\\lvert -4 \\rvert + |3-5|"), 6)).toBe(true);
  });

  it("does complex arithmetic with j and i", () => {
    const z = val("2660-2565*j");
    expect(z.re).toBe(2660);
    expect(z.im).toBe(-2565);
    // Euler identity.
    const euler = val("e^{\\pi j} + 1");
    expect(Math.abs(euler.re)).toBeLessThan(1e-9);
    expect(Math.abs(euler.im)).toBeLessThan(1e-9);
  });

  it("reports free variables as open", () => {
    const out = evaluateSource("x^2 - 4");
    expect(out.kind).toBe("open");
    if (out.kind === "open") expect(out.freeVars).toEqual(["x"]);
  });

  it("marks out-of-subset constructs open", () => {
    for (const src of [
      "\\text{hello}",
      "\\begin{bmatrix} 1 \\end{bmatrix}",
      "a \\\\ b",
      "50\\%",
      "\\hat{x}",
    ]) {
      expect(evaluateSource(src).kind).toBe("open");
    }
  });
});

describe("equalitySides", () => {
  it("splits on top-level =", () => {
    expect(equalitySides("x+1 = 5")).toEqual(["x+1", "5"]);
    expect(equalitySides("a = b = c")).toEqual(["a", "b", "c"]);
  });

  it("ignores = inside braces and environments", () => {
    expect(equalitySides("\\frac{a=b}{c} = 1")).toEqual(["\\frac{a=b}{c}", "1"]);
    expect(equalitySides("\\begin{bmatrix} a = b \\end{bmatrix}")).toBeNull();
  });

  it("splits \\approx like =", () => {
    expect(equalitySides("e \\approx 2.718")).toEqual(["e", "2.718"]);
  });
});

describe("sameValue / formatComplex", () => {
  it("compares within relative epsilon", () => {
    expect(sameValue({ re: 1, im: 0 }, { re: 1 + 1e-10, im: 0 })).toBe(true);
    expect(sameValue({ re: 1, im: 0 }, { re: 1.01, im: 0 })).toBe(false);
  });

  it("formats reals and j-form complexes", () => {
    expect(formatComplex({ re: 1.5430000001, im: 0 })).toBe("1.543");
    expect(formatComplex({ re: 42, im: 0 })).toBe("42");
    expect(formatComplex({ re: 2660, im: -2565 })).toBe("2660 - 2565j");
    expect(formatComplex({ re: 0, im: 2 })).toBe("2j");
  });
});

it.each([
  [{ re: 300000, im: 0 }, "300000"],
  [{ re: -300000, im: 0 }, "-300000"],
  [{ re: 1200000, im: 0 }, "1200000"],
  [{ re: 0, im: 300000 }, "300000j"],
  [{ re: 300000, im: -400000 }, "300000 - 400000j"],
  [{ re: 1e30, im: 0 }, "1e+30"],
  [{ re: 1.2e30, im: 0 }, "1.2e+30"],
  [{ re: 1.4e308, im: 1.4e308 }, "1.4e+308 + 1.4e+308j"],
] as const)("preserves integer/scientific place values: %o", (value, expected) => {
  expect(formatComplex(value)).toBe(expected);
});

describe("checkEquivalent", () => {
  it("accepts algebraically equal steps with free variables", () => {
    expect(checkEquivalent("x^2 + 3x", "x(x+3)").kind).toBe("equal");
    expect(checkEquivalent("(a+b)^2", "a^2 + 2ab + b^2").kind).toBe("equal");
  });

  it("compares lhs - rhs when the step is an equation", () => {
    expect(checkEquivalent("x^2 = 4", "x = 2")).toEqual(
      expect.objectContaining({ kind: "differs" }),
    );
    expect(checkEquivalent("2x = 6", "x = 3").kind).toBe("equal");
  });

  it.each([
    ["x", "2x"],
    ["x", "-x"],
    ["j", "-j"],
    ["1", "99"],
    ["j", "2j"],
    ["x+1", "3x+3"],
  ])("compares expression values rather than scale: %s versus %s", (prev, next) => {
    expect(checkEquivalent(prev, next).kind).toBe("differs");
  });

  it.each([
    ["x=1", "x-1"],
    ["x-1", "x=1"],
    ["x=1=2", "x=1"],
    ["x=1", "x=1=2"],
  ])("refuses mixed forms and equation chains: %s versus %s", (prev, next) => {
    expect(checkEquivalent(prev, next).kind).toBe("open");
  });

  it("accepts equal closed expressions and scaled single equations", () => {
    expect(checkEquivalent("2+3", "5").kind).toBe("equal");
    expect(checkEquivalent("x=3", "-2x=-6").kind).toBe("equal");
  });

  it.each(["\\ln(0)", "\\frac{1}{0}", "\\frac{1}{x-x}", "\\frac{1}{x-x}=0"])(
    "requires usable evidence even for identical inputs: %s",
    (source) => {
      expect(checkEquivalent(source, source).kind).toBe("open");
    },
  );

  it("reports insufficient evidence when only two candidate assignments are finite", () => {
    const denominator = [1.7, 3.7, -1.1, -2.3, -0.77, 2.9].map((p) => `(x-(${p}))`).join("");
    const source = `1/(${denominator})`;
    expect(checkEquivalent(source, source).kind).toBe("open");
  });

  it("recovers enough evidence past a singular sample", () => {
    expect(checkEquivalent("1/(x-1.7)", "1/(x-1.7)").kind).toBe("equal");
    expect(checkEquivalent("x-x", "0").kind).toBe("equal");
    expect(checkEquivalent("x=x", "2x=2x").kind).toBe("equal");
  });

  it("finds a counterexample after skipping a singularity", () => {
    expect(checkEquivalent("1/(x-1.7)", "1/(x-1.7)+(x-3.7)(x+1.1)").kind).toBe("differs");
  });

  it("does not certify equality when finite complex magnitudes overflow", () => {
    const source = "1.4*10^{308}(1+j)";
    expect([val(source).re, val(source).im].every(Number.isFinite)).toBe(true);
    expect(checkEquivalent(source, `-(${source})`).kind).toBe("differs");
  });

  it.each([
    ["10^{308}=0", "0.1=0"],
    ["1=0", "10^{200}=0"],
  ])("does not count an invalid ratio between finite residuals: %s versus %s", (a, b) => {
    expect(checkEquivalent(a, b).kind).toBe("open");
  });

  it("flags a dropped sign", () => {
    expect(checkEquivalent("(x-1)(x+1)", "x^2 - 2x - 1").kind).toBe("differs");
  });

  it("reports unparseable formulas as open", () => {
    expect(checkEquivalent("x = \\text{done}", "x = 1").kind).toBe("open");
  });
});
