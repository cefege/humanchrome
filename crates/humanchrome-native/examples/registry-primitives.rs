//! Process fixture for persisted instance-registry differential tests.

use std::{
    io,
    path::PathBuf,
    time::{Duration, UNIX_EPOCH},
};

use humanchrome_native::registry::{InstanceRecord, InstanceRegistry};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    operation: String,
    directory: PathBuf,
    #[serde(default)]
    record: Option<InstanceRecord>,
    #[serde(default)]
    pid: Option<u32>,
    #[serde(default)]
    now_ms: Option<u64>,
    #[serde(default)]
    file: Option<String>,
    #[serde(default)]
    value: Option<Value>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    modified_ms: Option<u64>,
}

#[tokio::main]
async fn main() -> io::Result<()> {
    let request = std::env::args()
        .nth(1)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing fixture request"))
        .and_then(|argument| {
            serde_json::from_str::<Request>(&argument).map_err(io::Error::other)
        })?;
    let output = execute(request).await?;
    println!(
        "{}",
        serde_json::to_string(&output).map_err(io::Error::other)?
    );
    Ok(())
}

async fn execute(request: Request) -> io::Result<Value> {
    let registry = InstanceRegistry::new(request.directory.clone());
    match request.operation.as_str() {
        "write" => {
            let record = request.record.ok_or_else(|| missing("record"))?;
            registry.write(&record).await?;
            Ok(json!({"ok": true}))
        }
        "list" => Ok(Value::Array(
            registry
                .list(request.now_ms.ok_or_else(|| missing("nowMs"))?)
                .await,
        )),
        "remove" => {
            registry
                .remove(request.pid.ok_or_else(|| missing("pid"))?)
                .await;
            Ok(json!({"ok": true}))
        }
        "writeRaw" => {
            let file = request.file.ok_or_else(|| missing("file"))?;
            let value = request.value.ok_or_else(|| missing("value"))?;
            tokio::fs::create_dir_all(&request.directory).await?;
            tokio::fs::write(
                request.directory.join(file),
                serde_json::to_vec_pretty(&value).map_err(io::Error::other)?,
            )
            .await?;
            Ok(json!({"ok": true}))
        }
        "writeText" => {
            let file = request.file.ok_or_else(|| missing("file"))?;
            let text = request.text.ok_or_else(|| missing("text"))?;
            tokio::fs::create_dir_all(&request.directory).await?;
            tokio::fs::write(request.directory.join(file), text).await?;
            Ok(json!({"ok": true}))
        }
        "setMtime" => {
            let file = request.file.ok_or_else(|| missing("file"))?;
            let modified_ms = request.modified_ms.ok_or_else(|| missing("modifiedMs"))?;
            let path = request.directory.join(file);
            let file = std::fs::File::open(path)?;
            let times = std::fs::FileTimes::new()
                .set_modified(UNIX_EPOCH + Duration::from_millis(modified_ms));
            file.set_times(times)?;
            Ok(json!({"ok": true}))
        }
        "readRaw" => {
            let file = request.file.ok_or_else(|| missing("file"))?;
            Ok(Value::String(
                tokio::fs::read_to_string(request.directory.join(file)).await?,
            ))
        }
        "exists" => {
            let file = request.file.ok_or_else(|| missing("file"))?;
            Ok(Value::Bool(
                tokio::fs::try_exists(request.directory.join(file)).await?,
            ))
        }
        operation => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("unknown fixture operation {operation}"),
        )),
    }
}

fn missing(name: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        format!("missing fixture field {name}"),
    )
}
