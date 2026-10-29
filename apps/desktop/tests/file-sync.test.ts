import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { Text } from "@codemirror/state";
import { createLayout } from "../src/lib/editor-layout";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/theme", () => ({ applyTheme: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { useEditorStore } from "../src/stores/editor-store";
import { useSettingsStore } from "../src/stores/settings-store";
import { createExternalFileSync, loadCurrentDiskVersion } from "../src/hooks/file-sync";
import { keepLocalFileChanges } from "../src/hooks/use-file-conflict";
import { saveNow, waitForSave } from "../src/lib/save";

const path = "/study.md";
const store = () => useEditorStore.getState();
const file = () => store().openFiles.get(path)!;
const mockedInvoke = vi.mocked(invoke);
let disk: string | null;
let writes: string[];
let read: () => Promise<unknown>;
let write: (content: string, expected: string | null) => Promise<unknown>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function tick() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

const raw = (content: string) => ({ path, content, modified_at: 1 });
const refresh = () => createExternalFileSync().refresh(path, () => true);

beforeEach(() => {
  store().resetEditorState();
  vi.useFakeTimers();
  vi.clearAllMocks();
  disk = "baseline";
  writes = [];
  useSettingsStore.setState({
    settings: {
      "files.trim-trailing-whitespace": false,
      "files.insert-final-newline": false,
    },
    isLoaded: true,
  });
  read = async () => {
    if (disk === null) throw `Not found: ${path}`;
    return raw(disk);
  };
  write = async (content, expected) => {
    if (disk !== expected) throw { kind: "file_conflict", diskContent: disk };
    disk = content;
    return { path, modified_at: 2 };
  };
  mockedInvoke.mockImplementation(async (command, payload) => {
    if (command === "read_file") return read();
    if (command === "write_file") {
      const args = payload as { content: string; expected: { content: string | null } };
      writes.push(args.content);
      return write(args.content, args.expected.content);
    }
    return null;
  });
});

afterEach(async () => {
  store().resetEditorState();
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
});

async function conflict() {
  await store().openFile(path);
  disk = "external";
  store().updateContent(path, "local");
  await waitForSave(path);
  expect(file().conflict?.diskContent).toBe("external");
}

test("a rejected conditional autosave retains both versions and blocks retries and close", async () => {
  await conflict();
  expect(file().content).toBe("local");
  expect(disk).toBe("external");
  expect(await saveNow(path)).toBe(false);
  const tab = store().tabs[0];
  store().closeTab(tab.id);
  await tick();
  await vi.advanceTimersByTimeAsync(5000);
  expect(writes).toEqual(["local"]);
  expect(store().tabs.some((t) => t.id === tab.id)).toBe(true);
});

test("clean external changes reload without a conflict", async () => {
  await store().openFile(path);
  disk = "new disk";
  await refresh();
  expect(file().content).toBe("new disk");
  expect(file().isDirty).toBe(false);
  expect(file().conflict).toBeFalsy();
});

test("only the latest external read may publish", async () => {
  await store().openFile(path);
  const old = deferred<unknown>();
  read = () => old.promise;
  const sync = createExternalFileSync();
  const first = sync.refresh(path, () => true);
  await tick();
  read = async () => raw("new external");
  await sync.refresh(path, () => true);
  old.resolve(raw("old external"));
  await first;
  expect(file().content).toBe("new external");
});

test("a save overtaking an external read forces a fresh read", async () => {
  await store().openFile(path);
  const old = deferred<unknown>();
  read = () => old.promise;
  const pending = refresh();
  await tick();
  store().updateContent(path, "saved local");
  await waitForSave(path);
  expect(disk).toBe("saved local");
  read = async () => raw(disk!);
  old.resolve(raw("stale external"));
  await pending;
  expect(file().content).toBe("saved local");
  expect(file().conflict).toBeFalsy();
  expect(mockedInvoke.mock.calls.filter(([cmd]) => cmd === "read_file")).toHaveLength(3);
});

test.each(["dispose", "workspace", "identity"])("%s invalidates an external read", async (kind) => {
  await store().openFile(path);
  const old = deferred<unknown>();
  read = () => old.promise;
  const sync = createExternalFileSync();
  let current = true;
  const pending = sync.refresh(path, () => current);
  await tick();
  if (kind === "dispose") sync.dispose();
  if (kind === "identity") current = false;
  if (kind === "workspace") {
    store().resetEditorState();
    read = async () => raw("reopened");
    await store().openFile(path);
  }
  old.resolve(raw("stale"));
  await pending;
  expect(file().content).toBe(kind === "workspace" ? "reopened" : "baseline");
});

test.each([false, true])(
  "a stale initial load cannot replace a reopened buffer (failure=%s)",
  async (fail) => {
    const old = deferred<unknown>();
    read = () => old.promise;
    const first = store().openFile(path);
    await tick();
    store().resetEditorState();
    read = async () => raw("reopened");
    await store().openFile(path);
    if (fail) old.reject(new Error("old read failed"));
    else old.resolve(raw("old"));
    await first;
    expect(file().content).toBe("reopened");
    expect(file().isLoading).toBe(false);
  },
);

test("a stale save cannot mark the new buffer saved or consume its queued save", async () => {
  await store().openFile(path);
  const old = deferred<unknown>();
  const normalWrite = write;
  write = () => old.promise;
  store().updateContent(path, "old local");
  const oldRequest = saveNow(path);
  store().resetEditorState();
  await store().openFile(path);
  store().updateContent(path, "new local");
  write = normalWrite;
  old.resolve({ path, modified_at: 2 });
  expect(await oldRequest).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(file().content).toBe("new local");
  expect(file().diskContent).toBe("new local");
  expect(disk).toBe("new local");
});

test("keeping local changes checks the observed competing version again", async () => {
  await conflict();
  disk = "second external";
  expect(await keepLocalFileChanges(path)).toBe(false);
  expect(disk).toBe("second external");
  expect(file().content).toBe("local");
  expect(file().conflict?.diskContent).toBe("second external");
  expect(await keepLocalFileChanges(path)).toBe(true);
  expect(disk).toBe("local");
  expect(file().conflict).toBeFalsy();
});

test("external deletion preserves text until explicit recreation", async () => {
  await store().openFile(path);
  disk = null;
  await refresh();
  expect(file().content).toBe("baseline");
  expect(file().conflict?.diskContent).toBeNull();
  expect(await saveNow(path)).toBe(false);
  expect(disk).toBeNull();
  expect(await keepLocalFileChanges(path)).toBe(true);
  expect(disk).toBe("baseline");
});

test("a publication collision keeps the recreation draft dirty and reports the failure", async () => {
  await store().openFile(path);
  disk = null;
  await refresh();
  const ordinaryWrite = write;
  let publicationAttempt = true;
  write = async (content, expected) => {
    if (!publicationAttempt) return ordinaryWrite(content, expected);
    publicationAttempt = false;
    expect(expected).toBeNull();
    disk = "created by another process";
    throw `Already exists: ${path}`;
  };
  const errors: string[] = [];
  const unsubscribe = useEditorStore.subscribe((state) => {
    const error = state.openFiles.get(path)?.saveError;
    if (error) errors.push(error);
  });
  let saved: boolean;
  try {
    saved = await keepLocalFileChanges(path);
  } finally {
    unsubscribe();
  }
  expect(saved).toBe(false);
  expect(errors).toContain(`Already exists: ${path}`);
  expect(disk).toBe("created by another process");
  expect(file().content).toBe("baseline");
  expect(file().isDirty).toBe(true);
  expect(file().diskContent).toBeNull();
  // saveNow retries after the in-flight publication failure. The existing
  // destination is then rejected at its precondition, restoring conflict choices.
  expect(file().conflict?.diskContent).toBe("created by another process");
  expect(file().content).toBe("baseline");
  expect(file().isDirty).toBe(true);
  expect(disk).toBe("created by another process");
  const attempts = writes.length;
  await vi.advanceTimersByTimeAsync(10000);
  expect(writes).toHaveLength(attempts);
});

test("use disk rereads rather than loading the version cached in the notice", async () => {
  await conflict();
  disk = "newer external";
  expect(await loadCurrentDiskVersion(path)).toBe(true);
  expect(file().content).toBe("newer external");
  expect(file().conflict).toBeFalsy();
});

test("typing during use disk preserves the pending CodeMirror document", async () => {
  await conflict();
  const pending = deferred<unknown>();
  read = () => pending.promise;
  const result = loadCurrentDiskVersion(path);
  await tick();
  const doc = Text.of(["new pending typing"]);
  store().noteContentChanged(path, doc);
  pending.resolve(raw("external"));
  expect(await result).toBe(false);
  expect(store().getPendingEdit(path)).toBe(doc);
  expect(file().conflict).toBeTruthy();
  store().flushPendingEdit(path);
  expect(file().content).toBe("new pending typing");
});

test("use disk cannot discard text when the file was deleted", async () => {
  await conflict();
  disk = null;
  expect(await loadCurrentDiskVersion(path)).toBe(false);
  expect(file().content).toBe("local");
  expect(file().conflict?.diskContent).toBeNull();
});

test("read errors preserve the buffer and explain why refresh failed", async () => {
  await store().openFile(path);
  read = async () => {
    throw new Error("permission denied");
  };
  await refresh();
  expect(file().content).toBe("baseline");
  expect(file().saveError).toContain("permission denied");
});

test("navigation and closing the destination keep a conflicted note reachable", async () => {
  await conflict();
  const original = store().tabs[0].id;
  await store().navigateToFile("/other.md", { tabId: original });
  expect(store().activeFilePath).toBe("/other.md");
  expect(store().tabs.some((t) => t.location.kind === "file" && t.location.path === path)).toBe(
    true,
  );
  store().closeTab(original);
  expect(store().tabs.some((t) => t.location.kind === "file" && t.location.path === path)).toBe(
    true,
  );
  expect(file().content).toBe("local");
});

test("a newer watcher observation overtakes a pending use-disk read", async () => {
  await conflict();
  const old = deferred<unknown>();
  read = () => old.promise;
  const result = loadCurrentDiskVersion(path);
  await tick();
  disk = "newest external";
  read = async () => raw(disk!);
  await refresh();
  expect(file().conflict?.diskContent).toBe("newest external");
  old.resolve(raw("external"));
  expect(await result).toBe(true);
  expect(file().content).toBe("newest external");
});

test("two callers waiting on an old initial load cannot duplicate a reopened load", async () => {
  const old = deferred<unknown>();
  read = () => old.promise;
  const first = store().openFile(path);
  const second = store().openFile(path);
  await tick();
  store().resetEditorState();
  const current = deferred<unknown>();
  read = () => current.promise;
  const reopened = store().openFile(path);
  await tick();
  old.resolve(raw("old"));
  await Promise.all([first, second]);
  expect(mockedInvoke.mock.calls.filter(([cmd]) => cmd === "read_file")).toHaveLength(2);
  current.resolve(raw("current"));
  await reopened;
  expect(file().content).toBe("current");
});

test("a late session-restore failure cannot prune a reopened conflict", async () => {
  const slow = deferred<unknown>();
  mockedInvoke.mockImplementation(async (command, payload) => {
    if (command !== "read_file") return null;
    if ((payload as { path: string }).path === path) throw new Error("initial failure");
    return slow.promise;
  });
  const restoring = store().restoreSession({
    tabs: [
      { id: "restore-a", location: { kind: "file", path }, back: [], forward: [] },
      { id: "restore-b", location: { kind: "file", path: "/slow.md" }, back: [], forward: [] },
    ],
    layout: createLayout(["restore-a", "restore-b"], "restore-a"),
  });
  await tick();
  expect(store().openFiles.has(path)).toBe(false);
  mockedInvoke.mockImplementation(async (command) =>
    command === "read_file" ? raw("reopened") : null,
  );
  await store().openFileInNewTab(path);
  store().recordDiskConflict(path, "external");
  store().noteContentChanged(path, Text.of(["new pending local"]));
  slow.resolve(raw("other"));
  await restoring;
  expect(file().content).toBe("reopened");
  expect(file().conflict?.diskContent).toBe("external");
  expect(store().getPendingEdit(path)?.toString()).toBe("new pending local");
  expect(store().tabs.some((t) => t.location.kind === "file" && t.location.path === path)).toBe(
    true,
  );
});

test("a conflict arriving during a successful write prevents a successful drain", async () => {
  await store().openFile(path);
  const pending = deferred<unknown>();
  write = () => pending.promise;
  store().updateContent(path, "local");
  const saving = saveNow(path);
  store().recordDiskConflict(path, "external");
  pending.resolve({ path, modified_at: 2 });
  expect(await saving).toBe(false);
  expect(file().conflict?.diskContent).toBe("external");
  expect(file().isDirty).toBe(true);
});
