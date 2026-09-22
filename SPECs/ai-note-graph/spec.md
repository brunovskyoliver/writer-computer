# AI Note Graph Spec

Research: [`research.md`](research.md) (R1–R11). This spec assumes it.

## Summary

An opt-in AI layer that indexes workspace notes against a user-configured
local/OpenAI-compatible endpoint, builds a relation graph (explicit
`[[wikilinks]]` + embedding similarity), renders it as an Obsidian-style
force graph tab, and offers per-note suggested tags that write to
frontmatter **only on explicit accept**. All inference and indexing run in
Rust off the webview thread; AI never rewrites a note on its own.

## Goals

- `ai.*` settings under a new **AI** category, global scope, default off.
- Background index: per-note wikilink edges, text-projection embeddings,
  cosine top-k similarity edges. Incremental on save/external change; full
  pass after `index:complete`. Persisted to a sidecar in the app data dir —
  never inside the workspace.
- `Graph` page-kind tab: canvas force-directed graph, link edges vs
  similarity edges visually distinct, click a node to open the note.
- Per-note AI surface: "suggested tags" (chat model, JSON-schema output)
  accepted individually or all — accepted tags merge into frontmatter
  `tags:` through the normal save path (`updateFrontmatter` for open files,
  `write_file` for closed ones). Plus a "related notes" list from the
  embedding index for quick switching.
- Chat endpoint fallback: primary → fallback on connect error/timeout/5xx.
- Status surface in Settings showing endpoint reachability and indexed
  count.

## Non-Goals

- Writing tags or any AI output to notes without an explicit user click.
- Editing the vault config, storing anything inside the workspace, or
  touching `.writer/`.
- Local-graph depth view, group colouring, filters (Obsidian parity
  extras) — follow-ups.
- `#tag` indexing/chips — that is `SPECs/tags-spec.md`, a separate feature;
  suggested tags here become frontmatter `tags:` on accept.
- Reranker pass (`/v1/rerank`) — noted in research as a later sharpening.

## Settings (all `scope: "global"`, category `AI`)

| Key                         | Type    | Default                    | Purpose                                                                    |
| --------------------------- | ------- | -------------------------- | -------------------------------------------------------------------------- |
| `ai.enabled`                | boolean | `false`                    | Master switch; off = zero network calls                                    |
| `ai.chat-endpoint`          | string  | `http://127.0.0.1:8000/v1` | OpenAI-compatible chat base                                                |
| `ai.chat-model`             | string  | `""`                       | Model id for tag suggestions                                               |
| `ai.chat-api-key`           | string  | `""`                       | Bearer for primary                                                         |
| `ai.chat-fallback-endpoint` | string  | `""`                       | Optional second base                                                       |
| `ai.chat-fallback-api-key`  | string  | `""`                       | Bearer for fallback                                                        |
| `ai.embed-endpoint`         | string  | `""`                       | Embedding base (`{base}/embeddings`, no `/v1` forced — TEI mounts at root) |
| `ai.embed-model`            | string  | `""`                       | Embedding model id                                                         |

API keys live only in the user's global config file. The schema defaults
are generic; no real endpoint or key ships in the repo.

## Rust design

New `ai.rs` module + `commands/ai.rs`.

- `AiSettings` resolved per-window from `WorkspaceState.settings`
  (global-only keys → `get_global_or_default`).
- `AiIndex` on `WorkspaceState`: `HashMap<PathBuf, NoteEntry>` where
  `NoteEntry { hash: u64, embedding: Option<Vec<f32>>, links: Vec<String>,
suggested_tags: Vec<String> }`. Reset with the other workspace runtime
  state; persisted to `app_data_dir()/ai-graph/<hash-of-root>.json`.
- Worker: one tokio task per workspace, fed by an
  `mpsc::UnboundedSender<AiJob>` slot on `WorkspaceState`
  (`AiJob::ScanAll | AiJob::Changed(PathBuf)`). Changed jobs debounce ~800 ms
  and dedupe; the worker guards every write with `with_workspace_snapshot`
  (captured root+epoch) so a workspace switch drops stale results.
- Triggers: `index_written_file` (self-saves), the watcher loop's
  `fs:file-changed` path (external changes; deleted files drop the node),
  `index:complete` emit site and the `index_workspace` command (ScanAll).
  All enqueue calls are no-ops when `ai.enabled` is false or no embed/chat
  endpoint is configured.
- Embedding input is a _text projection_: frontmatter stripped, fenced code
  and `$…$`/`$$…$$` math removed, `[[x|y]]` → `y`. Raw LaTeX embeds badly
  (research R9).
- Similarity edges: cosine over stored embeddings, top-3 per node above a
  floor threshold, symmetric pairs deduped keeping the higher score.
- Chat calls go through a fallback chain: primary endpoint, then
  `ai.chat-fallback-*` when configured. Tag extraction uses
  `response_format` JSON schema `{tags: string[]}`.

### Commands

- `ai_status() -> { enabled, chat_ok, embed_ok, indexed, pending }` —
  endpoint probes with a short timeout, for the Settings surface.
- `ai_graph() -> { nodes: [{path, name, suggested_tags}], edges:
[{source, target, kind, score?}] }` — nodes from the markdown file index;
  edges = resolved links + similarity pairs.
- `ai_suggest_tags(path, content) -> Vec<String>` — content arrives from
  the frontend (the open buffer may be ahead of disk); result is stored in
  the index entry and returned.
- `ai_related(path) -> Vec<{path, score}>` — top-k cosine neighbors.
- `ai_rescan()` — enqueue `ScanAll`.

## Frontend design

- `lib/ai.ts`: IPC wrappers + `applyTags(path, tags)` — merges into
  frontmatter (`yaml-entries` helpers); open file →
  `editorApi.updateFrontmatter` (normal dirty/autosave flow), closed file →
  `readFile` + merge + `writeFile` (the normal save path, self-write
  suppression included).
- `page-kinds/graph.ts`: `{ kind: "graph" }`, title "Graph", `keepAlive`,
  serializes (restored across sessions like settings). View registered in
  `page-kinds/views.tsx` as `GraphPane`.
- `components/graph/graph-pane.tsx`: `react-force-graph-2d` behind
  `React.lazy` (new dep via catalog); fetches `ai_graph` on mount and on
  `ai:graph-changed` events (workspace-identity checked like
  `fs:file-changed`); bounded layout (`warmupTicks` + `cooldownTicks` +
  `autoPauseRedraw`); node click → `openFile`.
- Suggestions UI: a floating card over the editor area
  (`stores/ai-store.ts` holds `panelFor`, suggestions, related list) opened
  by palette command "AI: Suggest Tags for Current Note"; chips accept
  individually, "Add all" applies the rest; related notes click →
  `openFile`.
- Palette commands: "Open Graph" (workspace, non-compact), "AI: Suggest
  Tags for Current Note" (file tab + `ai.enabled`), "AI: Rescan Note
  Index".
- Settings: new `AI` category renders automatically from the schema; a
  `SECTION_EXTRAS` entry adds the `ai_status` line.

## Acceptance Criteria

- With `ai.enabled` off, nothing contacts any endpoint and no graph tab can
  be opened from the palette.
- With it on and the vault open, `ai_graph` returns link edges for
  `[[wikilinks]]` and similarity edges once embeddings land; the Graph tab
  renders them and clicking a node opens the note.
- "AI: Suggest Tags" lists model-proposed tags; accepting one writes
  frontmatter `tags:` through the save path (visible as a normal dirty/save
  cycle); nothing is written without a click.
- Saving or externally editing a note re-embeds just that note; deleting it
  drops its node.
- Primary chat endpoint down → calls fall back to the configured secondary.
