import { lazy, Suspense } from "react";
import type { DrawingLocation } from "./page-kinds/drawing";

// The whole Excalidraw surface — the package, its 144 KB of CSS, and the
// asset-path wiring — lives in `./drawing-editor` so `React.lazy` can keep all
// of it out of the main graph. `views.tsx` is imported statically by the tab
// renderer, so a top-level import here would land Excalidraw in the entry
// chunk and defeat the point of the SVG-embed format (see spec.md).
const DrawingEditor = lazy(() => import("./drawing-editor"));

// `EditorArea` starts at the top of the window and the window chrome floats
// over it: the tab bar (`z-40`, 56px) and a full-width `data-tauri-drag-region`
// (`z-30`, `--chrome-drag-height`) with pointer events left on. `EditorPane`
// clears both by padding its scrolling content down; Excalidraw can't, because
// `.excalidraw` is `height: 100%` and pins its own toolbar to the top of its
// container. Offsetting the whole pane is the only thing that works — without
// it the toolbar draws under the chrome and every click on it is eaten as a
// window drag, while keyboard shortcuts (document-level) still fire.
//
// The drag region is the taller of the two, so it's the one to clear.
const CHROME_OFFSET = "var(--chrome-drag-height)";

export function DrawingPane({
  location,
  isActive,
}: {
  location: DrawingLocation;
  isActive: boolean;
}) {
  return (
    // The drawing kind is `keepAlive`, so an inactive tab stays mounted — but
    // `visibility: hidden` is not enough to hide it: Excalidraw's own CSS puts
    // `visibility: visible` on the footer islands (`.zen-mode-visibility`), so
    // the zoom controls kept showing over other tabs. `display: none` can't be
    // overridden by a descendant, and also stops the canvas painting while the
    // tab is in the background.
    <div
      className={
        isActive ? "absolute inset-0 z-10" : "pointer-events-none hidden absolute inset-0 z-10"
      }
      style={{ top: CHROME_OFFSET }}
    >
      <Suspense
        fallback={<div className="text-muted-foreground p-4 text-sm">Loading drawing…</div>}
      >
        {/* Keyed by path so navigating a tab to another drawing remounts with
            fresh state rather than reusing the previous scene. */}
        <DrawingEditor key={location.path} path={location.path} isActive={isActive} />
      </Suspense>
    </div>
  );
}
