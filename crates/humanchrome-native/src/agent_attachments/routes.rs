//! Composable Axum routes for attachment statistics, serving, and cleanup.

use std::{collections::BTreeMap, sync::Arc};

use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{delete, get},
};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::{
    AttachmentCleanupResult, AttachmentError, AttachmentProjectStats, AttachmentStats,
    AttachmentStore, CleanupProjectResult, ext_to_mime_type,
};

/// Supplies persisted project names to the statistics route without coupling it to a database.
pub trait AttachmentProjectSource: Send + Sync + 'static {
    /// Returns the current project ID-to-display-name map.
    fn project_names(&self) -> Result<BTreeMap<String, String>, String>;
}

impl<F> AttachmentProjectSource for F
where
    F: Fn() -> Result<BTreeMap<String, String>, String> + Send + Sync + 'static,
{
    fn project_names(&self) -> Result<BTreeMap<String, String>, String> {
        self()
    }
}

/// Builds attachment routes with no project catalog; all stat rows are reported as orphaned.
pub fn attachment_router(store: AttachmentStore) -> Router {
    attachment_router_with_projects(
        store,
        Arc::new(|| Ok::<BTreeMap<String, String>, String>(BTreeMap::new())),
    )
}

/// Builds attachment routes with an injected live project catalog for statistics enrichment.
pub fn attachment_router_with_projects(
    store: AttachmentStore,
    projects: Arc<dyn AttachmentProjectSource>,
) -> Router {
    Router::new()
        .route("/agent/attachments/stats", get(stats))
        .route("/agent/attachments/{project_id}/{filename}", get(serve))
        .route("/agent/attachments/{project_id}", delete(cleanup_project))
        .route("/agent/attachments", delete(cleanup))
        .with_state(AttachmentRouteState { store, projects })
}

impl AttachmentStore {
    /// Builds standalone attachment routes without a project catalog.
    pub fn router(self) -> Router {
        attachment_router(self)
    }

    /// Builds routes enriched from an injected live project catalog.
    pub fn router_with_projects(self, projects: Arc<dyn AttachmentProjectSource>) -> Router {
        attachment_router_with_projects(self, projects)
    }
}

#[derive(Clone)]
struct AttachmentRouteState {
    store: AttachmentStore,
    projects: Arc<dyn AttachmentProjectSource>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentStatsResponse {
    success: bool,
    root_dir: String,
    total_files: u64,
    total_bytes: u64,
    projects: Vec<EnrichedProjectStats>,
    orphan_project_ids: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EnrichedProjectStats {
    project_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_name: Option<String>,
    dir_path: String,
    exists: bool,
    file_count: u64,
    total_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_modified_at: Option<String>,
    exists_in_db: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentCleanupRequest {
    project_ids: Option<Vec<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentCleanupResponse {
    success: bool,
    scope: &'static str,
    removed_files: u64,
    removed_bytes: u64,
    results: Vec<CleanupProjectResult>,
}

async fn stats(
    State(state): State<AttachmentRouteState>,
) -> Result<Json<AttachmentStatsResponse>, AttachmentRouteError> {
    let statistics = state
        .store
        .stats()
        .await
        .map_err(AttachmentRouteError::stats)?;
    let projects = state.projects.clone();
    let project_names = tokio::task::spawn_blocking(move || projects.project_names())
        .await
        .map_err(|error| AttachmentRouteError::project_source(error.to_string()))?
        .map_err(AttachmentRouteError::project_source)?;
    Ok(Json(enrich_stats(statistics, project_names)))
}

async fn serve(
    State(state): State<AttachmentRouteState>,
    Path((project_id, filename)): Path<(String, String)>,
) -> Result<Response, AttachmentRouteError> {
    let body = state
        .store
        .read(&project_id, &filename)
        .await
        .map_err(AttachmentRouteError::read)?;
    let extension = filename
        .rsplit_once('.')
        .map_or("", |(_, extension)| extension);
    let content_type = ext_to_mime_type(extension).unwrap_or("application/octet-stream");
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=31536000, immutable"),
    );
    Ok((headers, body).into_response())
}

async fn cleanup_project(
    State(state): State<AttachmentRouteState>,
    Path(project_id): Path<String>,
) -> Result<Json<AttachmentCleanupResponse>, AttachmentRouteError> {
    let result = state
        .store
        .cleanup(Some(&[project_id]))
        .await
        .map_err(AttachmentRouteError::cleanup)?;
    Ok(Json(cleanup_response(result, "project")))
}

async fn cleanup(
    State(state): State<AttachmentRouteState>,
    body: Option<Json<AttachmentCleanupRequest>>,
) -> Result<Json<AttachmentCleanupResponse>, AttachmentRouteError> {
    let project_ids = body.and_then(|Json(body)| body.project_ids);
    let scope = if project_ids.as_ref().is_some_and(|ids| !ids.is_empty()) {
        "selected"
    } else {
        "all"
    };
    let result = state
        .store
        .cleanup(project_ids.as_deref())
        .await
        .map_err(AttachmentRouteError::cleanup)?;
    Ok(Json(cleanup_response(result, scope)))
}

fn enrich_stats(
    statistics: AttachmentStats,
    project_names: BTreeMap<String, String>,
) -> AttachmentStatsResponse {
    let mut orphan_project_ids = Vec::new();
    let projects = statistics
        .projects
        .into_iter()
        .map(|project| {
            let project_name = project_names.get(&project.project_id).cloned();
            let exists_in_db = project_name.is_some();
            if !exists_in_db {
                orphan_project_ids.push(project.project_id.clone());
            }
            enriched_project_stats(project, project_name, exists_in_db)
        })
        .collect();
    AttachmentStatsResponse {
        success: true,
        root_dir: statistics.root_dir.display().to_string(),
        total_files: statistics.total_files,
        total_bytes: statistics.total_bytes,
        projects,
        orphan_project_ids,
    }
}

fn enriched_project_stats(
    project: AttachmentProjectStats,
    project_name: Option<String>,
    exists_in_db: bool,
) -> EnrichedProjectStats {
    EnrichedProjectStats {
        project_id: project.project_id,
        project_name,
        dir_path: project.dir_path.display().to_string(),
        exists: project.exists,
        file_count: project.file_count,
        total_bytes: project.total_bytes,
        last_modified_at: project.last_modified_at,
        exists_in_db,
    }
}

fn cleanup_response(
    result: AttachmentCleanupResult,
    scope: &'static str,
) -> AttachmentCleanupResponse {
    AttachmentCleanupResponse {
        success: true,
        scope,
        removed_files: result.removed_files,
        removed_bytes: result.removed_bytes,
        results: result.results,
    }
}

#[derive(Debug)]
struct AttachmentRouteError {
    status: StatusCode,
    message: String,
}

impl AttachmentRouteError {
    fn stats(error: AttachmentError) -> Self {
        tracing::error!(error = %error, "failed to read attachment statistics");
        Self::internal()
    }

    fn project_source(error: String) -> Self {
        tracing::error!(
            error,
            "failed to list projects while reading attachment statistics"
        );
        Self::internal()
    }

    fn read(error: AttachmentError) -> Self {
        match error {
            AttachmentError::InvalidIdentifier { .. } | AttachmentError::InvalidFilename(_) => {
                Self {
                    status: StatusCode::BAD_REQUEST,
                    message: error.to_string(),
                }
            }
            AttachmentError::Io(error) if error.kind() == std::io::ErrorKind::NotFound => Self {
                status: StatusCode::NOT_FOUND,
                message: "Attachment not found".to_owned(),
            },
            AttachmentError::AttachmentSymlink => Self {
                status: StatusCode::NOT_FOUND,
                message: "Attachment not found".to_owned(),
            },
            error => {
                tracing::warn!(error = %error, "failed to read attachment");
                Self::internal()
            }
        }
    }

    fn cleanup(error: AttachmentError) -> Self {
        tracing::error!(error = %error, "failed to clean attachments");
        Self::internal()
    }

    fn internal() -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: "Internal server error".to_owned(),
        }
    }
}

impl IntoResponse for AttachmentRouteError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.message }))).into_response()
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    #[test]
    fn enriches_stats_and_marks_orphaned_project_directories() {
        let response = enrich_stats(
            AttachmentStats {
                root_dir: PathBuf::from("/temporary/attachments"),
                total_files: 2,
                total_bytes: 42,
                projects: vec![
                    AttachmentProjectStats {
                        project_id: "known".to_owned(),
                        dir_path: PathBuf::from("/temporary/attachments/known"),
                        exists: true,
                        file_count: 1,
                        total_bytes: 12,
                        last_modified_at: None,
                    },
                    AttachmentProjectStats {
                        project_id: "orphan".to_owned(),
                        dir_path: PathBuf::from("/temporary/attachments/orphan"),
                        exists: true,
                        file_count: 1,
                        total_bytes: 30,
                        last_modified_at: None,
                    },
                ],
            },
            BTreeMap::from([("known".to_owned(), "Known project".to_owned())]),
        );
        assert_eq!(
            response.projects[0].project_name.as_deref(),
            Some("Known project")
        );
        assert!(response.projects[0].exists_in_db);
        assert_eq!(response.orphan_project_ids, vec!["orphan"]);
    }

    #[test]
    fn unsafe_read_paths_are_client_errors_and_missing_files_are_not_found() {
        let unsafe_path =
            AttachmentRouteError::read(AttachmentError::InvalidFilename("../secret".to_owned()));
        assert_eq!(unsafe_path.status, StatusCode::BAD_REQUEST);
        let missing = AttachmentRouteError::read(AttachmentError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "missing",
        )));
        assert_eq!(missing.status, StatusCode::NOT_FOUND);
    }
}
