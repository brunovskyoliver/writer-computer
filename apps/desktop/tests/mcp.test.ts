import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { dispatchMcpRequest, respondToMcpRequest } from "../src/lib/mcp";
import { useEditorStore, type Tab } from "../src/stores/editor-store";
import { useWorkspaceStore } from "../src/stores/workspace-store";

const mockedInvoke = vi.mocked(invoke);

function fileTab(id: string, path: string): Tab {
  return { id, location: { kind: "file", path }, back: [], forward: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  useWorkspaceStore.setState({ root: "/ws", chromeMode: "workspace" });
  useEditorStore.setState({
    openFiles: new Map(),
    tabs: [fileTab("tab-1", "/ws/a.md"), fileTab("tab-2", "/ws/b.md")],
    activeTabId: "tab-1",
    activeFilePath: "/ws/a.md",
  });
});

describe("dispatchMcpRequest", () => {
  test("describe_window reports the workspace stores", async () => {
    const dispatch = await dispatchMcpRequest({ request_id: 1, tool: "describe_window", args: {} });
    expect(dispatch).toEqual({
      ok: true,
      result: {
        root: "/ws",
        chromeMode: "workspace",
        standaloneFile: null,
        activeFilePath: "/ws/a.md",
      },
    });
  });

  test("describe_window reports the hosted file as standaloneFile in compact mode", async () => {
    useWorkspaceStore.setState({ root: null, chromeMode: "compact-file" });
    const dispatch = await dispatchMcpRequest({ request_id: 1, tool: "describe_window", args: {} });
    expect(dispatch).toEqual({
      ok: true,
      result: {
        root: null,
        chromeMode: "compact-file",
        standaloneFile: "/ws/a.md",
        activeFilePath: "/ws/a.md",
      },
    });
  });

  test("list_tabs maps tabs to path, location_kind, active", async () => {
    useEditorStore.setState({
      tabs: [
        fileTab("tab-1", "/ws/a.md"),
        { id: "tab-2", location: { kind: "launcher" }, back: [], forward: [] },
        {
          id: "tab-3",
          location: { kind: "drawing", path: "/ws/d.excalidraw.svg" },
          back: [],
          forward: [],
        },
      ],
      activeTabId: "tab-3",
    });
    const dispatch = await dispatchMcpRequest({ request_id: 1, tool: "list_tabs", args: {} });
    expect(dispatch).toEqual({
      ok: true,
      result: {
        tabs: [
          { path: "/ws/a.md", location_kind: "file", active: false },
          { path: null, location_kind: "launcher", active: false },
          { path: "/ws/d.excalidraw.svg", location_kind: "drawing", active: true },
        ],
      },
    });
  });

  test("an unknown tool answers with an internal error instead of throwing", async () => {
    const dispatch = await dispatchMcpRequest({ request_id: 1, tool: "nonsense", args: {} });
    expect(dispatch.ok).toBe(false);
    if (!dispatch.ok) {
      expect(dispatch.error.kind).toBe("internal");
      expect(dispatch.error.detail).toContain("nonsense");
    }
  });
});

describe("respondToMcpRequest", () => {
  test("a successful dispatch invokes mcp_respond with the result", async () => {
    mockedInvoke.mockResolvedValue(undefined);
    await respondToMcpRequest({ request_id: 7, tool: "list_tabs", args: {} });
    expect(mockedInvoke).toHaveBeenCalledWith("mcp_respond", {
      requestId: 7,
      result: {
        tabs: [
          { path: "/ws/a.md", location_kind: "file", active: true },
          { path: "/ws/b.md", location_kind: "file", active: false },
        ],
      },
      error: null,
    });
  });

  test("a failed dispatch invokes mcp_respond with the error", async () => {
    mockedInvoke.mockResolvedValue(undefined);
    await respondToMcpRequest({ request_id: 9, tool: "nonsense", args: {} });
    expect(mockedInvoke).toHaveBeenCalledWith("mcp_respond", {
      requestId: 9,
      result: null,
      error: { kind: "internal", detail: "unknown webview tool: nonsense" },
    });
  });
});
