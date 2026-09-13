import { useSyncExternalStore } from "react";
import {
  getEditorAreaGeometry,
  type PaneRect,
  type StripRect,
} from "@/components/editor-area/pane-bounds";
import { locationBehavior, serializeLocation } from "@/components/editor-area/page-kinds";
import {
  buildFileDropCandidate,
  buildTabDropCandidate,
  containsPoint,
  findPane,
  resolveDropRegion,
  type DropCandidate,
  type Layout,
  type Point,
  type Rect,
} from "@/lib/editor-layout";
import { getWorkspaceIdentity, isCurrentWorkspaceIdentity } from "@/hooks/workspace-api";
import {
  createFileTab,
  useEditorStore,
  type FileDrop,
  type FileDropOutcome,
  type Tab,
} from "@/stores/editor-store";

/**
 * The window's one pointer-drag coordinator.
 *
 * Every drag that can end in the editor area — a file selection from the
 * sidebar, a tab from a strip — is armed here. The coordinator owns
 * what must be owned exactly once: the activation threshold, pointer capture,
 * the per-frame geometry pass, the resolved candidate, and every way a drag
 * can end (release, Escape, pointercancel, lost capture, blur). The source
 * plugs in an *adapter* for what only it knows: how to draw its ghost, what
 * a release outside the editor means (the tree's move on disk), and whether
 * its source still exists.
 *
 * One release, one owner: if there is an editor candidate it commits through
 * the store and the adapter is not consulted, so a sidebar drag can never both
 * open a file and move it on disk (spec FR-010).
 *
 * The coordinator is built from a `DragEnvironment` rather than touching
 * `window` directly, so the whole gesture is testable without a DOM. The
 * app-facing singleton at the bottom binds it to the real window.
 */

// Distance the pointer must travel before a press becomes a drag, so plain
// clicks still open and select. Shipped with the sidebar; kept as is.
export const DRAG_THRESHOLD_PX = 4;

export interface EditorAreaGeometry {
  /** The editor area in the pointer's coordinate space. */
  area: Rect;
  /** Pane bodies, relative to `area`. */
  panes: ReadonlyMap<string, PaneRect>;
  /** Tab strips and their tab boxes, relative to `area`. A strip takes
   *  precedence over the body it floats over. */
  strips: ReadonlyMap<string, StripRect>;
}

export type DragSource =
  | {
      kind: "files";
      paths: string[];
      /** False when the selection holds something that is not a document (a
       *  folder): the editor area is then not a target at all. */
      droppable: boolean;
    }
  | { kind: "tab"; tabId: string };

export interface DragAdapter {
  /** The threshold was crossed; the drag is now live. */
  onActivate?: () => void;
  /** Once per animation frame while live. `overEditor` means the editor has
   *  claimed this position, so the adapter must not offer a target of its own. */
  onFrame?: (point: Point, overEditor: boolean) => void;
  /** Checked every frame and at release. False cancels: the source was
   *  renamed, deleted, or otherwise stopped existing under the pointer. */
  isSourceValid?: () => boolean;
  /** Released with no editor candidate; the adapter may perform its own
   *  drop. Only called for a drag that activated. */
  onRelease?: (point: Point) => void;
  /** Every end path, after the coordinator has torn the drag down. */
  onEnd?: () => void;
}

export interface PointerCaptureTarget {
  setPointerCapture: (pointerId: number) => void;
  releasePointerCapture: (pointerId: number) => void;
  hasPointerCapture: (pointerId: number) => boolean;
}

export interface DragPress {
  pointerId: number;
  clientX: number;
  clientY: number;
  /** The pressed element. Capturing on it keeps the drag alive while the
   *  pointer crosses elements that are not hit-testable mid-drag. */
  target?: PointerCaptureTarget | null;
}

interface PointerLike {
  pointerId?: number;
  clientX?: number;
  clientY?: number;
  key?: string;
}

export interface DragEnvironment {
  listen: (type: string, handler: (event: PointerLike) => void, signal: AbortSignal) => void;
  requestFrame: (callback: () => void) => number;
  cancelFrame: (id: number) => void;
  geometry: () => EditorAreaGeometry | null;
  editor: () => { layout: Layout; tabs: Tab[] };
  createFileTab: (path: string) => Tab;
  workspaceIdentity: () => unknown;
  isWorkspaceCurrent: (identity: unknown) => boolean;
  openFilesFromDrop: (drop: FileDrop, isCurrent: () => boolean) => Promise<FileDropOutcome>;
  /** Synchronous: a tab move needs no I/O. False means the store refused it. */
  moveTabFromDrop: (candidate: DropCandidate) => boolean;
  suppressNextClick: () => void;
  reportFailure: (message: string) => void;
}

export interface DragCoordinator {
  arm: (press: DragPress, source: DragSource, adapter: DragAdapter) => void;
  cancel: () => void;
  isActive: () => boolean;
  /** The candidate the preview paints and a release would commit. */
  getCandidate: () => DropCandidate | null;
  subscribe: (listener: () => void) => () => void;
}

/** What the last frame resolved: the sidebar's drop with its minted tabs, or
 *  a tab's candidate. Both carry the one candidate the preview paints. */
type ResolvedDrop = { kind: "files"; drop: FileDrop } | { kind: "tab"; candidate: DropCandidate };

interface DragSession {
  pointerId: number;
  target: PointerCaptureTarget | null;
  source: DragSource;
  adapter: DragAdapter;
  workspace: unknown;
  start: Point;
  point: Point;
  started: boolean;
  drop: ResolvedDrop | null;
  /** A tab source's location at press time. If the tab is renamed or deleted
   *  under the pointer, the thing being dragged is gone and the drag ends. */
  sourceLocation: string | null;
  frame: number | null;
  abort: AbortController;
  /** One tab per path for the life of the drag, so the candidate's tab ids
   *  are stable across frames and the commit reuses exactly what was previewed. */
  tabsByPath: Map<string, Tab>;
}

// --- pure resolution ---------------------------------------------------------

function tabPath(tab: Tab): string | null {
  return locationBehavior(tab.location).primaryPath(tab.location);
}

/** The tab in `paneId` already showing `path`: the active one if it matches,
 *  else the first in strip order. */
function existingTabForPath(layout: Layout, tabs: Tab[], paneId: string, path: string) {
  const pane = findPane(layout, paneId);
  if (!pane) return null;
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const matches = pane.tabIds.filter((tabId) => {
    const tab = byId.get(tabId);
    return tab ? tabPath(tab) === path : false;
  });
  if (matches.length === 0) return null;
  return matches.find((tabId) => tabId === pane.activeTabId) ?? matches[0]!;
}

/** Width of the insertion bar painted in a strip gap. */
const INSERTION_GAP_WIDTH = 4;

/**
 * The strip under `point`, with the insertion index the pointer is nearest:
 * the count of tabs (other than `excludeTabId`, the dragged tab itself) whose
 * midpoint is left of it. Excluding the source is what makes the index valid
 * for the strip *after* the source is removed. `previewRect` is the gap bar.
 */
function resolveStripInsertion(
  geometry: EditorAreaGeometry,
  local: Point,
  excludeTabId: string | null,
): { paneId: string; insertionIndex: number; previewRect: Rect } | null {
  for (const [paneId, strip] of geometry.strips) {
    const rect = { x: strip.left, y: strip.top, width: strip.width, height: strip.height };
    if (!containsPoint(rect, local)) continue;
    const tabs = strip.tabs.filter((box) => box.tabId !== excludeTabId);
    let insertionIndex = 0;
    for (const box of tabs) {
      if (local.x < box.left + box.width / 2) break;
      insertionIndex += 1;
    }
    const gapX =
      tabs.length === 0
        ? strip.left
        : insertionIndex < tabs.length
          ? tabs[insertionIndex]!.left
          : tabs[tabs.length - 1]!.left + tabs[tabs.length - 1]!.width;
    return {
      paneId,
      insertionIndex,
      previewRect: {
        x: gapX - INSERTION_GAP_WIDTH / 2,
        y: strip.top,
        width: INSERTION_GAP_WIDTH,
        height: strip.height,
      },
    };
  }
  return null;
}

/** The pane body under `local`, and which of its regions. */
function resolveBodyRegion(geometry: EditorAreaGeometry, local: Point) {
  for (const [paneId, body] of geometry.panes) {
    const rect = { x: body.left, y: body.top, width: body.width, height: body.height };
    const region = resolveDropRegion(rect, local);
    if (region) return { paneId, region };
  }
  return null;
}

function localPoint(geometry: EditorAreaGeometry, point: Point): Point {
  return { x: point.x - geometry.area.x, y: point.y - geometry.area.y };
}

function areaRect(geometry: EditorAreaGeometry): Rect {
  return { x: 0, y: 0, width: geometry.area.width, height: geometry.area.height };
}

/**
 * Resolve a dragged tab at `point`: a strip gap first, else a body region.
 * Null outside every target or where the drop must not be offered.
 */
export function resolveTabDrop({
  layout,
  tabs,
  geometry,
  point,
  tabId,
}: {
  layout: Layout;
  tabs: Tab[];
  geometry: EditorAreaGeometry;
  point: Point;
  tabId: string;
}): DropCandidate | null {
  const local = localPoint(geometry, point);
  const strip = resolveStripInsertion(geometry, local, tabId);
  const target = strip ?? resolveBodyRegion(geometry, local);
  if (!target) return null;

  const tab = tabs.find((candidate) => candidate.id === tabId);
  const path = tab ? tabPath(tab) : null;
  // Only a strip or centre drop lands in the target pane; an edge opens a
  // deliberate second view, so nothing is replaced there.
  const replaces = "insertionIndex" in target || target.region === "center";
  const duplicate = replaces && path ? existingTabForPath(layout, tabs, target.paneId, path) : null;
  return buildTabDropCandidate(layout, tabId, target, areaRect(geometry), duplicate);
}

/**
 * Resolve a file selection at `point` against the live layout: which pane,
 * which region, and the exact layout that would commit. Null when the point
 * is outside every pane body or the drop must not be offered there. A strip
 * counts as its pane's centre: the files open there as tabs.
 */
export function resolveFileDrop({
  layout,
  tabs,
  geometry,
  point,
  paths,
  tabForPath,
}: {
  layout: Layout;
  tabs: Tab[];
  geometry: EditorAreaGeometry;
  point: Point;
  paths: string[];
  tabForPath: (path: string) => Tab;
}): FileDrop | null {
  if (paths.length === 0) return null;
  const local = localPoint(geometry, point);
  const strip = resolveStripInsertion(geometry, local, null);
  const target = strip
    ? { paneId: strip.paneId, region: "center" as const }
    : resolveBodyRegion(geometry, local);
  if (!target) return null;
  const { paneId, region } = target;

  const items = paths.map((path) => ({
    tabId: tabForPath(path).id,
    existingTabId: region === "center" ? existingTabForPath(layout, tabs, paneId, path) : null,
  }));
  const candidate = buildFileDropCandidate(layout, paneId, region, areaRect(geometry), items);
  if (!candidate) return null;
  const newTabs = items.flatMap((item, index) =>
    item.existingTabId ? [] : [tabForPath(paths[index]!)],
  );
  return { candidate, newTabs };
}

function candidateOf(drop: ResolvedDrop | null): DropCandidate | null {
  if (!drop) return null;
  return drop.kind === "files" ? drop.drop.candidate : drop.candidate;
}

/** The dragged tab's identity: its id plus where it points. */
function tabSourceLocation(tabs: Tab[], tabId: string): string | null {
  const tab = tabs.find((candidate) => candidate.id === tabId);
  return tab ? JSON.stringify(serializeLocation(tab.location)) : null;
}

function sameCandidate(a: DropCandidate | null, b: DropCandidate | null) {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.targetPaneId === b.targetPaneId &&
    a.region === b.region &&
    a.insertionIndex === b.insertionIndex &&
    a.expectedRevision === b.expectedRevision &&
    a.previewRect.x === b.previewRect.x &&
    a.previewRect.y === b.previewRect.y &&
    a.previewRect.width === b.previewRect.width &&
    a.previewRect.height === b.previewRect.height
  );
}

function describeFailure(errors: Array<{ path: string; error: unknown }>) {
  const lines = errors.map(({ path, error }) => {
    const message = error instanceof Error ? error.message : String(error);
    return `• ${path} — ${message}`;
  });
  return `Couldn't open ${errors.length} file${errors.length > 1 ? "s" : ""}:\n${lines.join("\n")}`;
}

// --- coordinator ---------------------------------------------------------------

export function createDragCoordinator(env: DragEnvironment): DragCoordinator {
  let session: DragSession | null = null;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const setDrop = (drop: ResolvedDrop | null) => {
    if (!session) return;
    const changed = !sameCandidate(candidateOf(session.drop), candidateOf(drop));
    session.drop = drop;
    if (changed) notify();
  };

  const resolve = (current: DragSession): ResolvedDrop | null => {
    const geometry = env.geometry();
    if (!geometry) return null;
    const { layout, tabs } = env.editor();
    const { source } = current;
    if (source.kind === "tab") {
      const candidate = resolveTabDrop({
        layout,
        tabs,
        geometry,
        point: current.point,
        tabId: source.tabId,
      });
      return candidate ? { kind: "tab", candidate } : null;
    }
    if (!source.droppable) return null;
    const drop = resolveFileDrop({
      layout,
      tabs,
      geometry,
      point: current.point,
      paths: source.paths,
      tabForPath: (path) => {
        let tab = current.tabsByPath.get(path);
        if (!tab) {
          tab = env.createFileTab(path);
          current.tabsByPath.set(path, tab);
        }
        return tab;
      },
    });
    return drop ? { kind: "files", drop } : null;
  };

  /** The source still exists as it was picked up: the adapter's check for
   *  files, the tab's id and location for a tab. */
  const isSourceValid = (current: DragSession) => {
    if (current.adapter.isSourceValid && !current.adapter.isSourceValid()) return false;
    if (current.source.kind !== "tab") return true;
    return tabSourceLocation(env.editor().tabs, current.source.tabId) === current.sourceLocation;
  };

  /** Tear the drag down. Everything that can end a drag goes through here. */
  const teardown = () => {
    const current = session;
    if (!current) return;
    session = null;
    current.abort.abort();
    if (current.frame !== null) env.cancelFrame(current.frame);
    if (current.started && current.target?.hasPointerCapture(current.pointerId)) {
      try {
        current.target.releasePointerCapture(current.pointerId);
      } catch {
        // Capture already gone — nothing to release.
      }
    }
    current.adapter.onEnd?.();
    if (current.drop) notify();
  };

  const cancel = () => {
    if (!session) return;
    teardown();
  };

  const step = () => {
    const current = session;
    if (!current) return;
    current.frame = null;
    if (!isSourceValid(current)) {
      cancel();
      return;
    }
    // One geometry pass per frame: the candidate for where the pointer is
    // now, against the layout as it is now.
    const drop = resolve(current);
    setDrop(drop);
    current.adapter.onFrame?.(current.point, drop !== null);
    // Keep stepping while live: the adapter may autoscroll under a still
    // pointer, and the layout can change under it.
    current.frame = env.requestFrame(step);
  };

  const activate = (current: DragSession) => {
    current.started = true;
    try {
      current.target?.setPointerCapture(current.pointerId);
    } catch {
      // The pointer is no longer active; the drag still runs on window events.
    }
    current.adapter.onActivate?.();
    if (current.frame === null) current.frame = env.requestFrame(step);
  };

  const handleMove = (event: PointerLike) => {
    const current = session;
    if (!current || event.pointerId !== current.pointerId) return;
    current.point = { x: event.clientX ?? 0, y: event.clientY ?? 0 };
    if (!current.started) {
      const dx = current.point.x - current.start.x;
      const dy = current.point.y - current.start.y;
      if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
      activate(current);
    }
  };

  const commit = (current: DragSession, resolved: ResolvedDrop) => {
    if (resolved.kind === "tab") {
      // A refused move is the store seeing a newer revision than the one the
      // candidate was re-resolved against a moment ago; nothing to report.
      env.moveTabFromDrop(resolved.candidate);
      return;
    }
    const paths = current.source.kind === "files" ? current.source.paths : [];
    const isCurrent = () => env.isWorkspaceCurrent(current.workspace);
    void env
      .openFilesFromDrop(resolved.drop, isCurrent)
      .then((outcome) => {
        if (outcome.status === "failed") env.reportFailure(describeFailure(outcome.errors));
      })
      .catch((error: unknown) => {
        env.reportFailure(describeFailure([{ path: paths.join(", "), error }]));
      });
  };

  const handleUp = (event: PointerLike) => {
    const current = session;
    if (!current || event.pointerId !== current.pointerId) return;
    if (!current.started) {
      // A plain click: let it open or select as it always has.
      teardown();
      return;
    }
    if (event.clientX !== undefined && event.clientY !== undefined) {
      current.point = { x: event.clientX, y: event.clientY };
    }
    const sourceValid = isSourceValid(current);
    // Resolve against the layout and geometry as they are at release, not as
    // they were on the last frame: a candidate is only ever valid for one
    // layout revision and one set of measured rectangles. Recomputing here is
    // what makes the committed result the previewed one.
    const drop = sourceValid ? resolve(current) : null;
    env.suppressNextClick();
    if (drop) {
      teardown();
      commit(current, drop);
      return;
    }
    // The adapter decides its own drop while its state is still intact —
    // `onEnd` clears it — and the teardown runs whatever that decision does.
    try {
      if (sourceValid) current.adapter.onRelease?.(current.point);
    } finally {
      teardown();
    }
  };

  const handleCancel = (event: PointerLike) => {
    const current = session;
    if (!current) return;
    if (event.pointerId !== undefined && event.pointerId !== current.pointerId) return;
    cancel();
  };

  const handleKey = (event: PointerLike) => {
    if (event.key === "Escape") cancel();
  };

  const arm: DragCoordinator["arm"] = (press, source, adapter) => {
    // A second press while one drag is live replaces it; the first can only
    // have been left behind by a missed end event.
    cancel();
    const abort = new AbortController();
    session = {
      pointerId: press.pointerId,
      target: press.target ?? null,
      source,
      adapter,
      workspace: env.workspaceIdentity(),
      start: { x: press.clientX, y: press.clientY },
      point: { x: press.clientX, y: press.clientY },
      started: false,
      drop: null,
      sourceLocation:
        source.kind === "tab" ? tabSourceLocation(env.editor().tabs, source.tabId) : null,
      frame: null,
      abort,
      tabsByPath: new Map(),
    };
    env.listen("pointermove", handleMove, abort.signal);
    env.listen("pointerup", handleUp, abort.signal);
    env.listen("pointercancel", handleCancel, abort.signal);
    env.listen("lostpointercapture", handleCancel, abort.signal);
    env.listen("keydown", handleKey, abort.signal);
    env.listen("blur", cancel, abort.signal);
  };

  return {
    arm,
    cancel,
    isActive: () => session !== null,
    getCandidate: () => candidateOf(session?.drop ?? null),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// --- browser binding -------------------------------------------------------------

/**
 * Swallow the single `click` the browser fires after a drag completes, so
 * dragging an item never also opens or selects it. Self-removes after that
 * click, or on the next tick if none arrives.
 */
function suppressNextClick() {
  const handler = (event: MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
    window.removeEventListener("click", handler, true);
  };
  window.addEventListener("click", handler, true);
  setTimeout(() => window.removeEventListener("click", handler, true), 0);
}

function browserEnvironment(): DragEnvironment {
  return {
    listen: (type, handler, signal) =>
      window.addEventListener(type, handler as EventListener, { signal }),
    requestFrame: (callback) => requestAnimationFrame(callback),
    cancelFrame: (id) => cancelAnimationFrame(id),
    geometry: getEditorAreaGeometry,
    editor: () => {
      const { layout, tabs } = useEditorStore.getState();
      return { layout, tabs };
    },
    createFileTab,
    workspaceIdentity: getWorkspaceIdentity,
    isWorkspaceCurrent: (identity) =>
      isCurrentWorkspaceIdentity(identity as ReturnType<typeof getWorkspaceIdentity>),
    openFilesFromDrop: (drop, isCurrent) =>
      useEditorStore.getState().openFilesFromDrop(drop, isCurrent),
    moveTabFromDrop: (candidate) => useEditorStore.getState().moveTabFromDrop(candidate),
    suppressNextClick,
    reportFailure: (message) => window.alert(message),
  };
}

let shared: DragCoordinator | null = null;

/** The app's coordinator, bound to the real window on first use. */
export function editorDrag(): DragCoordinator {
  shared ??= createDragCoordinator(browserEnvironment());
  return shared;
}

/** The live drop candidate, for the preview overlay. Null when no drag is
 *  over a valid editor target. */
export function useDropCandidate(): DropCandidate | null {
  const coordinator = editorDrag();
  return useSyncExternalStore(coordinator.subscribe, coordinator.getCandidate, () => null);
}
