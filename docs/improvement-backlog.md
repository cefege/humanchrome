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

### IMP-0006 · Add maxConcurrent flag to chrome_navigate_batch (feat) · score: 4

- **Proposed by**: feature-scout · 2026-05-05
- **Status**: proposed
- **Why**: chrome_navigate_batch currently opens all URLs simultaneously. On anti-bot platforms (LinkedIn, Instagram) that behavior triggers rate-limit or shadow-ban heuristics even though perTabDelayMs slows the inter-open delay. A maxConcurrent cap (e.g. 3) lets the tool open only that many tabs, then open the next as each finishes loading — giving agents burst control without having to manually sequence navigate_batch calls.
- **Cost**: S
- **Value**: M
  Schema: add maxConcurrent?: number (default: unlimited to preserve current behavior). Implementation in navigate-batch handler: maintain an in-flight counter; when a tab fires onUpdated status=complete decrement and open next queued URL. Touch: tools/browser/index.ts navigate_batch handler, TOOL_SCHEMAS. The perTabDelayMs field stays as-is for users who want spacing without hard concurrency limits.

### IMP-0008 · Extract checkDomainShift helper to eliminate 6 copy-pasted hostname-check blocks in computer.ts (refactor) · score: 4

- **Proposed by**: optimization-scout · 2026-05-05
- **Status**: proposed
- **Why**: The pattern `(ctx as any)?.hostname` + security-error throw is copy-pasted verbatim 6 times across computer.ts (lines 436, 538, 679, 763, 878, 1213). Each copy carries its own `as any` cast. A single `assertDomainUnchanged(ctx, currentHostname, actionName)` helper eliminates ~36 duplicated lines, removes all 6 casts, and ensures the check is impossible to update inconsistently.
- **Cost**: S
- **Value**: M
- **Files**: `app/chrome-extension/entrypoints/background/tools/browser/computer.ts` (1428 LoC)
- **Sketch**: Add `function assertDomainUnchanged(ctx: ScreenshotContext | null, currentHostname: string, action: string): void` near top of file; type `ctx` via the existing `ScreenshotContext` import so the cast disappears; call from each of the 6 case branches.
- **Risk**: Low — purely mechanical extraction, logic is identical across all 6 sites.

### IMP-0014 · Add chrome_console_clear tool to reset the captured console buffer (feat) · score: 4

- **Proposed by**: feature-scout · 2026-05-06
- **Status**: proposed
- **Why**: chrome_console accumulates all errors since the tab loaded. Agents running multi-step flows cannot tell whether a console error is from a previous step or the current one without tracking wall-clock timestamps manually. A chrome_console_clear tool resets the extension-side buffer so subsequent chrome_console or chrome_assert console_clean checks are scoped to the current step — the same reset pattern that test frameworks use between assertions.
- **Cost**: S
- **Value**: M
  Implementation: add a clear action to chrome_console (action: read|clear, default read) or a standalone tool. Touch: tools/browser/interaction.ts (or wherever the console buffer lives), TOOL_NAMES, TOOL_SCHEMAS. Returns { cleared: number } indicating how many buffered entries were dropped.

### IMP-0016 · Add title_matches predicate to chrome_assert (feat) · score: 4

- **Proposed by**: feature-scout · 2026-05-06
- **Status**: proposed
- **Why**: SPAs routinely update document.title on navigation without changing the URL path (e.g. LinkedIn messaging threads, WhatsApp contact views, Gmail). chrome_assert url_matches cannot distinguish these transitions. A title_matches predicate (substring or regex, same pattern interface as url_matches) lets agents confirm SPA navigation completed without a separate chrome_javascript call — keeping assertion logic declarative and in one tool call.
- **Cost**: S
- **Value**: M
  Schema change only + 3-line handler addition. Add title_matches to the kind enum in TOOL_SCHEMAS ASSERT entry. Handler: chrome.scripting.executeScript returning document.title, match against pattern using existing regex/substring logic already used by url_matches. Touch: tools/browser/assert.ts, TOOL_SCHEMAS. Zero new infrastructure.

### IMP-0017 · Add chrome_userscript_list and chrome_userscript_remove for injection lifecycle (feat) · score: 4

- **Proposed by**: feature-scout · 2026-05-06
- **Status**: proposed
- **Why**: chrome_userscript injects persistent scripts but there is no way to enumerate what is currently injected or remove a specific script without reloading the extension. In multi-step agent sessions a script injected in step 2 may conflict with a differently-configured script injected in step 5. Without a remove operation agents must reload the extension (losing all state) to clean up. List + remove completes the CRUD lifecycle the bookmark group already models.
- **Cost**: S
- **Value**: M
  chrome.userScripts.getScripts() returns registered scripts by id. Two new tools: chrome_userscript_list (no params; returns [{id, matches, world}]) and chrome_userscript_remove (param: id, required; calls chrome.userScripts.unregister). Touch: tools/browser/interaction.ts or new userscript-lifecycle.ts, TOOL_NAMES, TOOL_SCHEMAS. The userScripts API is already declared in the manifest (chrome_userscript uses it).

### IMP-0020 · Extract shadow-host CSS template literal to a separate .css file loaded via ?raw import (perf) · score: 4

- **Proposed by**: optimization-scout · 2026-05-06
- **Status**: proposed
- **Why**: shadow-host.ts is 3621 LoC but 3425 of those are a single inline CSS template literal (SHADOW_HOST_STYLES, lines 56-3480). The 85 KB string is parsed and re-evaluated every time the module is imported. Moving it to a .css file loaded via `import styles from "./shadow-host.css?raw"` defers parsing to the bundler, enables Vite/WXT CSS minification, and reduces the TS module to ~196 lines of actual logic — making future edits to either CSS or JS far less error-prone.
- **Cost**: S
- **Value**: M
- **Files**: `app/chrome-extension/entrypoints/web-editor-v2/ui/shadow-host.ts` (3621 LoC; 3425 lines are CSS), target split: `shadow-host.css` + `shadow-host.ts` (~200 lines)
- **Sketch**: 1) `git mv` the content of `SHADOW_HOST_STYLES` to `shadow-host.css`. 2) Replace the template literal with `import SHADOW_HOST_STYLES from "./shadow-host.css?raw";`. 3) WXT/Vite already handles `?raw` imports natively — no config change needed.
- **Risk**: Low. The WXT build pipeline minifies the CSS when building for production, so rendered output will be smaller. The only gotcha is that the current template literal uses `/* css */` for VS Code highlighting — the real file gets syntax highlighting automatically.

### IMP-0009 · Split ClaudeEngine.initializeAndRun into focused sub-methods (refactor) · score: 3

- **Proposed by**: optimization-scout · 2026-05-05
- **Status**: proposed
- **Why**: ClaudeEngine at 1601 LoC has a single public method `initializeAndRun` that spans roughly lines 62-1292 (~1230 lines). It interleaves SDK loading, env construction, tool-input streaming accumulation, stderr buffering, and HumanChrome bridge setup. Any change to stream parsing risks breaking error classification and vice versa. Splitting into private sub-methods (buildQuery, accumulateToolInput, processAssistantEvent, finalizeRun) would make each concern independently testable and cut the cognitive surface of the hot loop to <150 lines.
- **Cost**: M
- **Value**: M
- **Files**: `app/native-server/src/agent/engines/claude.ts` (1601 LoC)
- **Sketch**: Extract at minimum: `private async loadSdk()`, `private buildRunOptions(...)`, `private async processEventStream(stream, ctx, runLog)` (owns the big for-await loop), `private emitToolCall(...)`. `initializeAndRun` becomes an orchestrator of ~80 lines.
- **Risk**: Medium — the event loop is stateful (pendingToolInputs map, assistantBuffer); extraction must preserve the shared-state references. No behavior change.

### IMP-0019 · Split semantic-similarity-engine.ts into model-registry, memory-pool, proxy, and engine modules (refactor) · score: 3

- **Proposed by**: optimization-scout · 2026-05-06
- **Status**: proposed
- **Why**: At 2363 LoC the file bundles four unrelated concerns: model-registry (253 lines of PREDEFINED_MODELS + recommenders), EmbeddingMemoryPool (54 lines), SemanticSimilarityEngineProxy (312 lines, offscreen IPC only), and SemanticSimilarityEngine itself (1570 lines of ONNX + SIMD + tokenization). The offscreen entrypoint only imports SemanticSimilarityEngine, so Proxy is dead weight in that bundle. Splitting lets the proxy be tree-shaken where unused and makes the ONNX inference loop independently navigable.
- **Cost**: M
- **Value**: M
- **Files**: `app/chrome-extension/utils/semantic-similarity-engine.ts` (2363 LoC), `app/chrome-extension/entrypoints/offscreen/main.ts` (imports Engine only)
- **Sketch**: Extract to `utils/semantic-similarity/model-registry.ts` (PREDEFINED_MODELS, recommenders, size helpers), `utils/semantic-similarity/memory-pool.ts` (EmbeddingMemoryPool class), `utils/semantic-similarity/proxy.ts` (SemanticSimilarityEngineProxy), `utils/semantic-similarity/engine.ts` (SemanticSimilarityEngine). Re-export all from `utils/semantic-similarity-engine.ts` as a barrel so import paths stay valid.
- **Risk**: Low — purely mechanical split; WXT auto-import resolves from the barrel. The only risk is circular imports between engine and memory-pool, which are avoided by pool not importing engine.

### IMP-0021 · Split packages/shared/src/tools.ts into per-category schema files (refactor) · score: 3

- **Proposed by**: optimization-scout · 2026-05-06
- **Status**: proposed
- **Why**: tools.ts is 1969 LoC with TOOL_SCHEMAS spanning lines 121-1877 (1757 lines, ~45 tool definitions). Every tool addition touches this one file, creating merge conflicts when multiple features land in parallel. Splitting into per-category files (navigation.ts, interaction.ts, media.ts, workflows.ts, etc.) limits each PR to one file, and the category coverage test already enforces completeness — so the test harness works as-is after the split.
- **Cost**: M
- **Value**: M
- **Files**: `packages/shared/src/tools.ts` (1969 LoC) — 1757 lines are schema objects, 120 lines are shared fragments (TAB_TARGETING, SELECTOR_PROP etc.), 92 lines are TOOL_CATEGORIES
- **Sketch**: Create `packages/shared/src/tool-schemas/` directory. Move shared fragments to `fragments.ts`. Create one file per TOOL_CATEGORY_ORDER entry (navigation.ts, tabs.ts, interaction.ts, page.ts, media.ts, network.ts, cookies.ts, workflows.ts, pacing.ts). Re-export all arrays from `tools.ts` as `export const TOOL_SCHEMAS = [...navigation, ...tabs, ...]`. TOOL_NAMES and TOOL_CATEGORIES stay in `tools.ts`.
- **Risk**: Medium — any consumer that imports from `humanchrome-shared` and does `import { TOOL_SCHEMAS }` keeps working; internal cross-file fragment imports must not create circular deps. Run `pnpm -w build` + coverage test as acceptance gate.

### IMP-0022 · Type record-replay NodeRuntime step generics to eliminate 60+ as any casts across node files (refactor) · score: 3

- **Proposed by**: optimization-scout · 2026-05-06
- **Status**: proposed
- **Why**: The 10+ node files (click.ts, fill.ts, assert.ts, download-screenshot-attr-event-frame-loop.ts, etc.) all use NodeRuntime<any> and cast step as any before accessing step-specific fields. expandTemplatesDeep<T>(value: T, scope) already preserves the type but callers force-cast to any before calling it, discarding inference. Each file also repeats (located as any)?.ref and (located as any)?.frameId because locateElement returns an untyped shape. Typing NodeRuntime with concrete step interfaces (StepClick, StepFill, etc., already defined in legacy-types.ts) eliminates ~60 casts and catches field mismatches at compile time.
- **Cost**: M
- **Value**: M
- **Files**: nodes/click.ts (23 casts), nodes/fill.ts (21), nodes/assert.ts (16), nodes/download-screenshot-attr-event-frame-loop.ts (31), nodes/scroll.ts (4), nodes/navigate.ts (3), nodes/wait.ts (16) — total ~60 in node files
- **Sketch**: 1) Declare locateElement return type as interface LocatedElement { ref?: string; frameId?: number; resolvedBy?: string; cssSelector?: string }. 2) Change NodeRuntime<any> to NodeRuntime<StepClick> etc. using existing legacy-types. 3) Pass typed step to expandTemplatesDeep<StepClick> — the generic already supports this. Casts disappear file by file.
- **Risk**: Medium — some step fields (saveAs, filenameContains) are not yet in current interfaces and need extending. Compile errors guide the work; no runtime change.

### IMP-0023 · Split agent.ts route file into project, session, message, attachment, and streaming sub-routers (refactor) · score: 3

- **Proposed by**: optimization-scout · 2026-05-06
- **Status**: proposed
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
