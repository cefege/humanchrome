//! In-browser Google session probing shared by provisioning and CLI verification.

use std::time::Duration;

use serde_json::{Value, json};

use super::{FleetRuntimeError, GoogleSession, classify_list_accounts};

const CLIENT_ID: &str = "fleet-google-probe";
const PROBE_PAGE: &str = "https://accounts.google.com/robots.txt";
const PROBE_CODE: &str = "const response = await fetch('/ListAccounts?gpsia=1&source=ChromiumBrowser&json=standard', { method: 'POST', credentials: 'include', body: ' ' }); return { status: response.status, body: await response.text() };";

/// Probe Google's live state through the profile's authenticated extension bridge.
///
/// The background tab and client lane are released even when Google or the bridge fails.
/// # Errors
/// Returns tool, response-shape or Google account-response errors without guessing a state.
pub(crate) async fn probe_profile_google_session(
    port: u16,
    token: &str,
) -> Result<GoogleSession, FleetRuntimeError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| FleetRuntimeError::Profile(error.to_string()))?;
    let result = probe(&client, port, token).await;
    let _ = client
        .post(format!(
            "http://127.0.0.1:{port}/api/clients/{CLIENT_ID}/release"
        ))
        .bearer_auth(token)
        .send()
        .await;
    result
}

async fn probe(
    client: &reqwest::Client,
    port: u16,
    token: &str,
) -> Result<GoogleSession, FleetRuntimeError> {
    let opened = tool(
        client,
        port,
        token,
        "chrome_navigate_batch",
        json!({"urls":[PROBE_PAGE],"background":true}),
    )
    .await?;
    let tab_id = opened
        .get("tabs")
        .and_then(Value::as_array)
        .and_then(|tabs| tabs.first())
        .and_then(|tab| tab.get("tabId"))
        .and_then(Value::as_u64)
        .ok_or_else(|| FleetRuntimeError::Profile("the bridge opened no probe tab".to_owned()))?;
    let result = async {
        tool(
            client,
            port,
            token,
            "chrome_wait_for",
            json!({"kind":"load_state","state":"complete","tabId":tab_id}),
        )
        .await?;
        let ran = tool(
            client,
            port,
            token,
            "chrome_javascript",
            json!({"tabId":tab_id,"code":PROBE_CODE}),
        )
        .await?;
        let answer = ran
            .get("result")
            .and_then(Value::as_str)
            .and_then(|result| serde_json::from_str::<Value>(result).ok())
            .ok_or_else(|| {
                FleetRuntimeError::Profile("the ListAccounts probe returned nothing".to_owned())
            })?;
        if !answer.is_object() || answer.get("status").is_none() || answer.get("body").is_none() {
            return Err(FleetRuntimeError::Profile(
                "the ListAccounts probe returned nothing".to_owned(),
            ));
        }
        if answer.get("status").and_then(Value::as_u64) != Some(200) || !answer["body"].is_string()
        {
            let status = answer["status"]
                .as_str()
                .map_or_else(|| answer["status"].to_string(), str::to_owned);
            return Err(FleetRuntimeError::Profile(format!(
                "ListAccounts answered HTTP {status}"
            )));
        }
        classify_list_accounts(
            answer["body"]
                .as_str()
                .expect("Google body string was validated"),
        )
    }
    .await;
    let _ = tool(
        client,
        port,
        token,
        "chrome_close_tabs",
        json!({"action":"ids","tabIds":[tab_id]}),
    )
    .await;
    result
}

async fn tool(
    client: &reqwest::Client,
    port: u16,
    token: &str,
    name: &str,
    args: Value,
) -> Result<Value, FleetRuntimeError> {
    let response = client
        .post(format!("http://127.0.0.1:{port}/api/tools/{name}"))
        .bearer_auth(token)
        .header("x-client-id", CLIENT_ID)
        .json(&json!({"args":args}))
        .send()
        .await
        .map_err(|error| FleetRuntimeError::Profile(format!("{name} failed: {error}")))?;
    let status = response.status();
    let payload = response.json::<Value>().await.unwrap_or(Value::Null);
    let text = payload
        .get("content")
        .and_then(Value::as_array)
        .and_then(|blocks| {
            blocks
                .iter()
                .find_map(|block| block.get("text").and_then(Value::as_str))
        });
    if !status.is_success()
        || payload.get("isError").and_then(Value::as_bool) == Some(true)
        || text.is_none()
    {
        return Err(FleetRuntimeError::Profile(format!(
            "{name} failed (HTTP {}): {}",
            status.as_u16(),
            text.unwrap_or("no result")
        )));
    }
    serde_json::from_str(text.expect("tool text was validated"))
        .map_err(|_| FleetRuntimeError::Profile(format!("{name} answered with non-JSON text")))
}
