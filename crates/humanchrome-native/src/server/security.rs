//! Native bridge DNS-rebinding, origin and bearer checks for mutating requests.

use axum::{
    Json,
    body::Body,
    extract::{Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde_json::json;

/// Security settings captured once when the listener starts.
#[derive(Clone, Debug, Default)]
pub struct SecurityPolicy {
    token: Option<String>,
}

impl SecurityPolicy {
    /// Construct a policy from the configured bearer token, trimming as the
    /// existing native bridge does. Empty tokens leave bearer auth disabled.
    #[must_use]
    pub fn new(token: Option<&str>) -> Self {
        Self {
            token: token
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned),
        }
    }

    /// Check the bridge's mutation-only security rules in their original order.
    #[must_use]
    pub fn reject(
        &self,
        method: &Method,
        headers: &HeaderMap,
    ) -> Option<(StatusCode, &'static str)> {
        if !matches!(
            *method,
            Method::POST | Method::PUT | Method::DELETE | Method::PATCH
        ) {
            return None;
        }
        let host = headers
            .get(header::HOST)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        let name = host.split(':').next().unwrap_or("");
        let allow = |value| matches!(value, "127.0.0.1" | "localhost" | "[::1]" | "::1");
        if !allow(name) && !allow(host.as_str()) {
            return Some((StatusCode::FORBIDDEN, "Host not allowed"));
        }
        if let Some(origin) = headers
            .get(header::ORIGIN)
            .and_then(|value| value.to_str().ok())
            .filter(|origin| !origin.is_empty())
            && !allowed_origin(origin)
        {
            return Some((StatusCode::FORBIDDEN, "Origin not allowed"));
        }
        if let Some(token) = &self.token {
            let auth = headers
                .get(header::AUTHORIZATION)
                .and_then(|value| value.to_str().ok())
                .unwrap_or("");
            let presented = auth.strip_prefix("Bearer ").unwrap_or("").trim();
            if presented != token {
                return Some((StatusCode::UNAUTHORIZED, "Invalid or missing bearer token"));
            }
        }
        None
    }
}

fn allowed_origin(origin: &str) -> bool {
    origin.starts_with("chrome-extension://")
        || origin.starts_with("moz-extension://")
        || origin.starts_with("http://127.0.0.1")
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CorsOrigin {
    Allowed,
    Denied,
}

fn cors_origin(origin: Option<&HeaderValue>) -> CorsOrigin {
    match origin.and_then(|origin| origin.to_str().ok()) {
        None | Some("") => CorsOrigin::Allowed,
        Some(origin) if allowed_origin(origin) => CorsOrigin::Allowed,
        Some(_) => CorsOrigin::Denied,
    }
}

fn append_vary(headers: &mut HeaderMap, field: &'static str) {
    let Some(existing) = headers
        .get(header::VARY)
        .and_then(|value| value.to_str().ok())
    else {
        headers.insert(header::VARY, HeaderValue::from_static(field));
        return;
    };
    if existing == "*"
        || existing
            .split(',')
            .any(|value| value.trim().eq_ignore_ascii_case(field))
    {
        return;
    }
    let value = format!("{existing}, {field}")
        .parse()
        .expect("static Vary field names produce valid header values");
    headers.insert(header::VARY, value);
}

fn apply_cors_headers(
    response: &mut Response,
    origin: Option<&HeaderValue>,
    cors_origin: CorsOrigin,
    successful_preflight: bool,
    requested_headers: Option<&HeaderValue>,
) {
    let headers = response.headers_mut();
    // The Fastify origin callback is dynamic, so @fastify/cors always varies
    // the response even when the request origin is denied or absent.
    append_vary(headers, "Origin");
    if cors_origin == CorsOrigin::Denied {
        return;
    }
    if let Some(origin) = origin.filter(|origin| !origin.is_empty()) {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin.clone());
    }
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
        HeaderValue::from_static("true"),
    );
    if successful_preflight {
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET, POST, DELETE, OPTIONS"),
        );
        if let Some(requested_headers) = requested_headers {
            headers.insert(
                header::ACCESS_CONTROL_ALLOW_HEADERS,
                requested_headers.clone(),
            );
        }
        // @fastify/cors varies this preflight response even if no request
        // headers were requested because allowedHeaders is not configured.
        append_vary(headers, "Access-Control-Request-Headers");
    }
}

/// Apply the bridge's CORS response and preflight rules.
pub async fn cors(request: Request<Body>, next: Next) -> Response {
    // The TypeScript MCP handler hijacks the raw response after Fastify's CORS
    // hook. Its streamable replies therefore do not carry CORS headers.
    if request.uri().path() == "/mcp" {
        return next.run(request).await;
    }
    let origin = request.headers().get(header::ORIGIN).cloned();
    let cors_origin = cors_origin(origin.as_ref());
    let is_options = request.method() == Method::OPTIONS;
    let has_requested_method = request
        .headers()
        .contains_key(header::ACCESS_CONTROL_REQUEST_METHOD);
    let requested_headers = request
        .headers()
        .get(header::ACCESS_CONTROL_REQUEST_HEADERS)
        .cloned();
    let successful_preflight = is_options
        && cors_origin == CorsOrigin::Allowed
        && origin.as_ref().is_some_and(|origin| !origin.is_empty())
        && has_requested_method;
    let mut response = if is_options && cors_origin == CorsOrigin::Allowed {
        if successful_preflight {
            (
                StatusCode::NO_CONTENT,
                [(header::CONTENT_LENGTH, HeaderValue::from_static("0"))],
            )
                .into_response()
        } else {
            (
                StatusCode::BAD_REQUEST,
                [(header::CONTENT_TYPE, HeaderValue::from_static("text/plain"))],
                "Invalid Preflight Request",
            )
                .into_response()
        }
    } else {
        next.run(request).await
    };
    apply_cors_headers(
        &mut response,
        origin.as_ref(),
        cors_origin,
        successful_preflight,
        requested_headers.as_ref(),
    );
    response
}

/// Apply security to an Axum router without changing GET/HEAD/OPTIONS behavior.
pub async fn guard(
    State(policy): State<SecurityPolicy>,
    request: Request<Body>,
    next: Next,
) -> Response {
    if let Some((status, error)) = policy.reject(request.method(), request.headers()) {
        return (status, Json(json!({"error": error}))).into_response();
    }
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn rejects_mutating_hosts_origins_and_tokens_in_order() {
        let policy = SecurityPolicy::new(Some(" secret "));
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_static("attacker.invalid"));
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://attacker.invalid"),
        );
        assert_eq!(
            policy.reject(&Method::POST, &headers),
            Some((StatusCode::FORBIDDEN, "Host not allowed"))
        );
        headers.insert(header::HOST, HeaderValue::from_static("localhost:12306"));
        assert_eq!(
            policy.reject(&Method::POST, &headers),
            Some((StatusCode::FORBIDDEN, "Origin not allowed"))
        );
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("chrome-extension://fixture"),
        );
        assert_eq!(
            policy.reject(&Method::POST, &headers),
            Some((StatusCode::UNAUTHORIZED, "Invalid or missing bearer token"))
        );
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer secret"),
        );
        assert_eq!(policy.reject(&Method::POST, &headers), None);
    }

    #[test]
    fn empty_origin_is_treated_as_absent_by_cors_and_security() {
        let policy = SecurityPolicy::new(None);
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_static("localhost:12306"));
        headers.insert(header::ORIGIN, HeaderValue::from_static(""));
        assert_eq!(policy.reject(&Method::POST, &headers), None);
        assert_eq!(
            cors_origin(headers.get(header::ORIGIN)),
            CorsOrigin::Allowed
        );
    }

    #[test]
    fn cors_headers_match_the_dynamic_fastify_policy() {
        let origin = HeaderValue::from_static("chrome-extension://fixture");
        let requested_headers = HeaderValue::from_static("authorization, x-client-id");
        let mut response = StatusCode::NO_CONTENT.into_response();
        apply_cors_headers(
            &mut response,
            Some(&origin),
            CorsOrigin::Allowed,
            true,
            Some(&requested_headers),
        );
        let headers = response.headers();
        assert_eq!(
            headers.get(header::ACCESS_CONTROL_ALLOW_ORIGIN),
            Some(&origin)
        );
        assert_eq!(
            headers.get(header::ACCESS_CONTROL_ALLOW_CREDENTIALS),
            Some(&HeaderValue::from_static("true"))
        );
        assert_eq!(
            headers.get(header::ACCESS_CONTROL_ALLOW_METHODS),
            Some(&HeaderValue::from_static("GET, POST, DELETE, OPTIONS"))
        );
        assert_eq!(
            headers.get(header::VARY),
            Some(&HeaderValue::from_static(
                "Origin, Access-Control-Request-Headers"
            ))
        );

        let mut denied = StatusCode::OK.into_response();
        apply_cors_headers(&mut denied, None, CorsOrigin::Denied, false, None);
        assert_eq!(
            denied.headers().get(header::VARY),
            Some(&HeaderValue::from_static("Origin"))
        );
        assert!(
            denied
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_CREDENTIALS)
                .is_none()
        );
    }

    #[test]
    fn safe_method_is_not_rejected_by_mutation_policy() {
        let policy = SecurityPolicy::new(Some("secret"));
        assert_eq!(policy.reject(&Method::GET, &HeaderMap::new()), None);
        assert_eq!(policy.reject(&Method::OPTIONS, &HeaderMap::new()), None);
    }
}
