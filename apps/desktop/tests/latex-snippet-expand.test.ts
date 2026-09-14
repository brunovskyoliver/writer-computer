import { describe, expect, test } from "vite-plus/test";
import { ChangeSet, EditorState } from "@codemirror/state";
import { compileSnippetSet, type CompiledSnippet } from "../src/lib/latex-snippets/compile";
import { expandSnippet, nextGroup, type TabstopFrame } from "../src/lib/latex-snippets/expand";
import type { SnippetMatch } from "../src/lib/latex-snippets/match";

function snippet(replacement: string, trigger = "x", captures = 0): CompiledSnippet {
  const { set, errors } = compileSnippetSet(
    [
      {
        index: 0,
        line: 1,
        trigger:
          captures === 0
            ? { kind: "string", value: trigger }
            : { kind: "regex", source: trigger + "([\\s\\S])".repeat(captures), flags: "" },
        replacement,
        options: "mA",
      },
    ],
    new Map(),
  );
  expect(errors).toEqual([]);
  return set.byMode.inline.auto[0]!;
}

/** Expand `replacement` over a document that contains just the trigger. */
function expand(
  replacement: string,
  options: { trigger?: string; captures?: number; match?: Partial<SnippetMatch> } = {},
) {
  const trigger = options.trigger ?? "x";
  const state = EditorState.create({ doc: trigger });
  const match: SnippetMatch = {
    snippet: snippet(replacement, trigger, options.captures ?? 0),
    from: 0,
    to: trigger.length,
    groups: [],
    ...options.match,
  };
  const result = expandSnippet(match, state, 0, trigger.length);
  const doc = state.update({ changes: result.changes }).state.doc.toString();
  return { ...result, doc };
}

/** Every [from, to, group] in a frame, in document order. */
function stops(frame: TabstopFrame) {
  const found: [number, number, number][] = [];
  const cursor = frame.marks.iter();
  for (; cursor.value; cursor.next()) found.push([cursor.from, cursor.to, cursor.value.group]);
  return found;
}

describe("expandSnippet", () => {
  test("`//` → \\frac{}{} with three stops, caret at the numerator", () => {
    const { doc, selection, frame } = expand("\\frac{$0}{$1}$2", { trigger: "//" });

    expect(doc).toBe("\\frac{}{}");
    expect(stops(frame!)).toEqual([
      [6, 6, 0],
      [8, 8, 1],
      [9, 9, 2],
    ]);
    expect(selection.main.from).toBe(6);
    expect(selection.main.empty).toBe(true);
    expect(frame!.currentGroup).toBe(0);
  });

  test("a placeholder is inserted and selected", () => {
    const { doc, selection } = expand("\\text{${0:f}}");

    expect(doc).toBe("\\text{f}");
    expect([selection.main.from, selection.main.to]).toEqual([6, 7]);
  });

  test("a repeated stop yields one selection range per occurrence", () => {
    const { doc, selection } = expand("$0+$0");

    expect(doc).toBe("+");
    expect(selection.ranges.map((range) => range.from)).toEqual([0, 1]);
  });

  test("captures and ${VISUAL} are substituted", () => {
    const captured = expand("\\[[0]] [[1]]", { captures: 2, match: { groups: ["alpha", "y"] } });
    expect(captured.doc).toBe("\\alpha y");

    const visual = expand("\\sqrt{ ${VISUAL} }", { match: { visualText: "a+b" } });
    expect(visual.doc).toBe("\\sqrt{ a+b }");
  });

  test("a template with no tabstops leaves no frame and puts the caret at the end", () => {
    const { doc, selection, frame } = expand("\\sin");

    expect(doc).toBe("\\sin");
    expect(frame).toBeNull();
    expect(selection.main.head).toBe(4);
  });

  test("nextGroup walks the frame and reports the end", () => {
    const { frame } = expand("\\frac{$0}{$1}$2", { trigger: "//" });

    expect(nextGroup(frame!, 1)).toBe(1);
    expect(nextGroup({ ...frame!, currentGroup: 2 }, 1)).toBeNull();
    expect(nextGroup({ ...frame!, currentGroup: 1 }, -1)).toBe(0);
    expect(nextGroup({ ...frame!, currentGroup: 0 }, -1)).toBeNull();
  });

  test("stops survive an insertion before them", () => {
    const { frame } = expand("\\frac{$0}{$1}$2", { trigger: "//" });
    const moved = frame!.marks.map(ChangeSet.of({ from: 0, insert: "ab" }, 9));

    expect(stops({ ...frame!, marks: moved })).toEqual([
      [8, 8, 0],
      [10, 10, 1],
      [11, 11, 2],
    ]);
  });

  test("typing at an empty stop carries the stop along with the typed text", () => {
    const { frame } = expand("\\frac{$0}{$1}$2", { trigger: "//" });
    // Type `x` into the numerator: the stop ends up after it, so tabbing back
    // returns the caret to the end of what was typed, and later stops shift.
    const moved = frame!.marks.map(ChangeSet.of({ from: 6, insert: "x" }, 9));

    expect(stops({ ...frame!, marks: moved })).toEqual([
      [7, 7, 0],
      [9, 9, 1],
      [10, 10, 2],
    ]);
  });
});
