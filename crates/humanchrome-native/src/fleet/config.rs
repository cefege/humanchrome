//! Version-one fleet configuration is read and written in place, without schema conversion.

use std::{
    collections::HashMap,
    fmt::Write as _,
    path::{Path, PathBuf},
};

use serde_json::{Value, json};
use tokio::{fs, io::AsyncWriteExt};

/// Configuration errors retain the native CLI's existing human-readable classifications.
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    /// No readable fleet configuration exists.
    #[error("fleet not initialized — run: humanchrome-bridge fleet init")]
    NotInitialized,
    /// The version or profile collection is invalid.
    #[error("invalid fleet.json")]
    Invalid,
    /// A configured profile name does not satisfy the existing grammar.
    #[error("invalid fleet profile name: {0}")]
    ProfileName(String),
    /// A purpose name does not satisfy the existing grammar.
    #[error("invalid purpose name: {0}")]
    PurposeName(String),
    /// A purpose may have only one local profile owner.
    #[error("purpose \"{purpose}\" is bound to both {first} and {second}")]
    DuplicatePurpose {
        purpose: String,
        first: String,
        second: String,
    },
    /// A remote node may not impersonate the current node.
    #[error("node id {0} collides with this machine's nodeId")]
    NodeCollision(String),
    /// Runtime-required fields retain their individual diagnostics.
    #[error("invalid fleet.json: {0} is missing")]
    MissingField(&'static str),
    /// JavaScript property access or iteration rejected the persisted value.
    #[error("{0}")]
    TypeError(String),
    /// Malformed JSON is not an absent configuration.
    #[error("{0}")]
    Json(String),
    /// Writes and platform lookups can fail independently of parsing.
    #[error(transparent)]
    Io(#[from] std::io::Error),
    /// Secure token generation never substitutes a fabricated credential.
    #[error("could not generate bridge token: {0}")]
    Random(getrandom::Error),
}

/// A dedicated fleet root and default home, independent of installed runtime ownership.
#[derive(Clone, Debug)]
pub struct ConfigStore {
    root: PathBuf,
    home: PathBuf,
}

impl ConfigStore {
    /// Use explicit roots so tests and workers never share a live fleet directory.
    pub fn new(root: PathBuf, home: PathBuf) -> Self {
        Self { root, home }
    }

    /// The existing version-one configuration file.
    #[must_use]
    pub fn path(&self) -> PathBuf {
        self.root.join("fleet.json")
    }

    /// The configured profile boundary.
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Existing default source of signed-in Chrome profiles.
    #[must_use]
    pub fn default_daily_profile_dir(&self) -> PathBuf {
        self.home.join("Library/Application Support/Google/Chrome")
    }

    /// Build the same initial configuration, including a cryptographically random bridge token.
    ///
    /// # Errors
    /// Reports OS random-source or hostname lookup errors.
    pub fn default_config(&self, gateway_port: u16, base_port: u16) -> Result<Value, ConfigError> {
        let mut token_bytes = [0_u8; 32];
        getrandom::fill(&mut token_bytes).map_err(ConfigError::Random)?;
        let mut bridge_token = String::with_capacity(64);
        for byte in token_bytes {
            write!(bridge_token, "{byte:02x}").expect("writing to a String cannot fail");
        }
        Ok(json!({
            "version": 1,
            "gateway": { "host": "0.0.0.0", "port": gateway_port },
            "token": null,
            "bridgeToken": bridge_token,
            "chromePath": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "extensionDir": self.home.join("Library/Application Support/humanchrome-extension/chrome-mv3"),
            "basePort": base_port,
            "leaseIdleTtlSec": 900,
            "parked": false,
            "demandStartTimeoutSec": 90,
            "profiles": [],
            "nodeId": hostname::get()?.to_string_lossy(),
            "nodes": [],
            "dailyProfileDir": self.default_daily_profile_dir(),
        }))
    }

    /// Load legacy JSON and apply the same additive in-memory defaults only.
    ///
    /// # Errors
    /// Returns existing validation, JSON, and missing-configuration errors; never rewrites on read.
    pub async fn load(&self) -> Result<Value, ConfigError> {
        let bytes = fs::read(self.path())
            .await
            .map_err(|_| ConfigError::NotInitialized)?;
        let mut config: Value = serde_json::from_slice(&bytes).map_err(javascript_json_error)?;
        if !is_javascript_one(config.get("version"))
            || !config.get("profiles").is_some_and(Value::is_array)
        {
            return Err(ConfigError::Invalid);
        }

        let profiles = config["profiles"]
            .as_array()
            .expect("profiles validated as an array");
        // The JavaScript implementation deliberately validates every name before it
        // considers purposes.  That ordering is visible when one file has both errors.
        for profile in profiles {
            validate_profile_value(profile_property(profile, "name")?)?;
        }
        let mut purpose_owners = HashMap::new();
        for (index, profile) in profiles.iter().enumerate() {
            let purpose = profile_property(profile, "purpose")?;
            if !is_javascript_truthy(purpose) {
                continue;
            }
            validate_purpose_value(purpose)?;
            let purpose_key = javascript_map_key(purpose, index);
            let purpose_text = javascript_string(purpose);
            let name = profile_property(profile, "name")?;
            let owner = javascript_string(name);
            if let Some(first) = purpose_owners.insert(purpose_key, owner.clone()) {
                return Err(ConfigError::DuplicatePurpose {
                    purpose: purpose_text,
                    first,
                    second: owner,
                });
            }
        }

        let fields = config.as_object_mut().ok_or(ConfigError::Invalid)?;
        if fields.get("parked").is_none_or(Value::is_null) {
            fields.insert("parked".to_owned(), json!(false));
        }
        if fields.get("nodeId").is_none_or(Value::is_null) {
            fields.insert(
                "nodeId".to_owned(),
                Value::String(hostname::get()?.to_string_lossy().into_owned()),
            );
        }
        for (key, default) in [
            ("nodes", json!([])),
            ("token", Value::Null),
            ("leaseIdleTtlSec", json!(900)),
            ("demandStartTimeoutSec", json!(90)),
        ] {
            if fields.get(key).is_none_or(Value::is_null) {
                fields.insert(key.to_owned(), default);
            }
        }
        if fields.get("dailyProfileDir").is_none_or(Value::is_null) {
            fields.insert(
                "dailyProfileDir".to_owned(),
                json!(self.default_daily_profile_dir()),
            );
        }

        let node_id = config
            .get("nodeId")
            .expect("nodeId is defaulted before node collision checks");
        match config
            .get("nodes")
            .expect("nodes is defaulted before node collision checks")
        {
            Value::Array(nodes) => {
                for node in nodes {
                    let id = node_property(node, "id")?;
                    if javascript_strict_equals(id, Some(node_id)) {
                        return Err(ConfigError::NodeCollision(javascript_string(id)));
                    }
                }
            }
            // JavaScript strings are iterable.  Each character is boxed for `.id`,
            // which produces undefined and can never collide with a JSON nodeId.
            Value::String(_) => {}
            _ => {
                return Err(ConfigError::TypeError(
                    "config.nodes is not iterable".to_owned(),
                ));
            }
        }

        for (field, value) in [
            (
                "gateway.host",
                config
                    .get("gateway")
                    .and_then(|gateway| gateway.get("host")),
            ),
            (
                "gateway.port",
                config
                    .get("gateway")
                    .and_then(|gateway| gateway.get("port")),
            ),
            ("bridgeToken", config.get("bridgeToken")),
            ("chromePath", config.get("chromePath")),
            ("extensionDir", config.get("extensionDir")),
            ("basePort", config.get("basePort")),
        ] {
            if value.is_none_or(|value| value.is_null() || value.as_str() == Some("")) {
                return Err(ConfigError::MissingField(field));
            }
        }
        Ok(config)
    }

    /// Create only fleet-owned directories, without mutating any browser profile.
    ///
    /// # Errors
    /// Propagates directory creation failures.
    pub async fn ensure_directories(&self) -> Result<(), ConfigError> {
        for directory in ["profiles", "run", "registry/instances", "logs"] {
            fs::create_dir_all(self.root.join(directory)).await?;
        }
        Ok(())
    }

    /// Preserve the atomic temp-write/rename, JSON encoding, and final Unix mode 0600.
    ///
    /// # Errors
    /// Propagates serialization and filesystem errors; never performs destructive upgrades.
    pub async fn save(&self, config: &Value) -> Result<(), ConfigError> {
        self.ensure_directories().await?;
        let temporary = self
            .root
            .join(format!("fleet.json.{}.tmp", std::process::id()));
        let mut options = fs::OpenOptions::new();
        options.create(true).truncate(true).write(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(&temporary).await?;
        let mut bytes = humanchrome_core::json::to_vec_pretty(config);
        bytes.push(b'\n');
        file.write_all(&bytes).await?;
        drop(file);
        fs::rename(temporary, self.path()).await?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(self.path(), std::fs::Permissions::from_mode(0o600)).await?;
        }
        Ok(())
    }
}

#[derive(Debug, Eq, Hash, PartialEq)]
enum JavaScriptMapKey {
    Bool(bool),
    Number(u64),
    String(String),
    /// Parsed JSON has no aliases, so each composite value is a distinct JS object.
    Object(usize),
}

fn is_javascript_one(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_f64)
        .is_some_and(|number| number == 1.0)
}

fn javascript_json_error(error: serde_json::Error) -> ConfigError {
    if error.is_eof() {
        // Keep truncated persisted files distinct from a missing configuration.
        ConfigError::Json("Unexpected end of JSON input".to_owned())
    } else {
        ConfigError::Json(error.to_string())
    }
}

fn profile_property<'a>(
    profile: &'a Value,
    property: &str,
) -> Result<Option<&'a Value>, ConfigError> {
    if profile.is_null() {
        return Err(ConfigError::TypeError(format!(
            "Cannot read properties of null (reading '{property}')"
        )));
    }
    if profile.is_object() {
        return Ok(profile.get(property));
    }
    Ok(None)
}

fn node_property<'a>(node: &'a Value, property: &str) -> Result<Option<&'a Value>, ConfigError> {
    if node.is_null() {
        return Err(ConfigError::TypeError(format!(
            "Cannot read properties of null (reading '{property}')"
        )));
    }
    if node.is_object() {
        return Ok(node.get(property));
    }
    Ok(None)
}

fn validate_profile_value(value: Option<&Value>) -> Result<(), ConfigError> {
    let rendered = javascript_string(value);
    if !valid_name(&rendered) {
        return Err(ConfigError::ProfileName(rendered));
    }
    match value {
        Some(Value::String(name)) if !name.starts_with('_') => Ok(()),
        Some(Value::String(name)) => Err(ConfigError::ProfileName(name.clone())),
        Some(Value::Null) => Err(ConfigError::TypeError(
            "Cannot read properties of null (reading 'startsWith')".to_owned(),
        )),
        None => Err(ConfigError::TypeError(
            "Cannot read properties of undefined (reading 'startsWith')".to_owned(),
        )),
        _ => Err(ConfigError::TypeError(
            "name.startsWith is not a function".to_owned(),
        )),
    }
}

fn validate_purpose_value(value: Option<&Value>) -> Result<(), ConfigError> {
    let rendered = javascript_string(value);
    if valid_name(&rendered) {
        Ok(())
    } else {
        Err(ConfigError::PurposeName(rendered))
    }
}

pub(crate) fn is_javascript_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(value)) => value.as_f64().is_none_or(|number| number != 0.0),
        Some(Value::String(value)) => !value.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

fn javascript_map_key(value: Option<&Value>, index: usize) -> JavaScriptMapKey {
    match value {
        Some(Value::Bool(value)) => JavaScriptMapKey::Bool(*value),
        Some(Value::Number(value)) => JavaScriptMapKey::Number(
            value
                .as_f64()
                .expect("JSON numbers convert to JavaScript numbers")
                .to_bits(),
        ),
        Some(Value::String(value)) => JavaScriptMapKey::String(value.clone()),
        Some(Value::Array(_)) | Some(Value::Object(_)) | Some(Value::Null) | None => {
            JavaScriptMapKey::Object(index)
        }
    }
}

fn javascript_strict_equals(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(left)), Some(Value::Bool(right))) => left == right,
        (Some(Value::String(left)), Some(Value::String(right))) => left == right,
        (Some(Value::Number(left)), Some(Value::Number(right))) => left
            .as_f64()
            .zip(right.as_f64())
            .is_some_and(|(left, right)| left == right),
        _ => false,
    }
}

pub(crate) fn javascript_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(Value::Null) => "null".to_owned(),
        Some(Value::Bool(value)) => value.to_string(),
        Some(Value::Number(value)) => javascript_number_string(value),
        Some(Value::String(value)) => value.clone(),
        Some(Value::Array(values)) => javascript_array_string(values),
        Some(Value::Object(_)) => "[object Object]".to_owned(),
    }
}

fn javascript_array_string(values: &[Value]) -> String {
    let mut rendered = String::new();
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            rendered.push(',');
        }
        match value {
            Value::Null => {}
            Value::Array(values) => rendered.push_str(&javascript_array_string(values)),
            _ => rendered.push_str(&javascript_string(Some(value))),
        }
    }
    rendered
}

fn javascript_number_string(value: &serde_json::Number) -> String {
    humanchrome_core::json::stringify(&Value::Number(value.clone()))
}

/// Check the exact existing ASCII grammar for names shared by profiles, purposes and nodes.
#[must_use]
pub fn valid_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    (1..=32).contains(&bytes.len())
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

/// Validate a public profile name, including the reserved template boundary.
///
/// # Errors
/// Returns the existing profile-name diagnostic.
pub fn validate_profile_name(name: &str) -> Result<(), ConfigError> {
    if valid_name(name) {
        Ok(())
    } else {
        Err(ConfigError::ProfileName(name.to_owned()))
    }
}

/// Validate a purpose without admitting routing separators or synthetic template names.
///
/// # Errors
/// Returns the existing purpose-name diagnostic.
pub fn validate_purpose_name(name: &str) -> Result<(), ConfigError> {
    if valid_name(name) {
        Ok(())
    } else {
        Err(ConfigError::PurposeName(name.to_owned()))
    }
}

/// Resolve wildcard gateway binds to the existing local loopback URL.
#[must_use]
pub fn gateway_url(config: &Value) -> String {
    let host = config
        .get("gateway")
        .and_then(|gateway| gateway.get("host"));
    let host = if !is_javascript_truthy(host)
        || matches!(host, Some(Value::String(value)) if value == "0.0.0.0")
    {
        "127.0.0.1".to_owned()
    } else {
        javascript_string(host)
    };
    let port = config
        .get("gateway")
        .and_then(|gateway| gateway.get("port"));
    format!("http://{host}:{}", javascript_string(port))
}
