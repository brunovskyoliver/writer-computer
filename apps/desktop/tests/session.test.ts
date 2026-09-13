import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import {
  createSessionPersister,
  decodeSession,
  encodeSession,
  focusedSessionFile,
  parseSession,
  pruneSession,
  type SessionV2,
} from "../src/lib/session";
import { createLayout, splitPaneWithTab, validateLayout } from "../src/lib/editor-layout";
import { createFileTab, createLauncherTab } from "../src/stores/editor-store";

const FIXTURES = join(import.meta.dirname, "../../../SPECs/tab-tiling-splits/fixtures/sessions");

interface Fixture {
  description: string;
  input: unknown;
  missing_files?: string[];
  expected: {
    status: "ready" | "malformed" | "missing";
    session?: SessionV2 | null;
    focused_file?: string | null;
  };
}

function loadFixtures(): Array<[string, Fixture]> {
  return readdirSync(FIXTURES)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => [name, JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as Fixture]);
}

// ---------------------------------------------------------------------------
// Shared fixtures: the same cases Rust runs
// ---------------------------------------------------------------------------

describe("session fixtures", () => {
  const fixtures = loadFixtures();

  test("the fixture directory is not empty", () => {
    expect(fixtures.length).toBeGreaterThan(20);
  });

  test.each(fixtures)("%s", (_name, fixture) => {
    const record = parseSession(fixture.input);
    expect(record.status).toBe(fixture.expected.status);
    if (record.status !== "ready") {
      if (record.status === "malformed") expect(record.problems.length).toBeGreaterThan(0);
      return;
    }

    const missing = new Set(fixture.missing_files ?? []);
    const pruned = pruneSession(record.session, (path) => missing.has(path));
    expect(pruned).toEqual(fixture.expected.session ?? null);
    expect(pruned ? focusedSessionFile(pruned) : null).toBe(fixture.expected.focused_file ?? null);
  });
});

// ---------------------------------------------------------------------------
// Runtime codec
// ---------------------------------------------------------------------------

describe("session codec", () => {
  test("encodes a nested layout and decodes it back to the same shape with fresh ids", () => {
    const a = createFileTab("/vault/a.md");
    const b = createFileTab("/vault/b.md");
    const launcher = createLauncherTab();
    const tabs = [a, b, launcher];
    let layout = createLayout([a.id, b.id, launcher.id], b.id);
    layout = splitPaneWithTab(layout, layout.focusedPaneId, "x", "after", b.id);
    layout = { ...layout, root: { ...layout.root, ratio: 0.3 } as typeof layout.root };

    const encoded = encodeSession(tabs, layout);
    expect(encoded).not.toBeNull();
    // Launcher tabs never persist.
    expect(encoded!.tabs.map((tab) => tab.location.kind)).toEqual(["file", "file"]);
    expect(encoded!.layout.root.kind).toBe("split");
    if (encoded!.layout.root.kind !== "split") return;
    expect(encoded!.layout.root.ratio).toBe(0.3);
    expect(parseSession(encoded).status).toBe("ready");

    let minted = 0;
    const decoded = decodeSession(encoded!, () => `fresh-${++minted}`);
    expect(decoded.pruned).toEqual([]);
    expect(decoded.tabs.map((tab) => tab.id)).toEqual(["fresh-1", "fresh-2"]);
    expect(validateLayout(decoded.layout)).toEqual([]);
    expect(decoded.layout.root.kind).toBe("split");
    if (decoded.layout.root.kind !== "split") return;
    expect(decoded.layout.root.ratio).toBe(0.3);
    // Ids are re-minted, so nothing from the record can collide with live ids.
    expect(decoded.layout.root.id).not.toBe(encoded!.layout.root.id);
    expect(decoded.layout.focusedPaneId).toBe(decoded.layout.root.children[1].id);
  });

  test("removing the launcher can empty a pane, which collapses in the snapshot", () => {
    const a = createFileTab("/vault/a.md");
    const launcher = createLauncherTab();
    let layout = createLayout([a.id, launcher.id], a.id);
    layout = splitPaneWithTab(layout, layout.focusedPaneId, "y", "after", launcher.id);

    const encoded = encodeSession([a, launcher], layout);
    expect(encoded!.layout.root.kind).toBe("pane");
    expect(encoded!.layout.focused_pane_id).toBe(encoded!.layout.root.id);
  });

  test("a window with only a launcher persists nothing", () => {
    const launcher = createLauncherTab();
    expect(encodeSession([launcher], createLayout([launcher.id]))).toBeNull();
  });

  test("an unsupported page kind is pruned with a diagnostic and its pane collapses", () => {
    const session: SessionV2 = {
      version: 2,
      tabs: [
        { id: "t1", location: { kind: "file", path: "/vault/a.md" }, back: [], forward: [] },
        { id: "t2", location: { kind: "hologram", path: "/vault/h" }, back: [], forward: [] },
      ],
      layout: {
        root: {
          kind: "split",
          id: "s1",
          axis: "x",
          ratio: 0.5,
          children: [
            { kind: "pane", id: "p1", tab_ids: ["t1"], active_tab_id: "t1" },
            { kind: "pane", id: "p2", tab_ids: ["t2"], active_tab_id: "t2" },
          ],
        },
        focused_pane_id: "p2",
      },
    };
    const decoded = decodeSession(session, () => "fresh");
    expect(decoded.pruned).toEqual(["tab t2: unsupported page kind hologram"]);
    expect(decoded.tabs).toHaveLength(1);
    expect(decoded.layout.root.kind).toBe("pane");
    expect(validateLayout(decoded.layout)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Persistence boundary
// ---------------------------------------------------------------------------

describe("session persister", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const snapshot = (name: string): SessionV2 => ({
    version: 2,
    tabs: [
      { id: "t", location: { kind: "file", path: `/vault/${name}.md` }, back: [], forward: [] },
    ],
    layout: {
      root: { kind: "pane", id: "p", tab_ids: ["t"], active_tab_id: "t" },
      focused_pane_id: "p",
    },
  });

  test("coalesces a burst of snapshots into one write of the latest after 500 ms", async () => {
    const write = vi.fn(async () => {});
    const persister = createSessionPersister(write);

    persister.schedule("/ws", snapshot("one"));
    vi.advanceTimersByTime(300);
    persister.schedule("/ws", snapshot("two"));
    vi.advanceTimersByTime(499);
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await vi.advanceTimersByTimeAsync(0);

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("/ws", snapshot("two"));
  });

  test("flush writes the queued snapshot now and serializes behind an in-flight write", async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => {};
    const write = vi.fn((_root: string, session: SessionV2 | null) => {
      const name = session?.tabs[0]?.location.path as string;
      order.push(`start ${name}`);
      if (name === "/vault/one.md") {
        return new Promise<void>((resolve) => {
          releaseFirst = () => {
            order.push("end one");
            resolve();
          };
        });
      }
      order.push(`end ${name}`);
      return Promise.resolve();
    });
    const persister = createSessionPersister(write);

    persister.schedule("/ws", snapshot("one"));
    void persister.flush();
    persister.schedule("/ws", snapshot("two"));
    const second = persister.flush();
    await vi.advanceTimersByTimeAsync(0);
    // The second write waits for the first.
    expect(order).toEqual(["start /vault/one.md"]);

    releaseFirst();
    await second;
    expect(order).toEqual([
      "start /vault/one.md",
      "end one",
      "start /vault/two.md",
      "end /vault/two.md",
    ]);
  });

  test("cancel drops the queued snapshot so a reset workspace is never written", async () => {
    const write = vi.fn(async () => {});
    const persister = createSessionPersister(write);

    persister.schedule("/old", snapshot("stale"));
    persister.cancel();
    vi.advanceTimersByTime(1000);
    await persister.flush();

    expect(write).not.toHaveBeenCalled();
  });

  test("a failed write is reported, not thrown into the next one", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const write = vi
      .fn<(root: string, s: SessionV2 | null) => Promise<void>>()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValue(undefined);
    const persister = createSessionPersister(write);

    persister.schedule("/ws", snapshot("one"));
    await persister.flush();
    persister.schedule("/ws", snapshot("two"));
    await persister.flush();

    expect(write).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
