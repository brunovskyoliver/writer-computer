import { EditorView } from "@codemirror/view";
import { editorScrollInsets } from "./editor-scroll-geometry";

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

// Long enough for WebKit's smooth scroll to finish before correcting it.
const SMOOTH_SCROLL_MS = 500;
const SETTLE_FRAMES = 8;
const settlingScrolls = new WeakMap<HTMLElement, () => void>();

/** Scroll `scroller` so the line block at `pos` lands at the top of the safe
 *  zone (below the fade mask). Uses the layout model, not `coordsAtPos`, so it
 *  works for positions outside the rendered viewport (see docs/editor.md). */
export function scrollPosToSafeTop(
  view: EditorView,
  scroller: HTMLElement,
  pos: number,
  behavior: ScrollBehavior,
) {
  settlingScrolls.get(scroller)?.();
  scroller.scrollTo({ top: safeTopFor(view, scroller, pos), behavior });
  settleSafeTop(view, scroller, pos, behavior === "smooth" ? SMOOTH_SCROLL_MS : 0);
}

function safeTopFor(view: EditorView, scroller: HTMLElement, pos: number): number {
  const block = view.lineBlockAt(Math.min(pos, view.state.doc.length));
  const screenY = view.documentTop + block.top;
  const scrollerRect = scroller.getBoundingClientRect();
  const delta = screenY - scrollerRect.top - scroller.clientTop - editorScrollInsets(scroller).top;
  const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  return Math.max(0, Math.min(scroller.scrollTop + delta, max));
}

/** Lines far from the viewport have estimated heights, so the first scroll
 *  lands short. Each frame renders the lines it reached; re-aim until the
 *  estimates are gone. A new jump, a user scroll or a document swap cancels. */
function settleSafeTop(view: EditorView, scroller: HTMLElement, pos: number, delayMs: number) {
  const doc = view.state.doc;
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    scroller.removeEventListener("wheel", cancel);
    settlingScrolls.delete(scroller);
  };
  settlingScrolls.set(scroller, cancel);
  scroller.addEventListener("wheel", cancel, { passive: true });

  let frames = SETTLE_FRAMES;
  const step = () => {
    if (cancelled) return;
    if (frames-- === 0 || !scroller.isConnected || view.state.doc !== doc) {
      cancel();
      return;
    }
    view.requestMeasure({
      read: () => safeTopFor(view, scroller, pos),
      write: (top) => {
        if (!cancelled && Math.abs(top - scroller.scrollTop) > 1) scroller.scrollTop = top;
      },
    });
    requestAnimationFrame(step);
  };
  setTimeout(step, delayMs);
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
      const insets = editorScrollInsets(scroller);
      const safeTop = contentTop + insets.top;
      const safeBottom = contentTop + scroller.clientHeight - insets.bottom;
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
