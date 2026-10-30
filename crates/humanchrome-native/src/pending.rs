//! Bounded, single-owner request correlation state for the native host.

use hashlink::LinkedHashMap;
use std::collections::{BTreeSet, HashMap};

use humanchrome_core::{arguments::JsString, json_document::JsonDocument};
use tokio::sync::oneshot;
use uuid::Uuid;

/// Maximum concurrent native-host requests across all clients.
pub const MAX_PENDING_REQUESTS: usize = 1_000;
/// Maximum concurrent requests attributable to one MCP client.
pub const MAX_PENDING_PER_CLIENT: usize = 50;
/// Default timeout for generic bridge-to-extension requests.
pub const GENERIC_REQUEST_TIMEOUT_MS: u64 = 15_000;
/// Default timeout for tool invocations forwarded to the extension.
pub const TOOL_REQUEST_TIMEOUT_MS: u64 = 120_000;

/// Classifies a request so its default deadline remains explicit at the call site.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestKind {
    /// Regular extension request with the fifteen-second default.
    Generic,
    /// MCP tool request with the 120-second default.
    Tool,
}

impl RequestKind {
    /// Returns the default timeout in milliseconds for this kind of request.
    #[must_use]
    pub const fn timeout_ms(self) -> u64 {
        match self {
            Self::Generic => GENERIC_REQUEST_TIMEOUT_MS,
            Self::Tool => TOOL_REQUEST_TIMEOUT_MS,
        }
    }
}

/// Input required to register a pending request before its frame is written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestSpec {
    /// Determines the default timeout when [`Self::timeout_ms`] is absent.
    pub kind: RequestKind,
    /// Explicit legacy timeout override in milliseconds.
    pub timeout_ms: Option<u64>,
    /// Optional MCP identity counted against the per-client budget.
    pub client_id: Option<String>,
}

impl RequestSpec {
    /// Builds a request using its kind's default deadline.
    #[must_use]
    pub fn new(kind: RequestKind) -> Self {
        Self {
            kind,
            timeout_ms: None,
            client_id: None,
        }
    }

    fn effective_timeout_ms(&self) -> u64 {
        self.timeout_ms.unwrap_or_else(|| self.kind.timeout_ms())
    }
}

/// A pending request identity and the one-shot response receiver owned by its caller.
#[derive(Debug)]
pub struct PendingHandle {
    /// UUID written into the outbound request envelope.
    pub request_id: Uuid,
    /// Delivers exactly one extension response or terminal request error.
    pub response: oneshot::Receiver<PendingResult>,
}

/// Result delivered to the original caller; `None` preserves an omitted response payload.
pub type PendingResult = Result<Option<JsonDocument>, PendingError>;

/// Terminal request failures observable by bridge callers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PendingError {
    /// The active Native Messaging source is absent while a relay reconnects.
    SourceUnavailable,
    /// All global pending-request slots are occupied.
    GlobalCapacity {
        /// Current global in-flight request count.
        current: usize,
    },
    /// One client exhausted its own in-flight request budget.
    ClientCapacity {
        /// Identity whose in-flight budget is saturated.
        client_id: String,
        /// Current number of that client's requests.
        current: usize,
    },
    /// The response did not arrive before the request's configured deadline.
    TimedOut {
        /// Timeout selected when the request was registered.
        timeout_ms: u64,
    },
    /// The Native Messaging source ended and cannot complete this request.
    SourceDisconnected,
    /// The actor could not write the request after registering its deadline.
    WriteFailed {
        /// Source write failure text preserved for the request caller.
        message: String,
    },
    /// The extension explicitly returned a JavaScript-coerced error string.
    Extension {
        /// Extension-supplied error text, including an unpaired surrogate when present.
        message: JsString,
    },
}

impl PendingError {
    /// Converts a terminal error to the JavaScript string emitted on the wire.
    #[must_use]
    pub fn into_js_message(self) -> JsString {
        match self {
            Self::Extension { message } => message,
            error => JsString::from_owned_string(error.to_string()),
        }
    }
}

impl std::fmt::Display for PendingError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SourceUnavailable => formatter
                .write_str("Bridge has no active native-messaging source (SW reconnecting)"),
            Self::GlobalCapacity { current } => write!(
                formatter,
                "Too many pending requests ({current} >= {MAX_PENDING_REQUESTS})"
            ),
            Self::ClientCapacity { client_id, current } => write!(
                formatter,
                "CLIENT_BUSY: client \"{client_id}\" has {current} requests in flight (cap {MAX_PENDING_PER_CLIENT}). Wait for prior calls to complete before issuing more."
            ),
            Self::TimedOut { timeout_ms } => {
                write!(formatter, "Request timed out after {timeout_ms}ms")
            }
            Self::SourceDisconnected => {
                formatter.write_str("Native host source disconnected — request aborted")
            }
            Self::WriteFailed { message } => formatter.write_str(message),
            Self::Extension { message } => {
                formatter.write_str(message.as_utf8().unwrap_or("\u{FFFD}"))
            }
        }
    }
}

impl std::error::Error for PendingError {}

#[derive(Debug)]
struct PendingRequest {
    deadline_at_ms: u64,
    sequence: u64,
    timeout_ms: u64,
    client_id: Option<String>,
    sender: oneshot::Sender<PendingResult>,
}

/// Owns all request correlation and budget counters for one Tokio host actor.
#[derive(Debug, Default)]
pub struct PendingRequests {
    entries: LinkedHashMap<Uuid, PendingRequest>,
    per_client: HashMap<String, usize>,
    deadlines: BTreeSet<(u64, u64, Uuid)>,
    sequence: u64,
}

impl PendingRequests {
    /// Creates an empty pending-request owner.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers a request and generates its correlation UUID.
    pub fn begin(&mut self, now_ms: u64, spec: RequestSpec) -> Result<PendingHandle, PendingError> {
        self.begin_with_id(Uuid::new_v4(), now_ms, spec)
    }

    /// Registers a request using a caller-generated UUID for request-scoped logging.
    pub fn begin_with_id(
        &mut self,
        request_id: Uuid,
        now_ms: u64,
        spec: RequestSpec,
    ) -> Result<PendingHandle, PendingError> {
        let (sender, response) = oneshot::channel();
        self.insert_entry(now_ms, request_id, spec, sender)
            .map_err(|(error, _)| error)?;
        Ok(PendingHandle {
            request_id,
            response,
        })
    }

    /// Moves a caller-owned response sender into the pending map.
    ///
    /// The actor must first reject an inactive source, then call this method before
    /// writing the corresponding frame. Capacity failures are sent through `sender`
    /// so the client always observes a terminal result from its original receiver.
    pub fn insert_with_sender(
        &mut self,
        now_ms: u64,
        request_id: Uuid,
        spec: RequestSpec,
        sender: oneshot::Sender<PendingResult>,
    ) -> bool {
        match self.insert_entry(now_ms, request_id, spec, sender) {
            Ok(()) => true,
            Err((error, sender)) => {
                let _ = sender.send(Err(error));
                false
            }
        }
    }

    fn insert_entry(
        &mut self,
        now_ms: u64,
        request_id: Uuid,
        spec: RequestSpec,
        sender: oneshot::Sender<PendingResult>,
    ) -> Result<(), (PendingError, oneshot::Sender<PendingResult>)> {
        if self.entries.len() >= MAX_PENDING_REQUESTS {
            return Err((
                PendingError::GlobalCapacity {
                    current: self.entries.len(),
                },
                sender,
            ));
        }
        if self.entries.contains_key(&request_id) {
            return Err((
                PendingError::WriteFailed {
                    message: format!("Duplicate pending request ID: {request_id}"),
                },
                sender,
            ));
        }

        if let Some(client_id) = spec.client_id.as_ref() {
            let current = self.per_client.get(client_id).copied().unwrap_or_default();
            if current >= MAX_PENDING_PER_CLIENT {
                return Err((
                    PendingError::ClientCapacity {
                        client_id: client_id.clone(),
                        current,
                    },
                    sender,
                ));
            }
        }

        let timeout_ms = spec.effective_timeout_ms();
        let deadline_at_ms = now_ms.saturating_add(timeout_ms);
        if let Some(client_id) = spec.client_id.as_ref() {
            if let Some(count) = self.per_client.get_mut(client_id) {
                *count += 1;
            } else {
                self.per_client.insert(client_id.clone(), 1);
            }
        }
        let sequence = self.sequence;
        self.sequence = self.sequence.wrapping_add(1);
        self.deadlines
            .insert((deadline_at_ms, sequence, request_id));
        self.entries.insert(
            request_id,
            PendingRequest {
                deadline_at_ms,
                sequence,
                timeout_ms,
                client_id: spec.client_id,
                sender,
            },
        );
        Ok(())
    }

    /// Completes a request with an extension response or terminal error.
    ///
    /// Returns `false` for unknown or already-terminal request IDs.
    pub fn finish(&mut self, request_id: Uuid, result: PendingResult) -> bool {
        let Some(request) = self.remove(request_id) else {
            return false;
        };
        let _ = request.sender.send(result);
        true
    }

    /// Completes a request that could not be written after registration.
    pub fn abort(&mut self, request_id: Uuid, error: PendingError) -> bool {
        self.finish(request_id, Err(error))
    }

    /// Fails every request whose deadline has elapsed, returning the count released.
    pub fn expire(&mut self, now_ms: u64) -> usize {
        let mut count = 0;
        while let Some(&(deadline, _, request_id)) = self.deadlines.first() {
            if deadline > now_ms {
                break;
            }
            let timeout_ms = self
                .entries
                .get(&request_id)
                .expect("deadline index refers to an owned pending request")
                .timeout_ms;
            self.finish(request_id, Err(PendingError::TimedOut { timeout_ms }));
            count += 1;
        }
        count
    }

    /// Fails all in-flight requests because the active source disconnected.
    pub fn disconnect(&mut self) -> usize {
        let count = self.entries.len();
        self.deadlines.clear();
        self.per_client.clear();
        for (_, request) in self.entries.drain() {
            let _ = request.sender.send(Err(PendingError::SourceDisconnected));
        }
        count
    }

    /// Earliest owned deadline, without scanning all requests or allocating a timer task.
    #[must_use]
    pub fn next_deadline_ms(&self) -> Option<u64> {
        self.deadlines.first().map(|(deadline, _, _)| *deadline)
    }

    /// Returns the number of currently registered requests.
    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Returns whether no requests are registered.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Returns one client's in-flight count without creating a zero entry.
    #[must_use]
    pub fn client_len(&self, client_id: &str) -> usize {
        self.per_client.get(client_id).copied().unwrap_or_default()
    }

    fn remove(&mut self, request_id: Uuid) -> Option<PendingRequest> {
        let request = self.entries.remove(&request_id)?;
        self.deadlines
            .remove(&(request.deadline_at_ms, request.sequence, request_id));
        if let Some(client_id) = request.client_id.as_deref() {
            let remove_counter = match self.per_client.get_mut(client_id) {
                Some(count) => {
                    *count = count.saturating_sub(1);
                    *count == 0
                }
                None => false,
            };
            if remove_counter {
                self.per_client.remove(client_id);
            }
        }
        Some(request)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tokio::sync::oneshot;
    use uuid::Uuid;

    use super::{
        MAX_PENDING_PER_CLIENT, MAX_PENDING_REQUESTS, PendingError, PendingRequests, RequestKind,
        RequestSpec,
    };

    #[tokio::test]
    async fn response_releases_client_capacity_before_delivering_payload() {
        let mut pending = PendingRequests::new();
        let mut spec = RequestSpec::new(RequestKind::Tool);
        spec.client_id = Some("alice".to_owned());
        let handle = pending.begin(100, spec).expect("slot available");

        assert_eq!(pending.client_len("alice"), 1);
        assert!(pending.finish(handle.request_id, Ok(Some(json!({"ok": true}).into()))));
        assert_eq!(pending.client_len("alice"), 0);
        assert_eq!(
            handle.response.await.expect("sender remains live"),
            Ok(Some(json!({"ok": true}).into()))
        );
    }

    #[test]
    fn extension_error_exposes_its_lossless_wire_message() {
        let message =
            humanchrome_core::arguments::JsString::from_json_string_literal(r#""\ud800""#)
                .expect("escaped lone surrogate is a valid JSON string");
        let error = PendingError::Extension { message };
        assert_eq!(error.into_js_message().json_string_literal(), r#""\ud800""#);
    }

    #[tokio::test]
    async fn caller_owned_sender_receives_admission_failure_without_a_second_channel() {
        let mut pending = PendingRequests::new();
        let request_id = Uuid::nil();
        let (first_sender, first_response) = oneshot::channel();
        assert!(pending.insert_with_sender(
            0,
            request_id,
            RequestSpec::new(RequestKind::Generic),
            first_sender,
        ));

        let (rejected_sender, rejected_response) = oneshot::channel();
        assert!(!pending.insert_with_sender(
            0,
            request_id,
            RequestSpec::new(RequestKind::Generic),
            rejected_sender,
        ));
        assert!(matches!(
            rejected_response.await.expect("admission failure is sent"),
            Err(PendingError::WriteFailed { .. })
        ));

        assert!(pending.finish(request_id, Ok(Some(json!({"ok": true}).into()))));
        assert_eq!(
            first_response.await.expect("original sender is retained"),
            Ok(Some(json!({"ok": true}).into()))
        );
    }

    #[tokio::test]
    async fn expiration_uses_injected_time_and_releases_slot() {
        let mut pending = PendingRequests::new();
        let mut spec = RequestSpec::new(RequestKind::Generic);
        spec.timeout_ms = Some(7);
        let handle = pending.begin(10, spec).expect("slot available");

        assert_eq!(pending.expire(16), 0);
        assert_eq!(pending.expire(17), 1);
        assert_eq!(
            handle.response.await.expect("timeout delivered"),
            Err(PendingError::TimedOut { timeout_ms: 7 })
        );
        assert!(pending.is_empty());
    }

    #[tokio::test]
    async fn disconnect_releases_global_and_per_client_capacity() {
        let mut pending = PendingRequests::new();
        let mut spec = RequestSpec::new(RequestKind::Tool);
        spec.client_id = Some("alice".to_owned());
        let first = pending.begin(0, spec).expect("slot available");
        let second = pending
            .begin(0, RequestSpec::new(RequestKind::Generic))
            .expect("system slot available");

        assert_eq!(pending.disconnect(), 2);
        assert!(pending.is_empty());
        assert_eq!(pending.client_len("alice"), 0);
        assert_eq!(
            first.response.await.expect("disconnect delivered"),
            Err(PendingError::SourceDisconnected)
        );
        assert_eq!(
            second.response.await.expect("disconnect delivered"),
            Err(PendingError::SourceDisconnected)
        );
    }

    #[test]
    fn per_client_cap_does_not_block_another_client_or_system_requests() {
        let mut pending = PendingRequests::new();
        let mut alice = RequestSpec::new(RequestKind::Generic);
        alice.client_id = Some("alice".to_owned());
        for _ in 0..MAX_PENDING_PER_CLIENT {
            pending
                .begin(0, alice.clone())
                .expect("alice capacity remains");
        }

        assert!(matches!(
            pending.begin(0, alice),
            Err(PendingError::ClientCapacity { client_id, current: MAX_PENDING_PER_CLIENT }) if client_id == "alice"
        ));
        let mut bob = RequestSpec::new(RequestKind::Generic);
        bob.client_id = Some("bob".to_owned());
        assert!(pending.begin(0, bob).is_ok());
        assert!(
            pending
                .begin(0, RequestSpec::new(RequestKind::Generic))
                .is_ok()
        );
    }

    #[test]
    fn global_cap_rejects_without_admitting_another_request() {
        let mut pending = PendingRequests::new();
        for _ in 0..MAX_PENDING_REQUESTS {
            pending
                .begin(0, RequestSpec::new(RequestKind::Generic))
                .expect("global capacity remains");
        }

        assert_eq!(
            pending
                .begin(0, RequestSpec::new(RequestKind::Generic))
                .expect_err("capacity must reject admission"),
            PendingError::GlobalCapacity {
                current: MAX_PENDING_REQUESTS,
            }
        );
        assert_eq!(pending.len(), MAX_PENDING_REQUESTS);
    }
}
