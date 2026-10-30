import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  gitPull: vi.fn(),
  gitPush: vi.fn(),
  saveAllNow: vi.fn(),
  saveDrawingSessions: vi.fn(),
  refreshDrawingEmbeds: vi.fn(),
  recheckOpenFiles: vi.fn(),
  showEditorNotice: vi.fn(),
  bumpSidebarMetadataVersion: vi.fn(),
  closeTab: vi.fn(),
  dirtyDrawing: false,
  workspace: { root: "/w" as string | null },
  tabs: [] as { id: string; location: { kind: string; path?: string } }[],
  openFiles: new Map<string, { path: string; conflict: unknown }>(),
}));

vi.mock("@/lib/tauri", () => ({ gitPull: mocks.gitPull, gitPush: mocks.gitPush }));
vi.mock("@/lib/save", () => ({ saveAllNow: mocks.saveAllNow }));
vi.mock("@/lib/drawing-sessions", () => ({
  saveDrawingSessions: mocks.saveDrawingSessions,
  getDrawingSession: () => ({ isDirty: () => mocks.dirtyDrawing }),
}));
vi.mock("@/lib/drawings", () => ({ isDrawingPath: (path: string) => path.endsWith(".svg") }));
vi.mock("@/lib/drawing-embed-sync", () => ({ refreshDrawingEmbeds: mocks.refreshDrawingEmbeds }));
vi.mock("@/hooks/file-sync", () => ({ recheckOpenFiles: mocks.recheckOpenFiles }));
vi.mock("@/components/editor-area/editor-notice-store", () => ({
  showEditorNotice: mocks.showEditorNotice,
}));
vi.mock("@/stores/editor-store", () => ({
  useEditorStore: {
    getState: () => ({ tabs: mocks.tabs, openFiles: mocks.openFiles, closeTab: mocks.closeTab }),
  },
}));
vi.mock("@/stores/workspace-store", () => ({
  useWorkspaceStore: {
    getState: () => ({
      root: mocks.workspace.root,
      bumpSidebarMetadataVersion: mocks.bumpSidebarMetadataVersion,
    }),
  },
}));

import { useGitStore } from "../src/stores/git-store";

const outcome = (over = {}) => ({
  ok: true,
  message: "done",
  worktreeChanged: false,
  pulled: [] as string[],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.workspace.root = "/w";
  mocks.tabs = [];
  mocks.openFiles.clear();
  mocks.dirtyDrawing = false;
  mocks.recheckOpenFiles.mockResolvedValue(undefined);
  mocks.saveAllNow.mockResolvedValue(undefined);
  mocks.saveDrawingSessions.mockResolvedValue(undefined);
  useGitStore.setState({ running: null });
});

describe("git buttons", () => {
  test("push flushes before git runs and shows the result", async () => {
    const order: string[] = [];
    mocks.saveAllNow.mockImplementation(async () => void order.push("text"));
    mocks.saveDrawingSessions.mockImplementation(async () => void order.push("drawings"));
    mocks.gitPush.mockImplementation(async () => {
      order.push("push");
      return outcome({ message: "Pushed 1 commit." });
    });

    await useGitStore.getState().push();

    expect(order).toEqual(["text", "drawings", "push"]);
    expect(mocks.showEditorNotice).toHaveBeenCalledWith("Pushed 1 commit.");
    expect(useGitStore.getState().running).toBeNull();
  });

  test("a tab with an unresolved disk conflict stops git before it runs", async () => {
    mocks.openFiles.set("/w/a.md", { path: "/w/a.md", conflict: {} });

    await useGitStore.getState().pull();

    expect(mocks.gitPull).not.toHaveBeenCalled();
    expect(mocks.showEditorNotice.mock.calls[0]![0]).toContain("a.md changed on disk");
  });

  test("a failed save stops git before it runs", async () => {
    mocks.saveAllNow.mockRejectedValue(new Error("disk full"));

    await useGitStore.getState().push();

    expect(mocks.gitPush).not.toHaveBeenCalled();
    expect(mocks.showEditorNotice).toHaveBeenCalledWith("Push stopped: disk full");
  });

  test("a pull re-checks open files only when the tree changed", async () => {
    mocks.gitPull.mockResolvedValueOnce(outcome());
    await useGitStore.getState().pull();
    expect(mocks.recheckOpenFiles).not.toHaveBeenCalled();

    mocks.gitPull.mockResolvedValueOnce(
      outcome({ worktreeChanged: true, pulled: ["/w/d.excalidraw.svg"] }),
    );
    await useGitStore.getState().pull();
    expect(mocks.recheckOpenFiles).toHaveBeenCalledTimes(1);
    expect(mocks.refreshDrawingEmbeds).toHaveBeenCalledWith("/w/d.excalidraw.svg");
  });

  test("closes a clean drawing tab the pull overtook, and warns about an edited one", async () => {
    mocks.tabs = [{ id: "t", location: { kind: "drawing", path: "/w/d.excalidraw.svg" } }];
    mocks.gitPull.mockResolvedValue(
      outcome({ worktreeChanged: true, pulled: ["/w/d.excalidraw.svg"] }),
    );

    await useGitStore.getState().pull();
    expect(mocks.closeTab).toHaveBeenCalledWith("t");

    mocks.closeTab.mockClear();
    mocks.dirtyDrawing = true;
    await useGitStore.getState().pull();
    expect(mocks.closeTab).not.toHaveBeenCalled();
    expect(mocks.showEditorNotice.mock.lastCall![0]).toContain("was edited during the pull");
  });

  test("one operation at a time", async () => {
    useGitStore.setState({ running: "pull" });
    await useGitStore.getState().push();
    expect(mocks.gitPush).not.toHaveBeenCalled();
  });
});
