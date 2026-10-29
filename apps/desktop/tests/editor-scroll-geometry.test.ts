import { afterEach, expect, test, vi } from "vite-plus/test";
import { EditorView } from "@codemirror/view";
import { EditorState, EditorSelection } from "@codemirror/state";
import { CodeMirror } from "@replit/codemirror-vim";
import {
  scrollPosToSafeTop,
  editorScrollHandler,
} from "../src/components/editor-area/editor-scroll";
import { redirectVimScrollToOuterScroller } from "../src/components/editor-area/vim-scroll";

afterEach(() => vi.unstubAllGlobals());

function fixture(height: number, top = "", bottom = "") {
  const scroller = {
    scrollTop: 200,
    scrollLeft: 0,
    scrollHeight: 2000,
    clientHeight: height,
    clientWidth: 240,
    scrollWidth: 240,
    clientTop: 12,
    parentElement: null,
    getBoundingClientRect: () => ({ top: 100 }),
    scrollTo: vi.fn(({ top }: { top: number }) => {
      scroller.scrollTop = top;
    }),
  };
  vi.stubGlobal("getComputedStyle", () => ({
    overflowY: "auto",
    getPropertyValue: (name: string) => (name === "--editor-safe-top" ? top : bottom),
  }));
  const view = {
    dom: { parentElement: scroller },
    contentDOM: { getBoundingClientRect: () => ({ top: 120 }) },
    documentTop: 120,
    defaultLineHeight: 20,
    state: { doc: { length: 1000 } },
    lineBlockAt: () => ({ top: 100 }),
  } as unknown as EditorView;
  return { scroller: scroller as unknown as HTMLElement, view };
}

test("a heading target lands inside a short scroller's visible client area", () => {
  const { scroller, view } = fixture(80);
  const headingY = view.documentTop + view.lineBlockAt(100).top;
  const before = scroller.scrollTop;
  scrollPosToSafeTop(view, scroller, 100, "auto");
  const afterY = headingY - (scroller.scrollTop - before);
  const contentTop = scroller.getBoundingClientRect().top + scroller.clientTop;
  expect(afterY).toBeGreaterThanOrEqual(contentTop);
  expect(afterY + view.defaultLineHeight).toBeLessThanOrEqual(contentTop + 80);
});

test("heading alignment includes the scroller border and configured top inset", () => {
  const { scroller, view } = fixture(600, "8px", "140px");
  const before = scroller.scrollTop;
  scrollPosToSafeTop(view, scroller, 100, "auto");
  const afterY = 220 - (scroller.scrollTop - before);
  expect(afterY).toBe(120);
});

test("Vim uses the short visible viewport and reversible scroll coordinates", () => {
  const { scroller, view } = fixture(80, "4px", "8px");
  const cm = {
    findPosV: vi.fn(),
    getScrollInfo: vi.fn(),
    scrollTo: vi.fn(),
  } as unknown as CodeMirror;
  redirectVimScrollToOuterScroller(cm, view);
  const before = scroller.scrollTop;
  const info = cm.getScrollInfo();
  expect(info.clientHeight).toBe(68);
  cm.scrollTo(null, info.top);
  expect(scroller.scrollTop).toBe(before);
});

test.each([
  [70, 90],
  [190, 210],
])("caret scrolling keeps asymmetric clear space (%s..%s)", (top, bottom) => {
  const { scroller, view } = fixture(80, "8px", "24px");
  const measure = vi.fn();
  Object.assign(view, { coordsAtPos: () => ({ top, bottom }), requestMeasure: measure });
  const state = EditorState.create({ extensions: editorScrollHandler });
  const handler = state.facet(EditorView.scrollHandler)[0]!;
  expect(
    handler(view, EditorSelection.cursor(10), {
      x: "nearest",
      y: "nearest",
      xMargin: 0,
      yMargin: 0,
    }),
  ).toBe(true);
  const work = measure.mock.calls[0]![0];
  const before = scroller.scrollTop;
  work.write(work.read());
  const movement = scroller.scrollTop - before;
  expect(top - movement).toBeGreaterThanOrEqual(120);
  expect(bottom - movement).toBeLessThanOrEqual(168);
  expect(measure).toHaveBeenCalledTimes(2);
});

test("Vim cursor coordinates use the content origin after CodeMirror flushes pending scrolling", () => {
  const { view } = fixture(80, "4px", "4px");
  let contentTop = 120;
  Object.assign(view, {
    state: EditorState.create({ doc: "first\nlast" }),
    contentDOM: { getBoundingClientRect: () => ({ top: contentTop, left: 100 }) },
    coordsAtPos: () => {
      // CodeMirror may flush its pending scroll while measuring the cursor.
      contentTop = -600;
      return { left: 120, right: 120, top: 100, bottom: 120 };
    },
  });
  const cm = new CodeMirror(view);
  redirectVimScrollToOuterScroller(cm, view);
  expect(cm.charCoords({ line: 1, ch: 0 }, "local")).toEqual({
    left: 20,
    top: 700,
    bottom: 720,
  });
});
