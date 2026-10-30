//! WASM bindings for legacy record/replay policy while JavaScript retains effects and intrinsics.

use humanchrome_core::replay_policy::{self, ConditionHost};
use js_sys::{Array, Object, Reflect};
use serde::Deserialize;
use serde_json::{Map, Value};
use wasm_bindgen::{JsCast, prelude::*};

use crate::{encode_serializable, error};

#[wasm_bindgen]
extern "C" {
    type BrowserString;
    #[wasm_bindgen(js_name = String)]
    fn javascript_string(value: &JsValue) -> BrowserString;
    #[wasm_bindgen(method, js_name = toLowerCase)]
    fn js_to_lower_case(this: &BrowserString) -> BrowserString;
    #[wasm_bindgen(method, js_name = valueOf)]
    fn js_string_value(this: &BrowserString) -> JsValue;
    #[wasm_bindgen(method, js_name = concat)]
    fn js_concat(this: &BrowserString, value: &BrowserString) -> BrowserString;
    #[wasm_bindgen(method, js_name = trim)]
    fn js_trim(this: &BrowserString) -> BrowserString;
    #[wasm_bindgen(js_name = encodeURIComponent, catch)]
    fn js_encode_uri_component(value: &BrowserString) -> Result<BrowserString, JsValue>;
    #[wasm_bindgen(js_namespace = JSON, js_name = stringify, catch)]
    fn js_json_stringify(value: &JsValue) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(js_name = Number)]
    fn javascript_number(value: &JsValue) -> f64;
    #[wasm_bindgen(method, js_name = includes)]
    fn js_includes(this: &BrowserString, search: &BrowserString) -> bool;
    #[wasm_bindgen(method, js_name = startsWith)]
    fn js_starts_with(this: &BrowserString, prefix: &BrowserString) -> bool;
    #[wasm_bindgen(method, js_name = endsWith)]
    fn js_ends_with(this: &BrowserString, suffix: &BrowserString) -> bool;
    type BrowserRegExp;
    #[wasm_bindgen(catch, constructor, js_class = "RegExp")]
    fn new_regexp(pattern: &BrowserString) -> Result<BrowserRegExp, JsValue>;
    #[wasm_bindgen(method, js_name = test)]
    fn js_test(this: &BrowserRegExp, value: &BrowserString) -> bool;
}

struct BrowserLegacyResolver {
    values: Vec<JsValue>,
    variables: JsValue,
}

impl BrowserLegacyResolver {
    fn new(variables: JsValue) -> Self {
        Self {
            values: Vec::new(),
            variables,
        }
    }

    fn capture(&mut self, value: JsValue) -> usize {
        let index = self.values.len();
        self.values.push(value);
        index
    }

    fn field(value: &JsValue, key: &str) -> Option<JsValue> {
        Reflect::get(value, &JsValue::from_str(key)).ok()
    }

    fn has_field(value: &JsValue, key: &str) -> bool {
        Reflect::has(value, &JsValue::from_str(key)).unwrap_or(false)
    }

    fn is_record(value: &JsValue) -> bool {
        !value.is_null() && !value.is_undefined() && value.is_object()
    }

    fn default_index(&mut self, value: &JsValue) -> Option<usize> {
        Self::has_field(value, "default").then(|| {
            let value = Self::field(value, "default").unwrap_or(JsValue::UNDEFINED);
            self.capture(if value.is_null() || value.is_undefined() {
                JsValue::NULL
            } else {
                value
            })
        })
    }

    fn variable_path(value: &JsValue) -> Option<(String, Vec<replay_policy::VariablePathSegment>)> {
        if !Self::is_record(value) {
            return None;
        }
        let name = Self::field(value, "name")?
            .as_string()
            .filter(|name| !name.is_empty())?;
        let path = Self::field(value, "path")?;
        if path.is_undefined() {
            return Some((name, Vec::new()));
        }
        if !Array::is_array(&path) {
            return None;
        }
        let path = path.unchecked_into::<Array>();
        let mut decoded = Vec::with_capacity(path.length() as usize);
        for segment in path.iter() {
            if let Some(key) = segment.as_string() {
                decoded.push(replay_policy::VariablePathSegment::Key(key));
            } else {
                decoded.push(replay_policy::VariablePathSegment::Index(segment.as_f64()?));
            }
        }
        Some((name, decoded))
    }

    fn decode_resolvable(&mut self, value: JsValue) -> replay_policy::LegacyResolvable {
        let Some(kind) = Self::field(&value, "kind").and_then(|kind| kind.as_string()) else {
            return replay_policy::LegacyResolvable::Literal(self.capture(value));
        };
        if kind == "var"
            && let Some(reference) = Self::field(&value, "ref")
            && let Some((name, path)) = Self::variable_path(&reference)
        {
            let default = self.default_index(&value);
            return replay_policy::LegacyResolvable::Variable {
                name,
                path,
                default,
            };
        }
        if kind == "expr" && Self::has_field(&value, "expr") {
            let default = self.default_index(&value);
            return replay_policy::LegacyResolvable::Expression { default };
        }
        replay_policy::LegacyResolvable::Literal(self.capture(value))
    }

    fn decode_string_resolvable(
        &mut self,
        value: JsValue,
    ) -> replay_policy::LegacyStringResolvable {
        if value.is_string() {
            return replay_policy::LegacyStringResolvable::Literal(self.capture(value));
        }
        let Some(kind) = Self::field(&value, "kind").and_then(|kind| kind.as_string()) else {
            return replay_policy::LegacyStringResolvable::Unsupported;
        };
        if kind == "var"
            && let Some(reference) = Self::field(&value, "ref")
            && let Some((name, path)) = Self::variable_path(&reference)
        {
            return replay_policy::LegacyStringResolvable::Variable {
                name,
                path,
                default: self.default_index(&value),
            };
        }
        if kind == "expr" && Self::has_field(&value, "expr") {
            return replay_policy::LegacyStringResolvable::Expression {
                default: self.default_index(&value),
            };
        }
        if kind == "template" {
            let Some(parts) = Self::field(&value, "parts").filter(Array::is_array) else {
                return replay_policy::LegacyStringResolvable::Unsupported;
            };
            let parts = parts.unchecked_into::<Array>();
            if parts.length() == 0 {
                return replay_policy::LegacyStringResolvable::Unsupported;
            }
            let parts = parts
                .iter()
                .map(|part| {
                    let Some(part_kind) = Self::field(&part, "kind") else {
                        return replay_policy::LegacyTemplatePart::Invalid;
                    };
                    match part_kind.as_string().as_deref() {
                        Some("text") => Self::field(&part, "value")
                            .filter(JsValue::is_string)
                            .map(|text| replay_policy::LegacyTemplatePart::Text(self.capture(text)))
                            .unwrap_or(replay_policy::LegacyTemplatePart::InvalidText),
                        Some("insert") => {
                            let value = Self::field(&part, "value")
                                .map(|value| self.decode_resolvable(value))
                                .unwrap_or_else(|| self.decode_resolvable(JsValue::UNDEFINED));
                            let format = match Self::field(&part, "format")
                                .and_then(|format| format.as_string())
                                .as_deref()
                            {
                                Some("json") => replay_policy::LegacyTemplateFormat::Json,
                                Some("urlEncoded") => {
                                    replay_policy::LegacyTemplateFormat::UrlEncoded
                                }
                                _ => replay_policy::LegacyTemplateFormat::Text,
                            };
                            replay_policy::LegacyTemplatePart::Insert { value, format }
                        }
                        _ => replay_policy::LegacyTemplatePart::Unknown(self.capture(part_kind)),
                    }
                })
                .collect();
            return replay_policy::LegacyStringResolvable::Template(parts);
        }
        replay_policy::LegacyStringResolvable::Unsupported
    }

    fn decode_number_resolvable(
        &mut self,
        value: JsValue,
    ) -> replay_policy::LegacyNumberResolvable {
        let Some(kind) = Self::field(&value, "kind").and_then(|kind| kind.as_string()) else {
            return replay_policy::LegacyNumberResolvable::Literal(self.capture(value));
        };
        if kind == "var"
            && let Some(reference) = Self::field(&value, "ref")
            && let Some((name, path)) = Self::variable_path(&reference)
        {
            return replay_policy::LegacyNumberResolvable::Variable {
                name,
                path,
                default: self.default_index(&value),
            };
        }
        if kind == "expr" && Self::has_field(&value, "expr") {
            return replay_policy::LegacyNumberResolvable::Expression {
                default: self.default_index(&value),
            };
        }
        replay_policy::LegacyNumberResolvable::Unsupported
    }

    fn decode_compare_op(value: &str) -> Option<replay_policy::CompareOp> {
        Some(match value {
            "eq" => replay_policy::CompareOp::Eq,
            "eqi" => replay_policy::CompareOp::Eqi,
            "neq" => replay_policy::CompareOp::Neq,
            "gt" => replay_policy::CompareOp::Gt,
            "gte" => replay_policy::CompareOp::Gte,
            "lt" => replay_policy::CompareOp::Lt,
            "lte" => replay_policy::CompareOp::Lte,
            "contains" => replay_policy::CompareOp::Contains,
            "containsI" => replay_policy::CompareOp::ContainsI,
            "notContains" => replay_policy::CompareOp::NotContains,
            "notContainsI" => replay_policy::CompareOp::NotContainsI,
            "startsWith" => replay_policy::CompareOp::StartsWith,
            "endsWith" => replay_policy::CompareOp::EndsWith,
            "regex" => replay_policy::CompareOp::Regex,
            _ => return None,
        })
    }

    fn decode_condition(&mut self, value: &JsValue) -> Option<replay_policy::Condition> {
        let kind = Self::field(value, "kind")?.as_string()?;
        match kind.as_str() {
            "expr" => Some(replay_policy::Condition::Expr),
            "compare" => Some(replay_policy::Condition::Compare {
                left: self.capture(Self::field(value, "left").unwrap_or(JsValue::UNDEFINED)),
                op: Self::decode_compare_op(&Self::field(value, "op")?.as_string()?)?,
                right: self.capture(Self::field(value, "right").unwrap_or(JsValue::UNDEFINED)),
            }),
            "truthy" => Some(replay_policy::Condition::Truthy {
                value: self.capture(Self::field(value, "value").unwrap_or(JsValue::UNDEFINED)),
            }),
            "falsy" => Some(replay_policy::Condition::Falsy {
                value: self.capture(Self::field(value, "value").unwrap_or(JsValue::UNDEFINED)),
            }),
            "not" => Some(replay_policy::Condition::Not {
                condition: Box::new(self.decode_condition(&Self::field(value, "condition")?)?),
            }),
            "and" | "or" => {
                let conditions = Self::field(value, "conditions")?;
                if !Array::is_array(&conditions) {
                    return None;
                }
                let conditions = conditions
                    .unchecked_into::<Array>()
                    .iter()
                    .map(|condition| self.decode_condition(&condition))
                    .collect::<Option<Vec<_>>>()?;
                if kind == "and" {
                    Some(replay_policy::Condition::And { conditions })
                } else {
                    Some(replay_policy::Condition::Or { conditions })
                }
            }
            _ => None,
        }
    }
}

impl replay_policy::LegacyResolverHost for BrowserLegacyResolver {
    type Value = JsValue;

    fn input(&self, index: usize) -> Self::Value {
        self.values[index].clone()
    }

    fn variable(&self, name: &str) -> Option<Self::Value> {
        let value = Reflect::get(&self.variables, &JsValue::from_str(name)).ok()?;
        (!value.is_undefined()).then_some(value)
    }

    fn read_path(
        &self,
        value: &Self::Value,
        path: &[replay_policy::VariablePathSegment],
    ) -> Option<Self::Value> {
        let mut current = value.clone();
        for segment in path {
            match segment {
                replay_policy::VariablePathSegment::Index(index) => {
                    if !Array::is_array(&current) {
                        return None;
                    }
                    current = Reflect::get(&current, &JsValue::from_f64(*index)).ok()?;
                }
                replay_policy::VariablePathSegment::Key(key) => {
                    if !Self::is_record(&current) {
                        return None;
                    }
                    current = Reflect::get(&current, &JsValue::from_str(key)).ok()?;
                }
            }
            if current.is_undefined() {
                return None;
            }
        }
        Some(current)
    }

    fn null(&self) -> Self::Value {
        JsValue::NULL
    }
}

impl replay_policy::LegacyStringResolverHost for BrowserLegacyResolver {
    type String = JsValue;
    type Error = JsValue;

    fn input_is_string(&self, index: usize) -> bool {
        self.values[index].is_string()
    }

    fn input_string(&self, index: usize) -> Self::String {
        self.values[index].clone()
    }

    fn empty_string(&self) -> Self::String {
        JsValue::from_str("")
    }

    fn is_null(&self, value: &Self::Value) -> bool {
        value.is_null()
    }

    fn string(&self, value: &Self::Value) -> Self::String {
        javascript_string(value).js_string_value()
    }

    fn json_stringify(&self, value: &Self::Value) -> Result<Self::String, Self::Error> {
        js_json_stringify(value).map(|value| self.string(&value))
    }

    fn append(&self, output: &mut Self::String, value: &Self::String) {
        *output = javascript_string(output)
            .js_concat(&javascript_string(value))
            .js_string_value();
    }

    fn encode_uri_component(&self, value: &Self::String) -> Result<Self::String, Self::Error> {
        js_encode_uri_component(&javascript_string(value)).map(|value| value.js_string_value())
    }

    fn string_for_error(&self, value: &Self::String) -> String {
        javascript_string(value)
            .js_string_value()
            .as_string()
            .unwrap_or_default()
    }
}

impl replay_policy::LegacyNumberResolverHost for BrowserLegacyResolver {
    fn finite_number(&self, value: &Self::Value) -> Option<f64> {
        value.as_f64().filter(|number| number.is_finite())
    }

    fn string_is_nonempty_after_trim(&self, value: &Self::Value) -> bool {
        value.is_string()
            && !javascript_string(value)
                .js_trim()
                .js_string_value()
                .as_string()
                .unwrap_or_default()
                .is_empty()
    }

    fn number_from_string(&self, value: &Self::Value) -> f64 {
        javascript_number(value)
    }
}

impl ConditionHost for BrowserLegacyResolver {
    type Value = JsValue;

    fn resolve(&mut self, value: usize) -> Option<Self::Value> {
        let value = self.values.get(value)?.clone();
        let resolvable = self.decode_resolvable(value);
        replay_policy::resolve_legacy_json(&resolvable, self).ok()
    }

    fn is_truthy(&self, value: &Self::Value) -> bool {
        value.is_truthy()
    }

    fn strict_equal(&self, left: &Self::Value, right: &Self::Value) -> bool {
        left == right
    }

    fn number(&self, value: &Self::Value) -> f64 {
        javascript_number(value)
    }

    fn string_equal_insensitive(&self, left: &Self::Value, right: &Self::Value) -> bool {
        javascript_string(left).js_to_lower_case().js_string_value()
            == javascript_string(right)
                .js_to_lower_case()
                .js_string_value()
    }

    fn string_contains(&self, left: &Self::Value, right: &Self::Value, insensitive: bool) -> bool {
        let left = javascript_string(left);
        let right = javascript_string(right);
        if insensitive {
            left.js_to_lower_case()
                .js_includes(&right.js_to_lower_case())
        } else {
            left.js_includes(&right)
        }
    }

    fn string_starts_with(&self, left: &Self::Value, right: &Self::Value) -> bool {
        javascript_string(left).js_starts_with(&javascript_string(right))
    }

    fn string_ends_with(&self, left: &Self::Value, right: &Self::Value) -> bool {
        javascript_string(left).js_ends_with(&javascript_string(right))
    }

    fn regex_matches(&self, left: &Self::Value, right: &Self::Value) -> bool {
        BrowserRegExp::new_regexp(&javascript_string(right))
            .map(|regex| regex.js_test(&javascript_string(left)))
            .unwrap_or(false)
    }
}

fn resolution_result(result: Result<JsValue, &str>) -> Result<JsValue, JsValue> {
    let output = Object::new();
    let (key, value, ok) = match result {
        Ok(value) => ("value", value, true),
        Err(message) => ("error", JsValue::from_str(message), false),
    };
    Reflect::set(&output, &JsValue::from_str("ok"), &JsValue::from_bool(ok))?;
    Reflect::set(&output, &JsValue::from_str(key), &value)?;
    Ok(output.into())
}

/// Resolves one legacy value while retaining raw JavaScript object identity.
#[wasm_bindgen]
pub fn replay_resolve_json(value: JsValue, variables: JsValue) -> Result<JsValue, JsValue> {
    let mut host = BrowserLegacyResolver::new(variables);
    let resolvable = host.decode_resolvable(value);
    resolution_result(replay_policy::resolve_legacy_json(&resolvable, &host))
}

pub(crate) fn resolve_legacy_string(
    value: JsValue,
    variables: JsValue,
) -> Result<JsValue, replay_policy::LegacyStringResolutionError<JsValue>> {
    let mut host = BrowserLegacyResolver::new(variables);
    let resolvable = host.decode_string_resolvable(value);
    replay_policy::resolve_legacy_string(&resolvable, &host)
}

/// Resolves a string, returning policy failures and propagating native intrinsic exceptions.
#[wasm_bindgen]
pub fn replay_resolve_string(value: JsValue, variables: JsValue) -> Result<JsValue, JsValue> {
    match resolve_legacy_string(value, variables) {
        Ok(value) => resolution_result(Ok(value)),
        Err(replay_policy::LegacyStringResolutionError::Policy(message)) => {
            resolution_result(Err(&message))
        }
        Err(replay_policy::LegacyStringResolutionError::Intrinsic(exception)) => Err(exception),
    }
}

/// Resolves one finite legacy number with JavaScript trim and Number coercion.
#[wasm_bindgen]
pub fn replay_resolve_number(value: JsValue, variables: JsValue) -> Result<JsValue, JsValue> {
    let mut host = BrowserLegacyResolver::new(variables);
    let resolvable = host.decode_number_resolvable(value);
    let result = replay_policy::resolve_legacy_number(&resolvable, &host);
    resolution_result(
        result
            .as_ref()
            .map(|value| JsValue::from_f64(*value))
            .map_err(String::as_str),
    )
}

/// Evaluates a legacy condition through the Rust-owned resolver and narrow JavaScript intrinsics.
#[wasm_bindgen]
pub fn replay_evaluate_condition(condition: JsValue, variables: JsValue) -> bool {
    let mut host = BrowserLegacyResolver::new(variables);
    host.decode_condition(&condition)
        .is_some_and(|condition| replay_policy::evaluate_condition(&condition, &mut host))
}

/// Maps a V2 error code to the V3 compatibility code without rebuilding its error envelope.
#[wasm_bindgen]
pub fn replay_v2_error_code(code: String) -> String {
    String::from(replay_policy::map_v2_error_code(&code))
}

/// Projects V3 policy fields to the V2 handler shape before JavaScript invokes the handler.
#[wasm_bindgen]
pub fn replay_v2_action_policy(policy_json: String) -> Result<String, JsValue> {
    let policy: Option<Value> = parse(&policy_json)?;
    encode_serializable(&replay_policy::v2_action_policy(policy.as_ref()))
}

/// Produces all ordered V3 variable-patch operations after one V2 action result.
#[wasm_bindgen]
pub fn replay_v2_adapter_result_plan(
    before_json: String,
    after_json: String,
) -> Result<String, JsValue> {
    let before: Map<String, Value> = parse(&before_json)?;
    let after: Map<String, Value> = parse(&after_json)?;
    encode_serializable(&replay_policy::diff_vars(&before, &after))
}

/// Plans variable upserts using native SameValueZero key identity, retaining opaque values in JS.
#[wasm_bindgen]
pub fn replay_recording_variable_append_plan(
    existing: js_sys::Array,
    incoming: js_sys::Array,
) -> Result<JsValue, JsValue> {
    let identities = js_sys::Map::new();
    let mut next = 0_u32;
    let mut keys = |values: js_sys::Array| {
        values
            .iter()
            .map(|value| {
                if !value.is_truthy() {
                    return None;
                }
                let previous = identities.get(&value);
                if let Some(id) = previous.as_f64() {
                    return Some(id as u32);
                }
                let id = next;
                next += 1;
                identities.set(&value, &JsValue::from_f64(f64::from(id)));
                Some(id)
            })
            .collect::<Vec<_>>()
    };
    let existing = keys(existing);
    let incoming = keys(incoming);
    serde_wasm_bindgen::to_value(&replay_policy::recording_variable_append_plan(
        &existing, &incoming,
    ))
    .map_err(error)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForeachInput {
    #[serde(default)]
    list_var: Value,
    #[serde(default)]
    item_var: Value,
    #[serde(default)]
    subflow_id: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WhileInput {
    has_condition: bool,
    #[serde(default)]
    subflow_id: Value,
}
fn optional_string(value: &Value) -> Option<&str> {
    value.as_str()
}

fn parse<T: for<'de> Deserialize<'de>>(text: &str) -> Result<T, JsValue> {
    serde_json::from_str(text).map_err(error)
}

#[derive(Deserialize)]
struct RecordingNodeInput {
    id: String,
}

#[derive(Deserialize)]
struct RecordingEdgeInput {
    to: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordingStepInput {
    id: String,
    #[serde(rename = "type")]
    step_type: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordingAppendInput {
    nodes: Vec<RecordingNodeInput>,
    edges: Vec<RecordingEdgeInput>,
    cache: Vec<(String, usize)>,
    edge_seq: usize,
    steps: Vec<RecordingStepInput>,
}

/// Returns the execution-mode action sets owned by the Rust policy module.
#[wasm_bindgen]
pub fn replay_execution_mode_sets() -> Result<String, JsValue> {
    encode_serializable(&replay_policy::execution_mode_sets())
}

/// Routes a legacy record/replay step to actions or the legacy executor.
#[wasm_bindgen]
pub fn replay_should_use_actions(
    mode: String,
    step_type: String,
    legacy_only_json: String,
    actions_allowlist_json: String,
) -> Result<bool, JsValue> {
    let legacy_only: Option<Vec<String>> = parse(&legacy_only_json)?;
    let actions_allowlist: Option<Vec<String>> = parse(&actions_allowlist_json)?;
    Ok(replay_policy::should_use_actions(
        &mode,
        &step_type,
        legacy_only.as_deref(),
        actions_allowlist.as_deref(),
    ))
}

/// Applies the historical retry exhaustion comparison to host-coerced values.
#[wasm_bindgen]
pub fn replay_retry_exhausted(attempt: f64, max: f64) -> bool {
    replay_policy::retry_exhausted(attempt, max)
}

/// Computes one effect-free legacy retry delay after the host coerces numeric inputs.
#[wasm_bindgen]
pub fn replay_retry_delay_ms(base: f64, backoff: String, attempt: f64) -> f64 {
    replay_policy::retry_delay_ms(base, &backoff, attempt)
}

/// Computes ActionRegistry's total attempt count without scheduling retries.
#[wasm_bindgen]
pub fn replay_action_max_attempts(retries: f64) -> f64 {
    replay_policy::action_max_attempts(retries)
}

/// Normalizes a supplied ActionRegistry timeout without creating timers.
#[wasm_bindgen]
pub fn replay_timeout_ms(value: f64) -> f64 {
    replay_policy::timeout_ms(value)
}

/// Tests whether ActionRegistry may retry a result without inspecting its opaque payload.
#[wasm_bindgen]
pub fn replay_should_retry_action(
    has_policy: bool,
    retries: f64,
    error_code: Option<String>,
    retry_on_json: String,
) -> Result<bool, JsValue> {
    let retry_on: Option<Vec<String>> = parse(&retry_on_json)?;
    Ok(replay_policy::should_retry_action(
        has_policy,
        retries,
        error_code.as_deref(),
        retry_on.as_deref(),
    ))
}

/// Returns the exact bounded foreach control declaration without executing subflows.
#[wasm_bindgen]
pub fn replay_foreach_plan(input_json: String, concurrency: f64) -> Result<String, JsValue> {
    let input: ForeachInput = parse(&input_json)?;
    let plan = replay_policy::foreach_plan(
        optional_string(&input.list_var),
        optional_string(&input.item_var),
        optional_string(&input.subflow_id),
        concurrency,
    )
    .map_err(error)?;
    match plan {
        replay_policy::ControlPlan::Foreach {
            list_var,
            item_var,
            subflow_id,
            ..
        } => serde_json::to_string(&serde_json::json!({
            "kind": "foreach",
            "listVar": list_var,
            "itemVar": item_var,
            "subflowId": subflow_id,
        }))
        .map_err(error),
        replay_policy::ControlPlan::While { .. } => {
            Err(error("foreach policy returned while plan"))
        }
    }
}

/// Clamps a foreach worker count while retaining JavaScript NaN and infinity values.
#[wasm_bindgen]
pub fn replay_foreach_concurrency(value: f64) -> f64 {
    replay_policy::foreach_concurrency(value)
}

/// Returns the exact bounded while control declaration without evaluating its expression.
#[wasm_bindgen]
pub fn replay_while_plan(input_json: String, max_iterations: f64) -> Result<String, JsValue> {
    let input: WhileInput = parse(&input_json)?;
    let plan = replay_policy::while_plan(
        input.has_condition,
        optional_string(&input.subflow_id),
        max_iterations,
    )
    .map_err(error)?;
    match plan {
        replay_policy::ControlPlan::While { subflow_id, .. } => {
            serde_json::to_string(&serde_json::json!({
                "kind": "while",
                "subflowId": subflow_id,
            }))
            .map_err(error)
        }
        replay_policy::ControlPlan::Foreach { .. } => {
            Err(error("while policy returned foreach plan"))
        }
    }
}

/// Clamps a while iteration bound while retaining JavaScript NaN and infinity values.
#[wasm_bindgen]
pub fn replay_while_max_iterations(value: f64) -> f64 {
    replay_policy::while_max_iterations(value)
}

/// Selects a branch label after JavaScript evaluates user-authored expressions.
#[wasm_bindgen]
pub fn replay_if_branch_label(
    labels_json: String,
    matching_index_json: String,
    has_else: bool,
    else_label: String,
) -> Result<String, JsValue> {
    let labels: Vec<String> = parse(&labels_json)?;
    let matching_index: Option<usize> = parse(&matching_index_json)?;
    Ok(replay_policy::if_branch_label(
        &labels,
        matching_index,
        has_else,
        &else_label,
    ))
}

/// Validates an if declaration before host-owned condition evaluation.
#[wasm_bindgen]
pub fn replay_validate_if(has_branches: bool, has_condition: bool) -> Option<String> {
    replay_policy::validate_if(has_branches, has_condition).map(String::from)
}

/// Plans sequential DAG mutation for one recorded event without copying its opaque config.
#[wasm_bindgen]
pub fn replay_recorded_step_append_plan(
    previous_node_id: Option<String>,
    edge_count: usize,
    step_id: String,
) -> Result<String, JsValue> {
    encode_serializable(&replay_policy::recorded_step_append_plan(
        previous_node_id.as_deref(),
        edge_count,
        &step_id,
    ))
}

/// Rebuilds recording-session cache indexes without crossing opaque node config values.
#[wasm_bindgen]
pub fn replay_recording_cache_plan(nodes_json: String, edge_seq: usize) -> Result<String, JsValue> {
    let nodes: Vec<RecordingNodeInput> = parse(&nodes_json)?;
    let projections = nodes
        .into_iter()
        .map(|node| replay_policy::RecordingNodeProjection { id: node.id })
        .collect::<Vec<_>>();
    encode_serializable(&replay_policy::recording_cache_plan(&projections, edge_seq))
}

/// Plans all recording-session upsert/rechain decisions while JavaScript retains config values.
#[wasm_bindgen]
pub fn replay_recording_append_plan(input_json: String) -> Result<String, JsValue> {
    let input: RecordingAppendInput = parse(&input_json)?;
    let nodes = input
        .nodes
        .into_iter()
        .map(|node| replay_policy::RecordingNodeProjection { id: node.id })
        .collect::<Vec<_>>();
    let edges = input
        .edges
        .into_iter()
        .map(|edge| replay_policy::RecordingEdgeProjection { to: edge.to })
        .collect::<Vec<_>>();
    let steps = input
        .steps
        .into_iter()
        .map(|step| replay_policy::RecordingStepProjection {
            id: step.id,
            step_type: step.step_type,
        })
        .collect::<Vec<_>>();
    encode_serializable(&replay_policy::recording_append_plan(
        &nodes,
        &edges,
        &input.cache,
        input.edge_seq,
        &steps,
    ))
}

/// Selects a recording node type while preserving JavaScript's warning side effect in the host.
#[wasm_bindgen]
pub fn replay_recording_node_type_plan(step_type: String) -> Result<String, JsValue> {
    encode_serializable(&replay_policy::recording_node_type_plan(&step_type))
}

/// Constructs the immutable initial recorded-flow fields; the host retains empty arrays by identity.
#[wasm_bindgen]
pub fn replay_initial_flow_plan(
    authored_meta_json: String,
    generated_id: String,
    timestamp: String,
) -> Result<String, JsValue> {
    let authored_meta: Value = parse(&authored_meta_json)?;
    encode_serializable(&replay_policy::initial_flow_plan(
        &authored_meta,
        &generated_id,
        &timestamp,
    ))
}
