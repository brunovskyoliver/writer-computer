//! AI IPC surface — SPECs/ai-note-graph/contracts/ipc-and-events.md.
//!
//! Every command gates on `ai.enabled` first and returns the empty/disabled
//! shape when off: no network, no index work. `ai_suggest_tags` is the only
//! command that errors on a missing configuration — the user explicitly
//! invoked it, so a silent empty result would hide a setup mistake.

use crate::ai::{self, AiJob};
use crate::error::AppError;
use crate::state::AppState;
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::{Emitter, Manager};

#[derive(Debug, Serialize)]
pub struct AiStatus {
    pub enabled: bool,
    /// `GET {chat_endpoint}/models` answered 2xx within 3 s.
    pub chat_ok: bool,
    /// `POST {embed_endpoint}/embeddings` probe answered 2xx within 3 s.
    pub embed_ok: bool,
    /// Notes currently in the AI index.
    pub indexed: usize,
    /// Queued + in-flight re-index work.
    pub pending: usize,
}

#[derive(Debug, Serialize)]
pub struct AiGraphNode {
    /// Absolute path — the node id and the `openFile` target.
    pub path: String,
    /// File stem, shown as the label.
    pub name: String,
    /// Last suggested-tag set stored for this note (drives the tag glyph).
    pub suggested_tags: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AiEdgeKind {
    Link,
    Similar,
    /// Both notes contain the same normalized formula (line-relations-spec).
    Formula,
}

#[derive(Debug, Serialize)]
pub struct AiGraphEdge {
    pub source: String,
    pub target: String,
    pub kind: AiEdgeKind,
    /// Cosine score for `similar` edges; `None` for `link` edges.
    pub score: Option<f32>,
}

#[derive(Debug, Serialize)]
pub struct AiGraph {
    pub nodes: Vec<AiGraphNode>,
    pub edges: Vec<AiGraphEdge>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RelatedKind {
    /// Shares a normalized formula — carries `line` + `snippet`.
    Formula,
    /// Cosine neighbour — carries `score`.
    Similar,
}

#[derive(Debug, Serialize)]
pub struct RelatedItem {
    pub kind: RelatedKind,
    pub path: String,
    /// Line of the shared formula in `path` (formula kind only).
    pub line: Option<u32>,
    /// Cosine score (similar kind only).
    pub score: Option<f32>,
    /// First source line of the shared formula (formula kind only) — the
    /// card preview and the needle the line-target lookup re-finds.
    pub snippet: Option<String>,
}

#[tauri::command]
pub async fn ai_status(
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<AiStatus, AppError> {
    let state = app.state::<AppState>().get_or_create(webview.label());
    let Some(cfg) = ai::settings(&state) else {
        return Ok(AiStatus {
            enabled: false,
            chat_ok: false,
            embed_ok: false,
            indexed: 0,
            pending: 0,
        });
    };
    let (indexed, pending) = {
        let index = state.ai_index.read();
        (index.notes.len(), index.pending)
    };
    let (chat_ok, embed_ok) = ai::probe_endpoints(&cfg).await;
    Ok(AiStatus {
        enabled: true,
        chat_ok,
        embed_ok,
        indexed,
        pending,
    })
}

#[tauri::command]
pub fn ai_graph(webview: tauri::Webview, app: tauri::AppHandle) -> Result<AiGraph, AppError> {
    let state = app.state::<AppState>().get_or_create(webview.label());
    if ai::settings(&state).is_none() {
        return Ok(AiGraph {
            nodes: Vec::new(),
            edges: Vec::new(),
        });
    }
    state.workspace_snapshot().ok_or(AppError::NoWorkspace)?;

    // Nodes come from the file index — every indexed markdown note is a
    // node, including ones with no links or embedding yet.
    let files = state.file_index.read();
    // Write guard: the similarity edge list is cached inside the index and
    // refreshed on demand — see `AiIndex::similarity_edges_cached`.
    let mut index = state.ai_index.write();
    let nodes: Vec<AiGraphNode> = files
        .iter()
        .filter(|file| crate::commands::fs::is_markdown_file(&file.path))
        .map(|file| AiGraphNode {
            path: file.path.to_string_lossy().into_owned(),
            name: file
                .path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or(&file.name)
                .to_string(),
            suggested_tags: index
                .notes
                .get(&file.path)
                .map(|entry| entry.suggested_tags.clone())
                .unwrap_or_default(),
        })
        .collect();
    let node_paths: HashSet<&str> = nodes.iter().map(|node| node.path.as_str()).collect();

    let mut edges = Vec::new();
    let mut link_pairs: HashSet<(String, String)> = HashSet::new();
    for (path, entry) in &index.notes {
        let source = path.to_string_lossy();
        for target in &entry.links {
            if !node_paths.contains(target.as_str()) {
                continue;
            }
            if link_pairs.insert((source.clone().into_owned(), target.clone())) {
                edges.push(AiGraphEdge {
                    source: source.clone().into_owned(),
                    target: target.clone(),
                    kind: AiEdgeKind::Link,
                    score: None,
                });
            }
        }
    }

    for (source, target, score) in
        index.similarity_edges_cached(ai::SIMILARITY_FLOOR, ai::SIMILARITY_TOP_K)
    {
        let source = source.to_string_lossy().into_owned();
        let target = target.to_string_lossy().into_owned();
        // A link edge already covers the pair — in either direction.
        if link_pairs.contains(&(source.clone(), target.clone()))
            || link_pairs.contains(&(target.clone(), source.clone()))
        {
            continue;
        }
        edges.push(AiGraphEdge {
            source,
            target,
            kind: AiEdgeKind::Similar,
            score: Some(*score),
        });
    }

    // Formula edges: one per note pair sharing ≥1 normalized formula,
    // skipping pairs a wikilink already connects (same rule as similar).
    let mut formula_pairs: HashSet<(String, String)> = HashSet::new();
    for relation in ai::formula_relations(&index) {
        let a = relation.a_path.to_string_lossy().into_owned();
        let b = relation.b_path.to_string_lossy().into_owned();
        if !node_paths.contains(a.as_str()) || !node_paths.contains(b.as_str()) {
            continue;
        }
        if link_pairs.contains(&(a.clone(), b.clone()))
            || link_pairs.contains(&(b.clone(), a.clone()))
        {
            continue;
        }
        if formula_pairs.insert((a.clone(), b.clone())) {
            edges.push(AiGraphEdge {
                source: a,
                target: b,
                kind: AiEdgeKind::Formula,
                score: None,
            });
        }
    }

    Ok(AiGraph { nodes, edges })
}

#[tauri::command]
pub async fn ai_suggest_tags(
    path: String,
    content: String,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<Vec<String>, AppError> {
    let state = app.state::<AppState>().get_or_create(webview.label());
    let cfg = ai::settings(&state)
        .ok_or_else(|| AppError::Io("AI is disabled — enable it in Settings → AI".into()))?;
    if cfg.chat_endpoint.is_empty() {
        return Err(AppError::Io("ai.chat-endpoint is not configured".into()));
    }
    let client = ai::http_client().map_err(AppError::Io)?;
    let tags = ai::suggest_tags(&client, &cfg, &content)
        .await
        .map_err(|error| AppError::Io(error.to_string()))?;

    // Store into the note entry so the graph node can show the suggestion
    // state, and nudge the graph open if it's mounted.
    if let Some((root, epoch)) = state.workspace_snapshot() {
        let note_path = PathBuf::from(&path);
        let stored = tags.clone();
        state.with_workspace_snapshot(&root, epoch, || {
            let mut index = state.ai_index.write();
            index.notes.entry(note_path).or_default().suggested_tags = stored;
            index.touch();
        });
        let _ = app.emit(
            "ai:graph-changed",
            crate::watcher::WorkspaceIdentity {
                root: root.to_string_lossy().into_owned(),
                epoch,
            },
        );
    }
    Ok(tags)
}

#[tauri::command]
pub fn ai_related(
    path: String,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<Vec<RelatedItem>, AppError> {
    let state = app.state::<AppState>().get_or_create(webview.label());
    if ai::settings(&state).is_none() {
        return Ok(Vec::new());
    }
    let index = state.ai_index.read();
    let note_path = Path::new(&path);

    // Shared-formula relations first — the strongest evidence. Each item
    // points at the formula's line in the *other* note, and its snippet is
    // that note's own first source line so the jump can re-find it exactly.
    let mut items: Vec<RelatedItem> = Vec::new();
    for relation in ai::formula_relations(&index) {
        let other = if relation.a_path == note_path {
            Some((&relation.b_path, relation.b_line, &relation.b_snippet))
        } else if relation.b_path == note_path {
            Some((&relation.a_path, relation.a_line, &relation.a_snippet))
        } else {
            None
        };
        if let Some((path, line, snippet)) = other {
            items.push(RelatedItem {
                kind: RelatedKind::Formula,
                path: path.to_string_lossy().into_owned(),
                line: Some(line),
                score: None,
                snippet: Some(snippet.clone()),
            });
            if items.len() >= ai::FORMULA_RELATED_CAP {
                break;
            }
        }
    }

    for (path, score) in ai::related(&index, note_path, ai::RELATED_FLOOR, ai::RELATED_TOP_K) {
        items.push(RelatedItem {
            kind: RelatedKind::Similar,
            path: path.to_string_lossy().into_owned(),
            line: None,
            score: Some(score),
            snippet: None,
        });
    }
    Ok(items)
}

#[tauri::command]
pub fn ai_rescan(webview: tauri::Webview, app: tauri::AppHandle) -> Result<(), AppError> {
    let state = app.state::<AppState>().get_or_create(webview.label());
    if let Some(sender) = ai::kick(&app, &state) {
        let _ = sender.send(AiJob::ScanAll);
    }
    Ok(())
}
