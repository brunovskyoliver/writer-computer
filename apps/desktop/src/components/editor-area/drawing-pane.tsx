import { lazy, Suspense } from "react";
import type { DrawingLocation } from "./page-kinds/drawing";

// The whole Excalidraw surface — the package, its 144 KB of CSS, and the
// asset-path wiring — lives in `./drawing-editor` so `React.lazy` can keep all
// of it out of the main graph. `views.tsx` is imported statically by the tab
// renderer, so a top-level import here would land Excalidraw in the entry
// chunk and defeat the point of the SVG-embed format (see spec.md).
const DrawingEditor = lazy(() => import("./drawing-editor"));

export function DrawingPane({ location }: { location: DrawingLocation }) {
  return (
    <div className="h-full w-full">
      <Suspense
        fallback={<div className="text-muted-foreground p-4 text-sm">Loading drawing…</div>}
      >
        {/* Keyed by path so navigating a tab to another drawing remounts with
            fresh state rather than reusing the previous scene. */}
        <DrawingEditor key={location.path} path={location.path} />
      </Suspense>
    </div>
  );
}
