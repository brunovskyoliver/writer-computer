import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { saveDrawingSessions } from "@/lib/drawing-sessions";
import { freezeEditorInput, settleEditorInput } from "@/lib/editor-input";
import { saveAllNow } from "@/lib/save";

function reportSaveError(error: unknown) {
  console.error("Shutdown save failed", error);
  window.alert(
    `Your changes could not be saved. They are still in memory. Try saving again.\n\n${String(error)}`,
  );
}

export function useDrawingShutdown() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let disposed = false;
    let request: number | null = null;
    let release: (() => void) | undefined;
    const subscriptions = [
      getCurrentWindow().listen<number>("drawing:prepare-close", async ({ payload: id }) => {
        if (disposed) return;
        request = id;
        release?.();
        const releaseThisRequest = freezeEditorInput();
        release = releaseThisRequest;
        try {
          await settleEditorInput();
          if (request !== id || disposed) return;
          await saveAllNow();
          if (request !== id || disposed) return;
          await saveDrawingSessions();
          if (request !== id || disposed) return;
          await invoke("drawing_shutdown_complete", { id, success: true });
        } catch (error) {
          if (request !== id || disposed) return;
          releaseThisRequest();
          release = undefined;
          try {
            await invoke("drawing_shutdown_complete", { id, success: false });
          } finally {
            reportSaveError(error);
          }
        }
      }),
      listen<number>("drawing:close-cancelled", ({ payload: id }) => {
        if (id === request) {
          request = null;
          release?.();
          release = undefined;
        }
      }),
    ];
    void Promise.all(subscriptions)
      .then(async () => {
        if (disposed) return;
        await invoke("drawing_shutdown_ready");
        if (!disposed) setReady(true);
      })
      .catch(reportSaveError);
    return () => {
      disposed = true;
      release?.();
      for (const subscription of subscriptions) void subscription.then((unlisten) => unlisten());
    };
  }, []);
  return ready;
}
