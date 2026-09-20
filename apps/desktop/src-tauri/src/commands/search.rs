use crate::error::AppError;
use crate::state::{self, AppState, IndexedFile};
use ignore::WalkBuilder;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::Manager;

#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub path: String,
    pub filename: String,
    pub relative_path: String,
    pub score: u32,
    pub match_indices: Vec<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct IndexStats {
    pub file_count: usize,
    pub duration_ms: u64,
}

/// One matched line plus up to two lines either side, for the palette's
/// context preview. `line_number` is the absolute 1-based file line for text
/// matches; for PDFs it is the line's index within the page's extracted
/// lines (display-only, built frontend-side).
#[derive(Debug, Clone, Serialize)]
pub struct ContextLine {
    pub line_number: u32,
    pub text: String,
}

/// Which location field a [`SearchMatch`] carries — `line_number` for text
/// files, `page` for PDFs. Serializes as `"text" | "pdf"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchMatchKind {
    Text,
    /// PDF `SearchMatch`es are built on the frontend (`lib/pdf-search.ts`) —
    /// the Rust walk emits `PdfCandidate`s instead, so this variant exists for
    /// wire parity and is never constructed here.
    #[allow(dead_code)]
    Pdf,
}

/// One content-search hit — the unit of the results list, the preview, and
/// activation. `match_ranges` are `[char_start, len]` pairs within
/// `line_text`, in document order and non-overlapping.
#[derive(Debug, Clone, Serialize)]
pub struct SearchMatch {
    pub path: String,
    pub relative_path: String,
    pub modified_at: u64,
    pub kind: SearchMatchKind,
    pub line_number: Option<u32>,
    pub page: Option<u32>,
    pub line_text: String,
    pub match_ranges: Vec<(u32, u32)>,
    pub context: Vec<ContextLine>,
}

/// A `.pdf` in the corpus, emitted by the walk so the frontend can extract
/// and match its page text through pdf.js (research R3 — pdf.js cannot run
/// in Rust).
#[derive(Debug, Clone, Serialize)]
pub struct PdfCandidate {
    pub path: String,
    pub modified_at: u64,
}

/// The `content_search` channel payload. Serde-tagged as
/// `{ "type": "matches" | "pdf" | "done", ... }` — see
/// `SPECs/global-content-search/contracts/content-search-ipc.md`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentSearchEvent {
    Matches { matches: Vec<SearchMatch> },
    Pdf { candidate: PdfCandidate },
    Done { truncated: bool },
}

#[tauri::command]
pub fn index_workspace(
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<IndexStats, AppError> {
    let state = app.state::<AppState>().get_or_create(webview.label());
    let (root, epoch) = state.workspace_snapshot().ok_or(AppError::NoWorkspace)?;
    let cancel = Arc::clone(&state.cancel_index.read());

    let start = std::time::Instant::now();
    let (indexed, dirs) = index_workspace_impl(&root, cancel);
    let file_count = indexed.len();
    let duration_ms = start.elapsed().as_millis() as u64;

    let displaced = state.with_workspace_snapshot(&root, epoch, || {
        let old_index = std::mem::replace(&mut *state.file_index.write(), indexed);
        let old_cache = state.recent_files_cache.write().take();
        let old_dirs = std::mem::replace(&mut *state.dirs_with_markdown.write(), dirs);
        state.file_index_revision.fetch_add(1, Ordering::SeqCst);
        state.index_ready.store(true, Ordering::Relaxed);
        (old_index, old_cache, old_dirs)
    });
    let Some(displaced) = displaced else {
        return Ok(IndexStats {
            file_count: 0,
            duration_ms,
        });
    };
    drop(displaced);

    Ok(IndexStats {
        file_count,
        duration_ms,
    })
}

#[tauri::command]
pub fn fuzzy_search(
    query: String,
    limit: Option<u32>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<Vec<SearchResult>, AppError> {
    if query.is_empty() {
        return Ok(Vec::new());
    }

    let state = app.state::<AppState>().get_or_create(webview.label());
    let limit = limit.unwrap_or(50) as usize;
    let index = state.file_index.read();
    fuzzy_search_from(&query, &index, limit)
}

pub(crate) fn fuzzy_search_from(
    query: &str,
    index: &[IndexedFile],
    limit: usize,
) -> Result<Vec<SearchResult>, AppError> {
    if query.is_empty() {
        return Ok(Vec::new());
    }

    let normalized_query = query.to_lowercase();
    let mut needles = Vec::from([normalized_query.clone()]);
    let hyphen_query = normalized_query.replace(' ', "-");
    if !needles.contains(&hyphen_query) {
        needles.push(hyphen_query);
    }
    let space_query = normalized_query.replace('-', " ");
    if !needles.contains(&space_query) {
        needles.push(space_query);
    }

    let mut results: Vec<SearchResult> = index
        .iter()
        .filter_map(|file| {
            let haystack = file.relative_path.to_lowercase();
            let (byte_start, needle) = needles
                .iter()
                .filter_map(|needle| haystack.find(needle).map(|start| (start, needle)))
                .min_by_key(|(start, _)| *start)?;

            let char_start = haystack[..byte_start].chars().count();
            let char_len = needle.chars().count();

            let filename_start_bytes = file.relative_path.rfind('/').map(|i| i + 1).unwrap_or(0);
            let in_filename = byte_start >= filename_start_bytes;

            // Higher score ranks first. Matches inside the filename beat matches
            // in a parent directory; earlier matches beat later ones; shorter
            // paths tiebreak.
            let mut score: u32 = 0;
            if in_filename {
                score += 1_000_000;
            }
            score += 10_000u32.saturating_sub(byte_start as u32);
            score +=
                1_000u32.saturating_sub((file.relative_path.chars().count() as u32).min(1_000));

            let match_indices: Vec<u32> = (char_start..char_start + char_len)
                .map(|i| i as u32)
                .collect();

            Some(SearchResult {
                path: file.path.to_string_lossy().to_string(),
                filename: file.name.clone(),
                relative_path: file.relative_path.clone(),
                score,
                match_indices,
            })
        })
        .collect();

    results.sort_by(|a, b| b.score.cmp(&a.score));
    results.truncate(limit);
    Ok(results)
}

/// Parallel file indexing using the `ignore` crate's walker.
/// Returns the indexed files and a set of directories containing markdown.
///
/// The `cancel` flag lets a concurrent workspace switch stop this walk early:
/// each walker thread checks the flag at every directory entry and returns
/// `WalkState::Quit` as soon as it's flipped. The returned results may be
/// partial in that case; callers should compare `cancel.load` or the workspace
/// epoch against expectations before acting on them.
pub fn index_workspace_impl(
    root: &Path,
    cancel: Arc<AtomicBool>,
) -> (Vec<IndexedFile>, HashSet<PathBuf>) {
    let root = root.to_path_buf();
    let results: Arc<Mutex<Vec<IndexedFile>>> = Arc::new(Mutex::new(Vec::new()));

    let threads = std::thread::available_parallelism()
        .map(|n| n.get().min(8))
        .unwrap_or(4);

    let results_ref = Arc::clone(&results);
    let root_ref = root.clone();

    WalkBuilder::new(&root)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .threads(threads)
        .build_parallel()
        .run(move || {
            let results = Arc::clone(&results_ref);
            let root = root_ref.clone();
            let cancel = Arc::clone(&cancel);
            Box::new(move |entry| {
                if cancel.load(Ordering::Relaxed) {
                    return ignore::WalkState::Quit;
                }
                let entry = match entry {
                    Ok(e) => e,
                    Err(_) => return ignore::WalkState::Continue,
                };
                // Safety net: skip node_modules even without .gitignore
                if entry.file_type().is_some_and(|ft| ft.is_dir()) {
                    if entry.file_name() == "node_modules" {
                        return ignore::WalkState::Skip;
                    }
                    return ignore::WalkState::Continue;
                }
                if entry.file_type().is_some_and(|ft| ft.is_file())
                    && crate::commands::fs::is_markdown_file(entry.path())
                {
                    let rel = entry
                        .path()
                        .strip_prefix(&root)
                        .unwrap_or(entry.path())
                        .to_string_lossy()
                        .to_string();
                    results.lock().push(IndexedFile {
                        path: entry.path().to_path_buf(),
                        relative_path: rel,
                        name: entry.file_name().to_string_lossy().to_string(),
                        modified_at: crate::commands::fs::modified_time(entry.path()),
                    });
                }
                ignore::WalkState::Continue
            })
        });

    let indexed = Arc::try_unwrap(results).unwrap().into_inner();
    let dirs = state::rebuild_dirs_from_index(&indexed, &root);
    (indexed, dirs)
}

/// Test-only convenience: run an uncancellable index.
#[cfg(test)]
fn index_workspace_test(root: &Path) -> (Vec<IndexedFile>, HashSet<PathBuf>) {
    index_workspace_impl(root, Arc::new(AtomicBool::new(false)))
}

pub fn fuzzy_search_impl(query: &str, index: &[IndexedFile], limit: usize) -> Vec<SearchResult> {
    fuzzy_search_from(query, index, limit).unwrap_or_default()
}

/// Find a file under `root` by case-insensitive basename. Used by Obsidian
/// wiki image embeds (`![[image.png]]`), which reference attachments by bare
/// filename regardless of where they live in the vault. The workspace file
/// index only covers markdown, so this walks on demand (gitignore-aware,
/// parallel) instead of maintaining a second media index plus watcher
/// plumbing; callers cache positive results.
///
/// Deterministic on duplicates: the match with the fewest path components
/// wins, ties broken lexicographically — "shortest path" like Obsidian.
pub fn find_file_by_name_impl(root: &Path, file_name: &str) -> Option<PathBuf> {
    let matches: Arc<Mutex<Vec<PathBuf>>> = Arc::new(Mutex::new(Vec::new()));
    let target = file_name.to_lowercase();

    let threads = std::thread::available_parallelism()
        .map(|n| n.get().min(8))
        .unwrap_or(4);

    let matches_ref = Arc::clone(&matches);
    WalkBuilder::new(root)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .threads(threads)
        .build_parallel()
        .run(move || {
            let matches = Arc::clone(&matches_ref);
            let target = target.clone();
            Box::new(move |entry| {
                let Ok(entry) = entry else {
                    return ignore::WalkState::Continue;
                };
                if entry.file_type().is_some_and(|ft| ft.is_dir()) {
                    if entry.file_name() == "node_modules" {
                        return ignore::WalkState::Skip;
                    }
                    return ignore::WalkState::Continue;
                }
                if entry.file_type().is_some_and(|ft| ft.is_file())
                    && entry.file_name().to_string_lossy().to_lowercase() == target
                {
                    matches.lock().push(entry.path().to_path_buf());
                }
                ignore::WalkState::Continue
            })
        });

    let mut matches = Arc::try_unwrap(matches).unwrap().into_inner();
    matches.sort_by(|a, b| {
        let depth_a = a.components().count();
        let depth_b = b.components().count();
        depth_a.cmp(&depth_b).then_with(|| a.cmp(b))
    });
    matches.into_iter().next()
}

// --- content search (SPECs/global-content-search) ---------------------------

/// Rough bounds from FR-010: ~20 matches per file, ~200 text results per scan
/// (the ~200-result *display* cap is the frontend's — PDF matches are produced
/// there — so Rust self-caps text emissions at the same number to bound IPC).
const MAX_MATCHES_PER_FILE: usize = 20;
const MAX_TOTAL_MATCHES: usize = 200;
/// Skip files larger than ~4 MiB — bounds worst-case read+decode cost on an
/// interactive scan (research R8).
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
/// Lines of context emitted either side of a match (~5 total with the match).
const CONTEXT_RADIUS: usize = 2;

/// Literal smart-case substring matching on one line (FR-011). Returns
/// `[char_start, len]` pairs in document order, non-overlapping. Char units,
/// not bytes, so the frontend can slice `line_text` safely.
fn find_match_ranges(line: &str, needle: &str, case_sensitive: bool) -> Vec<(u32, u32)> {
    let needle: Vec<char> = needle.chars().collect();
    if needle.is_empty() {
        return Vec::new();
    }
    let haystack: Vec<char> = line.chars().collect();
    if haystack.len() < needle.len() {
        return Vec::new();
    }
    let mut ranges = Vec::new();
    let mut i = 0;
    while i + needle.len() <= haystack.len() {
        let hit = (0..needle.len()).all(|j| {
            if case_sensitive {
                haystack[i + j] == needle[j]
            } else {
                haystack[i + j].to_lowercase().eq(needle[j].to_lowercase())
            }
        });
        if hit {
            ranges.push((i as u32, needle.len() as u32));
            i += needle.len();
        } else {
            i += 1;
        }
    }
    ranges
}

/// The matched line plus up to `CONTEXT_RADIUS` lines either side. Fewer near
/// file boundaries — never an error (spec edge case).
fn context_around(lines: &[&str], index: usize) -> Vec<ContextLine> {
    let start = index.saturating_sub(CONTEXT_RADIUS);
    let end = (index + CONTEXT_RADIUS + 1).min(lines.len());
    (start..end)
        .map(|i| ContextLine {
            line_number: (i + 1) as u32,
            text: lines[i].to_string(),
        })
        .collect()
}

/// `.pdf` suffix, case-insensitive, on a filename with a real stem — the same
/// predicate as `isPdfPath` in `lib/pdf.ts` (a file named exactly `.pdf` has
/// no stem and is not a document).
fn is_pdf_path(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    name.len() > crate::commands::fs::PDF_EXTENSION.len()
        && name
            .to_lowercase()
            .ends_with(crate::commands::fs::PDF_EXTENSION)
}

/// The workspace scan behind `content_search`. Walks `root` with the exact
/// filters `index_workspace_impl` uses and streams results through `emit`:
/// a `matches` batch per matching text file (≤ `MAX_MATCHES_PER_FILE`),
/// a `pdf` event per `.pdf` file, and a terminal `done` when the walk
/// finishes. A cancelled walk emits nothing further — the frontend's seq
/// guard has already superseded it.
///
/// Synchronous on purpose: callers run it inside `spawn_blocking`, and tests
/// drive it directly on a tempdir with a Vec collector.
pub(crate) fn content_search_impl(
    root: &Path,
    query: &str,
    cancel: Arc<AtomicBool>,
    emit: &(dyn Fn(ContentSearchEvent) + Sync),
) {
    let case_sensitive = query.chars().any(|c| c.is_uppercase());
    let total_emitted = std::sync::atomic::AtomicUsize::new(0);
    let truncated = AtomicBool::new(false);

    let threads = std::thread::available_parallelism()
        .map(|n| n.get().min(8))
        .unwrap_or(4);

    let root_ref = root.to_path_buf();
    let emit_ref = emit;
    let total_ref = &total_emitted;
    let truncated_ref = &truncated;
    let cancel_walk = Arc::clone(&cancel);
    let query_ref = query;

    WalkBuilder::new(root)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .threads(threads)
        .build_parallel()
        .run(move || {
            let root = root_ref.clone();
            let cancel = Arc::clone(&cancel_walk);
            Box::new(move |entry| {
                if cancel.load(Ordering::Relaxed) {
                    return ignore::WalkState::Quit;
                }
                let entry = match entry {
                    Ok(e) => e,
                    Err(_) => return ignore::WalkState::Continue,
                };
                if entry.file_type().is_some_and(|ft| ft.is_dir()) {
                    // Safety net: skip node_modules even without .gitignore.
                    if entry.file_name() == "node_modules" {
                        return ignore::WalkState::Skip;
                    }
                    return ignore::WalkState::Continue;
                }
                if !entry.file_type().is_some_and(|ft| ft.is_file()) {
                    return ignore::WalkState::Continue;
                }
                let path = entry.path();
                if is_pdf_path(path) {
                    // PDFs enumerate only — extraction is the frontend's job.
                    // Candidates keep arriving after the text cap; they carry
                    // no truncation implication of their own.
                    emit_ref(ContentSearchEvent::Pdf {
                        candidate: PdfCandidate {
                            path: path.to_string_lossy().to_string(),
                            modified_at: crate::commands::fs::modified_time(path),
                        },
                    });
                    return ignore::WalkState::Continue;
                }
                // The text cap has engaged: no more text matches can display,
                // but the walk continues so PDF candidates still enumerate.
                if total_ref.load(Ordering::Relaxed) >= MAX_TOTAL_MATCHES {
                    return ignore::WalkState::Continue;
                }
                let Some(metadata) = entry.metadata().ok() else {
                    return ignore::WalkState::Continue;
                };
                if metadata.len() > MAX_FILE_BYTES {
                    return ignore::WalkState::Continue;
                }
                let Ok(bytes) = std::fs::read(path) else {
                    return ignore::WalkState::Continue;
                };
                let Ok(text) = std::str::from_utf8(&bytes) else {
                    return ignore::WalkState::Continue;
                };

                let lines: Vec<&str> = text.lines().collect();
                let rel = path
                    .strip_prefix(&root)
                    .unwrap_or(path)
                    .to_string_lossy()
                    .to_string();
                let path_str = path.to_string_lossy().to_string();
                let mut batch: Vec<SearchMatch> = Vec::new();
                for (index, line) in lines.iter().enumerate() {
                    if batch.len() >= MAX_MATCHES_PER_FILE {
                        truncated_ref.store(true, Ordering::Relaxed);
                        break;
                    }
                    let ranges = find_match_ranges(line, query_ref, case_sensitive);
                    if ranges.is_empty() {
                        continue;
                    }
                    batch.push(SearchMatch {
                        path: path_str.clone(),
                        relative_path: rel.clone(),
                        modified_at: metadata
                            .modified()
                            .ok()
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_secs())
                            .unwrap_or_else(|| crate::commands::fs::modified_time(path)),
                        kind: SearchMatchKind::Text,
                        line_number: Some((index + 1) as u32),
                        page: None,
                        line_text: (*line).to_string(),
                        match_ranges: ranges,
                        context: context_around(&lines, index),
                    });
                }

                if !batch.is_empty() {
                    let prev = total_ref.fetch_add(batch.len(), Ordering::SeqCst);
                    if prev >= MAX_TOTAL_MATCHES {
                        truncated_ref.store(true, Ordering::Relaxed);
                    } else {
                        let allowed = MAX_TOTAL_MATCHES - prev;
                        if batch.len() > allowed {
                            batch.truncate(allowed);
                            truncated_ref.store(true, Ordering::Relaxed);
                        }
                        emit_ref(ContentSearchEvent::Matches { matches: batch });
                    }
                }
                ignore::WalkState::Continue
            })
        });

    // Cancellation is not an error: a cancelled scan sends no `done`.
    if !cancel.load(Ordering::Relaxed) {
        emit(ContentSearchEvent::Done {
            truncated: truncated.load(Ordering::Relaxed),
        });
    }
}

#[tauri::command]
pub async fn content_search(
    query: String,
    on_event: tauri::ipc::Channel<ContentSearchEvent>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    if query.is_empty() {
        return Err(AppError::InvalidPath("empty search query".to_string()));
    }
    let state = app.state::<AppState>().get_or_create(webview.label());
    let (root, _epoch) = state.workspace_snapshot().ok_or(AppError::NoWorkspace)?;

    // One active scan per window: flip the outgoing flag so a superseded walk
    // exits at the next directory entry, then install a fresh one for this
    // scan (the `cancel_index` discipline — `Channel::send` does not reliably
    // fail when JS stops listening, so the flag is the cancellation path).
    let cancel = {
        let mut slot = state.cancel_search.write();
        slot.store(true, Ordering::SeqCst);
        let fresh = Arc::new(AtomicBool::new(false));
        *slot = Arc::clone(&fresh);
        fresh
    };

    tauri::async_runtime::spawn_blocking(move || {
        content_search_impl(&root, &query, cancel, &|event| {
            let _ = on_event.send(event);
        });
    })
    .await
    .map_err(|e| AppError::Io(e.to_string()))?;

    Ok(())
}

#[tauri::command]
pub async fn find_file_by_name(
    root: String,
    file_name: String,
) -> Result<Option<String>, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(find_file_by_name_impl(Path::new(&root), &file_name)
            .map(|path| path.to_string_lossy().to_string()))
    })
    .await
    .map_err(|e| AppError::Io(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn setup_workspace() -> TempDir {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("readme.md"), "# Readme").unwrap();
        fs::write(dir.path().join("notes.md"), "# Notes").unwrap();
        fs::write(dir.path().join("data.txt"), "not indexed").unwrap();
        fs::create_dir(dir.path().join("docs")).unwrap();
        fs::write(dir.path().join("docs").join("guide.md"), "# Guide").unwrap();
        // Hidden directory should be ignored
        fs::create_dir(dir.path().join(".git")).unwrap();
        fs::write(dir.path().join(".git").join("config.md"), "git").unwrap();
        dir
    }

    #[test]
    fn test_index_workspace_counts_md_files() {
        let dir = setup_workspace();
        let (index, _dirs) = index_workspace_test(dir.path());
        assert_eq!(index.len(), 3); // readme.md, notes.md, docs/guide.md
    }

    #[test]
    fn test_index_workspace_ignores_hidden() {
        let dir = setup_workspace();
        let (index, _dirs) = index_workspace_test(dir.path());
        // Should not include .git/config.md
        assert!(!index.iter().any(|f| f.relative_path.contains(".git")));
    }

    #[test]
    fn test_index_workspace_builds_dirs_with_markdown() {
        let dir = setup_workspace();
        let root = dir.path().to_path_buf();
        let (_index, dirs) = index_workspace_test(dir.path());
        // The root and docs/ should be in the set
        assert!(dirs.contains(&root));
        assert!(dirs.contains(&root.join("docs")));
        // .git should not be in the set
        assert!(!dirs.contains(&root.join(".git")));
    }

    #[test]
    fn test_cancel_flag_short_circuits_walk() {
        // Pre-cancelled walker should return before visiting any file.
        let dir = setup_workspace();
        let cancel = Arc::new(AtomicBool::new(true));
        let (index, dirs) = index_workspace_impl(dir.path(), cancel);
        assert!(index.is_empty());
        assert!(dirs.is_empty());
    }

    #[test]
    fn test_live_cancel_token_survives_after_swap() {
        // Mirror the workspace-switch contract: when the outgoing cancel flag
        // is flipped, any walker still holding a clone of the old Arc sees
        // the cancellation even after a fresh Arc replaces the state slot.
        let live = Arc::new(AtomicBool::new(false));
        let walker_view = Arc::clone(&live);
        live.store(true, Ordering::Relaxed);
        let _fresh = Arc::new(AtomicBool::new(false));
        assert!(walker_view.load(Ordering::Relaxed));
    }

    #[test]
    fn test_fuzzy_search_ranks_by_relevance() {
        let dir = setup_workspace();
        let (index, _dirs) = index_workspace_test(dir.path());
        let results = fuzzy_search_impl("readme", &index, 50);
        assert!(!results.is_empty());
        assert_eq!(results[0].filename, "readme.md");
    }

    #[test]
    fn test_fuzzy_search_matches_space_separated_names() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("No prior experience.md"), "# Note").unwrap();
        let (index, _dirs) = index_workspace_test(dir.path());

        let results = fuzzy_search_impl("No prior experience", &index, 50);

        assert!(!results.is_empty());
        assert_eq!(results[0].filename, "No prior experience.md");
    }

    #[test]
    fn test_fuzzy_search_returns_match_indices() {
        let dir = setup_workspace();
        let (index, _dirs) = index_workspace_test(dir.path());
        let results = fuzzy_search_impl("guide", &index, 50);
        assert!(!results.is_empty());
        assert!(!results[0].match_indices.is_empty());
    }

    #[test]
    fn test_fuzzy_search_empty_query() {
        let dir = setup_workspace();
        let (index, _dirs) = index_workspace_test(dir.path());
        let results = fuzzy_search_impl("", &index, 50);
        assert!(results.is_empty());
    }

    #[test]
    fn test_fuzzy_search_respects_limit() {
        let dir = setup_workspace();
        let (index, _dirs) = index_workspace_test(dir.path());
        let results = fuzzy_search_impl("md", &index, 1);
        assert!(results.len() <= 1);
    }

    #[test]
    fn test_find_file_by_name_case_insensitive() {
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join("assets")).unwrap();
        fs::write(dir.path().join("assets").join("Diagram.PNG"), [0u8]).unwrap();

        let found = find_file_by_name_impl(dir.path(), "diagram.png").unwrap();
        assert_eq!(found, dir.path().join("assets").join("Diagram.PNG"));
    }

    #[test]
    fn test_find_file_by_name_prefers_shortest_path() {
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(dir.path().join("a").join("b")).unwrap();
        fs::write(dir.path().join("a").join("b").join("pic.png"), [0u8]).unwrap();
        fs::write(dir.path().join("pic.png"), [0u8]).unwrap();

        let found = find_file_by_name_impl(dir.path(), "pic.png").unwrap();
        assert_eq!(found, dir.path().join("pic.png"));
    }

    // --- content search: matcher (T006) ------------------------------------

    #[test]
    fn test_line_match_case_insensitive_by_default() {
        let ranges = find_match_ranges("The Ferry departs at dawn", "ferry", false);
        assert_eq!(ranges, vec![(4, 5)]);
    }

    #[test]
    fn test_line_match_uppercase_query_is_case_sensitive() {
        assert!(find_match_ranges("The Ferry departs", "ferry", true).is_empty());
        assert_eq!(
            find_match_ranges("The Ferry departs", "Ferry", true),
            vec![(4, 5)]
        );
    }

    #[test]
    fn test_line_match_multiple_ranges_in_order_non_overlapping() {
        let ranges = find_match_ranges("foo bar foofoo", "foo", false);
        assert_eq!(ranges, vec![(0, 3), (8, 3), (11, 3)]);
        for pair in ranges.windows(2) {
            assert!(pair[0].0 + pair[0].1 <= pair[1].0);
        }
    }

    #[test]
    fn test_line_match_offsets_are_char_units() {
        // 'é' is two UTF-8 bytes but one char — a byte offset would report 7.
        let ranges = find_match_ranges("héllo ferry", "ferry", false);
        assert_eq!(ranges, vec![(6, 5)]);
    }

    #[test]
    fn test_context_around_clamps_at_boundaries() {
        let lines = vec!["one", "two", "three"];
        let ctx = context_around(&lines, 0);
        assert_eq!(ctx.len(), 3);
        assert_eq!(ctx[0].line_number, 1);
        let ctx = context_around(&lines, 2);
        assert_eq!(ctx.len(), 3);
        assert_eq!(ctx[2].line_number, 3);
    }

    // --- content search: walk, caps, cancellation (T007) -------------------

    fn search_events(root: &Path, query: &str) -> Vec<ContentSearchEvent> {
        let events = Mutex::new(Vec::new());
        content_search_impl(root, query, Arc::new(AtomicBool::new(false)), &|event| {
            events.lock().push(event)
        });
        events.into_inner()
    }

    fn text_matches(events: &[ContentSearchEvent]) -> Vec<&SearchMatch> {
        events
            .iter()
            .flat_map(|event| match event {
                ContentSearchEvent::Matches { matches } => matches.iter(),
                _ => [].iter(),
            })
            .collect()
    }

    fn done_event(events: &[ContentSearchEvent]) -> Option<&ContentSearchEvent> {
        events
            .iter()
            .find(|event| matches!(event, ContentSearchEvent::Done { .. }))
    }

    #[test]
    fn test_content_search_matches_text_files() {
        let dir = TempDir::new().unwrap();
        fs::write(
            dir.path().join("notes.md"),
            "the ferry departs\nnothing else\n",
        )
        .unwrap();
        fs::write(dir.path().join("plain.txt"), "also a ferry\n").unwrap();
        // A filename match alone must not produce a result (FR-013).
        fs::write(dir.path().join("ferry.md"), "no hits here\n").unwrap();

        let events = search_events(dir.path(), "ferry");
        let matches = text_matches(&events);
        assert_eq!(matches.len(), 2);
        assert!(matches.iter().all(|m| m.kind == SearchMatchKind::Text));
        assert!(matches.iter().all(|m| m.line_number.is_some()));
        assert!(matches.iter().all(|m| m.page.is_none()));
        assert!(matches!(
            done_event(&events),
            Some(ContentSearchEvent::Done { truncated: false })
        ));
    }

    #[test]
    fn test_content_search_skips_ignored_hidden_and_node_modules() {
        let dir = TempDir::new().unwrap();
        // `ignore` only honours .gitignore inside a repository.
        fs::create_dir(dir.path().join(".git")).unwrap();
        fs::write(dir.path().join(".gitignore"), "ignored.md\n").unwrap();
        fs::write(dir.path().join("ignored.md"), "ferry\n").unwrap();
        fs::write(dir.path().join(".hidden.md"), "ferry\n").unwrap();
        fs::create_dir_all(dir.path().join("node_modules").join("pkg")).unwrap();
        fs::write(
            dir.path().join("node_modules").join("pkg").join("x.md"),
            "ferry\n",
        )
        .unwrap();
        fs::write(dir.path().join("visible.md"), "ferry\n").unwrap();

        let events = search_events(dir.path(), "ferry");
        let matches = text_matches(&events);
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].relative_path, "visible.md");
    }

    #[test]
    fn test_content_search_emits_pdf_candidates_not_text_matches() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("report.pdf"), b"ferry inside bytes").unwrap();

        let events = search_events(dir.path(), "ferry");
        assert!(text_matches(&events).is_empty());
        let candidates: Vec<&PdfCandidate> = events
            .iter()
            .filter_map(|event| match event {
                ContentSearchEvent::Pdf { candidate } => Some(candidate),
                _ => None,
            })
            .collect();
        assert_eq!(candidates.len(), 1);
        assert!(candidates[0].path.ends_with("report.pdf"));
    }

    #[test]
    fn test_content_search_skips_oversized_and_binary_files() {
        let dir = TempDir::new().unwrap();
        // > ~4 MiB: skipped before the read.
        let mut big = "a".repeat(4 * 1024 * 1024 + 64);
        big.push_str("ferry");
        fs::write(dir.path().join("big.txt"), big).unwrap();
        // Invalid UTF-8: fails the strict decode.
        fs::write(dir.path().join("binary.bin"), [0xFFu8, 0xFE, 0x00, 0xF0]).unwrap();
        fs::write(dir.path().join("ok.txt"), "ferry\n").unwrap();

        let events = search_events(dir.path(), "ferry");
        let matches = text_matches(&events);
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].relative_path, "ok.txt");
    }

    #[test]
    fn test_content_search_per_file_cap_marks_truncated() {
        let dir = TempDir::new().unwrap();
        let body = (0..30)
            .map(|i| format!("ferry line {i}\n"))
            .collect::<String>();
        fs::write(dir.path().join("many.md"), body).unwrap();

        let events = search_events(dir.path(), "ferry");
        let matches = text_matches(&events);
        assert_eq!(matches.len(), 20);
        // Matches stay in document order within the file.
        let lines: Vec<u32> = matches.iter().filter_map(|m| m.line_number).collect();
        assert!(lines.windows(2).all(|w| w[0] < w[1]));
        assert_eq!(lines.first(), Some(&1));
        assert!(matches!(
            done_event(&events),
            Some(ContentSearchEvent::Done { truncated: true })
        ));
    }

    #[test]
    fn test_content_search_total_cap_marks_truncated() {
        let dir = TempDir::new().unwrap();
        for i in 0..12 {
            let body = (0..20)
                .map(|j| format!("ferry {i} {j}\n"))
                .collect::<String>();
            fs::write(dir.path().join(format!("f{i:02}.md")), body).unwrap();
        }

        let events = search_events(dir.path(), "ferry");
        let matches = text_matches(&events);
        assert!(matches.len() <= 200);
        assert!(matches!(
            done_event(&events),
            Some(ContentSearchEvent::Done { truncated: true })
        ));
    }

    #[test]
    fn test_content_search_cancelled_walk_sends_no_done() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("notes.md"), "ferry\n").unwrap();

        let events = Mutex::new(Vec::new());
        content_search_impl(
            dir.path(),
            "ferry",
            Arc::new(AtomicBool::new(true)),
            &|event| events.lock().push(event),
        );
        let events = events.into_inner();
        assert!(text_matches(&events).is_empty());
        assert!(done_event(&events).is_none());
    }

    #[test]
    fn test_find_file_by_name_missing_and_hidden() {
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();
        fs::write(dir.path().join(".git").join("hidden.png"), [0u8]).unwrap();

        assert!(find_file_by_name_impl(dir.path(), "nope.png").is_none());
        assert!(find_file_by_name_impl(dir.path(), "hidden.png").is_none());
    }
}
