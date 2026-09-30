import { describe, expect, test } from "vite-plus/test";
import { moveLineBlock, registerVimMoveLines } from "../src/components/editor-area/vim-move-lines";

type Pos = { line: number; ch: number };

/** A document of lines behind the library's CM5-style calls. */
function fakeCm(text: string) {
  let lines = text.split("\n");
  const cm = {
    selection: null as null | { anchor: Pos; head: Pos },
    lineCount: () => lines.length,
    getLine: (line: number) => lines[line]!,
    replaceRange(insert: string, from: Pos, to: Pos) {
      const head = lines.slice(0, from.line);
      const tail = lines.slice(to.line + 1);
      const replaced = lines[from.line]!.slice(0, from.ch) + insert + lines[to.line]!.slice(to.ch);
      lines = [...head, ...replaced.split("\n"), ...tail];
    },
    setSelection(anchor: Pos, head: Pos) {
      cm.selection = { anchor, head };
    },
    text: () => lines.join("\n"),
  };
  return cm;
}

/** Register against a stub `Vim` and hand back the action and the maps. */
function register() {
  const actions: Record<string, (cm: unknown, args: unknown, vim: unknown) => void> = {};
  const maps: { keys: string; args: unknown; context?: string }[] = [];
  registerVimMoveLines({
    defineAction: (name, fn) => {
      actions[name] = fn as never;
    },
    mapCommand: (keys, _type, _name, args, extra) => maps.push({ keys, args, ...extra }),
  });
  return { action: actions.writerMoveLines!, maps };
}

const { action, maps } = register();

describe("moveLineBlock", () => {
  const lines = ["a", "b", "c", "d"];
  const get = (line: number) => lines[line]!;

  test("down swaps the block with the line below", () => {
    expect(moveLineBlock(4, get, 1, 2, 1)).toEqual({ fromLine: 1, toLine: 3, text: "d\nb\nc" });
  });

  test("up swaps the block with the line above", () => {
    expect(moveLineBlock(4, get, 1, 2, -1)).toEqual({ fromLine: 0, toLine: 2, text: "b\nc\na" });
  });

  test("the document's edges leave the text alone", () => {
    expect(moveLineBlock(4, get, 2, 3, 1)).toBeNull();
    expect(moveLineBlock(4, get, 0, 1, -1)).toBeNull();
  });
});

describe("visual J / K", () => {
  test("are mapped in visual mode only", () => {
    expect(maps).toEqual([
      { keys: "J", args: { down: true }, context: "visual" },
      { keys: "K", args: { down: false }, context: "visual" },
    ]);
  });

  test("J moves a line-wise selection down and keeps it selected", () => {
    const cm = fakeCm("one\ntwo\nthree\nfour");
    const vim = {
      visualMode: true,
      visualLine: true,
      visualBlock: false,
      sel: { anchor: { line: 0, ch: 0 }, head: { line: 1, ch: 2 } },
    };
    action(cm, { down: true }, vim);
    expect(cm.text()).toBe("three\none\ntwo\nfour");
    expect(vim.sel).toEqual({ anchor: { line: 1, ch: 0 }, head: { line: 2, ch: 2 } });
    expect(cm.selection).toEqual({ anchor: { line: 1, ch: 0 }, head: { line: 2, ch: 3 } });
  });

  test("K moves a backwards character selection up", () => {
    const cm = fakeCm("one\ntwo\nthree");
    const vim = {
      visualMode: true,
      visualLine: false,
      visualBlock: false,
      sel: { anchor: { line: 2, ch: 3 }, head: { line: 1, ch: 1 } },
    };
    action(cm, { down: false }, vim);
    expect(cm.text()).toBe("two\nthree\none");
    expect(cm.selection).toEqual({ anchor: { line: 1, ch: 4 }, head: { line: 0, ch: 1 } });
  });

  test("block mode and the document's edge change nothing", () => {
    const cm = fakeCm("one\ntwo");
    const at = { line: 1, ch: 0 };
    action(
      cm,
      { down: true },
      { visualMode: true, visualLine: true, visualBlock: false, sel: { anchor: at, head: at } },
    );
    action(
      cm,
      { down: false },
      { visualMode: true, visualLine: false, visualBlock: true, sel: { anchor: at, head: at } },
    );
    expect(cm.text()).toBe("one\ntwo");
  });
});
