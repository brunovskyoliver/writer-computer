import { useCallback, useEffect, useRef, useState } from "react";
import { Excalidraw, getSceneVersion } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { loadDrawing, saveDrawing, type DrawingScene } from "@/lib/drawings";
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

// Excalidraw's `onChange` fires continuously while drawing, and a save is not
// cheap: `exportToSvg` with `exportEmbedScene` re-renders the whole scene,
// serializes it into the SVG, and any markdown tab embedding the drawing then
// re-decodes the new file. At 150 ms every pause to reposition the pointer
// triggered that. A pending save is flushed on unmount, so a longer window
// costs nothing but delay.
const SAVE_DEBOUNCE_MS = 1000;

// Keeps Excalidraw's own look; restyling it to match Writer is out of scope
// and would break on every upgrade. The two disabled actions are load/save
// *scene* — a foreign scene loaded into this tab would autosave straight over
// the file the tab is bound to. Module scope so the object identity is stable
// across renders.
const UI_OPTIONS = { canvasActions: { loadScene: false, saveToActiveFile: false } };

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; scene: DrawingScene };

type PendingChange = {
  elements: readonly OrderedExcalidrawElement[];
  appState: AppState;
  files: BinaryFiles;
  version: number;
  bgColor?: string;
  filesCount: number;
};

export default function DrawingEditor({ path }: { path: string }) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const themePreference = useSetting("appearance.theme") as ThemePreference | undefined;
  // ponytail: reads the preference, not the resolved DOM attribute. An OS
  // theme flip while the preference is "system" won't repaint an already-open
  // drawing tab until it remounts — the same gap the rest of the React tree
  // has (only CSS vars follow the system live).
  const theme = activeMode(themePreference);

  const pathRef = useRef(path);
  pathRef.current = path;

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingChange = useRef<PendingChange | null>(null);
  const lastSavedVersion = useRef<number>(-1);
  const lastSavedBg = useRef<string | undefined>(undefined);
  const lastSavedFilesCount = useRef<number>(0);

  // Excalidraw emits an `onChange` at mount that can carry an empty element
  // array before `initialData` is applied. Saving that would overwrite the
  // user's real drawing with nothing — the highest-consequence failure in this
  // feature. Stay disarmed until the first non-empty change; once armed, an
  // empty scene is a real "user deleted everything" and does save.
  const armed = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void loadDrawing(path).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setState({ status: "error", message: result.error });
        return;
      }
      armed.current = result.scene.elements.length === 0;
      lastSavedVersion.current = getSceneVersion(result.scene.elements);
      lastSavedBg.current = result.scene.appState.viewBackgroundColor;
      lastSavedFilesCount.current = Object.keys(result.scene.files ?? {}).length;
      setState({ status: "ready", scene: result.scene });
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const flushSave = useCallback(() => {
    if (!saveTimer.current) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const change = pendingChange.current;
    if (!change) return;
    lastSavedVersion.current = change.version;
    lastSavedBg.current = change.bgColor;
    lastSavedFilesCount.current = change.filesCount;
    void saveDrawing(pathRef.current, {
      elements: change.elements.filter((element) => !element.isDeleted),
      appState: change.appState,
      files: change.files,
    });
  }, []);

  // Flush a pending save on unmount (tab close), or the last edits within the
  // debounce window are dropped. `saveDrawing` serializes writes per path, so
  // this can't race an in-flight export.
  useEffect(() => () => flushSave(), [flushSave]);

  const handleChange = useCallback(
    (elements: readonly OrderedExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
      if (!armed.current) {
        if (elements.length === 0) return;
        armed.current = true;
      }

      const version = getSceneVersion(elements);
      const bgColor = appState.viewBackgroundColor;
      const filesCount = Object.keys(files ?? {}).length;

      // Skip saves and allocations if scene elements/content haven't mutated
      // (e.g. pan, zoom, selection, hover, cursor moves).
      if (
        version === lastSavedVersion.current &&
        bgColor === lastSavedBg.current &&
        filesCount === lastSavedFilesCount.current
      ) {
        return;
      }

      pendingChange.current = {
        elements,
        appState,
        files,
        version,
        bgColor,
        filesCount,
      };

      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        flushSave();
      }, SAVE_DEBOUNCE_MS);
    },
    [flushSave],
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
          The file has not been modified. Autosave is off for this tab.
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
    />
  );
}
