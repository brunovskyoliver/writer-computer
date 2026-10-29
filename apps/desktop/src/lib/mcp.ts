import * as tauri from "@/lib/tauri";
import { FileConflictError } from "@/lib/file-conflict";
import { editorGeneration } from "@/lib/editor-reset";
import { locationBehavior } from "@/components/editor-area/page-kinds";
import { getParentDir } from "@/lib/paths";
import { revealPathInSidebar } from "@/lib/reveal-in-sidebar";
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

/**
 * One in-flight write per canonical path. `mcp:request` dispatch is
 * fire-and-forget and each handler's awaits let later requests start before
 * earlier ones finish, so without this chain two writes to the same file
 * could settle out of order and the earlier request would win on disk.
 * Admission order is commit order; a failed op never blocks the next.
 */
const pathWriteQueues = new Map<string, Promise<unknown>>();

function enqueuePathWrite<T>(path: string, op: () => Promise<T>): Promise<T> {
  const queued = (pathWriteQueues.get(path) ?? Promise.resolve()).then(op, op);
  pathWriteQueues.set(path, queued);
  const cleanup = () => {
    if (pathWriteQueues.get(path) === queued) pathWriteQueues.delete(path);
  };
  void queued.then(cleanup, cleanup);
  return queued;
}

function unsavedConflict(relativePath: string, when: string): McpToolFailure {
  return new McpToolFailure(
    "unsaved_conflict",
    `${relativePath} ${when}; the user's text is preserved — retry after they save`,
  );
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
  return enqueuePathWrite(path, async () => {
    if (await tauri.fileExists(path)) {
      throw new McpToolFailure("already_exists", `${relativePath} already exists`);
    }
    // A dirty open tab on a deleted path still owns it — the autosave engine
    // will recreate the file with the user's text.
    if (useEditorStore.getState().openFiles.get(path)?.isDirty) {
      throw unsavedConflict(relativePath, "is open with unsaved changes");
    }
    try {
      await tauri.createFile(path);
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        throw new McpToolFailure("already_exists", `${relativePath} already exists`);
      }
      throw error;
    }
    try {
      const written = await tauri.writeFile(path, content);
      await refreshSidebarParent(path);
      return { path, relative_path: relativePath, modified_at: written.modified_at };
    } catch (error) {
      // The create already committed a placeholder; leaving it would make a
      // retry report already_exists. Remove only what this request made —
      // through the same trash path the UI's delete uses.
      await tauri.deleteEntry(path).catch((cleanupError: unknown) => {
        console.warn("[mcp] placeholder cleanup failed", cleanupError);
      });
      await refreshSidebarParent(path);
      throw error;
    }
  });
}

async function writeFile(args: unknown) {
  const { path, relativePath, content } = resolvedContentTarget(args);
  return enqueuePathWrite(path, () => writeFileResolved(path, relativePath, content));
}

async function writeFileResolved(path: string, relativePath: string, content: string) {
  useEditorStore.getState().flushPendingEdit(path);
  const admitted = useEditorStore.getState().openFiles.get(path);
  if (admitted?.isDirty || admitted?.conflict || admitted?.isLoading) {
    throw unsavedConflict(relativePath, "is open with unsaved changes or is loading");
  }
  const generation = editorGeneration();
  const expected = admitted ? admitted.diskContent : (await tauri.readFile(path)).content;
  let written;
  try {
    written = await tauri.writeFile(path, content, expected);
  } catch (error) {
    if (!(error instanceof FileConflictError)) throw error;
    const current = useEditorStore.getState().openFiles.get(path);
    if (
      admitted &&
      generation === editorGeneration() &&
      current?.instanceId === admitted.instanceId
    )
      useEditorStore.getState().recordDiskConflict(path, error.diskContent);
    throw unsavedConflict(relativePath, "changed on disk before the write");
  }
  // A conditional write protects disk; a separate ownership check protects
  // text typed or reopened while the IPC was pending. Never repair a race
  // by scheduling an unconditional overwrite of either version.
  if (generation !== editorGeneration())
    throw unsavedConflict(relativePath, "changed workspace while the write was in flight");
  const settled = useEditorStore.getState().openFiles.get(path);
  if (
    settled &&
    settled.instanceId !== admitted?.instanceId &&
    !settled.isDirty &&
    !settled.conflict &&
    !useEditorStore.getState().hasPendingEdit(path) &&
    settled.diskContent === content
  ) {
    return { path, relative_path: relativePath, modified_at: written.modified_at };
  }
  if (
    settled &&
    (settled.instanceId !== admitted?.instanceId ||
      settled.isDirty ||
      settled.conflict ||
      useEditorStore.getState().hasPendingEdit(path) ||
      settled.diskContent !== admitted?.diskContent)
  ) {
    useEditorStore.getState().recordDiskConflict(path, content);
    throw unsavedConflict(relativePath, "changed while the write was in flight");
  }
  if (settled) useEditorStore.getState().reloadFromDisk(path, content);
  return { path, relative_path: relativePath, modified_at: written.modified_at };
}

async function createFolder(args: unknown) {
  const { path, relativePath } = resolvedTarget(args);
  return enqueuePathWrite(path, async () => {
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
  });
}

/** FR-020: open in the window — focuses the tab already showing the file or
 *  opens a new one, never replacing a tab's document; `new_tab` forces a
 *  fresh tab — then bring the window forward. The only webview-side tool
 *  allowed to steal focus; Rust already resolved the path (`not_found` never
 *  reaches here). */
async function openFile(args: unknown) {
  const { path, relativePath } = resolvedTarget(args);
  const { new_tab } = (args ?? {}) as Record<string, unknown>;
  // A compact window's whole scope is its hosted file — already shown, so
  // the open reduces to the focus.
  if (useWorkspaceStore.getState().chromeMode !== "compact-file") {
    const editor = useEditorStore.getState();
    if (new_tab === true) {
      await editor.openFileInNewTab(path);
    } else {
      await editor.openFile(path);
    }
  }
  await tauri.focusCurrentWindow();
  return { opened: relativePath };
}

/** FR-022: the tab context-menu's reveal — expand the ancestors, scroll the
 *  row into view, no focus change. */
async function revealInSidebar(args: unknown) {
  const { path } = resolvedTarget(args);
  await revealPathInSidebar(path, { showSidebar: true });
  return {};
}

const MCP_TOOL_HANDLERS: Record<string, McpToolHandler> = {
  describe_window: describeWindow,
  list_tabs: listTabs,
  create_file: createFile,
  write_file: writeFile,
  create_folder: createFolder,
  open_file: openFile,
  reveal_in_sidebar: revealInSidebar,
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
