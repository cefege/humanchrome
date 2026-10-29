//! Contract-backed tool catalog lookup, dispatcher metadata, and help ranking.

use std::borrow::Cow;
use std::cmp::Ordering;
use std::fmt::Write as _;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::arguments::{
    JsString, did_you_mean_lossless, did_you_mean_text, truncate_received_lossless,
};
use crate::errors::serialize_tool_error_with_lossless_message;
use crate::json_document::JsonDocument;

/// A tool descriptor used for catalog policy without an MCP runtime dependency.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolSchema {
    /// Canonical tool name.
    pub name: String,
    /// Human-readable tool description.
    pub description: String,
    /// Tool input schema as authored by the shared contract.
    #[serde(rename = "inputSchema")]
    pub input_schema: Value,
}

impl ToolSchema {
    /// Creates a custom tool descriptor for the APIs that accept caller-supplied tools.
    #[must_use]
    pub fn new(
        name: impl Into<String>,
        description: impl Into<String>,
        input_schema: Value,
    ) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            input_schema,
        }
    }
}

/// A ranked catalog result returned by [`Catalog::search`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ToolSearchHit {
    /// Canonical tool name.
    pub name: String,
    /// First sentence of the tool description.
    pub summary: String,
    /// Relevance score.
    pub score: i32,
}

/// Consolidated replacement for a sunset tool name.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SunsetReplacement {
    /// Canonical replacement tool name.
    pub name: String,
    /// Replacement action when the target consolidates several operations.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
}

/// Legacy name alias that rewrites a dispatch target and may add default arguments.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LegacyToolAlias {
    /// Canonical dispatch target.
    pub tool: String,
    /// Arguments merged before caller-supplied arguments, when supplied.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Value>,
}

/// The lazy dispatcher descriptor exposed by the MCP catalog.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct DispatcherTool<'a> {
    /// Stable dispatcher tool name.
    pub name: &'a str,
    /// Byte-stable default catalog description, or a descriptor built for custom tools.
    pub description: &'a str,
    /// Dispatcher argument schema.
    #[serde(rename = "inputSchema")]
    pub input_schema: &'a Value,
}

#[derive(Debug)]
struct ToolEntry {
    tool: ToolSchema,
    name_lower: String,
    description_lower: String,
    name_tokens: Vec<String>,
    summary: String,
}

impl From<ToolSchema> for ToolEntry {
    fn from(tool: ToolSchema) -> Self {
        Self {
            name_lower: tool.name.to_lowercase(),
            description_lower: tool.description.to_lowercase(),
            name_tokens: tokenize(&tool.name),
            summary: first_sentence(&tool.description),
            tool,
        }
    }
}

#[derive(Debug)]
struct CatalogMetadata {
    dispatcher_tool_name: &'static str,
    dispatcher_input_schema: &'static Value,
    sunset_replacements: &'static Map<String, Value>,
    legacy_tool_aliases: &'static Map<String, Value>,
    descriptor: &'static str,
}

/// Contract-derived catalog policy, optionally constructed with custom tool descriptors.
#[derive(Debug)]
pub struct Catalog {
    tools: Vec<ToolEntry>,
    sorted_indices: Vec<usize>,
    sorted_names: Vec<String>,
    help_index: Value,
    metadata: &'static CatalogMetadata,
    dispatcher_description: Cow<'static, str>,
}

impl Catalog {
    /// Returns the catalog embedded from the generated shared contract artifact.
    #[must_use]
    pub fn embedded() -> &'static Self {
        static CATALOG: LazyLock<Catalog> = LazyLock::new(Catalog::from_embedded_contract);
        &CATALOG
    }

    /// Creates a catalog using contract-owned dispatcher metadata and caller-supplied tools.
    #[must_use]
    pub fn with_tools(tools: Vec<ToolSchema>) -> Self {
        let mut catalog = Self::from_tools(tools, Cow::Borrowed(""));
        catalog.dispatcher_description = Cow::Owned(catalog.build_custom_dispatcher_description());
        catalog
    }

    /// Returns canonical tool names in the same stable order as the TypeScript catalog.
    #[must_use]
    pub fn known_tool_names(&self) -> Vec<String> {
        self.sorted_names.clone()
    }

    /// Borrows canonical tool names in their stable catalog order.
    #[must_use]
    pub fn known_tool_name_refs(&self) -> &[String] {
        &self.sorted_names
    }

    /// Reports whether a canonical name appears in this catalog.
    #[must_use]
    pub fn is_known_tool_name(&self, name: &str) -> bool {
        self.tool_by_name(name).is_some()
    }

    /// Resolves an exact or legacy unprefixed tool name, including dynamic extras.
    #[must_use]
    pub fn resolve_tool_name(&self, name: &Value, extras: &[String]) -> Option<String> {
        let name = name.as_str()?;
        if name.is_empty() {
            return None;
        }

        if self.is_known_tool_name(name) || extras.iter().any(|candidate| candidate == name) {
            return Some(name.to_owned());
        }

        for prefix in ["chrome_", "browser_"] {
            let candidate = format!("{prefix}{name}");
            if self.is_known_tool_name(&candidate) || extras.iter().any(|extra| extra == &candidate)
            {
                return Some(candidate);
            }
        }
        None
    }

    /// Returns an edit-distance suggestion for a static or dynamic tool name.
    #[must_use]
    pub fn suggest_tool_name(&self, received: &Value, extras: &[String]) -> Option<String> {
        let Value::String(received) = received else {
            return None;
        };
        did_you_mean_text(
            received,
            self.sorted_names
                .iter()
                .map(String::as_str)
                .chain(extras.iter().map(String::as_str)),
            3,
        )
    }

    /// Returns an edit-distance suggestion without replacing unpaired UTF-16 code units.
    #[must_use]
    pub fn suggest_tool_name_lossless(
        &self,
        received: &JsString,
        extras: &[&str],
    ) -> Option<String> {
        did_you_mean_lossless(
            received,
            self.sorted_names
                .iter()
                .map(String::as_str)
                .chain(extras.iter().copied()),
            3,
        )
    }

    /// Builds the lazy-dispatcher unknown-tool result without projecting a JavaScript name to UTF-8.
    #[must_use]
    pub fn unknown_tool_result(&self, received: &JsString, extras: &[&str]) -> Value {
        if let Some(replacement) = self.find_replacement_for_lossless_tool_name(received) {
            let args_hint = replacement
                .action
                .as_deref()
                .map(|action| format!("{{action:\"{action}\", ...}}"))
                .unwrap_or_else(|| "{...}".to_owned());
            let mut recovery = JsString::from("Call ");
            recovery.push_str(&replacement.name);
            recovery.push_str("(");
            recovery.push_str(&args_hint);
            recovery.push_str(") instead.");

            let mut message = JsString::from("Tool \"");
            message.push_js_string(received);
            message.push_str("\" was consolidated into ");
            message.push_str(&replacement.name);
            message.push_str(". ");
            message.push_js_string(&recovery);

            let hint = format!(
                "Use {}{}.",
                replacement.name,
                replacement
                    .action
                    .as_deref()
                    .map(|action| format!(" with action:\"{action}\""))
                    .unwrap_or_default()
            );
            return tool_name_invalid_args_result(
                &message,
                tool_name_invalid_args_details(
                    received,
                    extras.len() + self.sorted_names.len(),
                    recovery,
                    Some(replacement),
                    Some(hint),
                ),
            );
        }

        let suggestion = self.suggest_tool_name_lossless(received, extras);
        let seed = tool_search_seed(received);
        let mut recovery = JsString::from("Call chrome_help({query:\"");
        recovery.push_js_string(&seed);
        recovery.push_str("\"}) to search the catalog.");

        let mut message = JsString::from("Unknown tool: \"");
        message.push_js_string(received);
        message.push_str("\". ");
        if let Some(suggestion) = &suggestion {
            message.push_str("Did you mean \"");
            message.push_str(suggestion);
            message.push_str("\"? Or call chrome_help({query:\"");
            message.push_js_string(&seed);
            message.push_str("\"}) to search the catalog.");
        } else {
            message.push_js_string(&recovery);
        }

        tool_name_invalid_args_result(
            &message,
            tool_name_invalid_args_details(
                received,
                extras.len() + self.sorted_names.len(),
                recovery,
                None,
                suggestion.map(|name| format!("Did you mean \"{name}\"?")),
            ),
        )
    }

    /// Returns a sunset replacement, if the given value is a known sunset name.
    #[must_use]
    pub fn find_replacement_for_sunset_tool(&self, name: &Value) -> Option<SunsetReplacement> {
        self.sunset_replacement(name.as_str()?)
    }

    fn find_replacement_for_lossless_tool_name(
        &self,
        name: &JsString,
    ) -> Option<SunsetReplacement> {
        self.sunset_replacement(name.as_utf8()?)
    }

    fn sunset_replacement(&self, name: &str) -> Option<SunsetReplacement> {
        self.metadata
            .sunset_replacements
            .get(name)
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok())
    }

    /// Returns a fixed-argument legacy alias, if present.
    #[must_use]
    pub fn legacy_tool_alias(&self, name: &str) -> Option<LegacyToolAlias> {
        self.metadata
            .legacy_tool_aliases
            .get(name)
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok())
    }

    /// Borrows the lazy dispatcher descriptor for immediate serialization.
    #[must_use]
    pub fn dispatcher_tool(&self) -> DispatcherTool<'_> {
        DispatcherTool {
            name: self.metadata.dispatcher_tool_name,
            description: self.dispatcher_description(),
            input_schema: self.metadata.dispatcher_input_schema,
        }
    }

    /// Returns the lazy dispatcher description without copying its stored bytes.
    #[must_use]
    pub fn dispatcher_description(&self) -> &str {
        &self.dispatcher_description
    }

    /// Ranks catalog tools against a free-text query.
    #[must_use]
    pub fn search(&self, query: &str) -> Vec<ToolSearchHit> {
        if js_trim_is_empty(query) {
            return Vec::new();
        }

        let query_tokens: Vec<String> = tokenize(query)
            .into_iter()
            .filter(|token| utf16_len(token) >= 3)
            .collect();
        if query_tokens.is_empty() {
            return Vec::new();
        }

        let query_lower = query.to_lowercase();
        let query_utf16_len = utf16_len(&query_lower);
        let mut hits = Vec::new();

        for tool in &self.tools {
            let mut score = 0;

            if tool.name_lower.contains(&query_lower) {
                score += 50;
            } else if query_utf16_len >= 4 && tool.description_lower.contains(&query_lower) {
                score += 30;
            }

            for token in &query_tokens {
                if tool
                    .name_tokens
                    .iter()
                    .any(|name_token| name_token == token)
                {
                    score += 20;
                } else if tool.name_lower.contains(token) {
                    score += 8;
                }
                if tool.description_lower.contains(token) {
                    score += 3;
                }
            }

            if query_utf16_len <= 12 {
                let best_distance = tool
                    .name_tokens
                    .iter()
                    .map(|name_token| edit_distance_utf16(&query_lower, name_token))
                    .min();
                if let Some(best_distance) = best_distance.filter(|distance| *distance <= 2) {
                    score += (3 - best_distance) as i32 * 4;
                }
            }

            if score >= 8 {
                hits.push(ToolSearchHit {
                    name: tool.tool.name.clone(),
                    summary: tool.summary.clone(),
                    score,
                });
            }
        }

        hits.sort_by(|left, right| {
            right
                .score
                .cmp(&left.score)
                .then_with(|| compare_tool_names(&left.name, &right.name))
        });
        hits
    }

    /// Builds the JSON payload returned by `chrome_help`.
    #[must_use]
    pub fn build_tool_help(&self, arg: Option<&Value>) -> Value {
        let arg = arg.unwrap_or(&Value::Null);
        if let Some(name) = arg.as_str() {
            return self.help_for_name(name);
        }

        let Some(args) = arg.as_object() else {
            return self.help_index();
        };

        if let Some(query) = args.get("query").and_then(Value::as_str)
            && !js_trim_is_empty(query)
        {
            let limit = js_help_limit(args.get("limit"));
            let matches: Vec<Value> = self
                .search(query)
                .into_iter()
                .take(limit)
                .map(search_hit_json)
                .collect();
            return json!({ "query": query, "matches": matches });
        }

        if let Some(name) = args.get("name").and_then(Value::as_str)
            && !name.is_empty()
        {
            return self.help_for_name(name);
        }

        self.help_index()
    }

    fn help_for_name(&self, name: &str) -> Value {
        let Some(tool) = self.tool_by_name(name) else {
            return json!({ "name": name, "found": false });
        };
        json!({
            "name": tool.tool.name,
            "summary": tool.summary,
            "description": tool.tool.description,
        })
    }

    fn help_index(&self) -> Value {
        self.help_index.clone()
    }

    fn tool_by_name(&self, name: &str) -> Option<&ToolEntry> {
        let position = self.sorted_indices.partition_point(|index| {
            compare_tool_names(&self.tools[*index].tool.name, name).is_lt()
        });
        let index = *self.sorted_indices.get(position)?;
        (self.tools[index].tool.name == name).then_some(&self.tools[index])
    }

    fn from_embedded_contract() -> Self {
        let catalog = humanchrome_contracts::CONTRACT
            .get("catalog")
            .and_then(Value::as_object)
            .expect("generated contract must contain catalog object");
        let tools = catalog
            .get("toolSchemas")
            .and_then(Value::as_array)
            .expect("generated contract must contain catalog.toolSchemas array")
            .iter()
            .cloned()
            .map(|value| {
                serde_json::from_value(value)
                    .expect("generated catalog tool schemas must match ToolSchema")
            })
            .collect();
        Self::from_tools(tools, Cow::Borrowed(embedded_metadata().descriptor))
    }

    fn from_tools(schemas: Vec<ToolSchema>, dispatcher_description: Cow<'static, str>) -> Self {
        let tools: Vec<ToolEntry> = schemas.into_iter().map(ToolEntry::from).collect();
        let mut sorted_indices: Vec<usize> = (0..tools.len()).collect();
        sorted_indices.sort_by(|left, right| {
            compare_tool_names(&tools[*left].tool.name, &tools[*right].tool.name)
        });
        let sorted_names = sorted_indices
            .iter()
            .map(|index| tools[*index].tool.name.clone())
            .collect();
        let help_index = Value::Object(Map::from_iter([(
            "tools".to_owned(),
            Value::Array(
                sorted_indices
                    .iter()
                    .map(|index| {
                        let tool = &tools[*index];
                        json!({ "name": tool.tool.name, "summary": tool.summary })
                    })
                    .collect(),
            ),
        )]));

        Self {
            tools,
            sorted_indices,
            sorted_names,
            help_index,
            metadata: embedded_metadata(),
            dispatcher_description,
        }
    }

    fn build_custom_dispatcher_description(&self) -> String {
        let description = self.metadata.descriptor;
        let header_end = description
            .find("\nCatalog (")
            .expect("generated dispatcher descriptor must retain its Catalog header delimiter");
        let mut out = String::with_capacity(description.len() + self.sorted_names.len() * 24);
        out.push_str(&description[..header_end]);
        write!(out, "\nCatalog ({} tools):\n", self.sorted_names.len())
            .expect("writing to a String cannot fail");
        for (index, name) in self.sorted_names.iter().enumerate() {
            if index > 0 {
                out.push('\n');
            }
            out.push_str("- ");
            out.push_str(name);
        }
        out
    }
}

fn tool_name_invalid_args_result(message: &JsString, details: JsonDocument) -> Value {
    let text = serialize_tool_error_with_lossless_message("INVALID_ARGS", message, Some(&details));
    json!({"content": [{"type": "text", "text": text}], "isError": true})
}

fn tool_name_invalid_args_details(
    received: &JsString,
    catalog_size: usize,
    recovery: JsString,
    replacement: Option<SunsetReplacement>,
    hint: Option<String>,
) -> JsonDocument {
    let mut expected = vec![
        ("kind", JsonDocument::from("tool_name")),
        ("catalogSize", JsonDocument::from(json!(catalog_size))),
        ("recovery", JsonDocument::string(recovery)),
    ];
    if let Some(replacement) = replacement {
        let replacement = serde_json::to_value(replacement)
            .expect("sunset replacement only contains JSON values");
        expected.push(("replacement", JsonDocument::from(replacement)));
    }

    let mut details = vec![
        ("arg", JsonDocument::from("name")),
        (
            "received",
            truncate_received_lossless(received).into_json_document(),
        ),
        ("expected", JsonDocument::object(expected)),
    ];
    if let Some(hint) = hint {
        details.push(("hint", JsonDocument::from(hint)));
    }
    JsonDocument::object(details)
}

fn tool_search_seed(received: &JsString) -> JsString {
    let mut units = received.clone().into_utf16_units();
    for prefix in ["chrome_", "browser_"] {
        let prefix: Vec<u16> = prefix.encode_utf16().collect();
        if units.starts_with(&prefix) {
            units.drain(..prefix.len());
            break;
        }
    }
    for unit in &mut units {
        if *unit == u16::from(b'_') {
            *unit = u16::from(b' ');
        }
    }
    JsString::from_utf16_units(units)
}

fn search_hit_json(hit: ToolSearchHit) -> Value {
    json!({ "name": hit.name, "summary": hit.summary, "score": hit.score })
}

fn embedded_metadata() -> &'static CatalogMetadata {
    static METADATA: LazyLock<CatalogMetadata> = LazyLock::new(|| {
        let contract: &'static Value = &humanchrome_contracts::CONTRACT;
        let catalog = contract
            .get("catalog")
            .and_then(Value::as_object)
            .expect("generated contract must contain catalog object");
        let descriptor = contract
            .get("descriptor")
            .and_then(Value::as_object)
            .expect("generated contract must contain descriptor object");
        CatalogMetadata {
            dispatcher_tool_name: catalog
                .get("dispatcherToolName")
                .and_then(Value::as_str)
                .expect("generated contract must contain catalog.dispatcherToolName"),
            dispatcher_input_schema: catalog
                .get("dispatcherInputSchema")
                .expect("generated contract must contain catalog.dispatcherInputSchema"),
            sunset_replacements: catalog
                .get("sunsetReplacements")
                .and_then(Value::as_object)
                .expect("generated contract must contain catalog.sunsetReplacements"),
            legacy_tool_aliases: catalog
                .get("legacyToolAliases")
                .and_then(Value::as_object)
                .expect("generated contract must contain catalog.legacyToolAliases"),
            descriptor: descriptor
                .get("description")
                .and_then(Value::as_str)
                .expect("generated contract must contain descriptor.description"),
        }
    });
    &METADATA
}

fn first_sentence(description: &str) -> String {
    if description.is_empty() {
        return String::new();
    }

    let chars: Vec<char> = description.chars().collect();
    for (index, character) in chars.iter().enumerate() {
        if is_js_line_terminator(*character) {
            break;
        }
        if matches!(character, '.' | '!' | '?')
            && chars
                .get(index + 1)
                .is_none_or(|next| is_js_whitespace(*next))
        {
            return collapse_whitespace(chars[..=index].iter().collect::<String>().as_str());
        }
    }
    collapse_whitespace(description)
}

fn collapse_whitespace(value: &str) -> String {
    let mut collapsed = String::with_capacity(value.len());
    let mut pending_space = false;
    for character in value.chars() {
        if is_js_whitespace(character) {
            pending_space = !collapsed.is_empty();
        } else {
            if pending_space {
                collapsed.push(' ');
            }
            collapsed.push(character);
            pending_space = false;
        }
    }
    collapsed
}

fn is_js_line_terminator(character: char) -> bool {
    matches!(character, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

fn is_js_whitespace(character: char) -> bool {
    is_js_line_terminator(character)
        || matches!(
            character,
            '\u{0009}' | '\u{000B}' | '\u{000C}' | '\u{0020}' | '\u{00A0}' | '\u{1680}' | '\u{2000}'
                ..='\u{200A}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
        )
}

fn js_trim_is_empty(value: &str) -> bool {
    value.chars().all(is_js_whitespace)
}

fn tokenize(value: &str) -> Vec<String> {
    if value.is_empty() {
        return Vec::new();
    }

    let chars: Vec<char> = value.chars().collect();
    let mut camel_separated = String::with_capacity(value.len());
    for (index, character) in chars.iter().enumerate() {
        if index > 0
            && (chars[index - 1].is_ascii_lowercase() || chars[index - 1].is_ascii_digit())
            && character.is_ascii_uppercase()
        {
            camel_separated.push(' ');
        }
        camel_separated.push(*character);
    }

    let mut tokens = Vec::new();
    let mut token = String::new();
    for character in camel_separated.to_lowercase().chars() {
        if character.is_ascii_lowercase() || character.is_ascii_digit() {
            token.push(character);
        } else if !token.is_empty() {
            tokens.push(std::mem::take(&mut token));
        }
    }
    if !token.is_empty() {
        tokens.push(token);
    }
    tokens
}

fn edit_distance_utf16(left: &str, right: &str) -> usize {
    let left: Vec<u16> = left.encode_utf16().collect();
    let right: Vec<u16> = right.encode_utf16().collect();
    if left == right {
        return 0;
    }
    if left.is_empty() {
        return right.len();
    }
    if right.is_empty() {
        return left.len();
    }

    let mut previous: Vec<usize> = (0..=right.len()).collect();
    let mut current = vec![0; right.len() + 1];
    for (left_index, left_unit) in left.iter().enumerate() {
        current[0] = left_index + 1;
        for (right_index, right_unit) in right.iter().enumerate() {
            let substitution_cost = usize::from(left_unit != right_unit);
            current[right_index + 1] = (current[right_index] + 1)
                .min(previous[right_index + 1] + 1)
                .min(previous[right_index] + substitution_cost);
        }
        std::mem::swap(&mut previous, &mut current);
    }
    previous[right.len()]
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn compare_tool_names(left: &str, right: &str) -> Ordering {
    // Contract tool names and dynamically published flow slugs are restricted to ASCII.
    // For that contract domain, Unicode scalar ordering and the existing JS locale order agree.
    left.cmp(right)
}

fn js_help_limit(value: Option<&Value>) -> usize {
    let number = match value {
        None | Some(Value::Null) => 10.0,
        Some(value) => js_number(value),
    };
    if number.is_nan() {
        return 0;
    }
    number.clamp(1.0, 50.0).trunc() as usize
}

fn js_number(value: &Value) -> f64 {
    match value {
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::Bool(value) => f64::from(*value),
        Value::String(value) => {
            let trimmed = value.trim_matches(is_js_whitespace);
            if trimmed.is_empty() {
                0.0
            } else {
                trimmed.parse().unwrap_or(f64::NAN)
            }
        }
        Value::Null => 0.0,
        Value::Array(values) if values.is_empty() => 0.0,
        Value::Array(values) if values.len() == 1 => js_number(&values[0]),
        _ => f64::NAN,
    }
}
