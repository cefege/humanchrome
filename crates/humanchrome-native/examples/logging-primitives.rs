//! Process fixture that proves native structured logs remain on stderr.

use std::error::Error;

use serde_json::json;

fn main() -> Result<(), Box<dyn Error>> {
    humanchrome_native::logging::init()?;
    let request = tracing::info_span!("request", requestId = "correlated-request");
    let _entered = request.enter();
    let percent_json = serde_json::to_string(&json!({
        "token": "percent-secret",
        "public": "percent-kept",
        "deeper": {"token": "deeper-percent-secret"},
    }))?;
    tracing::info!(
        token = "root-token-secret",
        password = "root-password-secret",
        authorization = "root-authorization-secret",
        headers = %json!({
            "Authorization": "header-authorization-secret",
            "authorization": "header-lower-authorization-secret",
            "cookie": "header-cookie-secret",
            "set-cookie": "response-cookie-secret",
            "accept": "application/json",
        }),
        query = %json!({
            "password": "query-password-secret",
            "apiKey": "query-api-key-secret",
            "public": "query-kept",
            "deeper": {"token": "deeper-token-secret"},
        }),
        other = %json!({"set-cookie": "other-cookie-kept"}),
        percentJson = %percent_json,
        "request complete"
    );
    Ok(())
}
