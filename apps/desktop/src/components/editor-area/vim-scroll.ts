import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { CodeMirror } from "@replit/codemirror-vim";
import { EDITOR_SAFE_SCROLL_MARGIN } from "./editor-scroll-container";
import { findOuterScroller } from "./editor-scroll";

/**
 * Point the CM5 adapter's scroll geometry at the ancestor scroller.
 *
 * `@replit/codemirror-vim` measures and scrolls `view.scrollDOM`. In Writer
 * `.cm-scroller` is `overflow: visible` and `EditorScrollContainer` is the
 * real scroller (docs/editor.md), so out of the box `Ctrl+D` reads the whole
 * document as one screen and `Ctrl+E` / `zz` / `zt` / `zb` / `H` / `M` / `L`
 * scroll nothing. The three adapter methods every scroll motion and action go
 * through are replaced on the instance; `y` stays in the adapter's own
 * content-local space (what `charCoords(pos, "local")` returns), and the
 * visible window is inset by the safe margin so lines land clear of the fade.
 */
export function redirectVimScrollToOuterScroller(cm: CodeMirror, view: EditorView) {
  const findPosV = cm.findPosV.bind(cm);
  const getScrollInfo = cm.getScrollInfo.bind(cm);
  const scrollTo = cm.scrollTo.bind(cm);

  cm.getScrollInfo = () => {
    const geometry = measure(view);
    if (!geometry) return getScrollInfo();
    const { scroller, contentTop, clientHeight } = geometry;
    return {
      left: scroller.scrollLeft,
      top: scroller.scrollTop + EDITOR_SAFE_SCROLL_MARGIN - contentTop,
      height: scroller.scrollHeight - contentTop,
      width: scroller.scrollWidth,
      clientHeight,
      clientWidth: scroller.clientWidth,
    };
  };

  cm.scrollTo = (x, y) => {
    const geometry = measure(view);
    if (!geometry) return scrollTo(x, y);
    if (y == null) return;
    const { scroller, contentTop } = geometry;
    scroller.scrollTo({ top: y - EDITOR_SAFE_SCROLL_MARGIN + contentTop, behavior: "auto" });
  };

  cm.findPosV = (start, amount, unit, goalColumn) => {
    const geometry = unit === "page" ? measure(view) : null;
    if (!geometry) return findPosV(start, amount, unit, goalColumn);
    let range = EditorSelection.cursor(cm.indexFromPos(start), 1, undefined, goalColumn);
    for (let i = 0, count = Math.round(Math.abs(amount)); i < count; i++) {
      range = view.moveVertically(range, amount > 0, geometry.clientHeight);
    }
    return cm.posFromIndex(range.head);
  };
}

/** `contentTop` is the content's y inside the scroller's scroll space; adding
 *  it converts a content-local y into a `scrollTop`. */
function measure(view: EditorView) {
  const scroller = findOuterScroller(view.dom);
  if (!scroller) return null;
  const scrollerRect = scroller.getBoundingClientRect();
  const contentRect = view.contentDOM.getBoundingClientRect();
  const contentTop = contentRect.top - scrollerRect.top - scroller.clientTop + scroller.scrollTop;
  const clientHeight = Math.max(
    view.defaultLineHeight,
    scroller.clientHeight - 2 * EDITOR_SAFE_SCROLL_MARGIN,
  );
  return { scroller, contentTop, clientHeight };
}
