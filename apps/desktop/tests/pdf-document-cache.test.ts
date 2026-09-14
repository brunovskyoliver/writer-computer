import { beforeEach, expect, test, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({ destroy: vi.fn(async () => {}), loads: 0 }));

vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (path: string) => `asset://${path}` }));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {} as { workerSrc?: string },
  getDocument: () => {
    fixture.loads += 1;
    return { promise: Promise.resolve({ numPages: 3 }), destroy: fixture.destroy };
  },
}));

import { acquirePdf, cachedPdfCount, releasePdf } from "../src/lib/pdf";

const PATH = "/ws/paper.pdf";

beforeEach(() => {
  fixture.loads = 0;
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
