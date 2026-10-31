//! Uninstalled JSON Lines fixture process over the actual native/core policy implementations.

use humanchrome_core::{
    arguments::{self, BuildInvalidArgsOptions, ReceivedValue},
    catalog::{Catalog, ToolSchema},
    errors,
    graph::{self, RREdge, RRNode},
    json,
    json_document::JsonDocument,
    output::{self, TruncateEnvelope, TruncateMode},
    session,
};
use humanchrome_native::{
    ipc,
    mcp::idem_cache::{IdemCache, make_key},
};
use serde_json::{Value, json as value};
use std::{
    cell::Cell,
    error::Error,
    io::{self, BufRead, Write},
};

fn main() -> Result<(), Box<dyn Error>> {
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    for line in stdin.lock().lines() {
        let input: Value = serde_json::from_str(&line?)?;
        let result = execute(input)?;
        result.write(&mut stdout)?;
        stdout.write_all(b"\n")?;
        stdout.flush()?;
    }
    Ok(())
}

fn string_envelope(envelope: TruncateEnvelope<humanchrome_core::arguments::JsString>) -> Value {
    value!({"json": format!("{{\"data\":{},\"truncated\":{},\"originalSize\":{},\"limit\":{},\"rawAvailable\":{}}}", envelope.data.json_string_literal(), envelope.truncated, envelope.original_size, envelope.limit, envelope.raw_available)})
}

fn execute(mut input: Value) -> Result<JsonDocument, Box<dyn Error>> {
    let op = input["op"]
        .as_str()
        .ok_or("fixture operation required")?
        .to_owned();
    let custom = input
        .as_object_mut()
        .and_then(|input| input.remove("tools"))
        .map(serde_json::from_value::<Vec<ToolSchema>>)
        .transpose()?
        .map(Catalog::with_tools);
    let catalog = custom.as_ref().unwrap_or_else(|| Catalog::embedded());
    let extras: Vec<String> = input
        .get("extras")
        .map(|value| serde_json::from_value(value.clone()))
        .transpose()?
        .unwrap_or_default();
    let text = |field: &str| input[field].as_str().unwrap_or("");
    let candidates: Vec<String> = input
        .get("candidates")
        .map(|value| serde_json::from_value(value.clone()))
        .transpose()?
        .unwrap_or_default();
    Ok(JsonDocument::from(match op.as_str() {
        "normalizeSessionName" => {
            value!({"value":session::normalize_session_name(&input["value"])})
        }
        "resolveToolName" => value!({"value":catalog.resolve_tool_name(&input["name"], &extras)}),
        "suggestToolName" => value!({"value":catalog.suggest_tool_name(&input["name"], &extras)}),
        "knownToolNames" => value!({"value":catalog.known_tool_name_refs()}),
        "buildToolHelp" => catalog.build_tool_help(input.get("args")),
        "searchTools" => value!({"value":catalog.search(text("query"))}),
        "buildDispatcherTool" => serde_json::to_value(catalog.dispatcher_tool())?,
        "findReplacementForSunsetTool" => {
            value!({"value":catalog.find_replacement_for_sunset_tool(&input["name"])})
        }
        "didYouMean" => {
            value!({"value":arguments::did_you_mean(&input["value"], &candidates, input["maxDistance"].as_u64().unwrap_or(2) as usize)})
        }
        "truncateReceived" => {
            let Some(received) = input.get("value") else {
                return Ok(JsonDocument::from(value!({})));
            };
            let encoded = match arguments::truncate_received(received) {
                ReceivedValue::Value(value) => json::stringify(&value),
                ReceivedValue::String(value) => value.json_string_literal(),
            };
            value!({"json":encoded})
        }
        "buildInvalidArgsDetails" => {
            let details = arguments::build_invalid_args_details(BuildInvalidArgsOptions {
                arg: text("arg"),
                received: input.get("received"),
                expected: input.get("expected"),
                hint: input.get("hint").and_then(Value::as_str),
                candidates: &candidates,
                extra: input.get("extra").and_then(Value::as_object),
            });
            value!({"json":details.to_json_text()})
        }
        "serializeToolError" => {
            value!({"json":errors::serialize_tool_error(text("code"),text("message"),input.get("details").and_then(Value::as_object))})
        }
        "enforceOutputBudget" => {
            let options = output::OutputBudgetOptions {
                raw: input["options"]["raw"] == Value::Bool(true),
                budget_bytes: input["options"]["budgetBytes"]
                    .as_u64()
                    .map(|value| value as usize),
            };
            output::enforce_output_budget(
                input
                    .as_object_mut()
                    .and_then(|input| input.remove("result"))
                    .ok_or("fixture result required")?,
                options,
            )
        }
        "truncateString" => string_envelope(output::truncate_string(
            text("value"),
            input["limit"].as_u64().unwrap_or(0) as usize,
            mode(&input),
        )),
        "truncateJson" => string_envelope(output::truncate_json(
            &input["value"],
            input["limit"].as_u64().unwrap_or(0) as usize,
            mode(&input),
        )),
        "truncateArray" => {
            let values = serde_json::from_value::<Vec<Value>>(input["value"].clone())?;
            let envelope = output::truncate_array(
                values,
                input["limit"].as_u64().unwrap_or(0) as usize,
                mode(&input),
            );
            value!({"data":envelope.data,"truncated":envelope.truncated,"originalSize":envelope.original_size,"limit":envelope.limit,"rawAvailable":envelope.raw_available})
        }
        "modeFromRaw" => {
            value!({"value":if output::mode_from_raw(&input["value"]) == TruncateMode::Raw {"raw"} else {"preview"}})
        }
        "mapNodeToStep" => graph::map_node_to_step(&serde_json::from_value(input["node"].clone())?),
        "mapStepToNodeConfig" => value!(graph::map_step_to_node_config(&input["step"])),
        "stepsToNodes" => value!(graph::steps_to_nodes(
            input["steps"].as_array().ok_or("fixture steps required")?
        )),
        "stepsToDAG" => value!(graph::steps_to_dag(
            input["steps"].as_array().ok_or("fixture steps required")?
        )),
        "topoOrder" | "nodesToSteps" => {
            let nodes = serde_json::from_value::<Vec<RRNode>>(input["nodes"].clone())?;
            let edges = serde_json::from_value::<Vec<RREdge>>(input["edges"].clone())?;
            if op == "topoOrder" {
                match graph::topo_order(&nodes, &edges) {
                    Ok(nodes) => value!(nodes),
                    Err(error) => thrown("TypeError", &error.to_string()),
                }
            } else {
                match graph::nodes_to_steps(&nodes, &edges) {
                    Ok(steps) => value!(steps),
                    Err(error) => thrown("TypeError", &error.to_string()),
                }
            }
        }
        "ipcValidate" => match ipc::validate_schema(text("schema"), &input["value"]) {
            Ok(()) => value!({"success":true}),
            Err(error) => value!({"success":false,"issues":error.issues}),
        },
        "parseNativeMessage" => match ipc::parse_native_message(input["value"].clone()) {
            Ok(data) => value!({"ok":true,"data":data}),
            Err(error) => value!({"ok":false,"error":serde_json::to_string_pretty(&error.issues)?}),
        },
        "idemCache" => {
            let now = Cell::new(0_u64);
            let mut cache = IdemCache::with_limits(
                || now.get(),
                input["ttlMs"].as_u64().unwrap_or(30_000),
                input["maxEntries"].as_u64().unwrap_or(1000) as usize,
            );
            let mut output = Vec::new();
            for action in input["actions"]
                .as_array()
                .ok_or("fixture cache actions required")?
            {
                if let Some(time) = action["now"].as_u64() {
                    now.set(time);
                }
                let client = action.get("clientId").and_then(Value::as_str);
                let tool = action["tool"].as_str().unwrap_or("");
                let text = action
                    .get("key")
                    .and_then(Value::as_str)
                    .map(arguments::JsString::from);
                let key = make_key(client, tool, text.as_ref());
                match action["kind"].as_str() {
                    Some("record") => {
                        if let Some(key) = key {
                            cache.record(key, JsonDocument::from(action["result"].clone()));
                        }
                        output.push(JsonDocument::from(value!({"size":cache.len()})));
                    }
                    Some("lookup") => {
                        let result = key
                            .as_ref()
                            .and_then(|key| cache.lookup(key))
                            .unwrap_or_else(|| JsonDocument::from(Value::Null));
                        output.push(JsonDocument::object([
                            ("result", result),
                            ("size", JsonDocument::from(value!(cache.len()))),
                        ]));
                    }
                    _ => return Err("unknown fixture cache action".into()),
                }
            }
            return Ok(JsonDocument::array(output));
        }
        _ => return Err(format!("unknown fixture operation: {op}").into()),
    }))
}

fn mode(input: &Value) -> TruncateMode {
    if input["mode"].as_str() == Some("raw") {
        TruncateMode::Raw
    } else {
        TruncateMode::Preview
    }
}
fn thrown(name: &str, message: &str) -> Value {
    value!({"thrown":{"name":name,"message":message}})
}
