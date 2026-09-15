use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("IO error: {0}")]
    Io(String),
    #[error("Not found: {0}")]
    NotFound(String),
    #[error("Already exists: {0}")]
    AlreadyExists(String),
    #[error("Invalid path: {0}")]
    InvalidPath(String),
    #[error("No workspace is open")]
    NoWorkspace,
    #[error("Invalid session: {0}")]
    InvalidSession(String),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        AppError::Io(err.to_string())
    }
}

/// The `data.kind` values of an MCP tool failure, per
/// `SPECs/writer-mcp-server/contracts/mcp-tools.md`. The wire form is the
/// snake_case string; `code` is the JSON-RPC error code each kind maps to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpErrorKind {
    InvalidParams,
    NotFound,
    OutsideWorkspace,
    AmbiguousWorkspace,
    NoWorkspace,
    UnsupportedKind,
    AlreadyExists,
    UnsavedConflict,
    TooLarge,
    WindowUnavailable,
    ServerDisabled,
    VersionMismatch,
    Internal,
}

impl McpErrorKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidParams => "invalid_params",
            Self::NotFound => "not_found",
            Self::OutsideWorkspace => "outside_workspace",
            Self::AmbiguousWorkspace => "ambiguous_workspace",
            Self::NoWorkspace => "no_workspace",
            Self::UnsupportedKind => "unsupported_kind",
            Self::AlreadyExists => "already_exists",
            Self::UnsavedConflict => "unsaved_conflict",
            Self::TooLarge => "too_large",
            Self::WindowUnavailable => "window_unavailable",
            Self::ServerDisabled => "server_disabled",
            Self::VersionMismatch => "version_mismatch",
            Self::Internal => "internal",
        }
    }

    /// Kinds arriving from the webview bridge or the socket handshake are
    /// strings; anything unrecognized collapses to `internal` rather than
    /// breaking the reply path.
    pub fn from_kind_str(kind: &str) -> Self {
        match kind {
            "invalid_params" => Self::InvalidParams,
            "not_found" => Self::NotFound,
            "outside_workspace" => Self::OutsideWorkspace,
            "ambiguous_workspace" => Self::AmbiguousWorkspace,
            "no_workspace" => Self::NoWorkspace,
            "unsupported_kind" => Self::UnsupportedKind,
            "already_exists" => Self::AlreadyExists,
            "unsaved_conflict" => Self::UnsavedConflict,
            "too_large" => Self::TooLarge,
            "window_unavailable" => Self::WindowUnavailable,
            "server_disabled" => Self::ServerDisabled,
            "version_mismatch" => Self::VersionMismatch,
            _ => Self::Internal,
        }
    }

    /// JSON-RPC `code` per the contract's error table: argument/routing
    /// failures are `-32602`, execution/environment failures `-32603`.
    pub fn code(self) -> rmcp::model::ErrorCode {
        match self {
            Self::InvalidParams
            | Self::NotFound
            | Self::OutsideWorkspace
            | Self::AmbiguousWorkspace
            | Self::NoWorkspace
            | Self::UnsupportedKind
            | Self::AlreadyExists
            | Self::TooLarge => rmcp::model::ErrorCode::INVALID_PARAMS,
            Self::UnsavedConflict
            | Self::WindowUnavailable
            | Self::ServerDisabled
            | Self::VersionMismatch
            | Self::Internal => rmcp::model::ErrorCode::INTERNAL_ERROR,
        }
    }
}

/// A tool-call failure: the kind an agent branches on plus a human detail.
/// Converted to `rmcp::ErrorData` at the tool boundary so the JSON-RPC
/// error carries `{code, message, data: {kind, detail}}`.
#[derive(Debug)]
pub struct McpToolError {
    pub kind: McpErrorKind,
    pub detail: String,
}

impl McpToolError {
    pub fn new(kind: McpErrorKind, detail: impl Into<String>) -> Self {
        Self {
            kind,
            detail: detail.into(),
        }
    }
}

impl From<McpToolError> for rmcp::ErrorData {
    fn from(err: McpToolError) -> Self {
        rmcp::ErrorData::new(
            err.kind.code(),
            err.detail.clone(),
            Some(serde_json::json!({
                "kind": err.kind.as_str(),
                "detail": err.detail,
            })),
        )
    }
}
