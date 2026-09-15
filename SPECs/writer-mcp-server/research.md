# Phase 0 Research: Writer MCP Server

## Decision: MCP protocol implementation — `rmcp` crate

- **Decision**: Use `rmcp` (official Rust SDK for MCP, currently 3.4.0) with the
  `server` and `transport-async-rw` features. Tool definitions use the
  `#[tool_router]` / `#[tool]` macros with `schemars`-derived input schemas.
- **Rationale**: `rmcp::serve_server` accepts any `IntoTransport<RoleServer>`
  transport, and `(R, W)` tuples of `AsyncRead + AsyncWrite` implement it — so a
  `tokio::io::split(UnixStream)` is a first-class server transport with no
  protocol code of ours in the middle. Hand-rolling JSON-RPC + the MCP
  initialize/capabilities/tool-schema handshake is exactly the kind of subtle
  surface that's easy to get wrong, and the constitution says don't reinvent
  the wheel.
- **Alternatives considered**:
  - Hand-rolled NDJSON JSON-RPC server — rejected: duplicates a maintained
    protocol implementation for zero benefit.
  - `rust-mcp-sdk` — rejected: `rmcp` is the official SDK with better docs and
    transport coverage.
- **New dependencies**: `rmcp`, `schemars` (input schemas), `tokio` features
  `net` + `io-util` (tokio is already a dependency). The accept loop runs on
  Tauri's async runtime (tokio under the hood), same as existing `async`
  commands.

## Decision: app↔bridge channel — Unix domain socket in the app data dir

- **Decision**: The app listens on a Unix domain socket at
  `app_data_dir()/mcp.sock` (macOS: `~/Library/Application
Support/com.writer-computer/mcp.sock`). One function,
  `mcp::socket_path()`, computes it and is shared by the app (bind) and CLI
  mode (connect) — single source for the path.
- **Rationale**: Local-only and user-private by construction (the app data
  dir is user-owned; the socket gets `0600`). No TCP port, satisfying FR-006 /
  FR-007 without firewall or port-collision concerns. `writer` CLI install is
  already macOS-only, and `std::os::unix::net::UnixStream` covers macOS +
  Linux with the same code.
- **Stale socket handling**: before bind, if the file exists, probe-connect;
  refused → unlink and bind; accepted → report "already served" as a startup
  failure surfaced in settings (should not happen under
  `tauri-plugin-single-instance`). On disable/quit the listener task is
  aborted and the file removed.
- **Alternatives considered**:
  - TCP on `127.0.0.1` — rejected: opens a network port (spec forbids), needs
    auth to be safe.
  - Windows named pipes — deferred with the rest of non-macOS CLI install.

## Decision: bridge is a dumb byte pipe

- **Decision**: `writer mcp` connects to the socket, exchanges a one-line
  version handshake, then copies bytes stdin→socket and socket→stdout on two
  threads until either side closes. No JSON parsing in the bridge.
- **Rationale**: All MCP logic lives in the running app (spec assumption), so
  bridge/app can never drift on tool behavior. The handshake
  (`{"writer_bridge_hello":{"version":...}}` →
  `{"writer_bridge_ready":{...}}` or `{"writer_bridge_error":{"message":...}}`)
  satisfies the "version mismatch must be reported by the bridge" requirement.
  Keeping the bridge dependency-free preserves `writer_cli.rs`'s existing
  constraint.
- **Framing**: newline-delimited JSON-RPC, same as MCP stdio transport — the
  byte pipe is transparent to it.
- **Connect failure**: socket missing/refused → stderr message covering both
  cases ("Writer is not running or the MCP server is disabled in Settings"),
  exit code 3.

## Decision: tool dispatch split — Rust for workspace truth, webview for editor truth

- **Decision**: The rmcp handler routes each call by where its single source
  of truth lives.
  - **Answered in Rust**: `list_files` (gitignore-aware walk with the sidebar's
    `is_sidebar_file` predicate), `search_files` (`fuzzy_search_from` over
    `file_index` — identical ranking to in-app search), `read_file`
    (`read_file_impl` + boundary/kind/size checks), `open_workspace`,
    `focus_window`, `open_standalone_file` (existing window-creation paths +
    `find_by_workspace` / `find_by_standalone_file` dedupe).
  - **Forwarded to the owning window's webview**: `list_tabs`,
    `describe_window` (internal; powers `list_workspaces` fan-out),
    `write_file`, `create_file`, `create_folder`, `open_file`,
    `reveal_in_sidebar`. Forwarding is an `mcp:request` event emitted to the
    target window's label; a dispatcher in `apps/desktop/src/lib/mcp.ts`
    executes against the existing stores/`lib/tauri.ts` wrappers and replies
    via a new `mcp_respond` command. Rust holds the reply in a
    `pending: HashMap<u64, oneshot::Sender>` with a timeout.
- **Rationale**: dirty flags, open tabs, and the active file exist only in the
  frontend's editor store; sessions on disk are debounced and carry no dirty
  state, so no Rust-side mirror can answer FR-016 correctly. Routing writes
  through the frontend dispatcher means they use literally the same code path
  as a UI save (`writeFile` invoke → `write_file` command → `record_write` +
  atomic write + index update), satisfying FR-018 with zero new write paths.
  Reads stay in Rust because the spec defines read content as what's on disk.
- **Writes**: `create_file` = `createFile` (fails on existing via
  `create_new`) + `writeFile` for content; `write_file` checks
  `openFiles.get(path)?.isDirty` → conflict error, else `writeFile` +
  `markSaved`/`reloadFromDisk` for open tabs. `create_folder` =
  `createDirectory`.
- **Alternatives considered**:
  - Push a state mirror (frontend → Rust on every change) — rejected: second
    source of truth with a real dirty-flag race; the request bridge is needed
    for open/reveal anyway.
  - All tools through the webview — rejected: makes `read_file`/`search`
    depend on webview health for no correctness gain.
- **Window-not-ready**: forward fails with `window_unavailable` on timeout or
  missing label; `AppState::remove` fails that label's pending requests.

## Decision: workspace identity = canonical root path; compact windows = file path

- **Decision**: `list_workspaces` returns `id` = canonical workspace root, or
  the standalone file path for compact windows. Path-taking tools accept this
  id as `workspace`; omitting it is allowed iff exactly one workspace is open,
  else an `ambiguous_workspace` error lists candidates (FR-026).
- **Path safety**: relative paths join the root; all inputs canonicalize and
  must `starts_with(root)` afterwards, which rejects `..` escapes and
  symlinked outs in one check (FR-025). `create_file`/`create_folder`
  canonicalize the parent since the target doesn't exist yet.
- **File kinds**: readable = `.md`, `.markdown`, `.excalidraw.svg` (text
  document kinds Writer opens); writable = `.md`, `.markdown` only — a
  full-file replace on an app-managed drawing SVG or a live drawing session
  risks corrupting state, and PDFs are binary. Listings show the full sidebar
  set (markdown + drawings + PDFs) per FR-028.
- **Caps (documented in contracts/mcp-tools.md)**: `read_file` ≤ 1 MiB;
  `search_files` limit default 50, max 200; `list_files` cap 5,000 entries.

## Decision: settings surface — schema key + status section, applied like telemetry

- **Decision**: `mcp.enabled` boolean, `"scope": "global"`, default `false`,
  in `apps/desktop/shared/settings.schema.json` (the single source of truth).
  Start/stop hooks into the same post-global-write path telemetry uses
  (`with_global_settings_mut` already applies side effects after every global
  write), so toggles apply in-session and hand-edited config reloads apply on
  the next write. Startup reads the setting after settings init.
- **Status UI**: an `mcp_status` command returns enabled/running/failed +
  socket path; a settings-panel extras section (same pattern as
  `latex-suite-extras.tsx`) shows status, the error on failure (FR-004), the
  copyable `{"command": "writer", "args": ["mcp"]}` snippet, and a pointer to
  the existing Install CLI action when `cli_status` reports missing.
- **Alternatives considered**: dedicated IPC channel for the toggle —
  rejected; the schema + post-write hook already does this job for telemetry.

## Open risks accepted for v1

- Dirty-check round-trip is not atomic vs. the user typing mid-call; the
  window is small and the failure mode is a refused write, not data loss.
- A window mid-hydration can't answer `describe_window`; it still appears in
  `list_workspaces` from Rust state with `active_file: null`.
