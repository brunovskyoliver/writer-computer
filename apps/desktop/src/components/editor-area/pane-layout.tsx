import { useCallback } from "react";
import { SEPARATOR_SIZE, type LayoutNode } from "@/lib/editor-layout";
import { useIsPaneFocused, useLayoutRoot, useSetFocusedPane } from "@/hooks/use-editor-layout";
import { registerPaneBody } from "./pane-bounds";

/**
 * The pane tree's chrome and geometry. It renders *slots*, not tab bodies:
 * each leaf contributes an empty measured rectangle, and `EditorArea`
 * positions the one stable set of tab bodies over those rectangles.
 *
 * The measured slots are also the drop surfaces. A drag holds pointer
 * capture on its source, so nothing here listens for pointer events; the
 * coordinator in `hooks/use-editor-drag.ts` hit-tests the pointer against
 * the rectangles `pane-bounds` measured and resolves centre/edge regions
 * from the same geometry the preview will paint.
 *
 * Splits are plain flex boxes with the same ratio math as `computeBounds`.
 * The resize library takes them over later (see tasks T035).
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
