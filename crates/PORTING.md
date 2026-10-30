# Rust transition compatibility

The workspace routes native runtime commands to Rust and has removed the legacy TypeScript native sources. Production rollout is separate from isolated verification; deployment facts belong in `deploy/fleet/README.md`.

Option A keeps browser policy in TypeScript/JavaScript and native services in Rust.
The general browser Rust/WASM experiment is retired; the original numeric SIMD
package and ONNX/HNSW engines remain. The pre-reversal source is preserved in
[checkpoint `1012e423`](https://github.com/cefege/humanchrome/commit/1012e423dca2265d9e84ebab0db696a22d63d829).

## Current Option A verification (2026-10-30)

| Gate                                                                                    | Observed result                                                                                                                                    |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust format, Clippy with warnings denied, workspace tests and optimized native binaries | Passed; 189 tests across 13 suites, one opt-in TLS test ignored                                                                                    |
| Shared and extension suites                                                             | 174 shared and 1,939 extension tests passed; one extension test skipped                                                                            |
| TypeScript, generated contracts and source inventory                                    | Passed; 646 production files, 85 retained browser-policy boundaries, zero pending boundaries                                                       |
| Owned Chrome for Testing                                                                | `browser-hc-rt-hziSan.json`: 35/35 matrix rows and 17/17 task scenarios                                                                            |
| Extracted native core plus pinned optional-engine archives                              | Installation, upgrade, retained configuration, Node-absent core startup and actual trace smoke passed                                              |
| Actual bundled Claude SDK and Codex                                                     | Local-only startup/activity/cancel/reap passed; Claude resume and invalid-resume clearing passed; no credentials or completed cloud-model response |

The 35/35 + 17/17 result is an isolated owned-Chrome gate, not a probe of the
daily-driver production profile or proof that its extension source has reloaded.

## Current production rollout status (2026-10-30)

The OVH coordinator is deployed from source
`956ffd77c91f1124f3fc821647a5312b648fbe1e` as
`humanchrome-coordinator:956ffd77c91f`. Its Docker
build uses the pinned Rust/Debian bases, Rust `1.99.1`, and the locked Cargo
graph; k3s runs `/usr/local/bin/humanchrome-bridge`, not a Node coordinator.
Both coordinator health endpoints passed, while the rollout retained the
existing PostgreSQL image, PVC identity, and Secret identities.

The idle Mac fleet worker likewise runs the installed Rust process and passed
its HTTP health probe using the existing root, database, and profile paths. A
hot repair changed only its worker/browser profile descriptor executable to
`ASRoot/releases/1.2.0-19417-0/humanchrome-nativehost`, retaining its origins.
Native `/ping` returned 200, and authenticated MCP reached the existing
TypeScript extension through the private Rust coordinator → Rust worker → Rust
native-host path; diagnostic leases were released successfully.

This proves that repaired live profile path, not complete desktop activation.
The automatic worker/gateway descriptor refresh passes Clippy, 189 Rust tests
and the extracted native/companion archive smoke. Its production activation
remains pending; the source browser bundle has not synchronized/reloaded into
the shared production path. The active
LinkedIn maintenance path remains untouched while its client renews the
existing lease. Desktop activation and IMP-0206 remain in-progress; no
standalone/global CLI or extension deployment completion, and no Node fallback,
is claimed.

The retired general browser kernel's tests and benchmarks below are historical,
not requirements or current-source certification. Browser policy uses direct
TypeScript calls; the numeric SIMD package remains a distinct engine.

## Contract boundary

| Authored source                                         | Rust/build consumer                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Shared tool names, schemas, categories and replacements | `humanchrome-contracts::CONTRACT` from the generated artifact                                    |
| Shared IPC schemas and error literals                   | `rust-contract-source.ts` → `generated/rust-contract.json` → embedded contract                   |
| `tool-index.snapshot.json`                              | Unmodified descriptor-byte oracle; SHA-256 and catalog consistency checked in `tests/catalog.rs` |
| Existing `packages/wasm-simd`                           | Workspace member retaining edition 2021 and the `wide` numeric implementation                    |

`pnpm build:contracts` runs independently of the shared package barrel and numeric browser WASM. The contract process example emits the exact embedded artifact, not a reconstructed catalog.

## Observable fixtures

`tests/rust-transition/typescript-baseline.json` records the compiled TypeScript native process using isolated HOME, SQLite, registry, socket and HTTP ports. It covers split/coalesced frames, invalid lengths, malformed JSON, unknown envelopes, processing past 100 frames, lazy/legacy MCP catalogs, simultaneous clients, both initialization versions, help/aliases/sunset handling, opaque extension fields, malformed REST bodies and Host/Origin rejection.

`node scripts/verify-rust-transition.mjs --suite contracts` checks artifact freshness and compares separate declarative TypeScript/Rust contract processes. `--suite native` requires a real candidate native host and compares its framing, HTTP/MCP, file and stdio observations with the captured original process; absence is a failure, never a passing skip. Agent, fleet and browser gates likewise require their real scenarios before cutover.

Normalization is restricted to generated UUIDs, timestamps, owned temporary paths and allocated fixture ports. Errors, null versus omission, catalog text, and frame/event ordering remain observable.

`source-map.json` distinguishes planned owners from completed migrations. Classification coverage does not mean migration completion. Browser/DOM effects and third-party engines remain explicit host boundaries; application policy cannot be reclassified as an effect to finish the migration.

Native wire behavior remains pinned to the captured TypeScript oracle. Before capture, the original stdio proxy's unsupported `2026-07-28` pin was removed because its own HTTP server rejected that version. The Rust proxy negotiates the SDK-supported protocol. Platform/provider and installed-host proofs are separate gates, not implied by Cargo or mocked tests.

## Shared/native primitive boundary

`humanchrome-core` owns catalog/help ranking, session normalization, graph
mapping, INVALID_ARGS details, structured tool errors, and the two distinct
output-truncation policies. Native modules own framed I/O, pending requests,
daemon sources, registry persistence, replay caching, and fleet wipe protection.
The original TypeScript runtime sources are retired from the workspace. Captured
observations remain the compatibility oracle; source cutover is not installed activation.

`JsonDocument` retains the ordinary `serde_json::Value` path and a lossless
UTF-16 representation for valid JSON containing unpaired surrogates in values
or keys. Validation may inspect a projection; transport and replies retain the
original document. Native output writes directly into the reusable frame
buffer. `JsonDocument` must not be passed through `json!(...)` or another
`Value` round-trip when it contains unpaired UTF-16.

The primitive process suites are `policy-suite.mjs`,
`native-primitives-suite.mjs`, `fleet-config-primitives-suite.mjs`,
`registry-primitives-suite.mjs`, and `logging-primitives-suite.mjs` under
`tests/rust-transition/`. Fixtures isolate HOME, TMPDIR, databases, registry,
socket paths, and ports. They do not install a partial native host or fabricate
public `server_started` responses.

Native source teardown uses cancellable Unix pipe/socket input rather than an
uncancellable blocking stdin read. UUID responses correlate by their exact
canonical string spelling, not by case-insensitive UUID equivalence. As in the
Node process, an exited primary leaves a socket pathname for the next startup
to probe before removing it.

Structured tracing is pinned to stderr. Use `%` with JSON values for structured
fields; `?` is diagnostic Debug text, not structured JSON. Credential redaction
retains the existing root/one-level/header paths without inventing recursive
masking. Existing file-boundary security findings are tracked separately as
IMP-0193 and IMP-0194; migration parity is not a security-hardening claim.

## Native application compatibility evidence

The candidate HTTP MCP endpoint uses the measured sessionless SSE POST contract,
including Accept/protocol rejection, notification acknowledgements and GET/DELETE
behavior. Help ranking uses `humanchrome-core::catalog::Catalog`. REST parsing
retains Fastify's 1 MiB limit, JSON-poisoning rejection and parser-before-auth
precedence. Routing preserves UTF-16 arguments, results, opaque metadata,
aliases, dynamic-flow arguments, raw mode, idempotency keys and filesystem sinks.
Pre-serialized native errors retain their original envelope.

`humanchrome-stdio` connects to an existing bridge rather than starting a native
actor. It reads adjacent `mcp/stdio-config.json`; URL, port and live-registry
resolution retain the TypeScript precedence.

Historical pre-Option-A checkpoints on Apple Silicon macOS; these counts do not certify the current tree:

| Command                                                                                                       | Observed result                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cargo test --workspace`                                                                                      | Latest completed Rust checkpoint: 219 passed across 16 suites; 1 opt-in TLS smoke ignored                                                                                |
| `cargo build -p humanchrome-native --release --bins --examples`                                               | Optimized candidate binaries/examples built without installed cutover                                                                                                    |
| `node scripts/verify-rust-transition.mjs --suite native`                                                      | Rust framing/lazy/legacy, file/protocol/routing/REST and isolated stdio fixtures matched original observations                                                           |
| `node tests/rust-transition/stdio-proxy-suite.mjs`                                                            | Real HTTP-to-stdio handshake, concurrent calls and URL/port/registry discovery matched                                                                                   |
| `cargo clippy --locked --workspace --all-targets --all-features -- -D warnings`                               | Passed with warnings denied                                                                                                                                              |
| `RUSTDOCFLAGS='-D warnings' cargo doc --locked --workspace --all-features --no-deps --document-private-items` | Workspace documentation generated with warnings denied                                                                                                                   |
| `pnpm typecheck`                                                                                              | Passed with fresh generated bindings and the adapter-only native workspace excluded from TypeScript project discovery                                                    |
| `RUN_EVALS=0 pnpm test`                                                                                       | Shared: 175 passed; extension: 1,945 passed and 1 skipped. Native runtime tests run through Cargo, not the retired native-server Jest suite; no paid evaluations enabled |

The Apple Silicon native archive passed `scripts/smoke-native-release.mjs` after
extraction into an isolated HOME: direct registration into a complete versioned
release, upgrade with preserved `mcp/stdio-config.json`, previous-release
retention, foreign-manifest protection, canonical-home TCC refusal, real Native
Messaging/HTTP/MCP, and stdio with Node absent from native-child PATH. Completed
releases are not automatically pruned: another browser or worker may still
reference an older executable. This is local candidate evidence, not signing,
other-platform execution, publication or installed-default activation.

The policy and primitive runners now use captured original observations or
independent consumer assertions; they do not launch the obsolete Node runtime.
The stdio fixture stages its own executable/configuration bundle and observes
early process exit, avoiding shared build-directory mutation and missed-exit hangs.

DevTools ships TypeScript sources, not the `.js` deep imports used by the former
build. `scripts/build-optional-engines.mjs` bundles the real upstream engine and
formatters as ESM, with an explicit English server-locale configuration. The
original analyzer and Rust JSONL adapter have produced matching actual summaries.

The separate Apple Silicon optional-engine archive contains the locked Claude
Agent SDK 0.3.215, DevTools 1.0.1662965, Node 24.22.2 and Codex CLI 0.154.0.
The builder uses a dedicated frozen production deployment with a hoisted module
layout, materialized regular files, dependency notices and executable checksums.
Node's official archive checksum is verified before extraction; its license is
retained. Tar creation omits macOS resource-fork sidecars.

The native host discovers `adapters/third-party.mjs` and
`adapters/runtime/bin/{node,codex}` beside its executable. The core archive remains
Node-free; the optional provider/trace engines do not. After extracting and
overlaying both archives, the native host passed genuine DevTools analysis and
real SDK/CLI startup, activity persistence and cancellation/reaping with an empty
external PATH. Claude valid-resume identity and invalid-resume clearing also
passed. Provider requests went only to the local fault endpoint inside the
network sandbox: no cloud-model completion, real credentials or billing proof
is claimed.

Agent SSE compatibility uses default EventSource messages, the initial comment,
session-local connection broadcasts, and one shared 30-second JSON heartbeat.
The process gate exercised simultaneous streams and the actual heartbeat interval.
Codex cancellation delivers SIGTERM and waits for child reaping; a subprocess
regression failed with SIGKILL before the fix and passed after it.

The agent gate matches the captured Node project/session/message/path/attachment
contract against legacy-shaped SQLite. Real Claude SDK and Codex CLI startup,
activity persistence, cancellation and child reaping also passed with synthetic
credentials and held loopback API requests, not simulated provider processes.
The inherited macOS sandbox permits loopback/Unix sockets only; a separate
non-loopback connection probe was denied with `EPERM`.

The Claude run additionally resumed the same SDK session identity, then injected
an invalid private-fixture identity and proved it was cleared with a terminal
error and no fresh-query retry. Codex retains the original no-resume invocation.
No completed cloud-model response, live paid-provider tool execution or usage
accounting is claimed. Plan/failure/final-message transitions have deterministic
parser regressions, separate from real-engine startup proof.

The macOS picker boundary distinguishes cancellation from command failure. The
failure case reproduced as Node 500 versus Rust 200 before the fix; both returned
500 afterward, and cancellation remained 200. Controlled OS subprocesses avoid
opening a desktop dialog; native picker UI interaction itself was not exercised.
Node-compatible base64 attachment bytes, including ignored trailing bits and
URL-safe symbols, are preserved; the `AB` → `[0]` regression failed before and
passed after the shared single-pass decoder replaced an empty-result fallback.

MCP notifications are acknowledged without dispatch. The isolated Chrome
navigation regression [failed before](../docs/e2e-runs/2026-10-29_rust-mcp-notification-before.json)
and [passed after](../docs/e2e-runs/2026-10-29_rust-mcp-notification-after.json);
the Node baseline also preserved the tab URL. Notification acknowledgement
alone was insufficient: verification inspected the actual live tab.

An earlier isolated Chrome matrix proved the candidate Rust nativehost executable
and PID, with 26 passing rows and the baseline combobox failure tracked by
IMP-0191. The [historical result](../docs/e2e-runs/2026-10-29_rust-nativehost-after-notification-fix.json)
is not a claim that all current browser or workspace gates pass.

## Fleet CLI and profile lifecycle

The native CLI wires profile/node/purpose operations, token rotation and open
fleets, template provisioning, diagnostics, gateway control, worker enrollment,
and coordinator serving to their runtime implementations. An existing
authenticated gateway owns lifecycle/provision operations; the CLI forwards to
it instead of creating a second supervisor. Gateway and worker serving also
hold the legacy SQLite root lock, not just PID files.

Worker enrollment keeps HTTP port `12320` and first bridge port `12900` as its
defaults. Explicit `--chrome-path` and `--extension-dir` overrides are
canonicalized before persistence so isolated Chrome for Testing can be used
without changing installed paths. `--seed-source daily=null` provisions an empty
worker profile. Existing roots and credentials are not overwritten. Launchd
installation/removal requires `--allow-agent-install`; verification exercises
the refusal path, never the installed service.

Owned shutdown snapshots replayable cookies before terminating Chrome. Adopted
browsers survive supervisor shutdown; explicit stops still verify their PID
against the profile. An exit during asynchronous process inspection is treated
as an exit, while a still-live mismatched PID remains an error. Restart markers
bind their recorded profile names to PIDs and do not authorize killing an
unrelated process.

The real-browser fixture uses temporary HOME, manifests, registry and profile
roots, the unchanged keyed extension, and the existing unlocked login Keychain
through a temporary symlink. It verifies same-Mac encrypted SQLite cookie
retention independently of plaintext session-snapshot replay. Google
verification compares the actual TypeScript and Rust in-browser probes; the
exercised fresh-profile answer is `none`, not a signed-in-account claim.
Both provisioner cases explicitly select `HC_TEST_NATIVE_BIN` before template
creation. The TypeScript manifest factory honors that isolated-harness override;
an invalid candidate fails rather than falling back to the Node wrapper.
Runtime verification requires the candidate nativehost PID/executable.

The aggregate fleet gate also includes PostgreSQL/coordinator wire and worker
durability checks. Those are separate readiness requirements: lifecycle
evidence must not be presented as a passing aggregate gate or deployment proof.

The integrated candidate passed 109 native library tests and built all release
binaries/examples. Real PostgreSQL verification passed singleton exclusion,
contested reservation, durable release/expiry generations, and terminated-leader
fail-closed writes. The coordinator HTTP/MCP differential (including official
SDK initialization/calls, persisted bindings, reload and shutdown) passed.
The controlled WorkerHttp fixture passed legacy SQLite reopen, mutation
disconnect/kill quarantine, no replay, recovery and active-stream handoff.

The real coordinator-to-Chrome fixture now passes through the official MCP SDK,
the production worker, the candidate Rust nativehost and the unchanged extension.
It drives navigation/DOM calls, releases a durable lease, terminates the exact
owned PostgreSQL advisory-lock session, and proves the next navigation is denied
with 503 without reaching the browser. The same run verifies worker crash
quarantine, stale-identity rejection, explicit Chrome replacement and subsequent
browser actions. Repeated starts preserve the running Chrome PID and ownership.

A completed fixed-length response formerly left an uncertainty marker because
Hyper need not poll EOF after sending `Content-Length` bytes. The regression
failed with a subsequent 409; it now passes. The worker retains only the last
chunk while persisting completion, and handles empty responses before returning
headers; it does not buffer complete payloads or retry actions.

An actual isolated PostgreSQL container restart reused its existing volume.
All three fleet tables retained matching row digests and the generation sequence
retained its value. The temporary comparison script was removed after the smoke.
No installed worker or production registration changed during verification.
Gateway federation also passed a TypeScript/Rust process differential with an
authenticated controlled peer: qualified and label-pool routing, cross-agent
exclusion, explicit release/handoff and no redirect replay. Coordinator role
checks reject non-admin worker inventory and parking with 403 on both runtimes.
These controlled-peer checks are transport/policy proof, not additional Chrome
claims; the separate real-browser chain supplies that evidence.

## Candidate platform verification

The Linux amd64 coordinator image built with Rust 1.99.1, the locked Cargo graph
and pinned Rust/Debian base images. It then ran in an owned full-system QEMU
x86-64 Linux VM on the Apple Silicon host, not merely through ARM-container
user-mode emulation. Docker reported `linux/amd64` for both daemon and image.
This proves execution compatibility, not native-CPU performance.

`scripts/verify-coordinator-container.mjs` passed with PostgreSQL 17.11:
health/readiness, missing/bad auth, real MCP control, unavailable-worker behavior,
singleton exclusion, fail-closed readiness/browser work after database loss,
and SIGTERM exit 0 without forced termination. The coordinator ran non-root
with a read-only root and read-only mounted configuration. Export inspection
covered 4,904 filesystem entries and found no Node or Chrome runtime entries.
The Mac artifact also completed the real worker/Chrome crash-recovery and
durable-fencing fixture after extraction. No installed registration, production
worker, coordinator, Tailscale identity or PostgreSQL data was switched over.

The refreshed image `humanchrome-coordinator:rust-candidate-20261030-final`
passed the full-system x86-64 container gate again. Its
`target/native-packaging/coordinator-linux-amd64.tar` SHA-256 is
`6e20840ead3cc0669746e2632fb15b1448571cd17fc6f3036122f505601405a3`.
Both owned verification VMs and their runtime disks were removed afterward;
the image archive and checksum remain. Host DNS and Tailscale configuration
were unchanged.

Current immutable native/core/WASM verification passed on macOS ARM64, macOS
Intel, Linux x86-64 and Windows x86-64 for
`5f223ec9d3a62ce9fb42ed8bbe708c6fc7ff4473`:
[run 41071714692](https://github.com/cefege/humanchrome/actions/runs/41071714692).
Each target built the three public executables, ran the native workspace suite,
packaged its archive, and passed an installed-archive smoke with Node absent from
the native child's PATH; Linux also passed the coordinator container gate. The
opt-in real-PostgreSQL TLS release test passed its one case in 0.09 seconds across
configured strict, CA, no-verify, direct, and rejection URL paths. The corrected
native comparison artifact is `target/rust-transition/performance-native.json`;
the failed synthetic predecessor, `before-success-envelope.json`, is retained and
explicitly superseded. With fully read response bodies and validated successful
tool content (status/success/data `{ok:true}`), old TypeScript → current Rust
p50/p95 is startup 607.195375/744.066166 → 11.499208/11.618833 ms (three each),
MCP help 0.704000/1.465792 → 0.205792/0.373500 ms (300 each), and successful
REST forwarding 0.458583/1.111334 → 0.196833/0.519000 ms (300 each); RSS median
is 289341440 → 15433728 bytes (three each). Parsing/assertion is outside the
elapsed interval. The recovered 9c8 TypeScript/Bun Node 25 baseline and current
`5f223` native process exclude Chrome, ONNX, and optional SDK processes; legacy
eagerly loads DevTools while Rust's optional trace adapter is not started. This
does not claim the whole feature set is Node-free.

This four-platform CI proves the immutable native/core/WASM artifacts and their
native/container gates; it neither replaces nor approves the separately authorized
browser-policy cutovers, whose real-Chrome evidence is recorded below.

Local current-source evidence additionally includes Clippy, 253 Rust tests passed
(one TLS opt-in test ignored), rustdoc with warnings denied, and rebuilt release
binaries. Public native protocol/file/stdio/real-trace and detached-relay
regressions, plus the real coordinator → worker → Rust host → Chrome,
crash-fencing/recovery and full lifecycle/cookie/snapshot/provisioning checks,
passed against current binaries. The earlier
`b1dc6fefb143822db8c19030df45a1912c4d959a` four-platform run remains historical
evidence only. None of these results is a release, merge, or installed-default
activation of the daily-driver runtime.

## Historical browser Rust/WASM acceptance evidence

The pre-reversal Rust/WASM candidate reported 35/35 matrix rows and 17/17 local task
scenarios in `target/rust-transition/browser-hc-rt-DvXGRS.json` and its
`.tasks.json` sidecar. It exercised all five Vue realms; the V2 editor committed
`style.opacity === "0.42"` and recorded the resulting screenshot. It also proved
two-client held-tab queue fairness and `TAB_CLOSED` release, all six frozen
recorder target cases with actual replay, workflow branch/retry/pause/cancel and
`nextSeq` behavior, genuine tokenizer/model loading, ONNX inference, HNSW
indexing, and exact astronomy/baking persisted-HNSW reopen queries over the
20-document corpus (IDs, order, scores, and snippets).

The same run woke a fresh service worker while native HTTP remained available,
re-established native-channel readiness, restored owned aliases/workflow events,
then performed the cold reset before model readiness: clear, restart/reopen, and
new-index search returned zero documents, zero tabs, and `[]`. The offscreen model
resource initialization is serialized so cached automatic boot and explicit
initialization cannot dispose an engine still initializing; its two-case lifecycle
regression failed before the fix and passed after it.

Recorder timing is a measured regression, not a speed claim: with 15 warmups and
40 samples grouped by ten, the six-target/29-candidate batch p50/p95 is
0.430/0.540 ms versus the original 0.190/0.220 ms with exact outputs. The
collection-level JSON profile is in
`target/rust-transition/performance-browser-cpu-profiles.json`; it attributes the
cost to collection-level JSON work rather than per-comparison work.

`target/rust-transition/performance-extension-startup.json` records three
authenticated source-build/current runs against the same constant Rust-native
backend: cold Chrome spawn through popup/runtime wake and the first successful
`chrome_get_windows_and_tabs` was 792.431/1028.795 ms p50/p95 originally and
811.316/931.793 ms currently. Each returned one window and three tabs with the
same contract shape; the three samples, excluded build time, and non-shipping
source baseline do not support a speed claim.

`target/rust-transition/performance-workflow-vector.json` records actual-Chrome,
40-warm-sample parity comparisons and remaining browser CPU regressions:
64-node/79-edge workflow traversal (63 next/reachable/DAG validations plus 24
resolvers) is 0.0754167/0.0858333 → 0.510417/0.544167 ms p50/p95 despite one
reused Rust workflow context; a 24-action branch with 48 whole-condition-tree
WASM calls is 0.006250/0.0104167 → 0.597500/0.750417 ms; and a contiguous
32×32, 128-dimensional vector batch is 0.167917/0.176250 →
0.357083/0.371667 ms. Workflow conditions retain their actual DOM/variable
effect boundary, vector parity holds to `1e-12`, and these results make no
ONNX/HNSW timing claim or overall browser-performance-win claim.

The harness builds with WXT directly into an owned temporary output directory,
without postbuild synchronization. Credential-free DOM fixtures use Chrome's
test-only Keychain on macOS, avoiding the private-HOME cookie-store stall; this
is not real-Keychain or signed-in-session proof. The separate fleet lifecycle
suite supplies the actual encrypted-cookie/Keychain evidence.

Those historical browser-policy cutovers used per-realm kernel initialization
and generated-WASM test barriers. Option A removes that general kernel and
restores direct TypeScript policy calls. The historical measurements above are
the reason for this architecture change, not current browser Rust requirements.

The required persistence gate is service-worker stop/start only, not a full
extension reload/update: it passed in the latest owned run, including the fresh
service-worker/native-channel path and cold reset before model readiness. Chrome
clears `chrome.storage.session` on a full extension reload/update. A separate
minimal `chrome.runtime.reload()` probe kept HTTP available but did not observe a
new worker, so it is neither recorded as passing nor substituted for the required
gate.

The pre-reversal validation recorded 175 shared tests, 1,950 extension tests
(one existing skip), TypeScript typechecking, contract export, and source coverage.
Its 96 Rust/WASM browser boundaries and actual-WASM specificity comparisons
describe the checkpoint, not the current TypeScript browser ownership.

## Retained browser behavior

The browser rollback preserves the independently fixed model initialization
serialization, awaited IndexedDB transactions, persisted mapping compatibility,
and in-place HNSW filesystem cleanup. Recorder, ownership/queue, workflow,
editor, and vector behavior remain actual-Chrome acceptance gates; passing the
historical WASM candidate does not substitute for verifying Option A.

## Browser computation assessment

The existing shipped Rust/WASM module produced the expected cosine, batch and
row-major matrix results for finite, zero, orthogonal and opposite vectors,
including non-four-lane dimensions. Its actual browser consumer remains
`utils/simd-math-engine.ts` through `utils/semantic-similarity-engine.ts`.

At assessment time, a pre-existing invalid JavaScript typed-array byte offset in
the host buffer pool prevented the public batch wrapper from reaching the
arithmetic; the semantic matrix caller used a JavaScript fallback. IMP-0195
records that historical finding, not a successful acceleration result. Concurrent
browser-policy changes are preserved, while browser/DOM/workflow effects remain
JavaScript. This native task makes no performance claim for that separate work.
