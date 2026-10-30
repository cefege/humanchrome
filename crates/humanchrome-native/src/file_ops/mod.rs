//! Native upload file operations and externally supplied DevTools trace analysis.

pub mod download;
pub mod storage;
pub mod trace;

use self::{download::FileDownloader, storage::FileStorage};
use crate::ipc;
use serde_json::{Value, json};
use std::{
    future::Future,
    path::{Path, PathBuf},
};

/// The DevTools trace engine is a third-party effect boundary. Implementations
/// must run a real analyzer and return its actual summary, not a synthesized one.
pub trait TraceAnalyzer: Send + Sync {
    /// Analyze the requested Chrome trace using its supported engine.
    fn analyze(
        &self,
        path: &Path,
        insight: Option<&str>,
    ) -> impl Future<Output = anyhow::Result<Value>> + Send;
}

/// File operations with an explicit trace engine and temporary upload root.
#[derive(Debug)]
pub struct FileOperations<T> {
    storage: FileStorage,
    downloader: FileDownloader,
    trace: T,
}

impl<T: TraceAnalyzer> FileOperations<T> {
    /// Create the native upload directory and the real trace-analyzer boundary.
    ///
    /// # Errors
    /// Returns a directory or HTTP client initialization failure.
    pub async fn new(temp_dir: PathBuf, trace: T) -> anyhow::Result<Self> {
        let storage = FileStorage::new(temp_dir.clone());
        storage.prepare().await?;
        Ok(Self {
            storage,
            downloader: FileDownloader::new(temp_dir)?,
            trace,
        })
    }

    /// Remove expired uploads using the caller's clock.
    ///
    /// # Errors
    /// Reports a directory, metadata or deletion failure.
    pub async fn cleanup_old(&self, now: std::time::SystemTime) -> std::io::Result<()> {
        self.storage.cleanup_old(now).await
    }

    /// Process one extension file request, preserving missing prepareFile results.
    pub async fn handle(&self, payload: &Value) -> Option<Value> {
        if let Err(error) = ipc::validate_schema("FileOperationPayloadSchema", payload) {
            return Some(
                json!({"success":false,"error":format!("Invalid file_operation payload: {}", error.first_message())}),
            );
        }
        let field = |key| {
            payload
                .get(key)
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
        };
        let action = field("action").unwrap_or("");
        let result: anyhow::Result<Option<Value>> = match action {
            "prepareFile" => {
                if let Some(url) = field("fileUrl") {
                    self.downloader
                        .download(url, field("fileName"))
                        .await
                        .map(Some)
                        .map_err(|error| {
                            anyhow::anyhow!("Failed to download file from URL: Error: {error}")
                        })
                } else if let Some(data) = field("base64Data") {
                    self.storage
                        .save_base64(data, field("fileName"))
                        .await
                        .map(Some)
                        .map_err(|error| {
                            anyhow::anyhow!("Failed to save base64 file: Error: {error}")
                        })
                } else if let Some(path) = field("filePath") {
                    self.storage
                        .verify(Path::new(path))
                        .await
                        .map(Some)
                        .map_err(|error| anyhow::anyhow!("Failed to verify file: Error: {error}"))
                } else {
                    Ok(None)
                }
            }
            "readBase64File" => match field("filePath") {
                Some(path) => self
                    .storage
                    .read_base64(Path::new(path))
                    .await
                    .map(Some)
                    .map_err(|error| anyhow::anyhow!("Failed to read file: {error}")),
                None => Ok(Some(
                    json!({"success":false,"error":"filePath is required"}),
                )),
            },
            "cleanupFile" => match field("filePath") {
                Some(path) => self
                    .storage
                    .cleanup(Path::new(path))
                    .await
                    .map(Some)
                    .map_err(|error| anyhow::anyhow!("Failed to cleanup file: Error: {error}")),
                None => Ok(Some(
                    json!({"success":false,"error":"filePath is required"}),
                )),
            },
            "saveToPath" => match field("destPath") {
                Some(path) => self
                    .storage
                    .save_to_path(Path::new(path), field("textData"), field("base64Data"))
                    .await
                    .map(Some)
                    .map_err(|error| anyhow::anyhow!("Failed to save to path: Error: {error}")),
                None => Ok(Some(
                    json!({"success":false,"error":"destPath is required for saveToPath"}),
                )),
            },
            "analyzeTrace" => match field("traceFilePath").or_else(|| field("filePath")) {
                Some(path) => self
                    .trace
                    .analyze(Path::new(path), field("insightName"))
                    .await
                    .and_then(|value| {
                        let mut object = value.as_object().cloned().ok_or_else(|| {
                            anyhow::anyhow!("Trace analyzer returned a non-object")
                        })?;
                        object.insert("success".into(), Value::Bool(true));
                        Ok(Some(Value::Object(object)))
                    }),
                None => Ok(Some(
                    json!({"success":false,"error":"traceFilePath is required"}),
                )),
            },
            _ => Ok(Some(
                json!({"success":false,"error":format!("Unknown file action: {action}")}),
            )),
        };
        match result {
            Ok(value) => value,
            Err(error) => Some(json!({"success":false,"error":error.to_string()})),
        }
    }
}
