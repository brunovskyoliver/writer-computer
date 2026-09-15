# Implementation Plan: Writer MCP Server

**Branch**: `writer-mcp-server` | **Date**: 2026-09-15 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `SPECs/writer-mcp-server/spec.md`

## Summary

Run an MCP server inside the Writer app so local agents (Claude Code, Codex,
Cursor, scripts) can list/read/search open workspaces, create and replace
notes, and drive app actions (open files/tabs/workspaces, focus windows,
reveal in sidebar). Transport is a Unix domain socket in the app data dir;
the existing `writer` multi-call binary gains an `mcp` subcommand that acts
as a stdio↔socket byte pipe after a version handshake. The server is off by
default behind a global `mcp.enabled` setting, with status + a copyable
connection snippet in the settings panel. Tool calls route to whichever side
owns the truth: Rust answers workspace/file-system tools from `AppState`,
the file index, and disk; the target window's webview answers editor-state
tools (tabs, dirty checks, writes, open/reveal) through an
`mcp:request`/`mcp_respond` bridge so agent writes use the identical save
path as the UI.

## Technical Context

**Language/Version**: Rust 2021 edition (Tauri v2 backend) + TypeScript/React frontend

**Primary Dependencies**: `rmcp` 3.4.x (`server` + `transport-async-rw` features), `schemars` (tool input schemas), existing `tokio` (+`net`, `io-util`), `serde`/`serde_json`, `parking_lot`, `thiserror`. No new frontend deps — `@tauri-apps/api` `listen`/`invoke` already in use.

**Storage**: Ghostty-style global config (`app_data_dir()/config`) for `mcp.enabled`; Unix socket file at `app_data_dir()/mcp.sock` (runtime only, removed on stop/quit). No document storage — everything reads/writes workspace files on disk.

**Testing**: `cargo test` (path resolution, boundary checks, handshake, error mapping, dispatch routing), `vp test` (frontend dispatcher), plus quickstart manual verification via `writer mcp`.

**Target Platform**: macOS first (matches existing `writer` CLI install); the socket code is portable to Linux, Windows named pipe deferred.

**Project Type**: desktop-app (Tauri v2)

**Performance Goals**: list/search/read < 1s on a 5,000-file workspace (spec SC-002); no polling — event-driven only.

**Constraints**: local-only transport, no TCP port; off by default; zero new write paths (FR-018); server start failure must never block app launch (FR-004).

**Scale/Scope**: one MCP server per app instance, N concurrent bridge connections, ~12 tools.

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

| Principle                            | Verdict | Notes                                                                                                                                                                                                                                                           |
| ------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I. Local-First Plain Text            | PASS    | Server is loopback-only, off by default, opt-in via a documented setting. No network dependency on any document path. No telemetry added.                                                                                                                       |
| II. Smallest Correct Change          | PASS    | Reuses `file_index`, `fuzzy_search_from`, `is_sidebar_file`, `read_file_impl`, `write_file` command, `find_by_workspace`, window creation commands, `revealPathInSidebar`, the settings schema, and the telemetry post-write hook pattern.                      |
| III. One Place Per Concern           | PASS    | One socket-path function shared by app + CLI mode; tool impls delegate to the existing single paths rather than duplicating them; `#[tool_router]` is the tool registry; MCP file-kind rules derive from the existing sidebar predicate.                        |
| IV. Explicit Failure and Owned State | PASS    | Enumerated error kinds surface as JSON-RPC error `data`; pending frontend requests time out and are failed on window close; server start failure is stored and shown, never blocks launch. New shared state (`pending` map, server status) lives in `AppState`. |
| V. Specs and Docs Move With the Code | PASS    | `docs/mcp-server.md` is a deliverable (FR-031); AGENTS.md docs index gains the entry in the same change; CHANGELOG updated on completion.                                                                                                                       |
| VI. Code structure                   | PASS    | `rmcp` instead of a hand-rolled protocol; no speculative partial-edit or subscription machinery.                                                                                                                                                                |

Post-design re-check: unchanged — all PASS. No violations to justify.

## Project Structure

### Documentation (this feature)

```text
SPECs/writer-mcp-server/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── mcp-tools.md     # Agent-facing tool schemas + error kinds
│   ├── bridge-protocol.md  # writer mcp ↔ app socket handshake/framing
│   └── app-bridge.md    # mcp:request / mcp_respond webview contract
└── checklists/
    └── requirements.md  # Spec quality checklist (complete)
```

### Source Code (repository root)

```text
apps/desktop/src-tauri/
├── Cargo.toml                       # + rmcp, schemars, tokio net/io-util
├── src/
│   ├── mcp/
│   │   ├── mod.rs                   # socket_path(), listener lifecycle,
│   │   │                            #   apply_enabled(), McpServerState
│   │   ├── server.rs                # rmcp handler, tool router, dispatch
│   │   │                            #   (Rust-local vs webview-forwarded)
│   │   └── bridge.rs                # version handshake, per-connection task
│   ├── commands/
│   │   └── mcp.rs                   # mcp_respond, mcp_status commands
│   ├── writer_cli.rs                # + `mcp` subcommand (byte-pipe bridge)
│   ├── state.rs                     # AppState.mcp (listener handle, status,
│   │                              #   pending-request map)
│   ├── error.rs                     # error kinds for tool responses
│   ├── lib.rs                       # register commands; start server in
│   │                              #   setup when enabled; stop on shutdown
│   └── shutdown.rs                  # remove socket file on quit
apps/desktop/
├── shared/settings.schema.json      # + mcp.enabled (global, default false)
└── src/
    ├── lib/mcp.ts                   # webview-side tool dispatcher
    ├── lib/tauri.ts                 # + mcpRespond, mcpStatus wrappers
    ├── hooks/use-mcp-requests.ts    # mounts the mcp:request listener
    └── components/settings-panel/
        └── mcp-section.tsx          # status, error, connection snippet,
                                     #   Install CLI pointer (extras pattern)
docs/mcp-server.md                   # tool list, schemas, connect guide (FR-031)
```

**Structure Decision**: the server lives in `apps/desktop/src-tauri/src/mcp/` because all tool logic must run inside the running app where `AppState`, watchers, and window handles exist. The CLI half stays in `writer_cli.rs` — `main.rs` already dispatches on argv[0], so `writer mcp` is a subcommand of the existing multi-call binary, keeping the bridge dependency-free. The webview dispatcher is one module (`lib/mcp.ts`) so adding a tool touches exactly the rmcp router + the dispatcher + `docs/mcp-server.md`.

## Design Notes

- **Dispatch rule** (from research.md): a tool is answered in Rust iff its
  source of truth is `AppState`/disk/file-index; it's forwarded to the owning
  window's webview iff it needs live editor state (dirty flags, tabs) or UI
  action (open, reveal). Workspace → window resolution uses
  `find_by_workspace` / `find_by_standalone_file`; omission is allowed only
  when exactly one workspace is open.
- **Write path**: frontend `write_file`/`create_file` tools call the same
  `lib/tauri.ts` wrappers the UI uses, so `record_write`, the atomic temp
  write, index updates, and `sidebar:metadata-changed` behave identically
  (FR-018, FR-005 acceptance). Dirty tabs refuse with
  `unsaved_conflict`; clean open tabs refresh via `markSaved`/`reloadFromDisk`.
- **Focus**: only the open/focus tools call `window.set_focus()` (plus
  unminimize) — matching the existing window-focus call sites in `lib.rs`.
- **Lifecycle**: `with_global_settings_mut` gets an `mcp::apply_enabled`
  post-write step mirroring `telemetry::apply_settings`; setup starts the
  server when the loaded setting is on; `shutdown.rs` removes the socket.
- **Serialization**: all webview-forwarded calls land on one JS thread per
  window, so writes to one file can never interleave (spec edge case).

## Complexity Tracking

No constitution violations — section intentionally empty.
