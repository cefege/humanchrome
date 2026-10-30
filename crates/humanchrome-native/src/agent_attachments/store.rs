//! Filesystem-backed, validated persistence for agent image attachments.

use std::{
    io,
    path::{Path, PathBuf},
    time::SystemTime,
};

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use serde_json::Value;
use thiserror::Error;
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use crate::{agent::AgentAttachment, file_ops::storage::decode_node_base64};

const MAX_FILENAME_ATTEMPTS: usize = 3;

/// Failures returned while validating or operating on persistent attachments.
#[derive(Debug, Error)]
pub enum AttachmentError {
    /// A caller supplied a project or message identity that cannot form a safe path component.
    #[error("Invalid {field}: {value}")]
    InvalidIdentifier { field: &'static str, value: String },
    /// A caller supplied a filename outside the generated attachment filename grammar.
    #[error("Invalid filename: {0}")]
    InvalidFilename(String),
    /// Only image attachments are persisted by this service.
    #[error("unsupported attachment type: {0}")]
    UnsupportedType(String),
    /// An image MIME type is not accepted by the attachment contract.
    #[error("unsupported MIME type: {0}")]
    UnsupportedMimeType(String),
    /// The target project directory is a symbolic link rather than owned attachment storage.
    #[error("attachment project directory is a symbolic link")]
    ProjectDirectorySymlink,
    /// The target attachment is a symbolic link rather than a regular persisted file.
    #[error("attachment file is a symbolic link")]
    AttachmentSymlink,
    /// A filesystem operation failed.
    #[error("attachment filesystem operation failed: {0}")]
    Io(#[from] io::Error),
    /// The metadata response could not be serialized.
    #[error("attachment metadata serialization failed: {0}")]
    Metadata(#[from] serde_json::Error),
}

/// Metadata retained in a persisted message and exposed by the attachments API.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentMetadata {
    /// Schema version reserved for additive metadata evolution.
    pub version: u8,
    /// Persisted attachment kind.
    pub kind: String,
    /// Owning project identity.
    pub project_id: String,
    /// Message receiving the image.
    pub message_id: String,
    /// Attachment position in that message.
    pub index: usize,
    /// Generated filename under the project's attachment directory.
    pub filename: String,
    /// Relative HTTP URL for serving this image.
    pub url_path: String,
    /// Validated media type.
    pub mime_type: String,
    /// Decoded byte count.
    pub size_bytes: usize,
    /// Caller-supplied presentation name, never used for a filesystem path.
    pub original_name: String,
    /// RFC 3339 creation instant.
    pub created_at: String,
}

/// A saved attachment's provider path and message metadata.
#[derive(Clone, Debug)]
pub struct SavedAttachment {
    /// Absolute file path for a provider process.
    pub absolute_path: PathBuf,
    /// Generated filename under the project attachment directory.
    pub filename: String,
    /// JSON metadata ready for a stored message's metadata object.
    pub metadata: Value,
}

/// Aggregated persistent attachment statistics.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentStats {
    /// Absolute root containing all project attachment directories.
    pub root_dir: PathBuf,
    /// Count of regular attachment files.
    pub total_files: u64,
    /// Sum of regular attachment file sizes.
    pub total_bytes: u64,
    /// Statistics for each safely readable project directory.
    pub projects: Vec<AttachmentProjectStats>,
}

/// Statistics for one project attachment directory.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentProjectStats {
    /// Project identity.
    pub project_id: String,
    /// Filesystem directory path.
    pub dir_path: PathBuf,
    /// Whether the directory existed when inspected.
    pub exists: bool,
    /// Count of regular files directly under the directory.
    pub file_count: u64,
    /// Sum of direct regular-file byte sizes.
    pub total_bytes: u64,
    /// Most recent direct regular-file modification instant.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_modified_at: Option<String>,
}

/// Cleanup outcome for one requested project.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupProjectResult {
    /// Project identity.
    pub project_id: String,
    /// Filesystem directory path.
    pub dir_path: PathBuf,
    /// Whether the directory existed before cleanup.
    pub existed: bool,
    /// Number of regular files removed.
    pub removed_files: u64,
    /// Bytes in regular files removed.
    pub removed_bytes: u64,
}

/// Aggregate attachment cleanup outcome.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentCleanupResult {
    /// Attachment root directory.
    pub root_dir: PathBuf,
    /// Total regular files removed.
    pub removed_files: u64,
    /// Total regular-file bytes removed.
    pub removed_bytes: u64,
    /// Per-project cleanup outcomes.
    pub results: Vec<CleanupProjectResult>,
}

/// Validated filesystem root for persisted agent attachments.
#[derive(Clone, Debug)]
pub struct AttachmentStore {
    root_dir: PathBuf,
}

impl AttachmentStore {
    /// Creates an attachment store rooted at `data_dir/attachments` without touching the filesystem.
    #[must_use]
    pub fn open(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            root_dir: data_dir.into().join("attachments"),
        }
    }

    /// Creates a store at an explicit attachments root for isolated tests and explicit embedding.
    #[must_use]
    pub fn with_root(root_dir: impl Into<PathBuf>) -> Self {
        Self {
            root_dir: root_dir.into(),
        }
    }

    /// Returns the absolute configured attachment root.
    #[must_use]
    pub fn root_dir(&self) -> &Path {
        &self.root_dir
    }

    /// Returns a project attachment directory after validating its path component.
    ///
    /// # Errors
    /// Returns [`AttachmentError::InvalidIdentifier`] when `project_id` is unsafe.
    pub fn project_dir(&self, project_id: &str) -> Result<PathBuf, AttachmentError> {
        validate_identifier("projectId", project_id)?;
        Ok(self.root_dir.join(project_id))
    }

    /// Returns a generated attachment file path after validating all public path components.
    ///
    /// # Errors
    /// Returns a validation error when either path component is unsafe.
    pub fn attachment_path(
        &self,
        project_id: &str,
        filename: &str,
    ) -> Result<PathBuf, AttachmentError> {
        validate_filename(filename)?;
        Ok(self.project_dir(project_id)?.join(filename))
    }

    /// Persists one validated image attachment and returns its provider path plus durable metadata.
    ///
    /// The caller's original filename is intentionally metadata only; no caller-controlled name
    /// is ever used to construct a filesystem path.
    ///
    /// # Errors
    /// Returns a validation error for unsupported data or a filesystem error while persisting it.
    pub async fn save(
        &self,
        project_id: &str,
        message_id: &str,
        attachment: &AgentAttachment,
        index: usize,
    ) -> Result<SavedAttachment, AttachmentError> {
        validate_identifier("projectId", project_id)?;
        validate_identifier("messageId", message_id)?;
        if attachment.r#type != "image" {
            return Err(AttachmentError::UnsupportedType(attachment.r#type.clone()));
        }
        if !is_allowed_mime_type(&attachment.mime_type) {
            return Err(AttachmentError::UnsupportedMimeType(
                attachment.mime_type.clone(),
            ));
        }
        let bytes = decode_node_base64(&attachment.data_base64);

        let project_dir = self.project_dir(project_id)?;
        tokio::fs::create_dir_all(&project_dir).await?;
        reject_symlink_directory(&project_dir).await?;

        for _ in 0..MAX_FILENAME_ATTEMPTS {
            let filename = build_attachment_filename(message_id, index, &attachment.mime_type);
            let absolute_path = project_dir.join(&filename);
            match write_new_file(&absolute_path, &bytes).await {
                Ok(()) => {
                    let metadata = AttachmentMetadata {
                        version: 1,
                        kind: "image".to_owned(),
                        project_id: project_id.to_owned(),
                        message_id: message_id.to_owned(),
                        index,
                        filename: filename.clone(),
                        url_path: format!("/agent/attachments/{project_id}/{filename}"),
                        mime_type: attachment.mime_type.clone(),
                        size_bytes: bytes.len(),
                        original_name: attachment.name.clone(),
                        created_at: now(),
                    };
                    return Ok(SavedAttachment {
                        absolute_path,
                        filename,
                        metadata: serde_json::to_value(metadata)?,
                    });
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(AttachmentError::Io(error)),
            }
        }
        Err(AttachmentError::Io(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "could not reserve a unique attachment filename",
        )))
    }

    /// Returns whether a validated regular attachment file exists.
    pub async fn exists(&self, project_id: &str, filename: &str) -> Result<bool, AttachmentError> {
        let path = self.attachment_path(project_id, filename)?;
        match tokio::fs::symlink_metadata(path).await {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                Err(AttachmentError::AttachmentSymlink)
            }
            Ok(metadata) => Ok(metadata.is_file()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(AttachmentError::Io(error)),
        }
    }

    /// Reads one validated regular attachment file for local HTTP serving.
    ///
    /// # Errors
    /// Returns a validation error for unsafe paths, or an I/O error when the file is unavailable.
    pub async fn read(&self, project_id: &str, filename: &str) -> Result<Vec<u8>, AttachmentError> {
        let path = self.attachment_path(project_id, filename)?;
        let metadata = tokio::fs::symlink_metadata(&path).await?;
        if metadata.file_type().is_symlink() {
            return Err(AttachmentError::AttachmentSymlink);
        }
        if !metadata.is_file() {
            return Err(AttachmentError::Io(io::Error::new(
                io::ErrorKind::NotFound,
                "attachment is not a regular file",
            )));
        }
        Ok(tokio::fs::read(path).await?)
    }

    /// Summarizes safely readable direct files beneath every project attachment directory.
    pub async fn stats(&self) -> Result<AttachmentStats, AttachmentError> {
        let mut projects = Vec::new();
        let mut total_files = 0;
        let mut total_bytes = 0;
        let mut entries = match tokio::fs::read_dir(&self.root_dir).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(AttachmentStats {
                    root_dir: self.root_dir.clone(),
                    total_files,
                    total_bytes,
                    projects,
                });
            }
            Err(error) => return Err(AttachmentError::Io(error)),
        };

        while let Some(entry) = entries.next_entry().await? {
            let file_type = entry.file_type().await?;
            if !file_type.is_dir() || file_type.is_symlink() {
                continue;
            }
            let project_id = entry.file_name().to_string_lossy().into_owned();
            if !is_valid_identifier(&project_id) {
                continue;
            }
            let project_stats = self.project_stats(&project_id).await?;
            total_files += project_stats.file_count;
            total_bytes += project_stats.total_bytes;
            projects.push(project_stats);
        }
        projects.sort_by(|left, right| left.project_id.cmp(&right.project_id));
        Ok(AttachmentStats {
            root_dir: self.root_dir.clone(),
            total_files,
            total_bytes,
            projects,
        })
    }

    /// Removes attachments for selected projects or every valid direct project directory.
    ///
    /// # Errors
    /// Returns filesystem errors without reporting a successful cleanup for a partially removed project.
    pub async fn cleanup(
        &self,
        project_ids: Option<&[String]>,
    ) -> Result<AttachmentCleanupResult, AttachmentError> {
        let project_ids = match project_ids.filter(|ids| !ids.is_empty()) {
            Some(ids) => ids.to_vec(),
            None => self.project_ids().await?,
        };
        let mut result = AttachmentCleanupResult {
            root_dir: self.root_dir.clone(),
            removed_files: 0,
            removed_bytes: 0,
            results: Vec::with_capacity(project_ids.len()),
        };
        for project_id in project_ids {
            if !is_valid_identifier(&project_id) {
                continue;
            }
            let project_result = self.cleanup_project(&project_id).await?;
            result.removed_files += project_result.removed_files;
            result.removed_bytes += project_result.removed_bytes;
            result.results.push(project_result);
        }
        Ok(result)
    }

    async fn project_ids(&self) -> Result<Vec<String>, AttachmentError> {
        let mut entries = match tokio::fs::read_dir(&self.root_dir).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(AttachmentError::Io(error)),
        };
        let mut ids = Vec::new();
        while let Some(entry) = entries.next_entry().await? {
            let file_type = entry.file_type().await?;
            let id = entry.file_name().to_string_lossy().into_owned();
            if file_type.is_dir() && !file_type.is_symlink() && is_valid_identifier(&id) {
                ids.push(id);
            }
        }
        ids.sort();
        Ok(ids)
    }

    async fn project_stats(
        &self,
        project_id: &str,
    ) -> Result<AttachmentProjectStats, AttachmentError> {
        let dir_path = self.project_dir(project_id)?;
        let mut file_count = 0;
        let mut total_bytes = 0;
        let mut last_modified: Option<SystemTime> = None;
        let mut entries = match tokio::fs::read_dir(&dir_path).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(AttachmentProjectStats {
                    project_id: project_id.to_owned(),
                    dir_path,
                    exists: false,
                    file_count,
                    total_bytes,
                    last_modified_at: None,
                });
            }
            Err(error) => return Err(AttachmentError::Io(error)),
        };
        while let Some(entry) = entries.next_entry().await? {
            let file_type = entry.file_type().await?;
            if !file_type.is_file() || file_type.is_symlink() {
                continue;
            }
            let metadata = match entry.metadata().await {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(AttachmentError::Io(error)),
            };
            file_count += 1;
            total_bytes += metadata.len();
            if let Ok(modified) = metadata.modified()
                && last_modified.is_none_or(|latest| modified > latest)
            {
                last_modified = Some(modified);
            }
        }
        Ok(AttachmentProjectStats {
            project_id: project_id.to_owned(),
            dir_path,
            exists: true,
            file_count,
            total_bytes,
            last_modified_at: last_modified.map(format_system_time),
        })
    }

    async fn cleanup_project(
        &self,
        project_id: &str,
    ) -> Result<CleanupProjectResult, AttachmentError> {
        let dir_path = self.project_dir(project_id)?;
        let metadata = match tokio::fs::symlink_metadata(&dir_path).await {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(CleanupProjectResult {
                    project_id: project_id.to_owned(),
                    dir_path,
                    existed: false,
                    removed_files: 0,
                    removed_bytes: 0,
                });
            }
            Err(error) => return Err(AttachmentError::Io(error)),
        };
        if metadata.file_type().is_symlink() {
            return Err(AttachmentError::ProjectDirectorySymlink);
        }
        if !metadata.is_dir() {
            return Ok(CleanupProjectResult {
                project_id: project_id.to_owned(),
                dir_path,
                existed: false,
                removed_files: 0,
                removed_bytes: 0,
            });
        }
        let stats = self.project_stats(project_id).await?;
        tokio::fs::remove_dir_all(&dir_path).await?;
        Ok(CleanupProjectResult {
            project_id: project_id.to_owned(),
            dir_path,
            existed: true,
            removed_files: stats.file_count,
            removed_bytes: stats.total_bytes,
        })
    }
}

/// Converts a supported MIME type to its canonical persisted extension.
#[must_use]
pub fn mime_type_to_ext(mime_type: &str) -> &'static str {
    match mime_type {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "bin",
    }
}

/// Converts a supported persisted extension to its MIME type.
#[must_use]
pub fn ext_to_mime_type(extension: &str) -> Option<&'static str> {
    match extension.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

fn is_allowed_mime_type(mime_type: &str) -> bool {
    matches!(
        mime_type,
        "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    )
}

fn build_attachment_filename(message_id: &str, index: usize, mime_type: &str) -> String {
    let uuid = Uuid::new_v4().simple().to_string();
    format!(
        "{message_id}-{index}-{}.{}",
        &uuid[..8],
        mime_type_to_ext(mime_type)
    )
}

fn validate_identifier(field: &'static str, value: &str) -> Result<(), AttachmentError> {
    if is_valid_identifier(value) {
        Ok(())
    } else {
        Err(AttachmentError::InvalidIdentifier {
            field,
            value: value.to_owned(),
        })
    }
}

fn is_valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn validate_filename(filename: &str) -> Result<(), AttachmentError> {
    let Some((stem, extension)) = filename.rsplit_once('.') else {
        return Err(AttachmentError::InvalidFilename(filename.to_owned()));
    };
    if stem.is_empty()
        || extension.is_empty()
        || !stem
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        || !extension.bytes().all(|byte| byte.is_ascii_alphanumeric())
    {
        return Err(AttachmentError::InvalidFilename(filename.to_owned()));
    }
    Ok(())
}

async fn reject_symlink_directory(path: &Path) -> Result<(), AttachmentError> {
    let metadata = tokio::fs::symlink_metadata(path).await?;
    if metadata.file_type().is_symlink() {
        return Err(AttachmentError::ProjectDirectorySymlink);
    }
    Ok(())
}

async fn write_new_file(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .await?;
    file.write_all(bytes).await?;
    file.flush().await
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn format_system_time(time: SystemTime) -> String {
    DateTime::<Utc>::from(time).to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine as _, engine::general_purpose::STANDARD};

    fn attachment(mime_type: &str, bytes: &[u8]) -> AgentAttachment {
        AgentAttachment {
            r#type: "image".to_owned(),
            name: "from-user.png".to_owned(),
            mime_type: mime_type.to_owned(),
            data_base64: STANDARD.encode(bytes),
        }
    }

    #[tokio::test]
    async fn saves_reads_and_reports_metadata_in_a_temp_root() {
        let temporary = tempfile::tempdir().expect("temporary root");
        let store = AttachmentStore::open(temporary.path());
        let png = b"\x89PNG\r\n\x1a\nimage";
        let saved = store
            .save("project_1", "message-1", &attachment("image/png", png), 2)
            .await
            .expect("saved attachment");

        assert!(
            saved
                .absolute_path
                .starts_with(temporary.path().join("attachments/project_1"))
        );
        assert_eq!(
            store
                .read("project_1", &saved.filename)
                .await
                .expect("attachment bytes"),
            png
        );
        assert_eq!(
            saved.metadata["urlPath"],
            format!("/agent/attachments/project_1/{}", saved.filename)
        );
        assert_eq!(saved.metadata["originalName"], "from-user.png");
        let stats = store.stats().await.expect("attachment stats");
        assert_eq!(
            (stats.total_files, stats.total_bytes),
            (1, png.len() as u64)
        );
    }

    #[tokio::test]
    async fn rejects_unsafe_identifiers_and_never_uses_original_name_as_path() {
        let temporary = tempfile::tempdir().expect("temporary root");
        let store = AttachmentStore::open(temporary.path());
        let mut image = attachment("image/png", b"\x89PNG\r\n\x1a\nimage");

        for unsafe_id in ["", "../outside", "project/name", "project\\name", ".hidden"] {
            let error = store
                .save(unsafe_id, "message", &image, 0)
                .await
                .expect_err("unsafe project rejected");
            assert!(matches!(error, AttachmentError::InvalidIdentifier { .. }));
        }
        image.name = "../../malicious.png".to_owned();
        let saved = store
            .save("project", "message", &image, 0)
            .await
            .expect("saved attachment");
        assert!(!saved.absolute_path.to_string_lossy().contains(&image.name));
        assert_eq!(saved.metadata["originalName"], image.name);
        assert!(matches!(
            store.read("project", "../outside.png").await,
            Err(AttachmentError::InvalidFilename(_))
        ));
    }

    #[tokio::test]
    async fn validates_type_and_mime_without_inspecting_declared_image_bytes() {
        let temporary = tempfile::tempdir().expect("temporary root");
        let store = AttachmentStore::open(temporary.path());
        let png = b"\x89PNG\r\n\x1a\nimage";

        let mut not_an_image = attachment("image/png", png);
        not_an_image.r#type = "file".to_owned();
        assert!(matches!(
            store.save("project", "message", &not_an_image, 0).await,
            Err(AttachmentError::UnsupportedType(_))
        ));
        assert!(matches!(
            store
                .save("project", "message", &attachment("image/svg+xml", png), 0)
                .await,
            Err(AttachmentError::UnsupportedMimeType(_))
        ));

        let saved = store
            .save("project", "message", &attachment("image/jpeg", png), 0)
            .await
            .expect("declared MIME type is retained without byte inspection");
        assert_eq!(saved.metadata["mimeType"], "image/jpeg");

        let mut node_compatible_base64 = attachment("image/png", png);
        node_compatible_base64.data_base64 = "not base64!".to_owned();
        let saved = store
            .save("project", "message", &node_compatible_base64, 1)
            .await
            .expect("Node-compatible permissive base64");
        assert_eq!(
            tokio::fs::read(saved.absolute_path)
                .await
                .expect("persisted bytes"),
            [158, 139, 91, 106, 199, 186],
        );
    }

    #[tokio::test]
    async fn preserves_node_base64_payload_bytes() {
        let temporary = tempfile::tempdir().expect("temporary root");
        let store = AttachmentStore::open(temporary.path());
        let samples: &[(&str, &[u8])] = &[
            ("AB", &[0]),
            ("_w", &[255]),
            ("AQ I?D", &[1, 2, 3]),
            ("AQ==ignored", &[1]),
            ("A", &[]),
        ];
        for (index, (encoded, expected)) in samples.iter().enumerate() {
            let mut image = attachment("image/png", &[]);
            image.data_base64 = (*encoded).to_owned();
            let saved = store
                .save("project", "message", &image, index)
                .await
                .expect("save");
            assert_eq!(
                tokio::fs::read(saved.absolute_path)
                    .await
                    .expect("persisted bytes"),
                *expected,
                "Node-compatible attachment data: {encoded}",
            );
        }
    }

    #[tokio::test]
    async fn cleans_selected_or_all_project_directories_deterministically() {
        let temporary = tempfile::tempdir().expect("temporary root");
        let store = AttachmentStore::open(temporary.path());
        let png = b"\x89PNG\r\n\x1a\nimage";
        store
            .save("alpha", "one", &attachment("image/png", png), 0)
            .await
            .expect("alpha attachment");
        store
            .save("beta", "two", &attachment("image/png", png), 0)
            .await
            .expect("beta attachment");

        let selected = store
            .cleanup(Some(&["alpha".to_owned()]))
            .await
            .expect("selected cleanup");
        assert_eq!(selected.removed_files, 1);
        assert!(!store.project_dir("alpha").expect("alpha path").exists());
        let all = store.cleanup(None).await.expect("all cleanup");
        assert_eq!(
            all.results
                .iter()
                .map(|result| result.project_id.as_str())
                .collect::<Vec<_>>(),
            vec!["beta"]
        );
        assert!(!store.project_dir("beta").expect("beta path").exists());
    }

    #[test]
    fn maps_canonical_mime_extensions() {
        assert_eq!(mime_type_to_ext("image/jpeg"), "jpg");
        assert_eq!(ext_to_mime_type("JPEG"), Some("image/jpeg"));
        assert_eq!(ext_to_mime_type("svg"), None);
    }
}
