//! Structured tracing stays off Native Messaging stdout and retains the existing redaction paths.

use chrono::{SecondsFormat, Utc};
use serde_json::{Map, Value};
use std::{
    cell::RefCell,
    error::Error,
    fmt,
    io::{self, Write},
};
use tracing::{
    Event, Subscriber,
    field::{Field, Visit},
    span::{Attributes, Id, Record},
};
use tracing_subscriber::{
    Layer,
    filter::LevelFilter,
    layer::{Context, SubscriberExt},
    registry::LookupSpan,
    util::SubscriberInitExt,
};

thread_local! { static BUFFER: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) }; }

/// Install once at executable startup, before spawning native effects.
///
/// `HUMANCHROME_LOG_LEVEL` takes precedence over the legacy `MCP_LOG_LEVEL`.
/// Chrome redirects stderr, so native-host records are newline-delimited JSON.
///
/// # Errors
/// Returns an error if another global tracing subscriber is already installed.
pub fn init() -> Result<(), tracing_subscriber::util::TryInitError> {
    let primary = std::env::var("HUMANCHROME_LOG_LEVEL").unwrap_or_default();
    let legacy = std::env::var("MCP_LOG_LEVEL").unwrap_or_default();
    tracing_subscriber::registry()
        .with(NativeLogLayer)
        .with(resolve_level(&primary, &legacy))
        .try_init()
}

fn resolve_level(primary: &str, legacy: &str) -> LevelFilter {
    [primary, legacy]
        .into_iter()
        .find_map(|value| {
            match value
                .trim_matches(js_whitespace)
                .to_ascii_lowercase()
                .as_str()
            {
                "trace" => Some(LevelFilter::TRACE),
                "debug" => Some(LevelFilter::DEBUG),
                "info" => Some(LevelFilter::INFO),
                "warn" => Some(LevelFilter::WARN),
                "error" => Some(LevelFilter::ERROR),
                // tracing has no fatal level; like Pino's fatal threshold, suppress all lower levels.
                "fatal" => Some(LevelFilter::OFF),
                _ => None,
            }
        })
        .unwrap_or(LevelFilter::INFO)
}

fn js_whitespace(character: char) -> bool {
    matches!(character, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

#[derive(Debug)]
struct NativeLogLayer;
#[derive(Default)]
struct SpanFields(Map<String, Value>);

impl<S: Subscriber + for<'lookup> LookupSpan<'lookup>> Layer<S> for NativeLogLayer {
    fn on_new_span(&self, attributes: &Attributes<'_>, id: &Id, context: Context<'_, S>) {
        if let Some(span) = context.span(id) {
            let mut fields = SpanFields::default();
            attributes.record(&mut Fields(&mut fields.0));
            span.extensions_mut().insert(fields);
        }
    }

    fn on_record(&self, id: &Id, record: &Record<'_>, context: Context<'_, S>) {
        if let Some(span) = context.span(id) {
            let mut extensions = span.extensions_mut();
            if let Some(fields) = extensions.get_mut::<SpanFields>() {
                record.record(&mut Fields(&mut fields.0));
            }
        }
    }

    fn on_event(&self, event: &Event<'_>, context: Context<'_, S>) {
        let mut fields = Map::new();
        fields.insert(
            "level".into(),
            Value::String(event.metadata().level().as_str().to_ascii_lowercase()),
        );
        fields.insert(
            "time".into(),
            Value::String(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)),
        );
        fields.insert("pid".into(), Value::from(std::process::id()));
        fields.insert(
            "version".into(),
            Value::String(env!("CARGO_PKG_VERSION").into()),
        );
        if let Some(scope) = context.event_scope(event) {
            for span in scope.from_root() {
                if let Some(bound) = span.extensions().get::<SpanFields>() {
                    fields.extend(bound.0.clone());
                }
            }
        }
        event.record(&mut Fields(&mut fields));
        redact(&mut fields);
        BUFFER.with_borrow_mut(|buffer| {
            buffer.clear();
            if humanchrome_core::json::write(&mut *buffer, &Value::Object(fields)).is_ok() {
                buffer.push(b'\n');
                let _ = io::stderr().lock().write_all(buffer);
            }
        });
    }
}

struct Fields<'a>(&'a mut Map<String, Value>);
impl Fields<'_> {
    fn insert(&mut self, field: &Field, value: Value) {
        self.0.insert(
            if field.name() == "message" {
                "msg"
            } else {
                field.name()
            }
            .to_owned(),
            value,
        );
    }
}
impl Visit for Fields<'_> {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.insert(field, Value::String(value.into()));
    }
    fn record_i64(&mut self, field: &Field, value: i64) {
        self.insert(field, Value::from(value));
    }
    fn record_u64(&mut self, field: &Field, value: u64) {
        self.insert(field, Value::from(value));
    }
    fn record_bool(&mut self, field: &Field, value: bool) {
        self.insert(field, Value::Bool(value));
    }
    fn record_f64(&mut self, field: &Field, value: f64) {
        self.insert(field, Value::from(value));
    }
    fn record_error(&mut self, field: &Field, value: &(dyn Error + 'static)) {
        self.insert(field, Value::String(value.to_string()));
    }
    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        let text = format!("{value:?}");
        // Display-formatted JSON fields retain their structure for the same shallow
        // redaction applied to structured Pino records. Ordinary messages remain text.
        let value = if matches!(text.as_bytes().first(), Some(b'{' | b'[')) {
            serde_json::from_str(&text).unwrap_or_else(|_| Value::String(text))
        } else {
            Value::String(text)
        };
        self.insert(field, value);
    }
}

fn redact(fields: &mut Map<String, Value>) {
    const COMMON: [&str; 6] = [
        "password",
        "token",
        "authorization",
        "cookie",
        "apiKey",
        "Authorization",
    ];
    for key in COMMON.into_iter().chain(["set-cookie"]) {
        if let Some(value) = fields.get_mut(key) {
            *value = Value::String("[REDACTED]".into());
        }
    }
    for (key, value) in fields {
        if let Value::Object(object) = value {
            for field in COMMON {
                if let Some(value) = object.get_mut(field) {
                    *value = Value::String("[REDACTED]".into());
                }
            }
            if key == "headers"
                && let Some(value) = object.get_mut("set-cookie")
            {
                *value = Value::String("[REDACTED]".into());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{redact, resolve_level};
    use serde_json::json;
    use tracing_subscriber::filter::LevelFilter;

    #[test]
    fn credentials_follow_existing_shallow_paths_without_masking_public_context() {
        let mut fields = json!({"token":"root-secret","requestId":"correlated","headers":{"Authorization":"bearer-secret","cookie":"session-secret","set-cookie":"response-secret","accept":"application/json"},"query":{"password":"password-secret","apiKey":"api-secret","public":"kept","deeper":{"token":"existing-policy-does-not-recurse"}},"other":{"set-cookie":"not-a-current-wildcard-path"}}).as_object().expect("object").clone();
        redact(&mut fields);
        assert_eq!(fields["token"], "[REDACTED]");
        assert_eq!(
            fields["headers"],
            json!({"Authorization":"[REDACTED]","cookie":"[REDACTED]","set-cookie":"[REDACTED]","accept":"application/json"})
        );
        assert_eq!(
            fields["query"],
            json!({"password":"[REDACTED]","apiKey":"[REDACTED]","public":"kept","deeper":{"token":"existing-policy-does-not-recurse"}})
        );
        assert_eq!(fields["requestId"], "correlated");
        assert_eq!(fields["other"]["set-cookie"], "not-a-current-wildcard-path");
    }

    #[test]
    fn invalid_primary_defers_to_legacy_and_fatal_does_not_enable_error() {
        assert_eq!(resolve_level(" DEBUG ", "error"), LevelFilter::DEBUG);
        assert_eq!(resolve_level("invalid", "warn"), LevelFilter::WARN);
        assert_eq!(
            resolve_level("\u{85}debug\u{85}", "trace"),
            LevelFilter::TRACE
        );
        assert_eq!(resolve_level("fatal", "debug"), LevelFilter::OFF);
    }
}
