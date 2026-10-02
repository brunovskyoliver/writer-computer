import { expect, test } from "vite-plus/test";
import { matchBrace } from "../src/lib/math/scan";

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
