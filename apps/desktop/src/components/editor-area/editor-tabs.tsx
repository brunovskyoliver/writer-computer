import {
  useCallback,
  useRef,
  useState,
  useTransition,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  useCloseTab,
  useFileSaveError,
  useIsFileLoading,
  useNavigateBack,
  useNavigateForward,
  useOpenNewTab,
  usePaneCanNavigate,
  usePaneTabs,
  useResolvedDocumentTitle,
  useSetActiveTab,
  type Tab,
} from "@/hooks/use-tabs";
import { usePaneActiveTabId } from "@/hooks/use-editor-layout";
import { ScrollFade } from "@/components/scroll-fade";
import { useScrollActiveTabIntoView } from "@/hooks/use-scroll-active-tab-into-view";
import { editorDrag } from "@/hooks/use-editor-drag";
import { getRelativePath } from "@/lib/paths";
import { pageKind } from "./page-kinds";
import { buildTabMenuItemsSpec, showNativeContextMenu } from "./editor-context-menu";
import { registerPaneStrip } from "./pane-bounds";
import { FileIcon } from "@/components/sidebar/file-tree-icons";

/** What the tab ghost needs, captured at press time: the tab, its box, and
 *  where inside it the pointer was, so the ghost lifts off in place. */
interface TabDragGhost {
  tab: Tab;
  width: number;
  grabOffsetX: number;
  grabOffsetY: number;
}

/**
 * The element that follows the cursor while a tab is dragged — the same
 * treatment the sidebar gives a dragged file: an icon and the tab's title in
 * a pill the size of the tab it left, portaled to the body so no strip's
 * overflow clips it. Positioned imperatively from the drag's frame callback,
 * not through state, so it never re-renders while it moves.
 */
function TabDragGhostView({ ghost }: { ghost: TabDragGhost }) {
  const kind = pageKind(ghost.tab.location);
  const filePath = kind.primaryPath(ghost.tab.location);
  const documentTitle = useResolvedDocumentTitle(filePath);
  const title = documentTitle || kind.title(ghost.tab.location);
  return (
    <div
      className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-[8px] bg-[var(--surface-selected)] px-3.5 text-[13px] leading-[1.15] text-[var(--fg-base)] shadow-lg h-[var(--chrome-control-height)]"
      style={{ width: ghost.width }}
    >
      <span className="flex w-5 shrink-0 items-center justify-center opacity-60">
        <FileIcon />
      </span>
      <span className="min-w-0 truncate">{title}</span>
    </div>
  );
}
import { useWorkspaceRoot } from "@/hooks/use-workspace";
import { revealPathInSidebar } from "@/lib/reveal-in-sidebar";

interface EditorTabButtonProps {
  tab: Tab;
  isActive: boolean;
  isDragging: boolean;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>, tab: Tab) => void;
  onContextMenu?: (event: MouseEvent<HTMLElement>, tab: Tab) => void;
}

function EditorTabButton({
  tab,
  isActive,
  isDragging,
  onSelect,
  onClose,
  onPointerDown,
  onContextMenu,
}: EditorTabButtonProps) {
  const kind = pageKind(tab.location);
  const filePath = kind.primaryPath(tab.location);
  const isLoading = useIsFileLoading(filePath ?? "");
  const saveError = useFileSaveError(filePath);
  const documentTitle = useResolvedDocumentTitle(filePath);
  const title = documentTitle || kind.title(tab.location);

  return (
    // tab row wraps a native <button> close control; HTML forbids nested buttons so it cannot become a <button>.
    <div
      // eslint-disable-next-line react-doctor/prefer-tag-over-role
      role="button"
      tabIndex={0}
      data-dragging={isDragging || undefined}
      onPointerDown={(event) => onPointerDown(event, tab)}
      onClick={() => onSelect(tab.id)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onSelect(tab.id);
      }}
      onContextMenu={(event) => {
        if (!kind.supportsFileContextMenu || !onContextMenu) return;
        event.preventDefault();
        onContextMenu(event, tab);
      }}
      className={` group relative flex shrink-0 items-center overflow-hidden whitespace-nowrap rounded-[8px] px-3.5 text-[13px] leading-[1.15] select-none cursor-default max-w-[180px] h-[var(--chrome-control-height)] data-[dragging]:opacity-40 ${
        isActive
          ? "bg-[var(--tab-active-bg)] text-[var(--text-secondary)] backdrop-blur-2xl"
          : "bg-transparent text-[var(--text-muted)] hover:bg-[var(--tab-active-bg)] hover:text-[var(--text-secondary)] hover:backdrop-blur-2xl"
      }`}
    >
      {saveError ? (
        <span
          aria-label={`Save failed: ${saveError}`}
          title={`Save failed: ${saveError}`}
          className="mr-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[#ff5f57]"
        />
      ) : null}
      <span
        className={`truncate group-hover:[mask-image:linear-gradient(to_right,black,black_calc(100%_-_28px),transparent)] group-hover:[-webkit-mask-image:linear-gradient(to_right,black,black_calc(100%_-_32px),transparent_calc(100%_-_8px))] ${isLoading ? "animate-pulse opacity-60" : ""}`}
      >
        {title}
      </span>
      <div
        className="pointer-events-none absolute inset-y-0 right-0 flex translate-x-full items-center justify-end pr-1 opacity-0 group-hover:translate-x-0 group-hover:opacity-100"
        style={{ width: 40 }}
      >
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onClose(tab.id);
          }}
          className="pointer-events-auto flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[13px] leading-none text-[var(--text-icon-muted)] hover:text-[var(--text-secondary)]"
          aria-label={`Close ${title}`}
        >
          ×
        </button>
      </div>
    </div>
  );
}

/**
 * One pane's tab strip. It owns what only a strip can: which of its tabs is
 * active, scrolling that tab into view, and arming a tab drag on the window's
 * one pointer coordinator (`editorDrag`), which resolves where the tab lands
 * and commits the move — this strip only marks the dragged tab.
 *
 * The strip is a window-drag surface (`data-tauri-drag-region`) only on its
 * empty space. Tabs carry no drag-region attribute, and Tauri only starts a
 * window drag when the pressed element itself has one, so a press on a tab
 * never moves the window — before the drag threshold as well as after.
 */
export function EditorTabs({
  paneId,
  clearTrafficLights,
}: {
  paneId: string;
  clearTrafficLights: boolean;
}) {
  const tabs = usePaneTabs(paneId);
  const activeTabId = usePaneActiveTabId(paneId);
  const setActiveTab = useSetActiveTab();
  const closeTab = useCloseTab();
  const { back: canNavigateBack, forward: canNavigateForward } = usePaneCanNavigate(paneId);
  const navigateBack = useNavigateBack();
  const navigateForward = useNavigateForward();
  const openNewTab = useOpenNewTab();
  const workspaceRoot = useWorkspaceRoot();
  const [, startTransition] = useTransition();
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [dragGhost, setDragGhost] = useState<TabDragGhost | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const unregisterStrip = useRef<() => void>(() => {});
  useScrollActiveTabIntoView(paneId, stripRef);

  // `ScrollFade` forwards the ref without returning its cleanup, so this
  // handles the `null` call on unmount itself rather than returning one.
  const stripRefCallback = useCallback(
    (element: HTMLDivElement | null) => {
      unregisterStrip.current();
      stripRef.current = element;
      unregisterStrip.current = registerPaneStrip(paneId, element);
    },
    [paneId],
  );

  const handleTabPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>, tab: Tab) => {
    // The close control is a button of its own; a press there must not
    // start a drag. Only the primary button drags.
    if (event.button !== 0 || (event.target as Element).closest("button")) return;
    const box = event.currentTarget.getBoundingClientRect();
    const ghost: TabDragGhost = {
      tab,
      width: box.width,
      grabOffsetX: event.clientX - box.left,
      grabOffsetY: event.clientY - box.top,
    };
    editorDrag().arm(
      {
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
        target: event.currentTarget,
      },
      { kind: "tab", tabId: tab.id },
      {
        onActivate: () => {
          setDraggingTabId(tab.id);
          setDragGhost(ghost);
        },
        onFrame: (point) => {
          const element = ghostRef.current;
          if (!element) return;
          element.style.transform = `translate(${point.x - ghost.grabOffsetX}px, ${point.y - ghost.grabOffsetY}px)`;
          element.style.opacity = "1";
        },
        onEnd: () => {
          setDraggingTabId(null);
          setDragGhost(null);
        },
      },
    );
  }, []);

  const handleTabContextMenu = useCallback(
    (_event: MouseEvent<HTMLElement>, tab: Tab) => {
      const kind = pageKind(tab.location);
      if (!kind.supportsFileContextMenu) return;
      const filePath = kind.primaryPath(tab.location);
      if (!filePath) return;
      const relative = workspaceRoot ? getRelativePath(filePath, workspaceRoot) : filePath;
      // Close-others and close-all act on this strip, not on every pane. The
      // tab list is captured with the menu, as the spec asks.
      const stripTabIds = tabs.map((t) => t.id);

      void showNativeContextMenu(
        buildTabMenuItemsSpec({
          onClose: () => closeTab(tab.id),
          onCloseOthers: () => {
            for (const id of stripTabIds) {
              if (id !== tab.id) closeTab(id);
            }
          },
          onCloseAll: () => {
            for (const id of stripTabIds) {
              closeTab(id);
            }
          },
          onRevealInSidebar: () => {
            setActiveTab(tab.id);
            void revealPathInSidebar(filePath, { showSidebar: true });
          },
          onCopyPath: () => {
            void writeText(relative);
          },
        }),
      );
    },
    [closeTab, setActiveTab, tabs, workspaceRoot],
  );

  return (
    <div
      data-tauri-drag-region
      className="group/tabs flex min-w-0 items-center gap-3"
      style={{
        height: "calc(var(--chrome-control-height) + var(--chrome-control-padding) * 2)",
        paddingBlock: "var(--chrome-control-padding)",
        // The top-left strip sits behind the macOS traffic lights and the
        // sidebar toggle when the sidebar is collapsed; leave them room.
        paddingLeft: clearTrafficLights ? 132 : 12,
        paddingRight: 12,
      }}
    >
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void navigateBack()}
          disabled={!canNavigateBack}
          className="flex h-[var(--chrome-control-height)] w-7 items-center justify-center rounded-lg text-base text-[var(--text-icon-muted)] transition-colors enabled:hover:bg-[var(--surface-subtle)] enabled:hover:text-[var(--text-secondary)] disabled:opacity-30"
          title="Back"
          aria-label="Back"
        >
          ←
        </button>
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void navigateForward()}
          disabled={!canNavigateForward}
          className="flex h-[var(--chrome-control-height)] w-7 items-center justify-center rounded-lg text-base text-[var(--text-icon-muted)] transition-colors enabled:hover:bg-[var(--surface-subtle)] enabled:hover:text-[var(--text-secondary)] disabled:opacity-30"
          title="Forward"
          aria-label="Forward"
        >
          →
        </button>
      </div>

      <div data-tauri-drag-region className="relative flex min-w-0 flex-1 items-center">
        <ScrollFade
          axis="horizontal"
          data-tab-strip
          data-tauri-drag-region
          ref={stripRefCallback}
          className="flex min-w-0 items-center overflow-x-auto scrollbar-none"
        >
          <div data-tauri-drag-region className="flex min-w-max items-center gap-1">
            {tabs.map((tab) => {
              const isActive = tab.id === activeTabId;

              return (
                <div key={tab.id} data-tab-id={tab.id} className="flex items-center">
                  <EditorTabButton
                    tab={tab}
                    isActive={isActive}
                    isDragging={tab.id === draggingTabId}
                    onSelect={(tabId) => startTransition(() => setActiveTab(tabId))}
                    onClose={closeTab}
                    onPointerDown={handleTabPointerDown}
                    onContextMenu={handleTabContextMenu}
                  />
                </div>
              );
            })}
          </div>
        </ScrollFade>
        <button
          type="button"
          onClick={openNewTab}
          className="ml-1 flex h-[var(--chrome-control-height)] w-9 shrink-0 items-center justify-center rounded-lg text-base text-[var(--text-icon-muted)] transition-colors hover:bg-[var(--surface-subtle)] hover:text-[var(--text-secondary)]"
          title="New tab"
          aria-label="New tab"
        >
          +
        </button>
      </div>
      {dragGhost &&
        createPortal(
          <div
            ref={ghostRef}
            aria-hidden="true"
            className="pointer-events-none fixed left-0 top-0 z-50"
            // Invisible until the first frame places it, so it never flashes
            // at the corner of the window.
            style={{ opacity: 0 }}
          >
            <TabDragGhostView ghost={dragGhost} />
          </div>,
          document.body,
        )}
    </div>
  );
}
