import { beforeEach, expect, test, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  destroy: vi.fn(async () => {}),
  loads: 0,
  terminated: 0,
  spawned: 0,
}));

vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (path: string) => `asset://${path}` }));
vi.mock("../src/lib/pdf-worker?worker", () => ({
  default: class {
    constructor() {
      fixture.spawned += 1;
    }
    terminate() {
      fixture.terminated += 1;
    }
  },
}));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {} as { workerSrc?: string; workerPort?: { terminate(): void } | null },
  getDocument: () => {
    fixture.loads += 1;
    return { promise: Promise.resolve({ numPages: 3 }), destroy: fixture.destroy };
  },
}));

import { acquirePdf, cachedPdfCount, pdfRetentionSnapshot, releasePdf } from "../src/lib/pdf";

const PATH = "/ws/paper.pdf";

beforeEach(async () => {
  // Drop any reference a failed test leaked so module state starts clean.
  while (cachedPdfCount() > 0) await releasePdf(PATH);
  fixture.loads = 0;
  fixture.terminated = 0;
  fixture.spawned = 0;
  vi.clearAllMocks();
});

/**
 * The refcount is the one branch in `lib/pdf.ts` a caller can get wrong in a
 * way nothing else catches: an unbalanced release leaves a live tab holding a
 * destroyed document. Nothing about that is visible from the outside except
 * through the cache count.
 */
test("a document is shared across tabs and destroyed only by the last release", async () => {
  const first = await acquirePdf(PATH);
  const second = await acquirePdf(PATH);

  expect(first.ok && first.doc.pageCount).toBe(3);
  expect(second).toBe(first);
  expect(fixture.loads).toBe(1);
  expect(cachedPdfCount()).toBe(1);

  await releasePdf(PATH);
  expect(cachedPdfCount()).toBe(1);
  expect(fixture.destroy).not.toHaveBeenCalled();

  await releasePdf(PATH);
  expect(cachedPdfCount()).toBe(0);
  expect(fixture.destroy).toHaveBeenCalledTimes(1);
});

test("releasing a path nobody holds is a no-op, not a negative refcount", async () => {
  await releasePdf(PATH);
  expect(cachedPdfCount()).toBe(0);
  expect(fixture.destroy).not.toHaveBeenCalled();
});

test("re-acquiring after the last release starts a fresh load", async () => {
  await acquirePdf(PATH);
  await releasePdf(PATH);
  await acquirePdf(PATH);

  expect(fixture.loads).toBe(2);
  expect(cachedPdfCount()).toBe(1);
  await releasePdf(PATH);
});

test("the worker idles out after the last release and respawns on demand", async () => {
  vi.useFakeTimers();
  try {
    await acquirePdf(PATH);
    await releasePdf(PATH);
    expect(cachedPdfCount()).toBe(0);

    // Still inside the idle grace — the worker stays warm.
    expect(pdfRetentionSnapshot().workerAlive).toBe(true);
    const terminatedBefore = fixture.terminated;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(fixture.terminated).toBe(terminatedBefore + 1);
    expect(pdfRetentionSnapshot().workerAlive).toBe(false);

    // The next acquire rebuilds it; that worker gets its own idle cycle.
    const spawnedBefore = fixture.spawned;
    await acquirePdf(PATH);
    expect(fixture.spawned).toBe(spawnedBefore + 1);
    expect(pdfRetentionSnapshot().workerAlive).toBe(true);
    await releasePdf(PATH);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(fixture.terminated).toBe(terminatedBefore + 2);
  } finally {
    vi.useRealTimers();
  }
});

test("an acquire inside the idle grace keeps the worker alive", async () => {
  vi.useFakeTimers();
  try {
    const terminatedBefore = fixture.terminated;
    await acquirePdf(PATH);
    await releasePdf(PATH);
    await vi.advanceTimersByTimeAsync(10_000);

    await acquirePdf(PATH);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(fixture.terminated).toBe(terminatedBefore);

    await releasePdf(PATH);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(fixture.terminated).toBe(terminatedBefore + 1);
  } finally {
    vi.useRealTimers();
  }
});
