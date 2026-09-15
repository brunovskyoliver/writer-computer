import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { respondToMcpRequest, type McpRequest } from "@/lib/mcp";

/**
 * Subscribe this window to `mcp:request` for its lifetime. Requests always
 * target exactly one window (Rust resolves the workspace to a label before
 * emitting), so there is no filtering to do here — every request that
 * arrives is ours.
 */
export function useMcpRequests() {
  useEffect(() => {
    const unlisten = listen<McpRequest>("mcp:request", (event) => {
      // Fire-and-forget: the reply path is `mcp_respond`, not the listener's
      // return value, and a slow handler must not queue others behind it.
      void respondToMcpRequest(event.payload);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);
}
