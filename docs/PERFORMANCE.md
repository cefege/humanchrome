# Performance Profile — HumanChrome

Static profile of the bridge (Node native-messaging host) and the chrome-mv3
extension build. Numbers were captured on macOS 25.3 (arm64), Node v25.9.0,
HumanChrome `main` @ `8ab8b50` on 2026-05-03.

This is a **static measurement pass** (no Chrome runtime, no MCP-tool
load test). Goal: surface bundle hotspots and obvious bridge-side wins.

---

## 1. Build artifact sizes — `app/chrome-extension/.output/chrome-mv3/`

Total unpacked: **18 MB**

| Subdir             | Size   | Notes                                |
| ------------------ | ------ | ------------------------------------ |
| `workers/`         | 11 MB  | dominated by ONNX runtime wasm       |
| `chunks/`          | 3.2 MB | vendor + lazy-loaded JS chunks       |
| `inject-scripts/`  | 544 KB | per-tab injected helpers             |
| `libs/`            | 356 KB | ort.min.js                           |
| `assets/`          | 220 KB | css + fonts                          |
| `content-scripts/` | 120 KB | element-picker, quick-panel, content |
| `_locales/`        | 40 KB  | en + zh_CN                           |
| `icon/`            | 40 KB  | PNGs                                 |

Top-level bundles:

- `background.js` — **2.0 MB** (180 lines minified, ~2.1 M chars)
- `web-editor-v2.js` — **444 KB**

### Top 10 files by size

| Size   | File                                                             |
| ------ | ---------------------------------------------------------------- |
| 11 MB  | `workers/ort-wasm-simd-threaded.wasm`                            |
| 2.0 MB | `background.js`                                                  |
| 1.4 MB | `chunks/elk.bundled-DBPVEpgc.js` (graph layout, used by builder) |
| 628 KB | `chunks/sidepanel-MZ9itGUw.js`                                   |
| 508 KB | `chunks/transformers.web-C87lXDS5.js`                            |
| 444 KB | `web-editor-v2.js`                                               |
| 352 KB | `libs/ort.min.js`                                                |
| 264 KB | `chunks/builder-CR0QETEu.js`                                     |
| 120 KB | `chunks/dist-BCMNnzAS.js`                                        |
| 106 KB | `inject-scripts/web-fetcher-helper.js`                           |

The single largest item — `ort-wasm-simd-threaded.wasm` at 11 MB — is ONNX
Runtime for the in-browser semantic-similarity model. It dominates the
distribution but is loaded on demand by the worker.

---

## 2. Largest tracked source files (excluding lockfile + wasm)

```
3621 app/chrome-extension/entrypoints/web-editor-v2/ui/shadow-host.ts
3062 app/chrome-extension/inject-scripts/web-fetcher-helper.js
2869 app/chrome-extension/public/libs/ort.min.js
2801 app/chrome-extension/inject-scripts/element-marker.js
2715 app/chrome-extension/entrypoints/web-editor-v2/ui/property-panel/controls/gradient-control.ts
2624 app/chrome-extension/entrypoints/popup/App.vue
2393 app/chrome-extension/inject-scripts/props-agent.js
2392 app/chrome-extension/entrypoints/web-editor-v2/ui/property-panel/controls/effects-control.ts
2363 app/chrome-extension/utils/semantic-similarity-engine.ts
1950 app/chrome-extension/inject-scripts/recorder.js
1913 app/chrome-extension/entrypoints/web-editor-v2/core/transaction-manager.ts
1854 app/chrome-extension/inject-scripts/accessibility-tree-helper.js
```

Largest bridge-side files:

```
1599 app/native-server/src/agent/engines/claude.ts
1264 app/native-server/src/server/routes/agent.ts
1099 app/native-server/src/scripts/doctor.ts
 962 app/native-server/src/agent/engines/codex.ts
 847 app/native-server/src/scripts/report.ts
```

---

## 3. Bridge cold-start cost

`/usr/bin/time -p node app/native-server/dist/cli.js --help` (5 runs):

```
real 0.08
real 0.07
real 0.07
real 0.07
real 0.07
```

**Median: ~70 ms** (Node v25 startup + commander `--help` parse).

`time node … doctor --json` (3 runs): **143–153 ms**, median **~143 ms**.
The added cost over `--help` (~70 ms) is dominated by an HTTP `fetch` of the
extension health endpoint (see profile below).

`time node … report --json` (3 runs): **464–482 ms**, median **~470 ms**.
The extra ~330 ms over `doctor` is the `report` tool spawning child
processes (`pnpm`, `git`, `which …`) to gather environment metadata.

`dist/` is small (1.2 MB total, top file `agent/engines/claude.js` at 68 KB),
so module-load cost is dominated by Node’s own builtin loading.

---

## 4. Bridge module-load tree

`node --trace-warnings -e "console.time('load'); require('./app/native-server/dist'); console.timeEnd('load')"`

```
load: 208.17ms
```

So requiring the `index.js` entry (which pulls in the file-handler,
native-messaging-host, logger, and zod schemas) costs ~208 ms on top of
Node’s ~70 ms startup.

V8 sample profile of `cli.js doctor --json` (81 ticks at 1 kHz):

- 67.9 % `UncheckedCast<TrustedObject>` — V8 internal, mostly module loading
- 47.3 % of those traced back to `compileForInternalLoader` →
  `requireBuiltin` (Node bootstrap)
- 16.0 % `_pselect$DARWIN_EXTSN` — kernel wait on the connectivity check
- The doctor’s `checkConnectivity` HTTP fetch shows up as 4 of the 81 ticks
  (~5 %), and is the only userland code in the top callers

Userland code is too quick to register meaningfully in a 150 ms run; the
profile is dominated by Node bootstrap and the connectivity probe.

---

## 5. Idle memory (RSS)

Sampled with `ps -o rss=` every 100 ms:

| Command         | Min RSS | Max RSS | Avg RSS | Notes                             |
| --------------- | ------- | ------- | ------- | --------------------------------- |
| `report --json` | 38 MB   | 58 MB   | 50 MB   | 12 samples over 1.2 s             |
| `doctor --json` | 48 MB   | 55 MB   | 52 MB   | 2 samples (process exits ~150 ms) |

Steady-state RSS for the bridge process is in the **40–60 MB** range, which
is normal for a Node 25 process loading zod, undici, fastify, and the agent
engine scaffolding. There is no detectable memory creep over the short
sampling window — the only resident long-running timer is the file-handler
cleanup which runs every 30 minutes (`.unref()`-ed).

---

## 6. Hot-path scans (static)

### 6a. `JSON.stringify` of potentially large payloads

**Status: largely capped.** A unified `truncate.ts` utility
(`app/chrome-extension/utils/truncate.ts`, 130 lines) defines a
`TruncateEnvelope` shape and is used by the high-volume tools:

- `network-capture-debugger.ts` — uses `truncateString` for response bodies,
  caps `MAX_REQUESTS_PER_CAPTURE`
- `network-capture-web-request.ts` — same
- `console.ts` — per-arg truncation envelope, recursive
  `[...truncated]` sentinels in deep objects
- `read-page.ts` — `truncateArray` on fallback element list, `FALLBACK_ELEMENT_LIMIT`
- `vector-search.ts` — sentence/word boundary truncation for embeddings
- `gif-enhanced-renderer.ts` — local `truncate()` for label rendering

Two `JSON.stringify` sites that are **not** wrapped:

1. `screenshot.ts:299` — emits the full base64 image inline when
   `storeBase64=true`. Image is already JPEG-compressed at 0.7 scale / 0.8
   quality (`screenshot.ts:286-290`), so the cap is implicit but real.
2. `network-capture-debugger.ts:1000` — emits the full sorted `requests`
   array on stop. Bodies inside each request are individually truncated,
   but the outer array is bounded only by `MAX_REQUESTS_PER_CAPTURE`. If
   that constant is set to a few thousand the resulting JSON could be tens
   of MB. Worth verifying the cap value.

### 6b. Sequential `await` in loops

Found in 14 background files. Most are intentional (must serialize CDP
ops, debugger detach must precede next attach, etc.). Two worth a look:

- `tools/browser/computer.ts:991` — `fill_form` action iterates form
  elements one at a time with `await fillTool.execute(...)`. For an N-field
  form this is N round-trips to the content script. Could likely be
  parallelized with `Promise.all` (different fields rarely race) for a
  rough N× speedup on large forms — but order-dependent forms (cascading
  selects) would break, so this is best behind an opt-in flag.

- `tools/browser/network-capture-debugger.ts:957` — sequentially stops
  capture on each remaining tab during teardown. Cosmetic; teardown is
  rare.

- `tools/browser/computer.ts:1048` — sequential `dispatchSimpleKey` /
  `dispatchKeyChord` for keystrokes. **Must** stay sequential to preserve
  key order and timing.

### 6c. `setInterval` / `clearInterval` pairing

Each `setInterval` site has a matching `clearInterval`:

| File                                                             | setInterval           | clearInterval                                             |
| ---------------------------------------------------------------- | --------------------- | --------------------------------------------------------- |
| `app/native-server/src/index.ts:15`                              | file cleanup, 30 min  | `.unref()` — no clear, but unref so process exits cleanly |
| `app/native-server/src/agent/stream-manager.ts:239`              | heartbeat             | line 264                                                  |
| `app/chrome-extension/shared/element-picker/controller.ts:730`   | poll                  | line 488                                                  |
| `app/chrome-extension/entrypoints/offscreen/rr-keepalive.ts:178` | ping                  | line 195                                                  |
| `…record-replay-v3/engine/queue/leasing.ts:26`                   | lease check           | lines 40, 64                                              |
| `…record-replay-v3/engine/queue/scheduler.ts:270`                | poll                  | line 290                                                  |
| `…popup/App.vue:1188, 1232`                                      | model + engine status | lines 1185/1222, 1229/1243                                |
| `…sidepanel/composables/useWorkflowsV3.ts:306`                   | refresh               | line 334                                                  |

No leaks found.

---

## Optimization candidates

| #   | Suggestion                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Effort | Expected gain                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Lazy-load ONNX runtime + embedding worker.** 11 MB wasm + 508 KB transformers chunk + 52 KB engine chunk are only needed when the user enables semantic search. Defer the wasm fetch until the first `vector_search` / `semantic-similarity` call. The `manifest.json` already exposes `web_accessible_resources: ["/workers/*", "/models/*"]`, so this is a code-path change rather than a packaging one.                                                              | **M**  | ~11.5 MB off the install footprint of features that don’t need it; faster cold-install in unpacked / `chrome.management` flows. |
| 2   | **Code-split `chunks/elk.bundled-…js` (1.4 MB).** ELK is a graph-layout library used by the builder graph view. Audit whether the builder route already lazy-imports it; if it’s pulled into a top-level chunk (e.g. shared with sidepanel) move it behind a dynamic `import()` in the builder canvas component only.                                                                                                                                                     | **S**  | ~1.4 MB off non-builder routes, faster builder→popup navigation.                                                                |
| 3   | **Tighten `network_capture_stop` payload.** Wrap the outer `requests` array in the existing `TruncateEnvelope` and verify `NetworkDebuggerStartTool.MAX_REQUESTS_PER_CAPTURE`. A capture run on a single-page-app can produce hundreds of requests; the JSON-string round-trip into the bridge today is unbounded by design. Surface a `truncated:true` flag so the LLM can ask for a paged read.                                                                         | **S**  | Bounded MCP response sizes, fewer pathological large payloads through native messaging (which has a 1 MB / message ceiling).    |
| 4   | **Parallelize `fill_form`.** `computer.ts:991` runs N field fills sequentially. Add an opt-in `parallel: boolean` arg (default `false` to preserve cascading-select semantics) and wrap the iteration in `Promise.all`. Useful for long forms where each field is independent.                                                                                                                                                                                            | **S**  | ~N× reduction in latency for large independent forms.                                                                           |
| 5   | **Reduce bridge cold-start by deferring zod schema construction.** Module-load is ~208 ms even before any work. The bulk of that is constructing zod schemas at module top-level (`FileOperationPayloadSchema`, MCP tool schemas). For short-lived commands like `--help` / `--version` we don’t need them. Either gate schema construction behind a getter or move CLI bootstrap out of `index.js` into its own dist entry that doesn’t pull file-handler / native-host. | **M**  | ~100 ms off `--help` / `register` / `update-port` invocations; better UX during postinstall + register flows.                   |

---

## What is **not** measured

- True Chrome cold-start (service-worker boot time, manifest parse, content-script attach latency). Requires an instrumented Chrome session.
- MCP tool-call latency under load. No benchmark harness exists; would need a synthetic JSON-RPC client driving the bridge over native messaging or stdio.
- Memory growth of the long-running background service worker. Only the bridge process was sampled.
- Real-world payload sizes for `network_capture` and `accessibility-tree`. Without driving real pages we can’t see how often the existing truncation kicks in.
- WASM compile time for the 11 MB `ort-wasm-simd-threaded.wasm` on first use — likely the largest single startup cost when semantic features are enabled.
- LLM token cost of tool responses. The unified `TruncateEnvelope` defends against pathological cases, but no histogram exists of typical tool-response sizes.
