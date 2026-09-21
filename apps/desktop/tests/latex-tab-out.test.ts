import { describe, expect, test } from "vite-plus/test";
import { tabOutTarget } from "../src/lib/latex-snippets/tab-out";
import type { MathContext } from "../src/lib/latex-snippets/math-context";

function inline(from: number, to: number): MathContext {
  return { kind: "inline", node: { from, to, formulaFrom: from + 1, formulaTo: to - 1 } };
}

describe("tabOutTarget", () => {
  test("moves past the next closing bracket on the line", () => {
    // `$\sqrt{x|}$` — caret at 8, line ends at 10.
    expect(tabOutTarget("}$", 8, inline(0, 10), 10)).toBe(9);
    expect(tabOutTarget(")+1$", 4, inline(0, 8), 8)).toBe(5);
    expect(tabOutTarget("|$", 3, inline(0, 5), 5)).toBe(4);
  });

  test("with nothing ahead, leaves the formula when it closes on this line", () => {
    // `$x|$` — caret at 2, closing `$` at 3.
    expect(tabOutTarget("$", 2, inline(0, 3), 3)).toBe(3);
  });

  test("returns null when the formula closes on a later line", () => {
    expect(tabOutTarget("", 5, inline(0, 30), 10)).toBeNull();
  });

  test("returns null outside math", () => {
    expect(tabOutTarget("", 5, { kind: "prose" }, 10)).toBeNull();
  });

  test("a bracket beats the formula's own delimiter", () => {
    // `$\sqrt{x|}$` — the `}` comes first even though the `$` is on this line.
    expect(tabOutTarget("}$", 8, inline(0, 10), 10)).toBe(9);
  });

  test("walks matrix cells: past & and past both chars of \\\\", () => {
    // `$a & b|$` — caret at 2.
    expect(tabOutTarget(" & b$", 2, inline(0, 7), 7)).toBe(4);
    // `a & b \\\\` — caret at 5, the break is two chars.
    expect(tabOutTarget(" \\\\ c", 5, inline(0, 11), 11)).toBe(8);
  });

  test("a lone backslash is a macro start, not a target", () => {
    // `\alpha` after the caret: the `\` is not a `\\` break; the `}` wins.
    expect(tabOutTarget("\\alpha}", 4, inline(0, 12), 12)).toBe(11);
  });
});
