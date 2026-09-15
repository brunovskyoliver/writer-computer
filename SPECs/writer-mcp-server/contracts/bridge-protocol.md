# Contract: `writer mcp` Bridge Protocol

The wire between the `writer mcp` stdio bridge and the running app.
Transport: Unix domain socket at `app_data_dir()/mcp.sock` — the path comes
from one shared `mcp::socket_path()` used by both the app (bind) and the CLI
(connect). Socket file permissions `0600`; the file is removed on disable
and on app quit.

## Handshake

First line each direction, before any MCP traffic:

```text
bridge → app:  {"writer_bridge_hello": {"version": "<cargo pkg version>"}}
app → bridge:  {"writer_bridge_ready": {"version": "<cargo pkg version>"}}
            or {"writer_bridge_error": {"kind": "version_mismatch"|"server_disabled", "message": "..."}}
```

- Versions must be equal (`writer` is a symlink into the same app bundle,
  so skew means a stale install — spec assumption: bridge and app ship in the
  same release).
- On `writer_bridge_error` the bridge prints `message` to stderr and exits 3.
- On handshake success the bridge stops interpreting bytes entirely.

## Data phase

Transparent bidirectional byte pipe: process stdin → socket, socket →
process stdout. MCP's stdio transport is newline-delimited JSON-RPC, and the
app's side speaks the same framing over the socket, so the pipe needs no
framing logic.

- Bridge exit codes follow the CLI convention: `0` clean EOF, `2` usage
  error, `3` runtime failure (connect refused → "Writer is not running or
  the MCP server is disabled in Settings"; never hangs, never launches the
  app — FR-008).
- App side: each accepted connection runs one `rmcp::serve_server` over
  `tokio::io::split(stream)`. Socket EOF or disable → the service is dropped
  and pending tool calls fail with `server_disabled`/`window_unavailable`.

## Client configuration snippet

Shown in the settings surface (FR-005, FR-008a):

```json
{ "mcpServers": { "writer": { "command": "writer", "args": ["mcp"] } } }
```

If `cli_status` reports the `writer` command missing, the surface points at
the existing Install CLI action instead of the snippet.
