import { useSyncExternalStore } from "react";
import { getEditorAreaGeometry, type PaneRect } from "@/components/editor-area/pane-bounds";
import { locationBehavior } from "@/components/editor-area/page-kinds";
import {
  buildFileDropCandidate,
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
 * sidebar today, a tab from a strip next — is armed here. The coordinator owns
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
}

export type DragSource = {
  kind: "files";
  paths: string[];
  /** False when the selection holds something that is not a document (a
   *  folder): the editor area is then not a target at all. */
  droppable: boolean;
};

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

interface DragSession {
  pointerId: number;
  target: PointerCaptureTarget | null;
  source: DragSource;
  adapter: DragAdapter;
  workspace: unknown;
  start: Point;
  point: Point;
  started: boolean;
  drop: FileDrop | null;
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

/**
 * Resolve a file selection at `point` against the live layout: which pane,
 * which region, and the exact layout that would commit. Null when the point
 * is outside every pane body or the drop must not be offered there.
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
  const local = { x: point.x - geometry.area.x, y: point.y - geometry.area.y };
  const area = { x: 0, y: 0, width: geometry.area.width, height: geometry.area.height };

  for (const [paneId, body] of geometry.panes) {
    const rect = { x: body.left, y: body.top, width: body.width, height: body.height };
    const region = resolveDropRegion(rect, local);
    if (!region) continue;

    const items = paths.map((path) => ({
      tabId: tabForPath(path).id,
      existingTabId: region === "center" ? existingTabForPath(layout, tabs, paneId, path) : null,
    }));
    const candidate = buildFileDropCandidate(layout, paneId, region, area, items);
    if (!candidate) return null;
    const newTabs = items.flatMap((item, index) =>
      item.existingTabId ? [] : [tabForPath(paths[index]!)],
    );
    return { candidate, newTabs };
  }
  return null;
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

  const setDrop = (drop: FileDrop | null) => {
    if (!session) return;
    const changed = !sameCandidate(session.drop?.candidate ?? null, drop?.candidate ?? null);
    session.drop = drop;
    if (changed) notify();
  };

  const resolve = (current: DragSession): FileDrop | null => {
    if (!current.source.droppable) return null;
    const geometry = env.geometry();
    if (!geometry) return null;
    const { layout, tabs } = env.editor();
    return resolveFileDrop({
      layout,
      tabs,
      geometry,
      point: current.point,
      paths: current.source.paths,
      tabForPath: (path) => {
        let tab = current.tabsByPath.get(path);
        if (!tab) {
          tab = env.createFileTab(path);
          current.tabsByPath.set(path, tab);
        }
        return tab;
      },
    });
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
    if (current.adapter.isSourceValid && !current.adapter.isSourceValid()) {
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

  const commit = (current: DragSession, drop: FileDrop) => {
    const isCurrent = () => env.isWorkspaceCurrent(current.workspace);
    void env
      .openFilesFromDrop(drop, isCurrent)
      .then((outcome) => {
        if (outcome.status === "failed") env.reportFailure(describeFailure(outcome.errors));
      })
      .catch((error: unknown) => {
        env.reportFailure(describeFailure([{ path: current.source.paths.join(", "), error }]));
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
    const sourceValid = current.adapter.isSourceValid?.() ?? true;
    // Resolve against the layout as it is at release, not as it was on the
    // last frame: a candidate is only ever valid for one revision.
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
    getCandidate: () => session?.drop?.candidate ?? null,
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
