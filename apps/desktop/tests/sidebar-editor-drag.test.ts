import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import {
  EDGE_BAND_MAX,
  buildFileDropCandidate,
  createLayout,
  createPane,
  createSplitId,
  findPane,
  layoutTabIds,
  paneOfTab,
  panes,
  resolveDropRegion,
  validateLayout,
  type Layout,
  type Rect,
  type Split,
} from "../src/lib/editor-layout";
import {
  createDragCoordinator,
  resolveFileDrop,
  type DragAdapter,
  type DragCoordinator,
  type DragEnvironment,
  type EditorAreaGeometry,
} from "../src/hooks/use-editor-drag";
import {
  createFileTab,
  type FileDrop,
  type FileDropOutcome,
  type Tab,
} from "../src/stores/editor-store";

// --- pure region resolution -------------------------------------------------

describe("resolveDropRegion", () => {
  const rect: Rect = { x: 0, y: 0, width: 1000, height: 600 };

  it("is null outside the body", () => {
    expect(resolveDropRegion(rect, { x: -1, y: 10 })).toBeNull();
    expect(resolveDropRegion(rect, { x: 10, y: 601 })).toBeNull();
  });

  it("resolves the four edges and the centre", () => {
    expect(resolveDropRegion(rect, { x: 10, y: 300 })).toBe("left");
    expect(resolveDropRegion(rect, { x: 990, y: 300 })).toBe("right");
    expect(resolveDropRegion(rect, { x: 500, y: 10 })).toBe("top");
    expect(resolveDropRegion(rect, { x: 500, y: 590 })).toBe("bottom");
    expect(resolveDropRegion(rect, { x: 500, y: 300 })).toBe("center");
  });

  it("caps the edge band at 80 px so the centre stays reachable", () => {
    // A quarter of 1000 is 250, but the band stops at EDGE_BAND_MAX.
    expect(resolveDropRegion(rect, { x: EDGE_BAND_MAX + 1, y: 300 })).toBe("center");
    expect(resolveDropRegion(rect, { x: EDGE_BAND_MAX - 1, y: 300 })).toBe("left");
  });

  it("uses a quarter of a small body when that is less than the cap", () => {
    const small: Rect = { x: 0, y: 0, width: 200, height: 200 };
    expect(resolveDropRegion(small, { x: 49, y: 100 })).toBe("left");
    expect(resolveDropRegion(small, { x: 51, y: 100 })).toBe("center");
  });

  it("breaks corner ties in the order left, right, top, bottom", () => {
    // Same normalized distance to the left and top edges: left wins.
    expect(resolveDropRegion(rect, { x: 20, y: 20 })).toBe("left");
    // Same to right and bottom: right wins.
    expect(resolveDropRegion(rect, { x: 980, y: 580 })).toBe("right");
    // Nearer the top than the right: top wins.
    expect(resolveDropRegion(rect, { x: 950, y: 5 })).toBe("top");
  });
});

// --- pure candidate building --------------------------------------------------

describe("buildFileDropCandidate", () => {
  const area: Rect = { x: 0, y: 0, width: 1000, height: 600 };

  it("splits on an edge, focuses the new pane, and previews its final allocation", () => {
    const layout = createLayout(["a"], "a");
    const candidate = buildFileDropCandidate(layout, layout.root.id, "right", area, [
      { tabId: "b", existingTabId: null },
      { tabId: "c", existingTabId: null },
    ]);
    expect(candidate).not.toBeNull();
    const created = paneOfTab(candidate!.layout, "b")!;
    expect(created.tabIds).toEqual(["b", "c"]);
    expect(created.activeTabId).toBe("b");
    expect(candidate!.layout.focusedPaneId).toBe(created.id);
    expect(candidate!.expectedRevision).toBe(layout.revision);
    expect(candidate!.previewRect).toEqual({ x: 498 + 4, y: 0, width: 498, height: 600 });
    expect(validateLayout(candidate!.layout)).toEqual([]);
  });

  it("opens at the centre without changing the tree and previews the whole body", () => {
    const layout = createLayout(["a"], "a");
    const candidate = buildFileDropCandidate(layout, layout.root.id, "center", area, [
      { tabId: "b", existingTabId: null },
    ]);
    expect(candidate).not.toBeNull();
    expect(panes(candidate!.layout)).toHaveLength(1);
    expect(layoutTabIds(candidate!.layout)).toEqual(["a", "b"]);
    expect(candidate!.previewRect).toEqual(area);
  });

  it("reuses an existing tab at the centre and makes the first file active", () => {
    const layout = createLayout(["a", "z"], "z");
    const candidate = buildFileDropCandidate(layout, layout.root.id, "center", area, [
      { tabId: "a2", existingTabId: "a" },
      { tabId: "b", existingTabId: null },
    ]);
    expect(layoutTabIds(candidate!.layout)).toEqual(["a", "z", "b"]);
    expect(findPane(candidate!.layout, layout.root.id)!.activeTabId).toBe("a");
  });

  it("offers no edge target when the split would fall below the pane minimum", () => {
    const layout = createLayout(["a"], "a");
    const narrow: Rect = { x: 0, y: 0, width: 400, height: 600 };
    expect(
      buildFileDropCandidate(layout, layout.root.id, "right", narrow, [
        { tabId: "b", existingTabId: null },
      ]),
    ).toBeNull();
    // The centre is still a target: nothing is being split.
    expect(
      buildFileDropCandidate(layout, layout.root.id, "center", narrow, [
        { tabId: "b", existingTabId: null },
      ]),
    ).not.toBeNull();
  });

  it("checks the target's own allocation inside a nested tree, not the whole window", () => {
    const left = createPane(["a"], "a", "left");
    const right = createPane(["b"], "b", "right");
    const root: Split = {
      kind: "split",
      id: createSplitId(),
      axis: "x",
      children: [left, right],
      ratio: 0.5,
    };
    const layout: Layout = { root, focusedPaneId: "left", revision: 3 };
    // 960 wide: each child has 478, and splitting that leaves 237 per side,
    // under the 240 minimum — even though 960 could host three panes in a row.
    const window: Rect = { x: 0, y: 0, width: 960, height: 600 };
    expect(
      buildFileDropCandidate(layout, "right", "right", window, [
        { tabId: "c", existingTabId: null },
      ]),
    ).toBeNull();
    // Stacking is fine: 600 tall leaves 298 per child, above the 160 minimum.
    const stacked = buildFileDropCandidate(layout, "right", "bottom", window, [
      { tabId: "c", existingTabId: null },
    ]);
    expect(stacked).not.toBeNull();
    expect(stacked!.previewRect).toEqual({ x: 482, y: 302, width: 478, height: 298 });
  });
});

// --- coordinator ----------------------------------------------------------------

interface Harness {
  window: EventTarget;
  frames: Array<() => void>;
  flushFrames: () => void;
  geometry: EditorAreaGeometry | null;
  layout: Layout;
  tabs: Tab[];
  workspaceGeneration: number;
  drops: FileDrop[];
  outcome: FileDropOutcome;
  suppressed: number;
  failures: string[];
  coordinator: DragCoordinator;
}

function pointer(type: string, x: number, y: number, pointerId = 1) {
  return Object.assign(new Event(type), { pointerId, clientX: x, clientY: y });
}

function createHarness(): Harness {
  const layout = createLayout(["a"], "a");
  const harness: Harness = {
    window: new EventTarget(),
    frames: [],
    flushFrames() {
      const pending = harness.frames;
      harness.frames = [];
      for (const frame of pending) frame();
    },
    geometry: {
      area: { x: 100, y: 0, width: 1000, height: 600 },
      panes: new Map([[layout.root.id, { left: 0, top: 0, width: 1000, height: 600 }]]),
    },
    layout,
    tabs: [{ id: "a", location: { kind: "file", path: "/a.md" }, back: [], forward: [] }],
    workspaceGeneration: 0,
    drops: [],
    outcome: { status: "committed" },
    suppressed: 0,
    failures: [],
    coordinator: null as unknown as DragCoordinator,
  };
  let frameId = 0;
  const env: DragEnvironment = {
    listen: (type, handler, signal) =>
      harness.window.addEventListener(type, handler as EventListener, { signal }),
    requestFrame: (callback) => {
      harness.frames.push(callback);
      frameId += 1;
      return frameId;
    },
    cancelFrame: () => {
      harness.frames = [];
    },
    geometry: () => harness.geometry,
    editor: () => ({ layout: harness.layout, tabs: harness.tabs }),
    createFileTab,
    workspaceIdentity: () => harness.workspaceGeneration,
    isWorkspaceCurrent: (identity) => identity === harness.workspaceGeneration,
    openFilesFromDrop: async (drop) => {
      harness.drops.push(drop);
      return harness.outcome;
    },
    suppressNextClick: () => {
      harness.suppressed += 1;
    },
    reportFailure: (message) => {
      harness.failures.push(message);
    },
  };
  harness.coordinator = createDragCoordinator(env);
  return harness;
}

function adapterSpy(): DragAdapter & {
  frames: Array<{ x: number; y: number; overEditor: boolean }>;
  released: Array<{ x: number; y: number }>;
  ended: number;
  activated: number;
} {
  const spy = {
    frames: [] as Array<{ x: number; y: number; overEditor: boolean }>,
    released: [] as Array<{ x: number; y: number }>,
    ended: 0,
    activated: 0,
    onActivate: () => {
      spy.activated += 1;
    },
    onFrame: (point: { x: number; y: number }, overEditor: boolean) => {
      spy.frames.push({ ...point, overEditor });
    },
    onRelease: (point: { x: number; y: number }) => {
      spy.released.push(point);
    },
    onEnd: () => {
      spy.ended += 1;
    },
  };
  return spy;
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("editor drag coordinator", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it("treats a press that never crosses the threshold as a click", () => {
    const adapter = adapterSpy();
    harness.coordinator.arm(
      { pointerId: 1, clientX: 10, clientY: 10 },
      { kind: "files", paths: ["/b.md"], droppable: true },
      adapter,
    );
    harness.window.dispatchEvent(pointer("pointermove", 12, 11));
    harness.flushFrames();
    harness.window.dispatchEvent(pointer("pointerup", 12, 11));

    expect(adapter.activated).toBe(0);
    expect(adapter.released).toEqual([]);
    expect(adapter.ended).toBe(1);
    expect(harness.suppressed).toBe(0);
    expect(harness.coordinator.isActive()).toBe(false);
  });

  it("commits an edge drop through the store and never hands it to the adapter", async () => {
    const adapter = adapterSpy();
    harness.coordinator.arm(
      { pointerId: 1, clientX: 10, clientY: 10 },
      { kind: "files", paths: ["/b.md", "/c.md"], droppable: true },
      adapter,
    );
    // Right edge of the pane: area.x + 1000 - 10.
    harness.window.dispatchEvent(pointer("pointermove", 1090, 300));
    harness.flushFrames();

    const candidate = harness.coordinator.getCandidate();
    expect(candidate?.region).toBe("right");
    expect(candidate?.expectedRevision).toBe(harness.layout.revision);
    expect(adapter.frames.at(-1)?.overEditor).toBe(true);

    harness.window.dispatchEvent(pointer("pointerup", 1090, 300));
    await settle();

    expect(adapter.released).toEqual([]);
    expect(harness.drops).toHaveLength(1);
    const drop = harness.drops[0]!;
    expect(drop.newTabs.map((tab) => tab.location)).toEqual([
      { kind: "file", path: "/b.md" },
      { kind: "file", path: "/c.md" },
    ]);
    const created = paneOfTab(drop.candidate.layout, drop.newTabs[0]!.id)!;
    expect(drop.candidate.layout.focusedPaneId).toBe(created.id);
    expect(harness.suppressed).toBe(1);
    expect(adapter.ended).toBe(1);
    expect(harness.coordinator.getCandidate()).toBeNull();
  });

  it("hands a release with no editor target to the adapter so the tree can move on disk", () => {
    const adapter = adapterSpy();
    harness.coordinator.arm(
      { pointerId: 1, clientX: 10, clientY: 10 },
      { kind: "files", paths: ["/b.md"], droppable: true },
      adapter,
    );
    harness.window.dispatchEvent(pointer("pointermove", 40, 300));
    harness.flushFrames();
    expect(harness.coordinator.getCandidate()).toBeNull();
    expect(adapter.frames.at(-1)?.overEditor).toBe(false);

    harness.window.dispatchEvent(pointer("pointerup", 40, 300));

    expect(adapter.released).toEqual([{ x: 40, y: 300 }]);
    expect(harness.drops).toEqual([]);
    expect(harness.suppressed).toBe(1);
  });

  it("offers no editor target for a selection that contains a folder", () => {
    const adapter = adapterSpy();
    harness.coordinator.arm(
      { pointerId: 1, clientX: 10, clientY: 10 },
      { kind: "files", paths: ["/dir", "/b.md"], droppable: false },
      adapter,
    );
    harness.window.dispatchEvent(pointer("pointermove", 600, 300));
    harness.flushFrames();
    expect(harness.coordinator.getCandidate()).toBeNull();
    expect(adapter.frames.at(-1)?.overEditor).toBe(false);

    harness.window.dispatchEvent(pointer("pointerup", 600, 300));
    expect(harness.drops).toEqual([]);
  });

  it("re-resolves against the live layout at release when the revision moved", async () => {
    const adapter = adapterSpy();
    harness.coordinator.arm(
      { pointerId: 1, clientX: 10, clientY: 10 },
      { kind: "files", paths: ["/b.md"], droppable: true },
      adapter,
    );
    harness.window.dispatchEvent(pointer("pointermove", 600, 300));
    harness.flushFrames();
    expect(harness.coordinator.getCandidate()?.expectedRevision).toBe(0);

    harness.layout = { ...harness.layout, revision: 5 };
    harness.window.dispatchEvent(pointer("pointerup", 600, 300));
    await settle();

    expect(harness.drops[0]?.candidate.expectedRevision).toBe(5);
  });

  it("reports a failed drop instead of swallowing it", async () => {
    harness.outcome = { status: "failed", errors: [{ path: "/b.md", error: new Error("gone") }] };
    harness.coordinator.arm(
      { pointerId: 1, clientX: 10, clientY: 10 },
      { kind: "files", paths: ["/b.md"], droppable: true },
      adapterSpy(),
    );
    harness.window.dispatchEvent(pointer("pointermove", 600, 300));
    harness.flushFrames();
    harness.window.dispatchEvent(pointer("pointerup", 600, 300));
    await settle();

    expect(harness.failures).toHaveLength(1);
    expect(harness.failures[0]).toContain("/b.md");
    expect(harness.failures[0]).toContain("gone");
  });

  it.each([
    ["Escape", () => Object.assign(new Event("keydown"), { key: "Escape" })],
    ["pointercancel", () => pointer("pointercancel", 600, 300)],
    ["lostpointercapture", () => pointer("lostpointercapture", 600, 300)],
    ["blur", () => new Event("blur")],
  ])("cancels on %s with no commit and no adapter release", (_name, makeEvent) => {
    const adapter = adapterSpy();
    harness.coordinator.arm(
      { pointerId: 1, clientX: 10, clientY: 10 },
      { kind: "files", paths: ["/b.md"], droppable: true },
      adapter,
    );
    harness.window.dispatchEvent(pointer("pointermove", 600, 300));
    harness.flushFrames();
    expect(harness.coordinator.getCandidate()).not.toBeNull();

    harness.window.dispatchEvent(makeEvent());

    expect(harness.coordinator.isActive()).toBe(false);
    expect(harness.coordinator.getCandidate()).toBeNull();
    expect(adapter.released).toEqual([]);
    expect(adapter.ended).toBe(1);
    expect(harness.drops).toEqual([]);

    // A release after the cancel is not ours any more.
    harness.window.dispatchEvent(pointer("pointerup", 600, 300));
    expect(adapter.released).toEqual([]);
    expect(harness.drops).toEqual([]);
  });

  it("cancels when the source stops being valid mid-drag", () => {
    let valid = true;
    const adapter = adapterSpy();
    adapter.isSourceValid = () => valid;
    harness.coordinator.arm(
      { pointerId: 1, clientX: 10, clientY: 10 },
      { kind: "files", paths: ["/b.md"], droppable: true },
      adapter,
    );
    harness.window.dispatchEvent(pointer("pointermove", 600, 300));
    harness.flushFrames();
    expect(harness.coordinator.isActive()).toBe(true);

    valid = false;
    harness.flushFrames();

    expect(harness.coordinator.isActive()).toBe(false);
    expect(adapter.ended).toBe(1);
    harness.window.dispatchEvent(pointer("pointerup", 600, 300));
    expect(harness.drops).toEqual([]);
  });

  it("ignores events from another pointer", () => {
    const adapter = adapterSpy();
    harness.coordinator.arm(
      { pointerId: 1, clientX: 10, clientY: 10 },
      { kind: "files", paths: ["/b.md"], droppable: true },
      adapter,
    );
    harness.window.dispatchEvent(pointer("pointermove", 600, 300, 2));
    harness.flushFrames();
    expect(adapter.activated).toBe(0);
    harness.window.dispatchEvent(pointer("pointerup", 600, 300, 2));
    expect(harness.coordinator.isActive()).toBe(true);
    harness.coordinator.cancel();
    expect(adapter.ended).toBe(1);
  });
});

describe("resolveFileDrop", () => {
  const geometry: EditorAreaGeometry = {
    area: { x: 0, y: 0, width: 1000, height: 600 },
    panes: new Map([["p", { left: 0, top: 0, width: 1000, height: 600 }]]),
  };
  const tabForPath = (path: string) => createFileTab(path);

  it("reuses the target pane's tab for a file at the centre and prefers the active match", () => {
    const tabs: Tab[] = [
      { id: "a1", location: { kind: "file", path: "/a.md" }, back: [], forward: [] },
      { id: "a2", location: { kind: "file", path: "/a.md" }, back: [], forward: [] },
    ];
    const layout: Layout = {
      root: createPane(["a1", "a2"], "a2", "p"),
      focusedPaneId: "p",
      revision: 0,
    };
    const drop = resolveFileDrop({
      layout,
      tabs,
      geometry,
      point: { x: 500, y: 300 },
      paths: ["/a.md", "/b.md"],
      tabForPath,
    });
    expect(drop).not.toBeNull();
    expect(drop!.newTabs.map((tab: Tab) => tab.location)).toEqual([
      { kind: "file", path: "/b.md" },
    ]);
    expect(findPane(drop!.candidate.layout, "p")!.activeTabId).toBe("a2");
  });

  it("opens a deliberate duplicate on an edge", () => {
    const tabs: Tab[] = [
      { id: "a1", location: { kind: "file", path: "/a.md" }, back: [], forward: [] },
    ];
    const layout: Layout = { root: createPane(["a1"], "a1", "p"), focusedPaneId: "p", revision: 0 };
    const drop = resolveFileDrop({
      layout,
      tabs,
      geometry,
      point: { x: 995, y: 300 },
      paths: ["/a.md"],
      tabForPath,
    });
    expect(drop!.newTabs).toHaveLength(1);
    expect(panes(drop!.candidate.layout)).toHaveLength(2);
  });

  it("is null outside every pane body", () => {
    const layout: Layout = { root: createPane(["a1"], "a1", "p"), focusedPaneId: "p", revision: 0 };
    expect(
      resolveFileDrop({
        layout,
        tabs: [],
        geometry,
        point: { x: 1500, y: 300 },
        paths: ["/a.md"],
        tabForPath,
      }),
    ).toBeNull();
  });
});
