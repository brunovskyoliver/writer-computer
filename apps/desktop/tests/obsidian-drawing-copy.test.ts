import { expect, test, vi } from "vite-plus/test";
vi.mock("../src/lib/tauri", () => ({ writeFile: vi.fn(), readDrawingSource: vi.fn() }));
import { writeFile } from "../src/lib/tauri";
import { FileConflictError } from "../src/lib/file-conflict";
import { publishDrawingCopy, decodeObsidianDrawing } from "../src/lib/obsidian-drawings";

const original = "/vault/Drawings/Course.excalidraw.md";
const svg = "<svg>embedded scene</svg>";

test("early and publication collisions retry separate copy names with missing-file preconditions", async () => {
  const write = vi.mocked(writeFile).mockReset();
  write.mockRejectedValueOnce(new FileConflictError("existing copy"));
  write.mockRejectedValueOnce("Already exists: /vault/Drawings/Course-1.excalidraw.svg");
  write.mockResolvedValueOnce({ path: "/vault/Drawings/Course-2.excalidraw.svg", modified_at: 1 });
  expect(await publishDrawingCopy(original, svg, () => true)).toBe(
    "/vault/Drawings/Course-2.excalidraw.svg",
  );
  expect(write.mock.calls).toEqual([
    ["/vault/Drawings/Course.excalidraw.svg", svg, null],
    ["/vault/Drawings/Course-1.excalidraw.svg", svg, null],
    ["/vault/Drawings/Course-2.excalidraw.svg", svg, null],
  ]);
});

test("an IO error is surfaced without creating another copy", async () => {
  const write = vi.mocked(writeFile).mockReset().mockRejectedValue("permission denied");
  await expect(publishDrawingCopy(original, svg, () => true)).rejects.toBe("permission denied");
  expect(write).toHaveBeenCalledTimes(1);
});

test("stale origins stop before the first write and between collisions", async () => {
  const write = vi.mocked(writeFile).mockReset();
  expect(await publishDrawingCopy(original, svg, () => false)).toBeNull();
  expect(write).not.toHaveBeenCalled();
  let current = true;
  write.mockImplementationOnce(async () => {
    current = false;
    throw new FileConflictError("other");
  });
  expect(await publishDrawingCopy(original, svg, () => current)).toBeNull();
  expect(write).toHaveBeenCalledTimes(1);
});

test("decoder timeout terminates its worker and a later request can succeed", async () => {
  vi.useFakeTimers();
  const worker = {
    postMessage: vi.fn(),
    terminate: vi.fn(),
    onmessage: null,
    onerror: null,
  } as unknown as Pick<Worker, "postMessage" | "terminate" | "onmessage" | "onerror">;
  try {
    const result = decodeObsidianDrawing("source", new AbortController().signal, () => worker);
    const rejected = expect(result).rejects.toThrow("too long");
    await vi.advanceTimersByTimeAsync(6000);
    await rejected;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(worker.onmessage).toBeNull();
    const next = decodeObsidianDrawing("retry", new AbortController().signal, () => worker);
    const scene = { elements: [], appState: {}, files: {} };
    worker.onmessage!.call(worker as Worker, { data: { ok: true, scene } } as MessageEvent);
    expect(await next).toEqual(scene);
    expect(worker.terminate).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

test("cancelling decoder work terminates it without accepting another result", async () => {
  const controller = new AbortController();
  const worker = {
    postMessage: vi.fn(),
    terminate: vi.fn(),
    onmessage: null,
    onerror: null,
  } as unknown as Pick<Worker, "postMessage" | "terminate" | "onmessage" | "onerror">;
  const result = decodeObsidianDrawing("source", controller.signal, () => worker);
  controller.abort();
  await expect(result).rejects.toThrow("cancelled");
  expect(worker.terminate).toHaveBeenCalledTimes(1);
  expect(worker.onmessage).toBeNull();
});
