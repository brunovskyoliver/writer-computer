# Tasks: AI Note Relations + Graph View

**Input**: Design documents from `SPECs/ai-note-graph/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md,
contracts/ (ipc-and-events, settings), quickstart.md

**Tests**: Included — pure Rust fns (extractor, projection, link
resolution, cosine, sidecar codec, tag-response parsing) get `cargo test`;
`mergeTagsIntoFrontmatter` gets `vp test` (node-only runner — no DOM).

**Organization**: Tasks grouped by phase → user story. US1 (index + graph)
blocks US2/US3 only through Phase 1 setup; US2 (tags) and US3 (related +
status) share the `ai.rs` client helpers.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallel-safe (different files, no unfinished deps)
- **[Story]**: US1 = relation index + graph, US2 = tag suggestions,
  US3 = related notes + status surface

## Path Conventions

Repo root `/Users/oliver/Programming/writer-computer`. Frontend
`apps/desktop/src/`, tests `apps/desktop/tests/`, Rust
`apps/desktop/src-tauri/src/`, shared `apps/desktop/shared/`.

Validation: `vp check && vp test` (repo root); `cargo test && cargo clippy
&& cargo fmt --check` (from `apps/desktop/src-tauri/`).

---

## Phase 1: Setup (Shared Infrastructure)

- [x] T001 Add the eight `ai.*` entries to `apps/desktop/shared/settings.schema.json` exactly per contracts/settings.md (category `AI`, scope `global`, defaults `""`/`false`, descriptions copied verbatim). Extend `apps/desktop/tests/settings-schema.test.ts` asserting the keys exist with the listed defaults and category. `cargo test` must still pass (Rust `include_str!`s the schema).
- [x] T002 [P] Add `react-force-graph-2d` `1.29.1` to the catalog in `pnpm-workspace.yaml` and to `apps/desktop/package.json` as `"react-force-graph-2d": "catalog:"`; run `vp install` and confirm the type surface compiles under `vp check` (add a `declare module` shim only if the package ships no types).
- [x] T003 [P] Create `apps/desktop/src/lib/ai.ts` with the TypeScript payload types from data-model.md (`AiStatus`, `AiGraphNode`, `AiGraphEdge`, `AiGraph`, `RelatedNote`) and thin `invoke` wrappers for the five commands per contracts/ipc-and-events.md (wrappers will reject until T004 lands — fine).
- [x] T004 Create `apps/desktop/src-tauri/src/commands/ai.rs` skeleton: all five commands registered and returning the disabled/empty shapes (`AiStatus{enabled:false,…}`, `AiGraph{nodes:[],edges:[]}`, `[]`, `()`); gate on `ai.enabled` via a shared `ai::settings(state)` resolver returning `Option<AiSettings>`. Register in `commands/mod.rs` and `lib.rs` `generate_handler!`.
- [x] T005 Add to `WorkspaceState` in `state.rs`: `pub ai_index: RwLock<AiIndex>` and `pub ai_queue: Mutex<Option<tokio::sync::mpsc::UnboundedSender<AiJob>>>`; clear both in `reset_workspace_runtime` (drop sender → worker exits). `AiIndex`/`AiJob`/`NoteEntry` defined in `ai.rs` per data-model.md.

**Checkpoint**: `vp check`, `vp test`, `cargo test`, `cargo clippy`, `cargo fmt --check` all pass; zero runtime behaviour change.

---

## Phase 2: US1 — Relation index + graph tab

**Purpose**: Worker, index, sidecar, `ai_graph`, graph tab. Delivers the "see relations" story end-to-end without any chat calls.

- [x] T006 [US1] `ai.rs` pure functions + tests: `extract_wiki_links(content) -> Vec<String>` (raw `[[…]]`/`![[…]]` targets, skipping frontmatter, fenced code and inline code); `embed_projection(content) -> String` (strip frontmatter + fenced code; `$$…$$`/`$…$` → plain text; `\cmd` → `cmd`; collapse whitespace; cap 4000 chars); `normalize_wiki_target` + `resolve_links(targets, root, index) -> Vec<String>` mirroring `lib/wiki-links.ts` rules (`|`/`#` split, ext strip, `/` ⇒ root-relative `.md`/`.markdown` probe, bare stem ⇒ unique case-insensitive match); `cosine(a,b)`; `similarity_edges(index, floor, k)` per data-model.md.
- [x] T007 [US1] `ai.rs` HTTP + worker: `reqwest` client; `embed_batch(cfg, texts) -> Vec<Vec<f32>>` (`POST {embed}/embeddings`, Bearer, 60 s); sidecar `load`/`save` (atomic temp+rename, `app_data_dir()/ai-graph/<fnv1a64(root)>.json`, version/embed-model invalidation per data-model.md); `run_worker` loop per contracts/ipc-and-events.md (800 ms debounce, epoch guard, `ScanAll`→process all indexed markdown, `Changed`→re-hash or remove); `kick`/`note_changed`/`note_markdown_event`/`apply_settings` entry points; `app.emit("ai:graph-changed", WorkspaceIdentity)` after each commit.
- [x] T008 [US1] Fill `ai_graph`/`ai_rescan` in `commands/ai.rs` per the contract (nodes from `file_index` markdown subset; link edges + similarity edges; dedupe link-over-similar pairs).
- [x] T009 [US1] Wire enqueue sites: `commands/workspace.rs` after `index:complete` → `ai::kick` + `ScanAll`; `commands/search.rs` `index_workspace` after publish → same; `watcher.rs` `fs:file-changed` markdown branch → `ai::note_markdown_event`; `state.rs` `index_written_file` → `ai::note_changed` (markdown-only check inside); `commands/settings.rs` `with_global_settings_mut` → `crate::ai::apply_settings`.
- [x] T010 [US1] Frontend surface: `page-kinds/graph.ts` (`kind:"graph"`, title "Graph", `keepAlive`, default serialize `{}`) + register in `page-kinds/index.ts`; `createGraphTab` + `useOpenGraphTab` (openOrFocus pattern, `use-tabs.ts`); `stores/ai-store.ts` with `graphVersion` + `bumpGraphVersion`; `use-file-watcher.ts` listener for `ai:graph-changed` guarded by `isWorkspaceEventCurrent`.
- [x] T011 [US1] `components/graph/graph-pane.tsx`: `React.lazy(() => import("react-force-graph-2d"))`; fetch `aiGraph()` on mount and whenever `graphVersion` changes; map edges (`link` = solid `--line`, `similar` = accent dashed + `linkLineDash`); node click → `editorApi.openFile(node.path)`; `warmupTicks`/`cooldownTicks`/`autoPauseRedraw` bounded; `ai.enabled` off → inline hint pointing at Settings; unmounted guard on the async fetch.
- [x] T012 [US1] Palette: "Open Graph" command (`root && !isCompactFileMode`), calling `useOpenGraphTab`.

**Checkpoint**: US1 demoable end-to-end — graph opens, link edges render immediately, similarity edges appear after embeddings land, edits update within ~1–2 s, clicking a node opens the note. `cargo test` + `vp test` + `vp check` green.

---

## Phase 3: US2 — Tag suggestions + accept-to-frontmatter

- [x] T013 [US2] `ai.rs` chat client: `chat_complete(cfg, system, user) -> Result<String>` walking primary → fallback on connect/timeout/5xx (4xx = config error, fail immediately); `suggest_tags(cfg, content) -> Result<Vec<String>>` with JSON-schema `response_format`, one retry without it on 400, lenient parse (first `{…}`/`[…]`), normalize (lowercase, spaces→`-`), dedupe, cap 8; tests for the parser + fallback classifier (no network — pure fns take a canned `Result`).
- [x] T014 [US2] `ai_suggest_tags` in `commands/ai.rs`: resolve cfg, call `suggest_tags` with the passed `content` (cap input ~6000 chars), store the result into `NoteEntry.suggested_tags` under `with_workspace_snapshot`, emit `ai:graph-changed`, return tags.
- [x] T015 [US2] `mergeTagsIntoFrontmatter(fm, tags)` + `applyTags(path, tags)` in `lib/ai.ts` per contracts/ipc-and-events.md (open → `updateFrontmatter`; closed → `readFile`/`serializeFile`/`writeFile`); unit tests for merge (empty/absent fm, scalar `tags`, list `tags`, dedupe, other keys preserved).
- [x] T016 [US2] `components/ai/suggest-card.tsx` + `stores/ai-store.ts` panel slice (`openPanel`, `acceptTag`, `acceptAll`, `closePanel`, `loading`/`error`): floating card over the editor area (mounted in `App.tsx` beside `CommandPalette`), tag chips accept-on-click, "Add all", dismiss ×, error line on failure. Style with existing CSS vars (no new palette).
- [x] T017 [US2] Palette: "AI: Suggest Tags for Current Note" (`activeFilePath` + `ai.enabled` via `useBooleanSetting`) → `aiStore.openPanel(activeFilePath)`; close palette first.

**Checkpoint**: US2 demoable — suggestions render, accept writes `tags:` once through the normal save path, frontmatter panel shows it, nothing writes unclicked; primary-down falls back; both-down shows the error line.

---

## Phase 4: US3 — Related notes, status, docs

- [x] T018 [US3] `ai_related` in `commands/ai.rs` (top-8 cosine, floor 0.3, empty without embedding); `ai_status` probes per contract (`GET {chat}/models` 3 s; `POST {embed}/embeddings` probe 3 s; unconfigured → `false`).
- [x] T019 [US3] Extend `suggest-card.tsx` + `ai-store.ts`: `related` loaded on `openPanel` (parallel with suggestions), rows render name + score%, click → `editorApi.openFile(path)` + close card.
- [x] T020 [US3] `components/settings-panel/ai-section.tsx` + `SECTION_EXTRAS["AI"]`: status line from `aiStatus()` ("chat reachable · embeddings reachable · N indexed · M pending" — "unreachable"/"not configured" variants), Refresh button re-probing; render only when `ai.enabled`.
- [x] T021 [US3] Palette: "AI: Rescan Note Index" (`root` + `ai.enabled`) → `aiRescan()`.
- [x] T022 Write the user's real endpoints into `~/Library/Application Support/com.writer-computer/config` (append `ai.*` keys; preserve existing lines; chat primary `http://100.127.4.22:8000/v1` model `qwen3-8b`, fallback `http://127.0.0.1:8000/v1` key `oliver`, embed `http://100.127.4.22:8080` model `Qwen/Qwen3-Embedding-0.6B`).
- [x] T023 [US3] Runtime verification per quickstart.md sections 1–5 using the verify skill; fix what it surfaces.
- [x] T024 [US3] `CHANGELOG.md` entry (user-visible: AI section in Settings, Graph tab, Suggest Tags command, opt-in note-content disclosure) + move the `TODOS.md` entry to Done + commit.

**Checkpoint**: all quickstart scenarios pass; `vp check && vp test && cargo test && cargo clippy && cargo fmt --check` green; CHANGELOG/TODOS updated; one commit.

---

## Dependency graph

```text
T001–T005 (Phase 1) ──> T006–T012 (US1) ──> T013–T017 (US2) ──> T018–T024 (US3)
                        T006,T007 sequential; T010/T011 depend on T003,T005
                        T016 depends on T014+T015
```
