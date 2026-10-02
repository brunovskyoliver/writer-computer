import { beforeEach, expect, test, vi } from "vite-plus/test";
import { EditorSelection, EditorState, type Transaction } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { prosemarkMarkdownSyntaxExtensions } from "../src/lib/prosemark-core/main";
import { latexMathNesting } from "../src/components/editor-area/latex-highlighting";

const notice = vi.hoisted(() => vi.fn());
vi.mock("@/components/editor-area/editor-notice-store", () => ({ showEditorNotice: notice }));
import { mathSplit } from "../src/components/editor-area/math-commands";

function split(formula: string) {
  const doc = "Before\n\n$$\n" + formula + "\n$$\n\nAfter";
  let state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(doc.indexOf("x&") + 1),
    extensions: [
      markdown({ extensions: [GFM, prosemarkMarkdownSyntaxExtensions, latexMathNesting] }),
      history(),
    ],
  });
  const dispatch = vi.fn((transaction: Transaction) => {
    state = transaction.state;
  });
  expect(mathSplit({ state, dispatch })).toBe(true);
  return { doc, getState: () => state, dispatch };
}

beforeEach(() => notice.mockReset());

test.each([
  "a + \\begin{aligned}x&=1\\\\y&=2\\end{aligned}",
  "\\begin{aligned}x&=1\\\\y&=2\\end{aligned} + b",
  "\\begin{bmatrix}\\begin{aligned}x&=1\\\\y&=2\\end{aligned}\\end{bmatrix}",
  "\\begin{aligned}x&=1\\end{aligned}\\begin{aligned}y&=2\\end{aligned}",
])("the split command preserves surrounding formula source: %s", (formula) => {
  const result = split(formula);
  expect(result.dispatch).not.toHaveBeenCalled();
  expect(result.getState().doc.toString()).toBe(result.doc);
  expect(notice).toHaveBeenCalledOnce();
});

test("the split command preserves nested matrix rows and surrounding prose in one undo", () => {
  const result = split(
    "\\begin{aligned}x&=\\begin{bmatrix}a&b\\\\c&d\\end{bmatrix}\\\\y&=2\\end{aligned}",
  );
  expect(result.dispatch).toHaveBeenCalledOnce();
  expect(result.getState().doc.toString()).toBe(
    "Before\n\n$$\nx=\\begin{bmatrix}a&b\\\\c&d\\end{bmatrix}\n$$\n\n$$\ny=2\n$$\n\nAfter",
  );
  expect(undo({ state: result.getState(), dispatch: result.dispatch })).toBe(true);
  expect(result.getState().doc.toString()).toBe(result.doc);
});

test("the split command refuses rows that cannot render", () => {
  const result = split("\\begin{aligned}x&=1\\\\y&=\\unknownCommand\\end{aligned}");
  expect(result.dispatch).not.toHaveBeenCalled();
  expect(result.getState().doc.toString()).toBe(result.doc);
  expect(notice).toHaveBeenCalledOnce();
});

test("the split command accepts display-only tags in resulting rows", () => {
  const result = split("\\begin{aligned}x&=1\\tag{1}\\\\y&=2\\end{aligned}");
  expect(result.dispatch).toHaveBeenCalledOnce();
  expect(result.getState().doc.toString()).toBe(
    "Before\n\n$$\nx=1\\tag{1}\n$$\n\n$$\ny=2\n$$\n\nAfter",
  );
});
