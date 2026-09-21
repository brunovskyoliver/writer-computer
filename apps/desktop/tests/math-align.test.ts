import { describe, expect, it } from "vite-plus/test";
import { alignRun, splitAligned } from "../src/lib/math/align";

describe("alignRun", () => {
  it("marks the first = of each step", () => {
    expect(alignRun(["x^2 + 3x = 0", "x(x+3) = 0"])).toBe("x^2 + 3x &= 0 \\\\\nx(x+3) &= 0");
  });

  it("aligns \\implies and comparison relations", () => {
    expect(alignRun(["a \\implies b", "c \\leq d"])).toBe("a &\\implies b \\\\\nc &\\leq d");
  });

  it("ignores relations inside braces and environments", () => {
    expect(alignRun(["\\frac{a=b}{c} = 1"])).toBe("\\frac{a=b}{c} &= 1");
    expect(alignRun(["\\begin{bmatrix} a & b \\end{bmatrix} = c"])).toBe(
      "\\begin{bmatrix} a & b \\end{bmatrix} &= c",
    );
  });

  it("keeps rows without a relation flush right", () => {
    expect(alignRun(["= 5", "x + 1"])).toBe("&= 5 \\\\\nx + 1");
  });

  it("drops blank steps", () => {
    expect(alignRun(["a = 1", "  ", "b = 2"])).toBe("a &= 1 \\\\\nb &= 2");
  });

  it("returns null when nothing is left", () => {
    expect(alignRun(["", "   "])).toBeNull();
  });

  it("does not double-mark a row the user aligned by hand", () => {
    expect(alignRun(["x &= 1"])).toBe("x &= 1");
  });
});

describe("splitAligned", () => {
  it("splits rows and strips alignment &", () => {
    expect(splitAligned("\\begin{aligned} x &= 1 \\\\ y &= 2 \\end{aligned}")).toEqual([
      "x = 1",
      "y = 2",
    ]);
  });

  it("consumes \\\\[dim] spacing args with the row break", () => {
    expect(splitAligned("\\begin{aligned} a &= 1 \\\\[4pt] b &= 2 \\end{aligned}")).toEqual([
      "a = 1",
      "b = 2",
    ]);
  });

  it("keeps nested matrix & and \\\\ untouched", () => {
    expect(
      splitAligned(
        "\\begin{aligned} \\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix} &= v \\\\ z &= 0 \\end{aligned}",
      ),
    ).toEqual(["\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix} = v", "z = 0"]);
  });

  it("splits gathered and align bodies", () => {
    expect(splitAligned("\\begin{gathered} a \\\\ b \\end{gathered}")).toEqual(["a", "b"]);
    expect(splitAligned("\\begin{align} x &= 1 \\end{align}")).toEqual(["x = 1"]);
  });

  it("returns null without a splittable environment", () => {
    expect(splitAligned("x = 1 \\\\ y = 2")).toBeNull();
    expect(splitAligned("\\begin{bmatrix} a \\\\ b \\end{bmatrix}")).toBeNull();
  });
});
