/**
 * The pure layout tree for a window's editor area: a binary tree of splits
 * whose leaves are panes, each holding an ordered list of tab IDs.
 *
 * Everything here is a value transition — no store, no DOM, no I/O. The editor
 * store owns the one writable `Layout` and commits transitions from this module
 * atomically, so a move that empties its source pane, collapses a split, and
 * changes focus is one state update rather than three (see
 * SPECs/tab-tiling-splits/data-model.md).
 *
 * Conventions worth knowing before reading the rest:
 *
 * - `axis: "x"` means the children are laid out along the x axis, side by side,
 *   separated by a vertical divider. `axis: "y"` stacks them.
 * - `ratio` is the first child's share of the space left after the separator.
 * - Transitions return the *same object* when they change nothing, so callers
 *   (and Zustand) can bail out on identity and `revision` only moves for real
 *   layout changes. Editing a document is not a layout change.
 */

/** Smallest pane the layout will allocate, including its tab strip. */
export const PANE_MIN_WIDTH = 240;
export const PANE_MIN_HEIGHT = 160;
/** Space a divider occupies between two children of a split. */
export const SEPARATOR_SIZE = 4;

export interface Pane {
  kind: "pane";
  id: string;
  tabIds: string[];
  activeTabId: string | null;
}

export interface Split {
  kind: "split";
  id: string;
  axis: "x" | "y";
  children: [LayoutNode, LayoutNode];
  /** First child's share of the non-separator space, strictly within (0, 1). */
  ratio: number;
}

export type LayoutNode = Pane | Split;

export interface Layout {
  root: LayoutNode;
  focusedPaneId: string;
  /** Monotonic; bumped by layout changes only, never by document edits. */
  revision: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Where inside a pane body a drop lands. Strip insertions use an index instead. */
export type DropRegion = "center" | "left" | "right" | "top" | "bottom";

/**
 * A fully resolved drop. The preview paints `previewRect` and the commit
 * applies `layout` — one value, so what the user sees is what they get. A
 * candidate is only valid while the store is still at `expectedRevision`.
 */
export interface DropCandidate {
  targetPaneId: string;
  /** Set for body drops; `null` when this is a tab-strip insertion. */
  region: DropRegion | null;
  /** Set for strip insertions; `null` for body drops. */
  insertionIndex: number | null;
  expectedRevision: number;
  layout: Layout;
  previewRect: Rect;
}

let paneSequence = 0;
let splitSequence = 0;

export function createPaneId() {
  paneSequence += 1;
  return `pane-${paneSequence}`;
}

export function createSplitId() {
  splitSequence += 1;
  return `split-${splitSequence}`;
}

export function createPane(
  tabIds: string[] = [],
  activeTabId: string | null = tabIds[0] ?? null,
  id: string = createPaneId(),
): Pane {
  return { kind: "pane", id, tabIds, activeTabId };
}

/** A fresh single-pane layout — the shape an empty window and a legacy flat
 *  session both restore into. */
export function createLayout(
  tabIds: string[] = [],
  activeTabId: string | null = tabIds[0] ?? null,
  revision = 0,
): Layout {
  const root = createPane(tabIds, activeTabId);
  return { root, focusedPaneId: root.id, revision };
}

// --- traversal -------------------------------------------------------------

/** Panes depth-first, first child before second — this is strip order, and the
 *  order neighbours are picked in when a pane collapses. */
export function panes(source: Layout | LayoutNode): Pane[] {
  // Tolerates a malformed tree: `validateLayout` walks a restored session
  // before anything has vouched for its shape, so a split missing a child must
  // produce a problem report rather than a crash.
  const node = source ? ("root" in source ? source.root : source) : null;
  if (!node) return [];
  if (node.kind === "pane") return [node];
  return node.children.flatMap((child) => panes(child));
}

export function findPane(source: Layout | LayoutNode, paneId: string): Pane | null {
  return panes(source).find((pane) => pane.id === paneId) ?? null;
}

export function paneOfTab(source: Layout | LayoutNode, tabId: string): Pane | null {
  return panes(source).find((pane) => pane.tabIds.includes(tabId)) ?? null;
}

export function layoutTabIds(source: Layout | LayoutNode): string[] {
  return panes(source).flatMap((pane) => pane.tabIds);
}

/** The tab a window's global commands act on: the focused pane's active tab. */
export function focusedTabId(layout: Layout): string | null {
  return findPane(layout, layout.focusedPaneId)?.activeTabId ?? null;
}

// --- validation ------------------------------------------------------------

/**
 * Every invariant the tree must hold, as a list of human-readable problems.
 * Empty means valid. Used by tests and by session restore, which reports what
 * it repaired rather than silently accepting a damaged layout.
 */
export function validateLayout(layout: Layout): string[] {
  const problems: string[] = [];
  const nodeIds = new Set<string>();
  const seenTabs = new Set<string>();

  const walk = (node: LayoutNode, isRoot: boolean) => {
    if (nodeIds.has(node.id)) problems.push(`duplicate node id ${node.id}`);
    nodeIds.add(node.id);

    if (node.kind === "pane") {
      for (const tabId of node.tabIds) {
        if (seenTabs.has(tabId)) problems.push(`tab ${tabId} appears in more than one pane`);
        seenTabs.add(tabId);
      }
      if (node.tabIds.length === 0) {
        // The root may be empty — that is the state an empty window sits in
        // until the store gives it a launcher tab.
        if (!isRoot) problems.push(`empty pane ${node.id} must collapse`);
        if (node.activeTabId !== null) problems.push(`empty pane ${node.id} has an active member`);
      } else if (node.activeTabId === null || !node.tabIds.includes(node.activeTabId)) {
        problems.push(`pane ${node.id} has no active member`);
      }
      return;
    }

    if (node.children.length !== 2) {
      problems.push(`split ${node.id} must have exactly two children`);
    }
    if (!Number.isFinite(node.ratio) || node.ratio <= 0 || node.ratio >= 1) {
      problems.push(`split ${node.id} ratio ${node.ratio} must be finite and within (0, 1)`);
    }
    for (const child of node.children) if (child) walk(child, false);
  };

  walk(layout.root, true);

  if (!findPane(layout, layout.focusedPaneId)) {
    problems.push(`focused pane ${layout.focusedPaneId} does not exist`);
  }
  return problems;
}

// --- normalization ---------------------------------------------------------

function clampRatio(ratio: number) {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(0.98, Math.max(0.02, ratio));
}

/**
 * Collapse empty panes and repair active members, bottom-up. Returns `null`
 * when the whole subtree is empty and should disappear, and returns the input
 * node itself when nothing changed, so callers get free no-op detection.
 */
function normalizeNode(node: LayoutNode): LayoutNode | null {
  if (node.kind === "pane") {
    if (node.tabIds.length === 0) return null;
    if (node.activeTabId !== null && node.tabIds.includes(node.activeTabId)) return node;
    return { ...node, activeTabId: node.tabIds[0]! };
  }

  const first = node.children[0] ? normalizeNode(node.children[0]) : null;
  const second = node.children[1] ? normalizeNode(node.children[1]) : null;
  if (!first) return second;
  if (!second) return first;

  const ratio = clampRatio(node.ratio);
  if (first === node.children[0] && second === node.children[1] && ratio === node.ratio) {
    return node;
  }
  return { ...node, children: [first, second], ratio };
}

/**
 * The single exit from every transition: normalize, repair focus, and bump the
 * revision — but only if the result actually differs. One place so no caller
 * can commit an unnormalized tree or forget the revision.
 */
function commit(layout: Layout, root: LayoutNode, focusedPaneId: string): Layout {
  const normalized = normalizeNode(root) ?? createPane();
  const focused = findPane(normalized, focusedPaneId)
    ? focusedPaneId
    : (panes(normalized)[0]?.id ?? focusedPaneId);
  if (normalized === layout.root && focused === layout.focusedPaneId) return layout;
  return { root: normalized, focusedPaneId: focused, revision: layout.revision + 1 };
}

/** Normalize in place — used after a restore or an external edit to the tree. */
export function normalizeLayout(layout: Layout): Layout {
  return commit(layout, layout.root, layout.focusedPaneId);
}

// --- structural edits ------------------------------------------------------

/** Rebuild the tree with `paneId` replaced by `replacement`, or removed when
 *  `replacement` is `null`. Untouched subtrees keep their identity. */
function replacePane(
  node: LayoutNode,
  paneId: string,
  replacement: LayoutNode | null,
): LayoutNode | null {
  if (node.kind === "pane") return node.id === paneId ? replacement : node;
  const first = replacePane(node.children[0], paneId, replacement);
  const second = replacePane(node.children[1], paneId, replacement);
  if (first === node.children[0] && second === node.children[1]) return node;
  if (!first) return second;
  if (!second) return first;
  return { ...node, children: [first, second] };
}

function mapPane(node: LayoutNode, paneId: string, update: (pane: Pane) => Pane): LayoutNode {
  const target = findPane(node, paneId);
  if (!target) return node;
  const updated = update(target);
  return updated === target ? node : (replacePane(node, paneId, updated) ?? updated);
}

/** The tab that should become active when `removed` leaves `pane`: the one
 *  that slides into its slot, else the one before it. */
function neighbourTabId(pane: Pane, removed: string): string | null {
  const index = pane.tabIds.indexOf(removed);
  const remaining = pane.tabIds.filter((tabId) => tabId !== removed);
  if (remaining.length === 0) return null;
  return remaining[index] ?? remaining[remaining.length - 1]!;
}

function withoutTab(pane: Pane, tabId: string): Pane {
  if (!pane.tabIds.includes(tabId)) return pane;
  return {
    ...pane,
    tabIds: pane.tabIds.filter((id) => id !== tabId),
    activeTabId: pane.activeTabId === tabId ? neighbourTabId(pane, tabId) : pane.activeTabId,
  };
}

export function setFocusedPane(layout: Layout, paneId: string): Layout {
  if (layout.focusedPaneId === paneId || !findPane(layout, paneId)) return layout;
  return { ...layout, focusedPaneId: paneId, revision: layout.revision + 1 };
}

/** Make `tabId` its pane's active tab and focus that pane. */
export function activateTab(layout: Layout, tabId: string): Layout {
  const pane = paneOfTab(layout, tabId);
  if (!pane) return layout;
  const root = mapPane(layout.root, pane.id, (target) =>
    target.activeTabId === tabId ? target : { ...target, activeTabId: tabId },
  );
  return commit(layout, root, pane.id);
}

export function insertTab(
  layout: Layout,
  paneId: string,
  tabId: string,
  index = Number.POSITIVE_INFINITY,
  { activate = true }: { activate?: boolean } = {},
): Layout {
  if (!findPane(layout, paneId)) return layout;
  const root = mapPane(layout.root, paneId, (pane) => {
    const tabIds = [...pane.tabIds];
    tabIds.splice(Math.max(0, Math.min(index, tabIds.length)), 0, tabId);
    return { ...pane, tabIds, activeTabId: activate ? tabId : (pane.activeTabId ?? tabId) };
  });
  return commit(layout, root, activate ? paneId : layout.focusedPaneId);
}

export function removeTab(layout: Layout, tabId: string): Layout {
  const pane = paneOfTab(layout, tabId);
  if (!pane) return layout;
  return commit(
    layout,
    mapPane(layout.root, pane.id, (p) => withoutTab(p, tabId)),
    layout.focusedPaneId,
  );
}

export function removeTabs(layout: Layout, tabIds: Iterable<string>): Layout {
  let next = layout;
  for (const tabId of tabIds) next = removeTab(next, tabId);
  return next;
}

/**
 * Move a tab to `paneId` at `index`, in one transition. The index is resolved
 * against the strip *after* the source tab is removed, so dropping a tab past
 * its own old position inside one strip lands where the gap was drawn.
 */
export function moveTab(
  layout: Layout,
  tabId: string,
  target: { paneId: string; index?: number },
): Layout {
  const source = paneOfTab(layout, tabId);
  if (!source || !findPane(layout, target.paneId)) return layout;

  const index = target.index ?? Number.POSITIVE_INFINITY;
  if (source.id === target.paneId) {
    const remaining = source.tabIds.filter((id) => id !== tabId);
    const clamped = Math.max(0, Math.min(index, remaining.length));
    remaining.splice(clamped, 0, tabId);
    if (remaining.join(" ") === source.tabIds.join(" ")) {
      return activateTab(layout, tabId);
    }
    const root = mapPane(layout.root, source.id, (pane) => ({
      ...pane,
      tabIds: remaining,
      activeTabId: tabId,
    }));
    return commit(layout, root, source.id);
  }

  const detached = replacePane(layout.root, source.id, withoutTab(source, tabId));
  if (!detached) return layout;
  const withTab = mapPane(detached, target.paneId, (pane) => {
    const tabIds = [...pane.tabIds];
    tabIds.splice(Math.max(0, Math.min(index, tabIds.length)), 0, tabId);
    return { ...pane, tabIds, activeTabId: tabId };
  });
  return commit(layout, withTab, target.paneId);
}

/**
 * Split `targetPaneId` along `axis` and move `tabId` into the new pane. The
 * source tab is detached first, so an edge drop that empties its own source
 * collapses that source before the new geometry is measured — which is why the
 * preview has to be computed from the returned layout, not the current one.
 *
 * A pane's sole tab dropped on its own edge is a no-op: there is nothing to
 * split off.
 */
export function splitPaneWithTab(
  layout: Layout,
  targetPaneId: string,
  axis: "x" | "y",
  placement: "before" | "after",
  tabId: string,
): Layout {
  const source = paneOfTab(layout, tabId);
  const target = findPane(layout, targetPaneId);
  if (!source || !target) return layout;
  if (source.id === target.id && source.tabIds.length === 1) return layout;

  const detached = replacePane(layout.root, source.id, withoutTab(source, tabId));
  if (!detached) return layout;

  const remaining = findPane(detached, targetPaneId);
  if (!remaining) return layout;

  const created = createPane([tabId], tabId);
  const split: Split = {
    kind: "split",
    id: createSplitId(),
    axis,
    children: placement === "before" ? [created, remaining] : [remaining, created],
    ratio: 0.5,
  };
  const root = replacePane(detached, targetPaneId, split) ?? split;
  return commit(layout, root, created.id);
}

/** Split `targetPaneId` and open `tabIds` (already created by the caller) in
 *  the new pane — the sidebar's multi-file edge drop. */
export function splitPaneWithTabs(
  layout: Layout,
  targetPaneId: string,
  axis: "x" | "y",
  placement: "before" | "after",
  tabIds: string[],
): Layout {
  const target = findPane(layout, targetPaneId);
  if (!target || tabIds.length === 0) return layout;

  const created = createPane(tabIds, tabIds[0]!);
  const split: Split = {
    kind: "split",
    id: createSplitId(),
    axis,
    children: placement === "before" ? [created, target] : [target, created],
    ratio: 0.5,
  };
  const root = replacePane(layout.root, targetPaneId, split) ?? split;
  return commit(layout, root, created.id);
}

/** Commit a completed resize. Live dragging belongs to the resize library. */
export function setSplitRatio(layout: Layout, splitId: string, ratio: number): Layout {
  const next = clampRatio(ratio);
  const apply = (node: LayoutNode): LayoutNode => {
    if (node.kind === "pane") return node;
    if (node.id === splitId) return node.ratio === next ? node : { ...node, ratio: next };
    const first = apply(node.children[0]);
    const second = apply(node.children[1]);
    if (first === node.children[0] && second === node.children[1]) return node;
    return { ...node, children: [first, second] };
  };
  return commit(layout, apply(layout.root), layout.focusedPaneId);
}

// --- geometry --------------------------------------------------------------

/** The smallest rectangle a subtree can be drawn in, separators included. */
export function minimumSize(node: LayoutNode): Size {
  if (node.kind === "pane") return { width: PANE_MIN_WIDTH, height: PANE_MIN_HEIGHT };
  const first = minimumSize(node.children[0]);
  const second = minimumSize(node.children[1]);
  if (node.axis === "x") {
    return {
      width: first.width + second.width + SEPARATOR_SIZE,
      height: Math.max(first.height, second.height),
    };
  }
  return {
    width: Math.max(first.width, second.width),
    height: first.height + second.height + SEPARATOR_SIZE,
  };
}

export function fitsWithin(size: Size, available: Size): boolean {
  return size.width <= available.width && size.height <= available.height;
}

/** Node ID → rectangle, for a tree drawn into `rect`. Splits are included so
 *  a subtree's allocation can be read off as easily as a pane's. */
export function computeBounds(node: LayoutNode, rect: Rect): Map<string, Rect> {
  const bounds = new Map<string, Rect>();
  const walk = (current: LayoutNode, area: Rect) => {
    bounds.set(current.id, area);
    if (current.kind === "pane") return;
    if (current.axis === "x") {
      const usable = Math.max(0, area.width - SEPARATOR_SIZE);
      const first = usable * current.ratio;
      walk(current.children[0], { ...area, width: first });
      walk(current.children[1], {
        ...area,
        x: area.x + first + SEPARATOR_SIZE,
        width: usable - first,
      });
      return;
    }
    const usable = Math.max(0, area.height - SEPARATOR_SIZE);
    const first = usable * current.ratio;
    walk(current.children[0], { ...area, height: first });
    walk(current.children[1], {
      ...area,
      y: area.y + first + SEPARATOR_SIZE,
      height: usable - first,
    });
  };
  walk(node, rect);
  return bounds;
}

/** The rectangle `paneId` would occupy if `layout` were the committed tree —
 *  the drop preview's authority, since a candidate layout may already have
 *  collapsed the drag's source pane. */
export function candidateBounds(layout: Layout, rect: Rect, paneId: string): Rect | null {
  return computeBounds(layout.root, rect).get(paneId) ?? null;
}

// --- drop targets ----------------------------------------------------------

export type EdgeRegion = Exclude<DropRegion, "center">;

/**
 * Each edge band is this share of the body along its axis, so the centre is
 * the middle 40% both ways. Proportional, with no pixel cap: a cap made the
 * centre of a wide pane hundreds of pixels across, and a split then needed a
 * long drag from wherever the tab was picked up. The centre is always
 * reachable because the bands never meet.
 */
export const EDGE_BAND_FRACTION = 0.3;

/**
 * The one table that says what each edge means: which axis the split runs
 * along and which side of the target the new pane lands on. Hit-testing,
 * preview, and commit all read it; nothing else encodes an edge.
 */
export const EDGES: Record<EdgeRegion, { axis: "x" | "y"; placement: "before" | "after" }> = {
  left: { axis: "x", placement: "before" },
  right: { axis: "x", placement: "after" },
  top: { axis: "y", placement: "before" },
  bottom: { axis: "y", placement: "after" },
};

export function containsPoint(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

/**
 * Which region of a pane body `point` is in, or `null` when it is outside.
 * At a corner the nearest edge in normalized band units wins; exact ties go
 * left, right, top, bottom — the order of the table below.
 */
export function resolveDropRegion(rect: Rect, point: Point): DropRegion | null {
  if (!containsPoint(rect, point)) return null;
  const bandX = rect.width * EDGE_BAND_FRACTION;
  const bandY = rect.height * EDGE_BAND_FRACTION;
  const normalized = (distance: number, band: number) =>
    band > 0 ? distance / band : Number.POSITIVE_INFINITY;
  const edges: Array<[EdgeRegion, number]> = [
    ["left", normalized(point.x - rect.x, bandX)],
    ["right", normalized(rect.x + rect.width - point.x, bandX)],
    ["top", normalized(point.y - rect.y, bandY)],
    ["bottom", normalized(rect.y + rect.height - point.y, bandY)],
  ];
  let best: EdgeRegion | null = null;
  let bestDistance = 1;
  for (const [region, distance] of edges) {
    if (distance < bestDistance) {
      best = region;
      bestDistance = distance;
    }
  }
  return best ?? "center";
}

function parentSplit(node: LayoutNode, childId: string): Split | null {
  if (node.kind === "pane") return null;
  if (node.children.some((child) => child.id === childId)) return node;
  return parentSplit(node.children[0], childId) ?? parentSplit(node.children[1], childId);
}

/**
 * Turn a transitioned layout into a candidate, or `null` when the drop must
 * not be offered. `previewPaneId` is the pane whose final rectangle the
 * preview paints. For a split, both children of the split that now holds that
 * pane must fit their minima inside the allocation the tree actually gives
 * them — the whole window fitting is not enough, since ratios elsewhere can
 * starve the target.
 */
function finalizeCandidate(
  layout: Layout,
  next: Layout,
  targetPaneId: string,
  region: DropRegion,
  area: Rect,
  previewPaneId: string,
): DropCandidate | null {
  if (next === layout && region !== "center") return null;
  const bounds = computeBounds(next.root, area);
  const previewRect = bounds.get(previewPaneId);
  if (!previewRect) return null;

  if (region !== "center") {
    const split = parentSplit(next.root, previewPaneId);
    if (!split) return null;
    for (const child of split.children) {
      const allocation = bounds.get(child.id);
      if (!allocation || !fitsWithin(minimumSize(child), allocation)) return null;
    }
  }

  return {
    targetPaneId,
    region,
    insertionIndex: null,
    expectedRevision: layout.revision,
    layout: next,
    previewRect,
  };
}

export interface FileDropItem {
  /** The tab minted for this file, used when the pane does not already show it. */
  tabId: string;
  /** A tab in the target pane that already shows this file. Only honoured at
   *  the centre: an edge drop is a deliberate second view. */
  existingTabId: string | null;
}

/**
 * The sidebar's drop: open `items` in `targetPaneId` at the centre, or in a
 * new pane split off its `region` edge. The first item ends up active either
 * way. Returns `null` when the drop must not be offered — the pane is gone,
 * or the split would leave a pane below its minimum.
 */
export function buildFileDropCandidate(
  layout: Layout,
  targetPaneId: string,
  region: DropRegion,
  area: Rect,
  items: FileDropItem[],
): DropCandidate | null {
  if (!findPane(layout, targetPaneId) || items.length === 0) return null;
  const first = items[0]!;

  if (region === "center") {
    let next = layout;
    for (const item of items) {
      if (item.existingTabId) continue;
      next = insertTab(next, targetPaneId, item.tabId, Number.POSITIVE_INFINITY, {
        activate: false,
      });
    }
    next = activateTab(next, first.existingTabId ?? first.tabId);
    if (paneOfTab(next, first.existingTabId ?? first.tabId)?.id !== targetPaneId) return null;
    return finalizeCandidate(layout, next, targetPaneId, region, area, targetPaneId);
  }

  const edge = EDGES[region];
  const tabIds = items.map((item) => item.tabId);
  const next = splitPaneWithTabs(layout, targetPaneId, edge.axis, edge.placement, tabIds);
  const created = paneOfTab(next, first.tabId);
  if (next === layout || !created) return null;
  return finalizeCandidate(layout, next, targetPaneId, region, area, created.id);
}

/**
 * Where a dragged tab is going: a strip gap (the strip measured the gap, so
 * it hands the preview rectangle in) or a pane body region.
 */
export type TabDropTarget =
  | { paneId: string; insertionIndex: number; previewRect: Rect }
  | { paneId: string; region: DropRegion };

/**
 * A tab's drop: reorder or move into a strip, move to a pane centre, or split
 * off an edge. One transition, so an edge drop that empties its source pane
 * previews the geometry left *after* that pane collapses.
 *
 * `duplicateTabId` is a tab in the target pane already showing the moved
 * tab's document. The moved tab survives — its id, history, and view state
 * are what the user picked up — and the duplicate leaves the layout in the
 * same update. Only strip and centre drops replace; an edge drop is a
 * deliberate second view.
 *
 * Returns `null` whenever the drop must not be offered: the tab or pane is
 * gone, the drop would change nothing, a sole tab meets its own edge, or the
 * split would starve a pane below its minimum.
 */
export function buildTabDropCandidate(
  layout: Layout,
  tabId: string,
  target: TabDropTarget,
  area: Rect,
  duplicateTabId: string | null,
): DropCandidate | null {
  const source = paneOfTab(layout, tabId);
  if (!source || !findPane(layout, target.paneId)) return null;
  const duplicate = duplicateTabId !== null && duplicateTabId !== tabId ? duplicateTabId : null;

  if ("region" in target && target.region !== "center") {
    const edge = EDGES[target.region];
    const next = splitPaneWithTab(layout, target.paneId, edge.axis, edge.placement, tabId);
    const created = paneOfTab(next, tabId);
    if (next === layout || !created) return null;
    return finalizeCandidate(layout, next, target.paneId, target.region, area, created.id);
  }

  // The centre of the tab's own pane is where it already is.
  if ("region" in target && source.id === target.paneId) return null;

  const index = "region" in target ? Number.POSITIVE_INFINITY : target.insertionIndex;
  if (source.id === target.paneId) {
    const remaining = source.tabIds.filter((id) => id !== tabId);
    remaining.splice(Math.max(0, Math.min(index, remaining.length)), 0, tabId);
    if (remaining.join(" ") === source.tabIds.join(" ")) return null;
  }

  // Insert before removing the duplicate: if the duplicate was the target's
  // only tab, removing it first would collapse the pane we are moving into.
  let next = moveTab(layout, tabId, { paneId: target.paneId, index });
  if (next === layout) return null;
  if (duplicate) next = removeTab(next, duplicate);
  if (paneOfTab(next, tabId)?.id !== target.paneId) return null;

  if ("region" in target) {
    return finalizeCandidate(layout, next, target.paneId, "center", area, target.paneId);
  }
  return {
    targetPaneId: target.paneId,
    region: null,
    insertionIndex: target.insertionIndex,
    expectedRevision: layout.revision,
    layout: next,
    previewRect: target.previewRect,
  };
}
