//! Native filesystem locations retain existing environment overrides and platform defaults.

use std::{
    env, io,
    path::{Component, PathBuf},
};

/// Paths are captured once for a native process; no installed paths are changed.
#[derive(Clone, Debug)]
pub struct NativePaths {
    /// The same home directory lookup used for all default native locations.
    pub home: PathBuf,
    /// Live bridge registry; each owner writes only its PID entry.
    pub registry: PathBuf,
    /// Primary/relay socket, isolated naturally by a registry override.
    pub daemon_socket: PathBuf,
    /// Version-one fleet configuration and profile root.
    pub fleet: PathBuf,
}

impl NativePaths {
    /// Resolve production paths, honoring the current native environment contract.
    ///
    /// # Errors
    /// Returns an error if no home or current working directory is available.
    pub fn from_environment() -> io::Result<Self> {
        let home = dirs::home_dir()
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "home directory unavailable"))?;
        let registry_default = if cfg!(target_os = "macos") {
            home.join("Library/Application Support/humanchrome-bridge/instances")
        } else if cfg!(windows) {
            home.join("AppData/Local/humanchrome-bridge/instances")
        } else {
            home.join(".config/humanchrome-bridge/instances")
        };
        let registry = absolute(
            env::var_os("HC_INSTANCE_REGISTRY_DIR")
                .filter(|value| !value.is_empty())
                .map_or(registry_default, PathBuf::from),
        )?;
        let daemon_socket = absolute(
            env::var_os("HC_BRIDGE_DAEMON_SOCKET")
                .filter(|value| !value.is_empty())
                .map_or_else(
                    || {
                        registry
                            .parent()
                            .unwrap_or(&registry)
                            .join("bridge-daemon.sock")
                    },
                    PathBuf::from,
                ),
        )?;
        // Fleet has historically used the macOS Application Support default on every OS.
        let fleet = absolute(env::var_os("HC_FLEET_ROOT").map_or_else(
            || home.join("Library/Application Support/humanchrome-fleet"),
            PathBuf::from,
        ))?;
        Ok(Self {
            home,
            registry,
            daemon_socket,
            fleet,
        })
    }
}

fn absolute(path: PathBuf) -> io::Result<PathBuf> {
    let path = if path.is_absolute() {
        path
    } else {
        env::current_dir()?.join(path)
    };
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    Ok(normalized)
}
