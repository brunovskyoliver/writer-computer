import { useCallback } from "react";
import { SEPARATOR_SIZE, type LayoutNode } from "@/lib/editor-layout";
import { useIsPaneFocused, useLayoutRoot, useSetFocusedPane } from "@/hooks/use-editor-layout";
import { useSidebar } from "@/hooks/use-sidebar";
import { EditorTabs } from "./editor-tabs";
import { registerPaneBody, usePaneRect } from "./pane-bounds";

/**
 * The pane tree's chrome and geometry. It renders *slots*, not tab bodies:
 * each leaf contributes an empty measured rectangle, and `EditorArea`
 * positions the one stable set of tab bodies over those rectangles.
 *
 * Each slot also carries its pane's tab strip, floating over the top of the
 * body exactly as the old single global strip floated over the editor — so
 * bodies keep the headroom they already pad for, and the drawing surface
 * keeps its chrome offset. The body slot is the whole pane; the strip takes
 * precedence over the body's top edge band during a drag.
 *
 * The measured slots are also the drop surfaces. A drag holds pointer
 * capture on its source, so nothing here listens for pointer events; the
 * coordinator in `hooks/use-editor-drag.ts` hit-tests the pointer against
 * the rectangles `pane-bounds` measured and resolves strip/centre/edge
 * targets from the same geometry the preview will paint.
 *
 * Splits are plain flex boxes with the same ratio math as `computeBounds`.
 * The resize library takes them over later (see tasks T035).
 */

function PaneSlot({ paneId }: { paneId: string }) {
  const isFocused = useIsPaneFocused(paneId);
  const setFocusedPane = useSetFocusedPane();
  const { isSidebarCollapsed } = useSidebar();
  const rect = usePaneRect(paneId);
  const bodyRef = useCallback(
    (element: HTMLDivElement | null) => registerPaneBody(paneId, element),
    [paneId],
  );
  // The pane in the window's top-left corner shares its strip with the macOS
  // traffic lights and the sidebar toggle once the sidebar is collapsed.
  const clearTrafficLights =
    isSidebarCollapsed && rect !== null && rect.left === 0 && rect.top === 0;

  return (
    <div
      data-pane-id={paneId}
      data-pane-focused={isFocused || undefined}
      className="relative min-h-0 min-w-0 flex-1"
      // Pointer capture anywhere in the pane chrome focuses it before any
      // child command runs, so a command always acts on the pane the user is
      // in. Bodies do the same in `EditorArea`.
      onPointerDownCapture={() => setFocusedPane(paneId)}
      onFocusCapture={() => setFocusedPane(paneId)}
    >
      <div ref={bodyRef} className="absolute inset-0" />
      <div className="absolute inset-x-0 top-0 z-40">
        <EditorTabs paneId={paneId} clearTrafficLights={clearTrafficLights} />
      </div>
    </div>
  );
}

function PaneNode({ node }: { node: LayoutNode }) {
  if (node.kind === "pane") return <PaneSlot paneId={node.id} />;
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1"
      style={{ flexDirection: node.axis === "x" ? "row" : "column" }}
    >
      <div className="flex min-h-0 min-w-0" style={{ flex: `${node.ratio} 1 0` }}>
        <PaneNode node={node.children[0]} />
      </div>
      <div
        aria-hidden
        className="shrink-0 bg-[var(--border-color)]"
        style={
          node.axis === "x"
            ? { width: SEPARATOR_SIZE, cursor: "col-resize" }
            : { height: SEPARATOR_SIZE, cursor: "row-resize" }
        }
      />
      <div className="flex min-h-0 min-w-0" style={{ flex: `${1 - node.ratio} 1 0` }}>
        <PaneNode node={node.children[1]} />
      </div>
    </div>
  );
}

export function PaneLayout() {
  const root = useLayoutRoot();
  return (
    <div
      className="absolute inset-0 flex min-h-0 min-w-0"
      // The focus ring only means something once there is more than one
      // pane; a single pane looks exactly as it did before tiling.
      data-multi-pane={root.kind === "split" || undefined}
    >
      <PaneNode node={root} />
    </div>
  );
}
