import * as tauri from "@/lib/tauri";
import { locationBehavior } from "@/components/editor-area/page-kinds";
import { getParentDir } from "@/lib/paths";
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

/** A handler's typed failure: surfaced to the caller as `{kind, detail}`
 *  instead of collapsing to `internal` like an unexpected throw does. */
class McpToolFailure extends Error {
  constructor(
    readonly kind: string,
    readonly detail: string,
  ) {
    super(detail);
    this.name = "McpToolFailure";
  }
}

// Handlers may be sync or async — `Promise` is already covered by `unknown`.
type McpToolHandler = (args: unknown) => unknown;

/** The resolved target Rust forwards for path-taking webview tools: the
 *  canonical, boundary-checked path plus its workspace-relative form for
 *  output and error detail. */
interface ResolvedTarget {
  path: string;
  relativePath: string;
}

function resolvedTarget(args: unknown): ResolvedTarget {
  const { path, relative_path } = (args ?? {}) as Record<string, unknown>;
  if (typeof path !== "string" || typeof relative_path !== "string") {
    throw new McpToolFailure("invalid_params", "path and relative_path are required");
  }
  return { path, relativePath: relative_path };
}

function resolvedContentTarget(args: unknown): ResolvedTarget & { content: string } {
  const target = resolvedTarget(args);
  const { content } = (args ?? {}) as Record<string, unknown>;
  if (typeof content !== "string") {
    throw new McpToolFailure("invalid_params", "content is required");
  }
  return { ...target, content };
}

/** AppError::AlreadyExists crosses IPC as its display string. */
function isAlreadyExistsError(error: unknown): boolean {
  return String(error).startsWith("Already exists:");
}

/** A created path only reaches the sidebar tree when its parent directory is
 *  re-read — the same explicit refresh the sidebar's own duplicate/delete
 *  actions run (the watcher treats the create's events as self-writes). A
 *  refresh failure must not fail the tool: the path already exists on disk. */
async function refreshSidebarParent(path: string) {
  const { root, refreshDirectory } = useWorkspaceStore.getState();
  if (!root) return;
  await refreshDirectory(getParentDir(path)).catch((error: unknown) => {
    console.warn("[mcp] sidebar refresh failed", error);
  });
}

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

async function createFile(args: unknown) {
  const { path, relativePath, content } = resolvedContentTarget(args);
  if (await tauri.fileExists(path)) {
    throw new McpToolFailure("already_exists", `${relativePath} already exists`);
  }
  try {
    await tauri.createFile(path);
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      throw new McpToolFailure("already_exists", `${relativePath} already exists`);
    }
    throw error;
  }
  const written = await tauri.writeFile(path, content);
  await refreshSidebarParent(path);
  return { path, relative_path: relativePath, modified_at: written.modified_at };
}

async function writeFile(args: unknown) {
  const { path, relativePath, content } = resolvedContentTarget(args);
  const open = useEditorStore.getState().openFiles.get(path);
  if (open?.isDirty) {
    throw new McpToolFailure(
      "unsaved_conflict",
      `${relativePath} is open with unsaved changes; the user's text is preserved — retry after they save`,
    );
  }
  const written = await tauri.writeFile(path, content);
  // A clean open tab must show the new content without user action (FR-017)
  // — the same refresh the file watcher applies to an external change. If the
  // tab went dirty during the write the user's text wins: it stays open and
  // the autosave engine writes it back over this write.
  const settled = useEditorStore.getState().openFiles.get(path);
  if (settled && !settled.isDirty) {
    useEditorStore.getState().reloadFromDisk(path, content);
  }
  return { path, relative_path: relativePath, modified_at: written.modified_at };
}

async function createFolder(args: unknown) {
  const { path, relativePath } = resolvedTarget(args);
  if (await tauri.fileExists(path)) {
    throw new McpToolFailure("already_exists", `${relativePath} already exists`);
  }
  try {
    await tauri.createDirectory(path);
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      throw new McpToolFailure("already_exists", `${relativePath} already exists`);
    }
    throw error;
  }
  await refreshSidebarParent(path);
  return { path, relative_path: relativePath };
}

const MCP_TOOL_HANDLERS: Record<string, McpToolHandler> = {
  describe_window: describeWindow,
  list_tabs: listTabs,
  create_file: createFile,
  write_file: writeFile,
  create_folder: createFolder,
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
    if (error instanceof McpToolFailure) {
      return { ok: false, error: { kind: error.kind, detail: error.detail } };
    }
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
    await tauri.mcpRespond(request.request_id, dispatch.result, null);
  } else {
    await tauri.mcpRespond(request.request_id, null, dispatch.error);
  }
}
