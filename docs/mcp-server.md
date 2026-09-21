# MCP Server

Writer can expose the open workspaces to local agents — Claude Code, Codex,
or any program that speaks MCP — so they can read and search your notes,
create and amend them, and drive the app's windows and tabs. **It is off
until you turn it on.** With the setting off there is no listener and no
socket file; nothing outside the app can reach this surface.

This document is the complete tool reference and connection guide. If it
disagrees with the code, the code is the bug. Adding or changing a tool
updates this document in the same change.

## Turning it on and off

Settings → Privacy → **MCP server**. The toggle applies immediately in the
running session — no relaunch. The section beneath it shows the live state:

- **Server running** plus the socket path, and the connection snippet.
- **Could not start the MCP server** with the bind error when startup fails;
  a failed bind never prevents the app from launching or opening workspaces.

Turning the setting off closes every connected client at once, removes the
socket file, and fails any in-flight call with `server_disabled`.

## Connecting an agent

Agents never talk to the socket directly. The `writer` command line tool has
an `mcp` subcommand that bridges an MCP client's stdio to the app's private
Unix socket, so any standard MCP client configuration works:

```json
{
  "mcpServers": {
    "writer": {
      "command": "writer",
      "args": ["mcp"]
    }
  }
}
```

If the `writer` command is not on PATH yet, install it from the Writer menu
("Install 'writer' Command Line Tool…") — the settings section says so in
place of the snippet when it detects that.

`writer mcp` fails fast — exit code 3 with "Writer is not running or the MCP
server is disabled" — when the socket is missing, refused, or the bridge
handshake fails. It never hangs and never launches the app.

## How it works

- The server listens on a Unix socket at
  `~/Library/Application Support/com.writer-computer/mcp.sock`, created with
  owner-only permissions (`0600`). It is reachable only from your account on
  this machine; no network port is opened.
- `writer mcp` performs a versioned handshake on connect; a build mismatch
  between the CLI and the running app is reported, not silently forwarded.
- Every agent write goes through the same save path as an editor save, so
  the sidebar, search index, recents, and change tracking behave identically.
- On quit the socket file is removed; on relaunch a stale socket from a
  crash is detected and taken over cleanly.

## Workspaces and paths

Most tools take an optional `workspace` argument — the `id` returned by
`list_workspaces` (a canonical root path, or a file path for a compact
single-file window). It may be omitted only when exactly one workspace is
open: with none open the call fails `no_workspace`, with several it fails
`ambiguous_workspace` and the error detail lists the candidate ids.

Paths are relative to the workspace root, or absolute paths that resolve
inside it after symlink resolution. Anything resolving outside —
`..` segments, symlink escapes, absolute paths elsewhere — is refused with
`outside_workspace` before any disk access.

## Tools

Thirteen tools. Reads see the file as it exists on disk; writes and UI
actions run inside the owning window.

### list_workspaces

List every open workspace, including compact file windows. An empty list is
a valid answer — this tool never fails with `no_workspace`.

- **Input**: `{}`
- **Output**: `{ workspaces: [{ id, kind, root, name, active_file }] }` —
  `kind` is `"workspace"` or `"file"`; `active_file` is `null` for a window
  that cannot be reached.

### list_files

List a workspace's files with the same rules the sidebar uses: hidden files
skipped, `.gitignore` and workspace ignore rules honored, and only the file
kinds Writer shows (markdown, drawings, PDFs).

- **Input**: `{ workspace?, path?, limit? }` — `path` restricts the listing
  to a subdirectory; `limit` defaults to 5,000 and is capped there.
- **Output**: `{ entries: [{ path, relative_path, kind, modified_at }], truncated }`
  — `kind` is `"markdown"`, `"drawing"`, or `"pdf"`; `truncated` is true
  when the cap cut the listing short.

### search_files

Fuzzy-search workspace-relative file paths with the same ranking as the
in-app search.

- **Input**: `{ workspace?, query, limit? }` — `limit` defaults to 50,
  capped at 200.
- **Output**: `{ results: [{ path, relative_path, score }] }`

### read_file

Read a file's full on-disk text, frontmatter included.

- **Input**: `{ workspace?, path }`
- **Output**: `{ path, relative_path, content, modified_at }`
- **Rules**: readable kinds are `.md`, `.markdown`, and `.excalidraw.svg`;
  anything else fails `unsupported_kind`. Files over **1 MiB** fail
  `too_large`.

### list_tabs

List a window's open tabs and which is active, including non-file tabs
(launcher, drawing, pdf, settings).

- **Input**: `{ workspace? }`
- **Output**: `{ tabs: [{ path, location_kind, active }] }` — `path` is
  `null` for tabs not backed by a file.

### create_file

Create a new markdown file with the given content.

- **Input**: `{ workspace?, path, content }`
- **Output**: `{ path, relative_path, modified_at }`
- **Rules**: `.md`/`.markdown` only (`unsupported_kind` otherwise); fails
  `already_exists` if the path exists — use `write_file` to replace.

### write_file

Replace a markdown file's content in full. Full replacement is the only
edit granularity in v1.

- **Input**: `{ workspace?, path, content }`
- **Output**: `{ path, relative_path, modified_at }`
- **Rules**: `not_found` if missing; `.md`/`.markdown` only; **fails
  `unsaved_conflict` when the file is open in a tab with unsaved edits** —
  the user's text is never overwritten. A clean open tab shows the new
  content immediately.

### create_folder

Create a folder inside a workspace.

- **Input**: `{ workspace?, path }`
- **Output**: `{ path, relative_path }`
- **Rules**: `already_exists` if the path exists.

### open_file

Open a file in its workspace window — focuses the tab already showing it, or
opens a new tab (`new_tab` forces a fresh tab even then) — and bring that
window forward. An open never replaces the document showing in a tab. This
tool may steal focus.

- **Input**: `{ workspace?, path, new_tab? }` — `new_tab` defaults to false.
- **Output**: `{ opened: relative_path }`
- **Rules**: `not_found` if missing; no tab is created for a missing file.

### open_workspace

Open a folder as a workspace. If the folder is already open, its window is
focused and its id returned — never a duplicate window.

- **Input**: `{ path, new_window? }` — absolute folder path; `new_window`
  is accepted but reserved, existing windows are never re-rooted.
- **Output**: `{ workspace: id }`

### open_standalone_file

Open a single file in a standalone compact window. Repeating the call
focuses the existing window rather than opening another.

- **Input**: `{ path }` — absolute file path.
- **Output**: `{ opened: path }`

### focus_window

Bring a workspace's window forward (unminimizing it first).

- **Input**: `{ workspace }` — required; there is no default.
- **Output**: `{}`

### reveal_in_sidebar

Expand and highlight a file in its workspace window's sidebar, like the tab
context-menu action. Does not change focus.

- **Input**: `{ workspace?, path }`
- **Output**: `{}`

## Errors

Tool failures are JSON-RPC errors whose `data` carries a machine-readable
`kind` and a human-readable `detail`:

```json
{ "code": -32602, "message": "...", "data": { "kind": "outside_workspace", "detail": "..." } }
```

| `data.kind`           | `code` | Meaning                                                          |
| --------------------- | ------ | ---------------------------------------------------------------- |
| `invalid_params`      | -32602 | Malformed or missing arguments                                   |
| `not_found`           | -32602 | File or folder does not exist                                    |
| `outside_workspace`   | -32602 | Path resolves outside every open workspace                       |
| `ambiguous_workspace` | -32602 | `workspace` omitted with several open; `detail` lists candidates |
| `no_workspace`        | -32602 | No workspace is open                                             |
| `unsupported_kind`    | -32602 | File kind not readable or writable through MCP                   |
| `already_exists`      | -32602 | `create_file`/`create_folder` target exists                      |
| `unsaved_conflict`    | -32603 | Target is open in a tab with unsaved user edits                  |
| `too_large`           | -32602 | Read exceeds the 1 MiB cap                                       |
| `window_unavailable`  | -32603 | Target window closed or did not answer within 5 seconds          |
| `server_disabled`     | -32603 | Feature was toggled off while connected                          |
| `version_mismatch`    | -32603 | Bridge/app version skew (reported at handshake)                  |
| `internal`            | -32603 | Anything else; `detail` carries the message                      |

## Limits and refusals

- `read_file` refuses files over **1 MiB**.
- `search_files` returns at most **200** results (default 50).
- `list_files` returns at most **5,000** entries and reports `truncated`.
- Only markdown (`.md`, `.markdown`) is writable; `.excalidraw.svg` is also
  readable. PDFs appear in listings, search results, and tabs but cannot be
  read or written.
- **Deleting and renaming are not available in v1.** No tool removes or
  moves anything.
- Only the open/focus tools (`open_file`, `open_workspace`,
  `open_standalone_file`, `focus_window`) can move windows or steal focus.
  Every other tool leaves the user's screen alone.
