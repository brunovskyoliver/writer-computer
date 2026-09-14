import { describe, expect, test } from "vite-plus/test";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { prosemarkMarkdownSyntaxExtensions } from "../src/lib/prosemark-core/main";
import { mathContext } from "../src/lib/latex-snippets/math-context";

/** Build a state from a document where `|` marks the caret. */
function contextAt(marked: string) {
  const caret = marked.indexOf("|");
  const doc = marked.replace("|", "");
  const state = EditorState.create({
    doc,
    extensions: [markdown({ extensions: [GFM, prosemarkMarkdownSyntaxExtensions] })],
  });
  return mathContext(state, caret);
}

describe("math context", () => {
  test("plain prose", () => {
    expect(contextAt("hello wor|ld")).toEqual({ kind: "prose" });
  });

  test("inline math", () => {
    const context = contextAt("a $x|$ b");
    expect(context.kind).toBe("inline");
    expect(context.kind === "inline" && context.node).toMatchObject({
      from: 2,
      to: 5,
      formulaFrom: 3,
      formulaTo: 4,
    });
  });

  test("display math on one line and across lines", () => {
    expect(contextAt("$$x|$$").kind).toBe("display");
    expect(contextAt("$$\nx|\n$$").kind).toBe("display");
  });

  test("the formula span of display math excludes the delimiters", () => {
    const context = contextAt("$$\nx|\n$$");
    expect(context.kind === "display" && context.node).toMatchObject({
      from: 0,
      formulaFrom: 2,
      formulaTo: 5,
      to: 7,
    });
  });

  test("an unclosed \\text{ inside math is prose again", () => {
    expect(contextAt("$\\text{a|}$").kind).toBe("text");
  });

  test("a closed \\text{} is back in math", () => {
    expect(contextAt("$\\text{a}|$").kind).toBe("inline");
  });

  test("nested braces inside \\text{} still count as text", () => {
    expect(contextAt("$\\text{a {b} c|}$").kind).toBe("text");
  });

  test("inline code and fenced code are code, even with math inside", () => {
    expect(contextAt("a `$x|$` b")).toEqual({ kind: "code" });
    expect(contextAt("```js\nlet x|= 1\n```")).toEqual({ kind: "code" });
  });

  test("the caret on the opening $ is outside, on the closing $ inside", () => {
    expect(contextAt("a |$x$ b")).toEqual({ kind: "prose" });
    expect(contextAt("a $x|$ b").kind).toBe("inline");
  });

  test("currency prose never becomes math", () => {
    expect(contextAt("I paid $5| and $6 more")).toEqual({ kind: "prose" });
  });
});
