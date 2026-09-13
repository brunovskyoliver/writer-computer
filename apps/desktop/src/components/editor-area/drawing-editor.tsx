import { useCallback, useEffect, useRef, useState } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { loadDrawing, type DrawingScene } from "@/lib/drawings";
import {
  createDrawingSession,
  registerDrawingSession,
  saveDrawingSessions,
} from "@/lib/drawing-sessions";
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
  path,
  isActive = true,
}: {
  path: string;
  isActive?: boolean;
}) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const themePreference = useSetting("appearance.theme") as ThemePreference | undefined;
  const theme = activeMode(themePreference);
  const session = useRef<ReturnType<typeof createDrawingSession> | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unregister: (() => void) | undefined;
    // A tab reopened while its previous export finishes must read that write.
    void saveDrawingSessions(path)
      .then(() => loadDrawing(path))
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          setState({ status: "error", message: result.error });
          return;
        }
        session.current = createDrawingSession(path, result.scene);
        unregister = registerDrawingSession(path, session.current.save, session.current.settled);
        setState({ status: "ready", scene: result.scene });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: "error", message: String(error) });
      });
    return () => {
      cancelled = true;
      unregister?.();
    };
  }, [path]);

  const handleChange = useCallback(
    (elements: readonly OrderedExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
      session.current?.change(elements, appState, files);
    },
    [],
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
      initialData={state.scene}
      theme={theme}
      onChange={handleChange}
      UIOptions={UI_OPTIONS}
      handleKeyboardGlobally={false}
      viewModeEnabled={!isActive}
    />
  );
}
