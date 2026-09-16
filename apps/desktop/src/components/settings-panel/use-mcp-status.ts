import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { cliStatus, mcpStatus, type McpStatus } from "@/lib/tauri";

export interface McpSurfaceState {
  /** null until the first `mcp_status` reply lands. */
  status: McpStatus | null;
  /** Whether the `writer` bridge command is on PATH. `cli_status` is
   *  macOS-only; a rejection (or a pending first read) leaves this null,
   *  which the surface treats as "unknown" and shows the snippet. */
  cliInstalled: boolean | null;
}

/**
 * Live status for the MCP settings surface. `mcp_status` is re-fetched on
 * every `settings:changed` broadcast — the backend emits that event only
 * after the global reload has applied the new `mcp.enabled` flag
 * (watcher.rs `reload_global_settings`), so toggles and hand-edited config
 * both land here post-apply, in every window.
 */
export function useMcpStatus(): McpSurfaceState {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [cliInstalled, setCliInstalled] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    const refresh = () => {
      mcpStatus()
        .then((report) => {
          if (live) setStatus(report);
        })
        .catch((error: unknown) => console.error("[mcp] mcp_status failed", error));
    };
    refresh();
    cliStatus()
      .then((report) => {
        if (live) setCliInstalled(report.installed);
      })
      .catch(() => {
        if (live) setCliInstalled(null);
      });
    const unlisten = listen("settings:changed", refresh);
    return () => {
      live = false;
      void unlisten.then((fn) => fn());
    };
  }, []);

  return { status, cliInstalled };
}
