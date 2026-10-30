//! In-memory, TTL-bound exclusive fleet profile leases.

use std::{
    collections::BTreeMap,
    fmt,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

/// One agent's exclusive claim to a profile.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FleetLease {
    /// Gateway agent/session identity.
    pub agent: String,
    /// Fleet profile name.
    pub profile: String,
    /// Milliseconds since Unix epoch when the holder last renewed the claim.
    pub last_seen_ms: u64,
}

/// Result of requesting a specific profile.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AcquireLease {
    /// The request owns the profile; an expired previous holder may have been displaced.
    Acquired { displaced: Option<String> },
    /// A non-expired lease belongs to another agent.
    Held { held_by: String },
}

/// Deterministic lease table with an injected wall clock for transition tests.
pub struct FleetLeases {
    idle_ttl: Duration,
    leases: BTreeMap<String, FleetLease>,
    clock: Box<dyn Fn() -> u64 + Send + Sync>,
}

impl fmt::Debug for FleetLeases {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("FleetLeases")
            .field("idle_ttl", &self.idle_ttl)
            .field("leases", &self.leases)
            .finish_non_exhaustive()
    }
}

impl FleetLeases {
    /// Construct with the system wall clock.
    #[must_use]
    pub fn new(idle_ttl: Duration) -> Self {
        Self::with_clock(idle_ttl, || {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                .try_into()
                .unwrap_or(u64::MAX)
        })
    }

    /// Construct with a caller-owned clock, primarily for exact expiry tests.
    #[must_use]
    pub fn with_clock(idle_ttl: Duration, clock: impl Fn() -> u64 + Send + Sync + 'static) -> Self {
        Self {
            idle_ttl,
            leases: BTreeMap::new(),
            clock: Box::new(clock),
        }
    }

    /// Acquire one named profile, refusing to displace a live lease.
    pub fn acquire(
        &mut self,
        agent: impl Into<String>,
        profile: impl Into<String>,
    ) -> AcquireLease {
        let agent = agent.into();
        let profile = profile.into();
        let displaced = match self.leases.get(&profile) {
            Some(existing) if existing.agent != agent && self.is_live(existing) => {
                return AcquireLease::Held {
                    held_by: existing.agent.clone(),
                };
            }
            Some(existing) if existing.agent != agent => Some(existing.agent.clone()),
            _ => None,
        };
        self.leases.insert(
            profile.clone(),
            FleetLease {
                agent,
                profile,
                last_seen_ms: (self.clock)(),
            },
        );
        AcquireLease::Acquired { displaced }
    }

    /// Pick the alphabetically first sticky or free profile from a candidate pool.
    pub fn acquire_from_pool(&mut self, agent: &str, candidates: &[String]) -> Option<String> {
        let mut ordered = candidates.to_vec();
        ordered.sort();
        ordered.dedup();
        if let Some(profile) = ordered.iter().find(|profile| {
            self.leases
                .get(*profile)
                .is_some_and(|lease| lease.agent == agent && self.is_live(lease))
        }) {
            return Some(profile.clone());
        }
        let profile = ordered.into_iter().find(|profile| {
            self.leases
                .get(profile)
                .is_none_or(|lease| !self.is_live(lease))
        })?;
        self.leases.insert(
            profile.clone(),
            FleetLease {
                agent: agent.to_owned(),
                profile: profile.clone(),
                last_seen_ms: (self.clock)(),
            },
        );
        Some(profile)
    }

    /// Renew only a lease held by `agent`; strangers cannot extend another holder's lease.
    pub fn touch(&mut self, agent: &str, profile: &str) {
        let now = (self.clock)();
        if let Some(lease) = self
            .leases
            .get_mut(profile)
            .filter(|lease| lease.agent == agent)
        {
            lease.last_seen_ms = now;
        }
    }

    /// Release every profile held by an agent, in deterministic profile order.
    pub fn release(&mut self, agent: &str) -> Vec<String> {
        let released = self
            .leases
            .iter()
            .filter(|(_, lease)| lease.agent == agent)
            .map(|(profile, _)| profile.clone())
            .collect::<Vec<_>>();
        for profile in &released {
            self.leases.remove(profile);
        }
        released
    }

    /// Forget all expired leases and return their state at expiry.
    pub fn sweep(&mut self) -> Vec<FleetLease> {
        let expired = self
            .leases
            .values()
            .filter(|lease| !self.is_live(lease))
            .cloned()
            .collect::<Vec<_>>();
        for lease in &expired {
            self.leases.remove(&lease.profile);
        }
        expired
    }

    /// Return copies of all leases in profile-name order.
    #[must_use]
    pub fn list(&self) -> Vec<FleetLease> {
        self.leases.values().cloned().collect()
    }

    /// Find the live holder, treating an expired entry as absent without mutating the table.
    #[must_use]
    pub fn holder(&self, profile: &str) -> Option<&str> {
        self.leases
            .get(profile)
            .filter(|lease| self.is_live(lease))
            .map(|lease| lease.agent.as_str())
    }

    fn is_live(&self, lease: &FleetLease) -> bool {
        (self.clock)().saturating_sub(lease.last_seen_ms) < self.idle_ttl.as_millis() as u64
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    #[test]
    fn leases_stick_then_expire_at_exact_ttl_boundary() {
        let now = Arc::new(Mutex::new(0_u64));
        let clock = Arc::clone(&now);
        let mut leases = FleetLeases::with_clock(Duration::from_secs(1), move || {
            *clock.lock().expect("clock")
        });
        assert_eq!(
            leases.acquire_from_pool("a", &["p02".to_owned(), "p01".to_owned()]),
            Some("p01".to_owned())
        );
        assert_eq!(
            leases.acquire_from_pool("b", &["p01".to_owned(), "p02".to_owned()]),
            Some("p02".to_owned())
        );
        *now.lock().expect("clock") = 1_000;
        assert!(
            matches!(leases.acquire("c", "p01"), AcquireLease::Acquired { displaced: Some(holder) } if holder == "a")
        );
    }
}
