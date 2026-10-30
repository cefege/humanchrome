//! Axum routes for the local persistent agent API.

use std::{
    collections::BTreeMap,
    convert::Infallible,
    path::PathBuf,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
};

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, Method, Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response, Sse, sse::Event},
    routing::{delete, get, post},
};
use futures_core::Stream;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::process::Command;
use uuid::Uuid;

use crate::agent_attachments::{AttachmentStore, attachment_router_with_projects};

use super::{
    provider::ProviderRegistry,
    service::{AgentService, AgentServiceError},
    store::{AgentStore, StoreError},
    stream::AgentEventStream,
    types::{
        AgentActRequest, AgentStoredMessage, ConnectedEvent, CreateProjectInput,
        CreateSessionInput, EngineName, RealtimeEvent, UpdateSessionInput,
    },
};

/// Immutable HTTP startup configuration for agent persistence and workspace authorization.
#[derive(Clone, Debug)]
pub struct AgentHttpConfig {
    /// Database file. The `CHROME_MCP_AGENT_DB_FILE` override takes precedence in [`Self::from_environment`].
    pub database_path: PathBuf,
    /// State base directory.
    pub data_dir: PathBuf,
    /// Roots allowed for persisted project workspaces.
    pub allowed_workspace_roots: Vec<PathBuf>,
}

impl AgentHttpConfig {
    /// Resolves the existing TypeScript environment contract without opening storage.
    #[must_use]
    pub fn from_environment(home: PathBuf) -> Self {
        let data_dir = environment_path("CHROME_MCP_AGENT_DATA_DIR")
            .unwrap_or_else(|| home.join(".humanchrome-agent"));
        let database_path = environment_path("CHROME_MCP_AGENT_DB_FILE")
            .unwrap_or_else(|| data_dir.join("agent.db"));
        let mut allowed_workspace_roots = vec![home];
        if let Some(root) = environment_path("USERPROFILE") {
            allowed_workspace_roots.push(root);
        }
        if let Some(root) = environment_path("MCP_ALLOWED_WORKSPACE_BASE") {
            allowed_workspace_roots.push(root);
        }
        Self {
            database_path,
            data_dir,
            allowed_workspace_roots,
        }
    }
    /// Resolves agent state from the process-captured native paths.
    #[must_use]
    pub fn from_native_paths(paths: &crate::paths::NativePaths) -> Self {
        Self::from_environment(paths.home.clone())
    }
}

/// Captured DNS-rebinding, cross-origin, and optional bearer-token policy.
#[derive(Clone, Debug)]
pub struct AgentAuthorizer {
    bearer_token: Option<Arc<str>>,
}

impl AgentAuthorizer {
    /// Captures `HUMANCHROME_TOKEN` once at server startup.
    #[must_use]
    pub fn from_environment() -> Self {
        Self {
            bearer_token: std::env::var("HUMANCHROME_TOKEN")
                .ok()
                .map(|token| token.trim().to_owned())
                .filter(|token| !token.is_empty())
                .map(Arc::from),
        }
    }

    /// Creates a policy for a supplied token, primarily for isolated server construction.
    #[must_use]
    pub fn new(bearer_token: Option<String>) -> Self {
        Self {
            bearer_token: bearer_token
                .map(|token| token.trim().to_owned())
                .filter(|token| !token.is_empty())
                .map(Arc::from),
        }
    }

    fn permits(&self, headers: &HeaderMap) -> Result<(), ApiError> {
        let host = header(headers, "host")
            .unwrap_or_default()
            .to_ascii_lowercase();
        let hostname = host.split(':').next().unwrap_or_default();
        if !(matches!(hostname, "127.0.0.1" | "localhost")
            || matches!(host.as_str(), "[::1]" | "::1")
            || host.starts_with("[::1]:"))
        {
            return Err(ApiError::new(StatusCode::FORBIDDEN, "Host not allowed"));
        }
        if let Some(origin) = header(headers, "origin") {
            let permitted = origin.starts_with("chrome-extension://")
                || origin.starts_with("moz-extension://")
                || origin.starts_with("http://127.0.0.1");
            if !permitted {
                return Err(ApiError::new(StatusCode::FORBIDDEN, "Origin not allowed"));
            }
        }
        if let Some(required) = &self.bearer_token {
            let presented = header(headers, "authorization")
                .and_then(|value| value.strip_prefix("Bearer "))
                .map(str::trim)
                .unwrap_or_default();
            if presented != required.as_ref() {
                return Err(ApiError::new(
                    StatusCode::UNAUTHORIZED,
                    "Invalid or missing bearer token",
                ));
            }
        }
        Ok(())
    }
}

/// Owns an initialized local agent service and builds its HTTP router.
#[derive(Clone)]
pub struct AgentHttp {
    state: HttpState,
    authorizer: AgentAuthorizer,
}

#[derive(Clone)]
struct HttpState {
    service: AgentService,
    attachments: AttachmentStore,
    default_workspace: PathBuf,
}

impl AgentHttp {
    /// Opens local state and registers explicit provider implementations.
    ///
    /// # Errors
    /// Returns database initialization errors before any HTTP listener is created.
    pub fn new(config: AgentHttpConfig, providers: ProviderRegistry) -> Result<Self, StoreError> {
        let store = AgentStore::open(&config.database_path, config.allowed_workspace_roots)?;
        let attachments = AttachmentStore::open(config.data_dir.clone());
        let service = AgentService::new(store, super::stream::AgentStreamHub::default(), providers)
            .with_attachments(attachments.clone());
        Ok(Self {
            state: HttpState {
                service,
                attachments,
                default_workspace: config.data_dir.join("workspaces"),
            },
            authorizer: AgentAuthorizer::from_environment(),
        })
    }
    /// Opens local state after the bridge port is known and lets the caller bind providers to it.
    ///
    /// The factory runs without reading external API credentials; it receives only the actual
    /// loopback bridge URL selected by lifecycle port walking.
    pub fn with_bound_port(
        config: AgentHttpConfig,
        bound_port: u16,
        providers: impl FnOnce(String) -> ProviderRegistry,
    ) -> Result<Self, StoreError> {
        let bridge_url = format!("http://127.0.0.1:{bound_port}");
        Self::new(config, providers(bridge_url))
    }

    /// Returns the initialized service for lifecycle integration and explicit shutdown ownership.
    #[must_use]
    pub fn service(&self) -> &AgentService {
        &self.state.service
    }

    /// Builds all supported agent routes with state-changing requests guarded before handlers run.
    pub fn router(&self) -> Router {
        let project_store = self.state.service.store().clone();
        let project_source: Arc<dyn crate::agent_attachments::AttachmentProjectSource> =
            Arc::new(move || {
                project_store
                    .projects()
                    .map(|projects| {
                        projects
                            .into_iter()
                            .map(|project| (project.id, project.name))
                            .collect::<BTreeMap<_, _>>()
                    })
                    .map_err(|error| error.to_string())
            });
        let attachment_routes =
            attachment_router_with_projects(self.state.attachments.clone(), project_source)
                .route_layer(middleware::from_fn_with_state(
                    self.authorizer.clone(),
                    authorize_mutations,
                ));
        Router::new()
            .route("/agent/engines", get(engines))
            .route("/agent/projects", get(projects).post(upsert_project))
            .route("/agent/projects/{project_id}", delete(delete_project))
            .route("/agent/projects/validate-path", post(validate_project_path))
            .route(
                "/agent/projects/create-directory",
                post(create_project_directory),
            )
            .route("/agent/projects/default-workspace", get(default_workspace))
            .route("/agent/projects/default-root", post(default_project_root))
            .route("/agent/sessions", get(all_sessions))
            .route(
                "/agent/projects/{project_id}/sessions",
                get(project_sessions).post(create_session),
            )
            .route(
                "/agent/projects/{project_id}/claude-info",
                get(project_claude_info),
            )
            .route("/agent/sessions/{session_id}/history", get(session_history))
            .route("/agent/sessions/{session_id}/reset", post(reset_session))
            .route(
                "/agent/sessions/{session_id}/claude-info",
                get(session_claude_info),
            )
            .route(
                "/agent/sessions/{session_id}",
                get(session).patch(update_session).delete(delete_session),
            )
            .route(
                "/agent/sessions/{session_id}/open",
                post(open_session_project),
            )
            .route("/agent/projects/{project_id}/open", post(open_project))
            .route(
                "/agent/projects/{project_id}/open-file",
                post(open_project_file),
            )
            .route("/agent/projects/pick-directory", post(pick_directory))
            .route(
                "/agent/chat/{project_id}/messages",
                get(project_messages)
                    .post(create_message)
                    .delete(delete_project_messages),
            )
            .route("/agent/chat/{session_id}/stream", get(stream))
            .route(
                "/agent/chat/{session_id}/act",
                post(act).layer(DefaultBodyLimit::max(50 * 1024 * 1024)),
            )
            .route(
                "/agent/chat/{session_id}/cancel/{request_id}",
                delete(cancel_request),
            )
            .route("/agent/chat/{session_id}/cancel", delete(cancel_session))
            .route_layer(middleware::from_fn_with_state(
                self.authorizer.clone(),
                authorize_mutations,
            ))
            .with_state(self.state.clone())
            .merge(attachment_routes)
    }
}

async fn authorize_mutations(
    authorizer: State<AgentAuthorizer>,
    request: Request<axum::body::Body>,
    next: Next,
) -> Response {
    if matches!(
        *request.method(),
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    ) && let Err(error) = authorizer.permits(request.headers())
    {
        return error.into_response();
    }
    next.run(request).await
}

async fn engines(State(state): State<HttpState>) -> Json<Value> {
    Json(
        json!({ "engines": state.service.engines().into_iter().map(|name| json!({"name": name})).collect::<Vec<_>>() }),
    )
}

async fn projects(State(state): State<HttpState>) -> Result<Json<Value>, ApiError> {
    let projects = state
        .service
        .store()
        .blocking(|store| store.projects())
        .await
        .map_err(ApiError::store)?;
    Ok(Json(json!({ "projects": projects })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateProjectRouteInput {
    id: Option<String>,
    name: Option<String>,
    description: Option<String>,
    root_path: Option<String>,
    preferred_cli: Option<EngineName>,
    selected_model: Option<String>,
    use_ccr: Option<bool>,
    enable_human_chrome: Option<bool>,
    allow_create: Option<bool>,
}

async fn upsert_project(
    State(state): State<HttpState>,
    Json(input): Json<CreateProjectRouteInput>,
) -> Result<Json<Value>, ApiError> {
    let (Some(name), Some(root_path)) = (input.name, input.root_path) else {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "name and rootPath are required to create a project",
        ));
    };
    if name.trim().is_empty() || root_path.trim().is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "name and rootPath are required to create a project",
        ));
    }
    let project = state
        .service
        .store()
        .blocking(move |store| {
            store.upsert_project(CreateProjectInput {
                id: input.id,
                name,
                description: input.description,
                root_path,
                preferred_cli: input.preferred_cli,
                selected_model: input.selected_model,
                use_ccr: input.use_ccr,
                enable_human_chrome: input.enable_human_chrome,
                allow_create: input.allow_create,
            })
        })
        .await
        .map_err(|error| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    Ok(Json(json!({ "project": project })))
}

async fn delete_project(
    State(state): State<HttpState>,
    Path(project_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    if project_id.is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "project id is required",
        ));
    }
    state
        .service
        .store()
        .blocking(move |store| store.delete_project(&project_id))
        .await
        .map_err(ApiError::store)?;
    Ok(StatusCode::NO_CONTENT)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RootPathBody {
    root_path: Option<String>,
}

async fn validate_project_path(
    State(state): State<HttpState>,
    Json(body): Json<RootPathBody>,
) -> Result<Json<Value>, ApiError> {
    let root_path = body
        .root_path
        .filter(|path| !path.trim().is_empty())
        .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "rootPath is required"))?;
    let validation = state
        .service
        .store()
        .blocking(move |store| Ok(store.validate_root(&root_path)))
        .await
        .map_err(ApiError::store)?;
    Ok(Json(json!(validation)))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AbsolutePathBody {
    absolute_path: Option<String>,
}

async fn create_project_directory(
    State(state): State<HttpState>,
    Json(body): Json<AbsolutePathBody>,
) -> Result<Json<Value>, ApiError> {
    let absolute_path = body
        .absolute_path
        .filter(|path| !path.trim().is_empty())
        .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "absolutePath is required"))?;
    state
        .service
        .store()
        .blocking({
            let path = absolute_path.clone();
            move |store| store.create_project_directory(&path)
        })
        .await
        .map_err(ApiError::store)?;
    Ok(Json(json!({"success": true, "path": absolute_path})))
}

async fn default_workspace(State(state): State<HttpState>) -> Json<Value> {
    Json(json!({"success": true, "path": state.default_workspace}))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectNameBody {
    project_name: Option<String>,
}

async fn default_project_root(
    State(state): State<HttpState>,
    Json(body): Json<ProjectNameBody>,
) -> Result<Json<Value>, ApiError> {
    let name = body
        .project_name
        .filter(|name| !name.trim().is_empty())
        .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "projectName is required"))?;
    let name = name.trim().to_ascii_lowercase();
    let slug = name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '_' | '-') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    let slug = slug
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    Ok(Json(
        json!({"success": true, "path": state.default_workspace.join(if slug.is_empty() { "default-project" } else { &slug })}),
    ))
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum OpenTarget {
    Vscode,
    Terminal,
}

#[derive(Deserialize)]
struct OpenProjectBody {
    target: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenFileBody {
    file_path: Option<String>,
    line: Option<u32>,
    column: Option<u32>,
}

fn open_target(body: OpenProjectBody) -> Result<OpenTarget, OpenRouteError> {
    match body.target.as_deref() {
        Some("vscode") => Ok(OpenTarget::Vscode),
        Some("terminal") => Ok(OpenTarget::Terminal),
        Some(_) => Err(OpenRouteError::new(
            StatusCode::BAD_REQUEST,
            "Invalid target. Must be one of: vscode, terminal",
        )),
        None => Err(OpenRouteError::new(
            StatusCode::BAD_REQUEST,
            "target is required",
        )),
    }
}

async fn open_session_project(
    State(state): State<HttpState>,
    Path(session_id): Path<String>,
    Json(body): Json<OpenProjectBody>,
) -> Result<Json<Value>, OpenRouteError> {
    let target = open_target(body)?;
    let session = state
        .service
        .store()
        .blocking(move |store| store.session(&session_id))
        .await
        .map_err(|error| OpenRouteError::from_api(ApiError::store(error)))?
        .ok_or_else(|| OpenRouteError::new(StatusCode::NOT_FOUND, "Session not found"))?;
    open_project_path(&state, &session.project_id, target)
        .await
        .map_err(OpenRouteError::from_api)
}

async fn open_project(
    State(state): State<HttpState>,
    Path(project_id): Path<String>,
    Json(body): Json<OpenProjectBody>,
) -> Result<Json<Value>, OpenRouteError> {
    let target = open_target(body)?;
    open_project_path(&state, &project_id, target)
        .await
        .map_err(OpenRouteError::from_api)
}

async fn open_project_path(
    state: &HttpState,
    project_id: &str,
    target: OpenTarget,
) -> Result<Json<Value>, ApiError> {
    let project_id = project_id.to_owned();
    let project = state
        .service
        .store()
        .blocking(move |store| store.project(&project_id))
        .await
        .map_err(ApiError::store)?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Project not found"))?;
    run_open_target(&project.root_path, target).await?;
    Ok(Json(json!({"success": true})))
}

async fn open_project_file(
    State(state): State<HttpState>,
    Path(project_id): Path<String>,
    Json(body): Json<OpenFileBody>,
) -> Result<Json<Value>, OpenRouteError> {
    let file_path = body
        .file_path
        .filter(|path| !path.trim().is_empty())
        .ok_or_else(|| OpenRouteError::new(StatusCode::BAD_REQUEST, "filePath is required"))?;
    let project = state
        .service
        .store()
        .blocking(move |store| store.project(&project_id))
        .await
        .map_err(|error| OpenRouteError::from_api(ApiError::store(error)))?
        .ok_or_else(|| OpenRouteError::new(StatusCode::NOT_FOUND, "Project not found"))?;
    let line = body.line.unwrap_or(1).max(1);
    let column = body.column.unwrap_or(1).max(1);
    let launch = tokio::task::spawn_blocking(move || -> Result<String, ApiError> {
        let root = std::fs::canonicalize(&project.root_path)
            .map_err(|error| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
        let candidate = PathBuf::from(&file_path);
        let file = if candidate.is_absolute() {
            candidate
        } else {
            root.join(candidate)
        };
        let file = std::fs::canonicalize(file)
            .map_err(|error| ApiError::new(StatusCode::BAD_REQUEST, error.to_string()))?;
        if !file.starts_with(&root) {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "filePath must be within project root",
            ));
        }
        Ok(format!("{}:{line}:{column}", file.display()))
    })
    .await
    .map_err(|error| {
        OpenRouteError::from_api(ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            error.to_string(),
        ))
    })?
    .map_err(OpenRouteError::from_api)?;
    let status = Command::new("code")
        .arg("--goto")
        .arg(launch)
        .status()
        .await
        .map_err(|error| {
            OpenRouteError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
        })?;
    if !status.success() {
        return Err(OpenRouteError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("VS Code exited with {status}"),
        ));
    }
    Ok(Json(json!({"success": true})))
}

async fn pick_directory() -> Result<Json<Value>, OpenRouteError> {
    let result = directory_picker().await.map_err(OpenRouteError::from_api)?;
    match result {
        Some(path) => Ok(Json(json!({"success": true, "path": path}))),
        None => Ok(Json(json!({"success": false, "cancelled": true}))),
    }
}

async fn run_open_target(root: &str, target: OpenTarget) -> Result<(), ApiError> {
    let mut command = if cfg!(target_os = "macos") {
        let mut command = Command::new("open");
        match target {
            OpenTarget::Vscode => {
                command.args(["-a", "Visual Studio Code", root]);
            }
            OpenTarget::Terminal => {
                command.args(["-a", "Terminal", root]);
            }
        }
        command
    } else if cfg!(target_os = "windows") {
        let mut command = Command::new("cmd");
        match target {
            OpenTarget::Vscode => {
                command.args(["/C", "code", root]);
            }
            OpenTarget::Terminal => {
                command.args(["/C", "start", "", root]);
            }
        }
        command
    } else {
        let mut command = Command::new(match target {
            OpenTarget::Vscode => "code",
            OpenTarget::Terminal => "xdg-open",
        });
        command.arg(root);
        command
    };
    let status = command
        .status()
        .await
        .map_err(|error| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    if status.success() {
        Ok(())
    } else {
        Err(ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("open command exited with {status}"),
        ))
    }
}

async fn directory_picker() -> Result<Option<String>, ApiError> {
    #[cfg(target_os = "macos")]
    {
        let script = "\n    set selectedFolder to choose folder with prompt \"Select Project Directory\"\n    return POSIX path of selectedFolder\n  ";
        let output = Command::new("osascript")
            .args(["-e", script])
            .output()
            .await
            .map_err(|error| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_owned();
            return Ok((!path.is_empty()).then_some(path));
        }
        if output.status.code() == Some(1) {
            return Ok(None);
        }
        Err(ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!(
                "Command failed: osascript -e '{script}'\n{}",
                String::from_utf8_lossy(&output.stderr)
            ),
        ))
    }
    #[cfg(target_os = "windows")]
    {
        let output = Command::new("powershell")
            .args(["-NoProfile", "-Command", "Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; if($d.ShowDialog() -eq 'OK'){[Console]::Write($d.SelectedPath)}"])
            .output().await
            .map_err(|error| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_owned();
            return Ok((!path.is_empty()).then_some(path));
        }
        return Ok(None);
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let output = Command::new("zenity")
            .args(["--file-selection", "--directory"])
            .output()
            .await
            .map_err(|error| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_owned();
            return Ok((!path.is_empty()).then_some(path));
        }
        Ok(None)
    }
}

async fn all_sessions(State(state): State<HttpState>) -> Result<Json<Value>, ApiError> {
    let sessions = state
        .service
        .store()
        .blocking(|store| store.all_sessions())
        .await
        .map_err(ApiError::store)?;
    Ok(Json(json!({"sessions": sessions})))
}

async fn project_sessions(
    State(state): State<HttpState>,
    Path(project_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let sessions = state
        .service
        .store()
        .blocking(move |store| store.sessions(&project_id))
        .await
        .map_err(ApiError::store)?;
    Ok(Json(json!({"sessions": sessions})))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateSessionRouteInput {
    engine_name: Option<String>,
    name: Option<String>,
    model: Option<String>,
    permission_mode: Option<String>,
    allow_dangerously_skip_permissions: Option<bool>,
    system_prompt_config: Option<Value>,
    options_config: Option<Value>,
}

async fn create_session(
    State(state): State<HttpState>,
    Path(project_id): Path<String>,
    Json(input): Json<CreateSessionRouteInput>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let engine_name = input
        .engine_name
        .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "engineName is required"))?;
    let engine_name = match engine_name.as_str() {
        "claude" => EngineName::Claude,
        "codex" => EngineName::Codex,
        "cursor" => EngineName::Cursor,
        "qwen" => EngineName::Qwen,
        "glm" => EngineName::Glm,
        _ => {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "Invalid engineName. Must be one of: claude, codex, cursor, qwen, glm",
            ));
        }
    };
    let input = CreateSessionInput {
        engine_name,
        name: input.name,
        model: input.model,
        permission_mode: input.permission_mode,
        allow_dangerously_skip_permissions: input.allow_dangerously_skip_permissions,
        system_prompt_config: input.system_prompt_config,
        options_config: input.options_config,
    };
    let session = state
        .service
        .store()
        .blocking(move |store| {
            if store.project(&project_id)?.is_none() {
                return Err(StoreError::InvalidProjectRoot(
                    "Project not found".to_owned(),
                ));
            }
            store.create_session(&project_id, input)
        })
        .await
        .map_err(|error| match error {
            StoreError::InvalidProjectRoot(message) if message == "Project not found" => {
                ApiError::new(StatusCode::NOT_FOUND, message)
            }
            error => ApiError::store(error),
        })?;
    Ok((StatusCode::CREATED, Json(json!({"session": session}))))
}

async fn session(
    State(state): State<HttpState>,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let session = state
        .service
        .store()
        .blocking(move |store| store.session(&session_id))
        .await
        .map_err(ApiError::store)?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Session not found"))?;
    Ok(Json(json!({"session": session})))
}

async fn update_session(
    State(state): State<HttpState>,
    Path(session_id): Path<String>,
    Json(input): Json<UpdateSessionInput>,
) -> Result<Json<Value>, ApiError> {
    let session_id_for_store = session_id.clone();
    if !state
        .service
        .store()
        .blocking(move |store| store.update_session(&session_id_for_store, input))
        .await
        .map_err(ApiError::store)?
    {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "Session not found"));
    }
    session(State(state), Path(session_id)).await
}

async fn delete_session(
    State(state): State<HttpState>,
    Path(session_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state
        .service
        .store()
        .blocking(move |store| store.delete_session(&session_id))
        .await
        .map_err(ApiError::store)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn session_history(
    State(state): State<HttpState>,
    Path(session_id): Path<String>,
    Query(query): Query<Pagination>,
) -> Result<Json<Value>, ApiError> {
    let limit = query.limit.filter(|limit| *limit > 0);
    let offset = query.offset.unwrap_or(0);
    let session_id_for_store = session_id.clone();
    let (exists, messages, total_count) = state
        .service
        .store()
        .blocking(move |store| {
            let exists = store.session(&session_id_for_store)?.is_some();
            let messages = store.session_messages(&session_id_for_store, limit, offset)?;
            let total_count = store.session_message_count(&session_id_for_store)?;
            Ok((exists, messages, total_count))
        })
        .await
        .map_err(ApiError::store)?;
    if !exists {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "Session not found"));
    }
    let has_more = limit.is_some()
        && offset.saturating_add(messages.len())
            < usize::try_from(total_count).unwrap_or(usize::MAX);
    Ok(Json(
        json!({"success": true, "sessionId": session_id, "messages": messages, "totalCount": total_count, "pagination": {"limit": limit.unwrap_or(0), "offset": offset, "count": messages.len(), "hasMore": has_more}}),
    ))
}

async fn reset_session(
    State(state): State<HttpState>,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let session_id_for_store = session_id.clone();
    let result = state
        .service
        .store()
        .blocking(move |store| store.reset_session(&session_id_for_store))
        .await
        .map_err(ApiError::store)?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Session not found"))?;
    let (session, deleted_messages, cleared_engine_session_id) = result;
    Ok(Json(
        json!({"success": true, "sessionId": session_id, "deletedMessages": deleted_messages, "clearedEngineSessionId": cleared_engine_session_id, "session": session}),
    ))
}

async fn session_claude_info(
    State(state): State<HttpState>,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let session_id_for_store = session_id.clone();
    let session = state
        .service
        .store()
        .blocking(move |store| store.session(&session_id_for_store))
        .await
        .map_err(ApiError::store)?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Session not found"))?;
    Ok(Json(
        json!({"managementInfo": session.management_info, "sessionId": session_id, "engineName": session.engine_name}),
    ))
}

async fn project_claude_info(
    State(state): State<HttpState>,
    Path(project_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let project_id_for_store = project_id.clone();
    let (project, sessions) = state
        .service
        .store()
        .blocking(move |store| {
            let project = store.project(&project_id_for_store)?;
            let sessions = store
                .sessions_for_engine(&project_id_for_store, super::types::EngineName::Claude)?;
            Ok((project, sessions))
        })
        .await
        .map_err(ApiError::store)?;
    if project.is_none() {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "Project not found"));
    }
    let mut with_info = sessions
        .into_iter()
        .filter(|session| session.management_info.is_some())
        .collect::<Vec<_>>();
    with_info.sort_by(|left, right| management_updated_at(right).cmp(management_updated_at(left)));
    let source = with_info.first();
    let mut response = serde_json::Map::new();
    response.insert(
        "managementInfo".to_owned(),
        source
            .and_then(|session| session.management_info.clone())
            .unwrap_or(Value::Null),
    );
    if let Some(source) = source {
        response.insert(
            "sourceSessionId".to_owned(),
            Value::String(source.id.clone()),
        );
    }
    response.insert("projectId".to_owned(), Value::String(project_id));
    response.insert("sessionsWithInfo".to_owned(), json!(with_info.len()));
    Ok(Json(Value::Object(response)))
}

fn management_updated_at(session: &super::types::AgentSession) -> &str {
    session
        .management_info
        .as_ref()
        .and_then(|info| info.get("lastUpdated"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(&session.updated_at)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessageInput {
    content: Option<String>,
    role: Option<String>,
    message_type: Option<String>,
    #[serde(default, deserialize_with = "super::types::nullable_patch")]
    conversation_id: Option<Option<String>>,
    session_id: Option<String>,
    cli_source: Option<String>,
    metadata: Option<Value>,
    request_id: Option<String>,
    id: Option<String>,
    created_at: Option<String>,
}

#[derive(Deserialize)]
struct Pagination {
    limit: Option<usize>,
    offset: Option<usize>,
}

async fn project_messages(
    State(state): State<HttpState>,
    Path(project_id): Path<String>,
    Query(query): Query<Pagination>,
) -> Result<Json<Value>, ApiError> {
    let limit = query.limit.filter(|limit| *limit > 0).unwrap_or(50);
    let offset = query.offset.unwrap_or(0);
    let (messages, total_count) = state
        .service
        .store()
        .blocking(move |store| {
            Ok((
                store.project_messages(&project_id, limit, offset)?,
                store.project_message_count(&project_id)?,
            ))
        })
        .await
        .map_err(ApiError::store)?;
    let count = messages.len();
    let has_more =
        offset.saturating_add(count) < usize::try_from(total_count).unwrap_or(usize::MAX);
    Ok(Json(json!({
        "success": true,
        "data": messages,
        "totalCount": total_count,
        "pagination": {"limit": limit, "offset": offset, "count": count, "hasMore": has_more},
    })))
}

async fn create_message(
    State(state): State<HttpState>,
    Path(project_id): Path<String>,
    Json(input): Json<MessageInput>,
) -> Response {
    let content = input.content.unwrap_or_default().trim().to_owned();
    if content.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"success": false, "error": "content is required"})),
        )
            .into_response();
    }
    let role = match input
        .role
        .as_deref()
        .map(|role| role.trim().to_ascii_lowercase())
        .as_deref()
    {
        Some("assistant") => "assistant",
        Some("system") => "system",
        Some("tool") => "tool",
        _ => "user",
    };
    let raw_message_type = input.message_type.as_deref().map(str::to_ascii_lowercase);
    let message_type = match raw_message_type.as_deref() {
        Some("chat" | "tool_use" | "tool_result" | "status") => {
            raw_message_type.unwrap_or_default()
        }
        _ if role == "system" => "status".to_owned(),
        _ => "chat".to_owned(),
    };
    let message = AgentStoredMessage {
        id: input
            .id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| Uuid::new_v4().to_string()),
        project_id,
        session_id: input.session_id.unwrap_or_default(),
        conversation_id: input.conversation_id.flatten(),
        role: role.to_owned(),
        content,
        message_type,
        metadata: input.metadata,
        cli_source: input.cli_source,
        request_id: input.request_id,
        created_at: input.created_at.unwrap_or_else(now),
    };
    match state.service.store().blocking(move |store| store.upsert_message(message)).await {
        Ok(message) => (StatusCode::CREATED, Json(json!({"success": true, "data": message}))).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"success": false, "error": "Failed to create message", "message": error.to_string()})),
        ).into_response(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteMessagesQuery {
    conversation_id: Option<String>,
}

async fn delete_project_messages(
    State(state): State<HttpState>,
    Path(project_id): Path<String>,
    Query(query): Query<DeleteMessagesQuery>,
) -> Result<Json<Value>, ApiError> {
    let conversation_id = query.conversation_id;
    let count = state
        .service
        .store()
        .blocking(move |store| {
            store.delete_project_messages(&project_id, conversation_id.as_deref())
        })
        .await
        .map_err(ApiError::store)?;
    Ok(Json(json!({"success": true, "deleted": count})))
}

async fn stream(
    State(state): State<HttpState>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    let connected = RealtimeEvent::Connected {
        data: ConnectedEvent {
            session_id: session_id.clone(),
            transport: "sse".to_owned(),
            timestamp: now(),
        },
    };
    let events = state.service.streams().subscribe(&session_id);
    state.service.streams().publish(&session_id, connected);
    Sse::new(SseEvents {
        opening: true,
        events,
    })
}

async fn act(
    State(state): State<HttpState>,
    Path(session_id): Path<String>,
    Json(request): Json<AgentActRequest>,
) -> Result<Json<super::types::AgentActResponse>, ApiError> {
    state
        .service
        .handle_act(session_id, request)
        .await
        .map(Json)
        .map_err(ApiError::service)
}

async fn cancel_request(
    State(state): State<HttpState>,
    Path((session_id, request_id)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    if session_id.is_empty() || request_id.is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "sessionId and requestId are required",
        ));
    }
    let cancelled = state.service.cancel_execution(&request_id);
    Ok(Json(json!({
        "success": cancelled,
        "message": if cancelled { "Execution cancelled" } else { "No running execution found with this requestId" },
        "requestId": request_id,
        "sessionId": session_id,
    })))
}

async fn cancel_session(
    State(state): State<HttpState>,
    Path(session_id): Path<String>,
) -> Json<Value> {
    Json(
        json!({"success": true, "cancelledCount": state.service.cancel_session(&session_id), "sessionId": session_id}),
    )
}

struct SseEvents {
    opening: bool,
    events: AgentEventStream,
}
impl Stream for SseEvents {
    type Item = Result<Event, Infallible>;
    fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.opening {
            self.opening = false;
            return Poll::Ready(Some(Ok(Event::default().comment(""))));
        }
        match Pin::new(&mut self.events).poll_next(context) {
            Poll::Ready(Some(Ok(event))) => Poll::Ready(Some(Ok(sse_event(event)))),
            Poll::Ready(Some(Err(error))) => {
                Poll::Ready(Some(Ok(sse_event(RealtimeEvent::Error {
                    error: error.to_string(),
                    data: None,
                }))))
            }
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
}

fn sse_event(event: RealtimeEvent) -> Event {
    Event::default()
        .json_data(event)
        .expect("agent event values serialize as JSON")
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}
impl ApiError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
    fn store(error: StoreError) -> Self {
        match error {
            StoreError::InvalidProjectRoot(message) => Self::new(StatusCode::BAD_REQUEST, message),
            error => Self::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
        }
    }
    fn service(error: AgentServiceError) -> Self {
        match error {
            AgentServiceError::NotFound(message) => Self::new(StatusCode::NOT_FOUND, message),
            AgentServiceError::Store(error) => Self::store(error),
            error => Self::new(StatusCode::BAD_REQUEST, error.to_string()),
        }
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({"error": self.message}))).into_response()
    }
}

#[derive(Debug)]
struct OpenRouteError {
    status: StatusCode,
    message: String,
}

impl OpenRouteError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    fn from_api(error: ApiError) -> Self {
        Self {
            status: error.status,
            message: error.message,
        }
    }
}

impl IntoResponse for OpenRouteError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({"success": false, "error": self.message})),
        )
            .into_response()
    }
}

fn environment_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .map(|path| {
            if path.is_absolute() {
                path
            } else {
                std::env::current_dir()
                    .unwrap_or_else(|_| PathBuf::from("."))
                    .join(path)
            }
        })
}
fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}
fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};

    #[tokio::test]
    async fn mutation_authorizer_rejects_dns_rebinding_host() {
        let policy = AgentAuthorizer::new(None);
        let request = Request::builder()
            .method(Method::POST)
            .header("host", "attacker.example")
            .body(Body::empty())
            .expect("request");
        let error = policy
            .permits(request.headers())
            .expect_err("rejected host");
        assert_eq!(error.status, StatusCode::FORBIDDEN);
    }
}
