import { useSyncExternalStore } from "react";

/**
 * Where each pane's body sits inside the editor area.
 *
 * Tab bodies are *not* rendered inside the pane tree. They are rendered once
 * under one stable parent and positioned over the rectangle their pane's body
 * slot measures. Rendering them inside the tree instead would remount a moved
 * tab's editor even with a stable React key, because its parent chain changes —
 * and a remount loses undo history and, for a drawing, can flush a write.
 *
 * Rectangles are relative to the editor-area container, which is the
 * positioning context the bodies are absolutely placed in.
 */
export interface PaneRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A pane's tab strip plus the box of every tab in it, in area coordinates. */
export interface StripRect extends PaneRect {
  tabs: Array<{ tabId: string; left: number; width: number }>;
}

const slots = new Map<string, HTMLElement>();
const rects = new Map<string, PaneRect>();
const strips = new Map<string, HTMLElement>();
const listeners = new Set<() => void>();

let container: HTMLElement | null = null;
let observer: ResizeObserver | null = null;

function sameRect(a: PaneRect | undefined, b: PaneRect) {
  return (
    a !== undefined &&
    a.left === b.left &&
    a.top === b.top &&
    a.width === b.width &&
    a.height === b.height
  );
}

function measureAll() {
  if (!container) return;
  const base = container.getBoundingClientRect();
  let changed = false;
  for (const [paneId, element] of slots) {
    const box = element.getBoundingClientRect();
    const next: PaneRect = {
      left: box.left - base.left,
      top: box.top - base.top,
      width: box.width,
      height: box.height,
    };
    if (sameRect(rects.get(paneId), next)) continue;
    rects.set(paneId, next);
    changed = true;
  }
  if (changed) for (const listener of listeners) listener();
}

function ensureObserver() {
  if (observer || typeof ResizeObserver === "undefined") return;
  observer = new ResizeObserver(measureAll);
}

/** The positioning context bodies are placed in. */
export function setPaneContainer(element: HTMLElement | null) {
  if (container && observer) observer.unobserve(container);
  container = element;
  if (!element) return;
  ensureObserver();
  observer?.observe(element);
  measureAll();
}

/** Register a pane's body slot. Returns the cleanup. */
export function registerPaneBody(paneId: string, element: HTMLElement | null) {
  if (!element) return () => {};
  ensureObserver();
  slots.set(paneId, element);
  observer?.observe(element);
  measureAll();
  return () => {
    observer?.unobserve(element);
    if (slots.get(paneId) === element) {
      slots.delete(paneId);
      rects.delete(paneId);
    }
  };
}

/** Register a pane's tab strip. Strips are measured on demand, not observed:
 *  their tab boxes shift with strip scrolling, which no observer reports. */
export function registerPaneStrip(paneId: string, element: HTMLElement | null) {
  if (!element) return () => {};
  strips.set(paneId, element);
  return () => {
    if (strips.get(paneId) === element) strips.delete(paneId);
  };
}

/** The current rectangles, for hit-testing a drag against pane bodies. */
export function getPaneRects(): ReadonlyMap<string, PaneRect> {
  return rects;
}

function measureStrips(base: DOMRect): Map<string, StripRect> {
  const measured = new Map<string, StripRect>();
  for (const [paneId, element] of strips) {
    const box = element.getBoundingClientRect();
    const tabs = Array.from(element.querySelectorAll<HTMLElement>("[data-tab-id]"), (tab) => {
      const tabBox = tab.getBoundingClientRect();
      return {
        tabId: tab.getAttribute("data-tab-id")!,
        left: tabBox.left - base.left,
        width: tabBox.width,
      };
    });
    measured.set(paneId, {
      left: box.left - base.left,
      top: box.top - base.top,
      width: box.width,
      height: box.height,
      tabs,
    });
  }
  return measured;
}

/**
 * The editor area in viewport coordinates plus every pane body relative to
 * it — everything a drag needs to turn a pointer position into a pane and a
 * region. Null until the area has mounted. Pane bodies and strips are the drop
 * surfaces; there are no DOM listeners on them because the dragged source
 * holds pointer capture, so hit-testing is geometric.
 */
export function getEditorAreaGeometry(): {
  area: { x: number; y: number; width: number; height: number };
  panes: ReadonlyMap<string, PaneRect>;
  strips: ReadonlyMap<string, StripRect>;
} | null {
  if (!container) return null;
  const box = container.getBoundingClientRect();
  return {
    area: { x: box.left, y: box.top, width: box.width, height: box.height },
    panes: rects,
    strips: measureStrips(box),
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The pane's measured body rectangle, or null before its first measurement.
 *  The stored object is reused until the geometry actually changes, so this is
 *  safe to compare with `Object.is`. */
export function usePaneRect(paneId: string): PaneRect | null {
  return useSyncExternalStore(
    subscribe,
    () => rects.get(paneId) ?? null,
    () => null,
  );
}
