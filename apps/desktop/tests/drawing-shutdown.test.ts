import { beforeEach, expect, test, vi } from "vite-plus/test";
const fixture = vi.hoisted(() => ({
  effects: [] as (() => () => void)[],
  listeners: new Map<string, (event: { payload: number }) => Promise<void> | void>(),
  invoke: vi.fn(async () => {}),
  save: vi.fn(async () => {}),
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
vi.mock("../src/lib/drawing-sessions", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  saveDrawingSessions: fixture.save,
  reportDrawingSaveError: vi.fn(),
}));
import { useDrawingShutdown } from "../src/hooks/use-drawing-shutdown";
let cleanup: () => void;
beforeEach(async () => {
  cleanup?.();
  fixture.effects.length = 0;
  fixture.listeners.clear();
  vi.clearAllMocks();
  vi.stubGlobal("document", { body: { inert: false } });
  useDrawingShutdown();
  cleanup = fixture.effects[0]!();
  await vi.waitFor(() => expect(fixture.invoke).toHaveBeenCalledWith("drawing_shutdown_ready"));
});

test("window acknowledgment waits for every drawing save", async () => {
  let finish!: () => void;
  fixture.save.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const closing = fixture.listeners.get("drawing:prepare-close")!({ payload: 1 });
  expect(document.body.inert).toBe(true);
  expect(fixture.invoke).not.toHaveBeenCalledWith("drawing_shutdown_complete", expect.anything());
  finish();
  await closing;
  expect(fixture.invoke).toHaveBeenCalledWith("drawing_shutdown_complete", {
    id: 1,
    success: true,
  });
  cleanup();
});

test("a cancelled request's late rejection cannot unfreeze a newer close", async () => {
  let rejectOld!: (error: Error) => void;
  let finishNew!: () => void;
  fixture.save
    .mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          rejectOld = reject;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishNew = resolve;
        }),
    );
  const old = fixture.listeners.get("drawing:prepare-close")!({ payload: 1 });
  await fixture.listeners.get("drawing:close-cancelled")!({ payload: 1 });
  expect(document.body.inert).toBe(false);
  const current = fixture.listeners.get("drawing:prepare-close")!({ payload: 2 });
  rejectOld(new Error("old failed"));
  await old;
  expect(document.body.inert).toBe(true);
  expect(fixture.invoke).not.toHaveBeenCalledWith("drawing_shutdown_complete", {
    id: 1,
    success: false,
  });
  finishNew();
  await current;
  expect(fixture.invoke).toHaveBeenCalledWith("drawing_shutdown_complete", {
    id: 2,
    success: true,
  });
  cleanup();
});
