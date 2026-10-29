import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { CodeMirror } from "@replit/codemirror-vim";
import { editorScrollInsets } from "./editor-scroll-geometry";
import { findOuterScroller } from "./editor-scroll";

/**
 * Point the CM5 adapter's scroll geometry at the ancestor scroller.
 *
 * `@replit/codemirror-vim` measures and scrolls `view.scrollDOM`. In Writer
 * `.cm-scroller` is `overflow: visible` and `EditorScrollContainer` is the
 * real scroller (docs/editor.md), so out of the box `Ctrl+D` reads the whole
 * document as one screen and `Ctrl+E` / `zz` / `zt` / `zb` / `H` / `M` / `L`
 * scroll nothing. The scroll and coordinate adapter methods are
 * replaced on the instance; `y` stays in the adapter's own
 * content-local space (what `charCoords(pos, "local")` returns), and the
 * visible window is inset by the safe margin so lines land clear of the fade.
 */
export function redirectVimScrollToOuterScroller(cm: CodeMirror, view: EditorView) {
  const findPosV = cm.findPosV.bind(cm);
  const getScrollInfo = cm.getScrollInfo.bind(cm);
  const scrollTo = cm.scrollTo.bind(cm);

  cm.charCoords = (pos) => {
    // coordsAtPos can flush a pending CodeMirror scroll (for example G, then
    // zz). Read the content origin afterwards so both coordinates describe
    // the same layout. The adapter exposes content-local coords in both modes.
    const coords = view.coordsAtPos(cm.indexFromPos(pos));
    const origin = view.contentDOM.getBoundingClientRect();
    return {
      left: (coords?.left ?? 0) - origin.left,
      top: (coords?.top ?? 0) - origin.top,
      bottom: (coords?.bottom ?? 0) - origin.top,
    };
  };

  cm.getScrollInfo = () => {
    const geometry = measure(view);
    if (!geometry) return getScrollInfo();
    const { scroller, contentTop, clientHeight, topInset } = geometry;
    return {
      left: scroller.scrollLeft,
      top: scroller.scrollTop + topInset - contentTop,
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
    const { scroller, contentTop, topInset } = geometry;
    scroller.scrollTo({ top: y - topInset + contentTop, behavior: "auto" });
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
  const insets = editorScrollInsets(scroller);
  const clientHeight = Math.max(
    view.defaultLineHeight,
    scroller.clientHeight - insets.top - insets.bottom,
  );
  return { scroller, contentTop, clientHeight, topInset: insets.top };
}
