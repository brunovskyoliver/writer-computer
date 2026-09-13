import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@/lib/theme", () => ({
  applyTheme: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { useEditorStore } from "../src/stores/editor-store";
import { useSettingsStore } from "../src/stores/settings-store";
import { saveNow } from "../src/lib/save";

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
}

describe("autosave", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    useEditorStore.setState({
      openFiles: new Map(),
      tabs: [],
      activeTabId: null,
      activeFilePath: null,
    });

    useSettingsStore.setState({
      settings: {
        "files.trim-trailing-whitespace": false,
        "files.insert-final-newline": false,
      },
      isLoaded: true,
    });
  });

  afterEach(async () => {
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
  });

  test("keeps newer edits dirty until a follow-up save completes", async () => {
    const firstWrite = deferred<{ path: string; modified_at: number }>();
    const secondWrite = deferred<{ path: string; modified_at: number }>();
    const writePayloads: string[] = [];

    mockedInvoke.mockImplementation((command, payload) => {
      if (command === "read_file") {
        return Promise.resolve({
          path: "/test.md",
          content: "initial",
          modified_at: 1,
        });
      }

      if (command === "write_file") {
        writePayloads.push((payload as { content: string }).content);
        return writePayloads.length === 1 ? firstWrite.promise : secondWrite.promise;
      }

      return Promise.resolve(null);
    });

    await useEditorStore.getState().openFile("/test.md");

    useEditorStore.getState().updateContent("/test.md", "first draft");
    expect(writePayloads).toEqual(["first draft"]);

    useEditorStore.getState().updateContent("/test.md", "second draft");
    expect(writePayloads).toEqual(["first draft"]);

    firstWrite.resolve({ path: "/test.md", modified_at: 2 });
    await flushMicrotasks();

    const midSave = useEditorStore.getState().openFiles.get("/test.md");
    expect(midSave?.content).toBe("second draft");
    expect(midSave?.diskContent).toBe("first draft");
    expect(midSave?.isDirty).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    expect(writePayloads).toEqual(["first draft", "second draft"]);

    secondWrite.resolve({ path: "/test.md", modified_at: 3 });
    await flushMicrotasks();

    const saved = useEditorStore.getState().openFiles.get("/test.md");
    expect(saved?.content).toBe("second draft");
    expect(saved?.diskContent).toBe("second draft");
    expect(saved?.isDirty).toBe(false);
  });

  describe("saveNow", () => {
    function mockFs(writes: string[], onWrite?: () => Promise<unknown>) {
      mockedInvoke.mockImplementation((command, payload) => {
        if (command === "read_file") {
          return Promise.resolve({ path: "/test.md", content: "initial", modified_at: 1 });
        }
        if (command === "write_file") {
          writes.push((payload as { content: string }).content);
          return onWrite ? onWrite() : Promise.resolve({ path: "/test.md", modified_at: 2 });
        }
        return Promise.resolve(null);
      });
    }

    test("writes before the throttle window elapses", async () => {
      const firstWrite = deferred<{ path: string; modified_at: number }>();
      const writes: string[] = [];
      mockFs(writes, () =>
        writes.length === 1
          ? firstWrite.promise
          : Promise.resolve({ path: "/test.md", modified_at: 3 }),
      );
      await useEditorStore.getState().openFile("/test.md");

      // Edit while the first write is in flight, then let it land: the
      // follow-up is parked behind the 1 s throttle timer.
      useEditorStore.getState().updateContent("/test.md", "first");
      useEditorStore.getState().updateContent("/test.md", "second");
      firstWrite.resolve({ path: "/test.md", modified_at: 2 });
      await flushMicrotasks();
      expect(writes).toEqual(["first"]);

      const saved = await saveNow("/test.md");

      expect(saved).toBe(true);
      expect(writes).toEqual(["first", "second"]);
      expect(useEditorStore.getState().openFiles.get("/test.md")?.isDirty).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(writes).toEqual(["first", "second"]);
    });

    test("resolves false and leaves the file dirty when the write rejects", async () => {
      const writes: string[] = [];
      mockFs(writes, () => Promise.reject(new Error("EACCES")));
      await useEditorStore.getState().openFile("/test.md");

      useEditorStore.getState().updateContent("/test.md", "draft");
      await flushMicrotasks();
      expect(writes).toEqual(["draft"]);

      const saved = await saveNow("/test.md");

      expect(saved).toBe(false);
      expect(writes).toEqual(["draft", "draft"]);
      const file = useEditorStore.getState().openFiles.get("/test.md");
      expect(file?.isDirty).toBe(true);
      expect(file?.saveError).toBe("EACCES");
    });

    test("waits for an in-flight write and lands the latest content once", async () => {
      const firstWrite = deferred<{ path: string; modified_at: number }>();
      const writes: string[] = [];
      let calls = 0;
      mockFs(writes, () => {
        calls += 1;
        return calls === 1
          ? firstWrite.promise
          : Promise.resolve({ path: "/test.md", modified_at: 3 });
      });
      await useEditorStore.getState().openFile("/test.md");

      useEditorStore.getState().updateContent("/test.md", "first");
      expect(writes).toEqual(["first"]);
      useEditorStore.getState().updateContent("/test.md", "second");
      useEditorStore.getState().updateContent("/test.md", "third");

      const pending = saveNow("/test.md");
      firstWrite.resolve({ path: "/test.md", modified_at: 2 });
      const saved = await pending;

      expect(saved).toBe(true);
      expect(writes).toEqual(["first", "third"]);
      expect(useEditorStore.getState().openFiles.get("/test.md")?.isDirty).toBe(false);
      // The throttled follow-up the first write queued has nothing left to do.
      await vi.advanceTimersByTimeAsync(1000);
      expect(writes).toEqual(["first", "third"]);
    });
  });
});
