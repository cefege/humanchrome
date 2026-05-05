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

### IMP-0005 · Add multi-match count to chrome_intercept_response (feat) · score: 4

- **Proposed by**: feature-scout · 2026-05-05
- **Status**: proposed
- **Why**: chrome_intercept_response detaches after the first matching response, forcing agents to re-call it for each subsequent API response in paginated SPA flows (LinkedIn inbox pages, WhatsApp message history loads). Adding an optional count parameter (default 1) lets the tool accumulate N matches before detaching and returning them as an array — cutting round-trips from N to 1 for known-count pagination.
- **Cost**: S
- **Value**: M
  Schema change: add count: number (default 1) and returns responses: InterceptedResponse[]. Implementation: keep the existing resolve-on-first path when count===1 (zero behavior change), otherwise push to an accumulator and resolve when accumulator.length === count or timeout. Touch: tools/browser/intercept-response.ts and TOOL_SCHEMAS entry.

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

### IMP-0002 · Auto-generate docs/TOOLS.md from schemas (docs) · score: 3

- **Proposed by**: seed · 2026-05-05
- **Status**: queued
- **Why**: Phase 5 of the MCP-cleanup plan was scoped but not yet implemented. `docs/TOOLS.md` (~726 lines) duplicates schema descriptions by hand and goes stale. A small Node script can read `TOOL_SCHEMAS` + a category map and emit the doc between AUTO-GEN markers.
- **Cost**: M
- **Value**: M
- **Notes**: Plan exists in `~/.claude/plans/can-you-make-a-linear-hare.md` (the prior MCP-tool plan, before this rewrite). Categories: Browser management, Reading, Interaction, Scripting, Network, Files, State, Performance, Diagnostics. Use external `TOOL_CATEGORIES` map next to `TOOL_SCHEMAS` rather than `_meta` — avoids 33 inline edits and keeps category metadata off the MCP wire.

### IMP-0009 · Split ClaudeEngine.initializeAndRun into focused sub-methods (refactor) · score: 3

- **Proposed by**: optimization-scout · 2026-05-05
- **Status**: proposed
- **Why**: ClaudeEngine at 1601 LoC has a single public method `initializeAndRun` that spans roughly lines 62-1292 (~1230 lines). It interleaves SDK loading, env construction, tool-input streaming accumulation, stderr buffering, and HumanChrome bridge setup. Any change to stream parsing risks breaking error classification and vice versa. Splitting into private sub-methods (buildQuery, accumulateToolInput, processAssistantEvent, finalizeRun) would make each concern independently testable and cut the cognitive surface of the hot loop to <150 lines.
- **Cost**: M
- **Value**: M
- **Files**: `app/native-server/src/agent/engines/claude.ts` (1601 LoC)
- **Sketch**: Extract at minimum: `private async loadSdk()`, `private buildRunOptions(...)`, `private async processEventStream(stream, ctx, runLog)` (owns the big for-await loop), `private emitToolCall(...)`. `initializeAndRun` becomes an orchestrator of ~80 lines.
- **Risk**: Medium — the event loop is stateful (pendingToolInputs map, assistantBuffer); extraction must preserve the shared-state references. No behavior change.

### IMP-0007 · Add chrome_download_list and chrome_download_cancel tools (feat) · score: 2

- **Proposed by**: feature-scout · 2026-05-05
- **Status**: proposed
- **Why**: chrome_handle_download waits for one download to start, but agents cannot enumerate in-progress downloads, check if a previous download is still running, or cancel a stalled one. The bookmark group (search/add/update/delete) is the precedent: full CRUD lifecycle. chrome.downloads.search + chrome.downloads.cancel are already within the downloads permission the extension declares.
- **Cost**: S
- **Value**: S
  Two new tools: chrome_download_list (wraps chrome.downloads.search; params: state=in_progress|complete|interrupted|all, filenameContains?, limit?) and chrome_download_cancel (param: downloadId, required). Touch: tools/browser/download.ts (existing file already handles chrome.downloads), TOOL_NAMES, TOOL_SCHEMAS. Keep chrome_handle_download untouched.

## Done

### IMP-0001 · Fix tab-cursor.integration.test.ts onUpdated mock (bug) · score: 6

- **Proposed by**: seed · 2026-05-05
- **Status**: done
- **Completed**: 2026-05-05
- **Summary**: Added `onUpdated` + `onRemoved` no-op listener stubs to the `vi.stubGlobal('chrome', ...)` `tabs` block; the existing `tabsGet` mock returning `status: 'complete'` lets `waitForTabComplete` resolve via its fast-path. Extension vitest: 640 → 641 passed (full green). pnpm -w build: green.
- **Worktree**: /Users/mike/Documents/Code/humanchrome/.claude/worktrees/agent-ae99b9a2 (branch `worktree-agent-ae99b9a2`)

### IMP-0003 · Add chrome_get_cookies and chrome_set_cookies tools (feat) · score: 4

- **Proposed by**: feature-scout · 2026-05-05
- **Status**: done
- **Completed**: 2026-05-05
- **Summary**: Added 3 tools (chrome_get_cookies, chrome_set_cookie, chrome_remove_cookie) in new file cookies.ts (+219). Schemas + TOOL_NAMES in tools.ts (+127). **Permission escalation**: added `cookies` to wxt.config.ts manifest permissions (was NOT pre-existing despite the proposal's claim) + PERMISSIONS.md justification — review before publishing as it triggers Chrome Web Store re-review and an update prompt for users. Bridge tests: 36/36. Extension vitest: 641/641. pnpm -w build: green.
- **Worktree**: /Users/mike/Documents/Code/humanchrome/.claude/worktrees/agent-aa6bcd43 (branch `worktree-agent-aa6bcd43`)

### IMP-0004 · Add chrome_await_element tool for element presence polling (feat) · score: 4

- **Proposed by**: feature-scout · 2026-05-05
- **Status**: done
- **Completed**: 2026-05-05
- **Summary**: Added `chrome_await_element` (await-element.ts +152, schema +56) using MutationObserver in extended wait-helper.js (+127). Resolves target via ref / CSS / XPath; observer watches document.documentElement (subtree+childList+attributes); returns immediately when goal state already holds. timeoutMs clamped to [0, 120000] with 15000 default; emits ToolErrorCode.TIMEOUT envelope on miss. Read-only (mutates=false). Bridge tests: 36/36. Extension vitest: 641/641. pnpm -w build: green.
- **Worktree**: /Users/mike/Documents/Code/humanchrome/.claude/worktrees/agent-ac16d6fa (branch `worktree-agent-ac16d6fa`)
- **Note**: Worktree was branched from main @ `6fe8158` (pre-Phase-1-4 of MCP-cleanup), so the schema hand-rolls tabId/windowId/background/ref/selector instead of using the TAB_TARGETING/REF_PROP/SELECTOR_PROP fragments added in Phase 2. If the cleanup phases land first, this schema can be tightened in a follow-up.
