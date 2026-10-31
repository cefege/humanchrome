use humanchrome_core::arguments::JsString;
use humanchrome_core::catalog::{Catalog, ToolSchema};
use serde_json::{Value, json};

fn custom_catalog() -> Catalog {
    Catalog::with_tools(vec![
        ToolSchema::new(
            "chrome_click_element",
            "Click the selected element. Then report its state.",
            json!({}),
        ),
        ToolSchema::new(
            "chrome_navigate",
            "Navigate the active tab to a URL.",
            json!({}),
        ),
        ToolSchema::new(
            "browser_claim_tab",
            "Claim an existing browser tab.",
            json!({}),
        ),
        ToolSchema::new(
            "chrome_help",
            "Search the available browser tools.",
            json!({}),
        ),
    ])
}

#[test]
fn embedded_dispatcher_uses_the_contract_descriptor_and_schema() {
    let dispatcher = Catalog::embedded().dispatcher_tool();
    let contract = &humanchrome_contracts::CONTRACT;

    assert_eq!(
        dispatcher.description,
        contract["descriptor"]["description"]
            .as_str()
            .expect("contract descriptor is text"),
        "the default dispatcher text is the pinned contract descriptor"
    );
    assert_eq!(
        dispatcher.input_schema,
        &contract["catalog"]["dispatcherInputSchema"]
    );
}

#[test]
fn custom_dispatcher_keeps_contract_metadata_and_sorts_only_tool_names() {
    let catalog = Catalog::with_tools(vec![
        ToolSchema::new("chrome_zebra", "Zebra.", json!({})),
        ToolSchema::new("chrome_alpha", "Alpha.", json!({})),
    ]);
    let dispatcher = catalog.dispatcher_tool();

    assert_eq!(dispatcher.name, "humanchrome");
    assert!(
        dispatcher
            .description
            .ends_with("- chrome_alpha\n- chrome_zebra")
    );
    assert_eq!(
        dispatcher.input_schema,
        Catalog::embedded().dispatcher_tool().input_schema
    );
}

#[test]
fn custom_tool_duplicates_preserve_first_input_for_name_help() {
    let catalog = Catalog::with_tools(vec![
        ToolSchema::new("chrome_duplicate", "First description.", json!({})),
        ToolSchema::new("chrome_duplicate", "Second description.", json!({})),
    ]);

    let help = catalog.build_tool_help(Some(&json!({ "name": "chrome_duplicate" })));
    assert_eq!(help["description"], "First description.");
}

#[test]
fn help_prefers_a_nonblank_query_over_name_and_preserves_the_raw_query() {
    let catalog = custom_catalog();
    let result = catalog.build_tool_help(Some(&json!({
        "name": "chrome_navigate",
        "query": " click ",
        "limit": 1,
    })));

    assert_eq!(result["query"], " click ");
    assert_eq!(result["matches"].as_array().map(Vec::len), Some(1));
    assert_eq!(result["matches"][0]["name"], "chrome_click_element");
    assert!(result.get("description").is_none());
}

#[test]
fn help_name_and_index_paths_preserve_found_and_summary_shape() {
    let catalog = custom_catalog();

    assert_eq!(
        catalog.build_tool_help(Some(&Value::String("not_real".into()))),
        json!({ "name": "not_real", "found": false })
    );
    let named = catalog.build_tool_help(Some(&json!({ "name": "chrome_click_element" })));
    assert_eq!(named["summary"], "Click the selected element.");
    assert_eq!(
        named["description"],
        "Click the selected element. Then report its state."
    );

    let index = catalog.build_tool_help(Some(&json!({})));
    let names: Vec<&str> = index["tools"]
        .as_array()
        .expect("help index contains tools")
        .iter()
        .map(|entry| entry["name"].as_str().expect("tool name is text"))
        .collect();
    assert_eq!(
        names,
        [
            "browser_claim_tab",
            "chrome_click_element",
            "chrome_help",
            "chrome_navigate"
        ]
    );
}

#[test]
fn help_query_limit_clamps_like_the_dispatcher_contract() {
    let catalog = Catalog::with_tools(vec![
        ToolSchema::new("chrome_action_one", "One.", json!({})),
        ToolSchema::new("chrome_action_two", "Two.", json!({})),
        ToolSchema::new("chrome_action_three", "Three.", json!({})),
    ]);

    let minimum = catalog.build_tool_help(Some(&json!({ "query": "action", "limit": 0 })));
    assert_eq!(minimum["matches"].as_array().map(Vec::len), Some(1));

    let default_limit = catalog.build_tool_help(Some(&json!({ "query": "action", "limit": null })));
    assert_eq!(default_limit["matches"].as_array().map(Vec::len), Some(3));

    let non_numeric = catalog.build_tool_help(Some(&json!({ "query": "action", "limit": "nope" })));
    assert_eq!(non_numeric["matches"], json!([]));
}

#[test]
fn search_ranking_uses_name_signals_before_description_only_matches() {
    let catalog = Catalog::with_tools(vec![
        ToolSchema::new(
            "chrome_click_element",
            "Perform an element action.",
            json!({}),
        ),
        ToolSchema::new(
            "chrome_console",
            "Read click diagnostic messages.",
            json!({}),
        ),
    ]);

    let matches = catalog.search("click");
    assert_eq!(matches[0].name, "chrome_click_element");
    assert_eq!(matches[0].score, 82);
    assert_eq!(matches[1].name, "chrome_console");
    assert_eq!(matches[1].score, 33);
}

#[test]
fn search_uses_utf16_length_for_the_edit_distance_bonus_cutoff() {
    let catalog = Catalog::with_tools(vec![ToolSchema::new(
        "chrome_abcdefghijx",
        "No cross-vocabulary hint.",
        json!({}),
    )]);

    let twelve_units = catalog.search("abcdefghij😀");
    let thirteen_units = catalog.search("abcdefghij😀x");
    assert_eq!(twelve_units[0].score, 12);
    assert_eq!(thirteen_units[0].score, 8);
}

#[test]
fn resolution_checks_exact_names_then_chrome_then_browser_and_dynamic_extras() {
    let catalog = Catalog::with_tools(vec![
        ToolSchema::new("chrome_open", "Open.", json!({})),
        ToolSchema::new("browser_open", "Open a browser tab.", json!({})),
    ]);
    let extras = vec!["flow.checkout".to_owned(), "chrome_dynamic".to_owned()];

    assert_eq!(
        catalog.resolve_tool_name(&json!("flow.checkout"), &extras),
        Some("flow.checkout".into())
    );
    assert_eq!(
        catalog.resolve_tool_name(&json!("open"), &extras),
        Some("chrome_open".into())
    );
    assert_eq!(
        catalog.resolve_tool_name(&json!("dynamic"), &extras),
        Some("chrome_dynamic".into())
    );
    assert_eq!(catalog.resolve_tool_name(&json!(""), &extras), None);
    assert_eq!(catalog.resolve_tool_name(&json!(null), &extras), None);
}

#[test]
fn suggestions_keep_catalog_order_before_dynamic_extras() {
    let catalog = Catalog::with_tools(vec![ToolSchema::new("chrome_clock", "Clock.", json!({}))]);
    let extras = vec!["flow.checkout".to_owned()];

    assert_eq!(
        catalog.suggest_tool_name(&json!("flo.checkout"), &extras),
        Some("flow.checkout".into())
    );
    assert_eq!(
        catalog.suggest_tool_name(&json!("zzzz_not_a_tool"), &extras),
        None
    );
}

#[test]
fn lossless_unknown_tool_result_keeps_surrogate_suggestions_and_recovery_distinct() {
    let catalog = Catalog::with_tools(Vec::new());
    let received =
        JsString::from_json_string_literal(r#""\ud800""#).expect("valid JSON string literal");
    let dynamic_names = ["a", "�"];
    let result = catalog.unknown_tool_result(&received, &dynamic_names);
    assert_eq!(result["isError"], true);
    let text = result
        .pointer("/content/0/text")
        .and_then(Value::as_str)
        .expect("MCP result includes error text");

    assert!(text.contains(
        r#""message":"Unknown tool: \"\ud800\". Did you mean \"a\"? Or call chrome_help({query:\"\ud800\"}) to search the catalog.""#
    ));
    assert!(text.contains(r#""received":"\ud800""#));
    assert!(
        text.contains(
            r#""recovery":"Call chrome_help({query:\"\ud800\"}) to search the catalog.""#
        )
    );
    assert!(text.contains(r#""hint":"Did you mean \"a\"?""#));
}

#[test]
fn lossless_unknown_tool_result_truncates_received_but_not_its_recovery_seed() {
    let catalog = Catalog::with_tools(Vec::new());
    let prefix = "x".repeat(199);
    let received = JsString::from_json_string_literal(&format!(r#""{prefix}\ud800z""#))
        .expect("valid JSON string literal");
    let result = catalog.unknown_tool_result(&received, &[]);
    let text = result
        .pointer("/content/0/text")
        .and_then(Value::as_str)
        .expect("MCP result includes error text");

    assert!(text.contains(&format!(r#""received":"{prefix}\ud800…""#)));
    assert!(text.contains(&format!(
        r#""recovery":"Call chrome_help({{query:\"{prefix}\ud800z\"}}) to search the catalog.""#
    )));
}

#[test]
fn unknown_tool_result_preserves_sunset_replacement_recovery_fields() {
    let result =
        Catalog::embedded().unknown_tool_result(&JsString::from("chrome_get_cookies"), &[]);
    let catalog_size = Catalog::embedded().known_tool_name_refs().len();
    let text = result
        .pointer("/content/0/text")
        .and_then(Value::as_str)
        .expect("MCP result includes error text");

    assert!(text.contains(
        r#""message":"Tool \"chrome_get_cookies\" was consolidated into chrome_cookies. Call chrome_cookies({action:\"get\", ...}) instead.""#
    ));
    assert!(text.contains(&format!(
        r#""expected":{{"kind":"tool_name","catalogSize":{catalog_size},"recovery":"Call chrome_cookies({{action:\"get\", ...}}) instead.","replacement":{{"name":"chrome_cookies","action":"get"}}}}"#
    )));
    assert!(text.contains(r#""hint":"Use chrome_cookies with action:\"get\".""#));
}

#[test]
fn sunset_replacements_and_legacy_aliases_are_contract_backed() {
    let catalog = Catalog::embedded();
    let replacement = catalog
        .find_replacement_for_sunset_tool(&json!("chrome_get_cookies"))
        .expect("known sunset name has replacement");
    assert_eq!(replacement.name, "chrome_cookies");
    assert_eq!(replacement.action.as_deref(), Some("get"));

    let alias = catalog
        .legacy_tool_alias("chrome_await_element")
        .expect("known translated legacy alias is exported");
    assert_eq!(alias.tool, "chrome_wait_for");
    assert_eq!(alias.args, Some(json!({ "kind": "element" })));
}
