# Contract: MCP Tool Surface

What an agent sees over MCP (`tools/list`, `tools/call`). This is the
agent-facing contract; `docs/mcp-server.md` renders the same list for users
and must be updated in the same change as any tool addition (FR-031).

All workspace-scoped tools take an optional `workspace` argument: the `id`
from `list_workspaces` (a canonical root path, or a standalone file path for
compact windows). It may be omitted only when exactly one workspace is open.

Paths are relative to the workspace root, or absolute paths that resolve
inside it after symlink resolution. Anything resolving outside is refused
with `outside_workspace`.

## Tools

### list_workspaces

Returns every open workspace including file-scoped compact windows.

- **Input**: `{}`
- **Output**: `{ workspaces: [{ id, kind: "workspace"|"file", root, name, active_file }] }`
- **Implementation**: Rust enumerates `AppState` windows; each window's
  webview answers a `describe_window` fan-out for `active_file`. Unreachable
  windows appear with `active_file: null`.
- **Never fails** with no-workspace: an empty list is a valid answer.

### list_files

- **Input**: `{ workspace?, path?, limit? }` — `path` restricts to a
  subdirectory; `limit` defaults to 5,000 (the cap).
- **Output**: `{ entries: [{ path, relative_path, kind, modified_at }], truncated }`
- **Rules**: same ignore rules and file-kind filter as the sidebar
  (gitignore-aware walk + `is_sidebar_file`: markdown, drawings, PDFs).

### search_files

- **Input**: `{ workspace?, query, limit? }` — `limit` default 50, max 200.
- **Output**: `{ results: [{ path, relative_path, score }] }`
- **Rules**: `fuzzy_search_from` over the workspace `file_index` — identical
  ranking to in-app search.

### read_file

- **Input**: `{ workspace?, path }`
- **Output**: `{ path, relative_path, content, modified_at }`
- **Rules**: content is the file's on-disk text, frontmatter included;
  `.md`/`.markdown`/`.excalidraw.svg` only; > 1 MiB → `too_large`.

### list_tabs

- **Input**: `{ workspace? }`
- **Output**: `{ tabs: [{ path, location_kind, active }] }`
- **Implementation**: forwarded to the owning window's webview.

### create_file

- **Input**: `{ workspace?, path, content }`
- **Output**: `{ path, relative_path, modified_at }`
- **Rules**: fails with `already_exists` if the path exists (FR-014);
  markdown kinds only; appears in the sidebar via the normal watcher/index
  path.

### write_file

- **Input**: `{ workspace?, path, content }` — full replacement, the only
  edit granularity in v1.
- **Output**: `{ path, relative_path, modified_at }`
- **Rules**: `not_found` if missing; `unsaved_conflict` if the file is open
  in a tab with unsaved changes (FR-016); a clean open tab shows the new
  content without user action (FR-017); goes through the same `write_file`
  command as an editor save (FR-018).

### create_folder

- **Input**: `{ workspace?, path }`
- **Output**: `{ path, relative_path }`
- **Rules**: `already_exists` if present.

### open_file

- **Input**: `{ workspace?, path, new_tab? }` — `new_tab` default false.
- **Output**: `{ opened: relative_path }`
- **Rules**: `not_found` if missing. Opens in the window's active tab (or a
  new tab), then brings that window forward. May steal focus (FR-020).

### open_workspace

- **Input**: `{ path, new_window? }` — absolute folder path.
- **Output**: `{ workspace: id }`
- **Rules**: if the folder is already open, its window is focused and its id
  returned (no duplicate, FR-021); otherwise a new window opens on it.

### open_standalone_file

- **Input**: `{ path }` — absolute file path.
- **Output**: `{ opened: path }`
- **Rules**: opens the file in a compact window; repeat opens focus the
  existing window (`find_by_standalone_file` dedupe, FR-024).

### focus_window

- **Input**: `{ workspace }` — required; there is no sensible default.
- **Output**: `{}` — brings the workspace's window forward (FR-023).

### reveal_in_sidebar

- **Input**: `{ workspace?, path }`
- **Output**: `{}` — expands and highlights the entry like the tab
  context-menu action (`revealPathInSidebar`), no focus change (FR-022).

## Error contract

Tool failures return a JSON-RPC error with `code` and a `data` object:

```json
{ "code": -32602, "message": "...", "data": { "kind": "outside_workspace", "detail": "..." } }
```

| `data.kind`           | `code` | Meaning                                                          |
| --------------------- | ------ | ---------------------------------------------------------------- |
| `invalid_params`      | -32602 | Malformed/missing arguments                                      |
| `not_found`           | -32602 | File or folder does not exist                                    |
| `outside_workspace`   | -32602 | Path resolves outside every open workspace                       |
| `ambiguous_workspace` | -32602 | `workspace` omitted with several open; `detail` lists candidates |
| `no_workspace`        | -32602 | No workspace open                                                |
| `unsupported_kind`    | -32602 | File kind not readable/writable through MCP                      |
| `already_exists`      | -32602 | `create_file`/`create_folder` target exists                      |
| `unsaved_conflict`    | -32603 | Target open in a tab with unsaved user edits                     |
| `too_large`           | -32602 | Read exceeds the 1 MiB cap                                       |
| `window_unavailable`  | -32603 | Target window closed or did not answer in time                   |
| `server_disabled`     | -32603 | Feature toggled off while connected                              |
| `version_mismatch`    | -32603 | Bridge/app version skew (reported at handshake)                  |
| `internal`            | -32603 | Anything else; `detail` carries the message                      |
