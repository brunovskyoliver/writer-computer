use crate::commands::fs::{drawing_format, read_file_impl, FileContent};
use crate::commands::settings::config_value_to_json;
use crate::commands::workspace::{
    build_restore_bundle, load_recent_workspaces, watch_standalone_file_impl,
    RestoreWorkspaceResponse,
};
use crate::error::AppError;
use crate::state::AppState;
use serde::Serialize;
use serde_json::Value;
use std::path::Path;
use tauri::Manager;

const RESTORE_WORKSPACE_KEY: &str = "window.restore-workspace";

#[derive(Debug, Serialize)]
pub struct StartupState {
    pub settings: Value,
    pub recent_workspaces: Vec<String>,
    /// Workspace restore payload. Populated for folder opens and session
    /// restores; `None` for standalone file opens and the welcome screen.
    pub restore_bundle: Option<RestoreWorkspaceResponse>,
    /// Optional text prefetch for a standalone Markdown note. Drawings use
    /// `standalone_path` without entering the frontend's Markdown buffers.
    /// Standalone opens start a single-file watcher and prepare no workspace.
    pub standalone_file: Option<FileContent>,
    /// Standalone source path, including drawings with no text prefetch.
    pub standalone_path: Option<String>,
}

#[tauri::command]
pub async fn get_startup_state(
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<StartupState, AppError> {
    let label = webview.label().to_string();
    let state = app.state::<AppState>().get_or_create(&label);

    let (settings, restore_enabled) = {
        let guard = state.settings.read();
        match guard.as_ref() {
            Some(s) => {
                let merged = s.merged();
                let restore_enabled = merged
                    .get(RESTORE_WORKSPACE_KEY)
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                let mut obj = serde_json::Map::new();
                for (k, v) in &merged {
                    obj.insert(k.clone(), config_value_to_json(v));
                }
                (Value::Object(obj), restore_enabled)
            }
            None => return Err(AppError::Io("Settings not initialized".into())),
        }
    };

    let recent_workspaces = load_recent_workspaces(&app).unwrap_or_default();
    let startup_open = state.take_startup_open();

    // Standalone opens prepare no workspace. Prefetch notes for the compact
    // editor; drawings retain their path and load through the drawing surface.
    // Both start the lightweight single-file watcher.
    if let Some(payload) = &startup_open {
        if payload.workspace.is_none() {
            if let Some(file) = &payload.file {
                let (standalone_path, standalone_file) = match standalone_startup_file(file) {
                    Ok(content) => (Some(file.clone()), content),
                    Err(err) => {
                        // File vanished between the open event and startup —
                        // fall through to the welcome screen.
                        eprintln!("failed to read standalone startup file {file}: {err:?}");
                        (None, None)
                    }
                };
                if standalone_path.is_some() {
                    if let Err(err) = watch_standalone_file_impl(&app, &label, file) {
                        eprintln!("failed to start standalone file watcher: {err:?}");
                    }
                }
                return Ok(StartupState {
                    settings,
                    recent_workspaces,
                    restore_bundle: None,
                    standalone_file,
                    standalone_path,
                });
            }
        }
    }

    // Pick a workspace to prefetch a bundle for so the frontend can hydrate
    // synchronously on first render — no second IPC waterfall, no welcome
    // screen flash. startup_open is set during window creation (from CLI
    // args or open_new_workspace_window) before the webview loads — same
    // lifecycle as settings. No runtime event touches it.
    let restore_target = if let Some(payload) = &startup_open {
        payload.workspace.clone()
    } else if restore_enabled {
        recent_workspaces
            .first()
            .filter(|path| Path::new(path).is_dir())
            .cloned()
    } else {
        None
    };

    let mut restore_bundle = if let Some(path) = restore_target {
        match build_restore_bundle(&app, &label, &path).await {
            Ok(bundle) => Some(bundle),
            Err(err) => {
                // Don't let a failed restore abort startup — settings still
                // need to hydrate and the welcome screen should render.
                eprintln!("failed to prefetch restore bundle for {path}: {err:?}");
                None
            }
        }
    } else {
        None
    };

    // A workspace+file payload (open_workspace_in_new_window with a file)
    // opens that file as a normal tab instead of restoring the previous
    // session — the user asked for a specific file, not their old tabs.
    if let Some(pending) = startup_open {
        if pending.workspace.is_some() {
            if let Some(ref mut bundle) = restore_bundle {
                bundle.session = crate::session::SessionRecord::Missing;
                bundle.active_file = None;
                bundle.open_file = pending.file;
            }
        }
    }

    Ok(StartupState {
        settings,
        recent_workspaces,
        restore_bundle,
        standalone_file: None,
        standalone_path: None,
    })
}

/// Drawings load through their own surface. Keep their path even
/// without prefetched prose so cold-start compact windows can open and watch them.
fn standalone_startup_file(path: &str) -> Result<Option<FileContent>, AppError> {
    if drawing_format(Path::new(path)).is_some() {
        if !Path::new(path).is_file() {
            return Err(AppError::NotFound(path.to_string()));
        }
        Ok(None)
    } else {
        read_file_impl(path).map(Some)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standalone_drawings_keep_open_access_without_text_prefetch() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["scene.excalidraw.md", "copy.EXCALIDRAW.SVG"] {
            let path = dir.path().join(name);
            // Deliberately invalid UTF-8 proves startup never reads drawing text.
            std::fs::write(&path, [0xff]).unwrap();
            assert!(standalone_startup_file(path.to_str().unwrap())
                .unwrap()
                .is_none());
        }
        let missing = dir.path().join("missing.excalidraw.md");
        assert!(standalone_startup_file(missing.to_str().unwrap()).is_err());
        let note = dir.path().join("note.md");
        std::fs::write(&note, "note").unwrap();
        assert_eq!(
            standalone_startup_file(note.to_str().unwrap())
                .unwrap()
                .unwrap()
                .content,
            "note"
        );
    }
}
