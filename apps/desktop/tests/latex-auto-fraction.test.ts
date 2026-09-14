import { describe, expect, test } from "vite-plus/test";
import { autoFraction } from "../src/lib/latex-snippets/auto-fraction";

/** The line as it reads after the replacement, with `|` at stop 0. */
function applied(lineBefore: string): string | null {
  const result = autoFraction(lineBefore);
  if (!result) return null;
  const head = lineBefore.slice(0, result.operandFrom);
  const stop = result.stops.find((entry) => entry.group === 0)!.offset;
  return head + result.text.slice(0, stop) + "|" + result.text.slice(stop);
}

describe("autoFraction", () => {
  test("a bracketed group becomes the numerator", () => {
    expect(applied("(a+b)/")).toBe("\\frac{a+b}{|}");
    expect(applied("[a,b]/")).toBe("\\frac{[a,b]}{|}");
  });

  test("a plain run stops at whitespace and operators", () => {
    expect(applied("x^2/")).toBe("\\frac{x^2}{|}");
    expect(applied("a+b/")).toBe("a+\\frac{b}{|}");
    expect(applied("y = 2x/")).toBe("y = \\frac{2x}{|}");
  });

  test("a control sequence before the group is pulled in", () => {
    expect(applied("\\sqrt{x}/")).toBe("\\frac{\\sqrt{x}}{|}");
  });

  test("an empty operand keeps the literal slash", () => {
    expect(autoFraction(" /")).toBeNull();
    expect(autoFraction("/")).toBeNull();
    expect(autoFraction("a+/")).toBeNull();
  });

  test("unbalanced brackets keep the literal slash", () => {
    expect(autoFraction("a+b)/")).toBeNull();
  });

  test("stop 0 sits in the denominator, stop 1 after its closing brace", () => {
    const result = autoFraction("x/")!;

    expect(result.operandFrom).toBe(0);
    expect(result.text).toBe("\\frac{x}{}");
    expect(result.stops).toEqual([
      { group: 0, offset: 9 },
      { group: 1, offset: 10 },
    ]);
  });
});
