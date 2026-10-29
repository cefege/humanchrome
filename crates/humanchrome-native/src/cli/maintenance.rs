//! File-maintenance handlers used by the native command interface.

use std::{
    io,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use serde_json::Value;
use tokio::fs;

static TEMPORARY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// A concrete file permission result.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PermissionResult {
    /// Target file inspected and, where needed, updated.
    pub path: PathBuf,
    /// Whether a permission change was made.
    pub changed: bool,
}

/// Restores executable permissions for an existing native host without changing its content.
///
/// # Errors
/// Returns an error when the path does not name a regular readable file or permissions cannot be changed.
pub async fn fix_permissions(path: &Path) -> io::Result<PermissionResult> {
    let metadata = fs::metadata(path).await?;
    if !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "native host is not a regular file",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let current = metadata.permissions().mode();
        let desired = current | 0o555;
        if desired != current {
            fs::set_permissions(path, std::fs::Permissions::from_mode(desired)).await?;
            return Ok(PermissionResult {
                path: path.to_path_buf(),
                changed: true,
            });
        }
    }
    #[cfg(windows)]
    {
        // Clearing readonly is the meaningful equivalent for a Windows host executable.
        let mut permissions = metadata.permissions();
        if permissions.readonly() {
            permissions.set_readonly(false);
            fs::set_permissions(path, permissions).await?;
            return Ok(PermissionResult {
                path: path.to_path_buf(),
                changed: true,
            });
        }
    }
    Ok(PermissionResult {
        path: path.to_path_buf(),
        changed: false,
    })
}

/// Updates the port component of a JSON configuration's absolute `url` field atomically.
///
/// # Errors
/// Returns invalid JSON, missing URL, invalid URL, port-range, or filesystem errors without truncating config.
pub async fn update_port(path: &Path, port: u16) -> io::Result<String> {
    let bytes = fs::read(path).await?;
    let mut config: Value = serde_json::from_slice(&bytes)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let url = config.get("url").and_then(Value::as_str).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "configuration url is missing or not a string",
        )
    })?;
    let updated = replace_url_port(url, port)?;
    let object = config.as_object_mut().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidData, "configuration is not an object")
    })?;
    object.insert("url".to_owned(), Value::String(updated.clone()));
    let mut encoded = humanchrome_core::json::to_vec_pretty(&config);
    encoded.push(b'\n');
    write_atomically(path, &encoded).await?;
    Ok(updated)
}

fn replace_url_port(url: &str, port: u16) -> io::Result<String> {
    let (scheme, remainder) = url.split_once("://").ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "configuration url is not absolute",
        )
    })?;
    if scheme.is_empty() || remainder.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "configuration url is not absolute",
        ));
    }
    let authority_end = remainder.find(['/', '?', '#']).unwrap_or(remainder.len());
    let authority = &remainder[..authority_end];
    if authority.is_empty() || authority.contains('@') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "configuration url has an unsupported authority",
        ));
    }
    let host = if authority.starts_with('[') {
        let closing = authority.find(']').ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "configuration url has an invalid IPv6 authority",
            )
        })?;
        if authority[closing + 1..].is_empty() || authority[closing + 1..].starts_with(':') {
            &authority[..=closing]
        } else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "configuration url has an invalid IPv6 authority",
            ));
        }
    } else {
        authority.split_once(':').map_or(
            authority,
            |(host, suffix)| {
                if suffix.contains(':') { "" } else { host }
            },
        )
    };
    if host.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "configuration url has an invalid host",
        ));
    }
    Ok(format!(
        "{scheme}://{host}:{port}{}",
        &remainder[authority_end..]
    ))
}

async fn write_atomically(path: &Path, content: &[u8]) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "configuration has no parent directory",
        )
    })?;
    let sequence = TEMPORARY_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = parent.join(format!(
        ".humanchrome-cli.{}.{}.tmp",
        std::process::id(),
        sequence
    ));
    fs::write(&temporary, content).await?;
    if let Err(error) = fs::rename(&temporary, path).await {
        let _ = fs::remove_file(&temporary).await;
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::update_port;

    #[test]
    fn updates_explicit_temp_config_port() {
        let directory = tempdir().expect("temporary directory");
        let path = directory.path().join("stdio-config.json");
        fs::write(&path, r#"{"url":"http://127.0.0.1:12306/api"}"#).expect("write config");
        let runtime = tokio::runtime::Runtime::new().expect("runtime");
        let url = runtime
            .block_on(update_port(&path, 4321))
            .expect("update port");
        assert_eq!(url, "http://127.0.0.1:4321/api");
        assert!(
            fs::read_to_string(path)
                .expect("read config")
                .contains(":4321")
        );
    }
}
