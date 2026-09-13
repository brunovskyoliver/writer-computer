import { describe, expect, test, vi } from "vite-plus/test";
import {
  createVimClipboardBridge,
  type VimRegister,
} from "../src/components/editor-area/vim-clipboard";

function setup(clipboard = "") {
  const setText = vi.fn((text = "", linewise?: boolean) => {
    register.text = text;
    register.linewise = linewise;
  });
  const register: VimRegister & { text: string; linewise: boolean | undefined } = {
    text: "",
    linewise: undefined,
    toString: () => register.text,
    setText,
  };
  const target = new EventTarget();
  const readText = vi.fn(() => Promise.resolve(clipboard));
  const writeText = vi.fn((text: string) => {
    clipboard = text;
    return Promise.resolve();
  });
  const bridge = createVimClipboardBridge({
    register: () => register,
    readText,
    writeText,
    target,
  });
  return { bridge, register, setText, target, readText, writeText };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("vim clipboard bridge", () => {
  test("acquire seeds the register from the clipboard", async () => {
    const { bridge, register } = setup("copied elsewhere\n");
    bridge.acquire();
    await settle();
    expect(register.text).toBe("copied elsewhere\n");
    expect(register.linewise).toBe(true);
  });

  test("a changed register is written to the clipboard once", async () => {
    const { bridge, register, writeText } = setup();
    bridge.acquire();
    await settle();
    register.text = "yanked";
    bridge.syncRegisterToClipboard();
    bridge.syncRegisterToClipboard();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("yanked");
  });

  test("an empty register never wipes the clipboard", async () => {
    const { bridge, writeText } = setup("keep me");
    bridge.acquire();
    await settle();
    bridge.syncRegisterToClipboard();
    expect(writeText).not.toHaveBeenCalled();
  });

  test("a yank's own echo does not overwrite the register on focus", async () => {
    const { bridge, register, setText, target } = setup();
    bridge.acquire();
    await settle();
    register.text = "yanked";
    bridge.syncRegisterToClipboard();
    setText.mockClear();
    target.dispatchEvent(new Event("focus"));
    await settle();
    expect(setText).not.toHaveBeenCalled();
  });

  test("copy and cut pull new clipboard text into the register", async () => {
    const { bridge, register, target, writeText } = setup("first");
    bridge.acquire();
    await settle();
    await writeText("second");
    target.dispatchEvent(new Event("copy"));
    await settle();
    expect(register.text).toBe("second");
    expect(register.linewise).toBe(false);
    await writeText("third");
    target.dispatchEvent(new Event("cut"));
    await settle();
    expect(register.text).toBe("third");
  });

  test("a read that resolves after a newer yank is discarded", async () => {
    let resolveRead!: (text: string) => void;
    const { bridge, register, target, readText } = setup();
    bridge.acquire();
    await settle();
    readText.mockImplementationOnce(() => new Promise((resolve) => (resolveRead = resolve)));
    target.dispatchEvent(new Event("focus"));
    register.text = "yanked";
    bridge.syncRegisterToClipboard();
    resolveRead("stale");
    await settle();
    expect(register.text).toBe("yanked");
  });

  test("listeners live from the first acquire to the last release", async () => {
    const { bridge, setText, target, readText } = setup("a");
    bridge.acquire();
    bridge.acquire();
    await settle();
    expect(readText).toHaveBeenCalledTimes(1);
    bridge.release();
    target.dispatchEvent(new Event("focus"));
    expect(readText).toHaveBeenCalledTimes(2);
    bridge.release();
    setText.mockClear();
    target.dispatchEvent(new Event("focus"));
    await settle();
    expect(readText).toHaveBeenCalledTimes(2);
    expect(setText).not.toHaveBeenCalled();
    expect(() => bridge.release()).toThrow();
  });

  test("clipboard failures are reported, not swallowed", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { bridge, register, readText, writeText } = setup();
    readText.mockRejectedValueOnce(new Error("no clipboard"));
    bridge.acquire();
    await settle();
    expect(error).toHaveBeenCalledTimes(1);
    writeText.mockRejectedValueOnce(new Error("no clipboard"));
    register.text = "yanked";
    bridge.syncRegisterToClipboard();
    await settle();
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});
