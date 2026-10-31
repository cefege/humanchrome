//! Claude Code Router configuration and environment policy, without JavaScript ownership.

use std::{
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
    time::Duration,
};

use serde::Serialize;
use serde_json::{Map, Value};

use crate::native_host::epoch_millis;

#[derive(Clone)]
struct Detection {
    credentials: Option<(String, String)>,
    source: Option<&'static str>,
    error: Option<String>,
}

static DETECTION: LazyLock<Mutex<Option<(u64, Detection)>>> = LazyLock::new(|| Mutex::new(None));

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Validation {
    pub checked: bool,
    pub valid: bool,
    pub config_path: PathBuf,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub router_default: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issue: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_fix: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggestion: Option<String>,
}

/// SDK env is a complete replacement, so preserve the inherited environment before overrides.
pub(super) async fn environment(use_ccr: bool, node: &Path) -> Map<String, Value> {
    let mut environment: Map<String, Value> = std::env::vars_os()
        .map(|(key, value)| {
            (
                key.to_string_lossy().into_owned(),
                Value::String(value.to_string_lossy().into_owned()),
            )
        })
        .collect();
    ensure_node_path(&mut environment, node);
    if use_ccr && !environment.get("ANTHROPIC_BASE_URL").is_some_and(truthy) {
        let detected = detect().await;
        if let Some((url, token)) = detected.credentials {
            environment.insert("ANTHROPIC_BASE_URL".into(), Value::String(url));
            environment.insert("ANTHROPIC_AUTH_TOKEN".into(), Value::String(token));
            tracing::info!(source = detected.source, "CCR auto-detected");
        } else if let Some(error) = detected.error {
            tracing::warn!(err = error, "CCR detection failed");
        }
    }
    environment
}

/// Restores Node's directory after a request-specific environment replaces `PATH`.
pub(super) fn ensure_node_path(environment: &mut Map<String, Value>, node: &Path) {
    let current_path = environment
        .get("PATH")
        .or_else(|| environment.get("Path"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if let Some(directory) = node.parent().filter(|path| !path.as_os_str().is_empty()) {
        let directory = directory.to_string_lossy();
        if !current_path.contains(directory.as_ref()) {
            let separator = if cfg!(windows) { ";" } else { ":" };
            let path = if current_path.is_empty() {
                directory.into_owned()
            } else {
                format!("{directory}{separator}{current_path}")
            };
            environment.insert("PATH".into(), Value::String(path));
        }
    }
}

async fn detect() -> Detection {
    let now = epoch_millis();
    if let Some((timestamp, result)) = DETECTION
        .lock()
        .expect("CCR detection lock poisoned")
        .as_ref()
        && now.saturating_sub(*timestamp) < 60_000
    {
        return result.clone();
    }
    let result = detect_uncached().await;
    *DETECTION.lock().expect("CCR detection lock poisoned") = Some((now, result.clone()));
    result
}

async fn detect_uncached() -> Detection {
    if let (Ok(url), Ok(token)) = (
        std::env::var("ANTHROPIC_BASE_URL"),
        std::env::var("ANTHROPIC_AUTH_TOKEN"),
    ) && !url.is_empty()
        && !token.is_empty()
        && healthy(&url).await
    {
        return Detection {
            credentials: Some((url, token)),
            source: Some("env"),
            error: None,
        };
    }
    let config = match read_config().await {
        Ok(config) if truthy(&config) => config,
        Ok(_) => return unavailable("CCR config not found or invalid"),
        Err(error) => return unavailable(error),
    };
    let port = nullish(&config, "PORT", "port")
        .cloned()
        .unwrap_or(Value::from(9898));
    let host = nullish(&config, "HOST", "host")
        .cloned()
        .unwrap_or_else(|| Value::from("127.0.0.1"));
    let url = format!("http://{}:{}", js_string(&host), js_string(&port));
    if !healthy(&url).await {
        return unavailable("CCR config found but service not running");
    }
    let token = nullish(&config, "APIKEY", "apiKey")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("APIKEY")
        .to_owned();
    Detection {
        credentials: Some((url, token)),
        source: Some("config"),
        error: None,
    }
}

fn unavailable(error: impl Into<String>) -> Detection {
    Detection {
        credentials: None,
        source: None,
        error: Some(error.into()),
    }
}

async fn healthy(url: &str) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
    else {
        return false;
    };
    client
        .get(format!("{url}/health"))
        .send()
        .await
        .is_ok_and(|response| response.status().is_success())
}

pub(super) async fn validate() -> Result<Validation, String> {
    let path = config_path()?;
    let config = match read_config().await {
        Ok(config) if truthy(&config) => config,
        result => {
            return Ok(Validation {
                checked: false,
                valid: true,
                config_path: path,
                router_default: None,
                issue: result.err(),
                suggested_fix: None,
                suggestion: None,
            });
        }
    };
    let router = nullish(&config, "Router", "router");
    let raw_default = router
        .and_then(|router| router.get("default"))
        .filter(|value| !value.is_null());
    if raw_default.is_some_and(|value| !value.is_string()) {
        return Err("router?.default?.trim is not a function".into());
    }
    let default = raw_default
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let mut validation = Validation {
        checked: true,
        valid: false,
        config_path: path,
        router_default: default.map(str::to_owned),
        issue: None,
        suggested_fix: None,
        suggestion: None,
    };
    let display_path = validation.config_path.display();
    let Some(default) = default else {
        validation.issue = Some("CCR Router.default is not configured.".into());
        validation.suggestion = Some(format!(
            "Edit {display_path} and set Router.default to \"provider,model\" format, then restart CCR."
        ));
        return Ok(validation);
    };
    let mut parts = default.split(',');
    let provider = parts.next().unwrap_or("").trim();
    let model = parts.next().map(str::trim);
    if model.is_none() {
        validation.suggested_fix = suggested(default, &config, router)?;
        let example = validation
            .suggested_fix
            .clone()
            .unwrap_or_else(|| format!("{default},<model>"));
        validation.issue = Some(format!(
            "CCR Router.default must be \"provider,model\" format, but got \"{default}\" (missing model)."
        ));
        validation.suggestion = Some(format!(
            "Edit {display_path} and change Router.default from \"{default}\" to \"{example}\", then restart CCR."
        ));
    } else if provider.is_empty() || model.is_none_or(str::is_empty) {
        validation.suggested_fix = suggested(provider, &config, router)?;
        validation.issue = Some(format!(
            "CCR Router.default \"{default}\" has empty provider or model part."
        ));
        validation.suggestion = Some(format!(
            "Edit {display_path} and set Router.default to a valid \"provider,model\" format, then restart CCR."
        ));
    } else {
        validation.valid = true;
    }
    Ok(validation)
}

fn suggested(name: &str, config: &Value, router: Option<&Value>) -> Result<Option<String>, String> {
    if name.is_empty() {
        return Ok(None);
    }
    let providers = nullish(config, "Providers", "providers");
    let providers = match providers {
        None => &[][..],
        Some(Value::Array(values)) => values,
        Some(_) => return Err("providers.find is not a function".into()),
    };
    for provider in providers {
        let Some(provider_name) = provider.get("name").and_then(Value::as_str) else {
            continue;
        };
        if provider_name.to_lowercase() == name.to_lowercase()
            && let Some(model) = provider
                .get("models")
                .and_then(|models| models.get(0))
                .filter(|value| truthy(value))
        {
            return Ok(Some(format!("{provider_name},{}", js_string(model))));
        }
    }
    for key in ["background", "think", "longContext"] {
        if let Some(entry) = router
            .and_then(|router| router.get(key))
            .and_then(Value::as_str)
        {
            let mut parts = entry.split(',');
            let provider = parts.next().unwrap_or("").trim();
            if let Some(model) = parts
                .next()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                && provider.to_lowercase() == name.to_lowercase()
            {
                return Ok(Some(format!("{name},{model}")));
            }
        }
    }
    Ok(None)
}

async fn read_config() -> Result<Value, String> {
    let path = config_path()?;
    let content = tokio::fs::read_to_string(&path).await.map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "CCR config file not found".into()
        } else {
            format!("Failed to read CCR config: {error}")
        }
    })?;
    serde_json::from_str(&interpolate(&content))
        .map_err(|_| "Failed to parse CCR config file".into())
}

fn config_path() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".claude-code-router/config.json"))
        .ok_or_else(|| "could not resolve the home directory for CCR configuration".into())
}

fn interpolate(content: &str) -> String {
    let mut output = String::with_capacity(content.len());
    let mut remaining = content;
    while let Some(start) = remaining.find("${") {
        output.push_str(&remaining[..start]);
        let tail = &remaining[start + 2..];
        let Some(end) = tail.find('}') else {
            output.push_str(&remaining[start..]);
            return output;
        };
        if end == 0 {
            output.push_str("${}");
        } else if let Some(value) = std::env::var_os(tail[..end].trim()) {
            output.push_str(&value.to_string_lossy());
        }
        remaining = &tail[end + 1..];
    }
    output.push_str(remaining);
    output
}

fn nullish<'a>(value: &'a Value, upper: &str, lower: &str) -> Option<&'a Value> {
    value
        .get(upper)
        .filter(|value| !value.is_null())
        .or_else(|| value.get(lower).filter(|value| !value.is_null()))
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::String(value) => !value.is_empty(),
        Value::Number(value) => value.as_f64() != Some(0.0),
        _ => true,
    }
}

fn js_string(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        _ => humanchrome_core::json_document::JsonRef::from(value)
            .to_js_string()
            .to_string(),
    }
}
