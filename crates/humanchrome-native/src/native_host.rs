//! Native Messaging lifecycle, source replacement, and one owned request-correlation actor.

use std::{
    future::pending,
    io,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use humanchrome_core::{arguments::JsString, json_document::JsonDocument};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
    time::{Instant, sleep_until},
};
use uuid::Uuid;

use crate::{
    codec::{CodecEvent, MAX_FRAMES_PER_TICK, NativeCodec, encode_frame_into},
    daemon::{self, DaemonMode, DaemonRole},
    fleet::{
        config::ConfigStore,
        purpose_guard::{self, ProtectionCache},
    },
    ipc::{self, CallToolEnvelopeInput},
    paths::NativePaths,
    pending::{PendingError, PendingRequests, PendingResult, RequestKind, RequestSpec},
    registry::InstanceRegistry,
};

/// Identity announced by Chrome; only START updates it.
#[derive(Clone, Debug, Default)]
pub struct RemoteIdentity {
    /// Extension identity for registry records.
    pub extension_id: Option<String>,
    /// Service-worker instance identity, if supplied.
    pub instance_id: Option<String>,
}

/// One extension request; missing payload and explicit null remain distinct.
#[derive(Debug)]
pub struct ExtensionRequest {
    /// Native message type, including forward-compatible extension-specific types.
    pub message_type: String,
    /// Omitted payload remains omitted on the wire.
    pub payload: Option<JsonDocument>,
    /// Top-level trusted MCP client identity.
    pub client_id: Option<String>,
    /// Per-operation override; otherwise generic/tool defaults apply.
    pub timeout_ms: Option<u64>,
    /// Optional pre-generated correlation ID for request-scoped logging.
    pub request_id: Option<Uuid>,
}

impl ExtensionRequest {
    /// Construct a generic request without inventing caller identity or retries.
    pub fn new(message_type: impl Into<String>, payload: Option<JsonDocument>) -> Self {
        Self {
            message_type: message_type.into(),
            payload,
            client_id: None,
            timeout_ms: None,
            request_id: None,
        }
    }
}

/// A cheap cloneable handle; pending state is never shared outside the actor.
#[derive(Clone, Debug)]
pub struct NativeClient {
    sender: mpsc::UnboundedSender<Command>,
    identity: watch::Receiver<RemoteIdentity>,
}

impl NativeClient {
    /// Request one extension response through the owned pending map.
    ///
    /// # Errors
    /// Returns the existing capacity, timeout, source-loss or extension failure.
    pub async fn request(&self, request: ExtensionRequest) -> PendingResult {
        let (response, receiver) = oneshot::channel();
        self.sender
            .send(Command::Request { request, response })
            .map_err(|_| PendingError::SourceUnavailable)?;
        receiver
            .await
            .map_err(|_| PendingError::SourceDisconnected)?
    }

    /// Queue a protocol notification, never a delivery acknowledgement.
    pub fn notify(&self, message: JsonDocument) -> bool {
        self.sender.send(Command::Notify(message)).is_ok()
    }

    /// Snapshot Chrome's announced identity without holding a watch guard across effects.
    #[must_use]
    pub fn remote_identity(&self) -> RemoteIdentity {
        self.identity.borrow().clone()
    }

    /// Stop an owned actor after the application has drained its serving boundary.
    pub fn shutdown(&self) {
        let _ = self.sender.send(Command::Shutdown);
    }
}

#[derive(Debug)]
enum Command {
    Request {
        request: ExtensionRequest,
        response: oneshot::Sender<PendingResult>,
    },
    Prepared {
        request_id: Uuid,
        result: Result<JsonDocument, String>,
    },
    Notify(JsonDocument),
    Shutdown,
}

#[derive(Debug)]
enum SourceEvent {
    Inbound { generation: u64, event: CodecEvent },
    Closed { generation: u64 },
}

#[derive(Debug)]
struct Source {
    output: mpsc::UnboundedSender<JsonDocument>,
    reader: JoinHandle<()>,
    writer: JoinHandle<()>,
}

impl Source {
    fn close(self) {
        self.reader.abort();
        self.writer.abort();
    }
}

#[derive(Debug)]
struct ToolProtection {
    cache: ProtectionCache,
    config: ConfigStore,
    profile: Option<String>,
}

/// Owns framed I/O, request deadlines, source generation and primary/relay lifetime.
#[derive(Debug)]
pub struct NativeHost {
    paths: NativePaths,
    commands: mpsc::UnboundedReceiver<Command>,
    sender: mpsc::UnboundedSender<Command>,
    events: mpsc::Receiver<SourceEvent>,
    event_sender: mpsc::Sender<SourceEvent>,
    directives: mpsc::UnboundedSender<JsonDocument>,
    identity: watch::Sender<RemoteIdentity>,
    source: Option<Source>,
    generation: u64,
    pending: PendingRequests,
    origin: Instant,
    protection: Arc<ToolProtection>,
}

impl NativeHost {
    /// Create the actor and its application boundary. START/STOP/file directives
    /// are delivered unchanged to their native effect owner, not acknowledged early.
    #[must_use]
    pub fn new(paths: NativePaths) -> (Self, NativeClient, mpsc::UnboundedReceiver<JsonDocument>) {
        let (sender, commands) = mpsc::unbounded_channel();
        let (event_sender, events) = mpsc::channel(MAX_FRAMES_PER_TICK);
        let (directives, receiver) = mpsc::unbounded_channel();
        let (identity, identity_receiver) = watch::channel(RemoteIdentity::default());
        let client = NativeClient {
            sender: sender.clone(),
            identity: identity_receiver,
        };
        let protection = Arc::new(ToolProtection {
            cache: ProtectionCache::default(),
            config: ConfigStore::new(paths.fleet.clone(), paths.home.clone()),
            profile: std::env::var("HC_FLEET_PROFILE")
                .ok()
                .filter(|profile| !profile.is_empty()),
        });
        let host = Self {
            paths,
            commands,
            sender,
            events,
            event_sender,
            directives,
            identity,
            source: None,
            generation: 0,
            pending: PendingRequests::new(),
            origin: Instant::now(),
            protection,
        };
        (host, client, receiver)
    }

    /// Select primary/relay/standalone and serve until an owned terminal transition.
    ///
    /// # Errors
    /// Reports startup and signal-registration errors; wire errors remain framed responses.
    pub async fn run(mut self) -> io::Result<()> {
        let registry = InstanceRegistry::new(self.paths.registry.clone());
        registry.list(epoch_millis()).await;
        let role =
            daemon::choose_role(&self.paths.daemon_socket, DaemonMode::from_environment()).await?;
        #[cfg(unix)]
        let primary = match role {
            DaemonRole::Relay(stream) => {
                tokio::select! { () = daemon::run_relay(stream) => {}, result = termination_signal() => { result?; } }
                return Ok(());
            }
            DaemonRole::Primary(primary) => Some(primary),
            DaemonRole::Standalone => None,
        };
        #[cfg(not(unix))]
        let primary: Option<()> = {
            let _ = role;
            None
        };
        self.install_source(crate::platform::native_stdin()?, tokio::io::stdout());
        let result = self.serve(primary.as_ref()).await;
        if let Some(source) = self.source.take() {
            source.close();
        }
        self.pending.disconnect();
        #[cfg(unix)]
        drop(primary);
        registry.remove(std::process::id()).await;
        result
    }

    /// Serve as the detached primary without inheriting a Chrome native-message source.
    ///
    /// A Chrome-launched relay owns its own stdin/stdout and connects through the
    /// daemon socket. Losing that relay therefore cannot terminate this HTTP owner.
    ///
    /// # Errors
    /// Reports socket acquisition and signal-registration failures.
    #[cfg(unix)]
    pub async fn run_detached_primary(mut self) -> io::Result<()> {
        let registry = InstanceRegistry::new(self.paths.registry.clone());
        registry.list(epoch_millis()).await;
        let Some(primary) = daemon::try_acquire_daemon_lock(&self.paths.daemon_socket).await?
        else {
            return Ok(());
        };
        let result = self.serve(Some(&primary)).await;
        self.pending.disconnect();
        drop(primary);
        registry.remove(std::process::id()).await;
        result
    }

    fn now_ms(&self) -> u64 {
        u64::try_from(self.origin.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    fn install_source<R, W>(&mut self, mut input: R, mut output: W)
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        if let Some(old) = self.source.take() {
            old.close();
        }
        self.generation = self.generation.wrapping_add(1);
        let generation = self.generation;
        let events = self.event_sender.clone();
        let reader = tokio::spawn(async move {
            let mut codec = NativeCodec::new();
            let mut buffer = [0_u8; 8192];
            loop {
                match input.read(&mut buffer).await {
                    Ok(0) | Err(_) => break,
                    Ok(size) => codec.push_bytes(&buffer[..size]),
                }
                let mut processed = 0;
                while let Some(event) = codec.next_event() {
                    if events
                        .send(SourceEvent::Inbound { generation, event })
                        .await
                        .is_err()
                    {
                        return;
                    }
                    processed += 1;
                    if processed == MAX_FRAMES_PER_TICK {
                        tokio::task::yield_now().await;
                        processed = 0;
                    }
                }
            }
            let _ = events.send(SourceEvent::Closed { generation }).await;
        });
        let (outgoing, mut messages) = mpsc::unbounded_channel();
        let writer = tokio::spawn(async move {
            let mut bytes = Vec::with_capacity(512);
            while let Some(message) = messages.recv().await {
                let result = match encode_frame_into(&message, &mut bytes) {
                    Ok(()) => output.write_all(&bytes).await,
                    Err(error) => {
                        tracing::warn!(%error, "failed to serialize native message");
                        continue;
                    }
                };
                if let Err(error) = result {
                    tracing::warn!(%error, "native stdout write failed");
                }
                if let Err(error) = output.flush().await {
                    tracing::warn!(%error, "native stdout flush failed");
                }
            }
        });
        self.source = Some(Source {
            output: outgoing,
            reader,
            writer,
        });
    }

    fn send(&self, message: JsonDocument) {
        if let Some(source) = &self.source {
            let _ = source.output.send(message);
        }
    }

    fn error(&self, message: JsString) {
        self.send(JsonDocument::object([
            ("type", JsonDocument::from("error_from_native_host")),
            (
                "payload",
                JsonDocument::object([("message", JsonDocument::string(message))]),
            ),
        ]));
    }

    #[cfg(unix)]
    async fn serve(&mut self, primary: Option<&daemon::PrimarySocket>) -> io::Result<()> {
        let signal = termination_signal();
        tokio::pin!(signal);
        let idle_wait =
            daemon::idle_timeout(std::env::var("HC_DAEMON_IDLE_TIMEOUT_MS").ok().as_deref());
        let mut idle_deadline = None;
        loop {
            let deadline = self
                .pending
                .next_deadline_ms()
                .map(|millis| self.origin + Duration::from_millis(millis));
            let wake_at = match (deadline, idle_deadline) {
                (Some(left), Some(right)) => Some(left.min(right)),
                (left, right) => left.or(right),
            };
            tokio::select! {
                result = &mut signal => return result,
                () = wait_until(wake_at) => {
                    if idle_deadline.is_some_and(|deadline| deadline <= Instant::now()) { return Ok(()); }
                    self.pending.expire(self.now_ms());
                },
                relay = async { match primary { Some(primary) => primary.accept().await, None => pending::<io::Result<tokio::net::UnixStream>>().await } } => {
                    let relay = relay?;
                    let (input, output) = relay.into_split();
                    self.install_source(input, output);
                    idle_deadline = None;
                },
                Some(event) = self.events.recv() => {
                    match event {
                        SourceEvent::Inbound { generation, event } if generation == self.generation => self.inbound(event),
                        SourceEvent::Closed { generation } if generation == self.generation => {
                            if let Some(source) = self.source.take() { source.close(); }
                            self.pending.disconnect();
                            if primary.is_none() { return Ok(()); }
                            idle_deadline = Some(Instant::now() + idle_wait);
                        },
                        _ => {},
                    }
                },
                Some(command) = self.commands.recv() => {
                    if !self.command(command) { return Ok(()); }
                },
            }
        }
    }

    #[cfg(not(unix))]
    async fn serve(&mut self, _primary: Option<&()>) -> io::Result<()> {
        let signal = termination_signal();
        tokio::pin!(signal);
        loop {
            let deadline = self
                .pending
                .next_deadline_ms()
                .map(|millis| self.origin + Duration::from_millis(millis));
            tokio::select! {
                result = &mut signal => return result,
                () = wait_until(deadline) => { self.pending.expire(self.now_ms()); },
                Some(event) = self.events.recv() => match event {
                    SourceEvent::Inbound { generation, event } if generation == self.generation => self.inbound(event),
                    SourceEvent::Closed { generation } if generation == self.generation => return Ok(()),
                    _ => {},
                },
                Some(command) = self.commands.recv() => { if !self.command(command) { return Ok(()); } },
            }
        }
    }

    fn command(&mut self, command: Command) -> bool {
        match command {
            Command::Shutdown => return false,
            Command::Notify(message) => self.send(message),
            Command::Prepared { request_id, result } => self.prepared(request_id, result),
            Command::Request { request, response } => {
                if self.source.is_none() {
                    let _ = response.send(Err(PendingError::SourceUnavailable));
                    return true;
                }
                let request_id = request.request_id.unwrap_or_else(Uuid::new_v4);
                let spec = RequestSpec {
                    kind: if request.message_type == "call_tool" {
                        RequestKind::Tool
                    } else {
                        RequestKind::Generic
                    },
                    timeout_ms: request.timeout_ms,
                    client_id: request.client_id.clone(),
                };
                if !self
                    .pending
                    .insert_with_sender(self.now_ms(), request_id, spec, response)
                {
                    return true;
                }
                if request.message_type != "call_tool" {
                    self.send(generic_envelope(request, request_id));
                    return true;
                }
                let input = match tool_input(request, request_id) {
                    Ok(input) => input,
                    Err(message) => {
                        self.pending
                            .abort(request_id, PendingError::WriteFailed { message });
                        return true;
                    }
                };
                if self.protection.profile.is_none() {
                    self.prepared(request_id, tool_envelope(input, None));
                    return true;
                }
                let sender = self.sender.clone();
                let protection = self.protection.clone();
                tokio::spawn(async move {
                    let reason = protection
                        .cache
                        .current(
                            protection.profile.as_deref(),
                            &protection.config,
                            &epoch_millis,
                        )
                        .await;
                    let result = tool_envelope(input, reason.as_deref());
                    let _ = sender.send(Command::Prepared { request_id, result });
                });
            }
        }
        true
    }

    fn prepared(&mut self, request_id: Uuid, result: Result<JsonDocument, String>) {
        match result {
            Ok(envelope) => self.send(envelope),
            Err(message) => {
                self.pending
                    .abort(request_id, PendingError::WriteFailed { message });
            }
        }
    }

    fn inbound(&mut self, event: CodecEvent) {
        let mut message = match event {
            CodecEvent::ProtocolError { message } => {
                self.error(js(message));
                return;
            }
            CodecEvent::Frame(frame) => frame.value,
        };
        if !message.is_object() && !message.is_array() {
            self.error(js("Invalid message format"));
            return;
        }
        if let Err(error) = ipc::validate_native_message(&message.validation_value()) {
            self.error(js(format!(
                "Invalid native message: {}",
                error.first_message()
            )));
            return;
        }
        if let Some(request_id) = message
            .get("responseToRequestId")
            .and_then(|value| value.as_str())
            .filter(|id| !id.is_empty())
        {
            if let Ok(parsed_id) = Uuid::parse_str(request_id) {
                // Node correlates exact string keys, not equivalent UUID spellings.
                let mut canonical = [0_u8; 36];
                if parsed_id.hyphenated().encode_lower(&mut canonical) != request_id {
                    return;
                }
                let result = if message.get("error").is_some_and(truthy) {
                    Err(PendingError::Extension {
                        message: message
                            .get("error")
                            .expect("error presence was checked before coercion")
                            .to_js_string(),
                    })
                } else {
                    Ok(message.remove("payload"))
                };
                self.pending.finish(parsed_id, result);
            }
            return;
        }
        let message_type = message.get("type").and_then(|value| value.as_str());
        match message_type {
            Some("ping_from_extension") => {
                self.send(JsonDocument::object([(
                    "type",
                    JsonDocument::from("pong_to_extension"),
                )]));
            }
            Some("start") => {
                self.identity.send_modify(|identity| {
                    if let Some(extension_id) = message
                        .get("payload")
                        .and_then(|payload| payload.get("extensionId"))
                        .and_then(|value| value.as_str())
                    {
                        identity.extension_id = Some(extension_id.to_owned());
                    }
                    if let Some(instance_id) = message
                        .get("payload")
                        .and_then(|payload| payload.get("instanceId"))
                        .and_then(|value| value.as_str())
                    {
                        identity.instance_id = Some(instance_id.to_owned());
                    }
                });
                if self.directives.send(message).is_err() {
                    self.error(js("Internal error: server instance not set"));
                }
            }
            Some("stop" | "file_operation") => {
                if self.directives.send(message).is_err() {
                    self.error(js("Internal error: server instance not set"));
                }
            }
            _ => {
                let mut error = JsString::from_owned_string(
                    "Unknown message type or non-response message: ".to_owned(),
                );
                if let Some(message_type) = message.get("type") {
                    let value = message_type.to_js_string();
                    if value.utf16_len() != 0 {
                        error.push_js_string(&value);
                    } else {
                        error.push_str("no type");
                    }
                } else {
                    error.push_str("no type");
                }
                self.error(error);
            }
        }
    }
}

fn tool_input(
    mut request: ExtensionRequest,
    request_id: Uuid,
) -> Result<CallToolEnvelopeInput, String> {
    let client_id = request
        .client_id
        .filter(|client| !client.is_empty())
        .ok_or("CALL_TOOL envelopes require a clientId")?;
    let name = request
        .payload
        .as_ref()
        .and_then(|payload| payload.get("name"))
        .and_then(|value| value.as_str())
        .filter(|name| !name.is_empty())
        .ok_or("CALL_TOOL envelopes require payload.name (non-empty string)")?
        .to_owned();
    let args = request
        .payload
        .as_mut()
        .and_then(|payload| payload.remove("args"));
    Ok(CallToolEnvelopeInput {
        name,
        args,
        request_id: request_id.to_string(),
        client_id,
    })
}

fn tool_envelope(
    mut input: CallToolEnvelopeInput,
    protection: Option<&str>,
) -> Result<JsonDocument, String> {
    input.args = purpose_guard::evaluate(&input.name, input.args, protection)
        .map_err(|error| error.to_string())?;
    ipc::build_call_tool_envelope(input).map_err(|error| {
        serde_json::to_string_pretty(&error.issues).expect("validation issues serialize")
    })
}

fn generic_envelope(request: ExtensionRequest, request_id: Uuid) -> JsonDocument {
    let mut envelope = Vec::with_capacity(4);
    envelope.push(("type", JsonDocument::from(request.message_type)));
    if let Some(payload) = request.payload {
        envelope.push(("payload", payload));
    }
    envelope.push(("requestId", JsonDocument::from(request_id.to_string())));
    if let Some(client_id) = request.client_id.filter(|client| !client.is_empty()) {
        envelope.push(("clientId", JsonDocument::from(client_id)));
    }
    JsonDocument::object(envelope)
}

fn truthy(value: humanchrome_core::json_document::JsonRef<'_>) -> bool {
    if value.is_null() || value.as_bool() == Some(false) {
        return false;
    }
    if value.is_string() {
        return value.to_js_string().utf16_len() != 0;
    }
    let text = value.to_owned().to_json_text();
    text != "0" && text != "0.0"
}

fn js(value: impl Into<String>) -> JsString {
    JsString::from_owned_string(value.into())
}

/// Epoch clock shared by native persistence and expiry caches.
#[must_use]
pub fn epoch_millis() -> u64 {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(u64::MAX)
}

async fn wait_until(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => sleep_until(deadline).await,
        None => pending::<()>().await,
    }
}
async fn termination_signal() -> io::Result<()> {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! { result = tokio::signal::ctrl_c() => result, _ = terminate.recv() => Ok(()) }
    }
    #[cfg(not(unix))]
    tokio::signal::ctrl_c().await
}
