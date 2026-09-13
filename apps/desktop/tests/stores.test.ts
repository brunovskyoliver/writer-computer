import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

// Mock the tauri API before importing stores
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@/lib/theme", () => ({
  applyTheme: vi.fn(),
  applyCssVarBindings: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { createFileTab, useEditorStore } from "../src/stores/editor-store";
import { useSettingsStore } from "../src/stores/settings-store";
import { useUIStore } from "../src/stores/ui-store";
import { useWorkspaceStore } from "../src/stores/workspace-store";
import { toggleSidebar } from "../src/hooks/use-sidebar";
import { toggleTheme } from "../src/hooks/use-theme";
import { createPendingOpenDrainer, handleOpenPayload } from "../src/hooks/use-open-drop";
import { getEditorSessionSnapshot } from "../src/stores/editor-store";
import {
  buildFileDropCandidate,
  buildTabDropCandidate,
  createLayout,
  findPane,
  layoutTabIds,
  paneOfTab,
  panes,
  splitPaneWithTab,
  validateLayout,
  type DropRegion,
  type Rect,
  type TabDropTarget,
} from "../src/lib/editor-layout";
import { getTabViewState, setTabCursor } from "../src/lib/editor-views";
// Side-effect: registers the subscription that re-points the standalone
// single-file watcher whenever the active file changes in a compact window.
import "../src/lib/standalone-watch";

const mockedInvoke = vi.mocked(invoke);

function tabPaths() {
  return useEditorStore
    .getState()
    .tabs.flatMap((tab) => (tab.location.kind === "file" ? [tab.location.path] : []));
}

function makeFileTab(id: string, currentPath: string) {
  return {
    id,
    location: { kind: "file" as const, path: currentPath },
    back: [],
    forward: [],
  };
}

function createDeferred<T>() {
  let resolvePromise: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value: T) {
      resolvePromise(value);
    },
  };
}

describe("workspace-store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceStore.setState({
      root: null,
      workspaceGeneration: 0,
      chromeMode: "workspace",
      directoryCache: new Map(),
      expandedDirs: new Set(),
      pinnedFiles: [],
      sidebarMetadataVersion: 0,
      recentWorkspaces: [],
      fileCount: 0,
    });
  });

  test("openWorkspace sets root and loads entries", async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "open_workspace") return { root: "/test", name: "test", file_count: 2 };
      if (cmd === "read_directory")
        return [{ name: "hello.md", path: "/test/hello.md", is_dir: false }];
      if (cmd === "get_recent_workspaces") return ["/test"];
      return null;
    });

    await useWorkspaceStore.getState().openWorkspace("/test");

    expect(useWorkspaceStore.getState().root).toBe("/test");
    expect(useWorkspaceStore.getState().fileCount).toBe(2);
    expect(useWorkspaceStore.getState().directoryCache.has("/test")).toBe(true);
    expect(useWorkspaceStore.getState().recentWorkspaces).toEqual(["/test"]);
    expect(useEditorStore.getState().tabs).toEqual([
      { id: expect.any(String), location: { kind: "launcher" }, back: [], forward: [] },
    ]);
  });

  test("toggleDirectory expands and collapses", async () => {
    mockedInvoke.mockResolvedValue([{ name: "file.md", path: "/test/dir/file.md", is_dir: false }]);

    useWorkspaceStore.setState({
      root: "/test",
      directoryCache: new Map(),
      expandedDirs: new Set(),
    });

    // Expand
    await useWorkspaceStore.getState().toggleDirectory("/test/dir");
    expect(useWorkspaceStore.getState().expandedDirs.has("/test/dir")).toBe(true);
    expect(useWorkspaceStore.getState().directoryCache.has("/test/dir")).toBe(true);

    // Collapse
    await useWorkspaceStore.getState().toggleDirectory("/test/dir");
    expect(useWorkspaceStore.getState().expandedDirs.has("/test/dir")).toBe(false);
  });

  test("refreshDirectory discards results after the workspace changes", async () => {
    const read = createDeferred<unknown>();
    mockedInvoke.mockImplementation((command: string) =>
      command === "read_directory" ? read.promise : Promise.resolve(null),
    );
    useWorkspaceStore.setState({ root: "/old", directoryCache: new Map() });

    const refresh = useWorkspaceStore.getState().refreshDirectory("/old");
    useWorkspaceStore.setState({
      root: "/new",
      directoryCache: new Map([["/new", []]]),
    });
    read.resolve([]);
    await refresh;

    expect(useWorkspaceStore.getState().directoryCache.has("/old")).toBe(false);
    expect(useWorkspaceStore.getState().directoryCache.has("/new")).toBe(true);
  });

  test("refreshDirectory discards ABA results after the same root is reopened", async () => {
    const read = createDeferred<unknown>();
    mockedInvoke.mockImplementation((command: string) =>
      command === "read_directory" ? read.promise : Promise.resolve(null),
    );
    useWorkspaceStore.setState({
      root: "/workspace",
      workspaceGeneration: 1,
      directoryCache: new Map(),
    });

    const refresh = useWorkspaceStore.getState().refreshDirectory("/workspace");
    useWorkspaceStore.setState({
      root: "/workspace",
      workspaceGeneration: 3,
      directoryCache: new Map([["/workspace", []]]),
    });
    read.resolve([{ name: "stale.md" }]);
    await refresh;

    expect(useWorkspaceStore.getState().directoryCache.get("/workspace")).toEqual([]);
  });

  test("invalidatePath removes from cache", () => {
    useWorkspaceStore.setState({
      directoryCache: new Map([
        [
          "/test",
          [{ name: "a.md", path: "/test/a.md", is_dir: false, is_markdown: true, modified_at: 0 }],
        ],
      ]),
    });

    useWorkspaceStore.getState().invalidatePath("/test");
    expect(useWorkspaceStore.getState().directoryCache.has("/test")).toBe(false);
  });

  test("togglePinnedFile adds and removes workspace file paths", () => {
    useWorkspaceStore.setState({ root: "/test", pinnedFiles: [] });

    useWorkspaceStore.getState().togglePinnedFile("/test/a.md");
    expect(useWorkspaceStore.getState().pinnedFiles).toEqual(["/test/a.md"]);

    useWorkspaceStore.getState().togglePinnedFile("/test/a.md");
    expect(useWorkspaceStore.getState().pinnedFiles).toEqual([]);
  });

  test("togglePinnedFile ignores paths outside the workspace", () => {
    useWorkspaceStore.setState({ root: "/test", pinnedFiles: [] });

    useWorkspaceStore.getState().togglePinnedFile("/elsewhere/a.md");

    expect(useWorkspaceStore.getState().pinnedFiles).toEqual([]);
  });

  test("rewritePinnedPath updates pinned files below renamed folders", () => {
    useWorkspaceStore.setState({
      root: "/test",
      pinnedFiles: ["/test/old/a.md", "/test/old/nested/b.md", "/test/keep.md"],
    });

    useWorkspaceStore.getState().rewritePinnedPath("/test/old", "/test/new");

    expect(useWorkspaceStore.getState().pinnedFiles).toEqual([
      "/test/new/a.md",
      "/test/new/nested/b.md",
      "/test/keep.md",
    ]);
  });
});

describe("editor-store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useEditorStore.setState({
      openFiles: new Map(),
      tabs: [],
      layout: createLayout(),
      activeTabId: null,
      activeFilePath: null,
    });
    useWorkspaceStore.setState({ chromeMode: "workspace" });
  });

  test("openFile loads file and sets active", async () => {
    mockedInvoke.mockResolvedValue({
      path: "/test/file.md",
      content: "Hello",
      modified_at: 1000,
    });

    await useEditorStore.getState().openFile("/test/file.md");

    const state = useEditorStore.getState();
    expect(state.activeFilePath).toBe("/test/file.md");
    expect(tabPaths()).toEqual(["/test/file.md"]);
    expect(state.openFiles.get("/test/file.md")?.content).toBe("Hello");
  });

  test("openFile derives title from frontmatter and preserves the body verbatim", async () => {
    mockedInvoke.mockResolvedValue({
      path: "/test/file.md",
      content: "---\ntitle: Hello\n---\n\n# Hello\n\nBody",
      modified_at: 1000,
    });

    await useEditorStore.getState().openFile("/test/file.md");

    const file = useEditorStore.getState().openFiles.get("/test/file.md");
    expect(file?.title).toBe("Hello");
    expect(file?.titleSource).toBe("frontmatter");
    expect(file?.content).toBe("\n# Hello\n\nBody");
  });

  test("updateFrontmatter(path, null) unmounts the frontmatter panel, dirties the file, and re-infers title", async () => {
    mockedInvoke.mockResolvedValue({
      path: "/test/file.md",
      content: "---\ntitle: Hello\n---\n\n# From Body\n\nBody",
      modified_at: 1000,
    });
    await useEditorStore.getState().openFile("/test/file.md");

    useEditorStore.getState().updateFrontmatter("/test/file.md", null);

    const file = useEditorStore.getState().openFiles.get("/test/file.md");
    expect(file?.frontmatter).toBeNull();
    expect(file?.isDirty).toBe(true);
    // Title now falls back to the first H1 in the body since the frontmatter title is gone.
    expect(file?.title).toBe("From Body");
    expect(file?.titleSource).toBe("h1");
  });

  test("openNewTab appends and activates a launcher tab", () => {
    useEditorStore.getState().openNewTab();

    const state = useEditorStore.getState();
    expect(state.tabs).toEqual([
      { id: expect.any(String), location: { kind: "launcher" }, back: [], forward: [] },
    ]);
    expect(state.activeFilePath).toBeNull();
  });

  test("ensureLauncherTab creates a launcher when no restored tabs exist", () => {
    useEditorStore.getState().ensureLauncherTab();

    const state = useEditorStore.getState();
    expect(state.tabs).toEqual([
      { id: expect.any(String), location: { kind: "launcher" }, back: [], forward: [] },
    ]);
    expect(state.activeFilePath).toBeNull();
  });

  test("closeFile removes and activates previous tab", async () => {
    mockedInvoke
      .mockResolvedValueOnce({
        path: "/a.md",
        content: "a",
        modified_at: 1,
      })
      .mockResolvedValueOnce({
        path: "/b.md",
        content: "b",
        modified_at: 2,
      });

    await useEditorStore.getState().openFile("/a.md");
    await useEditorStore.getState().openFileInNewTab("/b.md");

    useEditorStore.getState().closeFile("/b.md");

    const state = useEditorStore.getState();
    expect(tabPaths()).toEqual(["/a.md"]);
    expect(state.activeFilePath).toBe("/a.md");
    expect(state.openFiles.has("/b.md")).toBe(false);
  });

  test("closing the last tab recreates a launcher tab", async () => {
    mockedInvoke.mockResolvedValue({ path: "/a.md", content: "a", modified_at: 1 });

    await useEditorStore.getState().openFile("/a.md");
    useEditorStore.getState().closeTab(useEditorStore.getState().activeTabId!);

    const state = useEditorStore.getState();
    expect(state.tabs).toEqual([
      { id: expect.any(String), location: { kind: "launcher" }, back: [], forward: [] },
    ]);
    expect(state.activeFilePath).toBeNull();
    expect(state.openFiles.size).toBe(0);
  });

  test("navigateToFile updates active tab history", async () => {
    mockedInvoke
      .mockResolvedValueOnce({ path: "/a.md", content: "a", modified_at: 1 })
      .mockResolvedValueOnce({ path: "/b.md", content: "b", modified_at: 2 });

    await useEditorStore.getState().openFile("/a.md");
    await useEditorStore.getState().navigateToFile("/b.md");

    const [tab] = useEditorStore.getState().tabs;
    expect(tab).toMatchObject({
      location: { kind: "file", path: "/b.md" },
      back: [{ kind: "file", path: "/a.md" }],
      forward: [],
    });
  });

  test("opening a drawing leaves the note's tab in place and reuses its own", async () => {
    mockedInvoke.mockResolvedValueOnce({ path: "/a.md", content: "a", modified_at: 1 });

    await useEditorStore.getState().openFile("/a.md");
    await useEditorStore.getState().navigateToFile("/sketch.excalidraw.svg");

    let state = useEditorStore.getState();
    expect(state.tabs.map((tab) => tab.location)).toEqual([
      { kind: "file", path: "/a.md" },
      { kind: "drawing", path: "/sketch.excalidraw.svg" },
    ]);
    expect(state.activeTabId).toBe(state.tabs[1]!.id);
    // A drawing is not an open *file*: it never enters `openFiles` and never
    // becomes `activeFilePath`.
    expect(state.activeFilePath).toBeNull();
    expect(state.openFiles.has("/sketch.excalidraw.svg")).toBe(false);

    const drawingTabId = state.tabs[1]!.id;
    state.setActiveTab(state.tabs[0]!.id);
    await useEditorStore.getState().openFile("/sketch.excalidraw.svg");

    state = useEditorStore.getState();
    expect(state.tabs).toHaveLength(2);
    expect(state.activeTabId).toBe(drawingTabId);
  });

  test("navigateBack and navigateForward use tab-local history", async () => {
    mockedInvoke
      .mockResolvedValueOnce({ path: "/a.md", content: "a", modified_at: 1 })
      .mockResolvedValueOnce({ path: "/b.md", content: "b", modified_at: 2 });

    await useEditorStore.getState().openFile("/a.md");
    await useEditorStore.getState().navigateToFile("/b.md");
    await useEditorStore.getState().navigateBack();

    let [tab] = useEditorStore.getState().tabs;
    expect(tab).toMatchObject({
      location: { kind: "file", path: "/a.md" },
      forward: [{ kind: "file", path: "/b.md" }],
    });

    await useEditorStore.getState().navigateForward();

    [tab] = useEditorStore.getState().tabs;
    expect(tab).toMatchObject({
      location: { kind: "file", path: "/b.md" },
      back: [{ kind: "file", path: "/a.md" }],
    });
  });

  test("opening a file while a launcher tab is active reuses that tab id", async () => {
    mockedInvoke.mockResolvedValue({ path: "/a.md", content: "a", modified_at: 1 });

    useEditorStore.getState().openNewTab();
    const launcherTabId = useEditorStore.getState().activeTabId;

    await useEditorStore.getState().openFile("/a.md");

    const [tab] = useEditorStore.getState().tabs;
    expect(tab).toMatchObject({
      id: launcherTabId,
      location: { kind: "file", path: "/a.md" },
    });
    expect(useEditorStore.getState().activeTabId).toBe(launcherTabId);
  });

  test("opening an already-open file from a launcher tab creates a duplicate file tab", async () => {
    mockedInvoke.mockResolvedValue({ path: "/a.md", content: "a", modified_at: 1 });

    await useEditorStore.getState().openFile("/a.md");
    useEditorStore.getState().openNewTab();

    await useEditorStore.getState().openFile("/a.md");

    expect(tabPaths()).toEqual(["/a.md", "/a.md"]);
  });

  test("navigateToFile is a no-op on launcher tabs until a file is chosen", async () => {
    useEditorStore.getState().openNewTab();

    await useEditorStore.getState().navigateBack();
    await useEditorStore.getState().navigateForward();

    expect(useEditorStore.getState().tabs).toEqual([
      { id: expect.any(String), location: { kind: "launcher" }, back: [], forward: [] },
    ]);
    expect(useEditorStore.getState().activeFilePath).toBeNull();
  });

  test("setActiveFile switches active file", async () => {
    mockedInvoke
      .mockResolvedValueOnce({ path: "/a.md", content: "a", modified_at: 1 })
      .mockResolvedValueOnce({ path: "/b.md", content: "b", modified_at: 2 });

    await useEditorStore.getState().openFile("/a.md");
    await useEditorStore.getState().openFileInNewTab("/b.md");

    useEditorStore.getState().setActiveFile("/a.md");
    expect(useEditorStore.getState().activeFilePath).toBe("/a.md");
  });

  test("updateContent marks file as dirty", async () => {
    mockedInvoke.mockResolvedValue({
      path: "/test.md",
      content: "original",
      modified_at: 1,
    });

    await useEditorStore.getState().openFile("/test.md");
    useEditorStore.getState().updateContent("/test.md", "modified");

    const file = useEditorStore.getState().openFiles.get("/test.md");
    expect(file?.isDirty).toBe(true);
    expect(file?.content).toBe("modified");
  });

  test("markSaved clears dirty flag", async () => {
    mockedInvoke.mockResolvedValue({
      path: "/test.md",
      content: "original",
      modified_at: 1,
    });

    await useEditorStore.getState().openFile("/test.md");
    useEditorStore.getState().updateContent("/test.md", "modified");
    useEditorStore.getState().markSaved("/test.md", "modified");

    const file = useEditorStore.getState().openFiles.get("/test.md");
    expect(file?.isDirty).toBe(false);
    expect(file?.diskContent).toBe("modified");
  });

  test("session snapshots omit launcher tabs", async () => {
    mockedInvoke.mockResolvedValue({ path: "/a.md", content: "a", modified_at: 1 });

    await useEditorStore.getState().openFile("/a.md");
    useEditorStore.getState().openNewTab();

    const snapshot = getEditorSessionSnapshot(useEditorStore.getState());
    expect(snapshot.tabs).toEqual([
      { location: { kind: "file", path: "/a.md" }, back: [], forward: [] },
    ]);
    expect(snapshot.activeIndex).toBeNull();
  });

  test("openFileInNewTab always creates a fresh tab even when the file is already open", async () => {
    mockedInvoke.mockResolvedValue({ path: "/a.md", content: "a", modified_at: 1 });

    await useEditorStore.getState().openFile("/a.md");
    expect(tabPaths()).toEqual(["/a.md"]);

    await useEditorStore.getState().openFileInNewTab("/a.md");

    expect(tabPaths()).toEqual(["/a.md", "/a.md"]);
    // The newly created tab should be active.
    const state = useEditorStore.getState();
    const lastTab = state.tabs[state.tabs.length - 1];
    expect(state.activeTabId).toBe(lastTab.id);
  });

  test("openFileInNewTab removes the temporary tab when loading fails", async () => {
    mockedInvoke.mockRejectedValueOnce(new Error("read failed"));

    await expect(useEditorStore.getState().openFileInNewTab("/missing.md")).rejects.toThrow();

    const state = useEditorStore.getState();
    // The failed open should not have left any file tab behind.
    expect(state.tabs.some((tab) => tab.location.kind === "file")).toBe(false);
  });

  test("openCompactFile replaces existing tabs with a single file tab", async () => {
    mockedInvoke
      .mockResolvedValueOnce({ path: "/a.md", content: "a", modified_at: 1 })
      .mockResolvedValueOnce({ path: "/b.md", content: "b", modified_at: 2 })
      .mockResolvedValueOnce({ path: "/c.md", content: "c", modified_at: 3 });

    await useEditorStore.getState().openFile("/a.md");
    await useEditorStore.getState().openFileInNewTab("/b.md");
    await useEditorStore.getState().openCompactFile("/c.md");

    const state = useEditorStore.getState();
    expect(tabPaths()).toEqual(["/c.md"]);
    expect(state.activeFilePath).toBe("/c.md");
    expect(state.openFiles.has("/a.md")).toBe(false);
    expect(state.openFiles.has("/b.md")).toBe(false);
    expect(state.openFiles.get("/c.md")?.content).toBe("c");
  });

  test("removePathReferences closes every tab whose current location matches", async () => {
    mockedInvoke
      .mockResolvedValueOnce({ path: "/a.md", content: "a", modified_at: 1 })
      .mockResolvedValueOnce({ path: "/b.md", content: "b", modified_at: 2 })
      .mockResolvedValueOnce({ path: "/a.md", content: "a", modified_at: 1 });

    await useEditorStore.getState().openFile("/a.md");
    await useEditorStore.getState().openFileInNewTab("/b.md");
    await useEditorStore.getState().openFileInNewTab("/a.md");

    expect(tabPaths()).toEqual(["/a.md", "/b.md", "/a.md"]);

    useEditorStore.getState().removePathReferences("/a.md");

    expect(tabPaths()).toEqual(["/b.md"]);
    expect(useEditorStore.getState().openFiles.has("/a.md")).toBe(false);
  });

  test("removePathReferences strips the path from all remaining histories", async () => {
    mockedInvoke
      .mockResolvedValueOnce({ path: "/a.md", content: "a", modified_at: 1 })
      .mockResolvedValueOnce({ path: "/b.md", content: "b", modified_at: 2 })
      .mockResolvedValueOnce({ path: "/c.md", content: "c", modified_at: 3 });

    await useEditorStore.getState().openFile("/a.md");
    await useEditorStore.getState().navigateToFile("/b.md");
    await useEditorStore.getState().navigateToFile("/c.md");

    let [tab] = useEditorStore.getState().tabs;
    expect(tab).toMatchObject({
      location: { kind: "file", path: "/c.md" },
      back: [
        { kind: "file", path: "/a.md" },
        { kind: "file", path: "/b.md" },
      ],
    });

    useEditorStore.getState().removePathReferences("/b.md");

    [tab] = useEditorStore.getState().tabs;
    expect(tab).toMatchObject({
      location: { kind: "file", path: "/c.md" },
      back: [{ kind: "file", path: "/a.md" }],
      forward: [],
    });
  });

  test("removePathReferences ensures a launcher tab when the last file tab disappears", async () => {
    mockedInvoke.mockResolvedValue({ path: "/a.md", content: "a", modified_at: 1 });

    await useEditorStore.getState().openFile("/a.md");
    useEditorStore.getState().removePathReferences("/a.md");

    const state = useEditorStore.getState();
    expect(state.tabs).toEqual([
      { id: expect.any(String), location: { kind: "launcher" }, back: [], forward: [] },
    ]);
    expect(state.activeFilePath).toBeNull();
    expect(state.openFiles.size).toBe(0);
  });

  test("removePathsWithPrefix closes all tabs whose path starts with prefix", async () => {
    mockedInvoke
      .mockResolvedValueOnce({ path: "/ws/dir/a.md", content: "a", modified_at: 1 })
      .mockResolvedValueOnce({ path: "/ws/dir/b.md", content: "b", modified_at: 2 })
      .mockResolvedValueOnce({ path: "/ws/other.md", content: "c", modified_at: 3 });

    await useEditorStore.getState().openFile("/ws/dir/a.md");
    await useEditorStore.getState().openFileInNewTab("/ws/dir/b.md");
    await useEditorStore.getState().openFileInNewTab("/ws/other.md");

    expect(tabPaths()).toEqual(["/ws/dir/a.md", "/ws/dir/b.md", "/ws/other.md"]);

    useEditorStore.getState().removePathsWithPrefix("/ws/dir");

    expect(tabPaths()).toEqual(["/ws/other.md"]);
    expect(useEditorStore.getState().openFiles.has("/ws/dir/a.md")).toBe(false);
    expect(useEditorStore.getState().openFiles.has("/ws/dir/b.md")).toBe(false);
    expect(useEditorStore.getState().openFiles.has("/ws/other.md")).toBe(true);
  });

  test("removePathsWithPrefix strips matching paths from remaining histories", async () => {
    mockedInvoke
      .mockResolvedValueOnce({ path: "/ws/dir/a.md", content: "a", modified_at: 1 })
      .mockResolvedValueOnce({ path: "/ws/dir/b.md", content: "b", modified_at: 2 })
      .mockResolvedValueOnce({ path: "/ws/other.md", content: "c", modified_at: 3 });

    await useEditorStore.getState().openFile("/ws/dir/a.md");
    await useEditorStore.getState().navigateToFile("/ws/dir/b.md");
    await useEditorStore.getState().navigateToFile("/ws/other.md");

    // Tab has back history: [/ws/dir/a.md, /ws/dir/b.md]
    useEditorStore.getState().removePathsWithPrefix("/ws/dir");

    const [tab] = useEditorStore.getState().tabs;
    expect(tab).toMatchObject({
      location: { kind: "file", path: "/ws/other.md" },
      back: [],
    });
  });

  test("removePathsWithPrefix does not match sibling prefixes", async () => {
    mockedInvoke
      .mockResolvedValueOnce({ path: "/ws/notes/a.md", content: "a", modified_at: 1 })
      .mockResolvedValueOnce({
        path: "/ws/notes-archive/b.md",
        content: "b",
        modified_at: 2,
      });

    await useEditorStore.getState().openFile("/ws/notes/a.md");
    await useEditorStore.getState().openFileInNewTab("/ws/notes-archive/b.md");

    useEditorStore.getState().removePathsWithPrefix("/ws/notes");

    expect(tabPaths()).toEqual(["/ws/notes-archive/b.md"]);
  });

  test("removePathsWithPrefix ensures launcher tab when all tabs removed", async () => {
    mockedInvoke.mockResolvedValue({ path: "/ws/dir/a.md", content: "a", modified_at: 1 });

    await useEditorStore.getState().openFile("/ws/dir/a.md");
    useEditorStore.getState().removePathsWithPrefix("/ws/dir");

    const state = useEditorStore.getState();
    expect(state.tabs).toEqual([
      { id: expect.any(String), location: { kind: "launcher" }, back: [], forward: [] },
    ]);
  });

  test("rewritePathPrefix rewrites location, history, and openFiles keys", async () => {
    mockedInvoke
      .mockResolvedValueOnce({ path: "/ws/old/a.md", content: "a", modified_at: 1 })
      .mockResolvedValueOnce({ path: "/ws/old/b.md", content: "b", modified_at: 2 })
      .mockResolvedValueOnce({ path: "/ws/other.md", content: "c", modified_at: 3 });

    await useEditorStore.getState().openFile("/ws/old/a.md");
    await useEditorStore.getState().navigateToFile("/ws/old/b.md");

    // Open a second tab for an unrelated file
    await useEditorStore.getState().openFileInNewTab("/ws/other.md");

    useEditorStore.getState().rewritePathPrefix("/ws/old", "/ws/new");

    const state = useEditorStore.getState();
    const fileTabs = state.tabs.filter((t) => t.location.kind === "file");

    // First tab should have rewritten paths
    expect(fileTabs[0]).toMatchObject({
      location: { kind: "file", path: "/ws/new/b.md" },
      back: [{ kind: "file", path: "/ws/new/a.md" }],
    });

    // Second tab is unchanged
    expect(fileTabs[1]).toMatchObject({
      location: { kind: "file", path: "/ws/other.md" },
    });

    // openFiles keys should be rewritten
    expect(state.openFiles.has("/ws/new/a.md")).toBe(true);
    expect(state.openFiles.has("/ws/new/b.md")).toBe(true);
    expect(state.openFiles.has("/ws/old/a.md")).toBe(false);
    expect(state.openFiles.has("/ws/old/b.md")).toBe(false);

    // Rewritten files should have updated path field
    expect(state.openFiles.get("/ws/new/a.md")?.path).toBe("/ws/new/a.md");
  });

  test("rewritePathPrefix does not match sibling prefixes", async () => {
    mockedInvoke
      .mockResolvedValueOnce({ path: "/ws/notes/a.md", content: "a", modified_at: 1 })
      .mockResolvedValueOnce({
        path: "/ws/notes-archive/b.md",
        content: "b",
        modified_at: 2,
      });

    await useEditorStore.getState().openFile("/ws/notes/a.md");
    await useEditorStore.getState().openFileInNewTab("/ws/notes-archive/b.md");

    useEditorStore.getState().rewritePathPrefix("/ws/notes", "/ws/renamed");

    expect(tabPaths()).toEqual(["/ws/renamed/a.md", "/ws/notes-archive/b.md"]);
  });
});

describe("workspace-store rewriteExpandedDir", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceStore.setState({
      root: "/ws",
      directoryCache: new Map([
        ["/ws", []],
        ["/ws/dir", []],
        ["/ws/dir/sub", []],
      ]),
      expandedDirs: new Set(["/ws/dir", "/ws/dir/sub"]),
    });
  });

  test("rewrites the folder and its expanded children", () => {
    useWorkspaceStore.getState().rewriteExpandedDir("/ws/dir", "/ws/renamed");

    const expanded = useWorkspaceStore.getState().expandedDirs;
    expect(expanded.has("/ws/dir")).toBe(false);
    expect(expanded.has("/ws/dir/sub")).toBe(false);
    expect(expanded.has("/ws/renamed")).toBe(true);
    expect(expanded.has("/ws/renamed/sub")).toBe(true);
  });

  test("rekeys directory cache entries", () => {
    useWorkspaceStore.getState().rewriteExpandedDir("/ws/dir", "/ws/renamed");

    const cache = useWorkspaceStore.getState().directoryCache;
    expect(cache.has("/ws/dir")).toBe(false);
    expect(cache.has("/ws/dir/sub")).toBe(false);
    expect(cache.has("/ws/renamed")).toBe(true);
    expect(cache.has("/ws/renamed/sub")).toBe(true);
    // Root entry should be unchanged
    expect(cache.has("/ws")).toBe(true);
  });

  test("is a no-op when the folder is not expanded", () => {
    useWorkspaceStore.setState({
      expandedDirs: new Set(["/ws/other"]),
    });

    useWorkspaceStore.getState().rewriteExpandedDir("/ws/dir", "/ws/renamed");

    expect(useWorkspaceStore.getState().expandedDirs.has("/ws/other")).toBe(true);
    expect(useWorkspaceStore.getState().expandedDirs.size).toBe(1);
  });
});

describe("ui-store", () => {
  beforeEach(() => {
    useUIStore.setState({
      isCommandPaletteOpen: false,
      commandPaletteIntent: "search",
      commandPaletteSearch: "",
    });

    useSettingsStore.setState({
      settings: {
        "appearance.sidebar-visible": true,
        "appearance.theme": "system",
      },
      isLoaded: true,
    });
  });

  test("toggleSidebar toggles collapsed state", () => {
    mockedInvoke.mockResolvedValue(undefined);

    toggleSidebar();
    expect(useSettingsStore.getState().settings["appearance.sidebar-visible"]).toBe(false);

    toggleSidebar();
    expect(useSettingsStore.getState().settings["appearance.sidebar-visible"]).toBe(true);
  });

  test("openCommandPalette and closeCommandPalette", () => {
    useUIStore.getState().openCommandPalette();
    expect(useUIStore.getState().isCommandPaletteOpen).toBe(true);
    expect(useUIStore.getState().commandPaletteIntent).toBe("search");

    useUIStore.getState().openCommandPalette("create-file");
    expect(useUIStore.getState().commandPaletteIntent).toBe("create-file");

    useUIStore.getState().closeCommandPalette();
    expect(useUIStore.getState().isCommandPaletteOpen).toBe(false);
    expect(useUIStore.getState().commandPaletteIntent).toBe("search");
  });

  test("closeCommandPalette resets commandPaletteSearch", () => {
    useUIStore.getState().setCommandPaletteSearch("hello");
    expect(useUIStore.getState().commandPaletteSearch).toBe("hello");

    useUIStore.getState().closeCommandPalette();
    expect(useUIStore.getState().commandPaletteSearch).toBe("");
  });

  test("toggleTheme cycles system→light→dark→system", () => {
    mockedInvoke.mockResolvedValue(undefined);

    toggleTheme();
    expect(useSettingsStore.getState().settings["appearance.theme"]).toBe("light");

    toggleTheme();
    expect(useSettingsStore.getState().settings["appearance.theme"]).toBe("dark");

    toggleTheme();
    expect(useSettingsStore.getState().settings["appearance.theme"]).toBe("system");
  });
});

describe("workspace-store removeRecentWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceStore.setState({
      root: null,
      chromeMode: "workspace",
      directoryCache: new Map(),
      expandedDirs: new Set(),
      recentWorkspaces: ["/a", "/b", "/c"],
    });
  });

  test("removeRecentWorkspace removes entry", async () => {
    mockedInvoke.mockResolvedValue(undefined);
    await useWorkspaceStore.getState().removeRecentWorkspace("/b");
    expect(useWorkspaceStore.getState().recentWorkspaces).toEqual(["/a", "/c"]);
  });
});

describe("workspace-store isStartupResolved", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ isStartupResolved: false });
  });

  test("isStartupResolved starts as false", () => {
    expect(useWorkspaceStore.getState().isStartupResolved).toBe(false);
  });

  test("setStartupResolved sets it to true", () => {
    useWorkspaceStore.getState().setStartupResolved();
    expect(useWorkspaceStore.getState().isStartupResolved).toBe(true);
  });
});

describe("workspace-store restoreFromBundle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceStore.setState({
      root: null,
      chromeMode: "workspace",
      directoryCache: new Map(),
      expandedDirs: new Set(),
      pinnedFiles: [],
      sidebarMetadataVersion: 0,
      recentWorkspaces: [],
      fileCount: 0,
    });
    useEditorStore.setState({
      openFiles: new Map(),
      tabs: [],
      activeTabId: null,
      activeFilePath: null,
    });
  });

  test("workspace+file restore stays in workspace chrome and opens the file as a tab", async () => {
    mockedInvoke.mockResolvedValue({ path: "/ws/a.md", content: "a", modified_at: 1 });

    await useWorkspaceStore.getState().restoreFromBundle({
      workspace: { root: "/ws", name: "ws", file_count: 1 },
      entries: [],
      recent_workspaces: ["/ws"],
      session: null,
      active_file: null,
      open_file: "/ws/a.md",
    });

    expect(useWorkspaceStore.getState().chromeMode).toBe("workspace");
    expect(useWorkspaceStore.getState().root).toBe("/ws");
    await vi.waitFor(() => {
      expect(tabPaths()).toEqual(["/ws/a.md"]);
    });
  });
});

describe("handleOpenPayload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceStore.setState({
      root: "/ws",
      chromeMode: "workspace",
      directoryCache: new Map(),
      expandedDirs: new Set(),
      pinnedFiles: [],
      sidebarMetadataVersion: 0,
      recentWorkspaces: [],
      fileCount: 0,
    });
    useEditorStore.setState({
      openFiles: new Map(),
      tabs: [],
      activeTabId: null,
      activeFilePath: null,
    });
  });

  test("same-workspace file payload keeps normal workspace chrome", async () => {
    mockedInvoke.mockResolvedValue({ path: "/ws/a.md", content: "a", modified_at: 1 });

    await handleOpenPayload({ workspace: "/ws", file: "/ws/a.md" });

    expect(useWorkspaceStore.getState().chromeMode).toBe("workspace");
    expect(tabPaths()).toEqual(["/ws/a.md"]);
  });

  test("file-only payload on a workspace window opens a standalone window", async () => {
    mockedInvoke.mockResolvedValue(undefined);

    await handleOpenPayload({ workspace: null, file: "/anywhere/note.md" });

    expect(mockedInvoke).toHaveBeenCalledWith("open_file_in_standalone_window", {
      path: "/anywhere/note.md",
    });
    expect(useWorkspaceStore.getState().chromeMode).toBe("workspace");
    expect(tabPaths()).toEqual([]);
  });

  test("file-only payload on a rootless window enters compact mode and watches the file", async () => {
    mockedInvoke.mockImplementation((command: string) =>
      Promise.resolve(
        command === "read_file"
          ? { path: "/anywhere/note.md", content: "n", modified_at: 1 }
          : undefined,
      ),
    );
    useWorkspaceStore.setState({ root: null });

    await handleOpenPayload({ workspace: null, file: "/anywhere/note.md" });

    expect(useWorkspaceStore.getState().chromeMode).toBe("compact-file");
    expect(tabPaths()).toEqual(["/anywhere/note.md"]);
    expect(mockedInvoke).toHaveBeenCalledWith("watch_standalone_file", {
      path: "/anywhere/note.md",
    });
  });

  test("navigating to a linked file in a compact window re-points the watcher", async () => {
    mockedInvoke.mockImplementation((command, args) =>
      Promise.resolve(
        command === "read_file"
          ? { path: (args as { path?: string })?.path, content: "n", modified_at: 1 }
          : undefined,
      ),
    );
    useWorkspaceStore.setState({ root: null });

    // Open the first standalone file, then follow an internal link to another.
    await handleOpenPayload({ workspace: null, file: "/anywhere/a.md" });
    await useEditorStore.getState().navigateToFile("/anywhere/b.md");

    expect(useWorkspaceStore.getState().chromeMode).toBe("compact-file");
    expect(tabPaths()).toEqual(["/anywhere/b.md"]);
    expect(mockedInvoke).toHaveBeenCalledWith("watch_standalone_file", {
      path: "/anywhere/b.md",
    });
  });

  test("folder payload on a standalone compact window opens a new workspace window", async () => {
    mockedInvoke.mockResolvedValue(undefined);
    useWorkspaceStore.setState({ root: null, chromeMode: "compact-file" });

    await handleOpenPayload({ workspace: "/other", file: null });

    expect(mockedInvoke).toHaveBeenCalledWith("open_workspace_in_new_window", {
      path: "/other",
      file: null,
    });
    expect(useWorkspaceStore.getState().chromeMode).toBe("compact-file");
    expect(useWorkspaceStore.getState().root).toBeNull();
  });

  test("different workspace payload delegates to a new window", async () => {
    mockedInvoke.mockResolvedValue(undefined);

    await handleOpenPayload({ workspace: "/other", file: "/other/a.md" });

    expect(mockedInvoke).toHaveBeenCalledWith("open_workspace_in_new_window", {
      path: "/other",
      file: "/other/a.md",
    });
    expect(useWorkspaceStore.getState().root).toBe("/ws");
  });
});

describe("createPendingOpenDrainer", () => {
  test("drains queued payloads in order", async () => {
    const queue = [
      { workspace: "/a", file: null },
      { workspace: "/b", file: "/b/note.md" },
    ];
    const handled: Array<{ workspace: string; file: string | null }> = [];
    const drainPendingOpens = createPendingOpenDrainer(
      async () => queue.shift() ?? null,
      async (payload) => {
        handled.push(payload);
      },
    );

    await drainPendingOpens();

    expect(handled).toEqual([
      { workspace: "/a", file: null },
      { workspace: "/b", file: "/b/note.md" },
    ]);
  });

  test("re-runs when another drain is requested mid-flight", async () => {
    type TestPayload = { workspace: string; file: null };

    const queue = [{ workspace: "/a", file: null }];
    const handled: string[] = [];
    let nextPollStarted: (() => void) | null = null;
    let blockOnEmpty = true;
    const nextPollResponse = createDeferred<TestPayload | null>();

    const takePendingOpen = vi.fn(async () => {
      if (queue.length > 0) {
        return queue.shift() ?? null;
      }

      if (!blockOnEmpty) {
        return null;
      }

      blockOnEmpty = false;

      nextPollStarted?.();

      return await nextPollResponse.promise;
    });

    const nextPoll = new Promise<void>((resolve) => {
      nextPollStarted = resolve;
    });

    let drainPendingOpens!: () => Promise<void>;
    drainPendingOpens = createPendingOpenDrainer(takePendingOpen, async (payload) => {
      handled.push(payload.workspace);
    });

    const firstDrain = drainPendingOpens();
    await nextPoll;

    queue.push({ workspace: "/b", file: null });
    const secondDrain = drainPendingOpens();
    nextPollResponse.resolve(null);

    await firstDrain;
    await secondDrain;

    expect(handled).toEqual(["/a", "/b"]);
    expect(takePendingOpen).toHaveBeenCalledTimes(4);
  });

  test("continues draining after a failed payload", async () => {
    const queue = [
      { workspace: "/broken", file: null },
      { workspace: "/ok", file: null },
    ];
    const handled: string[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const drainPendingOpens = createPendingOpenDrainer(
      async () => queue.shift() ?? null,
      async (payload) => {
        if (payload.workspace === "/broken") {
          throw new Error("boom");
        }
        handled.push(payload.workspace);
      },
    );

    await drainPendingOpens();

    expect(handled).toEqual(["/ok"]);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe("workspace-store closeWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedInvoke.mockResolvedValue(undefined);
    useWorkspaceStore.setState({
      root: "/test",
      chromeMode: "workspace",
      isIndexing: true,
      directoryCache: new Map([["/test", []]]),
      expandedDirs: new Set(["/test/dir"]),
      recentWorkspaces: ["/test"],
    });
    useEditorStore.setState({
      openFiles: new Map([
        [
          "/test/a.md",
          {
            path: "/test/a.md",
            frontmatter: null,
            content: "a",
            title: "",
            titleSource: "none",
            diskContent: "a",
            isDirty: false,
            isLoading: false,
            saveError: null,
            reloadVersion: 0,
            displayDate: null,
            stats: { words: 0, characters: 0, paragraphs: 0 },
          },
        ],
      ]),
      tabs: [makeFileTab("tab-a", "/test/a.md")],
      activeTabId: "tab-a",
      activeFilePath: "/test/a.md",
    });
  });

  test("closeWorkspace invalidates the backend before resetting workspace and editor state", async () => {
    const close = createDeferred<unknown>();
    mockedInvoke.mockImplementation((command: string) =>
      command === "close_workspace" ? close.promise : Promise.resolve(null),
    );
    const closing = useWorkspaceStore.getState().closeWorkspace();

    expect(mockedInvoke).toHaveBeenCalledWith("close_workspace", { root: "/test" });
    expect(useWorkspaceStore.getState().root).toBe("/test");

    close.resolve(null);
    await closing;

    const ws = useWorkspaceStore.getState();
    expect(ws.root).toBeNull();
    expect(ws.directoryCache.size).toBe(0);
    expect(ws.expandedDirs.size).toBe(0);
    expect(ws.isIndexing).toBe(false);

    const ed = useEditorStore.getState();
    expect(ed.openFiles.size).toBe(0);
    expect(ed.activeFilePath).toBeNull();
    expect(ed.tabs).toEqual([]);
  });

  test("closeWorkspace is no-op when no workspace is open", async () => {
    useWorkspaceStore.setState({ root: null });
    await useWorkspaceStore.getState().closeWorkspace();
    expect(useWorkspaceStore.getState().root).toBeNull();
    expect(mockedInvoke).not.toHaveBeenCalledWith("close_workspace", expect.anything());
  });
});

describe("editor-store layout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useEditorStore.setState({
      openFiles: new Map(),
      tabs: [],
      layout: createLayout(),
      activeTabId: null,
      activeFilePath: null,
    });
    useWorkspaceStore.setState({ chromeMode: "workspace" });
  });

  /** Move `tabId` into a new pane beside the current one, and focus it. */
  function splitOff(tabId: string) {
    const { layout } = useEditorStore.getState();
    useEditorStore.setState({
      layout: splitPaneWithTab(layout, layout.focusedPaneId, "x", "after", tabId),
    });
  }

  test("starts as one focused pane that owns every open tab", async () => {
    mockedInvoke.mockResolvedValue({ path: "/a.md", content: "a", modified_at: 1 });
    await useEditorStore.getState().openFile("/a.md");
    useEditorStore.getState().openNewTab();

    const { layout, tabs } = useEditorStore.getState();
    expect(panes(layout)).toHaveLength(1);
    expect(layoutTabIds(layout)).toEqual(tabs.map((tab) => tab.id));
    expect(validateLayout(layout)).toEqual([]);
  });

  test("derives activeTabId and activeFilePath from the focused pane", async () => {
    mockedInvoke.mockResolvedValue({ path: "/a.md", content: "a", modified_at: 1 });
    await useEditorStore.getState().openFile("/a.md");
    await useEditorStore.getState().openFileInNewTab("/b.md");

    const [first, second] = useEditorStore.getState().tabs;
    splitOff(second!.id);

    const [left, right] = panes(useEditorStore.getState().layout);
    useEditorStore.getState().setFocusedPane(left!.id);
    expect(useEditorStore.getState().activeTabId).toBe(first!.id);

    useEditorStore.getState().setFocusedPane(right!.id);
    expect(useEditorStore.getState().activeTabId).toBe(second!.id);
    expect(useEditorStore.getState().activeFilePath).toBe("/b.md");
  });

  test("opens into the focused pane instead of appending to one global strip", async () => {
    mockedInvoke.mockResolvedValue({ path: "/a.md", content: "a", modified_at: 1 });
    await useEditorStore.getState().openFile("/a.md");
    await useEditorStore.getState().openFileInNewTab("/b.md");
    const [, second] = useEditorStore.getState().tabs;
    splitOff(second!.id);

    const right = panes(useEditorStore.getState().layout)[1]!;
    useEditorStore.getState().setFocusedPane(right.id);
    await useEditorStore.getState().openFileInNewTab("/c.md");

    const [leftPane, rightPane] = panes(useEditorStore.getState().layout);
    expect(leftPane!.tabIds).toHaveLength(1);
    expect(rightPane!.tabIds).toHaveLength(2);
    expect(useEditorStore.getState().activeFilePath).toBe("/c.md");
  });

  test("closing a pane's last tab collapses the pane and moves focus in one update", async () => {
    mockedInvoke.mockResolvedValue({ path: "/a.md", content: "a", modified_at: 1 });
    await useEditorStore.getState().openFile("/a.md");
    await useEditorStore.getState().openFileInNewTab("/b.md");
    const [first, second] = useEditorStore.getState().tabs;
    splitOff(second!.id);

    let notifications = 0;
    const unsubscribe = useEditorStore.subscribe(() => {
      notifications += 1;
    });
    useEditorStore.getState().closeTab(second!.id);
    unsubscribe();

    const state = useEditorStore.getState();
    expect(notifications).toBe(1);
    expect(panes(state.layout)).toHaveLength(1);
    expect(state.activeTabId).toBe(first!.id);
    expect(validateLayout(state.layout)).toEqual([]);
  });

  test("deleting a file removes its tabs from their panes and collapses what empties", async () => {
    mockedInvoke.mockResolvedValue({ path: "/a.md", content: "a", modified_at: 1 });
    await useEditorStore.getState().openFile("/a.md");
    await useEditorStore.getState().openFileInNewTab("/b.md");
    const [, second] = useEditorStore.getState().tabs;
    splitOff(second!.id);

    useEditorStore.getState().removePathReferences("/b.md");

    const state = useEditorStore.getState();
    expect(panes(state.layout)).toHaveLength(1);
    expect(layoutTabIds(state.layout)).toEqual(state.tabs.map((tab) => tab.id));
    expect(validateLayout(state.layout)).toEqual([]);
  });

  test("renaming a path keeps every tab in the pane that owned it", async () => {
    mockedInvoke.mockResolvedValue({ path: "/dir/a.md", content: "a", modified_at: 1 });
    await useEditorStore.getState().openFile("/dir/a.md");
    await useEditorStore.getState().openFileInNewTab("/dir/b.md");
    const [, second] = useEditorStore.getState().tabs;
    splitOff(second!.id);
    const before = panes(useEditorStore.getState().layout).map((pane) => pane.tabIds);

    useEditorStore.getState().rewritePathPrefix("/dir", "/moved");

    const state = useEditorStore.getState();
    expect(panes(state.layout).map((pane) => pane.tabIds)).toEqual(before);
    expect(tabPaths()).toEqual(["/moved/a.md", "/moved/b.md"]);
  });

  test("a compact-window open resets the layout to a single pane", async () => {
    mockedInvoke.mockResolvedValue({ path: "/a.md", content: "a", modified_at: 1 });
    await useEditorStore.getState().openFile("/a.md");
    await useEditorStore.getState().openFileInNewTab("/b.md");
    const [, second] = useEditorStore.getState().tabs;
    splitOff(second!.id);

    mockedInvoke.mockResolvedValue({ path: "/c.md", content: "c", modified_at: 1 });
    await useEditorStore.getState().openCompactFile("/c.md");

    const state = useEditorStore.getState();
    expect(panes(state.layout)).toHaveLength(1);
    expect(state.tabs).toHaveLength(1);
    expect(layoutTabIds(state.layout)).toEqual([state.tabs[0]!.id]);
    expect(validateLayout(state.layout)).toEqual([]);
  });

  test("an open that resolves after the layout was replaced does not resurrect its pane", async () => {
    const deferred = createDeferred<{ path: string; content: string; modified_at: number }>();
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "read_file") return deferred.promise;
      return null;
    });

    const pending = useEditorStore.getState().openFile("/slow.md");
    mockedInvoke.mockResolvedValue({ path: "/fast.md", content: "fast", modified_at: 1 });
    await useEditorStore.getState().openCompactFile("/fast.md");

    deferred.resolve({ path: "/slow.md", content: "slow", modified_at: 1 });
    await pending.catch(() => {});

    const state = useEditorStore.getState();
    expect(tabPaths()).toEqual(["/fast.md"]);
    expect(layoutTabIds(state.layout)).toEqual(state.tabs.map((tab) => tab.id));
    expect(validateLayout(state.layout)).toEqual([]);
  });

  test("editing a document does not bump the layout revision", async () => {
    mockedInvoke.mockResolvedValue({ path: "/a.md", content: "a", modified_at: 1 });
    await useEditorStore.getState().openFile("/a.md");

    const before = useEditorStore.getState().layout;
    useEditorStore.getState().updateContent("/a.md", "a changed");
    useEditorStore.getState().updateFrontmatter("/a.md", "title: x");

    const after = useEditorStore.getState().layout;
    expect(after.revision).toBe(before.revision);
    expect(after).toBe(before);
  });
});

describe("editor-store sidebar drops", () => {
  const area: Rect = { x: 0, y: 0, width: 1000, height: 600 };

  beforeEach(() => {
    vi.clearAllMocks();
    useEditorStore.setState({
      openFiles: new Map(),
      tabs: [],
      layout: createLayout(),
      activeTabId: null,
      activeFilePath: null,
    });
    useWorkspaceStore.setState({ chromeMode: "workspace" });
  });

  /** What the drag coordinator hands the store: the candidate resolved from
   *  the live layout plus the tabs it minted for the dropped paths. */
  function planDrop(paths: string[], region: DropRegion) {
    const { layout, tabs } = useEditorStore.getState();
    const pane = findPane(layout, layout.focusedPaneId)!;
    const newTabs = paths.map((path) => createFileTab(path));
    const items = newTabs.map((tab, index) => {
      const path = paths[index]!;
      const existing =
        region === "center"
          ? (tabs.find(
              (candidate) =>
                pane.tabIds.includes(candidate.id) &&
                candidate.location.kind === "file" &&
                candidate.location.path === path,
            ) ?? null)
          : null;
      return { tabId: tab.id, existingTabId: existing?.id ?? null };
    });
    const candidate = buildFileDropCandidate(layout, pane.id, region, area, items)!;
    return {
      candidate,
      newTabs: newTabs.filter((_, index) => items[index]!.existingTabId === null),
    };
  }

  function readAll() {
    mockedInvoke.mockImplementation(async (cmd: string, args: unknown) => {
      if (cmd !== "read_file") return null;
      const { path } = args as { path: string };
      return { path, content: `body of ${path}`, modified_at: 1 };
    });
  }

  test("a centre drop opens the selection in order, activates its first file, and moves nothing on disk", async () => {
    readAll();
    await useEditorStore.getState().openFile("/a.md");

    const outcome = await useEditorStore
      .getState()
      .openFilesFromDrop(planDrop(["/b.md", "/c.md"], "center"));

    expect(outcome).toEqual({ status: "committed" });
    const state = useEditorStore.getState();
    expect(panes(state.layout)).toHaveLength(1);
    expect(tabPaths()).toEqual(["/a.md", "/b.md", "/c.md"]);
    expect(state.activeFilePath).toBe("/b.md");
    expect(state.openFiles.get("/c.md")?.content).toBe("body of /c.md");
    expect(mockedInvoke.mock.calls.map(([cmd]) => cmd)).not.toContain("rename_entry");
    expect(validateLayout(state.layout)).toEqual([]);
  });

  test("an edge drop creates an equal split, focuses the new pane, and activates the first file", async () => {
    readAll();
    await useEditorStore.getState().openFile("/a.md");
    const before = useEditorStore.getState().layout;

    const drop = planDrop(["/b.md", "/c.md"], "right");
    const outcome = await useEditorStore.getState().openFilesFromDrop(drop);

    expect(outcome).toEqual({ status: "committed" });
    const state = useEditorStore.getState();
    const [left, right] = panes(state.layout);
    expect(state.layout.root.kind).toBe("split");
    expect(state.layout.root.kind === "split" && state.layout.root.ratio).toBe(0.5);
    expect(left!.tabIds).toHaveLength(1);
    expect(right!.tabIds).toEqual(drop.newTabs.map((tab) => tab.id));
    expect(state.layout.focusedPaneId).toBe(right!.id);
    expect(state.activeFilePath).toBe("/b.md");
    expect(state.layout.revision).toBe(before.revision + 1);
    expect(validateLayout(state.layout)).toEqual([]);
  });

  test("a centre drop of an already-open file focuses that tab instead of duplicating it", async () => {
    readAll();
    await useEditorStore.getState().openFile("/a.md");
    await useEditorStore.getState().openFileInNewTab("/z.md");
    const aTab = useEditorStore.getState().tabs[0]!;

    const drop = planDrop(["/a.md", "/b.md"], "center");
    expect(drop.newTabs).toHaveLength(1);
    await useEditorStore.getState().openFilesFromDrop(drop);

    const state = useEditorStore.getState();
    expect(tabPaths()).toEqual(["/a.md", "/z.md", "/b.md"]);
    expect(state.activeTabId).toBe(aTab.id);
  });

  test("an edge drop of an already-open file deliberately opens a second view", async () => {
    readAll();
    await useEditorStore.getState().openFile("/a.md");

    await useEditorStore.getState().openFilesFromDrop(planDrop(["/a.md"], "bottom"));

    const state = useEditorStore.getState();
    expect(tabPaths()).toEqual(["/a.md", "/a.md"]);
    expect(panes(state.layout)).toHaveLength(2);
    expect(state.openFiles.size).toBe(1);
  });

  test("a failed read leaves the layout untouched and prunes whatever did load", async () => {
    readAll();
    await useEditorStore.getState().openFile("/a.md");
    const before = useEditorStore.getState().layout;
    mockedInvoke.mockImplementation(async (cmd: string, args: unknown) => {
      if (cmd !== "read_file") return null;
      const { path } = args as { path: string };
      if (path === "/missing.md") throw new Error("ENOENT");
      return { path, content: `body of ${path}`, modified_at: 1 };
    });

    const outcome = await useEditorStore
      .getState()
      .openFilesFromDrop(planDrop(["/b.md", "/missing.md"], "right"));

    expect(outcome.status).toBe("failed");
    expect(outcome.status === "failed" && outcome.errors.map((e) => e.path)).toEqual([
      "/missing.md",
    ]);
    const state = useEditorStore.getState();
    expect(state.layout).toBe(before);
    expect(tabPaths()).toEqual(["/a.md"]);
    expect(state.openFiles.has("/b.md")).toBe(false);
    expect(state.openFiles.has("/missing.md")).toBe(false);
  });

  test("a candidate whose layout revision went stale during preflight is discarded", async () => {
    readAll();
    await useEditorStore.getState().openFile("/a.md");
    const drop = planDrop(["/b.md"], "right");

    const read = createDeferred<{ path: string; content: string; modified_at: number }>();
    mockedInvoke.mockImplementation(async (cmd: string) =>
      cmd === "read_file" ? read.promise : null,
    );
    const pending = useEditorStore.getState().openFilesFromDrop(drop);
    // The user opens something else while the read is in flight.
    useEditorStore.getState().openNewTab();
    read.resolve({ path: "/b.md", content: "b", modified_at: 1 });

    expect(await pending).toEqual({ status: "stale" });
    const state = useEditorStore.getState();
    expect(panes(state.layout)).toHaveLength(1);
    expect(tabPaths()).toEqual(["/a.md"]);
    expect(state.openFiles.has("/b.md")).toBe(false);
  });

  test("a workspace change during preflight discards the drop", async () => {
    readAll();
    await useEditorStore.getState().openFile("/a.md");
    const drop = planDrop(["/b.md"], "right");

    let current = true;
    const pending = useEditorStore.getState().openFilesFromDrop(drop, () => current);
    current = false;

    expect(await pending).toEqual({ status: "stale" });
    expect(panes(useEditorStore.getState().layout)).toHaveLength(1);
    expect(tabPaths()).toEqual(["/a.md"]);
  });

  test("a committed split keeps every new tab in the pane the candidate put it in", async () => {
    readAll();
    await useEditorStore.getState().openFile("/a.md");
    const drop = planDrop(["/b.md"], "left");
    await useEditorStore.getState().openFilesFromDrop(drop);

    const state = useEditorStore.getState();
    const created = paneOfTab(state.layout, drop.newTabs[0]!.id)!;
    expect(panes(state.layout)[0]!.id).toBe(created.id);
    expect(layoutTabIds(state.layout)).toEqual(state.tabs.map((tab) => tab.id));
  });
});

describe("editor-store tab drops", () => {
  const area: Rect = { x: 0, y: 0, width: 1000, height: 600 };

  beforeEach(() => {
    vi.clearAllMocks();
    useEditorStore.setState({
      openFiles: new Map(),
      tabs: [],
      layout: createLayout(),
      activeTabId: null,
      activeFilePath: null,
    });
    useWorkspaceStore.setState({ chromeMode: "workspace" });
    mockedInvoke.mockImplementation(async (cmd: string, args: unknown) => {
      if (cmd !== "read_file") return null;
      const { path } = args as { path: string };
      return { path, content: `body of ${path}`, modified_at: 1 };
    });
  });

  /** Open a.md and b.md as two panes: [a] | [b], with b focused. */
  async function twoPanes() {
    await useEditorStore.getState().openFile("/a.md");
    await useEditorStore.getState().openFileInNewTab("/b.md");
    const [a, b] = useEditorStore.getState().tabs;
    const { layout } = useEditorStore.getState();
    useEditorStore.setState({
      layout: splitPaneWithTab(layout, layout.focusedPaneId, "x", "after", b!.id),
    });
    const [left, right] = panes(useEditorStore.getState().layout);
    return { a: a!, b: b!, left: left!, right: right! };
  }

  function plan(tabId: string, target: TabDropTarget, duplicateTabId: string | null = null) {
    return buildTabDropCandidate(
      useEditorStore.getState().layout,
      tabId,
      target,
      area,
      duplicateTabId,
    )!;
  }

  test("a strip move keeps the tab's id, history, dirty content, and view state, and saves nothing", async () => {
    const { a, b, right } = await twoPanes();
    useEditorStore.getState().updateContent("/a.md", "edited");
    setTabCursor(a.id, "/a.md", 3);
    useEditorStore.setState((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === a.id ? { ...tab, back: [{ kind: "file", path: "/old.md" }] } : tab,
      ),
    }));
    const before = useEditorStore.getState();
    const calls = mockedInvoke.mock.calls.length;

    const committed = useEditorStore
      .getState()
      .moveTabFromDrop(plan(a.id, { paneId: right.id, insertionIndex: 1, previewRect: area }));

    expect(committed).toBe(true);
    const state = useEditorStore.getState();
    expect(panes(state.layout)).toHaveLength(1);
    expect(panes(state.layout)[0]!.tabIds).toEqual([b.id, a.id]);
    const moved = state.tabs.find((tab) => tab.id === a.id)!;
    expect(moved.back).toEqual([{ kind: "file", path: "/old.md" }]);
    expect(state.openFiles.get("/a.md")).toBe(before.openFiles.get("/a.md"));
    expect(state.openFiles.get("/a.md")!.isDirty).toBe(true);
    expect(getTabViewState(a.id, "/a.md").cursor).toBe(3);
    expect(state.activeTabId).toBe(a.id);
    expect(mockedInvoke.mock.calls.length).toBe(calls);
    expect(validateLayout(state.layout)).toEqual([]);
  });

  test("an edge drop of a pane's last tab collapses the source and focuses the new pane", async () => {
    const { b, left } = await twoPanes();
    const candidate = plan(b.id, { paneId: left.id, region: "bottom" });

    expect(useEditorStore.getState().moveTabFromDrop(candidate)).toBe(true);

    const state = useEditorStore.getState();
    const [top, bottom] = panes(state.layout);
    expect(state.layout.root.kind === "split" && state.layout.root.axis).toBe("y");
    expect(top!.id).toBe(left.id);
    expect(bottom!.tabIds).toEqual([b.id]);
    expect(state.layout.focusedPaneId).toBe(bottom!.id);
    expect(state.layout).toBe(candidate.layout);
  });

  test("a centre move onto a pane already showing the document drops that pane's tab without closing the file", async () => {
    const { a, left, right } = await twoPanes();
    useEditorStore.getState().setFocusedPane(right.id);
    await useEditorStore.getState().openFileInNewTab("/a.md");
    const duplicate = useEditorStore.getState().tabs.at(-1)!;
    setTabCursor(duplicate.id, "/a.md", 9);
    setTabCursor(a.id, "/a.md", 2);
    useEditorStore.getState().updateContent("/a.md", "edited");

    useEditorStore
      .getState()
      .moveTabFromDrop(plan(a.id, { paneId: right.id, region: "center" }, duplicate.id));

    const state = useEditorStore.getState();
    expect(state.tabs.map((tab) => tab.id)).not.toContain(duplicate.id);
    expect(state.tabs.map((tab) => tab.id)).toContain(a.id);
    expect(findPane(state.layout, left.id)).toBeNull();
    expect(state.openFiles.get("/a.md")!.isDirty).toBe(true);
    expect(getTabViewState(a.id, "/a.md").cursor).toBe(2);
    // The dropped duplicate is gone for good, so its view state is too.
    expect(getTabViewState(duplicate.id, "/a.md").cursor).toBe(0);
  });

  test("a candidate resolved against an older layout revision is refused", async () => {
    const { a, right } = await twoPanes();
    const candidate = plan(a.id, { paneId: right.id, region: "center" });
    useEditorStore.getState().openNewTab();
    const before = useEditorStore.getState();

    expect(useEditorStore.getState().moveTabFromDrop(candidate)).toBe(false);
    expect(useEditorStore.getState().layout).toBe(before.layout);
    expect(useEditorStore.getState().tabs).toBe(before.tabs);
  });

  test("a candidate whose tab was closed meanwhile is refused", async () => {
    const { a, right } = await twoPanes();
    const candidate = plan(a.id, { paneId: right.id, region: "center" });
    useEditorStore.getState().closeTab(a.id);
    const before = useEditorStore.getState();

    expect(useEditorStore.getState().moveTabFromDrop(candidate)).toBe(false);
    expect(useEditorStore.getState().layout).toBe(before.layout);
  });
});

describe("editor-store pane routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useEditorStore.setState({
      openFiles: new Map(),
      tabs: [],
      layout: createLayout(),
      activeTabId: null,
      activeFilePath: null,
    });
    useWorkspaceStore.setState({ chromeMode: "workspace" });
  });

  /** Open a.md and b.md as two panes: [a] | [b], with b focused. */
  async function twoPanes() {
    mockedInvoke.mockImplementation(async (_cmd: string, args: unknown) => {
      const path = (args as { path: string }).path;
      return { path, content: path, modified_at: 1 };
    });
    await useEditorStore.getState().openFile("/a.md");
    await useEditorStore.getState().openFileInNewTab("/b.md");
    const [a, b] = useEditorStore.getState().tabs;
    const { layout } = useEditorStore.getState();
    useEditorStore.setState({
      layout: splitPaneWithTab(layout, layout.focusedPaneId, "x", "after", b!.id),
    });
    const [left, right] = panes(useEditorStore.getState().layout);
    return { a: a!, b: b!, left: left!, right: right! };
  }

  function deferRead(path: string) {
    const read = createDeferred<{ path: string; content: string; modified_at: number }>();
    mockedInvoke.mockImplementation(async (_cmd: string, args: unknown) => {
      const requested = (args as { path: string }).path;
      if (requested === path) return read.promise;
      return { path: requested, content: requested, modified_at: 1 };
    });
    return read;
  }

  test("an explicit pane target overrides focus for openFile", async () => {
    const { a, left, right } = await twoPanes();
    expect(useEditorStore.getState().layout.focusedPaneId).toBe(right.id);

    await useEditorStore.getState().openFile("/c.md", { paneId: left.id });

    const state = useEditorStore.getState();
    // The left pane's active file tab navigated in place, as the existing
    // replace policy says; the right pane was not touched.
    expect(findPane(state.layout, left.id)!.tabIds).toEqual([a.id]);
    expect(state.tabs.find((tab) => tab.id === a.id)!.location).toEqual({
      kind: "file",
      path: "/c.md",
    });
    expect(findPane(state.layout, right.id)!.tabIds).toHaveLength(1);
  });

  test("an explicit tab target navigates that tab even after focus moved on", async () => {
    const { a, b, left, right } = await twoPanes();
    useEditorStore.getState().setFocusedPane(left.id);
    const read = deferRead("/c.md");

    const pending = useEditorStore.getState().navigateToFile("/c.md", { tabId: b.id });
    // Focus changes while the read is in flight: the completion still belongs
    // to the tab it was aimed at.
    useEditorStore.getState().setFocusedPane(left.id);
    read.resolve({ path: "/c.md", content: "c", modified_at: 1 });
    await pending;

    const state = useEditorStore.getState();
    const tabB = state.tabs.find((tab) => tab.id === b.id)!;
    expect(tabB.location).toEqual({ kind: "file", path: "/c.md" });
    expect(tabB.back).toEqual([{ kind: "file", path: "/b.md" }]);
    expect(state.tabs.find((tab) => tab.id === a.id)!.location).toEqual({
      kind: "file",
      path: "/a.md",
    });
    expect(findPane(state.layout, right.id)!.tabIds).toEqual([b.id]);
  });

  test("openFileInNewTab lands in the captured pane, not the pane focused at completion", async () => {
    const { left, right } = await twoPanes();
    const read = deferRead("/c.md");

    const pending = useEditorStore.getState().openFileInNewTab("/c.md", { paneId: left.id });
    useEditorStore.getState().setFocusedPane(right.id);
    read.resolve({ path: "/c.md", content: "c", modified_at: 1 });
    await pending;

    const state = useEditorStore.getState();
    expect(findPane(state.layout, left.id)!.tabIds).toHaveLength(2);
    expect(findPane(state.layout, right.id)!.tabIds).toHaveLength(1);
  });

  test("a target pane that closed during the read drops the open instead of landing elsewhere", async () => {
    const { b, left, right } = await twoPanes();
    // Only a launcher in the right pane, so openFile takes the create-a-tab path.
    useEditorStore.getState().closeTab(b.id);
    expect(findPane(useEditorStore.getState().layout, right.id)).toBeNull();
    useEditorStore.getState().openNewTab();
    const launcherPane = paneOfTab(
      useEditorStore.getState().layout,
      useEditorStore.getState().activeTabId!,
    )!;
    expect(launcherPane.id).toBe(left.id);

    // Split the launcher off so the target pane is a pane of its own.
    const launcherId = useEditorStore.getState().activeTabId!;
    const layout = useEditorStore.getState().layout;
    useEditorStore.setState({
      layout: splitPaneWithTab(layout, left.id, "x", "after", launcherId),
    });
    const target = paneOfTab(useEditorStore.getState().layout, launcherId)!;
    useEditorStore.getState().closeTab(launcherId);
    useEditorStore.getState().setFocusedPane(left.id);
    const before = useEditorStore.getState().tabs.length;

    await useEditorStore.getState().openFile("/c.md", { paneId: target.id });

    // The pane is gone, so the open falls back to the focused pane's policy:
    // the focused file tab navigates in place rather than a tab appearing
    // somewhere the user did not aim at.
    const state = useEditorStore.getState();
    expect(findPane(state.layout, target.id)).toBeNull();
    expect(state.tabs).toHaveLength(before);
  });

  test("a read that completes after the editor was reset does not land in the new layout", async () => {
    mockedInvoke.mockResolvedValue({ path: "/a.md", content: "a", modified_at: 1 });
    await useEditorStore.getState().openFile("/a.md");
    useEditorStore.getState().openNewTab();
    // A settings tab in front so openFile has to create a new tab.
    useEditorStore.getState().openOrFocus(
      (tab) => tab.location.kind === "settings",
      () => ({ id: "tab-settings", location: { kind: "settings" }, back: [], forward: [] }),
    );
    const read = deferRead("/c.md");

    const pending = useEditorStore.getState().openFile("/c.md");
    useEditorStore.getState().resetEditorState();
    read.resolve({ path: "/c.md", content: "c", modified_at: 1 });
    await pending;

    const state = useEditorStore.getState();
    expect(state.tabs).toEqual([]);
    expect(state.openFiles.size).toBe(0);
    expect(validateLayout(state.layout)).toEqual([]);
  });

  test("a finished divider drag commits one clamped ratio without touching tabs", async () => {
    await twoPanes();
    const before = useEditorStore.getState();
    const split = before.layout.root;
    expect(split.kind).toBe("split");
    if (split.kind !== "split") return;

    useEditorStore.getState().setSplitRatio(split.id, 0.3);
    const after = useEditorStore.getState();
    expect(after.layout.root.kind === "split" && after.layout.root.ratio).toBe(0.3);
    expect(after.layout.revision).toBe(before.layout.revision + 1);
    // Tabs and documents are untouched; only the tree moved.
    expect(after.tabs).toEqual(before.tabs);
    expect(after.openFiles).toBe(before.openFiles);

    // The same ratio again is a no-op, so nothing is persisted for it.
    useEditorStore.getState().setSplitRatio(split.id, 0.3);
    expect(useEditorStore.getState().layout).toBe(after.layout);

    // Out-of-range ratios are clamped rather than committed as-is.
    useEditorStore.getState().setSplitRatio(split.id, 1.5);
    const root = useEditorStore.getState().layout.root;
    expect(root.kind === "split" && root.ratio).toBeLessThan(1);
  });

  test("resetEditorState replaces the layout so stale pane ids cannot be reused", async () => {
    const { left } = await twoPanes();
    useEditorStore.getState().resetEditorState();

    const state = useEditorStore.getState();
    expect(findPane(state.layout, left.id)).toBeNull();
    expect(state.tabs).toEqual([]);
    expect(state.activeTabId).toBeNull();
    expect(state.activeFilePath).toBeNull();
    expect(panes(state.layout)).toHaveLength(1);
  });
});
