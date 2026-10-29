import type { ReactNode } from "react";
import { useEditorStore } from "@/stores/editor-store";
import { paneOfTab } from "@/lib/editor-layout";
import { usePaneRect, useEditorAreaSize } from "./pane-bounds";
import { paneChrome } from "./pane-chrome";

/**
 * A positioning surface over one tab's pane body, for chrome that belongs to
 * a tab rather than to the window: the find overlay, a paste notice. Children
 * position themselves inside it exactly as they used to inside the whole
 * editor area, so with one pane nothing moves. Without a pane (no tab, or no
 * measurement yet) it covers the whole area, which is also the one-pane
 * geometry.
 */
export function PaneSurface({
  tabId,
  children,
  avoidSmallPane = false,
}: {
  tabId: string | null;
  children: ReactNode;
  avoidSmallPane?: boolean;
}) {
  const paneId = useEditorStore((s) => (tabId ? (paneOfTab(s.layout, tabId)?.id ?? null) : null));
  const rect = usePaneRect(paneId ?? "");
  const mode = paneChrome(rect);
  const areaSize = useEditorAreaSize();
  const area = avoidSmallPane ? areaSize : null;
  const detached = Boolean(rect && area && (mode["data-pane-short"] || mode["data-pane-narrow"]));
  const width = detached ? Math.min(area!.width, Math.max(rect!.width, 584)) : rect?.width;
  const left = detached ? Math.max(0, Math.min(rect!.left, area!.width - width!)) : rect?.left;
  const side =
    detached && mode["data-pane-short"]
      ? rect!.top > area!.height - rect!.top - rect!.height
        ? "above"
        : "below"
      : undefined;
  return (
    <div
      data-search-detached={detached || undefined}
      data-search-side={side}
      className={
        rect ? "pointer-events-none absolute z-40" : "pointer-events-none absolute inset-0 z-40"
      }
      style={rect ? { left, top: rect.top, width, height: rect.height } : undefined}
    >
      {children}
    </div>
  );
}
