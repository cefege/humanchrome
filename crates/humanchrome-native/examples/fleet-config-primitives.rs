//! Isolated fleet configuration and purpose-guard fixture for differential process tests.

use std::{env, path::PathBuf};

use anyhow::{Context, Result, bail};
use humanchrome_native::fleet::{
    config::{ConfigError, ConfigStore, gateway_url},
    purpose_guard::evaluate,
};
use serde_json::{Map, Value, json};
use tokio::fs;

#[tokio::main]
async fn main() -> Result<()> {
    let scenario_path = env::args()
        .nth(1)
        .context("usage: fleet-config-primitives <scenario.json>")?;
    let scenario: Value = serde_json::from_slice(&fs::read(scenario_path).await?)?;
    let root = env::var_os("HC_FLEET_ROOT")
        .map(PathBuf::from)
        .context("HC_FLEET_ROOT is required")?;
    let home = env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("home"));
    let store = ConfigStore::new(root, home);
    let operations = scenario["operations"]
        .as_array()
        .context("scenario.operations must be an array")?;
    let mut outcomes = Vec::with_capacity(operations.len());

    for operation in operations {
        outcomes.push(run_operation(&store, operation).await?);
    }
    let output = json!({"operations": outcomes});
    println!("{}", humanchrome_core::json::stringify(&output));
    Ok(())
}

async fn run_operation(store: &ConfigStore, operation: &Value) -> Result<Value> {
    let name = operation["op"]
        .as_str()
        .context("fixture operation requires a string op")?;
    match name {
        "load" => Ok(load_result(store).await),
        "load-save" => match store.load().await {
            Ok(config) => {
                if let Err(error) = store.save(&config).await {
                    return Ok(error_result(&error));
                }
                let contents = fs::read_to_string(store.path()).await?;
                let temporary_files = temp_files(store).await?;
                let mut result = Map::new();
                result.insert("ok".to_owned(), Value::Bool(true));
                result.insert("value".to_owned(), config);
                result.insert("file".to_owned(), Value::String(contents));
                result.insert("temporaryFiles".to_owned(), Value::Array(temporary_files));
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let mode = fs::metadata(store.path()).await?.permissions().mode() & 0o777;
                    result.insert("mode".to_owned(), json!(mode));
                }
                Ok(Value::Object(result))
            }
            Err(error) => Ok(error_result(&error)),
        },
        "gateway-url" => match store.load().await {
            Ok(config) => Ok(json!({"ok": true, "value": gateway_url(&config)})),
            Err(error) => Ok(error_result(&error)),
        },
        "evaluate" => {
            let tool_name = operation["toolName"]
                .as_str()
                .context("evaluate operation requires toolName")?;
            let args = operation.get("args").cloned().map(Into::into);
            let protection = operation.get("protection").and_then(Value::as_str);
            match evaluate(tool_name, args, protection) {
                Ok(args) => Ok(verdict_result(true, args, None)),
                Err(refusal) => Ok(verdict_result(false, refusal.args, Some(refusal.message))),
            }
        }
        _ => bail!("unknown fixture operation: {name}"),
    }
}

async fn load_result(store: &ConfigStore) -> Value {
    match store.load().await {
        Ok(value) => json!({"ok": true, "value": value}),
        Err(error) => error_result(&error),
    }
}

fn error_result(error: &ConfigError) -> Value {
    let name = match error {
        ConfigError::Json(_) => "SyntaxError",
        ConfigError::TypeError(_) => "TypeError",
        _ => "Error",
    };
    json!({"ok": false, "error": {"name": name, "message": error.to_string()}})
}

fn verdict_result(
    allowed: bool,
    args: Option<humanchrome_core::json_document::JsonDocument>,
    message: Option<String>,
) -> Value {
    let mut result = Map::new();
    result.insert("allowed".to_owned(), Value::Bool(allowed));
    if let Some(args) = args {
        result.insert(
            "args".to_owned(),
            args.into_value()
                .expect("fleet fixture inputs are well-formed UTF-8 JSON"),
        );
    }
    if let Some(message) = message {
        result.insert("message".to_owned(), Value::String(message));
    }
    Value::Object(result)
}

async fn temp_files(store: &ConfigStore) -> Result<Vec<Value>> {
    let mut entries = fs::read_dir(store.root()).await?;
    let mut names = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with("fleet.json.") && name.ends_with(".tmp") {
            names.push(Value::String(name));
        }
    }
    names.sort_by(|left, right| left.as_str().cmp(&right.as_str()));
    Ok(names)
}
