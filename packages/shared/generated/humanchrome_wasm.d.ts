/* tslint:disable */
/* eslint-disable */

/**
 * Stateful, effect-free browser policy handle. Chrome probes, timers, and Promise settlement
 * remain in the host; continuations are retained here so a liveness resume cannot re-resolve a
 * different active tab.
 */
export class RustBrowserState {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Returns raw queue entries through the extension's existing test escape hatch.
     */
    _queue_entries_for_test(tab_id: bigint): string;
    /**
     * Clears queues through the extension's existing test reset hook.
     */
    _reset_queues_for_test(): void;
    /**
     * Sets the queue hold estimator through the extension's test escape hatch.
     */
    _set_queue_mean_hold_for_test(tab_id: bigint, mean_hold_ms: bigint): void;
    /**
     * Returns the number of active tab queues.
     */
    active_locked_tab_count(): number;
    /**
     * Admits one call to a per-tab queue.
     */
    admit_tab_lock(tab_id: bigint, client_id_json: string, timeout_json: string, now: bigint): string;
    /**
     * Returns aliases in insertion order.
     */
    aliases(client_id_json: string): string;
    /**
     * Claims a tab and returns its former owner or JSON null.
     */
    claim_tab(client_id_json: string, tab_id: bigint, window_id_json: string, now: bigint): string;
    /**
     * Clamps a requested tab-lock timeout using the existing dispatcher bounds.
     */
    static clamp_tab_lock_timeout(timeout_json: string): string;
    /**
     * Clears an invalid cached window hint.
     */
    clear_last_window(client_id_json: string, window_id: bigint): boolean;
    /**
     * Returns a diagnostic client state or JSON null.
     */
    client_snapshot(client_id_json: string): string;
    /**
     * Cancels all callbacks associated with a closed tab queue.
     */
    close_tab_queue(tab_id: bigint): string;
    /**
     * Consumes a pacing delay using the host clock and random sample.
     */
    consume_pacing_delay(client_id_json: string, now: bigint, random_sample: number): bigint;
    /**
     * Returns the Rust-owned default timeout for per-tab queue admission.
     */
    static default_tab_lock_timeout(): bigint;
    /**
     * Evicts stale client records.
     */
    evict_stale_clients(now: bigint): number;
    /**
     * Applies a Chrome tab-close notification.
     */
    handle_tab_removed(tab_id: bigint): boolean;
    /**
     * Applies a Chrome window-close notification.
     */
    handle_window_removed(window_id: bigint): boolean;
    /**
     * Returns all queue inspector records in insertion order.
     */
    inspect_all_tab_queues(now: bigint): string;
    /**
     * Returns one camel-case queue inspector record or JSON null.
     */
    inspect_tab_queue(tab_id: bigint, now: bigint): string;
    /**
     * Validates the alias grammar without lossy UTF-8 conversion.
     */
    static is_valid_alias(alias_json: string): boolean;
    /**
     * Marks the last host persistence write complete.
     */
    mark_persisted(): void;
    /**
     * Creates an empty browser policy state.
     */
    constructor();
    /**
     * Returns the lossless `chrome.storage.session` ownership payload.
     */
    ownership_snapshot(): string;
    /**
     * Returns transient pacing state or JSON null.
     */
    pacing(client_id_json: string): string;
    /**
     * Returns whether the host should schedule its debounced persistence write.
     */
    persistence_dirty(): boolean;
    /**
     * Creates a dispatch plan. `needsLivenessProbe` retains an opaque continuation handle.
     */
    plan_dispatch(request_json: string, now: bigint): string;
    /**
     * Records a successful tab touch.
     */
    record_client_tab(client_id_json: string, tab_id: bigint, window_id_json: string, now: bigint): void;
    /**
     * Records a successful window-only touch.
     */
    record_client_window(client_id_json: string, window_id: bigint, now: bigint): void;
    /**
     * Releases all tabs for a disconnected client.
     */
    release_client(client_id_json: string, now: bigint): number;
    /**
     * Releases an owned tab without closing it.
     */
    release_tab(client_id_json: string, tab_id: bigint): boolean;
    /**
     * Releases one held queue ticket idempotently.
     */
    release_tab_lock(tab_id: bigint, ticket: bigint, now: bigint): string;
    /**
     * Resolves an alias, retaining lone surrogates in errors.
     */
    resolve_alias(client_id_json: string, alias_json: string): string;
    /**
     * Resolves an owned-tab request and returns a target resolution/error document.
     */
    resolve_owned_tab(client_id_json: string, explicit_tab_id_json: string, access_json: string, now: bigint): string;
    /**
     * Resolves the explicit or retained window hint.
     */
    resolve_owned_window(client_id_json: string, explicit_window_id_json: string): string;
    /**
     * Resolves the complete dispatcher target contract.
     */
    resolve_target(request_json: string, now: bigint): string;
    /**
     * Restores ownership from a JSON payload and optional live Chrome tab ids.
     */
    restore_ownership(snapshot_json: string, alive_tab_ids_json: string, now: bigint): string;
    /**
     * Resumes the exact liveness continuation originally returned by [`Self::plan_dispatch`].
     */
    resume_dispatch(continuation_id: number, liveness_json: string): string;
    /**
     * Sets an alias after the host performs its existing schema/ownership gates.
     */
    set_alias(client_id_json: string, alias_json: string, tab_id: bigint, now: bigint): string;
    /**
     * Sets transient client pacing from a profile and optional override object.
     */
    set_pacing(client_id_json: string, profile_json: string, overrides_json: string, now: bigint): string;
    /**
     * Returns a tab's owner or JSON null.
     */
    tab_owner(tab_id: bigint): string;
    /**
     * Applies a host queue timeout.
     */
    timeout_tab_lock(tab_id: bigint, ticket: bigint, now: bigint, timeout_ms: bigint): string;
}

/**
 * Stateful snap policy retaining one DOM-collected anchor batch for a resize gesture.
 */
export class RustEditorSnapState {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Computes one frame using retained anchors and locks without a JSON round trip.
     */
    compute(input: any): any;
    /**
     * Computes labels from the retained locks without copying the anchor collection.
     */
    distance_labels(input: any): any;
    /**
     * Creates an empty gesture state.
     */
    constructor();
    /**
     * Stores one DOM-collected anchor batch and clears the previous gesture locks.
     */
    set_targets(anchors: any): void;
}

/**
 * Stateful embedding-cache policy retaining opaque JavaScript payload handles.
 *
 * Keys cross this boundary as JSON string literals so unpaired UTF-16 surrogates are retained in
 * the core [`humanchrome_core::arguments::JsString`] representation. Values stay as JavaScript
 * handles: returning or evicting one changes handle ownership only and never copies a typed-array
 * embedding into WebAssembly memory.
 */
export class RustEmbeddingCache {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Drops every payload handle and resets the recency list.
     */
    clear(): void;
    /**
     * Returns a cached payload or JavaScript `null` after applying a host-supplied access time.
     */
    get(key_json: string, now: number): any;
    /**
     * Tests for a payload without changing recency, frequency, or access time.
     */
    has(key_json: string): boolean;
    /**
     * Creates a cache using the legacy capacity fallback behavior.
     */
    constructor(capacity: number);
    /**
     * Stores a payload handle using a host-supplied creation time and JavaScript's `Math.log`.
     */
    set(key_json: string, value: any, now: number): void;
    /**
     * Returns the legacy normalized capacity.
     */
    readonly capacity: number;
    /**
     * Returns the number of retained payload handles.
     */
    readonly size: number;
    /**
     * Returns the legacy `size / capacity` ratio.
     */
    readonly usage: number;
}

/**
 * Stateful Rust breakpoint policy for one active run.
 */
export class RustRunBreakpoints {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Adds or enables a breakpoint.
     */
    add(node_id_json: string): void;
    /**
     * Returns all breakpoints in insertion order.
     */
    all(): string;
    /**
     * Clears all breakpoint state.
     */
    clear(): void;
    /**
     * Disables one existing breakpoint.
     */
    disable(node_id_json: string): void;
    /**
     * Enables one existing breakpoint.
     */
    enable(node_id_json: string): void;
    /**
     * Returns enabled node identifiers in insertion order.
     */
    enabled(): string;
    /**
     * Returns whether one breakpoint is enabled.
     */
    has_breakpoint(node_id_json: string): boolean;
    /**
     * Creates the run's breakpoint state from an optional JSON node-id array.
     */
    constructor(node_ids_json?: string | null);
    /**
     * Removes a breakpoint.
     */
    remove(node_id_json: string): void;
    /**
     * Replaces every breakpoint.
     */
    set_all(node_ids_json: string): void;
    /**
     * Enables or clears one-shot step-over behavior.
     */
    set_step_over(enabled: boolean): void;
    /**
     * Returns whether this node should pause execution.
     */
    should_pause_at(node_id_json: string): boolean;
    /**
     * Returns whether one-shot step-over is active.
     */
    step_over(): boolean;
}

/**
 * Rust-owned stateful admission policy for one V3 trigger manager.
 */
export class RustTriggerAdmission {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Admits or drops one host-observed fire without enqueueing a run itself.
     */
    admit(trigger_id_json: string, now_ms: number, queued_count: number): string;
    /**
     * Clears every installed identity before the host refreshes handlers.
     */
    clear_installed(): void;
    /**
     * Reports terminal enqueue success or failure, rolling back cooldown only on failure.
     */
    finish(ticket: number, succeeded: boolean): void;
    /**
     * Returns whether the host must observe its persisted queue length.
     */
    has_queue_cap(): boolean;
    /**
     * Marks one host-successfully-installed trigger as eligible to fire.
     */
    install(trigger_id_json: string): void;
    /**
     * Returns successfully installed trigger identities in insertion order.
     */
    installed_ids(): string;
    /**
     * Returns whether the manager is started.
     */
    is_started(): boolean;
    /**
     * Validates storm control and creates a stopped admission state.
     */
    constructor(cooldown_ms: any, max_queued: any);
    /**
     * Starts fire admission.
     */
    start(): void;
    /**
     * Stops admission and removes installed identities and cooldown stamps.
     */
    stop(): void;
    /**
     * Removes an uninstalled trigger identity.
     */
    uninstall(trigger_id_json: string): void;
}

/**
 * Rust-owned document mapping and label reservation state.
 */
export class SemanticIndex {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Reconciles the next label after the retained HNSW index has been opened.
     */
    apply_initialized_index_count(index_count: number): void;
    /**
     * Computes LRU and time-retention decisions with host-supplied time.
     */
    auto_cleanup_plan(max_elements: number, max_retention_days: number | null | undefined, now_ms: bigint): string;
    /**
     * Clears duplicate-page state during a full index or model clear.
     */
    clear_indexed_pages(): void;
    /**
     * Moves one contiguous embedding into the owned mapping after successful host ANN insertion.
     */
    commit_document(label: number, document_json: string, embedding: Float32Array): void;
    /**
     * Returns the number of persisted document mappings without projecting their embeddings.
     */
    document_count(): number;
    /**
     * Checks the exact raw URL/title duplicate key in Rust-owned indexing state.
     */
    has_indexed_page(url_json: string, title_json: string): boolean;
    /**
     * Returns the browser-visible number of remembered duplicate keys.
     */
    indexed_page_count(): number;
    /**
     * Records a page only after its selected chunks have been offered to the host.
     */
    mark_indexed_page(url_json: string, title_json: string): void;
    /**
     * Moves a contiguous normalized output batch to JavaScript after retained ONNX pooling.
     */
    mean_pool_normalized(hidden_state: Float32Array, attention_mask: Int32Array, batch_size: number, sequence_length: number, hidden_size: number): Float32Array;
    /**
     * Creates an empty mapping. The host retains HNSW and persistence effects.
     */
    constructor();
    /**
     * Removes one mapping and returns its persisted document when present.
     */
    remove_label(label: number): string | undefined;
    /**
     * Removes all document mappings for a tab and returns labels for host HNSW deletion.
     */
    remove_tab(tab_id: bigint): string;
    /**
     * Reserves an HNSW label before the host adds its vector.
     */
    reserve_label(): number;
    /**
     * Restores the existing persisted `documents`, `tabDocuments`, and `nextLabel` shape.
     */
    restore(persisted_json: string): void;
    /**
     * Maps HNSW neighbors, applies top-50-before-dedup, and returns the browser's top ten rows.
     */
    search_results(neighbors_json: string): string;
    /**
     * Serializes the existing mapping format without serializing embeddings through a host copy.
     */
    snapshot(): string;
    /**
     * Returns the number of tab-to-label mappings without projecting document metadata.
     */
    tab_count(): number;
}

/**
 * Reusable indexed flow plus variable context held entirely in the WASM realm.
 */
export class WorkflowHandle {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Applies ordered set/delete operations without rebuilding the indexed flow.
     */
    apply_variable_operations(operations_json: string): void;
    /**
     * Applies host-decided variable patches without rebuilding the indexed graph.
     */
    apply_variable_patch(patch_json: string): void;
    /**
     * Returns the first depth-first cycle path, including its repeated terminal node.
     */
    detect_cycle(): string;
    /**
     * Returns the source position of the first outgoing edge carrying `label`.
     */
    edge_index_by_label(node_id: string, label_json: string): number | undefined;
    /**
     * Returns incoming edge source positions so the host can retain original edge objects.
     */
    in_edge_indices(node_id: string): string;
    /**
     * Parses a V3 flow and variables once for repeated traversal and resolution decisions.
     */
    constructor(flow_json: string, variables_json: string);
    /**
     * Chooses the next node using label/default/sole-edge precedence without graph reserialization.
     */
    next_node(node_id: string, label_json?: string | null): string | undefined;
    /**
     * Returns the first authored node source position for host identity-preserving lookup.
     */
    node_index(node_id: string): number | undefined;
    /**
     * Returns outgoing edge source positions so the host can retain original edge objects.
     */
    out_edge_indices(node_id: string): string;
    /**
     * Returns reachable node ids in JavaScript depth-first Set insertion order.
     */
    reachable_node_ids(): string;
    /**
     * Resolves generic JSON through the supplied real expression callback when needed.
     */
    resolve_json(resolvable_json: string, evaluator: Function): string;
    /**
     * Resolves a finite number; blank variable strings retain the legacy rejection path.
     */
    resolve_number(resolvable_json: string, evaluator: Function): number;
    /**
     * Resolves a string with exact template authored/parts behavior and lossless UTF-16 output JSON.
     */
    resolve_string(resolvable_json: string, evaluator: Function): string;
    /**
     * Returns V3 validation errors and preserves first-cycle discovery ordering.
     */
    validate_dag(): string;
}

/**
 * Reusable normalized URL trigger rules held in the WASM realm.
 */
export class WorkflowUrlRules {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Matches a raw URL using browser URL parsing and the retained compiled rules.
     */
    matches(raw_url_json: string): boolean;
    /**
     * Compiles authored rules once using browser String normalization semantics.
     */
    constructor(rules_json: string);
}

/**
 * Classifies a host-observed tab-operation message without serializing opaque error objects.
 */
export function browser_metadata_classify_tab_error(message_json: string, tab_id_display_json: string): string;

/**
 * Selects host-owned tab indexes for close-tab filters using native JavaScript matching intrinsics.
 */
export function browser_metadata_close_tab_match_indexes(filters_json: string, candidates_json: string, except_tab_ids_json: string, now_ms: number): string;

/**
 * Returns matching marker indexes without moving IndexedDB-owned marker objects across WASM.
 */
export function browser_metadata_matching_marker_indexes(markers_json: string, current_json: string): string;

/**
 * Expands a navigation URL into existing Chrome query patterns using host-observed URL facts.
 */
export function browser_metadata_navigation_url_patterns(input_json: string, parsed_json: string): string;

/**
 * Normalizes stored marker URL fields around a host-native `URL` parse result.
 */
export function browser_metadata_normalize_marker_url(raw_json: string, parsed_json: string): string;

/**
 * Returns source indexes stably sorted by window id then tab id.
 */
export function browser_metadata_owned_tab_order(rows_json: string): string;

/**
 * Selects the best existing navigation candidate index without moving Chrome tab objects.
 */
export function browser_metadata_pick_navigation_candidate(target_json: string, candidates_json: string): string;

/**
 * Plans pacing tool validation while retaining JavaScript non-finite-number distinctions.
 */
export function browser_metadata_plan_pacing_input(profile_json: string, min_gap_ms_json: string, jitter_ms_json: string): string;

/**
 * Resolves the resource registry's request client key without claiming any browser tab.
 */
export function browser_metadata_registry_client_key(client_id_json: string): string;

/**
 * Selects host registry entries that a client-release event must evict.
 */
export function browser_metadata_registry_forget_client_indexes(entries_json: string, client_id_json: string): string;

/**
 * Selects host registry entries that a tab-close event must evict.
 */
export function browser_metadata_registry_forget_tab_indexes(entries_json: string, tab_id: bigint): string;

/**
 * Returns Rust-owned default configuration while the host retains random id generation.
 */
export function builder_default_config(node_type: string, branch_id: string): string;

/**
 * Extracts candidate flow values from a parsed import payload.
 */
export function builder_extract_flow_candidates(value_json: string): string;

/**
 * Detects a JSON-shaped legacy V2 flow before the caller selects a conversion path.
 */
export function builder_is_flow_v2(value_json: string): boolean;

/**
 * Detects a JSON-shaped V3 flow before the caller selects a conversion path.
 */
export function builder_is_flow_v3(value_json: string): boolean;

/**
 * Lists fixed model metadata in legacy registry insertion order.
 */
export function builder_list_models(): string;

/**
 * Returns a model metadata object for the retained third-party inference host.
 */
export function builder_model_info(preset: string): string;

/**
 * Tests model identity changes before retained Chrome/offscreen effects begin.
 */
export function builder_needs_model_switch(current_preset: string | null | undefined, current_version: string | null | undefined, current_dimension: number | null | undefined, requested_preset: string, requested_version: string, requested_dimension?: number | null): boolean;

/**
 * Returns the ordered result indexes after Rust-owned score and provider-priority ranking.
 */
export function builder_quick_panel_rank_order(ranks_json: string): string;

/**
 * Selects the existing device scenario recommendation.
 */
export function builder_recommend_model_for_device(device_memory: number, network_speed: string, prioritize_speed: boolean): string;

/**
 * Selects the existing language scenario recommendation.
 */
export function builder_recommend_model_for_language(scenario: string): string;

/**
 * Applies portable screenshot-to-viewport coordinate scaling.
 */
export function builder_scale_screenshot_coordinates(x: number, y: number, screenshot_width: number, screenshot_height: number, viewport_width: number, viewport_height: number): any;

/**
 * Decides screenshot metadata expiry while the host retains the original opaque context object.
 */
export function builder_screenshot_context_expired(timestamp: number, now: number): boolean;

/**
 * Validates a serialized declarative builder node configuration.
 */
export function builder_validate_node(node_type: string, config_json: string): string;

/**
 * Resolves all longhand winners in one metadata batch, retaining JS candidate identities.
 */
export function editor_cascade_overrides(candidates: any): any;

/**
 * Compares host-collected CSS cascade metadata.
 */
export function editor_compare_cascade(left: any, right: any): number;

/**
 * Compares pre-read computed CSS maps with the editor's numeric tolerance policy.
 */
export function editor_compare_computed(input_json: string): string;

/**
 * Compares source order without serializing JavaScript numeric values through JSON.
 */
export function editor_compare_source_order(left: any, right: any): number;

/**
 * Compares two CSS specificity tuples.
 */
export function editor_compare_specificity(left_json: string, right_json: string): bigint;

/**
 * Computes a complete stateless snap operation for the compatibility facade.
 */
export function editor_compute_snap(input: any): any;

/**
 * Computes a complete stateless distance-label operation for the compatibility facade.
 */
export function editor_compute_snap_distance_labels(input: any): any;

/**
 * Computes the complete editor specificity grammar without replacing JavaScript code units.
 */
export function editor_compute_specificity(value_json: string): string;

/**
 * Expands one normalized shorthand using the editor's cascade metadata.
 */
export function editor_expand_css_shorthand(value_json: string): string;

/**
 * Extracts custom-property names from arbitrary CSS text.
 */
export function editor_extract_css_var_names(value_json: string): string;

/**
 * Finds a named CSS function while preserving quoted and escaped arguments.
 */
export function editor_find_css_function(value_json: string, name_json: string): string;

/**
 * Formats a custom-property reference without crossing into CSSOM.
 */
export function editor_format_css_var(name_json: string, fallback_json: string): string;

/**
 * Associates inline and computed gradient stops by nearest position.
 */
export function editor_gradient_placeholder_mapping(inline_json: string, computed_json: string): string;

/**
 * Interpolates two gradient-stop colors.
 */
export function editor_interpolate_rgba(left_json: string, right_json: string, t: number): string;

/**
 * Tests the editor's curated CSS inheritance metadata.
 */
export function editor_is_inheritable_property(value_json: string): boolean;

/**
 * Selects the first highest-specificity member of a host-matched selector collection.
 */
export function editor_matched_specificity(selectors_json: string): string;

/**
 * Normalizes one web-editor apply-batch payload while retaining its `elements` array identity.
 */
export function editor_normalize_apply_batch_payload(raw: any): any;

/**
 * Normalizes one web-editor apply payload without serializing opaque JavaScript values.
 */
export function editor_normalize_apply_payload(raw: any): any;

/**
 * Normalizes one browser-read property name for inheritance and shorthand lookup.
 */
export function editor_normalize_css_property(value_json: string): string;

/**
 * Normalizes one browser-read CSS value using the same policy as computed-map comparison.
 */
export function editor_normalize_css_value(value_json: string): string;

/**
 * Normalizes one parsed gradient-stop collection.
 */
export function editor_normalize_gradient_stops(stops_json: string): string;

/**
 * Normalizes one effects-control length.
 */
export function editor_normalize_length(value_json: string): string;

/**
 * Coerces a primitive JavaScript string, retaining the historical empty-string fallback.
 */
export function editor_normalize_string(value: any): any;

/**
 * Normalizes display text using the same policy as editor comparisons.
 */
export function editor_normalize_text(value_json: string): string;

/**
 * Parses the first box-shadow expression without browser color resolution.
 */
export function editor_parse_box_shadow(value_json: string): string;

/**
 * Parses one standalone custom-property expression.
 */
export function editor_parse_css_var(value_json: string): string;

/**
 * Parses a hexadecimal gradient-stop color.
 */
export function editor_parse_hex_color(value_json: string): string;

/**
 * Parses an RGB or RGBA gradient-stop color.
 */
export function editor_parse_rgb_color(value_json: string): string;

/**
 * Formats an RGBA value for authored CSS.
 */
export function editor_rgba_to_css(color_json: string): string;

/**
 * Scores a host-collected HMR candidate fingerprint.
 */
export function editor_score_fingerprint_candidate(input_json: string): number | undefined;

/**
 * Splits an authored CSS value at top-level separators.
 */
export function editor_split_css_top_level(value_json: string, separator_json: string): string;

/**
 * Splits a selector list with the Rust CSS grammar scanner.
 */
export function editor_split_selector_list(value_json: string): string;

/**
 * Tokenizes an authored CSS value at top-level whitespace.
 */
export function editor_tokenize_css_top_level(value_json: string): string;

/**
 * Selects builder linear-step node positions after Rust filters trigger/default graph structure.
 */
export function graph_legacy_builder_step_indexes(nodes_json: string, edges_json: string): string;

/**
 * Selects a trigger's first default successor without serializing host graph resources.
 */
export function graph_legacy_default_successor(edges_json: string, current_id_json: string): number | undefined;

/**
 * Selects the one delay property the host must coerce with JavaScript's `Number`.
 */
export function graph_legacy_delay_source(sleep_is_nullish: boolean, ms_is_nullish: boolean): string;

/**
 * Runs legacy scheduler graph policy over host projections, returning only source indexes.
 */
export function graph_legacy_execution_plan(nodes_json: string, edges_json: string): string;

/**
 * Selects flow-store conversion and retained-versus-generated edge behavior.
 */
export function graph_legacy_flow_normalization_plan(has_nodes: boolean, has_steps: boolean, nodes_json: string, edges_json: string): string;

/**
 * Selects an exact legacy branch label without applying default-edge fallback.
 */
export function graph_legacy_labeled_edge(edges_json: string, current_id_json: string, label_json: string): number | undefined;

/**
 * Selects a scheduler successor without serializing node or edge host metadata.
 */
export function graph_legacy_next_edge(edges_json: string, current_id_json: string, label_json: string): number | undefined;

/**
 * Produces one core-owned step patch; the host reattaches only the original configuration object.
 */
export function graph_legacy_node_to_step_plan(node_json: string): string;

/**
 * Orders legacy node-to-step source positions, preserving no-edge source order in Rust.
 */
export function graph_legacy_nodes_to_step_indexes(nodes_json: string, edges_json: string): string;

/**
 * Clamps a single host-coerced legacy delay number through Rust policy.
 */
export function graph_legacy_normalize_delay(number_input_json: string): string;

/**
 * Generates sequential legacy DAG edge identifiers from source node projections.
 */
export function graph_legacy_sequential_edges(nodes_json: string): string;

/**
 * Produces default identifiers and types for legacy step-to-node conversion.
 */
export function graph_legacy_steps_to_nodes_plan(steps_json: string): string;

/**
 * Orders an arbitrary legacy edge set with the historical Kahn/cycle-fallback policy.
 */
export function graph_legacy_topo_order_indexes(nodes_json: string, edges_json: string): string;

/**
 * Returns source positions of non-dangling edges for legacy flow normalization.
 */
export function graph_legacy_valid_edge_indexes(nodes_json: string, edges_json: string): string;

/**
 * Returns a pure mutation plan, or undefined when the original result must be retained.
 */
export function output_budget_plan(result: any, options: any): any;

/**
 * Makes the Rust-owned public default available to generated build metadata.
 */
export function output_default_budget_bytes(): number;

/**
 * Computes ActionRegistry's total attempt count without scheduling retries.
 */
export function replay_action_max_attempts(retries: number): number;

/**
 * Evaluates a legacy condition through the Rust-owned resolver and narrow JavaScript intrinsics.
 */
export function replay_evaluate_condition(condition: any, variables: any): boolean;

/**
 * Returns the execution-mode action sets owned by the Rust policy module.
 */
export function replay_execution_mode_sets(): string;

/**
 * Clamps a foreach worker count while retaining JavaScript NaN and infinity values.
 */
export function replay_foreach_concurrency(value: number): number;

/**
 * Returns the exact bounded foreach control declaration without executing subflows.
 */
export function replay_foreach_plan(input_json: string, concurrency: number): string;

/**
 * Selects a branch label after JavaScript evaluates user-authored expressions.
 */
export function replay_if_branch_label(labels_json: string, matching_index_json: string, has_else: boolean, else_label: string): string;

/**
 * Constructs the immutable initial recorded-flow fields; the host retains empty arrays by identity.
 */
export function replay_initial_flow_plan(authored_meta_json: string, generated_id: string, timestamp: string): string;

/**
 * Plans sequential DAG mutation for one recorded event without copying its opaque config.
 */
export function replay_recorded_step_append_plan(previous_node_id: string | null | undefined, edge_count: number, step_id: string): string;

/**
 * Plans all recording-session upsert/rechain decisions while JavaScript retains config values.
 */
export function replay_recording_append_plan(input_json: string): string;

/**
 * Rebuilds recording-session cache indexes without crossing opaque node config values.
 */
export function replay_recording_cache_plan(nodes_json: string, edge_seq: number): string;

/**
 * Selects a recording node type while preserving JavaScript's warning side effect in the host.
 */
export function replay_recording_node_type_plan(step_type: string): string;

/**
 * Plans variable upserts using native SameValueZero key identity, retaining opaque values in JS.
 */
export function replay_recording_variable_append_plan(existing: Array<any>, incoming: Array<any>): any;

/**
 * Resolves one legacy value while retaining raw JavaScript object identity.
 */
export function replay_resolve_json(value: any, variables: any): any;

/**
 * Resolves one finite legacy number with JavaScript trim and Number coercion.
 */
export function replay_resolve_number(value: any, variables: any): any;

/**
 * Resolves a string, returning policy failures and propagating native intrinsic exceptions.
 */
export function replay_resolve_string(value: any, variables: any): any;

/**
 * Computes one effect-free legacy retry delay after the host coerces numeric inputs.
 */
export function replay_retry_delay_ms(base: number, backoff: string, attempt: number): number;

/**
 * Applies the historical retry exhaustion comparison to host-coerced values.
 */
export function replay_retry_exhausted(attempt: number, max: number): boolean;

/**
 * Tests whether ActionRegistry may retry a result without inspecting its opaque payload.
 */
export function replay_should_retry_action(has_policy: boolean, retries: number, error_code: string | null | undefined, retry_on_json: string): boolean;

/**
 * Routes a legacy record/replay step to actions or the legacy executor.
 */
export function replay_should_use_actions(mode: string, step_type: string, legacy_only_json: string, actions_allowlist_json: string): boolean;

/**
 * Normalizes a supplied ActionRegistry timeout without creating timers.
 */
export function replay_timeout_ms(value: number): number;

/**
 * Projects V3 policy fields to the V2 handler shape before JavaScript invokes the handler.
 */
export function replay_v2_action_policy(policy_json: string): string;

/**
 * Produces all ordered V3 variable-patch operations after one V2 action result.
 */
export function replay_v2_adapter_result_plan(before_json: string, after_json: string): string;

/**
 * Maps a V2 error code to the V3 compatibility code without rebuilding its error envelope.
 */
export function replay_v2_error_code(code: string): string;

/**
 * Validates an if declaration before host-owned condition evaluation.
 */
export function replay_validate_if(has_branches: boolean, has_condition: boolean): string | undefined;

/**
 * Clamps a while iteration bound while retaining JavaScript NaN and infinity values.
 */
export function replay_while_max_iterations(value: number): number;

/**
 * Returns the exact bounded while control declaration without evaluating its expression.
 */
export function replay_while_plan(input_json: string, max_iterations: number): string;

/**
 * Compares two queue rows using V3's priority/FIFO comparator.
 */
export function run_policy_compare_queue_items(left_priority: number, left_created_at: number, right_priority: number, right_created_at: number): number;

/**
 * Computes the next local-time cron fire using only host Date candidate observations.
 */
export function run_policy_cron_next_local(cron: string, from_ms: number, local_candidate: Function): number;

/**
 * Computes the next zoned cron fire using only host Intl DateTimeFormat observations.
 */
export function run_policy_cron_next_zoned(cron: string, timezone: string, from_ms: number, zoned_parts: Function): number;

/**
 * Canonicalizes a complete DOM-observer trigger payload batch and asks the host only to observe
 * native `localeCompare` ordering.
 */
export function run_policy_dom_trigger_payload(entries: any, locale_compare: Function, stringify: Function, trim: Function): string;

/**
 * Selects an error-routing branch without evaluating plugins or traversing edges.
 */
export function run_policy_error_plan(policy_json: string, has_on_error_edge: boolean): string;

/**
 * Returns whether a host-supplied lease expiration is strictly before the current time.
 */
export function run_policy_is_lease_expired(expires_at: number, now: number): boolean;

/**
 * Computes a lease expiration from explicit host time and TTL values.
 */
export function run_policy_lease_expires_at(now: number, ttl_ms: number): number;

/**
 * Plans the V3 node-policy merge while JavaScript retains `undefined` and opaque values.
 */
export function run_policy_node_policy_merge_plan(_flow_default: any, node_policy: any): string;

/**
 * Normalizes a cron source value through the host's String intrinsics, then validates grammar.
 */
export function run_policy_normalize_cron(value: any, normalize: Function): string;

/**
 * Validates and normalizes queue priority and max-attempt inputs without reading browser state.
 */
export function run_policy_normalize_enqueue(priority: any, max_attempts: any): string;

/**
 * Normalizes a timezone through host String/Intl observations while retaining error policy in Rust.
 */
export function run_policy_normalize_timezone(value: any, trim: Function, is_valid: Function): string | undefined;

/**
 * Produces stable sort indexes for projected V3 queue rows without serializing JavaScript numbers.
 */
export function run_policy_queue_sort_indexes(items: any): string;

/**
 * Selects cleanup before orphan-lease recovery from a host-supplied run status.
 */
export function run_policy_recovery_preclean(status?: string | null): string;

/**
 * Selects the record reconciliation after a host queue lease recovery transition.
 */
export function run_policy_recovery_reconcile(recovered_status: string, run_status?: string | null): string;

/**
 * Selects screenshot capture without calling Chrome or storing image data.
 */
export function run_policy_should_capture_screenshot(policy: string, failed: boolean): boolean;

/**
 * Validates the complete five-field cron grammar after host string normalization.
 */
export function run_policy_validate_cron(cron: string): void;

/**
 * Prepares a complete replay target while keeping source/stability handles on original objects.
 */
export function selector_action_target(target: any, scope: any): any;

/**
 * Returns deterministic ARIA-to-CSS fallback candidates.
 */
export function selector_aria_to_css(role_json: string, name_json: string): string;

/**
 * Produces the exact deduplication key for a candidate.
 */
export function selector_candidate_key(candidate_json: string): string;

/**
 * Preserves JavaScript Number coercion before applying the core's integer-bounds policy.
 */
export function selector_clamp_action_integer(value: any, min: number, max: number): number;

/**
 * Applies the current selector comparator to two candidate JSON values for legacy callers.
 */
export function selector_compare(left_json: string, right_json: string): number;

/**
 * Composes a canonical iframe composite selector.
 */
export function selector_compose_composite(frame_json: string, inner_json: string): string;

/**
 * Computes a DOM-collected structural fingerprint using JavaScript lower-casing semantics.
 */
export function selector_compute_fingerprint(input_json: string, options_json: string): string;

/**
 * Applies a Rust-owned compatibility escape when the host lacks native `CSS.escape`.
 */
export function selector_css_escape_fallback(value_json: string, mode_json: string): string;

/**
 * Derives a composite frame selector from a target and its candidate order.
 */
export function selector_derive_frame(target_json: string): string;

/**
 * Derives the text-tag locator hint from a target/candidate index.
 */
export function selector_derive_tag_hint(target_json: string, candidate_index: number): string;

/**
 * Returns eligible class indexes for the web-editor locator DOM adapter.
 */
export function selector_editor_locator_class_indexes(classes_json: string): string;

/**
 * Returns a DOM collection plan for the web-editor locator adapter.
 */
export function selector_editor_locator_plan(max_candidates_json: string, anchor_available: boolean): string;

/**
 * Selects one complete web-editor locator candidate batch.
 */
export function selector_editor_locator_select(head_candidates_json: string, path_candidate_json: string, anchor_candidate_json: string, max_candidates_json: string): string;

/**
 * Applies the default or supplied fingerprint threshold.
 */
export function selector_fingerprint_matches(left_json: string, right_json: string, threshold_json: string): string;

/**
 * Computes a fingerprint similarity score using JavaScript lower-casing semantics.
 */
export function selector_fingerprint_similarity(left_json: string, right_json: string): number;

/**
 * Tests composite selector syntax.
 */
export function selector_is_composite(selector_json: string): boolean;

/**
 * Builds the legacy ARIA fallback queries without browser handles or UTF-16 replacement.
 */
export function selector_legacy_aria_selectors(value_json: string): string;

/**
 * Matches strings using core policy and the browser's native Unicode lowercase intrinsic.
 */
export function selector_matches_accessible_name(computed: string, target: string, mode: string): boolean;

/**
 * Normalizes DOM-observed names without changing the host's synchronous API.
 */
export function selector_normalize_accessible_name(value: string): string;

/**
 * Resolves generator defaults and numeric clamps.
 */
export function selector_normalize_options(options_json: string): string;

/**
 * Parses a human-readable ARIA expression.
 */
export function selector_parse_aria_expression(input_json: string): string;

/**
 * Parses a fingerprint without dropping empty fields.
 */
export function selector_parse_fingerprint(input_json: string): string;

/**
 * Parses a prefixed selector expression.
 */
export function selector_parse_prefixed(input_json: string): string;

/**
 * Parses a role-selector value.
 */
export function selector_parse_role(input_json: string): string;

/**
 * Converts a prefixed selector parse result to a candidate patch, or JSON null.
 */
export function selector_prefixed_candidate(input_json: string): string;

/**
 * Ranks one raw candidate collection, crossing the WASM boundary only once.
 */
export function selector_rank(candidates_json: string, options_json: string, tag_name_json: string): string;

/**
 * Stably reorders a complete persisted candidate collection without deduplicating or truncating.
 */
export function selector_sort(candidates_json: string): string;

/**
 * Splits a composite selector into frame and inner components, or returns JSON null.
 */
export function selector_split_composite(selector_json: string): string;

/**
 * Computes one candidate's stability patch.
 */
export function selector_stability(candidate_json: string): string;

/**
 * Verifies a fingerprint against DOM-collected tag/id values.
 */
export function selector_verify_fingerprint(tag_json: string, id_json: string, fingerprint_json: string): boolean;

/**
 * Returns the Rust-owned ANN request count for the retained HNSW host effect.
 */
export function semantic_ann_candidate_count(requested?: number | null): number;

/**
 * Chunks content using JavaScript UTF-16 semantics and returns browser chunk records.
 */
export function semantic_chunk_text(input_json: string): string;

/**
 * Chunks content then applies the page chunk cap before host embedding work.
 */
export function semantic_chunks_for_indexing(input_json: string, max_chunks_per_page: number): string;

/**
 * Computes the synchronous scalar cosine compatibility primitive.
 */
export function semantic_cosine_similarity(left: Float32Array, right: Float32Array): number;

/**
 * Builds the current host-time document identifier without reading a browser clock.
 */
export function semantic_document_id(tab_id: bigint, chunk_index: number, now_ms: bigint): string;

/**
 * Estimates persisted vector storage from host JSON-length observations without reserializing documents.
 */
export function semantic_estimate_storage(document_json_utf16_lengths: string, tab_label_counts: string, dimension: number): string;

/**
 * Builds an unchanged index duplicate key from raw URL and title JSON string literals.
 */
export function semantic_indexed_page_key(url_json: string, title_json: string): string;

/**
 * Applies the existing content-index URL predicate without host normalization.
 */
export function semantic_is_indexable_content_url(url_json: string): boolean;

/**
 * Applies the existing rebuild-index URL predicate without host normalization.
 */
export function semantic_is_rebuild_indexable_url(url_json: string): boolean;

/**
 * Validates a contiguous batch supplied as a `Float32Array`.
 */
export function semantic_is_valid_contiguous_batch(vectors: Float32Array, dimension: number): boolean;

/**
 * Normalizes an owned contiguous vector while preserving the zero-vector compatibility case.
 */
export function semantic_normalize_vector(vector: Float32Array): Float32Array;

/**
 * Reconstructs direct-worker pair scores from one contiguous embedding result batch.
 */
export function semantic_pair_similarity_scores(pairs_json: string, embeddings: Float32Array, dimension: number): string;

/**
 * Plans cache placement and direct-worker versus offscreen inference work.
 */
export function semantic_plan_embedding_batch(texts_json: string, cache_hits_json: string, mode: string): string | undefined;

/**
 * Plans matrix similarity with one first-occurrence ordered embedding request.
 */
export function semantic_plan_similarity_matrix(left_json: string, right_json: string): string;

/**
 * Plans pair similarity without duplicating direct-worker deduplication in the host.
 */
export function semantic_plan_similarity_pairs(pairs_json: string, mode: string): string;

/**
 * Reconstructs a direct-worker similarity matrix from one contiguous embedding result batch.
 */
export function semantic_similarity_matrix_scores(left_json: string, right_json: string, embeddings: Float32Array, dimension: number): string;

/**
 * Validates a document embedding before the host submits it to HNSW.
 */
export function semantic_validate_embedding(embedding: Float32Array, dimension: number): void;

/**
 * Validates a query embedding before the host queries HNSW.
 */
export function semantic_validate_query_embedding(embedding: Float32Array, dimension: number): void;

/**
 * Validates a host similarity input while retaining non-string versus empty-string errors.
 */
export function semantic_validate_similarity_input(value_json: string): void;

/**
 * Builds a `chrome_help` response from the embedded catalog.
 */
export function shared_catalog_help(argument: any): any;

/**
 * Tests a static catalog name without a host-side duplicate index.
 */
export function shared_catalog_is_known(name: any): boolean;

/**
 * Returns static catalog names in its contract-defined sorted order.
 */
export function shared_catalog_known_names(): any;

/**
 * Resolves static and dynamic catalog names through the Rust catalog owner.
 */
export function shared_catalog_resolve(name: any, extras: Array<any>): any;

/**
 * Searches the embedded catalog with the existing Rust ranking policy.
 */
export function shared_catalog_search(query: any): any;

/**
 * Suggests a static or dynamic tool name through the Rust catalog owner.
 */
export function shared_catalog_suggest(received: any, extras: Array<any>): any;

/**
 * Suggests an enum value without converting an unpaired surrogate through UTF-8.
 */
export function shared_did_you_mean(received: any, candidates: Array<any>, max_distance: number): any;

/**
 * Identifies an object key whose value must be redacted in non-raw mode.
 */
export function shared_is_sensitive_key(key: any): boolean;

/**
 * Applies the per-string sanitizer length limit while preserving UTF-16 slicing behavior.
 */
export function shared_limit_string(text: any, max_length: number): any;

/**
 * Returns Rust-owned normalization for sanitizer configuration caps.
 */
export function shared_normalize_positive_int(value: number, fallback: number): number;

/**
 * Applies the ordered text-redaction rules while retaining JavaScript RegExp/String semantics.
 */
export function shared_sanitize_text(text: any, raw: boolean): any;

/**
 * Filters suggested-next tool names before the host attaches result metadata.
 */
export function shared_suggested_next(hints: Array<any>, limit: number): any;

/**
 * Caps formatted output and provides the exact footer fields for the JS envelope.
 */
export function shared_truncate_output_text(text: any, max_bytes: number): any;

/**
 * Truncates an INVALID_ARGS received value while retaining JavaScript's JSON/String behavior.
 */
export function shared_truncate_received(value: any): any;

/**
 * Returns TextEncoder-compatible UTF-8 byte length for a JavaScript string.
 */
export function shared_utf8_byte_length(text: any): number;

/**
 * Encodes a JavaScript string with TextEncoder-compatible replacement semantics.
 */
export function shared_utf8_to_base64(text: any): string;

/**
 * Applies Rust's relative-end plan while preserving original host array resources.
 */
export function tool_truncate_array(values: Array<any>, max_items: number, mode: string): any;

/**
 * Keeps JSON.stringify/String host semantics, including cycles and undefined.
 */
export function tool_truncate_json(value: any, max_bytes: number, mode: string): any;

/**
 * Decodes raw strictly: truthy non-booleans retain preview mode.
 */
export function tool_truncate_mode(raw: any): string;

/**
 * Caps lossless JavaScript strings without moving array/image resources into Rust.
 */
export function tool_truncate_string(text: any, max_bytes: number, mode: string): any;

/**
 * Converts a V2 flow with host-supplied conversion time and browser locale ordering.
 */
export function workflow_convert_v2_to_v3(flow_json: string, conversion_time_json: string): string;

/**
 * Converts one V2 trigger, retaining omitted versus explicit weekly `days` arrays.
 */
export function workflow_convert_v2_trigger(trigger_input_json: string): string;

/**
 * Converts a V3 flow back to the legacy builder's V2 representation.
 */
export function workflow_convert_v3_to_v2(flow_json: string): string;

/**
 * Applies legacy assignment paths while preserving source and target JavaScript handles.
 */
export function workflow_legacy_apply_assign(target: any, source: any, assign: any): void;

/**
 * Expands legacy `{name}` placeholders without serializing host-owned values.
 */
export function workflow_legacy_expand_templates_deep(value: any, scope: any): any;

/**
 * Reads one legacy action-handler path without changing undefined into a serialized value.
 */
export function workflow_legacy_handler_lookup(source: any, path: any): any;

/**
 * Computes legacy action retry timing from an explicit host random sample.
 */
export function workflow_legacy_retry_delay(policy: any, retry_index: number, random_sample: number): number;

/**
 * Matches legacy URL triggers with their raw prefix and substring behavior.
 */
export function workflow_legacy_url_matches(rules: any, raw_url: any): boolean;

/**
 * Computes V3 retry timing from explicit host random data without reading timers or globals.
 */
export function workflow_retry_delay(policy_json: string, attempt: number, random_sample: number): number;

/**
 * Compiles and matches URL trigger rules through actual browser URL and String intrinsics.
 */
export function workflow_url_matches(rules_json: string, raw_url_json: string): boolean;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_rustbrowserstate_free: (a: number, b: number) => void;
    readonly __wbg_rusteditorsnapstate_free: (a: number, b: number) => void;
    readonly __wbg_rustembeddingcache_free: (a: number, b: number) => void;
    readonly __wbg_rustrunbreakpoints_free: (a: number, b: number) => void;
    readonly __wbg_rusttriggeradmission_free: (a: number, b: number) => void;
    readonly __wbg_semanticindex_free: (a: number, b: number) => void;
    readonly __wbg_workflowhandle_free: (a: number, b: number) => void;
    readonly __wbg_workflowurlrules_free: (a: number, b: number) => void;
    readonly browser_metadata_classify_tab_error: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly browser_metadata_close_tab_match_indexes: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly browser_metadata_matching_marker_indexes: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly browser_metadata_navigation_url_patterns: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly browser_metadata_normalize_marker_url: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly browser_metadata_owned_tab_order: (a: number, b: number) => [number, number, number, number];
    readonly browser_metadata_pick_navigation_candidate: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly browser_metadata_plan_pacing_input: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly browser_metadata_registry_client_key: (a: number, b: number) => [number, number, number, number];
    readonly browser_metadata_registry_forget_client_indexes: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly browser_metadata_registry_forget_tab_indexes: (a: number, b: number, c: bigint) => [number, number, number, number];
    readonly builder_default_config: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly builder_extract_flow_candidates: (a: number, b: number) => [number, number, number, number];
    readonly builder_is_flow_v2: (a: number, b: number) => [number, number, number];
    readonly builder_is_flow_v3: (a: number, b: number) => [number, number, number];
    readonly builder_list_models: () => [number, number, number, number];
    readonly builder_model_info: (a: number, b: number) => [number, number, number, number];
    readonly builder_needs_model_switch: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => number;
    readonly builder_quick_panel_rank_order: (a: number, b: number) => [number, number, number, number];
    readonly builder_recommend_model_for_device: (a: number, b: number, c: number, d: number) => [number, number];
    readonly builder_recommend_model_for_language: (a: number, b: number) => [number, number];
    readonly builder_scale_screenshot_coordinates: (a: number, b: number, c: number, d: number, e: number, f: number) => any;
    readonly builder_screenshot_context_expired: (a: number, b: number) => number;
    readonly builder_validate_node: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly editor_cascade_overrides: (a: any) => [number, number, number];
    readonly editor_compare_cascade: (a: any, b: any) => [number, number, number];
    readonly editor_compare_computed: (a: number, b: number) => [number, number, number, number];
    readonly editor_compare_source_order: (a: any, b: any) => [number, number, number];
    readonly editor_compare_specificity: (a: number, b: number, c: number, d: number) => [bigint, number, number];
    readonly editor_compute_snap: (a: any) => [number, number, number];
    readonly editor_compute_snap_distance_labels: (a: any) => [number, number, number];
    readonly editor_compute_specificity: (a: number, b: number) => [number, number, number, number];
    readonly editor_expand_css_shorthand: (a: number, b: number) => [number, number, number, number];
    readonly editor_extract_css_var_names: (a: number, b: number) => [number, number, number, number];
    readonly editor_find_css_function: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly editor_format_css_var: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly editor_gradient_placeholder_mapping: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly editor_interpolate_rgba: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly editor_is_inheritable_property: (a: number, b: number) => [number, number, number];
    readonly editor_matched_specificity: (a: number, b: number) => [number, number, number, number];
    readonly editor_normalize_apply_batch_payload: (a: any) => [number, number, number];
    readonly editor_normalize_apply_payload: (a: any) => [number, number, number];
    readonly editor_normalize_css_property: (a: number, b: number) => [number, number, number, number];
    readonly editor_normalize_css_value: (a: number, b: number) => [number, number, number, number];
    readonly editor_normalize_gradient_stops: (a: number, b: number) => [number, number, number, number];
    readonly editor_normalize_length: (a: number, b: number) => [number, number, number, number];
    readonly editor_normalize_string: (a: any) => any;
    readonly editor_normalize_text: (a: number, b: number) => [number, number, number, number];
    readonly editor_parse_box_shadow: (a: number, b: number) => [number, number, number, number];
    readonly editor_parse_css_var: (a: number, b: number) => [number, number, number, number];
    readonly editor_parse_hex_color: (a: number, b: number) => [number, number, number, number];
    readonly editor_parse_rgb_color: (a: number, b: number) => [number, number, number, number];
    readonly editor_rgba_to_css: (a: number, b: number) => [number, number, number, number];
    readonly editor_score_fingerprint_candidate: (a: number, b: number) => [number, number, number, number];
    readonly editor_split_css_top_level: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly editor_split_selector_list: (a: number, b: number) => [number, number, number, number];
    readonly editor_tokenize_css_top_level: (a: number, b: number) => [number, number, number, number];
    readonly graph_legacy_builder_step_indexes: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly graph_legacy_default_successor: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly graph_legacy_delay_source: (a: number, b: number) => [number, number];
    readonly graph_legacy_execution_plan: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly graph_legacy_flow_normalization_plan: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly graph_legacy_labeled_edge: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly graph_legacy_next_edge: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly graph_legacy_node_to_step_plan: (a: number, b: number) => [number, number, number, number];
    readonly graph_legacy_nodes_to_step_indexes: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly graph_legacy_normalize_delay: (a: number, b: number) => [number, number, number, number];
    readonly graph_legacy_sequential_edges: (a: number, b: number) => [number, number, number, number];
    readonly graph_legacy_steps_to_nodes_plan: (a: number, b: number) => [number, number, number, number];
    readonly graph_legacy_topo_order_indexes: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly graph_legacy_valid_edge_indexes: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly output_budget_plan: (a: any, b: any) => [number, number, number];
    readonly output_default_budget_bytes: () => number;
    readonly replay_action_max_attempts: (a: number) => number;
    readonly replay_evaluate_condition: (a: any, b: any) => number;
    readonly replay_execution_mode_sets: () => [number, number, number, number];
    readonly replay_foreach_concurrency: (a: number) => number;
    readonly replay_foreach_plan: (a: number, b: number, c: number) => [number, number, number, number];
    readonly replay_if_branch_label: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly replay_initial_flow_plan: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly replay_recorded_step_append_plan: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly replay_recording_append_plan: (a: number, b: number) => [number, number, number, number];
    readonly replay_recording_cache_plan: (a: number, b: number, c: number) => [number, number, number, number];
    readonly replay_recording_node_type_plan: (a: number, b: number) => [number, number, number, number];
    readonly replay_recording_variable_append_plan: (a: any, b: any) => [number, number, number];
    readonly replay_resolve_json: (a: any, b: any) => [number, number, number];
    readonly replay_resolve_number: (a: any, b: any) => [number, number, number];
    readonly replay_resolve_string: (a: any, b: any) => [number, number, number];
    readonly replay_retry_delay_ms: (a: number, b: number, c: number, d: number) => number;
    readonly replay_retry_exhausted: (a: number, b: number) => number;
    readonly replay_should_retry_action: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly replay_should_use_actions: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number];
    readonly replay_timeout_ms: (a: number) => number;
    readonly replay_v2_action_policy: (a: number, b: number) => [number, number, number, number];
    readonly replay_v2_adapter_result_plan: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly replay_v2_error_code: (a: number, b: number) => [number, number];
    readonly replay_validate_if: (a: number, b: number) => [number, number];
    readonly replay_while_max_iterations: (a: number) => number;
    readonly replay_while_plan: (a: number, b: number, c: number) => [number, number, number, number];
    readonly run_policy_compare_queue_items: (a: number, b: number, c: number, d: number) => number;
    readonly run_policy_cron_next_local: (a: number, b: number, c: number, d: any) => [number, number, number];
    readonly run_policy_cron_next_zoned: (a: number, b: number, c: number, d: number, e: number, f: any) => [number, number, number];
    readonly run_policy_dom_trigger_payload: (a: any, b: any, c: any, d: any) => [number, number, number, number];
    readonly run_policy_error_plan: (a: number, b: number, c: number) => [number, number, number, number];
    readonly run_policy_is_lease_expired: (a: number, b: number) => number;
    readonly run_policy_lease_expires_at: (a: number, b: number) => number;
    readonly run_policy_node_policy_merge_plan: (a: any, b: any) => [number, number, number, number];
    readonly run_policy_normalize_cron: (a: any, b: any) => [number, number, number, number];
    readonly run_policy_normalize_enqueue: (a: any, b: any) => [number, number, number, number];
    readonly run_policy_normalize_timezone: (a: any, b: any, c: any) => [number, number, number, number];
    readonly run_policy_queue_sort_indexes: (a: any) => [number, number];
    readonly run_policy_recovery_preclean: (a: number, b: number) => [number, number];
    readonly run_policy_recovery_reconcile: (a: number, b: number, c: number, d: number) => [number, number];
    readonly run_policy_should_capture_screenshot: (a: number, b: number, c: number) => number;
    readonly run_policy_validate_cron: (a: number, b: number) => [number, number];
    readonly rustbrowserstate__queue_entries_for_test: (a: number, b: bigint) => [number, number, number, number];
    readonly rustbrowserstate__reset_queues_for_test: (a: number) => void;
    readonly rustbrowserstate__set_queue_mean_hold_for_test: (a: number, b: bigint, c: bigint) => void;
    readonly rustbrowserstate_active_locked_tab_count: (a: number) => number;
    readonly rustbrowserstate_admit_tab_lock: (a: number, b: bigint, c: number, d: number, e: number, f: number, g: bigint) => [number, number, number, number];
    readonly rustbrowserstate_aliases: (a: number, b: number, c: number) => [number, number, number, number];
    readonly rustbrowserstate_claim_tab: (a: number, b: number, c: number, d: bigint, e: number, f: number, g: bigint) => [number, number, number, number];
    readonly rustbrowserstate_clamp_tab_lock_timeout: (a: number, b: number) => [number, number, number, number];
    readonly rustbrowserstate_clear_last_window: (a: number, b: number, c: number, d: bigint) => [number, number, number];
    readonly rustbrowserstate_client_snapshot: (a: number, b: number, c: number) => [number, number, number, number];
    readonly rustbrowserstate_close_tab_queue: (a: number, b: bigint) => [number, number, number, number];
    readonly rustbrowserstate_consume_pacing_delay: (a: number, b: number, c: number, d: bigint, e: number) => [bigint, number, number];
    readonly rustbrowserstate_default_tab_lock_timeout: () => bigint;
    readonly rustbrowserstate_evict_stale_clients: (a: number, b: bigint) => number;
    readonly rustbrowserstate_handle_tab_removed: (a: number, b: bigint) => number;
    readonly rustbrowserstate_handle_window_removed: (a: number, b: bigint) => number;
    readonly rustbrowserstate_inspect_all_tab_queues: (a: number, b: bigint) => [number, number, number, number];
    readonly rustbrowserstate_inspect_tab_queue: (a: number, b: bigint, c: bigint) => [number, number, number, number];
    readonly rustbrowserstate_is_valid_alias: (a: number, b: number) => [number, number, number];
    readonly rustbrowserstate_mark_persisted: (a: number) => void;
    readonly rustbrowserstate_new: () => number;
    readonly rustbrowserstate_ownership_snapshot: (a: number) => [number, number, number, number];
    readonly rustbrowserstate_pacing: (a: number, b: number, c: number) => [number, number, number, number];
    readonly rustbrowserstate_persistence_dirty: (a: number) => number;
    readonly rustbrowserstate_plan_dispatch: (a: number, b: number, c: number, d: bigint) => [number, number, number, number];
    readonly rustbrowserstate_record_client_tab: (a: number, b: number, c: number, d: bigint, e: number, f: number, g: bigint) => [number, number];
    readonly rustbrowserstate_record_client_window: (a: number, b: number, c: number, d: bigint, e: bigint) => [number, number];
    readonly rustbrowserstate_release_client: (a: number, b: number, c: number, d: bigint) => [number, number, number];
    readonly rustbrowserstate_release_tab: (a: number, b: number, c: number, d: bigint) => [number, number, number];
    readonly rustbrowserstate_release_tab_lock: (a: number, b: bigint, c: bigint, d: bigint) => [number, number, number, number];
    readonly rustbrowserstate_resolve_alias: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly rustbrowserstate_resolve_owned_tab: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: bigint) => [number, number, number, number];
    readonly rustbrowserstate_resolve_owned_window: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly rustbrowserstate_resolve_target: (a: number, b: number, c: number, d: bigint) => [number, number, number, number];
    readonly rustbrowserstate_restore_ownership: (a: number, b: number, c: number, d: number, e: number, f: bigint) => [number, number, number, number];
    readonly rustbrowserstate_resume_dispatch: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly rustbrowserstate_set_alias: (a: number, b: number, c: number, d: number, e: number, f: bigint, g: bigint) => [number, number, number, number];
    readonly rustbrowserstate_set_pacing: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: bigint) => [number, number, number, number];
    readonly rustbrowserstate_tab_owner: (a: number, b: bigint) => [number, number];
    readonly rustbrowserstate_timeout_tab_lock: (a: number, b: bigint, c: bigint, d: bigint, e: bigint) => [number, number, number, number];
    readonly rusteditorsnapstate_compute: (a: number, b: any) => [number, number, number];
    readonly rusteditorsnapstate_distance_labels: (a: number, b: any) => [number, number, number];
    readonly rusteditorsnapstate_new: () => number;
    readonly rusteditorsnapstate_set_targets: (a: number, b: any) => [number, number];
    readonly rustembeddingcache_capacity: (a: number) => number;
    readonly rustembeddingcache_clear: (a: number) => void;
    readonly rustembeddingcache_get: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly rustembeddingcache_has: (a: number, b: number, c: number) => [number, number, number];
    readonly rustembeddingcache_new: (a: number) => number;
    readonly rustembeddingcache_set: (a: number, b: number, c: number, d: any, e: number) => [number, number];
    readonly rustembeddingcache_size: (a: number) => number;
    readonly rustembeddingcache_usage: (a: number) => number;
    readonly rustrunbreakpoints_add: (a: number, b: number, c: number) => [number, number];
    readonly rustrunbreakpoints_all: (a: number) => [number, number];
    readonly rustrunbreakpoints_clear: (a: number) => void;
    readonly rustrunbreakpoints_disable: (a: number, b: number, c: number) => [number, number];
    readonly rustrunbreakpoints_enable: (a: number, b: number, c: number) => [number, number];
    readonly rustrunbreakpoints_enabled: (a: number) => [number, number];
    readonly rustrunbreakpoints_has_breakpoint: (a: number, b: number, c: number) => [number, number, number];
    readonly rustrunbreakpoints_new: (a: number, b: number) => [number, number, number];
    readonly rustrunbreakpoints_remove: (a: number, b: number, c: number) => [number, number];
    readonly rustrunbreakpoints_set_all: (a: number, b: number, c: number) => [number, number];
    readonly rustrunbreakpoints_set_step_over: (a: number, b: number) => void;
    readonly rustrunbreakpoints_should_pause_at: (a: number, b: number, c: number) => [number, number, number];
    readonly rustrunbreakpoints_step_over: (a: number) => number;
    readonly rusttriggeradmission_admit: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly rusttriggeradmission_clear_installed: (a: number) => void;
    readonly rusttriggeradmission_finish: (a: number, b: number, c: number) => [number, number];
    readonly rusttriggeradmission_has_queue_cap: (a: number) => number;
    readonly rusttriggeradmission_install: (a: number, b: number, c: number) => [number, number];
    readonly rusttriggeradmission_installed_ids: (a: number) => [number, number];
    readonly rusttriggeradmission_is_started: (a: number) => number;
    readonly rusttriggeradmission_new: (a: any, b: any) => [number, number, number];
    readonly rusttriggeradmission_start: (a: number) => void;
    readonly rusttriggeradmission_stop: (a: number) => void;
    readonly rusttriggeradmission_uninstall: (a: number, b: number, c: number) => [number, number];
    readonly selector_action_target: (a: any, b: any) => [number, number, number];
    readonly selector_aria_to_css: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly selector_candidate_key: (a: number, b: number) => [number, number, number, number];
    readonly selector_clamp_action_integer: (a: any, b: number, c: number) => number;
    readonly selector_compare: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly selector_compose_composite: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly selector_compute_fingerprint: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly selector_css_escape_fallback: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly selector_derive_frame: (a: number, b: number) => [number, number, number, number];
    readonly selector_derive_tag_hint: (a: number, b: number, c: number) => [number, number, number, number];
    readonly selector_editor_locator_class_indexes: (a: number, b: number) => [number, number, number, number];
    readonly selector_editor_locator_plan: (a: number, b: number, c: number) => [number, number, number, number];
    readonly selector_editor_locator_select: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly selector_fingerprint_matches: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly selector_fingerprint_similarity: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly selector_is_composite: (a: number, b: number) => [number, number, number];
    readonly selector_legacy_aria_selectors: (a: number, b: number) => [number, number, number, number];
    readonly selector_matches_accessible_name: (a: any, b: any, c: number, d: number) => number;
    readonly selector_normalize_accessible_name: (a: any) => any;
    readonly selector_normalize_options: (a: number, b: number) => [number, number, number, number];
    readonly selector_parse_aria_expression: (a: number, b: number) => [number, number, number, number];
    readonly selector_parse_fingerprint: (a: number, b: number) => [number, number, number, number];
    readonly selector_parse_prefixed: (a: number, b: number) => [number, number, number, number];
    readonly selector_parse_role: (a: number, b: number) => [number, number, number, number];
    readonly selector_prefixed_candidate: (a: number, b: number) => [number, number, number, number];
    readonly selector_rank: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly selector_sort: (a: number, b: number) => [number, number, number, number];
    readonly selector_split_composite: (a: number, b: number) => [number, number, number, number];
    readonly selector_stability: (a: number, b: number) => [number, number, number, number];
    readonly selector_verify_fingerprint: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly semantic_ann_candidate_count: (a: number, b: number) => number;
    readonly semantic_chunk_text: (a: number, b: number) => [number, number, number, number];
    readonly semantic_chunks_for_indexing: (a: number, b: number, c: number) => [number, number, number, number];
    readonly semantic_cosine_similarity: (a: number, b: number, c: number, d: number) => number;
    readonly semantic_document_id: (a: bigint, b: number, c: bigint) => [number, number];
    readonly semantic_estimate_storage: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly semantic_indexed_page_key: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly semantic_is_indexable_content_url: (a: number, b: number) => [number, number, number];
    readonly semantic_is_rebuild_indexable_url: (a: number, b: number) => [number, number, number];
    readonly semantic_is_valid_contiguous_batch: (a: number, b: number, c: number) => number;
    readonly semantic_normalize_vector: (a: number, b: number) => [number, number];
    readonly semantic_pair_similarity_scores: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly semantic_plan_embedding_batch: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly semantic_plan_similarity_matrix: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly semantic_plan_similarity_pairs: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly semantic_similarity_matrix_scores: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly semantic_validate_embedding: (a: number, b: number, c: number) => [number, number];
    readonly semantic_validate_query_embedding: (a: number, b: number, c: number) => [number, number];
    readonly semantic_validate_similarity_input: (a: number, b: number) => [number, number];
    readonly semanticindex_apply_initialized_index_count: (a: number, b: number) => void;
    readonly semanticindex_auto_cleanup_plan: (a: number, b: number, c: number, d: number, e: bigint) => [number, number];
    readonly semanticindex_clear_indexed_pages: (a: number) => void;
    readonly semanticindex_commit_document: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly semanticindex_document_count: (a: number) => number;
    readonly semanticindex_has_indexed_page: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly semanticindex_indexed_page_count: (a: number) => number;
    readonly semanticindex_mark_indexed_page: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly semanticindex_mean_pool_normalized: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly semanticindex_new: () => number;
    readonly semanticindex_remove_label: (a: number, b: number) => [number, number];
    readonly semanticindex_remove_tab: (a: number, b: bigint) => [number, number];
    readonly semanticindex_reserve_label: (a: number) => number;
    readonly semanticindex_restore: (a: number, b: number, c: number) => [number, number];
    readonly semanticindex_search_results: (a: number, b: number, c: number) => [number, number, number, number];
    readonly semanticindex_snapshot: (a: number) => [number, number];
    readonly semanticindex_tab_count: (a: number) => number;
    readonly shared_catalog_help: (a: any) => [number, number, number];
    readonly shared_catalog_is_known: (a: any) => number;
    readonly shared_catalog_known_names: () => [number, number, number];
    readonly shared_catalog_resolve: (a: any, b: any) => [number, number, number];
    readonly shared_catalog_search: (a: any) => [number, number, number];
    readonly shared_catalog_suggest: (a: any, b: any) => [number, number, number];
    readonly shared_did_you_mean: (a: any, b: any, c: number) => any;
    readonly shared_is_sensitive_key: (a: any) => number;
    readonly shared_limit_string: (a: any, b: number) => [number, number, number];
    readonly shared_normalize_positive_int: (a: number, b: number) => number;
    readonly shared_sanitize_text: (a: any, b: number) => [number, number, number];
    readonly shared_suggested_next: (a: any, b: number) => [number, number, number];
    readonly shared_truncate_output_text: (a: any, b: number) => [number, number, number];
    readonly shared_truncate_received: (a: any) => [number, number, number];
    readonly shared_utf8_byte_length: (a: any) => [number, number, number];
    readonly shared_utf8_to_base64: (a: any) => [number, number, number, number];
    readonly tool_truncate_array: (a: any, b: number, c: number, d: number) => [number, number, number];
    readonly tool_truncate_json: (a: any, b: number, c: number, d: number) => [number, number, number];
    readonly tool_truncate_mode: (a: any) => [number, number];
    readonly tool_truncate_string: (a: any, b: number, c: number, d: number) => [number, number, number];
    readonly workflow_convert_v2_to_v3: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly workflow_convert_v2_trigger: (a: number, b: number) => [number, number, number, number];
    readonly workflow_convert_v3_to_v2: (a: number, b: number) => [number, number, number, number];
    readonly workflow_legacy_apply_assign: (a: any, b: any, c: any) => [number, number];
    readonly workflow_legacy_expand_templates_deep: (a: any, b: any) => [number, number, number];
    readonly workflow_legacy_handler_lookup: (a: any, b: any) => [number, number, number];
    readonly workflow_legacy_retry_delay: (a: any, b: number, c: number) => [number, number, number];
    readonly workflow_legacy_url_matches: (a: any, b: any) => number;
    readonly workflow_retry_delay: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly workflow_url_matches: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly workflowhandle_apply_variable_operations: (a: number, b: number, c: number) => [number, number];
    readonly workflowhandle_apply_variable_patch: (a: number, b: number, c: number) => [number, number];
    readonly workflowhandle_detect_cycle: (a: number) => [number, number];
    readonly workflowhandle_edge_index_by_label: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly workflowhandle_in_edge_indices: (a: number, b: number, c: number) => [number, number];
    readonly workflowhandle_new: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly workflowhandle_next_node: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly workflowhandle_node_index: (a: number, b: number, c: number) => number;
    readonly workflowhandle_out_edge_indices: (a: number, b: number, c: number) => [number, number];
    readonly workflowhandle_reachable_node_ids: (a: number) => [number, number];
    readonly workflowhandle_resolve_json: (a: number, b: number, c: number, d: any) => [number, number, number, number];
    readonly workflowhandle_resolve_number: (a: number, b: number, c: number, d: any) => [number, number, number];
    readonly workflowhandle_resolve_string: (a: number, b: number, c: number, d: any) => [number, number, number, number];
    readonly workflowhandle_validate_dag: (a: number) => [number, number];
    readonly workflowurlrules_matches: (a: number, b: number, c: number) => [number, number, number];
    readonly workflowurlrules_new: (a: number, b: number) => [number, number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
