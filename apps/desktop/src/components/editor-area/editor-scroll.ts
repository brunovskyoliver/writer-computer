import { EditorView } from "@codemirror/view";
import { EDITOR_SAFE_SCROLL_MARGIN } from "./editor-scroll-container";

/** The nearest ancestor of `root` that actually scrolls. Writer's `.cm-scroller`
 *  is `overflow: visible`; the real scroller is `EditorScrollContainer`. */
export function findOuterScroller(root: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = root.parentElement;
  while (node) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
    node = node.parentElement;
  }
  return null;
}

/** Scroll `scroller` so the line block at `pos` lands at the top of the safe
 *  zone (below the fade mask). Uses the layout model, not `coordsAtPos`, so it
 *  works for positions outside the rendered viewport (see docs/editor.md). */
export function scrollPosToSafeTop(
  view: EditorView,
  scroller: HTMLElement,
  pos: number,
  behavior: ScrollBehavior,
) {
  const block = view.lineBlockAt(Math.min(pos, view.state.doc.length));
  const screenY = view.documentTop + block.top;
  const scrollerRect = scroller.getBoundingClientRect();
  const delta = screenY - scrollerRect.top - EDITOR_SAFE_SCROLL_MARGIN;
  const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const next = Math.max(0, Math.min(scroller.scrollTop + delta, max));
  scroller.scrollTo({ top: next, behavior });
}

/** Keep cursor tracking and search inside the outer pane's clear area.
 * Only handles scroll requests, so wheel scrolling never snaps back to the caret. */
const safeScrollMeasure = {};
export const editorScrollHandler = EditorView.scrollHandler.of((view, range, options) => {
  if (options.y !== "nearest") return false;
  const scroller = findOuterScroller(view.dom);
  if (!scroller || scroller.clientHeight === 0) return false;
  const state = view.state;
  // scrollHandler runs inside CM's update. Caret coordinates require a separate
  // measure read; using lineBlockAt alone loses the caret inside long wraps.
  const measure = {
    key: safeScrollMeasure,
    read() {
      if (view.state !== state || scroller.clientHeight === 0) return null;
      const caret = view.coordsAtPos(range.head, range.assoc || 1);
      const block = caret ? null : view.lineBlockAt(range.head);
      const top = caret ? caret.top : view.documentTop + block!.top;
      const bottom = caret ? caret.bottom : view.documentTop + block!.bottom;
      const contentTop = scroller.getBoundingClientRect().top + scroller.clientTop;
      const margin = Math.min(EDITOR_SAFE_SCROLL_MARGIN, scroller.clientHeight / 3);
      const safeTop = contentTop + margin;
      const safeBottom = contentTop + scroller.clientHeight - margin;
      let delta = 0;
      if (top < safeTop) delta = top - safeTop;
      else if (bottom > safeBottom) {
        delta = bottom - top <= safeBottom - safeTop ? bottom - safeBottom : top - safeTop;
      }
      const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      return Math.max(0, Math.min(scroller.scrollTop + delta, max));
    },
    write(next: number | null) {
      if (next !== null && Math.abs(scroller.scrollTop - next) >= 1) {
        scroller.scrollTo({ top: next, behavior: "auto" });
        // Scrolling can replace estimated wrapped-line heights with measured
        // ones. Settle against the new layout before considering it visible.
        view.requestMeasure(measure);
      }
    },
  };
  view.requestMeasure(measure);
  return true;
});
