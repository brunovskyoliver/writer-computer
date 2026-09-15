# Data Model: Writer MCP Server

Entities, their fields, and the rules the spec's requirements impose on them.

## Workspace

An open folder hosted by one Writer window, or a degenerate file-scoped
window (compact/standalone mode).

| Field          | Type                    | Source of truth                                                                              |
| -------------- | ----------------------- | -------------------------------------------------------------------------------------------- |
| `id`           | string                  | Canonical root path; for a compact window, the standalone file path. Stable for the session. |
| `kind`         | `"workspace" \| "file"` | `chromeMode` / `standalone_file` presence                                                    |
| `root`         | string \| null          | `WorkspaceState.workspace_root` (canonicalized at open)                                      |
| `name`         | string                  | Root's last path component                                                                   |
| `active_file`  | string \| null          | Frontend `editor-store.activeFilePath`                                                       |
| `window_label` | string                  | `AppState` windows map key (internal routing key, not exposed as the workspace id)           |

**Rules**

- One window per workspace is already guaranteed by `find_by_workspace`
  dedupe; the id therefore resolves to exactly one window (FR-009, edge
  cases).
- A compact window's "workspace" scope is its single file: reads/writes for
  it are limited to that path (spec edge cases).
- `list_workspaces` fans out `describe_window` to every registered window;
  a window that doesn't answer still appears (from Rust state) with
  `active_file: null`.

## Document

A file inside a workspace that Writer can open in a tab.

| Field           | Type                                          | Notes                                                            |
| --------------- | --------------------------------------------- | ---------------------------------------------------------------- |
| `path`          | string                                        | Absolute canonical path                                          |
| `relative_path` | string                                        | Relative to workspace root (agent-facing)                        |
| `kind`          | `"markdown" \| "drawing" \| "pdf" \| "other"` | Same classification as `is_sidebar_file`                         |
| `modified_at`   | u64                                           | Unix seconds                                                     |
| `dirty`         | bool                                          | Frontend `OpenFile.isDirty` — only meaningful when open in a tab |

**Validation rules**

- Path resolution (FR-025): relative paths resolve against the named/defaulted
  workspace root; the candidate is canonicalized and must `starts_with(root)`
  after canonicalization, which rejects `..` escapes and symlinked escapes.
  `create_*` targets canonicalize the parent (the file may not exist yet).
- Kind limits (FR-028): readable = `.md`, `.markdown`, `.excalidraw.svg`;
  writable = `.md`, `.markdown`; everything else is `unsupported_kind`
  (listings still include it).
- Size cap: `read_file` refuses files over 1 MiB with `too_large`.
- Write rules: `create_file` on an existing path → `already_exists`;
  `write_file` on an open dirty tab → `unsaved_conflict`; neither deletes nor
  renames exist (FR-027).

## Tab

An open view of a document in a window.

| Field           | Type   | Notes                                                       |
| --------------- | ------ | ----------------------------------------------------------- |
| `path`          | string | Document path (file-kind locations only)                    |
| `location_kind` | string | `file`, `drawing`, `pdf`, `launcher`, ... (from `Location`) |
| `active`        | bool   | `editor-store.activeTabId` membership                       |

`list_tabs` reports every tab including non-file kinds so an agent sees the
real window state.

## Tool call

One agent request: `{ tool, args }` where `args.workspace` is optional under
the defaulting rule.

**Resolution order**

1. `workspace` given → must match an open workspace id → target window label.
2. Omitted + exactly one workspace → that one. Omitted + none → `no_workspace`.
   Omitted + several → `ambiguous_workspace` with the candidate list.
3. Workspace-free tools (`list_workspaces`, `open_workspace`,
   `open_standalone_file`) skip this step.

**Error kinds** (carried in JSON-RPC error `data.kind`; see
contracts/mcp-tools.md): `not_found`, `outside_workspace`,
`ambiguous_workspace`, `no_workspace`, `unsaved_conflict`, `already_exists`,
`unsupported_kind`, `too_large`, `window_unavailable`, `server_disabled`,
`invalid_params`, `internal`.

## Server status

| Field         | Type                                                          |
| ------------- | ------------------------------------------------------------- |
| `enabled`     | bool — `mcp.enabled` global setting                           |
| `state`       | `"stopped" \| "running" \| "failed"`                          |
| `error`       | string \| null — bind failure detail for the settings surface |
| `socket_path` | string                                                        |

Transitions: `stopped → running` on enable/startup-with-enabled;
`running → stopped` on disable or quit; `* → failed` on bind error
(never blocks launch, FR-004). Disabling fails all pending tool calls.

## Bridge session

One `writer mcp` process ↔ one socket connection.

| Field            | Type                                                         |
| ---------------- | ------------------------------------------------------------ |
| `bridge_version` | string — `CARGO_PKG_VERSION` of the CLI process              |
| `app_version`    | string — checked equal at handshake, else `version_mismatch` |

The bridge performs the handshake on stdin/stdout-free side channels: the
first line on the socket in each direction is the handshake frame; after it
succeeds the connection is a transparent NDJSON byte pipe.
