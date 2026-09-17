import { EditorView, keymap, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { create } from "zustand";
import { findHighlightCoveringRange, highlightContext } from "@/lib/highlight/emit";
import { treeChanged } from "@/lib/prosemark-core/utils";
import { findOuterScroller } from "./editor-scroll";
import "./highlight.css";

export interface BarSnapshot {
  left: number;
  top: number;
  activeHex: string | null;
}

export interface HighlightBarState {
  snapshots: Map<EditorView, BarSnapshot>;
  dismissedViews: Set<EditorView>;
  focusRequests: Map<EditorView, number>;
}

/** Per-view anchor positions and interaction state; the component subscribes
 *  only to its own view's entry. Positions live in the scroller's content
 *  space so they survive scroll without republishing. */
export const useHighlightBarStore = create<HighlightBarState>(() => ({
  snapshots: new Map(),
  dismissedViews: new Set(),
  focusRequests: new Map(),
}));

export function resetHighlightBarStore() {
  useHighlightBarStore.setState({
    snapshots: new Map(),
    dismissedViews: new Set(),
    focusRequests: new Map(),
  });
}

export function publishSnapshot(view: EditorView, snap: BarSnapshot | null) {
  useHighlightBarStore.setState((s) => {
    const had = s.snapshots.get(view);
    if (snap === null) {
      if (!had) return s;
      const next = new Map(s.snapshots);
      next.delete(view);
      return { snapshots: next };
    }
    if (had && had.left === snap.left && had.top === snap.top && had.activeHex === snap.activeHex) {
      return s;
    }
    const next = new Map(s.snapshots);
    next.set(view, snap);
    return { snapshots: next };
  });
}

const BAR_HEIGHT = 30;
const BAR_OFFSET = 8;

export function dismissHighlightBar(view: EditorView) {
  useHighlightBarStore.setState((s) => {
    const nextDismissed = new Set(s.dismissedViews);
    nextDismissed.add(view);
    return { dismissedViews: nextDismissed };
  });
  publishSnapshot(view, null);
}

export function isHighlightBarOpen(view: EditorView): boolean {
  const s = useHighlightBarStore.getState();
  return Boolean(s.snapshots.get(view)) && !s.dismissedViews.has(view);
}

export function measureHighlightBar(view: EditorView, forceRecompute = true) {
  view.requestMeasure({
    read() {
      const live = view.state.selection.main;
      const context = live.empty ? null : highlightContext(view.state, live.from, live.to);
      if (live.empty || view.state.readOnly || context === null) {
        return null;
      }
      const activeHex = forceRecompute
        ? (findHighlightCoveringRange(
            view.state.doc.toString(),
            live.from,
            live.to,
            context.kind === "math" ? "math" : "prose",
          )?.hex ?? null)
        : (useHighlightBarStore.getState().snapshots.get(view)?.activeHex ?? null);
      const scroller = findOuterScroller(view.dom);
      const head = view.coordsAtPos(live.from);
      const tail = view.coordsAtPos(live.to);
      if (!scroller || !head) return null;
      const rect = scroller.getBoundingClientRect();
      const originTop = rect.top + scroller.clientTop;
      const originLeft = rect.left + scroller.clientLeft;
      const left = head.left - originLeft + scroller.scrollLeft;
      const above = head.top - originTop + scroller.scrollTop - BAR_HEIGHT - BAR_OFFSET;
      const top =
        above >= 0
          ? above
          : (tail?.bottom ?? head.bottom) - originTop + scroller.scrollTop + BAR_OFFSET;
      return { left, top, activeHex };
    },
    write(snap) {
      publishSnapshot(view, snap);
    },
  });
}

export function openAndFocusHighlightBar(view: EditorView): boolean {
  const sel = view.state.selection.main;
  if (sel.empty || view.state.readOnly || highlightContext(view.state, sel.from, sel.to) === null) {
    return false;
  }
  useHighlightBarStore.setState((s) => {
    const nextDismissed = new Set(s.dismissedViews);
    nextDismissed.delete(view);
    const nextRequests = new Map(s.focusRequests);
    nextRequests.set(view, (nextRequests.get(view) ?? 0) + 1);
    return { dismissedViews: nextDismissed, focusRequests: nextRequests };
  });
  measureHighlightBar(view, true);
  return true;
}

export function handleHighlightBarEscape(view: EditorView): boolean {
  if (!isHighlightBarOpen(view)) return false;
  dismissHighlightBar(view);
  return true;
}

export const highlightBarKeymap = keymap.of([
  {
    key: "Escape",
    run: handleHighlightBarEscape,
  },
]);

export const highlightBarPlugin = ViewPlugin.define((view) => ({
  update(update: ViewUpdate) {
    if (
      !update.docChanged &&
      !update.selectionSet &&
      !update.viewportChanged &&
      !treeChanged(update)
    ) {
      return;
    }
    const sel = update.state.selection.main;
    if (update.selectionSet) {
      useHighlightBarStore.setState((s) => {
        if (!s.dismissedViews.has(view)) return s;
        const nextDismissed = new Set(s.dismissedViews);
        nextDismissed.delete(view);
        return { dismissedViews: nextDismissed };
      });
    }
    // Empty selection, read-only surface, code, or a selection whose ends
    // disagree (math into prose): the bar is hidden, never guessed. The
    // context probe runs here so a doc change that moves the selection into
    // code hides it without waiting for a press.
    if (
      sel.empty ||
      update.state.readOnly ||
      highlightContext(update.state, sel.from, sel.to) === null
    ) {
      publishSnapshot(view, null);
      return;
    }
    if (useHighlightBarStore.getState().dismissedViews.has(view)) {
      return;
    }
    // Layout reads go through requestMeasure, never inside the update
    // handler itself (docs/editor.md). The measure re-resolves the live
    // selection — a transaction landing between the update and the measure
    // must not anchor the bar to a range that no longer exists (FR-017).
    const recomputeActive = update.docChanged || update.selectionSet;
    measureHighlightBar(view, recomputeActive);
  },
  destroy() {
    publishSnapshot(view, null);
    useHighlightBarStore.setState((s) => {
      let changed = false;
      let nextDismissed = s.dismissedViews;
      if (s.dismissedViews.has(view)) {
        nextDismissed = new Set(s.dismissedViews);
        nextDismissed.delete(view);
        changed = true;
      }
      let nextRequests = s.focusRequests;
      if (s.focusRequests.has(view)) {
        nextRequests = new Map(s.focusRequests);
        nextRequests.delete(view);
        changed = true;
      }
      return changed ? { dismissedViews: nextDismissed, focusRequests: nextRequests } : s;
    });
  },
}));
