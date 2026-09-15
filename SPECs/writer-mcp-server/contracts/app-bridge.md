# Contract: App ↔ Webview Tool Bridge

How a tool call that needs live editor state reaches the window that owns it.
This is an internal contract between `src-tauri/src/mcp/` and
`apps/desktop/src/lib/mcp.ts`.

## Why it exists

Dirty flags, open tabs, the active file, and reveal/open actions live in the
frontend stores. The Rust side cannot answer or perform them, and routing
through the webview means agent writes execute the literal UI save path —
satisfying FR-016/017/018 with no second write path.

## Request (Rust → webview)

```ts
// emitted via app.emit_to(label, "mcp:request", payload)
interface McpRequest {
  request_id: number; // key into AppState's pending map
  tool: string; // webview-side tool name
  args: unknown; // tool input after workspace/path resolution
}
```

Rust resolves the workspace id to a window label _before_ emitting
(`find_by_workspace` / `find_by_standalone_file`), so a request always
targets exactly one window.

`describe_window` is a special broadcast tool used by `list_workspaces`: it
is emitted to every label and each reply contributes one workspace entry.

## Response (webview → Rust)

```ts
// new Tauri command
mcp_respond(request_id: number, result: unknown)          // success
mcp_respond(request_id: number, error: { kind, detail })  // failure
```

Rust completes the pending `oneshot` and maps the outcome onto the MCP
tool result or the error kinds in `mcp-tools.md`.

## Webview-side tools

| `tool`              | Executes                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `describe_window`   | `{root, chromeMode, standaloneFile, activeFilePath}` from workspace/editor stores           |
| `list_tabs`         | `tabs` + `layout` → `{path, location_kind, active}[]`                                       |
| `write_file`        | dirty check on `openFiles` → `tauri.writeFile` → `markSaved`/`reloadFromDisk` for open tabs |
| `create_file`       | `tauri.createFile` (create-new semantics) → `tauri.writeFile` for content                   |
| `create_folder`     | `tauri.createDirectory`                                                                     |
| `open_file`         | `openFile` / `openFileInNewTab` on the editor store                                         |
| `reveal_in_sidebar` | `revealPathInSidebar`                                                                       |

## Failure rules

- Per-request timeout (5 s) → `window_unavailable`.
- `AppState::remove(label)` fails that label's pending requests.
- Dispatch of an unknown tool name → `internal` error, logged.
- The dispatcher never throws across the bridge: every handler outcome is a
  `result` or an `{kind, detail}` error (constitution IV).
