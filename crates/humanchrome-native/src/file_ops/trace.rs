//! JSON Lines adapter to the retained Chrome DevTools trace engine.

use super::TraceAnalyzer;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    fmt,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
};
use thiserror::Error;
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::Mutex,
    task::JoinHandle,
};
use uuid::Uuid;

const MAX_STDERR_BYTES: usize = 16 * 1024;

/// Runs the real packaged DevTools formatter behind the shared JSON Lines boundary.
///
/// `module` is the parent-owned `third-party.mjs` adapter. It owns the
/// non-serializable DevTools imports and emits no protocol data except JSON Lines.
#[derive(Clone)]
pub struct DevtoolsTraceAnalyzer {
    node: PathBuf,
    module: PathBuf,
    adapter: Arc<Mutex<Option<TraceAdapterProcess>>>,
}

impl fmt::Debug for DevtoolsTraceAnalyzer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DevtoolsTraceAnalyzer")
            .field("node", &self.node)
            .field("module", &self.module)
            .finish_non_exhaustive()
    }
}

impl DevtoolsTraceAnalyzer {
    /// Select the Node executable and packaged third-party adapter module.
    #[must_use]
    pub fn new(node: PathBuf, module: PathBuf) -> Self {
        Self {
            node,
            module,
            adapter: Arc::new(Mutex::new(None)),
        }
    }
}

impl TraceAnalyzer for DevtoolsTraceAnalyzer {
    async fn analyze(&self, path: &Path, insight: Option<&str>) -> anyhow::Result<Value> {
        let id = Uuid::new_v4().to_string();
        let mut params = json!({"path": path.to_string_lossy()});
        if let Some(insight) = insight {
            params["insight"] = Value::String(insight.to_owned());
        }
        let request = json!({"id": id, "method":"trace.analyze", "params":params});
        let input = format!("{}\n", serde_json::to_string(&request)?);

        // The formatter holds a single mutable DevTools trace engine. Serializing requests
        // preserves its reset/parse lifecycle and still keeps one lazy JSONL child for every
        // clone of this analyzer.
        let mut adapter = self.adapter.lock().await;
        if adapter.is_none() {
            *adapter = Some(TraceAdapterProcess::start(&self.node, &self.module).await?);
        }
        let exchange = {
            let process = adapter
                .as_mut()
                .ok_or_else(|| anyhow::anyhow!("DevTools trace adapter was not initialized"))?;
            process.exchange(&input, &id).await
        };
        match exchange {
            Ok(TraceExchange::Result(value)) => validate_result(value),
            Ok(TraceExchange::Error(error)) => {
                let _ = &error.name;
                Err(error.into())
            }
            Err(error) => {
                *adapter = None;
                Err(error)
            }
            Ok(TraceExchange::Exited { malformed }) => {
                let mut process = adapter.take().ok_or_else(|| {
                    anyhow::anyhow!("DevTools trace adapter exited before responding")
                })?;
                let status = process.child.wait().await.map_err(|error| {
                    anyhow::anyhow!("could not wait for DevTools trace adapter: {error}")
                })?;
                let stderr = process.stderr_task.await.unwrap_or_default();
                if !status.success() {
                    anyhow::bail!(
                        "{}",
                        if stderr.is_empty() {
                            "DevTools trace analyzer failed".to_owned()
                        } else {
                            stderr
                        }
                    );
                }
                if let Some(error) = malformed {
                    anyhow::bail!("DevTools trace adapter returned invalid JSON: {error}");
                }
                anyhow::bail!("DevTools trace adapter did not return a result")
            }
        }
    }
}

struct TraceAdapterProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: Lines<BufReader<ChildStdout>>,
    stderr_task: JoinHandle<String>,
}

impl TraceAdapterProcess {
    async fn start(node: &Path, module: &Path) -> anyhow::Result<Self> {
        let mut child = Command::new(node)
            .arg(module)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| anyhow::anyhow!("could not start DevTools trace adapter: {error}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow::anyhow!("DevTools trace adapter stdin was not captured"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow::anyhow!("DevTools trace adapter stdout was not captured"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| anyhow::anyhow!("DevTools trace adapter stderr was not captured"))?;
        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout).lines(),
            stderr_task: tokio::spawn(read_limited(stderr)),
        })
    }

    async fn exchange(&mut self, input: &str, id: &str) -> anyhow::Result<TraceExchange> {
        self.stdin
            .write_all(input.as_bytes())
            .await
            .map_err(|error| {
                anyhow::anyhow!("could not deliver DevTools trace request: {error}")
            })?;
        self.stdin
            .flush()
            .await
            .map_err(|error| anyhow::anyhow!("could not flush DevTools trace request: {error}"))?;

        let mut malformed = None;
        loop {
            let line = self.stdout.next_line().await.map_err(|error| {
                anyhow::anyhow!("could not read DevTools trace adapter output: {error}")
            })?;
            let Some(line) = line else {
                return Ok(TraceExchange::Exited { malformed });
            };
            match serde_json::from_str::<AdapterEnvelope>(&line) {
                Ok(envelope) if envelope.id == id => match envelope.event.as_str() {
                    "result" => return Ok(TraceExchange::Result(envelope.value)),
                    "error" => return Ok(TraceExchange::Error(adapter_error(envelope.value)?)),
                    _ => {}
                },
                Ok(_) => {}
                Err(error) => malformed = Some(error),
            }
        }
    }
}

enum TraceExchange {
    Result(Value),
    Error(AdapterError),
    Exited {
        malformed: Option<serde_json::Error>,
    },
}

#[derive(Deserialize)]
struct AdapterEnvelope {
    id: String,
    event: String,
    value: Value,
}

#[derive(Debug, Error)]
#[error("{message}")]
struct AdapterError {
    name: String,
    message: String,
}

fn adapter_error(value: Value) -> anyhow::Result<AdapterError> {
    let error: AdapterErrorPayload = serde_json::from_value(value).map_err(|error| {
        anyhow::anyhow!("DevTools trace adapter returned an invalid error: {error}")
    })?;
    Ok(AdapterError {
        name: error.name,
        message: error.message,
    })
}

#[derive(Deserialize)]
struct AdapterErrorPayload {
    name: String,
    message: String,
}

fn validate_result(value: Value) -> anyhow::Result<Value> {
    if !value.get("summary").is_some_and(Value::is_string) {
        anyhow::bail!("DevTools trace analyzer did not return a summary");
    }
    Ok(value)
}

async fn read_limited(mut input: impl AsyncRead + Unpin) -> String {
    let mut retained = Vec::new();
    let mut buffer = [0_u8; 4096];
    while let Ok(read) = input.read(&mut buffer).await {
        if read == 0 {
            break;
        }
        let remaining = MAX_STDERR_BYTES.saturating_sub(retained.len());
        retained.extend_from_slice(&buffer[..read.min(remaining)]);
    }
    String::from_utf8_lossy(&retained).trim().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adapter_errors_retain_the_protocol_name_and_message() {
        let error = adapter_error(
            serde_json::json!({"name":"TraceParseError","message":"trace is invalid"}),
        )
        .expect("valid adapter error");
        assert_eq!(error.name, "TraceParseError");
        assert_eq!(error.message, "trace is invalid");
    }
}
