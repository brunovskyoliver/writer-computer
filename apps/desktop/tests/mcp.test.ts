import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const { currentWindow } = vi.hoisted(() => ({
  currentWindow: {
    isMinimized: vi.fn(() => Promise.resolve(false)),
    unminimize: vi.fn(() => Promise.resolve()),
    setFocus: vi.fn(() => Promise.resolve()),
    show: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => currentWindow,
}));

const { revealPathInSidebar } = vi.hoisted(() => ({
  revealPathInSidebar: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/reveal-in-sidebar", () => ({ revealPathInSidebar }));

import { invoke } from "@tauri-apps/api/core";
import { dispatchMcpRequest, respondToMcpRequest } from "../src/lib/mcp";
import { useEditorStore, type OpenFile, type Tab } from "../src/stores/editor-store";
import { useWorkspaceStore } from "../src/stores/workspace-store";

const mockedInvoke = vi.mocked(invoke);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function fileTab(id: string, path: string): Tab {
  return { id, location: { kind: "file", path }, back: [], forward: [] };
}

function openFile(path: string, content: string, isDirty = false): OpenFile {
  return {
    path,
    frontmatter: null,
    content,
    title: "",
    titleSource: "none",
    diskContent: content,
    isDirty,
    isLoading: false,
    saveError: null,
    reloadVersion: 0,
    displayDate: null,
    stats: { words: 0, characters: 0, paragraphs: 0 },
    editSeq: 0,
  };
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

describe("dispatchMcpRequest write tools", () => {
  test("create_file creates then writes content, in order", async () => {
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "file_exists") return Promise.resolve(false);
      if (cmd === "create_file")
        return Promise.resolve({ path: "/ws/new.md", content: "# ", modified_at: 1 });
      if (cmd === "write_file") return Promise.resolve({ path: "/ws/new.md", modified_at: 2 });
      if (cmd === "read_directory") return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected command ${cmd}`));
    });

    const dispatch = await dispatchMcpRequest({
      request_id: 1,
      tool: "create_file",
      args: { path: "/ws/new.md", relative_path: "new.md", content: "# Draft\n" },
    });

    expect(dispatch).toEqual({
      ok: true,
      result: { path: "/ws/new.md", relative_path: "new.md", modified_at: 2 },
    });
    expect(mockedInvoke.mock.calls.map(([cmd]) => cmd)).toEqual([
      "file_exists",
      "create_file",
      "write_file",
      "read_directory",
    ]);
    expect(mockedInvoke).toHaveBeenCalledWith("read_directory", { path: "/ws" });
    expect(mockedInvoke).toHaveBeenCalledWith("create_file", { path: "/ws/new.md" });
    expect(mockedInvoke).toHaveBeenCalledWith("write_file", {
      path: "/ws/new.md",
      content: "# Draft\n",
    });
  });

  test("create_file on an existing path fails already_exists and writes nothing", async () => {
    mockedInvoke.mockImplementation((cmd) =>
      cmd === "file_exists"
        ? Promise.resolve(true)
        : Promise.reject(new Error(`unexpected ${cmd}`)),
    );

    const dispatch = await dispatchMcpRequest({
      request_id: 1,
      tool: "create_file",
      args: { path: "/ws/a.md", relative_path: "a.md", content: "x" },
    });

    expect(dispatch.ok).toBe(false);
    if (!dispatch.ok) expect(dispatch.error.kind).toBe("already_exists");
    expect(mockedInvoke).not.toHaveBeenCalledWith("create_file", expect.anything());
    expect(mockedInvoke).not.toHaveBeenCalledWith("write_file", expect.anything());
  });

  test("create_file maps a create-new refusal to already_exists", async () => {
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "file_exists") return Promise.resolve(false);
      if (cmd === "create_file") return Promise.reject("Already exists: /ws/a.md");
      return Promise.reject(new Error(`unexpected command ${cmd}`));
    });

    const dispatch = await dispatchMcpRequest({
      request_id: 1,
      tool: "create_file",
      args: { path: "/ws/a.md", relative_path: "a.md", content: "x" },
    });

    expect(dispatch.ok).toBe(false);
    if (!dispatch.ok) expect(dispatch.error.kind).toBe("already_exists");
  });

  test("write_file refuses a dirty open file and its text survives", async () => {
    useEditorStore.setState({
      openFiles: new Map([["/ws/a.md", openFile("/ws/a.md", "user text", true)]]),
    });

    const dispatch = await dispatchMcpRequest({
      request_id: 1,
      tool: "write_file",
      args: { path: "/ws/a.md", relative_path: "a.md", content: "agent text" },
    });

    expect(dispatch.ok).toBe(false);
    if (!dispatch.ok) expect(dispatch.error.kind).toBe("unsaved_conflict");
    expect(mockedInvoke).not.toHaveBeenCalled();
    const file = useEditorStore.getState().openFiles.get("/ws/a.md");
    expect(file?.content).toBe("user text");
    expect(file?.isDirty).toBe(true);
  });

  test("write_file calls to one path commit in admission order", async () => {
    const first = deferred<{ path: string; modified_at: number }>();
    const writes: string[] = [];
    mockedInvoke.mockImplementation((cmd, payload) => {
      if (cmd === "write_file") {
        const content = (payload as { content: string }).content;
        writes.push(content);
        return content === "first"
          ? first.promise
          : Promise.resolve({ path: "/ws/a.md", modified_at: 2 });
      }
      return Promise.reject(new Error(`unexpected command ${cmd}`));
    });

    const a = dispatchMcpRequest({
      request_id: 1,
      tool: "write_file",
      args: { path: "/ws/a.md", relative_path: "a.md", content: "first" },
    });
    const b = dispatchMcpRequest({
      request_id: 2,
      tool: "write_file",
      args: { path: "/ws/a.md", relative_path: "a.md", content: "second" },
    });
    await flushMicrotasks();
    // The second op is queued behind the first — it hasn't invoked yet.
    expect(writes).toEqual(["first"]);
    first.resolve({ path: "/ws/a.md", modified_at: 1 });
    const [dispatchA, dispatchB] = await Promise.all([a, b]);
    expect(dispatchA.ok && dispatchB.ok).toBe(true);
    expect(writes).toEqual(["first", "second"]);
  });

  test("write_file reports unsaved_conflict when a save lands mid-write and restores the user's text", async () => {
    vi.useFakeTimers();
    try {
      useEditorStore.setState({
        openFiles: new Map([["/ws/a.md", openFile("/ws/a.md", "old", false)]]),
      });
      const agentWrite = deferred<{ path: string; modified_at: number }>();
      const writes: string[] = [];
      mockedInvoke.mockImplementation((cmd, payload) => {
        if (cmd === "write_file") {
          const content = (payload as { content: string }).content;
          writes.push(content);
          return content === "agent"
            ? agentWrite.promise
            : Promise.resolve({ path: "/ws/a.md", modified_at: 4 });
        }
        return Promise.reject(new Error(`unexpected command ${cmd}`));
      });

      const dispatchPromise = dispatchMcpRequest({
        request_id: 1,
        tool: "write_file",
        args: { path: "/ws/a.md", relative_path: "a.md", content: "agent" },
      });
      await flushMicrotasks(); // the agent's write_file invoke is in flight

      // The user types while the agent's write is in flight; their autosave
      // lands before it resolves.
      useEditorStore.getState().updateContent("/ws/a.md", "user");
      await flushMicrotasks();
      agentWrite.resolve({ path: "/ws/a.md", modified_at: 4 });
      const dispatch = await dispatchPromise;

      expect(dispatch.ok).toBe(false);
      if (!dispatch.ok) expect(dispatch.error.kind).toBe("unsaved_conflict");

      // The re-dirtied tab's queued autosave restores the user's text to disk.
      await vi.runOnlyPendingTimersAsync();
      const file = useEditorStore.getState().openFiles.get("/ws/a.md");
      expect(file?.content).toBe("user");
      expect(file?.diskContent).toBe("user");
      expect(file?.isDirty).toBe(false);
      expect(writes).toEqual(["agent", "user", "user"]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("write_file reports unsaved_conflict when an unsaved edit lands mid-write", async () => {
    useEditorStore.setState({
      openFiles: new Map([["/ws/a.md", openFile("/ws/a.md", "old", false)]]),
    });
    const agentWrite = deferred<{ path: string; modified_at: number }>();
    const userSave = deferred<{ path: string; modified_at: number }>();
    mockedInvoke.mockImplementation((cmd, payload) => {
      if (cmd === "write_file") {
        const content = (payload as { content: string }).content;
        return content === "agent" ? agentWrite.promise : userSave.promise;
      }
      return Promise.reject(new Error(`unexpected command ${cmd}`));
    });

    const dispatchPromise = dispatchMcpRequest({
      request_id: 1,
      tool: "write_file",
      args: { path: "/ws/a.md", relative_path: "a.md", content: "agent" },
    });
    await flushMicrotasks();
    // The user types mid-write; their autosave is still in flight when the
    // agent's write resolves.
    useEditorStore.getState().updateContent("/ws/a.md", "user");
    agentWrite.resolve({ path: "/ws/a.md", modified_at: 4 });
    const dispatch = await dispatchPromise;

    expect(dispatch.ok).toBe(false);
    if (!dispatch.ok) expect(dispatch.error.kind).toBe("unsaved_conflict");
    let file = useEditorStore.getState().openFiles.get("/ws/a.md");
    expect(file?.content).toBe("user");
    expect(file?.isDirty).toBe(true);

    // The pending autosave then writes the user's text over the agent's.
    userSave.resolve({ path: "/ws/a.md", modified_at: 5 });
    await flushMicrotasks();
    file = useEditorStore.getState().openFiles.get("/ws/a.md");
    expect(file?.diskContent).toBe("user");
    expect(file?.isDirty).toBe(false);
  });

  test("create_file removes its placeholder when the content write fails", async () => {
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "file_exists") return Promise.resolve(false);
      if (cmd === "create_file")
        return Promise.resolve({ path: "/ws/new.md", content: "# ", modified_at: 1 });
      if (cmd === "write_file") return Promise.reject(new Error("disk full"));
      if (cmd === "delete_entry") return Promise.resolve();
      if (cmd === "read_directory") return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected command ${cmd}`));
    });

    const dispatch = await dispatchMcpRequest({
      request_id: 1,
      tool: "create_file",
      args: { path: "/ws/new.md", relative_path: "new.md", content: "# Draft\n" },
    });

    expect(dispatch.ok).toBe(false);
    expect(mockedInvoke).toHaveBeenCalledWith("delete_entry", { path: "/ws/new.md" });
  });

  test("write_file goes through the save path and refreshes a clean open tab", async () => {
    useEditorStore.setState({
      openFiles: new Map([["/ws/a.md", openFile("/ws/a.md", "old", false)]]),
    });
    mockedInvoke.mockImplementation((cmd) =>
      cmd === "write_file"
        ? Promise.resolve({ path: "/ws/a.md", modified_at: 3 })
        : Promise.reject(new Error(`unexpected command ${cmd}`)),
    );

    const dispatch = await dispatchMcpRequest({
      request_id: 1,
      tool: "write_file",
      args: { path: "/ws/a.md", relative_path: "a.md", content: "new text" },
    });

    expect(dispatch).toEqual({
      ok: true,
      result: { path: "/ws/a.md", relative_path: "a.md", modified_at: 3 },
    });
    expect(mockedInvoke).toHaveBeenCalledWith("write_file", {
      path: "/ws/a.md",
      content: "new text",
    });
    const file = useEditorStore.getState().openFiles.get("/ws/a.md");
    expect(file?.content).toBe("new text");
    expect(file?.diskContent).toBe("new text");
    expect(file?.isDirty).toBe(false);
  });

  test("create_folder creates the directory and reports already_exists", async () => {
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "file_exists") return Promise.resolve(false);
      if (cmd === "create_directory")
        return Promise.resolve({
          name: "notes",
          path: "/ws/notes",
          is_dir: true,
          is_markdown: false,
          modified_at: 1,
          title: null,
        });
      if (cmd === "read_directory") return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected command ${cmd}`));
    });

    const dispatch = await dispatchMcpRequest({
      request_id: 1,
      tool: "create_folder",
      args: { path: "/ws/notes", relative_path: "notes" },
    });

    expect(dispatch).toEqual({
      ok: true,
      result: { path: "/ws/notes", relative_path: "notes" },
    });
    expect(mockedInvoke).toHaveBeenCalledWith("create_directory", { path: "/ws/notes" });

    mockedInvoke.mockImplementation((cmd) =>
      cmd === "file_exists"
        ? Promise.resolve(true)
        : Promise.reject(new Error(`unexpected ${cmd}`)),
    );
    const refused = await dispatchMcpRequest({
      request_id: 2,
      tool: "create_folder",
      args: { path: "/ws/notes", relative_path: "notes" },
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.kind).toBe("already_exists");
  });
});

describe("dispatchMcpRequest open/control tools", () => {
  test("open_file opens the file and brings the window forward", async () => {
    const openFile = vi.fn(() => Promise.resolve(null));
    const openFileInNewTab = vi.fn(() => Promise.resolve());
    useEditorStore.setState({ openFile, openFileInNewTab });

    const dispatch = await dispatchMcpRequest({
      request_id: 1,
      tool: "open_file",
      args: { path: "/ws/b.md", relative_path: "b.md", new_tab: false },
    });

    expect(dispatch).toEqual({ ok: true, result: { opened: "b.md" } });
    expect(openFile).toHaveBeenCalledWith("/ws/b.md");
    expect(openFileInNewTab).not.toHaveBeenCalled();
    expect(currentWindow.setFocus).toHaveBeenCalled();
  });

  test("open_file with new_tab opens a fresh tab", async () => {
    const openFile = vi.fn(() => Promise.resolve(null));
    const openFileInNewTab = vi.fn(() => Promise.resolve());
    useEditorStore.setState({ openFile, openFileInNewTab });

    const dispatch = await dispatchMcpRequest({
      request_id: 1,
      tool: "open_file",
      args: { path: "/ws/b.md", relative_path: "b.md", new_tab: true },
    });

    expect(dispatch).toEqual({ ok: true, result: { opened: "b.md" } });
    expect(openFileInNewTab).toHaveBeenCalledWith("/ws/b.md");
    expect(openFile).not.toHaveBeenCalled();
  });

  test("open_file in a compact window only focuses — its file is already shown", async () => {
    useWorkspaceStore.setState({ root: null, chromeMode: "compact-file" });
    const openFile = vi.fn(() => Promise.resolve(null));
    useEditorStore.setState({ openFile });

    const dispatch = await dispatchMcpRequest({
      request_id: 1,
      tool: "open_file",
      args: { path: "/ws/a.md", relative_path: "a.md", new_tab: false },
    });

    expect(dispatch).toEqual({ ok: true, result: { opened: "a.md" } });
    expect(openFile).not.toHaveBeenCalled();
    expect(currentWindow.setFocus).toHaveBeenCalled();
  });

  test("reveal_in_sidebar expands and highlights without a focus change", async () => {
    const dispatch = await dispatchMcpRequest({
      request_id: 1,
      tool: "reveal_in_sidebar",
      args: { path: "/ws/sub/note.md", relative_path: "sub/note.md" },
    });

    expect(dispatch).toEqual({ ok: true, result: {} });
    expect(revealPathInSidebar).toHaveBeenCalledWith("/ws/sub/note.md", { showSidebar: true });
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
