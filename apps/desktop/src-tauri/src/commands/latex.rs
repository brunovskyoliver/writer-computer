//! The global LaTeX snippet file.
//!
//! One plain-text file (`<app_data_dir>/latex-snippets.js`) in the Obsidian
//! Latex Suite object-list syntax, owned by the user. The app writes it only
//! twice: when it is missing, and when the user asks for the defaults back.
//! The frontend parses it (never evaluates it) — see
//! `src/lib/latex-snippets/parse-snippet-file.ts`.

use crate::error::AppError;
use std::io;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// The shipped default set. Same asset the frontend reads, so there is one
/// source for the defaults (docs/consolidation.md).
const DEFAULT_SNIPPETS: &str = include_str!("../../../shared/latex-snippets.default.js");

const SNIPPET_FILE_NAME: &str = "latex-snippets.js";

/// Create the snippet file from the defaults when it is missing. An existing
/// file is never touched — the user's edits outlive every upgrade.
fn ensure_snippets_file(dir: &Path) -> io::Result<PathBuf> {
    let path = dir.join(SNIPPET_FILE_NAME);
    if path.exists() {
        return Ok(path);
    }
    std::fs::create_dir_all(dir)?;
    write_atomically(&path, DEFAULT_SNIPPETS)?;
    Ok(path)
}

/// Overwrite the snippet file with the shipped defaults. The confirmation
/// prompt is the frontend's job (FR-016).
fn reset_snippets_file(dir: &Path) -> io::Result<PathBuf> {
    let path = dir.join(SNIPPET_FILE_NAME);
    std::fs::create_dir_all(dir)?;
    write_atomically(&path, DEFAULT_SNIPPETS)?;
    Ok(path)
}

/// Temp file + rename, like the session and telemetry-identity writes: a crash
/// mid-write can never leave a half-written snippet file behind.
fn write_atomically(path: &Path, contents: &str) -> io::Result<()> {
    let temp_path = path.with_extension("js.tmp");
    let written =
        std::fs::write(&temp_path, contents).and_then(|()| std::fs::rename(&temp_path, path));
    if written.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }
    written
}

fn snippets_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .app_data_dir()
        .map_err(|error| AppError::Io(error.to_string()))
}

#[tauri::command]
pub fn latex_snippets_path(app: AppHandle) -> Result<String, AppError> {
    let path = ensure_snippets_file(&snippets_dir(&app)?)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn reset_latex_snippets(app: AppHandle) -> Result<String, AppError> {
    let path = reset_snippets_file(&snippets_dir(&app)?)?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_creates_the_file_with_the_shipped_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = ensure_snippets_file(dir.path()).unwrap();

        assert_eq!(path, dir.path().join(SNIPPET_FILE_NAME));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), DEFAULT_SNIPPETS);
    }

    #[test]
    fn ensure_creates_missing_parent_directories() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("deeper");
        let path = ensure_snippets_file(&nested).unwrap();

        assert!(path.exists());
    }

    #[test]
    fn ensure_leaves_a_modified_file_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let path = ensure_snippets_file(dir.path()).unwrap();
        std::fs::write(&path, "[]").unwrap();

        ensure_snippets_file(dir.path()).unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "[]");
    }

    #[test]
    fn reset_restores_the_shipped_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = ensure_snippets_file(dir.path()).unwrap();
        std::fs::write(&path, "[]").unwrap();

        let reset_path = reset_snippets_file(dir.path()).unwrap();

        assert_eq!(reset_path, path);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), DEFAULT_SNIPPETS);
    }

    #[test]
    fn reset_creates_the_file_when_it_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let path = reset_snippets_file(dir.path()).unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), DEFAULT_SNIPPETS);
    }
}
