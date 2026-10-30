import { Component, lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { isObsidianDrawingPath } from "@/lib/drawings";
import type { DrawingLocation } from "./page-kinds/drawing";
import { getDrawingSession, reportDrawingSaveError } from "@/lib/drawing-sessions";

// The whole Excalidraw surface — the package, its 144 KB of CSS, and the
// asset-path wiring — lives in `./drawing-editor` so `React.lazy` can keep all
// of it out of the main graph. `views.tsx` is imported statically by the tab
// renderer, so a top-level import here would land Excalidraw in the entry
// chunk and defeat the point of the SVG-embed format (see spec.md).
class DrawingBoundary extends Component<
  { children: ReactNode; retry: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div role="alert" className="overflow-auto p-3 text-sm">
        <p>The drawing view could not be loaded.</p>
        <button className="mt-2 rounded border px-2 py-1" onClick={this.props.retry}>
          Retry
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}

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
  tabId,
  isVisible,
  isFocused,
}: {
  location: DrawingLocation;
  tabId: string;
  isVisible: boolean;
  isFocused: boolean;
}) {
  const [retry, setRetry] = useState(0);
  // Obsidian drawings start as a preview; opening the editor is the explicit step.
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const DrawingEditor = useMemo(() => lazy(() => import("./drawing-editor")), [retry]);
  const ObsidianDrawingPane = useMemo(() => lazy(() => import("./obsidian-drawing-pane")), [retry]);
  useEffect(() => {
    if (!isFocused || !isVisible) {
      const session = getDrawingSession(location.path);
      if (session?.isDirty()) {
        void session.save().catch(reportDrawingSaveError);
      }
    }
  }, [isFocused, isVisible, location.path]);

  useEffect(() => {
    const handleBlur = () => {
      const session = getDrawingSession(location.path);
      if (session?.isDirty()) {
        void session.save().catch(reportDrawingSaveError);
      }
    };
    window.addEventListener("blur", handleBlur);
    return () => window.removeEventListener("blur", handleBlur);
  }, [location.path]);

  return (
    // The drawing kind is `keepAlive`, so an inactive tab stays mounted — but
    // `visibility: hidden` is not enough to hide it: Excalidraw's own CSS puts
    // `visibility: visible` on the footer islands (`.zen-mode-visibility`), so
    // the zoom controls kept showing over other tabs. `display: none` can't be
    // overridden by a descendant, and also stops the canvas painting while the
    // tab is in the background.
    <div
      className={
        isVisible ? "absolute inset-0 z-10" : "pointer-events-none hidden absolute inset-0 z-10"
      }
      style={{ top: CHROME_OFFSET }}
    >
      <DrawingBoundary key={`${location.path}:${retry}`} retry={() => setRetry((n) => n + 1)}>
        <Suspense
          fallback={<div className="text-muted-foreground p-4 text-sm">Loading drawing…</div>}
        >
          {/* Keyed by path so navigating a tab to another drawing remounts with
            fresh state rather than reusing the previous scene. */}
          {isObsidianDrawingPath(location.path) && editingPath !== location.path ? (
            <ObsidianDrawingPane
              path={location.path}
              tabId={tabId}
              onEdit={() => setEditingPath(location.path)}
            />
          ) : (
            <DrawingEditor
              key={location.path}
              tabId={tabId}
              path={location.path}
              isActive={isFocused}
            />
          )}
        </Suspense>
      </DrawingBoundary>
    </div>
  );
}
