use crate::error::AppError;
use crate::state::{self, AppState, IndexedFile};
use ignore::WalkBuilder;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
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
    /// Built here for PDFs whose text the frontend already saved
    /// (`save_pdf_text`), and by `lib/pdf-search.ts` for the rest.
    Pdf,
}

/// One content-search hit — the unit of the results list, the preview, and
/// activation. `match_ranges` are `[char_start, len]` pairs within
/// `line_text`, in document order and non-overlapping. `clip_start` is where
/// `line_text` begins in the file's line, so `clip_start + char_start` is the
/// column; only text matches are clipped (see [`clip_line`]).
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
    pub clip_start: u32,
    pub context: Vec<ContextLine>,
}

/// A `.pdf` in the corpus with no saved text, emitted by the walk so the
/// frontend can extract and match its page text through pdf.js (research R3 —
/// pdf.js cannot run in Rust) and then save it for the next scan.
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
        let old_dirs = std::mem::replace(&mut *state.dirs_with_files.write(), dirs);
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

    // A rebuilt file index is the AI worker's ground truth — rescan.
    if let Some(sender) = crate::ai::kick(&app, &state) {
        let _ = sender.send(crate::ai::AiJob::ScanAll);
    }

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

/// A fresh walk rather than the file index: callers rewrite links straight after
/// a move, before the watcher has caught the index up.
#[tauri::command]
pub async fn list_workspace_notes(
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<Vec<String>, AppError> {
    let state = app.state::<AppState>().get_or_create(webview.label());
    let (root, _) = state.workspace_snapshot().ok_or(AppError::NoWorkspace)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (files, _) = index_workspace_impl(&root, Arc::new(AtomicBool::new(false)));
        files
            .into_iter()
            .filter(|file| {
                file.path.extension().is_some_and(|extension| {
                    extension.eq_ignore_ascii_case("md")
                        || extension.eq_ignore_ascii_case("markdown")
                })
            })
            .map(|file| file.path.to_string_lossy().to_string())
            .collect()
    })
    .await
    .map_err(|e| AppError::Io(e.to_string()))
}

/// Exact-substring hits always outrank subsequence hits: a contiguous match
/// in a directory name is a stronger signal than a scattered match inside a
/// filename. Fuzzy scores are clamped below this base so the two tiers can
/// never interleave.
const EXACT_SCORE_BASE: u32 = 1_000_000;
const FUZZY_SCORE_CAP: u32 = EXACT_SCORE_BASE - 1;
/// Filename bonus inside the fuzzy tier — large enough to dominate the
/// per-char bonuses so a filename hit always beats a path-segment hit.
const FUZZY_FILENAME_BONUS: u32 = 400_000;

// Subsequence matcher weights. Boundary hits (path start, after a
// separator, camelCase hump) and consecutive runs earn bonuses; gaps and a
// leading run of unmatched chars cost points.
const FUZZY_CHAR_SCORE: i64 = 8;
const FUZZY_CONSECUTIVE_BONUS: i64 = 16;
const FUZZY_BOUNDARY_BONUS: i64 = 24;
const FUZZY_GAP_PENALTY: i64 = 1;
const FUZZY_LEAD_PENALTY: i64 = 2;

/// Greedy leftmost subsequence match of `needle` against `hay` (both
/// lowercased, char-wise). Returns the matched char indices plus a raw
/// score. Greedy matching is O(n) and predictable — the scorer rewards the
/// properties (boundaries, runs, tight span) that make a fuzzy hit feel
/// right rather than searching for the optimal alignment.
fn subsequence_score(
    needle: &[char],
    hay: &[char],
    boundaries: &[bool],
) -> Option<(i64, Vec<u32>)> {
    if needle.is_empty() || needle.len() > hay.len() {
        return None;
    }
    let mut indices: Vec<u32> = Vec::with_capacity(needle.len());
    let mut score: i64 = 0;
    let mut n = 0;
    for (i, &c) in hay.iter().enumerate() {
        if n == needle.len() {
            break;
        }
        if c != needle[n] {
            continue;
        }
        if let Some(&prev) = indices.last() {
            score -= FUZZY_GAP_PENALTY * (i as i64 - prev as i64 - 1);
            if i as u32 == prev + 1 {
                score += FUZZY_CONSECUTIVE_BONUS;
            }
        } else {
            score -= FUZZY_LEAD_PENALTY * i as i64;
        }
        if boundaries[i] {
            score += FUZZY_BOUNDARY_BONUS;
        }
        score += FUZZY_CHAR_SCORE;
        indices.push(i as u32);
        n += 1;
    }
    (n == needle.len()).then_some((score.max(0), indices))
}

/// Queries at least this long forgive one typo (fsearch's rule: short
/// queries stay strict, or every 3-letter typo matches half the vault).
const TYPO_MIN_CHARS: usize = 5;
/// What a forgiven typo costs — one well-placed char's worth, so a typo hit
/// in the filename still beats a scattered hit across parent folders.
const TYPO_PENALTY: i64 = FUZZY_CHAR_SCORE + FUZZY_CONSECUTIVE_BONUS + FUZZY_BOUNDARY_BONUS;

/// One-typo fallback for a needle that is not a subsequence: retry with each
/// single char dropped. Dropping covers a stray, a wrong, or a swapped char
/// (`mian` → `man` ⊂ `main`); a missing char already passes the subsequence
/// test. Best surviving variant wins, minus `TYPO_PENALTY`.
fn typo_score(needles: &[Vec<char>], hay: &[char], boundaries: &[bool]) -> Option<(i64, Vec<u32>)> {
    needles
        .iter()
        .filter(|needle| needle.len() >= TYPO_MIN_CHARS)
        .flat_map(|needle| {
            (0..needle.len()).filter_map(move |skip| {
                let shorter: Vec<char> = needle
                    .iter()
                    .enumerate()
                    .filter_map(|(i, &c)| (i != skip).then_some(c))
                    .collect();
                subsequence_score(&shorter, hay, boundaries)
            })
        })
        .max_by_key(|(score, _)| *score)
        .map(|(score, indices)| ((score - TYPO_PENALTY).max(0), indices))
}

/// Per-position boundary flags over `path`, aligned to the chars of its
/// lowercase form: a position is a boundary at the start, after a
/// separator, or at a camelCase hump. Built alongside the lowercase chars
/// so multi-char lowercase expansions keep the two arrays the same length.
fn lowercase_with_boundaries(path: &str) -> (Vec<char>, Vec<bool>) {
    let mut chars = Vec::with_capacity(path.len());
    let mut boundaries = Vec::with_capacity(path.len());
    let mut prev: Option<char> = None;
    for (i, c) in path.chars().enumerate() {
        let boundary = i == 0
            || prev.is_some_and(|p| matches!(p, '/' | '-' | '_' | ' ' | '.'))
            || (prev.is_some_and(|p| p.is_lowercase()) && c.is_uppercase());
        for lc in c.to_lowercase() {
            chars.push(lc);
            boundaries.push(boundary);
        }
        prev = Some(c);
    }
    (chars, boundaries)
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
    let needle_chars: Vec<Vec<char>> = needles.iter().map(|n| n.chars().collect()).collect();

    let mut results: Vec<SearchResult> = index
        .iter()
        .filter_map(|file| {
            let haystack = file.relative_path.to_lowercase();
            let path_chars = file.relative_path.chars().count() as u32;
            let filename_start_bytes = file.relative_path.rfind('/').map(|i| i + 1).unwrap_or(0);
            let filename_start_chars =
                file.relative_path[..filename_start_bytes].chars().count() as u32;

            // Exact substring first — the strongest tier.
            let exact = needles
                .iter()
                .filter_map(|needle| haystack.find(needle).map(|start| (start, needle)))
                .min_by_key(|(start, _)| *start);

            let (score, match_indices) = match exact {
                Some((byte_start, needle)) => {
                    let char_start = haystack[..byte_start].chars().count();
                    let char_len = needle.chars().count();

                    // Matches inside the filename beat matches in a parent
                    // directory; earlier matches beat later ones; shorter
                    // paths tiebreak.
                    let mut score = EXACT_SCORE_BASE;
                    if byte_start >= filename_start_bytes {
                        score += FUZZY_FILENAME_BONUS;
                    }
                    score += 10_000u32.saturating_sub(byte_start as u32);
                    score += 1_000u32.saturating_sub(path_chars.min(1_000));

                    let indices: Vec<u32> = (char_start..char_start + char_len)
                        .map(|i| i as u32)
                        .collect();
                    (score, indices)
                }
                None => {
                    // Fuzzy tier: every query char must appear in order.
                    let (hay_chars, boundaries) = lowercase_with_boundaries(&file.relative_path);
                    let (raw, indices) = needle_chars
                        .iter()
                        .filter_map(|needle| subsequence_score(needle, &hay_chars, &boundaries))
                        .max_by_key(|(score, _)| *score)
                        .or_else(|| typo_score(&needle_chars, &hay_chars, &boundaries))?;
                    let mut score = raw as u32;
                    if indices.first().is_some_and(|&i| i >= filename_start_chars) {
                        score += FUZZY_FILENAME_BONUS;
                    }
                    score += 1_000u32.saturating_sub(path_chars.min(1_000));
                    (score.min(FUZZY_SCORE_CAP), indices)
                }
            };

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
/// Returns the indexed files and a set of directories containing them.
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
                    && crate::commands::fs::is_sidebar_file(entry.path())
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

/// Test-only convenience: search without the `AppError` envelope.
#[cfg(test)]
fn fuzzy_search_impl(query: &str, index: &[IndexedFile], limit: usize) -> Vec<SearchResult> {
    fuzzy_search_from(query, index, limit).unwrap_or_default()
}

/// Find a file under `root` by case-insensitive basename. Used by Obsidian
/// wiki image embeds (`![[image.png]]`), which reference attachments by bare
/// filename regardless of where they live in the vault. The workspace file
/// index only covers sidebar-visible files, so this walks on demand
/// (gitignore-aware, parallel) instead of maintaining a second media index
/// plus watcher plumbing; callers cache positive results.
///
/// Deterministic on duplicates: the match with the fewest path components
/// wins, ties broken lexicographically — "shortest path" like Obsidian.
#[cfg(test)]
fn find_file_by_name_impl(root: &Path, file_name: &str) -> Option<PathBuf> {
    find_file_by_name_checked(root, file_name, false).unwrap()
}

/// Drawing basenames require uniqueness across the complete walk. In that mode
/// an unreadable subtree is an error because uniqueness cannot be established.
fn find_file_by_name_checked(
    root: &Path,
    file_name: &str,
    require_unique: bool,
) -> Result<Option<PathBuf>, AppError> {
    let matches: Arc<Mutex<Vec<PathBuf>>> = Arc::new(Mutex::new(Vec::new()));
    let target = file_name.to_lowercase();
    let walk_error = Arc::new(Mutex::new(None::<String>));
    let walk_error_ref = Arc::clone(&walk_error);

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
            let walk_error = Arc::clone(&walk_error_ref);
            Box::new(move |entry| {
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(error) => {
                        if require_unique {
                            *walk_error.lock() = Some(error.to_string());
                        }
                        return ignore::WalkState::Continue;
                    }
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

    if let Some(error) = walk_error.lock().take() {
        return Err(AppError::Io(format!(
            "Could not resolve drawing basename: {error}"
        )));
    }
    let mut matches = Arc::try_unwrap(matches).unwrap().into_inner();
    if require_unique && matches.len() > 1 {
        return Err(AppError::InvalidPath(format!(
            "Ambiguous drawing basename '{file_name}'; use a relative path"
        )));
    }
    matches.sort_by(|a, b| {
        let depth_a = a.components().count();
        let depth_b = b.components().count();
        depth_a.cmp(&depth_b).then_with(|| a.cmp(b))
    });
    Ok(matches.into_iter().next())
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
/// Longest line sent to the palette, in chars. Minified files (Excalidraw SVG
/// exports) put hundreds of thousands of chars on one line, and the palette
/// renders one DOM node per char of a matched line.
const MAX_LINE_CHARS: usize = 400;
/// Chars kept before the first match when a long line is clipped.
const CLIP_LEAD_CHARS: usize = 40;

/// Literal smart-case substring matching on one line (FR-011). Returns
/// `[char_start, len]` pairs in document order, non-overlapping. Char units,
/// not bytes, so the frontend can slice `line_text` safely. The needle
/// arrives pre-split — the caller scans every line of every file with the
/// same query, so its char vec is built once per scan, not once per line.
fn find_match_ranges_chars(line: &str, needle: &[char], case_sensitive: bool) -> Vec<(u32, u32)> {
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

/// `&str` convenience for tests — the scan loop calls
/// `find_match_ranges_chars` with the needle already split.
#[cfg(test)]
fn find_match_ranges(line: &str, needle: &str, case_sensitive: bool) -> Vec<(u32, u32)> {
    let needle: Vec<char> = needle.chars().collect();
    find_match_ranges_chars(line, &needle, case_sensitive)
}

/// A window of a long line around its first match: the clipped text, the
/// ranges inside it re-based to the window, and the window's start in `line`.
/// Short lines pass through untouched.
fn clip_line(line: &str, ranges: Vec<(u32, u32)>) -> (String, Vec<(u32, u32)>, u32) {
    if line.chars().nth(MAX_LINE_CHARS).is_none() {
        return (line.to_string(), ranges, 0);
    }
    let (first_start, first_len) = ranges.first().copied().unwrap_or((0, 0));
    let start = (first_start as usize).saturating_sub(CLIP_LEAD_CHARS);
    // A query longer than the window still gets its whole first match.
    let window = MAX_LINE_CHARS.max(first_start as usize - start + first_len as usize);
    let end = (start + window) as u32;
    let clip_start = start as u32;
    let text = line.chars().skip(start).take(window).collect();
    let ranges = ranges
        .into_iter()
        .filter(|&(at, len)| at + len <= end)
        .map(|(at, len)| (at - clip_start, len))
        .collect();
    (text, ranges, clip_start)
}

/// The matched line plus up to `CONTEXT_RADIUS` lines either side. Fewer near
/// file boundaries — never an error (spec edge case). `matched` is the row at
/// `index` as the match carries it; the others are cut to `MAX_LINE_CHARS`.
fn context_around(lines: &[&str], index: usize, matched: &str) -> Vec<ContextLine> {
    let start = index.saturating_sub(CONTEXT_RADIUS);
    let end = (index + CONTEXT_RADIUS + 1).min(lines.len());
    (start..end)
        .map(|i| ContextLine {
            line_number: (i + 1) as u32,
            text: if i == index {
                matched.to_string()
            } else {
                lines[i].chars().take(MAX_LINE_CHARS).collect()
            },
        })
        .collect()
}

/// Smart-case matches over `lines` appended to `batch` until it holds
/// `MAX_MATCHES_PER_FILE`; `make` builds the hit from (line index, ranges).
/// True once the cap stopped it — the caller marks the scan truncated.
fn collect_line_matches(
    lines: &[&str],
    needle: &[char],
    case_sensitive: bool,
    batch: &mut Vec<SearchMatch>,
    make: impl Fn(usize, Vec<(u32, u32)>) -> SearchMatch,
) -> bool {
    for (index, line) in lines.iter().enumerate() {
        if batch.len() >= MAX_MATCHES_PER_FILE {
            return true;
        }
        let ranges = find_match_ranges_chars(line, needle, case_sensitive);
        if !ranges.is_empty() {
            batch.push(make(index, ranges));
        }
    }
    false
}

/// A PDF's extracted page lines, saved by the frontend after its one pdf.js
/// pass so later scans match it in Rust like a text file instead of
/// re-extracting a thousand pages per query. `path` guards hash collisions;
/// `modified_at` is the staleness check.
#[derive(Serialize, Deserialize)]
struct PdfText {
    path: String,
    modified_at: u64,
    pages: Vec<Vec<String>>,
}

// ponytail: entries for deleted/renamed PDFs are never pruned, and
// DefaultHasher may change across Rust releases (one re-extraction each).
// Add a sweep if the cache folder ever gets big.
fn pdf_text_file(cache_dir: &Path, pdf: &Path) -> PathBuf {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    pdf.hash(&mut hasher);
    cache_dir.join(format!("{:016x}.json", hasher.finish()))
}

fn load_pdf_text(cache_dir: &Path, pdf: &Path, modified_at: u64) -> Option<Vec<Vec<String>>> {
    let bytes = std::fs::read(pdf_text_file(cache_dir, pdf)).ok()?;
    let saved: PdfText = serde_json::from_slice(&bytes).ok()?;
    (saved.modified_at == modified_at && Path::new(&saved.path) == pdf).then_some(saved.pages)
}

fn save_pdf_text_impl(cache_dir: &Path, text: &PdfText) -> Result<(), AppError> {
    std::fs::create_dir_all(cache_dir).map_err(|e| AppError::Io(e.to_string()))?;
    let file = pdf_text_file(cache_dir, Path::new(&text.path));
    // Write-then-rename so a concurrent scan never reads a half-written file.
    let tmp = file.with_extension("tmp");
    let json = serde_json::to_vec(text).map_err(|e| AppError::Io(e.to_string()))?;
    std::fs::write(&tmp, json).map_err(|e| AppError::Io(e.to_string()))?;
    std::fs::rename(&tmp, &file).map_err(|e| AppError::Io(e.to_string()))
}

fn pdf_text_dir(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .app_cache_dir()
        .map(|dir| dir.join("pdf-text"))
        .map_err(|e| AppError::Io(e.to_string()))
}

/// Persist a fully extracted PDF's page lines for `content_search`.
#[tauri::command]
pub async fn save_pdf_text(
    path: String,
    modified_at: u64,
    pages: Vec<Vec<String>>,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    let dir = pdf_text_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        save_pdf_text_impl(
            &dir,
            &PdfText {
                path,
                modified_at,
                pages,
            },
        )
    })
    .await
    .map_err(|e| AppError::Io(e.to_string()))?
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
/// a `matches` batch per matching text file or cached PDF (≤
/// `MAX_MATCHES_PER_FILE`), a `pdf` event per `.pdf` with no saved text in
/// `pdf_cache`, and a terminal `done` when the walk
/// finishes. A cancelled walk emits nothing further — the frontend's seq
/// guard has already superseded it.
///
/// Synchronous on purpose: callers run it inside `spawn_blocking`, and tests
/// drive it directly on a tempdir with a Vec collector.
pub(crate) fn content_search_impl(
    root: &Path,
    query: &str,
    pdf_cache: Option<&Path>,
    cancel: Arc<AtomicBool>,
    emit: &(dyn Fn(ContentSearchEvent) + Sync),
) {
    let case_sensitive = query.chars().any(|c| c.is_uppercase());
    let needle_chars: Vec<char> = query.chars().collect();
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
    let needle_ref = &needle_chars;

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
                let cached_pdf = if is_pdf_path(path) {
                    let modified_at = crate::commands::fs::modified_time(path);
                    match pdf_cache.and_then(|dir| load_pdf_text(dir, path, modified_at)) {
                        Some(pages) => Some((pages, modified_at)),
                        None => {
                            // Not extracted yet — the frontend runs pdf.js
                            // and saves the text for the next scan. Candidates
                            // keep arriving after the text cap; they carry no
                            // truncation implication of their own.
                            emit_ref(ContentSearchEvent::Pdf {
                                candidate: PdfCandidate {
                                    path: path.to_string_lossy().to_string(),
                                    modified_at,
                                },
                            });
                            return ignore::WalkState::Continue;
                        }
                    }
                } else {
                    None
                };
                // The text cap has engaged: no more text matches can display,
                // but the walk continues so PDF candidates still enumerate.
                // Skipping a file here drops matches — that is truncation.
                if total_ref.load(Ordering::Relaxed) >= MAX_TOTAL_MATCHES {
                    truncated_ref.store(true, Ordering::Relaxed);
                    return ignore::WalkState::Continue;
                }
                let rel = path
                    .strip_prefix(&root)
                    .unwrap_or(path)
                    .to_string_lossy()
                    .to_string();
                let path_str = path.to_string_lossy().to_string();
                let mut batch: Vec<SearchMatch> = Vec::new();

                if let Some((pages, modified_at)) = cached_pdf {
                    for (page_index, page) in pages.iter().enumerate() {
                        let lines: Vec<&str> = page.iter().map(String::as_str).collect();
                        let capped = collect_line_matches(
                            &lines,
                            needle_ref,
                            case_sensitive,
                            &mut batch,
                            |index, ranges| SearchMatch {
                                path: path_str.clone(),
                                relative_path: rel.clone(),
                                modified_at,
                                kind: SearchMatchKind::Pdf,
                                line_number: None,
                                page: Some((page_index + 1) as u32),
                                // ponytail: PDF lines stay whole because `line_text` is
                                // the page anchor; extracted lines are visual lines, so
                                // short. Clip for display if one ever isn't.
                                line_text: lines[index].to_string(),
                                match_ranges: ranges,
                                clip_start: 0,
                                context: context_around(&lines, index, lines[index]),
                            },
                        );
                        if capped {
                            truncated_ref.store(true, Ordering::Relaxed);
                            break;
                        }
                    }
                } else {
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
                    let modified_at = metadata
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or_else(|| crate::commands::fs::modified_time(path));
                    let lines: Vec<&str> = text.lines().collect();
                    let capped = collect_line_matches(
                        &lines,
                        needle_ref,
                        case_sensitive,
                        &mut batch,
                        |index, ranges| {
                            let (line_text, match_ranges, clip_start) =
                                clip_line(lines[index], ranges);
                            SearchMatch {
                                path: path_str.clone(),
                                relative_path: rel.clone(),
                                modified_at,
                                kind: SearchMatchKind::Text,
                                line_number: Some((index + 1) as u32),
                                page: None,
                                context: context_around(&lines, index, &line_text),
                                line_text,
                                match_ranges,
                                clip_start,
                            }
                        },
                    );
                    if capped {
                        truncated_ref.store(true, Ordering::Relaxed);
                    }
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

    let pdf_cache = pdf_text_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        content_search_impl(&root, &query, Some(&pdf_cache), cancel, &|event| {
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
    require_unique: Option<bool>,
) -> Result<Option<String>, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(find_file_by_name_checked(
            Path::new(&root),
            &file_name,
            require_unique.unwrap_or(false),
        )?
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
    fn test_index_workspace_counts_indexed_files() {
        let dir = setup_workspace();
        let (index, _dirs) = index_workspace_test(dir.path());
        assert_eq!(index.len(), 3); // readme.md, notes.md, docs/guide.md
    }

    #[test]
    fn test_index_workspace_covers_all_sidebar_files() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("note.md"), "# Note").unwrap();
        fs::write(dir.path().join("report.pdf"), [0u8]).unwrap();
        fs::write(dir.path().join("sketch.excalidraw.svg"), "<svg/>").unwrap();
        // Kinds the sidebar does not list stay out of the index.
        fs::write(dir.path().join("plain.svg"), "<svg/>").unwrap();
        fs::write(dir.path().join("photo.png"), [0u8]).unwrap();
        fs::write(dir.path().join("data.txt"), "x").unwrap();

        let (index, dirs) = index_workspace_test(dir.path());
        let mut names: Vec<&str> = index.iter().map(|f| f.name.as_str()).collect();
        names.sort_unstable();
        assert_eq!(names, ["note.md", "report.pdf", "sketch.excalidraw.svg"]);
        assert!(dirs.contains(&dir.path().to_path_buf()));
    }

    #[test]
    fn test_index_workspace_ignores_hidden() {
        let dir = setup_workspace();
        let (index, _dirs) = index_workspace_test(dir.path());
        // Should not include .git/config.md
        assert!(!index.iter().any(|f| f.relative_path.contains(".git")));
    }

    #[test]
    fn test_index_workspace_builds_dirs_with_files() {
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
    fn test_fuzzy_search_subsequence_match() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("meeting-notes.md"), "# x").unwrap();
        let (index, _dirs) = index_workspace_test(dir.path());

        let results = fuzzy_search_impl("mtns", &index, 50);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].filename, "meeting-notes.md");
        // Indices are the real matched positions — in order, non-contiguous.
        // "meeting-notes.md": m@0, t@3, n@5, s@12.
        assert_eq!(results[0].match_indices, vec![0, 3, 5, 12]);
    }

    #[test]
    fn test_fuzzy_search_rejects_non_subsequence() {
        let dir = setup_workspace();
        let (index, _dirs) = index_workspace_test(dir.path());
        let results = fuzzy_search_impl("zxq", &index, 50);
        assert!(results.is_empty());
    }

    #[test]
    fn test_fuzzy_search_forgives_one_typo_in_long_queries() {
        let dir = setup_workspace();
        let (index, _dirs) = index_workspace_test(dir.path());
        // Swapped letters: `gudie` is not a subsequence of `guide`.
        let results = fuzzy_search_impl("gudie", &index, 50);
        assert_eq!(results[0].filename, "guide.md");
        // Under five chars stays strict.
        assert!(fuzzy_search_impl("gudi", &index, 50).is_empty());
    }

    #[test]
    fn test_fuzzy_search_exact_substring_beats_subsequence() {
        // "draft" is a literal substring of the `drafts` directory name but
        // only a scattered subsequence inside `d-r-a-f-t.md`. The exact tier
        // always ranks first — fuzzy is the fallback, not a competitor.
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join("drafts")).unwrap();
        fs::write(dir.path().join("drafts").join("meeting.md"), "# x").unwrap();
        fs::write(dir.path().join("d-r-a-f-t.md"), "# x").unwrap();
        let (index, _dirs) = index_workspace_test(dir.path());

        let results = fuzzy_search_impl("draft", &index, 50);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].relative_path, "drafts/meeting.md");
        assert_eq!(results[1].relative_path, "d-r-a-f-t.md");
    }

    #[test]
    fn test_fuzzy_search_finds_pdf_and_drawing() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("annual-report.pdf"), [0u8]).unwrap();
        fs::write(dir.path().join("roadmap.excalidraw.svg"), "<svg/>").unwrap();
        let (index, _dirs) = index_workspace_test(dir.path());

        let results = fuzzy_search_impl("report", &index, 50);
        assert_eq!(results[0].filename, "annual-report.pdf");

        // Subsequence matching works on drawings too.
        let results = fuzzy_search_impl("rdmp", &index, 50);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].filename, "roadmap.excalidraw.svg");
    }

    #[test]
    fn test_fuzzy_search_camel_case_boundary_match() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("QuarterlyReport.md"), "# x").unwrap();
        let (index, _dirs) = index_workspace_test(dir.path());

        let results = fuzzy_search_impl("qr", &index, 50);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].filename, "QuarterlyReport.md");
    }

    #[test]
    fn test_subsequence_score_prefers_boundaries_and_tight_spans() {
        // Same needle, two paths: the boundary-anchored match in
        // "docs/guide.md" must outscore the scattered one in
        // "digging-roads.md".
        let needle: Vec<char> = "gd".chars().collect();

        let (hay_a, boundaries_a) = lowercase_with_boundaries("docs/guide.md");
        let (score_a, indices_a) = subsequence_score(&needle, &hay_a, &boundaries_a).unwrap();
        assert_eq!(indices_a, vec![5, 8]);

        let (hay_b, boundaries_b) = lowercase_with_boundaries("digging-roads.md");
        let (score_b, _) = subsequence_score(&needle, &hay_b, &boundaries_b).unwrap();
        assert!(score_a > score_b);
    }

    #[test]
    fn test_subsequence_score_requires_every_char_in_order() {
        let hay: Vec<char> = "abc".chars().collect();
        let boundaries = vec![true, false, false];
        let needle: Vec<char> = "cba".chars().collect();
        assert!(subsequence_score(&needle, &hay, &boundaries).is_none());
        let needle: Vec<char> = "abcd".chars().collect();
        assert!(subsequence_score(&needle, &hay, &boundaries).is_none());
    }

    #[test]
    fn drawing_basename_lookup_rejects_duplicates_instead_of_picking_shortest() {
        let dir = TempDir::new().unwrap();
        let root_drawing = dir.path().join("Scene.excalidraw.md");
        fs::write(&root_drawing, "source").unwrap();
        assert_eq!(
            find_file_by_name_checked(dir.path(), "scene.excalidraw.md", true).unwrap(),
            Some(root_drawing.clone())
        );
        fs::create_dir(dir.path().join("nested")).unwrap();
        fs::write(
            dir.path().join("nested/scene.EXCALIDRAW.MD"),
            "other source",
        )
        .unwrap();
        let error = find_file_by_name_checked(dir.path(), "scene.excalidraw.md", true).unwrap_err();
        assert!(error.to_string().contains("Ambiguous drawing basename"));
        assert_eq!(
            find_file_by_name_checked(dir.path(), "scene.excalidraw.md", false).unwrap(),
            Some(root_drawing)
        );
        assert!(
            find_file_by_name_checked(dir.path(), "missing.excalidraw.md", true)
                .unwrap()
                .is_none()
        );
        assert!(
            find_file_by_name_checked(&dir.path().join("absent"), "scene.excalidraw.md", true)
                .is_err()
        );
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
        let ctx = context_around(&lines, 0, lines[0]);
        assert_eq!(ctx.len(), 3);
        assert_eq!(ctx[0].line_number, 1);
        let ctx = context_around(&lines, 2, lines[2]);
        assert_eq!(ctx.len(), 3);
        assert_eq!(ctx[2].line_number, 3);
    }

    // --- content search: walk, caps, cancellation (T007) -------------------

    fn search_events(root: &Path, query: &str) -> Vec<ContentSearchEvent> {
        let events = Mutex::new(Vec::new());
        content_search_impl(
            root,
            query,
            None,
            Arc::new(AtomicBool::new(false)),
            &|event| events.lock().push(event),
        );
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
    fn test_long_line_is_clipped_around_match_with_true_column() {
        let dir = TempDir::new().unwrap();
        // Multi-byte padding: the column must stay in chars, not bytes.
        let line = format!("{}ferry{}ferry", "é".repeat(200_000), "x".repeat(200_000));
        let neighbour = "n".repeat(200_000);
        fs::write(dir.path().join("a.svg"), format!("{neighbour}\n{line}\n")).unwrap();

        let events = search_events(dir.path(), "ferry");
        let hit = text_matches(&events)[0];
        assert!(hit.line_text.chars().count() <= MAX_LINE_CHARS);
        assert_eq!(hit.clip_start, 200_000 - CLIP_LEAD_CHARS as u32);
        // Only the match inside the window survives, re-based to it.
        assert_eq!(hit.match_ranges, vec![(CLIP_LEAD_CHARS as u32, 5)]);
        let (start, len) = hit.match_ranges[0];
        let shown: String = hit
            .line_text
            .chars()
            .skip(start as usize)
            .take(len as usize)
            .collect();
        assert_eq!(shown, "ferry");
        assert!(hit
            .context
            .iter()
            .all(|c| c.text.chars().count() <= MAX_LINE_CHARS));
        assert_eq!(hit.context[1].text, hit.line_text);
    }

    #[test]
    fn test_clip_line_keeps_short_lines_and_oversized_first_match() {
        let (text, ranges, start) = clip_line("a ferry", vec![(2, 5)]);
        assert_eq!((text.as_str(), ranges, start), ("a ferry", vec![(2, 5)], 0));

        let line = "y".repeat(2_000);
        let (text, ranges, start) = clip_line(&line, vec![(1_000, 600)]);
        assert_eq!(start, 960);
        assert_eq!(ranges, vec![(40, 600)]);
        assert_eq!(text.chars().count(), 640);
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
    fn test_content_search_matches_saved_pdf_text_in_rust() {
        let dir = TempDir::new().unwrap();
        let cache = TempDir::new().unwrap();
        let pdf = dir.path().join("book.pdf");
        fs::write(&pdf, b"%PDF").unwrap();
        let modified_at = crate::commands::fs::modified_time(&pdf);
        let pages = vec![
            vec!["intro".to_string()],
            vec!["a".into(), "the ferry".into()],
        ];
        save_pdf_text_impl(
            cache.path(),
            &PdfText {
                path: pdf.to_string_lossy().to_string(),
                modified_at,
                pages,
            },
        )
        .unwrap();

        let events = Mutex::new(Vec::new());
        let run = |cache_dir: Option<&Path>| {
            content_search_impl(
                dir.path(),
                "ferry",
                cache_dir,
                Arc::new(AtomicBool::new(false)),
                &|event| events.lock().push(event),
            )
        };
        run(Some(cache.path()));
        let found = events.lock().drain(..).collect::<Vec<_>>();
        let matches = text_matches(&found);
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].kind, SearchMatchKind::Pdf);
        assert_eq!(matches[0].page, Some(2));
        assert_eq!(matches[0].context[1].line_number, 2);
        assert!(!found
            .iter()
            .any(|e| matches!(e, ContentSearchEvent::Pdf { .. })));

        // A stale entry (different mtime) falls back to a pdf.js candidate.
        save_pdf_text_impl(
            cache.path(),
            &PdfText {
                path: pdf.to_string_lossy().to_string(),
                modified_at: modified_at + 1,
                pages: vec![vec!["ferry".into()]],
            },
        )
        .unwrap();
        run(Some(cache.path()));
        let found = events.into_inner();
        assert!(text_matches(&found).is_empty());
        assert!(found
            .iter()
            .any(|e| matches!(e, ContentSearchEvent::Pdf { .. })));
    }

    #[test]
    fn test_content_search_cancelled_walk_sends_no_done() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("notes.md"), "ferry\n").unwrap();

        let events = Mutex::new(Vec::new());
        content_search_impl(
            dir.path(),
            "ferry",
            None,
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
