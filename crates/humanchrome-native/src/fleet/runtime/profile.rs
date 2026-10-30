//! Persistent profile copying, cookie gates, Google-session classification, and session snapshots.

use std::{
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;

use super::super::config::{ConfigStore, validate_profile_name};
use super::label::{apply_window_label, close_onboarding_tabs, label_for};
use super::{
    CdpPipe, CdpResponse, FleetRuntimeError, LaunchConfig, assert_keychain_readable,
    find_chrome_for_profile, launch_profile_with_extension,
};

/// Fraction of copied persistent cookies that must survive a first browser launch.
pub const COOKIE_KEEP_RATIO: f64 = 0.9;
const CHROME_EPOCH_OFFSET_US: i64 = 11_644_473_600_000_000;
const SESSION_FILE: &str = ".hc-session.json";

/// Counts the persistent cookies relevant to profile-copy integrity.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct CookieCount {
    /// All unpartitioned, unexpired persistent cookies.
    pub persistent: usize,
    /// The subset scoped to `google.com` or one of its subdomains.
    pub google: usize,
}

/// Recorded source of a copied explicit seed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SeedProvenance {
    /// Source profile directory supplied by the operator.
    pub seeded_from: PathBuf,
    /// RFC3339-like UTC timestamp generated at copy completion.
    pub seeded_at: String,
}

/// Google account-session state returned by ListAccounts.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GoogleSessionState {
    /// At least one account has a usable web session.
    Session,
    /// Google remembers accounts, but none owns a live session.
    Remembered,
    /// Google did not list an account.
    None,
}

/// Account counts and live-session state from Google's in-browser endpoint.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GoogleSession {
    /// Overall account state.
    pub state: GoogleSessionState,
    /// Number of remembered Google accounts.
    pub accounts: usize,
    /// Number currently signed in.
    pub signed_in: usize,
}

#[derive(Debug, Deserialize, Serialize)]
struct StoredSession {
    captured_at: String,
    cookies: Vec<StoredCookie>,
}

#[derive(Debug, Deserialize, Serialize)]
struct StoredCookie {
    name: String,
    value: String,
    domain: String,
    path: String,
    expires: f64,
    #[serde(rename = "httpOnly")]
    http_only: bool,
    secure: bool,
    #[serde(rename = "sameSite")]
    same_site: String,
}

/// Copy a Chrome user-data directory while excluding volatile, unsafe, and oversized state.
///
/// # Errors
/// Returns copy failures without falling back to an empty profile.
pub async fn copy_profile_dir(source: &Path, destination: &Path) -> Result<(), FleetRuntimeError> {
    let source = source.to_owned();
    let destination = destination.to_owned();
    tokio::task::spawn_blocking(move || copy_profile_dir_blocking(&source, &destination)).await??;
    Ok(())
}

fn copy_profile_dir_blocking(source: &Path, destination: &Path) -> Result<(), FleetRuntimeError> {
    fn copy_tree(source: &Path, destination: &Path) -> Result<(), FleetRuntimeError> {
        std::fs::create_dir_all(destination)
            .map_err(|error| FleetRuntimeError::io(destination, error))?;
        for entry in
            std::fs::read_dir(source).map_err(|error| FleetRuntimeError::io(source, error))?
        {
            let entry = entry.map_err(|error| FleetRuntimeError::io(source, error))?;
            let file_name = entry.file_name();
            if seed_excluded(&file_name.to_string_lossy()) {
                continue;
            }
            let source_path = entry.path();
            let destination_path = destination.join(file_name);
            let metadata = entry
                .metadata()
                .map_err(|error| FleetRuntimeError::io(&source_path, error))?;
            if metadata.is_dir() {
                copy_tree(&source_path, &destination_path)?;
            } else if metadata.is_file() {
                std::fs::copy(&source_path, &destination_path)
                    .map_err(|error| FleetRuntimeError::io(&destination_path, error))?;
            }
        }
        Ok(())
    }
    copy_tree(source, destination)
}

fn seed_excluded(name: &str) -> bool {
    matches!(
        name,
        "RunningChromeVersion"
            | "Last Version"
            | "Crashpad"
            | "component_crx_cache"
            | "extensions_crx_cache"
            | "BrowserMetrics"
            | "Cache"
            | "Code Cache"
            | "GPUCache"
            | "DawnCache"
            | "GrShaderCache"
            | "ShaderCache"
            | "CacheStorage"
            | "Login Data"
            | "Account Web Data"
            | "NativeMessagingHosts"
            | "OptGuideOnDeviceModel"
            | "OptGuideManifestModel"
            | "OptimizationGuideModelsManifest"
    ) || name.starts_with("Singleton")
}

/// Seed a fleet-owned profile from an explicit source or an optional template profile.
///
/// # Errors
/// An explicit seed must exist and carry `Local State`; it never silently degrades to empty.
pub async fn seed_profile_from(
    _name: &str,
    explicit_seed: Option<&Path>,
    destination: &Path,
    template: &Path,
) -> Result<Option<SeedProvenance>, FleetRuntimeError> {
    let source = explicit_seed.unwrap_or(template);
    match tokio::fs::metadata(source).await {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) | Err(_) if explicit_seed.is_none() => return Ok(None),
        Err(_) | Ok(_) => {
            return Err(FleetRuntimeError::Profile(format!(
                "seed profile not found: {}",
                source.display()
            )));
        }
    }
    if explicit_seed.is_some()
        && tokio::fs::metadata(source.join("Local State"))
            .await
            .is_err()
    {
        return Err(FleetRuntimeError::Profile(format!(
            "seed profile has no Local State: {}",
            source.display()
        )));
    }
    if let Err(error) = copy_profile_dir(source, destination).await {
        let _ = tokio::fs::remove_dir_all(destination).await;
        return Err(error);
    }
    if explicit_seed.is_none() {
        return Ok(None);
    }
    Ok(Some(SeedProvenance {
        seeded_from: source.to_owned(),
        seeded_at: utc_timestamp(),
    }))
}

/// Write a profile-local native-messaging manifest after checking its host executable exists.
///
/// # Errors
/// Refuses a manifest that would point Chrome at a missing host script.
pub async fn write_native_host_manifest(
    profile_dir: &Path,
    manifest: &Value,
    host_path: &Path,
) -> Result<(), FleetRuntimeError> {
    if tokio::fs::metadata(host_path).await.is_err() {
        return Err(FleetRuntimeError::Profile(format!(
            "native host script missing: {} — provision from the built bridge, not from a source checkout",
            host_path.display()
        )));
    }
    let path = profile_dir
        .join("NativeMessagingHosts")
        .join("com.humanchrome.nativehost.json");
    let parent = path.parent().expect("manifest path has a parent");
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| FleetRuntimeError::io(parent, error))?;
    let bytes = serde_json::to_vec_pretty(manifest).expect("Value serializes");
    tokio::fs::write(&path, bytes)
        .await
        .map_err(|error| FleetRuntimeError::io(&path, error))
}

/// Count copied profile cookies before Chrome opens the profile.
///
/// # Errors
/// Returns SQLite errors rather than treating a corrupted cookie store as an empty jar.
pub async fn count_copied_cookies(
    user_data_dir: &Path,
    now_ms: i64,
) -> Result<CookieCount, FleetRuntimeError> {
    let path = user_data_dir.join("Default/Cookies");
    if !tokio::fs::try_exists(&path)
        .await
        .map_err(|error| FleetRuntimeError::io(&path, error))?
    {
        return Ok(CookieCount::default());
    }
    tokio::task::spawn_blocking(move || {
        let connection = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|error| FleetRuntimeError::Profile(format!("could not read {}: {error}", path.display())))?;
        let expiry = now_ms
            .checked_mul(1_000)
            .and_then(|value| value.checked_add(CHROME_EPOCH_OFFSET_US))
            .ok_or_else(|| FleetRuntimeError::Profile("cookie expiry timestamp overflow".to_owned()))?;
        let mut statement = connection
            .prepare(
                "SELECT host_key FROM cookies WHERE is_persistent = 1 AND top_frame_site_key = '' AND expires_utc > ?1",
            )
            .map_err(|error| FleetRuntimeError::Profile(format!("could not query copied cookies: {error}")))?;
        let rows = statement
            .query_map([expiry], |row| row.get::<_, String>(0))
            .map_err(|error| FleetRuntimeError::Profile(format!("could not query copied cookies: {error}")))?;
        let mut count = CookieCount::default();
        for host in rows {
            let host = host.map_err(|error| FleetRuntimeError::Profile(format!("could not read copied cookie: {error}")))?;
            count.persistent += 1;
            if is_google_domain(&host) {
                count.google += 1;
            }
        }
        Ok(count)
    })
    .await?
}

/// Return whether an unexpired Google session-bearing cookie was copied.
///
/// # Errors
/// Returns SQLite errors rather than assuming a damaged store has no Google login.
pub async fn copied_google_login(
    user_data_dir: &Path,
    now_ms: i64,
) -> Result<bool, FleetRuntimeError> {
    let path = user_data_dir.join("Default/Cookies");
    if !tokio::fs::try_exists(&path)
        .await
        .map_err(|error| FleetRuntimeError::io(&path, error))?
    {
        return Ok(false);
    }
    tokio::task::spawn_blocking(move || {
        let connection = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|error| FleetRuntimeError::Profile(format!("could not read {}: {error}", path.display())))?;
        let expiry = now_ms
            .checked_mul(1_000)
            .and_then(|value| value.checked_add(CHROME_EPOCH_OFFSET_US))
            .ok_or_else(|| FleetRuntimeError::Profile("cookie expiry timestamp overflow".to_owned()))?;
        let found = connection
            .query_row(
                "SELECT 1 FROM cookies WHERE host_key = '.google.com' AND name IN ('SID', '__Secure-1PSID') AND expires_utc > ?1 LIMIT 1",
                [expiry],
                |_| Ok(()),
            )
            .is_ok();
        Ok(found)
    })
    .await?
}

/// Count the persistent, unpartitioned cookies Chrome actually retained in memory.
///
/// # Errors
/// Returns a CDP failure; an uninspectable live jar is never represented as an empty jar.
pub async fn count_live_cookies(
    cdp: &CdpPipe,
    now_ms: i64,
) -> Result<CookieCount, FleetRuntimeError> {
    let response = cdp.send_default("Storage.getCookies", json!({})).await?;
    let result = require_cdp_result(response, "Storage.getCookies")?;
    let mut count = CookieCount::default();
    for cookie in result
        .get("cookies")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if cookie.get("session").and_then(Value::as_bool) != Some(false)
            || cookie.get("partitionKey").is_some()
            || cookie
                .get("expires")
                .and_then(Value::as_f64)
                .is_none_or(|expires| expires * 1_000.0 <= now_ms as f64)
        {
            continue;
        }
        count.persistent += 1;
        if cookie
            .get("domain")
            .and_then(Value::as_str)
            .is_some_and(is_google_domain)
        {
            count.google += 1;
        }
    }
    Ok(count)
}

/// Explain cookie loss using the fleet's strict launch gate, if any.
#[must_use]
pub fn cookie_loss(copied: CookieCount, kept: CookieCount) -> Option<String> {
    if (kept.persistent as f64) < (copied.persistent as f64) * COOKIE_KEEP_RATIO {
        return Some(format!(
            "Chrome kept {} of {} copied cookies (at least {} required)",
            kept.persistent,
            copied.persistent,
            ((copied.persistent as f64) * COOKIE_KEEP_RATIO).ceil() as usize
        ));
    }
    if copied.google > 0 && kept.google == 0 {
        return Some(format!(
            "Chrome kept none of the {} copied google.com cookies",
            copied.google
        ));
    }
    None
}

/// Capture replayable web cookies atomically before a browser stops.
///
/// # Errors
/// Returns CDP, serialization, or filesystem errors. The old snapshot remains intact on a failure.
pub async fn capture_session(
    cdp: &CdpPipe,
    user_data_dir: &Path,
) -> Result<usize, FleetRuntimeError> {
    let response = cdp.send_default("Storage.getCookies", json!({})).await?;
    let result = require_cdp_result(response, "Storage.getCookies")?;
    let cookies = result
        .get("cookies")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(stored_cookie)
        .collect::<Vec<_>>();
    write_session(cookies, user_data_dir).await
}

async fn write_session(
    cookies: Vec<StoredCookie>,
    user_data_dir: &Path,
) -> Result<usize, FleetRuntimeError> {
    let target = user_data_dir.join(SESSION_FILE);
    let temporary = user_data_dir.join(format!("{SESSION_FILE}.{}.tmp", std::process::id()));
    let payload = StoredSession {
        captured_at: utc_timestamp(),
        cookies,
    };
    let mut options = tokio::fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .await
        .map_err(|error| FleetRuntimeError::io(&temporary, error))?;
    let mut bytes = serde_json::to_vec(&payload).expect("session structure serializes");
    bytes.push(b'\n');
    file.write_all(&bytes)
        .await
        .map_err(|error| FleetRuntimeError::io(&temporary, error))?;
    file.flush()
        .await
        .map_err(|error| FleetRuntimeError::io(&temporary, error))?;
    drop(file);
    tokio::fs::rename(&temporary, &target)
        .await
        .map_err(|error| FleetRuntimeError::io(&target, error))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600))
            .await
            .map_err(|error| FleetRuntimeError::io(&target, error))?;
    }
    Ok(payload.cookies.len())
}

/// Restore a prior cookie snapshot before the extension can navigate.
///
/// Corrupt/missing snapshots and CDP failures intentionally do not block Chrome startup, matching
/// the existing fleet's recoverable-login behavior. Callers can log the returned `0` as needed.
pub async fn restore_session(cdp: &CdpPipe, user_data_dir: &Path) -> usize {
    let path = user_data_dir.join(SESSION_FILE);
    let Ok(raw) = tokio::fs::read(&path).await else {
        return 0;
    };
    let Ok(session) = serde_json::from_slice::<StoredSession>(&raw) else {
        return 0;
    };
    if session.cookies.is_empty() {
        return 0;
    }
    let Ok(response) = cdp
        .send_default("Storage.setCookies", json!({ "cookies": session.cookies }))
        .await
    else {
        return 0;
    };
    if response.error.is_some() {
        return 0;
    }
    session.cookies.len()
}

/// Classify a raw ListAccounts body according to Chromium's account array fields.
///
/// # Errors
/// Rejects unknown response formats instead of treating them as an unsigned browser.
pub fn classify_list_accounts(body: &str) -> Result<GoogleSession, FleetRuntimeError> {
    let Some(start) = body.find('[') else {
        return Err(FleetRuntimeError::Profile(
            "ListAccounts answered in an unrecognized format".to_owned(),
        ));
    };
    let value: Value = serde_json::from_str(&body[start..]).map_err(|_| {
        FleetRuntimeError::Profile("ListAccounts answered in an unrecognized format".to_owned())
    })?;
    let outer = value.as_array().ok_or_else(|| {
        FleetRuntimeError::Profile("ListAccounts answered in an unrecognized format".to_owned())
    })?;
    if outer.first().and_then(Value::as_str) != Some("gaia.l.a.r") {
        return Err(FleetRuntimeError::Profile(
            "ListAccounts answered in an unrecognized format".to_owned(),
        ));
    }
    let accounts = outer.get(1).and_then(Value::as_array).ok_or_else(|| {
        FleetRuntimeError::Profile("ListAccounts answered in an unrecognized format".to_owned())
    })?;
    let entries = accounts
        .iter()
        .filter_map(Value::as_array)
        .collect::<Vec<_>>();
    let signed_in = entries
        .iter()
        .filter(|account| {
            account.get(9).and_then(Value::as_i64) == Some(1)
                && account.get(14).and_then(Value::as_i64) != Some(1)
        })
        .count();
    Ok(GoogleSession {
        state: if signed_in > 0 {
            GoogleSessionState::Session
        } else if entries.is_empty() {
            GoogleSessionState::None
        } else {
            GoogleSessionState::Remembered
        },
        accounts: entries.len(),
        signed_in,
    })
}

/// Explain why a copied Google login did not survive an in-browser verification.
#[must_use]
pub fn google_session_loss(
    expected: bool,
    found: GoogleSession,
    source_pending_since: Option<&str>,
) -> Option<String> {
    if !expected || found.state == GoogleSessionState::Session {
        return None;
    }
    let detail = match found.state {
        GoogleSessionState::Remembered => format!(
            "Google remembers {} account(s) but none has a live session",
            found.accounts
        ),
        GoogleSessionState::None => "Google lists no account at all".to_owned(),
        GoogleSessionState::Session => return None,
    };
    let source = source_pending_since.map_or_else(String::new, |time| {
        format!("; the seed Chrome itself has shown Google sign-in pending since {time}, so it had no session to copy: sign in to Google there first")
    });
    let state = match found.state {
        GoogleSessionState::Remembered => "remembered",
        GoogleSessionState::None => "none",
        GoogleSessionState::Session => "session",
    };
    Some(format!(
        "its copied Google login is not live ({state}: {detail}){source}"
    ))
}

/// Read when a seed profile's Google account entered its persistent sign-in-pending state.
///
/// A malformed or unavailable Preferences file is not a provisioning failure; it only omits
/// additional context from a failed live-session gate.
pub async fn signin_pending_since(user_data_dir: &Path) -> Option<String> {
    let preferences = tokio::fs::read(user_data_dir.join("Default").join("Preferences"))
        .await
        .ok()?;
    let preferences = serde_json::from_slice::<Value>(&preferences).ok()?;
    let raw = preferences
        .get("signin")?
        .get("signin_pending_start_time")?
        .as_str()?;
    if raw.is_empty() || !raw.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let chrome_microseconds = raw.parse::<i128>().ok()?;
    let unix_milliseconds = (chrome_microseconds - i128::from(CHROME_EPOCH_OFFSET_US)) / 1_000;
    let unix_milliseconds = i64::try_from(unix_milliseconds).ok()?;
    chrono::DateTime::from_timestamp_millis(unix_milliseconds)
        .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

fn stored_cookie(cookie: &Value) -> Option<StoredCookie> {
    let same_site = cookie.get("sameSite")?.as_str()?;
    if !matches!(same_site, "Strict" | "Lax" | "None")
        || !matches!(
            cookie.get("sourceScheme")?.as_str()?,
            "Secure" | "NonSecure"
        )
    {
        return None;
    }
    Some(StoredCookie {
        name: cookie.get("name")?.as_str()?.to_owned(),
        value: cookie.get("value")?.as_str()?.to_owned(),
        domain: cookie.get("domain")?.as_str()?.to_owned(),
        path: cookie.get("path")?.as_str()?.to_owned(),
        expires: cookie
            .get("expires")
            .and_then(Value::as_f64)
            .filter(|expiry| *expiry > 0.0)
            .unwrap_or(-1.0),
        http_only: cookie
            .get("httpOnly")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        secure: cookie
            .get("secure")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        same_site: same_site.to_owned(),
    })
}

fn require_cdp_result(response: CdpResponse, command: &str) -> Result<Value, FleetRuntimeError> {
    if let Some(error) = response.error {
        return Err(FleetRuntimeError::Cdp(format!("{command} failed: {error}")));
    }
    response
        .result
        .ok_or_else(|| FleetRuntimeError::Cdp(format!("{command} returned no result")))
}

fn is_google_domain(host: &str) -> bool {
    let host = host.strip_prefix('.').unwrap_or(host);
    host == "google.com" || host.ends_with(".google.com")
}

fn utc_timestamp() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // The config treats this as display/provenance only; chrono gives the existing RFC3339 UTC form.
    chrono::DateTime::from_timestamp(seconds as i64, 0)
        .expect("Unix timestamp fits chrono")
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Outcome of atomically provisioning and registering one persistent fleet profile.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AddedProfile {
    /// Registered profile name.
    pub name: String,
    /// Allocated bridge port.
    pub port: u16,
    /// Cookie count before Chrome first opened the copy.
    pub copied: CookieCount,
    /// Cookie count Chrome retained after launch.
    pub kept: CookieCount,
    /// Google's live in-browser session answer, when the probe was reachable.
    pub google: Option<GoogleSession>,
    /// Explicit seed provenance when a seed was supplied.
    pub provenance: Option<SeedProvenance>,
}

/// Inputs that let a worker provision fleet profiles without mutating a daily Chrome profile.
#[derive(Clone, Debug)]
pub struct ProfileProvisioner {
    store: ConfigStore,
    launch: LaunchConfig,
    native_host_manifest: Value,
    native_host_path: PathBuf,
    http: reqwest::Client,
}

impl ProfileProvisioner {
    /// Construct a profile provisioner using a host manifest generated by the installed host.
    ///
    /// # Errors
    /// Returns an error if the loopback readiness client cannot be created.
    pub fn new(
        store: ConfigStore,
        launch: LaunchConfig,
        native_host_manifest: Value,
        native_host_path: PathBuf,
    ) -> Result<Self, FleetRuntimeError> {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(2))
            .build()
            .map_err(|error| {
                FleetRuntimeError::Process(format!(
                    "could not create profile readiness client: {error}"
                ))
            })?;
        Ok(Self {
            store,
            launch,
            native_host_manifest,
            native_host_path,
            http,
        })
    }

    /// Clone, gate, launch, and only then register a persistent fleet profile.
    ///
    /// # Errors
    /// Any failed cookie/session/bridge gate terminates Chrome and discards the copied directory.
    pub async fn add(
        &self,
        name: &str,
        labels: Vec<String>,
        seed: Option<&Path>,
    ) -> Result<AddedProfile, FleetRuntimeError> {
        validate_profile_name(name)
            .map_err(|error| FleetRuntimeError::Profile(error.to_string()))?;
        let mut config = self
            .store
            .load()
            .await
            .map_err(|error| FleetRuntimeError::Profile(error.to_string()))?;
        let profiles = config
            .get("profiles")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                FleetRuntimeError::Profile("invalid fleet profile configuration".to_owned())
            })?;
        if profiles
            .iter()
            .any(|profile| profile.get("name").and_then(Value::as_str) == Some(name))
        {
            return Err(FleetRuntimeError::Profile(format!(
                "profile already exists: {name}"
            )));
        }
        assert_keychain_readable().await?;
        let base_port = config
            .get("basePort")
            .and_then(Value::as_u64)
            .and_then(|port| u16::try_from(port).ok())
            .ok_or_else(|| FleetRuntimeError::Profile("invalid basePort".to_owned()))?;
        let port = profiles
            .iter()
            .filter_map(|profile| profile.get("port").and_then(Value::as_u64))
            .filter_map(|port| u16::try_from(port).ok())
            .max()
            .unwrap_or(base_port.saturating_sub(1))
            .max(base_port.saturating_sub(1))
            .checked_add(1)
            .ok_or_else(|| {
                FleetRuntimeError::Profile("no bridge port remains for a new profile".to_owned())
            })?;
        let directory = self.store.root().join("profiles").join(name);
        let template = self.store.root().join("profiles").join("_template");
        let provenance = seed_profile_from(name, seed, &directory, &template).await?;
        let source_pending_since = match seed {
            Some(source) => signin_pending_since(source).await,
            None => None,
        };
        if let Err(error) = write_native_host_manifest(
            &directory,
            &self.native_host_manifest,
            &self.native_host_path,
        )
        .await
        {
            let _ = tokio::fs::remove_dir_all(&directory).await;
            return Err(error);
        }
        let copied = match count_copied_cookies(&directory, unix_millis()).await {
            Ok(copied) => copied,
            Err(error) => {
                let _ = tokio::fs::remove_dir_all(&directory).await;
                return Err(error);
            }
        };
        let expects_google = match copied_google_login(&directory, unix_millis()).await {
            Ok(login) => provenance.is_some() && login,
            Err(error) => {
                let _ = tokio::fs::remove_dir_all(&directory).await;
                return Err(error);
            }
        };
        let launched = match launch_profile_with_extension(&self.launch, name, &directory, port)
            .await
        {
            Ok(launched) => launched,
            Err(error) => {
                if !find_chrome_for_profile(&self.launch.chrome_path, &directory)
                    .await?
                    .is_empty()
                {
                    return Err(FleetRuntimeError::Profile(format!(
                        "{error}; refusing to discard {name} while Chrome still owns its profile"
                    )));
                }
                let _ = tokio::fs::remove_dir_all(&directory).await;
                return Err(error);
            }
        };
        let pid_path = self.store.root().join("run").join(format!("{name}.pid"));
        if let Err(error) = tokio::fs::create_dir_all(self.store.root().join("run")).await {
            launched
                .process
                .terminate_checked(std::time::Duration::from_secs(5))
                .await?;
            let _ = tokio::fs::remove_dir_all(&directory).await;
            return Err(FleetRuntimeError::io(self.store.root().join("run"), error));
        }
        if let Err(error) = tokio::fs::write(&pid_path, launched.process.pid.to_string()).await {
            launched
                .process
                .terminate_checked(std::time::Duration::from_secs(5))
                .await?;
            let _ = tokio::fs::remove_dir_all(&directory).await;
            return Err(FleetRuntimeError::io(&pid_path, error));
        }
        let result = async {
            if !self
                .wait_for_bridge(port, std::time::Duration::from_secs(30))
                .await
            {
                return Err(FleetRuntimeError::Profile(
                    "extension did not connect; see docs/FLEET.md#troubleshooting".to_owned(),
                ));
            }
            let kept = count_live_cookies(&launched.process.cdp, unix_millis()).await?;
            if let Some(loss) = cookie_loss(copied, kept) {
                return Err(FleetRuntimeError::Profile(format!(
                    "{name} lost its seeded cookies: {loss}; profile discarded"
                )));
            }
            let google =
                match super::probe_profile_google_session(port, &self.launch.bridge_token).await {
                    Ok(session) => Some(session),
                    Err(error) if expects_google => {
                        return Err(FleetRuntimeError::Profile(format!(
                            "{name}: could not read its Google session ({error}); profile discarded"
                        )));
                    }
                    Err(_) => None,
                };
            if let Some(google) = google
                && let Some(loss) =
                    google_session_loss(expects_google, google, source_pending_since.as_deref())
            {
                return Err(FleetRuntimeError::Profile(format!(
                    "{name}: {loss}; profile discarded"
                )));
            }
            let label = label_for(name, None);
            let _ = apply_window_label(&launched.process.cdp, &directory, &label).await;
            let _ = close_onboarding_tabs(&launched.process.cdp, &launched.extension_id).await;
            Ok((kept, google))
        }
        .await;
        let (kept, google) = match result {
            Ok(result) => result,
            Err(error) => {
                launched
                    .process
                    .terminate_checked(std::time::Duration::from_secs(5))
                    .await?;
                let _ = tokio::fs::remove_file(
                    self.store.root().join("run").join(format!("{name}.pid")),
                )
                .await;
                let _ = tokio::fs::remove_dir_all(&directory).await;
                return Err(error);
            }
        };
        let mut seen_labels = std::collections::BTreeSet::new();
        let labels = labels
            .into_iter()
            .filter(|label| seen_labels.insert(label.clone()))
            .collect::<Vec<_>>();
        let profile = json!({
            "name": name, "port": port, "labels": labels, "enabled": true,
            "seededFrom": provenance.as_ref().map(|source| &source.seeded_from),
            "seededAt": provenance.as_ref().map(|source| &source.seeded_at),
        });
        config
            .get_mut("profiles")
            .and_then(Value::as_array_mut)
            .expect("profiles was validated as an array")
            .push(profile);
        if let Err(error) = self.store.save(&config).await {
            launched
                .process
                .terminate_checked(std::time::Duration::from_secs(5))
                .await?;
            let _ = tokio::fs::remove_file(&pid_path).await;
            let _ = tokio::fs::remove_dir_all(&directory).await;
            return Err(FleetRuntimeError::Profile(error.to_string()));
        }
        launched.process.cdp.close().await;
        Ok(AddedProfile {
            name: name.to_owned(),
            port,
            copied,
            kept,
            google,
            provenance,
        })
    }

    /// Persist the fleet's parked switch without touching profile contents.
    ///
    /// # Errors
    /// Returns existing configuration read/write errors.
    pub async fn set_parked(&self, parked: bool) -> Result<bool, FleetRuntimeError> {
        let mut config = self
            .store
            .load()
            .await
            .map_err(|error| FleetRuntimeError::Profile(error.to_string()))?;
        let changed = config.get("parked").and_then(Value::as_bool) != Some(parked);
        if changed {
            config["parked"] = Value::Bool(parked);
            self.store
                .save(&config)
                .await
                .map_err(|error| FleetRuntimeError::Profile(error.to_string()))?;
        }
        Ok(changed)
    }

    async fn wait_for_bridge(&self, port: u16, timeout: std::time::Duration) -> bool {
        let deadline = tokio::time::Instant::now() + timeout;
        while tokio::time::Instant::now() < deadline {
            if let Ok(response) = self
                .http
                .get(format!("http://127.0.0.1:{port}/ping"))
                .send()
                .await
                && response
                    .json::<Value>()
                    .await
                    .ok()
                    .and_then(|body| {
                        body.get("status")
                            .and_then(Value::as_str)
                            .map(ToOwned::to_owned)
                    })
                    .as_deref()
                    == Some("ok")
            {
                return true;
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
        false
    }
}

fn unix_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_cookie_loss_below_ratio_and_preserves_google_gate() {
        assert_eq!(
            cookie_loss(
                CookieCount {
                    persistent: 420,
                    google: 65
                },
                CookieCount::default(),
            ),
            Some("Chrome kept 0 of 420 copied cookies (at least 378 required)".to_owned())
        );
        assert_eq!(
            cookie_loss(
                CookieCount {
                    persistent: 300,
                    google: 5
                },
                CookieCount {
                    persistent: 300,
                    google: 0
                },
            ),
            Some("Chrome kept none of the 5 copied google.com cookies".to_owned())
        );
    }

    #[test]
    fn classifies_only_explicit_live_google_accounts() {
        let session =
            classify_list_accounts(r#"prefix ["gaia.l.a.r",[[0,0,0,0,0,0,0,0,0,1,0,0,0,0,0]] ]"#)
                .expect("known ListAccounts shape");
        assert_eq!(session.state, GoogleSessionState::Session);
        let remembered = classify_list_accounts(r#"["gaia.l.a.r",[[0,0,0,0,0,0,0,0,0,0]] ]"#)
            .expect("known ListAccounts shape");
        assert_eq!(remembered.state, GoogleSessionState::Remembered);
    }
}
