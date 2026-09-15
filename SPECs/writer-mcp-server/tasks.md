---
description: "Task list for Writer MCP Server implementation"
---

# Tasks: Writer MCP Server

**Input**: Design documents from `SPECs/writer-mcp-server/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ (mcp-tools.md, bridge-protocol.md, app-bridge.md), quickstart.md

**Tests**: Included — the plan's Testing section and the constitution's quality gates require `cargo test` coverage (path resolution, boundary checks, handshake, error mapping, dispatch routing) and `vp test` coverage (webview dispatcher).

**Organization**: Tasks are grouped by user story so each story can be implemented, tested, and delivered independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US4)
- All paths relative to repo root `/Users/oliver/Programming/writer-computer`

## Path Conventions

- Rust backend: `apps/desktop/src-tauri/src/` (new code under `mcp/` module)
- Frontend: `apps/desktop/src/` (dispatcher in `lib/mcp.ts`, hook in `hooks/`, UI in `components/settings-panel/`)
- Shared schema: `apps/desktop/shared/settings.schema.json`
- User docs: `docs/mcp-server.md`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Dependencies and module skeleton the rest of the work hangs off

- [x] T001 Add `rmcp` 3.4.x with `server` + `transport-async-rw` features, `schemars`, and tokio `net` + `io-util` features to `apps/desktop/src-tauri/Cargo.toml` (tokio is already a dependency — only add features)
- [x] T002 Create module skeleton `apps/desktop/src-tauri/src/mcp/mod.rs` with `pub fn socket_path() -> PathBuf` returning `app_data_dir()/mcp.sock` (single source shared by app bind and CLI connect), and register `mod mcp;` in `apps/desktop/src-tauri/src/lib.rs`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Transport, dispatch plumbing, shared resolution, and lifecycle — everything every tool call depends on

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T003 [P] Add MCP error kinds to `apps/desktop/src-tauri/src/error.rs`: the twelve `data.kind` values from `contracts/mcp-tools.md` (`invalid_params`, `not_found`, `outside_workspace`, `ambiguous_workspace`, `no_workspace`, `unsupported_kind`, `already_exists`, `unsaved_conflict`, `too_large`, `window_unavailable`, `server_disabled`, `version_mismatch`, `internal`) with the JSON-RPC `code` mapping from that contract's error table
- [x] T004 [P] Extend `AppState` in `apps/desktop/src-tauri/src/state.rs` with MCP server state: listener task handle, status (`stopped | running | failed` + bind-error string, `socket_path`), and `pending: HashMap<u64, oneshot::Sender>` for in-flight webview-forwarded calls (per data-model.md "Server status")
- [x] T005 [P] Add `mcp.enabled` to `apps/desktop/shared/settings.schema.json`: `"scope": "global"`, `"type": "boolean"`, `default: false`, matching the existing global-key entry shape
- [x] T006 Implement listener lifecycle in `apps/desktop/src-tauri/src/mcp/mod.rs`: bind `tokio::net::UnixListener` at `socket_path()`; before bind, if the file exists probe-connect — refused → unlink and bind, accepted → report "already served" as a startup failure; set socket file permissions `0600`; `stop` aborts the accept task and removes the file; `apply_enabled(enabled)` starts/stops the server and updates `AppState` status
- [x] T007 Implement `apps/desktop/src-tauri/src/mcp/bridge.rs`: per-connection task that reads the first socket line `{"writer_bridge_hello":{"version":...}}`, replies `{"writer_bridge_ready":{...}}` when versions equal `CARGO_PKG_VERSION` else `{"writer_bridge_error":{"kind":"version_mismatch","message":...}}`, then hands `tokio::io::split(stream)` to `rmcp::serve_server`; socket EOF or disable drops the service and fails pending calls with `server_disabled`/`window_unavailable`
- [x] T008 Add `mcp` subcommand to `apps/desktop/src-tauri/src/writer_cli.rs`: connect to `socket_path()`, send the hello line, read the reply line, then pump bytes stdin→socket and socket→stdout on two threads until either side closes — no JSON parsing after the handshake (per `contracts/bridge-protocol.md`); connect refused/missing socket or `writer_bridge_error` → stderr "Writer is not running or the MCP server is disabled in Settings" and exit code 3; never hangs, never launches the app (FR-008); CLI stays dependency-free
- [x] T009 Create `apps/desktop/src-tauri/src/commands/mcp.rs` with `mcp_respond(request_id, result | error{kind,detail})` completing the pending oneshot in `AppState`, and `mcp_status()` returning `{enabled, state, error, socket_path}`; register both commands plus `mod mcp` in `commands/mod.rs` and `lib.rs`
- [x] T010 Implement workspace and path resolution helpers in `apps/desktop/src-tauri/src/mcp/mod.rs`: `workspace` arg (an id from `list_workspaces` — canonical root, or standalone file path) → window label via `AppState::find_by_workspace`/`find_by_standalone_file`; omitted + zero open → `no_workspace`, omitted + exactly one → default, omitted + several → `ambiguous_workspace` whose `detail` lists candidate ids (FR-026); paths resolve relative to the named root, canonicalize, and must `starts_with(root)` — rejecting `..` and symlink escapes (FR-025); `create_*` targets canonicalize the parent since the file may not exist
- [x] T011 Implement the webview-forward plumbing in `apps/desktop/src-tauri/src/mcp/mod.rs` and `server.rs`: emit `mcp:request` `{request_id, tool, args}` to the resolved window label via `app.emit_to`, store the reply `oneshot` in `AppState.pending`, time out after 5 s → `window_unavailable`; `describe_window` broadcasts to every label and merges replies; `AppState::remove(label)` fails that label's pending requests (per `contracts/app-bridge.md`)
- [x] T012 Create the frontend dispatcher skeleton: `apps/desktop/src/lib/mcp.ts` (tool-name → handler registry that never throws — every outcome is a `result` or `{kind, detail}` error, unknown tool → `internal` error logged), `apps/desktop/src/hooks/use-mcp-requests.ts` (`listen("mcp:request")`, dispatch, reply via `mcpRespond`), `mcpRespond`/`mcpStatus` invoke wrappers in `apps/desktop/src/lib/tauri.ts`, and mount the hook at the app root
- [x] T013 Wire server lifecycle: start the server in `lib.rs` setup when loaded `mcp.enabled` is true; call `mcp::apply_enabled` inside `with_global_settings_mut` in `apps/desktop/src-tauri/src/commands/settings.rs` as a post-write step mirroring `telemetry::apply_settings` (so toggles and hand-edited config apply in-session); remove the socket file in `apps/desktop/src-tauri/src/shutdown.rs` on quit; bind failure stores the error in `AppState` status and never blocks launch (FR-004)
- [x] T014 Add `cargo test` coverage in `apps/desktop/src-tauri/src/mcp/` for the foundational spine: handshake accept/reject/`version_mismatch`, stale-socket takeover (probe → unlink → bind), workspace→window resolution including the ambiguity error listing candidates, and path boundary checks (`..` escape, symlinked escape, absolute path outside the root → `outside_workspace`)

**Checkpoint**: `writer mcp` connects through the socket, handshake works, and a forwarded call can round-trip to a window — user story implementation can now begin

---

## Phase 3: User Story 1 - Agent reads and searches the open workspace (Priority: P1) 🎯 MVP

**Goal**: An MCP client can list open workspaces, list and fuzzy-search files with Writer's own index and ignore rules, read note contents from disk, and see open tabs

**Independent Test**: With Writer open on a workspace containing a few markdown files, connect an MCP client via `writer mcp`, call `list_workspaces`/`list_files`/`search_files`/`read_file`/`list_tabs`, and confirm results match the Writer sidebar and fuzzy search for the same queries; an outside path returns `outside_workspace` and a second open workspace makes `workspace`-less calls return `ambiguous_workspace` (quickstart §3)

### Implementation for User Story 1

- [x] T015 [US1] Create the rmcp server handler in `apps/desktop/src-tauri/src/mcp/server.rs`: `#[tool_router]`/`#[tool]` macros with `schemars`-derived input structs; each tool routes by source of truth — answered in Rust iff its truth is `AppState`/disk/file-index, forwarded to the owning window's webview iff it needs live editor state or UI action (research.md dispatch rule)
- [x] T016 [US1] Implement `list_workspaces` in `apps/desktop/src-tauri/src/mcp/server.rs`: enumerate `AppState` windows; each entry `{id, kind: "workspace"|"file", root, name, active_file}` where `id` is the canonical root (or standalone file path for compact windows); fan out `describe_window` to each label for `active_file`, unreachable windows appear with `active_file: null`; empty list is a valid answer, never `no_workspace`
- [x] T017 [US1] Implement `list_files` in `apps/desktop/src-tauri/src/mcp/server.rs`: gitignore-aware walk honoring the sidebar's `is_sidebar_file` predicate (markdown + drawings + PDFs) and `workspace_ignore`; optional `path` restricts to a subdirectory, `limit` defaults to and caps at 5,000 with a `truncated` flag; output `{entries: [{path, relative_path, kind, modified_at}], truncated}`
- [x] T018 [US1] Implement `search_files` in `apps/desktop/src-tauri/src/mcp/server.rs`: `fuzzy_search_from` over the workspace `file_index` for identical ranking to in-app search; `limit` default 50, max 200; output `{results: [{path, relative_path, score}]}`
- [x] T019 [US1] Implement `read_file` in `apps/desktop/src-tauri/src/mcp/server.rs`: `read_file_impl` after workspace/path resolution; readable kinds `.md`, `.markdown`, `.excalidraw.svg` only — others → `unsupported_kind`; files over 1 MiB → `too_large`; output `{path, relative_path, content, modified_at}` with full on-disk text including frontmatter
- [x] T020 [US1] Implement `describe_window` and `list_tabs` handlers in `apps/desktop/src/lib/mcp.ts`: `describe_window` returns `{root, chromeMode, standaloneFile, activeFilePath}` from workspace/editor stores; `list_tabs` maps `tabs` + `layout` to `{path, location_kind, active}[]` reporting every tab including non-file kinds (`launcher`, `drawing`, `pdf`)
- [x] T021 [US1] Add `cargo test` coverage in `apps/desktop/src-tauri/src/mcp/server.rs` for dispatch routing (Rust-local vs forwarded), error-kind mapping onto JSON-RPC `code`/`data.kind`, and `read_file` refusal cases (outside workspace, unsupported kind, over 1 MiB)

**Checkpoint**: US1 fully functional — an agent can discover, search, and read notes with zero write capability; verify against quickstart §3

---

## Phase 4: User Story 2 - Agent contributes to notes (Priority: P2)

**Goal**: An agent can create new notes, replace existing content in full, and create folders — all through the identical save path the UI uses, with dirty-tab protection

**Independent Test**: With a note open in a Writer tab, have an agent `write_file` new content and confirm the tab updates; type unsaved text in the tab, have the agent write again, and confirm `unsaved_conflict` with the user's text intact; `create_file` on an existing path returns `already_exists` (quickstart §4)

### Implementation for User Story 2

- [x] T022 [US2] Implement `create_file` handler in `apps/desktop/src/lib/mcp.ts`: `tauri.createFile` (create-new semantics → `already_exists` on existing path, FR-014) then `tauri.writeFile` for content; markdown kinds (`.md`, `.markdown`) only; output `{path, relative_path, modified_at}`
- [x] T023 [US2] Implement `write_file` handler in `apps/desktop/src/lib/mcp.ts`: check `openFiles.get(path)?.isDirty` → `unsaved_conflict` (FR-016); `not_found` if missing; else `tauri.writeFile` then `markSaved`/`reloadFromDisk` so a clean open tab shows new content without user action (FR-017); this is the literal UI save path so `record_write`, the atomic temp write, index updates, and `sidebar:metadata-changed` behave identically (FR-018)
- [x] T024 [US2] Implement `create_folder` handler in `apps/desktop/src/lib/mcp.ts`: `tauri.createDirectory`; `already_exists` if present; output `{path, relative_path}` (FR-019)
- [x] T025 [US2] Register `create_file`, `write_file`, `create_folder` in the rmcp tool router in `apps/desktop/src-tauri/src/mcp/server.rs`: resolve workspace + path boundary in Rust (parent canonicalization for create targets), then forward to the owning window; serialization on the single JS thread per window means writes to one file can never interleave
- [x] T026 [US2] Add `vp test` coverage in `apps/desktop/tests/` for the webview dispatcher: dirty-conflict refusal preserves unsaved text, create-then-write ordering, unknown tool → `internal` error

**Checkpoint**: US2 fully functional — agent writes land exactly like editor saves, with the strictest refusal rules verified; verify against quickstart §4

---

## Phase 5: User Story 3 - Agent opens things in the app (Priority: P2)

**Goal**: An agent can open a note in the right window and tab, open folders as workspaces, focus windows, reveal files in the sidebar, and open standalone compact windows

**Independent Test**: From an MCP client, `open_file` a note and confirm the correct window comes forward with the note active; `open_workspace` on a new folder opens a window and on an already-open folder focuses the existing window instead of duplicating; `open_file` on a missing path returns `not_found` with no tab created (quickstart §5)

### Implementation for User Story 3

- [ ] T027 [US3] Implement `open_file` handler in `apps/desktop/src/lib/mcp.ts`: `openFile`/`openFileInNewTab` on the editor store (`new_tab` input, default false), then bring the window forward; `not_found` if missing; may steal focus per FR-020; output `{opened: relative_path}`
- [ ] T028 [US3] Implement `reveal_in_sidebar` handler in `apps/desktop/src/lib/mcp.ts`: `revealPathInSidebar` — expands and highlights the entry like the tab context-menu action, no focus change (FR-022)
- [ ] T029 [US3] Implement `open_workspace` tool in `apps/desktop/src-tauri/src/mcp/server.rs`: absolute folder path input; `find_by_workspace` hit → focus that window and return its id (no duplicate, FR-021); miss → existing window-creation path (`open_workspace_in_new_window`); output `{workspace: id}`
- [ ] T030 [US3] Implement `open_standalone_file` tool in `apps/desktop/src-tauri/src/mcp/server.rs`: absolute file path; `find_by_standalone_file` dedupe focuses the existing compact window, else `open_file_in_standalone_window` (FR-024); output `{opened: path}`
- [ ] T031 [US3] Implement `focus_window` tool in `apps/desktop/src-tauri/src/mcp/server.rs`: `workspace` argument required (no sensible default); `window.set_focus()` plus unminimize, matching the existing window-focus call sites in `lib.rs` (FR-023)
- [ ] T032 [US3] Register `open_file` and `reveal_in_sidebar` in the rmcp tool router in `apps/desktop/src-tauri/src/mcp/server.rs` as webview-forwarded tools (resolve workspace → window label first); confirm `focus_window`/`open_workspace`/`open_standalone_file` are the only tools that call `set_focus` and that no other tool steals focus (FR-030)

**Checkpoint**: US3 fully functional — agent navigation is indistinguishable in end state from user navigation; verify against quickstart §5

---

## Phase 6: User Story 4 - User controls the integration (Priority: P3)

**Goal**: The user can toggle the server in settings, see its status and any bind error, and copy the connection snippet — with the server off by default and clean start/stop in-session

**Independent Test**: Fresh install → no `mcp.sock` exists and `writer mcp` exits 3. Toggle the setting on → server starts without relaunch, settings show running + snippet, `writer mcp` connects. Toggle off with an agent connected → socket closes, pending calls fail `server_disabled`, `mcp.sock` is removed. Quit and relaunch with the setting on → clean bind, no stale-socket failure (quickstart §1, §6)

### Implementation for User Story 4

- [ ] T033 [US4] Create `apps/desktop/src/components/settings-panel/mcp-section.tsx` following the `latex-suite-extras.tsx` extras pattern: reads `mcpStatus` (enabled, state, error, socket_path), shows running/failed status with the bind-error detail (FR-004/FR-005), the copyable snippet `{ "command": "writer", "args": ["mcp"] }`, and — when `cli_status` reports the `writer` command missing — a pointer to the existing Install CLI action instead of the snippet (FR-008a); mount it in `apps/desktop/src/components/settings-panel/index.tsx`
- [ ] T034 [US4] Regenerate or update the settings types derived from `apps/desktop/shared/settings.schema.json` (check `apps/desktop/src/lib/settings-schema.ts` for how schema keys surface to the frontend) so `mcp.enabled` renders as a settings toggle in the appropriate category

**Checkpoint**: US4 fully functional — the trust gate is user-visible and verified end to end; verify against quickstart §1 and §6

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, changelog, and full validation

- [ ] T035 Write `docs/mcp-server.md` (FR-031): the complete tool list with each tool's inputs/outputs, the error-kind table from `contracts/mcp-tools.md`, documented caps (`read_file` ≤ 1 MiB, `search_files` limit default 50 / max 200, `list_files` cap 5,000), and the connection guide including the `{ "mcpServers": { "writer": { "command": "writer", "args": ["mcp"] } } }` snippet
- [ ] T036 Add the `docs/mcp-server.md` entry to the `AGENTS.md` docs index and record the feature in `CHANGELOG.md` (user-visible change); move the feature's entry in `TODOS.md` to Done
- [ ] T037 Run the full `SPECs/writer-mcp-server/quickstart.md` validation end to end (§1–§6 plus the `tools/list` smoke test)
- [ ] T038 Run all quality gates: `vp check` and `vp test` from repo root; `cargo test`, `cargo clippy`, `cargo fmt --check` from `apps/desktop/src-tauri/`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories. This is the transport + dispatch + lifecycle spine; nothing user-facing works without it
- **User Stories (Phases 3–6)**: All depend on Foundational. US1–US3 are independent of each other; US4's settings UI is a thin layer that can also proceed independently once `mcp_status` exists (T009)
- **Polish (Phase 7)**: Depends on all desired user stories being complete

### User Story Dependencies

- **US1 (P1)**: Needs T015 router + T020's `describe_window` for `list_workspaces` fan-out — no dependency on US2/US3/US4
- **US2 (P2)**: Independent — needs the webview dispatcher skeleton from T012 and forwarding from T011
- **US3 (P2)**: Independent — `open_workspace`/`focus_window`/`open_standalone_file` are Rust-local, `open_file`/`reveal_in_sidebar` reuse the same dispatcher
- **US4 (P3)**: Independent — needs `mcp_status` (T009) and the lifecycle wiring (T013); its phase is only the settings surface

### Within Each User Story

- Rust-side tools land in `server.rs`; webview-side handlers land in `lib/mcp.ts` — the two files can be worked in parallel within a story
- Router registration (T025, T032) depends on the dispatcher handlers existing to forward to
- Story complete before moving to the next priority when working sequentially

### Parallel Opportunities

- T003, T004, T005 (Foundational) touch different files — run in parallel
- T016–T019 (US1 Rust-local tools) all edit `server.rs` — sequential within the file, parallel with T020 (`lib/mcp.ts`)
- T022–T024 (US2 dispatcher handlers) share `lib/mcp.ts` — sequential within the file, parallel with T025 router registration in `server.rs`
- T027–T031 (US3) split by file: `lib/mcp.ts` handlers (T027, T028) parallel with `server.rs` tools (T029, T030, T031)
- US1, US2, US3, and US4 can proceed in parallel by different workers once Foundational completes

---

## Parallel Example: User Story 1

```bash
# After T015, the four Rust-local tools (sequential edits to server.rs)
# can be implemented while the webview half runs in parallel:
Task: "Implement describe_window and list_tabs handlers in apps/desktop/src/lib/mcp.ts"
Task: "Implement list_workspaces/list_files/search_files/read_file in apps/desktop/src-tauri/src/mcp/server.rs"
```

## Parallel Example: User Story 3

```bash
# Webview handlers and Rust-local tools touch different files:
Task: "Implement open_file handler in apps/desktop/src/lib/mcp.ts"
Task: "Implement reveal_in_sidebar handler in apps/desktop/src/lib/mcp.ts"
Task: "Implement open_workspace in apps/desktop/src-tauri/src/mcp/server.rs"
Task: "Implement open_standalone_file in apps/desktop/src-tauri/src/mcp/server.rs"
Task: "Implement focus_window in apps/desktop/src-tauri/src/mcp/server.rs"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL — transport, dispatch, lifecycle)
3. Complete Phase 3: User Story 1
4. **STOP and VALIDATE**: run quickstart §2–§3 — a connected agent can list, search, and read
5. This is already a useful read-only MCP server; demo/deploy decision point

### Incremental Delivery

1. Setup + Foundational → `writer mcp` connects, calls round-trip
2. - US1 → read-only agent access (MVP)
3. - US2 → agent can draft and amend notes safely
4. - US3 → agent can drive app navigation
5. - US4 → user-facing trust surface complete
6. Each story adds capability without changing previous behavior

### Key Correctness Anchors (from contracts)

- One `socket_path()` shared by app and CLI — never compute the path twice
- Writes go through the webview dispatcher → `tauri.writeFile` → the same `write_file` command as a UI save; no second write path anywhere (FR-018)
- Path safety is canonicalize-then-`starts_with(root)`; create targets canonicalize the parent
- All forwarded calls target exactly one window label; ambiguity is an error, not a guess

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks
- [Story] label maps each task to its spec.md user story for traceability
- Adding a tool later touches exactly three places: the rmcp router, `lib/mcp.ts` (if webview-side), and `docs/mcp-server.md` — keep it that way
- Commit after each task or logical group; one task per commit in loop mode per `docs/workflows/agent-loop.md`
- Stop at any checkpoint to validate a story independently via `writer mcp` and the quickstart NDJSON smoke test
