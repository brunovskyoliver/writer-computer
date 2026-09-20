// Resolves a content-search `line` PendingTarget against a live editor
// (SPECs/global-content-search/contracts/line-target.md). The needle is
// re-found, never trusted blindly: the file may have changed on disk or in a
// dirty tab since the scan. Found → select the range and scroll it into view.
// Not found → scroll the clamped line into view unselected — the graceful
// floor, never a wrong-range selection, never an error for a file that moved
// on.
import type { EditorView } from "@codemirror/view";
import { scrollPosToSafeTop } from "./editor-scroll";

export interface LineTarget {
  line: number;
  offset: number;
  length: number;
  needle: string;
}

/** `offset`/`length` are code-point units (SearchMatch.match_ranges); CM
 *  positions are UTF-16. `for…of` iterates code points, so this maps one
 *  space to the other. */
function utf16IndexForCharOffset(text: string, charOffset: number): number {
  let utf16 = 0;
  let i = 0;
  for (const char of text) {
    if (i >= charOffset) break;
    utf16 += char.length;
    i++;
  }
  return utf16;
}

export function applyLineTarget(
  view: EditorView,
  scrollContainer: HTMLElement,
  target: LineTarget,
) {
  const doc = view.state.doc;
  const lineNumber = Math.min(Math.max(1, target.line), doc.lines);
  const line = doc.line(lineNumber);

  // First occurrence at or after `offset`, else the first on the line.
  let found = -1;
  if (target.needle) {
    found = line.text.indexOf(target.needle, utf16IndexForCharOffset(line.text, target.offset));
    if (found === -1) found = line.text.indexOf(target.needle);
  }

  if (found !== -1) {
    const from = line.from + found;
    const to = from + target.needle.length;
    // The selection on arrival *is* the match marking (research R7).
    view.dispatch({ selection: { anchor: from, head: to } });
    scrollPosToSafeTop(view, scrollContainer, from, "auto");
  } else {
    scrollPosToSafeTop(view, scrollContainer, line.from, "auto");
  }
}
