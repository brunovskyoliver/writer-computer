import { describe, expect, test, beforeEach } from "vite-plus/test";
import { EditorState, EditorSelection } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { syntaxTree } from "@codemirror/language";
import { foldExtension, prosemarkMarkdownSyntaxExtensions } from "../src/lib/prosemark-core/main";
import { renderMath, clearMathCache } from "../src/components/editor-area/math-renderer";
import { mathDecorations } from "../src/components/editor-area/math-decorations";
// The shipped editor mounts a nested LaTeX tree over `MathFormula`; parse with
// it here so folding is tested against the tree the app actually sees.
import { latexMathNesting } from "../src/components/editor-area/latex-highlighting";

function parseState(doc: string) {
  return EditorState.create({
    doc,
    extensions: [
      markdown({ extensions: [GFM, prosemarkMarkdownSyntaxExtensions, latexMathNesting] }),
    ],
  });
}

/** All Math nodes in the doc as their source slices. */
function mathNodes(doc: string): string[] {
  const state = parseState(doc);
  const found: string[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === "Math") found.push(state.doc.sliceString(node.from, node.to));
    },
  });
  return found;
}

describe("math markdown parsing", () => {
  test("parses inline $...$ math", () => {
    expect(mathNodes("Euler: $e^{i\\pi} + 1 = 0$ wow")).toEqual(["$e^{i\\pi} + 1 = 0$"]);
  });

  test("parses display $$...$$ math", () => {
    expect(mathNodes("Sum: $$\\sum_{i=1}^n i$$ done")).toEqual(["$$\\sum_{i=1}^n i$$"]);
  });

  test("escaped \\$ does not open math", () => {
    expect(mathNodes("costs \\$5 and \\$10")).toEqual([]);
  });

  test("currency amounts do not become math", () => {
    // Closing candidates are preceded by whitespace ("... and $") or followed
    // by a digit — Pandoc's guards reject both.
    expect(mathNodes("I paid $5 and $10 more")).toEqual([]);
  });

  test("opener followed by whitespace does not start inline math", () => {
    expect(mathNodes("a $ b$ c")).toEqual([]);
  });

  test("content ending with whitespace does not close inline math", () => {
    expect(mathNodes("a $b $ c")).toEqual([]);
  });

  test("valid math still parses next to currency-looking text", () => {
    expect(mathNodes("pay $x+y$ dollars")).toEqual(["$x+y$"]);
  });

  test("display math tolerates surrounding whitespace in content", () => {
    expect(mathNodes("$$ x^2 $$")).toEqual(["$$ x^2 $$"]);
  });
});

describe("renderMath", () => {
  beforeEach(() => {
    clearMathCache();
  });

  test("renders a formula to KaTeX markup", () => {
    const result = renderMath("x^2", false);
    expect(result.error).toBeUndefined();
    expect(result.html).toContain("katex");
  });

  test("display mode produces katex-display markup", () => {
    const result = renderMath("\\sum_{i=1}^n i", true);
    expect(result.html).toContain("katex-display");
  });

  test("inline mode does not produce katex-display markup", () => {
    const result = renderMath("x^2", false);
    expect(result.html).not.toContain("katex-display");
  });

  test("same formula in different modes is cached separately", () => {
    const inline = renderMath("x^2", false);
    const display = renderMath("x^2", true);
    expect(inline.html).not.toBe(display.html);
    // Repeat calls return the cached strings.
    expect(renderMath("x^2", false).html).toBe(inline.html);
    expect(renderMath("x^2", true).html).toBe(display.html);
  });

  test("soft errors render in error color instead of failing", () => {
    // \unknowncommand is a soft error under throwOnError: false.
    const result = renderMath("\\unknowncommand", false);
    expect(result.error).toBeUndefined();
    expect(result.html).toBeDefined();
  });
});

describe("mathDecorations fold behavior", () => {
  const before = "text ";
  const math = "$a+b$";
  const doc = `${before}${math} after`;
  const mathFrom = before.length;
  const mathTo = mathFrom + math.length;

  function makeState(selection: { anchor: number; head?: number }) {
    return EditorState.create({
      doc,
      extensions: [
        markdown({ extensions: [GFM, prosemarkMarkdownSyntaxExtensions, latexMathNesting] }),
        mathDecorations(),
      ],
      selection: EditorSelection.single(selection.anchor, selection.head),
    });
  }

  function hasReplaceOverMath(state: EditorState): boolean {
    const set = state.field(foldExtension);
    let found = false;
    set.between(0, doc.length, (from, to) => {
      if (from === mathFrom && to === mathTo) {
        found = true;
        return false;
      }
      return undefined;
    });
    return found;
  }

  test("caret outside math → rendered widget replaces the source", () => {
    expect(hasReplaceOverMath(makeState({ anchor: 0 }))).toBe(true);
  });

  test("caret inside math → source stays visible", () => {
    expect(hasReplaceOverMath(makeState({ anchor: mathFrom + 2 }))).toBe(false);
  });

  test("range selection covering math → source stays visible", () => {
    expect(hasReplaceOverMath(makeState({ anchor: mathTo, head: mathFrom }))).toBe(false);
  });

  test("whitespace-only display math renders no widget", () => {
    const blankDoc = "x $$  $$ y";
    const state = EditorState.create({
      doc: blankDoc,
      extensions: [
        markdown({ extensions: [GFM, prosemarkMarkdownSyntaxExtensions, latexMathNesting] }),
        mathDecorations(),
      ],
      selection: EditorSelection.single(0),
    });
    let count = 0;
    state.field(foldExtension).between(0, blankDoc.length, () => {
      count++;
    });
    expect(count).toBe(0);
  });
});

describe("editing display math", () => {
  const formula = String.raw`\sin\left( \frac{\pi}{2} \right)*\cosh(y)=2`;
  const doc = `before\n\n$$\n\n${formula}\n\n$$\n\nafter`;
  function stateAt(anchor: number) {
    return EditorState.create({
      doc,
      selection: { anchor },
      extensions: [
        markdown({ extensions: [GFM, prosemarkMarkdownSyntaxExtensions, latexMathNesting] }),
        mathDecorations(),
      ],
    });
  }
  test("parses and renders the trigonometric expression intact", () => {
    expect(mathNodes(doc)).toEqual([`$$\n\n${formula}\n\n$$`]);
    const result = renderMath(formula, true);
    expect(result.error).toBeUndefined();
    expect(result.html).toContain("katex-display");
    expect(result.html).not.toContain("katex-error");
  });
  test("keeps a live preview above editable display source", () => {
    const state = stateAt(doc.indexOf(formula) + 3);
    const previews: string[] = [];
    state.field(foldExtension).between(0, doc.length, (from, to, decoration) => {
      if (decoration.spec.widget) {
        expect(from).toBe(doc.indexOf("$$"));
        expect(to).toBe(from);
        expect(decoration.spec.block).toBe(true);
        previews.push(decoration.spec.widget.formula);
      }
    });
    expect(previews).toEqual([`\n\n${formula}\n\n`]);
  });
});

test("display block keeps mixed closing layout and container boundaries", () => {
  expect(mathNodes("$$\nx$$\n\nafter")).toEqual(["$$\nx$$"]);
  expect(mathNodes("> $$\n> x\n\n# Outside\n\n$$\ny\n$$")).toEqual(["$$\ny\n$$"]);
});

test("display preview updates and refolds after editing", () => {
  let state = EditorState.create({
    doc: "before\n\n$$\nx\n$$\n\nafter",
    selection: { anchor: 11 },
    extensions: [
      markdown({ extensions: [prosemarkMarkdownSyntaxExtensions, latexMathNesting] }),
      mathDecorations(),
    ],
  });
  state = state.update({ changes: { from: 11, to: 12, insert: "y^2" } }).state;
  const previews: string[] = [];
  state.field(foldExtension).between(0, state.doc.length, (_from, _to, deco) => {
    if (deco.spec.widget?.preview) previews.push(deco.spec.widget.formula);
  });
  expect(previews).toEqual(["\ny^2\n"]);
  state = state.update({ selection: { anchor: 0 } }).state;
  let replacements = 0;
  state.field(foldExtension).between(0, state.doc.length, (from, to) => {
    if (to > from) replacements++;
  });
  expect(replacements).toBe(1);
});

test("display closer preserves following prose and separate formulas", () => {
  expect(mathNodes("$$\nx$$ after\n\n# Heading")).toEqual(["$$\nx$$"]);
  expect(mathNodes("$$\nx$$ and $$y$$")).toEqual(["$$\nx$$", "$$y$$"]);
});
