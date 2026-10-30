import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  tauri: {
    gitStatus: vi.fn(),
    gitSync: vi.fn(),
    gitPull: vi.fn(),
    gitPush: vi.fn(),
    gitPublish: vi.fn(),
    gitCommit: vi.fn(),
    gitAbortMerge: vi.fn(),
    gitInit: vi.fn(),
  },
  saveAllNow: vi.fn(),
  saveDrawingSessions: vi.fn(),
  recheckOpenFiles: vi.fn(),
  refreshDrawingEmbeds: vi.fn(),
  showEditorNotice: vi.fn(),
  bumpSidebarMetadataVersion: vi.fn(),
  setSetting: vi.fn(),
  workspace: { root: "/w" as string | null },
  settings: {} as Record<string, unknown>,
  tabs: [] as { id?: string; location: { kind: string; path?: string } }[],
  closeTab: vi.fn(),
  openFiles: new Map<string, { path: string; conflict: unknown }>(),
}));

vi.mock("@/lib/tauri", () => mocks.tauri);
vi.mock("@/lib/save", () => ({ saveAllNow: mocks.saveAllNow }));
vi.mock("@/lib/drawing-sessions", () => ({
  saveDrawingSessions: mocks.saveDrawingSessions,
  getDrawingSession: () => undefined,
}));
vi.mock("@/lib/drawings", () => ({ isDrawingPath: (path: string) => path.endsWith(".svg") }));
vi.mock("@/lib/drawing-embed-sync", () => ({ refreshDrawingEmbeds: mocks.refreshDrawingEmbeds }));
vi.mock("@/hooks/file-sync", () => ({ recheckOpenFiles: mocks.recheckOpenFiles }));
vi.mock("@/components/editor-area/editor-notice-store", () => ({
  showEditorNotice: mocks.showEditorNotice,
}));
vi.mock("@/stores/workspace-store", () => ({
  useWorkspaceStore: {
    getState: () => ({
      root: mocks.workspace.root,
      bumpSidebarMetadataVersion: mocks.bumpSidebarMetadataVersion,
    }),
  },
}));
vi.mock("@/stores/editor-store", () => ({
  useEditorStore: {
    getState: () => ({ tabs: mocks.tabs, openFiles: mocks.openFiles, closeTab: mocks.closeTab }),
  },
}));
vi.mock("@/stores/settings-store", () => ({
  useSettingsStore: {
    getState: () => ({ settings: mocks.settings, setSetting: mocks.setSetting }),
  },
}));

import { useGitStore } from "../src/stores/git-store";
import { defaultCommitMessage } from "../src/lib/git";
import type { GitFile, GitOutcome, GitStatus } from "../src/lib/tauri";

function status(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    kind: "ok",
    message: null,
    repoRoot: "/w",
    branch: "main",
    upstream: "origin/main",
    hasRemote: true,
    ahead: 0,
    behind: 0,
    files: [],
    outsideChanges: 0,
    inProgress: null,
    conflicts: [],
    ...overrides,
  };
}

function outcome(overrides: Partial<GitOutcome> = {}): GitOutcome {
  return {
    ok: true,
    kind: "ok",
    message: "Done.",
    worktreeChanged: false,
    pulled: [],
    suspects: [],
    status: status(),
    ...overrides,
  };
}

const file = (path: string, letter = "M"): GitFile => ({ path, status: letter, staged: false });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.workspace.root = "/w";
  mocks.settings = {};
  mocks.tabs = [];
  mocks.openFiles = new Map();
  mocks.saveAllNow.mockResolvedValue(undefined);
  mocks.saveDrawingSessions.mockResolvedValue(undefined);
  mocks.recheckOpenFiles.mockResolvedValue(undefined);
  mocks.tauri.gitStatus.mockResolvedValue(status());
  useGitStore.setState({
    root: "/w",
    status: status(),
    running: null,
    results: {},
    panelOpen: false,
    message: "",
    excluded: [],
    confirm: null,
  });
});

describe("sync", () => {
  test("flushes every buffer before git sees the tree", async () => {
    const order: string[] = [];
    mocks.saveAllNow.mockImplementation(async () => void order.push("text"));
    mocks.saveDrawingSessions.mockImplementation(async () => void order.push("drawings"));
    mocks.tauri.gitStatus.mockImplementation(async () => {
      order.push("status");
      return status({ files: [file("a.md")] });
    });
    mocks.tauri.gitSync.mockImplementation(async () => {
      order.push("sync");
      return outcome();
    });

    await useGitStore.getState().sync();

    expect(order).toEqual(["text", "drawings", "status", "sync"]);
  });

  test("a failed flush stops before any git call and is reported", async () => {
    mocks.saveAllNow.mockRejectedValue(new Error("Failed to save /w/a.md."));

    await useGitStore.getState().sync();

    expect(mocks.tauri.gitSync).not.toHaveBeenCalled();
    expect(useGitStore.getState().running).toBeNull();
    const result = useGitStore.getState().results["/w"]!;
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Failed to save /w/a.md.");
    expect(mocks.showEditorNotice).toHaveBeenCalledWith(result.message);
  });

  test("an unresolved file conflict stops the flush and names the file", async () => {
    mocks.openFiles.set("/w/a.md", { path: "/w/a.md", conflict: { diskContent: null } });

    await useGitStore.getState().sync();

    expect(mocks.saveAllNow).not.toHaveBeenCalled();
    expect(mocks.tauri.gitSync).not.toHaveBeenCalled();
    expect(useGitStore.getState().results["/w"]!.message).toContain("a.md changed on disk");
  });

  test("uses the generated default so one click is enough", async () => {
    mocks.tauri.gitStatus.mockResolvedValue(status({ files: [file("notes/a.md")] }));
    mocks.tauri.gitSync.mockResolvedValue(outcome());
    await useGitStore.getState().sync();
    expect(mocks.tauri.gitSync).toHaveBeenCalledWith("Update a.md", []);
  });

  test("a typed message wins and is cleared by success, not by failure", async () => {
    useGitStore.getState().setMessage("  my words ");
    mocks.tauri.gitSync.mockResolvedValueOnce(outcome({ ok: false, kind: "network" }));
    await useGitStore.getState().sync();
    expect(mocks.tauri.gitSync).toHaveBeenCalledWith("my words", []);
    expect(useGitStore.getState().message).toBe("  my words ");

    mocks.tauri.gitSync.mockResolvedValueOnce(outcome());
    await useGitStore.getState().sync();
    expect(useGitStore.getState().message).toBe("");
  });

  test("open files are re-checked when git changed the tree, and only then", async () => {
    mocks.tauri.gitSync.mockResolvedValueOnce(outcome());
    await useGitStore.getState().sync();
    expect(mocks.recheckOpenFiles).not.toHaveBeenCalled();

    mocks.tauri.gitSync.mockResolvedValueOnce(
      outcome({ worktreeChanged: true, pulled: ["/w/a.md", "/w/d.excalidraw.svg"] }),
    );
    await useGitStore.getState().sync();
    expect(mocks.recheckOpenFiles).toHaveBeenCalledTimes(1);
    expect(mocks.refreshDrawingEmbeds).toHaveBeenCalledWith("/w/d.excalidraw.svg");
    expect(mocks.bumpSidebarMetadataVersion).toHaveBeenCalled();
  });

  test("a conflict still re-checks files, reports, and opens the panel", async () => {
    mocks.settings["appearance.sidebar-visible"] = false;
    const conflicted = status({ inProgress: "merge", conflicts: ["a.md"] });
    mocks.tauri.gitSync.mockResolvedValue(
      outcome({
        ok: false,
        kind: "conflict",
        message: "conflicts in a.md",
        worktreeChanged: true,
        status: conflicted,
      }),
    );

    await useGitStore.getState().sync();

    const state = useGitStore.getState();
    expect(mocks.recheckOpenFiles).toHaveBeenCalled();
    expect(state.status).toEqual(conflicted);
    expect(state.panelOpen).toBe(true);
    expect(mocks.setSetting).toHaveBeenCalledWith("appearance.sidebar-visible", true);
    expect(state.results["/w"]!.message).toBe("conflicts in a.md");
  });

  test("closes a clean drawing tab the pull overtook", async () => {
    mocks.tabs = [{ id: "t", location: { kind: "drawing", path: "/w/d.excalidraw.svg" } }];
    mocks.tauri.gitSync.mockResolvedValue(
      outcome({ worktreeChanged: true, pulled: ["/w/d.excalidraw.svg"] }),
    );
    await useGitStore.getState().sync();
    expect(useGitStore.getState().results["/w"]!.message).toContain("Closed d.excalidraw.svg");
    expect(mocks.closeTab).toHaveBeenCalledWith("t");
  });

  test("only one operation runs in a window", async () => {
    let finish!: (value: GitOutcome) => void;
    mocks.tauri.gitSync.mockImplementation(
      () => new Promise<GitOutcome>((resolve) => (finish = resolve)),
    );
    const first = useGitStore.getState().sync();
    await vi.waitFor(() => expect(mocks.tauri.gitSync).toHaveBeenCalled());

    await useGitStore.getState().pull();

    expect(mocks.tauri.gitPull).not.toHaveBeenCalled();
    expect(mocks.showEditorNotice).toHaveBeenCalledWith(expect.stringContaining("still running"));
    finish(outcome());
    await first;
    expect(useGitStore.getState().running).toBeNull();
  });

  test("a result from a workspace switched away from is filed under that workspace", async () => {
    let finish!: (value: GitOutcome) => void;
    mocks.tauri.gitSync.mockImplementation(
      () => new Promise<GitOutcome>((resolve) => (finish = resolve)),
    );
    const before = useGitStore.getState().status;
    const op = useGitStore.getState().sync();
    await vi.waitFor(() => expect(mocks.tauri.gitSync).toHaveBeenCalled());

    mocks.workspace.root = "/other";
    finish(outcome({ worktreeChanged: true, status: status({ branch: "elsewhere" }) }));
    await op;

    const state = useGitStore.getState();
    expect(state.results["/w"]).toBeDefined();
    expect(state.status).toBe(before);
    expect(mocks.recheckOpenFiles).not.toHaveBeenCalled();
  });
});

describe("credentials", () => {
  test("a warning waits for confirmation, which allows exactly the named files", async () => {
    mocks.settings["appearance.sidebar-visible"] = true;
    mocks.tauri.gitStatus.mockResolvedValue(status({ files: [file(".env", "?")] }));
    mocks.tauri.gitSync.mockResolvedValueOnce(
      outcome({ ok: false, kind: "secrets", suspects: [".env"], message: "held back" }),
    );

    await useGitStore.getState().sync();

    expect(useGitStore.getState().confirm).toEqual({
      action: "sync",
      kind: "secrets",
      suspects: [".env"],
      allowed: [],
      sides: [],
    });
    expect(useGitStore.getState().panelOpen).toBe(true);
    expect(mocks.tauri.gitSync).toHaveBeenCalledTimes(1);

    mocks.tauri.gitSync.mockResolvedValueOnce(outcome());
    await useGitStore.getState().commitSuspects();

    expect(mocks.tauri.gitSync).toHaveBeenLastCalledWith(expect.any(String), [".env"]);
    expect(useGitStore.getState().confirm).toBeNull();
  });

  test("cancelling leaves nothing pending", async () => {
    useGitStore.setState({
      confirm: { action: "sync", kind: "secrets", suspects: [".env"], allowed: [], sides: [] },
    });
    useGitStore.getState().dismissConfirm();
    await useGitStore.getState().commitSuspects();
    expect(mocks.tauri.gitSync).not.toHaveBeenCalled();
  });
});

describe("commit", () => {
  test("a credential answer survives the one-sided warning that follows it", async () => {
    mocks.tauri.gitStatus.mockResolvedValue(status({ files: [file("a.png", "U")] }));
    mocks.tauri.gitCommit
      .mockResolvedValueOnce(
        outcome({ ok: false, kind: "secrets", suspects: ["a.png"], message: "held" }),
      )
      .mockResolvedValueOnce(
        outcome({ ok: false, kind: "oneSided", suspects: ["a.png"], message: "pick" }),
      )
      .mockResolvedValueOnce(outcome());

    await useGitStore.getState().commit();
    await useGitStore.getState().commitSuspects();
    expect(mocks.tauri.gitCommit).toHaveBeenLastCalledWith(
      ["a.png"],
      expect.any(String),
      ["a.png"],
      [],
    );
    expect(useGitStore.getState().confirm?.kind).toBe("oneSided");

    await useGitStore.getState().commitSuspects();
    expect(mocks.tauri.gitCommit).toHaveBeenLastCalledWith(
      ["a.png"],
      expect.any(String),
      ["a.png"],
      ["a.png"],
    );
    expect(useGitStore.getState().confirm).toBeNull();
  });

  test("sends only the chosen files, from the state after the flush", async () => {
    mocks.tauri.gitStatus.mockResolvedValue(status({ files: [file("a.md"), file("b.md")] }));
    mocks.tauri.gitCommit.mockResolvedValue(outcome());
    useGitStore.getState().toggleFile("b.md");

    await useGitStore.getState().commit();

    expect(mocks.saveAllNow).toHaveBeenCalled();
    expect(mocks.tauri.gitCommit).toHaveBeenCalledWith(["a.md"], "Update a.md", [], []);
    expect(useGitStore.getState().excluded).toEqual([]);
  });

  test("toggling twice restores a file", () => {
    useGitStore.getState().toggleFile("a.md");
    expect(useGitStore.getState().excluded).toEqual(["a.md"]);
    useGitStore.getState().toggleFile("a.md");
    expect(useGitStore.getState().excluded).toEqual([]);
  });
});

describe("other actions", () => {
  test("abort doesn't flush a partial resolution, then re-checks open files", async () => {
    mocks.tauri.gitAbortMerge.mockResolvedValue(outcome({ worktreeChanged: true }));
    await useGitStore.getState().abortMerge();
    expect(mocks.saveAllNow).not.toHaveBeenCalled();
    expect(mocks.recheckOpenFiles).toHaveBeenCalled();
  });

  test("pull flushes; push doesn't need to", async () => {
    mocks.tauri.gitPull.mockResolvedValue(outcome());
    mocks.tauri.gitPush.mockResolvedValue(outcome());
    await useGitStore.getState().pull();
    expect(mocks.saveAllNow).toHaveBeenCalledTimes(1);
    await useGitStore.getState().push();
    expect(mocks.saveAllNow).toHaveBeenCalledTimes(1);
  });
});

describe("refresh", () => {
  test("a slow read can't overwrite the result of an operation", async () => {
    let finishRead!: (value: GitStatus) => void;
    mocks.tauri.gitStatus.mockImplementationOnce(
      () => new Promise<GitStatus>((resolve) => (finishRead = resolve)),
    );
    const read = useGitStore.getState().refresh();
    const after = status({ ahead: 5 });
    mocks.tauri.gitPull.mockResolvedValue(outcome({ status: after }));
    await useGitStore.getState().pull();

    finishRead(status({ ahead: 1 }));
    await read;

    expect(useGitStore.getState().status).toEqual(after);
  });

  test("a new workspace starts clean and failure is shown, not swallowed", async () => {
    useGitStore.setState({ message: "draft", excluded: ["a.md"] });
    mocks.workspace.root = "/other";
    mocks.tauri.gitStatus.mockRejectedValue("No workspace is open");

    await useGitStore.getState().refresh();

    const state = useGitStore.getState();
    expect(state.root).toBe("/other");
    expect(state.message).toBe("");
    expect(state.excluded).toEqual([]);
    expect(state.status?.kind).toBe("other");
    expect(state.status?.message).toContain("No workspace is open");
  });

  test("drops exclusions for files that no longer have changes", async () => {
    useGitStore.setState({ excluded: ["gone.md", "a.md"] });
    mocks.tauri.gitStatus.mockResolvedValue(status({ files: [file("a.md")] }));
    await useGitStore.getState().refresh();
    expect(useGitStore.getState().excluded).toEqual(["a.md"]);
  });
});

describe("defaultCommitMessage", () => {
  test("names the files and the kind of change", () => {
    expect(defaultCommitMessage([file("x/a.md", "?")])).toBe("Add a.md");
    expect(defaultCommitMessage([file("a.md", "D"), file("b.md", "D")])).toBe("Delete a.md, b.md");
    expect(defaultCommitMessage([file("a.md", "?"), file("b.md")])).toBe("Update a.md, b.md");
    expect(defaultCommitMessage(["1", "2", "3", "4", "5"].map((n) => file(`${n}.md`)))).toBe(
      "Update 1.md, 2.md, 3.md and 2 more",
    );
    expect(defaultCommitMessage([])).toBe("Update notes");
    expect(defaultCommitMessage([file("a.md")], true)).toBe("Merge remote changes");
  });
});
