//! Destructive profile protection is enforced before every native tool forwarding path.

use humanchrome_contracts::CONTRACT;
use humanchrome_core::json_document::JsonDocument;
use std::sync::{Arc, Mutex};

use super::config::{ConfigStore, is_javascript_truthy, javascript_string};

const CACHE_MS: u64 = 30_000;

/// A denial preserves the original arguments and native refusal text.
#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct WipeRefusal {
    /// Unmodified caller arguments, including omitted versus explicit null.
    pub args: Option<JsonDocument>,
    /// Existing caller-visible protection message.
    pub message: String,
}

/// The native bridge owns one protection cache, with an explicit injected clock.
#[derive(Debug, Default)]
pub(crate) struct ProtectionCache {
    cached: Mutex<Option<(u64, Option<Arc<str>>)>>,
}

impl ProtectionCache {
    /// Look up the configured purpose/seed, retaining the existing stale-on-read-error behavior.
    ///
    /// Outside a fleet profile no filesystem access occurs. A cold config read failure
    /// returns null as the legacy runtime does; it is not cached as an unprotected profile.
    pub(crate) async fn current(
        &self,
        profile: Option<&str>,
        config: &ConfigStore,
        clock: &impl Fn() -> u64,
    ) -> Option<Arc<str>> {
        let profile = profile.filter(|value| !value.is_empty())?;
        let now_ms = clock();
        {
            let cached = self
                .cached
                .lock()
                .expect("purpose protection cache lock poisoned");
            if let Some((at, protection)) = cached.as_ref()
                && now_ms.saturating_sub(*at) < CACHE_MS
            {
                return protection.clone();
            }
        }
        let config = match config.load().await {
            Ok(config) => config,
            Err(error) => {
                tracing::error!(%error, "fleet: purpose guard could not read fleet.json");
                return self
                    .cached
                    .lock()
                    .expect("purpose protection cache lock poisoned")
                    .as_ref()
                    .and_then(|(_, protection)| protection.clone());
            }
        };
        let entry = config["profiles"].as_array().and_then(|profiles| {
            profiles
                .iter()
                .find(|entry| entry["name"].as_str() == Some(profile))
        });
        let protection = entry.and_then(|entry| {
            let purpose = entry.get("purpose");
            if is_javascript_truthy(purpose) {
                Some(format!(
                    "bound to purpose \"{}\"",
                    javascript_string(purpose)
                ))
            } else {
                let seed = entry.get("seededFrom");
                is_javascript_truthy(seed)
                    .then(|| format!("seeded from {}", javascript_string(seed)))
            }
        });
        let protection = protection.map(Arc::<str>::from);
        let at = clock();
        *self
            .cached
            .lock()
            .expect("purpose protection cache lock poisoned") = Some((at, protection.clone()));
        protection
    }
}

/// Apply the one native wipe policy and strip the native-only confirmation flag.
///
/// # Errors
/// Refuses an unscoped, unconfirmed wipe on a purpose-bound or seeded profile.
pub fn evaluate(
    tool_name: &str,
    mut args: Option<JsonDocument>,
    protection: Option<&str>,
) -> Result<Option<JsonDocument>, WipeRefusal> {
    let clear_name = CONTRACT["catalog"]["toolNames"]["BROWSER"]["CLEAR_BROWSING_DATA"]
        .as_str()
        .expect("exported clear-browsing-data tool name");
    if let Some(protection) = protection.filter(|_| tool_name == clear_name) {
        let confirmed = args
            .as_ref()
            .and_then(|args| args.get("confirmProfileWipe"))
            .and_then(|value| value.as_bool())
            == Some(true);
        let scoped = args
            .as_ref()
            .and_then(|args| args.get("origins"))
            .and_then(|value| value.array_len())
            .is_some_and(|length| length != 0);
        if !confirmed && !scoped {
            return Err(WipeRefusal {
                args,
                message: format!(
                    "profile is {protection}; chrome_clear_browsing_data without \"origins\" clears every login in this browser — pass origins to scope it, or confirmProfileWipe: true to wipe it anyway"
                ),
            });
        }
    }
    if let Some(args) = &mut args {
        args.remove("confirmProfileWipe");
    }
    Ok(args)
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    };

    use serde_json::json;
    use tempfile::tempdir;
    use tokio::fs;

    use super::{ProtectionCache, evaluate};
    use crate::fleet::config::ConfigStore;

    const CLEAR_BROWSING_DATA: &str = "chrome_clear_browsing_data";

    #[tokio::test]
    async fn retains_cached_protection_after_a_read_error_but_not_before_the_first_read() {
        let directory = tempdir().expect("create temporary fleet directory");
        let store = ConfigStore::new(
            directory.path().join("fleet"),
            directory.path().join("home"),
        );
        let clock = Arc::new(AtomicU64::new(100));
        let now = {
            let clock = Arc::clone(&clock);
            move || clock.load(Ordering::Relaxed)
        };
        let cache = ProtectionCache::default();

        assert_eq!(cache.current(Some("bound"), &store, &now).await, None);

        fs::create_dir_all(store.root())
            .await
            .expect("create fleet root");
        fs::write(
            store.path(),
            serde_json::to_vec(&json!({
                "version": 1,
                "profiles": [{"name": "bound", "purpose": 1}],
                "gateway": {"host": "127.0.0.1", "port": 12300},
                "bridgeToken": "bridge",
                "chromePath": "chrome",
                "extensionDir": "extension",
                "basePort": 12500
            }))
            .expect("serialize config"),
        )
        .await
        .expect("write config");
        assert_eq!(
            cache.current(Some("bound"), &store, &now).await.as_deref(),
            Some("bound to purpose \"1\"")
        );

        fs::remove_file(store.path())
            .await
            .expect("remove fixture config");
        clock.store(30_100, Ordering::Relaxed);
        assert_eq!(
            cache.current(Some("bound"), &store, &now).await.as_deref(),
            Some("bound to purpose \"1\"")
        );
    }

    #[tokio::test]
    async fn truthy_non_string_seed_is_a_profile_protection() {
        let directory = tempdir().expect("create temporary fleet directory");
        let store = ConfigStore::new(
            directory.path().join("fleet"),
            directory.path().join("home"),
        );
        fs::create_dir_all(store.root())
            .await
            .expect("create fleet root");
        fs::write(
            store.path(),
            serde_json::to_vec(&json!({
                "version": 1,
                "profiles": [{"name": "seeded", "seededFrom": {"profile": "daily"}}],
                "gateway": {"host": "127.0.0.1", "port": 12300},
                "bridgeToken": "bridge",
                "chromePath": "chrome",
                "extensionDir": "extension",
                "basePort": 12500
            }))
            .expect("serialize config"),
        )
        .await
        .expect("write config");

        let cache = ProtectionCache::default();
        let now = || 100;
        assert_eq!(
            cache.current(Some("seeded"), &store, &now).await.as_deref(),
            Some("seeded from [object Object]")
        );
    }

    #[test]
    fn only_allowed_wipes_strip_the_bridge_confirmation() {
        let absent = evaluate(CLEAR_BROWSING_DATA, None, Some("seeded from source"));
        assert_eq!(absent.expect_err("unscoped clear is refused").args, None);
        let null = evaluate(
            CLEAR_BROWSING_DATA,
            Some(serde_json::Value::Null.into()),
            Some("seeded from source"),
        );
        assert_eq!(
            null.expect_err("null unscoped clear is refused").args,
            Some(serde_json::Value::Null.into())
        );
        let allowed = evaluate(
            CLEAR_BROWSING_DATA,
            Some(json!({"origins": ["https://example.test"], "confirmProfileWipe": true}).into()),
            Some("seeded from source"),
        )
        .expect("scoped clear is allowed");
        assert_eq!(
            allowed,
            Some(json!({"origins": ["https://example.test"]}).into())
        );
        assert_eq!(
            evaluate(
                "chrome_get_windows_and_tabs",
                Some(json!({"confirmProfileWipe": true}).into()),
                Some("seeded from source"),
            )
            .expect("non-wipe tools remain allowed"),
            Some(json!({}).into())
        );
    }
}
