//! MCP server: a Unix-socket JSON-RPC endpoint inside the running app so
//! local agents can drive Writer through the `writer mcp` bridge.
//!
//! Layout: `bridge.rs` owns the per-connection handshake and rmcp serving,
//! `server.rs` owns the tool surface. This module owns everything shared:
//! the socket path (single source for app bind and CLI connect), the
//! listener lifecycle, workspace/path resolution, and the pending map that
//! carries webview-forwarded tool calls.

pub mod bridge;
pub mod server;

use crate::error::{McpErrorKind, McpToolError};
use crate::state::AppState;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::{Emitter, Manager};
use tokio::sync::oneshot;

/// Tauri `identifier` from tauri.conf.json. The socket lives in the app data
/// dir, which on every platform is derived from this string; the CLI has no
/// `AppHandle`, so both sides compute the path from the constant instead.
const BUNDLE_IDENTIFIER: &str = "com.writer-computer";

/// The one source for the socket location — app binds it, `writer mcp`
/// connects to it. They must never compute the path independently.
pub fn socket_path() -> PathBuf {
    app_data_dir().join("mcp.sock")
}

/// `app_data_dir()` without an `AppHandle`, matching Tauri's resolution for
/// this app's identifier on each platform.
fn app_data_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        home_dir()
            .join("Library")
            .join("Application Support")
            .join(BUNDLE_IDENTIFIER)
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join(".local").join("share"))
            .join(BUNDLE_IDENTIFIER)
    }
    #[cfg(windows)]
    {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(home_dir)
            .join(BUNDLE_IDENTIFIER)
    }
}

#[cfg(unix)]
fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

#[cfg(windows)]
fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("C:\\"))
}

// --- server state -----------------------------------------------------------

/// What a forwarded call waits on: the tool result JSON, or the
/// `{kind, detail}` failure the dispatcher reported.
pub type WebviewReply = Result<serde_json::Value, WebviewCallError>;

#[derive(Debug)]
pub struct WebviewCallError {
    pub kind: McpErrorKind,
    pub detail: String,
}

impl From<WebviewCallError> for McpToolError {
    fn from(err: WebviewCallError) -> Self {
        McpToolError::new(err.kind, err.detail)
    }
}

/// One in-flight `mcp:request`. `label` lets a window close fail its own
/// calls; `conn_id` lets a bridge disconnect fail the calls it issued.
pub struct PendingCall {
    pub conn_id: u64,
    pub label: String,
    pub sender: oneshot::Sender<WebviewReply>,
}

/// Server status for `mcp_status` and the settings surface (data-model.md
/// "Server status"). `Failed` keeps the bind error so the UI can show it;
/// a failure never blocks app launch (FR-004).
#[derive(Debug, Clone, Default)]
pub enum McpStatus {
    #[default]
    Stopped,
    Running,
    Failed(String),
}

impl McpStatus {
    pub fn state_str(&self) -> &'static str {
        match self {
            Self::Stopped => "stopped",
            Self::Running => "running",
            Self::Failed(_) => "failed",
        }
    }

    pub fn error(&self) -> Option<&str> {
        match self {
            Self::Failed(err) => Some(err),
            _ => None,
        }
    }
}

/// Process-wide MCP runtime held inside `AppState`. Everything here is
/// mutated under one mutex; lock order is `AppState.mcp` after
/// `windows`, never the reverse.
#[derive(Default)]
pub struct McpServerState {
    pub enabled: bool,
    pub status: McpStatus,
    pub listener: Option<tauri::async_runtime::JoinHandle<()>>,
    pub connections: HashMap<u64, tauri::async_runtime::JoinHandle<()>>,
    pub pending: HashMap<u64, PendingCall>,
    pub next_request_id: u64,
    pub next_conn_id: u64,
}

/// Serializable shape returned by the `mcp_status` command.
#[derive(Serialize)]
pub struct McpStatusReport {
    pub enabled: bool,
    pub state: &'static str,
    pub error: Option<String>,
    pub socket_path: String,
}

pub fn status_report(app_state: &AppState) -> McpStatusReport {
    let mcp = app_state.mcp.lock();
    McpStatusReport {
        enabled: mcp.enabled,
        state: mcp.status.state_str(),
        error: mcp.status.error().map(str::to_owned),
        socket_path: socket_path().to_string_lossy().to_string(),
    }
}

// --- lifecycle --------------------------------------------------------------

/// Post-settings-write hook mirroring `telemetry::apply_settings`: reads
/// `mcp.enabled` out of the settings layer and applies it. Called under the
/// global settings lock by `with_global_settings_mut` so two windows cannot
/// interleave persist/apply in the wrong order.
pub fn apply_settings(app_state: &AppState, settings: &crate::config::Settings) {
    let enabled = matches!(
        settings.get_global_or_default("mcp.enabled"),
        Some(crate::config::ConfigValue::Bool(true))
    );
    apply_enabled(app_state, enabled);
}

/// Start or stop the server to match `enabled`. A start failure is recorded
/// in status and reported through `mcp_status`; it never propagates.
///
/// The no-op paths matter beyond idempotence: `apply_settings` runs on every
/// global write, and `stop` removes the socket file — so "still disabled"
/// must not touch the filesystem (a `cargo test` run would unlink a live
/// app's socket), and "still running" must not rebind.
pub fn apply_enabled(app_state: &AppState, enabled: bool) {
    let action = {
        let mut mcp = app_state.mcp.lock();
        let was_enabled = std::mem::replace(&mut mcp.enabled, enabled);
        let running = matches!(mcp.status, McpStatus::Running);
        if enabled && !running {
            Some(true) // start or retry
        } else if !enabled && was_enabled {
            Some(false) // newly disabled
        } else {
            None
        }
    };
    match action {
        Some(true) => start(app_state),
        Some(false) => stop(app_state),
        None => {}
    }
}

fn start(app_state: &AppState) {
    let Some(app) = app_state.app_handle() else {
        // Only reachable in tests, where no Tauri runtime exists.
        app_state.mcp.lock().status = McpStatus::Failed("app handle unavailable".into());
        return;
    };
    match bind_and_spawn(&app) {
        Ok(handle) => {
            let mut mcp = app_state.mcp.lock();
            mcp.listener = Some(handle);
            mcp.status = McpStatus::Running;
        }
        Err(err) => {
            app_state.mcp.lock().status = McpStatus::Failed(err);
        }
    }
}

/// Stop the listener and every connection, fail all pending calls, and
/// remove the socket file. Idempotent — also the quit path.
pub fn stop(app_state: &AppState) {
    {
        let mut mcp = app_state.mcp.lock();
        if let Some(handle) = mcp.listener.take() {
            handle.abort();
        }
        for (_, handle) in mcp.connections.drain() {
            handle.abort();
        }
        fail_all_pending_locked(
            &mut mcp,
            McpErrorKind::ServerDisabled,
            "MCP server disabled",
        );
        mcp.status = McpStatus::Stopped;
    }
    let _ = std::fs::remove_file(socket_path());
}

/// Quit path: identical to `stop` — the socket file must not outlive the app
/// or the next launch would pay the stale-socket probe.
pub fn shutdown(app_state: &AppState) {
    stop(app_state);
}

#[cfg(unix)]
fn bind_and_spawn(app: &tauri::AppHandle) -> Result<tauri::async_runtime::JoinHandle<()>, String> {
    let listener = bind_listener(&socket_path())?;
    Ok(tauri::async_runtime::spawn(accept_loop(
        app.clone(),
        listener,
    )))
}

#[cfg(not(unix))]
fn bind_and_spawn(_app: &tauri::AppHandle) -> Result<tauri::async_runtime::JoinHandle<()>, String> {
    Err("MCP server is not supported on this platform".into())
}

/// Bind the Unix listener with stale-socket takeover: if the file exists,
/// probe-connect first — refused means a dead server's leftover (unlink and
/// bind), accepted means a live server already owns it (startup failure).
#[cfg(unix)]
fn bind_listener(path: &Path) -> Result<tokio::net::UnixListener, String> {
    use std::os::unix::fs::PermissionsExt;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if path.exists() {
        match std::os::unix::net::UnixStream::connect(path) {
            Ok(_) => {
                return Err("another Writer instance is already serving MCP".into());
            }
            Err(err)
                if matches!(
                    err.kind(),
                    std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::NotFound
                ) =>
            {
                let _ = std::fs::remove_file(path);
            }
            Err(err) => return Err(err.to_string()),
        }
    }
    // `UnixListener::bind` needs an entered reactor, but `start` runs on
    // Tauri's main thread during setup where none is active.
    let runtime = tauri::async_runtime::handle();
    let _guard = runtime.inner().enter();
    let listener = tokio::net::UnixListener::bind(path).map_err(|e| e.to_string())?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| e.to_string())?;
    Ok(listener)
}

#[cfg(unix)]
async fn accept_loop(app: tauri::AppHandle, listener: tokio::net::UnixListener) {
    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                let app_state = app.state::<AppState>();
                let conn_id = {
                    let mut mcp = app_state.mcp.lock();
                    mcp.next_conn_id += 1;
                    mcp.next_conn_id
                };
                let handle = tauri::async_runtime::spawn(bridge::serve_connection(
                    app.clone(),
                    stream,
                    conn_id,
                ));
                app_state.mcp.lock().connections.insert(conn_id, handle);
            }
            Err(_) => return,
        }
    }
}

// --- workspace and path resolution ------------------------------------------

/// What a tool call is scoped to after resolution.
#[derive(Debug, Clone)]
pub enum Scope {
    /// A workspace window: `path` args resolve under this canonical root.
    Root(PathBuf),
    /// A compact standalone window: its whole scope is this one file.
    StandaloneFile(PathBuf),
}

impl Scope {
    /// The `id` `list_workspaces` reports for this scope.
    pub fn id(&self) -> String {
        match self {
            Self::Root(root) => root.to_string_lossy().to_string(),
            Self::StandaloneFile(file) => file.to_string_lossy().to_string(),
        }
    }
}

/// A resolved workspace argument: the window that owns the scope plus the
/// scope itself.
#[derive(Debug, Clone)]
pub struct Resolved {
    pub label: String,
    pub scope: Scope,
}

/// Snapshot of every open scope — the `list_workspaces` enumeration and the
/// candidate set for `workspace` resolution in one pass.
pub fn open_scopes(app_state: &AppState) -> Vec<Resolved> {
    app_state
        .workspace_targets()
        .into_iter()
        .filter_map(|(label, root, standalone)| {
            if let Some(root) = root {
                Some(Resolved {
                    label,
                    scope: Scope::Root(root),
                })
            } else {
                standalone.map(|file| Resolved {
                    label,
                    scope: Scope::StandaloneFile(file),
                })
            }
        })
        .collect()
}

/// Resolve the optional `workspace` argument to exactly one window. A given
/// id must match an open scope (canonical root, or standalone file path);
/// omitted defaults only when exactly one scope is open (FR-026).
pub fn resolve_workspace(
    app_state: &AppState,
    workspace: Option<&str>,
) -> Result<Resolved, McpToolError> {
    let scopes = open_scopes(app_state);
    match workspace {
        Some(id) => {
            let wanted = Path::new(id);
            let canonical = wanted
                .canonicalize()
                .unwrap_or_else(|_| wanted.to_path_buf());
            scopes
                .into_iter()
                .find(|resolved| match &resolved.scope {
                    Scope::Root(root) => root == wanted || *root == canonical,
                    Scope::StandaloneFile(file) => file == wanted || *file == canonical,
                })
                .ok_or_else(|| {
                    McpToolError::new(
                        McpErrorKind::NotFound,
                        format!("no open workspace with id {id}"),
                    )
                })
        }
        None => match scopes.len() {
            0 => Err(McpToolError::new(
                McpErrorKind::NoWorkspace,
                "no workspace is open",
            )),
            1 => Ok(scopes.into_iter().next().unwrap()),
            _ => {
                let candidates = scopes
                    .iter()
                    .map(|resolved| resolved.scope.id())
                    .collect::<Vec<_>>()
                    .join(", ");
                Err(McpToolError::new(
                    McpErrorKind::AmbiguousWorkspace,
                    format!("workspace argument is required; open workspaces: {candidates}"),
                ))
            }
        },
    }
}

/// Resolve a tool `path` argument inside a scope: relative to the root (or
/// absolute inside it), canonicalized, and required to stay in scope — the
/// `starts_with` check after canonicalization rejects `..` escapes and
/// symlinked outs in one step (FR-025). Returns `(canonical, relative_path)`.
pub fn resolve_path(scope: &Scope, path: &str) -> Result<(PathBuf, String), McpToolError> {
    let candidate = candidate_path(scope, path);
    let canonical = candidate
        .canonicalize()
        .map_err(|_| McpToolError::new(McpErrorKind::NotFound, format!("{path} does not exist")))?;
    check_scope(scope, &canonical, path)
}

/// Same boundary check for `create_*` targets, which may not exist yet:
/// canonicalize the parent and re-attach the file name (FR-025). Part of the
/// shared resolution API (T010); the write tools that call it land with US2.
#[allow(dead_code)]
pub fn resolve_create_path(scope: &Scope, path: &str) -> Result<(PathBuf, String), McpToolError> {
    let candidate = candidate_path(scope, path);
    let parent = candidate
        .parent()
        .ok_or_else(|| McpToolError::new(McpErrorKind::InvalidParams, "path has no parent"))?;
    let file_name = candidate
        .file_name()
        .ok_or_else(|| McpToolError::new(McpErrorKind::InvalidParams, "path has no file name"))?;
    let canonical_parent = parent
        .canonicalize()
        .map_err(|_| McpToolError::new(McpErrorKind::NotFound, format!("{path} does not exist")))?;
    check_scope(scope, &canonical_parent.join(file_name), path)
}

fn candidate_path(scope: &Scope, path: &str) -> PathBuf {
    let raw = Path::new(path);
    if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        match scope {
            Scope::Root(root) => root.join(raw),
            Scope::StandaloneFile(file) => file
                .parent()
                .map(|dir| dir.join(raw))
                .unwrap_or_else(|| raw.to_path_buf()),
        }
    }
}

fn check_scope(
    scope: &Scope,
    canonical: &Path,
    original: &str,
) -> Result<(PathBuf, String), McpToolError> {
    match scope {
        Scope::Root(root) => {
            if !canonical.starts_with(root) {
                return Err(McpToolError::new(
                    McpErrorKind::OutsideWorkspace,
                    format!("{original} resolves outside the workspace"),
                ));
            }
            let relative = canonical
                .strip_prefix(root)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            Ok((canonical.to_path_buf(), relative))
        }
        Scope::StandaloneFile(file) => {
            if canonical != file {
                return Err(McpToolError::new(
                    McpErrorKind::OutsideWorkspace,
                    format!("{original} resolves outside the standalone file"),
                ));
            }
            let relative = file
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            Ok((canonical.to_path_buf(), relative))
        }
    }
}

// --- webview-forward plumbing ------------------------------------------------

/// Emit an `mcp:request` to one window and return the receiver for its
/// `mcp_respond` reply. The caller awaits it with `await_reply`.
pub fn emit_request(
    app_state: &AppState,
    label: &str,
    conn_id: u64,
    tool: &str,
    args: serde_json::Value,
) -> Result<(u64, oneshot::Receiver<WebviewReply>), McpToolError> {
    let (tx, rx) = oneshot::channel();
    let request_id = {
        let mut mcp = app_state.mcp.lock();
        mcp.next_request_id += 1;
        let request_id = mcp.next_request_id;
        mcp.pending.insert(
            request_id,
            PendingCall {
                conn_id,
                label: label.to_string(),
                sender: tx,
            },
        );
        request_id
    };
    let app = app_state.app_handle().ok_or_else(|| {
        app_state.mcp.lock().pending.remove(&request_id);
        McpToolError::new(McpErrorKind::WindowUnavailable, "app handle unavailable")
    })?;
    let payload = serde_json::json!({
        "request_id": request_id,
        "tool": tool,
        "args": args,
    });
    if let Err(err) = app.emit_to(label, "mcp:request", payload) {
        app_state.mcp.lock().pending.remove(&request_id);
        return Err(McpToolError::new(
            McpErrorKind::WindowUnavailable,
            format!("could not reach window {label}: {err}"),
        ));
    }
    Ok((request_id, rx))
}

/// Wait for a forwarded call's reply. Five seconds without an `mcp_respond`
/// is a `window_unavailable` (app-bridge.md failure rules); the stale pending
/// entry is removed so a late reply is dropped instead of leaked.
pub async fn await_reply(
    app_state: &AppState,
    request_id: u64,
    rx: oneshot::Receiver<WebviewReply>,
) -> Result<serde_json::Value, McpToolError> {
    match tokio::time::timeout(std::time::Duration::from_secs(5), rx).await {
        Ok(Ok(reply)) => reply.map_err(McpToolError::from),
        Ok(Err(_)) => Err(McpToolError::new(
            McpErrorKind::WindowUnavailable,
            "window reply channel closed",
        )),
        Err(_) => {
            app_state.mcp.lock().pending.remove(&request_id);
            Err(McpToolError::new(
                McpErrorKind::WindowUnavailable,
                "window did not answer in time",
            ))
        }
    }
}

/// Forward `tool` to `label`'s webview and await the reply — the common
/// shape of every webview-side tool.
pub async fn forward_to_window(
    app_state: &AppState,
    label: &str,
    conn_id: u64,
    tool: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value, McpToolError> {
    let (request_id, rx) = emit_request(app_state, label, conn_id, tool, args)?;
    await_reply(app_state, request_id, rx).await
}

/// `mcp_respond` entry: complete a pending call. An unknown id means the
/// call already timed out or the window closed — the reply is dropped.
pub fn complete_pending(app_state: &AppState, request_id: u64, reply: WebviewReply) {
    if let Some(pending) = app_state.mcp.lock().pending.remove(&request_id) {
        let _ = pending.sender.send(reply);
    }
}

/// Fail every pending call aimed at `label` — the window is gone and its
/// webview can no longer answer. Called from `AppState::remove`.
pub fn fail_pending_for_label(app_state: &AppState, label: &str) {
    let mut mcp = app_state.mcp.lock();
    let ids: Vec<u64> = mcp
        .pending
        .iter()
        .filter(|(_, pending)| pending.label == label)
        .map(|(id, _)| *id)
        .collect();
    for id in ids {
        if let Some(pending) = mcp.pending.remove(&id) {
            let _ = pending.sender.send(Err(WebviewCallError {
                kind: McpErrorKind::WindowUnavailable,
                detail: "window closed".into(),
            }));
        }
    }
}

/// Fail every pending call issued over `conn_id` — the bridge hung up, so
/// even if the webview still answers there is nobody to deliver it to.
pub fn fail_pending_for_conn(app_state: &AppState, conn_id: u64) {
    let mut mcp = app_state.mcp.lock();
    let ids: Vec<u64> = mcp
        .pending
        .iter()
        .filter(|(_, pending)| pending.conn_id == conn_id)
        .map(|(id, _)| *id)
        .collect();
    for id in ids {
        if let Some(pending) = mcp.pending.remove(&id) {
            let _ = pending.sender.send(Err(WebviewCallError {
                kind: McpErrorKind::WindowUnavailable,
                detail: "bridge connection closed".into(),
            }));
        }
    }
    mcp.connections.remove(&conn_id);
}

fn fail_all_pending_locked(mcp: &mut McpServerState, kind: McpErrorKind, detail: &str) {
    for (_, pending) in mcp.pending.drain() {
        let _ = pending.sender.send(Err(WebviewCallError {
            kind,
            detail: detail.to_string(),
        }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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

    // --- workspace resolution ------------------------------------------------

    #[test]
    fn resolve_workspace_defaults_only_when_exactly_one_scope_is_open() {
        let dir = TempDir::new().unwrap();
        let root = canonical(&dir);
        let app_state = AppState::new();

        let err = resolve_workspace(&app_state, None).unwrap_err();
        assert_eq!(err.kind, McpErrorKind::NoWorkspace);

        let main = app_state.get_or_create("main");
        *main.workspace_root.write() = Some(root.clone());
        let resolved = resolve_workspace(&app_state, None).unwrap();
        assert_eq!(resolved.label, "main");

        let second_dir = TempDir::new().unwrap();
        let second = app_state.get_or_create("second");
        *second.workspace_root.write() = Some(canonical(&second_dir));

        let err = resolve_workspace(&app_state, None).unwrap_err();
        assert_eq!(err.kind, McpErrorKind::AmbiguousWorkspace);
        assert!(err.detail.contains(&root.to_string_lossy().to_string()));

        // An explicit id resolves to its window — and a non-canonical
        // spelling of the same root matches too.
        let resolved = resolve_workspace(&app_state, Some(&root.to_string_lossy())).unwrap();
        assert_eq!(resolved.label, "main");
        let aliased = format!("{}/./", root.to_string_lossy());
        let resolved = resolve_workspace(&app_state, Some(&aliased)).unwrap();
        assert_eq!(resolved.label, "main");

        let err = resolve_workspace(&app_state, Some("/no/such/workspace")).unwrap_err();
        assert_eq!(err.kind, McpErrorKind::NotFound);
    }

    #[test]
    fn standalone_windows_resolve_by_file_path() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("note.md");
        touch(&file, "hi");
        let canonical_file = file.canonicalize().unwrap();

        let app_state = AppState::new();
        let solo = app_state.get_or_create("solo");
        *solo.standalone_file.write() = Some(canonical_file.clone());

        let resolved =
            resolve_workspace(&app_state, Some(&canonical_file.to_string_lossy())).unwrap();
        assert_eq!(resolved.label, "solo");
        assert!(matches!(resolved.scope, Scope::StandaloneFile(_)));
    }

    #[test]
    fn windows_without_a_scope_are_not_workspaces() {
        // A window that has neither a workspace root nor a standalone file
        // (e.g. still on the launcher) contributes no scope.
        let app_state = AppState::new();
        app_state.get_or_create("empty");
        assert!(open_scopes(&app_state).is_empty());
        let err = resolve_workspace(&app_state, None).unwrap_err();
        assert_eq!(err.kind, McpErrorKind::NoWorkspace);
    }

    // --- path boundary checks --------------------------------------------------

    #[test]
    fn resolve_path_accepts_relative_and_absolute_paths_inside_the_root() {
        let dir = TempDir::new().unwrap();
        let root = canonical(&dir);
        touch(&root.join("sub/note.md"), "x");
        touch(&root.join("top.md"), "x");
        let scope = Scope::Root(root.clone());

        let (path, rel) = resolve_path(&scope, "sub/note.md").unwrap();
        assert_eq!(path, root.join("sub/note.md"));
        assert_eq!(rel, "sub/note.md");

        let (_, rel) = resolve_path(&scope, &root.join("top.md").to_string_lossy()).unwrap();
        assert_eq!(rel, "top.md");
    }

    #[test]
    fn resolve_path_rejects_escapes_missing_and_outside_paths() {
        let dir = TempDir::new().unwrap();
        let root = canonical(&dir);
        touch(&root.join("sub/note.md"), "x");
        let scope = Scope::Root(root);

        let outside = TempDir::new().unwrap();
        let outside_file = outside.path().join("out.md");
        touch(&outside_file, "x");

        let err = resolve_path(&scope, "sub/../..").unwrap_err();
        assert_eq!(err.kind, McpErrorKind::OutsideWorkspace);

        let err = resolve_path(&scope, &outside_file.to_string_lossy()).unwrap_err();
        assert_eq!(err.kind, McpErrorKind::OutsideWorkspace);

        let err = resolve_path(&scope, "nope.md").unwrap_err();
        assert_eq!(err.kind, McpErrorKind::NotFound);
    }

    #[cfg(unix)]
    #[test]
    fn resolve_path_rejects_symlink_escapes() {
        let dir = TempDir::new().unwrap();
        let root = canonical(&dir);
        let outside = TempDir::new().unwrap();
        let secret = outside.path().join("secret.md");
        touch(&secret, "x");
        std::os::unix::fs::symlink(&secret, root.join("link.md")).unwrap();

        let err = resolve_path(&Scope::Root(root), "link.md").unwrap_err();
        assert_eq!(err.kind, McpErrorKind::OutsideWorkspace);
    }

    #[test]
    fn standalone_scope_accepts_only_its_own_file() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("note.md");
        touch(&file, "x");
        let canonical_file = file.canonicalize().unwrap();
        let scope = Scope::StandaloneFile(canonical_file.clone());

        let (path, rel) = resolve_path(&scope, "note.md").unwrap();
        assert_eq!(path, canonical_file);
        assert_eq!(rel, "note.md");

        touch(&dir.path().join("other.md"), "x");
        let err = resolve_path(&scope, "other.md").unwrap_err();
        assert_eq!(err.kind, McpErrorKind::OutsideWorkspace);
    }

    #[test]
    fn create_targets_canonicalize_the_parent() {
        let dir = TempDir::new().unwrap();
        let root = canonical(&dir);
        std::fs::create_dir_all(root.join("sub")).unwrap();
        let scope = Scope::Root(root.clone());

        let (path, rel) = resolve_create_path(&scope, "sub/new.md").unwrap();
        assert_eq!(path, root.join("sub/new.md"));
        assert_eq!(rel, "sub/new.md");

        let err = resolve_create_path(&scope, "sub/../../escape.md").unwrap_err();
        assert_eq!(err.kind, McpErrorKind::OutsideWorkspace);

        let err = resolve_create_path(&scope, "missing-dir/new.md").unwrap_err();
        assert_eq!(err.kind, McpErrorKind::NotFound);
    }

    // --- error mapping ----------------------------------------------------------

    #[test]
    fn error_kinds_map_to_contract_codes_and_data() {
        use rmcp::model::ErrorCode;

        for kind in [
            McpErrorKind::InvalidParams,
            McpErrorKind::NotFound,
            McpErrorKind::OutsideWorkspace,
            McpErrorKind::AmbiguousWorkspace,
            McpErrorKind::NoWorkspace,
            McpErrorKind::UnsupportedKind,
            McpErrorKind::AlreadyExists,
            McpErrorKind::TooLarge,
        ] {
            assert_eq!(kind.code(), ErrorCode::INVALID_PARAMS, "{kind:?}");
        }
        for kind in [
            McpErrorKind::UnsavedConflict,
            McpErrorKind::WindowUnavailable,
            McpErrorKind::ServerDisabled,
            McpErrorKind::VersionMismatch,
            McpErrorKind::Internal,
        ] {
            assert_eq!(kind.code(), ErrorCode::INTERNAL_ERROR, "{kind:?}");
        }

        let data: rmcp::ErrorData = McpToolError::new(McpErrorKind::TooLarge, "big file").into();
        assert_eq!(data.code, ErrorCode::INVALID_PARAMS);
        let data = data.data.unwrap();
        assert_eq!(data["kind"], "too_large");
        assert_eq!(data["detail"], "big file");

        assert_eq!(
            McpErrorKind::from_kind_str("unsaved_conflict"),
            McpErrorKind::UnsavedConflict
        );
        assert_eq!(McpErrorKind::from_kind_str("bogus"), McpErrorKind::Internal);
    }

    // --- stale-socket takeover ----------------------------------------------------

    #[cfg(unix)]
    #[test]
    fn bind_takes_over_a_stale_socket_and_refuses_a_live_one() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new().unwrap();
        let path = dir.path().join("mcp.sock");

        // `UnixListener::bind` registers with the Tokio reactor, so the binds
        // run inside `block_on`; the probing logic under test is synchronous.
        tauri::async_runtime::block_on(async {
            let listener = bind_listener(&path).unwrap();
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);

            // A live listener owns the file: rebinding reports the conflict.
            let err = bind_listener(&path).unwrap_err();
            assert!(err.contains("already serving"));

            // The file outliving its listener is the stale case: unlinked
            // and rebound without complaint.
            drop(listener);
            assert!(path.exists());
            let _rebound = bind_listener(&path).unwrap();
        });
    }

    /// Regression: `start` binds on Tauri's main thread during setup, where
    /// no Tokio reactor is entered — `bind_listener` must enter the app's
    /// async runtime itself or the bind panics.
    #[cfg(unix)]
    #[test]
    fn bind_works_without_a_reactor_on_the_calling_thread() {
        let dir = TempDir::new().unwrap();
        let listener = bind_listener(&dir.path().join("mcp.sock")).unwrap();
        drop(listener);
    }
}
