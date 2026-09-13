import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
vi.mock("../src/lib/tauri", () => ({ deleteEntry: vi.fn(async () => {}) }));
import { deleteEntry } from "../src/lib/tauri";
vi.mock("../src/lib/drawings", () => ({ saveDrawing: vi.fn(async () => {}) }));
import { saveDrawing } from "../src/lib/drawings";
import {
  attachDrawingView,
  changeDrawing,
  deleteEntryAfterDrawingWrites,
  discardDrawingSessions,
  getDrawingSession,
  hasDrawingSession,
  saveDrawingSessions,
  withDrawingSaveBoundary,
  type DrawingViewHandle,
} from "../src/lib/drawing-sessions";

const path = "/drawing.excalidraw.svg";
const initial = () => ({ elements: [], appState: {}, files: {} });
const elements = (version: number) =>
  [
    { id: "stroke", version, isDeleted: false, points: [[0, version]] },
  ] as unknown as OrderedExcalidrawElement[];
const state = {} as AppState;

/** A stand-in for a mounted Excalidraw instance: records what the session
 *  pushes at it, so sibling propagation is observable without a canvas. */
function spyView() {
  const applied: { elements: readonly unknown[]; files: BinaryFiles }[] = [];
  const handle: DrawingViewHandle = {
    applyScene: (scene) => applied.push(scene),
  };
  return { handle, applied };
}

/** Attach a view and return everything a test needs to drive it. */
function attach(viewId: string, scene = initial()) {
  const view = spyView();
  const attached = attachDrawingView(path, viewId, scene, view.handle);
  return { ...view, ...attached, viewId };
}

afterEach(() => {
  discardDrawingSessions(path);
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("explicit drawing persistence", () => {
  test("1000 changes do not traverse the scene, schedule timers or write", async () => {
    vi.useFakeTimers();
    attach("tab-a");
    const read = vi.fn();
    const strokes = new Proxy(elements(1), {
      get(target, key, receiver) {
        // The echo fingerprint is allowed to read length and the last element;
        // anything beyond that is a per-stroke traversal.
        if (key !== "length" && key !== "0") read(key);
        return Reflect.get(target, key, receiver);
      },
    });
    for (let i = 0; i < 1000; i++) changeDrawing(path, "tab-a", strokes, state, {});
    expect(read).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(saveDrawing).not.toHaveBeenCalled();
    await getDrawingSession(path)!.save();
    expect(saveDrawing).toHaveBeenCalledTimes(1);
  });

  test("captures mutable elements and files before yielding; saves newer edits separately", async () => {
    attach("tab-a");
    const session = getDrawingSession(path)!;
    const strokes = elements(1);
    const files = { image: { dataURL: "before" } } as unknown as BinaryFiles;
    changeDrawing(path, "tab-a", strokes, state, files);
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
    attach("tab-a");
    changeDrawing(path, "tab-a", elements(1), state, {});
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
    attach("tab-a");
    changeDrawing(path, "tab-a", elements(1), state, {});
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
    attach("tab-a", { ...initial(), elements: elements(1) as never });
    const session = getDrawingSession(path)!;
    changeDrawing(path, "tab-a", [], state, {});
    await session.save();
    expect(saveDrawing).not.toHaveBeenCalled();
    changeDrawing(path, "tab-a", elements(1), state, {});
    changeDrawing(path, "tab-a", [], state, {});
    await session.save();
    expect(saveDrawing).toHaveBeenCalledWith(path, expect.objectContaining({ elements: [] }));
  });

  test("deleted paths are not recreated on unmount", async () => {
    const view = attach("tab-a");
    changeDrawing(path, "tab-a", elements(1), state, {});
    discardDrawingSessions(path);
    view.detach();
    await saveDrawingSessions();
    expect(saveDrawing).not.toHaveBeenCalled();
  });
});

describe("one session per path, many views", () => {
  test("a second view joins the live scene rather than the copy on disk", () => {
    attach("tab-a");
    changeDrawing(path, "tab-a", elements(7), state, {});

    // The disk read the second pane performs is stale by the time it attaches.
    const second = attach("tab-b", initial());
    expect(second.scene.elements).toEqual(elements(7));
  });

  test("an edit in one view is pushed into the other, with its assets", () => {
    const a = attach("tab-a");
    const b = attach("tab-b");
    const files = { image: { dataURL: "data:," } } as unknown as BinaryFiles;

    changeDrawing(path, "tab-a", elements(2), state, files);

    expect(b.applied).toHaveLength(1);
    expect(b.applied[0]!.elements).toEqual(elements(2));
    expect(b.applied[0]!.files).toBe(files);
    // The originating view is never asked to apply its own edit.
    expect(a.applied).toHaveLength(0);
  });

  test("a view echoing back the scene it was just given does not loop", () => {
    const a = attach("tab-a");
    const b = attach("tab-b");

    changeDrawing(path, "tab-a", elements(3), state, {});
    const echoed = b.applied[0]!.elements as OrderedExcalidrawElement[];
    // Excalidraw reports the applied `updateScene` back through `onChange`.
    changeDrawing(path, "tab-b", echoed, state, {});

    expect(a.applied).toHaveLength(0);
    expect(b.applied).toHaveLength(1);
  });

  test("a genuine edit from the receiving view still propagates", () => {
    const a = attach("tab-a");
    const b = attach("tab-b");

    changeDrawing(path, "tab-a", elements(3), state, {});
    changeDrawing(path, "tab-b", elements(4), state, {});

    expect(a.applied).toHaveLength(1);
    expect(a.applied[0]!.elements).toEqual(elements(4));
  });

  test("two views share one export queue, so a save writes once", async () => {
    attach("tab-a");
    attach("tab-b");
    changeDrawing(path, "tab-a", elements(1), state, {});

    await saveDrawingSessions(path);

    expect(saveDrawing).toHaveBeenCalledTimes(1);
  });

  test("dirty state is shared: saving through either view settles both", async () => {
    attach("tab-a");
    attach("tab-b");
    changeDrawing(path, "tab-b", elements(1), state, {});
    const session = getDrawingSession(path)!;
    expect(session.isDirty()).toBe(true);

    await session.save();

    expect(session.isDirty()).toBe(false);
    await saveDrawingSessions(path);
    expect(saveDrawing).toHaveBeenCalledTimes(1);
  });

  test("detaching a view does not write — a tab move must not save", async () => {
    const a = attach("tab-a");
    attach("tab-b");
    changeDrawing(path, "tab-a", elements(1), state, {});

    a.detach();
    await Promise.resolve();

    expect(saveDrawing).not.toHaveBeenCalled();
    // The remaining view still owns a live, dirty session.
    expect(getDrawingSession(path)?.isDirty()).toBe(true);
  });

  test("a clean session is released once its last view detaches", () => {
    const a = attach("tab-a");
    expect(hasDrawingSession(path)).toBe(true);
    a.detach();
    expect(hasDrawingSession(path)).toBe(false);
  });

  test("a dirty session outlives its views so quit can still flush it", async () => {
    const a = attach("tab-a");
    changeDrawing(path, "tab-a", elements(1), state, {});
    a.detach();

    expect(hasDrawingSession(path)).toBe(true);
    await saveDrawingSessions();
    expect(saveDrawing).toHaveBeenCalledTimes(1);
    // Written and unattached: nothing left to own.
    expect(hasDrawingSession(path)).toBe(false);
  });

  test("a later save completion cannot mark newer content clean", async () => {
    let finish!: () => void;
    vi.mocked(saveDrawing).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    attach("tab-a");
    const session = getDrawingSession(path)!;
    changeDrawing(path, "tab-a", elements(1), state, {});
    const first = session.save();
    await vi.waitFor(() => expect(saveDrawing).toHaveBeenCalledTimes(1));

    // Edited while that export is still in flight.
    changeDrawing(path, "tab-a", elements(2), state, {});
    finish();
    await first;

    expect(session.isDirty()).toBe(true);
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
  const view = attach("tab-a");
  changeDrawing(path, "tab-a", elements(1), state, {});
  const saving = getDrawingSession(path)!.save();
  view.detach();
  const read = vi.fn();
  const reopening = saveDrawingSessions(path).then(read);
  await vi.waitFor(() => expect(saveDrawing).toHaveBeenCalledTimes(1));
  expect(read).not.toHaveBeenCalled();
  finish();
  await Promise.all([saving, reopening]);
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
  const view = attach("tab-a");
  changeDrawing(path, "tab-a", elements(1), state, {});
  const saving = getDrawingSession(path)!.save();
  const deleting = deleteEntryAfterDrawingWrites(path);
  await vi.waitFor(() => expect(saveDrawing).toHaveBeenCalledTimes(1));
  expect(deleteEntry).not.toHaveBeenCalled();
  finish();
  await Promise.all([saving, deleting]);
  expect(deleteEntry).toHaveBeenCalledWith(path);
  view.detach();
  await saveDrawingSessions();
  expect(saveDrawing).toHaveBeenCalledTimes(1);
});
