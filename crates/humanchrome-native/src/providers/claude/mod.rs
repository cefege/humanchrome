//! Claude Agent SDK provider hosted by a short-lived Node subprocess.
//!
//! The official Claude Agent SDK currently has no Rust implementation. This module owns
//! query policy and event mapping, using the private JSONL dependency adapter only for
//! SDK execution and its nonserializable callbacks. Prompts and configuration never
//! become shell arguments.

use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    path::PathBuf,
    pin::Pin,
};

mod ccr;

use serde::Serialize;
use serde_json::{Map, Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::mpsc,
};
use tokio_util::sync::CancellationToken;

use crate::agent::{AgentProvider, EngineName, ProviderError, ProviderEvent, ProviderRequest};

const CLAUDE_PROVIDER: &str = "claude";
const MAX_STDERR_BYTES: usize = 16 * 1024;
const MAX_SDK_STDERR_LINES: usize = 200;

/// Executes the official Claude Agent SDK through a Node.js host process.
#[derive(Clone, Debug)]
pub struct ClaudeProvider {
    node: PathBuf,
    sdk_root: Option<PathBuf>,
    adapter_module: Option<PathBuf>,
    human_chrome_url: Option<String>,
}

impl ClaudeProvider {
    /// Creates a provider using `node` and an optional local HumanChrome MCP endpoint.
    #[must_use]
    pub fn new(node: impl Into<PathBuf>, human_chrome_url: Option<String>) -> Self {
        Self {
            node: node.into(),
            sdk_root: None,
            adapter_module: None,
            human_chrome_url,
        }
    }

    /// Sets the directory from which Node resolves the packaged Claude Agent SDK.
    #[must_use]
    pub fn with_sdk_root(mut self, sdk_root: impl Into<PathBuf>) -> Self {
        self.sdk_root = Some(sdk_root.into());
        self
    }

    /// Selects the separately packaged, optional dependency adapter.
    #[must_use]
    pub fn with_adapter_module(mut self, module: impl Into<PathBuf>) -> Self {
        self.adapter_module = Some(module.into());
        self
    }

    /// Converts persisted, provider-neutral request fields into Claude SDK options.
    #[must_use]
    pub fn execution_config(&self, request: &ProviderRequest) -> ClaudeExecutionConfig {
        ClaudeExecutionConfig::from_request(request, self.human_chrome_url.as_deref())
    }
}

impl Default for ClaudeProvider {
    fn default() -> Self {
        Self::new(if cfg!(windows) { "node.exe" } else { "node" }, None)
    }
}

impl AgentProvider for ClaudeProvider {
    fn engine(&self) -> EngineName {
        EngineName::Claude
    }

    fn run<'a>(
        &'a self,
        request: ProviderRequest,
        events: mpsc::UnboundedSender<ProviderEvent>,
        cancellation: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<(), ProviderError>> + Send + 'a>> {
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return Err(ProviderError::Cancelled);
            }
            let node = resolve_node(&self.node)
                .await
                .map_err(|source| ProviderError::Spawn {
                    provider: CLAUDE_PROVIDER,
                    source,
                })?;
            let module = self
                .adapter_module
                .clone()
                .map_or_else(crate::providers::adapter_path, Ok)
                .map_err(|source| ProviderError::Spawn {
                    provider: CLAUDE_PROVIDER,
                    source,
                })?;
            let config = self.execution_config(&request);
            let prompt = prompt_with_images(&request.instruction, &request.image_paths);
            let Value::Object(mut options) =
                config.sdk_options(&request.project_root, request.model.as_deref())
            else {
                unreachable!("SDK options are an object");
            };
            let mut environment = ccr::environment(request.use_ccr, &node).await;
            if let Some(Value::Object(overrides)) = options.shift_remove("env") {
                environment.extend(overrides);
            }
            // The SDK inherits this as its complete environment. Restore Node after a
            // session-specific PATH override so its CLI child remains discoverable.
            ccr::ensure_node_path(&mut environment, &node);
            options.insert("env".into(), Value::Object(environment));
            if request.use_ccr {
                emit_ccr_warning(&events).await;
            }
            let input = serde_json::to_vec(&AdapterRequest {
                id: &request.request_id,
                method: "claude.query",
                params: HostRequest {
                    prompt: &prompt,
                    options: Value::Object(options),
                    sdk_root: self.sdk_root.as_deref(),
                },
            })
            .map_err(|error| {
                provider_failure(format!("could not serialize Claude SDK request: {error}"))
            })?;

            let mut child = Command::new(&node)
                .arg(module)
                .current_dir(&request.project_root)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .kill_on_drop(true)
                .spawn()
                .map_err(|source| ProviderError::Spawn {
                    provider: CLAUDE_PROVIDER,
                    source,
                })?;
            let mut stdin = child.stdin.take().expect("adapter stdin was captured");
            let stdout = child.stdout.take().expect("adapter stdout was captured");
            let stderr = child.stderr.take().expect("adapter stderr was captured");
            let stderr_task = tokio::spawn(read_limited(stderr));
            if let Err(error) = async {
                stdin.write_all(&input).await?;
                stdin.write_all(b"\n").await?;
                stdin.flush().await
            }
            .await
            {
                let _ = child.kill().await;
                let _ = child.wait().await;
                let _ = stderr_task.await;
                return Err(provider_failure(format!(
                    "could not deliver Claude SDK request: {error}"
                )));
            }

            let mut output = BufReader::new(stdout);
            let mut line = Vec::new();
            let mut state = StreamState::default();
            let mut sdk_stderr = std::collections::VecDeque::new();
            let mut host_failure = None;
            let mut cancelling = false;
            let mut terminal = false;
            loop {
                tokio::select! {
                    _ = cancellation.cancelled(), if !cancelling => {
                        cancelling = true;
                        let cancel = AdapterRequest { id: &request.request_id, method: "claude.cancel", params: Map::<String, Value>::new() };
                        let mut bytes = serde_json::to_vec(&cancel).expect("cancellation is serializable");
                        bytes.push(b'\n');
                        if let Err(error) = async {
                            stdin.write_all(&bytes).await?;
                            stdin.flush().await
                        }.await {
                            host_failure = Some(format!("could not cancel Claude SDK request: {error}"));
                            break;
                        }
                    }
                    read = output.read_until(b'\n', &mut line) => {
                        match read {
                            Ok(0) => break,
                            Ok(_) => {},
                            Err(error) => { host_failure = Some(format!("could not read Claude SDK adapter: {error}")); break; }
                        }
                        let envelope: Value = match serde_json::from_slice(&line) {
                            Ok(value) => value,
                            Err(error) => { host_failure = Some(format!("Claude SDK adapter emitted invalid JSON: {error}")); break; }
                        };
                        line.clear();
                        if envelope.get("id").and_then(Value::as_str) != Some(request.request_id.as_str()) { continue; }
                        match envelope.get("event").and_then(Value::as_str) {
                            Some("stderr") => {
                                if let Some(text) = envelope.get("value").and_then(Value::as_str) {
                                    let text = text.trim_end();
                                    if !text.is_empty() {
                                        if sdk_stderr.len() > MAX_SDK_STDERR_LINES { sdk_stderr.pop_front(); }
                                        sdk_stderr.push_back(text.to_owned());
                                    }
                                }
                            }
                            Some("result") => {
                                let value = &envelope["value"];
                                if !cancelling || value.get("cancelled").and_then(Value::as_bool).is_some() {
                                    terminal = true;
                                    break;
                                }
                            }
                            Some("error") => {
                                let message = envelope.pointer("/value/message").and_then(Value::as_str)
                                    .unwrap_or("Claude SDK adapter failed without an error message");
                                if config.resume.is_some() && is_resume_failure(message) {
                                    let _ = events.send(ProviderEvent::SessionInvalid);
                                }
                                host_failure = Some(message.to_owned());
                                if !cancelling { terminal = true; break; }
                            }
                            Some("sdk_message") => {
                                let outcome = convert_sdk_message(&envelope["value"], &mut state, &config);
                                match outcome {
                                    Ok(HostOutcome::Events(converted)) => {
                                        for event in converted { let _ = events.send(event); }
                                    }
                                    Ok(HostOutcome::EventsThenFailure(converted, message)) => {
                                        for event in converted { let _ = events.send(event); }
                                        host_failure = Some(message);
                                    }
                                    Err(message) => host_failure = Some(message),
                                }
                            }
                            _ => { host_failure = Some("Claude SDK adapter emitted an unknown event".into()); break; }
                        }
                    }
                }
            }
            if !terminal {
                let _ = child.start_kill();
            }
            drop(stdin);
            let status = child.wait().await.map_err(|source| ProviderError::Read {
                provider: CLAUDE_PROVIDER,
                source,
            })?;
            let stderr = stderr_task.await.unwrap_or_default();
            if cancellation.is_cancelled() {
                return Err(ProviderError::Cancelled);
            }
            if let Some(message) = host_failure {
                return Err(provider_failure(classify_error(message, &sdk_stderr).await));
            }
            if !status.success() {
                return Err(provider_failure(if stderr.is_empty() {
                    status.to_string()
                } else {
                    stderr
                }));
            }
            if !terminal {
                return Err(provider_failure(
                    "Claude SDK adapter ended without a terminal event",
                ));
            }
            if let Some(event) = state.assistant_event(true) {
                let _ = events.send(event);
            }
            Ok(())
        })
    }
}

/// Sanitized Claude-specific configuration derived from durable session state.
#[derive(Clone, Debug, PartialEq)]
pub struct ClaudeExecutionConfig {
    permission_mode: PermissionMode,
    allow_dangerously_skip_permissions: bool,
    resume: Option<String>,
    system_prompt: Option<Value>,
    options: Map<String, Value>,
}

impl ClaudeExecutionConfig {
    fn from_request(request: &ProviderRequest, human_chrome_url: Option<&str>) -> Self {
        let permission_mode = PermissionMode::parse(request.permission_mode.as_deref());
        let allow_dangerously_skip_permissions = match permission_mode {
            PermissionMode::BypassPermissions => true,
            _ => request.allow_dangerously_skip_permissions,
        };
        let mut options = sanitize_options(request.options_config.as_ref());
        if request.enable_human_chrome {
            if let Some(url) = human_chrome_url.filter(|url| !url.trim().is_empty()) {
                let mut servers = options
                    .remove("mcpServers")
                    .and_then(|value| value.as_object().cloned())
                    .unwrap_or_default();
                servers.insert(
                    "humanchrome".to_owned(),
                    json!({ "type": "http", "url": url }),
                );
                options.insert("mcpServers".to_owned(), Value::Object(servers));
            }
        } else if let Some(Value::Object(mut servers)) = options.remove("mcpServers") {
            servers.remove("humanchrome");
            if !servers.is_empty() {
                options.insert("mcpServers".to_owned(), Value::Object(servers));
            }
        }

        Self {
            permission_mode,
            allow_dangerously_skip_permissions,
            resume: nonempty(request.engine_session_id.as_deref()),
            system_prompt: sanitize_system_prompt(request.system_prompt_config.as_ref()),
            options,
        }
    }

    fn sdk_options(&self, project_root: &std::path::Path, model: Option<&str>) -> Value {
        let mut options = self.options.clone();
        options.insert(
            "cwd".to_owned(),
            Value::String(project_root.display().to_string()),
        );
        options.insert(
            "additionalDirectories".to_owned(),
            Value::Array(vec![Value::String(project_root.display().to_string())]),
        );
        let model = nonempty(model)
            .or_else(|| {
                std::env::var("CLAUDE_DEFAULT_MODEL")
                    .ok()
                    .filter(|value| !value.is_empty())
            })
            .unwrap_or_else(|| "claude-sonnet-4-20250514".into());
        options.insert("model".to_owned(), Value::String(model));
        options.insert(
            "permissionMode".to_owned(),
            Value::String(self.permission_mode.as_str().to_owned()),
        );
        options.insert(
            "allowDangerouslySkipPermissions".to_owned(),
            Value::Bool(self.allow_dangerously_skip_permissions),
        );
        options.insert("includePartialMessages".to_owned(), Value::Bool(true));
        if let Some(system_prompt) = &self.system_prompt {
            options.insert("systemPrompt".to_owned(), system_prompt.clone());
        }
        if let Some(resume) = &self.resume {
            options.insert("resume".to_owned(), Value::String(resume.clone()));
        }
        Value::Object(options)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PermissionMode {
    Default,
    AcceptEdits,
    BypassPermissions,
    Plan,
    DontAsk,
}

impl PermissionMode {
    fn parse(value: Option<&str>) -> Self {
        match value.map(str::trim).filter(|value| !value.is_empty()) {
            Some("default") => Self::Default,
            Some("acceptEdits") => Self::AcceptEdits,
            Some("bypassPermissions") | None => Self::BypassPermissions,
            Some("plan") => Self::Plan,
            Some("dontAsk") => Self::DontAsk,
            Some(_) => Self::Default,
        }
    }

    const fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::AcceptEdits => "acceptEdits",
            Self::BypassPermissions => "bypassPermissions",
            Self::Plan => "plan",
            Self::DontAsk => "dontAsk",
        }
    }
}

#[derive(Serialize)]
struct AdapterRequest<'a, P> {
    id: &'a str,
    method: &'static str,
    params: P,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostRequest<'a> {
    prompt: &'a str,
    options: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    sdk_root: Option<&'a std::path::Path>,
}

#[derive(Default)]
struct StreamState {
    assistant: String,
    assistant_message_id: Option<String>,
    assistant_created_at: Option<String>,
    last_assistant: Option<(String, bool)>,
    pending_tools: BTreeMap<usize, PendingTool>,
    current_index: Option<usize>,
    emitted_results: BTreeSet<String>,
    emitted_tools: BTreeSet<String>,
}

struct PendingTool {
    name: String,
    id: String,
    input_parts: Vec<String>,
}

enum HostOutcome {
    Events(Vec<ProviderEvent>),
    EventsThenFailure(Vec<ProviderEvent>, String),
}

fn convert_sdk_message(
    message: &Value,
    state: &mut StreamState,
    config: &ClaudeExecutionConfig,
) -> Result<HostOutcome, String> {
    let record = message
        .as_object()
        .ok_or_else(|| "Claude SDK host emitted a non-object message".to_owned())?;
    match record.get("type").and_then(Value::as_str) {
        Some("stream_event") => {
            convert_stream_event(record.get("event"), state).map(HostOutcome::Events)
        }
        Some("assistant") => Ok(HostOutcome::Events(
            state
                .replace_assistant(extract_message_content(message).unwrap_or_default())
                .into_iter()
                .collect(),
        )),
        Some("system") => Ok(HostOutcome::Events(convert_system(record))),
        Some("result") => Ok(convert_result(record, state, config)),
        Some("auth_status") => Ok(HostOutcome::Events(vec![convert_auth_status(record)])),
        Some("tool_progress") => Ok(HostOutcome::Events(
            convert_tool_progress(record).into_iter().collect(),
        )),
        _ => Ok(HostOutcome::Events(Vec::new())),
    }
}

fn convert_stream_event(
    event: Option<&Value>,
    state: &mut StreamState,
) -> Result<Vec<ProviderEvent>, String> {
    let event = event
        .and_then(Value::as_object)
        .ok_or_else(|| "Claude stream_event omitted its event object".to_owned())?;
    match event.get("type").and_then(Value::as_str) {
        Some("message_start") => {
            state.reset_message();
            Ok(Vec::new())
        }
        Some("content_block_start") => {
            let index = event_index(event, state, true);
            let Some(block) = event.get("content_block").and_then(Value::as_object) else {
                return Ok(Vec::new());
            };
            match block.get("type").and_then(Value::as_str) {
                Some("tool_use") => {
                    state.pending_tools.insert(
                        index,
                        PendingTool {
                            name: first_string(block.get("name"))
                                .unwrap_or_else(|| "tool".to_owned()),
                            id: first_string(block.get("id")).unwrap_or_default(),
                            input_parts: Vec::new(),
                        },
                    );
                    Ok(Vec::new())
                }
                Some("tool_result") => Ok(state.tool_result(block, index)),
                _ => Ok(Vec::new()),
            }
        }
        Some("content_block_delta") => {
            let index = event_index(event, state, false);
            let Some(delta) = event.get("delta") else {
                return Ok(Vec::new());
            };
            if delta.get("type").and_then(Value::as_str) == Some("input_json_delta") {
                if let (Some(pending), Some(part)) = (
                    state.pending_tools.get_mut(&index),
                    delta.get("partial_json").and_then(Value::as_str),
                ) {
                    pending.input_parts.push(part.to_owned());
                }
                return Ok(Vec::new());
            }
            let text = match delta {
                Value::String(text) => Some(text.as_str()),
                Value::Object(delta) => delta
                    .get("text")
                    .or_else(|| delta.get("delta"))
                    .or_else(|| delta.get("partial"))
                    .and_then(Value::as_str),
                _ => None,
            };
            if let Some(text) = text {
                state.assistant.push_str(text);
                Ok(state.assistant_event(false).into_iter().collect())
            } else {
                Ok(Vec::new())
            }
        }
        Some("content_block_stop") => {
            let index = event_index(event, state, false);
            let mut events = state.complete_tool(index);
            if let Some(block) = event.get("content_block").and_then(Value::as_object)
                && block.get("type").and_then(Value::as_str) == Some("tool_result")
            {
                events.extend(state.tool_result(block, index));
            }
            Ok(events)
        }
        Some("message_stop") => Ok(state.assistant_event(true).into_iter().collect()),
        _ => Ok(Vec::new()),
    }
}

fn convert_result(
    record: &Map<String, Value>,
    state: &mut StreamState,
    config: &ClaudeExecutionConfig,
) -> HostOutcome {
    let mut events = Vec::new();
    if record.contains_key("usage")
        || number(record.get("total_cost_usd")).is_some_and(|value| value > 0.0)
    {
        let usage = record.get("usage").and_then(Value::as_object);
        let mut metadata = Map::from_iter([
            (
                "inputTokens".to_owned(),
                json!(
                    usage
                        .and_then(|usage| number(usage.get("input_tokens")))
                        .unwrap_or(0.0)
                ),
            ),
            (
                "outputTokens".to_owned(),
                json!(
                    usage
                        .and_then(|usage| number(usage.get("output_tokens")))
                        .unwrap_or(0.0)
                ),
            ),
            (
                "totalCostUsd".to_owned(),
                json!(number(record.get("total_cost_usd")).unwrap_or(0.0)),
            ),
            (
                "durationMs".to_owned(),
                json!(number(record.get("duration_ms")).unwrap_or(0.0)),
            ),
            (
                "numTurns".to_owned(),
                json!(number(record.get("num_turns")).unwrap_or(0.0)),
            ),
        ]);
        if let Some(value) = usage.and_then(|usage| number(usage.get("cache_read_input_tokens"))) {
            metadata.insert("cacheReadInputTokens".to_owned(), json!(value));
        }
        if let Some(value) =
            usage.and_then(|usage| number(usage.get("cache_creation_input_tokens")))
        {
            metadata.insert("cacheCreationInputTokens".to_owned(), json!(value));
        }
        events.push(ProviderEvent::Usage {
            metadata: Value::Object(metadata),
        });
    }
    if record.get("is_error").and_then(Value::as_bool) == Some(true) {
        let message = result_error(record);
        if config.resume.is_some() && is_resume_failure(&message) {
            events.push(ProviderEvent::SessionInvalid);
            return HostOutcome::EventsThenFailure(
                events,
                format!("Resume failed: {message}. Session has been cleared - please retry."),
            );
        }
        return HostOutcome::EventsThenFailure(events, message);
    }
    if let Some(content) = extract_message_content(&Value::Object(record.clone()))
        .filter(|content| !content.is_empty())
    {
        if content != state.assistant.trim() {
            state.assistant = content;
        }
        if let Some(event) = state.assistant_event(true) {
            events.push(event);
        }
    }
    HostOutcome::Events(events)
}

fn convert_system(record: &Map<String, Value>) -> Vec<ProviderEvent> {
    if record.get("subtype").and_then(Value::as_str) != Some("init") {
        return Vec::new();
    }
    let management_info = management_info(record);
    match first_string(record.get("session_id")) {
        Some(engine_session_id) => vec![ProviderEvent::SessionInit {
            engine_session_id,
            management_info,
        }],
        None => vec![ProviderEvent::ManagementInfo { management_info }],
    }
}

fn convert_auth_status(record: &Map<String, Value>) -> ProviderEvent {
    let authenticating = record
        .get("isAuthenticating")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let output = record
        .get("output")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let error = first_string(record.get("error"));
    let content = error
        .clone()
        .or_else(|| (!output.is_empty()).then(|| output.join("\n")))
        .unwrap_or_else(|| "Authentication in progress...".to_owned());
    let output_text = output.join(" ").to_ascii_lowercase();
    let requires_login = !authenticating
        && (error.is_some()
            || output_text.contains("login")
            || output_text.contains("authenticate")
            || output_text.contains("sign in"));
    let mut metadata = Map::from_iter([
        ("cli_type".to_owned(), json!("claude")),
        ("event_type".to_owned(), json!("auth_status")),
        ("isAuthenticating".to_owned(), json!(authenticating)),
        ("output".to_owned(), json!(output)),
        ("requires_login".to_owned(), json!(requires_login)),
    ]);
    if let Some(error) = error {
        metadata.insert("error".to_owned(), Value::String(error));
    }
    ProviderEvent::SystemMessage {
        content,
        metadata: Value::Object(metadata),
        final_message: !authenticating,
    }
}

fn convert_tool_progress(record: &Map<String, Value>) -> Option<ProviderEvent> {
    let tool_use_id = first_string(record.get("tool_use_id"));
    let tool_name = first_string(record.get("tool_name"));
    let name = tool_name.clone().or_else(|| tool_use_id.clone())?;
    let elapsed_seconds = number(record.get("elapsed_time_seconds"));
    let elapsed = elapsed_seconds
        .map(|seconds| format!(" ({}s)", js_fixed_one(seconds)))
        .unwrap_or_default();
    let mut metadata = Map::from_iter([
        ("cli_type".to_owned(), json!("claude")),
        ("event_type".to_owned(), json!("tool_progress")),
    ]);
    let message_id = tool_use_id
        .as_ref()
        .map(|tool_use_id| format!("progress-{tool_use_id}"));
    if let Some(tool_use_id) = tool_use_id {
        metadata.insert("toolUseId".to_owned(), Value::String(tool_use_id));
    }
    if let Some(tool_name) = tool_name {
        metadata.insert("toolName".to_owned(), Value::String(tool_name));
    }
    if let Some(parent_tool_use_id) = first_string(record.get("parent_tool_use_id")) {
        metadata.insert(
            "parentToolUseId".to_owned(),
            Value::String(parent_tool_use_id),
        );
    }
    if let Some(elapsed_seconds) = elapsed_seconds {
        metadata.insert("elapsedTimeSeconds".to_owned(), json!(elapsed_seconds));
    }
    Some(ProviderEvent::ToolProgress {
        content: format!("{name} in progress{elapsed}"),
        metadata: Value::Object(metadata),
        message_id,
    })
}

impl StreamState {
    fn reset_message(&mut self) {
        self.assistant.clear();
        self.assistant_message_id = Some(uuid::Uuid::new_v4().to_string());
        self.assistant_created_at =
            Some(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
        self.last_assistant = None;
    }

    fn assistant_event(&mut self, final_message: bool) -> Option<ProviderEvent> {
        let content = self.assistant.trim();
        if content.is_empty() {
            return None;
        }
        let emitted = (content.to_owned(), final_message);
        if self.last_assistant.as_ref() == Some(&emitted) {
            return None;
        }
        let message_id = self
            .assistant_message_id
            .get_or_insert_with(|| uuid::Uuid::new_v4().to_string())
            .clone();
        let created_at = self
            .assistant_created_at
            .get_or_insert_with(|| {
                chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            })
            .clone();
        self.last_assistant = Some(emitted.clone());
        Some(ProviderEvent::AssistantMessage {
            content: emitted.0,
            final_message,
            message_id,
            created_at,
        })
    }

    fn replace_assistant(&mut self, content: String) -> Option<ProviderEvent> {
        if content.is_empty() {
            return None;
        }
        self.assistant = content;
        self.assistant_event(true)
    }

    fn complete_tool(&mut self, index: usize) -> Vec<ProviderEvent> {
        let Some(pending) = self.pending_tools.remove(&index) else {
            return Vec::new();
        };
        let input = serde_json::from_str::<Value>(&pending.input_parts.concat())
            .unwrap_or_else(|_| json!({}));
        let input = match input {
            Value::Object(input) => input,
            _ => Map::new(),
        };
        let content = tool_use_content(&pending.name, &input);
        let metadata = tool_metadata(&pending.name, &pending.id, &input);
        self.tool_event("tool_use", content, metadata, true)
    }

    fn tool_result(&mut self, block: &Map<String, Value>, index: usize) -> Vec<ProviderEvent> {
        let tool_use_id = first_string(block.get("tool_use_id"));
        let identity = tool_use_id
            .clone()
            .unwrap_or_else(|| format!("index-{index}"));
        if !self.emitted_results.insert(identity) {
            return Vec::new();
        }
        let is_error = block
            .get("is_error")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let content = tool_result_content(block).unwrap_or_else(|| {
            if is_error {
                "Tool execution failed".to_owned()
            } else {
                "Tool completed".to_owned()
            }
        });
        let mut metadata = Map::from_iter([
            ("is_error".to_owned(), Value::Bool(is_error)),
            (
                "status".to_owned(),
                Value::String(if is_error { "failed" } else { "completed" }.to_owned()),
            ),
            ("cli_type".to_owned(), Value::String("claude".to_owned())),
        ]);
        if let Some(tool_use_id) = tool_use_id {
            metadata.insert("toolUseId".to_owned(), Value::String(tool_use_id));
        }
        let content = if is_error {
            format!("Error: {content}")
        } else {
            content
        };
        self.tool_event("tool_result", content, Value::Object(metadata), false)
    }

    fn tool_event(
        &mut self,
        message_type: &str,
        content: String,
        metadata: Value,
        tool_use: bool,
    ) -> Vec<ProviderEvent> {
        let content = content.trim().to_owned();
        if content.is_empty() {
            return Vec::new();
        }
        let key = format!(
            "{message_type}:{content}:{}",
            serde_json::to_string(&metadata).unwrap_or_default()
        );
        if !self.emitted_tools.insert(key) {
            return Vec::new();
        }
        if tool_use {
            vec![ProviderEvent::ToolUse { content, metadata }]
        } else {
            vec![ProviderEvent::ToolResult { content, metadata }]
        }
    }
}

fn js_fixed_one(value: f64) -> String {
    if value.abs() >= 1e21 {
        return value.to_string();
    }
    let sign = if value.is_sign_negative() { "-" } else { "" };
    let rounded = (value.abs() * 10.0 + 0.5).floor() as u64;
    format!("{sign}{}.{:01}", rounded / 10, rounded % 10)
}

fn event_index(event: &Map<String, Value>, state: &mut StreamState, starting: bool) -> usize {
    let index = event
        .get("index")
        .and_then(Value::as_u64)
        .and_then(|index| usize::try_from(index).ok())
        .unwrap_or_else(|| {
            if starting {
                state
                    .current_index
                    .map_or(0, |index| index.saturating_add(1))
            } else {
                state.current_index.unwrap_or(0)
            }
        });
    if starting {
        state.current_index = Some(index);
    }
    index
}

fn sanitize_options(value: Option<&Value>) -> Map<String, Value> {
    let Some(input) = value.and_then(Value::as_object) else {
        return Map::from_iter([(String::from("settingSources"), json!(["project"]))]);
    };
    let mut output = Map::new();
    let setting_sources = input
        .get("settingSources")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .filter(|value| matches!(*value, "user" | "project" | "local"))
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>()
        });
    match setting_sources {
        Some(_)
            if input
                .get("settingSources")
                .is_some_and(|value| value == &Value::Array(Vec::new())) =>
        {
            output.insert("settingSources".to_owned(), Value::Array(Vec::new()));
        }
        Some(values) if !values.is_empty() => {
            output.insert("settingSources".to_owned(), json!(values));
        }
        _ => {
            output.insert("settingSources".to_owned(), json!(["project"]));
        }
    }
    for key in ["allowedTools", "disallowedTools", "betas"] {
        if let Some(values) = input.get(key).and_then(string_array) {
            output.insert(key.to_owned(), json!(values));
        }
    }
    if let Some(tools) = input.get("tools")
        && (string_array(tools).is_some() || is_claude_code_preset(tools))
    {
        output.insert("tools".to_owned(), tools.clone());
    }
    for key in ["maxThinkingTokens", "maxTurns", "maxBudgetUsd"] {
        if number(input.get(key)).is_some() {
            output.insert(key.to_owned(), input[key].clone());
        }
    }
    for key in ["mcpServers", "outputFormat", "sandbox"] {
        if input.get(key).is_some_and(Value::is_object) {
            output.insert(key.to_owned(), input[key].clone());
        }
    }
    if let Some(enabled) = input
        .get("enableFileCheckpointing")
        .and_then(Value::as_bool)
    {
        output.insert("enableFileCheckpointing".to_owned(), Value::Bool(enabled));
    }
    if let Some(environment) = input.get("env").and_then(Value::as_object) {
        let safe_environment = environment
            .iter()
            .filter_map(|(key, value)| {
                value
                    .as_str()
                    .map(|value| (key.clone(), Value::String(value.to_owned())))
            })
            .collect::<Map<_, _>>();
        if !safe_environment.is_empty() {
            output.insert("env".to_owned(), Value::Object(safe_environment));
        }
    }
    output
}

fn sanitize_system_prompt(value: Option<&Value>) -> Option<Value> {
    match value {
        Some(Value::String(value)) => nonempty(Some(value)).map(Value::String),
        Some(Value::Object(value))
            if value.get("type").and_then(Value::as_str) == Some("custom") =>
        {
            nonempty(value.get("text").and_then(Value::as_str)).map(Value::String)
        }
        Some(Value::Object(value))
            if value.get("type").and_then(Value::as_str) == Some("preset")
                && value.get("preset").and_then(Value::as_str) == Some("claude_code") =>
        {
            let mut prompt = Map::from_iter([
                (String::from("type"), Value::String("preset".to_owned())),
                (
                    String::from("preset"),
                    Value::String("claude_code".to_owned()),
                ),
            ]);
            if let Some(append) = nonempty(value.get("append").and_then(Value::as_str)) {
                prompt.insert("append".to_owned(), Value::String(append));
            }
            Some(Value::Object(prompt))
        }
        _ => None,
    }
}

fn string_array(value: &Value) -> Option<Vec<String>> {
    value.as_array().and_then(|values| {
        values
            .iter()
            .map(Value::as_str)
            .collect::<Option<Vec<_>>>()
            .map(|values| values.into_iter().map(ToOwned::to_owned).collect())
    })
}

fn is_claude_code_preset(value: &Value) -> bool {
    value.as_object().is_some_and(|value| {
        value.get("type").and_then(Value::as_str) == Some("preset")
            && value.get("preset").and_then(Value::as_str) == Some("claude_code")
    })
}

fn first_string(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(value)) => nonempty(Some(value)),
        Some(Value::Number(value)) => Some(value.to_string()),
        Some(Value::Bool(value)) => Some(value.to_string()),
        Some(Value::Array(values)) => values.iter().find_map(|value| first_string(Some(value))),
        _ => None,
    }
}

fn extract_message_content(value: &Value) -> Option<String> {
    fn extract(value: &Value, depth: usize) -> Option<String> {
        if depth > 3 {
            return None;
        }
        let record = value.as_object()?;
        if let Some(result) = record.get("result").and_then(Value::as_str) {
            return Some(result.trim().to_owned());
        }
        if let Some(message) = record.get("message")
            && let Some(content) = extract(message, depth + 1)
        {
            return Some(content);
        }
        for key in ["content", "text"] {
            if let Some(text) = record.get(key).and_then(Value::as_str) {
                return Some(text.trim().to_owned());
            }
        }
        record
            .get("content")
            .and_then(Value::as_array)
            .and_then(|parts| {
                let text = parts
                    .iter()
                    .filter_map(|part| {
                        let part = part.as_object()?;
                        (part.get("type").and_then(Value::as_str) == Some("text"))
                            .then(|| part.get("text").and_then(Value::as_str))
                            .flatten()
                    })
                    .collect::<String>();
                (!text.trim().is_empty()).then(|| text.trim().to_owned())
            })
    }
    extract(value, 0)
}

fn management_info(record: &Map<String, Value>) -> Value {
    let mut result = Map::new();
    if let Some(value) = strings(record.get("tools")) {
        result.insert("tools".to_owned(), json!(value));
    }
    if let Some(value) = strings(record.get("agents")) {
        result.insert("agents".to_owned(), json!(value));
    }
    if let Some(plugins) = record.get("plugins").and_then(Value::as_array) {
        let plugins = plugins
            .iter()
            .filter_map(|plugin| {
                let plugin = plugin.as_object()?;
                let name = plugin.get("name").and_then(Value::as_str)?;
                let mut result =
                    Map::from_iter([(String::from("name"), Value::String(name.to_owned()))]);
                if let Some(path) = plugin.get("path").and_then(Value::as_str) {
                    result.insert("path".to_owned(), Value::String(path.to_owned()));
                }
                Some(Value::Object(result))
            })
            .collect::<Vec<_>>();
        result.insert("plugins".to_owned(), Value::Array(plugins));
    }
    if let Some(value) = strings(record.get("skills")) {
        result.insert("skills".to_owned(), json!(value));
    }
    if let Some(servers) = record.get("mcp_servers").and_then(Value::as_array) {
        let servers = servers.iter().filter_map(|server| {
            let server = server.as_object()?;
            let name = server.get("name").and_then(Value::as_str)?;
            Some(json!({ "name": name, "status": server.get("status").and_then(Value::as_str).unwrap_or("unknown") }))
        }).collect::<Vec<_>>();
        result.insert("mcpServers".to_owned(), Value::Array(servers));
    }
    if let Some(value) = strings(record.get("slash_commands")) {
        result.insert("slashCommands".to_owned(), json!(value));
    }
    for (source, target) in [
        ("model", "model"),
        ("permissionMode", "permissionMode"),
        ("cwd", "cwd"),
        ("output_style", "outputStyle"),
        ("claude_code_version", "claudeCodeVersion"),
        ("apiKeySource", "apiKeySource"),
    ] {
        if let Some(value) = first_string(record.get(source)) {
            result.insert(target.to_owned(), Value::String(value));
        }
    }
    if let Some(value) = strings(record.get("betas")) {
        result.insert("betas".to_owned(), json!(value));
    }
    Value::Object(result)
}

fn strings(value: Option<&Value>) -> Option<Vec<String>> {
    value.and_then(Value::as_array).map(|values| {
        values
            .iter()
            .filter_map(Value::as_str)
            .map(ToOwned::to_owned)
            .collect()
    })
}

fn tool_metadata(name: &str, id: &str, input: &Map<String, Value>) -> Value {
    let normalized_name = name.to_ascii_lowercase();
    let mut metadata = Map::from_iter([
        ("toolName".to_owned(), Value::String(name.to_owned())),
        ("tool_name".to_owned(), Value::String(name.to_owned())),
        ("cli_type".to_owned(), Value::String("claude".to_owned())),
    ]);
    if !id.trim().is_empty() {
        metadata.insert("toolId".to_owned(), Value::String(id.to_owned()));
    }
    if let Some(action) = infer_action(name) {
        metadata.insert("action".to_owned(), Value::String(action.to_owned()));
    }
    if let Some(path) = input.get("file_path").and_then(Value::as_str) {
        metadata.insert("filePath".to_owned(), Value::String(path.to_owned()));
    }
    if normalized_name.contains("edit")
        || matches!(normalized_name.as_str(), "apply_patch" | "patch_file")
    {
        if let Some(old) = input.get("old_string").and_then(Value::as_str) {
            metadata.insert("oldString".to_owned(), Value::String(old.to_owned()));
            metadata.insert("deletedLines".to_owned(), json!(line_count(old)));
        }
        if let Some(new) = input.get("new_string").and_then(Value::as_str) {
            metadata.insert("newString".to_owned(), Value::String(new.to_owned()));
            metadata.insert("addedLines".to_owned(), json!(line_count(new)));
        }
        if let Some(replace_all) = input.get("replace_all").and_then(Value::as_bool) {
            metadata.insert("replaceAll".to_owned(), Value::Bool(replace_all));
        }
    }
    if (normalized_name.contains("write") || normalized_name == "create_file")
        && let Some(content) = input.get("content").and_then(Value::as_str)
    {
        metadata.insert(
            "contentPreview".to_owned(),
            Value::String(utf16_prefix(content, 200)),
        );
        metadata.insert("totalLines".to_owned(), json!(line_count(content)));
    }
    if normalized_name.contains("read") {
        copy_value(input, &mut metadata, "offset", "offset");
        copy_value(input, &mut metadata, "limit", "limit");
    }
    if normalized_name == "bash" || normalized_name.contains("shell") || normalized_name == "run" {
        if let Some(command) = input.get("command").and_then(Value::as_str) {
            metadata.insert("command".to_owned(), Value::String(command.to_owned()));
        }
        if let Some(description) = input.get("description").and_then(Value::as_str) {
            metadata.insert(
                "commandDescription".to_owned(),
                Value::String(description.to_owned()),
            );
        }
    }
    if normalized_name == "grep" || normalized_name.contains("search") {
        copy_value(input, &mut metadata, "pattern", "pattern");
        copy_value(input, &mut metadata, "path", "searchPath");
        copy_value(input, &mut metadata, "glob", "glob");
        copy_value(input, &mut metadata, "output_mode", "outputMode");
    }
    if matches!(normalized_name.as_str(), "glob" | "glob_files") {
        copy_value(input, &mut metadata, "pattern", "pattern");
        copy_value(input, &mut metadata, "path", "searchPath");
    }
    if matches!(normalized_name.as_str(), "todo_write" | "todowrite")
        && let Some(todos) = input.get("todos").and_then(Value::as_array)
    {
        metadata.insert("todoCount".to_owned(), json!(todos.len()));
        metadata.insert("todos".to_owned(), Value::Array(todos.clone()));
    }
    let raw = humanchrome_core::json::stringify_object(input);
    metadata.insert(
        "rawInput".to_owned(),
        Value::String(utf16_prefix(&raw, 1000)),
    );
    Value::Object(metadata)
}

fn line_count(value: &str) -> usize {
    value.bytes().filter(|byte| *byte == b'\n').count() + 1
}

fn utf16_prefix(value: &str, limit: usize) -> String {
    let mut output = String::with_capacity(value.len().min(limit));
    let mut used = 0;
    for character in value.chars() {
        let width = character.len_utf16();
        if used + width > limit {
            break;
        }
        output.push(character);
        used += width;
    }
    output
}

fn tool_use_content(name: &str, input: &Map<String, Value>) -> String {
    if let Some(command) = input.get("command").and_then(Value::as_str) {
        return format!("Running: {command}");
    }
    if let Some(path) = input.get("file_path").and_then(Value::as_str) {
        return format!("Operating on: {path}");
    }
    if let Some(pattern) = input.get("pattern").and_then(Value::as_str) {
        return format!("Searching: {pattern}");
    }
    if let Some(query) = input.get("query").and_then(Value::as_str) {
        return format!("Searching: {query}");
    }
    format!("Using tool: {name}")
}

fn copy_value(input: &Map<String, Value>, output: &mut Map<String, Value>, from: &str, to: &str) {
    if let Some(value) = input.get(from) {
        output.insert(to.to_owned(), value.clone());
    }
}

fn infer_action(name: &str) -> Option<&'static str> {
    let name = name.trim().to_ascii_lowercase();
    let suffix = name.rsplit(':').next().unwrap_or(&name);
    let name = if matches!(
        suffix,
        "read"
            | "read_file"
            | "write"
            | "write_file"
            | "create_file"
            | "edit"
            | "edit_file"
            | "apply_patch"
            | "patch_file"
            | "remove_file"
            | "delete_file"
            | "list_files"
            | "glob"
            | "glob_files"
            | "search_files"
            | "grep"
            | "bash"
            | "run"
            | "shell"
            | "todo_write"
            | "plan_write"
    ) {
        suffix
    } else {
        &name
    };
    if name.contains("edit") || name.contains("modify") || name.contains("patch") {
        Some("Edited")
    } else if name.contains("write") || name.contains("create") {
        Some("Created")
    } else if name.contains("read") || name.contains("view") {
        Some("Read")
    } else if name.contains("delete") || name.contains("remove") {
        Some("Deleted")
    } else if name.contains("search")
        || name.contains("find")
        || name.contains("glob")
        || name.contains("grep")
    {
        Some("Searched")
    } else if name.contains("bash")
        || name.contains("shell")
        || name.contains("exec")
        || name == "run"
    {
        Some("Executed")
    } else if name.contains("todo") || name.contains("plan") {
        Some("Generated")
    } else {
        None
    }
}

fn tool_result_content(block: &Map<String, Value>) -> Option<String> {
    match block.get("content") {
        Some(Value::String(content)) => Some(content.to_owned()),
        Some(Value::Array(parts)) => nonempty(Some(
            &parts
                .iter()
                .filter_map(|part| {
                    let part = part.as_object()?;
                    (part.get("type").and_then(Value::as_str) == Some("text"))
                        .then(|| part.get("text").and_then(Value::as_str))
                        .flatten()
                })
                .collect::<Vec<_>>()
                .join("\n"),
        )),
        _ => None,
    }
}

fn result_error(record: &Map<String, Value>) -> String {
    let errors = record
        .get("errors")
        .and_then(Value::as_array)
        .map(|errors| {
            errors
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("; ")
        })
        .filter(|errors| !errors.is_empty());
    errors
        .or_else(|| first_string(record.get("result")))
        .unwrap_or_else(|| "Unknown error from Claude Code".to_owned())
}

fn prompt_with_images(instruction: &str, image_paths: &[PathBuf]) -> String {
    let instruction = instruction
        .lines()
        .filter(|line| !line.trim_start().starts_with("Image #") || !line.contains(" path: "))
        .collect::<Vec<_>>()
        .join("\n");
    if image_paths.is_empty() {
        return instruction.trim().to_owned();
    }
    let images = image_paths
        .iter()
        .enumerate()
        .map(|(index, path)| format!("Image #{} path: {}", index + 1, path.display()))
        .collect::<Vec<_>>()
        .join("\n");
    format!("{}\n\n{images}", instruction.trim())
        .trim()
        .to_owned()
}

fn is_resume_failure(message: &str) -> bool {
    message.contains("No conversation found")
        || message.contains("Failed to resume session")
        || message.contains("session ID")
}

fn number(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
}

fn nonempty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

async fn read_limited(mut stderr: tokio::process::ChildStderr) -> String {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 1024];
    while let Ok(read) = stderr.read(&mut buffer).await {
        if read == 0 {
            break;
        }
        if bytes.len() < MAX_STDERR_BYTES {
            let remaining = MAX_STDERR_BYTES - bytes.len();
            bytes.extend_from_slice(&buffer[..read.min(remaining)]);
        }
    }
    String::from_utf8_lossy(&bytes).trim().to_owned()
}

async fn resolve_node(node: &std::path::Path) -> std::io::Result<PathBuf> {
    if node.components().count() > 1 {
        return tokio::fs::canonicalize(node).await;
    }
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            let candidate = directory.join(node);
            let Ok(metadata) = tokio::fs::metadata(&candidate).await else {
                continue;
            };
            if !metadata.is_file() {
                continue;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt as _;
                if metadata.permissions().mode() & 0o111 == 0 {
                    continue;
                }
            }
            return tokio::fs::canonicalize(candidate).await;
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        format!("Node executable {} not found on PATH", node.display()),
    ))
}

fn provider_failure(detail: impl Into<String>) -> ProviderError {
    ProviderError::Claude {
        detail: detail.into(),
    }
}

async fn emit_ccr_warning(events: &mpsc::UnboundedSender<ProviderEvent>) {
    let validation = match ccr::validate().await {
        Ok(validation) => validation,
        Err(error) => {
            tracing::warn!(%error, "CCR config validation error");
            return;
        }
    };
    if !validation.checked || validation.valid {
        return;
    }
    let mut lines = vec![
        "⚠️ Claude Code Router (CCR) configuration issue detected:".to_owned(),
        validation
            .issue
            .clone()
            .unwrap_or_else(|| "CCR configuration appears invalid.".to_owned()),
        String::new(),
        validation
            .suggestion
            .unwrap_or_else(|| "Please check your CCR configuration.".to_owned()),
    ];
    if let Some(fix) = &validation.suggested_fix {
        lines.push(String::new());
        lines.push(format!("Suggested fix: Router.default = \"{fix}\""));
    }
    let mut metadata = Map::from_iter([
        ("cli_type".to_owned(), json!("claude")),
        ("warning_type".to_owned(), json!("ccr_config")),
    ]);
    if let Some(issue) = validation.issue {
        metadata.insert("ccr_issue".to_owned(), json!(issue));
    }
    if let Some(fix) = validation.suggested_fix {
        metadata.insert("ccr_suggested_fix".to_owned(), json!(fix));
    }
    let _ = events.send(ProviderEvent::SystemMessage {
        content: lines.join("\n"),
        metadata: Value::Object(metadata),
        final_message: true,
    });
}

async fn classify_error(
    mut message: String,
    stderr: &std::collections::VecDeque<String>,
) -> String {
    let combined = format!(
        "{message}\n{}",
        stderr
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>()
            .join("\n")
    );
    if combined.contains("claude-code-router")
        && (combined.contains("reading 'includes'") || combined.contains("transformRequestIn"))
    {
        let suggestion = ccr::validate().await.ok()
            .filter(|validation| validation.checked && !validation.valid)
            .and_then(|validation| validation.suggestion)
            .unwrap_or_else(|| "Edit ~/.claude-code-router/config.json and set Router.default to \"provider,model\" format (e.g., \"venus,claude-4-5-sonnet-20250929\"), then restart CCR.".to_owned());
        message.push_str(&format!("\n\n💡 CCR Configuration Issue Detected:\nThis error is commonly caused by Router.default being set to only a provider name\n(e.g., \"venus\") instead of the required \"provider,model\" format.\n\nFix: {suggestion}"));
    }
    let mut tail = stderr
        .iter()
        .rev()
        .filter(|line| !line.contains("Spawning Claude Code:") && !line.trim().is_empty())
        .take(3)
        .map(String::as_str)
        .collect::<Vec<_>>();
    tail.reverse();
    if !tail.is_empty() {
        message.push_str(&format!(" (stderr: {})", tail.join(" | ")));
    }
    message
}

#[cfg(test)]
mod tests {
    use super::*;

    fn events(outcome: HostOutcome) -> Vec<ProviderEvent> {
        match outcome {
            HostOutcome::Events(events) => events,
            HostOutcome::EventsThenFailure(_, message) => {
                panic!("unexpected conversion failure: {message}")
            }
        }
    }

    #[test]
    fn configuration_uses_safe_json_values_and_injects_humanchrome() {
        let request = ProviderRequest {
            session_id: "stream".to_owned(),
            database_session_id: Some("database".to_owned()),
            engine: EngineName::Claude,
            project_id: "project".to_owned(),
            request_id: "request".to_owned(),
            instruction: "hello".to_owned(),
            project_root: PathBuf::from("/workspace"),
            model: None,
            enable_human_chrome: true,
            engine_session_id: Some("resume".to_owned()),
            permission_mode: Some("acceptEdits".to_owned()),
            allow_dangerously_skip_permissions: false,
            system_prompt_config: Some(
                json!({ "type": "preset", "preset": "claude_code", "append": "rules" }),
            ),
            options_config: Some(
                json!({ "settingSources": ["user", "bad"], "allowedTools": ["Read"], "mcpServers": { "custom": { "type": "http", "url": "https://example.test/mcp" } } }),
            ),
            image_paths: Vec::new(),
            use_ccr: false,
        };
        let config = ClaudeProvider::new("node", Some("http://127.0.0.1:12306/mcp".to_owned()))
            .execution_config(&request);
        let options = config.sdk_options(&request.project_root, None);
        assert_eq!(options["permissionMode"], "acceptEdits");
        assert_eq!(options["settingSources"], json!(["user"]));
        assert_eq!(
            options["mcpServers"]["humanchrome"]["url"],
            "http://127.0.0.1:12306/mcp"
        );
        assert_eq!(options["resume"], "resume");
    }

    #[test]
    fn stream_conversion_accumulates_tool_input_and_text() {
        let config = ClaudeExecutionConfig {
            permission_mode: PermissionMode::Default,
            allow_dangerously_skip_permissions: false,
            resume: None,
            system_prompt: None,
            options: Map::new(),
        };
        let mut state = StreamState::default();
        assert!(
            events(
                convert_sdk_message(
                    &json!({ "type": "stream_event", "event": { "type": "message_start" } }),
                    &mut state,
                    &config
                )
                .unwrap()
            )
            .is_empty()
        );
        assert!(events(convert_sdk_message(&json!({ "type": "stream_event", "event": { "type": "content_block_start", "index": 0, "content_block": { "type": "tool_use", "name": "Bash", "id": "tool-1" } } }), &mut state, &config).unwrap()).is_empty());
        assert!(events(convert_sdk_message(&json!({ "type": "stream_event", "event": { "type": "content_block_delta", "index": 0, "delta": { "type": "input_json_delta", "partial_json": r#"{"command":"pwd"}"# } } }), &mut state, &config).unwrap()).is_empty());
        let tool_events = events(convert_sdk_message(&json!({ "type": "stream_event", "event": { "type": "content_block_stop", "index": 0 } }), &mut state, &config).unwrap());
        assert!(
            matches!(&tool_events[0], ProviderEvent::ToolUse { content, .. } if content == "Running: pwd")
        );
        let partial = events(convert_sdk_message(&json!({ "type": "stream_event", "event": { "type": "content_block_delta", "index": 1, "delta": { "text": "hello" } } }), &mut state, &config).unwrap());
        let message_id = match &partial[0] {
            ProviderEvent::AssistantMessage {
                content,
                final_message: false,
                message_id,
                ..
            } if content == "hello" => message_id.clone(),
            event => panic!("unexpected assistant event: {event:?}"),
        };
        let final_event = events(
            convert_sdk_message(
                &json!({ "type": "stream_event", "event": { "type": "message_stop" } }),
                &mut state,
                &config,
            )
            .unwrap(),
        );
        assert!(
            matches!(&final_event[..], [ProviderEvent::AssistantMessage { message_id: final_id, final_message: true, .. }] if final_id == &message_id)
        );
    }

    #[test]
    fn source_backed_top_level_events_keep_message_shapes() {
        let config = ClaudeExecutionConfig {
            permission_mode: PermissionMode::Default,
            allow_dangerously_skip_permissions: false,
            resume: None,
            system_prompt: None,
            options: Map::new(),
        };
        let mut state = StreamState::default();

        assert!(
            events(
                convert_sdk_message(
                    &json!({ "type": "system", "subtype": "status", "status": "compacting" }),
                    &mut state,
                    &config
                )
                .unwrap()
            )
            .is_empty()
        );
        let auth = events(convert_sdk_message(&json!({ "type": "auth_status", "isAuthenticating": false, "output": ["Please login"] }), &mut state, &config).unwrap());
        assert!(
            matches!(&auth[..], [ProviderEvent::SystemMessage { content, final_message: true, metadata }]
            if content == "Please login" && metadata["requires_login"] == true)
        );
        assert!(
            events(
                convert_sdk_message(&json!({ "type": "tool_progress" }), &mut state, &config)
                    .unwrap()
            )
            .is_empty()
        );
        let progress = events(convert_sdk_message(&json!({ "type": "tool_progress", "tool_use_id": "tool-1", "elapsed_time_seconds": 1.25 }), &mut state, &config).unwrap());
        assert!(
            matches!(&progress[..], [ProviderEvent::ToolProgress { content, metadata, message_id: Some(message_id) }]
            if content == "tool-1 in progress (1.3s)" && metadata["toolUseId"] == "tool-1" && message_id == "progress-tool-1")
        );
    }

    #[test]
    fn system_init_persists_omitted_fields_without_json_nulls() {
        let config = ClaudeExecutionConfig {
            permission_mode: PermissionMode::Default,
            allow_dangerously_skip_permissions: false,
            resume: None,
            system_prompt: None,
            options: Map::new(),
        };
        let mut state = StreamState::default();
        let initialized = events(
            convert_sdk_message(
                &json!({
                    "type": "system",
                    "subtype": "init",
                    "session_id": "sdk-session",
                    "tools": ["Read"],
                    "plugins": [{ "name": "example" }],
                }),
                &mut state,
                &config,
            )
            .unwrap(),
        );
        assert!(
            matches!(&initialized[..], [ProviderEvent::SessionInit { engine_session_id, management_info }]
            if engine_session_id == "sdk-session"
                && management_info["tools"] == json!(["Read"])
                && management_info["plugins"][0]["name"] == "example"
                && management_info.get("agents").is_none()
                && management_info["plugins"][0].get("path").is_none())
        );
    }

    #[test]
    fn stream_metadata_and_dedup_match_handler_boundaries() {
        let config = ClaudeExecutionConfig {
            permission_mode: PermissionMode::Default,
            allow_dangerously_skip_permissions: false,
            resume: None,
            system_prompt: None,
            options: Map::new(),
        };
        let mut state = StreamState::default();
        assert!(events(convert_sdk_message(&json!({ "type": "stream_event", "event": {
            "type": "content_block_start", "content_block": { "type": "tool_use", "name": "Write", "id": "" }
        } }), &mut state, &config).unwrap()).is_empty());
        assert!(state.pending_tools.contains_key(&0));
        assert!(events(convert_sdk_message(&json!({ "type": "stream_event", "event": {
            "type": "content_block_delta", "delta": { "type": "input_json_delta", "partial_json": r#"{"content":"a\n","command":"ignored"}"# }
        } }), &mut state, &config).unwrap()).is_empty());
        let tool = events(
            convert_sdk_message(
                &json!({ "type": "stream_event", "event": { "type": "content_block_stop" } }),
                &mut state,
                &config,
            )
            .unwrap(),
        );
        assert!(
            matches!(&tool[..], [ProviderEvent::ToolUse { metadata, .. }]
            if metadata["cli_type"] == "claude"
                && metadata["totalLines"] == 2
                && metadata.get("toolId").is_none()
                && metadata.get("command").is_none())
        );

        let result = json!({ "type": "stream_event", "event": {
            "type": "content_block_start", "index": 1,
            "content_block": { "type": "tool_result", "tool_use_id": "same", "content": "done" }
        } });
        assert_eq!(
            events(convert_sdk_message(&result, &mut state, &config).unwrap()).len(),
            1
        );
        assert!(
            events(
                convert_sdk_message(
                    &json!({ "type": "stream_event", "event": { "type": "message_start" } }),
                    &mut state,
                    &config
                )
                .unwrap()
            )
            .is_empty()
        );
        assert!(events(convert_sdk_message(&result, &mut state, &config).unwrap()).is_empty());
    }

    #[test]
    fn resume_failure_requests_durable_session_clear() {
        let config = ClaudeExecutionConfig {
            permission_mode: PermissionMode::Default,
            allow_dangerously_skip_permissions: false,
            resume: Some("old".to_owned()),
            system_prompt: None,
            options: Map::new(),
        };
        let mut state = StreamState::default();
        let outcome = convert_sdk_message(
            &json!({ "type": "result", "is_error": true, "result": "No conversation found" }),
            &mut state,
            &config,
        )
        .unwrap();
        assert!(
            matches!(outcome, HostOutcome::EventsThenFailure(events, message) if message == "Resume failed: No conversation found. Session has been cleared - please retry." && events == vec![ProviderEvent::SessionInvalid])
        );
    }
}
