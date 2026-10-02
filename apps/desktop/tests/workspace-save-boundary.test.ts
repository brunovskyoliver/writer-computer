import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { Text } from "@codemirror/state";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/theme", () => ({ applyTheme: vi.fn(), applyCssVarBindings: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { useEditorStore } from "../src/stores/editor-store";
import { useWorkspaceStore } from "../src/stores/workspace-store";
import { useSettingsStore } from "../src/stores/settings-store";
import { cancelSave } from "../src/lib/save";
import { runAsyncEditorInput } from "../src/lib/editor-input";

const path = "/review/note.md";
const mockedInvoke = vi.mocked(invoke);
let disk: string;
let diskAtClose: string | null;
let writeGate: Promise<void> | null;
let failWrites: boolean;
let body: { inert: boolean };

beforeEach(async () => {
  vi.useFakeTimers();
  useEditorStore.getState().resetEditorState();
  vi.clearAllMocks();
  disk = "initial";
  diskAtClose = null;
  writeGate = null;
  failWrites = false;
  body = { inert: false };
  vi.stubGlobal("document", { body });
  useWorkspaceStore.setState({ root: "/review", workspaceEpoch: 1 });
  useSettingsStore.setState({ settings: { "files.insert-final-newline": false } });
  mockedInvoke.mockImplementation(async (command, payload) => {
    if (command === "read_file") return { path, content: disk, modified_at: 0 };
    if (command === "write_file") {
      if (writeGate) await writeGate;
      if (failWrites) throw new Error("EACCES");
      disk = (payload as { content: string }).content;
      return { path, modified_at: 1 };
    }
    if (command === "close_workspace") diskAtClose = disk;
    if (command === "focus_workspace_window") return false;
    return null;
  });
  await useEditorStore.getState().openFile(path);
});

afterEach(() => {
  cancelSave(path);
  useEditorStore.getState().resetEditorState();
  useWorkspaceStore.setState({ root: null });
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("close writes the latest buffered edit before resetting the workspace", async () => {
  useEditorStore.getState().noteContentChanged(path, Text.of(["first edit"]));
  await vi.waitFor(() => expect(disk).toBe("first edit"));
  useEditorStore.getState().noteContentChanged(path, Text.of(["latest edit"]));
  expect(useEditorStore.getState().hasPendingEdit(path)).toBe(true);

  await useWorkspaceStore.getState().closeWorkspace();

  expect(diskAtClose).toBe("latest edit");
  expect(disk).toBe("latest edit");
  expect(useEditorStore.getState().openFiles.size).toBe(0);
});

test("close waits for an old in-flight write and saves edits made after it started", async () => {
  let finishWrite!: () => void;
  writeGate = new Promise<void>((resolve) => {
    finishWrite = resolve;
  });
  useEditorStore.getState().noteContentChanged(path, Text.of(["first edit"]));
  useEditorStore.getState().noteContentChanged(path, Text.of(["latest edit"]));

  const closing = useWorkspaceStore.getState().closeWorkspace();
  await vi.advanceTimersByTimeAsync(5);
  const closedBeforeWrite = diskAtClose !== null;
  writeGate = null;
  finishWrite();
  await closing;

  expect(closedBeforeWrite).toBe(false);
  expect(diskAtClose).toBe("latest edit");
});

test("a failed save leaves the workspace and dirty buffer intact", async () => {
  failWrites = true;
  vi.spyOn(console, "error").mockImplementation(() => {});
  useEditorStore.getState().noteContentChanged(path, Text.of(["unsaved edit"]));
  await vi.waitFor(() =>
    expect(useEditorStore.getState().openFiles.get(path)?.saveError).toBe("EACCES"),
  );

  await expect(useWorkspaceStore.getState().closeWorkspace()).rejects.toThrow("save");

  expect(diskAtClose).toBeNull();
  expect(useWorkspaceStore.getState().root).toBe("/review");
  expect(useEditorStore.getState().openFiles.get(path)?.isDirty).toBe(true);
  expect(useEditorStore.getState().openFiles.get(path)?.content).toBe("unsaved edit");
  expect(body.inert).toBe(false);
});

test("switching cannot open another workspace after a save failure", async () => {
  failWrites = true;
  vi.spyOn(console, "error").mockImplementation(() => {});
  useEditorStore.getState().noteContentChanged(path, Text.of(["unsaved edit"]));
  await vi.waitFor(() =>
    expect(useEditorStore.getState().openFiles.get(path)?.saveError).toBe("EACCES"),
  );

  await expect(useWorkspaceStore.getState().switchWorkspace("/other")).rejects.toThrow("save");

  expect(mockedInvoke).not.toHaveBeenCalledWith("open_workspace", expect.anything());
  expect(useWorkspaceStore.getState().root).toBe("/review");
});

test("text-only closure freezes input until backend closure and reset finish", async () => {
  let finishClose!: () => void;
  const gate = new Promise<void>((resolve) => {
    finishClose = resolve;
  });
  mockedInvoke.mockImplementation(async (command) => {
    if (command === "close_workspace") await gate;
    return null;
  });

  const closing = useWorkspaceStore.getState().closeWorkspace();
  await vi.waitFor(() =>
    expect(mockedInvoke).toHaveBeenCalledWith("close_workspace", { root: "/review" }),
  );
  expect(body.inert).toBe(true);
  expect(useEditorStore.getState().openFiles.has(path)).toBe(true);
  finishClose();
  await closing;
  expect(useEditorStore.getState().openFiles.size).toBe(0);
  expect(body.inert).toBe(false);
});

test("backend failure restores input and retains the workspace", async () => {
  mockedInvoke.mockImplementation(async (command) => {
    if (command === "close_workspace") throw new Error("backend close failed");
    return null;
  });

  await expect(useWorkspaceStore.getState().closeWorkspace()).rejects.toThrow(
    "backend close failed",
  );
  expect(body.inert).toBe(false);
  expect(useWorkspaceStore.getState().root).toBe("/review");
  expect(useEditorStore.getState().openFiles.has(path)).toBe(true);
});

test("one failed save preserves every text buffer in a workspace", async () => {
  const second = "/review/second.md";
  mockedInvoke.mockImplementation(async (command, payload) => {
    const args = payload as { path: string; content: string };
    if (command === "read_file") return { path: args.path, content: "initial", modified_at: 0 };
    if (command === "write_file") {
      if (args.path === second) throw new Error("EACCES");
      return { path: args.path, modified_at: 1 };
    }
    return null;
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  await useEditorStore.getState().openFile(second);
  useEditorStore.getState().noteContentChanged(path, Text.of(["first changed"]));
  useEditorStore.getState().noteContentChanged(second, Text.of(["second changed"]));

  await expect(useWorkspaceStore.getState().closeWorkspace()).rejects.toThrow("save");
  expect(useEditorStore.getState().openFiles.get(path)?.content).toBe("first changed");
  expect(useEditorStore.getState().openFiles.get(second)?.content).toBe("second changed");
  expect(useEditorStore.getState().openFiles.get(second)?.isDirty).toBe(true);
  expect(mockedInvoke).not.toHaveBeenCalledWith("close_workspace", expect.anything());
  cancelSave(second);
});

test("close drains a clipboard edit started before the save boundary", async () => {
  let finishClipboard!: () => void;
  const clipboard = new Promise<void>((resolve) => {
    finishClipboard = resolve;
  });
  const paste = runAsyncEditorInput(async () => {
    await clipboard;
    useEditorStore.getState().noteContentChanged(path, Text.of(["pasted edit"]));
  });
  const closing = useWorkspaceStore.getState().closeWorkspace();
  await vi.advanceTimersByTimeAsync(5);
  const closedBeforeClipboard = diskAtClose !== null;
  expect(body.inert).toBe(true);
  expect(diskAtClose).toBeNull();
  finishClipboard();
  await paste;
  await closing;
  expect(closedBeforeClipboard).toBe(false);
  expect(diskAtClose).toBe("pasted edit");
});

test("switch keeps input frozen until the target session finishes restoring", async () => {
  useSettingsStore.setState({ settings: { "workspace.restore-open-files": true } });
  let finishSession!: () => void;
  const session = new Promise<void>((resolve) => {
    finishSession = resolve;
  });
  mockedInvoke.mockImplementation(async (command) => {
    if (command === "focus_workspace_window") return false;
    if (command === "open_workspace")
      return { root: "/other", epoch: 2, name: "other", file_count: 0 };
    if (command === "read_directory" || command === "get_recent_workspaces") return [];
    if (command === "load_session") {
      await session;
      return { status: "missing" };
    }
    return null;
  });
  const switching = useWorkspaceStore.getState().switchWorkspace("/other");
  await vi.waitFor(() =>
    expect(mockedInvoke).toHaveBeenCalledWith("load_session", expect.anything()),
  );
  expect(useWorkspaceStore.getState().root).toBe("/other");
  expect(body.inert).toBe(true);
  finishSession();
  await switching;
  expect(body.inert).toBe(false);
});
