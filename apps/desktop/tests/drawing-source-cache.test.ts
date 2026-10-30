import { expect, test, vi } from "vite-plus/test";
import { createDrawingSourceCache } from "../src/lib/drawing-source-cache";
import type { DrawingScene } from "../src/lib/drawings";

const scene: DrawingScene = { elements: [], appState: {}, files: {} };
const loaded = { scene, svg: "<svg/>", bytes: 10 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup() {
  const jobs: Array<ReturnType<typeof deferred<typeof loaded>> & { signal: AbortSignal }> = [];
  const load = vi.fn((_path: string, signal: AbortSignal) => {
    const job = { ...deferred<typeof loaded>(), signal };
    jobs.push(job);
    return job.promise;
  });
  let serial = 0;
  const createUrl = vi.fn(() => `blob:${++serial}`);
  const revokeUrl = vi.fn();
  const cache = createDrawingSourceCache(
    { load, createUrl, revokeUrl },
    { entries: 3, bytes: 20, jobs: 1 },
  );
  return { cache, jobs, load, createUrl, revokeUrl };
}
const flush = async () => {
  for (let n = 0; n < 5; n++) await Promise.resolve();
};

test("two consumers share work and retain the URL until the final release", async () => {
  const { cache, jobs, load, revokeUrl } = setup();
  const a = cache.acquire("a");
  const b = cache.acquire("a");
  expect(load).toHaveBeenCalledTimes(1);
  jobs[0]!.resolve(loaded);
  expect(await a.result).toBe(await b.result);
  a.release();
  a.release();
  expect(revokeUrl).not.toHaveBeenCalled();
  b.release();
  expect(revokeUrl).toHaveBeenCalledExactlyOnceWith("blob:1");
});

test("invalidation replaces data without revoking a still-displayed URL", async () => {
  const { cache, jobs, revokeUrl } = setup();
  const notify = vi.fn();
  const unsubscribe = cache.subscribe("a", notify);
  const a = cache.acquire("a");
  jobs[0]!.resolve(loaded);
  await a.result;
  await flush();
  cache.invalidate("a");
  expect(notify).toHaveBeenCalledTimes(1);
  expect(revokeUrl).not.toHaveBeenCalled();
  const b = cache.acquire("a");
  jobs[1]!.resolve(loaded);
  expect((await b.result).url).toBe("blob:2");
  a.release();
  expect(revokeUrl).toHaveBeenCalledExactlyOnceWith("blob:1");
  unsubscribe();
  cache.invalidate("a");
  expect(notify).toHaveBeenCalledTimes(1);
  b.release();
  expect(revokeUrl).toHaveBeenCalledTimes(2);
});

test("a reset cancels queued work and rejects late results without creating URLs", async () => {
  const { cache, jobs, load, createUrl } = setup();
  const a = cache.acquire("a");
  const b = cache.acquire("b");
  const outcomes = Promise.allSettled([a.result, b.result]);
  cache.reset();
  expect(jobs[0]!.signal.aborted).toBe(true);
  expect((await outcomes).every((value) => value.status === "rejected")).toBe(true);
  jobs[0]!.resolve(loaded);
  await flush();
  expect(load).toHaveBeenCalledTimes(1);
  expect(createUrl).not.toHaveBeenCalled();
  a.release();
  b.release();
  const c = cache.acquire("c");
  jobs[1]!.resolve(loaded);
  await c.result;
  c.release();
});

test("entry and byte limits reject excess work and recover after release", async () => {
  const { cache, jobs, load, createUrl } = setup();
  const a = cache.acquire("a");
  const b = cache.acquire("b");
  const c = cache.acquire("c");
  const excess = cache.acquire("d");
  await expect(excess.result).rejects.toThrow("Too many drawings");
  expect(load).toHaveBeenCalledTimes(1);
  jobs[0]!.resolve(loaded);
  await a.result;
  await flush();
  jobs[1]!.resolve(loaded);
  await b.result;
  await flush();
  jobs[2]!.resolve(loaded);
  await expect(c.result).rejects.toThrow("Too many large drawings");
  expect(createUrl).toHaveBeenCalledTimes(2);
  c.release();
  a.release();
  b.release();
  await flush();
  const d = cache.acquire("d");
  jobs[3]!.resolve(loaded);
  await d.result;
  d.release();
});

test("one drawing alone may exceed the byte budget, but nothing joins it", async () => {
  const { cache, jobs } = setup();
  const huge = cache.acquire("huge");
  jobs[0]!.resolve({ ...loaded, bytes: 100 });
  expect((await huge.result).url).toBe("blob:1");
  await flush();
  const other = cache.acquire("other");
  jobs[1]!.resolve(loaded);
  await expect(other.result).rejects.toThrow("Too many large drawings");
  other.release();
  huge.release();
  await flush();
  const after = cache.acquire("other");
  jobs[2]!.resolve(loaded);
  await after.result;
  after.release();
});

test("failure, invalidation and retry cannot return a previous successful scene", async () => {
  const { cache, jobs } = setup();
  const a = cache.acquire("a");
  jobs[0]!.resolve(loaded);
  await a.result;
  await flush();
  cache.invalidate("a");
  const b = cache.acquire("a");
  jobs[1]!.reject(new Error("corrupt source"));
  await expect(b.result).rejects.toThrow("corrupt source");
  a.release();
  b.release();
  await flush();
  const c = cache.acquire("a");
  jobs[2]!.resolve(loaded);
  expect((await c.result).url).toBe("blob:2");
  c.release();
});

test("a full cache can replace its only drawing while the previous image is displayed", async () => {
  let serial = 0;
  const revokeUrl = vi.fn();
  const cache = createDrawingSourceCache(
    { load: async () => loaded, createUrl: () => `blob:${++serial}`, revokeUrl },
    { entries: 1, bytes: 10, jobs: 1 },
  );
  const old = cache.acquire("a");
  await old.result;
  cache.invalidate("a");
  const fresh = cache.acquire("a");
  expect((await fresh.result).url).toBe("blob:2");
  expect(revokeUrl).not.toHaveBeenCalled();
  old.release();
  expect(revokeUrl).toHaveBeenCalledExactlyOnceWith("blob:1");
  fresh.release();
});
