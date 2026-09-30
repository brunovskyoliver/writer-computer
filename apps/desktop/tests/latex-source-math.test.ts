import { describe, expect, test } from "vite-plus/test";
import { EditorState } from "@codemirror/state";
import { regionAt, scanLatexSource } from "../src/lib/latex-snippets/latex-source-math";
import { mathContext, mathSource } from "../src/lib/latex-snippets/math-context";

/** The context kind at `|` in a LaTeX source. */
function kindAt(source: string): string {
  const pos = source.indexOf("|");
  const doc = source.replace("|", "");
  const state = EditorState.create({ doc, extensions: [mathSource.of("latex")] });
  return mathContext(state, pos).kind;
}

describe("LaTeX source math context", () => {
  test("dollar math, inline and display", () => {
    expect(kindAt("text $x|$ more")).toBe("inline");
    expect(kindAt("text $$x|$$ more")).toBe("display");
    expect(kindAt("text $x$ mo|re")).toBe("prose");
  });

  test("bracket delimiters", () => {
    expect(kindAt("a \\(x|\\) b")).toBe("inline");
    expect(kindAt("a \\[x|\\] b")).toBe("display");
  });

  test("math environments, starred too", () => {
    expect(kindAt("\\begin{equation}\na = |\n\\end{equation}")).toBe("display");
    expect(kindAt("\\begin{align*}\na &= |b\n\\end{align*}")).toBe("display");
    expect(kindAt("\\begin{itemize}\n\\item |x\n\\end{itemize}")).toBe("prose");
  });

  test("a bmatrix inside an equation is part of its formula", () => {
    const source = "\\begin{equation}\nA=\\begin{bmatrix}1 & |2\\end{bmatrix}\n\\end{equation}";
    const pos = source.indexOf("|");
    const doc = source.replace("|", "");
    const state = EditorState.create({ doc, extensions: [mathSource.of("latex")] });
    const context = mathContext(state, pos);
    expect(context.kind).toBe("display");
    if (context.kind !== "display") return;
    expect(doc.slice(context.node.formulaFrom, context.node.formulaTo)).toBe(
      "\nA=\\begin{bmatrix}1 & 2\\end{bmatrix}\n",
    );
  });

  test("escaped dollars and comments are not math", () => {
    expect(kindAt("costs \\$5 and |more")).toBe("prose");
    expect(kindAt("% a $comment| here\ntext")).toBe("code");
    expect(kindAt("% $\ntext $x|$")).toBe("inline");
  });

  test("\\text{} inside math is prose again", () => {
    expect(kindAt("$x \\text{if |} y$")).toBe("text");
  });

  test("an unclosed formula runs to the end while it is typed", () => {
    expect(kindAt("text $x + |")).toBe("inline");
  });

  test("the caret on the opening delimiter is outside, past the closing one inside", () => {
    expect(kindAt("a |$x$ b")).toBe("prose");
    expect(kindAt("a $x$| b")).toBe("inline");
  });

  test("notes keep using the Markdown tree", () => {
    const state = EditorState.create({ doc: "$x$" });
    expect(mathContext(state, 2).kind).toBe("prose"); // no Markdown parser loaded
  });

  test("a comment inside open math does not hide the math around it", () => {
    const text = "\\begin{align}\na % note\n= b\n\\end{align}";
    const regions = scanLatexSource(text);
    expect(regionAt(regions, text.indexOf("= b") + 1)?.kind).toBe("display");
    expect(regionAt(regions, text.indexOf("note"))?.kind).toBe("comment");
  });
});
