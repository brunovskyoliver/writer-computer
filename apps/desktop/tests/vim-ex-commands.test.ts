import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { EditorView } from "@codemirror/view";
import {
  E37,
  NO_FILE,
  registerVimExCommands,
  resetVimExCommandsForTests,
  type VimExDeps,
  type VimExFn,
} from "../src/components/editor-area/vim-ex-commands";

const view = {} as EditorView;
const cm = { cm6: view };

function setup(file?: { isDirty: boolean; content: string; diskContent: string }) {
  const handlers = new Map<string, VimExFn>();
  const vim = {
    defineEx: vi.fn((name: string, _prefix: string | undefined, fn: VimExFn) => {
      handlers.set(name, fn);
    }),
  };
  const deps: VimExDeps = {
    resolve: vi.fn(() => ({ tabId: "tab-1", path: "/note.md" })),
    getOpenFile: vi.fn(() => file),
    saveNow: vi.fn(() => Promise.resolve(true)),
    closeTab: vi.fn(),
    reloadFromDisk: vi.fn(),
    notify: vi.fn(),
  };
  registerVimExCommands(vim, deps);
  const run = (name: string, argString?: string) => handlers.get(name)!(cm, { argString });
  return { vim, deps, run };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("vim ex commands", () => {
  beforeEach(() => resetVimExCommandsForTests());

  test("registers once per JS context", () => {
    const { vim, deps } = setup();
    registerVimExCommands(vim, deps);
    expect(vim.defineEx).toHaveBeenCalledTimes(4);
  });

  test(":w saves the tab's path immediately", () => {
    const { deps, run } = setup({ isDirty: true, content: "a", diskContent: "" });
    run("write");
    expect(deps.saveNow).toHaveBeenCalledWith("/note.md");
    expect(deps.closeTab).not.toHaveBeenCalled();
  });

  test(":q refuses a dirty buffer with E37", () => {
    const { deps, run } = setup({ isDirty: true, content: "a", diskContent: "" });
    run("quit");
    expect(deps.notify).toHaveBeenCalledWith(view, E37);
    expect(deps.closeTab).not.toHaveBeenCalled();
  });

  test(":q closes a clean buffer", () => {
    const { deps, run } = setup({ isDirty: false, content: "a", diskContent: "a" });
    run("quit");
    expect(deps.closeTab).toHaveBeenCalledWith("tab-1");
    expect(deps.notify).not.toHaveBeenCalled();
  });

  test(":q closes when dirty but the buffer already equals disk", () => {
    const { deps, run } = setup({ isDirty: true, content: "a", diskContent: "a" });
    run("quit");
    expect(deps.closeTab).toHaveBeenCalledWith("tab-1");
  });

  test(":q! restores the disk image then closes", () => {
    const { deps, run } = setup({ isDirty: true, content: "edited", diskContent: "orig" });
    run("quit", "!");
    expect(deps.reloadFromDisk).toHaveBeenCalledWith("/note.md", "orig");
    expect(deps.closeTab).toHaveBeenCalledWith("tab-1");
    expect(deps.notify).not.toHaveBeenCalled();
  });

  test(":wq closes only after a successful save", async () => {
    const { deps, run } = setup({ isDirty: true, content: "a", diskContent: "" });
    run("wq");
    expect(deps.saveNow).toHaveBeenCalledWith("/note.md");
    await settle();
    expect(deps.closeTab).toHaveBeenCalledWith("tab-1");
  });

  test(":x is :wq", async () => {
    const { deps, run } = setup({ isDirty: true, content: "a", diskContent: "" });
    run("xit");
    await settle();
    expect(deps.saveNow).toHaveBeenCalledWith("/note.md");
    expect(deps.closeTab).toHaveBeenCalledWith("tab-1");
  });

  test(":wq leaves the tab open when the save fails", async () => {
    const { deps, run } = setup({ isDirty: true, content: "a", diskContent: "" });
    vi.mocked(deps.saveNow).mockResolvedValue(false);
    run("wq");
    await settle();
    expect(deps.closeTab).not.toHaveBeenCalled();
  });

  test("an unregistered view is reported, not acted on", () => {
    const { deps, run } = setup();
    vi.mocked(deps.resolve).mockReturnValue(null);
    run("write");
    run("quit");
    expect(deps.notify).toHaveBeenCalledTimes(2);
    expect(deps.notify).toHaveBeenLastCalledWith(view, NO_FILE);
    expect(deps.saveNow).not.toHaveBeenCalled();
    expect(deps.closeTab).not.toHaveBeenCalled();
  });
});
