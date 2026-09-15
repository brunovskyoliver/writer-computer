//! IPC commands for the MCP feature: the webview's reply channel for
//! forwarded tool calls, and the status readout for the settings surface.

use crate::error::{AppError, McpErrorKind};
use crate::mcp::{self, McpStatusReport, WebviewCallError};
use crate::state::AppState;
use serde::Deserialize;
use serde_json::Value;
use tauri::Manager;

#[derive(Debug, Deserialize)]
pub struct McpRespondError {
    pub kind: String,
    #[serde(default)]
    pub detail: Option<String>,
}

/// Complete a pending forwarded call. Exactly one of `result` / `error`
/// arrives (the dispatcher never throws, it reports); a missing-or-unknown
/// `request_id` means the call already timed out — the reply is dropped.
#[tauri::command]
pub fn mcp_respond(
    request_id: u64,
    result: Option<Value>,
    error: Option<McpRespondError>,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    let reply = match error {
        Some(error) => Err(WebviewCallError {
            kind: McpErrorKind::from_kind_str(&error.kind),
            detail: error.detail.unwrap_or_default(),
        }),
        None => Ok(result.unwrap_or(Value::Null)),
    };
    mcp::complete_pending(app.state::<AppState>().inner(), request_id, reply);
    Ok(())
}

#[tauri::command]
pub fn mcp_status(app: tauri::AppHandle) -> Result<McpStatusReport, AppError> {
    Ok(mcp::status_report(app.state::<AppState>().inner()))
}
