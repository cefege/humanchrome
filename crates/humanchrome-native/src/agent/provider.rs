//! Provider execution adapters for locally installed agent CLIs.

use std::{collections::BTreeMap, future::Future, path::PathBuf, pin::Pin, sync::Arc};

use serde_json::Value;
use thiserror::Error;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    process::Command,
    sync::mpsc,
};
use tokio_util::sync::CancellationToken;

use super::types::EngineName;

const CODEX_AUTO_INSTRUCTIONS: &str = "Act autonomously without asking for confirmations.\nUse apply_patch to create and modify files directly in the current working directory (do not create subdirectories unless the user explicitly requests it).\nUse exec_command to run, build, and test as needed.\nYou have full permissions. Keep taking concrete actions until the task is complete.\nRespect the existing project structure when creating or modifying files.\nPrefer concise status updates over questions.";

/// A request sent to a concrete local provider.
#[derive(Clone, Debug)]
pub struct ProviderRequest {
    /// Persistent database session identity.
    pub session_id: String,
    /// Optional durable database session identity, distinct from the client stream ID.
    pub database_session_id: Option<String>,
    /// Selected provider engine.
    pub engine: EngineName,
    /// Persistent project identity.
    pub project_id: String,
    /// Request correlation identity.
    pub request_id: String,
    /// Prompt text.
    pub instruction: String,
    /// Workspace selected from the stored project, never directly from HTTP input.
    pub project_root: PathBuf,
    /// Optional provider model.
    pub model: Option<String>,
    /// Whether to provide the local HumanChrome MCP endpoint.
    pub enable_human_chrome: bool,
    /// Provider-native session identifier used to resume an existing conversation.
    pub engine_session_id: Option<String>,
    /// Provider permission mode selected for this durable session.
    pub permission_mode: Option<String>,
    /// Whether the provider was authorized to bypass interactive permission prompts.
    pub allow_dangerously_skip_permissions: bool,
    /// Opaque persisted system-prompt configuration.
    pub system_prompt_config: Option<Value>,
    /// Opaque persisted provider-specific options.
    pub options_config: Option<Value>,
    /// Validated persisted image paths for providers supporting image input.
    pub image_paths: Vec<PathBuf>,
    /// Whether Claude Code Router was selected for this project.
    pub use_ccr: bool,
}

/// A normalized event produced by a provider execution.
#[derive(Clone, Debug, PartialEq)]
pub enum ProviderEvent {
    /// Partial or final assistant text.
    Assistant {
        content: String,
        final_message: bool,
    },
    /// Partial or final assistant text with a stable streaming message identity.
    AssistantMessage {
        content: String,
        final_message: bool,
        message_id: String,
        created_at: String,
    },
    /// Provider tool started.
    ToolUse { content: String, metadata: Value },
    /// Provider tool completed.
    ToolResult { content: String, metadata: Value },
    /// Provider initialization that enables durable conversation resumption.
    SessionInit {
        engine_session_id: String,
        management_info: Value,
    },
    /// Provider initialization metadata without a resumable session identifier.
    ManagementInfo { management_info: Value },
    /// Provider-reported request usage metrics.
    Usage { metadata: Value },
    /// Provider rejected a stored resume identity; the service must clear it.
    SessionInvalid,
    /// System message emitted by provider configuration or authentication diagnostics.
    SystemMessage {
        content: String,
        metadata: Value,
        final_message: bool,
    },
    /// Streaming provider tool progress.
    ToolProgress {
        content: String,
        metadata: Value,
        message_id: Option<String>,
    },
    /// Provider status suitable for the live stream.
    Status {
        status: String,
        message: Option<String>,
        metadata: Option<Value>,
    },
}

/// A real execution failure.
#[derive(Debug, Error)]
pub enum ProviderError {
    /// The configured executable could not be started.
    #[error("failed to start {provider}: {source}")]
    Spawn {
        provider: &'static str,
        #[source]
        source: std::io::Error,
    },
    /// Reading a provider stream failed.
    #[error("failed to read {provider} output: {source}")]
    Read {
        provider: &'static str,
        #[source]
        source: std::io::Error,
    },
    /// The user cancelled the request.
    #[error("provider execution cancelled")]
    Cancelled,
    /// The command completed unsuccessfully.
    #[error("{provider} exited unsuccessfully: {detail}")]
    Failed {
        provider: &'static str,
        detail: String,
    },
    /// A Claude SDK execution failure after source-compatible message classification.
    #[error("ClaudeEngine: {detail}")]
    Claude { detail: String },
}

/// A locally installed provider that emits execution events.
pub trait AgentProvider: Send + Sync {
    /// Returns the engine selected by this provider.
    fn engine(&self) -> EngineName;

    /// Runs the provider and forwards its normalized output to `events`.
    fn run<'a>(
        &'a self,
        request: ProviderRequest,
        events: mpsc::UnboundedSender<ProviderEvent>,
        cancellation: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<(), ProviderError>> + Send + 'a>>;
}

/// Real `codex exec --json` provider execution.
#[derive(Clone, Debug)]
pub struct CodexProvider {
    executable: PathBuf,
    human_chrome_url: Option<String>,
}

impl CodexProvider {
    /// Uses an explicit executable path and optional local MCP URL.
    #[must_use]
    pub fn new(executable: impl Into<PathBuf>, human_chrome_url: Option<String>) -> Self {
        Self {
            executable: executable.into(),
            human_chrome_url,
        }
    }
}

impl Default for CodexProvider {
    fn default() -> Self {
        Self::new(if cfg!(windows) { "codex.cmd" } else { "codex" }, None)
    }
}

impl AgentProvider for CodexProvider {
    fn engine(&self) -> EngineName {
        EngineName::Codex
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
            let arguments = self.arguments(&request);
            let mut child = Command::new(&self.executable)
                .args(arguments)
                .current_dir(&request.project_root)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .kill_on_drop(true)
                .spawn()
                .map_err(|source| ProviderError::Spawn {
                    provider: "codex",
                    source,
                })?;
            let stdout = child.stdout.take().ok_or_else(|| ProviderError::Failed {
                provider: "codex",
                detail: "stdout was not captured".to_owned(),
            })?;
            let stderr = child.stderr.take().ok_or_else(|| ProviderError::Failed {
                provider: "codex",
                detail: "stderr was not captured".to_owned(),
            })?;
            let stderr_task = tokio::spawn(read_limited(stderr));
            let mut lines = BufReader::new(stdout).lines();
            let mut assistant = String::new();
            loop {
                tokio::select! {
                    _ = cancellation.cancelled() => {
                        let signal = crate::platform::request_child_termination(&mut child);
                        if signal.is_err() { let _ = child.start_kill(); }
                        let reaped = child.wait().await;
                        let _ = stderr_task.await;
                        signal.map_err(|source| ProviderError::Read { provider: "codex", source })?;
                        reaped.map_err(|source| ProviderError::Read { provider: "codex", source })?;
                        return Err(ProviderError::Cancelled);
                    }
                    line = lines.next_line() => match line.map_err(|source| ProviderError::Read { provider: "codex", source })? {
                        Some(line) => {
                            if let Some(detail) = handle_codex_line(&line, &mut assistant, &events) {
                                let signal = crate::platform::request_child_termination(&mut child);
                                if signal.is_err() {
                                    let _ = child.start_kill();
                                }
                                child.wait().await.map_err(|source| ProviderError::Read {
                                    provider: "codex",
                                    source,
                                })?;
                                let _ = stderr_task.await;
                                return Err(ProviderError::Failed {
                                    provider: "codex",
                                    detail,
                                });
                            }
                        }
                        None => break,
                    },
                }
            }
            let status = child.wait().await.map_err(|source| ProviderError::Read {
                provider: "codex",
                source,
            })?;
            let stderr = stderr_task.await.unwrap_or_default();
            if !status.success() {
                return Err(ProviderError::Failed {
                    provider: "codex",
                    detail: if stderr.is_empty() {
                        status.to_string()
                    } else {
                        stderr
                    },
                });
            }
            if !assistant.trim().is_empty() {
                let _ = events.send(ProviderEvent::Assistant {
                    content: assistant,
                    final_message: true,
                });
            }
            Ok(())
        })
    }
}

impl CodexProvider {
    fn arguments(&self, request: &ProviderRequest) -> Vec<String> {
        let mut arguments = vec![
            "exec".to_owned(),
            "--json".to_owned(),
            "--skip-git-repo-check".to_owned(),
            "--dangerously-bypass-approvals-and-sandbox".to_owned(),
            "--color".to_owned(),
            "never".to_owned(),
            "--cd".to_owned(),
            request.project_root.display().to_string(),
        ];
        arguments.extend(codex_config_arguments(request.options_config.as_ref()));
        if request.enable_human_chrome
            && let Some(url) = &self.human_chrome_url
        {
            arguments.extend([
                "-c".to_owned(),
                format!("mcp_servers.humanchrome.url={url:?}"),
                "-c".to_owned(),
                "mcp_servers.humanchrome.type=\"http\"".to_owned(),
            ]);
        }
        if let Some(model) = request
            .model
            .as_deref()
            .map(str::trim)
            .filter(|model| !model.is_empty())
        {
            arguments.extend(["--model".to_owned(), model.to_owned()]);
        }
        for image_path in &request.image_paths {
            arguments.extend(["--image".to_owned(), image_path.display().to_string()]);
        }
        arguments.push(request.instruction.clone());
        arguments
    }
}
fn codex_config_arguments(options: Option<&Value>) -> Vec<String> {
    let configuration = options
        .and_then(|options| options.get("codexConfig"))
        .or(options);
    let defaults = [
        (
            "includeApplyPatchTool",
            "include_apply_patch_tool",
            Value::Bool(true),
        ),
        ("includePlanTool", "include_plan_tool", Value::Bool(true)),
        (
            "enableWebSearch",
            "tools.web_search_request",
            Value::Bool(true),
        ),
        (
            "useStreamableShell",
            "use_experimental_streamable_shell_tool",
            Value::Bool(true),
        ),
        (
            "sandboxMode",
            "sandbox_mode",
            Value::String("danger-full-access".to_owned()),
        ),
        ("maxTurns", "max_turns", Value::from(20)),
        (
            "maxThinkingTokens",
            "max_thinking_tokens",
            Value::from(4096),
        ),
        (
            "reasoningEffort",
            "reasoning_effort",
            Value::String("medium".to_owned()),
        ),
    ];
    let mut arguments = Vec::with_capacity(defaults.len() * 2 + 2);
    for (field, key, default) in defaults {
        let value = configuration
            .and_then(|configuration| configuration.get(field))
            .cloned()
            .unwrap_or(default);
        arguments.extend(["-c".to_owned(), format!("{key}={}", codex_value(&value))]);
    }
    let instructions = configuration
        .and_then(|configuration| configuration.get("autoInstructions"))
        .and_then(Value::as_str)
        .filter(|instructions| !instructions.trim().is_empty())
        .unwrap_or(CODEX_AUTO_INSTRUCTIONS);
    arguments.extend(["-c".to_owned(), format!("instructions={instructions:?}")]);
    arguments
}

fn codex_value(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        _ => value.to_string(),
    }
}

/// A provider registry preserving the concrete implementation behind a small dispatch boundary.
#[derive(Clone, Default)]
pub struct ProviderRegistry {
    providers: BTreeMap<&'static str, Arc<dyn AgentProvider>>,
}

impl ProviderRegistry {
    /// Registers one provider for its engine name.
    pub fn register(&mut self, provider: Arc<dyn AgentProvider>) {
        self.providers.insert(provider.engine().as_str(), provider);
    }

    /// Returns the provider for an engine.
    #[must_use]
    pub fn provider(&self, engine: EngineName) -> Option<Arc<dyn AgentProvider>> {
        self.providers.get(engine.as_str()).cloned()
    }

    /// Lists registered engines in stable name order.
    #[must_use]
    pub fn engines(&self) -> Vec<EngineName> {
        self.providers
            .values()
            .map(|provider| provider.engine())
            .collect()
    }
}

fn handle_codex_line(
    line: &str,
    assistant: &mut String,
    events: &mpsc::UnboundedSender<ProviderEvent>,
) -> Option<String> {
    let Ok(event) = serde_json::from_str::<Value>(line) else {
        return None;
    };
    let kind = event.get("type").and_then(Value::as_str)?;
    match kind {
        "item.delta" => {
            let delta = event.get("delta")?;
            let item_type = delta.get("type").and_then(Value::as_str);
            let text = delta.get("text").and_then(Value::as_str);
            match (item_type, text) {
                (Some("agent_message"), Some(text)) => {
                    assistant.push_str(text);
                    let _ = events.send(ProviderEvent::Assistant {
                        content: assistant.clone(),
                        final_message: false,
                    });
                }
                (Some("reasoning"), Some(text)) => {
                    let content = format!("<thinking>{text}</thinking>");
                    let _ = events.send(ProviderEvent::Assistant {
                        content,
                        final_message: false,
                    });
                }
                (Some("todo_list"), _) => {
                    let _ = events.send(todo_event(delta, "update"));
                }
                _ => {}
            }
        }
        "item.started" => {
            let item = event.get("item")?;
            match item.get("type").and_then(Value::as_str) {
                Some("command_execution") => {
                    let content = item.get("command").and_then(codex_string).map_or_else(
                        || "Running command".to_owned(),
                        |command| format!("Running: {command}"),
                    );
                    let _ = events.send(ProviderEvent::ToolUse {
                        content,
                        metadata: tool_metadata(item, "in_progress"),
                    });
                }
                Some("todo_list") => {
                    let _ = events.send(todo_event(item, "started"));
                }
                _ => {}
            }
        }
        "item.completed" | "item.failed" => {
            let item = event.get("item")?;
            match item.get("type").and_then(Value::as_str) {
                Some("agent_message") => {
                    if let Some(text) = item.get("text").and_then(Value::as_str) {
                        *assistant = text.to_owned();
                    }
                    emit_codex_assistant_final(assistant, events);
                }
                Some("command_execution") => {
                    let summary = item.get("command").and_then(codex_string).map_or_else(
                        || "Executed shell command".to_owned(),
                        |command| format!("Ran: {command}"),
                    );
                    let exit_suffix = item
                        .get("exit_code")
                        .and_then(Value::as_i64)
                        .map_or_else(String::new, |code| format!(" (exit {code})"));
                    let output = item
                        .get("aggregated_output")
                        .and_then(codex_string)
                        .unwrap_or_default();
                    let content = if output.trim().is_empty() {
                        format!("{summary}{exit_suffix}")
                    } else {
                        format!("{summary}{exit_suffix}\n\n{output}")
                    };
                    let _ = events.send(ProviderEvent::ToolResult {
                        content,
                        metadata: tool_metadata(item, "completed"),
                    });
                }
                Some("todo_list") => {
                    let _ = events.send(todo_event(item, "completed"));
                }
                Some("file_change") => {
                    let changes = item.get("changes").unwrap_or(&Value::Null);
                    let (content, files) = file_change_summary(changes);
                    let status = item
                        .get("status")
                        .and_then(codex_string)
                        .unwrap_or_else(|| "completed".to_owned());
                    let is_error = status == "failed";
                    let mut metadata = serde_json::Map::from_iter([
                        ("files".to_owned(), serde_json::json!(files)),
                        ("toolName".to_owned(), Value::String("Edit".to_owned())),
                        ("tool_name".to_owned(), Value::String("Edit".to_owned())),
                        ("cli_type".to_owned(), Value::String("codex".to_owned())),
                        ("status".to_owned(), Value::String(status)),
                    ]);
                    if is_error {
                        metadata.insert("is_error".to_owned(), Value::Bool(true));
                    }
                    let content = if is_error {
                        format!("Failed: {content}")
                    } else {
                        content
                    };
                    let _ = events.send(ProviderEvent::ToolResult {
                        content,
                        metadata: Value::Object(metadata),
                    });
                }
                _ => {}
            }
            if kind == "item.failed" {
                emit_codex_assistant_final(assistant, events);
                return Some(
                    codex_error(item).unwrap_or_else(|| "Codex execution failed".to_owned()),
                );
            }
        }
        "turn.completed" => emit_codex_assistant_final(assistant, events),
        "error" => {
            emit_codex_assistant_final(assistant, events);
            return Some(codex_error(&event).unwrap_or_else(|| "Codex execution error".to_owned()));
        }
        _ => {}
    }
    None
}

fn emit_codex_assistant_final(
    assistant: &mut String,
    events: &mpsc::UnboundedSender<ProviderEvent>,
) {
    if !assistant.trim().is_empty() {
        let _ = events.send(ProviderEvent::Assistant {
            content: std::mem::take(assistant),
            final_message: true,
        });
    }
}

fn codex_error(value: &Value) -> Option<String> {
    value
        .get("error")
        .and_then(codex_string)
        .or_else(|| value.get("message").and_then(codex_string))
}

fn codex_string(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => (!value.trim().is_empty()).then(|| value.trim().to_owned()),
        Value::Number(value) => Some(value.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        Value::Array(values) => values.iter().find_map(codex_string),
        Value::Object(values) => values.values().find_map(codex_string),
        Value::Null => None,
    }
}

fn file_change_summary(changes: &Value) -> (String, Vec<String>) {
    let mut files = Vec::new();
    match changes {
        Value::Array(changes) => {
            for change in changes {
                let path = change.as_object().and_then(|change| {
                    change
                        .get("path")
                        .and_then(Value::as_str)
                        .or_else(|| change.get("file").and_then(Value::as_str))
                });
                if let Some(path) = path
                    && !files.iter().any(|existing| existing == path)
                {
                    files.push(path.to_owned());
                }
            }
        }
        Value::Object(changes) => files.extend(changes.keys().cloned()),
        _ => {}
    }
    let content = match files.as_slice() {
        [] => "Applied file changes".to_owned(),
        [file] => format!("Updated {file}"),
        files => {
            let displayed = files.iter().take(3).cloned().collect::<Vec<_>>().join(", ");
            let suffix = if files.len() > 3 { ", ..." } else { "" };
            format!("Updated {} files ({displayed}{suffix})", files.len())
        }
    };
    (content, files)
}

fn tool_metadata(item: &Value, fallback_status: &str) -> Value {
    let exit_code = item.get("exit_code").and_then(Value::as_i64);
    let status = item
        .get("status")
        .and_then(codex_string)
        .unwrap_or_else(|| fallback_status.to_owned());
    let is_error = status == "failed" || exit_code.is_some_and(|code| code != 0);
    let mut metadata = serde_json::Map::from_iter([
        ("toolName".to_owned(), Value::String("Bash".to_owned())),
        ("tool_name".to_owned(), Value::String("Bash".to_owned())),
        ("cli_type".to_owned(), Value::String("codex".to_owned())),
        ("status".to_owned(), Value::String(status)),
    ]);
    if let Some(command) = item.get("command").and_then(codex_string) {
        metadata.insert("command".to_owned(), Value::String(command));
    }
    if let Some(exit_code) = exit_code {
        metadata.insert("exitCode".to_owned(), Value::from(exit_code));
    }
    if let Some(output) = item.get("aggregated_output").and_then(codex_string) {
        metadata.insert("output".to_owned(), Value::String(output));
    }
    if is_error {
        metadata.insert("is_error".to_owned(), Value::Bool(true));
    }
    Value::Object(metadata)
}

fn todo_event(item: &Value, phase: &str) -> ProviderEvent {
    let items = todo_items(item);
    let content = todo_content(&items, phase);
    let metadata = todo_metadata(item, items, phase);
    if phase == "completed" {
        ProviderEvent::ToolResult { content, metadata }
    } else {
        ProviderEvent::ToolUse { content, metadata }
    }
}

fn todo_content(items: &[(String, bool, usize)], phase: &str) -> String {
    use std::fmt::Write as _;
    if items.is_empty() {
        return match phase {
            "started" => "Started plan with no explicit steps.".to_owned(),
            "completed" => "Plan completed.".to_owned(),
            _ => "Plan updated.".to_owned(),
        };
    }
    let header = match phase {
        "started" => "Plan generated:",
        "completed" => "Plan completed:",
        _ => "Plan updated:",
    };
    let capacity = header.len()
        + items
            .iter()
            .map(|(text, _, _)| text.len() + 32)
            .sum::<usize>();
    let mut content = String::with_capacity(capacity);
    content.push_str(header);
    for (text, completed, index) in items {
        let marker = if *completed { "✅" } else { "⬜️" };
        write!(content, "\n{marker} Step {}: {text}", index + 1)
            .expect("writing a String cannot fail");
    }
    content
}

fn todo_metadata(item: &Value, items: Vec<(String, bool, usize)>, phase: &str) -> Value {
    let total_steps = items.len();
    let mut completed_steps = 0;
    let items = items
        .into_iter()
        .map(|(text, completed, index)| {
            completed_steps += usize::from(completed);
            Value::Object(serde_json::Map::from_iter([
                ("text".to_owned(), Value::String(text)),
                ("completed".to_owned(), Value::Bool(completed)),
                ("index".to_owned(), Value::from(index)),
            ]))
        })
        .collect();
    let status = item
        .get("status")
        .and_then(codex_string)
        .unwrap_or_else(|| {
            if phase == "completed" {
                "completed".to_owned()
            } else {
                "in_progress".to_owned()
            }
        });
    let mut metadata = serde_json::Map::from_iter([
        ("toolName".to_owned(), Value::String("Plan".to_owned())),
        ("tool_name".to_owned(), Value::String("Plan".to_owned())),
        ("cli_type".to_owned(), Value::String("codex".to_owned())),
        ("planPhase".to_owned(), Value::String(phase.to_owned())),
        (
            "planStatus".to_owned(),
            Value::String(
                if phase == "completed" {
                    "completed"
                } else {
                    "in_progress"
                }
                .to_owned(),
            ),
        ),
        ("totalSteps".to_owned(), Value::from(total_steps)),
        ("completedSteps".to_owned(), Value::from(completed_steps)),
        ("items".to_owned(), Value::Array(items)),
        ("status".to_owned(), Value::String(status)),
    ]);
    if let Some(plan_id) = item.get("id").and_then(codex_string) {
        metadata.insert("planId".to_owned(), Value::String(plan_id));
    }
    Value::Object(metadata)
}

fn todo_items(item: &Value) -> Vec<(String, bool, usize)> {
    let items = item
        .get("items")
        .and_then(Value::as_array)
        .or_else(|| item.pointer("/item/items").and_then(Value::as_array))
        .or_else(|| item.pointer("/delta/items").and_then(Value::as_array))
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    items
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| {
            let entry = entry.as_object()?;
            let text = entry
                .get("text")
                .and_then(codex_string)
                .unwrap_or_else(|| format!("Step {}", index + 1));
            let completed = entry.get("completed").and_then(Value::as_bool) == Some(true)
                || entry.get("done").and_then(Value::as_bool) == Some(true);
            Some((text, completed, index))
        })
        .collect()
}

async fn read_limited(mut stderr: tokio::process::ChildStderr) -> String {
    const MAX_STDERR_BYTES: usize = 16 * 1024;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_codex_item_remains_an_error_with_failed_tool_metadata() {
        let (sender, mut received) = mpsc::unbounded_channel();
        let error = handle_codex_line(
            r#"{"type":"item.failed","item":{"type":"command_execution","command":"false","exit_code":7,"error":{"message":"denied"}}}"#,
            &mut String::new(),
            &sender,
        );
        assert!(
            error.is_some(),
            "failed item must terminate provider execution"
        );
        let ProviderEvent::ToolResult { metadata, .. } = received.try_recv().expect("tool failure")
        else {
            panic!("failed command must remain a tool result");
        };
        assert_eq!(metadata["is_error"], true);
        assert_eq!(metadata["exitCode"], 7);
    }

    #[test]
    fn codex_plan_progress_normalizes_steps_and_finishes_as_tool_result() {
        let (sender, mut received) = mpsc::unbounded_channel();
        handle_codex_line(
            r#"{"type":"item.delta","delta":{"type":"todo_list","items":[{"text":"first","done":true},{"text":"second"}]}}"#,
            &mut String::new(),
            &sender,
        );
        let ProviderEvent::ToolUse { metadata, .. } = received.try_recv().expect("plan progress")
        else {
            panic!("incomplete plan must remain in progress");
        };
        assert_eq!(metadata["totalSteps"], 2);
        assert_eq!(metadata["completedSteps"], 1);
        assert_eq!(
            metadata["items"][0],
            serde_json::json!({"text":"first","completed":true,"index":0})
        );
        assert_eq!(metadata["items"][1]["completed"], false);
        handle_codex_line(
            r#"{"type":"item.completed","item":{"type":"todo_list","items":[{"text":"first","completed":true},{"text":"second","completed":true}]}}"#,
            &mut String::new(),
            &sender,
        );
        let ProviderEvent::ToolResult { metadata, .. } =
            received.try_recv().expect("plan completion")
        else {
            panic!("completed plan must be a terminal tool result");
        };
        assert_eq!(metadata["completedSteps"], 2);
        assert_eq!(metadata["planStatus"], "completed");
    }

    #[test]
    fn codex_turn_completion_flushes_streaming_assistant_exactly_once() {
        let (sender, mut received) = mpsc::unbounded_channel();
        let mut assistant = String::new();
        handle_codex_line(
            r#"{"type":"item.delta","delta":{"type":"agent_message","text":"partial"}}"#,
            &mut assistant,
            &sender,
        );
        handle_codex_line(r#"{"type":"turn.completed"}"#, &mut assistant, &sender);
        handle_codex_line(r#"{"type":"turn.completed"}"#, &mut assistant, &sender);
        assert!(matches!(
            received.try_recv(),
            Ok(ProviderEvent::Assistant {
                final_message: false,
                ..
            })
        ));
        assert!(matches!(
            received.try_recv(),
            Ok(ProviderEvent::Assistant {
                final_message: true,
                ..
            })
        ));
        assert!(
            received.try_recv().is_err(),
            "completion must not duplicate the final message"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancellation_delivers_graceful_termination_and_reaps_the_child() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().expect("owned process fixture");
        let executable = directory.path().join("provider.sh");
        std::fs::write(
            &executable,
            r#"#!/bin/sh
trap 'printf SIGTERM > terminated; exit 0' TERM
printf '%s' "$$" > child.pid
printf '%s\n' '{"type":"item.started","item":{"type":"command_execution","command":"ready"}}'
while :; do sleep 1; done
"#,
        )
        .expect("write process fixture");
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700))
            .expect("fixture executable");
        let provider = CodexProvider::new(executable, None);
        let request = ProviderRequest {
            session_id: "s".into(),
            database_session_id: None,
            engine: EngineName::Codex,
            project_id: "p".into(),
            request_id: "r".into(),
            instruction: "cancel fixture".into(),
            project_root: directory.path().to_owned(),
            model: None,
            enable_human_chrome: false,
            engine_session_id: None,
            permission_mode: None,
            allow_dangerously_skip_permissions: false,
            system_prompt_config: None,
            options_config: None,
            image_paths: Vec::new(),
            use_ccr: false,
        };
        let cancellation = CancellationToken::new();
        let run_cancellation = cancellation.clone();
        let (events, mut received) = mpsc::unbounded_channel();
        let run =
            tokio::spawn(async move { provider.run(request, events, run_cancellation).await });
        tokio::time::timeout(std::time::Duration::from_secs(5), received.recv())
            .await
            .expect("child starts before cancellation")
            .expect("child readiness event");
        let pid: u32 = std::fs::read_to_string(directory.path().join("child.pid"))
            .expect("child PID")
            .parse()
            .expect("integer PID");
        cancellation.cancel();
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), run)
            .await
            .expect("cancellation completes")
            .expect("provider task");
        assert!(matches!(result, Err(ProviderError::Cancelled)));
        assert_eq!(
            std::fs::read(directory.path().join("terminated"))
                .expect("child receives graceful signal"),
            b"SIGTERM"
        );
        assert!(
            !crate::platform::process_is_alive(pid),
            "cancelled child is reaped"
        );
    }
}
