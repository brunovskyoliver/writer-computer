import { describe, expect, it } from "vite-plus/test";
import {
  PANE_MIN_HEIGHT,
  PANE_MIN_WIDTH,
  SEPARATOR_SIZE,
  activateTab,
  candidateBounds,
  computeBounds,
  createLayout,
  createPane,
  createSplitId,
  fitsWithin,
  insertTab,
  layoutTabIds,
  minimumSize,
  moveTab,
  normalizeLayout,
  panes,
  paneOfTab,
  removeTab,
  setFocusedPane,
  setSplitRatio,
  splitPaneWithTab,
  validateLayout,
  type Layout,
  type Pane,
  type Split,
} from "../src/lib/editor-layout";

function twoPaneLayout(): Layout {
  // A vertical divider: pane-left | pane-right.
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

describe("layout construction and invariants", () => {
  it("starts as one focused pane holding the given tabs", () => {
    const layout = createLayout(["t1", "t2"], "t2");
    expect(layout.root.kind).toBe("pane");
    expect(panes(layout).map((pane) => pane.id)).toEqual([layout.focusedPaneId]);
    expect(layoutTabIds(layout)).toEqual(["t1", "t2"]);
    expect(validateLayout(layout)).toEqual([]);
  });

  it("gives every pane and split a unique id", () => {
    const layout = twoPaneLayout();
    const ids = [createPane().id, createPane().id, createSplitId(), createSplitId()];
    expect(new Set(ids).size).toBe(ids.length);
    expect(validateLayout(layout)).toEqual([]);
  });

  it("reports a tab that appears in more than one pane", () => {
    const layout = twoPaneLayout();
    (layout.root as Split).children[1] = createPane(["a"], "a", "right");
    expect(validateLayout(layout)).toContain("tab a appears in more than one pane");
  });

  it("reports a split that does not have exactly two children", () => {
    const layout = twoPaneLayout();
    (layout.root as Split).children = [createPane(["a"], "a", "only")] as never;
    expect(validateLayout(layout).join(" ")).toContain("exactly two children");
  });

  it("requires every nonempty pane to have one active member", () => {
    const layout = createLayout(["t1"], "t1");
    const broken: Layout = {
      ...layout,
      root: { ...(layout.root as Pane), activeTabId: "gone" },
    };
    expect(validateLayout(broken).join(" ")).toContain("active member");
  });

  it("requires the focused pane to exist", () => {
    const layout = { ...createLayout(["t1"], "t1"), focusedPaneId: "missing" };
    expect(validateLayout(layout).join(" ")).toContain("focused pane");
  });

  it.each([0, 1, -0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects a ratio of %p as outside (0, 1)",
    (ratio) => {
      const layout = twoPaneLayout();
      (layout.root as Split).ratio = ratio;
      expect(validateLayout(layout).join(" ")).toContain("ratio");
    },
  );

  it("reports an empty non-root pane as uncollapsed", () => {
    const layout = twoPaneLayout();
    (layout.root as Split).children[1] = createPane([], null, "right");
    expect(validateLayout(layout).join(" ")).toContain("empty");
  });

  it("allows an empty root pane, which is the launcher fallback", () => {
    const layout: Layout = {
      root: createPane([], null, "root"),
      focusedPaneId: "root",
      revision: 0,
    };
    expect(validateLayout(layout)).toEqual([]);
  });
});

describe("traversal", () => {
  it("visits panes in strip order, first child before second", () => {
    expect(panes(twoPaneLayout()).map((pane) => pane.id)).toEqual(["left", "right"]);
  });

  it("finds the pane owning a tab", () => {
    const layout = twoPaneLayout();
    expect(paneOfTab(layout, "b")?.id).toBe("left");
    expect(paneOfTab(layout, "c")?.id).toBe("right");
    expect(paneOfTab(layout, "nope")).toBeNull();
  });

  it("lists tab ids in traversal order", () => {
    expect(layoutTabIds(twoPaneLayout())).toEqual(["a", "b", "c"]);
  });
});

describe("normalization and collapse", () => {
  it("collapses an emptied pane into its sibling and keeps the tree valid", () => {
    const layout = removeTab(twoPaneLayout(), "c");
    expect(layout.root.kind).toBe("pane");
    expect(layoutTabIds(layout)).toEqual(["a", "b"]);
    expect(validateLayout(layout)).toEqual([]);
  });

  it("leaves one empty focused root pane when the last tab closes", () => {
    const layout = removeTab(createLayout(["only"], "only"), "only");
    expect(layout.root).toEqual(expect.objectContaining({ kind: "pane", tabIds: [] }));
    expect(panes(layout)).toHaveLength(1);
    expect(layout.focusedPaneId).toBe(panes(layout)[0]!.id);
    expect(validateLayout(layout)).toEqual([]);
  });

  it("moves focus to a surviving pane when the focused pane collapses", () => {
    const layout = removeTab(twoPaneLayout(), "c");
    expect(layout.focusedPaneId).toBe("left");
    const collapsedLeft = removeTab(removeTab(twoPaneLayout(), "a"), "b");
    expect(collapsedLeft.focusedPaneId).toBe("right");
  });

  it("repairs an active tab that is no longer a member", () => {
    const layout = twoPaneLayout();
    (layout.root as Split).children[0] = createPane(["a", "b"], "gone", "left");
    expect(panes(normalizeLayout(layout))[0]).toMatchObject({ activeTabId: "a" });
  });

  it("returns the same layout object when nothing needs normalizing", () => {
    const layout = twoPaneLayout();
    expect(normalizeLayout(layout)).toBe(layout);
  });
});

describe("revision", () => {
  it("increments once per committed layout change", () => {
    const layout = createLayout(["a"], "a");
    const withSecond = insertTab(layout, layout.focusedPaneId, "b");
    expect(withSecond.revision).toBe(layout.revision + 1);
    const split = splitPaneWithTab(withSecond, withSecond.focusedPaneId, "x", "after", "b");
    expect(split.revision).toBe(withSecond.revision + 1);
  });

  it("does not increment for a no-op", () => {
    const layout = twoPaneLayout();
    expect(setFocusedPane(layout, "left")).toBe(layout);
    expect(removeTab(layout, "absent")).toBe(layout);
    expect(activateTab(layout, "a")).toBe(layout);
  });
});

describe("tab transitions", () => {
  it("inserts at an index and activates the tab in its pane", () => {
    const layout = insertTab(twoPaneLayout(), "left", "z", 1);
    expect(panes(layout)[0]).toMatchObject({ tabIds: ["a", "z", "b"], activeTabId: "z" });
    expect(layout.focusedPaneId).toBe("left");
  });

  it("selects a neighbour when the active tab is removed", () => {
    const layout = removeTab(twoPaneLayout(), "a");
    expect(panes(layout)[0]).toMatchObject({ tabIds: ["b"], activeTabId: "b" });
  });

  it("moves a tab across panes, focusing the destination", () => {
    const layout = moveTab(twoPaneLayout(), "a", { paneId: "right", index: 0 });
    expect(panes(layout).map((pane) => pane.tabIds)).toEqual([["b"], ["a", "c"]]);
    expect(layout.focusedPaneId).toBe("right");
    expect(validateLayout(layout)).toEqual([]);
  });

  it("corrects the insertion index for the source removal within one strip", () => {
    // "a" sits at index 0; dropping it at index 2 of its own strip lands it
    // last rather than one short, because removing it shifts the strip left.
    const layout = createLayout(["a", "b", "c"], "a");
    const reordered = moveTab(layout, "a", { paneId: layout.focusedPaneId, index: 2 });
    expect(panes(reordered)[0]!.tabIds).toEqual(["b", "c", "a"]);
  });

  it("treats a move back to the same position as a no-op", () => {
    const layout = createLayout(["a", "b"], "a");
    expect(moveTab(layout, "a", { paneId: layout.focusedPaneId, index: 0 })).toBe(layout);
  });

  it("collapses the source pane when its last tab moves away", () => {
    const layout = moveTab(twoPaneLayout(), "c", { paneId: "left", index: 2 });
    expect(layout.root.kind).toBe("pane");
    expect(layoutTabIds(layout)).toEqual(["a", "b", "c"]);
    expect(validateLayout(layout)).toEqual([]);
  });
});

describe("splitting", () => {
  it("replaces the target pane with a two-child split holding the moved tab", () => {
    const layout = splitPaneWithTab(twoPaneLayout(), "right", "y", "after", "a");
    const root = layout.root as Split;
    expect(root.axis).toBe("x");
    const nested = root.children[1] as Split;
    expect(nested.kind).toBe("split");
    expect(nested.axis).toBe("y");
    expect(nested.ratio).toBe(0.5);
    expect(nested.children.map((child) => (child as Pane).tabIds)).toEqual([["c"], ["a"]]);
    expect(layout.focusedPaneId).toBe((nested.children[1] as Pane).id);
    expect(validateLayout(layout)).toEqual([]);
  });

  it("places the new pane before the target when asked", () => {
    const source = createLayout(["a", "b"], "a");
    const layout = splitPaneWithTab(source, source.focusedPaneId, "x", "before", "b");
    const root = layout.root as Split;
    expect(root.children.map((child) => (child as Pane).tabIds)).toEqual([["b"], ["a"]]);
  });

  it("rejects a sole tab dropped on its own pane edge", () => {
    const layout = createLayout(["only"], "only");
    expect(splitPaneWithTab(layout, layout.focusedPaneId, "x", "after", "only")).toBe(layout);
  });

  it("commits a completed ratio and clamps it inside (0, 1)", () => {
    const layout = twoPaneLayout();
    const resized = setSplitRatio(layout, (layout.root as Split).id, 0.3);
    expect((resized.root as Split).ratio).toBe(0.3);
    expect(validateLayout(resized)).toEqual([]);
    expect(
      (setSplitRatio(layout, (layout.root as Split).id, 0).root as Split).ratio,
    ).toBeGreaterThan(0);
    expect((setSplitRatio(layout, (layout.root as Split).id, 2).root as Split).ratio).toBeLessThan(
      1,
    );
  });
});

describe("geometry", () => {
  it("uses the pane minimum for a leaf", () => {
    expect(minimumSize(createPane(["a"], "a"))).toEqual({
      width: PANE_MIN_WIDTH,
      height: PANE_MIN_HEIGHT,
    });
  });

  it("sums minima along the split axis and takes the max across it", () => {
    const layout = twoPaneLayout();
    expect(minimumSize(layout.root)).toEqual({
      width: PANE_MIN_WIDTH * 2 + SEPARATOR_SIZE,
      height: PANE_MIN_HEIGHT,
    });
    const stacked = splitPaneWithTab(twoPaneLayout(), "right", "y", "after", "a");
    expect(minimumSize(stacked.root)).toEqual({
      width: PANE_MIN_WIDTH * 2 + SEPARATOR_SIZE,
      height: PANE_MIN_HEIGHT * 2 + SEPARATOR_SIZE,
    });
  });

  it("allocates bounds by ratio minus the separator", () => {
    const layout = twoPaneLayout();
    const rect = { x: 0, y: 0, width: 1004, height: 600 };
    const bounds = computeBounds(layout.root, rect);
    expect(bounds.get("left")).toEqual({ x: 0, y: 0, width: 500, height: 600 });
    expect(bounds.get("right")).toEqual({ x: 504, y: 0, width: 500, height: 600 });
  });

  it("stacks bounds down the y axis", () => {
    const source = createLayout(["a", "b"], "a");
    const layout = splitPaneWithTab(source, source.focusedPaneId, "y", "after", "b");
    const bounds = computeBounds(layout.root, { x: 10, y: 20, width: 400, height: 404 });
    const [first, second] = panes(layout);
    expect(bounds.get(first!.id)).toEqual({ x: 10, y: 20, width: 400, height: 200 });
    expect(bounds.get(second!.id)).toEqual({ x: 10, y: 224, width: 400, height: 200 });
  });

  it("predicts the bounds a drop target would receive after the split commits", () => {
    const rect = { x: 0, y: 0, width: 1004, height: 600 };
    const layout = createLayout(["a", "b"], "a");
    const candidate = splitPaneWithTab(layout, layout.focusedPaneId, "x", "after", "b");
    expect(candidateBounds(candidate, rect, candidate.focusedPaneId)).toEqual({
      x: 504,
      y: 0,
      width: 500,
      height: 600,
    });
  });

  it("only offers a split whose whole final tree still fits", () => {
    const layout = createLayout(["a", "b"], "a");
    const candidate = splitPaneWithTab(layout, layout.focusedPaneId, "x", "after", "b");
    expect(fitsWithin(minimumSize(candidate.root), { width: 1004, height: 600 })).toBe(true);
    expect(fitsWithin(minimumSize(candidate.root), { width: 400, height: 600 })).toBe(false);
    expect(fitsWithin(minimumSize(candidate.root), { width: 1004, height: 100 })).toBe(false);
  });

  it("checks minima recursively, not just at the top level", () => {
    const wide = { width: PANE_MIN_WIDTH * 2 + SEPARATOR_SIZE, height: 600 };
    const twoPanes = twoPaneLayout();
    expect(fitsWithin(minimumSize(twoPanes.root), wide)).toBe(true);
    const nested = splitPaneWithTab(twoPanes, "right", "x", "after", "a");
    expect(fitsWithin(minimumSize(nested.root), wide)).toBe(false);
  });
});
