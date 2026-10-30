//! Serializable contracts shared by the local agent HTTP surface.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub(crate) fn nullable_patch<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// A supported local agent engine.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EngineName {
    /// Anthropic Claude Code.
    Claude,
    /// OpenAI Codex CLI.
    Codex,
    /// Cursor agent.
    Cursor,
    /// Qwen agent.
    Qwen,
    /// GLM agent.
    Glm,
}

impl EngineName {
    /// Returns the TypeScript-compatible engine name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Cursor => "cursor",
            Self::Qwen => "qwen",
            Self::Glm => "glm",
        }
    }
}

/// A persisted project workspace.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProject {
    /// Stable project identity.
    pub id: String,
    /// User-facing project name.
    pub name: String,
    /// Optional user-facing description.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Absolute local workspace path.
    pub root_path: String,
    /// Preferred command-line provider.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preferred_cli: Option<EngineName>,
    /// Optional model override.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_model: Option<String>,
    /// Provider session used only for legacy Claude resumption.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_claude_session_id: Option<String>,
    /// Whether Claude Code Router is selected.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub use_ccr: Option<bool>,
    /// Whether the HumanChrome integration is exposed to this provider.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enable_human_chrome: Option<bool>,
    /// ISO-8601 creation time.
    pub created_at: String,
    /// ISO-8601 last update time.
    pub updated_at: String,
    /// ISO-8601 activity time.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_active_at: Option<String>,
}

/// Input accepted by `POST /agent/projects`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectInput {
    /// Existing project identity, if the caller is updating it.
    pub id: Option<String>,
    /// Project name.
    pub name: String,
    /// Optional description.
    pub description: Option<String>,
    /// Project workspace root.
    pub root_path: String,
    /// Preferred engine.
    pub preferred_cli: Option<EngineName>,
    /// Optional model.
    pub selected_model: Option<String>,
    /// Claude Code Router setting.
    pub use_ccr: Option<bool>,
    /// HumanChrome integration setting.
    pub enable_human_chrome: Option<bool>,
    /// Whether a missing root may be created.
    pub allow_create: Option<bool>,
}

/// A persisted provider session.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    /// Stable session identity.
    pub id: String,
    /// Owning project identity.
    pub project_id: String,
    /// Selected provider.
    pub engine_name: EngineName,
    /// Provider-native session identity.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine_session_id: Option<String>,
    /// Optional display name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Optional model override.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Provider permission mode.
    pub permission_mode: String,
    /// Whether headless permission bypass was requested.
    pub allow_dangerously_skip_permissions: bool,
    /// Opaque JSON copied without lossy remapping.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_prompt_config: Option<Value>,
    /// Opaque provider options.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options_config: Option<Value>,
    /// Cached provider management metadata.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub management_info: Option<Value>,
    /// ISO-8601 creation time.
    pub created_at: String,
    /// ISO-8601 last update time.
    pub updated_at: String,
    /// Preview derived from the first user message for session list rendering.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    /// Validated special rendering metadata associated with [`Self::preview`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_meta: Option<Value>,
}

/// Input accepted when creating a session.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionInput {
    /// Selected provider.
    pub engine_name: EngineName,
    /// Optional display name.
    pub name: Option<String>,
    /// Optional model override.
    pub model: Option<String>,
    /// Permission mode; defaults to `bypassPermissions`.
    pub permission_mode: Option<String>,
    /// Permission bypass flag.
    pub allow_dangerously_skip_permissions: Option<bool>,
    /// Provider prompt JSON.
    pub system_prompt_config: Option<Value>,
    /// Provider configuration JSON.
    pub options_config: Option<Value>,
}

/// Input accepted when updating a session.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSessionInput {
    /// Provider-native session ID; null clears it.
    #[serde(default, deserialize_with = "nullable_patch")]
    pub engine_session_id: Option<Option<String>>,
    /// Display name; null clears it.
    #[serde(default, deserialize_with = "nullable_patch")]
    pub name: Option<Option<String>>,
    /// Model; null clears it.
    #[serde(default, deserialize_with = "nullable_patch")]
    pub model: Option<Option<String>>,
    /// Permission mode; null clears it.
    #[serde(default, deserialize_with = "nullable_patch")]
    pub permission_mode: Option<Option<String>>,
    /// Permission bypass setting; null clears it.
    #[serde(default, deserialize_with = "nullable_patch")]
    pub allow_dangerously_skip_permissions: Option<Option<bool>>,
    /// Cached provider management metadata; null clears it.
    #[serde(default, deserialize_with = "nullable_patch")]
    pub management_info: Option<Option<Value>>,
    /// Prompt configuration; null clears it.
    #[serde(default, deserialize_with = "nullable_patch")]
    pub system_prompt_config: Option<Option<Value>>,
    /// Provider options; null clears them.
    #[serde(default, deserialize_with = "nullable_patch")]
    pub options_config: Option<Option<Value>>,
}

/// One durable transcript item.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStoredMessage {
    /// Stable message identity.
    pub id: String,
    /// Owning project identity.
    pub project_id: String,
    /// Owning session identity.
    pub session_id: String,
    /// Optional conversation partition.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    /// user, assistant, tool, or system.
    pub role: String,
    /// Renderable content.
    pub content: String,
    /// chat, tool_use, tool_result, or status.
    pub message_type: String,
    /// Opaque event metadata.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
    /// Provider source.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cli_source: Option<String>,
    /// Request correlation identity.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    /// ISO-8601 creation time.
    pub created_at: String,
}

/// Realtime message payload.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessage {
    /// Stable message identity.
    pub id: String,
    /// Session receiving the message.
    pub session_id: String,
    /// Message role.
    pub role: String,
    /// Content currently available.
    pub content: String,
    /// Message rendering type.
    pub message_type: String,
    /// Provider source.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cli_source: Option<String>,
    /// Request correlation identity.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    /// Whether more text is expected for this logical message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_streaming: Option<bool>,
    /// Whether this logical message is complete.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_final: Option<bool>,
    /// ISO-8601 creation time.
    pub created_at: String,
    /// Optional metadata.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

/// Events emitted to SSE clients.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum RealtimeEvent {
    /// A stream message.
    Message { data: AgentMessage },
    /// A provider status change.
    Status { data: StatusEvent },
    /// A terminal or non-terminal failure.
    Error {
        error: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<ErrorContext>,
    },
    /// Initial SSE connection acknowledgement.
    Connected { data: ConnectedEvent },
    /// Keepalive event.
    Heartbeat { data: HeartbeatEvent },
    /// Provider usage payload, preserving all provider-specific metrics.
    Usage { data: Value },
}

/// Provider status payload.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEvent {
    /// Session receiving status.
    pub session_id: String,
    /// starting, ready, running, completed, error, or cancelled.
    pub status: String,
    /// Human-readable context.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Provider-specific status metadata such as tool progress or login requirements.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
    /// Request correlation identity.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

/// Correlation context for an error.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorContext {
    /// Session identity.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Request identity.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

/// SSE connection acknowledgement.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectedEvent {
    /// Connected session identity.
    pub session_id: String,
    /// Wire transport.
    pub transport: String,
    /// ISO-8601 connection time.
    pub timestamp: String,
}

/// SSE heartbeat payload.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct HeartbeatEvent {
    /// ISO-8601 emission time.
    pub timestamp: String,
}

/// A file or image supplied with an agent turn.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAttachment {
    /// Attachment kind.
    pub r#type: String,
    /// Original filename.
    pub name: String,
    /// MIME type declared by the caller.
    pub mime_type: String,
    /// Base64-encoded bytes.
    pub data_base64: String,
}

/// Input accepted by `POST /agent/chat/:sessionId/act`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentActRequest {
    /// Provider instruction.
    pub instruction: String,
    /// Optional provider override.
    pub cli_preference: Option<EngineName>,
    /// Optional model override.
    pub model: Option<String>,
    /// Attachments supplied with the turn.
    pub attachments: Option<Vec<AgentAttachment>>,
    /// Optional persisted project ID, which must match the session owner.
    pub project_id: Option<String>,
    /// Optional persisted session ID, which must match the URL session.
    pub db_session_id: Option<String>,
    /// Ignored unless it exactly equals the persisted project root.
    pub project_root: Option<String>,
    /// Client-selected request identity.
    pub request_id: Option<String>,
    /// User-interface metadata retained with the input message.
    pub client_meta: Option<Value>,
    /// Optional presentation-only text.
    pub display_text: Option<String>,
}

/// Accepted asynchronous work response.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentActResponse {
    /// Request correlation identity.
    pub request_id: String,
    /// Session receiving the response.
    pub session_id: String,
    /// Always `accepted` after durable input persistence.
    pub status: &'static str,
}
