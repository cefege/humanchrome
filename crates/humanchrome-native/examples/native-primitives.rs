//! Isolated NativeHost fixture with a private control endpoint for process differential tests.

use std::{
    collections::HashMap,
    env,
    net::SocketAddr,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use anyhow::{Context, Result};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
};
use humanchrome_core::json_document::JsonDocument;
use humanchrome_native::{
    logging,
    native_host::{ExtensionRequest, NativeClient, NativeHost},
    paths::NativePaths,
};
use tokio::sync::{Mutex, broadcast};
use uuid::Uuid;

type BatchResults = Arc<Mutex<Vec<Option<JsonDocument>>>>;

#[derive(Clone)]
struct FixtureState {
    client: NativeClient,
    batches: Arc<Mutex<HashMap<String, BatchResults>>>,
    next_batch: Arc<AtomicU64>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let mut arguments = env::args().skip(1);
    let mut control_port = None;
    let mut relay = false;
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--relay" => relay = true,
            "--control-port" => {
                let port = arguments
                    .next()
                    .context("--control-port requires a value")?;
                control_port = Some(port.parse::<u16>().context("invalid --control-port")?);
            }
            _ => anyhow::bail!("usage: native-primitives --control-port <port> | --relay"),
        }
    }

    logging::init()?;

    let paths = NativePaths::from_environment()?;
    let (host, client, mut directives) = NativeHost::new(paths);
    if relay {
        tokio::spawn(async move { while directives.recv().await.is_some() {} });
        return host.run().await.map_err(Into::into);
    }
    let port = control_port.context("usage: native-primitives --control-port <port> | --relay")?;
    let state = FixtureState {
        client,
        batches: Arc::new(Mutex::new(HashMap::new())),
        next_batch: Arc::new(AtomicU64::new(0)),
    };
    tokio::spawn(async move { while directives.recv().await.is_some() {} });

    let (shutdown, _) = broadcast::channel(1);
    let application = Router::new()
        .route("/__test/request", post(request))
        .route("/__test/batch", post(batch))
        .route("/__test/batch/{batch_id}", get(batch_status))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port))).await?;
    let mut host = tokio::spawn(host.run());
    let mut shutdown_receiver = shutdown.subscribe();
    let mut http = tokio::spawn(async move {
        axum::serve(listener, application)
            .with_graceful_shutdown(async move {
                let _ = shutdown_receiver.recv().await;
            })
            .await
    });

    tokio::select! {
        result = &mut host => {
            let _ = shutdown.send(());
            result.context("native host task panicked")??;
            http.await.context("control server task panicked")??;
        }
        result = &mut http => {
            state.client.shutdown();
            result.context("control server task panicked")??;
            host.await.context("native host task panicked")??;
        }
    }
    Ok(())
}

async fn request(
    State(state): State<FixtureState>,
    body: Bytes,
) -> (StatusCode, Json<JsonDocument>) {
    (
        StatusCode::OK,
        Json(invoke(&state.client, parse_document(body)).await),
    )
}

async fn batch(State(state): State<FixtureState>, body: Bytes) -> (StatusCode, Json<JsonDocument>) {
    let input = parse_document(body);
    let Some(count) = input
        .get("count")
        .and_then(|value| value.to_owned().validation_value().as_u64())
    else {
        return bad_batch_count();
    };
    if count > 1_001 {
        return bad_batch_count();
    }
    let count = usize::try_from(count).expect("fixture batch count is bounded by 1001");
    let sequence = state.next_batch.fetch_add(1, Ordering::Relaxed);
    let batch_id = format!("batch-{sequence}");
    let results = Arc::new(Mutex::new(vec![None; count]));
    state
        .batches
        .lock()
        .await
        .insert(batch_id.clone(), results.clone());
    for index in 0..count {
        let client = state.client.clone();
        let request = input.clone();
        let results = results.clone();
        tokio::spawn(async move {
            let result = invoke(&client, request).await;
            results.lock().await[index] = Some(result);
        });
    }
    (
        StatusCode::OK,
        Json(JsonDocument::object([
            ("batchId", JsonDocument::from(batch_id)),
            (
                "count",
                JsonDocument::from(serde_json::Value::from(count as u64)),
            ),
        ])),
    )
}

async fn batch_status(
    State(state): State<FixtureState>,
    Path(batch_id): Path<String>,
) -> (StatusCode, Json<JsonDocument>) {
    let Some(results) = state.batches.lock().await.get(&batch_id).cloned() else {
        return (
            StatusCode::NOT_FOUND,
            Json(JsonDocument::object([(
                "error",
                JsonDocument::from("unknown batch"),
            )])),
        );
    };
    let results = results.lock().await.clone();
    (
        StatusCode::OK,
        Json(JsonDocument::object([(
            "results",
            JsonDocument::array(results.into_iter().map(|result| {
                result.unwrap_or_else(|| JsonDocument::from(serde_json::Value::Null))
            })),
        )])),
    )
}

async fn invoke(client: &NativeClient, input: JsonDocument) -> JsonDocument {
    let request = match parse_request(input) {
        Ok(request) => request,
        Err(message) => {
            return JsonDocument::object([
                ("outcome", JsonDocument::from("rejected")),
                ("error", JsonDocument::from(message)),
            ]);
        }
    };
    match client.request(request).await {
        Ok(Some(payload)) => JsonDocument::object([
            ("outcome", JsonDocument::from("resolved")),
            ("payloadPresent", JsonDocument::from(true)),
            ("payload", payload),
        ]),
        Ok(None) => JsonDocument::object([
            ("outcome", JsonDocument::from("resolved")),
            ("payloadPresent", JsonDocument::from(false)),
        ]),
        Err(error) => JsonDocument::object([
            ("outcome", JsonDocument::from("rejected")),
            ("error", JsonDocument::string(error.into_js_message())),
        ]),
    }
}

fn parse_document(body: Bytes) -> JsonDocument {
    std::str::from_utf8(&body)
        .ok()
        .and_then(|input| JsonDocument::parse(input).ok())
        .unwrap_or_else(|| JsonDocument::from(serde_json::Value::Null))
}

fn bad_batch_count() -> (StatusCode, Json<JsonDocument>) {
    (
        StatusCode::BAD_REQUEST,
        Json(JsonDocument::object([(
            "error",
            JsonDocument::from("count must be an integer from 0 through 1001"),
        )])),
    )
}

fn parse_request(mut input: JsonDocument) -> Result<ExtensionRequest, String> {
    if !input.is_object() {
        return Err("Invalid test request: messageType must be a string".to_owned());
    }
    let message_type = input
        .get("messageType")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "Invalid test request: messageType must be a string".to_owned())?
        .to_owned();
    let timeout_ms = input
        .get("timeoutMs")
        .and_then(|value| value.to_owned().validation_value().as_u64());
    let request_id = input
        .get("requestId")
        .and_then(|value| value.as_str())
        .map(Uuid::parse_str)
        .transpose()
        .map_err(|_| "Invalid test request: requestId must be a UUID".to_owned())?;
    let client_id = input
        .get("clientId")
        .and_then(|value| value.as_str())
        .map(ToOwned::to_owned);
    Ok(ExtensionRequest {
        message_type,
        payload: input.remove("payload"),
        client_id,
        timeout_ms,
        request_id,
    })
}
