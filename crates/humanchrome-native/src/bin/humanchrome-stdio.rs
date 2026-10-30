//! Stdio MCP entrypoint that proxies to an already-running HumanChrome bridge.

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    humanchrome_native::stdio_proxy::run().await
}
