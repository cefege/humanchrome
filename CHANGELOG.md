# Changelog

All notable changes to HumanChrome are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Rust transition prerequisites: a pinned Cargo workspace, generated declarative
  contracts, isolated process compatibility fixtures, and a production-source
  ownership inventory. Native and isolated-Chrome verification can target
  `HC_TEST_NATIVE_BIN` before any installed runtime cutover.
- Rust shared/native primitives: catalog and graph policy, lossless UTF-16 JSON
  transport, framed messaging and pending-request ownership, primary/relay
  lifecycle, registry persistence, profile-wipe protection, replay caching,
  and stderr-only structured logging.
- Rust MCP/REST application compatibility and a real HTTP-to-stdio
  proxy, verified against isolated TypeScript/native processes. Lossless UTF-16
  routing includes metadata, dynamic flows, idempotency and result-file sinks.
  The real DevTools engine is now built as ESM for trace-analysis adapters.
- Rust fleet CLI and runtime integration: authenticated gateway
  forwarding, per-profile native manifests, PID-bound lifecycle controls,
  adopted/owned shutdown handling, worker enrollment, and signal-driven reload.
  Worker enrollment accepts explicit `--chrome-path` and `--extension-dir`
  overrides without changing installed-path defaults or installing launchd agents.
- Rust agent application compatibility, including nullable session
  patches, persisted history, SSE heartbeat/reset and cancellation. Verification
  exercises the real Claude SDK initialization/cancel/reap path through its
  narrow JSONL adapter; it does not claim a completed cloud-model response.
- Rust MCP notifications no longer execute tools. An isolated-Chrome navigation
  regression failed before the fix and passed afterward against the candidate
  native host, while the installed Node runtime remained unchanged.
- Native release archives retain checksums, complete versioned installation,
  stdio configuration, and previous-release retention. Historical native/WASM verification for
  [`5f223ec9d3a62ce9fb42ed8bbe708c6fc7ff4473`](https://github.com/cefege/humanchrome/actions/runs/41071714692)
  passed workspace tests, archives, and Node-absent installed-archive smokes on
  macOS ARM64/Intel, Linux x86-64, and Windows x86-64; Linux also passed the
  coordinator container gate. Its opt-in real-PostgreSQL TLS release case passed
  across strict, CA, no-verify, direct, and rejection URL paths. The corrected
  `performance-native.json` validates fully read successful response bodies:
  TypeScript → Rust p50/p95 startup is 607.195375/744.066166 →
  11.499208/11.618833 ms, MCP help 0.704000/1.465792 → 0.205792/0.373500 ms,
  successful REST forwarding 0.458583/1.111334 → 0.196833/0.519000 ms, and RSS
  median 289341440 → 15433728 bytes. It excludes Chrome, ONNX, optional SDK
  processes, and the optional Rust trace adapter; it is not a whole-feature-set
  Node-free claim.
- Separate Mac arm64 optional-engine archives containing the real Claude Agent
  SDK, DevTools analyzer, pinned Node runtime and Codex executable. Native hosts
  discover the overlaid engines beside their own executable; the core archive
  remains Node-free. Extracted-bundle checks exercise SDK resume/cancel/reap,
  Codex cancellation and actual trace analysis without an external runtime PATH
  or paid model response.
- An isolated Rust-native/TypeScript-browser gate runs the full matrix and local
  task scenarios against one owned Chrome/bridge. WXT builds into a private output directory
  without installed-runtime synchronization. Private registration,
  public-key-derived origins, explicit fixture tabs, allocated CDP ports,
  credential-free test Keychain and strict failure/deadline reporting avoid
  daily-browser actions and false passing results. Baseline exceptions are never
  silently applied; verified browser fixes are recorded below.

### Changed

- Option A keeps Chrome extension policy and UI in TypeScript/JavaScript, while
  the bridge, MCP/REST, agent application, fleet gateway/worker and coordinator
  remain Rust. The browser is not a Node runtime. Numeric SIMD WASM, ONNX and HNSW
  remain unchanged; general-purpose browser Rust/WASM glue and build hooks are
  removed rather than retained as a second runtime.
- The full Rust-browser experiment is preserved at
  [checkpoint `1012e423`](https://github.com/cefege/humanchrome/commit/1012e423dca2265d9e84ebab0db696a22d63d829).
  Its recorder and workflow/vector CPU regressions motivated the browser rollback;
  native-service performance evidence does not imply a browser speedup.
- A production hot repair corrected only a caller-owned, profile-local Native
  Messaging descriptor from the removed Node wrapper to the installed Rust
  executable, preserving its allowed origins. The authenticated Rust
  coordinator → worker → native-host → installed TypeScript-extension MCP path
  then succeeded. Automatic worker/gateway descriptor refresh passes Clippy,
  189 Rust tests and packaged installation smoke; production activation remains
  pending in IMP-0209. This migrates caller metadata, not a Node fallback.

### Fixed

- CI/release companion builds now supply checksum-pinned Node and Codex inputs
  on the supported Mac arm64 target; all four platforms retain core archive
  packaging and Node-absent smoke coverage. The fixture workflow explicitly
  selects the same intentional keyless CI mode as the other build workflows.
- Keyless fixture origins use Chrome's canonical filesystem path. Generated
  native contracts retain their byte-exact generator format instead of being
  reflowed by pre-commit formatting.

- Combobox selection now delivers trusted commit keys in background tabs sharing
  an existing debugger session, using temporary focus emulation without
  activating the tab.
- Default page/ARIA reading and the interactive-elements fallback address the
  main frame explicitly rather than accepting an iframe response.
- Browser builds retain numeric SIMD and generated worker/recorder assets without
  depending on a general-purpose Rust/WASM policy kernel.
- The earlier four-platform native run for
  `b1dc6fefb143822db8c19030df45a1912c4d959a` remains historical evidence, not
  current-source certification, a release, merge, or installed-default
  activation.
- Recorder target production retains its original strategy configuration and
  frozen serialized contract. Replay click/fill/read actions retain the bound
  flow tab instead of resolving an unrelated active tab.
- Offscreen model-resource initialization remains serialized; persisted HNSW
  reopen and cold-reset behavior remain required real-browser checks.
- Native upgrades preserve already configured, valid extension origins while
  updating the executable path. Unsafe origins and missing required origins
  remain rejected; new installations retain the existing default allowlist.

### Security

- Upgrade the MCP client/server packages, Fastify, Zod, Vue, Transformers,
  Vite, and Vitest, with major-bounded transitive security floors centralized
  in `pnpm-workspace.yaml`. Explicit peer providers prevent the Agent SDK and
  Jest from retaining vulnerable MCP SDK or incompatible Babel versions.
- Move WXT to `0.21.5`, remove its obsolete disabled-runner configuration,
  and preserve the extension's prior TypeScript compiler contract. The unused
  `web-ext-run` dependency tree is no longer installed.
- Patch unreleased `deepmerge` prototype-poisoning fixes into the source,
  CJS, and UMD bundles; keep the registry advisory visible and cover Jest's
  consumed runtime with a security regression contract. See `SECURITY.md`.

### Changed

- **Project MCP connection**: point HumanChrome at the private OVH Tailscale
  coordinator. Portable clients use an environment token; OMP resolves its
  credential from the private bootstrap file without committing secrets.

- **Browserless coordinator and native workers**: `fleet coordinator` serves
  authenticated HTTP/MCP browser access without local Chrome. Dedicated Mac
  workers retain profiles and cookies locally, enforce durable lease fences,
  and quarantine unknown action outcomes. PostgreSQL preserves assignments
  through coordinator restarts; expired workflows require explicit release
  rather than silently moving to another browser. Kubernetes/Tailscale
  deployment and proxy identity-recovery verification live in `deploy/fleet/`.

- **Fleet: browsers start when a request needs them**: `fleet up` used to start
  every enabled profile and `fleet down` stopped all, so a pool request against a
  parked fleet got `503 no_free_profile` even though its bound profile existed.
  A pool request with no free healthy candidate now starts the one enabled
  browser bound to its label or purpose, waits up to `demandStartTimeoutSec`
  (default 90) and leases it. Failures answer `503 profile_start_failed` or
  `profile_start_timeout`. Park now only stops eager starts (boot, revival);
  demand-started browsers are supervised and stop after `idleStopSec` (default 1800) with no lease. `fleet status`, the status page and `fleet_park` reflect
  it. See docs/FLEET.md, "Demand start".

### Fixed

- Preserve macOS native-host TCC refusal when HOME is a filesystem alias, without
  rejecting lookalike directory names. The optional JSONL adapter now recognizes
  direct execution through canonicalized paths such as `/tmp` → `/private/tmp`.
- Keep successful worker fixture responses unread until their actual consumer:
  diagnostic assertions no longer consume JSON twice or await the end of an
  intentionally open streaming response. Isolated worker enrollment explicitly
  selects `daily=null`, avoiding an unintended seed lookup in its temporary HOME.
- Finalize successful fixed-length and empty worker proxy responses before
  exposing completion to callers; Hyper need not poll a stream again after
  `Content-Length` bytes. Completed mutations no longer falsely quarantine the
  next action; disconnected and incomplete mutations remain fenced.
- Keep an already-supervised live Chrome owned across repeated starts instead
  of re-adopting it and dropping the worker's private CDP connection.
- Preserve agent project/session activity, permissive attachment decoding and
  declared MIME behavior across the Rust cutover. A shared single-pass decoder
  retains Node's noncanonical trailing-bit behavior instead of losing file data.
- Map Codex failed items, plan progress, command/file metadata and final assistant
  transitions consistently; flush Claude cancellation before waiting for reap
  and restore the resolved Node directory after session PATH overrides.
- Classify macOS picker process failure as an HTTP 500 error, not user
  cancellation. Local-only provider smoke gates exercise real SDK/CLI startup,
  Claude resume/invalid-resume clearing and cancellation without cloud responses.

- Remove the stdio client's unsupported `2026-07-28` protocol pin; let the SDK
  negotiate a version the HTTP bridge actually supports.
- Honor Commander's negated `--no-seed` option instead of treating `false` as a
  seed directory. Share the Rust Google-session probe's original POST/ListAccounts
  behavior between CLI verification and provisioning.
- Preserve Unix private-CDP disconnect behavior with socket-backed stdio. Keep
  unrelated live PIDs protected while allowing a stop to complete when Chrome
  exits during asynchronous ownership inspection.
- Refuse non-allowlisted worker startup profiles and retain the running
  supervisor after a malformed reload, matching the existing CLI lifecycle.
- Honor `HC_TEST_NATIVE_BIN` when the TypeScript provisioning oracle creates
  temporary native manifests, so candidate browser verification cannot silently
  exercise the installed Node host.

- **Kubernetes/Tailscale deployment checks**: use the pinned chart's actual
  `operator` Deployment and the standalone proxy's `TailscaleProxyReady`
  condition. Proxy verification waits for rollout readiness before comparing
  persistent state Secret UIDs and tailnet device identities across restarts.

- **Fleet: only HumanChrome runs in a fleet browser**: a seeded profile carried
  its user's extensions, and their frames made CDP attach fail with "Cannot
  access a chrome-extension:// URL of different extension". Every launch now
  disables each extension except the loaded HumanChrome (including an older
  HumanChrome copy) through `chrome.management`, so no profile needs its files
  deleted. See docs/FLEET.md, "Provisioning".
- **Fleet: `fleet status` reflects profile changes made while parked**: a
  parked `serve` reloaded on every CLI mutation but kept its old profile list,
  so a profile removed with `profile rm` was still listed, and one added,
  relabelled, enabled or disabled showed stale, until `serve` restarted. The
  reload now syncs the list while parked, still without launching anything.
- **Fleet: a fleet browser can sign in to Google**: `--remote-debugging-pipe`
  alone made every page report `navigator.webdriver === true`, and Google
  refused sign-in with "This browser or app may not be secure"
  (`/v3/signin/rejected`). Fleet Chrome now launches with
  `--disable-blink-features=AutomationControlled`; on the same copied profile
  sign-in then proceeds to the password/passkey challenge. Browsers started
  before this keep the old flag until relaunched.
- **Fleet: `profile add` refuses a copy whose Google login is not live**: a
  copy of a daily Chrome that Google had already signed out kept every
  google.com cookie and passed the cookie gate, then landed on "Verify it's
  you". The add now asks Google (`ListAccounts` through the new profile's
  bridge) and, when the copy carried a Google login, discards the profile
  unless the answer is a live `session`, naming the state (`remembered` or
  `none`) and the source's own sign-in-pending time when that is the cause.
  New `fleet profile verify <name>` asks the same of a running profile and
  exits 1 unless it is signed in. See docs/FLEET.md.

- **Fleet: a seeded profile no longer comes up with its cookies wiped**:
  `fleet profile add` run over SSH launched the new Chrome in the SSH security
  session, where the login Keychain is locked, so Chrome could not read the
  `Chrome Safe Storage` key and deleted every copied cookie (420 → 0). The add
  is now handed to the running `fleet serve` (`POST /v1/profiles`), which
  lives in the GUI session; every fleet Chrome launch refuses a session that
  cannot read the Keychain; and `profile add` discards the profile instead of
  registering it when the browser kept under 90% of the copied persistent
  cookies, or none of its google.com ones. See docs/FLEET.md.

- **macOS Tahoe TCC compatibility — doctor surfaces existing bad installs**:
  `humanchrome-bridge doctor` now flags an existing manifest whose `path`
  field points into a TCC-protected directory, so users who registered the
  bridge before the register-time guard get a diagnostic instead of silent
  spawn failures. Pairs with the register-side check below.
- **macOS Tahoe TCC compatibility**: `humanchrome-bridge register` now refuses
  to write a Native Messaging manifest when the resolved bridge path is inside
  a TCC-protected directory (`~/Documents`, `~/Desktop`, `~/Downloads`,
  `~/Pictures`, `~/Movies`, `~/Music`, `~/Library/Mobile Documents`/iCloud
  Drive). Background: macOS Tahoe (Darwin 25.x) lets Chrome READ files in
  those directories with Full Disk Access but blocks `exec()` of scripts
  inside them. Registration would succeed, but every `connectNative()` call
  would silently fail with `lastError: 'Native host has exited.'` and our
  wrapper would never run (no log file, no spawn). The new check throws an
  error pointing the user at `~/Library/Application Support/humanchrome-bridge/`
  with a paste-able `pnpm deploy` recipe. New regression tests live at
  `app/native-server/src/scripts/utils.test.ts`.

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
