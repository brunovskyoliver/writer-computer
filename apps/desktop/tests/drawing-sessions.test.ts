import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
vi.mock("../src/lib/tauri", () => ({ deleteEntry: vi.fn(async () => {}) }));
import { deleteEntry } from "../src/lib/tauri";
vi.mock("../src/lib/drawings", () => ({ saveDrawing: vi.fn(async () => {}) }));
import { saveDrawing } from "../src/lib/drawings";
import {
  createDrawingSession,
  registerDrawingSession,
  saveDrawingSessions,
  discardDrawingSessions,
  withDrawingSaveBoundary,
  deleteEntryAfterDrawingWrites,
} from "../src/lib/drawing-sessions";

const path = "/drawing.excalidraw.svg";
const initial = () => ({ elements: [], appState: {}, files: {} });
const elements = (version: number) =>
  [
    { id: "stroke", version, isDeleted: false, points: [[0, version]] },
  ] as unknown as OrderedExcalidrawElement[];
const state = {} as AppState;
afterEach(() => {
  discardDrawingSessions(path);
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("explicit drawing persistence", () => {
  test("1000 changes do not traverse the scene, schedule timers or write", async () => {
    vi.useFakeTimers();
    const session = createDrawingSession(path, initial());
    const read = vi.fn();
    const strokes = new Proxy(elements(1), {
      get(target, key, receiver) {
        read(key);
        return Reflect.get(target, key, receiver);
      },
    });
    for (let i = 0; i < 1000; i++) session.change(strokes, state, {});
    expect(read).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(saveDrawing).not.toHaveBeenCalled();
    await session.save();
    expect(saveDrawing).toHaveBeenCalledTimes(1);
  });

  test("captures mutable elements and files before yielding; saves newer edits separately", async () => {
    const session = createDrawingSession(path, initial());
    const strokes = elements(1);
    const files = { image: { dataURL: "before" } } as unknown as BinaryFiles;
    session.change(strokes, state, files);
    const first = session.save();
    (strokes[0] as unknown as { points: number[][] }).points[0]![1] = 2;
    files.image!.dataURL = "after" as typeof files.image.dataURL;
    await first;
    expect(vi.mocked(saveDrawing).mock.calls[0]![1].elements[0]).toMatchObject({
      points: [[0, 1]],
    });
    expect(vi.mocked(saveDrawing).mock.calls[0]![1].files.image).toMatchObject({
      dataURL: "before",
    });
    await session.save();
    expect(saveDrawing).toHaveBeenCalledTimes(2);
    await session.save();
    expect(saveDrawing).toHaveBeenCalledTimes(2);
  });

  test("failed save stays retryable and prevents destructive close", async () => {
    const session = createDrawingSession(path, initial());
    session.change(elements(1), state, {});
    registerDrawingSession(path, session.save);
    vi.mocked(saveDrawing).mockRejectedValueOnce(new Error("disk full"));
    const close = vi.fn();
    await expect(withDrawingSaveBoundary(close, path)).rejects.toThrow("disk full");
    expect(close).not.toHaveBeenCalled();
    await withDrawingSaveBoundary(close, path);
    expect(close).toHaveBeenCalledTimes(1);
    expect(saveDrawing).toHaveBeenCalledTimes(2);
  });

  test("close waits for export; duplicate requests coalesce unchanged snapshots", async () => {
    let finish!: () => void;
    vi.mocked(saveDrawing).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const session = createDrawingSession(path, initial());
    session.change(elements(1), state, {});
    registerDrawingSession(path, session.save);
    const close = vi.fn();
    const closing = withDrawingSaveBoundary(close, path);
    const saving = saveDrawingSessions(path);
    await vi.waitFor(() => expect(saveDrawing).toHaveBeenCalledTimes(1));
    expect(close).not.toHaveBeenCalled();
    finish();
    await Promise.all([closing, saving]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(saveDrawing).toHaveBeenCalledTimes(1);
  });

  test("ignores empty initialization but saves deleting the entire drawing", async () => {
    const session = createDrawingSession(path, { ...initial(), elements: elements(1) as never });
    session.change([], state, {});
    await session.save();
    expect(saveDrawing).not.toHaveBeenCalled();
    session.change(elements(1), state, {});
    session.change([], state, {});
    await session.save();
    expect(saveDrawing).toHaveBeenCalledWith(path, expect.objectContaining({ elements: [] }));
  });

  test("deleted paths are not recreated on unmount", async () => {
    const session = createDrawingSession(path, initial());
    session.change(elements(1), state, {});
    const unregister = registerDrawingSession(path, session.save);
    discardDrawingSessions(path);
    unregister();
    await saveDrawingSessions();
    expect(saveDrawing).not.toHaveBeenCalled();
  });
});

test("reopening a retiring drawing waits for its outstanding save", async () => {
  let finish!: () => void;
  vi.mocked(saveDrawing).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const session = createDrawingSession(path, initial());
  session.change(elements(1), state, {});
  const unregister = registerDrawingSession(path, session.save, session.settled);
  unregister();
  const read = vi.fn();
  const reopening = saveDrawingSessions(path).then(read);
  await vi.waitFor(() => expect(saveDrawing).toHaveBeenCalledTimes(1));
  expect(read).not.toHaveBeenCalled();
  finish();
  await reopening;
  expect(read).toHaveBeenCalledTimes(1);
});

test("delete waits for an already requested save before removing the file", async () => {
  let finish!: () => void;
  vi.mocked(saveDrawing).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const session = createDrawingSession(path, initial());
  session.change(elements(1), state, {});
  const unregister = registerDrawingSession(path, session.save, session.settled);
  const saving = session.save();
  const deleting = deleteEntryAfterDrawingWrites(path);
  await vi.waitFor(() => expect(saveDrawing).toHaveBeenCalledTimes(1));
  expect(deleteEntry).not.toHaveBeenCalled();
  finish();
  await Promise.all([saving, deleting]);
  expect(deleteEntry).toHaveBeenCalledWith(path);
  unregister();
  await saveDrawingSessions();
  expect(saveDrawing).toHaveBeenCalledTimes(1);
});
