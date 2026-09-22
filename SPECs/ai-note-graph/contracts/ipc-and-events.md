# Contract: IPC Commands and Tauri Events

## New commands (`src-tauri/src/commands/ai.rs`)

All commands take `webview: tauri::Webview` + `app: tauri::AppHandle` like
the existing handlers, resolve `AppState::get_or_create(webview.label())`,
and error `AppError::NoWorkspace` where a workspace is required. Every one
of them checks `ai.enabled` first and returns the empty/disabled shape when
off — no network, no index work.

| Command           | Args                            | Returns                    | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------- | ------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ai_status`       | —                               | `AiStatus` (data-model.md) | `chat_ok`: `GET {chat_endpoint}/models` with Bearer, 3 s timeout; `embed_ok`: `POST {embed_endpoint}/embeddings` `{model, input: "ok"}`, 3 s timeout; both `false` when unconfigured. `indexed`/`pending` from `AiIndex`. No workspace needed for the probes.                                                                                                                                                                                                                                                  |
| `ai_graph`        | —                               | `AiGraph`                  | Nodes = `file_index` markdown entries; edges = resolved links + top-k similarity per data-model.md. Empty `nodes`/`edges` when disabled.                                                                                                                                                                                                                                                                                                                                                                       |
| `ai_suggest_tags` | `path: String, content: String` | `Vec<String>`              | `content` comes from the caller's buffer (an open file may be ahead of disk). Chat POST with `response_format` JSON schema `{tags: string[]}`; on HTTP 400 retries once without it; response parsed leniently (first JSON object/array). Tags normalized (lowercase, `-` for spaces), deduped, capped at 8, stored into the note's `NoteEntry.suggested_tags`. Primary endpoint first; connect/timeout/5xx falls back to `fallback_endpoint` when set; 4xx fails immediately (config error, not availability). |
| `ai_related`      | `path: String`                  | `Vec<RelatedNote>`         | Top-8 cosine neighbors over stored embeddings, floor 0.3. Empty when the note has no embedding.                                                                                                                                                                                                                                                                                                                                                                                                                |
| `ai_rescan`       | —                               | `()`                       | `ai::kick(app, state)` + send `AiJob::ScanAll`. No-op when disabled or no workspace.                                                                                                                                                                                                                                                                                                                                                                                                                           |

All five registered in `lib.rs` `generate_handler!` and wrapped in
`src/lib/tauri.ts`-adjacent `src/lib/ai.ts`.

## Worker lifecycle (`src-tauri/src/ai.rs`)

`ai::kick(app: &AppHandle, state: &Arc<WorkspaceState>)` — the single
entry point. No-ops when `ai.enabled` is off or there is no workspace
snapshot. When a live queue exists it is reused; otherwise a worker is
spawned on `tauri::async_runtime` holding a clone of the `Arc` state, the
`AppHandle`, and the captured `(root, epoch)` — commits always go through
`state.with_workspace_snapshot(&root, epoch, …)`, so a workspace switch
mid-flight discards results.

The worker loop: `rx.recv()` → collect more jobs for ≤800 ms (debounce;
`Changed` dedupes by path, `ScanAll` clears the set) → process → persist
sidecar → `app.emit("ai:graph-changed", WorkspaceIdentity)`. Exit
conditions: channel closed (sender dropped on workspace reset/window close)
or the captured epoch no longer matches `workspace_snapshot()`.

`ai::note_changed(state: &WorkspaceState, path: &Path)` — send-only fast
path for `index_written_file` (which has no `AppHandle`): sends
`AiJob::Changed` iff a queue exists. Coverage gap is closed by the
`ScanAll` after each `index:complete`.

`ai::apply_settings(app_state: &AppState, state: &WorkspaceState)` — called
inside `commands::settings::with_global_settings_mut` next to
`mcp::apply_settings`, so toggling `ai.enabled` or hand-editing the global
`config` (picked up by `start_global_config_watcher` → `reload_global_settings`)
kicks a `ScanAll` for the current workspace — and, on disable, drops the
queue (`ai_queue.take()`) which ends the worker.

### Trigger sites

| Site                                                      | Call                                                                         | Why                                                                   |
| --------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `commands/workspace.rs` after `index:complete` emit       | `ai::kick(&handle, &state)` + `ScanAll`                                      | Fresh index → full pass.                                              |
| `commands/search.rs` `index_workspace` after publish      | same                                                                         | Manual reindex = rescan.                                              |
| `watcher.rs` `fs:file-changed` emit branch, markdown only | `ai::note_markdown_event(&handle, &state, path)` → ensure-worker + `Changed` | External edits, creates, deletes.                                     |
| `state.rs` `index_written_file`                           | `ai::note_changed(&self, path)` (send-only)                                  | Self-saves; watcher self-write suppression hides these from the loop. |
| `commands/settings.rs` `with_global_settings_mut`         | `ai::apply_settings`                                                         | Enable → scan; disable → drop worker.                                 |

Enqueue is a no-op when the path is not a Markdown file
(`fs::is_markdown_file`) — drawings and PDFs never enter the AI index.

## Events

| Event              | Payload                             | Producer                                                                                                               | Consumer                                                                               |
| ------------------ | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `ai:graph-changed` | `WorkspaceIdentity { root, epoch }` | Worker, after each committed batch — broadcast via `app.emit` (the worker has no window label; every consumer filters) | `use-file-watcher.ts`: `isWorkspaceEventCurrent` guard → `ai-store.bumpGraphVersion()` |

No new events for `fs:file-changed`/`index:complete` — the worker hooks
those sites in Rust directly.

## HTTP contract

- **Chat** `POST {chat_endpoint}/chat/completions`, `Authorization: Bearer`
  when a key is configured. Body: `{model, messages, temperature: 0.2,
max_tokens: 256, response_format: {type: "json_schema", json_schema:
{name: "note_tags", schema: {type:"object", properties:{tags:{type:"array",
items:{type:"string"}}, required:["tags"], additionalProperties:false}}}}`.
  Timeout 120 s.
- **Embeddings** `POST {embed_endpoint}/embeddings` `{model, input: string[]}`
  (≤32 inputs per request, sequential batches). Timeout 60 s. Response read
  as `data[i].embedding` (OpenAI shape; TEI emits the same).

## Frontend API (`lib/ai.ts`)

```ts
aiStatus(): Promise<AiStatus>
aiGraph(): Promise<AiGraph>
aiSuggestTags(path: string, content: string): Promise<string[]>
aiRelated(path: string): Promise<RelatedNote[]>
aiRescan(): Promise<void>
mergeTagsIntoFrontmatter(fm: string | null, tags: string[]): string
applyTags(path: string, tags: string[]): Promise<void>
```

`applyTags`: open file → `editorApi.updateFrontmatter(path, merged)` (dirty
→ autosave → the normal `write_file` path); closed file →
`readFile` → `parseFrontmatter` → merge → `serializeFile` → `writeFile`.
Both routes keep `record_write` self-suppression and index updates for
free.

## Store (`stores/ai-store.ts`)

```ts
openPanel(path): Promise<void>   // sets panelFor, fires suggest+related loads
acceptTag(tag): Promise<void>    // applyTags + remove from suggestions
acceptAll(): Promise<void>
closePanel(): void
bumpGraphVersion(): void         // called by the watcher hook
```
