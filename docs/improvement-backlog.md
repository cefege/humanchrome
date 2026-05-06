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

### IMP-0009 · Split ClaudeEngine.initializeAndRun into focused sub-methods (refactor) · score: 3

- **Proposed by**: optimization-scout · 2026-05-05
- **Status**: in-progress
- **Why**: ClaudeEngine at 1601 LoC has a single public method `initializeAndRun` that spans roughly lines 62-1292 (~1230 lines). It interleaves SDK loading, env construction, tool-input streaming accumulation, stderr buffering, and HumanChrome bridge setup. Any change to stream parsing risks breaking error classification and vice versa. Splitting into private sub-methods (buildQuery, accumulateToolInput, processAssistantEvent, finalizeRun) would make each concern independently testable and cut the cognitive surface of the hot loop to <150 lines.
- **Cost**: M
- **Value**: M
- **Files**: `app/native-server/src/agent/engines/claude.ts` (1601 LoC)
- **Sketch**: Extract at minimum: `private async loadSdk()`, `private buildRunOptions(...)`, `private async processEventStream(stream, ctx, runLog)` (owns the big for-await loop), `private emitToolCall(...)`. `initializeAndRun` becomes an orchestrator of ~80 lines.
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

## Done

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
