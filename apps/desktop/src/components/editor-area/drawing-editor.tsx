import { useCallback, useEffect, useRef, useState } from "react";
import { CaptureUpdateAction, Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { loadDrawing, type DrawingScene } from "@/lib/drawings";
import { attachDrawingView, changeDrawing, saveDrawingSessions } from "@/lib/drawing-sessions";
import { useSetting } from "@/hooks/use-settings";
import { activeMode, type ThemePreference } from "@/lib/theme";

// Excalidraw resolves font URLs against this and silently falls back to
// esm.sh when it is unset or wrong — offline that fetch fails, `exportToSvg`
// does *not* throw, and the saved file gets a remote `@font-face` it can never
// load. Set at module scope so it is in place before the first render, and
// resolved to an absolute href: a value starting with `/` or `./` is resolved
// against `window.location.origin`, which is not the right base under Tauri's
// custom scheme. The assets are copied into `public/excalidraw-assets/` by the
// build (see `vite.config.ts`).
declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}
window.EXCALIDRAW_ASSET_PATH = new URL("excalidraw-assets/", window.location.href).href;

// Writer owns persistence; keep native scene load/save actions disabled.
const UI_OPTIONS = { canvasActions: { loadScene: false, saveToActiveFile: false } };

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; scene: DrawingScene };

export default function DrawingEditor({
  tabId,
  path,
  isActive = true,
}: {
  tabId: string;
  path: string;
  isActive?: boolean;
}) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const themePreference = useSetting("appearance.theme") as ThemePreference | undefined;
  const theme = activeMode(themePreference);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);

  useEffect(() => {
    let cancelled = false;
    let detach: (() => void) | undefined;
    // A tab reopened while its previous export finishes must read that write.
    void saveDrawingSessions(path)
      .then(() => loadDrawing(path))
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          setState({ status: "error", message: result.error });
          return;
        }
        // The session owns the scene. If another pane already has this drawing
        // open, `attachDrawingView` hands back the live scene rather than the
        // one just read from disk, so the second pane joins mid-edit.
        const attached = attachDrawingView(path, tabId, result.scene, {
          applyScene: ({ elements, files }) => {
            const api = apiRef.current;
            if (!api) return;
            if (Object.keys(files).length > 0) api.addFiles(Object.values(files));
            // NEVER: a sibling's edit is a remote update, so it must not enter
            // this view's own undo history.
            api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER });
          },
        });
        detach = attached.detach;
        setState({ status: "ready", scene: attached.scene });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: "error", message: String(error) });
      });
    return () => {
      cancelled = true;
      // Detaching never writes: a tab moving between panes remounts its editor,
      // and a move must not save. Cmd+S, tab close, and quit do the writing.
      detach?.();
    };
  }, [path, tabId]);

  const handleChange = useCallback(
    (elements: readonly OrderedExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
      changeDrawing(path, tabId, elements, appState, files);
    },
    [path, tabId],
  );

  if (state.status === "loading") {
    return <div className="text-muted-foreground p-4 text-sm">Loading drawing…</div>;
  }

  if (state.status === "error") {
    // No canvas is mounted, so nothing can autosave over the file on disk.
    return (
      <div className="text-destructive p-4 text-sm">
        <p className="font-medium">This drawing could not be opened.</p>
        <p className="text-muted-foreground mt-1 font-mono text-xs break-all">{state.message}</p>
        <p className="text-muted-foreground mt-2">
          The file has not been modified. Saving is disabled for this tab.
        </p>
      </div>
    );
  }

  return (
    <Excalidraw
      excalidrawAPI={(api) => {
        apiRef.current = api;
      }}
      initialData={state.scene}
      theme={theme}
      onChange={handleChange}
      UIOptions={UI_OPTIONS}
      handleKeyboardGlobally={false}
      viewModeEnabled={!isActive}
    />
  );
}
