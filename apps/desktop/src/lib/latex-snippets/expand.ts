/**
 * Turn a match into the one transaction that replaces the trigger, plus the
 * tabstop frame the Tab key walks. Pure: it takes an `EditorState` for the
 * document only and returns specs — it never dispatches.
 *
 * Contract: SPECs/latex-suite/contracts/editor-extension.md ("Tabstop state field")
 */

import { EditorSelection, RangeSet, RangeValue, type ChangeSpec } from "@codemirror/state";
import type { EditorState } from "@codemirror/state";
import type { SnippetMatch } from "./match";

/**
 * One tabstop. A `Decoration.mark` may not be empty and most stops are, so the
 * frame stores plain range values and the view layer builds marks for the
 * non-empty ones. Mapping the set through a transaction tracks edits for free.
 */
export class TabstopRange extends RangeValue {
  constructor(readonly group: number) {
    super();
  }
}

export type TabstopFrame = {
  marks: RangeSet<TabstopRange>;
  currentGroup: number;
};

export type Expansion = {
  changes: ChangeSpec;
  selection: EditorSelection;
  frame: TabstopFrame | null;
};

/** Ascending stop order: `$0` first, then `$1` … `$9`. */
function sortedGroups(stops: { group: number }[]): number[] {
  return [...new Set(stops.map((stop) => stop.group))].sort((a, b) => a - b);
}

/** Build a frame from absolute stop positions, or `null` when there are none. */
export function frameOf(stops: { from: number; to: number; group: number }[]): TabstopFrame | null {
  if (stops.length === 0) return null;
  const ordered = [...stops].sort((a, b) => a.from - b.from || a.group - b.group);
  return {
    marks: RangeSet.of(
      ordered.map((stop) => new TabstopRange(stop.group).range(stop.from, stop.to)),
      true,
    ),
    currentGroup: sortedGroups(stops)[0]!,
  };
}

export function expandSnippet(
  match: SnippetMatch,
  state: EditorState,
  replaceFrom: number,
  replaceTo: number,
): Expansion {
  let text = "";
  const stops: { from: number; to: number; group: number }[] = [];

  for (const segment of match.snippet.template) {
    switch (segment.kind) {
      case "literal":
        text += segment.text;
        break;
      case "capture":
        text += match.groups[segment.group] ?? "";
        break;
      case "visual":
        text += match.visualText ?? "";
        break;
      case "tabstop": {
        const placeholder = segment.placeholder ?? "";
        stops.push({
          from: replaceFrom + text.length,
          to: replaceFrom + text.length + placeholder.length,
          group: segment.index,
        });
        text += placeholder;
        break;
      }
    }
  }

  const frame = frameOf(stops);
  const newDocLength = state.doc.length - (replaceTo - replaceFrom) + text.length;
  const selection = frame
    ? selectionForGroup(frame, frame.currentGroup, newDocLength)!
    : EditorSelection.single(replaceFrom + text.length);

  return { changes: { from: replaceFrom, to: replaceTo, insert: text }, selection, frame };
}

/** Every range of `group`, as the selection to move to. `null` when the group
 *  no longer exists (its ranges were edited away). */
export function selectionForGroup(
  frame: TabstopFrame,
  group: number,
  docLength: number,
): EditorSelection | null {
  const ranges: ReturnType<typeof EditorSelection.range>[] = [];
  const cursor = frame.marks.iter();
  for (; cursor.value; cursor.next()) {
    if (cursor.value.group !== group) continue;
    const from = Math.min(cursor.from, docLength);
    const to = Math.min(cursor.to, docLength);
    ranges.push(EditorSelection.range(from, to));
  }
  return ranges.length === 0 ? null : EditorSelection.create(ranges, 0);
}

/** The next group in `dir` after the frame's current one, or `null` when the
 *  frame is exhausted in that direction (the caller pops it). */
export function nextGroup(frame: TabstopFrame, dir: 1 | -1): number | null {
  const groups: number[] = [];
  const cursor = frame.marks.iter();
  for (; cursor.value; cursor.next()) {
    if (!groups.includes(cursor.value.group)) groups.push(cursor.value.group);
  }
  groups.sort((a, b) => a - b);

  const at = groups.indexOf(frame.currentGroup);
  const target = at === -1 ? (dir === 1 ? 0 : groups.length - 1) : at + dir;
  return groups[target] ?? null;
}
