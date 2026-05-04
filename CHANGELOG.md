# Changelog

All notable changes to HumanChrome are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] — 2026-05-03

Initial public release.

### Added

- `chrome_intercept_response` tool. Captures fetch and XHR response bodies that match a URL pattern, with a per-call timeout. Solves the long-standing problem of reading API responses from inside a Chrome extension without instrumenting the page yourself.
- `POST /admin/reset` endpoint on the bridge HTTP server. Force-clears all MCP transports when a session gets stuck mid-init, so you don't have to disconnect and reconnect the extension by hand.
- Plain HTTP REST API alongside MCP. Hit `http://127.0.0.1:12306/` directly from any client, no MCP protocol needed.
- Per-tab JS execution lock. Two parallel `chrome_javascript` calls on the same tab are serialized FIFO, preventing race conditions.
- `chrome_console` `argsTruncated` envelope so callers know when console output was capped.
- `requestId`-correlated debug-dump entries for every tool call. Every failure carries a paste-ready diagnosis prompt.
- Live-test harness under `app/native-server/live-test/` with per-failure markdown files designed to be pasted into an LLM with no other context.

### Changed

- Output redaction is now opt-in via `rawOutput`. Set `chrome.storage.local.rawOutput = true` (or `globalThis.__MCP_RAW_OUTPUT__ = true` in the background console) to bypass the upstream privacy filter. Default-off preserves the cautious posture; turn it on when you need base64 IDs, URNs, JWTs, or cookie-shaped data to flow through verbatim.
- `chrome_javascript` auto-returns bare expressions. `chrome_javascript({code: 'location.href'})` now returns the URL string. Previously you had to wrap in `(() => location.href)()`.
- `chrome_navigate` defaults to opening the new tab in the background instead of stealing focus. Pass `foreground: true` to restore the old behavior.
- `chrome_fill_or_select` uses the React-compatible native `value` setter. Filling textareas and inputs on React-controlled forms (LinkedIn, Notion, etc.) now triggers the right `onChange` handlers and the submit button enables.
- MCP server is now per-session. Each connecting client gets its own `McpServer` instance with its own session id, and tool calls carry `clientId` through to the extension. Multiple clients can drive the same extension at once without stepping on each other's preferred tab.
- Extension UI is English-only. Removed `de`, `ja`, `ko`, `zh_CN`, `zh_TW` locales.

### Removed

- The `mcp-chrome-bridge` and `chrome-mcp-bridge` CLI binaries. Replaced by `humanchrome-bridge`.
- Chinese-language documentation files. The English versions are the canonical reference.
- Bundled release artifacts under `releases/`. Use GitHub Releases instead.

[Unreleased]: https://github.com/cefege/humanchrome/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/cefege/humanchrome/releases/tag/v1.0.0
