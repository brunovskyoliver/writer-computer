import { describe, expect, test, vi } from "vite-plus/test";

const { readDirectory, readFile } = vi.hoisted(() => ({
  readDirectory: vi.fn(),
  readFile: vi.fn(),
}));
vi.mock("@/lib/tauri", () => ({ readDirectory, readFile }));

import { CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { latexCompletions } from "../src/components/editor-area/latex-completion";
import {
  bibEntriesIn,
  labelsIn,
  LATEX_COMMANDS,
  macrosIn,
  LATEX_ENVIRONMENTS,
  renderTemplate,
} from "../src/lib/latex-completions/catalog";
import { mathSource } from "../src/lib/latex-snippets/math-context";

/** Run the source at `|` in a `.tex` source (or a note without a parser). */
async function complete(
  source: string,
  { latex = true, explicit = false } = {},
): Promise<CompletionResult | null> {
  const pos = source.indexOf("|");
  const doc = source.replace("|", "");
  const state = EditorState.create({ doc, extensions: latex ? [mathSource.of("latex")] : [] });
  const run = latexCompletions(() => "/w/main.tex");
  return run(new CompletionContext(state, pos, explicit));
}

function labels(result: CompletionResult | null): string[] {
  return result?.options.map((option) => option.label) ?? [];
}

describe("catalog", () => {
  test("templates render with their stops", () => {
    expect(renderTemplate("\\frac{$0}{$1}$2")).toEqual({
      text: "\\frac{}{}",
      stops: [
        { from: 6, to: 6, group: 0 },
        { from: 8, to: 8, group: 1 },
        { from: 9, to: 9, group: 2 },
      ],
    });
    expect(renderTemplate("\\date{${0:\\today}}$1").stops[0]).toEqual({
      from: 6,
      to: 12,
      group: 0,
    });
  });

  test("labels are unique and command templates all parse", () => {
    const seen = new Set<string>();
    for (const entry of LATEX_COMMANDS) {
      expect(seen.has(entry.label), entry.label).toBe(false);
      seen.add(entry.label);
      expect(renderTemplate(entry.template).text.startsWith("\\")).toBe(true);
    }
    expect(seen.has("\\frac")).toBe(true);
    expect(seen.has("\\alpha")).toBe(true); // from the symbol table
    for (const entry of LATEX_ENVIRONMENTS) {
      expect(renderTemplate(entry.name + entry.body).text).toContain(`\\end{${entry.name}}`);
    }
  });

  test("the document's own macros become completions with argument stops", () => {
    expect(
      macrosIn(
        "\\newcommand{\\R}{\\mathbb{R}}\n\\newcommand\\vv[2]{\\vec{#1}_{#2}}\n\\DeclareMathOperator{\\rank}{rank}",
      ),
    ).toEqual([
      { label: "\\R", template: "\\R" },
      { label: "\\vv", template: "\\vv{$0}{$1}$2" },
      { label: "\\rank", template: "\\rank" },
    ]);
  });

  test("labels and bib keys are read from source text", () => {
    expect(labelsIn("\\label{eq:a} x \\label{fig:b} \\label{eq:a}")).toEqual(["eq:a", "fig:b"]);
    expect(
      bibEntriesIn(
        '@book{knuth84,\n title = {The TeXbook},\n}\n@string{x = 1}\n@article{lamport, title="LaTeX"}',
      ),
    ).toEqual([
      { key: "knuth84", title: "The TeXbook" },
      { key: "lamport", title: "LaTeX" },
    ]);
  });
});

describe("latexCompletions", () => {
  test("math offers symbols and math commands, not document structure", async () => {
    const result = await complete("text $\\fr|$");
    expect(result?.from).toBe(6);
    const offered = labels(result);
    expect(offered).toContain("\\frac");
    expect(offered).toContain("\\alpha");
    expect(offered).not.toContain("\\section");
  });

  test("a macro the document defines is offered", async () => {
    const offered = labels(await complete("\\newcommand{\\R}{\\mathbb{R}}\n$x \\in \\R|$"));
    expect(offered[0]).toBe("\\R");
  });

  test(".tex prose offers structure, not bare math symbols", async () => {
    const offered = labels(await complete("Intro \\sec|"));
    expect(offered).toContain("\\section");
    expect(offered).not.toContain("\\alpha");
  });

  test("nothing in comments, after a row break, or in note prose", async () => {
    expect(await complete("% \\sec|")).toBeNull();
    expect(await complete("$\\begin{bmatrix}1\\\\|\\end{bmatrix}$")).toBeNull();
    expect(await complete("plain \\sec|", { latex: false })).toBeNull();
  });

  test("\\begin{ completes environments for where it is", async () => {
    const prose = labels(await complete("\\begin{it|"));
    expect(prose).toContain("itemize");
    expect(prose).not.toContain("bmatrix");
    const math = labels(await complete("$$\\begin{b|$$"));
    expect(math).toContain("bmatrix");
    expect(math).not.toContain("itemize");
  });

  test("\\ref{ lists labels from the document and sibling files", async () => {
    readDirectory.mockResolvedValueOnce([{ name: "chap.tex", path: "/w/chap.tex", is_dir: false }]);
    readFile.mockResolvedValueOnce({ content: "\\label{sec:intro}" });
    const result = await complete("\\label{eq:one}\nSee \\ref{|}");
    expect(labels(result)).toEqual(["eq:one", "sec:intro"]);
  });

  test("\\cite{ lists keys from .bib files in the folder, after the last comma", async () => {
    readDirectory.mockResolvedValueOnce([
      { name: "refs.bib", path: "/w/refs.bib", is_dir: false },
      { name: "main.tex", path: "/w/main.tex", is_dir: false },
    ]);
    readFile.mockResolvedValueOnce({ content: "@book{knuth84, title={The TeXbook}}" });
    const source = "As shown \\cite{lamport,kn|}";
    const result = await complete(source);
    expect(labels(result)).toEqual(["knuth84"]);
    expect(result?.from).toBe(source.indexOf(",") + 1);
  });
});
