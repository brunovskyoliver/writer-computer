//! Per-connection task for the `writer mcp` bridge. Each accepted socket
//! runs a one-line version handshake, then becomes a transparent NDJSON
//! pipe into `rmcp::serve_server` — all MCP logic lives in `server.rs`, so
//! bridge and app can never drift on tool behavior.
//!
//! Handshake framing (contracts/bridge-protocol.md): the first line in each
//! direction is the handshake frame; after it succeeds the connection
//! carries plain newline-delimited JSON-RPC.

use crate::error::McpErrorKind;
use crate::mcp::server::WriterMcpServer;
use crate::state::AppState;
use tauri::Manager;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};

const BRIDGE_VERSION: &str = env!("CARGO_PKG_VERSION");
/// The hello line is a small JSON object; anything larger is a peer that
/// is not a Writer bridge.
const MAX_HANDSHAKE_LINE: usize = 8192;

/// Read and validate the hello, write the reply. Returns the stream wrapped
/// in the same `BufReader` the handshake consumed from — buffered bytes past
/// the hello newline belong to the JSON-RPC stream and must not be dropped.
pub async fn handshake<S>(stream: S) -> Result<BufReader<S>, ()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut stream = BufReader::new(stream);
    let mut line = Vec::new();
    let read = {
        let mut limited = (&mut stream).take(MAX_HANDSHAKE_LINE as u64 + 1);
        limited.read_until(b'\n', &mut line).await.map_err(|_| ())?
    };
    let hello_version = (read > 0 && read <= MAX_HANDSHAKE_LINE)
        .then(|| serde_json::from_slice::<serde_json::Value>(&line).ok())
        .flatten()
        .and_then(|value| {
            value
                .get("writer_bridge_hello")?
                .get("version")?
                .as_str()
                .map(str::to_owned)
        });

    let reply = match hello_version.as_deref() {
        Some(BRIDGE_VERSION) => {
            serde_json::json!({"writer_bridge_ready": {"version": BRIDGE_VERSION}})
        }
        Some(other) => serde_json::json!({
            "writer_bridge_error": {
                "kind": McpErrorKind::VersionMismatch.as_str(),
                "message": format!(
                    "writer bridge version {other} does not match the running app ({BRIDGE_VERSION}); reinstall the writer CLI"
                ),
            }
        }),
        None => serde_json::json!({
            "writer_bridge_error": {
                "kind": McpErrorKind::VersionMismatch.as_str(),
                "message": "unrecognized bridge handshake",
            }
        }),
    };
    let mut reply_bytes = serde_json::to_vec(&reply).map_err(|_| ())?;
    reply_bytes.push(b'\n');
    stream.write_all(&reply_bytes).await.map_err(|_| ())?;
    stream.flush().await.map_err(|_| ())?;

    match hello_version.as_deref() {
        Some(BRIDGE_VERSION) => Ok(stream),
        _ => Err(()),
    }
}

/// One accepted connection = one bridge session. Handshake, serve rmcp over
/// the split stream until EOF or abort, then fail whatever this connection
/// still had in flight and unregister.
#[cfg(unix)]
pub async fn serve_connection(app: tauri::AppHandle, stream: tokio::net::UnixStream, conn_id: u64) {
    let Ok(buffered) = handshake(stream).await else {
        return;
    };
    let service = WriterMcpServer::new(app.clone(), conn_id);
    let (reader, writer) = tokio::io::split(buffered);
    if let Ok(running) = rmcp::serve_server(service, (reader, writer)).await {
        let _ = running.waiting().await;
    }
    crate::mcp::fail_pending_for_conn(app.state::<AppState>().inner(), conn_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tauri::async_runtime::block_on(f)
    }

    #[test]
    fn accepts_a_matching_version_and_keeps_buffered_bytes() {
        block_on(async {
            let (server, client) = tokio::io::duplex(4096);
            let mut client = BufReader::new(client);
            let task = tauri::async_runtime::spawn(handshake(server));
            let hello = format!(
                "{{\"writer_bridge_hello\":{{\"version\":\"{BRIDGE_VERSION}\"}}}}\n{{\"jsonrpc\":\"2.0\"}}\n"
            );
            // Hello and the first JSON-RPC frame in one write: the line past
            // the newline must still be readable from the returned reader.
            client.write_all(hello.as_bytes()).await.unwrap();
            let mut reply = Vec::new();
            client.read_until(b'\n', &mut reply).await.unwrap();
            let json: serde_json::Value = serde_json::from_slice(&reply).unwrap();
            assert_eq!(
                json["writer_bridge_ready"]["version"].as_str().unwrap(),
                BRIDGE_VERSION
            );

            let mut buffered = task.await.unwrap().expect("handshake should accept");
            let mut line = Vec::new();
            buffered.read_until(b'\n', &mut line).await.unwrap();
            assert_eq!(line, b"{\"jsonrpc\":\"2.0\"}\n");
        });
    }

    #[test]
    fn rejects_a_mismatched_version() {
        block_on(async {
            let (server, client) = tokio::io::duplex(4096);
            let mut client = BufReader::new(client);
            let task = tauri::async_runtime::spawn(handshake(server));
            client
                .write_all(b"{\"writer_bridge_hello\":{\"version\":\"0.0.0\"}}\n")
                .await
                .unwrap();
            let mut reply = Vec::new();
            client.read_until(b'\n', &mut reply).await.unwrap();
            let json: serde_json::Value = serde_json::from_slice(&reply).unwrap();
            assert_eq!(json["writer_bridge_error"]["kind"], "version_mismatch");
            assert!(task.await.unwrap().is_err());
        });
    }

    #[test]
    fn rejects_an_unrecognized_hello() {
        block_on(async {
            let (server, client) = tokio::io::duplex(4096);
            let mut client = BufReader::new(client);
            let task = tauri::async_runtime::spawn(handshake(server));
            client.write_all(b"not json at all\n").await.unwrap();
            let mut reply = Vec::new();
            client.read_until(b'\n', &mut reply).await.unwrap();
            let json: serde_json::Value = serde_json::from_slice(&reply).unwrap();
            assert!(json.get("writer_bridge_error").is_some());
            assert!(task.await.unwrap().is_err());
        });
    }
}
