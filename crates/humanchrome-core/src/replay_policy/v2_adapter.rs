//! V2-to-V3 compatibility decisions for the action-adapter effect host.

use serde::Serialize;
use serde_json::{Map, Value};

/// A serializable variable patch for the V3 event stream.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum VarsPatchOp {
    /// Replaces or adds one variable value.
    Set {
        /// The variable name.
        name: String,
        /// The JSON-compatible replacement value.
        value: Value,
    },
    /// Removes one variable.
    Delete {
        /// The variable name.
        name: String,
    },
}

/// Computes V3 patches after a V2 handler has mutated its isolated variable store.
#[must_use]
pub fn diff_vars(before: &Map<String, Value>, after: &Map<String, Value>) -> Vec<VarsPatchOp> {
    let mut patch = Vec::new();
    for (key, before_value) in before {
        match after.get(key) {
            None => patch.push(VarsPatchOp::Delete { name: key.clone() }),
            Some(after_value) if before_value != after_value => patch.push(VarsPatchOp::Set {
                name: key.clone(),
                value: after_value.clone(),
            }),
            Some(_) => {}
        }
    }
    for (key, value) in after {
        if !before.contains_key(key) {
            patch.push(VarsPatchOp::Set {
                name: key.clone(),
                value: value.clone(),
            });
        }
    }
    patch
}

/// Maps a V2 action error code to its V3-compatible error code.
#[must_use]
pub fn map_v2_error_code(code: &str) -> &'static str {
    match code {
        "VALIDATION_ERROR" => "VALIDATION_ERROR",
        "TIMEOUT" => "TIMEOUT",
        "TAB_NOT_FOUND" => "TAB_NOT_FOUND",
        "FRAME_NOT_FOUND" => "FRAME_NOT_FOUND",
        "TARGET_NOT_FOUND" => "TARGET_NOT_FOUND",
        "ELEMENT_NOT_VISIBLE" => "ELEMENT_NOT_VISIBLE",
        "NAVIGATION_FAILED" => "NAVIGATION_FAILED",
        "NETWORK_REQUEST_FAILED" => "NETWORK_REQUEST_FAILED",
        "SCRIPT_FAILED" => "SCRIPT_FAILED",
        "DOWNLOAD_FAILED" | "ASSERTION_FAILED" => "TOOL_ERROR",
        _ => "INTERNAL",
    }
}

/// Projects one V3 node policy onto the legacy V2 action policy shape.
#[must_use]
pub fn v2_action_policy(policy: Option<&Value>) -> Option<Value> {
    let policy = policy?.as_object()?;
    let mut projected = Map::new();

    if let Some(timeout) = policy.get("timeout").and_then(Value::as_object) {
        let mut v2_timeout = Map::new();
        if let Some(ms) = timeout.get("ms") {
            v2_timeout.insert(String::from("ms"), ms.clone());
        }
        let scope = match timeout.get("scope").and_then(Value::as_str) {
            Some("node") => "action",
            _ => "attempt",
        };
        v2_timeout.insert(String::from("scope"), Value::String(String::from(scope)));
        projected.insert(String::from("timeout"), Value::Object(v2_timeout));
    }
    for key in ["retry", "artifacts"] {
        if let Some(value) = policy.get(key) {
            projected.insert(String::from(key), value.clone());
        }
    }
    if let Some(on_error) = policy.get("onError").and_then(Value::as_object) {
        let action_error = match on_error.get("kind").and_then(Value::as_str) {
            Some("goto") => on_error
                .get("target")
                .and_then(Value::as_object)
                .filter(|target| target.get("kind").and_then(Value::as_str) == Some("edgeLabel"))
                .map(|target| {
                    let mut value = Map::new();
                    value.insert(String::from("kind"), Value::String(String::from("goto")));
                    if let Some(label) = target.get("label") {
                        value.insert(String::from("label"), label.clone());
                    }
                    Value::Object(value)
                })
                .unwrap_or_else(stop_policy),
            Some("continue") => {
                let mut value = Map::new();
                value.insert(
                    String::from("kind"),
                    Value::String(String::from("continue")),
                );
                if let Some(level) = on_error.get("as") {
                    value.insert(String::from("level"), level.clone());
                }
                Value::Object(value)
            }
            Some("retry") => stop_policy(),
            _ => Value::Object(on_error.clone()),
        };
        projected.insert(String::from("onError"), action_error);
    }

    Some(Value::Object(projected))
}

fn stop_policy() -> Value {
    Value::Object(Map::from_iter([(
        String::from("kind"),
        Value::String(String::from("stop")),
    )]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diff_preserves_before_keys_then_new_after_keys() {
        let before = serde_json::from_value::<Map<String, Value>>(serde_json::json!({
            "changed": 1,
            "removed": true,
            "unchanged": { "nested": [1] }
        }))
        .expect("record is valid");
        let after = serde_json::from_value::<Map<String, Value>>(serde_json::json!({
            "changed": 2,
            "unchanged": { "nested": [1] },
            "added": null
        }))
        .expect("record is valid");

        assert_eq!(
            diff_vars(&before, &after),
            vec![
                VarsPatchOp::Set {
                    name: String::from("changed"),
                    value: Value::from(2),
                },
                VarsPatchOp::Delete {
                    name: String::from("removed"),
                },
                VarsPatchOp::Set {
                    name: String::from("added"),
                    value: Value::Null,
                },
            ]
        );
    }

    #[test]
    fn policy_keeps_edge_labels_and_degrades_unrepresentable_transitions() {
        let edge = serde_json::json!({
            "onError": { "kind": "goto", "target": { "kind": "edgeLabel", "label": "retry" } }
        });
        assert_eq!(
            v2_action_policy(Some(&edge)),
            Some(serde_json::json!({ "onError": { "kind": "goto", "label": "retry" } }))
        );
        for policy in [
            serde_json::json!({ "onError": { "kind": "goto", "target": { "kind": "node", "nodeId": "next" } } }),
            serde_json::json!({ "onError": { "kind": "retry" } }),
        ] {
            assert_eq!(
                v2_action_policy(Some(&policy)),
                Some(serde_json::json!({ "onError": { "kind": "stop" } }))
            );
        }
    }
}
