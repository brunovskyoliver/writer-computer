import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { Vim, type CodeMirrorV, type Pos } from "@replit/codemirror-vim";
import { registerVimPaste } from "../src/components/editor-area/vim-paste";
import { freezeEditorInput, settleEditorInput } from "../src/lib/editor-input";

const readText = vi.fn<() => Promise<string>>();
const notify = vi.fn();
let disposed = false;
registerVimPaste(Vim, { readText, isDisposed: () => disposed, notify });

function fakeCm() {
  let content = "initial";
  let cursor: Pos = { line: 0, ch: 0 };
  const cm = {
    state: {},
    curOp: {},
    getOption: () => false,
    getCursor: () => cursor,
    getLine: () => content,
    firstLine: () => 0,
    lastLine: () => 0,
    somethingSelected: () => false,
    operation: <T>(fn: () => T) => fn(),
    setCursor: (pos: Pos) => {
      cursor = pos;
    },
    replaceRange: (text: string, from: Pos) => {
      content = content.slice(0, from.ch) + text + content.slice(from.ch);
    },
  };
  return { cm: cm as unknown as CodeMirrorV, text: () => content };
}

beforeEach(() => {
  Vim.resetVimGlobalState_();
  disposed = false;
  readText.mockReset();
  notify.mockReset();
  vi.stubGlobal("document", { body: { inert: false } });
});
afterEach(() => vi.unstubAllGlobals());

test.each([
  [['"', "+", "p"], "iPASTEDnitial"],
  [['"', "+", "P"], "PASTEDinitial"],
  [['"', "+", "2", "p"], "iPASTEDPASTEDnitial"],
])(
  "the installed Vim core drains system paste %j before a save boundary",
  async (keys, expected) => {
    let finish!: (text: string) => void;
    readText.mockReturnValue(
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
    );
    const editor = fakeCm();
    for (const key of keys) Vim.handleKey(editor.cm, key, "user");
    const release = freezeEditorInput();
    try {
      let drained = false;
      const draining = settleEditorInput().then(() => {
        drained = true;
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const drainedBeforeClipboard = drained;
      finish("PASTED");
      await draining;
      expect(drainedBeforeClipboard).toBe(false);
      expect(editor.text()).toBe(expected);
      expect(notify).not.toHaveBeenCalled();
    } finally {
      release();
    }
  },
);

test("ordinary register paste keeps its synchronous behavior", () => {
  Vim.getRegisterController().unnamedRegister.setText("LOCAL");
  const editor = fakeCm();
  Vim.handleKey(editor.cm, "p", "user");
  expect(editor.text()).toBe("iLOCALnitial");
  expect(readText).not.toHaveBeenCalled();
});

test("a failed system read reports the error and leaves the document untouched", async () => {
  readText.mockRejectedValue(new Error("clipboard failed"));
  const editor = fakeCm();
  for (const key of ['"', "+", "p"]) Vim.handleKey(editor.cm, key, "user");
  await settleEditorInput();
  expect(editor.text()).toBe("initial");
  expect(notify).toHaveBeenCalledWith(editor.cm, "clipboard failed");
});

test("a frozen editor rejects new Vim paste requests", () => {
  const release = freezeEditorInput();
  try {
    const editor = fakeCm();
    for (const key of ['"', "+", "p"]) Vim.handleKey(editor.cm, key, "user");
    expect(readText).not.toHaveBeenCalled();
    expect(editor.text()).toBe("initial");
    expect(notify).toHaveBeenCalledOnce();
  } finally {
    release();
  }
});
