# Changelog

All notable changes to HumanChrome are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- Bridge HTTP server now enforces a loopback-only `Host` header on
  state-changing methods (defends against DNS-rebinding attacks from
  malicious web pages that resolve `humanchrome.local` to `127.0.0.1`).
- Optional `Authorization: Bearer <token>` enforcement when the
  `HUMANCHROME_TOKEN` environment variable is set on the bridge.
- File handler hardening:
  - `prepareFile` rejects `file://`, loopback, RFC1918 (10/8, 172.16/12,
    192.168/16), 169.254/16, and link-local IPv6 URLs (SSRF mitigation).
    Redirects are also rejected so a public URL can't re-target an
    internal IP.
  - `readBase64File` enforces a path-traversal guard like `cleanupFile`
    already did — only files inside the bridge temp dir can be read.
- `drizzle-orm` bumped to `^0.45.2` to address GHSA-gpj5-g38j-94v9 (SQL
  injection via improperly escaped identifiers).
- `uuid` bumped to `^14.0.0` (GHSA-w5hq-g745-h8pq).
- `protobufjs` pinned via pnpm.overrides to `>=7.5.5`
  (GHSA-xq3m-2v4x-88gg, transitive via `@xenova/transformers`).
- `pnpm audit --audit-level=moderate --prod` now reports zero
  vulnerabilities.

### Performance

- Extension bundle reduced from 45 MB to 19 MB (~58%):
  - Production builds now minify (`minify: 'esbuild'`).
  - `@xenova/transformers` is lazy-imported inside the offscreen doc
    instead of being statically pulled into the popup chunk.
  - Dropped the 22 MB ONNX WebGPU wasm (`ort-wasm-simd-threaded.jsep.wasm`).
    Only the 11 MB CPU SIMD wasm ships locally; the JSEP variant is
    fetched from jsdelivr if WebGPU is ever wired up.
  - `vite.optimizeDeps.exclude` for `markstream-vue`'s unused optional
    peers (katex, mermaid, monaco-editor, vue-i18n, stream-markdown).
- `chrome.tabs.onRemoved` cleans up `tab-lock` queue entries on tab
  close (tiny memory leak).
- `pendingRequests` map in the native messaging host is capped at 1000
  entries so a misbehaving client can't grow it without bound.
- `cleanupOldFiles()` is now scheduled at bridge startup and every 30
  minutes instead of being defined-but-never-called.

### Changed

- Dropped the `declarativeNetRequest` Chrome extension permission (was
  declared but never used) — reduces the install-time warning.
- Dropped Firefox `dev:firefox`/`build:firefox`/`zip:firefox` scripts.
  README FAQ updated to "no, and not planned" for Firefox support.
- Internal symbol rename `chromeMcp` → `humanchrome` across the
  extension and bridge (DB column `enable_chrome_mcp` →
  `enable_humanchrome` with an inline migration that preserves
  existing values).
- MCP server identity strings: `ChromeMcpServer` → `HumanChromeServer`
  and `StdioChromeMcpServer` → `StdioHumanChromeServer`.
- README install instructions: monorepo root has no `bin`; install
  flow is now clone → `pnpm build` → `npm i -g ./app/native-server`.
- README adds explicit MIT attribution to upstream
  [hangwin/mcp-chrome](https://github.com/hangwin/mcp-chrome).
- Tests now run in CI (vitest + jest) on every push and PR, not just
  smoke tests.
- Dropped Jest coverage threshold gate (only one suite exists; restore
  once meaningful coverage is in place).
- Per-package `LICENSE` files added for `app/native-server`,
  `packages/shared`, and `packages/wasm-simd`. NPM publishes will now
  include the MIT terms.
- Apache 2.0 NOTICE files added for vendored ONNX Runtime and Arc90
  Readability.
- Resized `public/icon/*.png` from 5 byte-identical 210 KB files to
  proper per-size icons (16/32/48/96/128) — saves ~970 KB.

### Removed

- `app/chrome-extension/LICENSE` (the package is `private:true` so the
  duplicate root LICENSE was unused).
- `app/chrome-extension/public/wxt.svg` (default WXT splash, 326 KB,
  unreferenced).
- `prompt/` folder, `attr-ui-refactor.md`, `packages/wasm-simd/BUILD.md`
  — leftover Chinese-only docs from upstream.
- 5 unimported source files (`ElementMarkerManagement.vue`,
  `ScheduleDialog.vue`, `DebuggerPanel.vue`, `alignment-grid.ts`,
  `register.ts`).
- Unused npm deps: `@vue-flow/controls`, `@vue-flow/minimap`, `chalk`,
  `pino`, `pino-pretty`, `cross-env`. `zod` re-added to
  `packages/shared` for IPC schema validation.
- Stale `docs/CHANGELOG.md` and `docs/CONTRIBUTING.md` (root files
  are the canonical copies).

### Fixed

- Sidebar `createTrigger`/`editTrigger` no longer raise a jarring
  `alert("V3 trigger management not implemented yet")` — replaced
  with a silent `console.info` no-op matching the existing
  `createFlow`/`edit` pattern.
- README and `docs/TOOLS.md` now match the actual MCP tool surface:
  `chrome_userscript`, `chrome_inject_script`,
  `chrome_send_command_to_inject_script`, and `search_tabs_content`
  schemas were uncommented (handlers existed all along);
  `chrome_go_back_or_forward` (folded into `chrome_navigate`) and
  the legacy `chrome_network_capture_*`/`debugger_*` aliases were
  removed from the docs.
- 43 pre-existing TypeScript errors fixed across `entrypoints/`
  (gif-recorder Uint8Array<ArrayBufferLike> → Uint8Array<ArrayBuffer>,
  element-marker validator types, JsonObject mismatches, missing
  `previewMeta` on `AgentSession`, etc.).
- 5 pre-existing ESLint errors in `PropertyFormRenderer.vue`,
  `AgentChatShell.vue`, and `smoke-test.mjs` that had been failing
  CI on every commit for 18+ commits.
- Test suite resolver: `tool-bridge.ts` import path fixed so jest's
  resolver can find `'../constant'` (was `'../constant/index.js'`).
- Sharp prebuilt-binary issue on darwin-arm64v8 dev: chrome-extension
  vitest now mocks `@xenova/transformers` so the 10 affected test
  files can load. Real module is only used inside the offscreen doc.
- Postinstall guard: `app/native-server/scripts/postinstall-guard.cjs`
  no-ops when `dist/` doesn't exist, so fresh `pnpm install` from
  source doesn't hard-fail.

### Repo hygiene

- `.editorconfig` and `.nvmrc` (Node 20) added.
- `.gitattributes` cleaned up: dropped dead `*.onnx filter=lfs` rule
  (the extension `.gitignore` excludes `*.onnx`); added EOL
  normalization and standard text/binary classifications.

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
