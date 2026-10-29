//! Generated browser and native wire contracts, authored in the shared TypeScript package.

use std::sync::LazyLock;

/// The deterministic artifact produced by `pnpm build:contracts`.
pub const CONTRACT_JSON: &str =
    include_str!("../../../packages/shared/generated/rust-contract.json");

/// Parsed contract data retains JavaScript object insertion order.
pub static CONTRACT: LazyLock<serde_json::Value> = LazyLock::new(|| {
    serde_json::from_str(CONTRACT_JSON).expect("generated rust-contract.json must be valid JSON")
});
