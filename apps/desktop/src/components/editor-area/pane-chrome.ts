import type { CSSProperties } from "react";
import type { PaneRect } from "./pane-bounds";

// The measured whole pane owns these decisions for both chrome and stable bodies.
// Reuse pane-bounds' observer instead of adding independent resize state.
export function paneChrome(rect: PaneRect | null) {
  return {
    "data-pane-short": (rect !== null && rect.height < 360) || undefined,
    "data-pane-narrow": (rect !== null && rect.width < 480) || undefined,
    style: (rect ? { "--pane-width": `${rect.width}px` } : {}) as CSSProperties,
  };
}
