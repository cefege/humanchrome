//! Cross-process fleet-root authority compatible with the TypeScript owner.

use std::{path::Path, time::Duration};

use rusqlite::Connection;

/// Holds SQLite's exclusive transaction until the owning supervisor has stopped.
pub(crate) struct FleetRootLock {
    connection: Option<Connection>,
}

impl FleetRootLock {
    pub(crate) async fn acquire(root: &Path) -> Result<Self, String> {
        let path = root.join("run/fleet-root-lock.sqlite");
        tokio::fs::create_dir_all(path.parent().expect("fleet lock has a run directory"))
            .await
            .map_err(|error| error.to_string())?;
        tokio::task::spawn_blocking(move || {
            let connection = Connection::open(&path).map_err(|error| error.to_string())?;
            connection
                .busy_timeout(Duration::ZERO)
                .map_err(|error| error.to_string())?;
            connection.execute_batch("BEGIN EXCLUSIVE").map_err(|_| {
                let root = path
                    .parent()
                    .and_then(Path::parent)
                    .expect("fleet lock has a root");
                format!(
                    "a fleet process is already running in this root ({})",
                    root.display()
                )
            })?;
            Ok(Self {
                connection: Some(connection),
            })
        })
        .await
        .map_err(|error| error.to_string())?
    }

    pub(crate) async fn release(mut self) -> Result<(), String> {
        let connection = self.connection.take().expect("fleet lock is released once");
        tokio::task::spawn_blocking(move || {
            connection
                .execute_batch("COMMIT")
                .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())?
    }
}

impl Drop for FleetRootLock {
    fn drop(&mut self) {
        let Some(connection) = self.connection.take() else {
            return;
        };
        // Startup errors and cancellation must also release authority. Closing SQLite can
        // perform filesystem work, so never run it on an asynchronous executor thread.
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            drop(runtime.spawn_blocking(move || drop(connection)));
        } else {
            drop(connection);
        }
    }
}
