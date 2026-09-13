import { findPane, minimumSize, type LayoutNode, type Pane, type Size } from "@/lib/editor-layout";
import { useEditorStore } from "@/stores/editor-store";

/**
 * Read access to the window's layout tree, one slice per hook.
 *
 * The tree is immutable and shares structure between revisions, so a `Pane`
 * node keeps its identity across any update that did not touch it. That is
 * what lets these selectors return objects and arrays straight out of the tree
 * without a shallow comparator: `Object.is` is already the right test (see
 * docs/zustand.md).
 *
 * There is no writable layout state here. The editor store owns the one tree,
 * because a move has to change pane membership, active tabs, and focus
 * together or not at all.
 */

export function useLayoutRoot(): LayoutNode {
  return useEditorStore((s) => s.layout.root);
}

/** Bumped by layout changes only — never by typing. */
export function useLayoutRevision() {
  return useEditorStore((s) => s.layout.revision);
}

export function useFocusedPaneId() {
  return useEditorStore((s) => s.layout.focusedPaneId);
}

export function usePane(paneId: string): Pane | null {
  return useEditorStore((s) => findPane(s.layout, paneId));
}

/** The pane's tab ids in strip order. Map them against `useOpenTabs()` to get
 *  the tabs themselves; this stays a raw slice so it keeps its identity. */
export function usePaneTabIds(paneId: string): string[] | undefined {
  return useEditorStore((s) => findPane(s.layout, paneId)?.tabIds);
}

export function usePaneActiveTabId(paneId: string) {
  return useEditorStore((s) => findPane(s.layout, paneId)?.activeTabId ?? null);
}

export function useIsPaneFocused(paneId: string) {
  return useEditorStore((s) => s.layout.focusedPaneId === paneId);
}

/**
 * Whether `tabId` is the one tab that receives global commands and keyboard
 * focus. A tab can be visible in its own pane without being this one — see
 * `isVisible` versus `isFocused` in the page-kind view contract.
 */
export function useIsTabFocused(tabId: string) {
  return useEditorStore((s) => s.activeTabId === tabId);
}

export function useSetFocusedPane() {
  return useEditorStore((s) => s.setFocusedPane);
}

export function useSetSplitRatio() {
  return useEditorStore((s) => s.setSplitRatio);
}

/** The smallest editor area the whole tree fits in. A window shrunk below
 *  it scrolls rather than starving panes; the selector returns a new object
 *  only when the number is new, so it is cheap to subscribe to. */
export function useLayoutMinimumSize(): Size {
  const width = useEditorStore((s) => minimumSize(s.layout.root).width);
  const height = useEditorStore((s) => minimumSize(s.layout.root).height);
  return { width, height };
}
