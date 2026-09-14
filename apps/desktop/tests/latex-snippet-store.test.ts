import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@/lib/theme", () => ({ applyTheme: vi.fn(), applyCssVarBindings: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { useLatexSnippetStore } from "../src/stores/latex-snippet-store";
import { useSettingsStore } from "../src/stores/settings-store";

const mockedInvoke = vi.mocked(invoke);

const PATH = "/data/latex-snippets.js";

/** Answer the two commands the store uses; `content` is the snippet file. */
function withFile(content: string, options: { delayRead?: number } = {}) {
  mockedInvoke.mockImplementation(async (command: string) => {
    if (command === "latex_snippets_path" || command === "reset_latex_snippets") return PATH;
    if (command === "read_file") {
      if (options.delayRead) await new Promise((resolve) => setTimeout(resolve, options.delayRead));
      return { path: PATH, content, modified_at: 0 };
    }
    throw new Error(`unexpected command ${command}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useLatexSnippetStore.setState({ filePath: null, status: { kind: "empty" } });
  useSettingsStore.setState({ settings: { "latex.snippet-variables": ["GREEK=alpha|beta"] } });
});

describe("the snippet store", () => {
  test("ensures the path, compiles the file, and reports skipped entries", async () => {
    withFile(
      '[{trigger: "mk", replacement: "$$0$", options: "tA"},' +
        ' {trigger: "@a", replacement: "\\\\${GREEK}", options: "mA"},' +
        ' {trigger: "bad", replacement: "x", options: "tZ"}]',
    );

    await useLatexSnippetStore.getState().load();
    const { filePath, status } = useLatexSnippetStore.getState();

    expect(filePath).toBe(PATH);
    expect(status.kind).toBe("loaded");
    expect(status.kind === "loaded" && status.set.count).toBe(2);
    expect(status.kind === "loaded" && status.warnings.map((w) => w.code)).toEqual([
      "invalid-options",
    ]);
  });

  test("a broken file keeps the last valid set active", async () => {
    withFile('[{trigger: "mk", replacement: "$$0$", options: "tA"}]');
    await useLatexSnippetStore.getState().load();

    withFile('[{trigger: "mk"');
    await useLatexSnippetStore.getState().load();

    const { status, getActiveSet } = useLatexSnippetStore.getState();
    expect(status.kind).toBe("failed");
    expect(getActiveSet().count).toBe(1);
  });

  test("an empty status hands the editor an inert set", () => {
    expect(useLatexSnippetStore.getState().getActiveSet().count).toBe(0);
  });

  test("a slow read never overwrites a newer load", async () => {
    withFile('[{trigger: "old", replacement: "x", options: "tA"}]', { delayRead: 20 });
    const slow = useLatexSnippetStore.getState().load();

    withFile(
      '[{trigger: "a", replacement: "x", options: "tA"}, {trigger: "b", replacement: "x", options: "tA"}]',
    );
    await useLatexSnippetStore.getState().load();
    await slow;

    const { status } = useLatexSnippetStore.getState();
    expect(status.kind === "loaded" && status.set.count).toBe(2);
  });

  test("markDisabled disables the snippet everywhere and records the reason", async () => {
    withFile('[{trigger: "x", replacement: "y", options: "mA"}]');
    await useLatexSnippetStore.getState().load();

    useLatexSnippetStore
      .getState()
      .markDisabled(0, { code: "pattern-threw", index: 0, message: "boom" });

    const { status, getActiveSet } = useLatexSnippetStore.getState();
    const set = getActiveSet();
    expect(set.byMode.inline.auto[0]?.disabled?.code).toBe("pattern-threw");
    expect(set.byMode.display.auto[0]?.disabled?.code).toBe("pattern-threw");
    expect(status.kind === "loaded" && status.warnings.map((w) => w.code)).toEqual([
      "pattern-threw",
    ]);
  });
});
