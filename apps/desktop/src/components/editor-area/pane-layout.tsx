import { useCallback } from "react";
import { Group, Panel, Separator, type Layout as GroupLayout } from "react-resizable-panels";
import { SEPARATOR_SIZE, minimumSize, type LayoutNode, type Split } from "@/lib/editor-layout";
import {
  useIsPaneFocused,
  useLayoutRoot,
  useSetFocusedPane,
  useSetSplitRatio,
} from "@/hooks/use-editor-layout";
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
 * Splits are `react-resizable-panels` groups. The library owns the live
 * divider drag, including keyboard resizing on the focused separator; only
 * the finished ratio is committed to the store. Its percentages are shares
 * of the space left after separators, which is the same quantity
 * `computeBounds` divides, so a drop preview drawn from the tree matches
 * what the library lays out.
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
      <div data-pane-strip className="absolute inset-x-0 top-0 z-40">
        <EditorTabs paneId={paneId} clearTrafficLights={clearTrafficLights} />
      </div>
    </div>
  );
}

/** Panel contents must fill the panel and never scroll: the bodies are
 *  positioned over the measured slots, so the slots themselves are inert. */
const PANEL_STYLE = { display: "flex", minWidth: 0, minHeight: 0, overflow: "hidden" } as const;

function SplitNode({ node }: { node: Split }) {
  const setSplitRatio = useSetSplitRatio();
  const [first, second] = node.children;
  const horizontal = node.axis === "x";
  // Each child's minimum is its whole subtree's, so a nested split can never
  // be squeezed below what its own panes need.
  const minOf = (child: LayoutNode) =>
    horizontal ? minimumSize(child).width : minimumSize(child).height;

  const onLayoutChanged = (layout: GroupLayout, meta: { isUserInteraction: boolean }) => {
    // Mount and constraint recomputes are not layout changes the user made;
    // committing them would write ratios the tree did not ask for.
    if (!meta.isUserInteraction) return;
    const a = layout[first.id];
    const b = layout[second.id];
    if (a === undefined || b === undefined || a + b <= 0) return;
    setSplitRatio(node.id, a / (a + b));
  };

  return (
    <Group
      id={node.id}
      orientation={horizontal ? "horizontal" : "vertical"}
      defaultLayout={{ [first.id]: node.ratio * 100, [second.id]: (1 - node.ratio) * 100 }}
      onLayoutChanged={onLayoutChanged}
      className="min-h-0 min-w-0 flex-1"
    >
      <Panel id={first.id} minSize={minOf(first)} style={PANEL_STYLE}>
        <PaneNode node={first} />
      </Panel>
      <Separator
        data-pane-separator
        aria-label={horizontal ? "Resize panes left and right" : "Resize panes up and down"}
        style={horizontal ? { width: SEPARATOR_SIZE } : { height: SEPARATOR_SIZE }}
      />
      <Panel id={second.id} minSize={minOf(second)} style={PANEL_STYLE}>
        <PaneNode node={second} />
      </Panel>
    </Group>
  );
}

function PaneNode({ node }: { node: LayoutNode }) {
  if (node.kind === "pane") return <PaneSlot paneId={node.id} />;
  // Keyed by the split and its children: a child that becomes a split keeps
  // its parent's id but changes the panel ids the group's default layout is
  // written against, so the group re-mounts with the right shares. A ratio
  // the group itself committed changes none of these and needs no re-mount.
  // Only slots re-mount; the tab bodies live elsewhere.
  const key = `${node.id}:${node.children[0].id}:${node.children[1].id}`;
  return <SplitNode key={key} node={node} />;
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
