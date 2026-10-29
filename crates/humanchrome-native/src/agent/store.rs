//! SQLite-backed persistence for agent projects, sessions, and messages.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
};

use chrono::{SecondsFormat, Utc};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde_json::Value;
use thiserror::Error;
use uuid::Uuid;

use super::types::{
    AgentProject, AgentSession, AgentStoredMessage, CreateProjectInput, CreateSessionInput,
    EngineName, UpdateSessionInput,
};

/// Persistence failures returned to HTTP handlers without leaking SQLite internals on success paths.
#[derive(Debug, Error)]
pub enum StoreError {
    /// A filesystem operation needed for the database failed.
    #[error("agent storage filesystem error: {0}")]
    Io(#[from] std::io::Error),
    /// SQLite rejected an operation.
    #[error("agent storage error: {0}")]
    Sql(#[from] rusqlite::Error),
    /// A caller supplied an invalid project root.
    #[error("invalid project root: {0}")]
    InvalidProjectRoot(String),
    /// Database serialization failed.
    #[error("agent storage serialization error: {0}")]
    Json(#[from] serde_json::Error),
    /// The dedicated blocking-storage task did not complete.
    #[error("agent storage task failed: {0}")]
    Task(#[from] tokio::task::JoinError),
    /// The process-local connection owner panicked.
    #[error("agent storage lock poisoned")]
    Lock,
}

/// Validation result returned by the project-root endpoint.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathValidation {
    /// Whether the root is allowed and usable.
    pub valid: bool,
    /// Resolved absolute path where available.
    pub absolute: String,
    /// Whether the path currently exists.
    pub exists: bool,
    /// Whether the caller can request its creation.
    pub needs_creation: bool,
    /// Human-readable validation failure.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// A process-owned agent database with an explicit workspace authorization boundary.
#[derive(Clone, Debug)]
pub struct AgentStore {
    connection: Arc<Mutex<Connection>>,
    allowed_roots: Arc<Vec<PathBuf>>,
}
/// Borrowed fields for a single persisted agent message.
#[derive(Debug)]
pub struct CreateMessage<'a> {
    pub project_id: &'a str,
    pub session_id: &'a str,
    pub role: &'a str,
    pub content: &'a str,
    pub message_type: &'a str,
    pub metadata: Option<&'a Value>,
    pub cli_source: Option<&'a str>,
    pub request_id: Option<&'a str>,
}

impl AgentStore {
    /// Opens and migrates a database at `database_path`.
    ///
    /// `allowed_roots` contains the only filesystem prefixes project requests may use.
    /// Empty roots are ignored, and callers should pass resolved absolute paths.
    ///
    /// # Errors
    /// Returns database initialization errors without creating a project workspace.
    pub fn open(
        database_path: impl AsRef<Path>,
        allowed_roots: impl IntoIterator<Item = PathBuf>,
    ) -> Result<Self, StoreError> {
        let database_path = database_path.as_ref();
        if let Some(parent) = database_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(database_path)?;
        connection.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS projects (
               id TEXT PRIMARY KEY NOT NULL,
               name TEXT NOT NULL,
               description TEXT,
               root_path TEXT NOT NULL,
               preferred_cli TEXT,
               selected_model TEXT,
               active_claude_session_id TEXT,
               use_ccr TEXT,
               enable_humanchrome TEXT NOT NULL DEFAULT '1',
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL,
               last_active_at TEXT
             );
             CREATE INDEX IF NOT EXISTS projects_last_active_idx ON projects(last_active_at);
             CREATE TABLE IF NOT EXISTS sessions (
               id TEXT PRIMARY KEY NOT NULL,
               project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
               engine_name TEXT NOT NULL,
               engine_session_id TEXT,
               name TEXT,
               model TEXT,
               permission_mode TEXT NOT NULL DEFAULT 'bypassPermissions',
               allow_dangerously_skip_permissions TEXT,
               system_prompt_config TEXT,
               options_config TEXT,
               management_info TEXT,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS sessions_project_id_idx ON sessions(project_id);
             CREATE INDEX IF NOT EXISTS sessions_engine_name_idx ON sessions(engine_name);
             CREATE TABLE IF NOT EXISTS messages (
               id TEXT PRIMARY KEY NOT NULL,
               project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
               session_id TEXT NOT NULL,
               conversation_id TEXT,
               role TEXT NOT NULL,
               content TEXT NOT NULL,
               message_type TEXT NOT NULL,
               metadata TEXT,
               cli_source TEXT,
               request_id TEXT,

               created_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS messages_project_id_idx ON messages(project_id);
             CREATE INDEX IF NOT EXISTS messages_session_id_idx ON messages(session_id);
             CREATE INDEX IF NOT EXISTS messages_created_at_idx ON messages(created_at);
             CREATE INDEX IF NOT EXISTS messages_request_id_idx ON messages(request_id);",
        )?;
        migrate_schema(&connection)?;
        let roots: Vec<PathBuf> = allowed_roots
            .into_iter()
            .filter(|root| !root.as_os_str().is_empty())
            .map(|root| make_absolute(&root))
            .collect::<Result<_, _>>()?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
            allowed_roots: Arc::new(roots),
        })
    }

    /// Runs one SQLite or synchronous filesystem operation on Tokio's blocking executor.
    ///
    /// HTTP and provider paths must use this boundary rather than invoke the synchronous
    /// SQLite connection directly from an async task.
    pub async fn blocking<T, F>(&self, operation: F) -> Result<T, StoreError>
    where
        T: Send + 'static,
        F: FnOnce(&Self) -> Result<T, StoreError> + Send + 'static,
    {
        let store = self.clone();
        tokio::task::spawn_blocking(move || operation(&store)).await?
    }

    /// Returns a validation result without creating a directory.
    #[must_use]
    pub fn validate_root(&self, root: &str) -> PathValidation {
        let trimmed = root.trim();
        if trimmed.is_empty() {
            return invalid_path("Project rootPath must not be empty", PathBuf::new());
        }
        let absolute = match make_absolute(Path::new(trimmed)) {
            Ok(path) => path,
            Err(error) => return invalid_path(&error.to_string(), PathBuf::new()),
        };
        if !self.allowed_roots.iter().any(|base| {
            absolute
                .to_string_lossy()
                .starts_with(base.to_string_lossy().as_ref())
        }) {
            return invalid_path(
                &format!(
                    "Project rootPath must be under allowed directories: {}",
                    self.allowed_roots
                        .iter()
                        .map(|root| root.display().to_string())
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
                absolute,
            );
        }
        match fs::metadata(&absolute) {
            Ok(metadata) if metadata.is_dir() => PathValidation {
                valid: true,
                absolute: absolute.display().to_string(),
                exists: true,
                needs_creation: false,
                error: None,
            },
            Ok(_) => invalid_path(
                &format!("Path exists but is not a directory: {}", absolute.display()),
                absolute,
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => PathValidation {
                valid: true,
                absolute: absolute.display().to_string(),
                exists: false,
                needs_creation: true,
                error: None,
            },
            Err(error) => invalid_path(&error.to_string(), absolute),
        }
    }

    /// Creates a previously validated absent project directory.
    ///
    /// # Errors
    /// Returns an error when the path is invalid, already exists, or cannot be created.
    pub fn create_project_directory(&self, root: &str) -> Result<(), StoreError> {
        let validation = self.validate_root(root);
        if !validation.valid {
            return Err(StoreError::InvalidProjectRoot(
                validation
                    .error
                    .unwrap_or_else(|| "Invalid path".to_owned()),
            ));
        }
        if validation.exists {
            return Err(StoreError::InvalidProjectRoot(
                "Directory already exists".to_owned(),
            ));
        }
        fs::create_dir_all(validation.absolute)?;
        Ok(())
    }

    /// Lists projects by most recent activity.
    pub fn projects(&self) -> Result<Vec<AgentProject>, StoreError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, name, description, root_path, preferred_cli, selected_model,
                    active_claude_session_id, use_ccr, enable_humanchrome, created_at,
                    updated_at, last_active_at
             FROM projects ORDER BY last_active_at DESC",
        )?;
        let rows = statement.query_map([], project_from_row)?;
        rows.collect::<Result<_, _>>().map_err(StoreError::from)
    }

    /// Gets one project by identity.
    pub fn project(&self, id: &str) -> Result<Option<AgentProject>, StoreError> {
        let connection = self.connection()?;
        connection
            .query_row(
                "SELECT id, name, description, root_path, preferred_cli, selected_model,
                        active_claude_session_id, use_ccr, enable_humanchrome, created_at,
                        updated_at, last_active_at
                 FROM projects WHERE id = ?1",
                [id],
                project_from_row,
            )
            .optional()
            .map_err(StoreError::from)
    }

    /// Inserts or updates a project by its caller-provided ID.
    ///
    /// # Errors
    /// Returns an error for invalid roots, failed directory creation, or database failures.
    pub fn upsert_project(&self, input: CreateProjectInput) -> Result<AgentProject, StoreError> {
        let validation = self.validate_root(&input.root_path);
        if !validation.valid {
            return Err(StoreError::InvalidProjectRoot(
                validation
                    .error
                    .unwrap_or_else(|| "Invalid path".to_owned()),
            ));
        }
        if validation.needs_creation {
            if input.allow_create.unwrap_or(false) {
                fs::create_dir_all(&validation.absolute)?;
            } else {
                return Err(StoreError::InvalidProjectRoot(format!(
                    "Directory does not exist: {}. Use the validate-path API first and confirm creation with the user.",
                    validation.absolute
                )));
            }
        }
        let id = input
            .id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let existing = self.project(&id)?;
        let now = now();
        let project = AgentProject {
            id,
            name: input.name.trim().to_owned(),
            description: nonempty(input.description).or_else(|| {
                existing
                    .as_ref()
                    .and_then(|project| nonempty(project.description.clone()))
            }),
            root_path: validation.absolute,
            preferred_cli: input
                .preferred_cli
                .or_else(|| existing.as_ref().and_then(|p| p.preferred_cli)),
            selected_model: input
                .selected_model
                .or_else(|| existing.as_ref().and_then(|p| p.selected_model.clone())),
            active_claude_session_id: existing
                .as_ref()
                .and_then(|p| p.active_claude_session_id.clone()),
            use_ccr: input
                .use_ccr
                .or_else(|| existing.as_ref().and_then(|p| p.use_ccr))
                .or(Some(false)),
            enable_human_chrome: input
                .enable_human_chrome
                .or_else(|| existing.as_ref().and_then(|p| p.enable_human_chrome))
                .or(Some(true)),
            created_at: existing
                .as_ref()
                .map_or_else(|| now.clone(), |p| p.created_at.clone()),
            updated_at: now.clone(),
            last_active_at: Some(now),
        };
        let connection = self.connection()?;
        connection.execute(
            "INSERT INTO projects (id, name, description, root_path, preferred_cli, selected_model,
             active_claude_session_id, use_ccr, enable_humanchrome, created_at, updated_at, last_active_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description,
             root_path = excluded.root_path, preferred_cli = excluded.preferred_cli,
             selected_model = excluded.selected_model, active_claude_session_id = excluded.active_claude_session_id,
             use_ccr = excluded.use_ccr, enable_humanchrome = excluded.enable_humanchrome,
             updated_at = excluded.updated_at, last_active_at = excluded.last_active_at",
            params![
                project.id, project.name, project.description, project.root_path,
                project.preferred_cli.map(EngineName::as_str), project.selected_model,
                project.active_claude_session_id, true_column(project.use_ccr),
                enabled_column(project.enable_human_chrome), project.created_at, project.updated_at,
                project.last_active_at
            ],
        )?;
        Ok(project)
    }

    /// Deletes a project and database-cascaded sessions/messages.
    pub fn delete_project(&self, id: &str) -> Result<(), StoreError> {
        self.connection()?
            .execute("DELETE FROM projects WHERE id = ?1", [id])?;
        Ok(())
    }
    /// Updates a project's activity timestamps after a durable chat turn.
    pub fn touch_project_activity(&self, id: &str) -> Result<(), StoreError> {
        let timestamp = now();
        self.connection()?.execute(
            "UPDATE projects SET last_active_at = ?2, updated_at = ?2 WHERE id = ?1",
            params![id, timestamp],
        )?;
        Ok(())
    }

    /// Persists or clears the legacy project-level Claude resume identifier.
    pub fn update_project_claude_session(
        &self,
        id: &str,
        session_id: Option<&str>,
    ) -> Result<(), StoreError> {
        let session_id = session_id.and_then(|session_id| {
            let session_id = session_id.trim();
            (!session_id.is_empty()).then_some(session_id)
        });
        self.connection()?.execute(
            "UPDATE projects SET active_claude_session_id = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, session_id, now()],
        )?;
        Ok(())
    }
    /// Clears only a provider-native session identifier after a resume rejection.
    pub fn clear_engine_session(&self, id: &str) -> Result<(), StoreError> {
        self.connection()?.execute(
            "UPDATE sessions SET engine_session_id = NULL, updated_at = ?2 WHERE id = ?1",
            params![id, now()],
        )?;
        Ok(())
    }

    /// Creates a session belonging to an existing project.
    pub fn create_session(
        &self,
        project_id: &str,
        input: CreateSessionInput,
    ) -> Result<AgentSession, StoreError> {
        let now = now();
        let permission_mode = input
            .permission_mode
            .and_then(|mode| nonempty(Some(mode)))
            .unwrap_or_else(|| "bypassPermissions".to_owned());
        let allow_dangerously_skip_permissions = input
            .allow_dangerously_skip_permissions
            .unwrap_or(permission_mode == "bypassPermissions");
        let session = AgentSession {
            id: Uuid::new_v4().to_string(),
            project_id: project_id.to_owned(),
            engine_name: input.engine_name,
            engine_session_id: None,
            name: nonempty(input.name),
            model: nonempty(input.model),
            permission_mode,
            allow_dangerously_skip_permissions,
            system_prompt_config: input.system_prompt_config,
            options_config: input.options_config,
            management_info: None,
            created_at: now.clone(),
            updated_at: now,
            preview: None,
            preview_meta: None,
        };
        self.connection()?.execute(
            "INSERT INTO sessions (id, project_id, engine_name, engine_session_id, name, model,
             permission_mode, allow_dangerously_skip_permissions, system_prompt_config,
             options_config, management_info, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                session.id,
                session.project_id,
                session.engine_name.as_str(),
                session.engine_session_id,
                session.name,
                session.model,
                session.permission_mode,
                true_column(Some(session.allow_dangerously_skip_permissions)),
                json_column(session.system_prompt_config.as_ref())?,
                json_column(session.options_config.as_ref())?,
                json_column(session.management_info.as_ref())?,
                session.created_at,
                session.updated_at,
            ],
        )?;
        Ok(session)
    }

    /// Updates a session's activity timestamp after a durable chat turn.
    pub fn touch_session_activity(&self, id: &str) -> Result<(), StoreError> {
        self.connection()?.execute(
            "UPDATE sessions SET updated_at = ?2 WHERE id = ?1",
            params![id, now()],
        )?;
        Ok(())
    }

    /// Gets one session by identity.
    pub fn session(&self, id: &str) -> Result<Option<AgentSession>, StoreError> {
        self.connection()?
            .query_row("SELECT id, project_id, engine_name, engine_session_id, name, model, permission_mode,
                        allow_dangerously_skip_permissions, system_prompt_config, options_config,
                        management_info, created_at, updated_at FROM sessions WHERE id = ?1", [id], session_from_row)
            .optional()
            .map_err(StoreError::from)
    }

    /// Lists all sessions for a project, newest first, with the established transcript preview.
    pub fn sessions(&self, project_id: &str) -> Result<Vec<AgentSession>, StoreError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare("SELECT id, project_id, engine_name, engine_session_id, name, model, permission_mode,
                        allow_dangerously_skip_permissions, system_prompt_config, options_config,
                        management_info, created_at, updated_at FROM sessions WHERE project_id = ?1 ORDER BY updated_at DESC")?;
        let mut sessions = statement
            .query_map([project_id], session_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        drop(connection);
        self.add_session_previews(&mut sessions)?;
        Ok(sessions)
    }

    /// Lists every session, newest first, with the established transcript preview.
    pub fn all_sessions(&self) -> Result<Vec<AgentSession>, StoreError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare("SELECT id, project_id, engine_name, engine_session_id, name, model, permission_mode,
                        allow_dangerously_skip_permissions, system_prompt_config, options_config,
                        management_info, created_at, updated_at FROM sessions ORDER BY updated_at DESC")?;
        let mut sessions = statement
            .query_map([], session_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        drop(connection);
        self.add_session_previews(&mut sessions)?;
        Ok(sessions)
    }

    fn add_session_previews(&self, sessions: &mut [AgentSession]) -> Result<(), StoreError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT content, metadata FROM messages WHERE session_id = ?1 AND role = 'user' ORDER BY created_at ASC LIMIT 1",
        )?;
        for session in sessions {
            let preview = statement
                .query_row([&session.id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
                })
                .optional()?;
            let Some((content, metadata)) = preview else {
                continue;
            };
            session.preview = Some(truncate_preview(&content, 50));
            let Some(Value::Object(metadata)) = metadata
                .as_deref()
                .and_then(|value| serde_json::from_str::<Value>(value).ok())
            else {
                continue;
            };
            let display_text = metadata.get("displayText").and_then(Value::as_str);
            let client_meta = metadata.get("clientMeta").filter(|client_meta| {
                matches!(
                    client_meta.get("kind").and_then(Value::as_str),
                    Some("web_editor_apply_batch" | "web_editor_apply_single")
                )
            });
            if display_text.is_some() || client_meta.is_some() {
                let mut preview_meta = serde_json::Map::new();
                preview_meta.insert(
                    "displayText".to_owned(),
                    Value::String(
                        display_text
                            .unwrap_or_else(|| session.preview.as_deref().unwrap_or_default())
                            .to_owned(),
                    ),
                );
                if let Some(client_meta) = client_meta {
                    preview_meta.insert("clientMeta".to_owned(), client_meta.clone());
                }
                preview_meta.insert(
                    "fullContent".to_owned(),
                    Value::String(truncate_preview(&content, 200)),
                );
                session.preview_meta = Some(Value::Object(preview_meta));
            }
        }
        Ok(())
    }

    /// Applies partial updates to a session.
    pub fn update_session(&self, id: &str, update: UpdateSessionInput) -> Result<bool, StoreError> {
        let Some(mut session) = self.session(id)? else {
            return Ok(false);
        };
        if let Some(value) = update.engine_session_id {
            session.engine_session_id = nonempty(value);
        }
        if let Some(value) = update.name {
            session.name = nonempty(value);
        }
        if let Some(value) = update.model {
            session.model = nonempty(value);
        }
        if let Some(value) = update.permission_mode {
            session.permission_mode =
                nonempty(value).unwrap_or_else(|| "bypassPermissions".to_owned());
        }
        if let Some(value) = update.allow_dangerously_skip_permissions {
            session.allow_dangerously_skip_permissions = value.unwrap_or(false);
        }
        if let Some(value) = update.management_info {
            session.management_info = value;
        }
        if let Some(value) = update.system_prompt_config {
            session.system_prompt_config = value;
        }
        if let Some(value) = update.options_config {
            session.options_config = value;
        }
        session.updated_at = now();
        self.connection()?.execute(
            "UPDATE sessions SET engine_session_id = ?2, name = ?3, model = ?4, permission_mode = ?5,
             allow_dangerously_skip_permissions = ?6, system_prompt_config = ?7,
             options_config = ?8, management_info = ?9, updated_at = ?10 WHERE id = ?1",
            params![id, session.engine_session_id, session.name, session.model, session.permission_mode,
                true_column(Some(session.allow_dangerously_skip_permissions)),
                json_column(session.system_prompt_config.as_ref())?, json_column(session.options_config.as_ref())?,
                json_column(session.management_info.as_ref())?, session.updated_at],
        )?;
        Ok(true)
    }

    /// Deletes a session without deleting its messages, matching the existing route behaviour.
    pub fn delete_session(&self, id: &str) -> Result<(), StoreError> {
        self.connection()?
            .execute("DELETE FROM sessions WHERE id = ?1", [id])?;
        Ok(())
    }
    /// Clears a session's provider resume identifier and returns its deleted transcript count.
    pub fn reset_session(
        &self,
        id: &str,
    ) -> Result<Option<(AgentSession, usize, bool)>, StoreError> {
        let Some(existing) = self.session(id)? else {
            return Ok(None);
        };
        let cleared_engine_session_id = existing.engine_session_id.is_some();
        let connection = self.connection()?;
        let transaction = connection.unchecked_transaction()?;
        transaction.execute(
            "UPDATE sessions SET engine_session_id = NULL, updated_at = ?2 WHERE id = ?1",
            params![id, now()],
        )?;
        let deleted_messages =
            transaction.execute("DELETE FROM messages WHERE session_id = ?1", [id])?;
        transaction.commit()?;
        drop(connection);
        let session = self
            .session(id)?
            .ok_or_else(|| StoreError::Sql(rusqlite::Error::QueryReturnedNoRows))?;
        Ok(Some((session, deleted_messages, cleared_engine_session_id)))
    }

    /// Lists sessions for one project and engine, newest first.
    pub fn sessions_for_engine(
        &self,
        project_id: &str,
        engine: EngineName,
    ) -> Result<Vec<AgentSession>, StoreError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, project_id, engine_name, engine_session_id, name, model, permission_mode,
                        allow_dangerously_skip_permissions, system_prompt_config, options_config,
                        management_info, created_at, updated_at FROM sessions
                        WHERE project_id = ?1 AND engine_name = ?2 ORDER BY updated_at DESC",
        )?;
        statement
            .query_map(params![project_id, engine.as_str()], session_from_row)?
            .collect::<Result<_, _>>()
            .map_err(StoreError::from)
    }
    /// Persists a provider-native session identifier and management metadata.
    pub fn update_provider_session(
        &self,
        id: &str,
        engine_session_id: &str,
        management_info: &Value,
    ) -> Result<(), StoreError> {
        self.connection()?.execute(
            "UPDATE sessions SET engine_session_id = ?2, management_info = ?3, updated_at = ?4 WHERE id = ?1",
            params![id, engine_session_id, management_info_with_timestamp(management_info)?, now()],
        )?;
        Ok(())
    }

    /// Persists provider management metadata without changing its session identifier.
    pub fn update_management_info(
        &self,
        id: &str,
        management_info: &Value,
    ) -> Result<(), StoreError> {
        self.connection()?.execute(
            "UPDATE sessions SET management_info = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, management_info_with_timestamp(management_info)?, now()],
        )?;
        Ok(())
    }

    /// Writes one durable transcript message with a generated ID and current timestamp.
    pub fn create_message(
        &self,
        input: CreateMessage<'_>,
    ) -> Result<AgentStoredMessage, StoreError> {
        self.upsert_message(AgentStoredMessage {
            id: Uuid::new_v4().to_string(),
            project_id: input.project_id.to_owned(),
            session_id: input.session_id.to_owned(),
            conversation_id: None,
            role: input.role.to_owned(),
            content: input.content.to_owned(),
            message_type: input.message_type.to_owned(),
            metadata: input.metadata.cloned(),
            cli_source: input.cli_source.map(ToOwned::to_owned),
            request_id: input.request_id.map(ToOwned::to_owned),
            created_at: now(),
        })
    }

    /// Stores a route-supplied message identity, replacing an existing message of that identity.
    pub fn upsert_message(
        &self,
        message: AgentStoredMessage,
    ) -> Result<AgentStoredMessage, StoreError> {
        self.connection()?.execute(
            "INSERT INTO messages (id, project_id, session_id, conversation_id, role, content, message_type,
             metadata, cli_source, request_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(id) DO UPDATE SET role = excluded.role, message_type = excluded.message_type,
             content = excluded.content, metadata = excluded.metadata, session_id = excluded.session_id,
             conversation_id = excluded.conversation_id, cli_source = excluded.cli_source,
             request_id = excluded.request_id",
            params![
                message.id,
                message.project_id,
                message.session_id,
                message.conversation_id,
                message.role,
                message.content,
                message.message_type,
                json_column(message.metadata.as_ref())?,
                message.cli_source,
                message.request_id,
                message.created_at,
            ],
        )?;
        Ok(message)
    }
    /// Replaces a persisted message's opaque metadata after dependent files are written.
    pub fn update_message_metadata(
        &self,
        id: &str,
        metadata: Option<&Value>,
    ) -> Result<(), StoreError> {
        self.connection()?.execute(
            "UPDATE messages SET metadata = ?2 WHERE id = ?1",
            params![id, json_column(metadata)?],
        )?;
        Ok(())
    }

    /// Lists project messages oldest first with offset pagination.
    pub fn project_messages(
        &self,
        project_id: &str,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<AgentStoredMessage>, StoreError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare("SELECT id, project_id, session_id, conversation_id, role, content, message_type,
             metadata, cli_source, request_id, created_at FROM messages WHERE project_id = ?1 ORDER BY created_at ASC LIMIT ?2 OFFSET ?3")?;
        statement
            .query_map(params![project_id, limit, offset], message_from_row)?
            .collect::<Result<_, _>>()
            .map_err(StoreError::from)
    }

    /// Lists a session transcript oldest first; zero limit means unbounded.
    pub fn session_messages(
        &self,
        session_id: &str,
        limit: Option<usize>,
        offset: usize,
    ) -> Result<Vec<AgentStoredMessage>, StoreError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare("SELECT id, project_id, session_id, conversation_id, role, content, message_type,
             metadata, cli_source, request_id, created_at FROM messages WHERE session_id = ?1 ORDER BY created_at ASC LIMIT ?2 OFFSET ?3")?;
        let bound = i64::try_from(limit.unwrap_or(usize::MAX)).unwrap_or(-1);
        statement
            .query_map(params![session_id, bound, offset], message_from_row)?
            .collect::<Result<_, _>>()
            .map_err(StoreError::from)
    }

    /// Counts project messages.
    pub fn project_message_count(&self, project_id: &str) -> Result<u64, StoreError> {
        self.count("project_id", project_id)
    }

    /// Counts session messages.
    pub fn session_message_count(&self, session_id: &str) -> Result<u64, StoreError> {
        self.count("session_id", session_id)
    }

    /// Deletes project messages, optionally restricted to a conversation.
    pub fn delete_project_messages(
        &self,
        project_id: &str,
        conversation_id: Option<&str>,
    ) -> Result<usize, StoreError> {
        let changed = match conversation_id {
            Some(conversation_id) => self.connection()?.execute(
                "DELETE FROM messages WHERE project_id = ?1 AND conversation_id = ?2",
                params![project_id, conversation_id],
            )?,
            None => self
                .connection()?
                .execute("DELETE FROM messages WHERE project_id = ?1", [project_id])?,
        };
        Ok(changed)
    }

    /// Deletes every message associated with a session.
    pub fn delete_session_messages(&self, session_id: &str) -> Result<usize, StoreError> {
        Ok(self
            .connection()?
            .execute("DELETE FROM messages WHERE session_id = ?1", [session_id])?)
    }

    fn count(&self, column: &str, value: &str) -> Result<u64, StoreError> {
        let statement = match column {
            "project_id" => "SELECT COUNT(*) FROM messages WHERE project_id = ?1",
            "session_id" => "SELECT COUNT(*) FROM messages WHERE session_id = ?1",
            _ => unreachable!("fixed internal column"),
        };
        self.connection()?
            .query_row(statement, [value], |row| row.get(0))
            .map_err(StoreError::from)
    }

    fn connection(&self) -> Result<MutexGuard<'_, Connection>, StoreError> {
        self.connection.lock().map_err(|_| StoreError::Lock)
    }
}

fn project_from_row(row: &Row<'_>) -> rusqlite::Result<AgentProject> {
    Ok(AgentProject {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        root_path: row.get(3)?,
        preferred_cli: parse_engine(row.get::<_, Option<String>>(4)?),
        selected_model: row.get(5)?,
        active_claude_session_id: row.get(6)?,
        use_ccr: Some(parse_bool(row.get(7)?).unwrap_or(false)),
        enable_human_chrome: Some(row.get::<_, Option<String>>(8)?.as_deref() != Some("0")),
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        last_active_at: row.get(11)?,
    })
}

fn session_from_row(row: &Row<'_>) -> rusqlite::Result<AgentSession> {
    Ok(AgentSession {
        id: row.get(0)?,
        project_id: row.get(1)?,
        engine_name: parse_engine(row.get::<_, Option<String>>(2)?).ok_or_else(|| {
            rusqlite::Error::InvalidColumnType(
                2,
                "engine_name".to_owned(),
                rusqlite::types::Type::Text,
            )
        })?,
        engine_session_id: row.get(3)?,
        name: row.get(4)?,
        model: row.get(5)?,
        permission_mode: row.get(6)?,
        allow_dangerously_skip_permissions: parse_bool(row.get(7)?).unwrap_or(false),
        system_prompt_config: parse_json(row.get(8)?),
        options_config: parse_json(row.get(9)?),
        management_info: parse_json(row.get(10)?),
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
        preview: None,
        preview_meta: None,
    })
}

fn message_from_row(row: &Row<'_>) -> rusqlite::Result<AgentStoredMessage> {
    Ok(AgentStoredMessage {
        id: row.get(0)?,
        project_id: row.get(1)?,
        session_id: row.get(2)?,
        conversation_id: row.get(3)?,
        role: row.get(4)?,
        content: row.get(5)?,
        message_type: row.get(6)?,
        metadata: parse_json(row.get(7)?),
        cli_source: row.get(8)?,
        request_id: row.get(9)?,
        created_at: row.get(10)?,
    })
}

fn parse_engine(value: Option<String>) -> Option<EngineName> {
    match value.as_deref() {
        Some("claude") => Some(EngineName::Claude),
        Some("codex") => Some(EngineName::Codex),
        Some("cursor") => Some(EngineName::Cursor),
        Some("qwen") => Some(EngineName::Qwen),
        Some("glm") => Some(EngineName::Glm),
        _ => None,
    }
}
fn parse_bool(value: Option<String>) -> Option<bool> {
    value.map(|value| value == "1")
}
fn parse_json(value: Option<String>) -> Option<Value> {
    value.and_then(|value| serde_json::from_str(&value).ok())
}
fn json_column(value: Option<&Value>) -> Result<Option<String>, StoreError> {
    value
        .map(serde_json::to_string)
        .transpose()
        .map_err(StoreError::from)
}
fn management_info_with_timestamp(value: &Value) -> Result<String, StoreError> {
    let mut info = value.as_object().cloned().unwrap_or_default();
    info.insert("lastUpdated".to_owned(), Value::String(now()));
    serde_json::to_string(&Value::Object(info)).map_err(StoreError::from)
}
fn true_column(value: Option<bool>) -> Option<&'static str> {
    value.and_then(|value| value.then_some("1"))
}
fn enabled_column(value: Option<bool>) -> Option<&'static str> {
    value.map(|value| if value { "1" } else { "0" })
}
fn nonempty(value: Option<String>) -> Option<String> {
    value.and_then(|value| (!value.trim().is_empty()).then(|| value.trim().to_owned()))
}

fn truncate_preview(value: &str, limit: usize) -> String {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut characters = normalized.chars();
    let preview: String = characters.by_ref().take(limit).collect();
    if characters.next().is_some() {
        let mut truncated: String = preview.chars().take(limit.saturating_sub(1)).collect();
        truncated.push('…');
        return truncated;
    }
    preview
}
fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn make_absolute(path: &Path) -> Result<PathBuf, StoreError> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            std::path::Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            std::path::Component::RootDir => normalized.push(component.as_os_str()),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            std::path::Component::Normal(part) => normalized.push(part),
        }
    }
    Ok(normalized)
}
fn invalid_path(message: &str, absolute: PathBuf) -> PathValidation {
    PathValidation {
        valid: false,
        absolute: absolute.display().to_string(),
        exists: false,
        needs_creation: false,
        error: Some(message.to_owned()),
    }
}

/// Applies the TypeScript store's additive project-column upgrades to a reopened legacy database.
fn migrate_schema(connection: &Connection) -> Result<(), StoreError> {
    if !column_exists(connection, "projects", "active_claude_session_id")? {
        connection
            .execute_batch("ALTER TABLE projects ADD COLUMN active_claude_session_id TEXT")?;
    }
    if !column_exists(connection, "projects", "use_ccr")? {
        connection.execute_batch("ALTER TABLE projects ADD COLUMN use_ccr TEXT")?;
    }
    if !column_exists(connection, "projects", "enable_humanchrome")? {
        if column_exists(connection, "projects", "enable_chrome_mcp")? {
            connection.execute_batch(
                "ALTER TABLE projects RENAME COLUMN enable_chrome_mcp TO enable_humanchrome",
            )?;
        } else {
            connection.execute_batch(
                "ALTER TABLE projects ADD COLUMN enable_humanchrome TEXT NOT NULL DEFAULT '1'",
            )?;
        }
    }
    Ok(())
}

fn column_exists(connection: &Connection, table: &str, column: &str) -> Result<bool, StoreError> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
    Ok(columns.filter_map(Result::ok).any(|name| name == column))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn store() -> (tempfile::TempDir, AgentStore) {
        let directory = tempdir().expect("temp directory");
        let workspaces = directory.path().join("workspaces");
        fs::create_dir(&workspaces).expect("workspace root");
        let store =
            AgentStore::open(directory.path().join("agent.db"), [workspaces]).expect("store");
        (directory, store)
    }

    #[test]
    fn project_creation_requires_explicit_directory_authorization() {
        let (directory, store) = store();
        let root = directory.path().join("workspaces/new-project");
        let error = store
            .upsert_project(CreateProjectInput {
                id: None,
                name: "new".into(),
                description: None,
                root_path: root.display().to_string(),
                preferred_cli: None,
                selected_model: None,
                use_ccr: None,
                enable_human_chrome: None,
                allow_create: None,
            })
            .expect_err("missing root rejected");
        assert!(error.to_string().contains("Use the validate-path API"));
        let project = store
            .upsert_project(CreateProjectInput {
                id: None,
                name: "new".into(),
                description: None,
                root_path: root.display().to_string(),
                preferred_cli: Some(EngineName::Codex),
                selected_model: None,
                use_ccr: None,
                enable_human_chrome: None,
                allow_create: Some(true),
            })
            .expect("creates authorized root");
        assert!(root.is_dir());
        assert_eq!(project.preferred_cli, Some(EngineName::Codex));
    }

    #[test]
    fn project_delete_cascades_sessions_and_messages() {
        let (directory, store) = store();
        let root = directory.path().join("workspaces/project");
        let project = store
            .upsert_project(CreateProjectInput {
                id: None,
                name: "project".into(),
                description: None,
                root_path: root.display().to_string(),
                preferred_cli: None,
                selected_model: None,
                use_ccr: None,
                enable_human_chrome: None,
                allow_create: Some(true),
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
        store
            .create_message(CreateMessage {
                project_id: &project.id,
                session_id: &session.id,
                role: "user",
                content: "hello",
                message_type: "chat",
                metadata: None,
                cli_source: None,
                request_id: None,
            })
            .expect("message");
        store.delete_project(&project.id).expect("delete project");
        assert!(store.session(&session.id).expect("lookup").is_none());
        assert_eq!(store.project_message_count(&project.id).expect("count"), 0);
    }
}
