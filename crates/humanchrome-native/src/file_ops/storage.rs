//! Local file operations for the native messaging file handler.

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    io,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::fs;

const MAX_DOWNLOAD_BYTES: u64 = 100 * 1024 * 1024;

/// File storage rooted at an explicit temporary directory.
#[derive(Clone, Debug)]
pub struct FileStorage {
    temp_dir: PathBuf,
}

impl FileStorage {
    /// Construct storage without creating directories or touching an installed host.
    #[must_use]
    pub fn new(temp_dir: PathBuf) -> Self {
        Self { temp_dir }
    }

    /// Create the same temporary upload directory used by the native host.
    ///
    /// # Errors
    /// Reports a failure to create the upload directory.
    pub async fn prepare(&self) -> io::Result<()> {
        fs::create_dir_all(&self.temp_dir).await
    }

    /// Delete files older than one hour; missing entries are treated as I/O errors
    /// just as the existing native handler's single-pass cleanup does.
    ///
    /// # Errors
    /// Returns a directory, metadata, or deletion error.
    pub async fn cleanup_old(&self, now: SystemTime) -> io::Result<()> {
        let mut entries = fs::read_dir(&self.temp_dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            let metadata = entry.metadata().await?;
            let age = now.duration_since(metadata.modified()?).unwrap_or_default();
            if age > std::time::Duration::from_secs(3600) {
                fs::remove_file(entry.path()).await?;
            }
        }
        Ok(())
    }

    /// Save base64 payload to the upload directory.
    ///
    /// # Errors
    /// Reports filesystem or clock failure.
    pub async fn save_base64(&self, data: &str, name: Option<&str>) -> anyhow::Result<Value> {
        let decoded = decode_base64(data);
        let default = format!(
            "upload-{}.bin",
            SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis()
        );
        let filename = name.filter(|value| !value.is_empty()).unwrap_or(&default);
        let path = node_join(&self.temp_dir, filename);
        fs::write(&path, &decoded).await?;
        Ok(
            json!({"success":true,"filePath":path.to_string_lossy(),"fileName":filename,"size":decoded.len()}),
        )
    }

    /// Save UTF-8 or base64 bytes to the caller's requested path; text wins.
    ///
    /// # Errors
    /// Reports malformed payload or filesystem failure.
    pub async fn save_to_path(
        &self,
        dest: &Path,
        text: Option<&str>,
        base64: Option<&str>,
    ) -> anyhow::Result<Value> {
        let data = match (
            text.filter(|value| !value.is_empty()),
            base64.filter(|value| !value.is_empty()),
        ) {
            (Some(text), _) => text.as_bytes().to_vec(),
            (None, Some(data)) => decode_base64(data),
            (None, None) => {
                return Ok(
                    json!({"success":false,"error":"Either textData or base64Data is required"}),
                );
            }
        };
        if let Some(parent) = dest
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            fs::create_dir_all(parent).await?;
        }
        fs::write(dest, &data).await?;
        Ok(json!({"success":true,"filePath":dest.to_string_lossy(),"size":data.len()}))
    }

    /// Verify a readable regular file and return its name and size.
    ///
    /// # Errors
    /// Reports a missing, unreadable, or non-regular file.
    pub async fn verify(&self, path: &Path) -> anyhow::Result<Value> {
        let metadata = fs::metadata(path).await.map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                anyhow::anyhow!("File does not exist: {}", path.display())
            } else {
                error.into()
            }
        })?;
        if !metadata.is_file() {
            anyhow::bail!("Path is not a file: {}", path.display());
        }
        fs::File::open(path).await?;
        Ok(
            json!({"success":true,"filePath":path.to_string_lossy(),"fileName":file_name(path),"size":metadata.len()}),
        )
    }

    /// Read a regular file inside the upload directory and return base64 bytes.
    ///
    /// # Errors
    /// Reports an out-of-root path, non-file, oversized file or I/O failure.
    pub async fn read_base64(&self, path: &Path) -> anyhow::Result<Value> {
        let root = absolute(&self.temp_dir)?;
        let resolved = absolute(path)?;
        if !resolved.starts_with(&root) {
            anyhow::bail!("readBase64File only allowed inside the bridge temp directory");
        }
        let metadata = fs::metadata(&resolved).await.map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                anyhow::anyhow!("File does not exist: {}", resolved.display())
            } else {
                error.into()
            }
        })?;
        if !metadata.is_file() {
            anyhow::bail!("Path is not a file: {}", resolved.display());
        }
        if metadata.len() > MAX_DOWNLOAD_BYTES {
            anyhow::bail!("File too large to read: {} bytes", metadata.len());
        }
        let bytes = fs::read(&resolved).await?;
        Ok(
            json!({"success":true,"filePath":resolved.to_string_lossy(),"fileName":file_name(&resolved),"size":metadata.len(),"base64Data":STANDARD.encode(bytes)}),
        )
    }

    /// Remove an upload using the existing native prefix rule.
    ///
    /// # Errors
    /// Reports failures deleting an existing file.
    pub async fn cleanup(&self, path: &Path) -> anyhow::Result<Value> {
        if !path
            .to_string_lossy()
            .starts_with(self.temp_dir.to_string_lossy().as_ref())
        {
            return Ok(json!({"success":false,"error":"Can only cleanup files in temp directory"}));
        }
        match fs::remove_file(path).await {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        Ok(json!({"success":true,"message":"File cleaned up successfully"}))
    }
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}

fn node_join(root: &Path, name: &str) -> PathBuf {
    let trimmed = name.trim_start_matches(std::path::MAIN_SEPARATOR);
    root.join(trimmed)
}

fn absolute(path: &Path) -> io::Result<PathBuf> {
    let input = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut normalized = PathBuf::new();
    for component in input.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            value => normalized.push(value.as_os_str()),
        }
    }
    Ok(normalized)
}

fn decode_base64(data: &str) -> Vec<u8> {
    let raw = data
        .strip_prefix("data:")
        .and_then(|value| value.split_once(";base64,"))
        .map_or(data, |(_, value)| value);
    decode_node_base64(raw)
}

/// Decode Node-compatible base64 without a normalized intermediate allocation.
pub(crate) fn decode_node_base64(value: &str) -> Vec<u8> {
    let mut decoded = Vec::with_capacity(value.len() / 4 * 3 + value.len() % 4);
    let mut buffer = 0_u16;
    let mut bits = 0_u32;
    for byte in value.bytes() {
        let digit = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        buffer = (buffer << 6) | u16::from(digit);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            decoded.push(((buffer >> bits) & 0xff) as u8);
        }
    }
    decoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn file_round_trip_preserves_bytes_and_rejects_other_roots() {
        let temp = tempfile::tempdir().expect("temporary root");
        let uploads = temp.path().join("humanchrome-uploads");
        let storage = FileStorage::new(uploads.clone());
        storage.prepare().await.expect("create directory");
        let saved = storage
            .save_base64(
                "data:application/octet-stream;base64,AAH/",
                Some("input.bin"),
            )
            .await
            .expect("save");
        assert_eq!(saved["size"], 3);
        let file = uploads.join("input.bin");
        assert_eq!(
            storage.read_base64(&file).await.expect("read")["base64Data"],
            "AAH/"
        );
        assert!(
            storage
                .read_base64(&temp.path().join("outside"))
                .await
                .is_err()
        );
        assert_eq!(
            storage.cleanup(&file).await.expect("cleanup")["success"],
            true
        );
        assert!(!file.exists());
    }

    #[tokio::test]
    async fn save_to_path_creates_parents_and_prefers_text() {
        let temp = tempfile::tempdir().expect("temporary root");
        let storage = FileStorage::new(temp.path().join("uploads"));
        let dest = temp.path().join("a/b/target.txt");
        let result = storage
            .save_to_path(&dest, Some("hé"), Some("YmluYXJ5"))
            .await
            .expect("save");
        assert_eq!(result["size"], 3);
        assert_eq!(fs::read_to_string(dest).await.expect("read"), "hé");
    }
}
