//! Opt-in AI layer: a per-workspace index of wikilink edges, content hashes,
//! embedding vectors and suggested tags — SPECs/ai-note-graph/.
//!
//! One lazy tokio worker per window is fed by an unbounded `AiJob` channel
//! (kicked by `index:complete`, `index_workspace`, the watcher, and
//! `index_written_file`). Every commit goes through `with_workspace_snapshot`
//! so results from a switched-away workspace are dropped. All network I/O is
//! gated on `ai.enabled`; the feature never writes notes.

use crate::commands::fs::is_markdown_file;
use crate::config::{ConfigValue, Settings};
use crate::state::{AppState, WorkspaceState};
use crate::watcher::WorkspaceIdentity;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;

const SIDECAR_VERSION: u32 = 2;
const DEBOUNCE: Duration = Duration::from_millis(800);
const EMBED_BATCH: usize = 32;
const PROJECTION_CAP: usize = 4000;
const SUGGEST_INPUT_CAP: usize = 6000;
const SUGGEST_TAG_CAP: usize = 3;
/// Minimum cosine for a similarity edge (data-model.md).
pub const SIMILARITY_FLOOR: f32 = 0.6;
/// Per-node similarity neighbours kept for the graph payload.
pub const SIMILARITY_TOP_K: usize = 2;
/// Floor for the `ai_related` list (looser than graph edges — the card shows
/// the score so weak-but-real neighbours are still useful).
pub const RELATED_FLOOR: f32 = 0.5;
pub const RELATED_TOP_K: usize = 3;
/// Shared-formula rows shown above the similar notes in `ai_related`.
pub const FORMULA_RELATED_CAP: usize = 5;
/// Inline `$…$` only counts when the normalized token stream is at least
/// this long — keeps `$x$`, prices and stray delimiters out of relations.
const INLINE_MATH_MIN: usize = 8;

// ---------- settings ----------

/// Resolved `ai.*` settings. Global-scope keys are read per call and never
/// cached — a hand-edited config file applies on the next job without an app
/// restart.
#[derive(Debug, Clone, PartialEq)]
pub struct AiSettings {
    pub enabled: bool,
    pub chat_endpoint: String,
    pub chat_model: String,
    pub chat_key: String,
    pub fallback_endpoint: String,
    pub fallback_key: String,
    pub embed_endpoint: String,
    pub embed_model: String,
}

fn global_string(settings: &Settings, key: &str) -> String {
    settings
        .get_global_or_default(key)
        .and_then(ConfigValue::as_str)
        .unwrap_or("")
        .to_string()
}

/// Resolve the full `ai.*` set from a settings layer, including `enabled`.
pub fn resolve(settings: &Settings) -> AiSettings {
    AiSettings {
        enabled: matches!(
            settings.get_global_or_default("ai.enabled"),
            Some(ConfigValue::Bool(true))
        ),
        chat_endpoint: global_string(settings, "ai.chat-endpoint"),
        chat_model: global_string(settings, "ai.chat-model"),
        chat_key: global_string(settings, "ai.chat-api-key"),
        fallback_endpoint: global_string(settings, "ai.chat-fallback-endpoint"),
        fallback_key: global_string(settings, "ai.chat-fallback-api-key"),
        embed_endpoint: global_string(settings, "ai.embed-endpoint"),
        embed_model: global_string(settings, "ai.embed-model"),
    }
}

/// `Some` only while `ai.enabled` is on — every command and enqueue path
/// gates through here so "off" means zero network and zero index work.
pub fn settings(state: &WorkspaceState) -> Option<AiSettings> {
    let guard = state.settings.read();
    let cfg = resolve(guard.as_ref()?);
    cfg.enabled.then_some(cfg)
}

// ---------- index types (WorkspaceState fields live in state.rs) ----------

/// One per indexed Markdown file, keyed by absolute path (data-model.md).
#[derive(Debug, Clone, Default)]
pub struct NoteEntry {
    /// FNV-1a of the raw file bytes — a matching hash skips re-embedding.
    pub hash: u64,
    /// `None` when no embed endpoint is configured or the call failed —
    /// also the "dirty" marker the next scan uses to re-embed.
    pub embedding: Option<Vec<f32>>,
    /// Resolved absolute paths of this note's `[[…]]` targets.
    pub links: Vec<String>,
    /// Math blocks found in the note — the formula-relation source.
    pub math_blocks: Vec<MathBlock>,
    /// Last chat-model suggestion set; survives re-embeds.
    pub suggested_tags: Vec<String>,
}

/// One math block (`$$…$$`, `\[…\]`, or a substantial inline `$…$`) with
/// its canonical identity and its location in the file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MathBlock {
    /// Normalized TeX token stream — two notes relate when this matches.
    pub normalized: String,
    /// 1-based line of the block's first content line (frontmatter included).
    pub line: u32,
    /// Raw inner source, trimmed — the card's preview and the line-target
    /// needle (its first line appears literally on `line`).
    pub source: String,
}

#[derive(Debug, Default)]
pub struct AiIndex {
    pub notes: HashMap<PathBuf, NoteEntry>,
    /// Queued + in-flight path count — drives `ai_status.pending`.
    pub pending: usize,
    /// Bumped by `touch` on every `notes` mutation — the similarity cache
    /// keys off it, so a stale edge set can never outlive the vectors it
    /// was scored from.
    generation: u64,
    similarity_cache: Option<SimilarityCache>,
}

#[derive(Debug)]
struct SimilarityCache {
    generation: u64,
    floor: f32,
    k: usize,
    edges: Vec<(PathBuf, PathBuf, f32)>,
}

impl AiIndex {
    /// Call after mutating `notes` — bumps the generation every derived
    /// cache keys off.
    pub fn touch(&mut self) {
        self.generation += 1;
    }

    /// `similarity_edges` scores every embedded pair per call; `ai_graph`
    /// asks for the same result on every graph render. Recompute only when
    /// the inputs — the note set or the floor/k parameters — changed.
    pub fn similarity_edges_cached(&mut self, floor: f32, k: usize) -> &[(PathBuf, PathBuf, f32)] {
        let fresh = self.similarity_cache.as_ref().is_some_and(|cache| {
            cache.generation == self.generation && cache.floor == floor && cache.k == k
        });
        if !fresh {
            self.similarity_cache = Some(SimilarityCache {
                generation: self.generation,
                floor,
                k,
                edges: similarity_edges(self, floor, k),
            });
        }
        &self
            .similarity_cache
            .as_ref()
            .expect("just populated")
            .edges
    }
}

#[derive(Debug)]
pub enum AiJob {
    /// Embed/link-scan every indexed markdown file.
    ScanAll,
    /// One file saved/created/changed/deleted.
    Changed(PathBuf),
}

// ---------- wikilink extraction + resolution (T006) ----------

/// Strip a leading `---` frontmatter block. Mirrors the frontend's
/// `FRONTMATTER_RE` (`lib/frontmatter.ts`): the fence must be the very first
/// line and the block must close on its own line.
fn strip_frontmatter(content: &str) -> &str {
    let first_end = match content.find('\n') {
        Some(i) => i,
        None => return content,
    };
    if content[..first_end].trim_end() != "---" {
        return content;
    }
    let rest = &content[first_end + 1..];
    let mut start = 0usize;
    for line in rest.split('\n') {
        if line.trim_end() == "---" {
            let body_start = (start + line.len() + 1).min(rest.len());
            return &rest[body_start..];
        }
        start += line.len() + 1;
    }
    // No closing fence → treat the whole file as body.
    content
}

/// A fenced-code marker line: ≥3 backticks or ≥3 tildes.
fn fence_marker(trimmed: &str) -> Option<(u8, usize)> {
    let ch = *trimmed.as_bytes().first()?;
    if ch != b'`' && ch != b'~' {
        return None;
    }
    let len = trimmed.bytes().take_while(|&b| b == ch).count();
    (len >= 3).then_some((ch, len))
}

/// Raw `[[…]]` / `![[…]]` inner targets, in document order. Frontmatter,
/// fenced code blocks and inline code spans are skipped — an embed inside
/// backticks is text, not a link.
pub fn extract_wiki_links(content: &str) -> Vec<String> {
    let body = strip_frontmatter(content);
    let mut targets = Vec::new();
    let mut fence: Option<(u8, usize)> = None;

    for line in body.split('\n') {
        let trimmed = line.trim_start();
        match fence {
            Some((ch, len)) => {
                // A closing fence is the same char, at least as long, alone.
                if trimmed.bytes().take_while(|&b| b == ch).count() >= len
                    && trimmed[len..].trim().is_empty()
                {
                    fence = None;
                }
                continue;
            }
            None => {
                if let Some(marker) = fence_marker(trimmed) {
                    fence = Some(marker);
                    continue;
                }
            }
        }
        scan_line_links(line, &mut targets);
    }
    targets
}

fn scan_line_links(line: &str, targets: &mut Vec<String>) {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        // Inline code: a run of n backticks closes at the next run of n.
        if bytes[i] == b'`' {
            let run = bytes[i..].iter().take_while(|&&b| b == b'`').count();
            let mut j = i + run;
            while j < bytes.len() {
                if bytes[j] == b'`' && bytes[j..].iter().take_while(|&&b| b == b'`').count() == run
                {
                    break;
                }
                j += 1;
            }
            // No closing run → rest of line is code, stop scanning.
            i = if j < bytes.len() {
                j + run
            } else {
                bytes.len()
            };
            continue;
        }
        let is_link = bytes[i] == b'[' && bytes.get(i + 1) == Some(&b'[');
        let is_embed =
            bytes[i] == b'!' && bytes.get(i + 1) == Some(&b'[') && bytes.get(i + 2) == Some(&b'[');
        if is_link || is_embed {
            let inner_start = i + if is_embed { 3 } else { 2 };
            if let Some(rel_end) = line[inner_start..].find("]]") {
                let inner = &line[inner_start..inner_start + rel_end];
                targets.push(inner.to_string());
                i = inner_start + rel_end + 2;
                continue;
            }
        }
        i += 1;
    }
}

/// The display text of a wikilink inner: the alias when one exists
/// (`[[a|b]]` → `b`), else the target minus any `#fragment`.
fn wiki_display_text(inner: &str) -> String {
    if let Some((_, alias)) = inner.split_once('|') {
        return alias.trim().to_string();
    }
    inner.split('#').next().unwrap_or(inner).trim().to_string()
}

/// Strip a link inner down to its normalized path target — mirrors
/// `parseWikiLink` + `normalizeWikiTarget` in `lib/wiki-links.ts`: alias and
/// fragment split, backslashes → slashes, leading `/` dropped, `.md` /
/// `.markdown` extension stripped (case-insensitive).
pub fn normalize_wiki_target(raw: &str) -> String {
    // splitAlias: first `|` not preceded by `\`.
    let bytes = raw.as_bytes();
    let mut target_end = raw.len();
    for i in 0..bytes.len() {
        if bytes[i] == b'|' && (i == 0 || bytes[i - 1] != b'\\') {
            target_end = if i > 0 && bytes[i - 1] == b'\\' {
                i - 1
            } else {
                i
            };
            break;
        }
    }
    let target = &raw[..target_end];
    let target = target.replace("\\|", "|");
    let target = target.trim().replace('\\', "/");
    // splitFragment: first `#`.
    let path = target.split('#').next().unwrap_or("").to_string();
    let mut path = path.trim().trim_start_matches('/').to_string();
    let lower = path.to_lowercase();
    if lower.ends_with(".markdown") {
        path.truncate(path.len() - ".markdown".len());
    } else if lower.ends_with(".md") {
        path.truncate(path.len() - ".md".len());
    }
    path
}

/// Resolve raw `[[…]]` targets to absolute markdown paths — mirrors
/// `resolveWikiLink` rules in `lib/wiki-links.ts`:
///
/// - targets containing `/` are workspace-root-relative probes for
///   `{target}.md` / `{target}.markdown`;
/// - bare stems resolve only when exactly one indexed markdown file matches
///   (case-insensitive).
///
/// `files` is the indexed markdown set (absolute paths). Unresolved targets
/// are dropped; the result is deduped.
pub fn resolve_links(targets: &[String], root: &Path, files: &HashSet<PathBuf>) -> Vec<String> {
    let mut stems: HashMap<String, Vec<&PathBuf>> = HashMap::new();
    for file in files {
        if let Some(stem) = file.file_stem().and_then(|s| s.to_str()) {
            stems.entry(stem.to_lowercase()).or_default().push(file);
        }
    }

    let mut seen = HashSet::new();
    let mut resolved = Vec::new();
    for raw in targets {
        let target = normalize_wiki_target(raw);
        if target.is_empty() {
            continue;
        }
        let hit: Option<PathBuf> = if target.contains('/') {
            [".md", ".markdown"]
                .iter()
                .map(|ext| root.join(format!("{target}{ext}")))
                .find(|candidate| files.contains(candidate))
        } else {
            stems
                .get(&target.to_lowercase())
                .and_then(|hits| (hits.len() == 1).then(|| hits[0].clone()))
        };
        if let Some(path) = hit {
            let key = path.to_string_lossy().into_owned();
            if seen.insert(key.clone()) {
                resolved.push(key);
            }
        }
    }
    resolved
}

// ---------- embedding projection (R9: raw LaTeX embeds badly) ----------

/// Text actually sent to the embedding endpoint: frontmatter and fenced code
/// stripped, `[[x|y]]` → `y`, `$$…$$`/`$…$` unwrapped to their inner text,
/// `\cmd` → `cmd`, whitespace collapsed, capped at 4000 chars.
pub fn embed_projection(content: &str) -> String {
    let body = strip_fenced_code(strip_frontmatter(content));
    let no_links = unwrap_wikilinks(&body);
    let no_math = unwrap_math(&no_links);
    let no_tex = strip_tex_commands(&no_math);
    let collapsed = no_tex.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(PROJECTION_CAP).collect()
}

/// Drop fenced code blocks entirely — a projection of prose.
fn strip_fenced_code(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut fence: Option<(u8, usize)> = None;
    for line in text.split('\n') {
        let trimmed = line.trim_start();
        match fence {
            Some((ch, len)) => {
                if trimmed.bytes().take_while(|&b| b == ch).count() >= len
                    && trimmed[len..].trim().is_empty()
                {
                    fence = None;
                }
            }
            None => match fence_marker(trimmed) {
                Some(marker) => fence = Some(marker),
                None => {
                    out.push_str(line);
                    out.push('\n');
                }
            },
        }
    }
    out
}

/// Replace `[[x]]` / `[[x|y]]` / `![[x]]` with their display text so the
/// projection reads like rendered prose.
fn unwrap_wikilinks(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    loop {
        let link_at = rest.find("[[");
        let Some(start) = link_at else {
            out.push_str(rest);
            break;
        };
        // Include the '!' of `![[` when it directly precedes.
        let (emit_end, inner_start) = if start > 0 && rest.as_bytes()[start - 1] == b'!' {
            (start - 1, start + 2)
        } else {
            (start, start + 2)
        };
        let Some(end) = rest[inner_start..].find("]]") else {
            out.push_str(rest);
            break;
        };
        out.push_str(&rest[..emit_end]);
        let inner = &rest[inner_start..inner_start + end];
        out.push_str(&wiki_display_text(inner));
        out.push(' ');
        rest = &rest[inner_start + end + 2..];
    }
    out
}

/// `$$…$$` and `$…$` unwrap to their inner text. A single `$` only counts
/// when the opener isn't followed by whitespace and the closer isn't
/// preceded by whitespace (keeps "$5 and $10" prose intact); inner text may
/// not span a newline.
fn unwrap_math(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('$') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        if let Some(inner) = after.strip_prefix('$') {
            match inner.find("$$") {
                Some(end) => {
                    out.push_str(&inner[..end]);
                    out.push(' ');
                    rest = &inner[end + 2..];
                }
                None => {
                    out.push_str("$$");
                    rest = inner;
                }
            }
            continue;
        }
        match after.find('$') {
            Some(end)
                if end > 0
                    && !after.as_bytes()[0].is_ascii_whitespace()
                    && !after.as_bytes()[end - 1].is_ascii_whitespace()
                    && !after[..end].contains('\n') =>
            {
                out.push_str(&after[..end]);
                out.push(' ');
                rest = &after[end + 1..];
            }
            _ => {
                out.push('$');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// `\frac` → `frac`: drop the backslash on alphabetic commands. Other
/// escapes (`\|`, `\#`, `\\`) pass through untouched.
fn strip_tex_commands(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\\' && chars.peek().is_some_and(|c| c.is_ascii_alphabetic()) {
            continue;
        }
        out.push(ch);
    }
    out
}

// ---------- math blocks + formula relations ----------

/// The closing frontmatter fence's line index (0-based), so math scanning
/// can skip `---…---` entirely while keeping absolute line numbers.
fn frontmatter_end_line(content: &str) -> Option<usize> {
    let first_end = content.find('\n')?;
    if content[..first_end].trim_end() != "---" {
        return None;
    }
    let mut idx = 1usize;
    for line in content[first_end + 1..].split('\n') {
        if line.trim_end() == "---" {
            return Some(idx);
        }
        idx += 1;
    }
    None
}

/// Display-math state carried across lines inside `scan_line_math`.
struct DisplayBlock {
    /// Closing delimiter: `"$$"` or `"\\]"`.
    closer: &'static str,
    /// Line of the first non-whitespace content char (1-based); 0 = none yet.
    content_line: u32,
    buf: String,
}

/// Every math block in `content` with its normalized identity and absolute
/// line. Frontmatter, fenced code and inline code spans are skipped — a
/// `$$` inside backticks is text, not math.
pub fn extract_math_blocks(content: &str) -> Vec<MathBlock> {
    let fm_end = frontmatter_end_line(content);
    let mut blocks = Vec::new();
    let mut fence: Option<(u8, usize)> = None;
    let mut display: Option<DisplayBlock> = None;

    for (idx, line) in content.split('\n').enumerate() {
        if fm_end.is_some_and(|end| idx <= end) {
            continue;
        }
        let lineno = (idx + 1) as u32;
        if display.is_none() {
            let trimmed = line.trim_start();
            match fence {
                Some((ch, len)) => {
                    if trimmed.bytes().take_while(|&b| b == ch).count() >= len
                        && trimmed[len..].trim().is_empty()
                    {
                        fence = None;
                    }
                    continue;
                }
                None => {
                    if let Some(marker) = fence_marker(trimmed) {
                        fence = Some(marker);
                        continue;
                    }
                }
            }
        }
        scan_line_math(line, lineno, &mut display, &mut blocks);
    }
    blocks
}

fn emit_math_block(source: String, line: u32, blocks: &mut Vec<MathBlock>) {
    let source = source.trim().to_string();
    let normalized = normalize_math(&source);
    if normalized.is_empty() {
        return;
    }
    blocks.push(MathBlock {
        normalized,
        line,
        source,
    });
}

fn scan_line_math(
    line: &str,
    lineno: u32,
    display: &mut Option<DisplayBlock>,
    blocks: &mut Vec<MathBlock>,
) {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if display.is_some() {
            let (closer_len, closes) = {
                let block = display.as_ref().unwrap();
                (
                    block.closer.len(),
                    bytes[i..].starts_with(block.closer.as_bytes()),
                )
            };
            if closes {
                let finished = display.take().unwrap();
                let line = if finished.content_line == 0 {
                    lineno
                } else {
                    finished.content_line
                };
                emit_math_block(finished.buf, line, blocks);
                i += closer_len;
                continue;
            }
            let ch = line[i..].chars().next().unwrap();
            let block = display.as_mut().unwrap();
            if block.content_line == 0 && !ch.is_whitespace() {
                block.content_line = lineno;
            }
            block.buf.push(ch);
            i += ch.len_utf8();
            continue;
        }

        match bytes[i] {
            // Inline code: a run of n backticks closes at the next run of n.
            b'`' => {
                let run = bytes[i..].iter().take_while(|&&b| b == b'`').count();
                let mut j = i + run;
                while j < bytes.len() {
                    if bytes[j] == b'`'
                        && bytes[j..].iter().take_while(|&&b| b == b'`').count() == run
                    {
                        break;
                    }
                    j += 1;
                }
                i = if j < bytes.len() {
                    j + run
                } else {
                    bytes.len()
                };
            }
            b'$' if bytes.get(i + 1) == Some(&b'$') => {
                *display = Some(DisplayBlock {
                    closer: "$$",
                    content_line: 0,
                    buf: String::new(),
                });
                i += 2;
            }
            b'\\' if bytes.get(i + 1) == Some(&b'[') => {
                *display = Some(DisplayBlock {
                    closer: "\\]",
                    content_line: 0,
                    buf: String::new(),
                });
                i += 2;
            }
            b'$' => {
                // unwrap_math's heuristic: opener not followed by space,
                // closer not preceded by space, same line only.
                let inner_start = i + 1;
                if bytes
                    .get(inner_start)
                    .is_some_and(|b| !b.is_ascii_whitespace())
                {
                    let rest = &line[inner_start..];
                    if let Some(end) = rest.find('$') {
                        let inner = &rest[..end];
                        if end > 0 && !inner.as_bytes()[end - 1].is_ascii_whitespace() {
                            let normalized = normalize_math(inner.trim());
                            let formulaish = inner
                                .bytes()
                                .any(|b| matches!(b, b'\\' | b'^' | b'_' | b'='));
                            if formulaish && normalized.len() >= INLINE_MATH_MIN {
                                emit_math_block(inner.trim().to_string(), lineno, blocks);
                            }
                            i = inner_start + end + 1;
                            continue;
                        }
                    }
                }
                i += 1;
            }
            _ => i += 1,
        }
    }
    if let Some(block) = display.as_mut() {
        block.buf.push('\n');
    }
}

/// TeX commands that never change a formula's meaning — sizing, spacing
/// and style only. Compared as whole tokens (the leading `\` included).
const MATH_NOOPS: &[&str] = &[
    "\\left",
    "\\right",
    "\\middle",
    "\\displaystyle",
    "\\limits",
    "\\nolimits",
    "\\quad",
    "\\qquad",
    "\\bigl",
    "\\bigr",
    "\\Bigl",
    "\\Bigr",
    "\\biggl",
    "\\biggr",
    "\\Biggl",
    "\\Biggr",
    "\\,",
    "\\;",
    "\\:",
    "\\!",
    "\\ ",
    "\\>",
];

/// Split TeX source into comparison tokens: `\command` (backslash + letters,
/// or backslash + one char), then one char per token. Whitespace separates
/// only — `\alpha x` and `\alphax` stay different commands.
fn math_tokens(tex: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut chars = tex.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch.is_whitespace() {
            continue;
        }
        if ch == '\\' {
            let mut cmd = String::from('\\');
            match chars.peek() {
                Some(&next) if next.is_ascii_alphabetic() => {
                    while let Some(&c) = chars.peek() {
                        if !c.is_ascii_alphabetic() {
                            break;
                        }
                        cmd.push(c);
                        chars.next();
                    }
                }
                Some(&next) => {
                    cmd.push(next);
                    chars.next();
                }
                None => {}
            }
            tokens.push(cmd);
            continue;
        }
        tokens.push(ch.to_string());
    }
    tokens
}

/// `{x}` → `x` when the group wraps exactly one token — braces around a
/// single atom are optional in TeX, so `x_{i}` ≡ `x_i`. Repeated to a
/// fixpoint for `{{x}}`. A group of ≥2 tokens keeps its braces, which is
/// correct: `\sqrt{xy}` ≠ `\sqrt xy` (the unbraced form takes only `x`).
fn collapse_single_atom_braces(tokens: &mut Vec<String>) {
    loop {
        let mut changed = false;
        let mut i = 0;
        while i + 2 < tokens.len() {
            if tokens[i] == "{" && tokens[i + 2] == "}" {
                let inner = tokens.remove(i + 1);
                tokens.remove(i + 1); // the closing brace, now at i+1
                tokens[i] = inner;
                changed = true;
            } else {
                i += 1;
            }
        }
        if !changed {
            break;
        }
    }
}

/// A formula's canonical identity: tokenized, no-op commands dropped,
/// single-atom braces collapsed, whitespace-free modulo the one-space
/// token separator. `E = mc^{2}` ≡ `E=mc^2` ≡ `E\,=\,mc^2`.
pub fn normalize_math(tex: &str) -> String {
    let mut tokens = math_tokens(tex);
    tokens.retain(|tok| !MATH_NOOPS.contains(&tok.as_str()));
    collapse_single_atom_braces(&mut tokens);
    tokens.join(" ")
}

/// The first source line of a block, trimmed — the card preview and the
/// needle the line-target lookup re-finds in the file.
pub fn first_source_line(source: &str) -> &str {
    source.split('\n').next().unwrap_or("").trim()
}

/// A cross-note formula match: both sides share the same normalized math.
/// `a`/`b` order is canonical (path, then line) for deterministic output;
/// each side carries its own first source line — display text and the
/// line-target needle for the jump into that note.
#[derive(Debug, Clone)]
pub struct FormulaRelation {
    pub a_path: PathBuf,
    pub a_line: u32,
    pub a_snippet: String,
    pub b_path: PathBuf,
    pub b_line: u32,
    pub b_snippet: String,
}

/// Every pair of notes sharing at least one normalized formula — one
/// relation per (note pair, formula), pointing at each note's earliest
/// occurrence. Collapsing to note granularity before materializing is what
/// keeps repeated formulas cheap: 1500 identical `$$` blocks across 3 notes
/// is 3 relations, not ~750k block-pair clones the graph caller would
/// dedupe back down anyway.
pub fn formula_relations(index: &AiIndex) -> Vec<FormulaRelation> {
    let mut by_norm: HashMap<&str, HashMap<&PathBuf, &MathBlock>> = HashMap::new();
    for (path, entry) in &index.notes {
        for block in &entry.math_blocks {
            by_norm
                .entry(block.normalized.as_str())
                .or_default()
                .entry(path)
                .and_modify(|earliest| {
                    if block.line < earliest.line {
                        *earliest = block;
                    }
                })
                .or_insert(block);
        }
    }

    let mut relations = Vec::new();
    for per_note in by_norm.values() {
        let mut blocks: Vec<(&PathBuf, &MathBlock)> = per_note
            .iter()
            .map(|(path, block)| (*path, *block))
            .collect();
        // Sorting by path alone would already be deterministic; including
        // the line keeps the emitted pair order independent of the hash
        // map's iteration order even if earliest-occurrence selection ever
        // loosens.
        blocks.sort_by(|(pa, a), (pb, b)| pa.cmp(pb).then(a.line.cmp(&b.line)));
        for i in 0..blocks.len() {
            for j in i + 1..blocks.len() {
                let (a_path, a) = blocks[i];
                let (b_path, b) = blocks[j];
                relations.push(FormulaRelation {
                    a_path: a_path.clone(),
                    a_line: a.line,
                    a_snippet: first_source_line(&a.source).to_string(),
                    b_path: b_path.clone(),
                    b_line: b.line,
                    b_snippet: first_source_line(&b.source).to_string(),
                });
            }
        }
    }
    relations.sort_by(|x, y| {
        x.a_path
            .cmp(&y.a_path)
            .then(x.a_line.cmp(&y.a_line))
            .then(x.b_path.cmp(&y.b_path))
            .then(x.b_line.cmp(&y.b_line))
    });
    relations
}

// ---------- similarity ----------

pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0f64;
    let mut na = 0f64;
    let mut nb = 0f64;
    for i in 0..a.len() {
        let x = a[i] as f64;
        let y = b[i] as f64;
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    (dot / (na * nb).sqrt()) as f32
}

/// Top-k cosine neighbours per node above `floor`; symmetric pairs deduped
/// keeping the higher score. Returns `(source, target, score)` sorted by
/// descending score for deterministic output.
pub fn similarity_edges(index: &AiIndex, floor: f32, k: usize) -> Vec<(PathBuf, PathBuf, f32)> {
    let embedded: Vec<(&PathBuf, &Vec<f32>)> = index
        .notes
        .iter()
        .filter_map(|(path, entry)| entry.embedding.as_ref().map(|e| (path, e)))
        .collect();

    let mut best: HashMap<(PathBuf, PathBuf), f32> = HashMap::new();
    for (i, (path, emb)) in embedded.iter().enumerate() {
        let mut scored: Vec<(&PathBuf, f32)> = embedded
            .iter()
            .enumerate()
            .filter(|(j, _)| *j != i)
            .map(|(_, (other, other_emb))| (*other, cosine(emb, other_emb)))
            .filter(|(_, score)| *score >= floor)
            .collect();
        scored.sort_by(|a, b| b.1.total_cmp(&a.1));
        for (other, score) in scored.into_iter().take(k) {
            let key = if *path <= other {
                ((*path).clone(), (*other).clone())
            } else {
                ((*other).clone(), (*path).clone())
            };
            let entry = best.entry(key).or_insert(score);
            *entry = entry.max(score);
        }
    }

    let mut edges: Vec<(PathBuf, PathBuf, f32)> = best
        .into_iter()
        .map(|((a, b), score)| (a, b, score))
        .collect();
    edges.sort_by(|a, b| b.2.total_cmp(&a.2));
    edges
}

/// Top-k cosine neighbours of one note (the card's "related" list).
pub fn related(index: &AiIndex, path: &Path, floor: f32, k: usize) -> Vec<(PathBuf, f32)> {
    let Some(entry) = index.notes.get(path) else {
        return Vec::new();
    };
    let Some(embedding) = entry.embedding.as_ref() else {
        return Vec::new();
    };
    let mut scored: Vec<(PathBuf, f32)> = index
        .notes
        .iter()
        .filter(|(other, _)| other.as_path() != path)
        .filter_map(|(other, e)| {
            e.embedding
                .as_ref()
                .map(|emb| (other.clone(), cosine(embedding, emb)))
        })
        .filter(|(_, score)| *score >= floor)
        .collect();
    scored.sort_by(|a, b| b.1.total_cmp(&a.1));
    scored.truncate(k);
    scored
}

// ---------- sidecar persistence ----------

#[derive(Debug, Serialize, Deserialize)]
struct SidecarFile {
    version: u32,
    root: String,
    embed_endpoint: String,
    embed_model: String,
    notes: Vec<SidecarNote>,
}

#[derive(Debug, Serialize, Deserialize)]
struct SidecarNote {
    /// Workspace-relative path.
    path: String,
    hash: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    embedding: Option<Vec<f32>>,
    #[serde(default)]
    links: Vec<String>,
    #[serde(default)]
    math_blocks: Vec<MathBlock>,
    #[serde(default)]
    suggested_tags: Vec<String>,
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for &b in bytes {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn sidecar_path(app: &AppHandle, root: &Path) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    let name = format!("{:016x}.json", fnv1a64(root.to_string_lossy().as_bytes()));
    Some(dir.join("ai-graph").join(name))
}

/// Load the persisted index. A wrong `version`/`root` ignores the file; an
/// `embed_endpoint`/`embed_model` mismatch keeps links and tags but drops
/// vectors (they re-embed on the next scan). Notes whose file no longer
/// exists are skipped.
fn load_sidecar(path: &Path, root: &Path, cfg: &AiSettings) -> HashMap<PathBuf, NoteEntry> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return HashMap::new();
    };
    let Ok(file) = serde_json::from_str::<SidecarFile>(&raw) else {
        return HashMap::new();
    };
    if file.version != SIDECAR_VERSION || Path::new(&file.root) != root {
        return HashMap::new();
    }
    let embeddings_valid =
        file.embed_endpoint == cfg.embed_endpoint && file.embed_model == cfg.embed_model;
    let mut notes = HashMap::new();
    for note in file.notes {
        let path = root.join(&note.path);
        if !path.exists() {
            continue;
        }
        notes.insert(
            path,
            NoteEntry {
                hash: note.hash,
                embedding: if embeddings_valid {
                    note.embedding
                } else {
                    None
                },
                links: note.links,
                math_blocks: note.math_blocks,
                suggested_tags: note.suggested_tags,
            },
        );
    }
    notes
}

/// Serialize the index to the sidecar: atomic temp-write + rename, the same
/// pattern as session saves. Relative paths keep the file root-agnostic.
fn save_sidecar(path: &Path, root: &Path, cfg: &AiSettings, index: &AiIndex) {
    let mut notes: Vec<SidecarNote> = index
        .notes
        .iter()
        .filter_map(|(path, entry)| {
            let rel = path.strip_prefix(root).ok()?.to_string_lossy().into_owned();
            Some(SidecarNote {
                path: rel,
                hash: entry.hash,
                embedding: entry.embedding.clone(),
                links: entry.links.clone(),
                math_blocks: entry.math_blocks.clone(),
                suggested_tags: entry.suggested_tags.clone(),
            })
        })
        .collect();
    notes.sort_by(|a, b| a.path.cmp(&b.path));

    let file = SidecarFile {
        version: SIDECAR_VERSION,
        root: root.to_string_lossy().into_owned(),
        embed_endpoint: cfg.embed_endpoint.clone(),
        embed_model: cfg.embed_model.clone(),
        notes,
    };
    let Ok(json) = serde_json::to_string(&file) else {
        return;
    };
    let Some(parent) = path.parent() else { return };
    if std::fs::create_dir_all(parent).is_err() {
        return;
    }
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, json).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}

// ---------- HTTP ----------

/// Build the shared client. reqwest is `rustls-no-provider` (see
/// Cargo.toml), so the ring provider is installed once per process — same
/// pattern as telemetry.
pub(crate) fn http_client() -> Result<reqwest::Client, String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        // Blackholed endpoints otherwise hang for the OS TCP timeout
        // (~75 s+) — a dead host should fail fast and fallback-worthy.
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())
}

/// `POST {embed_endpoint}/embeddings`, OpenAI shape
/// `{model, input: string[]}` → `data[i].embedding` (sorted by `index` when
/// present). Callers chunk to ≤32 inputs.
pub async fn embed_batch(
    client: &reqwest::Client,
    cfg: &AiSettings,
    texts: &[String],
) -> Result<Vec<Vec<f32>>, String> {
    let url = format!("{}/embeddings", cfg.embed_endpoint.trim_end_matches('/'));
    let response = client
        .post(&url)
        .timeout(Duration::from_secs(60))
        .json(&serde_json::json!({ "model": cfg.embed_model, "input": texts }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let response = response.error_for_status().map_err(|e| e.to_string())?;
    let body: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    let data = body
        .get("data")
        .and_then(|d| d.as_array())
        .ok_or_else(|| "embeddings response missing data[]".to_string())?;

    let mut items: Vec<(usize, Vec<f32>)> = Vec::with_capacity(data.len());
    for (position, item) in data.iter().enumerate() {
        let vector: Vec<f32> = item
            .get("embedding")
            .and_then(|e| e.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_f64().map(|f| f as f32))
                    .collect()
            })
            .ok_or_else(|| "embeddings item missing embedding[]".to_string())?;
        let index = item
            .get("index")
            .and_then(|i| i.as_u64())
            .map(|i| i as usize)
            .unwrap_or(position);
        items.push((index, vector));
    }
    items.sort_by_key(|(index, _)| *index);
    Ok(items.into_iter().map(|(_, vector)| vector).collect())
}

/// Why one chat endpoint failed — drives the fallback classifier.
#[derive(Debug)]
pub enum ChatError {
    /// Connect error, timeout, DNS — the endpoint itself is unavailable.
    Transport(String),
    /// HTTP status — `4xx` is a config error (fail), `5xx` is availability
    /// (fall back when a secondary is configured).
    Http(u16),
    /// Response wasn't the OpenAI chat shape.
    Parse(String),
}

impl ChatError {
    /// Pure classifier — a canned `Result` is all a test needs.
    pub fn is_fallback_worthy(&self) -> bool {
        match self {
            ChatError::Transport(_) => true,
            ChatError::Http(status) => *status >= 500,
            ChatError::Parse(_) => false,
        }
    }
}

impl std::fmt::Display for ChatError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ChatError::Transport(e) => write!(f, "chat endpoint unreachable: {e}"),
            ChatError::Http(status) => write!(f, "chat endpoint returned HTTP {status}"),
            ChatError::Parse(e) => write!(f, "chat response unparseable: {e}"),
        }
    }
}

fn tags_json_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "json_schema",
        "json_schema": {
            "name": "note_tags",
            "schema": {
                "type": "object",
                "properties": { "tags": { "type": "array", "items": { "type": "string" } } },
                "required": ["tags"],
                "additionalProperties": false
            }
        }
    })
}

fn chat_body(cfg_model: &str, system: &str, user: &str, with_format: bool) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": cfg_model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user },
        ],
        "temperature": 0.2,
        // Reasoning models (Qwen3) burn tokens on `reasoning` before the
        // answer — 256 truncates them into `content: null`. 2048 leaves room
        // for a think block plus the tags JSON.
        "max_tokens": 2048,
    });
    if with_format {
        body["response_format"] = tags_json_schema();
        // Qwen3-on-vLLM: skip the think block so `content` is the answer.
        // Servers that reject unknown keys 400 → retried without both.
        body["chat_template_kwargs"] = serde_json::json!({ "enable_thinking": false });
    }
    body
}

async fn chat_extract(response: reqwest::Response) -> Result<String, ChatError> {
    let status = response.status();
    if !status.is_success() {
        return Err(ChatError::Http(status.as_u16()));
    }
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| ChatError::Parse(e.to_string()))?;
    body.pointer("/choices/0/message/content")
        .and_then(|c| c.as_str())
        .map(str::to_owned)
        .ok_or_else(|| ChatError::Parse("missing choices[0].message.content".into()))
}

/// One endpoint attempt: POST `{base}/chat/completions` with the JSON-schema
/// `response_format`; a 400 retries once without it (servers that don't know
/// structured output). No other retries — fallback handles availability.
async fn chat_once(
    client: &reqwest::Client,
    endpoint: &str,
    key: &str,
    cfg: &AiSettings,
    system: &str,
    user: &str,
) -> Result<String, ChatError> {
    let url = format!("{}/chat/completions", endpoint.trim_end_matches('/'));
    let send = |with_format: bool| {
        let request = client
            .post(&url)
            .timeout(Duration::from_secs(120))
            .json(&chat_body(&cfg.chat_model, system, user, with_format));
        let request = if key.is_empty() {
            request
        } else {
            request.bearer_auth(key)
        };
        async move {
            request
                .send()
                .await
                .map_err(|e| ChatError::Transport(e.to_string()))
        }
    };

    let response = send(true).await?;
    if response.status().as_u16() == 400 {
        return chat_extract(send(false).await?).await;
    }
    chat_extract(response).await
}

/// Primary → fallback on connect/timeout/5xx when a fallback is configured;
/// 4xx and parse failures are config problems and surface immediately.
pub async fn chat_complete(
    client: &reqwest::Client,
    cfg: &AiSettings,
    system: &str,
    user: &str,
) -> Result<String, ChatError> {
    let primary = chat_once(client, &cfg.chat_endpoint, &cfg.chat_key, cfg, system, user).await;
    match primary {
        Err(error) if error.is_fallback_worthy() && !cfg.fallback_endpoint.is_empty() => {
            eprintln!("[ai] primary chat failed ({error}), trying fallback");
            chat_once(
                client,
                &cfg.fallback_endpoint,
                &cfg.fallback_key,
                cfg,
                system,
                user,
            )
            .await
        }
        other => other,
    }
}

const SUGGEST_SYSTEM_PROMPT: &str =
    "You suggest tags for a markdown note. Reply with a JSON object {\"tags\": [...]} only — \
     at most 3 short lowercase tags, the most specific ones describing the note's topic, \
     hyphenated, no '#', no commentary.";

/// Chat-model tag suggestions for one note's content (already capped by the
/// caller). Returns a normalized, deduped, ≤3 list.
pub async fn suggest_tags(
    client: &reqwest::Client,
    cfg: &AiSettings,
    content: &str,
) -> Result<Vec<String>, ChatError> {
    let capped: String = content.chars().take(SUGGEST_INPUT_CAP).collect();
    let user = format!("Note:\n\n{capped}");
    let text = chat_complete(client, cfg, SUGGEST_SYSTEM_PROMPT, &user).await?;
    Ok(parse_tags_response(&text))
}

/// Lenient tag extraction: find the first JSON object or array in the model
/// output, read `{"tags": [...]}` or a bare `[...]`, then normalize
/// (lowercase, spaces → `-`), dedupe, cap at 3. Returns an empty list on
/// garbage — the caller surfaces "no suggestions", not an error.
pub fn parse_tags_response(text: &str) -> Vec<String> {
    let candidates = [
        first_json_span(text, b'{', b'}'),
        first_json_span(text, b'[', b']'),
    ];
    for candidate in candidates.into_iter().flatten() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(candidate) else {
            continue;
        };
        let raw: Vec<&str> = match &value {
            serde_json::Value::Object(map) => map
                .get("tags")
                .and_then(|t| t.as_array())
                .map(|arr| arr.iter().filter_map(|v| v.as_str()).collect())
                .unwrap_or_default(),
            serde_json::Value::Array(arr) => arr.iter().filter_map(|v| v.as_str()).collect(),
            _ => Vec::new(),
        };
        if raw.is_empty() {
            continue;
        }
        let mut seen = HashSet::new();
        let mut tags = Vec::new();
        for tag in raw {
            let normalized = tag.trim().to_lowercase().replace(char::is_whitespace, "-");
            if normalized.is_empty() || !seen.insert(normalized.clone()) {
                continue;
            }
            tags.push(normalized);
            if tags.len() >= SUGGEST_TAG_CAP {
                break;
            }
        }
        if !tags.is_empty() {
            return tags;
        }
    }
    Vec::new()
}

/// First balanced `open…close` span (depth-counted). Model output sometimes
/// pads the JSON with prose; this grabs the object without needing the whole
/// reply to parse.
fn first_json_span(text: &str, open: u8, close: u8) -> Option<&str> {
    let bytes = text.as_bytes();
    let start = bytes.iter().position(|&b| b == open)?;
    let mut depth = 0usize;
    for i in start..bytes.len() {
        if bytes[i] == open {
            depth += 1;
        } else if bytes[i] == close {
            depth -= 1;
            if depth == 0 {
                return Some(&text[start..=i]);
            }
        }
    }
    None
}

// ---------- endpoint probes (ai_status) ----------

/// `GET {chat}/models` and `POST {embed}/embeddings`, each with a 3 s budget.
/// Unconfigured endpoints report `false` — the UI reads "off" and
/// "unreachable" the same way.
pub async fn probe_endpoints(cfg: &AiSettings) -> (bool, bool) {
    let Ok(client) = http_client() else {
        return (false, false);
    };
    let chat = async {
        if cfg.chat_endpoint.is_empty() {
            return false;
        }
        let request = client
            .get(format!(
                "{}/models",
                cfg.chat_endpoint.trim_end_matches('/')
            ))
            .timeout(Duration::from_secs(3));
        let request = if cfg.chat_key.is_empty() {
            request
        } else {
            request.bearer_auth(&cfg.chat_key)
        };
        request
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    };
    let embed = async {
        if cfg.embed_endpoint.is_empty() {
            return false;
        }
        client
            .post(format!(
                "{}/embeddings",
                cfg.embed_endpoint.trim_end_matches('/')
            ))
            .timeout(Duration::from_secs(3))
            .json(&serde_json::json!({ "model": cfg.embed_model, "input": "ok" }))
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    };
    tokio::join!(chat, embed)
}

// ---------- enqueue entry points ----------

/// Ensure the per-workspace worker exists and return its queue. `None` when
/// `ai.enabled` is off or no workspace is open — the two states callers treat
/// identically (no-op).
///
/// Callers must not hold the `state.settings` write guard — this resolves
/// settings itself (the settings-write path uses [`ensure_worker`] instead).
pub fn kick(app: &AppHandle, state: &Arc<WorkspaceState>) -> Option<mpsc::UnboundedSender<AiJob>> {
    settings(state)?;
    ensure_worker(app, state)
}

/// Spawn the worker if no live queue exists; returns the queue. Does not
/// check `ai.enabled` — callers resolve settings themselves (the
/// settings-write path calls this under its write guard).
fn ensure_worker(
    app: &AppHandle,
    state: &Arc<WorkspaceState>,
) -> Option<mpsc::UnboundedSender<AiJob>> {
    let (root, epoch) = state.workspace_snapshot()?;
    let mut slot = state.ai_queue.lock();
    if let Some(sender) = slot.as_ref() {
        if !sender.is_closed() {
            return Some(sender.clone());
        }
    }
    let (tx, rx) = mpsc::unbounded_channel();
    *slot = Some(tx.clone());
    tauri::async_runtime::spawn(run_worker(app.clone(), Arc::clone(state), root, epoch, rx));
    Some(tx)
}

/// Send-only fast path for `index_written_file` (which has no `AppHandle`):
/// enqueues `Changed` iff a queue already exists. The worker was spawned by
/// an earlier `kick`; a missed enqueue here is covered by the `ScanAll` after
/// each `index:complete`.
pub fn note_changed(state: &WorkspaceState, path: &Path) {
    if !is_markdown_file(path) {
        return;
    }
    if let Some(sender) = state.ai_queue.lock().as_ref() {
        let _ = sender.send(AiJob::Changed(path.to_path_buf()));
    }
}

/// Watcher entry point: external markdown change → ensure worker + `Changed`.
/// No-op for non-markdown paths and while `ai.enabled` is off.
pub fn note_markdown_event(app: &AppHandle, state: &Arc<WorkspaceState>, path: &Path) {
    if !is_markdown_file(path) {
        return;
    }
    if let Some(sender) = kick(app, state) {
        let _ = sender.send(AiJob::Changed(path.to_path_buf()));
    }
}

/// Post-settings-write hook, next to `mcp::apply_settings` inside
/// `with_global_settings_mut` — but called after the settings write guard is
/// dropped (the caller resolves `cfg` under the guard; taking
/// `workspace_root` under it would deadlock a concurrent workspace switch).
/// Enable or any `ai.*` change → `ScanAll`; disable → the queue is dropped,
/// which ends the worker.
pub fn apply_settings(app_state: &AppState, state: &Arc<WorkspaceState>, cfg: &AiSettings) {
    // Only act on an actual change — this hook runs on every global write,
    // and a ScanAll reads every note.
    {
        let mut applied = state.ai_applied.lock();
        if applied.as_ref() == Some(cfg) {
            return;
        }
        // An embed endpoint/model change invalidates stored vectors.
        if let Some(previous) = applied.as_ref() {
            if cfg.enabled
                && (previous.embed_endpoint != cfg.embed_endpoint
                    || previous.embed_model != cfg.embed_model)
            {
                let mut index = state.ai_index.write();
                for entry in index.notes.values_mut() {
                    entry.embedding = None;
                }
                index.touch();
            }
        }
        *applied = Some(cfg.clone());
    }

    if !cfg.enabled {
        // Dropping the sender closes the channel; the worker exits after its
        // current batch. The index stays — a re-enable doesn't re-embed.
        state.ai_queue.lock().take();
        return;
    }
    let Some(app) = app_state.app_handle() else {
        return;
    };
    if let Some(sender) = ensure_worker(&app, state) {
        let _ = sender.send(AiJob::ScanAll);
    }
}

// ---------- worker ----------

/// One worker per workspace, exited by channel close (sender dropped on
/// reset/disable) or an epoch that no longer matches. Commits and the
/// `ai:graph-changed` emit happen under `with_workspace_snapshot`, so a
/// workspace switch mid-batch discards the results.
async fn run_worker(
    app: AppHandle,
    state: Arc<WorkspaceState>,
    root: PathBuf,
    epoch: u64,
    mut rx: mpsc::UnboundedReceiver<AiJob>,
) {
    let client = match http_client() {
        Ok(client) => client,
        Err(error) => {
            eprintln!("[ai] failed to build http client: {error}");
            return;
        }
    };

    // Restore the persisted index once — embeddings only survive when the
    // embed config still matches.
    if let (Some(cfg), Some(path)) = (settings(&state), sidecar_path(&app, &root)) {
        let notes = load_sidecar(&path, &root, &cfg);
        if !notes.is_empty() {
            state.with_workspace_snapshot(&root, epoch, || {
                let mut index = state.ai_index.write();
                index.notes.extend(notes);
                index.touch();
            });
        }
    }

    'outer: loop {
        // Workspace moved on (reset bumps the epoch and drops the sender —
        // either check ends us).
        if state.with_workspace_snapshot(&root, epoch, || ()).is_none() {
            break;
        }

        let Some(job) = rx.recv().await else { break };

        // Debounce: keep collecting for 800 ms. `ScanAll` subsumes pending
        // `Changed` jobs; `Changed` dedupes by path.
        let mut scan_all = matches!(job, AiJob::ScanAll);
        let mut changed: HashSet<PathBuf> = HashSet::new();
        if let AiJob::Changed(path) = job {
            changed.insert(path);
        }
        loop {
            match tokio::time::timeout(DEBOUNCE, rx.recv()).await {
                Ok(Some(AiJob::ScanAll)) => {
                    scan_all = true;
                    changed.clear();
                }
                Ok(Some(AiJob::Changed(path))) => {
                    if !scan_all {
                        changed.insert(path);
                    }
                }
                Ok(None) => break 'outer,
                Err(_) => break,
            }
        }

        let Some(cfg) = settings(&state) else { break };
        let batch = if scan_all {
            BatchKind::ScanAll
        } else {
            BatchKind::Changed(changed)
        };
        process_batch(&app, &client, &state, &cfg, &root, epoch, batch).await;
    }
}

/// What one debounced pass processes: the whole index, or a deduped path set.
enum BatchKind {
    ScanAll,
    Changed(HashSet<PathBuf>),
}

/// One debounced batch: a `ScanAll` walks every indexed markdown file (and
/// prunes entries for files no longer indexed); `Changed` paths are re-read
/// or, when gone, dropped. Links always update; embeddings only for notes
/// whose hash changed or whose vector is missing — and only when an embed
/// endpoint is configured.
async fn process_batch(
    app: &AppHandle,
    client: &reqwest::Client,
    state: &Arc<WorkspaceState>,
    cfg: &AiSettings,
    root: &Path,
    epoch: u64,
    batch: BatchKind,
) {
    let indexed_markdown: Vec<PathBuf> = state
        .file_index
        .read()
        .iter()
        .map(|file| file.path.clone())
        .filter(|path| is_markdown_file(path))
        .collect();
    let file_set: HashSet<PathBuf> = indexed_markdown.iter().cloned().collect();

    let targets: Vec<PathBuf> = match batch {
        BatchKind::ScanAll => {
            let committed = state.with_workspace_snapshot(root, epoch, || {
                let mut index = state.ai_index.write();
                index.notes.retain(|path, _| file_set.contains(path));
                index.touch();
                index.pending = indexed_markdown.len();
            });
            if committed.is_none() {
                return;
            }
            indexed_markdown
        }
        BatchKind::Changed(changed) => {
            let paths: Vec<PathBuf> = changed.into_iter().collect();
            let committed = state.with_workspace_snapshot(root, epoch, || {
                state.ai_index.write().pending = paths.len();
            });
            if committed.is_none() {
                return;
            }
            paths
        }
    };

    let mut embed_jobs: Vec<(PathBuf, String)> = Vec::new();
    for path in &targets {
        let Ok(bytes) = tokio::fs::read(path).await else {
            // Deleted or unreadable → drop the entry.
            state.with_workspace_snapshot(root, epoch, || {
                let mut index = state.ai_index.write();
                index.notes.remove(path);
                index.touch();
                index.pending = index.pending.saturating_sub(1);
            });
            continue;
        };
        let hash = fnv1a64(&bytes);
        let content = String::from_utf8_lossy(&bytes);
        let raw_targets = extract_wiki_links(&content);
        let mut links = resolve_links(&raw_targets, root, &file_set);
        let own = path.to_string_lossy();
        links.retain(|target| target != &*own);
        // Formula-relation source — local and cheap, so it always refreshes
        // with the file, even when embeddings are off or the endpoint is down.
        let math_blocks = extract_math_blocks(&content);

        let previous = state.ai_index.read().notes.get(path).cloned();
        let needs_embed = !cfg.embed_endpoint.is_empty()
            && match previous.as_ref() {
                // A changed hash or a missing vector → re-embed.
                Some(entry) => entry.hash != hash || entry.embedding.is_none(),
                None => true,
            };

        // An empty projection (frontmatter-only, code-only, blank note) has
        // nothing to embed — and an empty string in the batch is rejected by
        // the endpoint, poisoning the whole request. Mark it with an empty
        // vector instead: `cosine` scores it 0 and the hash gate keeps it
        // out of future batches until the content changes.
        let projection = if needs_embed {
            embed_projection(&content)
        } else {
            String::new()
        };
        let embeddable = needs_embed && !projection.trim().is_empty();
        if embeddable {
            embed_jobs.push((path.clone(), projection));
        }

        let committed = state.with_workspace_snapshot(root, epoch, || {
            // The stored vector survives only while the content hash matches.
            let (kept_embedding, kept_tags) = match previous {
                Some(entry) if entry.hash == hash => (entry.embedding, entry.suggested_tags),
                Some(entry) => (None, entry.suggested_tags),
                None => (None, Vec::new()),
            };
            let embedding = if needs_embed && !embeddable {
                Some(Vec::new())
            } else {
                kept_embedding
            };
            let mut index = state.ai_index.write();
            index.notes.insert(
                path.clone(),
                NoteEntry {
                    hash,
                    embedding,
                    links,
                    math_blocks,
                    suggested_tags: kept_tags,
                },
            );
            index.touch();
            index.pending = index.pending.saturating_sub(1);
        });
        if committed.is_none() {
            return;
        }
    }

    if !embed_jobs.is_empty() {
        for chunk in embed_jobs.chunks(EMBED_BATCH) {
            let texts: Vec<String> = chunk.iter().map(|(_, text)| text.clone()).collect();
            match embed_batch(client, cfg, &texts).await {
                Ok(vectors) => {
                    let applied = state.with_workspace_snapshot(root, epoch, || {
                        let mut index = state.ai_index.write();
                        for ((path, _), vector) in chunk.iter().zip(vectors) {
                            if let Some(entry) = index.notes.get_mut(path) {
                                entry.embedding = Some(vector);
                            }
                        }
                        index.touch();
                    });
                    if applied.is_none() {
                        return;
                    }
                }
                // Endpoint down/unreachable → links-only mode for this batch;
                // the entries keep `embedding: None` so a later scan retries.
                Err(error) => {
                    eprintln!("[ai] embed batch failed: {error}");
                    break;
                }
            }
        }
    }

    // Persist + notify — only while the workspace is still ours.
    let persisted = state.with_workspace_snapshot(root, epoch, || {
        state.ai_index.write().pending = 0;
        if let Some(path) = sidecar_path(app, root) {
            save_sidecar(&path, root, cfg, &state.ai_index.read());
        }
    });
    if persisted.is_some() {
        let _ = app.emit(
            "ai:graph-changed",
            WorkspaceIdentity {
                root: root.to_string_lossy().into_owned(),
                epoch,
            },
        );
    }
}

// ---------- tests ----------

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(enabled: bool) -> AiSettings {
        AiSettings {
            enabled,
            chat_endpoint: String::new(),
            chat_model: String::new(),
            chat_key: String::new(),
            fallback_endpoint: String::new(),
            fallback_key: String::new(),
            embed_endpoint: String::new(),
            embed_model: String::new(),
        }
    }

    #[test]
    fn extract_wiki_links_skips_frontmatter_fences_and_inline_code() {
        let content = "---\ntags: [a]\nlink: \"[[not-a-link]]\"\n---\n\
             See [[Real Note]] and ![[embed.png]].\n\
             ```\n[[in-fence]]\n```\n\
             Inline `[[in-code]]` and [[Second|alias]].\n";
        assert_eq!(
            extract_wiki_links(content),
            vec!["Real Note", "embed.png", "Second|alias"]
        );
    }

    #[test]
    fn extract_wiki_links_handles_tilde_fences_and_unclosed_inline_code() {
        let content = "~~~\n[[skip]]\n~~~\n`unclosed [[skip-too]]\n[[kept]]";
        assert_eq!(extract_wiki_links(content), vec!["kept"]);
    }

    #[test]
    fn normalize_wiki_target_splits_alias_fragment_and_extension() {
        assert_eq!(normalize_wiki_target("Note|alias"), "Note");
        assert_eq!(normalize_wiki_target("Dir/Note#Heading"), "Dir/Note");
        assert_eq!(normalize_wiki_target("/abs/Path.MD"), "abs/Path");
        assert_eq!(normalize_wiki_target("dir\\note.markdown"), "dir/note");
        assert_eq!(normalize_wiki_target("a\\|b"), "a|b");
    }

    #[test]
    fn resolve_links_probes_paths_and_unique_stems() {
        let root = Path::new("/vault");
        let files: HashSet<PathBuf> = [
            "/vault/unique.md",
            "/vault/dir/note.markdown",
            "/vault/a/dup.md",
            "/vault/b/dup.md",
        ]
        .iter()
        .map(PathBuf::from)
        .collect();

        // Bare stem: unique match only.
        assert_eq!(
            resolve_links(&["unique".into()], root, &files),
            vec!["/vault/unique.md"]
        );
        assert!(resolve_links(&["dup".into()], root, &files).is_empty());
        // Slash path probes .md then .markdown, case-insensitive stem.
        assert_eq!(
            resolve_links(&["dir/note".into()], root, &files),
            vec!["/vault/dir/note.markdown"]
        );
        assert!(resolve_links(&["dir/missing".into()], root, &files).is_empty());
        // Deduped.
        assert_eq!(
            resolve_links(&["unique".into(), "unique|x".into()], root, &files),
            vec!["/vault/unique.md"]
        );
    }

    #[test]
    fn embed_projection_strips_noise_and_keeps_prose() {
        let content = "---\ntitle: x\n---\n\
             # Limits\nSee [[Other Note|the other note]].\n\
             ```rust\nfn main() {}\n```\n\
             Inline $\\frac{1}{2}$ and display $$\\int_0^1 x$$ here.\n\
             Cost is $5 and $10.\n";
        let projection = embed_projection(content);
        assert!(projection.contains("# Limits"));
        assert!(projection.contains("the other note"));
        assert!(!projection.contains("fn main"));
        assert!(projection.contains("frac{1}{2}"));
        assert!(projection.contains("int_0^1 x"));
        assert!(projection.contains("$5 and $10"));
        assert!(!projection.contains("title: x"));
    }

    #[test]
    fn cosine_and_similarity_edges_behave() {
        assert!((cosine(&[1.0, 0.0], &[1.0, 0.0]) - 1.0).abs() < 1e-6);
        assert!(cosine(&[1.0, 0.0], &[0.0, 1.0]).abs() < 1e-6);
        assert_eq!(cosine(&[1.0], &[1.0, 0.0]), 0.0);
        assert_eq!(cosine(&[], &[]), 0.0);

        let mut index = AiIndex::default();
        let a = PathBuf::from("/v/a.md");
        let b = PathBuf::from("/v/b.md");
        let c = PathBuf::from("/v/c.md");
        let mut entry = |embedding: Vec<f32>| NoteEntry {
            hash: 0,
            embedding: Some(embedding),
            links: Vec::new(),
            math_blocks: Vec::new(),
            suggested_tags: Vec::new(),
        };
        index.notes.insert(a.clone(), entry(vec![1.0, 0.0]));
        index.notes.insert(b.clone(), entry(vec![0.9, 0.1]));
        index.notes.insert(c.clone(), entry(vec![0.0, 1.0]));
        index.notes.insert(
            PathBuf::from("/v/d.md"),
            NoteEntry {
                embedding: None,
                ..entry(vec![])
            },
        );

        let edges = similarity_edges(&index, 0.5, 1);
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].0, a);
        assert_eq!(edges[0].1, b);
        assert!(edges[0].2 > 0.99);
    }

    #[test]
    fn similarity_edges_cached_recomputes_on_generation_or_param_change() {
        let mut index = AiIndex::default();
        let a = PathBuf::from("/v/a.md");
        let b = PathBuf::from("/v/b.md");
        let c = PathBuf::from("/v/c.md");
        let entry = |embedding: Vec<f32>| NoteEntry {
            hash: 0,
            embedding: Some(embedding),
            links: Vec::new(),
            math_blocks: Vec::new(),
            suggested_tags: Vec::new(),
        };
        index.notes.insert(a.clone(), entry(vec![1.0, 0.0]));
        index.notes.insert(b.clone(), entry(vec![0.9, 0.1]));
        index.touch();

        let first: Vec<_> = index.similarity_edges_cached(0.5, 5).to_vec();
        assert_eq!(first.len(), 1);

        // Same generation + params → the cached list comes straight back.
        let again: Vec<_> = index.similarity_edges_cached(0.5, 5).to_vec();
        assert_eq!(again, first);

        // A mutation without `touch` is a caller bug — the cache contract is
        // "mutate, then touch". Touching re-scores and picks the new note up.
        index.notes.insert(c.clone(), entry(vec![0.95, 0.05]));
        index.touch();
        let second: Vec<_> = index.similarity_edges_cached(0.5, 5).to_vec();
        assert!(second.len() > first.len());

        // Different parameters are a different query, not a stale hit.
        let stricter: Vec<_> = index.similarity_edges_cached(0.999, 5).to_vec();
        assert_eq!(stricter.len(), 0);
    }

    #[test]
    fn sidecar_round_trips_and_drops_embeddings_on_endpoint_change() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let note_path = root.join("note.md");
        std::fs::write(&note_path, "# hi").unwrap();

        let mut index = AiIndex::default();
        index.notes.insert(
            note_path.clone(),
            NoteEntry {
                hash: 42,
                embedding: Some(vec![0.1, 0.2]),
                links: vec!["/other.md".into()],
                math_blocks: vec![MathBlock {
                    normalized: "E = m c ^ 2".into(),
                    line: 7,
                    source: "E = mc^2".into(),
                }],
                suggested_tags: vec!["math".into()],
            },
        );

        let cfg = AiSettings {
            embed_endpoint: "http://e".into(),
            embed_model: "m".into(),
            ..cfg(true)
        };
        let path = root.join("ai-graph/test.json");
        save_sidecar(&path, root, &cfg, &index);

        let loaded = load_sidecar(&path, root, &cfg);
        let entry = loaded.get(&note_path).unwrap();
        assert_eq!(entry.hash, 42);
        assert_eq!(entry.embedding, Some(vec![0.1, 0.2]));
        assert_eq!(entry.links, vec!["/other.md"]);
        assert_eq!(entry.math_blocks.len(), 1);
        assert_eq!(entry.math_blocks[0].line, 7);
        assert_eq!(entry.suggested_tags, vec!["math"]);

        // Endpoint changed → vectors dropped, the rest kept.
        let other_cfg = AiSettings {
            embed_endpoint: "http://other".into(),
            ..cfg.clone()
        };
        let loaded = load_sidecar(&path, root, &other_cfg);
        let entry = loaded.get(&note_path).unwrap();
        assert_eq!(entry.embedding, None);
        assert_eq!(entry.suggested_tags, vec!["math"]);

        // Missing files are skipped.
        std::fs::remove_file(&note_path).unwrap();
        assert!(load_sidecar(&path, root, &cfg).is_empty());
    }

    #[test]
    fn parse_tags_response_extracts_normalizes_and_caps() {
        assert_eq!(
            parse_tags_response("Here you go: {\"tags\": [\"Math\", \"Set Theory\", \"math\"]}"),
            vec!["math", "set-theory"]
        );
        assert_eq!(parse_tags_response("[\"a\", \"b\"]"), vec!["a", "b"]);
        let many = parse_tags_response(
            "{\"tags\":[\"1\",\"2\",\"3\",\"4\",\"5\",\"6\",\"7\",\"8\",\"9\"]}",
        );
        assert_eq!(many.len(), 3);
        assert!(parse_tags_response("no json at all").is_empty());
        assert!(parse_tags_response("{\"tags\": []}").is_empty());
    }

    #[test]
    fn chat_fallback_classifier_treats_4xx_and_parse_as_config_errors() {
        assert!(ChatError::Transport("refused".into()).is_fallback_worthy());
        assert!(ChatError::Http(500).is_fallback_worthy());
        assert!(ChatError::Http(503).is_fallback_worthy());
        assert!(!ChatError::Http(400).is_fallback_worthy());
        assert!(!ChatError::Http(401).is_fallback_worthy());
        assert!(!ChatError::Parse("bad json".into()).is_fallback_worthy());
    }

    #[test]
    fn normalize_math_collapses_cosmetic_differences() {
        assert_eq!(normalize_math("E = mc^2"), normalize_math("E = mc^{2}"));
        assert_eq!(normalize_math("E = mc^2"), normalize_math("E\\,=\\,mc^2"));
        assert_eq!(
            normalize_math("\\int_0^1 x"),
            normalize_math("\\int_{0}^{1} x")
        );
        assert_eq!(
            normalize_math("\\left( a+b \\right)"),
            normalize_math("(a+b)")
        );
        assert_eq!(normalize_math("x_{i}"), normalize_math("x_i"));
        // Whitespace is a separator only — the command boundary is real.
        assert_ne!(normalize_math("\\alpha x"), normalize_math("\\alphax"));
        // `\sqrt xy` takes only `x`; `\sqrt{xy}` takes the group — different.
        assert_ne!(normalize_math("\\sqrt{xy}"), normalize_math("\\sqrt xy"));
    }

    #[test]
    fn extract_math_blocks_finds_lines_and_skips_noise() {
        let content = "---\ntitle: x\n---\n\
             # Note\n\n\
             $$\nE = mc^{2}\n$$\n\n\
             Inline $v = \\frac{d}{t}$ here.\n\n\
             ```\n$$ inside fence $$\n```\n\n\
             `$$ in code$$`\n\n\
             \\[ a^2 + b^2 = c^2 \\]\n\n\
             Cost $5 and $10, var $x$.\n";
        let blocks = extract_math_blocks(content);
        assert_eq!(blocks.len(), 3);
        // `$$` opens on line 6 but the formula's first content line is 7.
        assert_eq!(
            (blocks[0].line, blocks[0].source.as_str()),
            (7, "E = mc^{2}")
        );
        assert_eq!(blocks[0].normalized, normalize_math("E=mc^2"));
        assert_eq!(
            (blocks[1].line, blocks[1].source.as_str()),
            (10, "v = \\frac{d}{t}")
        );
        assert_eq!(blocks[2].line, 18);
    }

    #[test]
    fn formula_relations_pairs_across_notes_only() {
        let note_a = PathBuf::from("/v/a.md");
        let note_b = PathBuf::from("/v/b.md");
        let note_c = PathBuf::from("/v/c.md");
        let block = |normalized: &str, line: u32, source: &str| MathBlock {
            normalized: normalized.into(),
            line,
            source: source.into(),
        };
        let shared = normalize_math("E=mc^2");

        let mut index = AiIndex::default();
        index.notes.insert(
            note_a.clone(),
            NoteEntry {
                math_blocks: vec![block(&shared, 7, "E = mc^{2}")],
                ..Default::default()
            },
        );
        index.notes.insert(
            note_b.clone(),
            NoteEntry {
                math_blocks: vec![block(&shared, 12, "E=mc^2")],
                ..Default::default()
            },
        );
        index.notes.insert(
            note_c.clone(),
            NoteEntry {
                math_blocks: vec![
                    block("x ^ 2", 3, "x^2"),
                    // Two occurrences in one note — a same-note pair is not
                    // a relation, but both match a's and b's copies.
                    block(&shared, 30, "E = mc^2"),
                    block(&shared, 40, "E = mc^2"),
                ],
                ..Default::default()
            },
        );

        let relations = formula_relations(&index);
        // One relation per (note pair, formula): a–b, a–c, b–c — c's second
        // occurrence does not multiply the pair into more relations.
        assert_eq!(relations.len(), 3);
        let ab = &relations[0];
        assert_eq!((ab.a_path.as_path(), ab.a_line), (note_a.as_path(), 7));
        assert_eq!((ab.b_path.as_path(), ab.b_line), (note_b.as_path(), 12));
        // Each side keeps its own source line — the needle for that file —
        // and c's earliest occurrence is the one reported.
        assert_eq!(ab.a_snippet, "E = mc^{2}");
        assert_eq!(ab.b_snippet, "E=mc^2");
        let ac = relations
            .iter()
            .find(|r| r.a_path == note_a && r.b_path == note_c)
            .expect("a–c relation");
        assert_eq!(ac.b_line, 30);
        assert!(relations.iter().all(|r| r.a_path != r.b_path));
    }

    #[test]
    fn formula_relations_repeat_blocks_do_not_multiply() {
        // The measured blowup: one formula repeated many times in each of a
        // few notes must stay linear in note pairs, not block pairs.
        let shared = normalize_math("E=mc^2");
        let mut index = AiIndex::default();
        for name in ["a.md", "b.md", "c.md"] {
            index.notes.insert(
                PathBuf::from(format!("/v/{name}")),
                NoteEntry {
                    math_blocks: (0..500)
                        .map(|i| MathBlock {
                            normalized: shared.clone(),
                            line: i,
                            source: "E=mc^2".into(),
                        })
                        .collect(),
                    ..Default::default()
                },
            );
        }
        let relations = formula_relations(&index);
        assert_eq!(relations.len(), 3);
        assert!(relations.iter().all(|r| r.a_line == 0 && r.b_line == 0));
    }
}
