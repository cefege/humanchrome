//! Primary/relay acquisition preserves stale probing before Unix socket removal.

use std::{io, path::Path, time::Duration};

#[cfg(unix)]
use tokio::{
    io::{AsyncWriteExt, copy},
    net::{UnixListener, UnixStream},
    time::timeout,
};

/// The existing HC_DISABLE_DAEMON switch selects standalone only for the value `1`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DaemonMode {
    Enabled,
    Disabled,
}

impl DaemonMode {
    /// Resolve the native process environment without broadening accepted disabling values.
    #[must_use]
    pub fn from_environment() -> Self {
        if std::env::var("HC_DISABLE_DAEMON").as_deref() == Ok("1") {
            Self::Disabled
        } else {
            Self::Enabled
        }
    }
}

/// One native process owns HTTP, relays protocol bytes, or runs without a daemon.
#[derive(Debug)]
pub enum DaemonRole {
    /// Legacy lifecycle: native input closure shuts down this process.
    Standalone,
    /// This process owns the listening socket and native request state.
    #[cfg(unix)]
    Primary(PrimarySocket),
    /// An existing primary owns all native request state.
    #[cfg(unix)]
    Relay(UnixStream),
}

/// Shutdown leaves the pathname as Node does; acquisition probes before removing it.
#[cfg(unix)]
#[derive(Debug)]
pub struct PrimarySocket {
    listener: UnixListener,
}

#[cfg(unix)]
impl PrimarySocket {
    /// Accept replacement sources without rebinding HTTP or replacing pending state.
    ///
    /// # Errors
    /// Propagates socket acceptance errors.
    pub async fn accept(&self) -> io::Result<UnixStream> {
        self.listener.accept().await.map(|(stream, _)| stream)
    }
}

/// Select primary, relay or standalone without touching a live primary's socket.
///
/// # Errors
/// Reports failure to create the configured socket directory, as the old host does.
pub async fn choose_role(path: &Path, mode: DaemonMode) -> io::Result<DaemonRole> {
    if mode == DaemonMode::Disabled {
        return Ok(DaemonRole::Standalone);
    }
    #[cfg(unix)]
    {
        if let Some(primary) = try_acquire_daemon_lock(path).await? {
            return Ok(DaemonRole::Primary(primary));
        }
        match connect_as_relay(path, Duration::from_secs(3)).await {
            Ok(stream) => return Ok(DaemonRole::Relay(stream)),
            Err(error) => {
                tracing::warn!(%error, "relay connect failed — falling back to standalone mode")
            }
        }
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(DaemonRole::Standalone)
}

/// Bind a new primary; probe a collision before removing a stale socket and retrying once.
///
/// # Errors
/// Reports directory creation errors. Binding/probing errors retain standalone fallback.
#[cfg(unix)]
pub async fn try_acquire_daemon_lock(path: &Path) -> io::Result<Option<PrimarySocket>> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    if let Ok(listener) = UnixListener::bind(path) {
        return Ok(Some(PrimarySocket { listener }));
    }
    let live = matches!(
        timeout(Duration::from_millis(500), UnixStream::connect(path)).await,
        Ok(Ok(_))
    );
    if live {
        return Ok(None);
    }
    match tokio::fs::remove_file(path).await {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(_) => return Ok(None),
    }
    Ok(UnixListener::bind(path)
        .ok()
        .map(|listener| PrimarySocket { listener }))
}

/// Connect the new Chrome native host to its existing primary with the original deadline.
///
/// # Errors
/// Reports connect failure or the same human-readable connection timeout.
#[cfg(unix)]
pub async fn connect_as_relay(path: &Path, wait: Duration) -> io::Result<UnixStream> {
    timeout(wait, UnixStream::connect(path))
        .await
        .map_err(|_| {
            io::Error::new(
                io::ErrorKind::TimedOut,
                format!("Timed out connecting to daemon at {}", path.display()),
            )
        })?
}

/// Forward opaque framed bytes in both directions; no tool is replayed or interpreted.
#[cfg(unix)]
pub async fn run_relay(stream: UnixStream) {
    let (mut input, mut output) = stream.into_split();
    let mut stdin = match crate::platform::native_stdin() {
        Ok(input) => input,
        Err(error) => {
            tracing::warn!(%error, "relay stdin closed");
            return;
        }
    };
    let mut stdout = tokio::io::stdout();
    tokio::select! {
        result = copy(&mut stdin, &mut output) => {
            if let Err(error) = result { tracing::warn!(%error, "relay stdin closed"); }
            let _ = output.shutdown().await;
        },
        result = copy(&mut input, &mut stdout) => {
            if let Err(error) = result { tracing::warn!(%error, "relay socket closed"); }
            let _ = stdout.flush().await;
        },
    }
}

/// Resolve the historical Node timer behavior, including zero/invalid defaulting.
#[must_use]
pub fn idle_timeout(value: Option<&str>) -> Duration {
    let number = value
        .and_then(|value| value.trim().parse::<f64>().ok())
        .unwrap_or(0.0);
    let millis = if number == 0.0 || number.is_nan() {
        5 * 60 * 1000
    } else if !(1.0..=2_147_483_647.0).contains(&number) {
        1
    } else {
        number as u64
    };
    Duration::from_millis(millis)
}
