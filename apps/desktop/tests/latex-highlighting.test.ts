import { describe, expect, test } from "vite-plus/test";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { LanguageDescription, syntaxTree } from "@codemirror/language";
import { GFM } from "@lezer/markdown";
import type { SyntaxNode } from "@lezer/common";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import { prosemarkMarkdownSyntaxExtensions } from "../src/lib/prosemark-core/main";
import {
  insideLatexSource,
  latexAwareCodeLanguages,
  latexMathNesting,
  latexSourceLanguage,
} from "../src/components/editor-area/latex-highlighting";

/** Every token the LaTeX tokenizer emits for `source`, as `[name, text]`. */
function tokenize(source: string): [string, string][] {
  const tree = latexSourceLanguage.parser.parse(source);
  const out: [string, string][] = [];
  tree.iterate({
    enter(node) {
      if (node.name === "Document") return;
      out.push([node.name, source.slice(node.from, node.to)]);
    },
  });
  return out;
}

function markdownState(doc: string) {
  return EditorState.create({
    doc,
    extensions: [
      markdown({
        codeLanguages: latexAwareCodeLanguages,
        extensions: [GFM, prosemarkMarkdownSyntaxExtensions, latexMathNesting],
      }),
    ],
  });
}

/** Highlight classes the renderer would apply, as `[class, text]`. */
function highlightClasses(doc: string): [string, string][] {
  const state = markdownState(doc);
  const out: [string, string][] = [];
  highlightTree(syntaxTree(state), classHighlighter, (from, to, cls) => {
    out.push([cls, state.doc.sliceString(from, to)]);
  });
  return out;
}

/** Token names inside the first node called `name`, after forcing a full parse. */
function nestedTokens(state: EditorState, name: string): [string, string][] {
  const out: [string, string][] = [];
  let inside: SyntaxNode | null = null;
  syntaxTree(state).iterate({
    enter(node) {
      if (!inside && node.name === name) inside = node.node;
      if (inside && node.from >= inside.from && node.to <= inside.to && node.name !== name) {
        out.push([node.name, state.doc.sliceString(node.from, node.to)]);
      }
    },
  });
  return out;
}

describe("latex tokenizer", () => {
  test("splits the five classes plus delimiters and plain text", () => {
    expect(tokenize("\\frac{a}{b} & x^2 3.5 \\\\ % note")).toEqual([
      ["keyword", "\\frac"],
      ["bracket", "{"],
      ["latexText", "a"],
      ["bracket", "}{"],
      ["latexText", "b"],
      ["bracket", "}"],
      ["latexText", " "],
      ["operator", "&"],
      ["latexText", " x"],
      ["operator", "^"],
      ["number", "2"],
      ["latexText", " "],
      ["number", "3.5"],
      ["latexText", " "],
      ["operator", "\\\\"],
      ["latexText", " "],
      ["lineComment", "% note"],
    ]);
  });

  test("a non-letter control sequence is one keyword", () => {
    expect(tokenize("\\, \\{")).toEqual([
      ["keyword", "\\,"],
      ["latexText", " "],
      ["keyword", "\\{"],
    ]);
  });

  test("dollars are processing instructions", () => {
    expect(tokenize("$$x$")).toEqual([
      ["processingInstruction", "$$"],
      ["latexText", "x"],
      ["processingInstruction", "$"],
    ]);
  });

  test("every character is covered exactly once", () => {
    const source = "\\alpha_{i} + 12.5% tail";
    expect(tokenize(source).reduce((acc, [, text]) => acc + text, "")).toBe(source);
  });
});

describe("markdown nesting", () => {
  test("inline math mounts the latex tree", () => {
    const state = markdownState("text $x^2$ tail");
    expect(nestedTokens(state, "Math")).toEqual([
      ["MathMark", "$"],
      ["Document", "x^2"],
      ["latexText", "x"],
      ["operator", "^"],
      ["number", "2"],
      ["MathMark", "$"],
    ]);
  });

  // Fence mounts are overlays, which `Tree.iterate` does not descend into.
  // `highlightTree` does, and it is what the editor actually renders through.
  test("a latex fence is parsed by the latex language", () => {
    expect(highlightClasses("```latex\n\\frac{a}{b}\n```")).toContainEqual([
      "tok-keyword",
      "\\frac",
    ]);
  });

  test("a tex fence too, and an unrelated fence is untouched", () => {
    expect(highlightClasses("```tex\n\\alpha\n```")).toContainEqual(["tok-keyword", "\\alpha"]);
    expect(highlightClasses("```text\n\\alpha\n```")).not.toContainEqual([
      "tok-keyword",
      "\\alpha",
    ]);
  });
});

describe("latexAwareCodeLanguages", () => {
  test("latex and tex map to the tokenizer, case-insensitively", () => {
    expect(latexAwareCodeLanguages("latex")).toBe(latexSourceLanguage);
    expect(latexAwareCodeLanguages("TeX")).toBe(latexSourceLanguage);
    expect(latexAwareCodeLanguages(" latex ")).toBe(latexSourceLanguage);
  });

  test("everything else keeps the stock lookup", () => {
    const ts = latexAwareCodeLanguages("ts");
    expect(ts).toBeInstanceOf(LanguageDescription);
    expect((ts as LanguageDescription).name).toBe("TypeScript");
    expect(latexAwareCodeLanguages("not-a-language")).toBe(null);
  });
});

describe("insideLatexSource", () => {
  test("true inside math and latex fences, false in prose and other fences", () => {
    const state = markdownState("a {b} $c {d}$ e");
    expect(insideLatexSource(state, state.doc.toString().indexOf("{b}"))).toBe(false);
    expect(insideLatexSource(state, state.doc.toString().indexOf("{d}"))).toBe(true);

    const fence = markdownState("```latex\n{x}\n```");
    expect(insideLatexSource(fence, fence.doc.toString().indexOf("{x}"))).toBe(true);

    const other = markdownState("```ts\n{x}\n```");
    expect(insideLatexSource(other, other.doc.toString().indexOf("{x}"))).toBe(false);
  });
});
