import { describe, expect, it } from "vite-plus/test";
import { mathAnnotation } from "../src/lib/math/annotate";

describe("mathAnnotation", () => {
  it("annotates closed formulas with ≈ value", () => {
    expect(mathAnnotation("\\frac{3}{4}")?.text).toBe("≈ 0.75");
    expect(mathAnnotation("\\sqrt{2}")?.text).toBe("≈ 1.41421");
    expect(mathAnnotation("2660-2565*j")?.text).toBe("≈ 2660 - 2565j");
  });

  it("marks a true equality ✓ and a false one ✗", () => {
    expect(mathAnnotation("\\frac{1}{2} = 0.5")?.text).toBe("✓");
    const bad = mathAnnotation("\\sqrt{2} = 1.5");
    expect(bad?.text).toBe("✗");
    expect(bad?.title).toContain("left");
  });

  it("leaves open and unparseable formulas unannotated", () => {
    expect(mathAnnotation("x^2 - 4")).toBeNull();
    expect(mathAnnotation("\\begin{bmatrix} 1 \\end{bmatrix}")).toBeNull();
    expect(mathAnnotation("a = b = c")).toBeNull();
    expect(mathAnnotation("")).toBeNull();
  });
});
