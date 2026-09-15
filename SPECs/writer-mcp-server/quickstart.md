# Quickstart: Writer MCP Server

Runnable validation that the feature works end to end. Prerequisites:
a built Writer dev build (`vp dev` / `vp run tauri dev` from `apps/desktop`)
and the `writer` command on PATH (Install CLI action, or
`WRITER_APP_PATH`-backed symlink for dev builds).

## 1. Off by default (FR-002, SC-007)

1. Launch Writer. Confirm `~/Library/Application Support/com.writer-computer/mcp.sock`
   does not exist.
2. `writer mcp` → exits 3 with "Writer is not running or the MCP server is
   disabled" (it must not hang or launch the app — FR-008).

## 2. Enable and connect (FR-001/003/005, SC-001)

1. Settings → enable the MCP server toggle.
2. The settings surface shows **running**, the socket path, and the snippet
   `{ "command": "writer", "args": ["mcp"] }`.
3. Smoke-test the bridge by hand (it speaks NDJSON on stdio):

   ```bash
   printf '%s\n' \
     '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
     '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
     '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | writer mcp
   ```

   Expected: an `initialize` result naming `writer`, then a `tools/list`
   result containing the tools in [contracts/mcp-tools.md](./contracts/mcp-tools.md).

## 3. Read and search (User Story 1)

With a workspace open containing a few markdown files:

- `tools/call` `list_workspaces` → the open root plus `active_file`.
- `search_files` `{"query": "readme"}` → same order as in-app fuzzy search.
- `read_file` `{"path": "notes/todo.md"}` → full on-disk text.
- `read_file` `{"path": "../outside.md"}` or an absolute path outside the
  root → `outside_workspace` error, nothing read (SC-004).
- Open a second window on another folder → `search_files` without
  `workspace` → `ambiguous_workspace` listing both ids (FR-026).

## 4. Contribute (User Story 2)

- `create_file` `{"path": "agent-draft.md", "content": "# Draft\n"}` → file
  on disk and in the sidebar. Repeat → `already_exists`.
- `write_file` on a note open in a tab with no edits → tab shows the new
  content immediately (FR-017).
- Type unsaved text in that tab → `write_file` again → `unsaved_conflict`,
  typed text intact (FR-016, SC-003).

## 5. Open and control (User Story 3)

- `open_file` `{"path": "notes/todo.md", "new_tab": true}` → window comes
  forward with the note in a new tab (SC-005).
- `reveal_in_sidebar` on another file → sidebar expands/highlights it.
- `open_workspace` on an already-open folder → existing window focuses, no
  duplicate (FR-021); on a new folder → new window.
- `open_standalone_file` on a markdown path → compact window.

## 6. Disable and quit (User Story 4, SC-006/007)

1. With an agent connected, toggle the setting off → the bridge's socket
   closes (pending calls fail with `server_disabled`), `mcp.sock` is gone,
   new `writer mcp` exits 3.
2. Re-enable, quit Writer → socket file removed; relaunch with the setting
   still on → server binds cleanly (no stale-socket failure).

## Automated checks

- `cargo test` in `apps/desktop/src-tauri` covers: path resolution and
  `..`/symlink escapes, workspace→window resolution and ambiguity,
  handshake accept/reject, error-kind mapping, stale-socket takeover.
- `vp test` covers the webview dispatcher: dirty-conflict refusal,
  create-then-write ordering, unknown-tool error.
- `vp check`, `cargo clippy`, `cargo fmt --check` per the constitution's
  quality gates.
