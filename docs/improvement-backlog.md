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

<!-- ===== Ralph Loop queue: IMP-0074..IMP-0084 (added 2026-05-09) ============
The eleven entries below are the autonomous-loop work queue. The loop ships
them one at a time, in order, each as a separate PR. Conflict-avoidance rules
the loop must follow:

  1. `git checkout main; git pull --ff-only origin main` at the start of every
     iteration. No exceptions.
  2. Touch `packages/shared/src/tools.ts` only by appending: new TOOL_NAMES at
     the end of the BROWSER object, new TOOL_SCHEMAS at the end of the array,
     new TOOL_CATEGORIES at the end of its map.
  3. Touch `app/chrome-extension/entrypoints/background/tools/index.ts` only by
     appending an import + a push into `eagerTools`.
  4. Touch `app/chrome-extension/entrypoints/background/tools/browser/index.ts`
     only by appending an export.
  5. One IMP-NNNN per PR. No multi-feature batches.

Per-iteration playbook:
  1. Pull main, branch `feat/imp-NNNN-<slug>`.
  2. Create the new tool file under
     app/chrome-extension/entrypoints/background/tools/browser/<slug>.ts.
     Class extends BaseBrowserToolExecutor. Action enum if multi-action.
     Error mapping: TAB_CLOSED for /no tab with id/i, INVALID_ARGS for arg
     validation, UNKNOWN otherwise.
  3. Append TOOL_NAMES + TOOL_SCHEMAS + TOOL_CATEGORIES entries.
  4. Append barrel export and dispatcher import + eagerTools push.
  5. Add manifest permission(s) to wxt.config.ts if the entry calls for them.
  6. Write tests/tools/browser/<slug>.test.ts — 8-15 cases: arg validation,
     happy path per action, error classifications, missing-permission path.
  7. `cd packages/shared && npm run build` then `cd app/chrome-extension &&
     npx tsc --noEmit -p .` then `npx vitest run --reporter=dot`.
  8. `cd app/native-server && npm test`.
  9. Move the IMP-NNNN entry from `## Active` to `## Done` with a one-paragraph
     summary that covers what shipped, the action surface, error classification,
     test count, and the manifest delta.
 10. `git add -A; git commit; git push -u; gh pr create; gh run watch;
     gh pr merge --squash --delete-branch`.

Stop conditions: queue empty, two consecutive failures with the same root
cause, or user invokes /ralph-loop:cancel-ralph.

Safety net: if an iteration hits an irrecoverable failure, abort without
opening a PR and append `**Status**: blocked\n- **Notes**: <reason>` to the
IMP entry. Move to next iteration on the next tick.
=========================================================================== -->

### IMP-0054 · Extract executeAction switch in computer.ts into per-action handler modules (click, scroll, fill, screenshot) (refactor) · score: 4

- **Proposed by**: optimization-scout · 2026-05-08
- **Status**: done (CDPHelper, click-actions, scroll-zoom-actions, input-actions, view-actions all extracted under `browser/computer/`; computer.ts shrank from 1327 LoC to ~350 LoC orchestrator)
- **Why**: After IMP-0008 (domain-shift helper) and IMP-0035 (params typing), the dominant bulk in computer.ts is a 16-case switch inside executeAction spanning lines 392-1348 (~956 LoC). Representative case sizes: left_click_drag 93 LoC, zoom 98 LoC, screenshot 147 LoC. Adding a new action or fixing a case requires navigating past all 15 others. CDPHelper (lines 142-310) is already a self-contained class that could be elevated to a sibling module without any refactor risk.
- **Cost**: M
- **Value**: M
- **Files**: `app/chrome-extension/entrypoints/background/tools/browser/computer.ts` (1478 LoC; executeAction lines 392-1348 ~956 LoC switch; CDPHelper lines 142-310)
- **Sketch**: Slicing into focused PRs. Slice 1 (done): move CDPHelper to `browser/computer/cdp-helper.ts` (~168 LoC). Slice 2: extract `browser/computer/actions/click-actions.ts` (left_click/right_click/double_click/triple_click/left_click_drag). Slice 3: scroll-actions.ts. Slice 4: fill-actions.ts. Slice 5: screenshot-actions.ts. Slice 6: replace switch with `const HANDLERS: Record<string, ActionHandler> = {...}` dispatch table. After all slices: computer.ts shrinks to ~250-LoC orchestrator with execute()/mapActionToCapture()/triggerAutoCapture()/domHoverFallback().
- **Risk**: Medium — CDP timeout wrapper composes around handler dispatch; shared helpers (project, screenshotContextManager lookups) passed via deps object. No runtime change. Extension test suite catches regressions.

### IMP-0009 · Split ClaudeEngine.initializeAndRun into focused sub-methods (refactor) · score: 3

- **Proposed by**: optimization-scout · 2026-05-05
- **Status**: in-progress (slices 1 + 2 + 3 landed)
- **Why**: ClaudeEngine at 1601 LoC has a single public method `initializeAndRun` that spans ~1230 lines. It interleaves SDK loading, env construction, tool-input streaming accumulation, stderr buffering, and HumanChrome bridge setup. Splitting into private sub-methods makes each concern independently testable.
- **Cost**: M
- **Value**: M
- **Files**: `app/native-server/src/agent/engines/claude.ts`
- **Sketch**: Slice 1 (done): `private async loadSdk()` — 1 method. Slice 2 (done): `private async buildRunOptions(input)` lifted from `initializeAndRun` lines 445-761 (~315 LoC). Returns `{queryOptions, internalAbortController}`. 26 unit tests. Slice 3 (done): `private dispatchToolMessageRun(scope, ...)` lifted from the in-loop closure. The closure now binds `{sessionId, requestId, streamedToolHashes, emit}` once per run as a `ClaudeDispatchScope` and delegates to the class method. **Includes the same dedup-hash full-base64 fix that landed in IMP-0049 slice 3** (codex.ts). 9 unit tests at `src/agent/engines/claude.dispatch-tool-message.test.ts`. Remaining slices: `processEventStream` (for-await loop, ~447 LoC) — blocked on first promoting the in-loop state cluster (`assistantBuffer`, `assistantMessageId`, `assistantCreatedAt`, `lastAssistantEmitted`, `streamedToolHashes`, `pendingToolInputs`, `currentContentBlockIndex`) plus closure helpers (`emitAssistant`, `buildToolMetadata`, `inferActionFromToolName`) into either a `RunState` object or methods, otherwise `processEventStream`'s signature would need ~12 callbacks.
- **Risk**: Medium — the event loop is stateful; extraction must preserve the shared-state references. Slices 2 + 3 had zero streaming-state coupling and were clean wins.

### IMP-0019 · Split semantic-similarity-engine.ts into model-registry, memory-pool, proxy, and engine modules (refactor) · score: 3

- **Proposed by**: optimization-scout · 2026-05-06
- **Status**: done (3 of 4 sub-modules extracted under `utils/semantic-similarity/`: model-registry, memory-pool, proxy. The 4th — the SemanticSimilarityEngine class — remains in semantic-similarity-engine.ts; splitting it would be a pure file rename since the rest of the file is engine-internal types + the engine class. Concerns are separated; orchestrator now scopes to engine + cache helpers.)
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
- **Status**: done (all 16 node files typed with proper Step\* generics; ~158 casts eliminated; click.ts dedup'd via runClickStep helper, fill.ts via logFallback helper)
- **Why**: The 10+ node files (click.ts, fill.ts, assert.ts, download-screenshot-attr-event-frame-loop.ts, etc.) all use NodeRuntime<any> and cast step as any before accessing step-specific fields. expandTemplatesDeep<T>(value: T, scope) already preserves the type but callers force-cast to any before calling it, discarding inference. Each file also repeats (located as any)?.ref and (located as any)?.frameId because locateElement returns an untyped shape. Typing NodeRuntime with concrete step interfaces (StepClick, StepFill, etc., already defined in legacy-types.ts) eliminates ~60 casts and catches field mismatches at compile time.
- **Cost**: M
- **Value**: M
- **Files**: nodes/click.ts (23 casts), nodes/fill.ts (21), nodes/assert.ts (16), nodes/download-screenshot-attr-event-frame-loop.ts (31), nodes/scroll.ts (4), nodes/navigate.ts (3), nodes/wait.ts (16) — total ~60 in node files
- **Sketch**: 1) Declare locateElement return type as interface LocatedElement { ref?: string; frameId?: number; resolvedBy?: string; cssSelector?: string }. 2) Change NodeRuntime<any> to NodeRuntime<StepClick> etc. using existing legacy-types. 3) Pass typed step to expandTemplatesDeep<StepClick> — the generic already supports this. Casts disappear file by file.
- **Risk**: Medium — some step fields (saveAs, filenameContains) are not yet in current interfaces and need extending. Compile errors guide the work; no runtime change.

### IMP-0023 · Split agent.ts route file into project, session, message, attachment, and streaming sub-routers (refactor) · score: 3

- **Proposed by**: optimization-scout · 2026-05-06
- **Status**: done (projects.ts, attachments.ts, sessions.ts, messages.ts, streaming.ts all extracted; agent.ts shrunk from 1264 LoC → 287 LoC orchestrator)
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
- **Status**: done (sse-client.ts, prompt-builder.ts, normalizers.ts, editor-lifecycle.ts, early-injection.ts, and now message-router.ts all extracted; index.ts shrunk from 1641 LoC to 54 LoC)
- **Why**: app/chrome-extension/entrypoints/background/web-editor/index.ts is 1641 LoC and bundles four unrelated concerns inside a single initWebEditorListeners() export: SSE subscription / execution-status cache (lines 29-160), agent prompt builder (lines 412-670), input normalizer helpers (lines 263-410), and the 700-line chrome.runtime.onMessage switch. Any change to the prompt template requires navigating past the SSE client and vice versa. The file is evaluated in the service worker on extension start, so its parse time is in the critical path.
- **Cost**: M
- **Value**: M
- **Files**: (1641 LoC)
- **Sketch**: Extract to (subscribeToSessionStatus, executionStatusCache, handleSseEvent, ~160 LoC), (normalizeString, normalizeStringArray, normalizeStyleMap, normalizeApplyPayload, normalizeApplyBatchPayload, ~150 LoC), (buildAgentPrompt, buildAgentPromptBatch, ~260 LoC), (chrome.runtime.onMessage handler, ~700 LoC). index.ts becomes a 30-line orchestrator calling initWebEditorListeners.
- **Risk**: Low. No behavior change. Internal function references become cross-file imports. Message-router imports from all three helpers.

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
- **Status**: done (all 5 sub-modules extracted under `cssom/`: inheritance, shorthand, sheet-inspector, specificity-parser, cascade; orchestrator shrunk from 1552 LoC to ~810 LoC)
- **Why**: 1552-LoC file has 6 pre-labeled banner sections (Specificity, Inheritance, Shorthand, Cascade, CSSOM Inspection, Collection) plus 4 large data tables: INHERITED_PROPERTIES (~120 entries), SHORTHAND_TO_LONGHANDS (~135 entries), LEGACY_PSEUDO_ELEMENTS, and a selector tokenizer (lines 363-507). Each section is self-contained. Splitting makes the specificity parser independently testable without booting the cascade engine and reduces the impact surface of CSS panel changes.
- **Cost**: M
- **Value**: M
- **Files**: `app/chrome-extension/entrypoints/web-editor-v2/core/cssom-styles-collector.ts` (1552 LoC, 33 functions)
- **Sketch**: Split into `cssom/specificity-parser.ts` (~340 LoC: tokenizer + computeSelectorSpecificity + helpers), `cssom/inheritance.ts` (~125 LoC: INHERITED_PROPERTIES + isInheritableProperty), `cssom/shorthand.ts` (~145 LoC: SHORTHAND_TO_LONGHANDS + expandToLonghands + normalizePropertyName), `cssom/cascade.ts` (~50 LoC: compareCascade/compareSourceOrder/computeOverrides), `cssom/sheet-inspector.ts` (~160 LoC: isSheetApplicable/describeStyleSheet/evalMediaRule/evalSupportsRule/safeReadCssRules). Top-level file keeps public types and createRuleIndexForRoot orchestrator (~600 LoC).
- **Risk**: Low — sections are self-contained by design and their labeled boundaries match function call graphs.

### IMP-0049 · Split codex.ts initializeAndRun into focused sub-methods (mirrors IMP-0009 pattern for claude.ts) (refactor) · score: 3

- **Proposed by**: optimization-scout · 2026-05-08
- **Status**: in-progress (slices 1 + 2 + 3 landed)
- **Why**: codex.ts initializeAndRun spans ~632 LoC, mirroring the IMP-0009 problem in claude.ts. It blends Codex CLI spawn, env construction, JSON-line event parsing, todo-list synthesis, apply-patch summarization, attachment temp-file creation, and stderr buffering in one method. Divergence from the claude.ts refactor creates parallel maintenance pressure: every change to shared message shape must be replicated in both engines without structural parity to guide the developer.
- **Cost**: M
- **Value**: M
- **Files**: `app/native-server/src/agent/engines/codex.ts`
- **Sketch**: Slicing into focused PRs. Slice 1 (done): `private async buildCliInvocation(input)` — 10 unit tests. Slice 2 (done): `private emitTodoListUpdate(record, phase, dispatch)` — 7 unit tests. Slice 3 (done): `private dispatchToolMessageRun(scope, ...)` lifted from the in-loop closure — the closure now binds `{sessionId, requestId, streamedToolHashes, emit}` once per run as a `CodexDispatchScope` and delegates to the class method. Locked by 9 unit tests at `src/agent/engines/codex.dispatch-tool-message.test.ts`. **Bonus fix**: slice 3 surfaced and corrected a pre-existing dedup-hash collision bug — `encodeHash(...).slice(0, 16)` truncated base64 too aggressively, causing different small metadata payloads (`{k:1}` vs `{k:2}`) to share their first 16 chars and silently dedupe. Now uses the full hash. **claude.ts has the same bug at line 195** — flag for the corresponding IMP-0009 slice. Remaining slices: `processCodexEventStream(child, ctx, runLog)` (for-await loop, ~350 LoC) — blocked on first promoting `handleItemStarted/Delta/Completed`, `emitAssistant`, `resetAssistantBuffers` from closures to methods (or bundling them into a `CodexStreamState` object). After all slices: initializeAndRun becomes a ~80-line orchestrator. Apply same sub-method pattern as IMP-0009 so both engines are structurally parallel.
- **Risk**: Low-Medium — stateful event loop with shared accumulators (stderr buffer, pending lines) must preserve closure references. No runtime change in slices 1+2; slice 3 includes a CORRECTNESS FIX for the dedup hash collision (no behavior change for the common case where messages differ in the first 16 chars).

### IMP-0052 · Split rpc-server.ts into request-router plus per-domain handler modules (queue, flow, trigger, run-control) (refactor) · score: 3

- **Proposed by**: optimization-scout · 2026-05-08
- **Status**: in-progress (slice 1: queue handlers extracted to `transport/handlers/queue-handlers.ts`; flow/trigger/run-control handlers pending)
- **Why**: Single RpcServer class has 30+ private async handle\* methods registered through one handleRequest dispatch (line 238). Concerns are clearly separable: queue management, flow CRUD + normalizeFlowSpec (140 LoC validator), trigger CRUD + normalizeTriggerSpec (155 LoC), and run controls. The transport file conflates wire-protocol lifecycle with domain validation logic, making it hard to change flow normalization without navigating past trigger and queue code.
- **Cost**: M
- **Value**: M
- **Files**: `app/chrome-extension/entrypoints/background/record-replay-v3/engine/transport/rpc-server.ts` (1063 LoC)
- **Sketch**: Extract `transport/handlers/queue-handlers.ts` (~80 LoC: handleEnqueueRun/handleListQueue/handleCancelQueueItem), `transport/handlers/flow-handlers.ts` (~290 LoC: handleSaveFlow/handleDeleteFlow + normalizeFlowSpec/normalizeNode/normalizeEdge), `transport/handlers/trigger-handlers.ts` (~445 LoC: handleCreateTrigger through handleFireTrigger + normalizeTriggerSpec), `transport/handlers/run-handlers.ts` (~95 LoC: handlePauseRun/handleResumeRun/handleCancelRun). rpc-server.ts becomes ~280-LoC orchestrator for port lifecycle + handleRequest dispatch. Handlers receive a context object { storage, events, runners, scheduler, triggerManager, generateRunId, now }.
- **Risk**: Medium — handleRequest switch must stay exhaustive; requireTriggerManager guard must compose into handler context. Compile errors guide the work. No runtime change.

## Done

### IMP-0086 · Revert IMP-0056 lazy tool dispatcher — MV3 service worker fails to register (bug) · score: 5

- **Status**: done
- **Completed**: 2026-05-11
- **Summary**: IMP-0056 split `tools/index.ts` into eager + lazy halves with `import('./browser/<x>')` for ~14 heavy tools, claiming an ~80–120 KB cold-start saving. In practice Rolldown (1.0.0-rc.17 via WXT 0.20.26) hoisted those dynamic imports back to static imports in the entry chunk (`gif-recorder`, `network-capture-debugger`, `intercept-response`, etc. show up in `import …from"./chunks/…"` at the top of `background.js`), so the boot-time bundle didn't actually shrink. Worse, Rolldown placed `BaseBrowserToolExecutor` in the entry chunk while making the lazy chunks back-edge import it via `import { … } from "../background.js"`. ESM evaluation order then resolved the lazy chunks' top-level `class X extends Base` before the entry reached `class Base { … }` — TDZ → "Class extends value undefined" → MV3 service worker registration fails with status code 15. Reproduced fresh from `main` (HEAD = 6df5464) on Chrome MV3; v1.0.1 release (commit 2d41084, predates IMP-0056's c1700b4) was the last green build. Bisect: c1700b4 (IMP-0056) is the offending commit. Fix: convert all 14 lazy loaders to eager `import` statements at the top of `tools/index.ts`, push them into `eagerTools`, drop `lazyLoaders` / `resolveLazyTool` / `lazyResolved` / `lazyInflight` / `_resetLazyToolCacheForTest` machinery (kept the export name as a no-op for back-compat), delete `tests/tools/lazy-tool-registry.test.ts` (its boot-time-silence assertions no longer model what's shipped), update CLAUDE.md to drop the eager/lazy split mention and the contract-test row. Bundle has zero back-edge imports from chunks to `../background.js`. Real lazy loading is recoverable later by moving `BaseBrowserToolExecutor` (and any sibling helpers it pulls in) into `humanchrome-shared` so it lives in a leaf module Rolldown can chunk independently of the entry — that work tracked separately.

### IMP-0035 · Type computer.ts params to eliminate 24 remaining as any casts in action dispatch (refactor) · score: 3

- **Status**: done (premise stale — audit confirmed zero `as any` casts)
- **Completed**: 2026-05-09
- **Summary**: Audit during the IMP-0049 slice 2 cycle confirmed `app/chrome-extension/entrypoints/background/tools/browser/computer.ts` has **zero** `as any` casts today. The IMP-0008 (domain-shift helper) + the original IMP-0035 first pass already eliminated all 24. What remains is three innocuous `: any` annotations on CDP return values (lines 748, 1101, 1120 — `Page.getLayoutMetrics`, `Page.captureScreenshot`) where the code already does defensive `?.` access on the response shape. A future micro-PR could tighten `CDPHelper.send<T>(...)` with a generic — but that's a chore touching every caller, not the IMP-0035 surface. Closed without code change. No test impact.

### IMP-0053 · Add status action to chrome_network_capture for non-destructive buffer inspection (feat) · score: 2

- **Status**: done
- **Completed**: 2026-05-09
- **Summary**: New `status` action on the unified `chrome_network_capture` tool — read-only inspection of the in-memory capture state. Returns `{active, backend: 'debugger'|'webRequest'|null, sinceMs: number|null, bufferedCount, tabIds: number[]}`. Lets agents check whether a capture is already running (so they can avoid the start-while-running error), peek the buffered request count before deciding whether to `flush`, or measure capture age. Side-effect-free: listeners, timers, and buffered requests are NOT touched. Backend-precedence rule mirrors `flush`/`stop`: if both happen to be active, debugger wins (it's the more invasive session). Aggregates `bufferedCount` and `tabIds` across all tabs in the active backend's `captureData`; `sinceMs` is computed from the OLDEST `startTime` so multi-tab captures don't hide a long-running tab. Code-simplifier pass before tests landed: extracted `summarizeCapture(map)` helper for the shared per-tab loop, hoisted the debugger `captureData` cast into a single `getDebuggerCaptureData()` accessor, dropped the redundant `scope` string field in favor of just `tabIds`, trimmed comments to WHY-only. New tests at `tests/tools/browser/network-capture-status.test.ts` (8 cases). Targeted suite + flush regression 28/28, typecheck clean.

### IMP-0007 · Add chrome_download_list and chrome_download_cancel tools (feat) · score: 2

- **Status**: done
- **Completed**: 2026-05-09
- **Summary**: Two new MCP tools wrapping `chrome.downloads.search` and `chrome.downloads.cancel`, completing the download lifecycle alongside `chrome_handle_download`. `chrome_download_list` params: `{state?: 'in_progress'|'complete'|'interrupted'|'all', filenameContains?: string, limit?: number}`. Returns `{count, items: [{id, url, filename, state, totalBytes, bytesReceived, startTime, endTime, mime, error?}]}`. `state='all'` skips the state filter; `filenameContains` is case-insensitive substring match on the basename (full path is OS-dependent and tends to false-positive against the user's home dir). `limit` clamped to `[1, 100]`, default 25. `chrome_download_cancel` params: `{downloadId: number}` (required). Returns `{cancelled: true, downloadId, postState}` where `postState` is the post-cancel state (`'interrupted'` for active cancels, the prior terminal state for already-finished). `postState` falls back to `'unknown'` if the post-cancel search throws or returns nothing — the cancel itself is reported as success regardless. Error classification: missing `chrome.downloads` API → UNKNOWN, missing/non-numeric `downloadId` → INVALID_ARGS naming the field, search/cancel rejection → UNKNOWN with the original message. No new manifest permissions (`downloads` already declared). Wired through the eager dispatcher. New tests at `tests/tools/browser/download-list-cancel.test.ts` (15 cases). Code-simplifier pass applied before tests: dropped the local `DownloadItemSummary` shape in favor of inline mapping, exported `DownloadListParams`/`DownloadCancelParams`, hoisted basename extraction into a small helper, used `chrome.downloads.DownloadQuery['state']` for the state union. Extension typecheck clean; targeted suite + lazy-tool-registry shape guard 23/23.

### IMP-0018 · Add record_replay_flow_delete tool to complete recording lifecycle (feat) · score: 2

- **Status**: done
- **Completed**: 2026-05-09
- **Summary**: New `record_replay_flow_delete` MCP tool — completes the recording lifecycle alongside `record_replay_list_published` and `record_replay_flow_run`. Agents can now clean up stale versions during iterative record-test-refine sessions without opening the extension UI. Param: `flowId` (string, required). Always unpublishes BEFORE deleting (idempotent — `unpublishFlow` no-ops on unpublished flows) so the dynamic `flow.<slug>` MCP tool the bridge exposes disappears even when the underlying flow record is being deleted in the same call. The bridge cache is TTL-bounded (60s in `dispatch.ts`) so the next `tools/list` reflects the deletion automatically. Returns `{deleted: true, unpublished, flowId}` — `unpublished` reports whether the flow was published before deletion. `unpublished:true` is determined BEFORE the unpublish call, so a failed unpublish (some storage backends throw on unknown keys) doesn't lie. Error classification: missing/whitespace `flowId` → INVALID_ARGS naming the field; nonexistent flow → INVALID_ARGS with the id; deleteFlow rejection → UNKNOWN with the original message. Survives partial failures: `listPublished` failure proceeds with delete (reports `unpublished:false`); `unpublishFlow` failure proceeds with delete (the IndexedDB delete is the source of truth). Wired through the eager dispatcher. New tests at `tests/tools/browser/flow-delete.test.ts` (8 cases). Targeted suite + lazy-tool-registry shape guard 16/16, typecheck clean.

### IMP-0029 · Add chrome_remove_injected_script tool to explicitly unload a persistent injection (feat) · score: 2

- **Status**: done
- **Completed**: 2026-05-09
- **Summary**: New `chrome_remove_injected_script` MCP tool that wraps the existing internal `handleCleanup(tabId)` path so agents can deliberately tear down a previously-installed user script without navigating the tab away. Params: `{tabId?: number}` — falls back to the active tab in the focused window when omitted. Returns `{removed: boolean, tabId}`. Idempotent: `removed:false` when the tab had no injection (callers don't need to track state). Error classification: missing active tab → TAB_NOT_FOUND; "no tab with id" during cleanup is treated as `removed:true` (the map entry is still gone — the tab raced closure between has-check and cleanup). No new manifest permissions. New `_seedInjectedTabForTest` test-only export so test seeding doesn't depend on `injectScriptTool`'s arg shape (mirrors the IMP-0085 `_resetPlatformCacheForTest` lesson). Code-simplifier pass applied before tests landed: trimmed JSDocs, moved param doc up to the class, removed redundant error-message prefixes. New tests at `tests/tools/browser/remove-injected-script.test.ts` (6 cases). Targeted suite + lazy-tool-registry shape guard 14/14, typecheck clean.

### IMP-0015 · Add chrome_pace_get tool to read the current pacing profile (feat) · score: 2

- **Status**: done
- **Completed**: 2026-05-09
- **Summary**: New `chrome_pace_get` MCP tool — read-only counterpart to `chrome_pace`. No required parameters. Returns `{clientId, profile: 'off' | 'human' | 'careful' | 'fast', minGapMs, jitterMs}` for the calling MCP client. When no profile has been set, returns the canonical `{profile: 'off', minGapMs: 0, jitterMs: 0}` default. Enables safe save-and-restore patterns (read current pace → temporarily switch to `fast` for a bulk read phase → restore). Reuses the existing `getClientPacing(clientId)` accessor in `client-state.ts` — zero new infrastructure. Error classification: missing clientId on the request context → INVALID_ARGS pointing the caller at the `X-Client-Id` REST header. Wired through the eager dispatcher. New tests at `tests/tools/browser/pace-get.test.ts` (7 cases: defaults, post-set roundtrip, explicit overrides, profile change, no-clientId rejection, cross-client isolation, repeated-read idempotency). Targeted suite + lazy-tool-registry shape guard 15/15, typecheck clean.

### IMP-0051 · chrome_performance_analyze_insight returns isError:false when no trace has been recorded (bug) · score: 4

- **Status**: done (already fixed before backlog audit)
- **Completed**: 2026-05-09
- **Summary**: Audit during the IMP-0085 cycle confirmed `PerformanceAnalyzeInsightTool` (`app/chrome-extension/entrypoints/background/tools/browser/performance.ts:362-368`) already uses `createErrorResponse(..., ToolErrorCode.UNKNOWN, { tabId })` for the "no recorded trace for this tab" pre-condition. The fix was bundled into the IMP-0048 batch when the performance-tool family was migrated off the legacy `isError:false` text-error pattern. The parallel `PerformanceStopTraceTool` "no session" branch deliberately stays `isError:false` (idempotent stop), guarded by `tests/tools/browser/performance.test.ts:162` so future refactors don't widen the fix beyond what was intended. No code change required to close.

### IMP-0030 · Add named-shortcut param to chrome_keyboard for common browser-level key combos (feat) · score: 2

- **Status**: done (superseded by IMP-0085)
- **Completed**: 2026-05-09
- **Summary**: Functionality landed via IMP-0085 (`Add shortcut enum to chrome_keyboard for platform-correct named chords`, PR #113 + simplify follow-up #114). IMP-0085 covers the same surface (copy/paste/cut/undo/redo/save/select_all/find/refresh/back/forward/new_tab/close_tab) plus platform detection via `chrome.runtime.getPlatformInfo()`, asymmetric mappings where macOS diverges (redo, back, forward), exported pure helper `resolveShortcutKeys`, memoized platform lookup, and 32 unit tests. The IMP-0030 sketch is a strict subset.

### IMP-0085 · Add `shortcut` enum to chrome_keyboard for platform-correct named chords (feat) · score: 3

- **Status**: done
- **Completed**: 2026-05-09
- **Summary**: Augments the existing `chrome_keyboard` tool with an optional `shortcut` enum (`copy | paste | cut | undo | redo | save | select_all | find | refresh | back | forward | new_tab | close_tab`) that resolves at dispatch time to the platform-correct chord — `Meta` on macOS (via `chrome.runtime.getPlatformInfo()`), `Ctrl` elsewhere — so agents no longer hard-code Ctrl-vs-Meta in prompts. Asymmetric mapping where it matters (redo: `Meta+Shift+z` on macOS vs `Ctrl+y` elsewhere; back/forward: `Meta+Arrow*` vs `Alt+Arrow*`). When both `keys` and `shortcut` are supplied, `shortcut` wins (callers reaching for a high-level name don't want a stale literal silently overriding it). When neither is supplied, returns `INVALID_ARGS` naming `keys|shortcut` (was `keys`-only before). The `keys` field is no longer required at the schema level but is still validated in code. Pure helper `resolveShortcutKeys` is exported for unit testing without `chrome.runtime` mocks. Falls back to non-mac chord on `getPlatformInfo` failure. New tests at `tests/tools/browser/keyboard-shortcuts.test.ts` (32 cases): exhaustive 13×2 mac/non-mac mapping coverage plus 6 end-to-end cases for `chrome.runtime.getPlatformInfo` integration, shortcut-wins-over-keys, fallback, and the no-args INVALID_ARGS path. No new manifest permissions. Extension: 1109/1109; bridge: 77/77; typecheck clean.
- **Branch**: feat/imp-0085-keyboard-shortcuts

### IMP-0084 · Add chrome_drag_drop tool — synthesize mousedown/move/up + DnD events (feat) · score: 4

- **Status**: done
- **Completed**: 2026-05-09
- **Summary**: New `chrome_drag_drop` MCP tool that synthesizes the full HTML5 Drag-and-Drop + Pointer-Event chain between two elements. Single tool, no action enum. Params: `{ fromSelector? | fromRef?, toSelector? | toRef?, tabId?, windowId?, frameId?, steps? }`. MAIN-world shim resolves both targets, computes their bounding-rect centers, then dispatches `pointerdown` → `mousedown` → `dragstart` on FROM, then `steps` intermediate `pointermove` + `dragover` events along a linear interpolation (target shifts to TO past the halfway point so kanban / sortable libs see crossing), then `dragenter` → `dragover` → `drop` on TO and `dragend` on FROM and `pointerup` / `mouseup` on TO. Each drag event carries a fresh `DataTransfer`. Returns `{ steps, fromBox, toBox, tabId, frameId }`. Error classification: `INVALID_ARGS` for missing/duplicate from-or-to source, `INVALID_ARGS` for not-found / hidden targets (with a `reason` field of `from_not_found | to_not_found | from_hidden | to_hidden`) so callers can branch without re-raising; `TAB_CLOSED` for `no tab with id`; `TAB_NOT_FOUND` when no active tab; `UNKNOWN` otherwise. `steps` is clamped to `[1, 50]`. No new manifest permissions (uses existing `scripting`). Wired through the eager dispatcher. New tests at `tests/tools/browser/drag-drop.test.ts` (16 cases) covering arg validation, both selector + ref happy paths, steps clamping, frame scoping, all four error reasons, missing-result, and TAB_NOT_FOUND. Extension: 1077/1077; bridge: 77/77; typecheck clean. Ralph-loop queue IMP-0074..IMP-0084 complete.
- **Branch**: feat/imp-0084-drag-drop

### IMP-0083 · Add chrome_identity tool — OAuth via chrome.identity (feat) · score: 4

- **Status**: done
- **Completed**: 2026-05-09
- **Summary**: New `chrome_identity` MCP tool wrapping `chrome.identity.{getAuthToken,removeCachedAuthToken,getProfileUserInfo}`. Lets agents call Google APIs (Gmail, Calendar, Drive, GSC) via Chrome's native consent-cache-refresh flow instead of bouncing through an interactive browser-based OAuth each run. Action enum: `get_token` (`scopes: string[]`, `interactive: boolean`; returns `{token, scopes, interactive}`; unwraps both the legacy string return and the modern `{token}` object return), `remove_token` (`token`), `get_profile` (returns `{email, id}` via `getProfileUserInfo({accountStatus: 'ANY'})`). **Manifest delta:** added `identity` to permissions, plus a new `oauth2: { client_id: process.env.HUMANCHROME_OAUTH_CLIENT_ID || '__SET_HUMANCHROME_OAUTH_CLIENT_ID__', scopes: [] }` block. Until `HUMANCHROME_OAUTH_CLIENT_ID` is set at build time, the placeholder loads as-is and the tool detects placeholder/not-granted/client_id errors and surfaces an INVALID_ARGS pointing at the env-var requirement instead of an opaque OAuth failure. New tests at `tests/tools/browser/identity.test.ts` (12 cases) including both placeholder-detection paths. Extension: 1061/1061 (was 1049 + 12 new); bridge: 77/77; typecheck clean.
- **Branch**: feat/imp-0083-identity
- **Setup note**: For `get_token` to actually return a real token, set `HUMANCHROME_OAUTH_CLIENT_ID` in your build environment (`.env` or shell) to a Google OAuth2 client_id with the appropriate scopes whitelisted. The extension's keyfile pin is also typically required for `chrome.identity.getAuthToken` to work — see `chrome.runtime.id` and the matching client_id authorized in Google Cloud Console. Without these, the tool short-circuits with the INVALID_ARGS message above.

### IMP-0082 · Add chrome_proxy tool — set/clear proxy configuration (feat) · score: 3

- **Status**: done
- **Completed**: 2026-05-09
- **Summary**: New `chrome_proxy` MCP tool wrapping `chrome.proxy.settings.{set,clear,get}` so agents can switch proxy config at runtime — useful for scraping, regional testing, and anonymity flows. Action enum: `set` (mode = `direct` | `system` | `fixed_servers` | `pac_script`; `fixed_servers` requires `singleProxy: {scheme?, host, port}` plus optional `bypassList[]`; `pac_script` requires `pacUrl`), `clear` (revert to default), `get` (returns current `{value, levelOfControl, incognitoSpecific}`). Scope is hardcoded to `regular` (incognito left untouched). Error classification: missing chrome.proxy → UNKNOWN, missing/invalid mode/host/port/pacUrl → INVALID_ARGS naming the field, UNKNOWN otherwise. Added `proxy` to manifest permissions. Wired through the eager dispatcher. New tests at `tests/tools/browser/proxy.test.ts` (13 cases) covering each mode + clear + get round-trip + custom scheme handling. Extension: 1049/1049 (was 1036 + 13 new); bridge: 77/77; typecheck clean.
- **Branch**: feat/imp-0082-proxy

### IMP-0081 · Add chrome_clear_browsing_data tool — wipe browsing-data stores (feat) · score: 4

- **Status**: done
- **Completed**: 2026-05-09
- **Summary**: New `chrome_clear_browsing_data` MCP tool wrapping `chrome.browsingData.remove` so agents can sanitize state between sessions in one call. Single tool, no action enum. Required: `dataTypes` (non-empty array of `cookies`, `localStorage`, `indexedDB`, `cache`, `cacheStorage`, `history`, `downloads`, `formData`, `passwords`, `serviceWorkers`, `webSQL`, `fileSystems`, `pluginData`, `appcache`). Optional: `since` (epoch ms; default 0 = all time), `origins` (origin-scoped filter). Validation rejects empty/missing dataTypes with INVALID_ARGS and unknown keys with INVALID_ARGS naming the offender. Returns `{ ok, removed: dataTypes, since, origins }`. Added `browsingData` to manifest permissions. Wired through the eager dispatcher. New tests at `tests/tools/browser/clear-browsing-data.test.ts` (12 cases) including the unknown-key rejection and full-dataTypes round-trip. Extension: 1036/1036 (was 1024 + 12 new); bridge: 77/77; typecheck clean.
- **Branch**: feat/imp-0081-clear-browsing-data

### IMP-0080 · Add chrome_alarms tool — schedule one-shot or repeating callbacks (feat) · score: 4

- **Status**: done
- **Completed**: 2026-05-09
- **Summary**: New `chrome_alarms` MCP tool wrapping `chrome.alarms.{create,clear,clearAll,get,getAll}`. Action enum: `create | clear | clear_all | get | get_all`. `create` takes `{ name, when?, delayInMinutes?, periodInMinutes? }` (requires at least one of `when` or `delayInMinutes`); `periodInMinutes` makes it a repeating alarm. Each alarm fire broadcasts `{type:"alarm_fired", name, scheduledTime}` via `chrome.runtime.sendMessage` so flows polling for it can correlate (same shape as chrome_context_menu's onClicked bridge). The `onAlarm` listener installs exactly once at first call (idempotent guard via module-scoped flag). Error classification: missing chrome.alarms → UNKNOWN, missing/invalid args → INVALID_ARGS naming the field. The `alarms` permission was already in the manifest. Wired through the eager dispatcher. New tests at `tests/tools/browser/alarms.test.ts` (14 cases) including the listener-installed-once invariant. Extension: 1024/1024 (was 1010 + 14 new); bridge: 77/77; typecheck clean.
- **Branch**: feat/imp-0080-alarms

### IMP-0079 · Add chrome_idle tool — query user idle state (feat) · score: 3

- **Status**: done
- **Completed**: 2026-05-09
- **Summary**: New `chrome_idle` MCP tool wrapping `chrome.idle.queryState`. Single tool, no action enum. Params: `{ detectionIntervalSec? }` (default 60, range [15, 14400] per Chrome). Returns `{ state: 'active' | 'idle' | 'locked', detectionIntervalSec }`. Pair with the pacing throttle to back off intrusive operations while the user is at the keyboard, or skip a screenshot when the system is locked. Added `idle` to manifest permissions. Error classification: missing `chrome.idle` API → UNKNOWN, out-of-range interval → INVALID_ARGS naming the offending field. `mutates = false`. Wired through the eager dispatcher. New tests at `tests/tools/browser/idle.test.ts` (8 cases). Extension: 1010/1010 (was 1002 + 8 new); bridge: 77/77; typecheck clean.
- **Branch**: feat/imp-0079-idle

### IMP-0078 · Add chrome_web_vitals tool — Core Web Vitals via PerformanceObserver (feat) · score: 5

- **Status**: done
- **Completed**: 2026-05-09
- **Summary**: New `chrome_web_vitals` MCP tool that wraps a MAIN-world `PerformanceObserver` shim (installed idempotently on `window.__hcWebVitals`) to deliver the standard six Core Web Vitals: LCP (most recent `largest-contentful-paint`), CLS (sum of non-input `layout-shift` entries), INP (max `event` entry duration with `durationThreshold:40`), FCP (`paint` entry filtered for `first-contentful-paint`), FID (one-shot `first-input` `processingStart - startTime`), TTFB (navigation `responseStart - startTime`). Different shape from `chrome_performance_*` (those record full DevTools traces — heavy, post-hoc); this is "what does the user actually feel" measurement, live and cheap. Action enum: `start` (idempotent observer install; optional `reload: true` reloads the tab first so cold-start LCP/FCP/TTFB get captured), `snapshot` (read current values without disturbing), `stop` (read + disconnect observers + clear the global). Returns `{ lcpMs, clsScore, inpMs, fcpMs, ttfbMs, fidMs, installed }` with `null` for any metric not yet observed. Each `safeObserve` swallows individual entry-type rejections so older Chromium builds still get partial vitals (whatever the build supports). Error mapping: TAB_CLOSED for `/no tab with id/i`, INVALID_ARGS for unknown action, TAB_NOT_FOUND when no active tab, UNKNOWN otherwise. Wired through the eager dispatcher; no new manifest permissions. New tests at `tests/tools/browser/web-vitals.test.ts` (13 cases). Extension: 1002/1002 (was 989 + 13 new); bridge: 77/77; typecheck clean.
- **Branch**: feat/imp-0078-web-vitals

### IMP-0077 · Add chrome_window tool — create / focus / update / close windows (feat) · score: 4

- **Status**: done
- **Completed**: 2026-05-09
- **Summary**: New `chrome_window` MCP tool wrapping `chrome.windows.{create,update,remove}` so agents can spawn an isolated incognito/popup window for a sandboxed flow, bring a window to front before a screenshot, or close one as cleanup. Single tool with action enum: `create` (`url?, type=normal|popup|panel, incognito, focused, state=normal|minimized|maximized|fullscreen, left/top/width/height`), `focus` (calls `update({focused:true})`), `update` (generic update — needs at least one of focused/state/left/top/width/height), `close` (`chrome.windows.remove`). Returns the resulting Window via a `serializeWindow()` helper as `{id, type, state, focused, incognito, top, left, width, height, tabsCount}`. Tool file at `window-manage.ts` (distinct from the existing `window.ts` which holds tab-window scoping helpers — those are unchanged). Error classification: TAB_CLOSED for `/no tab with id/i`, "No window with id" → INVALID_ARGS with the windowId, INVALID_ARGS for missing/empty fields, UNKNOWN otherwise. Wired through the eager dispatcher; no new manifest permissions. New tests at `tests/tools/browser/window-manage.test.ts` (14 cases). Extension: 989/989 (was 975 + 14 new); bridge: 77/77; typecheck clean.
- **Branch**: feat/imp-0077-window

### IMP-0076 · Add chrome_select_text tool — select text by range or substring (feat) · score: 4

- **Status**: done
- **Completed**: 2026-05-09
- **Summary**: New `chrome_select_text` MCP tool that takes `{ selector | ref }` plus either a `substring` or `start`+`end` character offsets, and ends with a real DOM Selection or `input.setSelectionRange()`. The ISOLATED-world shim resolves the element (input/textarea → `setSelectionRange`; everything else → walk text nodes via `TreeWalker(SHOW_TEXT)`, build a `Range`, apply via `window.getSelection().addRange`). Returns `{ start, end, selected, mode: 'input-range' | 'dom-range', tagName, resolution }`. Error mapping: TAB_CLOSED for `/no tab with id/i`, INVALID_ARGS for missing/conflicting `selector|ref` and `substring|start+end`, plus a specific INVALID_ARGS classification for "substring not found" so callers can branch without re-raising; UNKNOWN otherwise. Wired through the eager dispatcher; no new manifest permissions. New tests at `tests/tools/browser/select-text.test.ts` (16 cases). Extension: 975/975 (was 959 + 16 new); bridge: 77/77; typecheck clean.
- **Branch**: feat/imp-0076-select-text

### IMP-0075 · Add chrome_paste tool — focus + paste into an element (feat) · score: 5

- **Status**: done
- **Completed**: 2026-05-09
- **Summary**: New `chrome_paste` MCP tool that wires up the missing `chrome_clipboard.write → chrome_focus → keyboard Ctrl+V` chain into one call. If `text` is supplied, the tool seeds the clipboard via a co-located `writeClipboardFromBackground` helper (uses the same offscreen `clipboard.write` plumbing as `chrome_clipboard` without re-entering the dispatcher), then injects an ISOLATED-world shim that focuses the target (resolved by `selector` or `ref` against `__claudeElementMap`), dispatches a synthetic `ClipboardEvent('paste')` carrying a `text/plain` `DataTransfer`, AND falls back to `document.execCommand('insertText', false, text)` so pages that ignore paste events still receive the value. Returns `{ focused, pasted, mode: 'event' | 'execCommand' | 'both' }`. Without `text`, the page sees whatever the OS clipboard currently holds. Error mapping: TAB_CLOSED for `/no tab with id/i`, INVALID_ARGS for missing/conflicting selector|ref, TAB_NOT_FOUND when no active tab. Wired through the eager dispatcher; no new manifest permissions. New tests at `tests/tools/browser/paste.test.ts` (14 cases). Extension: 959/959 (was 945 + 14 new); bridge: 77/77; typecheck clean.
- **Branch**: feat/imp-0075-paste

### IMP-0074 · Add chrome_focus tool — focus an element programmatically (feat) · score: 5

- **Status**: done
- **Completed**: 2026-05-09
- **Summary**: New `chrome_focus` MCP tool that resolves a target by `selector` or `ref` (mutually exclusive — exactly one required) and calls `el.focus({ preventScroll: false })`. The ISOLATED-world shim looks refs up against `window.__claudeElementMap` (populated by `chrome_read_page`/`chrome_await_element`'s injected helpers) via the existing WeakRef contract, then reports `focused: document.activeElement === el` so callers can detect "element exists but doesn't accept focus" cases (disabled inputs, hidden tabindex=-1 elements). Error classification: `TAB_CLOSED` for `/no tab with id/i`, `INVALID_ARGS` for missing/conflicting selector|ref, `TAB_NOT_FOUND` when no active tab, `UNKNOWN` otherwise. Wired through the eager dispatcher; no new manifest permissions. New tests at `tests/tools/browser/focus.test.ts` (13 cases) cover both resolution paths, focused:true vs focused:false, frame scoping, the no-result-from-shim branch, and each error classification. Extension: 945/945 (was 932 + 13 new); bridge: 77/77; typecheck clean.
- **Branch**: feat/imp-0074-focus

### IMP-0064 · Add chrome_notifications tool — native OS notifications (feat) · score: 5

- **Status**: done
- **Completed**: 2026-05-09
- **Summary**: Wraps `chrome.notifications.{create,clear,getAll}` so a long-running agent can push native OS pings ("session done", "captcha needs attention"). Actions: `create` (returns `{notificationId}`), `clear` (by id), `clear_all`, `get_all`. `buttons[]` is capped to 2; default icon resolves to the extension icon via `chrome.runtime.getURL('icon/128.png')`. Added `notifications` to manifest permissions. 9 tests cover validation, default-icon fallback, button capping, and bulk clear.
- **Branch**: feat/imp-bulk-tools

### IMP-0065 · Add chrome_clipboard tool — read/write system clipboard (feat) · score: 5

- **Status**: done
- **Completed**: 2026-05-09
- **Summary**: Plain-text clipboard read/write via the offscreen document (only DOM context where `navigator.clipboard.{readText,writeText}` works from a service-worker extension). Actions: `read`, `write`. The offscreen doc gains `CLIPBOARD` as a co-reason alongside the existing `WORKERS` so the existing similarity worker isn't disturbed (Chrome only allows one offscreen doc per extension). Two early-return branches added to `offscreen/main.ts` for `clipboard.read` / `clipboard.write` message types. 8 tests.
- **Branch**: feat/imp-bulk-tools

### IMP-0066 · Add chrome_sessions tool — list & restore recently-closed tabs/windows (feat) · score: 4

- **Status**: done
- **Completed**: 2026-05-09
- **Summary**: Wraps `chrome.sessions.{getRecentlyClosed,restore}` so an agent can un-close a tab it killed by mistake. Actions: `get_recently_closed` (returns up to 25, capped server-side), `restore` (by `sessionId`, or omit to restore the most recent closure). Added `sessions` to manifest permissions. Serializes both tab and window entries (windows include their `tabs[]`). 8 tests.
- **Branch**: feat/imp-bulk-tools

### IMP-0067 · Add chrome_tab_lifecycle tool — discard / mute / autoDiscardable (feat) · score: 4

- **Status**: done
- **Completed**: 2026-05-09
- **Summary**: Memory and audio controls on tabs. Actions: `discard` (free in-memory state via `chrome.tabs.discard`), `mute`/`unmute` (via `chrome.tabs.update({muted})`), `set_auto_discardable` (pin a tab so Chrome's memory-pressure heuristics leave it alone). Returns the updated tab's `{id, url, mutedInfo, discarded, autoDiscardable}`. "No tab with id" classified as `TAB_CLOSED`. 9 tests.
- **Branch**: feat/imp-bulk-tools

### IMP-0068 · Add chrome_network_emulate tool — Network.emulateNetworkConditions (feat) · score: 5

- **Status**: done
- **Completed**: 2026-05-09
- **Summary**: Emulate network conditions on a tab via the existing `debugger` permission. Actions: `set` (offline | latencyMs | downloadKbps | uploadKbps; throughput converted to CDP's bytes/sec via the kbps→bytes/sec factor `1024/8`), `reset` (restore defaults and detach). Idempotently handles "Another debugger is already attached". On error, best-effort detach so a stale attach doesn't block DevTools. 9 tests.
- **Branch**: feat/imp-bulk-tools

### IMP-0069 · Add chrome_print_to_pdf tool — Page.printToPDF (feat) · score: 5

- **Status**: done
- **Completed**: 2026-05-09
- **Summary**: Save a tab as PDF via CDP's `Page.printToPDF`. Returns base64 by default; when `savePath` is supplied the bridge's `file_operation` `saveToPath` action writes to disk and the response returns `{path, bytes}`. Standard formatting options exposed (`landscape`, `printBackground`, `scale`, paper / margin sizes in inches, `pageRanges`). Auto-attaches the debugger and detaches on the way out (skips detach when an existing CDP consumer was already attached, so the caller's state is preserved). 8 tests.
- **Branch**: feat/imp-bulk-tools

### IMP-0070 · Add chrome_block_or_redirect tool — declarativeNetRequest session rules (feat) · score: 5

- **Status**: done
- **Completed**: 2026-05-09
- **Summary**: Runtime URL block / redirect via `chrome.declarativeNetRequest.updateSessionRules` (session-scoped, no manifest declaration, cleared on Chrome restart). Actions: `add` (urlFilter + ruleAction = block | redirect; auto-assigns the next free ruleId; optional `resourceTypes` filter), `remove` (by ruleId), `list`, `clear`. Lets an agent mock APIs during a flow, block trackers for a session, or simulate a 404 on a specific URL. Added `declarativeNetRequestWithHostAccess` to manifest permissions (host_permissions are honored). 14 tests including auto-id increment.
- **Branch**: feat/imp-bulk-tools

### IMP-0071 · Add chrome_action_badge tool — extension icon badge text + color (feat) · score: 3

- **Status**: done
- **Completed**: 2026-05-09
- **Summary**: Show a small badge on the extension icon for live status during long runs. Actions: `set` (text, optional `#RRGGBB` / `#RRGGBBAA` color, optional per-tab scope), `clear`. Hex parsing returns `[r,g,b,a]` in 0..255 (alpha defaults to 255 when 6-digit hex is supplied). No new permissions. 10 tests.
- **Branch**: feat/imp-bulk-tools

### IMP-0072 · Add chrome_keep_awake tool — power.requestKeepAwake (feat) · score: 3

- **Status**: done
- **Completed**: 2026-05-09
- **Summary**: Prevent the system from sleeping during long agent runs. Actions: `enable` (`level` = `display` blocks screen sleep too, `system` lets the screen sleep but keeps the OS active), `disable`. Idempotent — repeated `enable` calls just refresh the existing lock. Released when the extension reloads. Added `power` to manifest permissions. 7 tests.
- **Branch**: feat/imp-bulk-tools

### IMP-0073 · Add chrome_context_menu tool — register transient right-click items (feat) · score: 4

- **Status**: done
- **Completed**: 2026-05-09
- **Summary**: Register transient right-click menu items via `chrome.contextMenus`. Actions: `add` (auto-generates `humanchrome-cm-<ts>` id when none supplied; default contexts `["page"]`), `update`, `remove`, `remove_all`. The tool installs a one-time `onClicked` listener that broadcasts `{type:'context_menu_clicked', menuItemId, info, tab}` over `chrome.runtime.sendMessage` so flows can correlate clicks. The `contextMenus` permission was already in the manifest. 12 tests.
- **Branch**: feat/imp-bulk-tools

### IMP-0063 · Add chrome_tab_groups tool — Chrome tab-group management (feat) · score: 5

- **Status**: done
- **Completed**: 2026-05-09
- **Summary**: New consolidated tool wrapping `chrome.tabs.group` / `chrome.tabs.ungroup` / `chrome.tabGroups.*`. Single tool with an `action` enum — `create`, `update`, `query`, `get`, `add_tabs`, `remove_tabs`, `move` — same dispatch shape as `chrome_storage` and `chrome_network_capture`. Lets agents partition their managed tabs into a labelled, colored group in the tab strip (e.g. one group per session run) so the user can always tell which tabs belong to which agent. Color palette pinned to Chrome's fixed 9 (grey/blue/red/yellow/green/pink/purple/cyan/orange) via input-schema enum. Added `tabGroups` to manifest permissions in `wxt.config.ts`. Tool is `mutates = true` so it serializes through the per-tab lock and honors the pacing throttle. Error classification: `No group with id` → not-found error, `No tab with id` → `TAB_CLOSED`, plus undefined-return guards on `chrome.tabGroups.update` / `.move` for the concurrent-delete window. New `tests/tools/browser/tab-groups.test.ts` (24 tests) covers each action, every input-validation branch, the missing-permission path, and both error classifications. Extension: 838/838 (was 814 + 24 new), typecheck clean.
- **Branch**: feat/imp-tab-groups

### IMP-0056 · Lazy-load heavy tool handlers (perf) · score: 4

- **Status**: done
- **Completed**: 2026-05-08
- **Summary**: Rebuilt `app/chrome-extension/entrypoints/background/tools/index.ts` to drop the `import * as browserTools from './browser'` star-import that was forcing every tool file to evaluate at SW boot. Light tools (the ~30 small ones called every session) stay eager via explicit named imports — keeps the dispatcher fast on the common paths. The 14 heavy tools that the audit flagged go through a `Record<string, () => Promise<ToolInstance>>` lazy registry: `chrome_screenshot`, `chrome_search_tabs_content`, `chrome_request_element_selection`, `chrome_network_debugger_start`/`_stop`, `chrome_intercept_response`, `chrome_javascript`, `chrome_read_page`, `chrome_computer`, `chrome_userscript`, `chrome_performance_start_trace`/`_stop_trace`/`_analyze_insight`, `chrome_gif_recorder`. Each entry is one line — `async () => (await import('./browser/<file>')).<exportName>`. First call resolves and memoizes via `lazyResolved` Map; concurrent first calls collapse onto a `lazyInflight` Promise. Heavy tools that previously dragged ~80–120 KB of code (gif-encoding chain ~2.6k LoC, computer.ts 1478 LoC, network-capture-debugger 1035 LoC, vector-database 1557 LoC + hnswlib WASM, etc.) now only land in the SW chunk when they're actually used. The `./browser/index.ts` barrel is left in place for any future caller; the dispatcher just doesn't use it. Test-only `_resetLazyToolCacheForTest()` and `_listRegisteredToolNamesForTest()` exports support the new test suite. New `tests/tools/lazy-tool-registry.test.ts` (8 tests): coverage guard (every TOOL_NAMES.BROWSER + TOOL_NAMES.RECORD_REPLAY entry has a registered handler — no orphans), source-shape guards (every flagged heavy tool is wired through the lazy half AND the dispatcher does NOT statically import any heavy module — caught a regression early via test 8), runtime memoization (handleCallTool routes a heavy tool through the dynamic loader, the spy fires, second call hits the memo), unknown-tool returns INVALID_ARGS. Extension: 702/702 (was 694, +8 from the new suite), typecheck clean.
- **Branch**: perf/imp-0056-lazy-tool-registry

### IMP-0059 · Make logger persistence opt-in (perf) · score: 4

- **Status**: done
- **Completed**: 2026-05-08
- **Summary**: Combined fix-sketch options (a) and (b). Added a `persistEnabled` flag to `app/chrome-extension/utils/logger.ts` (default **off**), persisted under `humanchrome:logPersistEnabled` so the choice survives SW restart. When off, `schedulePersist` short-circuits before queuing the 5 MB chrome.storage.local.set — eliminating the dominant steady-state SW CPU cost during automation runs (was ~240 writes/min, now zero). When on, the debounce was bumped from 250 ms to 5 s so a hot stream coalesces into ~12 writes/min instead of 240. Toggle via the new exported `setPersistEnabled(boolean)` / `getPersistEnabled()` or via `chrome_debug_dump({ persist: true|false })` (new arg, response always echoes `persistEnabled`). on→off drops the persisted blob so the next SW boot starts clean; off→on schedules a debounced flush so the in-memory backlog gets persisted. Buffer-restore on SW restart is gated on the flag too — old persisted blobs from a previous "on" session are not resurrected after the user turns persistence off. New `tests/utils/logger-persist-opt-in.test.ts` (7 tests, uses `vi.resetModules()` per test for clean module-scoped state and a fake `chrome.storage.local` whose set/remove/get are spied): default-off zero-write hot stream, in-memory dumpLog still works with persistence off, on→off drops blob and prevents further writes, off→on schedules a flush, 50-event burst within 5 s coalesces into ONE write, SW-restart-with-persistence-off does not resurrect old logs, SW-restart-with-persistence-on does. `chrome_debug_dump` schema gained the `persist` arg; `docs/TOOLS.md` regenerated. Extension: 701/701, typecheck clean. Bridge `tool-categories-coverage` 3/3.
- **Branch**: perf/imp-0059-logger-persist

### IMP-0050 · Add chrome_close_tabs_matching tool (feat) · score: 4

- **Status**: done
- **Completed**: 2026-05-08
- **Summary**: New `chrome_close_tabs_matching` MCP tool for bulk post-`chrome_navigate_batch` cleanup. Filters: `urlMatches` (case-insensitive substring or `/regex/flags`), `titleMatches` (same matching rules), `olderThanMs` (matches tabs whose recorded creation timestamp is older than N ms — tabs without a recorded creation time are NOT matched, documented). Filters AND together. `exceptTabIds` always preserves the listed tabs. `windowId` scopes the search. `dryRun: true` returns matches without closing — useful pre-flight. Refuses calls with no filter set (no implicit close-everything). Honors the IMP-0062 last-tab guard via `safeRemoveTabs`, so closing every tab in a window opens a placeholder first. Bad regex falls back to substring match against the **inner** pattern (slashes stripped) — better matches user intent than literally searching for `/pattern/`. Returns `{ ok, closed, scanned, matched, tabIds }`. New `utils/tab-creation-tracker.ts` (~40 LoC) listens to `chrome.tabs.onCreated` / `onRemoved` so `olderThanMs` has a creation timestamp to compare against; wired in the background entrypoint via `initTabCreationTracker()` next to `initLastTabGuardListeners()`. New `tests/tools/browser/close-tabs-matching.test.ts` (14 tests): empty-filter rejection, blank-string rejection, substring URL match, AND-combined url+title, regex form, malformed-regex fallback to inner-pattern substring, olderThanMs cutoff, untracked-tab non-match, exceptTabIds preservation, windowId scoping, dryRun no-mutation, empty-match no-call, query rejection, safeRemoveTabs rejection. The `safeRemoveTabs` helper is mocked at the module level so tests assert it was invoked with the right ids without spinning up the real placeholder dance. Extension: 708/708, typecheck clean. Tool count 47→48 on this branch; `docs/TOOLS.md` regenerated; bridge `tool-categories-coverage` 3/3.
- **Branch**: feat/imp-0050-close-tabs-matching

### IMP-0047 · Add chrome_storage tool for localStorage / sessionStorage (feat) · score: 4

- **Status**: done
- **Completed**: 2026-05-08
- **Summary**: New `chrome_storage` MCP tool wraps a MAIN-world `chrome.scripting.executeScript` shim that reads/writes a tab's `window.localStorage` or `window.sessionStorage` so prompts no longer need to embed JS into `chrome_javascript`. Five actions: `get` → `{value, exists}`; `set` (string only — wrap structured data via JSON.stringify) → `{stored:true}`; `remove` → `{removed:boolean}`; `clear` → `{cleared:count}`; `keys` → `{keys:string[]}`. `scope` defaults to `local`. `tabId` / `windowId` / `frameId` route the call (frameId is forwarded as `target.frameIds`). The shim returns a discriminated union — Safari-private-mode-style `QuotaExceededError`, sandboxed iframe blocks, etc. surface as a structured error rather than throwing across the bridge. Distinct error classification: tab-gone-mid-call → `TAB_CLOSED`, frame mismatch → `INVALID_ARGS`, missing active tab → `TAB_NOT_FOUND`. IndexedDB intentionally out of scope; cookies handled by `chrome_get_cookies` / `chrome_set_cookie` / `chrome_remove_cookie`. New `tests/tools/browser/storage.test.ts` (21 tests) drives the real shim against a `FakeStorage` that implements the `Storage` interface, exercising all 5 actions, scope routing, frame routing, every validation guard, and error classification. Extension: 715/715, typecheck clean. Tool count 47→48 on this branch; `docs/TOOLS.md` regenerated; bridge `tool-categories-coverage` 3/3.
- **Branch**: feat/imp-0047-chrome-storage

### IMP-0044 · Add chrome_list_frames tool (feat) · score: 4

- **Status**: done
- **Completed**: 2026-05-08
- **Summary**: New `chrome_list_frames` MCP tool wraps `chrome.webNavigation.getAllFrames` to return one entry per frame as `{ frameId, parentFrameId, url, errorOccurred }`, with the main document at `frameId: 0` / `parentFrameId: -1`. Optional `urlContains` (case-insensitive substring) filter narrows results without an extra round-trip. Sort is stable: parent frames before children, then by `frameId`. Read-only, no DOM access. **No manifest change** — `webNavigation` was already declared in `wxt.config.ts` for the navigation guards in `base-browser`. Distinct error classification: tab-gone-mid-call surfaces as `TAB_CLOSED`; null result (discarded tab) returns an empty list rather than an error so callers can retry after activating; missing active tab returns `TAB_NOT_FOUND`. New `tests/tools/browser/list-frames.test.ts` (9 tests): explicit-tabId forwarding, active-tab fallback, `windowId` routing, parent/frameId sort, urlContains filter with `totalBeforeFilter` reporting, null result → empty, `no tab with id` → `TAB_CLOSED`, generic rejection → `UNKNOWN`, missing active tab → `TAB_NOT_FOUND`. Extension: 703/703, typecheck clean. Tool count 47→48 on this branch; `docs/TOOLS.md` regenerated; bridge `tool-categories-coverage` 3/3.
- **Branch**: feat/imp-0044-list-frames

### IMP-0041 · Add chrome_list_injected_scripts tool (feat) · score: 4

- **Status**: done
- **Completed**: 2026-05-08
- **Summary**: New `chrome_list_injected_scripts` MCP tool returns one entry per injected tab as `{tabId, world, scriptLength, injectedAt}` so agents can do idempotent inject-once patterns and pre-flight checks before `chrome_send_command_to_inject_script`. Pure read of the existing `injectedTabs` Map in `app/chrome-extension/.../inject-script.ts`; the Map's value type was extended from `ScriptConfig` to `InjectedTabEntry` (adding `injectedAt: number`) so the timestamp is captured at inject time. Optional `tabId` param filters to a single tab. Zero new permissions, zero new infrastructure. New `tests/tools/browser/list-injected-scripts.test.ts` (7 tests) drives the inject pipeline through the public API and covers: empty case, multi-tab listing, deterministic tabId-sorted order, single-tab filter, filter-miss empty case, re-injection replaces the entry and bumps `injectedAt`, and a no-mutation guard (verifies the list call doesn't touch chrome.scripting/tabs.update/sendMessage). Extension: 701/701, typecheck + lint clean. Tool count 47→48; `docs/TOOLS.md` regenerated; bridge `tool-categories-coverage` 3/3.
- **Branch**: feat/imp-0041-list-injected-scripts

### IMP-0032 · Strip verbose debug logging from vector-database.ts hot path (perf) · score: 4

- **Status**: done
- **Completed**: 2026-05-08
- **Summary**: Routed all 89 informational `console.log` sites in `app/chrome-extension/utils/vector-database.ts` (1557 LoC, hit on every embedding lookup) through a module-level `dlog()` helper that's a no-op when `const DEBUG = false`. Bundlers can DCE the call sites; flipping DEBUG to true brings the trace back. The unconditional `EmscriptenFileSystemManager.setDebugLogs(true)` was changed to `setDebugLogs(DEBUG)` so it mirrors the same flag — no more WASM FS noise on every embedding lookup. The 38 `console.warn` and 31 `console.error` sites stay direct so real warnings/errors aren't muffled. New `tests/utils/vector-database-debug-logging.test.ts` (6 tests) acts as a regression guard via static analysis (DEBUG=false declaration, ≤1 direct console.log site, setDebugLogs(DEBUG) not setDebugLogs(true), ≥20 console.warn / ≥20 console.error preserved, dlog ternary on DEBUG with a no-op false branch) plus a runtime check that module import emits zero console.log. Extension: 700/700, typecheck clean. No tool-schema changes.
- **Branch**: perf/imp-0032-vector-db-debug-logging

### IMP-0048 + IMP-0051 · chrome*performance*\* pre-condition errors now return isError:true (bug bundle) · score: 4

- **Status**: done
- **Completed**: 2026-05-08
- **Summary**: Both bugs share the same root cause — the performance tool family was returning `{ isError: false, content: [{ text: "Error: ..." }] }` on pre-condition failures, so agents branching on `isError` treated the failure as success. Fixed in `app/chrome-extension/entrypoints/background/tools/browser/performance.ts`: `start_trace` (line 164) when a session is already recording, and `analyze_insight` (line 361) when LAST_RESULTS has no entry — both now route through `createErrorResponse(..., ToolErrorCode.UNKNOWN, { tabId })`. The "stop with no session" case at line 263 is intentionally **not** changed (IMP-0048 notes flagged it as a debatable idempotent no-op); a regression test pins the existing tolerant behavior so a future cleanup doesn't widen the fix beyond review. New `tests/tools/browser/performance.test.ts` (7 tests, uses `vi.resetModules()` per test for clean module-scoped state and synthesizes `chrome.debugger.onEvent` to drive the full trace lifecycle) covers: start happy path; IMP-0048 second-start; analyze IMP-0051; TAB_NOT_FOUND on both; stop's preserved no-session behavior; full start→stop→analyze round-trip. Extension: 701/701, typecheck clean. No tool-schema changes.
- **Branch**: fix/imp-0048-0051-performance-iserror

### IMP-0028 · Add flush action to chrome_network_capture for mid-session drain without stopping (feat) · score: 4

- **Status**: done
- **Completed**: 2026-05-08
- **Summary**: Added `action: "flush"` to the unified `chrome_network_capture` tool. Both backends now expose `flushCapture(tabId)` that snapshots the current request buffer in the same envelope shape `stop` produces (with `flushed: true`, `stillActive: true`, `flushedAt`, and `previousFlushAt` for stitching multiple drains), then clears `captureInfo.requests`, `requestCounters`, and `limitReached` while leaving listeners, timers, and the CDP session intact. `lastActivityTime` is bumped so the inactivity watchdog doesn't fire as a side-effect of the drain pause; the MAX_REQUESTS cap also resets per flush so long sessions don't stay stuck at the cap. `stopCapture` on both backends was refactored to share a private `buildResultData()` helper with `flushCapture` — keeps the envelope shapes in lockstep. New `tests/tools/browser/network-capture-flush.test.ts` (20 tests) covers each backend's flush, the unified routing (web-only, debugger-only, needResponseBody preference, fallback, multi-tab drain, active-tab preference), the no-active-capture and unknown-action error paths, the post-flush stop-without-double-counting invariant, and a stop-envelope regression check on both backends. Extension: 714/714, typecheck + lint clean.
- **Branch**: feat/imp-0028-network-capture-flush

### IMP-0027 · Add chrome_history_delete tool to remove history entries by URL or time range (feat) · score: 4

- **Status**: done
- **Completed**: 2026-05-08
- **Summary**: New `chrome_history_delete` MCP tool wraps `chrome.history.deleteUrl` / `deleteRange` / `deleteAll`. Single mutually-exclusive mode per call: `url`, `startTime`+`endTime` (reuses existing relative/keyword date parsing), or `all: true` gated behind `confirmDeleteAll: true` as a wipe-all safety check. `parseDateString` and `formatDate` were promoted from `HistoryTool` private methods to module-scope helpers so both classes share them. New `tests/tools/browser/history-delete.test.ts` (10 tests covering each mode, missing-mode, multi-mode, partial range, malformed dates, inverted range, missing-confirm, and chrome rejection passthrough). No manifest change — `history` permission already declared. Auto-generated `docs/TOOLS.md` regenerated. Extension: 704/704, typecheck + lint clean.
- **Branch**: feat/imp-0027-history-delete

### IMP-0055 · Split model-cache helpers out of semantic-similarity-engine.ts so the service worker stops inlining @huggingface/transformers and onnxruntime-web (perf) · score: 6

- **Status**: done
- **Completed**: 2026-05-08
- **Summary**: Extracted `cleanupModelCache` and `hasAnyModelCache` to a new `app/chrome-extension/utils/model-cache-status.ts` (40 lines, IndexedDB only — no transformers/onnxruntime/SIMDMathEngine reach). Repointed the SW imports at `entrypoints/background/index.ts` and `entrypoints/background/semantic-similarity.ts`. Kept a back-compat re-export from `semantic-similarity-engine.ts` so popup imports still work. Load-bearing prerequisite for IMP-0057's actual win.
- **Worktree**: /Users/mike/Documents/Code/humanchrome/.claude/worktrees/agent-abf1cc03caa7065e5 · branch worktree-agent-abf1cc03caa7065e5

### IMP-0057 · Defer vector-search dependency chain so vector-database.ts and hnswlib-wasm-static stop landing in the service worker (perf) · score: 4

- **Status**: done
- **Completed**: 2026-05-08
- **Summary**: Lazy-loaded `ContentIndexer` in `tools/browser/vector-search.ts` via memoized `getIndexer()` async helper that does `await import('@/utils/content-indexer')` on first use. Plus the load-bearing flip of `defineBackground` to `{ type: 'module', main: ... }` so WXT compiles the SW as ESM (Chrome 91+ supports module SWs natively) — without this, IIFE bundling silently inlines every `await import(...)`. Combined with IMP-0055, **background.js dropped from 2168 KB to 612 KB (−72%)**; total dist 6.95 MB → 6.16 MB. Bridge 69/69, extension 694/694, build green.
- **Worktree**: /Users/mike/Documents/Code/humanchrome/.claude/worktrees/agent-abf1cc03caa7065e5 · branch worktree-agent-abf1cc03caa7065e5

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
