//! Atomic, process-owned instance records compatible with the existing native registry.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    io,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};
use tokio::{fs, io::AsyncWriteExt};

use crate::platform::process_is_alive;

const MAX_STALE_MS: u64 = 5 * 60 * 1000;

/// The native bridge announces the same persisted record layout after HTTP bind.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceRecord {
    /// OS process ID of the HTTP owner, not a Chrome profile authority.
    pub pid: u32,
    /// Bound loopback HTTP port.
    pub port: u16,
    /// Extension identity received in its START message.
    pub extension_id: String,
    /// Chrome service-worker instance identity, if supplied.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
    /// Fleet launch binary, if supplied in the environment.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chrome_binary: Option<String>,
    /// ISO timestamp from the owner's HTTP startup.
    pub started_at: String,
}

/// One registry directory; methods never remove records for a live non-stale owner.
#[derive(Clone, Debug)]
pub struct InstanceRegistry {
    directory: PathBuf,
}

impl InstanceRegistry {
    /// Bind operations to a resolved directory rather than ambient global state.
    pub fn new(directory: PathBuf) -> Self {
        Self { directory }
    }

    /// Resolve a PID entry using the historical filename.
    #[must_use]
    pub fn entry_path(&self, pid: u32) -> PathBuf {
        self.directory.join(format!("{pid}.json"))
    }

    /// Atomically publish a complete record using mode 0600 on new Unix files.
    ///
    /// # Errors
    /// Reports filesystem errors without removing another process's record.
    pub async fn write(&self, record: &InstanceRecord) -> io::Result<()> {
        fs::create_dir_all(&self.directory).await?;
        let final_path = self.entry_path(record.pid);
        let temporary = self.directory.join(format!("{}.json.tmp", record.pid));
        let mut options = fs::OpenOptions::new();
        options.create(true).truncate(true).write(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(&temporary).await?;
        let bytes = serde_json::to_vec_pretty(record).map_err(io::Error::other)?;
        file.write_all(&bytes).await?;
        drop(file);
        fs::rename(temporary, final_path).await
    }

    /// Remove only the requested owner's entry; shutdown is idempotent.
    pub async fn remove(&self, pid: u32) {
        let _ = fs::remove_file(self.entry_path(pid)).await;
    }

    /// List live records, preserving unknown fields; collect dead, stale or corrupt entries.
    ///
    /// The injected epoch clock preserves the strict greater-than five-minute boundary.
    pub async fn list(&self, now_ms: u64) -> Vec<Value> {
        let Ok(mut entries) = fs::read_dir(&self.directory).await else {
            return Vec::new();
        };
        let mut paths = Vec::new();
        while let Ok(Some(entry)) = entries.next_entry().await {
            if entry.file_name().to_string_lossy().ends_with(".json") {
                paths.push(entry.path());
            }
        }
        // Node readdirSync returns directory entries in name order on supported hosts.
        paths.sort();
        let mut records = Vec::with_capacity(paths.len());
        for path in paths {
            if let Some((record, modified_ms)) = read_record(&path).await {
                let pid = record
                    .get("pid")
                    .and_then(Value::as_u64)
                    .and_then(|pid| u32::try_from(pid).ok());
                let stale = now_ms.saturating_sub(modified_ms) > MAX_STALE_MS;
                if !stale && pid.is_some_and(process_is_alive) {
                    records.push(record);
                    continue;
                }
            }
            let _ = fs::remove_file(path).await;
        }
        records
    }
}

async fn read_record(path: &Path) -> Option<(Value, u64)> {
    let bytes = fs::read(path).await.ok()?;
    let record = serde_json::from_slice(&bytes).ok()?;
    let modified = fs::metadata(path).await.ok()?.modified().ok()?;
    let elapsed = modified.duration_since(UNIX_EPOCH).ok()?;
    let modified_ms = u64::try_from(elapsed.as_millis()).ok()?;
    Some((record, modified_ms))
}
