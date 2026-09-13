import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import {
  createPane,
  createSplitId,
  findPane,
  layoutTabIds,
  panes,
  paneOfTab,
  type DropCandidate,
  type Layout,
  type Split,
} from "../src/lib/editor-layout";
import {
  createDragCoordinator,
  resolveTabDrop,
  type DragCoordinator,
  type DragEnvironment,
  type EditorAreaGeometry,
} from "../src/hooks/use-editor-drag";
import { createFileTab, type Tab } from "../src/stores/editor-store";

/**
 * Tab drags through the coordinator, without a DOM: two panes side by side,
 * each with a 56 px strip across the top of its body. The strip geometry is
 * what `pane-bounds` would measure — tab boxes in area coordinates.
 */

const STRIP_HEIGHT = 56;

function twoPaneLayout(): Layout {
  const left = createPane(["a", "b"], "a", "left");
  const right = createPane(["c"], "c", "right");
  const root: Split = {
    kind: "split",
    id: createSplitId(),
    axis: "x",
    children: [left, right],
    ratio: 0.5,
  };
  return { root, focusedPaneId: "left", revision: 0 };
}

function tab(id: string, path: string): Tab {
  return { id, location: { kind: "file", path }, back: [], forward: [] };
}

function geometryFor(): EditorAreaGeometry {
  // Area 1000 x 600 at (100, 0); left body 0..498, right body 502..1000.
  return {
    area: { x: 100, y: 0, width: 1000, height: 600 },
    panes: new Map([
      ["left", { left: 0, top: 0, width: 498, height: 600 }],
      ["right", { left: 502, top: 0, width: 498, height: 600 }],
    ]),
    strips: new Map([
      [
        "left",
        {
          left: 0,
          top: 0,
          width: 498,
          height: STRIP_HEIGHT,
          tabs: [
            { tabId: "a", left: 60, width: 100 },
            { tabId: "b", left: 164, width: 100 },
          ],
        },
      ],
      [
        "right",
        {
          left: 502,
          top: 0,
          width: 498,
          height: STRIP_HEIGHT,
          tabs: [{ tabId: "c", left: 562, width: 100 }],
        },
      ],
    ]),
  };
}

interface Harness {
  window: EventTarget;
  frames: Array<() => void>;
  flushFrames: () => void;
  geometry: EditorAreaGeometry | null;
  layout: Layout;
  tabs: Tab[];
  moves: DropCandidate[];
  moveResult: boolean;
  suppressed: number;
  fileDrops: number;
  coordinator: DragCoordinator;
}

function pointer(type: string, x: number, y: number, pointerId = 1) {
  return Object.assign(new Event(type), { pointerId, clientX: x, clientY: y });
}

function createHarness(): Harness {
  const harness: Harness = {
    window: new EventTarget(),
    frames: [],
    flushFrames() {
      const pending = harness.frames;
      harness.frames = [];
      for (const frame of pending) frame();
    },
    geometry: geometryFor(),
    layout: twoPaneLayout(),
    tabs: [tab("a", "/a.md"), tab("b", "/b.md"), tab("c", "/c.md")],
    moves: [],
    moveResult: true,
    suppressed: 0,
    fileDrops: 0,
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
    workspaceIdentity: () => 0,
    isWorkspaceCurrent: () => true,
    openFilesFromDrop: async () => {
      harness.fileDrops += 1;
      return { status: "committed" };
    },
    moveTabFromDrop: (candidate) => {
      harness.moves.push(candidate);
      return harness.moveResult;
    },
    suppressNextClick: () => {
      harness.suppressed += 1;
    },
    reportFailure: () => {},
  };
  harness.coordinator = createDragCoordinator(env);
  return harness;
}

/** Press on tab `tabId` (at its strip box) and drag to `(x, y)`. */
function drag(harness: Harness, tabId: string, x: number, y: number) {
  harness.coordinator.arm({ pointerId: 1, clientX: 200, clientY: 20 }, { kind: "tab", tabId }, {});
  harness.window.dispatchEvent(pointer("pointermove", x, y));
  harness.flushFrames();
}

describe("tab drags", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it("previews a strip gap and commits the insertion on release", () => {
    // Right strip, past the end of "c": area x 100 + 700.
    drag(harness, "a", 800, 20);
    const candidate = harness.coordinator.getCandidate();
    expect(candidate).not.toBeNull();
    expect(candidate!.targetPaneId).toBe("right");
    expect(candidate!.insertionIndex).toBe(1);
    expect(candidate!.region).toBeNull();
    // The gap bar is centred on the right edge of "c", full strip height.
    expect(candidate!.previewRect).toMatchObject({ y: 0, height: STRIP_HEIGHT });
    expect(candidate!.previewRect.x + candidate!.previewRect.width / 2).toBe(662);
    expect(panes(candidate!.layout).map((pane) => pane.tabIds)).toEqual([["b"], ["c", "a"]]);

    harness.window.dispatchEvent(pointer("pointerup", 800, 20));

    expect(harness.moves).toHaveLength(1);
    // Release re-resolves, so the committed candidate equals the previewed one
    // by value: the same tree, the same gap.
    expect(harness.moves[0]!.layout).toStrictEqual(candidate!.layout);
    expect(harness.moves[0]!.previewRect).toStrictEqual(candidate!.previewRect);
    expect(harness.suppressed).toBe(1);
    expect(harness.fileDrops).toBe(0);
    expect(harness.coordinator.isActive()).toBe(false);
    expect(harness.coordinator.getCandidate()).toBeNull();
  });

  it("inserts before a tab when the pointer is left of its midpoint", () => {
    // "c" spans 562..662 in area coordinates; its midpoint is 612.
    drag(harness, "a", 100 + 600, 20);
    expect(harness.coordinator.getCandidate()!.insertionIndex).toBe(0);
    const rect = harness.coordinator.getCandidate()!.previewRect;
    expect(rect.x + rect.width / 2).toBe(562);
  });

  it("gives the strip precedence over the body's top edge band", () => {
    // y = 10 is inside the top edge band of the right body, and inside its strip.
    drag(harness, "a", 800, 10);
    const candidate = harness.coordinator.getCandidate()!;
    expect(candidate.insertionIndex).toBe(1);
    expect(candidate.region).toBeNull();
  });

  it("resolves a within-strip reorder against the strip without the source", () => {
    // Drag "a" past "b": the only other tab; index counts tabs other than "a".
    drag(harness, "a", 100 + 300, 20);
    const candidate = harness.coordinator.getCandidate()!;
    expect(candidate.insertionIndex).toBe(1);
    expect(panes(candidate.layout)[0]!.tabIds).toEqual(["b", "a"]);
  });

  it("offers nothing back at the tab's own position, and commits nothing on release", () => {
    // Left of "a"'s own midpoint: index 0, where it already is.
    drag(harness, "a", 100 + 80, 20);
    expect(harness.coordinator.getCandidate()).toBeNull();

    harness.window.dispatchEvent(pointer("pointerup", 180, 20));
    expect(harness.moves).toEqual([]);
    // The drag did activate, so the click that follows must still be eaten.
    expect(harness.suppressed).toBe(1);
  });

  it("moves to another pane's centre and splits off its edge", () => {
    drag(harness, "a", 100 + 750, 300);
    let candidate = harness.coordinator.getCandidate()!;
    expect(candidate.region).toBe("center");
    expect(candidate.previewRect).toEqual({ x: 502, y: 0, width: 498, height: 600 });

    harness.window.dispatchEvent(pointer("pointermove", 100 + 750, 590));
    harness.flushFrames();
    candidate = harness.coordinator.getCandidate()!;
    expect(candidate.region).toBe("bottom");
    expect(paneOfTab(candidate.layout, "a")!.id).not.toBe("right");
    expect(candidate.previewRect).toEqual({ x: 502, y: 302, width: 498, height: 298 });
  });

  it("previews the post-collapse geometry when the source pane empties", () => {
    // "c" is the right pane's only tab; splitting the left pane's bottom edge
    // collapses the right pane first, so the new pane spans the full width.
    drag(harness, "c", 100 + 250, 590);
    const candidate = harness.coordinator.getCandidate()!;
    expect(candidate.region).toBe("bottom");
    expect(candidate.previewRect).toEqual({ x: 0, y: 302, width: 1000, height: 298 });
  });

  it("replaces a destination tab showing the same document", () => {
    harness.tabs = [tab("a", "/a.md"), tab("b", "/b.md"), tab("c", "/a.md")];
    drag(harness, "a", 100 + 750, 300);
    const candidate = harness.coordinator.getCandidate()!;
    expect(layoutTabIds(candidate.layout)).toEqual(["b", "a"]);
    expect(findPane(candidate.layout, "right")!.activeTabId).toBe("a");
  });

  it("offers no edge to a sole tab on its own pane", () => {
    drag(harness, "c", 100 + 990, 300);
    expect(harness.coordinator.getCandidate()).toBeNull();
  });

  it("treats a press that never moves as a click", () => {
    harness.coordinator.arm(
      { pointerId: 1, clientX: 200, clientY: 20 },
      { kind: "tab", tabId: "a" },
      {},
    );
    harness.window.dispatchEvent(pointer("pointerup", 201, 20));
    expect(harness.suppressed).toBe(0);
    expect(harness.moves).toEqual([]);
    expect(harness.coordinator.isActive()).toBe(false);
  });

  it.each([
    ["Escape", () => Object.assign(new Event("keydown"), { key: "Escape" })],
    ["pointercancel", () => pointer("pointercancel", 800, 20)],
    ["lostpointercapture", () => pointer("lostpointercapture", 800, 20)],
    ["blur", () => new Event("blur")],
  ])("cancels on %s without a move", (_name, makeEvent) => {
    drag(harness, "a", 800, 20);
    expect(harness.coordinator.getCandidate()).not.toBeNull();

    harness.window.dispatchEvent(makeEvent());

    expect(harness.coordinator.isActive()).toBe(false);
    expect(harness.coordinator.getCandidate()).toBeNull();
    harness.window.dispatchEvent(pointer("pointerup", 800, 20));
    expect(harness.moves).toEqual([]);
  });

  it("cancels when the tab is closed mid-drag", () => {
    drag(harness, "a", 800, 20);
    harness.tabs = harness.tabs.filter((t) => t.id !== "a");
    harness.flushFrames();
    expect(harness.coordinator.isActive()).toBe(false);
    harness.window.dispatchEvent(pointer("pointerup", 800, 20));
    expect(harness.moves).toEqual([]);
  });

  it("cancels when the tab's file is renamed mid-drag", () => {
    drag(harness, "a", 800, 20);
    harness.tabs = harness.tabs.map((t) => (t.id === "a" ? tab("a", "/renamed.md") : t));
    harness.flushFrames();
    expect(harness.coordinator.isActive()).toBe(false);
  });

  it("re-resolves at release when the layout revision moved", () => {
    drag(harness, "a", 800, 20);
    harness.layout = { ...harness.layout, revision: 4 };
    harness.window.dispatchEvent(pointer("pointerup", 800, 20));
    expect(harness.moves[0]!.expectedRevision).toBe(4);
  });

  it("opens a sidebar file at a pane's centre when it is dropped on that pane's strip", () => {
    harness.coordinator.arm(
      { pointerId: 1, clientX: 10, clientY: 300 },
      { kind: "files", paths: ["/d.md"], droppable: true },
      {},
    );
    harness.window.dispatchEvent(pointer("pointermove", 800, 20));
    harness.flushFrames();
    const candidate = harness.coordinator.getCandidate()!;
    expect(candidate.targetPaneId).toBe("right");
    expect(candidate.region).toBe("center");
  });
});

describe("resolveTabDrop", () => {
  it("is null outside every strip and body", () => {
    expect(
      resolveTabDrop({
        layout: twoPaneLayout(),
        tabs: [tab("a", "/a.md")],
        geometry: geometryFor(),
        point: { x: 5000, y: 5000 },
        tabId: "a",
      }),
    ).toBeNull();
  });
});
