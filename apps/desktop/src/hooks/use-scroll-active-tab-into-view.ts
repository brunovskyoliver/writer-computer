import { useEffect, type RefObject } from "react";
import { usePaneActiveTabId } from "./use-editor-layout";

/**
 * Scrolls a pane's active tab (tagged with `data-tab-id={tabId}`) into view
 * inside that pane's strip whenever the pane's active tab changes.
 *
 * - Uses instant scrolling (no animation).
 * - Skips the scroll if the tab is already fully visible.
 */
export function useScrollActiveTabIntoView(
  paneId: string,
  stripRef: RefObject<HTMLElement | null>,
) {
  const activeTabId = usePaneActiveTabId(paneId);

  useEffect(() => {
    const strip = stripRef.current;
    if (!activeTabId || !strip) return;
    const tab = strip.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeTabId)}"]`);
    if (!tab) return;

    const stripRect = strip.getBoundingClientRect();
    const tabRect = tab.getBoundingClientRect();
    const fullyVisible = tabRect.left >= stripRect.left && tabRect.right <= stripRect.right;
    if (fullyVisible) return;

    tab.scrollIntoView({
      behavior: "auto",
      block: "nearest",
      inline: "nearest",
    });
  }, [activeTabId, stripRef]);
}
