import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { respondToMcpRequest, type McpRequest } from "@/lib/mcp";

/**
 * Subscribe this window to `mcp:request` for its lifetime. Requests always
 * target exactly one window (Rust resolves the workspace to a label before
 * emitting). The listener must be window-scoped: the global `listen()`
 * registers `EventTarget::Any`, which Tauri delivers for every `emit_to`
 * regardless of the target label — every window would answer and the first
 * reply would win the pending call.
 */
export function useMcpRequests() {
  useEffect(() => {
    const unlisten = getCurrentWindow().listen<McpRequest>("mcp:request", (event) => {
      // Fire-and-forget: the reply path is `mcp_respond`, not the listener's
      // return value, and a slow handler must not queue others behind it.
      void respondToMcpRequest(event.payload);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);
}
