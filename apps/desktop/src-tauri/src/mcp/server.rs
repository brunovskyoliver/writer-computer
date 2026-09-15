//! The rmcp tool surface. Dispatch rule (research.md): a tool is answered
//! in Rust iff its source of truth is `AppState`/disk/file-index; it is
//! forwarded to the owning window's webview iff it needs live editor state
//! or a UI action.

use crate::commands::fs::{is_sidebar_file, modified_time, read_file_impl};
use crate::commands::search::fuzzy_search_from;
use crate::error::{McpErrorKind, McpToolError};
use crate::ignore::WorkspaceIgnore;
use crate::mcp::{
    forward_to_window, open_scopes, resolve_path, resolve_workspace, Resolved, Scope,
};
use crate::state::{AppState, WorkspaceState};
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::CallToolResult;
use rmcp::{tool, tool_handler, tool_router, ErrorData, ServerHandler};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;
use tauri::Manager;

/// `read_file` refuses files over 1 MiB (contracts/mcp-tools.md).
const READ_FILE_CAP: u64 = 1024 * 1024;
const LIST_FILES_CAP: usize = 5_000;
const SEARCH_FILES_DEFAULT_LIMIT: usize = 50;
const SEARCH_FILES_MAX_LIMIT: usize = 200;

/// One bridge connection's service instance. `conn_id` ties the pending
/// calls this connection issues to its lifetime, so a disconnect fails them.
#[derive(Clone)]
pub struct WriterMcpServer {
    app: tauri::AppHandle,
    conn_id: u64,
}

impl WriterMcpServer {
    pub fn new(app: tauri::AppHandle, conn_id: u64) -> Self {
        Self { app, conn_id }
    }

    fn app_state(&self) -> tauri::State<'_, AppState> {
        self.app.state::<AppState>()
    }

    /// The common forwarded-tool body: resolve `workspace`, emit the request
    /// to that window, await the reply.
    async fn forward(
        &self,
        workspace: Option<&str>,
        tool: &str,
        args: Value,
    ) -> Result<Value, McpToolError> {
        let resolved = resolve_workspace(self.app_state().inner(), workspace)?;
        forward_to_window(
            self.app_state().inner(),
            &resolved.label,
            self.conn_id,
            tool,
            args,
        )
        .await
    }
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ListFilesArgs {
    /// Workspace id from `list_workspaces`; required when several are open.
    #[serde(default)]
    pub workspace: Option<String>,
    /// Restrict the listing to this subdirectory (relative to the root).
    #[serde(default)]
    pub path: Option<String>,
    /// Max entries to return; defaults to and caps at 5,000.
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SearchFilesArgs {
    /// Workspace id from `list_workspaces`; required when several are open.
    #[serde(default)]
    pub workspace: Option<String>,
    /// Fuzzy query matched against workspace-relative file paths, same
    /// ranking as Writer's own search.
    pub query: String,
    /// Max results; default 50, capped at 200.
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ReadFileArgs {
    /// Workspace id from `list_workspaces`; required when several are open.
    #[serde(default)]
    pub workspace: Option<String>,
    /// Path relative to the workspace root, or absolute inside it.
    pub path: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct WorkspaceOnlyArgs {
    /// Workspace id from `list_workspaces`; required when several are open.
    #[serde(default)]
    pub workspace: Option<String>,
}

#[tool_router]
impl WriterMcpServer {
    /// Enumerate every open scope, then fan out `describe_window` for each
    /// window's live `active_file`. A window that does not answer still
    /// appears, with `active_file: null` — an empty list is a valid answer.
    #[tool(
        description = "List every open workspace, including file-scoped compact windows. Each entry's `id` is what other tools accept as `workspace`."
    )]
    async fn list_workspaces(&self) -> Result<CallToolResult, ErrorData> {
        let scopes = open_scopes(self.app_state().inner());

        // Emit every describe_window up front so replies stream back
        // concurrently; timeouts then overlap instead of stacking.
        let mut pending = Vec::with_capacity(scopes.len());
        for resolved in &scopes {
            let emitted = crate::mcp::emit_request(
                self.app_state().inner(),
                &resolved.label,
                self.conn_id,
                "describe_window",
                json!({}),
            );
            pending.push(emitted);
        }

        let mut active_files: Vec<Option<String>> = Vec::with_capacity(scopes.len());
        for emitted in pending {
            let active_file = match emitted {
                Ok((request_id, rx)) => {
                    crate::mcp::await_reply(self.app_state().inner(), request_id, rx)
                        .await
                        .ok()
                        .and_then(|reply| {
                            reply
                                .get("activeFilePath")
                                .and_then(Value::as_str)
                                .map(str::to_owned)
                        })
                }
                Err(_) => None,
            };
            active_files.push(active_file);
        }

        let workspaces: Vec<Value> = scopes
            .iter()
            .zip(active_files)
            .map(|(resolved, active_file)| workspace_entry(resolved, active_file))
            .collect();
        Ok(CallToolResult::structured(
            json!({ "workspaces": workspaces }),
        ))
    }

    /// Gitignore-aware walk honoring the sidebar's `is_sidebar_file`
    /// predicate and the workspace ignore matcher — the same set the
    /// sidebar shows (markdown, drawings, PDFs).
    #[tool(
        description = "List files in an open workspace with Writer's own sidebar rules (markdown, drawings, PDFs; gitignore-aware)."
    )]
    async fn list_files(
        &self,
        Parameters(args): Parameters<ListFilesArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let resolved = resolve_workspace(self.app_state().inner(), args.workspace.as_deref())?;
        let limit = args.limit.unwrap_or(LIST_FILES_CAP as u32) as usize;
        let limit = limit.min(LIST_FILES_CAP);

        let state = self
            .app_state()
            .get(&resolved.label)
            .ok_or_else(|| window_gone(&resolved))?;
        let (entries, truncated) = tauri::async_runtime::spawn_blocking(move || {
            list_files_impl(&state, &resolved, args.path.as_deref(), limit)
        })
        .await
        .map_err(|e| McpToolError::new(McpErrorKind::Internal, e.to_string()))??;

        Ok(CallToolResult::structured(
            json!({ "entries": entries, "truncated": truncated }),
        ))
    }

    /// `fuzzy_search_from` over the window's live `file_index` — identical
    /// ranking to in-app search.
    #[tool(
        description = "Fuzzy-search file paths in an open workspace with the same ranking as Writer's search."
    )]
    async fn search_files(
        &self,
        Parameters(args): Parameters<SearchFilesArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        if args.query.is_empty() {
            return Err(McpToolError::new(McpErrorKind::InvalidParams, "query is empty").into());
        }
        let resolved = resolve_workspace(self.app_state().inner(), args.workspace.as_deref())?;
        let limit = args
            .limit
            .unwrap_or(SEARCH_FILES_DEFAULT_LIMIT as u32)
            .clamp(1, SEARCH_FILES_MAX_LIMIT as u32) as usize;

        let state = self
            .app_state()
            .get(&resolved.label)
            .ok_or_else(|| window_gone(&resolved))?;
        let index = state.file_index.read().clone();
        let results = fuzzy_search_from(&args.query, &index, limit)
            .map_err(|e| McpToolError::new(McpErrorKind::Internal, e.to_string()))?
            .into_iter()
            .map(|r| {
                json!({
                    "path": r.path,
                    "relative_path": r.relative_path,
                    "score": r.score,
                })
            })
            .collect::<Vec<_>>();

        Ok(CallToolResult::structured(json!({ "results": results })))
    }

    /// On-disk text of a readable file kind (`.md`, `.markdown`,
    /// `.excalidraw.svg`), frontmatter included, capped at 1 MiB.
    #[tool(
        description = "Read a file's on-disk text. Readable kinds: .md, .markdown, .excalidraw.svg. Files over 1 MiB are refused."
    )]
    async fn read_file(
        &self,
        Parameters(args): Parameters<ReadFileArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let resolved = resolve_workspace(self.app_state().inner(), args.workspace.as_deref())?;
        let (canonical, relative) = resolve_path(&resolved.scope, &args.path)?;
        let output =
            tauri::async_runtime::spawn_blocking(move || read_file_checked(&canonical, &relative))
                .await
                .map_err(|e| McpToolError::new(McpErrorKind::Internal, e.to_string()))??;
        Ok(CallToolResult::structured(output))
    }

    /// Forwarded: only the window's webview knows its tabs.
    #[tool(
        description = "List the open tabs in a workspace's window, including non-file kinds (launcher, drawing, pdf, settings)."
    )]
    async fn list_tabs(
        &self,
        Parameters(args): Parameters<WorkspaceOnlyArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let reply = self
            .forward(args.workspace.as_deref(), "list_tabs", json!({}))
            .await?;
        Ok(CallToolResult::structured(reply))
    }
}

#[tool_handler(
    name = "writer",
    instructions = "Read and navigate the Writer markdown editor's open workspaces. Paths are relative to a workspace root; `workspace` is an id from `list_workspaces` and is required only when several are open."
)]
impl ServerHandler for WriterMcpServer {}

// --- impls kept free of AppHandle so `cargo test` can drive them ------------

fn window_gone(resolved: &Resolved) -> McpToolError {
    McpToolError::new(
        McpErrorKind::WindowUnavailable,
        format!("window {} is no longer open", resolved.label),
    )
}

fn workspace_entry(resolved: &Resolved, active_file: Option<String>) -> Value {
    match &resolved.scope {
        Scope::Root(root) => json!({
            "id": resolved.scope.id(),
            "kind": "workspace",
            "root": root.to_string_lossy(),
            "name": root
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| resolved.scope.id()),
            "active_file": active_file,
        }),
        Scope::StandaloneFile(file) => json!({
            "id": resolved.scope.id(),
            "kind": "file",
            "root": Value::Null,
            "name": file
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| resolved.scope.id()),
            "active_file": active_file,
        }),
    }
}

/// The file kinds `list_files` reports, mirroring `is_sidebar_file`.
fn entry_kind(path: &Path) -> &'static str {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return "other";
    };
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".excalidraw.svg") {
        "drawing"
    } else if lower.ends_with(".pdf") {
        "pdf"
    } else {
        "markdown"
    }
}

/// Walk `start` under `root` with the sidebar's rules: hidden files skipped,
/// the workspace ignore matcher applied to files and directory pruning, and
/// only `is_sidebar_file` kinds collected. Returns `(entries, truncated)`.
fn list_files_impl(
    state: &WorkspaceState,
    resolved: &Resolved,
    path_arg: Option<&str>,
    limit: usize,
) -> Result<(Vec<Value>, bool), McpToolError> {
    let Scope::Root(root) = &resolved.scope else {
        // A standalone window's whole scope is its file.
        return Ok((standalone_listing(resolved)?, false));
    };

    let start = match path_arg {
        Some(path) => {
            let (canonical, _) = resolve_path(&resolved.scope, path)?;
            if !canonical.is_dir() {
                return Err(McpToolError::new(
                    McpErrorKind::InvalidParams,
                    format!("{path} is not a directory"),
                ));
            }
            canonical
        }
        None => root.clone(),
    };

    let ignore = state
        .workspace_ignore
        .read()
        .as_ref()
        .map(Arc::clone)
        .unwrap_or_else(|| Arc::new(WorkspaceIgnore::bootstrap()));
    let ignore_for_prune = Arc::clone(&ignore);

    let mut entries = Vec::new();
    let mut truncated = false;
    let walker = ignore::WalkBuilder::new(&start)
        .hidden(true)
        .filter_entry(move |entry| {
            !(entry.file_type().is_some_and(|ft| ft.is_dir())
                && entry.path() != start.as_path()
                && ignore_for_prune.is_ignored(entry.path(), true))
        })
        .build();

    'walk: for result in walker {
        let Ok(entry) = result else { continue };
        if !entry.file_type().is_some_and(|ft| ft.is_file()) {
            continue;
        }
        let entry_path = entry.path();
        if !is_sidebar_file(entry_path) || ignore.is_ignored(entry_path, false) {
            continue;
        }
        if entries.len() >= limit {
            truncated = true;
            break 'walk;
        }
        entries.push(json!({
            "path": entry_path.to_string_lossy(),
            "relative_path": entry_path
                .strip_prefix(root)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| entry_path.to_string_lossy().to_string()),
            "kind": entry_kind(entry_path),
            "modified_at": modified_time(entry_path),
        }));
    }

    Ok((entries, truncated))
}

fn standalone_listing(resolved: &Resolved) -> Result<Vec<Value>, McpToolError> {
    let Scope::StandaloneFile(file) = &resolved.scope else {
        unreachable!()
    };
    if !file.is_file() {
        return Err(McpToolError::new(
            McpErrorKind::NotFound,
            "standalone file no longer exists",
        ));
    }
    let relative = file
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(vec![json!({
        "path": file.to_string_lossy(),
        "relative_path": relative,
        "kind": entry_kind(file),
        "modified_at": modified_time(file),
    })])
}

/// `read_file` checks after resolution: readable kind, under the 1 MiB cap,
/// then the shared `read_file_impl` for content + modified time.
fn read_file_checked(canonical: &Path, relative: &str) -> Result<Value, McpToolError> {
    if !is_readable_kind(canonical) {
        return Err(McpToolError::new(
            McpErrorKind::UnsupportedKind,
            format!("{relative} is not a readable kind (.md, .markdown, .excalidraw.svg)"),
        ));
    }
    let size = std::fs::metadata(canonical)
        .map(|m| m.len())
        .map_err(|e| McpToolError::new(McpErrorKind::Internal, e.to_string()))?;
    if size > READ_FILE_CAP {
        return Err(McpToolError::new(
            McpErrorKind::TooLarge,
            format!("{relative} exceeds the 1 MiB read cap"),
        ));
    }
    let file = read_file_impl(&canonical.to_string_lossy())
        .map_err(|e| McpToolError::new(McpErrorKind::Internal, e.to_string()))?;
    Ok(json!({
        "path": canonical.to_string_lossy(),
        "relative_path": relative,
        "content": file.content,
        "modified_at": file.modified_at,
    }))
}

/// The kinds `read_file` accepts: Writer's text documents. Listings may show
/// more (PDFs); reading them is `unsupported_kind`.
fn is_readable_kind(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".excalidraw.svg")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::Resolved;
    use std::path::PathBuf;
    use tempfile::TempDir;

    fn touch(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, content).unwrap();
    }

    fn canonical(dir: &TempDir) -> PathBuf {
        dir.path().canonicalize().unwrap()
    }

    fn workspace_state(root: &Path) -> WorkspaceState {
        let state = WorkspaceState::default();
        *state.workspace_ignore.write() = Some(Arc::new(WorkspaceIgnore::load(root)));
        state
    }

    fn resolved_root(root: &Path) -> Resolved {
        Resolved {
            label: "main".into(),
            scope: Scope::Root(root.to_path_buf()),
        }
    }

    // --- router registration -------------------------------------------------

    #[test]
    fn router_registers_exactly_the_us1_tools() {
        // Routing rule check: the registered surface is the five read-only
        // tools; `list_tabs` is the only webview-forwarded one (its body calls
        // `forward`, everything else resolves against AppState/disk).
        let mut names: Vec<String> = WriterMcpServer::tool_router()
            .list_all()
            .into_iter()
            .map(|tool| tool.name.to_string())
            .collect();
        names.sort();
        assert_eq!(
            names,
            [
                "list_files",
                "list_tabs",
                "list_workspaces",
                "read_file",
                "search_files"
            ]
        );
    }

    // --- list_files ------------------------------------------------------------

    #[test]
    fn list_files_follows_sidebar_kinds_and_ignore_rules() {
        let dir = TempDir::new().unwrap();
        let root = canonical(&dir);
        touch(&root.join("a.md"), "x");
        touch(&root.join("b.markdown"), "x");
        touch(&root.join("d.excalidraw.svg"), "x");
        touch(&root.join("p.pdf"), "x");
        touch(&root.join("note.txt"), "x");
        touch(&root.join("sub/nested.md"), "x");
        touch(&root.join("build/out.md"), "x");
        touch(&root.join(".git/ignored.md"), "x");
        touch(&root.join(".gitignore"), "build/\n");

        let state = workspace_state(&root);
        let resolved = resolved_root(&root);
        let (entries, truncated) = list_files_impl(&state, &resolved, None, 5000).unwrap();
        assert!(!truncated);

        let rels: Vec<&str> = entries
            .iter()
            .map(|e| e["relative_path"].as_str().unwrap())
            .collect();
        for expected in ["a.md", "d.excalidraw.svg", "p.pdf", "sub/nested.md"] {
            assert!(rels.contains(&expected), "missing {expected}");
        }
        for excluded in [
            "b.markdown",
            "note.txt",
            "build/out.md",
            ".git/ignored.md",
            ".gitignore",
        ] {
            assert!(!rels.contains(&excluded), "unexpected {excluded}");
        }

        let kinds: std::collections::HashMap<&str, &str> = entries
            .iter()
            .map(|e| {
                (
                    e["relative_path"].as_str().unwrap(),
                    e["kind"].as_str().unwrap(),
                )
            })
            .collect();
        assert_eq!(kinds["d.excalidraw.svg"], "drawing");
        assert_eq!(kinds["p.pdf"], "pdf");
        assert_eq!(kinds["a.md"], "markdown");

        // `path` restricts the listing to a subdirectory.
        let (entries, _) = list_files_impl(&state, &resolved, Some("sub"), 5000).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["relative_path"], "sub/nested.md");

        // The cap sets `truncated`.
        let (entries, truncated) = list_files_impl(&state, &resolved, None, 2).unwrap();
        assert_eq!(entries.len(), 2);
        assert!(truncated);

        let err = list_files_impl(&state, &resolved, Some("a.md"), 5000).unwrap_err();
        assert_eq!(err.kind, McpErrorKind::InvalidParams);
    }

    #[test]
    fn standalone_scope_lists_only_its_file() {
        let dir = TempDir::new().unwrap();
        let file = canonical(&dir).join("note.md");
        touch(&file, "x");
        touch(&canonical(&dir).join("other.md"), "x");
        let resolved = Resolved {
            label: "solo".into(),
            scope: Scope::StandaloneFile(file.clone()),
        };
        let state = WorkspaceState::default();
        let (entries, truncated) = list_files_impl(&state, &resolved, None, 5000).unwrap();
        assert!(!truncated);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["relative_path"], "note.md");
    }

    // --- read_file -------------------------------------------------------------

    #[test]
    fn read_file_refuses_unreadable_kinds_and_oversized_files() {
        let dir = TempDir::new().unwrap();
        let root = canonical(&dir);
        touch(&root.join("note.md"), "# Hello\nbody\n");
        touch(&root.join("page.txt"), "x");
        touch(
            &root.join("big.md"),
            &"x".repeat(READ_FILE_CAP as usize + 1),
        );
        touch(&root.join("doc.markdown"), "md");
        touch(&root.join("d.excalidraw.svg"), "<svg/>");

        let ok = read_file_checked(&root.join("note.md"), "note.md").unwrap();
        assert_eq!(ok["content"], "# Hello\nbody\n");
        assert_eq!(ok["relative_path"], "note.md");
        assert!(ok["modified_at"].as_u64().unwrap() > 0);

        // .markdown and .excalidraw.svg are readable kinds.
        assert!(read_file_checked(&root.join("doc.markdown"), "doc.markdown").is_ok());
        assert!(read_file_checked(&root.join("d.excalidraw.svg"), "d.excalidraw.svg").is_ok());

        let err = read_file_checked(&root.join("page.txt"), "page.txt").unwrap_err();
        assert_eq!(err.kind, McpErrorKind::UnsupportedKind);

        let err = read_file_checked(&root.join("big.md"), "big.md").unwrap_err();
        assert_eq!(err.kind, McpErrorKind::TooLarge);
    }

    // --- workspace entries ------------------------------------------------------

    #[test]
    fn workspace_entry_shape_matches_the_contract() {
        let dir = TempDir::new().unwrap();
        let root = canonical(&dir);
        let resolved = Resolved {
            label: "main".into(),
            scope: Scope::Root(root.clone()),
        };
        let entry = workspace_entry(&resolved, Some("/ws/a.md".into()));
        assert_eq!(entry["id"], root.to_string_lossy().as_ref());
        assert_eq!(entry["kind"], "workspace");
        assert_eq!(entry["root"], root.to_string_lossy().as_ref());
        assert_eq!(entry["active_file"], "/ws/a.md");

        let file = canonical(&dir).join("solo.md");
        let resolved = Resolved {
            label: "solo".into(),
            scope: Scope::StandaloneFile(file.clone()),
        };
        let entry = workspace_entry(&resolved, None);
        assert_eq!(entry["id"], file.to_string_lossy().as_ref());
        assert_eq!(entry["kind"], "file");
        assert_eq!(entry["name"], "solo.md");
        assert_eq!(entry["active_file"], Value::Null);
    }
}
