import { describe, expect, it, test } from "vite-plus/test";
import { envSpans, matchBrace, topLevelMask } from "../src/lib/math/scan";

test("a commented brace does not close a group", () => {
  const source = "{a % } ignored\n{b} + c}";
  expect(matchBrace(source, 0)).toBe(source.length - 1);
});

test("escaped percent signs and braces retain their TeX meaning", () => {
  expect(matchBrace("{a\\%} suffix}", 0)).toBe(4);
  const source = "{a\\{b\\}c}";
  expect(matchBrace(source, 0)).toBe(source.length - 1);
});

test("a comment reaching EOF leaves its surrounding group unclosed", () => {
  expect(matchBrace("{a % ignored closing}", 0)).toBeNull();
});

describe("comment-aware nesting", () => {
  it("ignores commented environments and braces without hiding the next line", () => {
    const text = "% { \\begin{matrix}\nx=y";
    expect(envSpans(text)).toEqual([]);
    const mask = topLevelMask(text);
    expect(mask.slice(0, text.indexOf("\n")).every((bit) => !bit)).toBe(true);
    expect(mask[text.indexOf("=")]).toBe(true);
  });

  it("ignores a commented end token inside a real environment", () => {
    const text = "\\begin{matrix}a % \\end{matrix}\nb\\end{matrix}";
    expect(envSpans(text)).toEqual([{ from: 0, to: text.length }]);
  });
});

test("both characters of an escape inherit the surrounding brace level", () => {
  const text = "\\text{a\\;b}\\;c";
  const mask = topLevelMask(text);
  expect(mask[text.indexOf("\\;")]).toBe(false);
  expect(mask[text.indexOf("\\;") + 1]).toBe(false);
  expect(mask[text.lastIndexOf("\\;")]).toBe(true);
});
