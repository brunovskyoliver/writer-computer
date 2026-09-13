import { useCallback } from "react";
import { SEPARATOR_SIZE, type LayoutNode } from "@/lib/editor-layout";
import { useIsPaneFocused, useLayoutRoot, useSetFocusedPane } from "@/hooks/use-editor-layout";
import { registerPaneBody } from "./pane-bounds";

/**
 * The pane tree's chrome and geometry. It renders *slots*, not tab bodies:
 * each leaf contributes an empty measured rectangle, and `EditorArea`
 * positions the one stable set of tab bodies over those rectangles.
 *
 * Splits are plain flex boxes here. The resize library takes this over later
 * (see tasks T035); nothing in this phase creates a split, so the tree is
 * always a single pane and there is nothing to drag yet.
 */

function PaneSlot({ paneId }: { paneId: string }) {
  const isFocused = useIsPaneFocused(paneId);
  const setFocusedPane = useSetFocusedPane();
  const bodyRef = useCallback(
    (element: HTMLDivElement | null) => registerPaneBody(paneId, element),
    [paneId],
  );

  return (
    <div
      data-pane-id={paneId}
      data-pane-focused={isFocused || undefined}
      className="relative min-h-0 min-w-0 flex-1"
      // Pointer capture anywhere in the pane focuses it before any child
      // command runs, so a command always acts on the pane the user is in.
      onPointerDownCapture={() => setFocusedPane(paneId)}
      onFocusCapture={() => setFocusedPane(paneId)}
    >
      <div ref={bodyRef} className="absolute inset-0" />
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
        className="shrink-0 bg-[var(--border)]"
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
    <div className="absolute inset-0 flex min-h-0 min-w-0">
      <PaneNode node={root} />
    </div>
  );
}
