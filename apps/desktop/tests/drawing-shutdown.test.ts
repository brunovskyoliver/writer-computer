import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
const fixture = vi.hoisted(() => ({
  effects: [] as (() => () => void)[],
  listeners: new Map<string, (event: { payload: number }) => Promise<void> | void>(),
  windowListeners: new Map<string, (event: { payload: number }) => Promise<void> | void>(),
  invoke: vi.fn(async () => {}),
  save: vi.fn(async () => {}),
  saveText: vi.fn(async () => {}),
}));
vi.mock("react", () => ({
  useEffect: (effect: () => () => void) => fixture.effects.push(effect),
  useState: () => [false, vi.fn()],
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: fixture.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, callback: (event: { payload: number }) => void) => {
    fixture.listeners.set(event, callback);
    return () => {};
  },
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    listen: async (event: string, callback: (event: { payload: number }) => void) => {
      fixture.windowListeners.set(event, callback);
      return () => {};
    },
  }),
}));
vi.mock("../src/lib/drawing-sessions", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  saveDrawingSessions: fixture.save,
  reportDrawingSaveError: vi.fn(),
}));
vi.mock("../src/lib/save", () => ({ saveAllNow: fixture.saveText }));
import { useDrawingShutdown } from "../src/hooks/use-drawing-shutdown";
import { runAsyncEditorInput, isEditorInputFrozen } from "../src/lib/editor-input";
let cleanup: () => void;
const prepare = async (id: number, target = "main") => {
  // Tauri's global Any listener sees emit_to too; a window listener sees only
  // its own target. Keep that routing distinction in this native-event seam.
  const global = fixture.listeners.get("drawing:prepare-close")?.({ payload: id });
  const scoped =
    target === "main"
      ? fixture.windowListeners.get("drawing:prepare-close")?.({ payload: id })
      : undefined;
  await Promise.all([global, scoped]);
};
const cancel = (id: number) => fixture.listeners.get("drawing:close-cancelled")!({ payload: id });
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(async () => {
  fixture.effects.length = 0;
  fixture.listeners.clear();
  fixture.windowListeners.clear();
  fixture.save.mockReset().mockResolvedValue();
  fixture.saveText.mockReset().mockResolvedValue();
  fixture.invoke.mockClear();
  vi.stubGlobal("document", { body: { inert: false } });
  vi.stubGlobal("window", { alert: vi.fn() });
  useDrawingShutdown();
  cleanup = fixture.effects[0]!();
  await vi.waitFor(() => expect(fixture.invoke).toHaveBeenCalledWith("drawing_shutdown_ready"));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("window acknowledgment waits for text and every drawing save", async () => {
  const text = deferred(),
    drawing = deferred();
  fixture.saveText.mockReturnValueOnce(text.promise);
  fixture.save.mockReturnValueOnce(drawing.promise);
  const closing = prepare(1);
  expect(document.body.inert).toBe(true);
  await vi.waitFor(() => expect(fixture.saveText).toHaveBeenCalledOnce());
  expect(fixture.save).not.toHaveBeenCalled();
  expect(fixture.invoke).not.toHaveBeenCalledWith("drawing_shutdown_complete", expect.anything());
  text.resolve();
  await vi.waitFor(() => expect(fixture.save).toHaveBeenCalledOnce());
  expect(fixture.invoke).not.toHaveBeenCalledWith("drawing_shutdown_complete", expect.anything());
  drawing.resolve();
  await closing;
  expect(fixture.invoke).toHaveBeenCalledWith("drawing_shutdown_complete", {
    id: 1,
    success: true,
  });
  expect(document.body.inert).toBe(true);
});

test("a cancelled request's late rejection cannot unfreeze a newer close", async () => {
  const old = deferred(),
    current = deferred();
  fixture.save.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  const first = prepare(1);
  await vi.waitFor(() => expect(fixture.save).toHaveBeenCalledTimes(1));
  await cancel(1);
  expect(document.body.inert).toBe(false);
  const second = prepare(2);
  await vi.waitFor(() => expect(fixture.save).toHaveBeenCalledTimes(2));
  old.reject(new Error("old failed"));
  await first;
  expect(document.body.inert).toBe(true);
  expect(fixture.invoke).not.toHaveBeenCalledWith("drawing_shutdown_complete", {
    id: 1,
    success: false,
  });
  current.resolve();
  await second;
  expect(fixture.invoke).toHaveBeenCalledWith("drawing_shutdown_complete", {
    id: 2,
    success: true,
  });
});

test("text failure cancels closure and restores input", async () => {
  fixture.saveText.mockRejectedValueOnce(new Error("Failed to save note.md"));
  vi.spyOn(console, "error").mockImplementation(() => {});
  await prepare(1);
  expect(fixture.invoke).toHaveBeenCalledWith("drawing_shutdown_complete", {
    id: 1,
    success: false,
  });
  expect(fixture.invoke).not.toHaveBeenCalledWith("drawing_shutdown_complete", {
    id: 1,
    success: true,
  });
  expect(document.body.inert).toBe(false);
  expect(window.alert).toHaveBeenCalledWith(expect.stringContaining("note.md"));
});

test("shutdown drains clipboard input before choosing text to save", async () => {
  const clipboard = deferred();
  let text = "before";
  const paste = runAsyncEditorInput(async () => {
    await clipboard.promise;
    text = "pasted";
  });
  const saved: string[] = [];
  fixture.saveText.mockImplementationOnce(async () => {
    saved.push(text);
  });
  const closing = prepare(1);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const savedBeforePaste = saved.length;
  clipboard.resolve();
  await paste;
  await closing;
  expect(savedBeforePaste).toBe(0);
  expect(saved).toEqual(["pasted"]);
});

test("cancelling during clipboard drain prevents a stale save and acknowledgment", async () => {
  const clipboard = deferred();
  const paste = runAsyncEditorInput(async () => {
    await clipboard.promise;
  });
  const closing = prepare(1);
  await cancel(1);
  clipboard.resolve();
  await paste;
  await closing;
  expect(fixture.saveText).not.toHaveBeenCalled();
  expect(fixture.invoke).not.toHaveBeenCalledWith("drawing_shutdown_complete", expect.anything());
  expect(isEditorInputFrozen()).toBe(false);
});

test("a cancelled text save cannot acknowledge or release a newer request", async () => {
  const old = deferred(),
    current = deferred();
  fixture.saveText.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  const first = prepare(1);
  await vi.waitFor(() => expect(fixture.saveText).toHaveBeenCalledTimes(1));
  await cancel(1);
  const second = prepare(2);
  await vi.waitFor(() => expect(fixture.saveText).toHaveBeenCalledTimes(2));
  old.resolve();
  await first;
  expect(document.body.inert).toBe(true);
  expect(fixture.invoke).not.toHaveBeenCalledWith("drawing_shutdown_complete", {
    id: 1,
    success: true,
  });
  current.resolve();
  await second;
  expect(fixture.invoke).toHaveBeenCalledWith("drawing_shutdown_complete", {
    id: 2,
    success: true,
  });
});

test("a queued native event after cleanup does not freeze input or save", async () => {
  cleanup();
  await prepare(1);
  expect(isEditorInputFrozen()).toBe(false);
  expect(fixture.saveText).not.toHaveBeenCalled();
  expect(fixture.save).not.toHaveBeenCalled();
});

test("cleanup during a text save releases input without acknowledging", async () => {
  const pending = deferred();
  fixture.saveText.mockReturnValueOnce(pending.promise);
  const closing = prepare(1);
  await vi.waitFor(() => expect(fixture.saveText).toHaveBeenCalledOnce());
  cleanup();
  pending.resolve();
  await closing;
  expect(isEditorInputFrozen()).toBe(false);
  expect(fixture.invoke).not.toHaveBeenCalledWith("drawing_shutdown_complete", expect.anything());
});

test("closing another window does not freeze this window or start its saves", async () => {
  await prepare(1, "other");
  expect(isEditorInputFrozen()).toBe(false);
  expect(fixture.saveText).not.toHaveBeenCalled();
  expect(fixture.save).not.toHaveBeenCalled();
  expect(fixture.invoke).not.toHaveBeenCalledWith("drawing_shutdown_complete", expect.anything());
});
