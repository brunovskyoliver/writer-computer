import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { aiStatus, type AiStatus } from "@/lib/ai";

export interface AiStatusSurface {
  /** null until the first `ai_status` reply lands. */
  status: AiStatus | null;
  refresh: () => void;
}

/**
 * Live status for the AI settings surface. Re-fetches `ai_status` on every
 * `settings:changed` broadcast — the backend emits that only after a global
 * reload has applied the new settings, so toggles and hand-edited config
 * both land here post-apply (same contract as `useMcpStatus`). `refresh`
 * re-probes on demand.
 */
export function useAiStatus(): AiStatusSurface {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    aiStatus()
      .then((report) => {
        if (live) setStatus(report);
      })
      .catch((error: unknown) => console.error("[ai] ai_status failed", error));
    return () => {
      live = false;
    };
  }, [tick]);

  useEffect(() => {
    const unlisten = listen("settings:changed", () => setTick((t) => t + 1));
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { status, refresh };
}
