import { mcpRespond } from "@/lib/tauri";
import { locationBehavior } from "@/components/editor-area/page-kinds";
import { useEditorStore } from "@/stores/editor-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

/**
 * The webview half of the MCP tool bridge (contracts/app-bridge.md). Rust
 * emits `mcp:request` to exactly one window; the dispatcher here runs the
 * matching handler against the live stores and answers via `mcp_respond`.
 *
 * The contract's one hard rule: the dispatcher never throws across the
 * bridge — every outcome is a `result` or a `{kind, detail}` error, so a
 * pending call in Rust always completes.
 */
export interface McpRequest {
  request_id: number;
  tool: string;
  args: unknown;
}

export type McpDispatch =
  | { ok: true; result: unknown }
  | { ok: false; error: { kind: string; detail: string } };

// Handlers may be sync or async — `Promise` is already covered by `unknown`.
type McpToolHandler = (args: unknown) => unknown;

function describeWindow() {
  const { root, chromeMode } = useWorkspaceStore.getState();
  const { activeFilePath } = useEditorStore.getState();
  // A compact window hosts exactly one file; that file is its scope.
  const standaloneFile = root === null && chromeMode === "compact-file" ? activeFilePath : null;
  return { root, chromeMode, standaloneFile, activeFilePath };
}

function listTabs() {
  const { tabs, activeTabId } = useEditorStore.getState();
  return {
    tabs: tabs.map((tab) => ({
      // `paths()[0]`, not `primaryPath`: standalone surfaces (drawings, PDFs)
      // report `primaryPath: null` by design, but an agent still needs the
      // file the tab is showing.
      path: locationBehavior(tab.location).paths(tab.location)[0] ?? null,
      location_kind: tab.location.kind,
      active: tab.id === activeTabId,
    })),
  };
}

const MCP_TOOL_HANDLERS: Record<string, McpToolHandler> = {
  describe_window: describeWindow,
  list_tabs: listTabs,
};

/** Run one forwarded tool call. Never throws — the bridge contract says the
 *  reply is always either a result or a `{kind, detail}` error. */
export async function dispatchMcpRequest(request: McpRequest): Promise<McpDispatch> {
  const handler = MCP_TOOL_HANDLERS[request.tool];
  if (!handler) {
    console.error(`[mcp] unknown webview tool: ${request.tool}`);
    return {
      ok: false,
      error: { kind: "internal", detail: `unknown webview tool: ${request.tool}` },
    };
  }
  try {
    return { ok: true, result: await handler(request.args) };
  } catch (error) {
    return {
      ok: false,
      error: { kind: "internal", detail: error instanceof Error ? error.message : String(error) },
    };
  }
}

/** Complete a pending call in Rust's pending map. */
export async function respondToMcpRequest(request: McpRequest): Promise<void> {
  const dispatch = await dispatchMcpRequest(request);
  if (dispatch.ok) {
    await mcpRespond(request.request_id, dispatch.result, null);
  } else {
    await mcpRespond(request.request_id, null, dispatch.error);
  }
}
