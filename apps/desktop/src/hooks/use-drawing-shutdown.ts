import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  reportDrawingSaveError,
  saveDrawingSessions,
  freezeDrawingInput,
} from "@/lib/drawing-sessions";

export function useDrawingShutdown() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let disposed = false;
    let request: number | null = null;
    let release: (() => void) | undefined;
    const subscriptions = [
      listen<number>("drawing:prepare-close", async ({ payload: id }) => {
        request = id;
        release?.();
        const releaseThisRequest = freezeDrawingInput();
        release = releaseThisRequest;
        try {
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
            reportDrawingSaveError(error);
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
      .catch(reportDrawingSaveError);
    return () => {
      disposed = true;
      release?.();
      for (const subscription of subscriptions) void subscription.then((unlisten) => unlisten());
    };
  }, []);
  return ready;
}
