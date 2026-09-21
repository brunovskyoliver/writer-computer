import { describe, expect, test } from "vite-plus/test";
import { MATH_SYMBOLS, searchSymbols, symbolInsertion } from "../src/lib/math/symbols";

describe("MATH_SYMBOLS table", () => {
  test("has broad coverage", () => {
    expect(MATH_SYMBOLS.length).toBeGreaterThanOrEqual(140);
  });

  test("every entry has code, name, and group", () => {
    for (const s of MATH_SYMBOLS) {
      expect(s.code.startsWith("\\")).toBe(true);
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.group.length).toBeGreaterThan(0);
    }
  });

  test("codes are unique", () => {
    const codes = MATH_SYMBOLS.map((s) => s.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("searchSymbols", () => {
  test("empty query returns everything", () => {
    expect(searchSymbols("")).toBe(MATH_SYMBOLS);
    expect(searchSymbols("   ")).toBe(MATH_SYMBOLS);
  });

  test("matches by name, case-insensitive", () => {
    const hits = searchSymbols("ALPHA");
    expect(hits.some((s) => s.code === "\\alpha")).toBe(true);
  });

  test("matches by code", () => {
    const hits = searchSymbols("\\frac");
    expect(hits).toHaveLength(1);
    expect(hits[0].code).toBe("\\frac{}{}");
  });

  test("matches by group", () => {
    const hits = searchSymbols("greek");
    expect(hits.every((s) => s.group === "Greek")).toBe(true);
    expect(hits.length).toBeGreaterThan(30);
  });

  test("no match gives an empty list", () => {
    expect(searchSymbols("zzz-no-such-symbol")).toEqual([]);
  });
});

describe("symbolInsertion", () => {
  test("inside math inserts the bare code, caret after it", () => {
    expect(symbolInsertion("\\alpha", true)).toEqual({
      text: "\\alpha",
      caret: "\\alpha".length,
    });
  });

  test("in prose wraps in $…$, caret after the closing $", () => {
    expect(symbolInsertion("\\alpha", false)).toEqual({
      text: "$\\alpha$",
      caret: "$\\alpha$".length,
    });
  });

  test("a {} group takes the caret inside math", () => {
    const { text, caret } = symbolInsertion("\\sqrt{}", true);
    expect(text).toBe("\\sqrt{}");
    expect(text.slice(0, caret).endsWith("{")).toBe(true);
    expect(text[caret]).toBe("}");
  });

  test("a {} group takes the caret in prose too", () => {
    const { text, caret } = symbolInsertion("\\sqrt{}", false);
    expect(text).toBe("$\\sqrt{}$");
    expect(text.slice(0, caret).endsWith("{")).toBe(true);
    expect(text[caret]).toBe("}");
  });

  test("multi-group codes land in the first group", () => {
    const { text, caret } = symbolInsertion("\\frac{}{}", true);
    expect(text.slice(0, caret)).toBe("\\frac{");
  });
});
