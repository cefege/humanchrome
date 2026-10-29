//! Portable record/replay workflow policy with browser effects supplied by host adapters.
//!
//! This module intentionally owns graph traversal and data decisions, but not timers, storage,
//! URL parsing, locale collation, URI encoding, or user-expression execution. Those JavaScript
//! intrinsics are passed in at the narrow points where their observable semantics are required.

use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;
use serde_json::Value;

use crate::arguments::JsString;
use crate::graph::{self, RREdge, RRNode};
use crate::json_document::JsonDocument;

const DEFAULT_EDGE_LABEL: &str = "default";

/// A workflow node whose configuration retains lossless JSON strings and field order.
#[derive(Clone, Debug, PartialEq)]
pub struct WorkflowNode {
    /// Stable node identifier.
    pub id: String,
    /// Handler-selected node kind.
    pub kind: String,
    /// Optional display name.
    pub name: Option<JsString>,
    /// Whether the runner skips this node, preserving omitted versus explicit false.
    pub disabled: Option<bool>,
    /// Opaque handler configuration.
    pub config: JsonDocument,
    /// Optional canvas location used only for deterministic import root selection.
    pub ui: Option<CanvasPoint>,
}

/// A finite canvas coordinate supplied by the browser editor.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CanvasPoint {
    /// Horizontal coordinate.
    pub x: f64,
    /// Vertical coordinate.
    pub y: f64,
}

impl CanvasPoint {
    fn is_finite(self) -> bool {
        self.x.is_finite() && self.y.is_finite()
    }
}

/// A directed workflow edge in source order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkflowEdge {
    /// Stable edge identifier.
    pub id: String,
    /// Source node identifier.
    pub from: String,
    /// Target node identifier.
    pub to: String,
    /// Optional branch label; absence is equivalent to the default edge for traversal.
    pub label: Option<String>,
}

/// A reusable, indexed workflow graph.
///
/// Construction indexes the source graph once. Edge traversal thereafter only reads the owned
/// indexes; callers must not serialize the graph again for every branch decision.
#[derive(Clone, Debug)]
pub struct WorkflowFlow {
    /// Stable flow identifier.
    pub id: String,
    /// Explicit execution entry node.
    pub entry_node_id: String,
    /// Nodes in authored order.
    pub nodes: Vec<WorkflowNode>,
    /// Edges in authored order.
    pub edges: Vec<WorkflowEdge>,
    node_indexes: HashMap<String, usize>,
    out_edge_indexes: HashMap<String, Vec<usize>>,
    in_edge_indexes: HashMap<String, Vec<usize>>,
    adjacency: HashMap<String, Vec<String>>,
}

impl WorkflowFlow {
    /// Builds an indexed workflow without applying additional validation or normalization.
    #[must_use]
    pub fn new(
        id: String,
        entry_node_id: String,
        nodes: Vec<WorkflowNode>,
        edges: Vec<WorkflowEdge>,
    ) -> Self {
        let mut node_indexes = HashMap::with_capacity(nodes.len());
        let mut out_edge_indexes: HashMap<String, Vec<usize>> = HashMap::with_capacity(nodes.len());
        let mut in_edge_indexes: HashMap<String, Vec<usize>> = HashMap::with_capacity(nodes.len());
        let mut adjacency: HashMap<String, Vec<String>> = HashMap::with_capacity(nodes.len());

        for (index, node) in nodes.iter().enumerate() {
            // V3's public findNodeById uses Array.find, retaining the first duplicate id.
            node_indexes.entry(node.id.clone()).or_insert(index);
            out_edge_indexes.entry(node.id.clone()).or_default();
            in_edge_indexes.entry(node.id.clone()).or_default();
            adjacency.entry(node.id.clone()).or_default();
        }
        for (index, edge) in edges.iter().enumerate() {
            if let Some(out) = out_edge_indexes.get_mut(&edge.from) {
                out.push(index);
                adjacency
                    .entry(edge.from.clone())
                    .or_default()
                    .push(edge.to.clone());
            }
            if let Some(input) = in_edge_indexes.get_mut(&edge.to) {
                input.push(index);
            }
        }

        Self {
            id,
            entry_node_id,
            nodes,
            edges,
            node_indexes,
            out_edge_indexes,
            in_edge_indexes,
            adjacency,
        }
    }

    /// Returns the first authored node for an id, matching V3 `Array.find` lookup semantics.
    #[must_use]
    pub fn node(&self, id: &str) -> Option<&WorkflowNode> {
        self.node_indexes.get(id).map(|&index| &self.nodes[index])
    }

    /// Returns outgoing edges in original source order without allocating a graph projection.
    pub fn out_edges(&self, node_id: &str) -> impl Iterator<Item = &WorkflowEdge> {
        self.out_edge_indexes
            .get(node_id)
            .into_iter()
            .flatten()
            .map(|&index| &self.edges[index])
    }

    /// Returns incoming edges in original source order without allocating a graph projection.
    pub fn in_edges(&self, node_id: &str) -> impl Iterator<Item = &WorkflowEdge> {
        self.in_edge_indexes
            .get(node_id)
            .into_iter()
            .flatten()
            .map(|&index| &self.edges[index])
    }

    /// Finds the first source-ordered edge carrying `label`.
    #[must_use]
    pub fn edge_by_label(&self, node_id: &str, label: &str) -> Option<&WorkflowEdge> {
        self.out_edges(node_id)
            .find(|edge| edge.label.as_deref() == Some(label))
    }

    /// Selects the next node with V3 label/default/sole-edge precedence.
    #[must_use]
    pub fn next_node(&self, node_id: &str, label: Option<&str>) -> Option<&str> {
        let edges = self.out_edge_indexes.get(node_id)?;
        if edges.is_empty() {
            return None;
        }
        if let Some(label) = label.filter(|label| !label.is_empty())
            && let Some(edge) = edges
                .iter()
                .map(|&index| &self.edges[index])
                .find(|edge| edge.label.as_deref() == Some(label))
        {
            return Some(edge.to.as_str());
        }
        if let Some(edge) = edges
            .iter()
            .map(|&index| &self.edges[index])
            .find(|edge| matches!(edge.label.as_deref(), None | Some(DEFAULT_EDGE_LABEL)))
        {
            return Some(edge.to.as_str());
        }
        (edges.len() == 1).then(|| self.edges[edges[0]].to.as_str())
    }

    /// Validates entry and edge references, then reports the first DFS cycle path.
    #[must_use]
    pub fn validate_dag(&self) -> DagValidation {
        let node_ids: HashSet<&str> = self.nodes.iter().map(|node| node.id.as_str()).collect();
        let mut errors = Vec::new();
        if !node_ids.contains(self.entry_node_id.as_str()) {
            errors.push(WorkflowError::invalid(format!(
                "Entry node \"{}\" does not exist in flow",
                self.entry_node_id
            )));
        }
        for edge in &self.edges {
            if !node_ids.contains(edge.from.as_str()) {
                errors.push(WorkflowError::invalid(format!(
                    "Edge \"{}\" references non-existent source node \"{}\"",
                    edge.id, edge.from
                )));
            }
            if !node_ids.contains(edge.to.as_str()) {
                errors.push(WorkflowError::invalid(format!(
                    "Edge \"{}\" references non-existent target node \"{}\"",
                    edge.id, edge.to
                )));
            }
        }
        if let Some(cycle) = self.detect_cycle() {
            errors.push(WorkflowError::cycle(format!(
                "Cycle detected in flow: {}",
                cycle.join(" -> ")
            )));
        }
        DagValidation { errors }
    }

    /// Returns the DFS-discovered offending cycle, including its repeated terminal node.
    #[must_use]
    pub fn detect_cycle(&self) -> Option<Vec<String>> {
        let mut visited = HashSet::new();
        let mut stack = HashSet::new();
        let mut path = Vec::new();
        for node in &self.nodes {
            if !visited.contains(node.id.as_str())
                && self.visit_cycle(&node.id, &mut visited, &mut stack, &mut path)
            {
                return Some(path);
            }
        }
        None
    }

    fn visit_cycle(
        &self,
        node_id: &str,
        visited: &mut HashSet<String>,
        stack: &mut HashSet<String>,
        path: &mut Vec<String>,
    ) -> bool {
        visited.insert(node_id.to_owned());
        stack.insert(node_id.to_owned());
        path.push(node_id.to_owned());
        for neighbor in self.adjacency.get(node_id).into_iter().flatten() {
            if !visited.contains(neighbor.as_str()) {
                if self.visit_cycle(neighbor, visited, stack, path) {
                    return true;
                }
            } else if stack.contains(neighbor.as_str()) {
                let start = path.iter().position(|id| id == neighbor).unwrap_or(0);
                path.push(neighbor.clone());
                path.drain(..start);
                return true;
            }
        }
        path.pop();
        stack.remove(node_id);
        false
    }

    /// Visits all nodes reachable from the explicit entry id in DFS order.
    #[must_use]
    pub fn reachable_node_ids(&self) -> HashSet<String> {
        let mut reachable = HashSet::new();
        self.visit_reachable(&self.entry_node_id, &mut reachable);
        reachable
    }

    fn visit_reachable(&self, node_id: &str, reachable: &mut HashSet<String>) {
        if !reachable.insert(node_id.to_owned()) {
            return;
        }
        for neighbor in self.adjacency.get(node_id).into_iter().flatten() {
            self.visit_reachable(neighbor, reachable);
        }
    }

    /// Returns whether `node_id` is reachable from the explicit entry node.
    #[must_use]
    pub fn is_reachable(&self, node_id: &str) -> bool {
        self.reachable_node_ids().contains(node_id)
    }
}

/// A workflow validation error using the V3 public error code strings.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkflowError {
    /// V3-compatible error code.
    pub code: WorkflowErrorCode,
    /// V3-compatible error message.
    pub message: String,
}

impl WorkflowError {
    fn invalid(message: String) -> Self {
        Self {
            code: WorkflowErrorCode::DagInvalid,
            message,
        }
    }

    fn cycle(message: String) -> Self {
        Self {
            code: WorkflowErrorCode::DagCycle,
            message,
        }
    }
}

/// Workflow graph error categories exposed to the browser host.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkflowErrorCode {
    /// A node reference is invalid.
    DagInvalid,
    /// A directed cycle was found.
    DagCycle,
}

impl WorkflowErrorCode {
    /// Returns the V3 wire literal.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::DagInvalid => "DAG_INVALID",
            Self::DagCycle => "DAG_CYCLE",
        }
    }
}

/// The result of V3 DAG validation.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DagValidation {
    /// All missing-reference errors followed by at most one cycle error.
    pub errors: Vec<WorkflowError>,
}

impl DagValidation {
    /// Returns whether the flow satisfies V3 DAG validation.
    #[must_use]
    pub fn is_ok(&self) -> bool {
        self.errors.is_empty()
    }
}

/// Delegates legacy V1/V2 ordering to the shared graph implementation.
///
/// This deliberately keeps the legacy duplicate-id, unresolved-source, and cycle fallback
/// behavior in `graph.rs` rather than introducing a second record/replay graph algorithm.
pub fn legacy_topo_order<'source>(
    nodes: &'source [RRNode],
    edges: &[RREdge],
) -> Result<Vec<&'source RRNode>, graph::GraphError> {
    graph::topo_order(nodes, edges)
}

/// A host-provided locale comparator for JavaScript `String.prototype.localeCompare`.
pub trait LocaleCompare {
    /// Compares authored identifier strings with the host JavaScript locale semantics.
    fn locale_compare(&self, left: &str, right: &str) -> std::cmp::Ordering;
}

/// A V2 flow node used by the importer.
#[derive(Clone, Debug, PartialEq)]
pub struct V2Node {
    /// Node identifier.
    pub id: String,
    /// V2 node type.
    pub r#type: String,
    /// Optional node title.
    pub name: Option<JsString>,
    /// Whether the node is disabled, preserving omitted versus explicit false.
    pub disabled: Option<bool>,
    /// Lossless configuration object or value.
    pub config: Option<JsonDocument>,
    /// Optional editor coordinate.
    pub ui: Option<CanvasPoint>,
}

/// A V2 flow edge used by the importer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct V2Edge {
    /// Edge identifier.
    pub id: String,
    /// Source node identifier.
    pub from: String,
    /// Target node identifier.
    pub to: String,
    /// Optional edge label.
    pub label: Option<String>,
}

/// A V2 variable definition retained by the V3 conversion.
#[derive(Clone, Debug, PartialEq)]
pub struct V2Variable {
    /// Variable key.
    pub key: String,
    /// Optional display label.
    pub label: Option<JsString>,
    /// Whether a host must redact this value, preserving omission.
    pub sensitive: Option<bool>,
    /// Distinguishes absent default from explicit JSON null.
    pub default: Option<JsonDocument>,
    /// The V2 required rule, preserving omission.
    pub required: Option<bool>,
}

/// V2 metadata fields consumed by the conversion.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct V2Meta {
    /// Original created timestamp.
    pub created_at: Option<JsString>,
    /// Original updated timestamp.
    pub updated_at: Option<JsString>,
    /// Optional tags in source order.
    pub tags: Vec<JsString>,
    /// Optional URL bindings in source order.
    pub bindings: Vec<V2Binding>,
}

/// A V2 flow URL binding.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct V2Binding {
    /// `domain`, `path`, or `url` in the V2 wire format.
    pub r#type: String,
    /// Binding value.
    pub value: JsString,
}

/// Fully typed V2 input for the pure importer.
#[derive(Clone, Debug, PartialEq)]
pub struct V2Flow {
    /// Flow identifier.
    pub id: String,
    /// Flow name.
    pub name: JsString,
    /// Legacy flow schema version, retained for V3-to-V2 output.
    pub version: f64,
    /// Optional description.
    pub description: Option<JsString>,
    /// Optional metadata.
    pub meta: Option<V2Meta>,
    /// Variable definitions in source order.
    pub variables: Vec<V2Variable>,
    /// Nodes in source order.
    pub nodes: Vec<V2Node>,
    /// Edges in source order.
    pub edges: Vec<V2Edge>,
    /// Nonempty keys represent unsupported V2 subflows.
    pub subflow_ids: Vec<String>,
}

/// A V3 variable definition produced by V2 conversion.
#[derive(Clone, Debug, PartialEq)]
pub struct V3Variable {
    /// V3 variable name.
    pub name: String,
    /// Optional label.
    pub label: Option<JsString>,
    /// Whether values are sensitive, preserving omission.
    pub sensitive: Option<bool>,
    /// Preserved default.
    pub default: Option<JsonDocument>,
    /// V2 required rule carried into V3, preserving omission.
    pub required: Option<bool>,
}

/// V3 metadata retained by the importer.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct V3Meta {
    /// Tags in source order.
    pub tags: Vec<JsString>,
    /// URL bindings in source order.
    pub bindings: Vec<V3Binding>,
}

/// A V3 flow binding.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct V3Binding {
    /// `domain`, `path`, or `url`.
    pub kind: String,
    /// Binding value.
    pub value: JsString,
}

/// A V3 flow created by the V2 importer.
#[derive(Clone, Debug)]
pub struct V3Flow {
    /// V3 schema version, always three.
    pub schema_version: u8,
    /// Flow identifier.
    pub id: String,
    /// Flow name.
    pub name: JsString,
    /// Optional description.
    pub description: Option<JsString>,
    /// Original timestamp or host-supplied conversion timestamp.
    pub created_at: JsString,
    /// Original timestamp or host-supplied conversion timestamp.
    pub updated_at: JsString,
    /// Import-selected entry node.
    pub entry_node_id: String,
    /// Converted nodes in source order.
    pub nodes: Vec<WorkflowNode>,
    /// Converted edges in source order.
    pub edges: Vec<WorkflowEdge>,
    /// Nonempty converted variables.
    pub variables: Vec<V3Variable>,
    /// Nonempty converted metadata.
    pub meta: Option<V3Meta>,
}

impl V3Flow {
    /// Moves this flow into the reusable traversal object without serializing graph edges.
    #[must_use]
    pub fn into_workflow(self) -> WorkflowFlow {
        WorkflowFlow::new(self.id, self.entry_node_id, self.nodes, self.edges)
    }
}

/// The importer result preserves warnings even if validation prevents output.
#[derive(Clone, Debug)]
pub struct ConversionResult<T> {
    /// Conversion output when no fatal errors occurred.
    pub data: Option<T>,
    /// Fatal conversion errors in JavaScript source order.
    pub errors: Vec<String>,
    /// Nonfatal conversion warnings in JavaScript source order.
    pub warnings: Vec<String>,
}

impl<T> ConversionResult<T> {
    /// Returns whether conversion generated output.
    #[must_use]
    pub fn is_success(&self) -> bool {
        self.data.is_some()
    }
}

/// Converts a complete V2 flow into V3 without reading time or locale globals.
#[must_use]
pub fn convert_v2_flow(
    flow: &V2Flow,
    conversion_time: JsString,
    locale: &dyn LocaleCompare,
) -> ConversionResult<V3Flow> {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    if flow.id.is_empty() {
        errors.push(String::from("V2 Flow missing required field: id"));
    }
    if flow.name.utf16_len() == 0 {
        errors.push(String::from("V2 Flow missing required field: name"));
    }
    if flow.nodes.is_empty() {
        errors.push(String::from("V2 Flow has no nodes"));
    }
    if !flow.subflow_ids.is_empty() {
        errors.push(format!(
            "V3 does not support subflows yet. Flow contains subflows: {}",
            flow.subflow_ids.join(", ")
        ));
    }
    let unsupported: Vec<String> = flow
        .nodes
        .iter()
        .filter(|node| node.r#type == "foreach" || node.r#type == "while")
        .map(|node| format!("{} ({})", node.id, node.r#type))
        .collect();
    if !unsupported.is_empty() {
        errors.push(format!(
            "V3 does not support foreach/while nodes yet. Found: {}",
            unsupported.join(", ")
        ));
    }
    if !errors.is_empty() {
        return ConversionResult {
            data: None,
            errors,
            warnings,
        };
    }

    let mut nodes = Vec::with_capacity(flow.nodes.len());
    for node in &flow.nodes {
        if node.id.is_empty() || node.r#type.is_empty() {
            warnings.push(format!("Skipped invalid node: {}", node.id));
            continue;
        }
        nodes.push(WorkflowNode {
            id: node.id.clone(),
            kind: node.r#type.clone(),
            name: node.name.clone().filter(js_string_truthy),
            disabled: node.disabled.filter(|disabled| *disabled),
            config: node
                .config
                .clone()
                .filter(json_truthy)
                .unwrap_or_else(|| JsonDocument::from(Value::Object(Default::default()))),
            ui: node.ui,
        });
    }
    let mut edges = Vec::with_capacity(flow.edges.len());
    for edge in &flow.edges {
        if edge.id.is_empty() || edge.from.is_empty() || edge.to.is_empty() {
            warnings.push(format!("Skipped invalid edge: {}", edge.id));
            continue;
        }
        edges.push(WorkflowEdge {
            id: edge.id.clone(),
            from: edge.from.clone(),
            to: edge.to.clone(),
            label: edge.label.clone().filter(|label| !label.is_empty()),
        });
    }

    let entry = select_import_entry(&nodes, &edges, locale);
    warnings.extend(entry.warnings);
    let Some(entry_node_id) = entry.node_id else {
        errors.push(String::from(
            "Could not determine entry node. No valid root node found.",
        ));
        return ConversionResult {
            data: None,
            errors,
            warnings,
        };
    };
    let variables = flow
        .variables
        .iter()
        .filter(|variable| !variable.key.is_empty())
        .map(|variable| V3Variable {
            name: variable.key.clone(),
            label: variable.label.clone().filter(js_string_truthy),
            sensitive: variable.sensitive.filter(|sensitive| *sensitive),
            default: variable.default.clone(),
            required: variable.required.filter(|required| *required),
        })
        .collect();
    let meta = flow.meta.as_ref().and_then(|meta| {
        let tags = meta.tags.clone();
        let bindings: Vec<V3Binding> = meta
            .bindings
            .iter()
            .map(|binding| V3Binding {
                kind: binding.r#type.clone(),
                value: binding.value.clone(),
            })
            .collect();
        (!tags.is_empty() || !bindings.is_empty()).then_some(V3Meta { tags, bindings })
    });
    let created_at = flow
        .meta
        .as_ref()
        .and_then(|meta| meta.created_at.clone().filter(js_string_truthy))
        .unwrap_or_else(|| conversion_time.clone());
    let updated_at = flow
        .meta
        .as_ref()
        .and_then(|meta| meta.updated_at.clone().filter(js_string_truthy))
        .unwrap_or(conversion_time);
    ConversionResult {
        data: Some(V3Flow {
            schema_version: 3,
            id: flow.id.clone(),
            name: flow.name.clone(),
            description: flow.description.clone().filter(js_string_truthy),
            created_at,
            updated_at,
            entry_node_id,
            nodes,
            edges,
            variables,
            meta,
        }),
        errors,
        warnings,
    }
}

struct EntrySelection {
    node_id: Option<String>,
    warnings: Vec<String>,
}

fn select_import_entry(
    nodes: &[WorkflowNode],
    edges: &[WorkflowEdge],
    locale: &dyn LocaleCompare,
) -> EntrySelection {
    let executable: Vec<&WorkflowNode> =
        nodes.iter().filter(|node| node.kind != "trigger").collect();
    if executable.is_empty() {
        return EntrySelection {
            node_id: None,
            warnings: vec![String::from(
                "No executable nodes found; cannot determine entry node",
            )],
        };
    }
    let executable_ids: HashSet<&str> = executable.iter().map(|node| node.id.as_str()).collect();
    let mut indegree: HashMap<&str, usize> = executable
        .iter()
        .map(|node| (node.id.as_str(), 0))
        .collect();
    for edge in edges {
        if executable_ids.contains(edge.from.as_str()) && executable_ids.contains(edge.to.as_str())
        {
            *indegree.entry(edge.to.as_str()).or_default() += 1;
        }
    }
    let roots: Vec<&WorkflowNode> = executable
        .iter()
        .copied()
        .filter(|node| indegree.get(node.id.as_str()) == Some(&0))
        .collect();
    if roots.is_empty() {
        let (node, rule) = stable_root(&executable, locale);
        return EntrySelection {
            node_id: Some(node.id.clone()),
            warnings: vec![format!(
                "No inDegree=0 executable node found (graph may contain cycles); falling back to \"{}\" by {}",
                node.id, rule
            )],
        };
    }
    if roots.len() == 1 {
        return EntrySelection {
            node_id: Some(roots[0].id.clone()),
            warnings: Vec::new(),
        };
    }
    let (node, rule) = stable_root(&roots, locale);
    let mut ids: Vec<&str> = roots.iter().map(|root| root.id.as_str()).collect();
    ids.sort_by(|left, right| locale.locale_compare(left, right));
    EntrySelection {
        node_id: Some(node.id.clone()),
        warnings: vec![format!(
            "Multiple inDegree=0 executable nodes ({}); selected \"{}\" by {}",
            ids.join(", "),
            node.id,
            rule
        )],
    }
}

fn stable_root<'a>(
    nodes: &[&'a WorkflowNode],
    locale: &dyn LocaleCompare,
) -> (&'a WorkflowNode, String) {
    let mut with_ui: Vec<&WorkflowNode> = nodes
        .iter()
        .copied()
        .filter(|node| node.ui.is_some_and(CanvasPoint::is_finite))
        .collect();
    if !with_ui.is_empty() {
        with_ui.sort_by(|left, right| {
            let left_ui = left.ui.expect("filtered to finite canvas coordinates");
            let right_ui = right.ui.expect("filtered to finite canvas coordinates");
            if left_ui.x != right_ui.x {
                return left_ui
                    .x
                    .partial_cmp(&right_ui.x)
                    .expect("canvas coordinates are finite");
            }
            if left_ui.y != right_ui.y {
                return left_ui
                    .y
                    .partial_cmp(&right_ui.y)
                    .expect("canvas coordinates are finite");
            }
            locale.locale_compare(&left.id, &right.id)
        });
        let selected = with_ui[0];
        let ui = selected
            .ui
            .expect("selected node has finite canvas coordinates");
        return (
            selected,
            format!("ui(x={}, y={})", js_number(ui.x), js_number(ui.y)),
        );
    }
    let mut sorted = nodes.to_vec();
    sorted.sort_by(|left, right| locale.locale_compare(&left.id, &right.id));
    (sorted[0], String::from("id"))
}

fn js_number(value: f64) -> String {
    if value == 0.0 {
        return String::from("0");
    }
    ryu_js::Buffer::new().format(value).to_owned()
}

fn js_string_truthy(value: &JsString) -> bool {
    value.utf16_len() > 0
}

fn json_truthy(value: &JsonDocument) -> bool {
    if value.as_ref().is_null() {
        return false;
    }
    if let Some(value) = value.as_ref().as_bool() {
        return value;
    }
    if let Some(value) = value.as_ref().as_f64() {
        return value != 0.0 && !value.is_nan();
    }
    !value.as_ref().is_string() || value.to_js_string().utf16_len() > 0
}
/// Converts a V3 flow back to V2 for legacy builder editing.
#[must_use]
pub fn convert_v3_flow(flow: &V3Flow) -> ConversionResult<V2Flow> {
    let nodes = flow
        .nodes
        .iter()
        .map(|node| V2Node {
            id: node.id.clone(),
            r#type: node.kind.clone(),
            name: node.name.clone(),
            disabled: node.disabled,
            config: Some(node.config.clone()),
            ui: node.ui,
        })
        .collect();
    let edges = flow
        .edges
        .iter()
        .map(|edge| V2Edge {
            id: edge.id.clone(),
            from: edge.from.clone(),
            to: edge.to.clone(),
            label: edge.label.clone(),
        })
        .collect();
    let variables = flow
        .variables
        .iter()
        .map(|variable| V2Variable {
            key: variable.name.clone(),
            label: variable.label.clone(),
            sensitive: variable.sensitive,
            default: variable.default.clone(),
            required: variable.required,
        })
        .collect();
    let meta = V2Meta {
        created_at: Some(flow.created_at.clone()),
        updated_at: Some(flow.updated_at.clone()),
        tags: flow
            .meta
            .as_ref()
            .map_or_else(Vec::new, |meta| meta.tags.clone()),
        bindings: flow.meta.as_ref().map_or_else(Vec::new, |meta| {
            meta.bindings
                .iter()
                .map(|binding| V2Binding {
                    r#type: binding.kind.clone(),
                    value: binding.value.clone(),
                })
                .collect()
        }),
    };
    ConversionResult {
        data: Some(V2Flow {
            id: flow.id.clone(),
            name: flow.name.clone(),
            version: 2.0,
            description: flow.description.clone(),
            meta: Some(meta),
            variables,
            nodes,
            edges,
            subflow_ids: Vec::new(),
        }),
        errors: Vec::new(),
        warnings: Vec::new(),
    }
}

/// V2 trigger kinds accepted by the importer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum V2TriggerKind {
    /// Run by URL matching.
    Url,
    /// Run by configured command.
    Command,
    /// Run only when directly requested.
    Manual,
    /// Run on a V2 schedule.
    Schedule,
    /// Run from a legacy DOM element trigger.
    Element,
    /// An unrecognized source type retained so raw imports return the existing error.
    Unknown(JsString),
}

/// V2 schedule forms accepted by the importer.
#[derive(Clone, Debug, PartialEq)]
pub enum V2Schedule {
    /// Repeats at a millisecond interval.
    Interval { interval_ms: f64 },
    /// Runs at an optional `HH:MM` time.
    Daily { time: Option<JsString> },
    /// Runs on optional weekday numbers at an optional `HH:MM` time.
    ///
    /// `None` is the source field being omitted; `Some(vec![])` is an explicit empty array.
    Weekly {
        time: Option<JsString>,
        days: Option<Vec<i64>>,
    },
}

/// Typed V2 trigger input for pure conversion.
#[derive(Clone, Debug, PartialEq)]
pub struct V2Trigger {
    /// Trigger identifier.
    pub id: String,
    /// Trigger kind.
    pub kind: Option<V2TriggerKind>,
    /// Owning flow identifier.
    pub flow_id: String,
    /// Explicit enabled value; absent defaults to true.
    pub enabled: Option<bool>,
    /// URL rules for URL triggers.
    pub matches: Vec<UrlMatchRule>,
    /// Optional command key.
    pub command_key: Option<JsString>,
    /// Optional V2 schedule.
    pub schedule: Option<V2Schedule>,
}

/// V3 trigger forms produced by the importer.
#[derive(Clone, Debug, PartialEq)]
pub enum V3Trigger {
    /// Manual trigger.
    Manual {
        id: String,
        flow_id: String,
        enabled: bool,
    },
    /// URL trigger rules.
    Url {
        id: String,
        flow_id: String,
        enabled: bool,
        matches: Vec<UrlMatchRule>,
    },
    /// Command trigger.
    Command {
        id: String,
        flow_id: String,
        enabled: bool,
        command_key: JsString,
    },
    /// Cron trigger.
    Cron {
        id: String,
        flow_id: String,
        enabled: bool,
        cron: JsString,
    },
}

/// Converts a V2 trigger to its V3 equivalent, retaining source error and warning text.
#[must_use]
pub fn convert_v2_trigger(
    trigger: &V2Trigger,
    strings: &dyn StringIntrinsics,
) -> ConversionResult<V3Trigger> {
    let mut errors = Vec::new();
    let warnings = Vec::new();
    if trigger.id.is_empty() {
        errors.push(String::from("V2 Trigger missing required field: id"));
    }
    if trigger.flow_id.is_empty() {
        errors.push(String::from("V2 Trigger missing required field: flowId"));
    }
    if trigger.kind.is_none() {
        errors.push(String::from("V2 Trigger missing required field: type"));
    }
    if !errors.is_empty() {
        return ConversionResult {
            data: None,
            errors,
            warnings,
        };
    }
    let enabled = trigger.enabled.unwrap_or(true);
    let data = match trigger.kind.as_ref().expect("validated trigger kind") {
        V2TriggerKind::Manual => V3Trigger::Manual {
            id: trigger.id.clone(),
            flow_id: trigger.flow_id.clone(),
            enabled,
        },
        V2TriggerKind::Command => V3Trigger::Command {
            id: trigger.id.clone(),
            flow_id: trigger.flow_id.clone(),
            enabled,
            command_key: trigger
                .command_key
                .clone()
                .filter(|key| key.utf16_len() > 0)
                .unwrap_or_else(|| JsString::from_string("run_workflow")),
        },
        V2TriggerKind::Url => V3Trigger::Url {
            id: trigger.id.clone(),
            flow_id: trigger.flow_id.clone(),
            enabled,
            matches: trigger.matches.clone(),
        },
        V2TriggerKind::Schedule => {
            let Some(schedule) = trigger.schedule.as_ref() else {
                return ConversionResult {
                    data: None,
                    errors: vec![String::from(
                        "Could not convert V2 schedule to cron expression",
                    )],
                    warnings,
                };
            };
            let cron = schedule_to_cron(schedule, strings);
            V3Trigger::Cron {
                id: trigger.id.clone(),
                flow_id: trigger.flow_id.clone(),
                enabled,
                cron,
            }
        }
        V2TriggerKind::Unknown(kind) => {
            return ConversionResult {
                data: None,
                errors: vec![format!(
                    "Unknown V2 trigger type: {}",
                    kind.to_string_lossy()
                )],
                warnings,
            };
        }
        V2TriggerKind::Element => {
            return ConversionResult {
                data: Some(V3Trigger::Manual {
                    id: trigger.id.clone(),
                    flow_id: trigger.flow_id.clone(),
                    enabled,
                }),
                errors,
                warnings: vec![String::from(
                    "Element trigger is not fully supported in V3, converting to manual",
                )],
            };
        }
    };
    ConversionResult {
        data: Some(data),
        errors,
        warnings,
    }
}

fn schedule_to_cron(schedule: &V2Schedule, strings: &dyn StringIntrinsics) -> JsString {
    let hour_minute = |time: Option<&JsString>| {
        let Some(time) = time.and_then(JsString::to_string_if_well_formed) else {
            return (String::from("0"), String::from("0"));
        };
        let mut parts = time.split(':');
        let hour = parts
            .next()
            .map(|part| strings.number_from_string(&JsString::from_string(part)))
            .unwrap_or(f64::NAN);
        let minute = parts
            .next()
            .map(|part| strings.number_from_string(&JsString::from_string(part)))
            .unwrap_or(f64::NAN);
        (
            js_truthy_number_or_zero(hour),
            js_truthy_number_or_zero(minute),
        )
    };
    match schedule {
        V2Schedule::Interval { interval_ms } => {
            let source_interval = if interval_ms.is_nan() || *interval_ms == 0.0 {
                60_000.0
            } else {
                *interval_ms
            };
            let minutes = js_round(source_interval / 60_000.0).max(1.0);
            if minutes < 60.0 {
                JsString::from_owned_string(format!(
                    "*/{} * * * *",
                    js_truthy_number_or_zero(minutes)
                ))
            } else {
                JsString::from_owned_string(format!(
                    "0 */{} * * *",
                    js_truthy_number_or_zero(js_round(minutes / 60.0))
                ))
            }
        }
        V2Schedule::Daily { time } => {
            let (hour, minute) = hour_minute(time.as_ref());
            JsString::from_owned_string(format!("{minute} {hour} * * *"))
        }
        V2Schedule::Weekly { time, days } => {
            let (hour, minute) = hour_minute(time.as_ref());
            let days = match days {
                None => String::from("0"),
                Some(days) => days
                    .iter()
                    .map(|day| day.to_string())
                    .collect::<Vec<_>>()
                    .join(","),
            };
            JsString::from_owned_string(format!("{minute} {hour} * * {days}"))
        }
    }
}

fn js_round(value: f64) -> f64 {
    if value.is_nan() || value.is_infinite() {
        return value;
    }
    (value + 0.5).floor()
}

fn js_truthy_number_or_zero(value: f64) -> String {
    if value.is_nan() || value == 0.0 {
        return String::from("0");
    }
    if value == f64::INFINITY {
        return String::from("Infinity");
    }
    if value == f64::NEG_INFINITY {
        return String::from("-Infinity");
    }
    ryu_js::Buffer::new().format(value).to_owned()
}

/// A parsed browser URL supplied by the host `URL` intrinsic.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UrlParts {
    /// Browser `URL.hostname` value.
    pub hostname: String,
    /// Browser `URL.pathname` value.
    pub pathname: String,
}

/// One URL trigger rule.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UrlMatchRule {
    /// `url`, `domain`, or `path`.
    pub kind: UrlMatchKind,
    /// Unnormalized authored value.
    pub value: JsString,
}

/// URL trigger matching modes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UrlMatchKind {
    /// Raw URL-string prefix.
    Url,
    /// Exact hostname or subdomain.
    Domain,
    /// Raw pathname prefix.
    Path,
}

/// Normalized URL rules reusable across navigation events.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CompiledUrlRules {
    url_prefixes: Vec<JsString>,
    domains: Vec<JsString>,
    path_prefixes: Vec<JsString>,
}

impl CompiledUrlRules {
    /// Compiles source-ordered rules with the V3 normalization policy.
    #[must_use]
    pub fn compile(rules: &[UrlMatchRule], strings: &dyn StringIntrinsics) -> Self {
        let mut compiled = Self::default();
        for rule in rules {
            match rule.kind {
                UrlMatchKind::Url => {
                    if let Some(value) = trim_js_string(&rule.value, strings) {
                        compiled.url_prefixes.push(value);
                    }
                }
                UrlMatchKind::Domain => {
                    if let Some(value) = normalize_domain(&rule.value, strings) {
                        compiled.domains.push(value);
                    }
                }
                UrlMatchKind::Path => {
                    if let Some(mut value) = trim_js_string(&rule.value, strings) {
                        if !strings.starts_with(&value, &JsString::from_string("/")) {
                            let mut prefixed = JsString::from_string("/");
                            prefixed.push_js_string(&value);
                            value = prefixed;
                        }
                        compiled.path_prefixes.push(value);
                    }
                }
            }
        }
        compiled
    }

    /// Matches raw URL, hostname, and pathname using host-parsed URL parts.
    #[must_use]
    pub fn matches(
        &self,
        raw_url: &JsString,
        parsed: &UrlParts,
        strings: &dyn StringIntrinsics,
    ) -> bool {
        self.url_prefixes
            .iter()
            .any(|prefix| strings.starts_with(raw_url, prefix))
            || self
                .domains
                .iter()
                .any(|domain| hostname_matches_domain(&parsed.hostname, domain, strings))
            || self.path_prefixes.iter().any(|prefix| {
                let pathname = if parsed.pathname.is_empty() {
                    "/"
                } else {
                    &parsed.pathname
                };
                strings.starts_with(&JsString::from_string(pathname), prefix)
            })
    }
}

fn normalize_domain(value: &JsString, strings: &dyn StringIntrinsics) -> Option<JsString> {
    let lower = strings.to_lower_case(&strings.trim(value));
    let mut units: Vec<u16> = lower.utf16_units().collect();
    let start = units
        .iter()
        .position(|unit| *unit != u16::from(b'.'))
        .unwrap_or(units.len());
    let end = units
        .iter()
        .rposition(|unit| *unit != u16::from(b'.'))
        .map_or(0, |index| index + 1);
    if start >= end {
        return None;
    }
    units.copy_within(start..end, 0);
    units.truncate(end - start);
    Some(JsString::from_utf16_units(units))
}

fn trim_js_string(value: &JsString, strings: &dyn StringIntrinsics) -> Option<JsString> {
    let trimmed = strings.trim(value);
    (trimmed.utf16_len() > 0).then_some(trimmed)
}

fn hostname_matches_domain(
    hostname: &str,
    domain: &JsString,
    strings: &dyn StringIntrinsics,
) -> bool {
    let hostname = strings.to_lower_case(&JsString::from_string(hostname));
    if hostname == *domain {
        return true;
    }
    let mut suffix = JsString::from_string(".");
    suffix.push_js_string(domain);
    strings.ends_with(&hostname, &suffix)
}

/// Retry backoff kinds used by V3 runner policy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RetryBackoff {
    /// Keep the base interval.
    None,
    /// Multiply the base by the attempt number.
    Linear,
    /// Double the base for each attempt after the first.
    Exponential,
}

/// Retry jitter modes used by V3 runner policy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RetryJitter {
    /// Return the computed delay unchanged.
    None,
    /// Select an inclusive random delay from zero through the computed delay.
    Full,
}

/// Retry timing policy; all inputs are explicit and timer-free.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RetryPolicy {
    /// Base interval in milliseconds.
    pub interval_ms: f64,
    /// Optional interval cap.
    pub max_interval_ms: Option<f64>,
    /// Backoff curve.
    pub backoff: RetryBackoff,
    /// Jitter mode.
    pub jitter: RetryJitter,
}

/// Computes V3 runner retry delay from an explicit JavaScript random sample.
#[must_use]
pub fn compute_retry_delay_ms(policy: RetryPolicy, attempt: f64, random_sample: f64) -> f64 {
    let base = policy.interval_ms.max(0.0);
    let mut delay = match policy.backoff {
        RetryBackoff::None => base,
        RetryBackoff::Linear => base * attempt,
        RetryBackoff::Exponential => base * 2_f64.powf((attempt - 1.0).max(0.0)),
    };
    if let Some(max_interval_ms) = policy.max_interval_ms {
        delay = delay.min(max_interval_ms.max(0.0));
    }
    if policy.jitter == RetryJitter::Full {
        // JavaScript Math.random is supplied by the host. The runner's inclusive `delay + 1`
        // deliberately differs from the legacy registry's exclusive jitter range.
        delay = (random_sample * (delay + 1.0)).floor();
    }
    delay.max(0.0).floor()
}

/// A variable path segment used by structured resolution.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VariablePathSegment {
    /// Object property name.
    Key(String),
    /// Array offset.
    Index(i64),
}

/// A reference into a host-owned variable store.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VariablePointer {
    /// Variable name; scopes are intentionally host policy and do not affect legacy lookup.
    pub name: String,
    /// Optional nested field path.
    pub path: Vec<VariablePathSegment>,
}

/// A structured value that can be resolved by variables, expressions, or templates.
#[derive(Clone, Debug, PartialEq)]
pub enum Resolvable {
    /// A literal JSON value.
    Literal(JsonDocument),
    /// A variable reference with an optional explicit default.
    Variable {
        reference: VariablePointer,
        default: Option<JsonDocument>,
    },
    /// A user expression remains in the existing JavaScript sandbox.
    Expression {
        expression: JsonDocument,
        default: Option<JsonDocument>,
    },
    /// A string template with its unmodified JSON representation for generic resolution.
    Template {
        /// The exact authored object returned by generic JSON resolution.
        authored: JsonDocument,
        /// Parsed parts used only by string resolution.
        parts: Vec<TemplatePart>,
    },
}

/// One string-template fragment.
#[derive(Clone, Debug, PartialEq)]
pub enum TemplatePart {
    /// Literal text.
    Text(JsString),
    /// A resolved JSON insertion with formatting requested by the author.
    Insert {
        value: Box<Resolvable>,
        format: TemplateFormat,
    },
    /// A malformed part carried from host decoding for exact resolver errors.
    Invalid,
    /// An unknown authored kind carried from host decoding for exact resolver errors.
    Unknown { kind: JsString },
}

/// String-template insertion formatting.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TemplateFormat {
    /// JavaScript ordinary string coercion, except null becomes empty.
    Text,
    /// JavaScript JSON serialization.
    Json,
    /// JavaScript `encodeURIComponent` after text formatting.
    UrlEncoded,
}

/// The variable environment passed from the host without evaluating application policy.
pub type VariableStore = IndexMap<String, JsonDocument>;

/// Reusable flow plus variable context for one workflow run.
///
/// The browser owns scheduling, storage transactions, and action execution; this object keeps
/// graph indexes and variable data local to the WASM realm between those host effects.
#[derive(Clone, Debug)]
pub struct WorkflowContext {
    flow: WorkflowFlow,
    variables: VariableStore,
}

impl WorkflowContext {
    /// Owns an indexed flow and its initial variable snapshot for repeated transitions.
    #[must_use]
    pub fn new(flow: WorkflowFlow, variables: VariableStore) -> Self {
        Self { flow, variables }
    }

    /// Returns the reusable graph state without reserializing it.
    #[must_use]
    pub fn flow(&self) -> &WorkflowFlow {
        &self.flow
    }

    /// Returns the current variable snapshot.
    #[must_use]
    pub fn variables(&self) -> &VariableStore {
        &self.variables
    }

    /// Gives the host controlled access to apply its already-decided variable patch.
    pub fn variables_mut(&mut self) -> &mut VariableStore {
        &mut self.variables
    }

    /// Resolves values against the current context and host-only expression/string intrinsics.
    #[must_use]
    pub fn resolver<'host>(
        &'host self,
        expressions: &'host dyn ExpressionEvaluator,
        strings: &'host dyn StringIntrinsics,
    ) -> Resolver<'host> {
        Resolver::new(&self.variables, expressions, strings)
    }
}

/// A narrow host callback for existing user-expression sandbox results.
pub trait ExpressionEvaluator {
    /// Evaluates one serialized expression in the existing host sandbox.
    fn evaluate(&self, expression: &JsonDocument) -> Result<JsonDocument, String>;
}

/// A narrow host callback for JavaScript string intrinsics.
pub trait StringIntrinsics {
    /// Implements browser `String.prototype.trim` for authored URL rules.
    fn trim(&self, value: &JsString) -> JsString;

    /// Implements browser `String.prototype.toLowerCase` for authored domain rules.
    fn to_lower_case(&self, value: &JsString) -> JsString;

    /// Implements browser `String.prototype.startsWith` over UTF-16 code units.
    fn starts_with(&self, value: &JsString, prefix: &JsString) -> bool;

    /// Implements browser `String.prototype.endsWith` over UTF-16 code units.
    fn ends_with(&self, value: &JsString, suffix: &JsString) -> bool;

    /// Implements browser `encodeURIComponent` without moving template policy into JavaScript.
    fn encode_uri_component(&self, value: &JsString) -> JsString;

    /// Implements JavaScript `Number(string)` for all browser string inputs.
    fn number_from_string(&self, value: &JsString) -> f64;
}

/// The no-expression resolver used for legacy default behavior.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoExpressionEvaluator;

impl ExpressionEvaluator for NoExpressionEvaluator {
    fn evaluate(&self, _expression: &JsonDocument) -> Result<JsonDocument, String> {
        Err(String::from(
            "Expression value is not supported by the default resolver",
        ))
    }
}

/// Structured resolver retaining JavaScript missing/null/default distinctions.
pub struct Resolver<'host> {
    variables: &'host VariableStore,
    expressions: &'host dyn ExpressionEvaluator,
    strings: &'host dyn StringIntrinsics,
}

impl<'host> Resolver<'host> {
    /// Creates a resolver over a stable variable snapshot and narrow host intrinsics.
    #[must_use]
    pub fn new(
        variables: &'host VariableStore,
        expressions: &'host dyn ExpressionEvaluator,
        strings: &'host dyn StringIntrinsics,
    ) -> Self {
        Self {
            variables,
            expressions,
            strings,
        }
    }

    /// Resolves generic JSON values with the legacy variable/default/expression behavior.
    pub fn json(&self, value: &Resolvable) -> Result<JsonDocument, String> {
        match value {
            Resolvable::Literal(value) => Ok(value.clone()),
            Resolvable::Variable { reference, default } => Ok(self
                .read_variable(reference)
                .or_else(|| default.clone())
                .unwrap_or_else(|| JsonDocument::from(Value::Null))),
            Resolvable::Expression {
                expression,
                default,
            } => self
                .expressions
                .evaluate(expression)
                .or_else(|error| default.clone().ok_or(error)),
            Resolvable::Template { authored, .. } => Ok(authored.clone()),
        }
    }

    /// Resolves a string, preserving JavaScript UTF-16 units in its return type.
    pub fn string(&self, value: &Resolvable) -> Result<JsString, String> {
        match value {
            Resolvable::Literal(value) if value.as_ref().is_string() => Ok(value.to_js_string()),
            Resolvable::Variable { reference, default } => {
                if let Some(resolved) = self
                    .read_variable(reference)
                    .filter(|value| !value.as_ref().is_null())
                {
                    return Ok(resolved.to_js_string());
                }
                if let Some(default) = default.as_ref().filter(|value| value.as_ref().is_string()) {
                    return Ok(default.to_js_string());
                }
                Ok(JsString::from_string(""))
            }
            Resolvable::Template { parts, .. } => self.resolve_template(parts),
            Resolvable::Expression {
                expression,
                default,
            } => match self.expressions.evaluate(expression) {
                Ok(value) => Ok(value.to_js_string()),
                Err(error) => default
                    .as_ref()
                    .filter(|value| value.as_ref().is_string())
                    .map(JsonDocument::to_js_string)
                    .ok_or(error),
            },
            _ => Err(String::from("Unsupported resolvable string value")),
        }
    }

    /// Resolves a finite JavaScript number through the host Number intrinsic when needed.
    pub fn number(&self, value: &Resolvable) -> Result<f64, String> {
        match value {
            Resolvable::Literal(value) => value
                .as_ref()
                .as_f64()
                .filter(|number| number.is_finite())
                .ok_or_else(|| String::from("Unsupported resolvable number value")),
            Resolvable::Variable { reference, default } => {
                let number =
                    self.read_variable(reference)
                        .and_then(|value| match value.as_ref().as_f64() {
                            Some(number) if number.is_finite() => Some(number),
                            _ if value.as_ref().is_string() => {
                                let text = value.to_js_string();
                                if self.strings.trim(&text).utf16_len() == 0 {
                                    None
                                } else {
                                    let number = self.strings.number_from_string(&text);
                                    number.is_finite().then_some(number)
                                }
                            }
                            _ => None,
                        });
                number
                    .or_else(|| {
                        default
                            .as_ref()
                            .and_then(|value| value.as_ref().as_f64())
                            .filter(|number| number.is_finite())
                    })
                    .ok_or_else(|| {
                        format!("Variable \"{}\" is not a finite number", reference.name)
                    })
            }
            Resolvable::Expression {
                expression,
                default,
            } => match self.expressions.evaluate(expression) {
                Ok(value) => value
                    .as_ref()
                    .as_f64()
                    .filter(|number| number.is_finite())
                    .ok_or_else(|| {
                        String::from("Expression value is not supported by the default resolver")
                    }),
                Err(error) => default
                    .as_ref()
                    .and_then(|value| value.as_ref().as_f64())
                    .filter(|number| number.is_finite())
                    .ok_or(error),
            },
            Resolvable::Template { .. } => Err(String::from("Unsupported resolvable number value")),
        }
    }

    fn read_variable(&self, reference: &VariablePointer) -> Option<JsonDocument> {
        let mut value = self.variables.get(&reference.name)?.clone();
        for segment in &reference.path {
            value = match segment {
                VariablePathSegment::Key(key) if value.as_ref().is_array() => {
                    let values = value.into_array_values()?;
                    if key == "length" {
                        JsonDocument::from(Value::from(values.len() as u64))
                    } else {
                        let index = crate::json::array_index(key)?;
                        values.into_iter().nth(index as usize)?
                    }
                }
                VariablePathSegment::Key(key) => value.get(key)?.to_owned(),
                VariablePathSegment::Index(index) => {
                    let index = usize::try_from(*index).ok()?;
                    value.into_array_values()?.into_iter().nth(index)?
                }
            };
        }
        Some(value)
    }

    fn resolve_template(&self, parts: &[TemplatePart]) -> Result<JsString, String> {
        if parts.is_empty() {
            return Err(String::from("Unsupported resolvable string value"));
        }
        let mut output = JsString::from_string("");
        for part in parts {
            match part {
                TemplatePart::Text(text) => output.push_js_string(text),
                TemplatePart::Insert { value, format } => {
                    let value = self.json(value)?;
                    let inserted = match format {
                        TemplateFormat::Text => {
                            if value.as_ref().is_null() {
                                JsString::from_string("")
                            } else {
                                value.to_js_string()
                            }
                        }
                        TemplateFormat::Json => JsString::from_owned_string(value.to_json_text()),
                        TemplateFormat::UrlEncoded => {
                            let text = if value.as_ref().is_null() {
                                JsString::from_string("")
                            } else {
                                value.to_js_string()
                            };
                            self.strings.encode_uri_component(&text)
                        }
                    };
                    output.push_js_string(&inserted);
                }
                TemplatePart::Invalid => return Err(String::from("Invalid template part")),
                TemplatePart::Unknown { kind } => {
                    return Err(format!(
                        "Unknown template part kind: {}",
                        kind.to_string_lossy()
                    ));
                }
            }
        }
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestStrings;

    impl StringIntrinsics for TestStrings {
        fn trim(&self, value: &JsString) -> JsString {
            JsString::from_owned_string(
                value
                    .to_string_if_well_formed()
                    .expect("test strings are well-formed")
                    .trim()
                    .to_owned(),
            )
        }

        fn to_lower_case(&self, value: &JsString) -> JsString {
            JsString::from_owned_string(
                value
                    .to_string_if_well_formed()
                    .expect("test strings are well-formed")
                    .to_lowercase(),
            )
        }

        fn starts_with(&self, value: &JsString, prefix: &JsString) -> bool {
            value
                .to_string_if_well_formed()
                .expect("test strings are well-formed")
                .starts_with(
                    &prefix
                        .to_string_if_well_formed()
                        .expect("test strings are well-formed"),
                )
        }

        fn ends_with(&self, value: &JsString, suffix: &JsString) -> bool {
            value
                .to_string_if_well_formed()
                .expect("test strings are well-formed")
                .ends_with(
                    &suffix
                        .to_string_if_well_formed()
                        .expect("test strings are well-formed"),
                )
        }

        fn encode_uri_component(&self, value: &JsString) -> JsString {
            value.clone()
        }

        fn number_from_string(&self, value: &JsString) -> f64 {
            value
                .to_string_if_well_formed()
                .expect("test strings are well-formed")
                .parse()
                .unwrap_or(f64::NAN)
        }
    }

    #[test]
    fn blank_numeric_variable_uses_default_or_reports_original_error() {
        let mut variables = VariableStore::new();
        variables.insert(String::from("delay"), JsonDocument::from(" \t"));
        let strings = TestStrings;
        let resolver = Resolver::new(&variables, &NoExpressionEvaluator, &strings);
        let reference = VariablePointer {
            name: String::from("delay"),
            path: Vec::new(),
        };

        assert_eq!(
            resolver.number(&Resolvable::Variable {
                reference: reference.clone(),
                default: Some(JsonDocument::from(Value::from(1_000))),
            }),
            Ok(1_000.0)
        );
        assert_eq!(
            resolver.number(&Resolvable::Variable {
                reference,
                default: None,
            }),
            Err(String::from("Variable \"delay\" is not a finite number"))
        );
    }

    #[test]
    fn array_string_path_reads_index_and_length() {
        let mut variables = VariableStore::new();
        variables.insert(
            String::from("items"),
            JsonDocument::parse(r#"["first"]"#).expect("valid test JSON"),
        );
        let strings = TestStrings;
        let resolver = Resolver::new(&variables, &NoExpressionEvaluator, &strings);

        for (path, expected) in [("0", "\"first\""), ("length", "1")] {
            let value = resolver
                .json(&Resolvable::Variable {
                    reference: VariablePointer {
                        name: String::from("items"),
                        path: vec![VariablePathSegment::Key(String::from(path))],
                    },
                    default: None,
                })
                .expect("array property resolves");
            assert_eq!(value.to_json_text(), expected);
        }
    }

    #[test]
    fn generic_resolution_retains_template_object() {
        let variables = VariableStore::new();
        let strings = TestStrings;
        let resolver = Resolver::new(&variables, &NoExpressionEvaluator, &strings);
        let authored =
            JsonDocument::parse(r#"{"kind":"template","parts":[]}"#).expect("valid test JSON");
        let value = Resolvable::Template {
            authored: authored.clone(),
            parts: Vec::new(),
        };

        assert_eq!(resolver.json(&value), Ok(authored));
        assert_eq!(
            resolver.string(&value),
            Err(String::from("Unsupported resolvable string value"))
        );
    }

    #[test]
    fn weekly_days_omission_differs_from_explicit_empty_array() {
        let strings = TestStrings;
        let omitted = schedule_to_cron(
            &V2Schedule::Weekly {
                time: None,
                days: None,
            },
            &strings,
        );
        let empty = schedule_to_cron(
            &V2Schedule::Weekly {
                time: None,
                days: Some(Vec::new()),
            },
            &strings,
        );

        assert_eq!(
            omitted.to_string_if_well_formed(),
            Some(String::from("0 0 * * 0"))
        );
        assert_eq!(
            empty.to_string_if_well_formed(),
            Some(String::from("0 0 * * "))
        );
    }
}
