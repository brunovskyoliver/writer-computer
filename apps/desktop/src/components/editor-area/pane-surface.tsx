import type { ReactNode } from "react";
import { useEditorStore } from "@/stores/editor-store";
import { paneOfTab } from "@/lib/editor-layout";
import { usePaneRect } from "./pane-bounds";

/**
 * A positioning surface over one tab's pane body, for chrome that belongs to
 * a tab rather than to the window: the find overlay, a paste notice. Children
 * position themselves inside it exactly as they used to inside the whole
 * editor area, so with one pane nothing moves. Without a pane (no tab, or no
 * measurement yet) it covers the whole area, which is also the one-pane
 * geometry.
 */
export function PaneSurface({ tabId, children }: { tabId: string | null; children: ReactNode }) {
  const paneId = useEditorStore((s) => (tabId ? (paneOfTab(s.layout, tabId)?.id ?? null) : null));
  const rect = usePaneRect(paneId ?? "");
  return (
    <div
      className={
        rect ? "pointer-events-none absolute z-40" : "pointer-events-none absolute inset-0 z-40"
      }
      style={
        rect
          ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
          : undefined
      }
    >
      {children}
    </div>
  );
}
