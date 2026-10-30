//! Error values for fleet process and profile operations.

use std::path::PathBuf;

/// A failure while owning a fleet browser or its persistent profile.
#[derive(Debug, thiserror::Error)]
pub enum FleetRuntimeError {
    /// A filesystem operation failed.
    #[error("fleet filesystem operation failed at {path}: {source}")]
    Io {
        /// Path involved in the operation.
        path: PathBuf,
        /// Source I/O failure.
        #[source]
        source: std::io::Error,
    },
    /// A persistent JSON document was malformed.
    #[error("invalid JSON at {path}: {source}")]
    Json {
        /// Path containing the malformed document.
        path: PathBuf,
        /// JSON parser failure.
        #[source]
        source: serde_json::Error,
    },
    /// A Chrome DevTools operation failed.
    #[error("{0}")]
    Cdp(String),
    /// Chrome could not be launched or controlled as a process.
    #[error("{0}")]
    Process(String),
    /// A profile violates an ownership or session-safety invariant.
    #[error("{0}")]
    Profile(String),
    /// A background file operation panicked or was cancelled.
    #[error("fleet background task failed: {0}")]
    Join(#[from] tokio::task::JoinError),
}

impl FleetRuntimeError {
    /// Attach a filesystem path to an I/O failure.
    pub(crate) fn io(path: impl Into<PathBuf>, source: std::io::Error) -> Self {
        Self::Io {
            path: path.into(),
            source,
        }
    }
}
