import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import { EditorState } from "@codemirror/state";
import {
  compileSnippetSet,
  parseVariables,
  type CompiledSnippet,
  type CompiledSnippetSet,
} from "../src/lib/latex-snippets/compile";
import { expandSnippet } from "../src/lib/latex-snippets/expand";
import { matchSnippet } from "../src/lib/latex-snippets/match";
import type { MathContext } from "../src/lib/latex-snippets/math-context";
import { parseSnippetFile } from "../src/lib/latex-snippets/parse-snippet-file";
import { SETTINGS_SCHEMA } from "../src/lib/settings-schema";

const DEFAULT_FILE = fileURLToPath(new URL("../shared/latex-snippets.default.js", import.meta.url));

/** The shipped variables, as the app loads them: schema default → parsed map. */
function defaultVariables(): Map<string, string> {
  const entry = SETTINGS_SCHEMA.find((setting) => setting.key === "latex.snippet-variables");
  const items = (entry?.default ?? []) as string[];
  const { variables, errors } = parseVariables(items);
  expect(errors).toEqual([]);
  return variables;
}

async function loadDefaultSet(): Promise<CompiledSnippetSet> {
  const parsed = await parseSnippetFile(readFileSync(DEFAULT_FILE, "utf8"));
  if ("failure" in parsed)
    throw new Error(`default snippet file failed to parse: ${parsed.failure.message}`);
  expect(parsed.errors).toEqual([]);

  const { set, errors } = compileSnippetSet(parsed.entries, defaultVariables());
  expect(errors).toEqual([]);
  return set;
}

const NODE = { from: 0, to: 0, formulaFrom: 0, formulaTo: 0 };
const INLINE: MathContext = { kind: "inline", node: NODE };

function contextFor(snippet: CompiledSnippet): MathContext {
  if (snippet.mode === "text") return { kind: "prose" };
  if (snippet.mode === "display") return { kind: "display", node: NODE };
  return INLINE;
}

/** A `w` snippet's pattern carries the word-boundary lookbehind. */
function needsBoundary(snippet: CompiledSnippet): boolean {
  return snippet.pattern.source.startsWith("(?<!");
}

/** What the template inserts with every stop reduced to its placeholder — the
 *  expected document, derived from the template rather than from `expand`. */
function reduced(snippet: CompiledSnippet): string {
  return snippet.template
    .map((segment) =>
      segment.kind === "literal"
        ? segment.text
        : segment.kind === "tabstop"
          ? (segment.placeholder ?? "")
          : "",
    )
    .join("");
}

function allSnippets(set: CompiledSnippetSet): CompiledSnippet[] {
  const seen = new Set<number>();
  return (["text", "inline", "display"] as const)
    .flatMap((mode) => [...set.byMode[mode].auto, ...set.byMode[mode].tab])
    .filter((snippet) => !seen.has(snippet.id) && seen.add(snippet.id));
}

describe("shipped default snippet set", () => {
  test("compiles with no errors (SC-001)", async () => {
    const set = await loadDefaultSet();
    expect(set.count).toBeGreaterThanOrEqual(150);
  });

  test("every literal-trigger snippet expands to its replacement", async () => {
    const set = await loadDefaultSet();
    const failures: string[] = [];

    for (const snippet of allSnippets(set)) {
      if (snippet.triggerText === null || snippet.captureCount !== 0 || snippet.visual) continue;

      const prefix = needsBoundary(snippet) ? " " : "";
      const lineBefore = prefix + snippet.triggerText;
      const state = EditorState.create({ doc: lineBefore });

      const hit = matchSnippet({
        lineBefore,
        context: contextFor(snippet),
        set,
        kind: snippet.automatic ? "auto" : "tab",
        selectionText: "",
        typedText: snippet.triggerText.slice(-1),
        onDisable: () => {},
      });

      if (hit?.snippet.id !== snippet.id) {
        // A higher-priority snippet claiming the text is the file author's
        // explicit override; anything else is a trigger that can never fire.
        if (hit && hit.snippet.priority > snippet.priority) continue;
        // A general rule that writes the same text (`cdot` → `\cdot` by the
        // symbol-backslash rule at the start of a line) is not a shadowing.
        if (hit) {
          const other = expandSnippet(hit, state, hit.from, lineBefore.length);
          const text = state.update({ changes: other.changes }).state.doc.toString();
          if (text === prefix + reduced(snippet)) continue;
        }
        failures.push(
          `${snippet.triggerText} matched ${hit ? `"${hit.snippet.triggerText}"` : "nothing"}`,
        );
        continue;
      }

      const expansion = expandSnippet(hit, state, hit.from, lineBefore.length);
      const doc = state.update({ changes: expansion.changes }).state.doc.toString();
      const expected = prefix + reduced(snippet);
      if (doc !== expected)
        failures.push(`${snippet.triggerText} → "${doc}" (expected "${expected}")`);

      // The caret lands on the lowest-numbered stop, or after the text when
      // the template has none.
      const groups = snippet.template.flatMap((segment) =>
        segment.kind === "tabstop" ? [segment.index] : [],
      );
      const lowest = Math.min(...groups);
      const firstStop = snippet.template.findIndex(
        (segment) => segment.kind === "tabstop" && segment.index === lowest,
      );
      if (groups.length > 0) {
        expect(expansion.frame).not.toBeNull();
        const before = reduced({ ...snippet, template: snippet.template.slice(0, firstStop) });
        expect(expansion.selection.main.from).toBe(prefix.length + before.length);
      }
    }

    expect(failures).toEqual([]);
  });

  test("every default pattern agrees with native captures on short inputs", async () => {
    const set = await loadDefaultSet();
    const subjects = [
      "",
      "cos",
      "arcsin",
      "theta",
      "xhat",
      "x3",
      "#e3",
      "a_i1",
      "\\alphax",
      "\\int",
      "\\begin{bmatrix}",
      "bmat",
      "{bmat",
      "matrix",
      "\\cosx",
      "par2",
      "dm",
      " dm",
      "é3",
      "😀sin",
    ];
    for (const snippet of allSnippets(set)) {
      const native = new RegExp(snippet.pattern.source, "u");
      for (const subject of subjects) {
        const expected = native.exec(subject);
        const actual = snippet.pattern.exec(subject);
        expect(
          actual && { index: actual.index, values: Array.from(actual) },
          `${snippet.id} on ${JSON.stringify(subject)}`,
        ).toEqual(expected && { index: expected.index, values: Array.from(expected) });
      }
    }
  });

  test("scanning a 200-char math line with no match stays under 1ms (SC-004)", async () => {
    const set = await loadDefaultSet();
    const line = `\\qquad ${"zZ".repeat(96)}`;
    const args = {
      lineBefore: line,
      context: INLINE,
      set,
      kind: "auto" as const,
      selectionText: "",
      onDisable: () => {},
    };

    // Warm up, then measure.
    for (let run = 0; run < 100; run += 1) matchSnippet(args);
    const started = performance.now();
    for (let run = 0; run < 1000; run += 1) matchSnippet(args);
    const average = (performance.now() - started) / 1000;

    expect(average).toBeLessThan(1);
  });
});

/** Type `input` one character at a time into display math, firing automatic
 *  snippets the way the input handler does. Returns the document with `|` at
 *  the caret. */
async function typeInDisplay(input: string): Promise<string> {
  const set = await loadDefaultSet();
  const context: MathContext = { kind: "display", node: NODE };
  let doc = "";
  let caret = 0;
  for (const char of input) {
    // The editor steps over a snippet's own closer instead of doubling it.
    if ("})]".includes(char) && doc[caret] === char) {
      caret += 1;
      continue;
    }
    doc = doc.slice(0, caret) + char + doc.slice(caret);
    caret += 1;
    const lineFrom = doc.lastIndexOf("\n", caret - 1) + 1;
    const match = matchSnippet({
      lineBefore: doc.slice(lineFrom, caret),
      context,
      set,
      kind: "auto",
      selectionText: "",
      typedText: char,
      onDisable: () => {},
    });
    if (!match) continue;
    const state = EditorState.create({ doc });
    const { changes, selection } = expandSnippet(match, state, lineFrom + match.from, caret);
    const next = state.update({ changes, selection }).state;
    doc = next.doc.toString();
    caret = next.selection.main.head;
  }
  return doc.slice(0, caret) + "|" + doc.slice(caret);
}

describe("shipped defaults while typing matrix rows", () => {
  test("backslash rules fire at the start of a row", async () => {
    expect(await typeInDisplay("cos")).toBe("\\cos|");
    expect(await typeInDisplay("det")).toBe("\\det|");
    expect(await typeInDisplay("theta")).toBe("\\theta|");
    expect(await typeInDisplay("beta")).toBe("\\beta|");
  });

  test("a hand-typed \\begin{bmatrix} does not expand inside its braces", async () => {
    expect(await typeInDisplay("\\begin{bmatrix}")).toBe("\\begin{bmatrix}|");
    expect(await typeInDisplay("\\end{pmatrix}")).toBe("\\end{pmatrix}|");
  });

  test("auto-subscript leaves hex colours and open script groups alone", async () => {
    expect(await typeInDisplay("x3")).toBe("x_{3}|");
    expect(await typeInDisplay("a_i1")).toBe("a_{i1|}");
    expect(await typeInDisplay("\\textcolor{#e0a000}")).toBe("\\textcolor{#e0a000}|");
  });

  test("ans and sol need a word boundary", async () => {
    expect(await typeInDisplay("xans")).toBe("xans|");
  });
});
