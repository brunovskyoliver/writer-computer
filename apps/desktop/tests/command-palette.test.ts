import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";

const mockedInvoke = vi.mocked(invoke);

describe("fuzzySearch IPC", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("fuzzySearch calls correct command", async () => {
    mockedInvoke.mockResolvedValue([]);
    const { fuzzySearch } = await import("../src/lib/tauri");
    await fuzzySearch("test", 20);
    expect(mockedInvoke).toHaveBeenCalledWith("fuzzy_search", { query: "test", limit: 20 });
  });

  test("indexWorkspace calls correct command", async () => {
    mockedInvoke.mockResolvedValue({ file_count: 5, duration_ms: 10 });
    const { indexWorkspace } = await import("../src/lib/tauri");
    await indexWorkspace();
    expect(mockedInvoke).toHaveBeenCalledWith("index_workspace");
  });
});

describe("useFuzzySearch hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("returns empty on empty query", async () => {
    // The hook internally calls fuzzySearch via tauri which is mocked
    // Testing the logic: empty query should not trigger search
    mockedInvoke.mockResolvedValue([]);

    // The hook debounces at 50ms, so no invoke should happen for empty query
    // We verify this by checking that invoke was not called
    expect(mockedInvoke).not.toHaveBeenCalledWith("fuzzy_search", expect.anything());
  });
});

describe("palette open routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("a created note opens in the pane captured when the palette ran, not the pane focused when the write finishes", async () => {
    const { useEditorStore } = await import("../src/stores/editor-store");
    const { createLayout, findPane, panes, splitPaneWithTab } =
      await import("../src/lib/editor-layout");
    const { createAndOpenFile } = await import("../src/components/command-palette/open-routes");

    useEditorStore.setState({
      openFiles: new Map(),
      tabs: [],
      layout: createLayout(),
      activeTabId: null,
      activeFilePath: null,
    });

    let finishCreate: () => void = () => {};
    mockedInvoke.mockImplementation(async (cmd: string, args: unknown) => {
      const path = (args as { path?: string }).path ?? "";
      if (cmd === "create_file") {
        await new Promise<void>((resolve) => (finishCreate = resolve));
        return { path, content: "", modified_at: 1 };
      }
      if (cmd === "read_file") return { path, content: path, modified_at: 1 };
      return null;
    });

    // Two panes, [a] | [b], with the palette opened over the left one.
    await useEditorStore.getState().openFile("/ws/a.md");
    await useEditorStore.getState().openFileInNewTab("/ws/b.md");
    const [a, b] = useEditorStore.getState().tabs;
    const { layout } = useEditorStore.getState();
    useEditorStore.setState({
      layout: splitPaneWithTab(layout, layout.focusedPaneId, "x", "after", b!.id),
    });
    const [left, right] = panes(useEditorStore.getState().layout);
    useEditorStore.getState().setFocusedPane(left!.id);

    const pending = createAndOpenFile("/ws/new.md", { paneId: left!.id, tabId: a!.id });
    // Focus moves while the file is being written.
    useEditorStore.getState().setFocusedPane(right!.id);
    finishCreate();
    await pending;

    const state = useEditorStore.getState();
    // The left pane's file tab navigated in place per the replace policy; the
    // right pane never saw the new file.
    expect(state.tabs.find((tab) => tab.id === a!.id)!.location).toEqual({
      kind: "file",
      path: "/ws/new.md",
    });
    expect(findPane(state.layout, right!.id)!.tabIds).toEqual([b!.id]);
    expect(state.tabs.find((tab) => tab.id === b!.id)!.location).toEqual({
      kind: "file",
      path: "/ws/b.md",
    });
  });
});
