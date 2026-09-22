# Implementation Plan: AI Note Relations + Graph View

**Date**: 2026-09-22 | **Spec**: [spec.md](./spec.md) | **Research**: [research.md](./research.md)

**Input**: Feature specification from `SPECs/ai-note-graph/spec.md`

## Summary

Opt-in AI layer for note relations. A per-window Rust worker maintains an
index of each Markdown note's resolved `[[wikilink]]` edges, content hash,
text projection, embedding vector, and AI-suggested tags — persisted as a
sidecar JSON under the app data dir, never inside the vault. Embeddings go
to a user-configured `{base}/embeddings` endpoint (TEI/OpenAI-shaped);
tag suggestions go through a primary → fallback chain of
OpenAI-compatible chat endpoints with JSON-schema output. A new `graph`
page-kind renders link + similarity edges as a force-directed canvas;
clicking a node opens the note. A per-note card suggests tags that write
frontmatter `tags:` **only on explicit accept**, plus a related-notes list
for jumping between notes.

Technical approach in one line: one lazy tokio worker per workspace fed by
an unbounded `AiJob` channel — kicked by `index:complete`, `index_workspace`,
the watcher, and `index_written_file` — commits results under
`with_workspace_snapshot`, and all network I/O lives behind
`ai.enabled = false` by default.

## Technical Context

**Language/Version**: TypeScript 5.8 (React 19) frontend; Rust (Tauri v2) backend.

**Primary Dependencies**: `reqwest` (0.13, json + rustls — already used by
telemetry), `tokio` (fs/sync/time), `serde_json`, `parking_lot` — all
already in Cargo.toml, **no new Rust crates**. Frontend: `zustand`,
`yaml`, existing page-kind/store/palette infra. **New frontend dep**:
`react-force-graph-2d@1.29.1` (canvas force graph, lazy-loaded via
`React.lazy`; 7 months old, well past the new-release vetting window).

**Storage**: `app_data_dir()/ai-graph/<fnv1a64(root)>.json` — versioned
sidecar `{ version, root, embed_endpoint, embed_model, notes[] }`. Embeddings
invalidate when `embed_endpoint`/`embed_model` change; links and accepted
suggestions survive. Settings: 8 new `ai.*` keys in
`apps/desktop/shared/settings.schema.json`, all `scope: "global"`.

**Testing**: `cargo test` for the pure Rust pieces (wikilink extraction,
projection, link resolution, cosine, sidecar round-trip, tag-response
parsing). `vp test` for the frontmatter merge helper and store logic —
node-only runner, no DOM. Runtime verification via
[quickstart.md](./quickstart.md) against the user's real endpoints.

**Target Platform**: macOS desktop (Tauri v2); platform-neutral code like
the rest of the app.

**Performance Goals**: Zero network calls while `ai.enabled` is off. Index
work bounded: only changed notes re-embed (content hash), batches of ≤32
inputs per request, sequential. Graph data computed on demand in `ai_graph`
(top-k cosine over in-memory vectors — ~200 pairs at the user's vault
scale). The webview never blocks: all HTTP and file I/O runs on the async
runtime / worker task, and the graph renderer mounts lazily only while its
tab is visible.

**Constraints**: AI never writes notes. Accepted tags are the single write
path, executed only on click through `updateFrontmatter` (open file → dirty
→ autosave) or `readFile` + `writeFile` (closed file). No remote fallback:
the chat fallback chain only walks endpoints the user configured. Note
content leaves the app only toward configured endpoints — the settings copy
says so.

**Scale/Scope**: 8 settings keys, 1 new Rust module (~`ai.rs`), 1 new command
module, ~5 frontend files (page-kind, pane, IPC lib, store, suggestion
card), 2 palette commands, 1 settings-extras section.

## Constitution Check

_GATE: re-checked after design._

| Principle                         | Status | Evidence                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I. Local-first plain text         | PASS   | Off by default; content goes only to configured endpoints; the index is a sidecar outside the vault; notes are never rewritten by AI. The settings description states plainly that note text is sent to the endpoints.                                                                                                                                      |
| II. Smallest correct change       | PASS   | No new Rust crates; reuses the watcher, index, settings and write paths as-is. One new page-kind entry, one worker, one sidecar file. No local-graph mode, filters, or groups (deferred).                                                                                                                                                                   |
| III. One place per concern        | PASS   | `locationForPath` untouched — `graph` is a stateless kind like `settings`. Wikilink rules mirrored in one Rust fn; frontmatter merge in one TS helper; settings keys only in the schema JSON; worker enqueue sites call one `ai::kick`/`ai::note_changed` pair.                                                                                             |
| IV. Explicit failure, owned state | PASS   | Endpoint failures surface in `ai_status` and the suggestion card error state; embeddings degrade to links-only when the endpoint is absent/down — a stated mode, not a silent swallow. Stale commits dropped via `with_workspace_snapshot`; reset clears queue + index.                                                                                     |
| V. Specs and docs move with code  | PASS   | This spec set (spec/plan/research/data-model/contracts/tasks/quickstart) linked from `TODOS.md`; `CHANGELOG.md` entry in the final task.                                                                                                                                                                                                                    |
| VI. Code structure (no reinvent)  | PASS   | Reused: `spawn_blocking`/`async_runtime` precedent, `WorkspaceIdentity` event filtering, `emit`-then-filter event style for `ai:graph-changed`, `with_global_settings_mut` post-write hook (same as `mcp::apply_settings`), `parseFrontmatter`/`serializeFile`, `updateFrontmatter` save path, `openFile` for node navigation, `SECTION_EXTRAS` for status. |
| VII. Scope of the user            | PASS   | Sized for a ~21-note vault but bounded for larger ones (hash-skip, top-k, batch caps).                                                                                                                                                                                                                                                                      |
| Quality gates                     | PASS   | Pure Rust fns get `cargo test`; merge helper + store transitions get `vp test`; endpoints exercised in quickstart against real servers.                                                                                                                                                                                                                     |

## Project Structure

### Documentation (this feature)

```text
SPECs/ai-note-graph/
├── spec.md              # Feature spec (input)
├── plan.md              # This file
├── research.md          # Phase 0: endpoint probes, energy findings, decisions R1–R11
├── data-model.md        # AiIndex, NoteEntry, sidecar file, IPC payload types
├── contracts/
│   ├── ipc-and-events.md   # commands, event payloads, frontend store API, trigger sites
│   └── settings.md         # the eight ai.* schema entries
├── quickstart.md        # runtime validation scenarios against real endpoints
└── tasks.md             # Phase 2 output
```

### Source Code (repository root)

```text
apps/desktop/shared/
└── settings.schema.json                    # + 8 entries, category "AI"

apps/desktop/src-tauri/src/
├── ai.rs                                   # NEW: config, HTTP client, projection,
│                                           #     wikilink extract/resolve, cosine,
│                                           #     sidecar load/save, worker, kick API
├── commands/ai.rs                          # NEW: ai_status, ai_graph, ai_suggest_tags,
│                                           #      ai_related, ai_rescan
├── commands/mod.rs                         # + pub mod ai
├── lib.rs                                  # + 5 command registrations
├── state.rs                                # + ai_index, ai_queue fields; reset; enqueue in index_written_file
├── watcher.rs                              # + enqueue on markdown fs:file-changed
├── commands/workspace.rs                   # + kick ScanAll after index:complete
├── commands/search.rs                      # + kick ScanAll after index_workspace publish
└── commands/settings.rs                    # + ai::apply_settings in with_global_settings_mut

apps/desktop/src/
├── lib/ai.ts                               # NEW: IPC wrappers, types, mergeTagsIntoFrontmatter, applyTags
├── stores/ai-store.ts                      # NEW: graph version, suggestion-card state
├── components/editor-area/page-kinds/
│   ├── graph.ts                            # NEW: { kind: "graph" } stateless kind
│   ├── index.ts                            # + register
│   └── views.tsx                           # + GraphPane view
├── components/graph/graph-pane.tsx         # NEW: lazy react-force-graph-2d canvas
├── components/ai/suggest-card.tsx          # NEW: floating suggestion + related-notes card
├── hooks/use-tabs.ts                       # + useOpenGraphTab
├── hooks/use-file-watcher.ts               # + ai:graph-changed listener
├── components/command-palette/index.tsx    # + "Open Graph", "AI: Suggest Tags", "AI: Rescan"
└── components/settings-panel/ai-section.tsx# NEW: endpoint/index status extras
```

## Phases

### Phase 1 — Setup

Schema entries (contracts/settings.md), `react-force-graph-2d` via catalog,
`commands/ai.rs` skeleton returning disabled-state results, registration,
`lib/ai.ts` wrapper skeleton. No behaviour change.

### Phase 2 — US1: Relation index + graph tab

`ai.rs` core (projection, wikilink extract/resolve, cosine, sidecar),
worker + enqueue sites, `ai_graph` + `ai_rescan`, `graph` page-kind +
`GraphPane` + palette command + `ai:graph-changed` listener. Exit: links +
similarity edges render; click opens note; edits re-index incrementally.

### Phase 3 — US2: Tag suggestions + accept-to-frontmatter

Chat client w/ primary→fallback chain, `ai_suggest_tags`, suggestion card
(chips, accept one / accept all / dismiss), `mergeTagsIntoFrontmatter` +
`applyTags`, palette command. Exit: suggestions appear; accepting writes
`tags:` via the normal save path; nothing writes unclicked.

### Phase 4 — US3: Related notes, status, docs

`ai_related` + related list in the card, `ai_status` + AI settings extras,
palette "Rescan Note Index", quickstart verification, CHANGELOG, docs
cross-refs.

## Risk Notes

- **Two windows, one workspace**: `find_by_workspace` dedupes opens; two
  windows on the same root would share a sidecar file. Sidecar writes are
  atomic (temp + rename) and last-writer-wins is acceptable — worst case is
  a redundant re-embed, not corruption.
- **`workspace_epoch` vs. async HTTP**: commits happen only inside
  `with_workspace_snapshot`; a mid-flight switch discards the batch.
- **Embedding dimension drift**: sidecar records `embed_model` +
  `embed_endpoint`; a mismatch drops vectors (not links/tags) and re-embeds.
- **Chat model noise**: suggestions are deduped, capped at 8, and never
  auto-applied — noisy output is an annoyance, not a write hazard.
