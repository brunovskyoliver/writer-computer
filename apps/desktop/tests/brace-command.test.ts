import { describe, expect, test } from "vite-plus/test";
import { emitBraceWrap } from "../src/components/editor-area/brace-command";
import { validateMath } from "../src/components/editor-area/math-renderer";

describe("emitBraceWrap", () => {
  test("math: wraps the fragment in place, caret inside the annotation", () => {
    const under = emitBraceWrap("x^2 + 2x", "under", true);
    expect(under.insert).toBe("\\underbrace{x^2 + 2x}_{}");
    expect(under.insert.slice(0, under.caret).endsWith("_{")).toBe(true);
    expect(under.insert[under.caret]).toBe("}");

    const over = emitBraceWrap("a + b", "over", true);
    expect(over.insert).toBe("\\overbrace{a + b}^{}");
    expect(over.insert.slice(0, over.caret).endsWith("^{")).toBe(true);
  });

  test("prose: wraps into inline math with \\text body and \\text annotation", () => {
    const under = emitBraceWrap("selected prose", "under", false);
    expect(under.insert).toBe("$\\underbrace{\\text{selected prose}}_{\\text{}}$");
    // Caret sits inside the annotation's \text{} — before the final `}}$`.
    expect(under.insert.slice(under.caret)).toBe("}}$");
    expect(under.insert.slice(0, under.caret).endsWith("\\text{")).toBe(true);

    const over = emitBraceWrap("selected prose", "over", false);
    expect(over.insert).toBe("$\\overbrace{\\text{selected prose}}^{\\text{}}$");
    expect(over.insert.slice(over.caret)).toBe("}}$");
  });

  test("every emitted form parses", () => {
    for (const side of ["under", "over"] as const) {
      for (const math of [true, false]) {
        const { insert } = emitBraceWrap("frag", side, math);
        expect(validateMath(math ? insert : insert.slice(1, -1))).toBe(true);
      }
    }
  });

  test("validation catches the prose fragments that would break", () => {
    // An unbalanced brace or a `$` inside \text{} must fail the command's
    // validateMath gate — emit stays dumb, the gate says no.
    for (const bad of ["a { b", "a } b", "a $ b"]) {
      const { insert } = emitBraceWrap(bad, "under", false);
      expect(validateMath(insert.slice(1, -1)), bad).toBe(false);
    }
  });
});
