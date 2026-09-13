import { useCallback } from "react";
import { useActiveTab, useActiveTabId, useOpenTabs } from "@/hooks/use-tabs";
import { usePane } from "@/hooks/use-editor-layout";
import { useEditorStore } from "@/stores/editor-store";
import { paneOfTab } from "@/lib/editor-layout";
import type { Tab } from "@/stores/editor-store";
import { pageKind } from "./page-kinds";
import { pageKindView } from "./page-kinds/views";
import { PaneLayout } from "./pane-layout";
import { setPaneContainer, usePaneRect } from "./pane-bounds";
import { EditorSearchOverlay } from "./editor-search-overlay";
import { EditorNoticeBanner } from "./editor-notice-banner";

interface EditorAreaProps {
  showFooter?: boolean;
}

/**
 * One tab body, kept at a stable place in the React tree for the whole life of
 * its tab, and positioned over whichever pane currently owns it.
 *
 * This indirection is the point of the whole arrangement: rendering bodies
 * inside the pane tree would remount a moved tab's editor even with a stable
 * key, because its parent chain changes. A remount loses undo history and
 * cursor, and for a drawing it can flush a write — so a move would silently
 * save. Here the parent never changes; only `style` does.
 */
function TabHost({ tab, isFocused }: { tab: Tab; isFocused: boolean }) {
  // Which pane owns this tab is layout state, so read it from the store rather
  // than threading it down through the tree that must not own these bodies.
  const paneId = useEditorStore((s) => paneOfTab(s.layout, tab.id)?.id ?? null);
  const pane = usePane(paneId ?? "");
  const rect = usePaneRect(paneId ?? "");
  const isVisible = pane?.activeTabId === tab.id;

  const kind = pageKind(tab.location);
  if (!kind.keepAlive && !isVisible) return null;
  if (!rect) return null;

  const Component = pageKindView(tab.location).Component as React.ComponentType<{
    location: typeof tab.location;
    tabId: string;
    isVisible: boolean;
    isFocused: boolean;
  }>;

  return (
    <div
      data-tab-host={tab.id}
      className="absolute"
      style={{
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        // A body that is not its pane's active tab stays mounted but takes up
        // no visual space and receives nothing.
        display: isVisible ? undefined : "none",
      }}
    >
      <Component
        location={tab.location}
        tabId={tab.id}
        isVisible={isVisible}
        isFocused={isFocused}
      />
    </div>
  );
}

function EditorArea({ showFooter = true }: EditorAreaProps) {
  const activeTab = useActiveTab();
  const activeTabId = useActiveTabId();
  const tabs = useOpenTabs();

  const containerRef = useCallback((element: HTMLDivElement | null) => {
    setPaneContainer(element);
  }, []);

  return (
    <div className="relative h-full overflow-hidden">
      <div ref={containerRef} className="relative h-full min-h-0 overflow-hidden">
        {/* Chrome and geometry only — the bodies below are positioned over the
            rectangles these slots measure. */}
        <PaneLayout />
        {tabs.map((tab) => (
          <TabHost key={tab.id} tab={tab} isFocused={tab.id === activeTabId} />
        ))}
      </div>
      {showFooter && activeTab
        ? pageKindView(activeTab.location).renderFooter?.(activeTab.location)
        : null}
      <EditorSearchOverlay />
      <EditorNoticeBanner />
    </div>
  );
}

export { EditorArea };
