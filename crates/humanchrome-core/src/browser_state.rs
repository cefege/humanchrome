//! Portable browser ownership, pacing, dispatch, and per-tab queue policy.
//!
//! Chrome, storage, timers, and Promise settlement remain host effects. This module owns the
//! deterministic state transitions those effects drive.

use indexmap::{IndexMap, IndexSet};
use serde::Serialize;

use crate::arguments::JsString;
use crate::json_document::JsonDocument;

/// Chrome tab identifiers carried across the host boundary.
pub type TabId = i64;
/// Chrome window identifiers carried across the host boundary.
pub type WindowId = i64;
/// Milliseconds from a host-provided wall clock.
pub type Millis = i64;
/// Monotonic per-instance queue identifier.
pub type TicketId = u64;

/// Persistence key used by the extension's `chrome.storage.session` adapter.
pub const OWNERSHIP_STORAGE_KEY: &str = "humanchrome:ownership";
/// Clients idle longer than this no longer retain tab ownership.
pub const STALE_AFTER_MS: Millis = 30 * 60 * 1_000;
/// The extension storage adapter coalesces dirty snapshots for this interval.
pub const PERSIST_DEBOUNCE_MS: Millis = 50;
/// Default timeout for a mutating call waiting on a tab lock.
pub const DEFAULT_TAB_LOCK_TIMEOUT_MS: Millis = 60_000;
/// Maximum pending and holding entries on one tab queue.
pub const MAX_TAB_QUEUE_DEPTH: usize = 16;
/// Queue ETA used before a completed holder establishes an EWMA.
pub const DEFAULT_EXPECTED_HOLD_MS: Millis = 250;
/// Lower bound for caller-supplied tab lock timeouts.
pub const MIN_TAB_LOCK_TIMEOUT_MS: Millis = 100;
/// Upper bound for caller-supplied tab lock timeouts.
pub const MAX_TOOL_TIMEOUT_MS: Millis = 300_000;

/// Pacing mode selected by `chrome_pace`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PacingProfile {
    /// Disable pacing and remove any existing pacing state.
    #[default]
    Off,
    /// Add a 600ms baseline and up to 600ms random jitter.
    Human,
    /// Add a 1500ms baseline and up to 1500ms random jitter.
    Careful,
    /// Retain queue serialization without an additional delay.
    Fast,
}

/// Optional pacing values supplied by the host after argument validation.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PacingOverrides {
    /// Replacement baseline delay.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_gap_ms: Option<Millis>,
    /// Replacement upper jitter bound.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jitter_ms: Option<Millis>,
}

/// Current pacing state for one client.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PacingState {
    /// Active pacing profile.
    pub profile: PacingProfile,
    /// Inclusive lower gap bound between mutating dispatches.
    pub min_gap_ms: Millis,
    /// Inclusive random extra gap upper bound.
    pub jitter_ms: Millis,
    /// Dispatch time accepted by the throttle, including its scheduled delay.
    pub last_dispatch_at: Millis,
}

/// Serializable view of a client's full in-memory state.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientStateSnapshot {
    /// Tabs in JavaScript `Set` insertion order.
    pub owned_tab_ids: Vec<TabId>,
    /// Last tab successfully touched by this client.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_tab_id: Option<TabId>,
    /// Most recently touched window hint.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_window_id: Option<WindowId>,
    /// Host clock time of the last state-changing client interaction.
    pub last_seen_at: Millis,
    /// Ephemeral service-worker pacing state.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pacing: Option<PacingState>,
    /// Per-client alias mapping in JavaScript `Map` insertion order.
    #[serde(skip_serializing_if = "IndexMap::is_empty")]
    pub aliases: IndexMap<String, TabId>,
}

/// Storage-safe client record. Pacing is deliberately absent.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedClientEntry {
    /// Owned tabs in insertion order.
    pub owned_tab_ids: Vec<TabId>,
    /// Active tab when it remains owned.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_tab_id: Option<TabId>,
    /// Last window hint.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_window_id: Option<WindowId>,
    /// Last interaction time.
    pub last_seen_at: Millis,
    /// Alias-to-tab mappings whose tabs remain owned.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aliases: Option<IndexMap<String, TabId>>,
}

/// Complete `chrome.storage.session` ownership payload.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct OwnershipSnapshot {
    /// Client records, preserving JavaScript object insertion order.
    #[serde(flatten)]
    pub clients: IndexMap<String, PersistedClientEntry>,
}

/// Results of restoring an ownership snapshot after a service-worker boot.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    /// Number of snapshot entries accepted into state.
    pub restored_clients: usize,
    /// Number of tab ids discarded by host liveness filtering.
    pub dropped_tab_ids: usize,
    /// Number of records discarded because no owned tab survived.
    pub dropped_clients: usize,
}

/// Ownership behavior for target resolution.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TargetAccess {
    /// Read-only calls accept an explicit tab without changing ownership.
    Read,
    /// Mutating calls may only use an unowned tab or the caller's tab.
    #[default]
    Mutate,
}

/// Static tool policy governing whether a missing owned tab may be created.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum AutoSpawnPolicy {
    /// A missing target may create a fresh background tab.
    #[default]
    Enabled,
    /// This tool owns no meaningful tab target and must not create one.
    Disabled,
}

/// Whether a URL-owning caller supplied a nonempty string URL argument.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum UrlTargeting {
    /// No nonempty URL string was supplied.
    #[default]
    Absent,
    /// The tool selects or creates its own target from the URL.
    Provided,
}

/// Window forwarding behavior for ordinary calls and explicit close actions.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum WindowTargeting {
    /// An omitted window uses the client's most-recent window hint.
    #[default]
    UseClientHint,
    /// Window close actions remain explicit and never inherit a hint.
    ExplicitOnly,
}

/// A tab's ownership conflict returned to the dispatcher.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabConflict {
    /// Explicit tab rejected for a mutating request.
    pub tab_id: TabId,
    /// Client currently owning the tab.
    pub owner: String,
}

/// A failed alias lookup returned to the dispatcher.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AliasMissReason {
    /// No mapping existed for the client and alias.
    UnknownAlias,
    /// Mapping existed but its tab is no longer owned.
    TabClosed,
}

/// Alias failure details passed to the existing error-envelope host.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AliasMiss {
    /// Caller-provided alias after the host's ECMAScript `trim` intrinsic.
    pub alias: JsString,
    /// Why no tab could be chosen.
    pub reason: AliasMissReason,
}

/// Mutually-exclusive dispatcher target arguments.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConflictingTabTargetArgs {
    /// Explicit numeric tab id.
    pub tab_id: TabId,
    /// Nonempty ECMAScript-trimmed alias.
    pub alias: JsString,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TargetResolution {
    /// Chosen tab, if any.
    pub tab_id: Option<TabId>,
    /// Cross-client mutation rejection.
    pub conflict: Option<TabConflict>,
    /// Alias lookup rejection.
    pub alias_miss: Option<AliasMiss>,
    /// Both selector forms were supplied.
    pub conflicting_args: Option<ConflictingTabTargetArgs>,
}

/// Request fields relevant to target selection.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TargetRequest {
    /// Calling client, absent for legacy callers.
    pub client_id: Option<String>,
    /// Numeric `tabId`, present only when JavaScript observed a number.
    pub explicit_tab_id: Option<TabId>,
    /// `tabAlias` after the host applies ECMAScript `String.prototype.trim`.
    ///
    /// The host performs trimming because browser string whitespace is an intrinsic, not
    /// application policy. An empty result behaves as if no alias was supplied.
    pub trimmed_tab_alias: Option<JsString>,
    /// Read-only tools can target another client's explicit tab without changing ownership.
    pub access: TargetAccess,
}

/// Whether the host completed the optional Chrome tab liveness probe.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TabLiveness {
    /// The host has not probed yet and should do so before dispatch.
    #[default]
    Unprobed,
    /// The tab exists, or the Chrome API is unavailable and therefore cannot disprove it.
    Live,
    /// Chrome reported that the selected tab no longer exists.
    Missing,
}

/// Portable dispatcher inputs beyond target selection.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DispatchRequest {
    /// Client/tab/alias selection inputs.
    pub target: TargetRequest,
    /// Tool static auto-spawn policy.
    pub auto_spawn_policy: AutoSpawnPolicy,
    /// Whether a nonempty string URL moves target selection into the tool.
    pub url_targeting: UrlTargeting,
    /// Numeric caller `windowId`, when provided.
    pub explicit_window_id: Option<WindowId>,
    /// Window inheritance behavior for this tool action.
    pub window_targeting: WindowTargeting,
    /// Result of the host's Chrome tab liveness probe.
    pub tab_liveness: TabLiveness,
}

/// Opaque liveness continuation retaining the exact target and window hints selected before await.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DispatchContinuation {
    request: DispatchRequest,
    resolved_tab_id: TabId,
    forwarded_window_id: Option<WindowId>,
    auto_spawn_preferred_window_id: Option<WindowId>,
}

impl DispatchContinuation {
    /// Returns the exact tab the host must probe before resuming this continuation.
    #[must_use]
    pub fn tab_id(&self) -> TabId {
        self.resolved_tab_id
    }
}

/// Details needed by the host to create a background tab exactly once.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoSpawnRequest {
    /// Window hint to probe/use; absent means Chrome selects its last-focused window.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preferred_window_id: Option<WindowId>,
}

/// Final target fields to inject into a tool argument object.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchReady {
    /// Resolved tab before the URL-carve-out is applied, useful for diagnostics.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_tab_id: Option<TabId>,
    /// Tab to forward to the tool. URL-owning calls may intentionally omit it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub forwarded_tab_id: Option<TabId>,
    /// Window to forward to the tool.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub forwarded_window_id: Option<WindowId>,
    /// A fresh background tab must be created before tool execution.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_spawn: Option<AutoSpawnRequest>,
}

/// Dispatcher planning result; host effects occur only in response to this result.
#[derive(Clone, Debug, PartialEq)]
pub enum DispatchPlan {
    /// Existing error-envelope policy should be used.
    Rejected { error: BrowserStateError },
    /// Chrome must verify the cached tab before the decision can be finalized.
    NeedsLivenessProbe {
        /// Immutable continuation bound to the exact probed tab.
        continuation: DispatchContinuation,
    },
    /// All state-owned dispatch decisions are complete.
    Ready { target: DispatchReady },
}

/// Error codes emitted by portable ownership and queue policy.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum BrowserStateErrorCode {
    /// Cross-client mutation attempted against an owned tab.
    TabNotOwned,
    /// Alias did not resolve to a usable owned tab.
    TabNotFound,
    /// Mutually exclusive dispatcher arguments were supplied.
    InvalidArgs,
    /// A queued call exceeded its acquisition timeout.
    TabLockTimeout,
    /// A per-tab queue reached its hard capacity.
    QueueFull,
    /// Chrome removed the queued tab.
    TabClosed,
}

/// Existing tool-envelope data produced without a Chrome or Promise dependency.
#[derive(Clone, Debug, PartialEq)]
pub struct BrowserStateError {
    /// Stable tool error code.
    pub code: BrowserStateErrorCode,
    /// Existing human-readable error text, retaining unpaired UTF-16 surrogates.
    pub message: JsString,
    /// Structured details retained as a lossless JSON document.
    pub details: JsonDocument,
}

impl BrowserStateError {
    /// Builds lossless error fields for a host tool-error envelope.
    #[must_use]
    pub fn as_json_document(&self) -> JsonDocument {
        JsonDocument::object([
            ("code", JsonDocument::from(self.code.as_str())),
            ("message", JsonDocument::string(self.message.clone())),
            ("details", self.details.clone()),
        ])
    }
}

impl BrowserStateErrorCode {
    /// Returns the stable tool error code literal.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::TabNotOwned => "TAB_NOT_OWNED",
            Self::TabNotFound => "TAB_NOT_FOUND",
            Self::InvalidArgs => "INVALID_ARGS",
            Self::TabLockTimeout => "TAB_LOCK_TIMEOUT",
            Self::QueueFull => "QUEUE_FULL",
            Self::TabClosed => "TAB_CLOSED",
        }
    }
}

/// Tab queue admission outcome.
#[derive(Clone, Debug, PartialEq)]
pub enum QueueAdmission {
    /// The caller owns the critical section immediately.
    Granted(QueueGrant),
    /// The host should install a timeout and await a future promotion transition.
    Queued(QueuedTicket),
    /// The queue was already at capacity.
    Rejected { error: BrowserStateError },
}

/// Ticket granted to a queue holder.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueGrant {
    /// Monotonic queue ticket.
    pub ticket: TicketId,
    /// Queue position at admission, before later fairness promotions.
    pub queued_at_position: usize,
    /// Time spent queued before entering the critical section.
    pub waited_ms: Millis,
}

/// Pending ticket details owned by the host's Promise/timer adapter.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedTicket {
    /// Monotonic queue ticket.
    pub ticket: TicketId,
    /// Queue position at admission.
    pub queued_at_position: usize,
    /// Host timer deadline for this pending ticket.
    pub deadline_at: Millis,
}

/// A host callback to reject a pending ticket.
#[derive(Clone, Debug, PartialEq)]
pub struct CancelledTicket {
    /// Ticket whose pending/held host callback must reject.
    pub ticket: TicketId,
    /// Existing tool-envelope data.
    pub error: BrowserStateError,
}

/// Result of releasing, timing out, or closing a queue ticket.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct QueueTransition {
    /// At most one waiter becomes the new holder after a normal transition.
    pub promoted: Option<QueueGrant>,
    /// Tickets the host must reject, notably after a tab close.
    pub cancelled: Vec<CancelledTicket>,
    /// The queue was removed because it has neither holder nor waiters.
    pub retired: bool,
}

/// Queue holder or waiter shown by `chrome_queue_inspect`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueWaiterSnapshot {
    /// `None` serializes to JavaScript `null` for anonymous callers.
    pub client_id: Option<String>,
    /// One-based current position.
    pub position: usize,
    /// Elapsed queue time.
    pub waited_ms: Millis,
    /// EWMA-derived wait prediction.
    pub expected_wait_ms: f64,
    /// Ticket correlation key.
    pub ticket: TicketId,
}

/// Queue holder shown by `chrome_queue_inspect`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueHolderSnapshot {
    /// `None` serializes to JavaScript `null` for anonymous callers.
    pub client_id: Option<String>,
    /// Elapsed hold duration.
    pub held_ms: Millis,
    /// Ticket correlation key.
    pub ticket: TicketId,
}

/// Full queue inspector record for one tab.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueTabSnapshot {
    /// Queue's Chrome tab.
    pub tab_id: TabId,
    /// Holder plus waiters.
    pub depth: usize,
    /// Number of completed holders since this queue was created.
    pub served_total: u64,
    /// EWMA of completed hold durations.
    pub mean_hold_ms: f64,
    /// Current holder, if any.
    pub holder: Option<QueueHolderSnapshot>,
    /// Current waiters in execution order.
    pub waiters: Vec<QueueWaiterSnapshot>,
}

/// Internal queue entry view exposed only through the extension's test escape hatch.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueEntryTestSnapshot {
    /// Monotonic queue ticket.
    pub ticket: TicketId,
    /// Owning fairness lane, if any.
    pub client_id: Option<String>,
    /// Host wall-clock time at admission.
    pub enqueued_at: Millis,
    /// Host wall-clock time at promotion, if promoted.
    pub started_at: Option<Millis>,
}

#[derive(Clone, Debug)]
struct ClientRecord {
    owned_tabs: IndexSet<TabId>,
    active_tab_id: Option<TabId>,
    last_window_id: Option<WindowId>,
    last_seen_at: Millis,
    pacing: Option<PacingState>,
    aliases: IndexMap<String, TabId>,
}

impl ClientRecord {
    fn new(now: Millis) -> Self {
        Self {
            owned_tabs: IndexSet::new(),
            active_tab_id: None,
            last_window_id: None,
            last_seen_at: now,
            pacing: None,
            aliases: IndexMap::new(),
        }
    }

    fn snapshot(&self) -> ClientStateSnapshot {
        ClientStateSnapshot {
            owned_tab_ids: self.owned_tabs.iter().copied().collect(),
            active_tab_id: self.active_tab_id,
            last_window_id: self.last_window_id,
            last_seen_at: self.last_seen_at,
            pacing: self.pacing,
            aliases: self.aliases.clone(),
        }
    }
}

#[derive(Clone, Debug)]
struct QueueEntry {
    ticket: TicketId,
    client_id: Option<String>,
    enqueued_at: Millis,
    queued_at_position: usize,
    started_at: Option<Millis>,
}

#[derive(Clone, Debug, Default)]
struct TabQueueState {
    entries: Vec<QueueEntry>,
    mean_hold_ms: f64,
    served_total: u64,
    last_served_client_id: Option<String>,
}

/// One WASM-owned browser policy object.
#[derive(Clone, Debug)]
pub struct BrowserState {
    clients: IndexMap<String, ClientRecord>,
    queues: IndexMap<TabId, TabQueueState>,
    next_ticket: TicketId,
    persistence_dirty: bool,
}

impl Default for BrowserState {
    fn default() -> Self {
        Self::new()
    }
}

impl BrowserState {
    /// Creates an empty policy state with the first queue ticket set to one.
    #[must_use]
    pub fn new() -> Self {
        Self {
            clients: IndexMap::new(),
            queues: IndexMap::new(),
            next_ticket: 1,
            persistence_dirty: false,
        }
    }

    /// Returns whether a host should schedule one debounced ownership snapshot write.
    #[must_use]
    pub fn persistence_dirty(&self) -> bool {
        self.persistence_dirty
    }

    /// Marks the currently scheduled snapshot write complete without changing state.
    pub fn mark_persisted(&mut self) {
        self.persistence_dirty = false;
    }

    /// Produces the storage payload, intentionally excluding ephemeral pacing state.
    #[must_use]
    pub fn ownership_snapshot(&self) -> OwnershipSnapshot {
        let clients = self
            .clients
            .iter()
            .filter(|(_, state)| !state.owned_tabs.is_empty())
            .map(|(client_id, state)| {
                let aliases = (!state.aliases.is_empty()).then(|| state.aliases.clone());
                (
                    client_id.clone(),
                    PersistedClientEntry {
                        owned_tab_ids: state.owned_tabs.iter().copied().collect(),
                        active_tab_id: state.active_tab_id,
                        last_window_id: state.last_window_id,
                        last_seen_at: state.last_seen_at,
                        aliases,
                    },
                )
            })
            .collect();
        OwnershipSnapshot { clients }
    }

    /// Restores persisted ownership after a service-worker boot.
    ///
    /// `alive_tab_ids` mirrors the extension adapter's best-effort Chrome query. `None` or an
    /// empty set trusts the snapshot, matching the current JavaScript behavior when it cannot
    /// distinguish a failed query from an empty result.
    pub fn restore_ownership(
        &mut self,
        snapshot: OwnershipSnapshot,
        alive_tab_ids: Option<&IndexSet<TabId>>,
        _now: Millis,
    ) -> RestoreReport {
        let mut report = RestoreReport::default();
        let filter_alive = alive_tab_ids.is_some_and(|ids| !ids.is_empty());
        for (client_id, entry) in snapshot.clients {
            let before = entry.owned_tab_ids.len();
            let owned_tabs: IndexSet<TabId> = entry
                .owned_tab_ids
                .into_iter()
                .filter(|tab_id| {
                    !filter_alive || alive_tab_ids.is_some_and(|ids| ids.contains(tab_id))
                })
                .collect();
            report.dropped_tab_ids += before.saturating_sub(owned_tabs.len());
            if owned_tabs.is_empty() {
                report.dropped_clients += 1;
                continue;
            }
            let aliases = entry
                .aliases
                .unwrap_or_default()
                .into_iter()
                .filter(|(_, tab_id)| owned_tabs.contains(tab_id))
                .collect();
            let active_tab_id = entry
                .active_tab_id
                .filter(|tab_id| owned_tabs.contains(tab_id));
            self.clients.insert(
                client_id,
                ClientRecord {
                    owned_tabs,
                    active_tab_id,
                    last_window_id: entry.last_window_id,
                    last_seen_at: entry.last_seen_at,
                    pacing: None,
                    aliases,
                },
            );
            report.restored_clients += 1;
        }
        report
    }

    /// Returns a copied diagnostic view of a client's state.
    #[must_use]
    pub fn client_snapshot(&self, client_id: Option<&str>) -> Option<ClientStateSnapshot> {
        client_id
            .and_then(|id| self.clients.get(id))
            .map(ClientRecord::snapshot)
    }

    /// Removes clients that have not been seen within the ownership safety window.
    pub fn evict_stale_clients(&mut self, now: Millis) -> usize {
        let before = self.clients.len();
        self.clients
            .retain(|_, state| now.saturating_sub(state.last_seen_at) <= STALE_AFTER_MS);
        before.saturating_sub(self.clients.len())
    }

    /// Sets a client's transient pacing profile and returns its new state.
    pub fn set_pacing(
        &mut self,
        client_id: Option<&str>,
        profile: PacingProfile,
        overrides: PacingOverrides,
        now: Millis,
    ) -> Option<PacingState> {
        let client_id = client_id?;
        let state = self.ensure_client(client_id, now);
        state.pacing = match profile {
            PacingProfile::Off => None,
            PacingProfile::Human => Some(PacingState {
                profile,
                min_gap_ms: overrides.min_gap_ms.unwrap_or(600),
                jitter_ms: overrides.jitter_ms.unwrap_or(600),
                last_dispatch_at: 0,
            }),
            PacingProfile::Careful => Some(PacingState {
                profile,
                min_gap_ms: overrides.min_gap_ms.unwrap_or(1_500),
                jitter_ms: overrides.jitter_ms.unwrap_or(1_500),
                last_dispatch_at: 0,
            }),
            PacingProfile::Fast => Some(PacingState {
                profile,
                min_gap_ms: overrides.min_gap_ms.unwrap_or(0),
                jitter_ms: overrides.jitter_ms.unwrap_or(0),
                last_dispatch_at: 0,
            }),
        };
        state.last_seen_at = now;
        state.pacing
    }

    /// Returns a copy of a client's transient pacing state.
    #[must_use]
    pub fn pacing(&self, client_id: Option<&str>) -> Option<PacingState> {
        client_id
            .and_then(|id| self.clients.get(id))
            .and_then(|state| state.pacing)
    }

    /// Consumes the next pacing delay using a host-provided random sample.
    pub fn consume_pacing_delay(
        &mut self,
        client_id: Option<&str>,
        now: Millis,
        random_sample: f64,
    ) -> Millis {
        let Some(client_id) = client_id else {
            return 0;
        };
        let Some(state) = self.clients.get_mut(client_id) else {
            return 0;
        };
        let Some(pacing) = state.pacing.as_mut() else {
            return 0;
        };
        let jitter =
            (random_sample * (pacing.jitter_ms.saturating_add(1) as f64)).floor() as Millis;
        let target = pacing.min_gap_ms.saturating_add(jitter);
        let elapsed = now.saturating_sub(pacing.last_dispatch_at);
        let delay = target.saturating_sub(elapsed).max(0);
        pacing.last_dispatch_at = now.saturating_add(delay);
        state.last_seen_at = now;
        delay
    }

    /// Claims a tab, transferring it from any other client and returning that prior owner.
    pub fn claim_tab(
        &mut self,
        client_id: Option<&str>,
        tab_id: TabId,
        window_id: Option<WindowId>,
        now: Millis,
    ) -> Option<String> {
        let client_id = client_id?;
        self.evict_stale_clients(now);
        let mut previous_owner = None;
        for (other_id, other_state) in &mut self.clients {
            if other_id == client_id {
                continue;
            }
            if other_state.owned_tabs.shift_remove(&tab_id) {
                previous_owner = Some(other_id.clone());
                if other_state.active_tab_id == Some(tab_id) {
                    other_state.active_tab_id = None;
                }
            }
        }
        let state = self.ensure_client(client_id, now);
        state.owned_tabs.insert(tab_id);
        state.active_tab_id = Some(tab_id);
        if let Some(window_id) = window_id {
            state.last_window_id = Some(window_id);
        }
        state.last_seen_at = now;
        self.persistence_dirty = true;
        previous_owner
    }

    /// Releases one owned tab without closing it or modifying stale aliases.
    pub fn release_tab(&mut self, client_id: Option<&str>, tab_id: TabId) -> bool {
        let Some(client_id) = client_id else {
            return false;
        };
        let Some(state) = self.clients.get_mut(client_id) else {
            return false;
        };
        let removed = state.owned_tabs.shift_remove(&tab_id);
        if removed {
            if state.active_tab_id == Some(tab_id) {
                state.active_tab_id = None;
            }
            self.persistence_dirty = true;
        }
        removed
    }

    /// Finds the first current owner in client insertion order.
    #[must_use]
    pub fn tab_owner(&self, tab_id: TabId) -> Option<&str> {
        self.clients.iter().find_map(|(client_id, state)| {
            state
                .owned_tabs
                .contains(&tab_id)
                .then_some(client_id.as_str())
        })
    }

    /// Releases all tabs for a disconnected client while retaining its empty record.
    pub fn release_client(&mut self, client_id: Option<&str>, now: Millis) -> usize {
        let Some(client_id) = client_id else {
            return 0;
        };
        let Some(state) = self.clients.get_mut(client_id) else {
            return 0;
        };
        let released = state.owned_tabs.len();
        state.owned_tabs.clear();
        state.active_tab_id = None;
        state.aliases.clear();
        state.last_seen_at = now;
        self.persistence_dirty = true;
        released
    }

    /// Resolves an explicit tab or the caller's most recent owned tab.
    pub fn resolve_owned_tab(
        &mut self,
        client_id: Option<&str>,
        explicit_tab_id: Option<TabId>,
        access: TargetAccess,
        now: Millis,
    ) -> TargetResolution {
        if let Some(tab_id) = explicit_tab_id {
            if access == TargetAccess::Read {
                return TargetResolution {
                    tab_id: Some(tab_id),
                    ..TargetResolution::default()
                };
            }
            if let Some(owner) = self.tab_owner(tab_id)
                && Some(owner) != client_id
            {
                return TargetResolution {
                    conflict: Some(TabConflict {
                        tab_id,
                        owner: owner.to_owned(),
                    }),
                    ..TargetResolution::default()
                };
            }
            if client_id.is_some() {
                self.claim_tab(client_id, tab_id, None, now);
            }
            return TargetResolution {
                tab_id: Some(tab_id),
                ..TargetResolution::default()
            };
        }
        let Some(client_id) = client_id else {
            return TargetResolution::default();
        };
        let Some(state) = self.clients.get_mut(client_id) else {
            return TargetResolution::default();
        };
        if state
            .active_tab_id
            .is_some_and(|tab_id| state.owned_tabs.contains(&tab_id))
        {
            return TargetResolution {
                tab_id: state.active_tab_id,
                ..TargetResolution::default()
            };
        }
        if let Some(tab_id) = state.owned_tabs.iter().next_back().copied() {
            return TargetResolution {
                tab_id: Some(tab_id),
                ..TargetResolution::default()
            };
        }
        if state.active_tab_id.take().is_some() {
            self.persistence_dirty = true;
        }
        TargetResolution::default()
    }

    /// Resolves an alias, defensively removing a stale mapping when encountered.
    pub fn resolve_alias(
        &mut self,
        client_id: Option<&str>,
        alias: &JsString,
    ) -> Result<TabId, AliasMissReason> {
        let Some(alias) = alias.as_utf8() else {
            return Err(AliasMissReason::UnknownAlias);
        };
        let Some(client_id) = client_id else {
            return Err(AliasMissReason::UnknownAlias);
        };
        let Some(state) = self.clients.get_mut(client_id) else {
            return Err(AliasMissReason::UnknownAlias);
        };
        let Some(tab_id) = state.aliases.get(alias).copied() else {
            return Err(AliasMissReason::UnknownAlias);
        };
        if !state.owned_tabs.contains(&tab_id) {
            state.aliases.shift_remove(alias);
            self.persistence_dirty = true;
            return Err(AliasMissReason::TabClosed);
        }
        Ok(tab_id)
    }

    /// Resolves the dispatcher-level `tabId`/`tabAlias` target contract.
    pub fn resolve_target(&mut self, request: &TargetRequest, now: Millis) -> TargetResolution {
        let alias = request
            .trimmed_tab_alias
            .as_ref()
            .filter(|alias| alias.utf16_units().next().is_some());
        if let (Some(tab_id), Some(alias)) = (request.explicit_tab_id, alias) {
            return TargetResolution {
                conflicting_args: Some(ConflictingTabTargetArgs {
                    tab_id,
                    alias: alias.clone(),
                }),
                ..TargetResolution::default()
            };
        }
        if let Some(alias) = alias {
            return match self.resolve_alias(request.client_id.as_deref(), alias) {
                Ok(tab_id) => self.resolve_owned_tab(
                    request.client_id.as_deref(),
                    Some(tab_id),
                    request.access,
                    now,
                ),
                Err(reason) => TargetResolution {
                    alias_miss: Some(AliasMiss {
                        alias: alias.clone(),
                        reason,
                    }),
                    ..TargetResolution::default()
                },
            };
        }
        self.resolve_owned_tab(
            request.client_id.as_deref(),
            request.explicit_tab_id,
            request.access,
            now,
        )
    }

    /// Records a successful tab touch, claiming it if the client did not already own it.
    pub fn record_client_tab(
        &mut self,
        client_id: Option<&str>,
        tab_id: TabId,
        window_id: Option<WindowId>,
        now: Millis,
    ) {
        let _ = self.claim_tab(client_id, tab_id, window_id, now);
    }

    /// Records a successful window-only touch.
    pub fn record_client_window(
        &mut self,
        client_id: Option<&str>,
        window_id: WindowId,
        now: Millis,
    ) {
        let Some(client_id) = client_id else {
            return;
        };
        let state = self.ensure_client(client_id, now);
        state.last_window_id = Some(window_id);
        state.last_seen_at = now;
        self.persistence_dirty = true;
    }

    /// Resolves an explicit window or the caller's most recent window hint.
    #[must_use]
    pub fn resolve_owned_window(
        &self,
        client_id: Option<&str>,
        explicit_window_id: Option<WindowId>,
    ) -> Option<WindowId> {
        explicit_window_id.or_else(|| {
            client_id
                .and_then(|id| self.clients.get(id))
                .and_then(|state| state.last_window_id)
        })
    }

    /// Clears a stale window hint after the host's `chrome.windows.get` probe fails.
    pub fn clear_last_window(&mut self, client_id: Option<&str>, window_id: WindowId) -> bool {
        let Some(client_id) = client_id else {
            return false;
        };
        let Some(state) = self.clients.get_mut(client_id) else {
            return false;
        };
        if state.last_window_id != Some(window_id) {
            return false;
        }
        state.last_window_id = None;
        self.persistence_dirty = true;
        true
    }

    /// Returns whether a JavaScript string satisfies the alias grammar without lossy UTF-8 conversion.
    #[must_use]
    pub fn is_valid_alias_js(alias: &JsString) -> bool {
        let mut units = alias.utf16_units();
        let Some(first) = units.next() else {
            return false;
        };
        if !is_ascii_lowercase_unit(first) {
            return false;
        }
        let mut len = 1;
        for unit in units {
            len += 1;
            if len > 32
                || !(is_ascii_lowercase_unit(unit)
                    || is_ascii_digit_unit(unit)
                    || matches!(unit, 0x5F | 0x2D))
            {
                return false;
            }
        }
        true
    }

    /// Returns whether an UTF-8 alias satisfies the browser tool's lowercase ASCII grammar.
    #[must_use]
    pub fn is_valid_alias(alias: &str) -> bool {
        Self::is_valid_alias_js(&JsString::from(alias))
    }

    /// Sets an alias after the host's schema and ownership gates have validated it.
    ///
    /// The current TypeScript state helper deliberately does not revalidate either precondition;
    /// preserving that separation lets the caller retain its existing `INVALID_ARGS` envelope.
    pub fn set_alias(
        &mut self,
        client_id: Option<&str>,
        alias: String,
        tab_id: TabId,
        now: Millis,
    ) -> Option<TabId> {
        let client_id = client_id?;
        let state = self.ensure_client(client_id, now);
        let previous = state.aliases.insert(alias, tab_id);
        self.persistence_dirty = true;
        previous
    }

    /// Returns a copied alias map for `chrome_owned_tabs`.
    #[must_use]
    pub fn aliases(&self, client_id: Option<&str>) -> IndexMap<String, TabId> {
        client_id
            .and_then(|id| self.clients.get(id))
            .map_or_else(IndexMap::new, |state| state.aliases.clone())
    }

    /// Evicts a closed tab from every client and cleans aliases that point to it.
    pub fn handle_tab_removed(&mut self, tab_id: TabId) -> bool {
        let mut touched = false;
        for state in self.clients.values_mut() {
            touched |= state.owned_tabs.shift_remove(&tab_id);
            if state.active_tab_id == Some(tab_id) {
                state.active_tab_id = None;
                touched = true;
            }
            let old_len = state.aliases.len();
            state
                .aliases
                .retain(|_, mapped_tab_id| *mapped_tab_id != tab_id);
            touched |= old_len != state.aliases.len();
        }
        if touched {
            self.persistence_dirty = true;
        }
        touched
    }

    /// Clears stale window hints from every client after a window closes.
    pub fn handle_window_removed(&mut self, window_id: WindowId) -> bool {
        let mut touched = false;
        for state in self.clients.values_mut() {
            if state.last_window_id == Some(window_id) {
                state.last_window_id = None;
                touched = true;
            }
        }
        if touched {
            self.persistence_dirty = true;
        }
        touched
    }

    /// Produces the initial portable dispatch decision without performing Chrome effects.
    pub fn plan_dispatch(&mut self, request: &DispatchRequest, now: Millis) -> DispatchPlan {
        let resolved = self.resolve_target(&request.target, now);
        if let Some(error) = resolved.as_error() {
            return DispatchPlan::Rejected { error };
        }
        if let Some(tab_id) = resolved.tab_id {
            let forwarded_window_id = self.dispatch_forwarded_window(request);
            let auto_spawn_preferred_window_id =
                self.resolve_owned_window(request.target.client_id.as_deref(), None);
            return match request.tab_liveness {
                TabLiveness::Unprobed => DispatchPlan::NeedsLivenessProbe {
                    continuation: DispatchContinuation {
                        request: request.clone(),
                        resolved_tab_id: tab_id,
                        forwarded_window_id,
                        auto_spawn_preferred_window_id,
                    },
                },
                liveness => self.finish_dispatch(request, Some(tab_id), liveness, None),
            };
        }
        self.finish_dispatch(request, None, request.tab_liveness, None)
    }

    /// Completes a liveness continuation without re-resolving the client's active tab.
    pub fn resume_dispatch(
        &mut self,
        continuation: DispatchContinuation,
        liveness: TabLiveness,
    ) -> DispatchPlan {
        debug_assert!(liveness != TabLiveness::Unprobed);
        self.finish_dispatch(
            &continuation.request,
            Some(continuation.resolved_tab_id),
            liveness,
            Some((
                continuation.forwarded_window_id,
                continuation.auto_spawn_preferred_window_id,
            )),
        )
    }

    fn finish_dispatch(
        &mut self,
        request: &DispatchRequest,
        resolved_tab_id: Option<TabId>,
        liveness: TabLiveness,
        preserved_window_hints: Option<(Option<WindowId>, Option<WindowId>)>,
    ) -> DispatchPlan {
        let tab_id = match (resolved_tab_id, liveness) {
            (Some(tab_id), TabLiveness::Missing) => {
                let _ = self.release_tab(request.target.client_id.as_deref(), tab_id);
                None
            }
            (tab_id, _) => tab_id,
        };
        let (forwarded_window_id, auto_spawn_preferred_window_id) = preserved_window_hints
            .unwrap_or_else(|| {
                (
                    self.dispatch_forwarded_window(request),
                    self.resolve_owned_window(request.target.client_id.as_deref(), None),
                )
            });
        let auto_spawn = (tab_id.is_none()
            && request.target.access == TargetAccess::Mutate
            && request.auto_spawn_policy == AutoSpawnPolicy::Enabled
            && request.target.client_id.is_some()
            && request.url_targeting == UrlTargeting::Absent)
            .then_some(AutoSpawnRequest {
                preferred_window_id: auto_spawn_preferred_window_id,
            });
        let forwarded_tab_id = if request.url_targeting == UrlTargeting::Provided
            && request.target.explicit_tab_id.is_none()
        {
            None
        } else {
            tab_id
        };
        DispatchPlan::Ready {
            target: DispatchReady {
                resolved_tab_id: tab_id,
                forwarded_tab_id,
                forwarded_window_id,
                auto_spawn,
            },
        }
    }

    fn dispatch_forwarded_window(&self, request: &DispatchRequest) -> Option<WindowId> {
        if request.window_targeting == WindowTargeting::ExplicitOnly {
            request.explicit_window_id
        } else {
            self.resolve_owned_window(
                request.target.client_id.as_deref(),
                request.explicit_window_id,
            )
        }
    }

    /// Clamps a numeric caller override using the dispatcher's existing range.
    #[must_use]
    pub fn clamp_tab_lock_timeout(timeout_ms: Option<Millis>) -> Option<Millis> {
        timeout_ms.map(|timeout| timeout.clamp(MIN_TAB_LOCK_TIMEOUT_MS, MAX_TOOL_TIMEOUT_MS))
    }

    /// Admits one mutating call to a per-tab queue without creating timers or Promises.
    pub fn admit_tab_lock(
        &mut self,
        tab_id: TabId,
        client_id: Option<String>,
        timeout_ms: Option<Millis>,
        now: Millis,
    ) -> QueueAdmission {
        let state = self.queues.entry(tab_id).or_default();
        if state.entries.len() >= MAX_TAB_QUEUE_DEPTH {
            return QueueAdmission::Rejected {
                error: queue_full_error(tab_id, state.entries.len()),
            };
        }
        let ticket = self.next_ticket;
        self.next_ticket = self.next_ticket.checked_add(1).unwrap_or(1);
        let queued_at_position = state.entries.len() + 1;
        state.entries.push(QueueEntry {
            ticket,
            client_id,
            enqueued_at: now,
            queued_at_position,
            started_at: None,
        });
        if state.entries.len() == 1 {
            let entry = state
                .entries
                .first_mut()
                .expect("just-pushed queue entry is present");
            entry.started_at = Some(now);
            return QueueAdmission::Granted(QueueGrant {
                ticket,
                queued_at_position,
                waited_ms: 0,
            });
        }
        let timeout = timeout_ms.unwrap_or(DEFAULT_TAB_LOCK_TIMEOUT_MS).max(0);
        QueueAdmission::Queued(QueuedTicket {
            ticket,
            queued_at_position,
            deadline_at: now.saturating_add(timeout),
        })
    }

    /// Removes a still-pending ticket after its host timer fires.
    pub fn timeout_tab_lock(
        &mut self,
        tab_id: TabId,
        ticket: TicketId,
        now: Millis,
        timeout_ms: Millis,
    ) -> QueueTransition {
        let Some(state) = self.queues.get_mut(&tab_id) else {
            return QueueTransition::default();
        };
        let Some(index) = state
            .entries
            .iter()
            .position(|entry| entry.ticket == ticket)
        else {
            return QueueTransition::default();
        };
        if state.entries[index].started_at.is_some() {
            return QueueTransition::default();
        }
        state.entries.remove(index);
        let mut transition = self.promote_after_change(tab_id, now);
        transition.cancelled.push(CancelledTicket {
            ticket,
            error: tab_lock_timeout_error(tab_id, timeout_ms),
        });
        transition
    }

    /// Releases a holder idempotently and promotes the next fair waiter, if any.
    pub fn release_tab_lock(
        &mut self,
        tab_id: TabId,
        ticket: TicketId,
        now: Millis,
    ) -> QueueTransition {
        let Some(state) = self.queues.get_mut(&tab_id) else {
            return QueueTransition::default();
        };
        let Some(index) = state
            .entries
            .iter()
            .position(|entry| entry.ticket == ticket)
        else {
            return QueueTransition::default();
        };
        let Some(started_at) = state.entries[index].started_at else {
            return QueueTransition::default();
        };
        let entry = state.entries.remove(index);
        let sample = now.saturating_sub(started_at);
        state.mean_hold_ms = if state.mean_hold_ms == 0.0 {
            sample as f64
        } else {
            state.mean_hold_ms * 0.7 + sample as f64 * 0.3
        };
        state.served_total = state.served_total.saturating_add(1);
        state.last_served_client_id = entry.client_id;
        self.promote_after_change(tab_id, now)
    }

    /// Cancels all pending and held callbacks when Chrome reports that a tab closed.
    pub fn close_tab_queue(&mut self, tab_id: TabId) -> QueueTransition {
        let Some(state) = self.queues.shift_remove(&tab_id) else {
            return QueueTransition::default();
        };
        let cancelled = state
            .entries
            .into_iter()
            .map(|entry| CancelledTicket {
                ticket: entry.ticket,
                error: tab_closed_error(tab_id, entry.started_at.is_some()),
            })
            .collect();
        QueueTransition {
            promoted: None,
            cancelled,
            retired: true,
        }
    }

    /// Returns an inspector record for one active queue.
    #[must_use]
    pub fn inspect_tab_queue(&self, tab_id: TabId, now: Millis) -> Option<QueueTabSnapshot> {
        self.queues
            .get(&tab_id)
            .map(|state| snapshot_queue(tab_id, state, now))
    }

    /// Returns inspector records in JavaScript `Map` insertion order.
    #[must_use]
    pub fn inspect_all_tab_queues(&self, now: Millis) -> Vec<QueueTabSnapshot> {
        self.queues
            .iter()
            .map(|(tab_id, state)| snapshot_queue(*tab_id, state, now))
            .collect()
    }

    /// Returns the number of tabs with a held or pending lock.
    #[must_use]
    pub fn active_locked_tab_count(&self) -> usize {
        self.queues.len()
    }

    /// Clears queue policy state for the extension's existing test reset hook.
    pub fn _reset_queues_for_test(&mut self) {
        self.queues.clear();
        self.next_ticket = 1;
    }

    /// Sets a queue's hold-time estimator for deterministic extension tests.
    pub fn _set_queue_mean_hold_for_test(&mut self, tab_id: TabId, mean_hold_ms: Millis) {
        self.queues.entry(tab_id).or_default().mean_hold_ms = mean_hold_ms as f64;
    }

    /// Snapshots raw queue entry timing for the extension's existing test hook.
    #[must_use]
    pub fn _queue_entries_for_test(&self, tab_id: TabId) -> Vec<QueueEntryTestSnapshot> {
        self.queues.get(&tab_id).map_or_else(Vec::new, |state| {
            state
                .entries
                .iter()
                .map(|entry| QueueEntryTestSnapshot {
                    ticket: entry.ticket,
                    client_id: entry.client_id.clone(),
                    enqueued_at: entry.enqueued_at,
                    started_at: entry.started_at,
                })
                .collect()
        })
    }

    fn ensure_client(&mut self, client_id: &str, now: Millis) -> &mut ClientRecord {
        self.clients
            .entry(client_id.to_owned())
            .or_insert_with(|| ClientRecord::new(now))
    }

    fn promote_after_change(&mut self, tab_id: TabId, now: Millis) -> QueueTransition {
        let is_empty = self
            .queues
            .get(&tab_id)
            .is_some_and(|state| state.entries.is_empty());
        if is_empty {
            self.queues.shift_remove(&tab_id);
            return QueueTransition {
                retired: true,
                ..QueueTransition::default()
            };
        }
        let Some(state) = self.queues.get_mut(&tab_id) else {
            return QueueTransition::default();
        };
        if state
            .entries
            .first()
            .is_some_and(|entry| entry.started_at.is_some())
        {
            return QueueTransition::default();
        }
        if let Some(last_served) = state.last_served_client_id.as_deref()
            && let Some(index) = state
                .entries
                .iter()
                .position(|entry| entry.client_id.as_deref() != Some(last_served))
            && index != 0
        {
            let entry = state.entries.remove(index);
            state.entries.insert(0, entry);
        }
        let entry = state
            .entries
            .first_mut()
            .expect("nonempty queue has a first entry");
        entry.started_at = Some(now);
        QueueTransition {
            promoted: Some(QueueGrant {
                ticket: entry.ticket,
                queued_at_position: entry.queued_at_position,
                waited_ms: now.saturating_sub(entry.enqueued_at),
            }),
            ..QueueTransition::default()
        }
    }
}

impl TargetResolution {
    /// Converts a failed resolution into the extension's existing tool-error fields.
    #[must_use]
    pub fn as_error(&self) -> Option<BrowserStateError> {
        if let Some(args) = &self.conflicting_args {
            return Some(BrowserStateError {
                code: BrowserStateErrorCode::InvalidArgs,
                message: JsString::from("Cannot pass both `tabId` and `tabAlias` — choose one."),
                details: object_document([
                    ("tabId", numeric_document(args.tab_id)),
                    ("alias", JsonDocument::string(args.alias.clone())),
                ]),
            });
        }
        if let Some(alias_miss) = &self.alias_miss {
            let reason = match alias_miss.reason {
                AliasMissReason::UnknownAlias => "unknown-alias",
                AliasMissReason::TabClosed => "tab-closed",
            };
            let mut message = JsString::from("No tab aliased as \"");
            message.push_js_string(&alias_miss.alias);
            message.push_str("\" for this client (");
            message.push_str(reason);
            message.push_str("). Use browser_alias_tab to set it first.");
            return Some(BrowserStateError {
                code: BrowserStateErrorCode::TabNotFound,
                message,
                details: object_document([
                    ("alias", JsonDocument::string(alias_miss.alias.clone())),
                    ("reason", JsonDocument::from(reason)),
                ]),
            });
        }
        self.conflict.as_ref().map(|conflict| {
            let mut message = JsString::from("Tab ");
            message.push_str(&conflict.tab_id.to_string());
            message.push_str(" is owned by client ");
            message.push_str(&conflict.owner);
            BrowserStateError {
                code: BrowserStateErrorCode::TabNotOwned,
                message,
                details: object_document([
                    ("tabId", numeric_document(conflict.tab_id)),
                    ("owner", JsonDocument::from(conflict.owner.clone())),
                ]),
            }
        })
    }
}

fn object_document<const N: usize>(fields: [(&str, JsonDocument); N]) -> JsonDocument {
    JsonDocument::object(fields)
}

fn numeric_document(value: impl Into<serde_json::Value>) -> JsonDocument {
    JsonDocument::from(value.into())
}

fn queue_full_error(tab_id: TabId, depth: usize) -> BrowserStateError {
    BrowserStateError {
        code: BrowserStateErrorCode::QueueFull,
        message: JsString::from(format!(
            "Tab {tab_id} queue is at capacity ({MAX_TAB_QUEUE_DEPTH} waiters); back off and retry, or pin a different tabId."
        )),
        details: object_document([
            ("tabId", numeric_document(tab_id)),
            ("depth", numeric_document(depth as u64)),
            ("max", numeric_document(MAX_TAB_QUEUE_DEPTH as u64)),
        ]),
    }
}

fn tab_lock_timeout_error(tab_id: TabId, timeout_ms: Millis) -> BrowserStateError {
    BrowserStateError {
        code: BrowserStateErrorCode::TabLockTimeout,
        message: JsString::from(format!(
            "Lock acquisition for tab {tab_id} timed out after {timeout_ms}ms"
        )),
        details: object_document([
            ("tabId", numeric_document(tab_id)),
            ("timeoutMs", numeric_document(timeout_ms)),
        ]),
    }
}

fn tab_closed_error(tab_id: TabId, was_holder: bool) -> BrowserStateError {
    let role = if was_holder { "holding" } else { "waiting for" };
    BrowserStateError {
        code: BrowserStateErrorCode::TabClosed,
        message: JsString::from(format!("Tab {tab_id} closed while {role} the tab queue")),
        details: object_document([("tabId", numeric_document(tab_id))]),
    }
}

fn snapshot_queue(tab_id: TabId, state: &TabQueueState, now: Millis) -> QueueTabSnapshot {
    let holder_entry = state
        .entries
        .first()
        .filter(|entry| entry.started_at.is_some());
    let holder = holder_entry.map(|entry| QueueHolderSnapshot {
        client_id: entry.client_id.clone(),
        held_ms: now.saturating_sub(entry.started_at.expect("holder has start time")),
        ticket: entry.ticket,
    });
    let waiter_start = usize::from(holder.is_some());
    let base_hold = if state.mean_hold_ms > 0.0 {
        state.mean_hold_ms
    } else {
        DEFAULT_EXPECTED_HOLD_MS as f64
    };
    let waiters = state.entries[waiter_start..]
        .iter()
        .enumerate()
        .map(|(index, entry)| QueueWaiterSnapshot {
            client_id: entry.client_id.clone(),
            position: index + if holder.is_some() { 2 } else { 1 },
            waited_ms: now.saturating_sub(entry.enqueued_at),
            expected_wait_ms: (index + 1) as f64 * base_hold,
            ticket: entry.ticket,
        })
        .collect();
    QueueTabSnapshot {
        tab_id,
        depth: state.entries.len(),
        served_total: state.served_total,
        mean_hold_ms: state.mean_hold_ms,
        holder,
        waiters,
    }
}

fn is_ascii_lowercase_unit(unit: u16) -> bool {
    (u16::from(b'a')..=u16::from(b'z')).contains(&unit)
}

fn is_ascii_digit_unit(unit: u16) -> bool {
    (u16::from(b'0')..=u16::from(b'9')).contains(&unit)
}

#[cfg(test)]
mod tests {
    use super::{
        AutoSpawnPolicy, BrowserState, DispatchPlan, DispatchRequest, TabLiveness, TargetAccess,
        TargetRequest, UrlTargeting, WindowTargeting,
    };

    fn mutating_request(client_id: &str) -> DispatchRequest {
        DispatchRequest {
            target: TargetRequest {
                client_id: Some(client_id.to_owned()),
                access: TargetAccess::Mutate,
                ..TargetRequest::default()
            },
            auto_spawn_policy: AutoSpawnPolicy::Disabled,
            url_targeting: UrlTargeting::Absent,
            window_targeting: WindowTargeting::UseClientHint,
            ..DispatchRequest::default()
        }
    }

    #[test]
    fn liveness_continuation_keeps_its_original_tab_and_window_hints() {
        let mut state = BrowserState::new();
        state.claim_tab(Some("alice"), 10, Some(1), 0);
        let mut request = mutating_request("alice");
        request.auto_spawn_policy = AutoSpawnPolicy::Enabled;
        let continuation = match state.plan_dispatch(&request, 1) {
            DispatchPlan::NeedsLivenessProbe { continuation } => continuation,
            plan => panic!("expected liveness continuation, got {plan:?}"),
        };

        state.record_client_tab(Some("alice"), 20, Some(2), 2);
        let plan = state.resume_dispatch(continuation, TabLiveness::Missing);

        assert_eq!(state.tab_owner(10), None);
        assert_eq!(state.tab_owner(20), Some("alice"));
        assert!(matches!(
            plan,
            DispatchPlan::Ready {
                target: super::DispatchReady {
                    resolved_tab_id: None,
                    forwarded_window_id: Some(1),
                    auto_spawn: Some(super::AutoSpawnRequest {
                        preferred_window_id: Some(1)
                    }),
                    ..
                }
            }
        ));
    }

    #[test]
    fn auto_spawn_uses_client_hint_not_explicit_forwarded_window() {
        let mut state = BrowserState::new();
        state.record_client_window(Some("alice"), 3, 0);
        let mut request = mutating_request("alice");
        request.auto_spawn_policy = AutoSpawnPolicy::Enabled;
        request.explicit_window_id = Some(9);

        let plan = state.plan_dispatch(&request, 1);
        assert!(matches!(
            plan,
            DispatchPlan::Ready {
                target: super::DispatchReady {
                    forwarded_window_id: Some(9),
                    auto_spawn: Some(super::AutoSpawnRequest {
                        preferred_window_id: Some(3)
                    }),
                    ..
                }
            }
        ));
    }

    #[test]
    fn unresolved_lone_surrogate_alias_stays_lossless_in_error_json() {
        let mut state = BrowserState::new();
        let request = DispatchRequest {
            target: TargetRequest {
                client_id: Some("alice".to_owned()),
                trimmed_tab_alias: Some(crate::arguments::JsString::from_utf16_units(vec![0xD800])),
                access: TargetAccess::Mutate,
                ..TargetRequest::default()
            },
            ..DispatchRequest::default()
        };

        let DispatchPlan::Rejected { error } = state.plan_dispatch(&request, 0) else {
            panic!("unresolved alias must reject");
        };
        assert_eq!(
            error.as_json_document().to_json_text(),
            r#"{"code":"TAB_NOT_FOUND","message":"No tab aliased as \"\ud800\" for this client (unknown-alias). Use browser_alias_tab to set it first.","details":{"alias":"\ud800","reason":"unknown-alias"}}"#
        );
    }
}
