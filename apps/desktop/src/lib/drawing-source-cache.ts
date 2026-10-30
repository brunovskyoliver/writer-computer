import type { DrawingScene } from "./drawings";

export interface DrawingPreview {
  scene: DrawingScene;
  url: string;
}
export interface DrawingLease {
  result: Promise<DrawingPreview>;
  release(): void;
}
interface Entry {
  path: string;
  refs: number;
  controller: AbortController;
  result: Promise<DrawingPreview>;
  resolve(value: DrawingPreview): void;
  reject(error: unknown): void;
  preview?: DrawingPreview;
  bytes: number;
}

/** One owner for concurrent work, retained scenes and leased object URLs. */
export function createDrawingSourceCache(
  deps: {
    load(
      path: string,
      signal: AbortSignal,
    ): Promise<{ scene: DrawingScene; svg: string; bytes: number }>;
    createUrl(svg: string): string;
    revokeUrl(url: string): void;
  },
  limits = { entries: 12, bytes: 32 * 1024 * 1024, jobs: 2 },
) {
  const current = new Map<string, Entry>();
  const retained = new Set<Entry>();
  const listeners = new Map<string, Set<() => void>>();
  const queue: Entry[] = [];
  let jobs = 0;
  let bytes = 0;

  const dispose = (entry: Entry) => {
    if (!retained.has(entry)) return;
    if (current.get(entry.path) === entry) current.delete(entry.path);
    entry.controller.abort();
    entry.reject(new Error("Drawing load cancelled."));
    const index = queue.indexOf(entry);
    if (index >= 0) queue.splice(index, 1);
    if (entry.preview) deps.revokeUrl(entry.preview.url);
    bytes -= entry.bytes;
    entry.bytes = 0;
    retained.delete(entry);
  };
  const pump = () => {
    while (jobs < limits.jobs && queue.length > 0) {
      const entry = queue.shift()!;
      if (entry.controller.signal.aborted) continue;
      jobs++;
      void deps
        .load(entry.path, entry.controller.signal)
        .then((loaded) => {
          if (entry.controller.signal.aborted) return;
          const activeBytes = [...current.values()].reduce((sum, item) => sum + item.bytes, 0);
          // Keep one bounded reserve for old images still leased by the UI.
          // One drawing alone may exceed the budget: closing others couldn't make it fit.
          const alone = activeBytes === 0 && bytes === 0;
          const fits =
            loaded.bytes <= limits.bytes - activeBytes && loaded.bytes <= 2 * limits.bytes - bytes;
          if (!alone && !fits)
            throw new Error("Too many large drawings are open. Close a drawing and retry.");
          const url = deps.createUrl(loaded.svg);
          entry.bytes = loaded.bytes;
          bytes += entry.bytes;
          entry.preview = { scene: loaded.scene, url };
          entry.resolve(entry.preview);
        })
        .catch((error: unknown) => entry.reject(error))
        .finally(() => {
          jobs--;
          pump();
        });
    }
  };
  const invalidate = (path?: string) => {
    for (const entry of current.values()) {
      if (path && entry.path !== path) continue;
      current.delete(entry.path);
      entry.controller.abort();
      entry.reject(new Error("Drawing changed while loading."));
      // A displayed URL belongs to its leases until their consumers replace it.
      if (entry.refs === 0) dispose(entry);
    }
    const callbacks = path
      ? [...(listeners.get(path) ?? [])]
      : [...listeners.values()].flatMap((set) => [...set]);
    for (const notify of callbacks) notify();
  };
  return {
    acquire(path: string): DrawingLease {
      let entry = current.get(path);
      if (!entry) {
        if (current.size >= limits.entries || retained.size >= 2 * limits.entries) {
          return {
            result: Promise.reject(
              new Error("Too many drawings are open. Close a drawing and retry."),
            ),
            release() {},
          };
        }
        let resolve!: Entry["resolve"];
        let reject!: Entry["reject"];
        const result = new Promise<DrawingPreview>((yes, no) => {
          resolve = yes;
          reject = no;
        });
        entry = {
          path,
          refs: 0,
          result,
          resolve,
          reject,
          bytes: 0,
          controller: new AbortController(),
        };
        current.set(path, entry);
        retained.add(entry);
        queue.push(entry);
      }
      entry.refs++;
      pump();
      let released = false;
      return {
        result: entry.result,
        release() {
          if (released) return;
          released = true;
          if (--entry.refs === 0) dispose(entry);
        },
      };
    },
    invalidate,
    subscribe(path: string, notify: () => void): () => void {
      const set = listeners.get(path) ?? new Set<() => void>();
      listeners.set(path, set);
      set.add(notify);
      return () => {
        set.delete(notify);
        if (set.size === 0) listeners.delete(path);
      };
    },
    reset() {
      for (const entry of retained) dispose(entry);
      current.clear();
      queue.length = 0;
      // Subscribers belong to mounted views and remove themselves on unmount.
    },
  };
}
