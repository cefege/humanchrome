//! OpenAPI document generated from the same live tool catalog as REST dispatch.

use serde_json::{Map, Value, json};

/// Generate the REST description from tool descriptors, including dynamic tools.
/// Later duplicate names replace earlier operations, matching JavaScript objects.
#[must_use]
pub fn build(tools: &[Value]) -> Value {
    let mut paths = Map::with_capacity(tools.len());
    for tool in tools {
        let Some(name) = tool.get("name").and_then(Value::as_str) else {
            continue;
        };
        let description = tool
            .get("description")
            .filter(|value| value.as_str().is_some_and(|text| !text.is_empty()))
            .cloned()
            .unwrap_or_else(|| Value::String(name.to_owned()));
        let schema = tool
            .get("inputSchema")
            .filter(|value| !value.is_null())
            .cloned()
            .unwrap_or_else(|| json!({"type":"object"}));
        paths.insert(format!("/api/tools/{name}"), json!({
            "post": {
                "operationId": name,
                "summary": description,
                "tags": ["tools"],
                "parameters": [{
                    "name": "X-Client-Id", "in": "header", "required": false,
                    "schema": {"type": "string"},
                    "description": "Optional stable identifier to keep preferred-tab state across calls."
                }],
                "requestBody": {"required": false, "content": {"application/json": {"schema": {
                    "type": "object", "properties": {"args": schema}
                }}}},
                "responses": {"200": {"description": "Tool result (MCP CallToolResult shape).", "content": {
                    "application/json": {"schema": {"type": "object", "properties": {
                        "content": {"type": "array", "items": {"type": "object"}}, "isError": {"type": "boolean"}
                    }}}
                }}}
            }
        }));
    }
    json!({
        "openapi": "3.1.0",
        "info": {
            "title": "humanchrome REST API",
            "version": "1.0.0",
            "description": "Plain HTTP surface over the same Chrome browser tools the MCP transport exposes. Each operation forwards to the extension over native messaging and returns an MCP CallToolResult — `content` is an array of items (text, image, etc.) and `isError` is `true` when the call failed."
        },
        "paths": paths
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn describes_input_result_and_client_identity() {
        let doc = build(&[
            json!({"name":"chrome_navigate","description":"Navigate.","inputSchema":{"type":"object","properties":{"url":{"type":"string"}}}}),
        ]);
        let post = &doc["paths"]["/api/tools/chrome_navigate"]["post"];
        assert_eq!(post["operationId"], "chrome_navigate");
        assert_eq!(post["parameters"][0]["name"], "X-Client-Id");
        assert_eq!(
            post["requestBody"]["content"]["application/json"]["schema"]["properties"]["args"]["properties"]
                ["url"]["type"],
            "string"
        );
        assert_eq!(
            post["responses"]["200"]["content"]["application/json"]["schema"]["properties"]["isError"]
                ["type"],
            "boolean"
        );
    }

    #[test]
    fn dynamic_duplicate_names_replace_the_prior_descriptor() {
        let doc = build(&[
            json!({"name":"flow.demo","description":"old"}),
            json!({"name":"flow.demo","description":"new"}),
        ]);
        assert_eq!(
            doc["paths"]["/api/tools/flow.demo"]["post"]["summary"],
            "new"
        );
    }
}
