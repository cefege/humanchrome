//! Chrome process groups and the private DevTools pipe transport.

use std::{
    collections::BTreeMap,
    io,
    path::Path,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

#[cfg(windows)]
use std::sync::Mutex as StdMutex;

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Child,
    sync::{Mutex, oneshot},
    task::JoinHandle,
    time,
};

use super::error::FleetRuntimeError;

const DEFAULT_CDP_TIMEOUT: Duration = Duration::from_secs(15);
#[cfg(unix)]
const CDP_REQUEST_FD: libc::c_int = 3;
#[cfg(unix)]
const CDP_RESPONSE_FD: libc::c_int = 4;
const QUIET_PASSES: usize = 3;
type PendingCdpResponse = oneshot::Sender<Result<CdpResponse, FleetRuntimeError>>;
type PendingCdpResponses = Arc<Mutex<BTreeMap<u64, PendingCdpResponse>>>;

/// A decoded response from Chrome's DevTools Protocol.
#[derive(Clone, Debug)]
pub struct CdpResponse {
    /// Request identifier assigned by [`CdpPipe`].
    pub id: u64,
    /// Successful command result, when Chrome provided one.
    pub result: Option<Value>,
    /// Chrome-reported protocol failure, when the command itself completed.
    pub error: Option<String>,
}

impl CdpResponse {
    fn successful(&self, command: &str) -> Result<&Value, FleetRuntimeError> {
        if let Some(error) = &self.error {
            return Err(FleetRuntimeError::Cdp(format!("{command} failed: {error}")));
        }
        self.result
            .as_ref()
            .ok_or_else(|| FleetRuntimeError::Cdp(format!("{command} returned no result")))
    }
}

/// Null-delimited CDP connection held open for a browser's complete lifetime.
#[derive(Debug)]
pub struct CdpPipe {
    writer: Arc<Mutex<tokio::fs::File>>,
    pending: PendingCdpResponses,
    next_id: AtomicU64,
    closed: Arc<AtomicBool>,
    reader: Mutex<Option<JoinHandle<()>>>,
}

impl CdpPipe {
    /// Build a CDP connection from the parent ends of Chrome's fd3/fd4 pipes.
    fn new(input: std::fs::File, output: std::fs::File) -> Self {
        let writer = Arc::new(Mutex::new(tokio::fs::File::from_std(input)));
        let pending = Arc::new(Mutex::new(BTreeMap::new()));
        let closed = Arc::new(AtomicBool::new(false));
        let reader = tokio::spawn(read_responses(
            tokio::fs::File::from_std(output),
            Arc::clone(&pending),
            Arc::clone(&closed),
        ));
        Self {
            writer,
            pending,
            next_id: AtomicU64::new(0),
            closed,
            reader: Mutex::new(Some(reader)),
        }
    }

    /// Send one DevTools command and wait for its matching response.
    ///
    /// # Errors
    /// Returns immediately after pipe closure, after a write failure, or when Chrome does not
    /// answer before `timeout`.
    pub async fn send(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
        session_id: Option<&str>,
    ) -> Result<CdpResponse, FleetRuntimeError> {
        if self.closed.load(Ordering::Acquire) {
            return Err(FleetRuntimeError::Cdp("cdp pipe closed".to_owned()));
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id, sender);
        let mut message = json!({ "id": id, "method": method, "params": params });
        if let Some(session_id) = session_id {
            message["sessionId"] = Value::String(session_id.to_owned());
        }
        let frame = format!(
            "{}\0",
            serde_json::to_string(&message).expect("Value serializes")
        );
        let write = async {
            let mut writer = self.writer.lock().await;
            writer.write_all(frame.as_bytes()).await?;
            writer.flush().await
        };
        if let Err(error) = write.await {
            self.pending.lock().await.remove(&id);
            self.fail_pending().await;
            return Err(FleetRuntimeError::Cdp(format!(
                "cdp pipe write failed: {error}"
            )));
        }
        match time::timeout(timeout, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(FleetRuntimeError::Cdp("cdp pipe closed".to_owned())),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(FleetRuntimeError::Cdp(format!("cdp timeout: {method}")))
            }
        }
    }

    /// Send with the existing fifteen-second command deadline.
    pub async fn send_default(
        &self,
        method: &str,
        params: Value,
    ) -> Result<CdpResponse, FleetRuntimeError> {
        self.send(method, params, DEFAULT_CDP_TIMEOUT, None).await
    }

    /// Load the unpacked HumanChrome extension into the current browser run.
    ///
    /// # Errors
    /// Returns an error if Chrome rejects the extension or does not assign it an identifier.
    pub async fn load_unpacked(&self, extension_dir: &Path) -> Result<String, FleetRuntimeError> {
        let response = self
            .send_default("Extensions.loadUnpacked", json!({ "path": extension_dir }))
            .await?;
        let result = response.successful("Extensions.loadUnpacked")?;
        result
            .get("id")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .ok_or_else(|| {
                FleetRuntimeError::Cdp(
                    "Extensions.loadUnpacked returned no extension id".to_owned(),
                )
            })
    }

    /// Stop reader/writer activity and fail all calls currently awaiting Chrome.
    pub async fn close(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        self.fail_pending().await;
        if let Some(reader) = self.reader.lock().await.take() {
            reader.abort();
        }
    }

    async fn fail_pending(&self) {
        self.closed.store(true, Ordering::Release);
        let pending = std::mem::take(&mut *self.pending.lock().await);
        for sender in pending.into_values() {
            let _ = sender.send(Err(FleetRuntimeError::Cdp("cdp pipe closed".to_owned())));
        }
    }
}

async fn read_responses(
    mut output: tokio::fs::File,
    pending: PendingCdpResponses,
    closed: Arc<AtomicBool>,
) {
    let mut buffered = Vec::new();
    let mut read_buffer = [0_u8; 8192];
    loop {
        let read: usize = output.read(&mut read_buffer).await.unwrap_or_default();
        if read == 0 {
            closed.store(true, Ordering::Release);
            let pending = std::mem::take(&mut *pending.lock().await);
            for sender in pending.into_values() {
                let _ = sender.send(Err(FleetRuntimeError::Cdp("cdp pipe closed".to_owned())));
            }
            return;
        }
        buffered.extend_from_slice(&read_buffer[..read]);
        while let Some(boundary) = buffered.iter().position(|byte| *byte == 0) {
            let frame: Vec<u8> = buffered.drain(..boundary).collect();
            buffered.drain(..1);
            if frame.is_empty() {
                continue;
            }
            let Ok(value) = serde_json::from_slice::<Value>(&frame) else {
                continue;
            };
            let Some(id) = value.get("id").and_then(Value::as_u64) else {
                continue;
            };
            let response = CdpResponse {
                id,
                result: value.get("result").cloned(),
                error: value
                    .get("error")
                    .and_then(|error| error.get("message"))
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
            };
            if let Some(sender) = pending.lock().await.remove(&id) {
                let _ = sender.send(Ok(response));
            }
        }
    }
}

/// A launched browser together with its profile-exclusive CDP connection.
#[derive(Debug)]
pub struct ChromeProcess {
    /// Browser process-group leader PID.
    pub pid: u32,
    /// CDP pipe retained so Chrome cannot block on a full response buffer.
    pub cdp: CdpPipe,
    #[cfg(unix)]
    child: Mutex<Child>,
    #[cfg(windows)]
    child: StdMutex<WindowsProcess>,
}

#[cfg(windows)]
#[derive(Debug)]
struct WindowsProcess {
    process: windows_sys::Win32::Foundation::HANDLE,
    job: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl Drop for WindowsProcess {
    fn drop(&mut self) {
        // SAFETY: both handles are uniquely owned by this launched profile.
        unsafe {
            let _ = windows_sys::Win32::Foundation::CloseHandle(self.job);
            let _ = windows_sys::Win32::Foundation::CloseHandle(self.process);
        }
    }
}

impl ChromeProcess {
    /// Waits for and reaps this owned Unix child without holding up the async executor.
    ///
    /// Cancellation releases the child lock so a caller can signal and terminate the group.
    #[cfg(unix)]
    pub async fn wait_for_exit(&self) -> Result<(), FleetRuntimeError> {
        self.child
            .lock()
            .await
            .wait()
            .await
            .map(|_| ())
            .map_err(|error| {
                FleetRuntimeError::Process(format!("could not reap Chrome {}: {error}", self.pid))
            })
    }

    /// Terminate Chrome's whole containment unit after requesting a graceful browser exit.
    pub async fn terminate(&self, grace: Duration) {
        let _ = self.terminate_checked(grace).await;
    }

    /// Terminate Chrome's private containment unit and prove it no longer holds its profile.
    ///
    /// # Errors
    /// Returns an error when the operating system cannot signal the process group or the browser
    /// remains alive after escalation. The CDP pipe stays open on that failure so the caller can
    /// preserve ownership rather than pretending the browser stopped.
    #[cfg(unix)]
    pub async fn terminate_checked(&self, grace: Duration) -> Result<(), FleetRuntimeError> {
        signal_chrome_group_checked(self.pid, libc::SIGTERM)?;
        let deadline = time::Instant::now() + grace;
        while time::Instant::now() < deadline {
            if self.containment_exited().await? {
                self.cdp.close().await;
                return Ok(());
            }
            time::sleep(Duration::from_millis(100)).await;
        }
        if self.containment_exited().await? {
            self.cdp.close().await;
            return Ok(());
        }
        signal_chrome_group_checked(self.pid, libc::SIGKILL)?;
        let forced_deadline = time::Instant::now() + Duration::from_secs(1);
        while time::Instant::now() < forced_deadline {
            if self.containment_exited().await? {
                self.cdp.close().await;
                return Ok(());
            }
            time::sleep(Duration::from_millis(25)).await;
        }
        if self.containment_exited().await? {
            self.cdp.close().await;
            return Ok(());
        }
        Err(FleetRuntimeError::Process(format!(
            "Chrome process group {} survived termination",
            self.pid
        )))
    }

    /// Terminate Chrome's private containment unit and prove it no longer holds its profile.
    ///
    /// # Errors
    /// Returns an error when Windows cannot terminate the browser's process tree.
    #[cfg(windows)]
    pub async fn terminate_checked(&self, grace: Duration) -> Result<(), FleetRuntimeError> {
        terminate_chrome_checked(self.pid, grace).await?;
        self.cdp.close().await;
        Ok(())
    }

    /// Report that Chromium's private process-containment ABI is unavailable on this platform.
    ///
    /// # Errors
    /// Always reports the unsupported platform.
    #[cfg(not(any(unix, windows)))]
    pub async fn terminate_checked(&self, _grace: Duration) -> Result<(), FleetRuntimeError> {
        Err(FleetRuntimeError::Process(
            "this operating system does not expose Chromium's private process-containment ABI"
                .to_owned(),
        ))
    }

    #[cfg(unix)]
    async fn containment_exited(&self) -> Result<bool, FleetRuntimeError> {
        self.child
            .lock()
            .await
            .try_wait()
            .map(|status| status.is_some() && !chrome_group_is_alive(self.pid))
            .map_err(|error| {
                FleetRuntimeError::Process(format!(
                    "could not reap terminated Chrome {}: {error}",
                    self.pid
                ))
            })
    }
}

/// The Chrome command-line contract used by every fleet browser.
#[must_use]
pub fn chrome_args(user_data_dir: &Path) -> Vec<String> {
    vec![
        format!("--user-data-dir={}", user_data_dir.display()),
        "--no-first-run".to_owned(),
        "--no-default-browser-check".to_owned(),
        "--disable-backgrounding-occluded-windows".to_owned(),
        "--disable-renderer-backgrounding".to_owned(),
        "--disable-blink-features=AutomationControlled".to_owned(),
        "--disable-features=OptimizationGuideModelExecution,OnDeviceModelBackgroundDownload"
            .to_owned(),
        "--remote-debugging-pipe".to_owned(),
    ]
}

/// Refuse a macOS launch before Chrome can open and erase Keychain-encrypted cookies.
///
/// # Errors
/// Reports an inaccessible login Keychain. Other platforms do not use this check.
pub async fn assert_keychain_readable() -> Result<(), FleetRuntimeError> {
    #[cfg(target_os = "macos")]
    {
        let output = tokio::process::Command::new("/usr/bin/security")
            .arg("show-keychain-info")
            .output()
            .await
            .map_err(|error| {
                FleetRuntimeError::Process(format!("could not inspect login Keychain: {error}"))
            })?;
        if !output.status.success() {
            let message = String::from_utf8_lossy(&output.stderr).trim().to_owned();
            return Err(FleetRuntimeError::Profile(format!(
                "this session cannot read the login Keychain ({message})"
            )));
        }
    }
    Ok(())
}

/// Verify that an extension build exists and carries its stable unpacked-extension key.
///
/// # Errors
/// Returns a rebuild-oriented error when the manifest is absent or a JSON error when malformed.
pub async fn read_extension_manifest(
    extension_dir: &Path,
) -> Result<Option<String>, FleetRuntimeError> {
    #[derive(Deserialize)]
    struct Manifest {
        key: Option<String>,
    }
    let path = extension_dir.join("manifest.json");
    let bytes = tokio::fs::read(&path).await.map_err(|error| {
        FleetRuntimeError::Profile(format!(
            "extension build missing at {} — run: pnpm build:extension (or update extensionDir in fleet.json): {error}",
            extension_dir.display()
        ))
    })?;
    let manifest: Manifest = serde_json::from_slice(&bytes)
        .map_err(|source| FleetRuntimeError::Json { path, source })?;
    Ok(manifest.key)
}

/// Disable every persisted extension except HumanChrome before browser automation begins.
///
/// # Errors
/// Reports a missing `chrome://extensions` CDP target or an extension-management failure.
pub async fn disable_foreign_extensions(
    cdp: &CdpPipe,
    keep_id: &str,
    timeout: Duration,
) -> Result<(), FleetRuntimeError> {
    let created = cdp
        .send_default(
            "Target.createTarget",
            json!({ "url": "chrome://extensions/", "background": true }),
        )
        .await?;
    let target_id = created
        .successful("Target.createTarget")?
        .get("targetId")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| {
            FleetRuntimeError::Cdp("Target.createTarget returned no target id".to_owned())
        })?;
    let operation = async {
        let attached = cdp
            .send_default(
                "Target.attachToTarget",
                json!({ "targetId": target_id, "flatten": true }),
            )
            .await?;
        let session_id = attached
            .successful("Target.attachToTarget")?
            .get("sessionId")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .ok_or_else(|| {
                FleetRuntimeError::Cdp("Target.attachToTarget returned no session id".to_owned())
            })?;
        let deadline = time::Instant::now() + timeout;
        let mut quiet = 0;
        let mut last_error = None;
        while quiet < QUIET_PASSES {
            match disable_extension_pass(cdp, &session_id, keep_id).await {
                Ok(disabled) if disabled.is_empty() => quiet += 1,
                Ok(_) => quiet = 0,
                Err(error) => {
                    quiet = 0;
                    last_error = Some(error);
                }
            }
            if quiet >= QUIET_PASSES {
                return Ok(());
            }
            if time::Instant::now() >= deadline {
                return Err(last_error.unwrap_or_else(|| {
                    FleetRuntimeError::Cdp(
                        "foreign extensions kept appearing and were not all disabled".to_owned(),
                    )
                }));
            }
            time::sleep(Duration::from_millis(500)).await;
        }
        Ok(())
    }
    .await;
    let _ = cdp
        .send_default("Target.closeTarget", json!({ "targetId": target_id }))
        .await;
    operation
}

async fn disable_extension_pass(
    cdp: &CdpPipe,
    session_id: &str,
    keep_id: &str,
) -> Result<Vec<String>, FleetRuntimeError> {
    let expression = format!(
        "(async () => {{ const keep = {}; const list = await chrome.developerPrivate.getExtensionsInfo(); const disabled = []; for (const extension of list) {{ if (extension.id === keep || extension.state !== 'ENABLED') continue; await chrome.management.setEnabled(extension.id, false); disabled.push(extension.id); }} return disabled; }})()",
        serde_json::to_string(keep_id).expect("string serializes")
    );
    let response = cdp
        .send(
            "Runtime.evaluate",
            json!({ "expression": expression, "awaitPromise": true, "returnByValue": true }),
            DEFAULT_CDP_TIMEOUT,
            Some(session_id),
        )
        .await?;
    let result = response.successful("Runtime.evaluate")?;
    if let Some(details) = result.get("exceptionDetails") {
        let description = details
            .get("exception")
            .and_then(|exception| exception.get("description"))
            .or_else(|| details.get("text"))
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        return Err(FleetRuntimeError::Cdp(format!(
            "disabling foreign extensions failed: {description}"
        )));
    }
    result
        .get("result")
        .and_then(|result| result.get("value"))
        .and_then(Value::as_array)
        .ok_or_else(|| {
            FleetRuntimeError::Cdp("disabling foreign extensions returned no list".to_owned())
        })?
        .iter()
        .map(|value| {
            value.as_str().map(ToOwned::to_owned).ok_or_else(|| {
                FleetRuntimeError::Cdp(
                    "disabling foreign extensions returned an invalid list".to_owned(),
                )
            })
        })
        .collect()
}

/// Spawn Chrome as a process-group leader and attach a private CDP pipe.
///
/// # Errors
/// Reports pipe, spawn, or process-group setup failures; it never falls back to a network debug port.
#[cfg(unix)]
pub fn spawn_with_cdp_pipe(
    chrome_path: &Path,
    args: &[String],
    environment: &[(String, String)],
) -> Result<ChromeProcess, FleetRuntimeError> {
    use std::os::unix::{io::FromRawFd, process::CommandExt};

    let (request_read, request_write) = create_pipe()?;
    let (response_read, response_write) = create_pipe()?;
    let mut command = std::process::Command::new(chrome_path);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .envs(environment.iter().map(|(key, value)| (key, value)));
    // SAFETY: the closure only uses async-signal-safe libc calls and inherited raw FDs before exec.
    unsafe {
        command.pre_exec(move || {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            if libc::dup2(request_read, CDP_REQUEST_FD) == -1 {
                return Err(io::Error::last_os_error());
            }
            if libc::dup2(response_write, CDP_RESPONSE_FD) == -1 {
                return Err(io::Error::last_os_error());
            }
            for fd in [request_read, request_write, response_read, response_write] {
                if fd != CDP_REQUEST_FD && fd != CDP_RESPONSE_FD {
                    let _ = libc::close(fd);
                }
            }
            Ok(())
        });
    }
    let child = match tokio::process::Command::from(command).spawn() {
        Ok(child) => child,
        Err(error) => {
            close_fd(request_read);
            close_fd(request_write);
            close_fd(response_read);
            close_fd(response_write);
            return Err(FleetRuntimeError::io(chrome_path, error));
        }
    };
    close_fd(request_read);
    close_fd(response_write);
    let pid = child
        .id()
        .expect("a newly spawned Chrome child retains its PID");
    // SAFETY: this process owns these two pipe ends after the child inherited the opposite ends.
    let input = unsafe { std::fs::File::from_raw_fd(request_write) };
    // SAFETY: this process owns these two pipe ends after the child inherited the opposite ends.
    let output = unsafe { std::fs::File::from_raw_fd(response_read) };
    Ok(ChromeProcess {
        pid,
        cdp: CdpPipe::new(input, output),
        child: Mutex::new(child),
    })
}

/// Spawn Chrome with the same CRT fd 3/4 contract used by Chromium's Windows
/// DevTools pipe handler. The handle-list attribute prevents unrelated
/// inheritable handles from leaking into Chrome.
#[cfg(windows)]
pub fn spawn_with_cdp_pipe(
    chrome_path: &Path,
    args: &[String],
    environment: &[(String, String)],
) -> Result<ChromeProcess, FleetRuntimeError> {
    use std::os::windows::io::FromRawHandle;
    let (request_read, request_write) = create_windows_pipe()?;
    let (response_read, response_write) = match create_windows_pipe() {
        Ok(pipe) => pipe,
        Err(error) => {
            // SAFETY: the first pipe is still entirely owned by this process.
            unsafe {
                let _ = windows_sys::Win32::Foundation::CloseHandle(request_read);
                let _ = windows_sys::Win32::Foundation::CloseHandle(request_write);
            }
            return Err(error);
        }
    };

    if let Err(error) = clear_windows_handle_inheritance(request_write)
        .and_then(|()| clear_windows_handle_inheritance(response_read))
    {
        // SAFETY: neither pipe has reached CreateProcess, so all four ends
        // remain locally owned on this failure path.
        unsafe {
            for handle in [request_read, request_write, response_read, response_write] {
                let _ = windows_sys::Win32::Foundation::CloseHandle(handle);
            }
        }
        return Err(error);
    }
    let nul_input = match create_nul_handle(true) {
        Ok(handle) => handle,
        Err(error) => {
            // SAFETY: setup failed before any handle was transferred to Chrome.
            unsafe {
                for handle in [request_read, request_write, response_read, response_write] {
                    let _ = windows_sys::Win32::Foundation::CloseHandle(handle);
                }
            }
            return Err(error);
        }
    };
    let nul_output = match create_nul_handle(false) {
        Ok(handle) => handle,
        Err(error) => {
            // SAFETY: setup failed before any handle was transferred to Chrome.
            unsafe {
                for handle in [
                    nul_input,
                    request_read,
                    request_write,
                    response_read,
                    response_write,
                ] {
                    let _ = windows_sys::Win32::Foundation::CloseHandle(handle);
                }
            }
            return Err(error);
        }
    };
    let nul_error = match create_nul_handle(false) {
        Ok(handle) => handle,
        Err(error) => {
            // SAFETY: setup failed before any handle was transferred to Chrome.
            unsafe {
                for handle in [
                    nul_input,
                    nul_output,
                    request_read,
                    request_write,
                    response_read,
                    response_write,
                ] {
                    let _ = windows_sys::Win32::Foundation::CloseHandle(handle);
                }
            }
            return Err(error);
        }
    };

    let child_handles = [
        nul_input,
        nul_output,
        nul_error,
        request_read,
        response_write,
    ];
    let spawned = launch_windows_process(chrome_path, args, environment, &child_handles);

    // SAFETY: CreateProcess has completed. These are the child-only copies and
    // the NUL descriptors which are no longer needed in this process.
    unsafe {
        for handle in [
            nul_input,
            nul_output,
            nul_error,
            request_read,
            response_write,
        ] {
            let _ = windows_sys::Win32::Foundation::CloseHandle(handle);
        }
    }

    let (process, job, pid) = match spawned {
        Ok(spawned) => spawned,
        Err(error) => {
            // SAFETY: launch did not consume the parent ends on failure.
            unsafe {
                let _ = windows_sys::Win32::Foundation::CloseHandle(request_write);
                let _ = windows_sys::Win32::Foundation::CloseHandle(response_read);
            }
            return Err(error);
        }
    };
    // SAFETY: after the child copies closed above, these parent endpoints are
    // exclusively owned by the `File`s and then by the CDP transport.
    let input = unsafe { std::fs::File::from_raw_handle(request_write) };
    // SAFETY: see the corresponding input-handle ownership transfer.
    let output = unsafe { std::fs::File::from_raw_handle(response_read) };
    Ok(ChromeProcess {
        pid,
        cdp: CdpPipe::new(input, output),
        child: StdMutex::new(WindowsProcess { process, job }),
    })
}

/// The platform must provide Chromium's fd3/fd4 DevTools-pipe ABI; this
/// runtime never changes the transport to a TCP debug port.
#[cfg(not(any(unix, windows)))]
pub fn spawn_with_cdp_pipe(
    _chrome_path: &Path,
    _args: &[String],
    _environment: &[(String, String)],
) -> Result<ChromeProcess, FleetRuntimeError> {
    Err(FleetRuntimeError::Process(
        "this operating system does not expose Chromium's private CDP pipe ABI".to_owned(),
    ))
}

#[cfg(windows)]
fn create_windows_pipe() -> Result<
    (
        windows_sys::Win32::Foundation::HANDLE,
        windows_sys::Win32::Foundation::HANDLE,
    ),
    FleetRuntimeError,
> {
    use std::{mem::size_of, ptr};
    use windows_sys::Win32::{
        Foundation::{GetLastError, HANDLE},
        Security::SECURITY_ATTRIBUTES,
        System::Pipes::CreatePipe,
    };

    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: ptr::null_mut(),
        bInheritHandle: 1,
    };
    let (mut read, mut write): (HANDLE, HANDLE) = (ptr::null_mut(), ptr::null_mut());
    // SAFETY: all pointers are valid writable storage and the attributes live
    // through the call. A successful pipe yields two handles owned here.
    if unsafe { CreatePipe(&mut read, &mut write, &attributes, 0) } == 0 {
        // SAFETY: GetLastError is valid immediately after the failing Win32 call.
        let code = unsafe { GetLastError() };
        return Err(FleetRuntimeError::Process(format!(
            "could not create Chrome CDP pipe (Win32 error {code})"
        )));
    }
    Ok((read, write))
}

#[cfg(windows)]
fn clear_windows_handle_inheritance(
    handle: windows_sys::Win32::Foundation::HANDLE,
) -> Result<(), FleetRuntimeError> {
    use windows_sys::Win32::Foundation::{GetLastError, HANDLE_FLAG_INHERIT, SetHandleInformation};

    // SAFETY: `handle` is a valid pipe endpoint owned by this process.
    if unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) } == 0 {
        // SAFETY: GetLastError is valid immediately after the failing Win32 call.
        let code = unsafe { GetLastError() };
        return Err(FleetRuntimeError::Process(format!(
            "could not mark parent CDP pipe private (Win32 error {code})"
        )));
    }
    Ok(())
}

#[cfg(windows)]
fn create_nul_handle(
    read: bool,
) -> Result<windows_sys::Win32::Foundation::HANDLE, FleetRuntimeError> {
    use std::{mem::size_of, ptr};
    use windows_sys::Win32::{
        Foundation::{GetLastError, INVALID_HANDLE_VALUE},
        Security::SECURITY_ATTRIBUTES,
        Storage::FileSystem::{
            CreateFileW, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
        },
    };

    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: ptr::null_mut(),
        bInheritHandle: 1,
    };
    let access = if read {
        FILE_GENERIC_READ
    } else {
        FILE_GENERIC_WRITE | FILE_READ_ATTRIBUTES
    };
    // SAFETY: `NUL` is a static, NUL-terminated wide string and all remaining
    // pointers/handles follow CreateFileW's documented null conventions.
    let handle = unsafe {
        CreateFileW(
            [b'N' as u16, b'U' as u16, b'L' as u16, 0].as_ptr(),
            access,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            &attributes,
            OPEN_EXISTING,
            0,
            ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        // SAFETY: GetLastError is valid immediately after the failing Win32 call.
        let code = unsafe { GetLastError() };
        return Err(FleetRuntimeError::Process(format!(
            "could not create inherited NUL descriptor (Win32 error {code})"
        )));
    }
    Ok(handle)
}

#[cfg(windows)]
fn launch_windows_process(
    chrome_path: &Path,
    args: &[String],
    environment: &[(String, String)],
    child_handles: &[windows_sys::Win32::Foundation::HANDLE; 5],
) -> Result<
    (
        windows_sys::Win32::Foundation::HANDLE,
        windows_sys::Win32::Foundation::HANDLE,
        u32,
    ),
    FleetRuntimeError,
> {
    use std::{
        mem::{size_of, size_of_val},
        os::windows::ffi::OsStrExt,
        ptr,
    };
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, INVALID_HANDLE_VALUE},
        System::{
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
                SetInformationJobObject,
            },
            Threading::{
                CREATE_UNICODE_ENVIRONMENT, CreateProcessW, DeleteProcThreadAttributeList,
                EXTENDED_STARTUPINFO_PRESENT, InitializeProcThreadAttributeList,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROCESS_INFORMATION, STARTF_USESTDHANDLES,
                STARTUPINFOEXW, UpdateProcThreadAttribute,
            },
        },
    };

    let application_name = chrome_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut command_line = quote_windows_command_line(chrome_path, args);
    let mut environment_block = windows_environment_block(environment);
    let mut stdio = windows_crt_stdio_block(child_handles);
    let cb_reserved2 = u16::try_from(stdio.len()).map_err(|_| {
        FleetRuntimeError::Process("Windows CRT fd table exceeds STARTUPINFO capacity".to_owned())
    })?;

    let mut attribute_size = 0;
    // SAFETY: the first call is the documented size probe; it returns false
    // with ERROR_INSUFFICIENT_BUFFER and does not dereference the null list.
    unsafe {
        let _ = InitializeProcThreadAttributeList(ptr::null_mut(), 1, 0, &mut attribute_size);
    }
    if attribute_size == 0 {
        // SAFETY: retrieves the failure code from the immediately preceding probe.
        let code = unsafe { GetLastError() };
        return Err(FleetRuntimeError::Process(format!(
            "could not size Chrome handle-list attribute (Win32 error {code})"
        )));
    }
    let word_count = attribute_size.div_ceil(size_of::<usize>());
    let mut attribute_storage = vec![0_usize; word_count];
    let attribute_list = attribute_storage
        .as_mut_ptr()
        .cast::<core::ffi::c_void>()
        .cast::<windows_sys::Win32::System::Threading::PROC_THREAD_ATTRIBUTE_LIST>(
    );
    // SAFETY: allocated storage has the required size and alignment.
    if unsafe { InitializeProcThreadAttributeList(attribute_list, 1, 0, &mut attribute_size) } == 0
    {
        // SAFETY: retrieves the failure code from the immediately preceding call.
        let code = unsafe { GetLastError() };
        return Err(FleetRuntimeError::Process(format!(
            "could not initialize Chrome handle-list attribute (Win32 error {code})"
        )));
    }
    // SAFETY: this exact five-handle list is the entire intended inheritance
    // surface: NUL fds 0–2 and Chrome's private CDP fds 3–4.
    let attribute_result = unsafe {
        UpdateProcThreadAttribute(
            attribute_list,
            0,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            child_handles.as_ptr().cast(),
            size_of_val(child_handles),
            ptr::null_mut(),
            ptr::null(),
        )
    };
    if attribute_result == 0 {
        // SAFETY: retrieves the failure code before cleanup may overwrite it.
        let code = unsafe { GetLastError() };
        // SAFETY: the initialized attribute list must be released exactly once.
        unsafe { DeleteProcThreadAttributeList(attribute_list) };
        return Err(FleetRuntimeError::Process(format!(
            "could not restrict Chrome inherited handles (Win32 error {code})"
        )));
    }
    // SAFETY: null security/name request a private job. Its ownership transfers
    // to the returned ChromeProcess only after Chrome is assigned successfully.
    let job = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
    if job.is_null() {
        // SAFETY: retrieves the failure code before cleanup may overwrite it.
        let code = unsafe { GetLastError() };
        // SAFETY: releases the initialized attribute list before returning.
        unsafe { DeleteProcThreadAttributeList(attribute_list) };
        return Err(FleetRuntimeError::Process(format!(
            "could not create Chrome containment job (Win32 error {code})"
        )));
    }
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    // SAFETY: `limits` is a correctly sized, initialized extended-limit value.
    if unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    } == 0
    {
        // SAFETY: retrieves the failure code before cleanup may overwrite it.
        let code = unsafe { GetLastError() };
        // SAFETY: both resources were initialized in this function and remain owned here.
        unsafe {
            DeleteProcThreadAttributeList(attribute_list);
            let _ = CloseHandle(job);
        }
        return Err(FleetRuntimeError::Process(format!(
            "could not configure Chrome containment job (Win32 error {code})"
        )));
    }

    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.cbReserved2 = cb_reserved2;
    startup.StartupInfo.lpReserved2 = stdio.as_mut_ptr();
    startup.StartupInfo.hStdInput = child_handles[0];
    startup.StartupInfo.hStdOutput = child_handles[1];
    startup.StartupInfo.hStdError = child_handles[2];
    startup.lpAttributeList = attribute_list;
    let mut process_information = PROCESS_INFORMATION::default();
    // SAFETY: application and command line are NUL-terminated UTF-16,
    // STARTUPINFOEX contains valid owned buffers through the call, and the
    // explicit handle list makes `bInheritHandles=TRUE` race-free.
    let created = unsafe {
        CreateProcessW(
            application_name.as_ptr(),
            command_line.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            1,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
            environment_block.as_mut_ptr().cast(),
            ptr::null(),
            &startup.StartupInfo,
            &mut process_information,
        )
    };
    // SAFETY: the attribute list is no longer consulted once CreateProcessW returns.
    unsafe { DeleteProcThreadAttributeList(attribute_list) };
    if created == 0 {
        // SAFETY: retrieve the failure before closing the locally owned job.
        let code = unsafe { GetLastError() };
        // SAFETY: the job remains owned locally on this failure path.
        unsafe {
            let _ = CloseHandle(job);
        }
        return Err(FleetRuntimeError::Process(format!(
            "could not launch Chrome with private CDP pipe (Win32 error {code})"
        )));
    }
    // SAFETY: Chrome's primary thread handle is no longer needed. A successful
    // assignment makes all Chromium helper processes part of the private job.
    let assigned = unsafe { AssignProcessToJobObject(job, process_information.hProcess) };
    unsafe {
        let _ = CloseHandle(process_information.hThread);
    }
    if assigned == 0 {
        // SAFETY: retrieve the failure before cleanup may overwrite it.
        let code = unsafe { GetLastError() };
        // SAFETY: this process and job are still owned locally; kill before
        // closing so no browser can retain the profile lock.
        unsafe {
            let _ = windows_sys::Win32::System::Threading::TerminateProcess(
                process_information.hProcess,
                1,
            );
            let _ = CloseHandle(process_information.hProcess);
            let _ = CloseHandle(job);
        }
        return Err(FleetRuntimeError::Process(format!(
            "could not assign Chrome to containment job (Win32 error {code})"
        )));
    }
    debug_assert_ne!(process_information.hProcess, INVALID_HANDLE_VALUE);
    Ok((
        process_information.hProcess,
        job,
        process_information.dwProcessId,
    ))
}

#[cfg(windows)]
fn windows_crt_stdio_block(handles: &[windows_sys::Win32::Foundation::HANDLE; 5]) -> Vec<u8> {
    const FOPEN: u8 = 0x01;
    const FPIPE: u8 = 0x08;
    const FDEV: u8 = 0x40;
    let mut block = Vec::with_capacity(
        std::mem::size_of::<u32>() + handles.len() + handles.len() * std::mem::size_of::<usize>(),
    );
    block.extend_from_slice(&(handles.len() as u32).to_ne_bytes());
    block.extend_from_slice(&[
        FOPEN | FDEV,
        FOPEN | FDEV,
        FOPEN | FDEV,
        FOPEN | FPIPE,
        FOPEN | FPIPE,
    ]);
    for handle in handles {
        block.extend_from_slice(&(*handle as usize).to_ne_bytes());
    }
    block
}

#[cfg(windows)]
fn windows_environment_block(environment: &[(String, String)]) -> Vec<u16> {
    let mut block = Vec::new();
    for (key, value) in environment {
        block.extend(key.encode_utf16());
        block.push(b'=' as u16);
        block.extend(value.encode_utf16());
        block.push(0);
    }
    block.push(0);
    block
}

#[cfg(windows)]
fn quote_windows_command_line(chrome_path: &Path, args: &[String]) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;

    let mut command_line = Vec::new();
    append_windows_argument(
        &mut command_line,
        &chrome_path.as_os_str().encode_wide().collect::<Vec<_>>(),
    );
    for argument in args {
        command_line.push(b' ' as u16);
        append_windows_argument(
            &mut command_line,
            &argument.encode_utf16().collect::<Vec<_>>(),
        );
    }
    command_line.push(0);
    command_line
}

#[cfg(windows)]
fn append_windows_argument(command_line: &mut Vec<u16>, argument: &[u16]) {
    let needs_quotes = argument.is_empty()
        || argument
            .iter()
            .any(|character| matches!(*character, 9 | 10 | 11 | 12 | 13 | 32 | 0x22));
    if !needs_quotes {
        command_line.extend_from_slice(argument);
        return;
    }
    command_line.push(b'"' as u16);
    let mut backslashes = 0;
    for &character in argument {
        if character == b'\\' as u16 {
            backslashes += 1;
        } else if character == b'"' as u16 {
            command_line.extend(std::iter::repeat(b'\\' as u16).take(backslashes * 2 + 1));
            command_line.push(character);
            backslashes = 0;
        } else {
            command_line.extend(std::iter::repeat(b'\\' as u16).take(backslashes));
            command_line.push(character);
            backslashes = 0;
        }
    }
    command_line.extend(std::iter::repeat(b'\\' as u16).take(backslashes * 2));
    command_line.push(b'"' as u16);
}

#[cfg(unix)]
fn create_pipe() -> Result<(libc::c_int, libc::c_int), FleetRuntimeError> {
    let mut descriptors = [-1, -1];
    // Match Node/libuv's "pipe" stdio: Chromium's Unix transport shuts these
    // descriptors down as sockets when the private connection is disposed.
    // SAFETY: `descriptors` is valid writable storage for socketpair's two results.
    if unsafe {
        libc::socketpair(
            libc::AF_UNIX,
            libc::SOCK_STREAM,
            0,
            descriptors.as_mut_ptr(),
        )
    } == -1
    {
        return Err(FleetRuntimeError::Process(format!(
            "could not create Chrome CDP pipe: {}",
            io::Error::last_os_error()
        )));
    }
    for descriptor in descriptors {
        // SAFETY: each descriptor came from `socketpair` above and remains owned here.
        if unsafe { libc::fcntl(descriptor, libc::F_SETFD, libc::FD_CLOEXEC) } == -1 {
            close_fd(descriptors[0]);
            close_fd(descriptors[1]);
            return Err(FleetRuntimeError::Process(format!(
                "could not protect Chrome CDP pipe: {}",
                io::Error::last_os_error()
            )));
        }
    }
    Ok((descriptors[0], descriptors[1]))
}

#[cfg(unix)]
fn close_fd(descriptor: libc::c_int) {
    // SAFETY: caller passes an owned pipe descriptor; close is best effort during cleanup.
    let _ = unsafe { libc::close(descriptor) };
}

/// Terminate Chrome's process containment unit without leaving helpers holding
/// the profile directory.
pub async fn terminate_chrome(pid: u32, grace: Duration) {
    let _ = terminate_chrome_checked(pid, grace).await;
}

/// Terminate Chrome's containment unit and verify it no longer owns the profile directory.
///
/// # Errors
/// Returns an error if the process cannot be signalled or survives forced termination.
pub async fn terminate_chrome_checked(pid: u32, grace: Duration) -> Result<(), FleetRuntimeError> {
    if pid == 0 {
        return Ok(());
    }
    #[cfg(unix)]
    {
        if !chrome_group_is_alive(pid) {
            return Ok(());
        }
        signal_chrome_group_checked(pid, libc::SIGTERM)?;
        let deadline = time::Instant::now() + grace;
        while time::Instant::now() < deadline && chrome_group_is_alive(pid) {
            time::sleep(Duration::from_millis(100)).await;
        }
        if chrome_group_is_alive(pid) {
            signal_chrome_group_checked(pid, libc::SIGKILL)?;
            let forced_deadline = time::Instant::now() + Duration::from_secs(1);
            while time::Instant::now() < forced_deadline && chrome_group_is_alive(pid) {
                time::sleep(Duration::from_millis(25)).await;
            }
        }
        if chrome_group_is_alive(pid) {
            return Err(FleetRuntimeError::Process(format!(
                "Chrome process group {pid} survived termination"
            )));
        }
    }
    #[cfg(windows)]
    {
        let numeric_pid = pid;
        let pid = numeric_pid.to_string();
        let graceful = tokio::process::Command::new("taskkill")
            .args(["/PID", &pid, "/T"])
            .status();
        let _ = time::timeout(grace, graceful).await;
        if crate::platform::process_is_alive(numeric_pid) {
            tokio::process::Command::new("taskkill")
                .args(["/PID", &pid, "/T", "/F"])
                .status()
                .await
                .map_err(|error| {
                    FleetRuntimeError::Process(format!(
                        "could not force-stop Chrome {numeric_pid}: {error}"
                    ))
                })?;
        }
        if crate::platform::process_is_alive(numeric_pid) {
            return Err(FleetRuntimeError::Process(format!(
                "Chrome process {numeric_pid} survived termination"
            )));
        }
    }
    Ok(())
}

#[cfg(unix)]
fn signal_chrome_group_checked(pid: u32, signal: libc::c_int) -> Result<(), FleetRuntimeError> {
    let raw = libc::pid_t::try_from(pid).map_err(|_| {
        FleetRuntimeError::Process(format!("Chrome pid {pid} is outside the platform range"))
    })?;
    // SAFETY: negative PID addresses only the process group created by `setsid`; no pointers are used.
    if unsafe { libc::kill(-raw, signal) } == 0 {
        return Ok(());
    }
    let group_error = std::io::Error::last_os_error();
    // SAFETY: this fallback only addresses the intended process group leader.
    if unsafe { libc::kill(raw, signal) } == 0 {
        return Ok(());
    }
    let process_error = std::io::Error::last_os_error();
    if process_error.raw_os_error() == Some(libc::ESRCH) {
        return Ok(());
    }
    Err(FleetRuntimeError::Process(format!(
        "could not signal Chrome process group {pid}: {group_error}; fallback: {process_error}"
    )))
}

#[cfg(unix)]
fn chrome_group_is_alive(pid: u32) -> bool {
    let Ok(raw) = libc::pid_t::try_from(pid) else {
        return false;
    };
    // SAFETY: signal zero probes only the private process group and cannot deliver a signal.
    let result = unsafe { libc::kill(-raw, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Find only top-level Chrome browser processes currently using `user_data_dir`.
#[cfg(unix)]
pub async fn find_chrome_for_profile(
    chrome_path: &Path,
    user_data_dir: &Path,
) -> Result<Vec<u32>, FleetRuntimeError> {
    let output = tokio::process::Command::new("ps")
        .args(["-Ao", "pid=,command="])
        .output()
        .await
        .map_err(|error| {
            FleetRuntimeError::Process(format!("could not inspect Chrome processes: {error}"))
        })?;
    if !output.status.success() {
        return Err(FleetRuntimeError::Process(format!(
            "Chrome process inspection failed ({}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(match_profile_processes(
        String::from_utf8_lossy(&output.stdout).lines(),
        chrome_path,
        user_data_dir,
    ))
}

/// Query Windows' process provider rather than guessing from a debug port.
#[cfg(windows)]
pub async fn find_chrome_for_profile(
    chrome_path: &Path,
    user_data_dir: &Path,
) -> Result<Vec<u32>, FleetRuntimeError> {
    let output = tokio::process::Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | ForEach-Object { [Console]::Write($_.ProcessId); [Console]::Write(\"`t\"); [Console]::Write($_.CommandLine); [Console]::Write(\"`0\") }",
        ])
        .output()
        .await
        .map_err(|error| FleetRuntimeError::Process(format!("could not inspect Chrome processes: {error}")))?;
    if !output.status.success() {
        return Err(FleetRuntimeError::Process(format!(
            "Windows process provider failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    let records = String::from_utf8_lossy(&output.stdout);
    let mut matches = Vec::new();
    let marker = format!("--user-data-dir={}", user_data_dir.display());
    for record in records.split('\0') {
        let Some((pid, command)) = record.split_once('\t') else {
            continue;
        };
        if profile_command_matches(command, chrome_path, &marker) {
            if let Ok(pid) = pid.parse() {
                matches.push(pid);
            }
        }
    }
    matches.sort_unstable();
    matches.dedup();
    Ok(matches)
}

#[cfg(not(any(unix, windows)))]
pub async fn find_chrome_for_profile(
    _chrome_path: &Path,
    _user_data_dir: &Path,
) -> Result<Vec<u32>, FleetRuntimeError> {
    Err(FleetRuntimeError::Process(
        "this operating system has no supported Chrome process inspector".to_owned(),
    ))
}

#[cfg(unix)]
fn match_profile_processes<'a>(
    lines: impl Iterator<Item = &'a str>,
    chrome_path: &Path,
    user_data_dir: &Path,
) -> Vec<u32> {
    let marker = format!("--user-data-dir={}", user_data_dir.display());
    let mut pids = lines
        .filter_map(|line| {
            let trimmed = line.trim_start();
            let (pid, command) = trimmed.split_once(char::is_whitespace)?;
            profile_command_matches(command, chrome_path, &marker)
                .then(|| pid.parse::<u32>().ok())
                .flatten()
        })
        .collect::<Vec<_>>();
    pids.sort_unstable();
    pids.dedup();
    pids
}

fn profile_command_matches(command: &str, chrome_path: &Path, marker: &str) -> bool {
    let command = command.trim_start().trim_start_matches('"');
    let Some(arguments) = command.strip_prefix(chrome_path.to_string_lossy().as_ref()) else {
        return false;
    };
    let arguments = arguments.strip_prefix('"').unwrap_or(arguments);
    if !arguments.starts_with(char::is_whitespace) || arguments.contains("--type=") {
        return false;
    }
    arguments.match_indices(marker).any(|(offset, matched)| {
        let before = &arguments[..offset];
        let after = &arguments[offset + matched.len()..];
        before
            .strip_suffix('"')
            .unwrap_or(before)
            .chars()
            .next_back()
            .is_none_or(char::is_whitespace)
            && after
                .strip_prefix('"')
                .unwrap_or(after)
                .chars()
                .next()
                .is_none_or(char::is_whitespace)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn profile_process_match_requires_browser_and_exact_user_data_argument() {
        let chrome = Path::new("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
        let profile = Path::new("/tmp/humanchrome/profiles/alice");
        let lines = [
            "101 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/humanchrome/profiles/alice",
            "102 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome Helper --type=renderer --user-data-dir=/tmp/humanchrome/profiles/alice",
            "103 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/humanchrome/profiles/bob",
            "104 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/humanchrome/profiles/alice2",
            "105 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --label=--user-data-dir=/tmp/humanchrome/profiles/alice",
        ];
        assert_eq!(
            match_profile_processes(lines.iter().copied(), chrome, profile),
            vec![101]
        );
    }

    #[cfg(windows)]
    #[test]
    fn crt_stdio_block_matches_chromiums_fd_three_and_four_abi() {
        use windows_sys::Win32::Foundation::HANDLE;

        let handles = [1_usize, 2, 3, 4, 5].map(|handle| handle as HANDLE);
        let block = windows_crt_stdio_block(&handles);
        assert_eq!(&block[..4], &(5_u32).to_ne_bytes());
        assert_eq!(&block[4..9], &[0x41, 0x41, 0x41, 0x09, 0x09]);
        let width = std::mem::size_of::<usize>();
        for (index, handle) in handles.into_iter().enumerate() {
            let start = 9 + index * width;
            assert_eq!(
                &block[start..start + width],
                &(handle as usize).to_ne_bytes()
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn command_line_escapes_quoted_and_trailing_backslash_arguments() {
        let command = quote_windows_command_line(
            Path::new(r"C:\Program Files\Google\chrome.exe"),
            &[
                r#"--user-data-dir=C:\profiles\A B\"#.to_owned(),
                r#"a"b"#.to_owned(),
            ],
        );
        let command = String::from_utf16(&command[..command.len() - 1]).unwrap();
        assert_eq!(
            command,
            r#""C:\Program Files\Google\chrome.exe" "--user-data-dir=C:\profiles\A B\\" "a\"b""#
        );
    }
}
