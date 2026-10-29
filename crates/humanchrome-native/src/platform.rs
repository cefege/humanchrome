//! Safe native I/O and narrow process probes; never treat a PID file as ownership.

/// Probe process existence without sending a signal or changing process state.
#[must_use]
pub fn process_is_alive(pid: u32) -> bool {
    if pid == std::process::id() {
        return true;
    }
    platform_process_is_alive(pid)
}

/// Request the same graceful child termination as Node's default `ChildProcess.kill()`.
/// The caller retains the child handle and must wait for it before releasing run ownership.
///
/// # Errors
/// Reports child status, PID conversion, or operating-system signal failures.
pub fn request_child_termination(child: &mut tokio::process::Child) -> std::io::Result<()> {
    if child.try_wait()?.is_some() {
        return Ok(());
    }
    #[cfg(unix)]
    {
        let Some(pid) = child.id() else {
            return Ok(());
        };
        let pid = libc::pid_t::try_from(pid)
            .ok()
            .filter(|pid| *pid > 0)
            .ok_or_else(|| std::io::Error::other("child has no valid positive process ID"))?;
        // SAFETY: the positive PID belongs to this unreaped child; no pointers or group IDs are used.
        if unsafe { libc::kill(pid, libc::SIGTERM) } == 0 {
            Ok(())
        } else {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ESRCH) {
                Ok(())
            } else {
                Err(error)
            }
        }
    }
    #[cfg(not(unix))]
    child.start_kill()
}

#[cfg(unix)]
fn platform_process_is_alive(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    // SAFETY: signal zero only probes an integer PID; it takes no pointers and
    // cannot deliver a terminating signal, including for the PID-zero group case.
    let result = unsafe { libc::kill(pid, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
fn platform_process_is_alive(pid: u32) -> bool {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, ERROR_ACCESS_DENIED, GetLastError, STILL_ACTIVE},
        System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    };
    // SAFETY: a query-only handle is requested for an integer PID; no pointers
    // are supplied and the returned handle is closed exactly once below.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        // SAFETY: GetLastError has no arguments and reads this thread's error.
        return unsafe { GetLastError() } == ERROR_ACCESS_DENIED;
    }
    let mut status = 0;
    // SAFETY: handle is live and query-only; status points to a writable u32.
    let queried = unsafe { GetExitCodeProcess(handle, &mut status) };
    // SAFETY: this function owns the non-null handle returned by OpenProcess.
    unsafe {
        CloseHandle(handle);
    }
    queried != 0 && status == STILL_ACTIVE as u32
}

/// Cancellable native input. Tokio's blocking standard-input adapter otherwise
/// prevents runtime shutdown while Chrome keeps the original input open.
#[cfg(unix)]
#[derive(Debug)]
pub enum NativeInput {
    /// Chrome's anonymous pipe.
    Pipe(tokio::net::unix::pipe::Receiver),
    /// libuv child-process stdio uses a stream socket pair.
    Socket(tokio::net::UnixStream),
    /// A redirected regular file has finite, file-backed input.
    File(tokio::fs::File),
}

#[cfg(unix)]
impl tokio::io::AsyncRead for NativeInput {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
        buffer: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            Self::Pipe(input) => {
                tokio::io::AsyncRead::poll_read(std::pin::Pin::new(input), context, buffer)
            }
            Self::Socket(input) => {
                tokio::io::AsyncRead::poll_read(std::pin::Pin::new(input), context, buffer)
            }
            Self::File(input) => {
                tokio::io::AsyncRead::poll_read(std::pin::Pin::new(input), context, buffer)
            }
        }
    }
}

/// Own a duplicate of the native input descriptor without creating an
/// uncancellable blocking read thread for pipes or stream sockets.
///
/// # Errors
/// Returns descriptor, registration, or unsupported-input errors.
#[cfg(unix)]
pub fn native_stdin() -> std::io::Result<NativeInput> {
    use std::os::{fd::AsFd, unix::fs::FileTypeExt};
    let descriptor = std::io::stdin().as_fd().try_clone_to_owned()?;
    let file = std::fs::File::from(descriptor);
    let kind = file.metadata()?.file_type();
    if kind.is_fifo() {
        tokio::net::unix::pipe::Receiver::from_owned_fd(file.into()).map(NativeInput::Pipe)
    } else if kind.is_socket() {
        let stream = std::os::unix::net::UnixStream::from(std::os::fd::OwnedFd::from(file));
        stream.set_nonblocking(true)?;
        tokio::net::UnixStream::from_std(stream).map(NativeInput::Socket)
    } else if kind.is_file() {
        Ok(NativeInput::File(tokio::fs::File::from_std(file)))
    } else {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "Native Messaging stdin must be a pipe, stream socket, or regular file",
        ))
    }
}

/// Windows native input uses Tokio's standard handle adapter.
///
/// # Errors
/// This constructor is infallible; the adapter reports read errors asynchronously.
#[cfg(windows)]
pub fn native_stdin() -> std::io::Result<tokio::io::Stdin> {
    Ok(tokio::io::stdin())
}
