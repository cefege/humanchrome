//! Validated coordinator identities, worker origins, and inventory snapshots.

use std::{collections::HashSet, fmt};

use reqwest::Url;
use serde::{Deserialize, Serialize};

/// A coordinator client credential and authorization level.
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
pub struct CoordinatorClient {
    /// Stable client identity used for durable bindings.
    pub id: String,
    /// Bearer credential, redacted by [`fmt::Debug`].
    pub token: String,
    /// Whether this credential may mutate fleet configuration and lifecycle state.
    pub admin: bool,
}

/// A worker origin and its distinct worker credential.
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
pub struct CoordinatorWorker {
    /// Stable worker identity.
    pub id: String,
    /// HTTP(S) origin without a path, query, fragment, or user info.
    pub url: String,
    /// Bearer credential, redacted by [`fmt::Debug`].
    pub token: String,
}

/// Coordinator process settings.
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
pub struct CoordinatorConfig {
    /// Logical coordinator identity, used to scope PostgreSQL rows and advisory locks.
    pub id: String,
    /// Interface address for the parent binary to bind.
    pub host: String,
    /// Port for the parent binary to bind.
    pub port: u16,
    /// PostgreSQL connection URL.
    #[serde(rename = "databaseUrl")]
    pub database_url: String,
    /// Lease duration enforced by both coordinator and workers.
    #[serde(rename = "leaseTtlSec")]
    pub lease_ttl_sec: u32,
    /// External clients permitted to call the coordinator.
    pub clients: Vec<CoordinatorClient>,
    /// Workers forming the profile inventory.
    pub workers: Vec<CoordinatorWorker>,
}

impl fmt::Debug for CoordinatorClient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CoordinatorClient")
            .field("id", &self.id)
            .field("token", &"<redacted>")
            .field("admin", &self.admin)
            .finish()
    }
}

impl fmt::Debug for CoordinatorWorker {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CoordinatorWorker")
            .field("id", &self.id)
            .field("url", &"<redacted>")
            .field("token", &"<redacted>")
            .finish()
    }
}

impl fmt::Debug for CoordinatorConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CoordinatorConfig")
            .field("id", &self.id)
            .field("host", &self.host)
            .field("port", &self.port)
            .field("database_url", &"<redacted>")
            .field("lease_ttl_sec", &self.lease_ttl_sec)
            .field("clients", &self.clients)
            .field("workers", &self.workers)
            .finish()
    }
}

/// A worker inventory entry as returned by `/v1/worker`.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProfileSnapshot {
    /// Worker-local profile name.
    pub name: String,
    /// Loopback bridge port on the worker.
    pub port: u16,
    /// Allocation labels.
    pub labels: Vec<String>,
    /// Whether the profile is administratively enabled.
    pub enabled: bool,
    /// Optional fixed purpose alias.
    pub purpose: Option<String>,
    /// Worker-reported runtime state.
    pub state: ProfileState,
    /// Browser process identifier, when running.
    pub pid: Option<i64>,
    /// Current worker-side lease holder.
    #[serde(rename = "leasedBy")]
    pub leased_by: Option<String>,
    /// Most recent worker error.
    #[serde(rename = "lastError")]
    pub last_error: Option<String>,
    /// Demand-start provenance.
    #[serde(rename = "startedBy")]
    pub started_by: Option<StartedBy>,
}

/// A worker inventory document.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct WorkerInventory {
    /// Reporting worker identity.
    pub id: String,
    /// Profiles visible to that worker.
    pub profiles: Vec<ProfileSnapshot>,
}

/// Runtime profile states shared with the TypeScript worker.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProfileState {
    /// Browser is stopped.
    Stopped,
    /// Browser startup is ongoing.
    Starting,
    /// Browser process exists but is not ready.
    Running,
    /// Browser bridge is ready.
    Healthy,
    /// Supervisor retry delay is active.
    Backoff,
    /// Worker could not be reached by the coordinator.
    Unreachable,
}

/// Demand-start provenance included in inventory output.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StartedBy {
    /// Browser lane owner.
    pub agent: String,
    /// Request that caused demand start.
    pub request: String,
    /// ISO-8601 timestamp supplied by the worker.
    pub at: String,
}

/// Configuration validation errors intentionally never interpolate credentials or URLs.
#[derive(Clone, Debug, thiserror::Error, Eq, PartialEq)]
#[error(
    "invalid coordinator configuration: check identities, credentials, worker origins, database URL and lease limits"
)]
pub struct ConfigError;

impl CoordinatorConfig {
    /// Validates all trust-boundary invariants before any network connection is opened.
    ///
    /// # Errors
    /// Returns a credential-safe error when the configuration is invalid.
    pub fn validate(mut self) -> Result<Self, ConfigError> {
        if !valid_name(&self.id)
            || self.host.is_empty()
            || !valid_postgres_url(&self.database_url)
            || !(15..=900).contains(&self.lease_ttl_sec)
            || self.clients.is_empty()
            || self.workers.is_empty()
            || !self.clients.iter().any(|client| client.admin)
        {
            return Err(ConfigError);
        }
        let mut client_ids = HashSet::with_capacity(self.clients.len());
        let mut client_tokens = HashSet::with_capacity(self.clients.len());
        for client in &self.clients {
            if !valid_name(&client.id)
                || client.token.len() < 32
                || !client_ids.insert(&client.id)
                || !client_tokens.insert(&client.token)
            {
                return Err(ConfigError);
            }
        }
        let mut worker_ids = HashSet::with_capacity(self.workers.len());
        let mut worker_tokens = HashSet::with_capacity(self.workers.len());
        for worker in &mut self.workers {
            if !valid_name(&worker.id)
                || worker.token.len() < 32
                || !valid_worker_origin(&worker.url)
                || !worker_ids.insert(worker.id.clone())
                || !worker_tokens.insert(worker.token.clone())
                || client_tokens.contains(&worker.token)
            {
                return Err(ConfigError);
            }
            worker.url = Url::parse(&worker.url)
                .expect("worker URL passed validation")
                .origin()
                .ascii_serialization();
        }
        Ok(self)
    }
}

impl WorkerInventory {
    /// Rejects malformed or ambiguous worker inventory before it enters durable storage.
    ///
    /// # Errors
    /// Returns [`ConfigError`] without disclosing worker data.
    pub fn validate(self) -> Result<Self, ConfigError> {
        if !valid_name(&self.id) {
            return Err(ConfigError);
        }
        let mut names = HashSet::with_capacity(self.profiles.len());
        for profile in &self.profiles {
            if !valid_name(&profile.name) || profile.port == 0 || !names.insert(&profile.name) {
                return Err(ConfigError);
            }
        }
        Ok(self)
    }
}

fn valid_name(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 32
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

fn valid_postgres_url(value: &str) -> bool {
    value.starts_with("postgres://") || value.starts_with("postgresql://")
}

fn valid_worker_origin(value: &str) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    matches!(url.scheme(), "http" | "https")
        && !url.cannot_be_a_base()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && (url.path().is_empty() || url.path() == "/")
        && url.host_str().is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> CoordinatorConfig {
        CoordinatorConfig {
            id: "cloud".into(),
            host: "127.0.0.1".into(),
            port: 12300,
            database_url: "postgresql://localhost/humanchrome".into(),
            lease_ttl_sec: 900,
            clients: vec![
                CoordinatorClient {
                    id: "operator".into(),
                    token: "a".repeat(32),
                    admin: true,
                },
                CoordinatorClient {
                    id: "agent".into(),
                    token: "b".repeat(32),
                    admin: false,
                },
            ],
            workers: vec![CoordinatorWorker {
                id: "mac".into(),
                url: "http://mac.example.ts.net/".into(),
                token: "c".repeat(32),
            }],
        }
    }

    #[test]
    fn rejects_credential_reuse_across_trust_boundaries() {
        let mut configured = config();
        configured.workers[0].token = configured.clients[0].token.clone();
        assert_eq!(configured.validate(), Err(ConfigError));
    }

    #[test]
    fn rejects_worker_urls_that_are_not_origins() {
        for url in [
            "https://user:secret@host",
            "file:///tmp/worker",
            "http://host/path",
            "http://host?token=x",
        ] {
            let mut configured = config();
            configured.workers[0].url = url.into();
            assert_eq!(configured.validate(), Err(ConfigError), "{url}");
        }
    }

    #[test]
    fn inventory_rejects_duplicate_worker_profile_names() {
        let profile = ProfileSnapshot {
            name: "browser".into(),
            port: 12500,
            labels: vec![],
            enabled: true,
            purpose: None,
            state: ProfileState::Healthy,
            pid: Some(1),
            leased_by: None,
            last_error: None,
            started_by: None,
        };
        assert_eq!(
            WorkerInventory {
                id: "mac".into(),
                profiles: vec![profile.clone(), profile]
            }
            .validate(),
            Err(ConfigError)
        );
    }
}
