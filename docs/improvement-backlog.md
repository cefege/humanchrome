# humanchrome improvement backlog

This file is the working list for what to improve in humanchrome next. It's
co-edited by the user and by three "scout" subagents that propose new items.

## How to use

- **Run `/improve` in Claude Code** to refresh the backlog (if stale) and pick
  one item to implement. The orchestrator runs all three scouts in parallel,
  re-triages, and shows you the top 5 to pick from. Picked items spawn an
  implementer agent in an isolated git worktree — review the diff before
  committing.
- **Edit by hand** any time. Add notes, change priority hints (cost/value),
  re-word `why`, or move an item to `wontdo`. Scouts dedupe by title-keyword
  similarity and won't clobber your edits.
- **Optional daily refresh**: invoke the `/schedule` skill once to set up an
  overnight cron that re-runs the scouts so morning `/improve` is instant.
  Suggested prompt for the scheduled job:
  > Run feature-scout, bug-scout, and optimization-scout in parallel against
  > this repo. Each appends to docs/improvement-backlog.md and runs the triage
  > script. Don't ask any questions; this is unattended.

<!--
Co-edited by you and the scout agents. Add notes freely; scouts dedupe by id
and title-similarity and won't clobber your edits.

Format spec:
  ### IMP-NNNN · {title} ({kind}) · score: {N}
  - **Proposed by**: {agent-name} · {YYYY-MM-DD}
  - **Status**: proposed | queued | in-progress | done | wontdo
  - **Why**: {1-3 lines}
  - **Cost**: S | M | L  (or hours/days)
  - **Value**: S | M | L
  - **Notes**: free text. Scouts won't overwrite this field.
  - **Repro** / **Fix sketch**: bug-only fields
  - **Worktree**: {path/branch}  ← set by /improve when you pick this item

  kinds: feat | bug | perf | refactor | docs

Triage scoring (computed by .claude/scripts/triage-backlog.mjs):
  score = value_weight + urgency_weight - cost_weight + freshness_weight
    value_weight:    S=2, M=4, L=6
    cost_weight:     S=0, M=1, L=2
    urgency_weight:  bug=+2, regression=+3, otherwise 0
    freshness_weight: -1 if proposed >14 days ago and still queued

The order of items inside ## Active is sorted by score descending.
-->

## Active

### IMP-0055 · Split model-cache helpers out of semantic-similarity-engine.ts so the service worker stops inlining @huggingface/transformers and onnxruntime-web (~1.2 MB) (perf) · score: 6

- **Proposed by**: audit-bundle · 2026-05-08
- **Status**: proposed
- **Why**: background.js is 2.16 MB because Rolldown collapsed the dynamic import(@huggingface/transformers) at semantic-similarity-engine.ts:23 into an inlined Promise.resolve. Root cause: the SW statically imports cleanupModelCache (entrypoints/background/index.ts:7) and hasAnyModelCache (entrypoints/background/semantic-similarity.ts:5) from the same file that hosts the engine, so Rolldown drags the whole module — including transformers (~700 KB) and onnxruntime-web (~500 KB) — into the SW chunk. The offscreen entrypoint already owns the engine instance correctly; the SW just needs to not co-import status helpers from the heavy module.
- **Cost**: S
- **Value**: L
  **Fix sketch**: extract `hasAnyModelCache` and `cleanupModelCache` into a tiny `utils/model-cache-status.ts` that touches only IndexedDB — no transformers/onnxruntime/SIMDMathEngine reach. Re-point `entrypoints/background/index.ts:7` and `entrypoints/background/semantic-similarity.ts:5` to the new file. Verify by checking `.output/chrome-mv3/background.js` size and grepping for `transformers.js/${l}` UA marker (currently present, should disappear). Expected: SW shrinks from 2.16 MB to ~1 MB.

### IMP-0027 · Add chrome_history_delete tool to remove history entries by URL or time range (feat) · score: 4

- **Proposed by**: feature-scout · 2026-05-07
- **Status**: proposed
- **Why**: chrome_history only searches/reads. Agents automating privacy-sensitive workflows (clearing traces after a scrape session, removing test visits before asserting history state) must open the Chrome UI to delete. chrome.history.deleteUrl, deleteRange, and deleteAll are already within the history permission the extension declares. Completes the read/write lifecycle the same way bookmark_delete rounds out the bookmark group.
- **Cost**: S
- **Value**: M
  New tool chrome_history_delete. Params: url? (delete single URL), startTime?/endTime? (delete range — same date-parse conventions as chrome_history), all?: boolean (deleteAll shortcut, requires explicit true to avoid accidents). Returns { deleted: number } via chrome.history.deleteUrl/deleteRange/deleteAll. Touch: history.ts (add execute branch or second class), TOOL_NAMES.BROWSER.HISTORY_DELETE, TOOL_SCHEMAS entry, TOOL_CATEGORIES map. Zero new infrastructure — same permission already granted.

### IMP-0028 · Add flush action to chrome_network_capture for mid-session drain without stopping (feat) · score: 4

- **Proposed by**: feature-scout · 2026-05-07
- **Status**: proposed
- **Why**: chrome_network_capture action=stop returns all accumulated entries and tears down the listener. In long-running scrape sessions (e.g. scrolling an infinite feed for 5 minutes) an agent cannot drain the buffer periodically to stay within context limits — it must stop, read, restart, losing requests that arrive during the restart gap. A flush action returns and clears the internal buffer while keeping the webRequest/debugger listener attached.
- **Cost**: S
- **Value**: M
  Add action enum value flush to the chrome_network_capture schema (alongside start and stop). Implementation: the existing handler already accumulates requests in an in-memory array; flush returns a snapshot of that array and splices it empty without calling stop(). Returns the same shape as stop (requests[], requestCount, etc.). Touch: tools/browser/network-capture.ts handler, TOOL_SCHEMAS action enum. No new infrastructure — flush is a pure read+clear of the existing buffer.

### IMP-0032 · Strip verbose debug logging and unconditional setDebugLogs(true) from vector-database.ts hot path (perf) · score: 4

- **Proposed by**: optimization-scout · 2026-05-07
- **Status**: proposed
- **Why**: VectorDatabase.search() and addDocument() emit 158 console.log calls across their execution paths, including per-call logs like "Processing N search neighbors", "Available documents in mapping", and "About to call addPoint". In addition, hnswlib.EmscriptenFileSystemManager.setDebugLogs(true) is unconditionally set on every initialization, flooding the service-worker console with WASM FS noise. Both are debug artifacts that add synchronous string-formatting overhead on every embedding lookup.
- **Cost**: S
- **Value**: M
- **Files**: (1557 LoC, 158 console.log calls)
- **Sketch**: Replace the 158 console.log with a single debug-flag guard (const DEBUG = false) at the top of the file; calls become if (DEBUG) console.log(...). Change setDebugLogs(true) to setDebugLogs(false). Keep console.error for real errors.
- **Risk**: Low. No behavior change. Loss of verbose tracing for future debugging mitigated by the DEBUG flag being a one-line change to re-enable.

### IMP-0041 · Add chrome_list_injected_scripts tool to enumerate active injections per tab (feat) · score: 4

- **Proposed by**: feature-scout · 2026-05-08
- **Status**: proposed
- **Why**: chrome_inject_script and chrome_send_command_to_inject_script cover write and message, but agents have no read path. Before injecting a monitoring bridge or mutation observer, an agent must blindly inject again (risking duplicates) or reload the tab. chrome_list_injected_scripts returns the existing injectedTabs Map as [{tabId, scriptId, sourceUrl, injectedAt}], enabling idempotent inject-once patterns and safe pre-flight checks.
- **Cost**: S
- **Value**: M
  Touch: tools/browser/inject-script.ts (expose injectedTabs read path), TOOL_NAMES.BROWSER.LIST_INJECTED_SCRIPTS, TOOL_SCHEMAS entry, TOOL_CATEGORIES (same category as INJECT_SCRIPT). No new infrastructure — reads the Map already maintained by the existing inject handler. Zero new permissions.

### IMP-0044 · Add chrome_list_frames tool to enumerate iframes and their frameIds in a tab (feat) · score: 4

- **Proposed by**: feature-scout · 2026-05-08
- **Status**: proposed
- **Why**: chrome_click_element, chrome_fill_or_select, and chrome_await_element all accept a frameId param for iframe-targeted operations, but there is no MCP tool to discover frame IDs. Agents currently inject JS to walk window.frames — which is cross-origin-blocked for sandboxed iframes and returns unstable numeric indexes. chrome.webNavigation.getAllFrames returns stable frameId values per origin, indexed independently of the DOM tree.
- **Cost**: S
- **Value**: M
  New tool chrome_list_frames. Params: tabId? (standard tab targeting). Returns [{frameId, url, parentFrameId, name}]. Implementation: chrome.webNavigation.getAllFrames({tabId}) in the extension background. Audit whether webNavigation is already declared in wxt.config.ts permissions — if not, add it and note the Web Store review trigger. Touch: new tools/browser/list-frames.ts, TOOL_NAMES.BROWSER.LIST_FRAMES, TOOL_SCHEMAS entry, TOOL_CATEGORIES (Page category alongside READ_PAGE).

### IMP-0047 · Add chrome_storage tool to read, write, and clear web app localStorage and sessionStorage (feat) · score: 4

- **Proposed by**: feature-scout · 2026-05-08
- **Status**: proposed
- **Why**: Agents automating web apps (login flows, onboarding tests, state-seeding) must currently inject raw JS to read or clear localStorage and sessionStorage. A dedicated tool reduces prompt complexity, avoids quoting/escaping hazards in chrome_javascript payloads, and is more discoverable than a JS snippet. Particularly useful for clearing auth state between test runs or pre-seeding feature flags without opening DevTools.
- **Cost**: S
- **Value**: M
  New tool chrome_storage. Params: action: get|set|remove|clear|keys (required), scope: local|session (default: local), key? (required for get/set/remove), value? (required for set), tabId?/windowId?/frameId?. Implementation: chrome.scripting.executeScript MAIN-world shim that reads/writes window.localStorage or window.sessionStorage. Returns {value} for get, {keys: string[]} for keys, {cleared: number} for clear. IndexedDB access deferred to a follow-up. Touch: new tools/browser/storage.ts, TOOL_NAMES.BROWSER.STORAGE, TOOL_SCHEMAS entry, TOOL_CATEGORIES (Page category).

### IMP-0048 · chrome_performance_start_trace returns isError:false when a trace is already running (bug) · score: 4

- **Proposed by**: bug-scout · 2026-05-08
- **Status**: proposed
- **Why**: When a trace session already exists for the active tab, PerformanceStartTraceTool returns { content: [{ text: "Error: a performance trace is already running." }], isError: false }. Agents that branch on isError proceed as if the second start succeeded and never recover the in-progress trace.
- **Cost**: S
- **Value**: S
- **Repro**: Call `chrome_performance_start_trace` twice on the same tab without stopping in between. Expected: second call returns isError:true. Actual: returns isError:false with an "Error:" string embedded in the text body.
- **Fix sketch**: `/Users/mike/Documents/Code/humanchrome/app/chrome-extension/entrypoints/background/tools/browser/performance.ts` line 164 — replace the early `return { content: [...], isError: false }` with `return createErrorResponse("A performance trace is already recording for this tab.", ToolErrorCode.UNKNOWN)`.
- **Notes**: Latent. Same isError:false-for-errors pattern also appears at line 263 (stop with no session) and line 362 (analyze with no trace), but those are more debatable as idempotent no-ops.

### IMP-0050 · Add chrome_close_tabs_matching tool for bulk tab cleanup after navigate_batch fan-out (feat) · score: 4

- **Proposed by**: feature-scout · 2026-05-08
- **Status**: proposed
- **Why**: chrome_navigate_batch opens many tabs in parallel, but cleanup requires iterating chrome_get_windows_and_tabs and calling chrome_close_tab once per tab — O(N) round trips for a common workflow. A single bulk-close tool with URL/title/age filters covers the post-scrape cleanup pattern in one call and keeps the window tidy for the next agent interaction.
- **Cost**: S
- **Value**: M
  New tool chrome_close_tabs_matching. Params: urlMatches? (substring or /regex/ string), titleMatches? (substring or /regex/ string), olderThanMs? (close tabs opened more than N ms ago), exceptTabIds? (number[], always preserve these), windowId? (default: preferred client window, honoring single-window preference). Returns {closed: number, tabIds: number[]}. Implementation: chrome.tabs.query filtered in the background, then chrome.tabs.remove(matchingIds). Never closes the last tab in the window (consistent with IMP-0062 last-tab guard commit). Touch: new tools/browser/close-tabs-matching.ts, TOOL_NAMES.BROWSER.CLOSE_TABS_MATCHING, TOOL_SCHEMAS entry, TOOL_CATEGORIES (Tabs category alongside CLOSE_TAB).

### IMP-0051 · chrome_performance_analyze_insight returns isError:false when no trace has been recorded (bug) · score: 4

- **Proposed by**: bug-scout · 2026-05-08
- **Status**: proposed
- **Why**: When LAST_RESULTS has no entry for the active tab, PerformanceAnalyzeInsightTool returns { content: [{ text: "No recorded traces found..." }], isError: false }. Agents that branch on isError treat the pre-condition failure as a successful (empty) analysis and do not retry the start/stop sequence.
- **Cost**: S
- **Value**: S
- **Repro**: Call `chrome_performance_analyze_insight` on a tab that has never had a trace. Expected: isError:true. Actual: isError:false, success:undefined, text says "No recorded traces found".
- **Fix sketch**: `/Users/mike/Documents/Code/humanchrome/app/chrome-extension/entrypoints/background/tools/browser/performance.ts` lines 361–371 — replace the early return with `return createErrorResponse("No recorded trace for this tab. Call chrome_performance_start_trace then chrome_performance_stop_trace first.", ToolErrorCode.UNKNOWN)`.
- **Notes**: Latent. Same root cause as IMP-0048 — the performance tool family uses plain text error strings with isError:false rather than createErrorResponse.

### IMP-0054 · Extract executeAction switch in computer.ts into per-action handler modules (click, scroll, fill, screenshot) (refactor) · score: 4

- **Proposed by**: optimization-scout · 2026-05-08
- **Status**: in-progress (slice 1 of N landed: CDPHelper extracted to `browser/computer/cdp-helper.ts`)
- **Why**: After IMP-0008 (domain-shift helper) and IMP-0035 (params typing), the dominant bulk in computer.ts is a 16-case switch inside executeAction spanning lines 392-1348 (~956 LoC). Representative case sizes: left_click_drag 93 LoC, zoom 98 LoC, screenshot 147 LoC. Adding a new action or fixing a case requires navigating past all 15 others. CDPHelper (lines 142-310) is already a self-contained class that could be elevated to a sibling module without any refactor risk.
- **Cost**: M
- **Value**: M
- **Files**: `app/chrome-extension/entrypoints/background/tools/browser/computer.ts` (1478 LoC; executeAction lines 392-1348 ~956 LoC switch; CDPHelper lines 142-310)
- **Sketch**: Slicing into focused PRs. Slice 1 (done): move CDPHelper to `browser/computer/cdp-helper.ts` (~168 LoC). Slice 2: extract `browser/computer/actions/click-actions.ts` (left_click/right_click/double_click/triple_click/left_click_drag). Slice 3: scroll-actions.ts. Slice 4: fill-actions.ts. Slice 5: screenshot-actions.ts. Slice 6: replace switch with `const HANDLERS: Record<string, ActionHandler> = {...}` dispatch table. After all slices: computer.ts shrinks to ~250-LoC orchestrator with execute()/mapActionToCapture()/triggerAutoCapture()/domHoverFallback().
- **Risk**: Medium — CDP timeout wrapper composes around handler dispatch; shared helpers (project, screenshotContextManager lookups) passed via deps object. No runtime change. Extension test suite catches regressions.

### IMP-0056 · Lazy-load tool handlers in tools/index.ts so heavy ones (gif-recorder, performance, network-capture-debugger, computer, read-page) do not instantiate at SW boot (perf) · score: 4

- **Proposed by**: audit-bundle · 2026-05-08
- **Status**: proposed
- **Why**: tools/index.ts:3 does import \* as browserTools from ./browser, which through tools/browser/index.ts star-exports every tool file and constructs export const xxxTool = new XxxTool() at module-eval time. All 40+ tools — including gif-recorder, gif-enhanced-renderer, performance traces, network-capture-debugger, computer, vector-search, read-page, userscript — are instantiated on every service-worker cold-start, even when the user never calls them. Estimated ~80–120 KB of bundled code plus per-instance allocations on every browser wake.
- **Cost**: M
- **Value**: M
  **Fix sketch**: replace the eager toolsMap (built from Object.values(browserTools)) with a lazy registry shaped as Record<string, () => Promise<BrowserToolExecutor>>. In handleCallTool (or wherever the dispatch happens), await registry[name]() then call execute. Memoize the resolved tool per name so subsequent calls do not re-import. Start with the 8 heaviest tools listed in the title; the rest can stay eager if their footprint is trivial. Acceptance: background.js shrinks; no tool regression in the 694-test extension suite.

### IMP-0057 · Defer vector-search dependency chain so vector-database.ts and hnswlib-wasm-static stop landing in the service worker (perf) · score: 4

- **Proposed by**: audit-bundle · 2026-05-08
- **Status**: proposed
- **Why**: tools/browser/vector-search.ts:9 static-imports ContentIndexer from utils/content-indexer.ts (586 LoC), which transitively pulls utils/vector-database.ts (1557 LoC) and the hnswlib-wasm-static loader stub. The chrome_vector_search tool runs only when explicitly invoked; today the entire indexing/search engine is parsed on every SW cold-start. Estimated ~50–80 KB off the SW chunk plus removing a wasm pre-init cost from boot.
- **Cost**: S
- **Value**: M
  **Fix sketch**: wrap the imports inside the tool lazy initializer. In tools/browser/vector-search.ts, change the top-level static import to a dynamic one inside a getIndexer() helper that memoizes a single ContentIndexer instance. The tool execute() awaits getIndexer() before calling search. Alternative (cleaner long-term): move vector ops to the offscreen document and have the tool message-pass — same pattern the semantic-similarity engine already uses. Pairs naturally with the lazy tool-registry change.

### IMP-0059 · Make logger.persist delta-based or opt-in so chrome.storage.local stops re-serializing the whole 5 MB log ring every 250 ms during tool streams (perf) · score: 4

- **Proposed by**: audit-bundle · 2026-05-08
- **Status**: proposed
- **Why**: utils/logger.ts:184 schedulePersist debounces a chrome.storage.local.set of the ENTIRE log buffer at 250 ms. Each tool call emits ~3 logEvents (start/done + child line) and each goes through redact() (recursive object walk depth 6) before being appended to the ring. During a hot tool stream this means: 4 redact-walks/sec, plus a 250 ms-debounced JSON.stringify of up to 5 MB of buffered logs (trimToByteBudget at logger.ts:142,154 also stringifies inside the byte-budget check). This is the dominant steady-state SW CPU cost during automation runs — completely separate from the actual tool work.
- **Cost**: S
- **Value**: M
  **Fix sketch**: three options, pick whichever matches usage. (a) Gate persistence behind a flag set by the chrome_debug_dump tool — the only consumer that actually needs the persisted buffer — and clear it on next dump. (b) Raise the debounce from 250 ms to 5 s; trade a small loss on SW-restart for 20x less serialization. (c) Append-only delta persist: track lastPersistedIndex, only write entries since that index. (a) is simplest if the buffer is rarely needed; (b) is safest. Acceptance: profile a 60s tool-call stream and confirm chrome.storage.local writes drop from ~240 to <20.

### IMP-0009 · Split ClaudeEngine.initializeAndRun into focused sub-methods (refactor) · score: 3

- **Proposed by**: optimization-scout · 2026-05-05
- **Status**: in-progress
- **Why**: ClaudeEngine at 1601 LoC has a single public method `initializeAndRun` that spans roughly lines 62-1292 (~1230 lines). It interleaves SDK loading, env construction, tool-input streaming accumulation, stderr buffering, and HumanChrome bridge setup. Any change to stream parsing risks breaking error classification and vice versa. Splitting into private sub-methods (buildQuery, accumulateToolInput, processAssistantEvent, finalizeRun) would make each concern independently testable and cut the cognitive surface of the hot loop to <150 lines.
- **Cost**: M
- **Value**: M
- **Files**: `app/native-server/src/agent/engines/claude.ts` (1601 LoC)
- **Sketch**: Extract at minimum: `private async loadSdk()` (slice 1 landed), `private buildRunOptions(...)`, `private async processEventStream(stream, ctx, runLog)` (owns the big for-await loop), `private emitToolCall(...)`. `initializeAndRun` becomes an orchestrator of ~80 lines.
- **Risk**: Medium — the event loop is stateful (pendingToolInputs map, assistantBuffer); extraction must preserve the shared-state references. No behavior change.

### IMP-0019 · Split semantic-similarity-engine.ts into model-registry, memory-pool, proxy, and engine modules (refactor) · score: 3

- **Proposed by**: optimization-scout · 2026-05-06
- **Status**: in-progress
- **Why**: At 2363 LoC the file bundles four unrelated concerns: model-registry (253 lines of PREDEFINED_MODELS + recommenders), EmbeddingMemoryPool (54 lines), SemanticSimilarityEngineProxy (312 lines, offscreen IPC only), and SemanticSimilarityEngine itself (1570 lines of ONNX + SIMD + tokenization). The offscreen entrypoint only imports SemanticSimilarityEngine, so Proxy is dead weight in that bundle. Splitting lets the proxy be tree-shaken where unused and makes the ONNX inference loop independently navigable.
- **Cost**: M
- **Value**: M
- **Files**: `app/chrome-extension/utils/semantic-similarity-engine.ts` (2363 LoC), `app/chrome-extension/entrypoints/offscreen/main.ts` (imports Engine only)
- **Sketch**: Extract to `utils/semantic-similarity/model-registry.ts` (PREDEFINED_MODELS, recommenders, size helpers), `utils/semantic-similarity/memory-pool.ts` (EmbeddingMemoryPool class), `utils/semantic-similarity/proxy.ts` (SemanticSimilarityEngineProxy), `utils/semantic-similarity/engine.ts` (SemanticSimilarityEngine). Re-export all from `utils/semantic-similarity-engine.ts` as a barrel so import paths stay valid.
- **Risk**: Low — purely mechanical split; WXT auto-import resolves from the barrel. The only risk is circular imports between engine and memory-pool, which are avoided by pool not importing engine.

### IMP-0021 · Split packages/shared/src/tools.ts into per-category schema files (refactor) · score: 3

- **Proposed by**: optimization-scout · 2026-05-06
- **Status**: in-progress
- **Why**: tools.ts is 1969 LoC with TOOL_SCHEMAS spanning lines 121-1877 (1757 lines, ~45 tool definitions). Every tool addition touches this one file, creating merge conflicts when multiple features land in parallel. Splitting into per-category files (navigation.ts, interaction.ts, media.ts, workflows.ts, etc.) limits each PR to one file, and the category coverage test already enforces completeness — so the test harness works as-is after the split.
- **Cost**: M
- **Value**: M
- **Files**: `packages/shared/src/tools.ts` (1969 LoC) — 1757 lines are schema objects, 120 lines are shared fragments (TAB_TARGETING, SELECTOR_PROP etc.), 92 lines are TOOL_CATEGORIES
- **Sketch**: Create `packages/shared/src/tool-schemas/` directory. Move shared fragments to `fragments.ts`. Create one file per TOOL_CATEGORY_ORDER entry (navigation.ts, tabs.ts, interaction.ts, page.ts, media.ts, network.ts, cookies.ts, workflows.ts, pacing.ts). Re-export all arrays from `tools.ts` as `export const TOOL_SCHEMAS = [...navigation, ...tabs, ...]`. TOOL_NAMES and TOOL_CATEGORIES stay in `tools.ts`.
- **Risk**: Medium — any consumer that imports from `humanchrome-shared` and does `import { TOOL_SCHEMAS }` keeps working; internal cross-file fragment imports must not create circular deps. Run `pnpm -w build` + coverage test as acceptance gate.

### IMP-0022 · Type record-replay NodeRuntime step generics to eliminate 60+ as any casts across node files (refactor) · score: 3

- **Proposed by**: optimization-scout · 2026-05-06
- **Status**: in-progress
- **Why**: The 10+ node files (click.ts, fill.ts, assert.ts, download-screenshot-attr-event-frame-loop.ts, etc.) all use NodeRuntime<any> and cast step as any before accessing step-specific fields. expandTemplatesDeep<T>(value: T, scope) already preserves the type but callers force-cast to any before calling it, discarding inference. Each file also repeats (located as any)?.ref and (located as any)?.frameId because locateElement returns an untyped shape. Typing NodeRuntime with concrete step interfaces (StepClick, StepFill, etc., already defined in legacy-types.ts) eliminates ~60 casts and catches field mismatches at compile time.
- **Cost**: M
- **Value**: M
- **Files**: nodes/click.ts (23 casts), nodes/fill.ts (21), nodes/assert.ts (16), nodes/download-screenshot-attr-event-frame-loop.ts (31), nodes/scroll.ts (4), nodes/navigate.ts (3), nodes/wait.ts (16) — total ~60 in node files
- **Sketch**: 1) Declare locateElement return type as interface LocatedElement { ref?: string; frameId?: number; resolvedBy?: string; cssSelector?: string }. 2) Change NodeRuntime<any> to NodeRuntime<StepClick> etc. using existing legacy-types. 3) Pass typed step to expandTemplatesDeep<StepClick> — the generic already supports this. Casts disappear file by file.
- **Risk**: Medium — some step fields (saveAs, filenameContains) are not yet in current interfaces and need extending. Compile errors guide the work; no runtime change.

### IMP-0023 · Split agent.ts route file into project, session, message, attachment, and streaming sub-routers (refactor) · score: 3

- **Proposed by**: optimization-scout · 2026-05-06
- **Status**: in-progress
- **Why**: agent.ts at 1264 LoC registers all agent-domain HTTP routes in a single registerAgentRoutes function (~53 Fastify route registrations). Sessions, projects, messages, attachments, and SSE streaming are independent concerns. Any change to SSE stream handling requires navigating past 600 lines of CRUD. Splitting into focused sub-routers (projects.ts, sessions.ts, messages.ts, attachments.ts, streaming.ts) caps each file at ~150-250 LoC and makes each endpoint group independently testable.
- **Cost**: M
- **Value**: M
- **Files**: (1264 LoC, ~53 route registrations)
- **Sketch**: Create directory. Extract: (CRUD + directory open), (CRUD + engine listing), (CRUD by project/session), (stats + cleanup), (SSE act/cancel — the hot path). Top-level becomes ~30-line orchestrator that calls each sub-router. AgentRoutesOptions interface stays in agent.ts or moves to a shared types file.
- **Risk**: Low — Fastify plugin registration is additive; splitting does not change route paths or method semantics. Import paths in the server entrypoint only change for agent.ts itself.

### IMP-0033 · Split transaction-manager.ts into dom-helpers, transaction-factories, transaction-appliers, and manager modules (refactor) · score: 3

- **Proposed by**: optimization-scout · 2026-05-07
- **Status**: proposed
- **Why**: transaction-manager.ts is 1913 LoC with four sections already delimited by comments: Style Helpers (line 178), Class Helpers (line 253), Structure Helpers (line 330), and Transaction Helpers (line 500), followed by the Transaction Manager implementation (line 1155, ~750 LoC). The file is a content-script module that is re-evaluated on every page injection; a smaller per-concern surface makes it easier to add new transaction types without risking regressions in unrelated apply logic.
- **Cost**: M
- **Value**: M
- **Files**: (1913 LoC)
- **Sketch**: Extract to (Style + Class helpers, ~150 LoC), (Structure + Move helpers, ~300 LoC), (createStyleTransaction, createTextTransaction, createClassTransaction, createMoveTransaction, createStructureTransaction, ~350 LoC), (applyStructureTransaction, applyMoveOperation, applyTransaction, ~200 LoC). becomes a ~200-line orchestrator exporting createTransactionManager. Re-export barrel preserves the existing import path.
- **Risk**: Medium. The sections are labeled but functions between them reference each other; factory functions call dom-helpers. Dependency order must be: dom-helpers -> structure-helpers -> factories -> appliers -> manager.

### IMP-0034 · Split background/web-editor/index.ts into sse-client, prompt-builder, normalizers, and message-router modules (refactor) · score: 3

- **Proposed by**: optimization-scout · 2026-05-07
- **Status**: proposed
- **Why**: app/chrome-extension/entrypoints/background/web-editor/index.ts is 1641 LoC and bundles four unrelated concerns inside a single initWebEditorListeners() export: SSE subscription / execution-status cache (lines 29-160), agent prompt builder (lines 412-670), input normalizer helpers (lines 263-410), and the 700-line chrome.runtime.onMessage switch. Any change to the prompt template requires navigating past the SSE client and vice versa. The file is evaluated in the service worker on extension start, so its parse time is in the critical path.
- **Cost**: M
- **Value**: M
- **Files**: (1641 LoC)
- **Sketch**: Extract to (subscribeToSessionStatus, executionStatusCache, handleSseEvent, ~160 LoC), (normalizeString, normalizeStringArray, normalizeStyleMap, normalizeApplyPayload, normalizeApplyBatchPayload, ~150 LoC), (buildAgentPrompt, buildAgentPromptBatch, ~260 LoC), (chrome.runtime.onMessage handler, ~700 LoC). index.ts becomes a 30-line orchestrator calling initWebEditorListeners.
- **Risk**: Low. No behavior change. Internal function references become cross-file imports. Message-router imports from all three helpers.

### IMP-0035 · Type computer.ts params to eliminate 24 remaining as any casts in action dispatch (refactor) · score: 3

- **Proposed by**: optimization-scout · 2026-05-07
- **Status**: proposed
- **Why**: computer.ts still has 24 as any casts after IMP-0008 removed the hostname-check blocks. The remaining casts are concentrated on params access in action branches (scroll, click_and_type, wait, multi-element fill) where params is typed as the broad ComputerActionParams union and callers cast to any rather than narrowing. The same unsafe pattern is also present in the wait_for text branch where 6 casts access params.text / params.timeoutMs / params.appear. Typing each action branch with a discriminated union or narrow interface eliminates runtime-invisible field mismatches.
- **Cost**: M
- **Value**: M
- **Files**: (1392 LoC, 24 as any)
- **Sketch**: 1) Audit the existing ComputerActionParams union type; add missing optional fields (text, duration, appear, timeoutMs, elements array) to the appropriate action member. 2) In each action branch, use a type assertion or in-narrowing ("text" in params) to get a typed view. 3) The multi-element fill loop at lines 955-972 can use a local interface ElementInput { ref?: string; value: string }. No new types needed beyond extending what already exists.
- **Risk**: Medium. The params union may need new fields that could conflict with future action additions. Compile errors are safe; no runtime change.

### IMP-0043 · Split editor.ts (web-editor-v2 core) into edit-session, broadcast, transaction-apply, and lifecycle modules (refactor) · score: 3

- **Proposed by**: optimization-scout · 2026-05-08
- **Status**: proposed
- **Why**: Single createWebEditorV2() factory bundles 7 concerns across 1566 LoC: text edit-session state machine (lines 174-310), hover/select handling (312-432), debounced broadcast (433-595), transaction-apply pipeline (596-1011), revert/clearSelection (1012-1045), 365-line start() boot (1046-1411), and stop() (1412-1538). The hot apply pipeline sits behind hundreds of lines of unrelated UI plumbing. Splitting exposes each concern for independent testing and reduces cognitive surface of the apply path to ~310 LoC.
- **Cost**: M
- **Value**: M
- **Files**: `app/chrome-extension/entrypoints/web-editor-v2/core/editor.ts` (1566 LoC, 33 functions, 13 console calls)
- **Sketch**: Extract `core/edit-session.ts` (~140 LoC), `core/broadcast.ts` (~160 LoC: broadcastTxChanged/broadcastSelectionChanged/broadcastEditorCleared), `core/transaction-apply.ts` (~310 LoC: applyLatestTransaction/applyAllTransactions/revertElement/attemptRollbackOnFailure/checkApplyingTxStatus), `core/editor-lifecycle.ts` (~365 LoC of start() body). editor.ts becomes a ~250-LoC orchestrator wiring modules to shared state.
- **Risk**: Medium — shared closure state (state, editSession, txChangedBroadcastTimer, lastBroadcastedSelectionKey) must be threaded as parameters or a shared context object. No behavior change.

### IMP-0046 · Split cssom-styles-collector.ts into specificity-parser, inheritance, shorthand-expander, cascade, and sheet-inspector modules (refactor) · score: 3

- **Proposed by**: optimization-scout · 2026-05-08
- **Status**: proposed
- **Why**: 1552-LoC file has 6 pre-labeled banner sections (Specificity, Inheritance, Shorthand, Cascade, CSSOM Inspection, Collection) plus 4 large data tables: INHERITED_PROPERTIES (~120 entries), SHORTHAND_TO_LONGHANDS (~135 entries), LEGACY_PSEUDO_ELEMENTS, and a selector tokenizer (lines 363-507). Each section is self-contained. Splitting makes the specificity parser independently testable without booting the cascade engine and reduces the impact surface of CSS panel changes.
- **Cost**: M
- **Value**: M
- **Files**: `app/chrome-extension/entrypoints/web-editor-v2/core/cssom-styles-collector.ts` (1552 LoC, 33 functions)
- **Sketch**: Split into `cssom/specificity-parser.ts` (~340 LoC: tokenizer + computeSelectorSpecificity + helpers), `cssom/inheritance.ts` (~125 LoC: INHERITED_PROPERTIES + isInheritableProperty), `cssom/shorthand.ts` (~145 LoC: SHORTHAND_TO_LONGHANDS + expandToLonghands + normalizePropertyName), `cssom/cascade.ts` (~50 LoC: compareCascade/compareSourceOrder/computeOverrides), `cssom/sheet-inspector.ts` (~160 LoC: isSheetApplicable/describeStyleSheet/evalMediaRule/evalSupportsRule/safeReadCssRules). Top-level file keeps public types and createRuleIndexForRoot orchestrator (~600 LoC).
- **Risk**: Low — sections are self-contained by design and their labeled boundaries match function call graphs.

### IMP-0049 · Split codex.ts initializeAndRun into focused sub-methods (mirrors IMP-0009 pattern for claude.ts) (refactor) · score: 3

- **Proposed by**: optimization-scout · 2026-05-08
- **Status**: proposed
- **Why**: codex.ts initializeAndRun spans lines 48-680 (~632 LoC), mirroring the IMP-0009 problem in claude.ts. It blends Codex CLI spawn, env construction, JSON-line event parsing, todo-list synthesis, apply-patch summarization, attachment temp-file creation, and stderr buffering in one method. Divergence from the claude.ts refactor creates parallel maintenance pressure: every change to shared message shape must be replicated in both engines without structural parity to guide the developer.
- **Cost**: M
- **Value**: M
- **Files**: `app/native-server/src/agent/engines/codex.ts` (965 LoC; initializeAndRun lines 48-680 ~632 LoC)
- **Sketch**: Extract `private async setupCodexProcess(options)` (env + args + spawn, ~80 LoC), `private async processCodexEventStream(child, ctx, runLog)` (for-await loop, ~350 LoC), `private emitTodoListUpdate(record, phase, ctx)` (uses extractTodoListItems + normalizeTodoListItems + buildTodoListContent, ~80 LoC). initializeAndRun becomes ~80-line orchestrator. Apply same sub-method pattern as IMP-0009 so both engines are structurally parallel.
- **Risk**: Low-Medium — stateful event loop with shared accumulators (stderr buffer, pending lines) must preserve closure references. No runtime change.

### IMP-0052 · Split rpc-server.ts into request-router plus per-domain handler modules (queue, flow, trigger, run-control) (refactor) · score: 3

- **Proposed by**: optimization-scout · 2026-05-08
- **Status**: proposed
- **Why**: Single RpcServer class has 30+ private async handle\* methods registered through one handleRequest dispatch (line 238). Concerns are clearly separable: queue management, flow CRUD + normalizeFlowSpec (140 LoC validator), trigger CRUD + normalizeTriggerSpec (155 LoC), and run controls. The transport file conflates wire-protocol lifecycle with domain validation logic, making it hard to change flow normalization without navigating past trigger and queue code.
- **Cost**: M
- **Value**: M
- **Files**: `app/chrome-extension/entrypoints/background/record-replay-v3/engine/transport/rpc-server.ts` (1063 LoC)
- **Sketch**: Extract `transport/handlers/queue-handlers.ts` (~80 LoC: handleEnqueueRun/handleListQueue/handleCancelQueueItem), `transport/handlers/flow-handlers.ts` (~290 LoC: handleSaveFlow/handleDeleteFlow + normalizeFlowSpec/normalizeNode/normalizeEdge), `transport/handlers/trigger-handlers.ts` (~445 LoC: handleCreateTrigger through handleFireTrigger + normalizeTriggerSpec), `transport/handlers/run-handlers.ts` (~95 LoC: handlePauseRun/handleResumeRun/handleCancelRun). rpc-server.ts becomes ~280-LoC orchestrator for port lifecycle + handleRequest dispatch. Handlers receive a context object { storage, events, runners, scheduler, triggerManager, generateRunId, now }.
- **Risk**: Medium — handleRequest switch must stay exhaustive; requireTriggerManager guard must compose into handler context. Compile errors guide the work. No runtime change.

### IMP-0007 · Add chrome_download_list and chrome_download_cancel tools (feat) · score: 2

- **Proposed by**: feature-scout · 2026-05-05
- **Status**: proposed
- **Why**: chrome_handle_download waits for one download to start, but agents cannot enumerate in-progress downloads, check if a previous download is still running, or cancel a stalled one. The bookmark group (search/add/update/delete) is the precedent: full CRUD lifecycle. chrome.downloads.search + chrome.downloads.cancel are already within the downloads permission the extension declares.
- **Cost**: S
- **Value**: S
  Two new tools: chrome_download_list (wraps chrome.downloads.search; params: state=in_progress|complete|interrupted|all, filenameContains?, limit?) and chrome_download_cancel (param: downloadId, required). Touch: tools/browser/download.ts (existing file already handles chrome.downloads), TOOL_NAMES, TOOL_SCHEMAS. Keep chrome_handle_download untouched.

### IMP-0015 · Add chrome_pace_get tool to read the current pacing profile (feat) · score: 2

- **Proposed by**: feature-scout · 2026-05-06
- **Status**: proposed
- **Why**: chrome_pace sets the per-client throttle profile (off|human|careful|fast) but there is no getter. An agent that wants to temporarily escalate pace (e.g. switch to fast for a bulk read phase) and then restore the previous value must hard-code the original setting instead of reading it back — fragile if another agent on a different client changed it. chrome_pace_get completes the read/write pair and enables safe save-and-restore patterns.
- **Cost**: S
- **Value**: S
  Simplest implementation: new tool with no required parameters; reads client-state pacing entry for the calling client. Returns { profile: string, mutatingDelayMs: number }. Touch: tools/browser/pace.ts (or dispatch handler), TOOL_NAMES, TOOL_SCHEMAS. Zero new infrastructure — client-state already stores the profile.

### IMP-0018 · Add record_replay_flow_delete tool to complete recording lifecycle (feat) · score: 2

- **Proposed by**: feature-scout · 2026-05-06
- **Status**: proposed
- **Why**: record_replay_list_published and record_replay_flow_run exist, but agents cannot delete a flow once it is published. During iterative recording sessions (capture, test, refine) stale versions accumulate under the same slug family, cluttering the dynamic flow.<slug> MCP tool surface and forcing the user to open the extension UI to clean up. A delete tool closes the lifecycle gap the same way bookmark_delete rounds out the bookmark group.
- **Cost**: S
- **Value**: S
  Param: id (required, the flow UUID from list_published). Implementation wraps whatever the extension uses to remove a flow from IndexedDB / chrome.storage — inspect record-replay/nodes/ for the storage layer. Returns { deleted: boolean, id }. Touch: TOOL_NAMES.RECORD_REPLAY.FLOW_DELETE, TOOL_SCHEMAS entry, dispatch.ts FLOW_PREFIX path or a dedicated handler, and the bridge must un-register the dynamic flow.<slug> tool if it was auto-exposed.

### IMP-0029 · Add chrome_remove_injected_script tool to explicitly unload a persistent injection (feat) · score: 2

- **Proposed by**: feature-scout · 2026-05-07
- **Status**: proposed
- **Why**: chrome_inject_script + chrome_send_command_to_inject_script cover inject and message, but agents cannot cleanly tear down a running injection without navigating the tab away. The injectedTabs map in inject-script.ts already has internal cleanup on tab removal, but there is no MCP surface to call it deliberately. Agents that inject monitoring bridges (e.g. a mutation observer or a WebSocket proxy) and need to remove them before handing the tab back to the user have no choice but to reload the page, losing form state.
- **Cost**: S
- **Value**: S
  New tool chrome_remove_injected_script. Params: tabId? (falls back to preferred tab). Calls the existing internal cleanup path that calls injectedTabs.delete(tabId) and sends a teardown event to the injected script via the existing message channel. Returns { removed: boolean, tabId }. Touch: inject-script.ts (expose existing teardown logic), TOOL_NAMES.BROWSER.REMOVE_INJECTED_SCRIPT, TOOL_SCHEMAS entry, TOOL_CATEGORIES map (same category as INJECT_SCRIPT).

### IMP-0030 · Add named-shortcut param to chrome_keyboard for common browser-level key combos (feat) · score: 2

- **Proposed by**: feature-scout · 2026-05-07
- **Status**: proposed
- **Why**: Agents that need to trigger copy/paste/undo/redo/save/open-devtools must know the platform-correct key sequence (Ctrl vs Cmd, exact key names) and assemble it via the raw key array. A shortcut string param (e.g. shortcut: copy | paste | undo | redo | save | select_all | find) maps to the correct platform keys at dispatch time, reducing prompt engineering burden and platform-portability bugs for the most common combos.
- **Cost**: S
- **Value**: S
  Add optional shortcut param to chrome_keyboard schema (enum of common action names). At dispatch time in keyboard.ts, a lookup table maps shortcut names to platform-correct key arrays (macOS: Meta+C for copy; Windows/Linux: Ctrl+C). If both shortcut and key are provided, shortcut takes precedence. The existing key array path remains fully supported — this is purely additive. Touch: tools/browser/keyboard.ts (add lookup table + shortcut branch), TOOL_SCHEMAS chrome_keyboard properties. No new tool needed, no new infrastructure.

### IMP-0053 · Add status action to chrome_network_capture for non-destructive buffer inspection (feat) · score: 2

- **Proposed by**: feature-scout · 2026-05-08
- **Status**: proposed
- **Why**: chrome_network_capture action=stop returns all entries and tears down the listener. An agent that wants to check whether a capture is already running, or how many entries have accumulated before deciding whether to flush (IMP-0028), must call stop and lose the listener. A status action is a pure read of the existing in-memory listener and buffer state, enabling safe pre-flight checks without side effects.
- **Cost**: S
- **Value**: S
  Add action enum value status to chrome_network_capture schema alongside start, stop, and the proposed flush (IMP-0028). Returns {active: boolean, sinceMs: number|null, bufferedCount: number, scope: string}. Implementation: read-only inspection of the same in-memory capture state object used by start/stop. Touch: tools/browser/network-capture.ts handler (add status branch), TOOL_SCHEMAS action enum. Zero new infrastructure.

## Done

### IMP-0031 · Dedup css-helpers across control files (refactor) · score: 4

- **Status**: done
- **Completed**: 2026-05-08
- **Summary**: No code change needed — investigation showed all 5 helpers (`isFieldFocused`, `readInlineValue`, `readComputedValue`, `splitTopLevel`, `tokenizeTopLevel`) are already exported once from `app/chrome-extension/entrypoints/web-editor-v2/ui/property-panel/controls/css-helpers.ts` (lines 245, 261, 275, 293, 349) and consumed by every flagged control file via `import { ... } from './css-helpers'` — no local copies exist anywhere under `entrypoints/web-editor-v2`. The scout's report was stale (likely pre-dating an earlier dedup pass). The one nearby function that _did_ match by partial name — `splitTopLevelTokens` in `layout-control.ts:157` — is intentionally a simpler subset for grid-track parsing (no quote/escape handling) and is not interchangeable with `tokenizeTopLevel`; folding it would have been scope creep beyond IMP-0031. Moved the entry to Done so the next loop iteration doesn't re-pick it.
- **Branch**: docs/imp-0031-already-deduped

### IMP-0058 · Cache listDynamicFlowTools with invalidation (perf) · score: 4

- **Status**: done
- **Completed**: 2026-05-08
- **Summary**: Added a module-scope cache in `app/native-server/src/mcp/dispatch.ts` shared by both `listDynamicFlowTools` (tools/list path) and `dispatchTool`'s `flow.<slug>` resolution path. 60s TTL with an `invalidateFlowToolsCache()` exported helper for eager invalidation when a flows_changed event fires. Concurrent cold-cache callers collapse onto a single in-flight fetch via a `pendingFlowToolsFetch` promise. The flow-call path falls back to one targeted refetch when a slug isn't in cache (covers the "flow published since last fetch" case). Errors don't poison the cache — empty result returned and next call retries. Pre-cache: a single tools/list immediately followed by `flow.<slug>` cost two 20s-timeout `rr_list_published_flows` round-trips. Post-cache: one round-trip serves both. New `dispatch.flow-cache.test.ts` (8 tests) pins each contract: shared fetch within TTL, concurrent collapse, error doesn't poison, manual invalidation, the IMP-0058 acceptance criterion (tools/list + flow.demo = 1 fetch), multi-flow-call reuse, unknown-slug single refetch, and a published-since-last-fetch round-trip. Existing 6 collision tests updated with `invalidateFlowToolsCache()` in `beforeEach`. Bridge: 77/77 (was 68 + 9 new); extension: 694/694; typecheck clean. No tool-schema changes.
- **Branch**: perf/imp-0058-flow-tools-cache

### IMP-0042 · chrome_screenshot reports success:true when both bridge save and chrome.downloads fallback fail (bug) · score: 7

- **Status**: done
- **Completed**: 2026-05-08
- **Summary**: Added an early-return guard in `screenshot.ts` that returns `createErrorResponse(saveError, ToolErrorCode.UNKNOWN)` when `savePng !== false` and neither the native bridge save nor the `chrome.downloads` fallback succeeded — top-level `isError` now reflects the failure instead of staying `false`. +9 src lines, +29/-4 in `screenshot.test.ts` (1 strengthened failure-path test, 1 new `savePng:false` boundary test). Extension: 694/694, build green.
- **Worktree**: /Users/mike/Documents/Code/humanchrome/.claude/worktrees/agent-a0e8378f034578161 · branch worktree-agent-a0e8378f034578161

### IMP-0040 · record_replay_flow_run MCP tool silently does nothing for flows containing loopElements or executeFlow steps (bug) · score: 6

- **Status**: done
- **Completed**: 2026-05-08
- **Summary**: No code change needed — investigation showed both `executeFlowNode` and `loopElementsNode` are reachable via `LegacyStepExecutor` → `legacyExecuteStep` → `nodes/index.ts` registry. In hybrid mode the absence from `STEP_TYPE_TO_ACTION_TYPE` triggers the `attempt.supported === false` fallback that lands on the same legacy nodes. New `legacy-node-coverage.contract.test.ts` (62 lines, 3 tests) asserts the registry routes correctly via the legacy nodes' own validate() error messages, with a negative-control test on a fake type to prove the assertion is meaningful. Extension: 694/694, build green.
- **Worktree**: /Users/mike/Documents/Code/humanchrome/.claude/worktrees/agent-a0e8378f034578161 · branch worktree-agent-a0e8378f034578161

### IMP-0045 · flow.\* MCP schema silently overwrites user-defined flow variables named tabTarget, refresh, captureNetwork, returnLogs, or timeoutMs (bug) · score: 6

- **Status**: done
- **Completed**: 2026-05-08
- **Summary**: Exported `FLOW_RUNNER_RESERVED_KEYS` in `dispatch.ts`. `listDynamicFlowTools` now skips user vars whose key collides with a runner-option key and emits a pino `warn` so the lost var is observable. +35 src lines; new `dispatch.flow-tools.test.ts` (158 lines, 4 tests covering single-key collision, required-array guard, all-five-keys collision, and a no-collision baseline). Bridge: 68/68, build green.
- **Worktree**: /Users/mike/Documents/Code/humanchrome/.claude/worktrees/agent-a0e8378f034578161 · branch worktree-agent-a0e8378f034578161

### IMP-0039 · jsdom@29 bump introduces --localstorage-file warning spam in bridge test suite (regression) (bug) · score: 5

- **Status**: done
- **Completed**: 2026-05-08
- **Summary**: Root cause was Node 25's built-in webstorage warning emitted from `node:internal/webstorage` when `jest-util`'s teardown reflects on `globalThis.localStorage` — not jsdom 29 as the backlog hypothesized. New `jest.setup-warnings.js` (57 lines, wired via `setupFiles`) patches `process.stderr.write` to drop chunks matching `/--localstorage-file/` plus the trailing `(Use \`node --trace-warnings ...)`line, with a belt-and-suspenders patch on`process.emitWarning`. Verified: stderr `localstorage` line count went 7 → 0. Bridge: 68/68, build green.
- **Worktree**: /Users/mike/Documents/Code/humanchrome/.claude/worktrees/agent-a0e8378f034578161 · branch worktree-agent-a0e8378f034578161

### IMP-0038 · chrome_assert title_matches silently returns ok:false with empty title on chrome:// pages and restricted frames (bug) · score: 6

- **Status**: done
- **Completed**: 2026-05-07
- **Summary**: `AssertTool.evaluate`'s `title_matches` predicate now reads `tab.title` directly from the `chrome.tabs.Tab` it already holds, dropping the `chrome.scripting.executeScript` indirection that silently failed on `chrome://` pages and restricted frames. The unused `getDocumentTitle()` helper was removed. New `tests/tools/browser/assert.test.ts` adds 4 tests covering the chrome:// path, mismatch regression guard, regex pattern, and undefined-title fallback. Extension: 664/664, build green.
- **Worktree**: `/Users/mike/Documents/Code/humanchrome/.claude/worktrees/agent-ad568dc0257e1c882` · branch `worktree-agent-ad568dc0257e1c882`

### IMP-0036 · triggerEvent and setAttribute step types missing from STEP_TYPE_TO_ACTION_TYPE in adapter.ts (bug) · score: 6

- **Status**: done
- **Completed**: 2026-05-07
- **Summary**: `STEP_TYPE_TO_ACTION_TYPE` in `app/chrome-extension/entrypoints/background/record-replay/actions/adapter.ts` now maps `triggerEvent` and `setAttribute` step types through to their already-registered handlers. New 145-line `adapter-handler-parity.contract.test.ts` (4 tests) asserts bidirectional parity between `STEP_TYPE_TO_ACTION_TYPE` and `ALL_HANDLERS`, plus an explicit IMP-0036 regression check and IMP-0040 placeholder guard. Extension: 651/651, build green. PR #58.

### IMP-0037 · registerWithElevatedPermissions ignores --browser and --detect flags when --system or root (bug) · score: 7

- **Status**: done
- **Completed**: 2026-05-07
- **Summary**: `getSystemManifestPath` and `registerWithElevatedPermissions` in `app/native-server/src/scripts/utils.ts` now accept a `BrowserType[]` and resolve the system manifest path + Windows registry key per-browser, mirroring `tryRegisterUserLevelHost`. `cli.ts:88` passes the resolved `targetBrowsers` through; the TODO is gone. 4 regression tests added. Bridge: 53/53, build green.
- **Worktree**: `/Users/mike/Documents/Code/humanchrome/.claude/worktrees/agent-aec4917924a0e2ec0` · branch `worktree-agent-aec4917924a0e2ec0`

### IMP-0014 · Add chrome_console_clear tool (feat) · score: 4

- **Status**: done
- **Completed**: 2026-05-06
- **Summary**: New standalone `chrome_console_clear` MCP tool. New file `console-clear.ts` (+76), `tools.ts` +15, `index.ts` +1. Returns `{ cleared: number }`. Bridge: 49/49, extension: 647/647, build green.
- **Commit**: `078d741` on main
- **Worktree**: `.claude/worktrees/agent-a50f36fc` / `worktree-agent-a50f36fc`

### IMP-0016 · Add title_matches predicate to chrome_assert (feat) · score: 4

- **Status**: done
- **Completed**: 2026-05-06
- **Summary**: Added `title_matches` to the `kind` enum in `chrome_assert` schema; handler reads `document.title` via `chrome.scripting.executeScript` and matches against substring/regex (same shape as `url_matches`). `assert.ts` +26, `tools.ts` +4/-2. Extension: 647/647, build green.
- **Commit**: `7655d17` on main
- **Worktree**: `.claude/worktrees/agent-a6eec630` / `worktree-agent-a6eec630`

### IMP-0017 · Add chrome_userscript_list and chrome_userscript_remove (feat) · score: 4

- **Status**: done
- **Completed**: 2026-05-06
- **Summary**: NO-OP — already supported. The existing `chrome_userscript` tool exposes `action: 'list'` and `action: 'remove'` sub-commands covering the same lifecycle the proposal asked for. Implementer agent reviewed the source and confirmed no code change required. Backlog dedup hint: scouts should grep for existing `action:` enums before proposing new tools in the same group.
- **Commit**: n/a (no code change)
- **Worktree**: `.claude/worktrees/agent-abc1be79` / `worktree-agent-abc1be79`

### IMP-0020 · Extract shadow-host CSS to standalone file (perf) · score: 4

- **Status**: done
- **Completed**: 2026-05-06
- **Summary**: Moved ~3.4kLoC of inline CSS from `shadow-host.ts` (3621 → 191 LoC) into a sibling `shadow-host.css` (3423 LoC), imported via `import SHADOW_HOST_STYLES from './shadow-host.css?raw'`. Five `${...}` interpolations inlined to compile-time constants (`#6366f1` accent color, `__mcp_web_editor_v2_overlay__`, `__mcp_web_editor_v2_ui__` host ids). WXT/Vite handles `?raw` natively; build output unchanged. Extension: 647/647.
- **Commit**: `674aa64` on main
- **Worktree**: `.claude/worktrees/agent-a2d80ac5` / `worktree-agent-a2d80ac5`

### IMP-0001 · Fix tab-cursor.integration.test.ts onUpdated mock (bug) · score: 6

- **Proposed by**: seed · 2026-05-05
- **Status**: done
- **Completed**: 2026-05-05
- **Summary**: Added `onUpdated` + `onRemoved` no-op listener stubs to the `vi.stubGlobal('chrome', ...)` `tabs` block; the existing `tabsGet` mock returning `status: 'complete'` lets `waitForTabComplete` resolve via its fast-path. Extension vitest: 640 → 641 passed (full green). pnpm -w build: green.
- **Commit**: `e8eb2b5` on main

### IMP-0003 · Add chrome_get_cookies and chrome_set_cookies tools (feat) · score: 4

- **Proposed by**: feature-scout · 2026-05-05
- **Status**: done
- **Completed**: 2026-05-05
- **Summary**: Added 3 tools (chrome_get_cookies, chrome_set_cookie, chrome_remove_cookie) in new file cookies.ts (+219). Schemas + TOOL_NAMES in tools.ts (+127). **Permission escalation**: added `cookies` to wxt.config.ts manifest permissions (was NOT pre-existing despite the proposal's claim) + PERMISSIONS.md justification — review before publishing as it triggers Chrome Web Store re-review and an update prompt for users. Bridge tests: 36/36. Extension vitest: 641/641. pnpm -w build: green.
- **Commit**: `51d31b0` on main

### IMP-0004 · Add chrome_await_element tool for element presence polling (feat) · score: 4

- **Proposed by**: feature-scout · 2026-05-05
- **Status**: done
- **Completed**: 2026-05-05
- **Summary**: Added `chrome_await_element` (await-element.ts +143, schema +32) using MutationObserver in extended wait-helper.js (+134). Resolves target via ref / CSS / XPath; observer watches document.documentElement (subtree+childList+attributes); returns immediately when goal state already holds. timeoutMs clamped to [0, 120000] with 15000 default; emits ToolErrorCode.TIMEOUT envelope on miss. Read-only (mutates=false). Schema uses the shared SELECTOR_PROP / SELECTOR_TYPE_PROP / TAB_TARGETING / FRAME_ID_PROP fragments (tightened during the rebase onto post-Phase-2 main). Bridge tests: 36/36. Extension vitest: 641/641. pnpm -w build: green.
- **Commit**: `bb39a05` on main

### IMP-0002 · Auto-generate docs/TOOLS.md from schemas (docs) · score: 3

- **Proposed by**: seed · 2026-05-05
- **Status**: done
- **Completed**: 2026-05-05
- **Summary**: TOOL_CATEGORIES + TOOL_CATEGORY_ORDER appended to packages/shared/src/tools.ts. Generator at app/native-server/scripts/generate-tools-doc.mjs reads built shared dist, replaces content between `<!-- AUTO-GEN BELOW -->` / `<!-- AUTO-GEN END -->` in docs/TOOLS.md. `docs:tools` npm script. Coverage jest test fails CI if a TOOL_SCHEMAS tool lacks a category. 40 tools across 9 categories; second run zero diff (idempotent). Bridge tests: 45/45 (+3 coverage). Extension vitest: 641/641.
- **Commit**: `ee27339` on main
- **Note**: This worktree initially branched from a stale base (`cb903ce`, before the MCP cleanup + earlier IMP-0001/0003/0004 merges). The implementer built TOOL_CATEGORIES against an old surface; rebase resolved the conflict and the categories were extended to cover cookies / await_element / bookmark_update / navigate_batch / wait_for_tab / get_interactive_elements. The same harness bug will affect future implementer worktrees — see follow-up commit that updates `/improve` Step 5 to make the agent reset to current main as its first action.

### IMP-0010 · Add chrome_assert with composite predicates (url/element/console/network/js) (feat) · score: 6

- **Proposed by**: user-direction · 2026-05-06
- **Status**: done
- **Completed**: 2026-05-06
- **Summary**: Single tool with N predicates per call (url_matches | element_present | element_absent | console_clean | network_succeeded | js). Returns `{ ok, results: [{predicate, ok, detail}] }`. Reuses existing primitives (consoleBuffer, performance.getEntriesByType, chrome.scripting.executeScript MAIN-world eval) — no new infrastructure. Bridge 6/6, extension 33/33, ci-local.sh all green.
- **Commit**: `c9a4585` on main

### IMP-0011 · Add chrome_wait_for unifying element/network_idle/response_match/js waits (feat) · score: 5

- **Proposed by**: user-direction · 2026-05-06
- **Status**: done
- **Completed**: 2026-05-06
- **Summary**: Single primitive replaces the chrome_javascript spin-poll pattern. Kinds: element (wraps chrome_await_element), network_idle (page-side PerformanceObserver, default quietMs=500), response_match (delegates to chrome_intercept_response with returnBody=false), js (page-side eval re-run on every DOM mutation + 250ms safety poll). Shared TIMEOUT envelope on miss. ci-local.sh green.
- **Commit**: `6515f6b` on main

### IMP-0012 · Add chrome_pace for per-client throttling of mutating dispatches (feat) · score: 5

- **Proposed by**: user-direction · 2026-05-06
- **Status**: done
- **Completed**: 2026-05-06
- **Summary**: Per-MCP-client pacing profile (off | human | careful | fast) gates mutating tool dispatches in tools/index.ts:handleCallTool. State lives in client-state.ts next to the existing tab pinning; reads stay un-throttled. Service-worker restart resets to off. New "Pacing" category in TOOL_CATEGORY_ORDER. ci-local.sh green.
- **Commit**: `944dd45` on main

### IMP-0013 · Expose record-replay flows as MCP tools (phase 4a) (feat) · score: 4

- **Proposed by**: user-direction · 2026-05-06
- **Status**: done
- **Completed**: 2026-05-06
- **Summary**: Phase 4a only — uncommented the record_replay_flow_run + record_replay_list_published schemas in TOOL_SCHEMAS; added new "Workflows" category to TOOL_CATEGORY_ORDER + map both tools to it. Tightened descriptions to point users at the dynamic flow.<slug> auto-exposed surface (preferred) vs the explicit ID-based fallback. The handlers + dispatch.ts FLOW_PREFIX path were already complete; only the schemas were commented out. Phase 4b (verify recording UX end-to-end) and 4c (docs/RECORD_REPLAY.md walkthrough) deferred until manual verification of the recording flow. ci-local.sh green; 45 tools across 11 categories.
- **Commit**: `4a63c84` on main

### IMP-0025 · chrome_navigate with newWindow:true never pins the opened tab to the client (bug) · score: 7

- **Proposed by**: bug-scout · 2026-05-06
- **Status**: done
- **Completed**: 2026-05-06
- **Summary**: Added `(p) => p?.tabs?.[0]?.tabId` as a third path in extractTabIdFromResult. Purely additive — only fires on the array-shaped response that newWindow:true and navigate_batch return. Single-tab paths still take priority. Build green; extension vitest 641/641.
- **Commit**: `5a46e56` on main

### IMP-0026 · chrome_navigate_batch never pins the opened tabs to the client (bug) · score: 7

- **Proposed by**: bug-scout · 2026-05-06
- **Status**: done
- **Completed**: 2026-05-06
- **Summary**: Same root cause and same fix as IMP-0025 — both bugs were resolved by the single one-line addition to extractTabIdFromResult.
- **Commit**: `5a46e56` on main

### IMP-0024 · flow.\* dispatch double-wraps args, losing tabTarget/refresh/captureNetwork/returnLogs/timeoutMs (bug) · score: 6

- **Proposed by**: bug-scout · 2026-05-06
- **Status**: done
- **Completed**: 2026-05-06
- **Summary**: Extracted `buildFlowArgs(flowId, mcpArgs)` helper in dispatch.ts that destructures runner options (tabTarget/refresh/captureNetwork/returnLogs/timeoutMs/startUrl) to the top level of the flow envelope and leaves only user-supplied flow variables in `args`. 4 unit tests cover canonical / runner-only / vars-only / undefined cases. Build green; bridge tests 49/49 (was 45 +4 new).
- **Commit**: `4dc7454` on main

### IMP-0005 · Add multi-match count to chrome_intercept_response (feat) · score: 4

- **Proposed by**: feature-scout · 2026-05-05
- **Status**: done
- **Completed**: 2026-05-06
- **Summary**: Added `count` param (default 1, max 100). count===1 keeps the existing single-response code path byte-for-byte (chrome_wait_for response_match continues to work). count>1 uses a pendingByRequestId map + completed[] accumulator; resolves when count reached or on timeout returning whatever was gathered (matched > 0 → success; matched===0 → standard TIMEOUT envelope). returnBody:false works in multi mode; loadingFailed for one request drops only that requestId. Build green; bridge 49/49; extension 641/641.
- **Commit**: `9309769` on main

### IMP-0006 · Add maxConcurrent flag to chrome_navigate_batch (feat) · score: 4

- **Proposed by**: feature-scout · 2026-05-05
- **Status**: done
- **Completed**: 2026-05-06
- **Summary**: Worker-pool semaphore for navigate_batch. maxConcurrent (omitted/<=0/>=urls.length keeps legacy behavior). Workers claim URLs from a shared cursor, await waitForTabComplete with perUrlTimeoutMs (default 30s) before claiming the next. TIMEOUT/TAB_CLOSED/TAB_NOT_FOUND record the tab + surface in errors[] without aborting. perTabDelayMs applies as intra-worker spacing. Tabs[] preserves input order via index-keyed sparse arrays. Bonus: perUrlTimeoutMs schema knob exposed for slow anti-bot platforms. 6 new tests with vi.useFakeTimers; 647/647 extension; 49/49 bridge.
- **Commit**: `17b69fe` on main

### IMP-0008 · Extract checkDomainShift helper to eliminate 6 copy-pasted hostname-check blocks in computer.ts (refactor) · score: 4

- **Proposed by**: optimization-scout · 2026-05-05
- **Status**: done
- **Completed**: 2026-05-06
- **Summary**: Two top-level helpers in computer.ts (`getHostnameFromUrl`, `checkDomainShift`) replace the 6 inline `(ctx as any)?.hostname` + throw blocks. ctx typed as `ScreenshotContext | undefined` (no `as any`). Behavior preserved: per-site predicate gates kept inline (they varied); literal vs dynamic action labels preserved; zoom site's distinct trailing message ("Capture a new screenshot first.") preserved via a `trailing: 'first'` option. Net -36 LoC, all 6 casts gone. Build green; extension vitest 647/647.
- **Commit**: `4810f70` on main
