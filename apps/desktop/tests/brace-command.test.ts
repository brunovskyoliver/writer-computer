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

  test("prose with math islands lifts them out of \\text{}", () => {
    // `rows $*$ columns` must not emit `$` inside \text{} — the emitted
    // source would reparse as two math spans and corrupt the line. The
    // island's delimiters are stripped and the content emitted as math.
    const { insert } = emitBraceWrap("rows $*$ columns", "under", false);
    expect(insert).toBe("$\\underbrace{\\text{rows }*\\text{ columns}}_{\\text{}}$");
    expect(validateMath(insert.slice(1, -1))).toBe(true);
  });

  test("prose islands: multiple, adjacent, and $$…$$ spans", () => {
    expect(emitBraceWrap("$a$ and $b$", "under", false).insert).toBe(
      "$\\underbrace{a\\text{ and }b}_{\\text{}}$",
    );
    expect(emitBraceWrap("see $$x+y$$ now", "over", false).insert).toBe(
      "$\\overbrace{\\text{see }x+y\\text{ now}}^{\\text{}}$",
    );
    expect(emitBraceWrap("$x^2$", "under", false).insert).toBe("$\\underbrace{x^2}_{\\text{}}$");
  });

  test("prose: literal $ and TeX specials are escaped, not stranded", () => {
    // Currency never opens an island (Pandoc guard: a closer can't precede a
    // digit, and "$5 and $10" has no valid pair) — the `$`s escape instead.
    const paid = emitBraceWrap("I paid $5 and $10 more", "under", false);
    expect(paid.insert).toBe("$\\underbrace{\\text{I paid \\$5 and \\$10 more}}_{\\text{}}$");
    expect(validateMath(paid.insert.slice(1, -1))).toBe(true);

    // A lone unpaired `$` escapes the same way; braces escape to `\{`/`\}`.
    for (const fragment of ["a $ b", "a { b", "a } b"]) {
      const { insert } = emitBraceWrap(fragment, "under", false);
      expect(validateMath(insert.slice(1, -1)), fragment).toBe(true);
    }
    expect(emitBraceWrap("a { b", "under", false).insert).toBe(
      "$\\underbrace{\\text{a \\{ b}}_{\\text{}}$",
    );
  });

  test("escaped \\$ never opens an island", () => {
    // `costs \$5` is prose with a literal dollar — the backslash keeps it out
    // of the island scan, and the pair survives \text{} unchanged.
    const { insert } = emitBraceWrap("costs \\$5", "under", false);
    expect(insert).toBe("$\\underbrace{\\text{costs \\$5}}_{\\text{}}$");
    expect(validateMath(insert.slice(1, -1))).toBe(true);
  });

  test("every emitted form parses", () => {
    for (const side of ["under", "over"] as const) {
      for (const math of [true, false]) {
        const { insert } = emitBraceWrap("frag", side, math);
        expect(validateMath(math ? insert : insert.slice(1, -1))).toBe(true);
      }
    }
  });

  test("validation still catches the prose fragments that would break", () => {
    // `^` is not allowed inside \text{} — the gate refuses rather than write
    // a formula that won't render.
    const { insert } = emitBraceWrap("a ^ b", "under", false);
    expect(validateMath(insert.slice(1, -1))).toBe(false);
  });
});
