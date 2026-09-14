import { describe, expect, test } from "vite-plus/test";
import { EditorState } from "@codemirror/state";
import { setFrames, tabstopField } from "../src/components/editor-area/latex-snippets-extension";
import { frameOf } from "../src/lib/latex-snippets/expand";

/** The field is view-independent, so it can be exercised on a bare state —
 *  the rest of the extension needs an `EditorView`, which this runner has no
 *  DOM for. */
function stateWith(doc: string) {
  return EditorState.create({ doc, extensions: [tabstopField] });
}

const frame = (from: number, to: number) => frameOf([{ from, to, group: 0 }])!;

describe("tabstopField", () => {
  test("a setFrames effect installs the stack", () => {
    const state = stateWith("abc").update({ effects: setFrames.of([frame(1, 2)]) }).state;
    expect(state.field(tabstopField).frames).toHaveLength(1);
  });

  test("a frame whose stops are edited away is dropped", () => {
    const start = stateWith("abc").update({ effects: setFrames.of([frame(1, 2)]) }).state;
    const after = start.update({ changes: { from: 0, to: 3, insert: "" } }).state;
    expect(after.field(tabstopField).frames).toEqual([]);
  });

  test("a document swap clears the stack", () => {
    const start = stateWith("abc").update({ effects: setFrames.of([frame(1, 2)]) }).state;
    const after = start.update({
      changes: { from: 0, to: 3, insert: "other" },
      userEvent: "writer.swap",
    }).state;
    expect(after.field(tabstopField).frames).toEqual([]);
  });

  test("an expansion records the change counter Backspace compares against", () => {
    const typed = stateWith("abc").update({
      changes: { from: 3, insert: "x" },
      userEvent: "input.type",
    }).state;
    expect(typed.field(tabstopField).lastExpansionAt).toBeNull();

    const expanded = typed.update({
      changes: { from: 3, to: 4, insert: "$$" },
      userEvent: "input.snippet",
    }).state;
    const value = expanded.field(tabstopField);
    expect(value.lastExpansionAt).toBe(value.docChanges);

    const later = expanded.update({ changes: { from: 0, insert: "z" } }).state;
    const after = later.field(tabstopField);
    expect(after.lastExpansionAt).not.toBe(after.docChanges);
  });
});
