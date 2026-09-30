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

  test("moving the caret after an expansion closes the Backspace-undo window", () => {
    const expanded = stateWith("abc").update({
      changes: { from: 3, insert: "{}" },
      selection: { anchor: 4 },
      userEvent: "input.snippet",
    }).state;
    expect(expanded.field(tabstopField).lastExpansionAt).not.toBeNull();
    const moved = expanded.update({ selection: { anchor: 5 }, userEvent: "select" }).state;
    expect(moved.field(tabstopField).lastExpansionAt).toBeNull();
  });

  test("moving the caret out of a frame drops it", () => {
    const start = stateWith("a_{}  x").update({
      effects: setFrames.of([
        frameOf([
          { from: 3, to: 3, group: 0 },
          { from: 4, to: 4, group: 1 },
        ])!,
      ]),
      selection: { anchor: 3 },
    }).state;
    expect(start.field(tabstopField).frames).toHaveLength(1);
    const outside = start.update({ selection: { anchor: 7 } }).state;
    expect(outside.field(tabstopField).frames).toEqual([]);
  });

  test("reaching the exit stop finishes the frame, even while typing there", () => {
    const frame = frameOf([
      { from: 3, to: 3, group: 0 },
      { from: 4, to: 4, group: 1 },
    ])!;
    const start = stateWith("a_{}").update({
      effects: setFrames.of([frame]),
      selection: { anchor: 3 },
    }).state;
    // Arrow past `}` onto `$1`, the exit: the snippet is done.
    const atExit = start.update({ selection: { anchor: 4 } }).state;
    expect(atExit.field(tabstopField).frames).toEqual([]);
    // Typing at the exit drags the empty stop along; the frame still ends.
    const typed = start.update({
      changes: { from: 4, insert: " + r" },
      selection: { anchor: 8 },
    }).state;
    expect(typed.field(tabstopField).frames).toEqual([]);
  });

  test("leaving an inner frame keeps the enclosing one", () => {
    const outer = frameOf([
      { from: 1, to: 1, group: 0 },
      { from: 9, to: 9, group: 1 },
    ])!;
    const inner = frameOf([
      { from: 3, to: 3, group: 0 },
      { from: 4, to: 4, group: 1 },
    ])!;
    const start = stateWith("0123456789").update({
      effects: setFrames.of([outer, inner]),
      selection: { anchor: 3 },
    }).state;
    const after = start.update({ selection: { anchor: 6 } }).state;
    expect(after.field(tabstopField).frames).toEqual([outer]);
  });

  test("typing inside a stop keeps the frame", () => {
    const start = stateWith("a_{}").update({
      effects: setFrames.of([
        frameOf([
          { from: 3, to: 3, group: 0 },
          { from: 4, to: 4, group: 1 },
        ])!,
      ]),
      selection: { anchor: 3 },
    }).state;
    const typed = start.update({
      changes: { from: 3, insert: "11" },
      selection: { anchor: 5 },
    }).state;
    expect(typed.field(tabstopField).frames).toHaveLength(1);
  });
});
