//! Durable agent request orchestration and provider event persistence.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use chrono::{SecondsFormat, Utc};
use serde_json::{Map, Value};
use thiserror::Error;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::agent_attachments::AttachmentStore;

use super::{
    provider::{AgentProvider, ProviderError, ProviderEvent, ProviderRegistry, ProviderRequest},
    store::{AgentStore, CreateMessage, StoreError},
    stream::AgentStreamHub,
    types::{
        AgentActRequest, AgentActResponse, AgentMessage, EngineName, ErrorContext, RealtimeEvent,
        StatusEvent,
    },
};

/// Request processing failures suitable for an HTTP client.
#[derive(Debug, Error)]
pub enum AgentServiceError {
    /// The request omitted required instruction text.
    #[error("instruction is required")]
    MissingInstruction,
    /// The request did not identify a persisted project.
    #[error("projectId is required. Please select or create a project first.")]
    MissingProject,
    /// A project/session identity does not exist.
    #[error("{0}")]
    NotFound(String),
    /// Request fields do not match the persisted authorization boundary.
    #[error("{0}")]
    Mismatch(String),
    /// The selected provider was not registered by the host.
    #[error("No agent engine registered for {0}")]
    ProviderUnavailable(&'static str),
    /// Durable state could not be updated.
    #[error(transparent)]
    Store(#[from] StoreError),
    /// Attachment persistence rejected the submitted payload.
    #[error("attachment error: {0}")]
    Attachment(String),
}

/// Coordinates persistent input, provider execution, event fan-out, and cancellation.
#[derive(Clone)]
pub struct AgentService {
    store: AgentStore,
    streams: AgentStreamHub,
    providers: ProviderRegistry,
    attachments: Option<AttachmentStore>,
    running: Arc<Mutex<HashMap<String, RunningExecution>>>,
}

#[derive(Clone)]
struct RunningExecution {
    session_id: String,
    cancellation: CancellationToken,
}
struct MessageEvent<'a> {
    role: &'a str,
    content: String,
    message_type: &'a str,
    metadata: Option<Value>,
    final_message: bool,
    message_id: Option<String>,
    created_at: Option<String>,
}

impl AgentService {
    /// Creates a concrete service from its persistent store and explicitly registered providers.
    #[must_use]
    pub fn new(store: AgentStore, streams: AgentStreamHub, providers: ProviderRegistry) -> Self {
        Self {
            store,
            streams,
            providers,
            attachments: None,
            running: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Enables durable validated image attachment persistence for request execution.
    #[must_use]
    pub fn with_attachments(mut self, attachments: AttachmentStore) -> Self {
        self.attachments = Some(attachments);
        self
    }

    /// Returns the persistent store for route operations.
    #[must_use]
    pub fn store(&self) -> &AgentStore {
        &self.store
    }

    /// Returns the stream hub for the SSE route.
    #[must_use]
    pub fn streams(&self) -> &AgentStreamHub {
        &self.streams
    }

    /// Lists registered engine names in stable order.
    #[must_use]
    pub fn engines(&self) -> Vec<EngineName> {
        self.providers.engines()
    }

    /// Persists a user turn and begins asynchronous provider execution.
    ///
    /// Workspace selection always derives from the durable project record. An HTTP-provided
    /// `projectRoot` may only repeat that exact root; it cannot redirect a provider process.
    pub async fn handle_act(
        &self,
        session_id: String,
        request: AgentActRequest,
    ) -> Result<AgentActResponse, AgentServiceError> {
        let instruction = request.instruction.trim().to_owned();
        if instruction.is_empty() {
            return Err(AgentServiceError::MissingInstruction);
        }
        let database_session_id = request
            .db_session_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(ToOwned::to_owned);
        let database_session = match database_session_id {
            Some(id) => {
                let session_id = id.clone();
                Some(
                    self.store
                        .blocking(move |store| store.session(&session_id))
                        .await?
                        .ok_or_else(|| {
                            AgentServiceError::NotFound(format!("Session not found for id: {id}"))
                        })?,
                )
            }
            None => None,
        };
        let project_id = request
            .project_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(ToOwned::to_owned)
            .or_else(|| {
                database_session
                    .as_ref()
                    .map(|session| session.project_id.clone())
            })
            .ok_or(AgentServiceError::MissingProject)?;
        if let Some(session) = &database_session
            && session.project_id != project_id
        {
            return Err(AgentServiceError::Mismatch(format!(
                "Session {} does not belong to project: {project_id}",
                session.id
            )));
        }
        let project_id_for_store = project_id.clone();
        let project = self
            .store
            .blocking(move |store| store.project(&project_id_for_store))
            .await?
            .ok_or_else(|| {
                AgentServiceError::NotFound(format!("Project not found for id: {project_id}"))
            })?;
        if let Some(root) = request
            .project_root
            .as_deref()
            .map(str::trim)
            .filter(|root| !root.is_empty())
            && root != project.root_path
        {
            return Err(AgentServiceError::Mismatch(
                "projectRoot must match the persisted project root".to_owned(),
            ));
        }
        let engine = database_session
            .as_ref()
            .map(|session| session.engine_name)
            .or(request.cli_preference)
            .or(project.preferred_cli)
            .unwrap_or(EngineName::Claude);
        if let Some(preference) = request.cli_preference
            && database_session
                .as_ref()
                .is_some_and(|session| session.engine_name != preference)
        {
            return Err(AgentServiceError::Mismatch(format!(
                "cliPreference ({}) does not match session.engineName ({})",
                preference.as_str(),
                engine.as_str()
            )));
        }
        let provider = self
            .providers
            .provider(engine)
            .ok_or(AgentServiceError::ProviderUnavailable(engine.as_str()))?;
        let request_id = request
            .request_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let mut metadata = message_metadata(request.client_meta, request.display_text);
        let project_id_for_message = project.id.clone();
        let session_id_for_message = session_id.clone();
        let instruction_for_message = instruction.clone();
        let request_id_for_message = request_id.clone();
        let metadata_for_message = metadata.clone();
        let engine_for_message = engine;
        let database_session_activity_id =
            database_session.as_ref().map(|session| session.id.clone());
        let mut message = self
            .store
            .blocking(move |store| {
                store.touch_project_activity(&project_id_for_message)?;
                if let Some(id) = &database_session_activity_id {
                    store.touch_session_activity(id)?;
                }
                store.create_message(CreateMessage {
                    project_id: &project_id_for_message,
                    session_id: &session_id_for_message,
                    role: "user",
                    content: &instruction_for_message,
                    message_type: "chat",
                    metadata: metadata_for_message.as_ref(),
                    cli_source: Some(engine_for_message.as_str()),
                    request_id: Some(&request_id_for_message),
                })
            })
            .await?;
        let image_paths = self
            .persist_attachments(
                &project.id,
                &message.id,
                request.attachments.as_deref(),
                &mut metadata,
            )
            .await?;
        let message_id = message.id.clone();
        let metadata_for_store = metadata.clone();
        self.store
            .blocking(move |store| {
                store.update_message_metadata(&message_id, metadata_for_store.as_ref())
            })
            .await?;
        message.metadata = metadata.clone();
        let user_event = AgentMessage {
            id: message.id,
            session_id: session_id.clone(),
            role: "user".to_owned(),
            content: message.content,
            message_type: "chat".to_owned(),
            cli_source: Some(engine.as_str().to_owned()),
            request_id: Some(request_id.clone()),
            is_streaming: Some(false),
            is_final: Some(true),
            created_at: message.created_at,
            metadata,
        };
        self.streams
            .publish(&session_id, RealtimeEvent::Message { data: user_event });
        self.streams.publish(
            &session_id,
            status(
                &session_id,
                "starting",
                Some("Agent request accepted".to_owned()),
                Some(request_id.clone()),
            ),
        );
        let cancellation = CancellationToken::new();
        if let Ok(mut running) = self.running.lock() {
            running.insert(
                request_id.clone(),
                RunningExecution {
                    session_id: session_id.clone(),
                    cancellation: cancellation.clone(),
                },
            );
        }
        let effective_model = request
            .model
            .and_then(|model| (!model.trim().is_empty()).then(|| model.trim().to_owned()))
            .or_else(|| {
                database_session
                    .as_ref()
                    .and_then(|session| session.model.clone())
            })
            .or(project.selected_model.clone());
        let provider_request = ProviderRequest {
            session_id: session_id.clone(),
            database_session_id: database_session.as_ref().map(|session| session.id.clone()),
            engine,
            project_id: project.id.clone(),
            request_id: request_id.clone(),
            instruction,
            project_root: project.root_path.into(),
            model: effective_model,
            enable_human_chrome: project.enable_human_chrome.unwrap_or(true),
            engine_session_id: database_session
                .as_ref()
                .and_then(|session| session.engine_session_id.clone())
                .or_else(|| {
                    (engine == EngineName::Claude)
                        .then(|| project.active_claude_session_id.clone())
                        .flatten()
                }),
            permission_mode: database_session
                .as_ref()
                .map(|session| session.permission_mode.clone()),
            allow_dangerously_skip_permissions: database_session
                .as_ref()
                .is_some_and(|session| session.allow_dangerously_skip_permissions),
            system_prompt_config: database_session
                .as_ref()
                .and_then(|session| session.system_prompt_config.clone()),
            options_config: database_session
                .as_ref()
                .and_then(|session| session.options_config.clone()),
            image_paths,
            use_ccr: project.use_ccr.unwrap_or(false),
        };
        let service = self.clone();
        tokio::spawn(async move {
            service
                .run_provider(provider, provider_request, cancellation)
                .await;
        });
        Ok(AgentActResponse {
            request_id,
            session_id,
            status: "accepted",
        })
    }
    async fn persist_attachments(
        &self,
        project_id: &str,
        message_id: &str,
        attachments: Option<&[super::types::AgentAttachment]>,
        metadata: &mut Option<Value>,
    ) -> Result<Vec<PathBuf>, AgentServiceError> {
        let Some(attachments) = attachments.filter(|attachments| !attachments.is_empty()) else {
            return Ok(Vec::new());
        };
        let Some(store) = &self.attachments else {
            return Ok(Vec::new());
        };
        let mut paths = Vec::with_capacity(attachments.len());
        let mut persisted = Vec::with_capacity(attachments.len());
        for (index, attachment) in attachments
            .iter()
            .filter(|attachment| attachment.r#type == "image")
            .enumerate()
        {
            let Ok(saved) = store.save(project_id, message_id, attachment, index).await else {
                continue;
            };
            paths.push(saved.absolute_path);
            persisted.push(saved.metadata);
        }
        if persisted.is_empty() {
            return Ok(paths);
        }
        let object = metadata.get_or_insert_with(|| Value::Object(Map::new()));
        let Value::Object(object) = object else {
            return Ok(paths);
        };
        object.insert("attachments".to_owned(), Value::Array(persisted));
        Ok(paths)
    }

    /// Cancels one known execution.
    pub fn cancel_execution(&self, request_id: &str) -> bool {
        match self.running.lock() {
            Ok(running) => running.get(request_id).is_some_and(|execution| {
                execution.cancellation.cancel();
                true
            }),
            Err(_) => false,
        }
    }

    /// Cancels all active executions attached to one stream session.
    pub fn cancel_session(&self, session_id: &str) -> usize {
        let executions = match self.running.lock() {
            Ok(running) => running
                .values()
                .filter(|execution| execution.session_id == session_id)
                .cloned()
                .collect::<Vec<_>>(),
            Err(_) => return 0,
        };
        for execution in &executions {
            execution.cancellation.cancel();
        }
        executions.len()
    }

    async fn run_provider(
        &self,
        provider: Arc<dyn AgentProvider>,
        request: ProviderRequest,
        cancellation: CancellationToken,
    ) {
        let (event_sender, mut events) = mpsc::unbounded_channel();
        let execution_request = request.clone();
        let execution_cancellation = cancellation.clone();
        let provider_task = tokio::spawn(async move {
            provider
                .run(execution_request, event_sender, execution_cancellation)
                .await
        });
        while let Some(event) = events.recv().await {
            self.emit_provider_event(&request, event).await;
        }
        let result = match provider_task.await {
            Ok(result) => result,
            Err(error) => Err(ProviderError::Failed {
                provider: "agent",
                detail: error.to_string(),
            }),
        };
        match result {
            Ok(()) => self.streams.publish(
                &request.session_id,
                status(
                    &request.session_id,
                    "completed",
                    None,
                    Some(request.request_id.clone()),
                ),
            ),
            Err(ProviderError::Cancelled) => self.streams.publish(
                &request.session_id,
                status(
                    &request.session_id,
                    "cancelled",
                    None,
                    Some(request.request_id.clone()),
                ),
            ),
            Err(error) => {
                self.streams.publish(
                    &request.session_id,
                    RealtimeEvent::Error {
                        error: error.to_string(),
                        data: Some(ErrorContext {
                            session_id: Some(request.session_id.clone()),
                            request_id: Some(request.request_id.clone()),
                        }),
                    },
                );
                self.streams.publish(
                    &request.session_id,
                    status(
                        &request.session_id,
                        "error",
                        Some(error.to_string()),
                        Some(request.request_id.clone()),
                    ),
                );
            }
        }
        if let Ok(mut running) = self.running.lock() {
            running.remove(&request.request_id);
        }
    }

    async fn emit_provider_event(&self, request: &ProviderRequest, event: ProviderEvent) {
        match event {
            ProviderEvent::SessionInit {
                engine_session_id,
                management_info,
            } => {
                if let Some(session_id) = request.database_session_id.clone() {
                    let project_id = request.project_id.clone();
                    let _ = self
                        .store
                        .blocking(move |store| {
                            store.update_provider_session(
                                &session_id,
                                &engine_session_id,
                                &management_info,
                            )?;
                            store.touch_project_activity(&project_id)
                        })
                        .await;
                } else if request.engine == EngineName::Claude {
                    let project_id = request.project_id.clone();
                    let _ = self
                        .store
                        .blocking(move |store| {
                            store.update_project_claude_session(
                                &project_id,
                                Some(&engine_session_id),
                            )?;
                            store.touch_project_activity(&project_id)
                        })
                        .await;
                }
            }
            ProviderEvent::ManagementInfo { management_info } => {
                if let Some(session_id) = request.database_session_id.clone() {
                    let _ = self
                        .store
                        .blocking(move |store| {
                            store.update_management_info(&session_id, &management_info)
                        })
                        .await;
                }
            }
            ProviderEvent::SessionInvalid => {
                if let Some(session_id) = request.database_session_id.clone() {
                    let _ = self
                        .store
                        .blocking(move |store| store.clear_engine_session(&session_id))
                        .await;
                } else if request.engine == EngineName::Claude {
                    let project_id = request.project_id.clone();
                    let _ = self
                        .store
                        .blocking(move |store| {
                            store.update_project_claude_session(&project_id, None)
                        })
                        .await;
                }
            }
            ProviderEvent::Usage { metadata } => self
                .streams
                .publish(&request.session_id, RealtimeEvent::Usage { data: metadata }),
            ProviderEvent::Status {
                status: state,
                message,
                metadata,
            } => {
                self.streams.publish(
                    &request.session_id,
                    RealtimeEvent::Status {
                        data: StatusEvent {
                            session_id: request.session_id.clone(),
                            status: state,
                            message,
                            metadata,
                            request_id: Some(request.request_id.clone()),
                        },
                    },
                );
            }
            ProviderEvent::SystemMessage {
                content,
                metadata,
                final_message,
            } => {
                self.emit_message_event(
                    request,
                    MessageEvent {
                        role: "system",
                        content,
                        message_type: "status",
                        metadata: Some(metadata),
                        final_message,
                        message_id: None,
                        created_at: None,
                    },
                )
                .await;
            }
            ProviderEvent::ToolProgress {
                content,
                metadata,
                message_id,
            } => {
                self.emit_message_event(
                    request,
                    MessageEvent {
                        role: "tool",
                        content,
                        message_type: "tool_use",
                        metadata: Some(metadata),
                        final_message: false,
                        message_id,
                        created_at: None,
                    },
                )
                .await;
            }
            ProviderEvent::Assistant {
                content,
                final_message,
            } => {
                self.emit_message_event(
                    request,
                    MessageEvent {
                        role: "assistant",
                        content,
                        message_type: "chat",
                        metadata: None,
                        final_message,
                        message_id: None,
                        created_at: None,
                    },
                )
                .await;
            }
            ProviderEvent::AssistantMessage {
                content,
                final_message,
                message_id,
                created_at,
            } => {
                self.emit_message_event(
                    request,
                    MessageEvent {
                        role: "assistant",
                        content,
                        message_type: "chat",
                        metadata: None,
                        final_message,
                        message_id: Some(message_id),
                        created_at: Some(created_at),
                    },
                )
                .await;
            }
            ProviderEvent::ToolUse { content, metadata } => {
                self.emit_message_event(
                    request,
                    MessageEvent {
                        role: "tool",
                        content,
                        message_type: "tool_use",
                        metadata: Some(metadata),
                        final_message: true,
                        message_id: None,
                        created_at: None,
                    },
                )
                .await;
            }
            ProviderEvent::ToolResult { content, metadata } => {
                self.emit_message_event(
                    request,
                    MessageEvent {
                        role: "tool",
                        content,
                        message_type: "tool_result",
                        metadata: Some(metadata),
                        final_message: true,
                        message_id: None,
                        created_at: None,
                    },
                )
                .await;
            }
        }
    }

    async fn emit_message_event(&self, request: &ProviderRequest, event: MessageEvent<'_>) {
        let MessageEvent {
            role,
            content,
            message_type,
            metadata,
            final_message,
            message_id,
            created_at,
        } = event;
        let message = AgentMessage {
            id: message_id.unwrap_or_else(|| Uuid::new_v4().to_string()),
            session_id: request.session_id.clone(),
            role: role.to_owned(),
            content: content.clone(),
            message_type: message_type.to_owned(),
            cli_source: Some(request.engine.as_str().to_owned()),
            request_id: Some(request.request_id.clone()),
            is_streaming: Some(!final_message),
            is_final: Some(final_message),
            created_at: created_at.unwrap_or_else(now),
            metadata: metadata.clone(),
        };
        self.streams.publish(
            &request.session_id,
            RealtimeEvent::Message { data: message },
        );
        if final_message && !content.trim().is_empty() {
            let project_id = request.project_id.clone();
            let session_id = request.session_id.clone();
            let role = role.to_owned();
            let message_type = message_type.to_owned();
            let cli_source = request.engine.as_str().to_owned();
            let request_id = request.request_id.clone();
            let _ = self
                .store
                .blocking(move |store| {
                    store.create_message(CreateMessage {
                        project_id: &project_id,
                        session_id: &session_id,
                        role: &role,
                        content: &content,
                        message_type: &message_type,
                        metadata: metadata.as_ref(),
                        cli_source: Some(&cli_source),
                        request_id: Some(&request_id),
                    })
                })
                .await;
        }
    }
}

fn message_metadata(client_meta: Option<Value>, display_text: Option<String>) -> Option<Value> {
    let mut metadata = Map::new();
    if let Some(client_meta) = client_meta {
        metadata.insert("clientMeta".to_owned(), client_meta);
    }
    if let Some(display_text) = display_text {
        metadata.insert("displayText".to_owned(), Value::String(display_text));
    }
    (!metadata.is_empty()).then(|| Value::Object(metadata))
}

fn status(
    session_id: &str,
    status: &str,
    message: Option<String>,
    request_id: Option<String>,
) -> RealtimeEvent {
    RealtimeEvent::Status {
        data: StatusEvent {
            session_id: session_id.to_owned(),
            status: status.to_owned(),
            message,
            metadata: None,
            request_id,
        },
    }
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::{CodexProvider, CreateProjectInput, CreateSessionInput};
    use std::{fs, sync::Arc};
    use tempfile::tempdir;

    #[tokio::test]
    async fn request_rejects_project_root_override_before_provider_start() {
        let directory = tempdir().expect("temp directory");
        let root = directory.path().join("root");
        fs::create_dir(&root).expect("root");
        let store =
            AgentStore::open(directory.path().join("agent.db"), [root.clone()]).expect("store");
        let project = store
            .upsert_project(CreateProjectInput {
                id: None,
                name: "project".into(),
                description: None,
                root_path: root.display().to_string(),
                preferred_cli: Some(EngineName::Codex),
                selected_model: None,
                use_ccr: None,
                enable_human_chrome: None,
                allow_create: None,
            })
            .expect("project");
        let session = store
            .create_session(
                &project.id,
                CreateSessionInput {
                    engine_name: EngineName::Codex,
                    name: None,
                    model: None,
                    permission_mode: None,
                    allow_dangerously_skip_permissions: None,
                    system_prompt_config: None,
                    options_config: None,
                },
            )
            .expect("session");
        let mut providers = ProviderRegistry::default();
        providers.register(Arc::new(CodexProvider::default()));
        let service = AgentService::new(store, AgentStreamHub::default(), providers);
        let error = service
            .handle_act(
                "stream".into(),
                AgentActRequest {
                    instruction: "hi".into(),
                    cli_preference: None,
                    model: None,
                    attachments: None,
                    project_id: Some(project.id),
                    db_session_id: Some(session.id),
                    project_root: Some("/outside".into()),
                    request_id: None,
                    client_meta: None,
                    display_text: None,
                },
            )
            .await
            .expect_err("rejects root override");
        assert_eq!(
            error.to_string(),
            "projectRoot must match the persisted project root"
        );
    }
}
