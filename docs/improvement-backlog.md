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

### IMP-0163 · CI e2e-fixture matrix — bridge crashes on bind under macos-latest runner (bug) · score: 7

- **Proposed by**: claude · 2026-05-24 (follow-up to IMP-0162 — partial fix unblocked local but not CI)
- **Status**: proposed
- **Why**: IMP-0162 fixed two harness bugs in `scripts/run-e2e-matrix.mjs` (30s SW handshake timeout, missing fixture server). Local `pnpm e2e:isolated` now reliably reports 16/16 PASS in ~3 minutes. CI's matrix job remains red on a third, separate failure: the bridge spawns via Chrome's native messaging child but exits within ~50ms, so no `~/Library/Application Support/humanchrome-bridge/e2e-registry/instances/<pid>.json` file is ever written and `findSpawnedBridge` times out at 180s. The matrix has been failing on every PR since 2026-05-19 with this exact shape. Workflow: CI's `e2e-fixture.yml` installs CFT via `@puppeteer/browsers install chrome@stable`, runs `humanchrome-bridge register`, then `pnpm e2e:matrix --launch-chrome`. Chrome boots fine (SW logs `[OffscreenKeepalive] acquire(native-host)` within ~2s), but each NM connection drops immediately with `[humanchrome] Native connection disconnected`. The SW retries with exponential backoff but the bridge never stays alive long enough to write its registry entry.
- **Cost**: M
- **Value**: M
- **Repro**: Push any change touching `app/chrome-extension/` to a PR. The `e2e-fixture` workflow's `matrix` job will hit "spawned Chrome did not register a bridge within 180s" (with the IMP-0162 amend in place) after ~3 minutes.
- **Fix sketch**: Investigate why the NM-spawned bridge exits immediately on CI's macos-latest runner. Candidates: (a) `run_host.sh` path resolution — `cli.js register` writes a manifest pointing at the runner's installed `dist/run_host.sh`, but the bridge child may resolve paths differently from a CI shell; (b) Code-signing / Gatekeeper restrictions on @puppeteer/browsers CFT preventing the NM child from execve'ing the bridge cleanly; (c) Env var propagation — `HC_INSTANCE_REGISTRY_DIR` and `HC_BRIDGE_DAEMON_SOCKET` are set in `spawn()` env when launching Chrome, but Chrome may not forward them to NM child processes the same way locally vs CI; (d) FD limits — bridge daemon UDS bind fails silently in CI's constrained env. Add `console.error` instrumentation to the bridge's startup path (pre-registry-write) and chrome.runtime.onConnect.onDisconnect's `lastError` in the SW, so the next CI run dumps the actual reason. Once root cause known, the fix is likely a 1–2 line patch to the bridge or the manifest path.
- **Notes**: This is the third stacked failure mode in the matrix CI gate (after IMP-0139 NM-path and IMP-0162 timeout). Until fixed, the `e2e-fixture` job remains a red gate on every PR; humans have been merging through it. Doesn't block local matrix verification — `pnpm e2e:isolated` works correctly post-IMP-0162.

### IMP-0103 · Installed bridge is stale — IMP-0098/0100/0101/0102 surface rejected at MCP layer (bug) · score: 8

- **Proposed by**: bug-scout · 2026-05-16
- **Status**: done (2026-05-17; rebuilt+resynced bridge, matrix run at `docs/e2e-runs/2026-05-17_baseline.json` shows IMP-0100/0101/0102 rows all PASS)
- **Why**: The bridge installed at `~/Library/Application Support/humanchrome-bridge/` was last built at 2026-05-16 14:56 — ~6h before the local `packages/shared/dist/` (20:10) and the extension build (20:46). Its bundled `humanchrome-shared` still ships the pre-IMP-0098 enums, so every IMP-0098..0102 contract is rejected at the MCP boundary before reaching the (correctly-updated) extension. E2E verification per `docs/E2E-VERIFICATION.md` against `playwright-parity.html` could not exercise the new surface at all — see IMP-0098/0100/0101/0102 matrix rows.
- **Cost**: S
- **Value**: L

- **Repro**:
  - `selectorType: "role"` → `chrome_click_element` schema-rejected (enum allows only `css|xpath`); prefix form `role:button[name="Submit"]` round-trips to `document.querySelector(...)` and fails with DOMException — the SW resolver never sees `selectorKind` because the bridge's shared lib strips the new fields.
  - `chrome_handle_dialog({action:"register_default"})` → `INVALID_ARGS: action must be "accept" or "dismiss"`.
  - `chrome_wait_for({kind:"url"|"load_state"})` → `INVALID_ARGS: unknown kind: url`.
  - `chrome_locator_handler` not exposed via MCP at all (ToolSearch miss).
- **Fix sketch**: Re-run `pnpm --filter chrome-extension build` (already done) + rebuild `packages/shared` + `humanchrome-bridge register` (or whichever install script bumps `~/Library/Application Support/humanchrome-bridge/`). Add a startup version check that warns when bridge-bundled `humanchrome-shared` version ≠ workspace version. Document the reinstall step at the top of `docs/E2E-VERIFICATION.md` "Prerequisites".

### IMP-0139 · pnpm e2e:isolated — spawned Chrome never registers a bridge in 30s (harness regression) (bug) · score: 8

- **Proposed by**: claude-loop · 2026-05-19
- **Status**: done (2026-05-19; `scripts/run-e2e-matrix.mjs` now stages the NM manifest at every macOS user-level path Chrome actually scans — `~/Library/Application Support/Google/{Chrome,ChromeForTesting,Chrome for Testing}/NativeMessagingHosts/` — instead of only the profile-relative dir Chrome ignores on macOS. Also scrubs stale daemon UDS sockets before launch — an abandoned previous-run daemon would steal the socket, force the new bridge into relay mode, and skip the registry write, surfacing as the bogus 30s timeout. Verified by running with all CFT NM dirs deleted then full `pnpm e2e:isolated`: handshake now 2.6–4.1s, registry entry written within a few seconds. Added `--enable-logging --v=1` and a diagnostic dump (source manifest, staged-paths existence, recent chrome_debug.log NM lines, Chrome pid liveness) printed on the failure path so future regressions self-diagnose. Tool-timeout failures observed in the matrix (offscreen, unstable_bbox, occluded_by, disabled, aria-disabled, readonly, locator_handler) are a SEPARATE actionability regression — not part of this IMP; will be filed independently as a new IMP.)
- **Why**: Running `pnpm e2e:isolated` (the local matrix runner for hands-off E2E verification per CLAUDE.md "Never ask user to drive browser" rule) consistently fails with "spawned Chrome did not register a bridge within 30s." Chrome spawns (pid is logged) but the registry dir at ~/Library/Application Support/humanchrome-bridge/e2e-registry/instances stays empty. The NM manifest is staged at e2e-profile/NativeMessagingHosts/ — that may not be a path Chrome actually scans on macOS (Chrome reads NM manifests from ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/, not from a profile-specific path). Result: every chrome-extension PR opened by /improve-auto fails its mandatory E2E gate locally, even when the code change has nothing to do with the bridge handshake. Caught while running IMP-0137 verification in iteration 1 of the autonomous loop.
- **Cost**: M (NM manifest path investigation + e2e harness fix)
- **Value**: L (unblocks every chrome-extension PR's local E2E; restores the "never ask user to drive browser" guarantee for the autonomous loop)

- **Repro**: `cd app/chrome-extension && pnpm e2e:isolated` from a clean main → fails at `[e2e] spawned Chrome did not register a bridge within 30s` after Chrome pid is logged. Re-run produces identical failure.
- **Fix sketch**: Inspect `scripts/run-e2e-matrix.mjs` Chrome-launch path. NM manifest must be at `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.humanchrome.bridge.json` (system path) OR Chrome must be launched with `--user-data-dir` pointing at a profile whose `NativeMessagingHosts` subdirectory has the manifest (the latter requires Chrome to actually scan profile-relative paths, which I should verify is supported on macOS). Add a startup-trace flag (`--enable-logging --v=1`) to capture Chrome's NM-discovery output so future failures self-diagnose.
- **Notes**: GitHub Actions `e2e-fixture.yml` may still work because it uses a fresh runner; only local `pnpm e2e:isolated` is broken right now. CI gate continues to protect the merge.

### IMP-0112 · IMP-0098 role+name resolver returns empty for explicit role lookup (bug) · score: 7

- **Proposed by**: bug-scout · 2026-05-17 (matrix evidence)
- **Status**: done (fixed transitively by IMP-0104 acc-tree-helper injection; matrix evidence at `docs/e2e-runs/2026-05-17_baseline.json` plus post-IMP-0111b runs all show "role + name (Submit)" PASS)
- **Why**: `chrome_click_element({selectorType:'role', selector:'button[name="Submit"]'})` against a real `<button>Submit</button>` returns `INVALID_ARGS: Failed to resolve role selector: unknown error` with `details: {selectorType:'role', selector:'button[name=\"Submit\"]'}`. The resolver IS running (this is the `resolveSelectorToRef` error path, not click-helper's "not found"), but acc-tree-helper's `__hcResolveByKind('role', ...)` returns matchCount:0 even though the target element exists with explicit `role=button` (implicit via `<button>` tag) and `name="Submit"` (text content). Either the role match is too strict (e.g. requires explicit `role=button` attribute and ignores implicit ARIA roles for `<button>`) or the accessible-name computation isn't extracting text content.
- **Cost**: M
- **Value**: L
- **Repro**: `pnpm e2e:isolated` — "IMP-0098 role + name (Submit)" row fails. Full evidence in `docs/e2e-runs/2026-05-17_baseline.json`.
- **Fix sketch**: Trace `accessibility-tree-helper.js:929-967` (`resolveByKind` → `resolveByRoleJs`). Likely missing the implicit-role lookup for HTML5 button/link/input elements (Playwright's `getByRole` matches `<button>` against `role=button` without requiring the explicit attribute). May also need `computeAccessibleName_v2` to fall through to `textContent` when no `aria-label`/`aria-labelledby` set.

### IMP-0116 · strict-mode multi-match without index — matchCount predicate mismatch (bug) · score: 6

- **Proposed by**: bug-scout · 2026-05-17 (matrix evidence)
- **Status**: done (2026-05-17; click-helper + fill-helper re-query `querySelectorAll(selector)` in the strict-violation branch and report the true count instead of probe's short-circuit ceiling of 2.)
- **Why**: `chrome_click_element({selector:'.row-btn'})` against 3 matching elements correctly returns an `INVALID_ARGS` envelope, but the matrix runner's `details.matchCount` predicate doesn't match — investigation needed to see whether the envelope shape changed, matchCount is in `details.samples.length`, or the error surfaces via a different path (acc-tree-helper structured response vs click-helper's `__hcQuerySelectorUnique`).
- **Cost**: S
- **Value**: M

- **Repro**: `pnpm e2e:isolated` — "strict-mode multi-match without index" row fails with `expected matchCount:3, got {"content":[...{"error":{"code":"INVALID_ARGS"...`. Inspect the full error body and either fix the response shape or update the matrix predicate.

### IMP-0142 · chrome_set_extra_http_headers — per-tab header injection via CDP Network.setExtraHTTPHeaders (feat) · score: 6

- **Proposed by**: feature-scout · 2026-05-19
- **Status**: done (2026-05-24; merged in PR #256 — multi-action tool: set/get/clear/list_tabs, per-tab Map evicted on chrome.tabs.onRemoved, forbidden-headers rejected with details.header, CDP_BUSY classification)
- **Why**: Many adversarial workflows need to inject Authorization / X-Csrf-Token / custom session-bridge headers on EVERY request a tab makes (LinkedIn Voyager calls, internal company APIs behind corporate auth, mock-server impersonation in test runs). Today the only knobs are chrome_set_cookie (cookies only — no Bearer token surface), chrome_inject_script (have to monkey-patch fetch/XHR per-script — page CSP often blocks), and chrome_proxy (network-layer, can't alter headers). CDP Network.setExtraHTTPHeaders does exactly this in one call; we already have the debugger permission. No equivalent surface today.
- **Cost**: S
- **Value**: L
  5-file recipe. New `app/chrome-extension/entrypoints/background/tools/browser/extra-http-headers.ts`. Multi-action enum: `set` (params: `headers: Record<string,string>`, applied across the whole tab via CDP Network.enable + Network.setExtraHTTPHeaders), `get` (return current overrides recorded for this tab), `clear` (Network.setExtraHTTPHeaders with `{}` + drop the tab from the registry), `list_tabs` (which tabs currently have overrides — read-only). Per-tab state held in a module-scope `Map<tabId, Record<string,string>>` with `_resetForTest` seeder. Persistent across navigations within the tab (CDP guarantee) until clear or tab close. Wire through `cdpSessionManager` (already used by intercept-response / network-capture-debugger / dialog) so the attach is refcounted with owner-tag `extra-http-headers`. Cleanup on `chrome.tabs.onRemoved` + `CLIENT_DISCONNECTED` (mirror dialog defaults). Should reject forbidden headers per Chrome blocklist (Host, Content-Length, etc.) with INVALID_ARGS + details.header so callers know which line tripped it. Lazy register (CDP attach cost). Tests: arg validation, set+verify roundtrip, clear unwinds tab from map, two-tab independence, forbidden-header rejection, CDP_BUSY classification, cleanup on tab close. Pairs naturally with chrome_intercept_response (mocks) and chrome_emulate (IMP-0124 UA override) — three CDP-emulation primitives stacked.

### IMP-0150 · chrome_wait_for(kind:element, state:absent) returns found:true after element disappears (bug) · score: 6

- **Proposed by**: bug-scout · 2026-05-19
- **Status**: done (2026-05-24; merged in PR #255 — wait-for now mirrors await-element's `found` semantics: success against state:absent returns found:false + absent:true twin)
- **Why**: IMP-0095 fixed the same shape bug for chrome_await_element but the twin in chrome_wait_for was missed. wait-helper.js always emits `found:true` regardless of state; chrome_await_element overrides via `isPresentSuccess = state === present`, but chrome_wait_for.shapeResponse spreads the raw helper response unchanged. Caller calling `chrome_wait_for({kind:element, state:absent, selector:#modal})` sees `found:true` AFTER the modal disappears — same surprise as IMP-0095, masking the success of the absent wait. Agents conditioning on `found:false` to confirm an element was successfully waited away cannot use chrome_wait_for for that purpose.
- **Cost**: S
- **Value**: M
- **Repro**: From a page with `<div id=modal>`, call `chrome_wait_for({kind:element, selector:#modal, state:absent, timeoutMs:5000})`. Remove the div externally. Envelope returns `{success:true, kind:element, found:true, matched:null, state:absent, ...}`. Expected: `found:false` (twin of IMP-0095s `await_element` fix), or an `absent:true` field.\n- **Fix sketch**: `app/chrome-extension/entrypoints/background/tools/browser/wait-for.ts:556-585` — when kind===element, mirror await-element.ts:171-189: compute `isPresentSuccess = (state === present)` and explicitly set `found:isPresentSuccess`/`absent:!isPresentSuccess` instead of spreading the raw `resp.found` from `wait-helper.js:283`. Or fix the helper itself at `app/chrome-extension/inject-scripts/wait-helper.js:281-287` to set `found: wantPresent` so all consumers agree on the contract.\n- **Notes**: IMP-0095 was filed against chrome_await_element only; the unified wait_for path was added in IMP-0011 and shares the same helper. Both helpers and both tool wrappers should agree on what `found` means.

### IMP-0151 · chrome_inject_script + chrome_send_command_to_inject_script missing `static mutates = true` — auto-spawn/pacing bypass (bug) · score: 6

- **Proposed by**: bug-scout · 2026-05-19
- **Status**: done (2026-05-23; landed via IMP-0156, multi-tab Phase 1)
- **Why**: InjectScriptTool (inject-script.ts:126) and SendCommandToInjectScriptTool (inject-script.ts:231) both inject and dispatch into page state but neither declares `static readonly mutates = true`. The base class default is `mutates = false` (base-browser.ts:26). Effect: the dispatchers IMP-0086 multi-client invariants are bypassed — anonymous calls do NOT auto-spawn a fresh owned tab and DO NOT participate in per-tab lock queueing / pacing. Two concurrent clients calling chrome_inject_script with no tabId land on whichever active tab Chrome resolves (the cross-window fallback at inject-script.ts:174), which silently collides with another clients owned tab. RemoveInjectedScriptTool correctly declares `mutates = true` at line 480 — so the declaration is missing from exactly the two tools that perform the actual write.
- **Cost**: S
- **Value**: M
- **Repro**: With two clients connected (Claude Code + curl), call `chrome_inject_script({type:MAIN, jsScript:console.log(client_A)})` from client A with no tabId. Repeat from client B with no tabId. Both injections land on the same currentWindow active tab. With `mutates = true` set, client Bs call would auto-spawn an owned tab via the dispatcher (tools/index.ts:451-453).\n- **Fix sketch**: Add `static readonly mutates = true;` to `app/chrome-extension/entrypoints/background/tools/browser/inject-script.ts:127` (InjectScriptTool) and `:232` (SendCommandToInjectScriptTool). One-line each. The fallback active-tab paths at `:174` and `:252` then become dead code for anonymous calls — the dispatcher injects the auto-spawned `tabId` into args before tool.execute runs.\n- **Notes**: CLAUDE.md §Load-bearing conventions explicitly calls this out: `Mutating tools without an explicit tabId get a fresh background tab auto-spawned and claimed for the client — opt out by setting static readonly autoSpawnTab = false on tools that dont need a tab`. Neither tool wants the opt-out — both are tab-targeted writes.

### IMP-0154 · Tab-less mutating tools auto-spawn unused tabs — clipboard/notifications/alarms/action_badge/keep_awake missing autoSpawnTab=false (bug) · score: 6

- **Proposed by**: bug-scout · 2026-05-19
- **Status**: done (2026-05-23; landed via IMP-0156, multi-tab Phase 1)
- **Why**: Five mutating tools that do not target a tab are missing `static readonly autoSpawnTab = false`: chrome_clipboard, chrome_notifications, chrome_alarms, chrome_action_badge, chrome_keep_awake. Per the dispatcher at tools/index.ts:451-453, any mutating tool called without an explicit tabId by a known clientId triggers `autoSpawnOwnedTab(clientId)` — which calls `chrome.tabs.create({active:false})`, claims the tab for the client, and stamps `args.tabId` with the new id. None of these five tools use args.tabId (their schemas dont even list it). Net effect: every fresh MCP client that calls chrome_clipboard/chrome_notifications/etc. as its FIRST tool gets a blank background tab silently opened in its window. Subsequent calls reuse the owned tab (no further spawns) but the orphan tab sticks around until the user closes it or `browser_close_my_tabs` runs. Mild garbage but breaks the principle of least surprise — a clipboard read should NOT open a tab. CLAUDE.md explicitly calls out this opt-out pattern (`opt out by setting static readonly autoSpawnTab = false on tools that dont need a tab`); pace_get and get_windows_and_tabs already do it.
- **Cost**: S
- **Value**: M
- **Repro**: From a fresh extension boot, connect a new MCP client (e.g. fresh curl with a new X-Humanchrome-Session header). First call: `chrome_clipboard({action:read})`. Observe `chrome.tabs.query({})` in the SW debugger — a new blank tab has appeared in the active window. Same shape for `chrome_notifications({action:get_all})`, `chrome_alarms({action:list})`, `chrome_action_badge({...})`, `chrome_keep_awake({...})`.\n- **Fix sketch**: Add `static readonly autoSpawnTab = false;` after each existing `static readonly mutates = true;` line. Files + lines: `app/chrome-extension/entrypoints/background/tools/browser/clipboard.ts:23`, `notifications.ts:24`, `alarms.ts` (around the mutates declaration), `action-badge.ts`, `keep-awake.ts`. Five one-line additions.\n- **Notes**: Audit the rest of the tool surface for the same shape — any tool whose schema doesnt accept tabId/url but is marked mutates=true is a candidate (cookies.ts may be the same). The base class default for autoSpawnTab is true (assumed via the `!== false` check at tools/index.ts:429), so the opt-out must be explicit.

### IMP-0108 · chrome_wait_for / chrome_await_element ignore `timeoutMs` and block ~120s (bug) · score: 5

- **Proposed by**: bug-scout · 2026-05-16
- **Status**: wontdo (2026-05-17; stale-bridge artifact — IMP-0103 root cause. Matrix `docs/e2e-runs/2026-05-17_baseline.json` shows `wait_for kind:url`, `wait_for kind:load_state`, and `await_element absent` all PASS against a fresh SW. Closing.)
- **Why**: `chrome_wait_for({kind:'element', selector:'#submit-btn', timeoutMs:2000})` and `chrome_await_element({selector:'#ephemeral', state:'absent', timeoutMs:3000})` both hang and ultimately return `{code:"UNKNOWN", message:"Request timed out after 120000ms"}` — the bridge's default 120s envelope, not the caller's budget. `#submit-btn` is present immediately so element-present should resolve in <50ms. Suggests the call isn't reaching the SW wait-helper at all (bridge handler missing or message envelope mismatched), and the bridge's default request timeout is what eventually returns.
- **Cost**: M
- **Value**: M

- **Repro**: Open `playwright-parity.html`, call `chrome_wait_for({kind:'element', selector:'#submit-btn', timeoutMs:2000, tabId:<fixture>})` — observe 120s wall-clock to error.
- **Fix sketch**: Likely tied to IMP-0103 (bridge staleness — `chrome_wait_for` schema mismatch causes dispatcher to drop the call). Reinstall and re-test. If still hanging: trace the request id through bridge → native-host → SW, log dispatch decisions, ensure SW returns a response even when validation fails (so caller doesn't wait for the global timeout).

### IMP-0109 · Unattended E2E verification pipeline — `chrome_dev_reload` + `chrome_runtime_info` + standalone HTTP runner (feat) · score: 5

- **Proposed by**: user · 2026-05-16
- **Status**: done (2026-05-16; see `scripts/run-e2e-matrix.mjs`, `chrome_dev_reload`, `chrome_runtime_info`)
- **Why**: Every chrome-extension PR was supposed to run the matrix in `docs/E2E-VERIFICATION.md` (hard rule in CLAUDE.md). In practice the matrix required 30+ round-trips because (a) the MV3 SW doesn't auto-reload on rebuild — needed manual click in chrome://extensions; (b) the bridge process held old code in memory; (c) the MCP client cached tool schemas at session start so new tools were invisible mid-session; (d) no way to verify the SW was actually on the bundle just built. So the rule was followed at high friction or silently skipped, and IMP-0104..0108 regressions slipped through unnoticed.
- **Cost**: M
- **Value**: L

- **Files**: `app/chrome-extension/entrypoints/background/tools/browser/dev-reload.ts` (new), `app/chrome-extension/entrypoints/background/tools/browser/runtime-info.ts` (new), `app/chrome-extension/entrypoints/background/tools/index.ts` (`listRegisteredToolNames` export, register both tools), `app/chrome-extension/entrypoints/background/tools/browser/index.ts` (barrel), `app/chrome-extension/wxt.config.ts` (`__HC_BUILD_HASH__` + `__HC_BUILT_AT__` define), `packages/shared/src/tools.ts` (`DEV_RELOAD`, `RUNTIME_INFO` entries), `scripts/run-e2e-matrix.mjs` (new — HTTP-only matrix runner), `package.json` (`e2e:matrix`, `e2e:full`), `docs/E2E-VERIFICATION.md` (TL;DR section).
- **Sketch**: `chrome_dev_reload` MCP tool calls `chrome.runtime.reload()` from SW. `chrome_runtime_info` returns `{extensionVersion, toolNames[], buildHash, builtAt, uptimeMs}` so runners detect stale SW. Build-hash injection via wxt's `vite.define`. `scripts/run-e2e-matrix.mjs` POSTs to bridge's `/api/tools/:name` directly — no MCP, no Claude Code session, no schema cache. Pipeline: probe runtime_info → call dev_reload → poll until uptimeMs<5000 → navigate fixture → walk matrix → emit pass/fail JSON. Bootstrap: ONE manual reload of the extension to load these tools into a SW that didn't have them; every subsequent test cycle is unattended.
- **Follow-ups**: Phase 1 (bridge file watcher — auto-calls dev_reload on `.output/chrome-mv3/manifest.json` mtime change) and Phase 4 (`puppeteer-core` to spawn dedicated Chrome with `--load-extension` so CI doesn't depend on user Chrome) deferred — current implementation is enough for local unattended runs.

### IMP-0110 · CI e2e-fixture workflow gates chrome-extension PRs (feat) · score: 5

- **Proposed by**: user · 2026-05-16
- **Status**: proposed
- **Why**: CLAUDE.md hard-rules "E2E verification mandatory for every chrome-extension change", but until IMP-0109 landed (the `pnpm e2e:full` runner) there was no automatable way to enforce it. Now that the matrix runner is HTTP-only and JSON-emitting, a CI job can run it on every PR touching `app/chrome-extension/**` and fail the merge gate when the matrix regresses. Closes the gap that let IMP-0104..0108 slip through review unnoticed.
- **Cost**: M
- **Value**: L

- **Depends on**: IMP-0109 (#185) merged so `pnpm e2e:full` exists on main.
- **Files**: `.github/workflows/e2e-fixture.yml` (new), `docs/E2E-VERIFICATION.md` (point at the workflow), `package.json` (optional CI-mode flag if `--ci` needs to swap behavior).
- **Sketch**: New workflow triggered on `pull_request` with `paths: ['app/chrome-extension/**', 'packages/shared/**']`. Steps: checkout → pnpm install → install Chrome via `browser-actions/setup-chrome@v1` → `pnpm build` → start static fixture server (`python3 -m http.server 4173 --directory app/chrome-extension/tests/e2e/fixtures`) in background → launch Chrome headed with `--load-extension=$REPO/app/chrome-extension/.output/chrome-mv3 --user-data-dir=$RUNNER_TEMP/profile --remote-debugging-port=9222 --no-first-run` in background → wait-for-port → spawn bridge with `humanchrome-bridge register` + wait-for-port on `:12306` → run `pnpm e2e:full --json $RUNNER_TEMP/result.json` (which itself calls `chrome_dev_reload` + polls runtime_info) → `actions/upload-artifact@v4` for the JSON → job fails when exit code ≠ 0.
- **Open questions**: Headed Chrome on GitHub Actions Linux runners requires `xvfb-run` wrapping. macOS runners may be cleaner but cost more. Headless Chrome won't help because the extension needs MV3 service-worker support which is gated on browser surface; might need to investigate `--headless=new` compatibility before settling. Bootstrap reload (the one human step in IMP-0109) can be skipped in CI because the SW starts fresh on each Chrome launch — there's no prior installation to be stale against.

### IMP-0118 · checkStable false-stable at velocity-zero animation peak (bug) · score: 5

- **Proposed by**: bug-scout · 2026-05-17 (matrix evidence)
- **Status**: done (2026-05-17; checkStable rewritten as fixed-interval (50ms × 3 samples) setTimeout sampler instead of rAF consecutive-equal heuristic; reliably catches slow CSS animations and avoids the rAF-based hang that earlier attempts triggered. Matrix `pnpm e2e:isolated` is 16/16 PASS.)
- **Why**: `chrome_click_element({selector:'#sliding-btn'})` (a button with `4s ease-in-out infinite alternate` CSS transform) succeeds without `force:true` — should return `NOT_ACTIONABLE failures:['unstable_bbox']`. Root cause: `checkStable` resolves null on the first equal pair of consecutive rAF samples; ease-in-out animations have velocity-zero peaks at every reversal, so sampling at that exact moment yields a single equal pair and the check returns stable.
- **Cost**: M
- **Value**: M

- **Files**: `app/chrome-extension/inject-scripts/actionability.js` (`checkStable` ~L235-267)
- **Fix sketch**: Require N consecutive equal samples (e.g. 3 in a row) before declaring stable, so a single zero-velocity coincidence can't pass. Attempted in fix/imp0113-actionability but introduced SW hangs in matrix runs that aren't reproducible in unit tests — needs deeper investigation. Possible cause: rAF inside an injected script may interact poorly with Chrome's content-script lifecycle when the page also has animations driving its own rAF. Diagnostic next steps: enable verbose chrome_console capture during the matrix and look for "post-inject ping never returned pong" warnings.
- **Repro**: `pnpm e2e:isolated` — "animation unstable_bbox" row fails. Evidence in any recent matrix JSON.

### IMP-0124 · chrome_emulate — device/UA/locale/timezone/geolocation/color-scheme overrides via CDP (feat) · score: 5

- **Proposed by**: feature-scout · 2026-05-19
- **Status**: done (2026-05-24; merged in PR #258 — 8 actions: set_device/ua/locale/timezone/geolocation/color_scheme/reset_all/get_state, device presets iphone-15/pixel-7/etc, per-tab state evicted on tab close, CDP_BUSY classification)
- **Why**: Anti-bot platforms (LinkedIn, Tinder) cross-check timezone/geolocation/UA vs IP. Mobile-only flows (Instagram DMs, WhatsApp Web mobile UI) need device emulation. Today the only emulation tool is chrome_network_emulate (throughput/latency only) and chrome_proxy (IP). No primitive for UA, timezone, geolocation, locale, color-scheme, viewport size, deviceScaleFactor, prefers-reduced-motion. Agents currently fail silently when these mismatch the proxy region — or fall back to chrome_javascript injection that does not persist across navigations.
- **Cost**: M
- **Value**: L
  Multi-action tool wrapping CDP Emulation.\*: setUserAgentOverride, setLocaleOverride, setTimezoneOverride, setGeolocationOverride, setDeviceMetricsOverride, setEmulatedMedia (color-scheme + prefers-reduced-motion), clearDeviceMetricsOverride. Actions: set_device (preset name like iphone-15 or explicit width/height/dsf/mobile/touch), set_ua, set_locale, set_timezone, set_geolocation, set_color_scheme, reset_all. Requires debugger permission (already granted). Per-tab state, persists across navigations within the tab until reset_all or tab close. Files: app/chrome-extension/entrypoints/background/tools/browser/emulate.ts (new), packages/shared/src/tools.ts (TOOL_NAMES.BROWSER.EMULATE + schema), barrel + dispatcher + tests. Lazy registration (CDP attach cost). Pairs naturally with chrome_proxy when running through a region-specific proxy — agent sets timezone + locale + geolocation to match.

### IMP-0127 · chrome_aria_snapshot — Playwright-style compact ARIA tree snapshot for token-efficient page reads (feat) · score: 5

- **Proposed by**: feature-scout · 2026-05-19
- **Status**: done (2026-05-24; merged in PR #257 — thin formatter over the existing accessibility-tree-helper, strips coord/attr decorations to leave just role+name+ref; 1 MiB output cap; interactiveOnly + includeRefs flags)
- **Why**: chrome_read_page returns the full accessibility tree as nested JSON — verbose, blows agent context fast on rich pages (LinkedIn feed renders 30 KB+ per call). Playwright introduced page snapshot text format which renders the ARIA tree as compact YAML-like text with stable refs that round-trip into selectorType:ref. On a typical LinkedIn message thread it is 4-6x smaller than chrome_read_page output and easier for an LLM to scan. Anthropic/OpenAI agent harnesses standardized on this format. Today there is no equivalent in humanchrome.
- **Cost**: M
- **Value**: L
  New file app/chrome-extension/entrypoints/background/tools/browser/aria-snapshot.ts. Params: {tabId?, frameId?, refId?, maxDepth?, interactiveOnly?: boolean, includeText?: boolean, includeRefs?: boolean}. Reuses the existing accessibility-tree-helper.js (already injected per IMP-0104) and walks the same role+name pairs that chrome_read_page returns, but serializes to indented text: - button "Submit" [ref=ref_12]\n - link "Privacy" [ref=ref_13]. Default interactiveOnly:true cuts noise. includeRefs:true (default) inserts [ref=ref_N] stable refs so the LLM can immediately pivot to chrome_click_element({selectorType:ref, selector:ref_12}). 1 MiB output cap with truncation envelope. Read-only. Pairs with chrome_read_page for the heavy case — most calls use aria_snapshot; read_page is the fallback for pixel-precise bbox needs. 5-file recipe + tests covering empty trees, nested roles, ref stability across calls, depth/maxNodes truncation, interactiveOnly filter.

### IMP-0129 · Extract NetworkCapture base class to dedupe network-capture-debugger.ts + network-capture-web-request.ts (~2.2k LoC) (refactor) · score: 5

- **Proposed by**: optimization-scout · 2026-05-19
- **Status**: proposed
- **Why**: network-capture-debugger.ts (1116 LoC) and network-capture-web-request.ts (1084 LoC) — total 2200 LoC of two distinct backends with ~12 near-identical helpers each. Every fix (IMP-0028 flush, IMP-0053 status, header-truncation cap) had to land twice and risks divergence; the IMP-0093 bug existed because intercept-response used a third copy of the truncation pattern. A shared `NetworkCaptureBackend` base saves ~500 LoC + ends the parallel-maintenance tax.
- **Cost**: M
- **Value**: L
- **Files**: `app/chrome-extension/entrypoints/background/tools/browser/network-capture-debugger.ts` (1116 LoC), `network-capture-web-request.ts` (1084 LoC). Together they form a ~2.2k LoC pair where 12 helper methods are near-byte-identical. The previously-extracted `NETWORK_FILTERS` constants live at `app/chrome-extension/entrypoints/background/utils/network-filters.ts` (mime-type tables already shared), but per-instance helpers are still copied.\n- **Duplicated helpers**: `handleTabRemoved`, `handleTabCreated` (per-tab capture init), `shouldFilterByMimeType`, `updateLastActivityTime`, `checkInactivity` (timer loop), `stopCaptureByInactivity`, `cleanupCapture`, `buildResultData` (envelope shape — already refactored once to share between flush/stop in IMP-0028), `analyzeCommonHeaders` (78-line vs 47-line variants doing the same thing — the debugger version is actually a more correct rewrite that web-request lost), `filterOutCommonHeaders` (identical), `requestCounters`/`captureTimers`/`inactivityTimers`/`lastActivityTime` Maps with identical lifecycle.\n- **Sketch**: New `app/chrome-extension/entrypoints/background/utils/network-capture-base.ts` exposing `abstract class NetworkCaptureBackend<RequestT>`. Generic `RequestT` so the debugger backend can keep its richer `NetworkRequestInfo` shape and web-request its lighter one. Base owns: `captureData: Map<number, CaptureInfo<RequestT>>`, all 4 Map lifecycles, `updateLastActivityTime`/`checkInactivity`/`stopCaptureByInactivity`/`cleanupCapture`/`handleTabRemoved` (all backend-independent), `analyzeCommonHeaders`/`filterOutCommonHeaders` (operate on `Record<string, string>` headers — backend-agnostic), `buildResultData` skeleton with abstract `summarizeRequest(req: RequestT): SummarizedRequest` hook. Subclasses implement only backend-specific: `setupListeners()`, `removeListeners()`, `startCaptureForTab(tab, opts)` and the per-event handlers. Picks the BETTER `analyzeCommonHeaders` (the debugger versions per-value counting handles divergent header values across requests — the web-request all-or-nothing match misses cases where 90/100 requests share a value).\n- **Risk**: Medium — the two backends drifted by accident over time, so unifying them surfaces real behavior diffs (e.g. the analyzeCommonHeaders semantic). Mitigated by landing in slices: slice 1 = extract pure helpers (`analyzeCommonHeaders`/`filterOutCommonHeaders` + the Map-lifecycle quartet) to a shared module with both backends consuming via composition; slice 2 = lift to abstract class once the diff is well-understood. Existing tests at `network-capture.test.ts` + `network-capture-flush.test.ts` + `network-capture-status.test.ts` (~28 cases) gate the rewrite.\n- **Bonus**: After the dedup, IMP-0093 fix scope shrinks too — intercept-response can call into the same `truncateResponseBody` helper instead of pasting copy #4 of the MAX_RESPONSE_BODY_BYTES dance.

### IMP-0152 · chrome_drag_drop inlined actionability suite missing IMP-0113 fixes — offscreen never recovered, transform animations pass stable (bug) · score: 5

- **Proposed by**: bug-scout · 2026-05-19
- **Status**: done (2026-05-24; merged in PR #263 — ported IMP-0113's isOffscreenButPresent+scrollCenter scroll-and-recheck pattern into drag-drop's runActionability; checkStable now diffs getComputedStyle(el).transform alongside getBoundingClientRect)
- **Why**: drag-drop.ts:333-446 duplicates the visible/stable/hit-test suite inside its MAIN-world shim (MAIN shims cannot reach `window.__actionability` since they are serialized as standalone functions). The duplicate was written before IMP-0113 and was not updated when IMP-0113 landed in actionability.js. Two concrete regressions vs ClickTool/FillTool: (1) **offscreen recovery**: drag-drop calls `scrollIfNeeded` ONCE at line 350-351 then polls `checkVisible` with no further recovery — if the first scroll did not bring the element into view (lazy-loaded list, sticky overlay, scroll container with momentum), the actionability poll loop sees `not_visible` until the deadline and fails. IMP-0113s flow in actionability.js is check-once → scroll → re-check, gated by `isOffscreenButPresent` so display:none doesnt waste the scroll. (2) **slow CSS transform stability**: drag-drops checkStable at line 368-397 compares only `getBoundingClientRect()` across 6 rAF samples. A `transform: translateX()` animation with sub-pixel motion floors to identical pixel coords and reports stable — IMP-0113 closed this by additionally diffing `getComputedStyle(el).transform` across the sampler. Result: drag operations on a card mid-CSS-transform pass the stability check; the card moves while the synthesized pointer chain dispatches and the drop lands at the wrong coords.
- **Cost**: M
- **Value**: M
- **Repro**: Open a page where the drag source is offscreen (e.g. a list item at scrollTop+1000). Call `chrome_drag_drop({fromSelector:#item-offscreen, toSelector:#dropzone})`. Click/Fill handle this via IMP-0113s scroll-and-recheck; drag-drop fails with `NOT_ACTIONABLE, failures:[not_visible]` if the initial scrollIntoView did not place it in viewport.\n- **Second repro**: Animate a draggable card with `transform: translateX(0) → translateX(100px)` over 4s ease-in-out, then `chrome_drag_drop({fromSelector:.card, ...})`. The drop lands at stale coords because the card kept moving during the chain dispatch — the stability check missed the transform-only motion.\n- **Fix sketch**: Port IMP-0113s `isOffscreenButPresent` guard + scroll-then-recheck pattern into drag-drop.ts:422-446 (`runActionability` loop). Port the `getComputedStyle(el).transform` diff into the `checkStable` at drag-drop.ts:368-397. Or — better — refactor the MAIN-world shim to also load `actionability.js` first and reuse `window.__actionability.awaitActionable` so the suite has a single source of truth (the existing comment at line 334-336 says “MAIN-world shims are serialized as standalone functions, so we cant reach into window.\_\_actionability” — but actionability.js IS a MAIN-world capable script that could be inject-scripted alongside the shim execution; current code chose to inline-copy instead).\n- **Notes**: Same divergence will recur for any future actionability invariant added to actionability.js but not back-ported into the drag-drop inline copy. The longer-term win is collapsing both copies into one.

### IMP-0054 · Extract executeAction switch in computer.ts into per-action handler modules (click, scroll, fill, screenshot) (refactor) · score: 4

- **Proposed by**: optimization-scout · 2026-05-08
- **Status**: done (CDPHelper, click-actions, scroll-zoom-actions, input-actions, view-actions all extracted under `browser/computer/`; computer.ts shrank from 1327 LoC to ~350 LoC orchestrator)
- **Why**: After IMP-0008 (domain-shift helper) and IMP-0035 (params typing), the dominant bulk in computer.ts is a 16-case switch inside executeAction spanning lines 392-1348 (~956 LoC). Representative case sizes: left_click_drag 93 LoC, zoom 98 LoC, screenshot 147 LoC. Adding a new action or fixing a case requires navigating past all 15 others. CDPHelper (lines 142-310) is already a self-contained class that could be elevated to a sibling module without any refactor risk.
- **Cost**: M
- **Value**: M
- **Files**: `app/chrome-extension/entrypoints/background/tools/browser/computer.ts` (1478 LoC; executeAction lines 392-1348 ~956 LoC switch; CDPHelper lines 142-310)
- **Sketch**: Slicing into focused PRs. Slice 1 (done): move CDPHelper to `browser/computer/cdp-helper.ts` (~168 LoC). Slice 2: extract `browser/computer/actions/click-actions.ts` (left_click/right_click/double_click/triple_click/left_click_drag). Slice 3: scroll-actions.ts. Slice 4: fill-actions.ts. Slice 5: screenshot-actions.ts. Slice 6: replace switch with `const HANDLERS: Record<string, ActionHandler> = {...}` dispatch table. After all slices: computer.ts shrinks to ~250-LoC orchestrator with execute()/mapActionToCapture()/triggerAutoCapture()/domHoverFallback().
- **Risk**: Medium — CDP timeout wrapper composes around handler dispatch; shared helpers (project, screenshotContextManager lookups) passed via deps object. No runtime change. Extension test suite catches regressions.

### IMP-0086 · Multi-client tab isolation — ownership, auto-spawn, stable sessionName, UI clientId stamping (feat) · score: 4

- **Proposed by**: user · 2026-05-16
- **Status**: done (PR #172, squash `12f1943`, 2026-05-16)
- **Why**: Two concurrent MCP clients (Claude Code + curl, two CLIs, etc.) silently collide on the globally-active tab when either calls a tool without an explicit `tabId`. The dispatcher's old `resolveTabIdForClient` returned `undefined` for a fresh client, falling through to whatever Chrome currently shows — so Client B's first action lands on Client A's tab and every subsequent call interleaves with Client A's session there. Same problem affects popup/sidepanel/options calls, which carried no `clientId` at all.
- **Cost**: L
- **Value**: L

- **Files**: `app/chrome-extension/entrypoints/background/utils/client-state.ts`, `app/chrome-extension/entrypoints/background/tools/index.ts`, `app/chrome-extension/entrypoints/background/tools/base-browser.ts`, `app/chrome-extension/entrypoints/background/tools/browser/claim-tab.ts` (new), `app/chrome-extension/entrypoints/background/tools/browser/window.ts`, `app/chrome-extension/entrypoints/background/native-host.ts`, `app/chrome-extension/entrypoints/background/utils/timeouts.ts`, `app/native-server/src/mcp/session-name.ts` (new), `app/native-server/src/mcp/mcp-server-stdio.ts`, `app/native-server/src/server/index.ts`, `packages/shared/src/{error-codes,types,tools}.ts`.
- **Sketch**: Replace single-`lastTabId` with `Set<number> ownedTabs` + persistence to `chrome.storage.session`. Dispatcher resolves explicit-then-active-then-most-recent-owned; mutating call with no usable owned tab → `chrome.tabs.create({active:false})` auto-spawn (opt-out via `static autoSpawnTab=false`). Cross-client targeting → `TAB_NOT_OWNED`. UI surfaces get synthetic `__ui:<surface>` clientIds. Caller-supplied sessionName via `X-Humanchrome-Session` header (stdio derives from CWD/env) becomes the canonical clientId so reconnects reclaim their owned set. Bridge `transport.onclose` → `CLIENT_DISCONNECTED` native msg → extension `releaseClient` (tabs become unowned, not closed). New `browser_claim_tab` tool exposes the claim primitive; `chrome_get_windows_and_tabs` surfaces `owner` per tab.
- **Notes**: Follow-ups split out as IMP-0087..0091 below — see the "Out of scope" section of the original plan at `~/.claude/plans/staged-wiggling-hennessy.md`.

### IMP-0088 · `browser_close_my_tabs` opt-in cleanup tool (feat) · score: 4

- **Proposed by**: user · 2026-05-16
- **Status**: done (2026-05-16)
- **Why**: When a client wraps up (CI run, one-shot script, interactive agent finishing a workflow) there is no one-shot verb to dismiss every tab it owns. Today the caller round-trips `chrome_get_windows_and_tabs` → filter by `owner` → `chrome_close_tab` with the ids, which is racy (a tab can close between listing and close) and pushes ownership bookkeeping onto the agent loop. IMP-0086's `CLIENT_DISCONNECTED` deliberately leaves tabs intact — this is the positive opt-in side of that contract.
- **Cost**: S
- **Value**: M

- **Files**: `app/chrome-extension/entrypoints/background/tools/browser/close-my-tabs.ts` (new), `app/chrome-extension/entrypoints/background/tools/browser/index.ts`, `app/chrome-extension/entrypoints/background/tools/index.ts`, `packages/shared/src/tools.ts`, tests.
- **Sketch**: New tool `browser_close_my_tabs({ keep?: number[] })`. Resolves the calling client's `ownedTabs`, skips any tabId in `keep[]`, calls a small `safeRemoveTabs` helper that swallows "no tab with id" so closed tabs don't fail the batch. Returns `{ closed: number[], kept: number[], failed: { tabId, error }[] }`. Disconnect path unchanged — still releases without closing.
- **Notes**: Long-form plan at `~/.claude/plans/imp0088browserclosemytabs.md`.

### IMP-0090 · Cross-window arbitration for per-client ownership (feat) · score: 4

- **Proposed by**: user · 2026-05-16
- **Status**: done (2026-05-16)
- **Why**: IMP-0086's `autoSpawnOwnedTab` calls `chrome.tabs.create({ active: false })` with no `windowId`, so a new tab lands in whichever window Chrome considers "last focused" — usually the user's, not the client's. A client driving W1 silently loses its workspace into W2 the moment the user clicks anywhere in W2. `NavigateBatchTool`'s `getLastFocused` fallback drifts the same way. When the user closes a window the client was using, `lastWindowId` becomes stale and the next auto-spawn throws `"No window with id …"`.
- **Cost**: S
- **Value**: M

- **Files**: `app/chrome-extension/entrypoints/background/utils/client-state.ts`, `app/chrome-extension/entrypoints/background/tools/index.ts`, `app/chrome-extension/entrypoints/background/tools/browser/common.ts`, tests.
- **Sketch**: New `resolveOwnedWindowIdForClient` helper prefers the client's recorded `lastWindowId` over `chrome.windows.getLastFocused`. `autoSpawnOwnedTab`, `NavigateTool`'s no-`tabId` branch, and `NavigateBatchTool`'s no-`windowId` branch all route through it. Add a `chrome.windows.onRemoved` listener that clears `lastWindowId` and evicts any `ownedTabs` belonging to the dead window. Single-window default (the documented norm) stays a no-op.
- **Notes**: Long-form plan at `~/.claude/plans/imp0090crosswindowarbitration.md`.

### IMP-0091 · Plumb `clientId` into humanchrome's IPC schemas (refactor) · score: 4

- **Proposed by**: user · 2026-05-16
- **Status**: done (2026-05-16)
- **Why**: `clientId` is now load-bearing for tab ownership but the envelope is built ad-hoc with no schema enforcement. `CALL_TOOL` and the new `CLIENT_DISCONNECTED` frames slip through `UnknownTypedMessageSchema` — a typo (`clientid`, `client_id`) or omission on either side would silently degrade isolation back to the pre-IMP-0086 bug. Both producer and consumer read `clientId` from `any`-typed envelopes — no compile-time guarantee.
- **Cost**: M
- **Value**: M
- **Files**: `packages/shared/src/ipc-schemas.ts`, `app/native-server/src/native-messaging-host.ts`, `app/native-server/src/server/index.ts`, `app/chrome-extension/entrypoints/background/native-host.ts`, ipc-schemas tests.
- **Sketch**: Add explicit `CallToolMessageSchema` requiring `clientId`, and a new `ClientDisconnectedMessageSchema`. Typed union discriminator over message types. Schema-built envelope helpers on producer side (`buildCallToolEnvelope`, `buildClientDisconnectedEnvelope`). Schema-parsed envelope on consumer side. Future regressions in clientId plumbing fail at the IPC boundary instead of silently breaking tab isolation.
- **Notes**: Long-form plan at `~/.claude/plans/imp0091clientidinipcschemas.md`. Touches the wire boundary — land after the upstack settles.

### IMP-0125 · chrome_hover — programmatic mouse hover to trigger tooltips and dropdown menus (feat) · score: 4

- **Proposed by**: feature-scout · 2026-05-19
- **Status**: done (2026-05-24; merged in PR #260 — ISOLATED-world shim dispatches pointermove→mouseover→mouseenter→pointerenter chain; visibility + hit-test gate with occluded_by:<tag> classification; position offset; force flag)
- **Why**: Hover-revealed UI (LinkedIn profile preview cards, Twitter quote-tweet tooltip, GitHub commit hover, dropdown menus on most nav bars) is unreachable without a real mouseover dispatch. chrome_focus only focuses, chrome_click clicks, chrome_drag_drop chains move+down+up, chrome_paste fires paste events. Agents currently fall back to chrome_computer with coordinate math (have to query bbox first, then dispatch mouse_move at center) or chrome_javascript that fires synthetic events but skips actionability. Single dedicated tool eliminates a 3-call pattern and inherits the IMP-0097 actionability suite (visible+stable+hit-test) so hover-over-overlay silently-failing is structurally impossible.
- **Cost**: S
- **Value**: M
  New file app/chrome-extension/entrypoints/background/tools/browser/hover.ts. Params: {selector?, selectorType?, ref?, index?, multi?, position?, force?, actionabilityTimeoutMs?, tabId?, frameId?}. ISOLATED-world shim resolves the target via the same \_selector-resolve helper that click uses, runs awaitActionable with the hover check matrix (visible+stable+hit-test, no enabled/editable), computes element-center (or position offset), then dispatches pointermove → mouseover → mouseenter → pointerenter on the target — exactly the chain a real mouse generates. Returns {hovered, bbox, tabId}. Reuses inject-scripts/click-helper.js coord-mode plumbing for hit-testing. 5-file recipe (tool + tools.ts schema + barrel + dispatcher eager-list + tests/tools/browser/hover.test.ts). Single tool, no action enum. Pairs with chrome_await_element after dispatch to wait for the revealed UI before clicking it.

### IMP-0126 · chrome_get_attributes — read DOM attributes, properties, computed CSS by selector or ref (feat) · score: 4

- **Proposed by**: feature-scout · 2026-05-19
- **Status**: done (2026-05-24; merged in PR #259 — read-only ISOLATED shim; default attribute set (id/class/href/src/value/title/role/aria-label) + default property set (tagName/checked/disabled/selected/value); computedStyles opt-in; multi:true returns matches[]; FileList/NodeList safely serialized)
- **Why**: Reading a single attribute (href, value, checked, disabled, aria-label, data-id, src) or a computed style (color, font, display) is one of the most common assertion/scraping needs. Today the options are: (a) chrome_assert with kind:js (forces JS authoring + only returns boolean), (b) chrome_read_page (returns the whole accessibility tree — heavy; computed styles unavailable), (c) chrome_javascript (force-pushes JS authoring onto the agent and trips redactor). There is no read-only structured primitive that says give me these N attributes on this one element. Scraping LinkedIn URNs from data-entity-urn, reading <input value> after fill, asserting computed color matches a brand spec — all need this and currently cost the agent a full JS round-trip.
- **Cost**: S
- **Value**: M
  5-file recipe. New app/chrome-extension/entrypoints/background/tools/browser/get-attributes.ts. Params: {selector?, selectorType?, ref?, index?, multi?, attributes?: string[], properties?: string[], computedStyles?: string[], frameId?, tabId?}. ISOLATED-world shim: resolves the element via \_selector-resolve; for each attributes[] name calls el.getAttribute(name); for each properties[] name reads (el as any)[name] (covers DOM-property-only fields like checked/value/selectedIndex/files.length); for each computedStyles[] reads getComputedStyle(el).getPropertyValue(name). multi:true returns an array. Empty input arrays default to commonly-needed sets (attributes: id/class/href/src/value/title/role/aria-label, properties: tagName/checked/disabled/selected/value, computedStyles: empty). Returns {tagName, attributes: {...}, properties: {...}, computedStyles: {...}, count}. Read-only (mutates=false). Pairs with chrome_assert for non-boolean comparisons. Reuses IMP-0098 locator engine for free.

### IMP-0132 · Extract `classifyTabError` helper — dedupe 16+ copies of `/no tab with id/i` → TAB_CLOSED catch block (refactor) · score: 4

- **Proposed by**: optimization-scout · 2026-05-19
- **Status**: done (2026-05-24; merged in PR #261 — helper in common/tool-handler.ts; 12 tool files migrated, -44 LoC; ToolError instances preserve code+details with ctx merge; covers "Receiving end does not exist" + "Could not establish connection" too)
- **Why**: 16 tool files copy-paste the same 6-line pattern: `catch (error: unknown) { const msg = error instanceof Error ? error.message : String(error); if (/no tab with id/i.test(msg)) { return createErrorResponse(\`Tab ${tabId} not found\`, ToolErrorCode.TAB_CLOSED, { tabId }); } ... }`. ~96 LoC of pure duplication that breaks when a new related regex (`Receiving end does not exist`, `Frame with ID`, `Could not establish connection`) needs to be added — today it requires touching 16 files instead of one. Encourages drift: some files already classify `Receiving end does not exist` and others don't.
- **Cost**: S
- **Value**: M
- **Files** (16 confirmed, line numbers of the `/no tab with id/i` test): `tools/browser/focus.ts:158`, `paste.ts:144`, `tab-groups.ts:115`, `tab-lifecycle.ts:87`, `web-vitals.ts:119`, `storage.ts:136`, `select-text.ts:135`, `close-my-tabs.ts:79`, `drag-drop.ts:254`, `inject-script.ts:490`, `list-frames.ts:51`, plus 5 more via `grep -rln '/no tab with id/i' entrypoints/background/tools/browser`. Total ~16 files. Each repeats the exact same `error instanceof Error ? error.message : String(error)` + regex test + `createErrorResponse` ToolErrorCode.TAB_CLOSED triple.
- **Sketch**: Add to `app/chrome-extension/common/tool-handler.ts` (already 48 LoC; the dedupe natural home) a `classifyTabError(error, ctx)` helper that handles `/no tab with id/i` → TAB_CLOSED with tabId details, `/receiving end does not exist|could not establish connection/i` → TAB_CLOSED unreachable, fallback → UNKNOWN with toolName context. Each tool collapses its 6-9 line catch to `} catch (error) { return classifyTabError(error, { tabId, toolName: 'chrome_focus', extraDetails: { frameId: args.frameId } }); }`. Net deletion: ~80 LoC across 16 files.
- **Risk**: Low. Pure refactor — the regex stays identical; only the wrapping moves. Test surface per tool stays unchanged because each `*.test.ts` already asserts via the public envelope shape, not the catch source. Easy slice: ship as 3-4 grouped PRs (5 files each) so the diff stays reviewable.
- **Win 2**: Anywhere we add a new TAB-class regex (SUSPENDED_TAB, the IMP-0094 CDP_BUSY extension), it lands in one place. The classifier becomes the single audit point for tab-related error mapping.

### IMP-0140 · Split common.ts (920 LoC) — extract NavigateBatchTool, CloseTabsTool, SwitchTabTool into siblings (refactor) · score: 4

- **Proposed by**: optimization-scout · 2026-05-19
- **Status**: proposed
- **Why**: `common.ts` jams 4 unrelated tools (Navigate/NavigateBatch/CloseTabs/SwitchTab) into one 920-LoC file with overlapping URL-matching helpers (`buildUrlPatterns`, `pickBestMatch`, `normalizePath`). New tools (IMP-0050 close_tabs_matching, etc.) keep landing here because the file is the catch-all. Splitting clarifies ownership and shrinks per-file blast radius for unrelated edits.
- **Cost**: S
- **Value**: M
- **Files**: `app/chrome-extension/entrypoints/background/tools/browser/common.ts` (920 LoC; classes at lines 26, 518, 693, 875)
- **Sketch**:
  - `navigate.ts` ← `NavigateTool` (lines 26-476) + `buildUrlPatterns` + `pickBestMatch` helpers (only used by navigate)
  - `navigate-batch.ts` ← `NavigateBatchTool` (lines 518-683) + worker-pool helper
  - `close-tabs.ts` ← `CloseTabsTool` (lines 693-865)
  - `switch-tab.ts` ← `SwitchTabTool` (lines 875-920)
  - `common.ts` → delete entirely (or keep as a re-export shim for one release)
  - `tools/browser/index.ts` barrel updated; dispatcher imports already singletons so no other touchpoints.
- **Risk**: low — these are independent classes today, only shared state is module-scope constants `DEFAULT_WINDOW_WIDTH/HEIGHT` (move into `navigate.ts`, the only user). Tests already split by tool (navigate.test.ts, navigate-batch.test.ts, etc).

### IMP-0141 · Extract AgentEngineBase — claude.ts + codex.ts share 6 identical helpers (~150 LoC dedupe) (refactor) · score: 4

- **Proposed by**: optimization-scout · 2026-05-19
- **Status**: proposed
- **Why**: Both engines (claude.ts 1733 LoC, codex.ts 1078 LoC) carry the same `pickFirstString`, `resolveRepoPath`, `encodeHash`, `writeAttachmentToTemp`, `MAX_STDERR_LINES` constant, and a 30-line `dispatchToolMessageRun` that differs only by the `cli_type` metadata key. Each future bug fix has to be applied twice; IMP-0009 / IMP-0049 (split initializeAndRun) will only get harder until the shared spine is extracted.
- **Cost**: M
- **Value**: M
- **Files**: `app/native-server/src/agent/engines/claude.ts` (lines 1070-1082 resolveRepoPath, 1481-1497 pickFirstString, 1445-1476 dispatchToolMessageRun, 1706-1712 encodeHash, 1713+ writeAttachmentToTemp); `app/native-server/src/agent/engines/codex.ts` (lines 635-644, 835+, 1037-1077, 789-808 — identical signatures, identical bodies modulo the `cli_type` literal)
- **Sketch**:
  - New `app/native-server/src/agent/engines/base.ts` exporting `abstract class AgentEngineBase implements AgentEngine` with the 5 helpers as `protected` methods and `MAX_STDERR_LINES` as a `protected static`.
  - `dispatchToolMessageRun` becomes generic over a `DispatchScope<TCliType>` — concrete engines call `super.dispatchToolMessageRun(scope, content, metadata, type, isStreaming, { cliType: "claude" })`.
  - `ClaudeEngine extends AgentEngineBase`, `CodexEngine extends AgentEngineBase` — concrete classes lose ~150 LoC each.
  - Adds a place for IMP-0009/IMP-0049 follow-up extractions (shared stderr buffering, shared abort handling).
- **Risk**: low — pure dedupe. The two `dispatchToolMessageRun` bodies match byte-for-byte except for the `cli_type` string; existing claude/codex tests would catch any regression.

### IMP-0143 · chrome_type_into — char-by-char keystroke typing into a selector with per-key delay (feat) · score: 4

- **Proposed by**: feature-scout · 2026-05-19
- **Status**: proposed
- **Why**: chrome_fill_or_select sets `el.value` instantly + dispatches one `input` event — anti-bot heuristics on LinkedIn / Tinder / Facebook search boxes flag the lack of keyboard cadence and skip suggestions / shadowban the session. chrome_keyboard fires keystrokes at the window (no focus-pin to the target element). chrome_paste pastes a single buffer. There is no primitive for "focus this input and type these N characters one keystroke at a time with realistic delay between keys" — exactly what humans look like and what the hard platforms expect for a typed search. Today the agent has to chain chrome_focus + N chrome_keyboard calls (and the delay between calls is the bridge round-trip, not human-shaped). One tool collapses N round-trips into one and surfaces realistic-cadence input as a first-class primitive.
- **Cost**: S
- **Value**: M
  5-file recipe. New `app/chrome-extension/entrypoints/background/tools/browser/type-into.ts`. Params: `{selector?, selectorType?, ref?, index?, text, perKeyDelayMs?: number (default 60, jitter ±30), pressEnter?: boolean, clearFirst?: boolean, tabId?, frameId?, actionabilityTimeoutMs?, force?}`. ISOLATED-world shim: resolves the target via the shared `_selector-resolve` helper; runs awaitActionable with the fill matrix (visible+enabled+editable); focuses; if clearFirst, dispatches Ctrl/Cmd+A + Delete via the CDP Input.dispatchKeyEvent (or contenteditable-aware Selection.removeAllRanges + execCommand("delete")); then for each char dispatches CDP Input.dispatchKeyEvent {type:"keyDown", text:char} → {type:"keyUp"} with sleep(perKeyDelayMs ± jitter). pressEnter sends an extra Enter at the end (works on search-box submit + multiline editors). Returns `{typed: N, finalValue?: string, pressedEnter, tabId}`. Reuses CDP attach via cdpSessionManager (debugger permission already granted). Pairs with chrome_pace (slow profile) for naturally-paced flows on hard platforms. Tests: arg validation, char-by-char delivery against jsdom-style mock, perKeyDelayMs honored, clearFirst clears existing value, pressEnter dispatches Enter, contenteditable target works, locked input returns NOT_ACTIONABLE, CDP_BUSY classification.

### IMP-0144 · chrome_har_export — emit captured network data as standard HAR 1.2 JSON (feat) · score: 4

- **Proposed by**: feature-scout · 2026-05-19
- **Status**: proposed
- **Why**: chrome_network_capture / chrome_intercept_response store rich per-request data (headers, status, timings, response bodies up to 1 MiB) but emit a custom JSON shape. Every external tool that consumes browser network data — Chrome DevTools "Save all as HAR", Charles Proxy import, Playwright trace viewer, Sentry session replay, har-validator-based test harnesses — expects HAR 1.2. Today the only way to get HAR is to save the trace via chrome_performance_stop_trace (heavy, full timeline) and post-process externally. A direct export from the same capture buffer that already exists gives the agent a one-call path to share a session's network with humans / external tools without the trace-recording overhead.
- **Cost**: S
- **Value**: M
  5-file recipe. New `app/chrome-extension/entrypoints/background/tools/browser/har-export.ts`. Multi-action enum because the network captures live in two backends (debugger + web-request — see IMP-0129): `export_from_active` (read whichever capture is currently running for the tab, format as HAR), `export_buffer` (params: serialized request array from a prior flush — useful when re-formatting), `save_to_downloads` (write the HAR JSON to ~/Downloads via chrome.downloads.download — returns the path so callers can attach it). HAR 1.2 shape: `{log: {version:"1.2", creator:{name:"humanchrome", version}, entries:[{startedDateTime, time, request:{method,url,httpVersion,headers,queryString,cookies,headersSize,bodySize,postData?}, response:{status,statusText,httpVersion,headers,cookies,content:{size,mimeType,text?,encoding?},redirectURL,headersSize,bodySize}, cache:{}, timings:{send,wait,receive,dns?,connect?,ssl?,blocked?}}]}}. Reuses the existing capture buffer — no new collection. Body sizes still honor the 1 MiB cap (truncation envelope on `content.comment`). Tests: shape validation against the JSON schema at http://www.softwareishard.com/har/viewer/, round-trip a known capture, save_to_downloads writes a file, empty buffer returns valid-empty HAR, redirect chain produces N entries in correct order. Read-only (mutates=false). Pairs nicely with IMP-0128 chrome_mock_response — agent can capture + export HAR to demonstrate intercept behavior to a human reviewer.

### IMP-0153 · chrome_focus rejects focusable elements with `pointer-events:none` as not_visible (bug) · score: 4

- **Proposed by**: bug-scout · 2026-05-19
- **Status**: done (2026-05-24; merged in PR #262 — dropped the pointer-events:none → not_visible check from focus.ts checkVisibleSync; pointer-events is a mouse-event gate that doesn't block programmatic focus)
- **Why**: focus.ts:240 inside `checkVisibleSync` returns `not_visible` when `getComputedStyle(target).pointerEvents === none`. But `pointer-events:none` is a _mouse-event_ gate — it does NOT prevent programmatic focus via element.focus(). Real-world hit: form pages that style read-only inputs with `pointer-events:none` (common pattern to discourage clicks during async validation) but still rely on Tab/click-elsewhere-then-focus flows. Calling `chrome_focus({selector:#styled-input})` returns NOT_ACTIONABLE failures:[not_visible] when the element is genuinely visible and programmatically focusable. Mirror: the click/fill path treats pointer-events:none as a true blocker because mouse events would not reach it — same check for focus is incorrect because focus does not flow through pointer events.
- **Cost**: S
- **Value**: S
- **Repro**: Render `<input id=x style=pointer-events:none value=hello>`. Call `chrome_focus({selector:#x})`. Returns `NOT_ACTIONABLE, failures:[not_visible]`. Expected: ok:true, focused:true (verify via `document.activeElement === input`). The pointer-events:none style is irrelevant to focus.\n- **Fix sketch**: In `app/chrome-extension/entrypoints/background/tools/browser/focus.ts:240`, drop the `if (style.pointerEvents === none) return not_visible;` line — the other 5 checks (isConnected/display/visibility/opacity/zero-rect) are correct for focus. Leave the actionability suite in `inject-scripts/actionability.js` untouched — that one IS correct for click/fill because those paths route through pointer events.\n- **Notes**: Playwrights `page.locator(...).focus()` doesnt enforce pointer-events at all; closest analog. Low value (S) because the workaround is `force:true`, but the surprise is sharp when an agent tries to fill a read-only-styled input after focus.

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

### IMP-0128 · chrome_mock_response — synthesize fake response bodies for matched URLs (extends intercept-response) (feat) · score: 3

- **Proposed by**: feature-scout · 2026-05-19
- **Status**: proposed
- **Why**: Today the network mock surface is binary: chrome_block_or_redirect can block or rewrite URLs to another URL, chrome_intercept_response only WAITS for a response. There is no way to let the page fire its real request and synthesize a fake JSON body in flight. Common need: testing the logged-in flow when the user is rate-limited and the real endpoint would 429 (return a fake 200); deterministic fixture replay; making a flow demoable when the back-end is down. Playwright route handlers + Cypress intercept fulfill cover this and humanchrome users have asked for it explicitly when porting from those tools.
- **Cost**: M
- **Value**: M
  Either a new chrome_mock_response tool OR a new action:register_mock on chrome_intercept_response (favor the latter to reuse the existing CDP attach + match/timeout machinery). Params: urlPattern (regex/substring like existing tool), method?, status (default 200), headers? (Record<string,string>), body? (string), bodyJson? (object — auto-serialized + content-type:application/json), delayMs? (artificial latency), once?: boolean (auto-unregister after first match — default true). Implementation: Fetch.enable + Fetch.requestPaused + Fetch.fulfillRequest from CDP (already wired in network-capture-debugger). Per-tab registry with stable handlerIds; chrome_intercept_response gains a sibling list_mocks and unregister_mock action. Same 1 MiB cap as IMP-0093. Pair with locator-handler (IMP-0101) for register-rule patterns. Files: app/chrome-extension/entrypoints/background/tools/browser/intercept-response.ts (extend), schema in tools.ts, tests. Audit log via console.warn includes handlerId + matched URL + response status for visibility.

### IMP-0130 · Split gif-recorder.ts 7-action switch into per-action handler modules (refactor) · score: 3

- **Proposed by**: optimization-scout · 2026-05-19
- **Status**: proposed
- **Why**: gif-recorder.ts is 1243 LoC; the `execute()` switch from line 630-1205 packs 7 distinct actions into ~575 LoC (start: 49 LoC, auto_start: 73 LoC, capture: 38 LoC, stop: 87 LoC, status: 25 LoC, clear: 61 LoC, export: 242 LoC). The 242-line export handler alone is bigger than most whole tools. Adding a new mode requires scrolling past 6 other concerns; bug-fixing one mode risks the others.
- **Cost**: M
- **Value**: M
- **Files**: `app/chrome-extension/entrypoints/background/tools/browser/gif-recorder.ts` (1243 LoC, single `GifRecorderTool` class spans line 616-1239). The class is already lazy-loaded (IMP-0056) so the win here is pure maintainability, not SW boot time.\n- **Action sizes (line ranges in `execute()`)**: `start` 631-679 (~49 LoC fixed-FPS recording), `auto_start` 680-752 (~73 LoC), `capture` 753-790 (~38 LoC), `stop` 791-877 (~87 LoC), `status` 878-902 (~25 LoC), `clear` 903-963 (~61 LoC), `export` 964-1205 (~242 LoC — by far the largest, includes cache lookup + ffmpeg-style transcoding + saveToPath fan-out + auto-cleanup).\n- **Sketch**: Mirror IMP-0054 pattern (computer.ts already done). Create `browser/gif-recorder/actions/{start,auto-start,capture,stop,status,clear,export}.ts`, each exporting `async function handle<Action>(args, ctx)` where `ctx = { resolveTargetTab, isRestrictedUrl, buildResponse, getRecordingStatus }`. `execute()` becomes `const HANDLERS = { start: handleStart, ... }` dispatch table (~25 LoC). The 200+-line export handler especially benefits — that one likely needs its own sub-split (cache-lookup, transcode, save-disposition).\n- **Risk**: Low. The actions are already independent — they only share the module-scope state (`activeRecordings`, `exportCache`, `EXPORT_CACHE_LIFETIME_MS`, `CDP_SESSION_KEY`). Pass that through a `RecorderContext` object. No runtime change; existing test coverage applies as-is since the public API is unchanged.\n- **Bonus**: post-split, the `gif-auto-capture.ts` sidecar (already extracted) becomes co-located with the auto_start handler, and the existing `gif-encoder.ts` offscreen calls collapse into a single place.

### IMP-0131 · Split doctor.ts collectDoctorReport into per-check modules (8 distinct checks, ~450 LoC) (refactor) · score: 3

- **Proposed by**: optimization-scout · 2026-05-19
- **Status**: proposed
- **Why**: doctor.ts is 1097 LoC and `collectDoctorReport` runs 8 distinct checks across lines 617-1062 (~445 LoC). Each check (installation, host.files, host.permissions, node.resolution, manifest, registry, port, logs) is independently testable but jammed into a single 445-line function. Splitting makes each check unit-testable without booting all the others, and reduces merge-conflict pressure when adding new checks (Linux setup verification, MV3 keepalive lock check, etc.).
- **Cost**: M
- **Value**: M
- **Files**: `app/native-server/src/scripts/doctor.ts` (1097 LoC). The function `collectDoctorReport` (line 617) is one of the top-3 longest functions in the native-server. Already section-banner-commented at lines 645/659/684/709/792/870/961/1026 — the cleanup is half-done; just needs extracting.\n- **Sketch**: Create `app/native-server/src/scripts/doctor/checks/` directory. One file per check (`installation.ts`, `host-files.ts`, `host-permissions.ts`, `node-resolution.ts`, `manifest.ts` (~78 LoC, longest), `windows-registry.ts` (~91 LoC), `port-config.ts` (~65 LoC), `logs-directory.ts` (~36 LoC)). Each exports `async function check<Name>(ctx: DoctorContext): Promise<DoctorCheckResult[]>`. `DoctorContext` packages `{packageName, packageVersion, distDir, wrapperPath, nodeScriptPath, logDir, stdioConfigPath, commandInfo, targetBrowsers, browsersToCheck}` once. `collectDoctorReport` becomes a ~50-line orchestrator that builds context, calls each check, accumulates results + nextSteps. The existing `attemptFixes` (`line 470`) and helpers (`resolveNodeCandidate`, `queryWindowsRegistryDefaultValue`, `readJsonFile`) stay in doctor.ts or move to `doctor/helpers.ts`.\n- **Risk**: Low. The checks have a clean dependency: they only read context + push to `checks[]`/`nextSteps[]`. Output JSON shape is unchanged so the existing doctor test (`app/native-server/src/scripts/doctor.test.ts`) gates the rewrite. The Windows-only registry check stays platform-gated by an `if (process.platform === "win32")` at the orchestrator level.\n- **Win**: Add a new check = one new file + one orchestrator line. Plus per-check unit tests become small + focused (especially the Linux/Mac branching that today sits inside the monolith).

### IMP-0133 · Lazy-load network-capture-web-request.ts (1084 LoC currently eager) — frees ~40-60 KB from SW boot (perf) · score: 3

- **Proposed by**: optimization-scout · 2026-05-19
- **Status**: proposed
- **Why**: network-capture-web-request.ts (1084 LoC) is statically imported in the eager dispatcher at tools/index.ts:73 + :179 — parsed on every SW boot even when nothing in the session ever calls `chrome_network_capture_start`. Its peer network-capture-debugger.ts (1116 LoC) was already lazied in IMP-0056. The blocker is one eager `chrome.tabs.onRemoved` listener installed at line 148 of the constructor; lift that out and the whole class lazies cleanly. Estimated savings: 40-60 KB off background.js (currently 760 KB).
- **Cost**: M
- **Value**: M
- **Files**: `app/chrome-extension/entrypoints/background/tools/browser/network-capture-web-request.ts` (1084 LoC). Eager-imported at `tools/index.ts:73-75` and instantiated at `:179`. The peer `network-capture-debugger.ts` (1116 LoC) is already lazy via `tools/index.ts:251-253`.
- **Side effect on import**: line 1083 `export const networkCaptureStartTool = new NetworkCaptureStartTool();` runs the constructor at SW boot, which at `:148` calls `chrome.tabs.onRemoved.addListener(this.handleTabRemoved.bind(this))`. That listener must fire even when no capture is active (so the per-tab cleanup paths stay correct if a tab is closed before a capture starts). This is the blocker for naive lazy.
- **Sketch**: Two clean options.
  1. **Listener-on-demand** (preferred): refactor so `handleTabRemoved` only matters when `captureData.has(tabId)`. The listener installs on first `execute({action:'start'})` call (idempotent via `if (this.listenersInstalled) return;`), uninstalls when `captureData.size === 0` post-stop. Frees the eager import — file becomes lazy via `lazyLoaders['chrome_network_capture_start'] = async () => (await import('./browser/network-capture-web-request')).networkCaptureStartTool`.
  2. **Module-side eager listener, lazy class body**: keep a tiny eager stub at `browser/network-capture-web-request-listener.ts` (~20 LoC) that owns the onRemoved subscription + a `Set<number>` of tabs-with-captures; the full class loads on first `execute()`. Same wire-up as IMP-0055/IMP-0057.
- **Bundle win**: per IMP-0056's accounting, network-capture-debugger.ts was a ~50-80 KB chunk in the eager bundle pre-IMP-0056. Web-request is similar size (1084 vs 1116 LoC, fewer CDP-attach paths, more chrome.webRequest listeners). Lazying it should drop SW boot by ~40-60 KB and parse time by 10-15 ms on cold start. Per IMP-0057 the SW dropped from 2168 KB to 612 KB — current background.js is 760 KB, so any 40+ KB reduction is meaningful.
- **Risk**: Medium for option 1 (listener-install timing must be ironclad — install before any chrome.tabs event that matters; the test `network-capture.test.ts` should cover both "start then close tab" and "close tab then start"). Low for option 2 (mechanical).
- **Test gate**: existing 28 tests across `network-capture.test.ts` + `network-capture-flush.test.ts` + `network-capture-status.test.ts` cover the listener lifecycle. Add 2 cases: "listener idempotent across start/stop/start" and "listener uninstalled when captureData empty" (option 1) or "eager stub forwards events to lazy class once loaded" (option 2). `lazy-tool-registry.test.ts` enforces the eager/lazy split — extend it to forbid `network-capture-web-request` in `eagerTools`.

### IMP-0145 · chrome_basic_auth — autoresponder for HTTP Basic / Digest auth prompts via CDP Fetch.continueWithAuth (feat) · score: 3

- **Proposed by**: feature-scout · 2026-05-19
- **Status**: proposed
- **Why**: Many internal corporate sites and staging environments sit behind HTTP Basic / Digest auth — the browser shows a native dialog that chrome_handle_dialog cannot answer (chrome_handle_dialog only handles JS dialogs from Page.javascriptDialogOpening, not the auth dialog from Fetch.authRequired). Today the only escape is to bake credentials into the URL ("https://user:pass@host/...") which most modern Chrome versions reject for security. Agents currently stall indefinitely on the first auth-protected page. CDP Fetch.requestPaused + authChallengeResponse gives a clean autoresponder; we already attach debugger for network-capture / intercept-response.
- **Cost**: M
- **Value**: M
  5-file recipe. New `app/chrome-extension/entrypoints/background/tools/browser/basic-auth.ts`. Multi-action enum mirroring chrome_handle_dialog: `register({tabId?, origin: "https://example.com" or "*", username, password, scheme?: "basic"|"digest"|"any" (default any)})` — installs Fetch.enable with handleAuthRequests:true and stores the credential keyed by origin (per-tab registry to avoid leaking creds across tabs); `unregister({tabId?, origin})`; `list({tabId?})` returns the registered origins WITHOUT passwords (returns `{origin, scheme, hasCredential:true}`) so callers can inspect coverage. On Fetch.authRequired the listener matches origin (exact host or wildcard), dispatches Fetch.continueWithAuth({authChallengeResponse:{response:"ProvideCredentials", username, password}}); unmatched challenges get "Default" (Chrome shows the native dialog as fallback). Per-tab CDP attach via cdpSessionManager with owner-tag "basic-auth"; refcount across multiple registers; cleanup on tabs.onRemoved + CLIENT_DISCONNECTED so creds don't outlive the session. Passwords stored in-memory only (never persisted to chrome.storage; never echoed in tool output / logs). Tests: arg validation, register+unregister roundtrip, two-origin matrix, unknown-origin falls through to Default, CDP_BUSY classification, cleanup on tab close, password redaction in error envelopes.

### IMP-0147 · Split gradient-control.ts (2583 LoC) — extract color-parser, gradient-parser, stop-model modules (refactor) · score: 3

- **Proposed by**: optimization-scout · 2026-05-19
- **Status**: proposed
- **Why**: `gradient-control.ts` is the single largest file in the extension at 2583 LoC and bundles 4 distinct concerns into one: RGBA color parsing/serialisation (10 functions, ~200 LoC), linear/radial gradient AST parsing (~600 LoC), stop-model reconciliation (~300 LoC), and the actual UI control creator (`createGradientControl`, ~1300 LoC). The color-parsing helpers are also re-implemented in `color-field.ts` and `effects-control.ts` — extracting them lets us dedupe.
- **Cost**: M
- **Value**: M
- **Files**: `app/chrome-extension/entrypoints/web-editor-v2/ui/property-panel/controls/gradient-control.ts` (2583 LoC). Sections labelled by `// =====` comments at lines 30 (Constants), 55 (Types), 131 (Stop helpers), 207 (Color helpers), 351 (Gradient parsers).
- **Sketch**:
  - New `controls/color-parsing.ts` ← `clampByte`, `toHexByte`, `rgbaToCss`, `parseHexColorToRgba`, `parseRgbChannel`, `parseAlphaChannel`, `parseRgbColorToRgba`, `lerpNumber`, `interpolateRgba` (~200 LoC). Reused by `color-field.ts` + `effects-control.ts`.
  - New `controls/gradient-parser.ts` ← `parseGradientFunctionCall`, `parseLinearGradient`, `parseRadialGradient`, `parseColorStop`, `normalizeStopPositions`, position/angle/percent token parsers (~600 LoC).
  - New `controls/gradient-stops.ts` ← `StopModel`, `createStopId`, `createDefaultStopModels`, `toStopModels`, `reconcileStopModels`, `toPreviewStops` (~150 LoC).
  - `gradient-control.ts` → keeps only `createGradientControl` + UI wiring (~1500 LoC, still large but coherent — UI is one concern).
- **Risk**: medium — parsers are tested via the gradient-control UI flow only; should add an explicit `gradient-parser.test.ts` during the split to lock the contract before moving. No runtime perf impact (same code paths, fewer files).

### IMP-0148 · Split effects-control.ts (2264 LoC) — drop or quarantine legacy variant, extract SVG icon factory + shadow parser (refactor) · score: 3

- **Proposed by**: optimization-scout · 2026-05-19
- **Status**: proposed
- **Why**: `effects-control.ts` ships two parallel implementations: `createLegacyEffectsControl` (lines 365-878, ~510 LoC) and `createEffectsControl` (lines 1311-end, ~950 LoC). Both are exported and both compile into web-editor-v2.js (450 KB). Plus the file inlines 5 SVG icon factories (~120 LoC of identical `createElementNS` boilerplate) that have no business in a property-panel control. Cutting the legacy + extracting icons removes ~700 LoC from the editor bundle.
- **Cost**: M
- **Value**: M
- **Files**: `app/chrome-extension/entrypoints/web-editor-v2/ui/property-panel/controls/effects-control.ts` (2264 LoC). Sections: lines 90-349 box-shadow/blur parsers (shared), 365-878 `createLegacyEffectsControl`, 902-1300 effect-model helpers + SVG icons, 1311+ `createEffectsControl`.
- **Sketch**:
  - Audit consumers — `grep createLegacyEffectsControl` should show whether it is still imported. If unused: delete outright. If used: move into a `legacy/` subfolder + add a sunset TODO.
  - New `controls/svg-icons.ts` ← `createSvgIcon`, `createPlusIcon`, `createTrashIcon`, `createAdjustIcon`, `createEyeIcon`, `createIconButton` (~120 LoC). Re-used by other controls that re-roll SVG.
  - New `controls/box-shadow-parser.ts` ← `parseBoxShadow`, `formatBoxShadow`, `upsertFirstShadow`, `findCssFunction`, `parseBlurRadius`, `upsertBlurFunction`, `normalizeLength` (~250 LoC). Pure functions, easily testable in isolation.
  - `effects-control.ts` → keeps only `createEffectsControl` + effect-model types (~900 LoC).
- **Risk**: low if legacy is unused (most likely — file comment says current version superseded it). If legacy is still wired somewhere unexpected, the import audit catches it before deletion. No runtime impact for the live path; bundle shrinks proportional to legacy size.

### IMP-0149 · Extract ClaudeEngine.initializeAndRun stream-event handlers (~600 LoC of nested switches) — sibling to IMP-0009 (refactor) · score: 3

- **Proposed by**: optimization-scout · 2026-05-19
- **Status**: proposed
- **Why**: Even after the IMP-0009 sub-method split lands, `claude.ts` initializeAndRun (lines 129-1022, ~900 LoC) holds 4 large closures and a 200-line `switch(eventType)` plus a 200-line `switch(message.type)`. The closures (`emitAssistant`, `inferActionFromToolName`, `buildToolMetadata`, `cleanupTempFiles`) close over the per-run state by reference but only the per-run state — they can become free functions taking a `RunState` arg. That alone collapses the method to ~250 LoC and makes each branch unit-testable.
- **Cost**: M
- **Value**: M
- **Files**: `app/native-server/src/agent/engines/claude.ts` (1733 LoC; initializeAndRun body 129-1022; switches inside at 529-693 stream_event, 694-1022 message-type).
- **Sketch**:
  - `RunState` interface (~10 fields: assistantBuffer, assistantMessageId, lastAssistantEmitted, pendingToolInputs, tempFiles, etc.) — concrete object passed to free helpers.
  - New `claude/stream-event-handlers.ts` ← 6 free functions: `handleMessageStart`, `handleContentBlockStart`, `handleContentBlockStop`, `handleContentBlockDelta`, `handleMessageStop`, plus `inferActionFromToolName` + `buildToolMetadata` (TOOL_NAME_ACTION_MAP and pattern-matching, pure functions today).
  - New `claude/message-type-handlers.ts` ← `handleAssistantMessage`, `handleResultMessage`, `handleSystemMessage`, `handleUserMessage` (each currently a ~50-100 LoC switch arm).
  - `claude/tool-dispatch.ts` ← `emitAssistant`, the existing `dispatchToolMessageRun` (or moved to base.ts per IMP-0141).
  - initializeAndRun becomes: build state + queryOptions, then a small `for await` loop that delegates to the helpers.
- **Risk**: medium — heavy refactor of the streaming hot path. Mitigations: keep the helpers as plain TS functions in same package; existing integration tests (`claude.engine.test.ts` if present, plus the agent route tests) exercise the full streaming flow. Should land as 3-4 slices like IMP-0019 did for semantic-similarity-engine. Pair with IMP-0141 (extract base class) so the helpers can live next to similar codex helpers.

### IMP-0087 · Same-tab queueing — fairness, depth cap, per-call timeout, inspect tool (feat) · score: 2

- **Proposed by**: user · 2026-05-16
- **Status**: done (2026-05-16)
- **Why**: After IMP-0086 same-tab contention is rare but opaque when it does happen. `utils/tab-lock.ts` is a single anonymous `Promise<void>` chain per `tabId` — no waiter accounting, no fairness, no upper bound on queue depth, no way to inspect contention from outside. A misbehaving client looping on a shared tab starves a polite one behind it (pure FIFO), and a per-call timeout cannot be tuned without changing the global default.
- **Cost**: L
- **Value**: M

- **Files**: `app/chrome-extension/entrypoints/background/utils/tab-lock.ts` (rewrite as `tab-queue.ts` with re-export shim), `app/chrome-extension/entrypoints/background/tools/index.ts`, `app/chrome-extension/entrypoints/background/tools/browser/queue-inspect.ts` (new), `packages/shared/src/{tools,error-codes}.ts`, dispatcher + tab-queue tests.
- **Sketch**: Replace anonymous `Map<tabId, Promise>` with `QueueEntry`-based queue carrying ticket / clientId / enqueuedAt / start / cancel / startedAt. Round-robin fairness across clients (one mutating call per client per round-trip on a contested tab). New `QUEUE_FULL` error code with a depth cap. Per-call `tabLockTimeoutMs` opt-in on the dispatcher. New `chrome_queue_inspect` tool returning per-tab snapshots + EWMA wait estimates. Same `TAB_LOCK_TIMEOUT` semantics preserved.
- **Notes**: Long-form plan at `~/.claude/plans/imp0087sametabqueueing.md`. Largest of the IMP-0086 follow-ups — deserves its own branch and a fresh planning pass before execution.

### IMP-0089 · `force: true` override on `browser_claim_tab` to seize an owned tab (feat) · score: 2

- **Proposed by**: user · 2026-05-16
- **Status**: done (2026-05-16)
- **Why**: `browser_claim_tab` refuses to claim a tab owned by another client and returns `TAB_NOT_OWNED`. Safe default — but when the owning client is dead and `CLIENT_DISCONNECTED` never fires (native-host crash, transport hang, manual hand-off between operator-driven sessions), there's no escape hatch short of restarting the extension or waiting out the 30-min `STALE_AFTER_MS` GC. `force: true` is the explicit override.
- **Cost**: S
- **Value**: S

- **Files**: `packages/shared/src/tools.ts` (schema), `app/chrome-extension/entrypoints/background/tools/browser/claim-tab.ts` (gate + audit log), `app/chrome-extension/tests/tools/browser/claim-tab.test.ts`, `docs/TOOLS.md` (regen).
- **Sketch**: Add `force?: boolean` to the schema with a description that warns against habitual use. When true, the tool skips the existing `TAB_NOT_OWNED` short-circuit and delegates straight to `claimTabForClient`, which already evicts the prior owner. Emit a `console.warn`-level audit line including `{tabId, oldOwner, newOwner}` so contention stays visible. Dispatcher's per-call ownership gate is **not** touched — callers must claim with `force:true`, then issue mutating calls (two-step is the audit trail).
- **Notes**: Long-form plan at `~/.claude/plans/imp0089claimtabforce.md`. Smallest of the IMP-0086 follow-ups; recommended first up.

### IMP-0121 · `/mcp` POST race vs fastify auto-respond — ERR_HTTP_HEADERS_SENT spam (bug) · score: 2

- **Proposed by**: claude · 2026-05-17 (observed in daemon stderr log: 175 738 stack traces in ~3h; 91 MB of log spam; 15 stuck `transportsMap` entries cleared on first `/admin/reset` probe)
- **Status**: done (2026-05-17; `server/index.ts` now calls `reply.hijack()` BEFORE handing `reply.raw` to every MCP transport (`/sse`, `/messages`, `/mcp` POST/GET/DELETE) via a new `runHijacked(reply, fn)` helper that also provides a uniform raw-mode error tail. Root cause: the MCP SDK's `StreamableHTTPServerTransport.handleRequest` writes the response via `@hono/node-server` directly on the underlying `ServerResponse`; without `hijack()` fastify's post-handler auto-send fires a second `writeHead` → `ERR_HTTP_HEADERS_SENT` storms at ~10/sec. Coverage: `src/server/mcp-hijack.contract.test.ts` asserts the fixed-path round-trip; existing `server.test.ts` T7 multi-client smoke regresses if hijack is removed. Also: proactive `listInstances()` sweep on bridge startup so stale registry entries don't linger until the next consumer reads.)

### IMP-0146 · chrome_set_checked — idempotent checkbox / radio state set via selector (feat) · score: 2

- **Proposed by**: feature-scout · 2026-05-19
- **Status**: proposed
- **Why**: Setting a checkbox or radio to a specific state is one of the most common interaction patterns in form workflows, but every existing tool requires a guess about current state: chrome_fill_or_select with value:true/false works for some custom toggles but not native checkboxes (no `change` cascade); chrome_click toggles regardless of intended state (idempotency requires reading state first); chrome_javascript with `el.checked = true` skips React/Vue handlers. Playwright exposes locator.check() and locator.setChecked() as one-call idempotent primitives — the agent says "I want this checked" and the runtime makes it so, returning the prior state. Saves a read-then-click round-trip and removes the "what if I clicked it twice" ambiguity, which matters on LinkedIn/Facebook settings pages where toggles can race the page.
- **Cost**: S
- **Value**: S
  5-file recipe. New `app/chrome-extension/entrypoints/background/tools/browser/set-checked.ts`. Params: `{selector?, selectorType?, ref?, index?, multi?, checked: boolean, tabId?, frameId?, actionabilityTimeoutMs?, force?}`. ISOLATED-world shim: resolves the target via shared `_selector-resolve`; verifies the element is a checkable (input[type=checkbox]|input[type=radio]|[role=checkbox]|[role=radio]|[role=switch]) and returns INVALID_ARGS otherwise with details.tagName/role for diagnostics; runs awaitActionable with the click matrix (visible+stable+enabled+hit-test); compares current `element.checked` (or aria-checked for role-based) to requested `checked` — no-op if already matched (returns `{checked: true, changed: false, priorChecked, tabId}`); otherwise dispatches a native click via the existing click-helper (so React/Vue onChange fires; respects framework controlled-component reconciliation) and verifies post-click state; returns `{checked: true, changed, priorChecked, tabId}`. For radio groups, checking sets the target and uncheck of the prior sibling is the browser default — no extra logic. multi:true applies to each match. Pairs with chrome_assert(kind:js) for state verification across complex toggle UIs. Tests: native checkbox check/uncheck/idempotent, radio group set, ARIA role=switch via space-key, already-checked no-op, disabled returns NOT_ACTIONABLE, non-checkable element returns INVALID_ARGS, multi:true batch.

## Done

### IMP-0169 · Multi-tab Phase 4a — browser_alias_tab + per-client ClientState.aliases (feat) · score: 5

- **Proposed by**: claude · 2026-05-24 (multi-tab-by-design rollout, Phase 4a)
- **Status**: done
- **Completed**: 2026-05-24
- **Summary**: New tool `browser_alias_tab({tabId?, alias})` lets a client name an owned tab so subsequent tool calls can target it by name. Aliases live in `ClientState.aliases: Map<string, number>` (added to `utils/client-state.ts`), persisted to `chrome.storage.session` alongside ownedTabs, validated against `ALIAS_REGEX = /^[a-z][a-z0-9_-]{0,31}$/`. Per-client by design (alice's `'checkout'` is not bob's). Self-evict in `chrome.tabs.onRemoved` and `_handleTabRemovedForTests`. Don't survive `releaseClient` (client-scoped, per the plan). Reusing an alias overwrites and returns `previousTabId` in the response. New `resolveAliasForClient` / `setAliasForClient` / `listAliasesForClient` helpers. Tool gates: requires clientId on request context (INVALID_ARGS otherwise); validates alias regex (INVALID_ARGS); defaults tabId to activeTabId (INVALID_ARGS if neither resolvable); rejects cross-client tabs with TAB_NOT_OWNED. Standard 5-file recipe + 11 contract tests at `tests/tools/browser/alias-tab.test.ts`. docs/TOOLS.md regenerated. Gate: 19/19 vitest pass; tsc + lint clean.
- **Why**: Phase 4a of the multi-tab-by-design rollout. The tool ships now so callers can start naming tabs; the matching `tabAlias?` arg on every browser tool — the actual "drive 3 tabs in parallel by name" workflow — lands in a follow-up Phase 4b PR that touches the dispatcher.
- **Cost**: M
- **Value**: M

### IMP-0168 · Multi-tab Phase 6b — chrome_owned_tabs tool (feat) · score: 4

- **Proposed by**: claude · 2026-05-24 (multi-tab-by-design rollout, Phase 6b)
- **Status**: done
- **Completed**: 2026-05-24
- **Summary**: New tool `chrome_owned_tabs` returns the tabs currently owned by the calling MCP client (or UI surface). Distinct from `chrome_get_windows_and_tabs` (whole-browser catalog with owner column) — `chrome_owned_tabs` answers the narrower "what does THIS client own" question with one flat array, refreshed metadata, and an `isPinnedActive` flag marking the dispatcher's `activeTabId`. Optional `tabId` arg filters to one row for "is this still mine?" checks. Powers the "Tabs owned by this client" panel that lives in the popup/sidepanel UIs (next IMP). Read-only (no `mutates`); `autoSpawnTab=false` so a fresh client with no claims gets `{count:0, ownedTabs:[]}` instead of an unexpected blank tab. Standard 5-file recipe per CLAUDE.md: tool at `tools/browser/owned-tabs.ts`, registry/schema/category in `packages/shared/src/tools.ts` (append-only), barrel + dispatcher in `tools/browser/index.ts` + `tools/index.ts`, 7 tests in `tests/tools/browser/owned-tabs.test.ts` (INVALID_ARGS without context, empty for new client, rows with metadata, `isPinnedActive`, tabId filter, skip-closed-tabs, cross-client isolation, sort order). docs/TOOLS.md regenerated. Gate: 16/16 (owned-tabs + lazy-tool-registry) pass; tsc + lint clean.
- **Why**: Phase 6b of the multi-tab-by-design rollout. The panel in the next IMP needs this tool to render. Also useful standalone for MCP clients introspecting their own ownership state without parsing the whole-browser tree.
- **Cost**: S
- **Value**: M

### IMP-0167 · Multi-tab Phase 6a — per-window UI clientId stamping (feat) · score: 4

- **Proposed by**: claude · 2026-05-24 (multi-tab-by-design rollout, Phase 6a)
- **Status**: done
- **Completed**: 2026-05-24
- **Summary**: `stampUiClientId` in `app/chrome-extension/entrypoints/background/native-host.ts` now suffixes each surface tag (`__ui:popup` / `__ui:sidepanel` / `__ui:options` / `__ui:quickpanel`) with the originating windowId — so a popup opened in Chrome window 42 stamps `__ui:popup:42` instead of bare `__ui:popup`. Pre-fix every popup in every window shared one ownership lane; two popups in different windows fought over the same owned-tab set. Resolution order: `sender.tab?.windowId` (content-script messages) → `chrome.windows.getLastFocused({windowTypes:['normal']})` (popup/sidepanel/options pages aren't tabs) → `:0` fallback so the format stays parseable. The `__ui:` prefix is still reserved by `normalizeSessionName` (`session-name.ts:33`) so the appended windowId doesn't open a back-door for MCP clients to claim a UI lane. Function became async; callsite at native-host.ts:704 chains through the new Promise without touching sendResponse semantics. 6 new contract tests at `tests/native-host/stamp-ui-clientid.contract.test.ts` cover: tab-bearing sender, lastFocused fallback, every surface (popup/sidepanel/options/quickpanel), windowId-unavailable :0 fallback, unknown surface. Gate: 6/6 stamp tests + 22/22 dispatcher tests pass; tsc + lint clean.
- **Why**: Phase 6a of the multi-tab-by-design rollout. Foundation for the "Tabs owned by this client" panel (IMP-0170) — each popup window will show its own owned tabs instead of one global set.
- **Cost**: S
- **Value**: M

### IMP-0166 · Multi-tab Phase 5b — gif-recorder cross-client ownership gate (refactor) · score: 4

- **Proposed by**: claude · 2026-05-24 (multi-tab-by-design rollout, Phase 5b)
- **Status**: done
- **Completed**: 2026-05-24
- **Summary**: Added a cross-client ownership gate to `app/chrome-extension/entrypoints/background/tools/browser/gif-recorder.ts`. The gif recorder is genuinely singleton (one CDP screencast per Chrome at a time), so per-client de-singleton like IMP-0165 doesn't apply. Instead: `startRecording` now stamps `currentRecordingClientId` from `getCurrentRequestContext()?.clientId`, and a second client trying to start gets `error: Recording already in progress (owned by client X)` — the message names the owning client so the second caller knows who to coordinate with. `stopRecording` rejects non-owners with `error: Recording owned by client X; client Y cannot stop it`. The `__system` bucket (used by internal cleanup paths like tab-close auto-stop) is allowed to bypass the gate so legacy paths still work. Ownership is cleared on stop, on start-failure rollback, and via the test seam `_setRecordingOwnerForTest`/`_resetRecordingOwnerForTest`. 5 new contract tests at `tests/tools/browser/gif-recorder-ownership.contract.test.ts` cover: start-reject by owner id; system-bucket as owner; stop-reject by non-owner; system-bucket bypass; reset-clears-stamp. Cross-client `lastRecordedGif` cache split is deferred to a follow-up — it's bounded by the 5-minute EXPORT_CACHE_LIFETIME_MS and strictly less impactful than the cross-client collision this gate prevents. Gate: 962/962 vitest pass; tsc + lint clean.
- **Why**: Phase 5b of the multi-tab-by-design rollout. Together with IMP-0165 (v2 recorder per-client), neither recording surface silently collides between MCP clients.
- **Cost**: S
- **Value**: M

### IMP-0165 · Multi-tab Phase 5a — recorder per-client sessions (de-singleton v2 RecordingSessionManager) (refactor) · score: 5

- **Proposed by**: claude · 2026-05-24 (multi-tab-by-design rollout, Phase 5a)
- **Status**: done
- **Completed**: 2026-05-24
- **Summary**: De-singletoned `app/chrome-extension/entrypoints/background/record-replay/recording/session-manager.ts`. Pre-fix `recordingSession` was a single module-scope `new RecordingSessionManager()` instance shared across the extension — two MCP clients calling the recorder concurrently would clobber each other's `originTabId` / `flow` / `activeTabs` / `status`. Now: a `Map<clientId, RecordingSessionManager>` plus a Proxy at the module boundary that routes property access to the caller's manager via `getCurrentRequestContext()?.clientId`. The 14+ callsites in `recorder-manager.ts`, `flow-builder.ts`, and `record-replay/index.ts` keep the same import surface — zero changes outside `session-manager.ts`. Callers without a request context (content-script step messages, tab event handlers, recorder-manager bootstrap) fall back to a `__system` bucket so legacy single-client behavior is preserved. Per-tab exclusivity across clients (the `RECORDING_IN_PROGRESS` error from the plan) is deferred to a follow-up — this PR is "de-singleton, don't regress" — and is documented at the top of the new per-client section. 7 new contract tests at `tests/record-replay/recording-isolation.contract.test.ts` lock in: two clients get distinct manager instances, idempotent lookup per clientId, Proxy routes based on request context, A-stopping doesn't affect B, system-bucket fallback works, `_resetRecordingSessionsForTest` clears all managers, every RecordingSessionManager method is reachable through the Proxy. Full gate: 964/964 pass (tools + utils + record-replay); tsc clean; pnpm e2e:isolated 16/16 PASS on the migrated build.
- **Why**: Phase 5a of the multi-tab-by-design rollout. Foundation for IMP-0166 (gif-recorder de-singleton — same pattern, can copy the Proxy approach) and for the eventual cross-client recording exclusivity check.
- **Cost**: S
- **Value**: M

### IMP-0164 · Multi-tab Phase 3 — migrate 6 module-scope registries onto OwnedRegistry (refactor) · score: 6

- **Proposed by**: claude · 2026-05-24 (multi-tab-by-design rollout, Phase 3 Registries)
- **Status**: done
- **Completed**: 2026-05-24
- **Summary**: Migrated 6 module-scope `Map<tabId, V>` registries onto the `OwnedRegistry` helper added in IMP-0158, so they all share one auto-eviction story instead of each tool re-implementing its own tab-close listener. Files: `inject-script.ts` (`injectedTabs`), `userscript.ts` (`activeInjections`), `locator-handler.ts` (`tabHandlers`), `dialog.ts` (`defaults` — onEvict tears down the CDP onEvent listener + detach), `gif-auto-capture.ts` (`tabStates`), `performance.ts` (`sessions` + `LAST_RESULTS`). For dialog defaults the explicit listener-remove + detach in `clearDefaultForTab` / `register_default`'s replace branch / external-detach handler all became redundant once `onEvict` owns the lifecycle — net diff is smaller than the raw migration delta. Eviction policy decisions per the plan: `inject-script` is per-client (uses `getCurrentRequestContext` for the clientId); the other 5 route all entries through the system bucket because they're page-scoped behaviors where per-client distinction adds no value (dialog handler can only respond once per dialog; locator handlers / userscripts / gif-auto-capture / perf traces are page-scoped state). Removed 4 standalone `chrome.tabs.onRemoved` listeners (inject-script, locator-handler, dialog, gif-auto-capture's was implicit) — OwnedRegistry self-subscribes once on creation. Closes a class of leaks: closed tabs used to leak entries in gif-auto-capture and performance because neither had a tab-close listener at all. Full focused gate: 831/831 vitest pass; tsc clean; `pnpm e2e:isolated` 16/16 PASS in 3 min on the migrated build.
- **Why**: Phase 3 of the multi-tab-by-design rollout. Foundation for Phase 5 (CDP per-client owner tags / event fan-out) — once the registry pattern is in place, the CDP work can adopt the same primitive without re-deriving the eviction contract. Also fixes the leaks where closed tabs left dangling state in gif-auto-capture and performance registries.
- **Cost**: M
- **Value**: M

### IMP-0161 · Multi-tab Phase 2 — ratchet test banning direct chrome.tabs.query in tools/browser (test) · score: 5

- **Proposed by**: claude · 2026-05-23 (multi-tab-by-design rollout, Phase 2 Tool Migrations — completes Phase 2)
- **Status**: done
- **Completed**: 2026-05-23
- **Summary**: New contract test at `tests/tools/contract-no-direct-tab-query.test.ts` walks `entrypoints/background/tools/browser/**/*.ts` and fails if any file matches `chrome.tabs.query({...active:true...})` or `chrome.tabs.query({...currentWindow:true...})` outside a small allowlist (`window.ts`, `close-tabs-matching.ts`, `close-my-tabs.ts`, `claim-tab.ts` — each annotated with its one-line justification). Second test checks the allowlist for stale entries — if an allowlisted file is renamed away, the test fails so the entry can't shadow a future violation. Verified the ratchet catches additions by adding a temporary file under `tools/browser/` containing the forbidden call — the test failed; after removal, green. Drift guard for IMP-0162 and beyond: any future refactor that re-introduces an implicit active-tab path in `tools/browser/` will be caught at CI time, not in production.
- **Why**: Completes Phase 2 of the multi-tab-by-design rollout. With IMP-0156 → IMP-0161 landed, every browser-tool active-tab fallback now honors the calling client's owned set (IMP-0086), and the ratchet ensures no future PR can silently regress it. Unblocks Phase 3 (CDP per-client owner tags + event fan-out) and Phase 4 (tab aliasing + parallel dispatch).
- **Cost**: S
- **Value**: M

### IMP-0160 · Multi-tab Phase 2 — migrate 7 mutating tools off direct chrome.tabs.query (batch 2/2) (refactor) · score: 6

- **Proposed by**: claude · 2026-05-23 (multi-tab-by-design rollout, Phase 2 Tool Migrations)
- **Status**: done
- **Completed**: 2026-05-23
- **Summary**: Converted 12 active-tab fallback sites across 7 tools to `this.getOwnedTab({ isRead: true, required: false })` (IMP-0157). Files: `inject-script.ts:172` (InjectScriptTool active-tab fallback) and `:254` (RemoveInjectedScriptTool fallback), `performance.ts:162/262/364` (Start/Stop/AnalyzeInsight), `network-capture.ts:276` (unified flush primary-tab selection), `network-capture-debugger.ts:902` (start) and `:1011` (stop), `network-capture-web-request.ts:912` (start) and `:999` (stop), `common.ts:846` (CloseTabsTool empty-args close). These are the load-bearing mutating call sites where the dispatcher pre-stamps `tabId` for anonymous calls — the fallback only fires when callers explicitly clear `tabId`. Behavior preserved for the single-tab case. Updated two test files to thread request-context: `performance.test.ts` (replaced `chrome.tabs.query` mock with `claimTabForClient` + `runWithContext`; uses dynamic re-imports of `request-context` and `client-state` post-`vi.resetModules()` so the test client and tool share the same singleton — 7/7 pass), `network-capture-flush.test.ts` (one test seeded an owned tab + ran inside client context — 20/20 pass). Focused gate 116/116 pass; `tsc --noEmit` clean.
- **Why**: With both batches landed, every active-tab fallback in `tools/browser/` either honors client ownership or is a `query-by-URL`/`query-all` (non-implicit-active) path. Unblocks IMP-0161 (contract test banning direct `chrome.tabs.query({active,currentWindow})` in `tools/browser/`).
- **Cost**: M
- **Value**: M

### IMP-0159 · Multi-tab Phase 2 — migrate 5 tools off direct chrome.tabs.query (batch 1/2) (refactor) · score: 5

- **Proposed by**: claude · 2026-05-23 (multi-tab-by-design rollout, Phase 2 Tool Migrations)
- **Status**: done
- **Completed**: 2026-05-23
- **Summary**: Converted the implicit active-tab fallback in 5 tools to `this.getOwnedTab({ isRead: true, required: false })` (the helper added in IMP-0157). Each callsite previously called `chrome.tabs.query({active:true,currentWindow:true})` directly, which bypasses per-client ownership (IMP-0086) and could land a read on another client's tab when the calling client had its own owned set. Files: `console.ts:262` (active-tab fallback when neither `tabId` nor `url` provided), `web-fetcher.ts:121-124` (web-fetcher fallback) and `:342` (`GetInteractiveElementsTool` body), `bookmark.ts:395-396` (bookmark URL inference), `network-request.ts:42` (target tab for in-page fetch), `userscript.ts` (deleted the module-scope `getActiveTab()` helper and routed its 3 callsites through `this.getOwnedTab` directly — `:477` create, `:716` delete cleanup, `:738` sendCommand). Behavior preserved: when the caller has an owned tab, the call lands there; when they don't, the response is identical (`No active tab found` / `TAB_NOT_FOUND`). The remaining `chrome.tabs.query` calls in these files are not active-tab fallbacks (`console.ts:418` queries by URL for tab navigation, `tab-groups.ts:216` queries by groupId, `history.ts:183` queries all tabs to dedupe, `web-fetcher.ts:107` queries all for URL match) and stay. Focused vitest gate 65/65 pass; `tsc --noEmit` clean. Full suite background-run: 1671/1691 pass + 19 skipped + 1 unrelated flake on `wait-helper.test.ts > waitFor (text-presence)` that passes in isolation (pre-existing timing-under-load).
- **Why**: Canary batch for the bulk tool migration ahead of the IMP-0161 contract ban. Read-only first so a wrong resolution surfaces as a query mismatch instead of a state mutation. Unblocks IMP-0160 (mutating-tool batch).
- **Cost**: S
- **Value**: M

### IMP-0158 · Multi-tab Phase 1 — introduce OwnedRegistry helper for (clientId, tabId)-keyed module state (feat) · score: 5

- **Proposed by**: claude · 2026-05-23 (multi-tab-by-design rollout, Phase 1 Foundations)
- **Status**: done
- **Completed**: 2026-05-23
- **Summary**: New `app/chrome-extension/entrypoints/background/utils/owned-registry.ts` exports `createOwnedRegistry<V>()` returning a registry keyed by `(clientId, tabId)` instead of the `Map<tabId, V>` shape that six tools currently use. Internally a `Map<string, Map<number, V>>` so `forgetClient` is O(1) and `forgetTab` walks one shallow dimension. Self-registers two evictions: `chrome.tabs.onRemoved` and a new `subscribeOnClientReleased` hook on `utils/client-state.ts` invoked from `releaseClient`. Consumers can pass an `onEvict(entry)` callback for per-entry teardown (CDP detach, injection cancel, recorder stop) — errors swallowed so one bad teardown can't block the rest. `skipAutoSubscribe` is a test escape hatch. Undefined/empty clientId routes to a reserved `__system` bucket (exported as `OWNED_REGISTRY_SYSTEM_CLIENT`) for callsites with no request context. 9 unit tests cover isolation, eviction paths, system bucket, dispose, and onEvict error tolerance. Ships with zero callers — IMP-0162 migrates inject-script, userscript, locator-handler, dialog, gif-auto-capture, performance, and the three network-capture variants onto it.
- **Why**: Without this primitive, the IMP-0162 registry migration becomes a 6-tool atomic conversion at ~600 LoC. Landing the helper first lets IMP-0162 be reviewed against a stable, tested abstraction. The `subscribeOnClientReleased` hook in `client-state.ts` is reusable beyond registries — recorder de-singleton (IMP-0165) and gif-recorder de-singleton (IMP-0166) consume it too.
- **Cost**: S
- **Value**: M

### IMP-0157 · Multi-tab Phase 1 — add client-aware getOwnedTab helper to BaseBrowserToolExecutor (feat) · score: 6

- **Proposed by**: claude · 2026-05-23 (multi-tab-by-design rollout, Phase 1 Foundations)
- **Status**: done
- **Completed**: 2026-05-23
- **Summary**: Added `protected async getOwnedTab(opts?)` to `BaseBrowserToolExecutor` (`app/chrome-extension/entrypoints/background/tools/base-browser.ts`). Reads `clientId` from `getCurrentRequestContext()` (no signature change on `execute` so the ~60 subclasses don't have to migrate at once) and delegates to `resolveOwnedTabIdForClient` from `utils/client-state.ts:364` — same priority the dispatcher uses (explicit → activeTabId → most-recently-inserted owned). Conflicts become `TAB_NOT_OWNED`; missing tabs become `TAB_NOT_FOUND` with `details.reason ∈ {'no-owned-tab','closed','window-mismatch'}`. `opts.windowId` filters the *picked* tab — never re-queries `chrome.tabs.query({active:true})`, which is the implicit-global-tab path this helper exists to replace. `opts.required: false` returns `null` instead of throwing. `getActiveTabOrThrow` / `getActiveTabInWindow` / `getActiveTabOrThrowInWindow` stay in place with `@deprecated` JSDoc pointing at `getOwnedTab` and IMP-0169 (deletion). 8 new vitest cases in `tests/tools/base-browser-getOwnedTab.test.ts` cover the resolution priority, conflict, isRead bypass, missing tab, closed tab, window-mismatch, required=false, and no-context paths. Full tools vitest 747/747 pass; `tsc --noEmit` clean.
- **Why**: Side-by-side prerequisite for the bulk tool-migration PRs (IMP-0159, IMP-0160). Hard renaming the helpers would force a 25-tool atomic conversion. Adding the new helper first lets each migration PR pick its own batch and lands the `chrome.tabs.query` ban (IMP-0161) after the bulk is done.
- **Cost**: S
- **Value**: M

### IMP-0156 · Multi-tab Phase 1 — close IMP-0151 + IMP-0154 + add tools-static-flags contract test (chore) · score: 6

- **Proposed by**: claude · 2026-05-23 (first PR of the multi-tab-by-design rollout)
- **Status**: done
- **Completed**: 2026-05-23
- **Summary**: Set `static readonly mutates = true` on `InjectScriptTool` + `SendCommandToInjectScriptTool` (closes IMP-0151 — anonymous inject calls now go through the dispatcher's IMP-0086 ownership + auto-spawn path instead of landing on the globally-active tab). Set `static readonly autoSpawnTab = false` on `ClipboardTool`, `NotificationsTool`, `AlarmsTool`, `ActionBadgeTool`, `KeepAwakeTool` (closes IMP-0154 — first anonymous call to these tab-less tools no longer silently spawns a blank `about:blank` tab). New contract test at `tests/tools/tools-static-flags.contract.test.ts` (8 cases) locks in both fixes and adds a forward guard against the same class of regression. Test imports `@/entrypoints/background/tools` first to avoid a circular load through `native-host.ts` when the barrel pulls in individual tool singletons. Full vitest gate: tools-static-flags + lazy-tool-registry + dispatcher-auto-spawn + dispatcher-tab-queueing + inject-script + clipboard + alarms + action-badge + notifications + keep-awake = 82 pass; `tsc --noEmit` clean.
- **Why**: First step of the multi-tab-by-design rollout (`/Users/mike/.claude/plans/how-can-we-make-sleepy-treehouse.md`). Phase 1 lays the foundation by fixing the two existing flag-drift bugs that would otherwise produce false-positive dispatcher matrix results in later phases. The contract test is the ratchet that future PRs in the rollout depend on.
- **Cost**: S
- **Value**: M

### IMP-0155 · Matrix runner regression — actionability deadline not honored on the sliding-btn fixture (bug) · score: 7

- **Proposed by**: claude-loop · 2026-05-19 (matrix evidence from IMP-0139 verification)
- **Status**: done
- **Completed**: 2026-05-19
- **Summary**: Plumbed the outer `awaitActionable` deadline into the two inner blocking sub-calls so the worst-case wall-time stops being unbounded against `infinite alternate` animations. (1) `checkStable(el, deadline)` now accepts an absolute Date.now() ceiling; both branches of its setTimeout chain (the gap between samples AND the equality test inside takeSample) check `Date.now() >= deadline` before scheduling/continuing, resolving `unstable_bbox` on expiry — the fail-closed answer that's safe whenever `hasActiveAnimation` already reported running motion. The previous code resolved unconditionally at REQUIRED_SAMPLES × STABILITY_SAMPLE_MS = 200ms, so the outer loop only checked the deadline once per ~250ms iteration and a `timeoutMs` shorter than the sampler window could not bail mid-sample. (2) New `waitOneFrameOrDeadline(deadline)` replaces the unconditional `waitOneFrame()` in the scroll-recovery branch: races `requestAnimationFrame` against `setTimeout(remaining)` so background-tab throttling can't stretch a single rAF tick past the outer budget. (3) The 50ms inter-iteration sleep at the bottom of the outer loop now clips to `min(50, remaining)` and short-circuits when `remaining <= 0` so the outer loop never overshoots its own deadline. Deliberately did NOT add a "deadline expired → push unstable_bbox" guard around the stability sub-call in the outer loop because it mis-classified static-but-occluded elements as unstable_bbox when an earlier iteration burned the budget — the existing fast-path `if (!hasActiveAnimation(el)) return Promise.resolve(null)` correctly returns instantly for static targets without touching the deadline. Added 3 new vitest cases to `tests/inject-scripts/actionability.test.ts` (bringing the file from 36 to 39): "bails with unstable_bbox when the deadline expires inside the sampler" (verifies the sampler bails before its natural 200ms window when timeoutMs=60), "honours the outer deadline when scrollIntoView never recovers an offscreen element" (verifies the recovery branch + the outer loop together bail within ~timeoutMs+50ms), "returns ok in <50ms for a stable visible element (happy path)" (regression guard that the happy path stays fast). Matrix now 16/16 PASS (evidence: `docs/e2e-runs/2026-05-19_imp0155-fix.json`). Full chrome-extension vitest 1659/1666 pass + 7 skipped; tsc clean; `pnpm -w build` clean.
- **Why**: After IMP-0139 unblocked `pnpm e2e:isolated` locally, the matrix run surfaced 7/16 failures sharing the same shape (`transportError:"The operation was aborted due to timeout"` at the 15s HTTP ceiling) — not the expected NOT_ACTIONABLE envelope. The 2026-05-17 baseline at `docs/e2e-runs/2026-05-17_all-green.json` had 16/16 PASS, so something between then and IMP-0139 had introduced an unbounded wait inside `awaitActionable`. The proximate cause was that IMP-0118's setTimeout sampler and IMP-0113's `readTransform` diff resolved `null` (stable) after 4×50ms regardless of whether `hasActiveAnimation` was still true — so against the `#sliding-btn` fixture (`animation: slide 4s ease-in-out infinite alternate`) the outer loop could keep cycling and the deadline check at the bottom of each iteration was the only guard. In real Chrome the cycle stretched enough that the matrix's 15s HTTP transport ran out before the 5s actionability deadline saw the end of an iteration.
- **Cost**: M
- **Value**: L

### IMP-0122 · `chrome_search_tabs_content` still blocked by SW dynamic-`import()` ban (bug) · score: 5

- **Proposed by**: claude · 2026-05-18 (follow-up to GitHub issues #216 / #217)
- **Status**: done
- **Completed**: 2026-05-19
- **Summary**: Moved the ~1.2 MB ML indexer graph (`@huggingface/transformers` + `onnxruntime-web` + `hnswlib-wasm-static`) out of the service-worker import surface and into the existing offscreen document. SW callers now speak to the indexer over `chrome.runtime.sendMessage` via a new typed client at `app/chrome-extension/utils/indexer-rpc.ts`. New offscreen entry at `app/chrome-extension/entrypoints/offscreen/vector-host.ts` owns the `getGlobalContentIndexer()` singleton and dispatches the 9 new `OFFSCREEN_MESSAGE_TYPES.CONTENT_INDEXER_*` calls (search, stats, status, clearAll, clearVectorData, indexTab, removeTab, reinitialize, startInit). Rewrote `app/chrome-extension/entrypoints/background/tools/browser/vector-search.ts` to call `indexerRpc.*` instead of `await import('@/utils/content-indexer')`; same swap applied to `app/chrome-extension/entrypoints/background/storage-manager.ts` (3 sites: stats, indexer-clear, vector-data-clear) and `app/chrome-extension/entrypoints/background/semantic-similarity.ts` (2 sites: post-init kick, model-switch reinit). `content-indexer.ts` had a leftover `await import('@/entrypoints/background/semantic-similarity')` reading the model status; replaced with a direct `chrome.storage.local.get(['modelState'])` read since the indexer now runs in the offscreen page and importing a background entrypoint from there would either crash or pick up the wrong listener context. Vector-search tool promoted from `lazyLoaders` to eager registration because the module no longer drags the ML graph into the SW; lazy-tool-registry test updated to drop SEARCH*TABS_CONTENT from STILL_LAZY and add `./browser/vector-search` to PROMOTED_PATHS. Build output verified: zero references to `hnswlib-wasm-static` / `onnxruntime-web` / `@huggingface/transformers` in `background.js`; all 9 `CONTENT_INDEXER*\*` message types present in the offscreen chunk (`offscreen-D7n4WWoC.js`). Total: 13 new vector-search tests + 12 new vector-host tests pass; lazy-tool-registry suite green; full chrome-extension suite 1656/1656 pass (7 skipped); `pnpm -w build` clean.
- **Why**: #216 promoted the cheap lazy tools (javascript / read-page / userscript / performance / element-picker) to static imports so they survive the SW dynamic-`import()` ban. `vector-search.ts` (`chrome_search_tabs_content`) was left lazy because its `getIndexer()` did `await import('@/utils/content-indexer')` to defer the ~1.2 MB ML graph. That inner dynamic import hit the same Chrome limitation: `import() is disallowed on ServiceWorkerGlobalScope` per https://github.com/w3c/ServiceWorker/issues/1356. Bringing the graph in statically would have added ~1.2 MB to SW boot — unacceptable.
- **Cost**: M
- **Value**: M

### IMP-0113 · IMP-0097 actionability — offscreen scroll-into-view + unstable_bbox not enforced (bug) · score: 5

- **Proposed by**: bug-scout · 2026-05-17 (matrix evidence)
- **Status**: done
- **Completed**: 2026-05-19
- **Summary**: Hardened `app/chrome-extension/inject-scripts/actionability.js` against the two remaining matrix-evidence gaps. (1) Offscreen scroll-into-view: added an explicit `isOffscreenButPresent(el)` guard inside the polling loop; when `checkVisible` returns `not_visible` purely because the rect is outside the viewport (not display:none / visibility:hidden / opacity:0 / pointer-events:none / zero-area), the orchestrator now calls `el.scrollIntoView({block:'center', inline:'center', behavior:'instant'})` once, awaits a single rAF for the layout flush, then re-checks visibility. If the scroll lands the element in view the action proceeds; if scrolling cannot help (e.g. `position:absolute; left:-9999px` with no scroll container) the second check still fails and `not_visible` is returned — Playwright's contract exactly. The recovery is one-shot per `awaitActionable` call so the polling loop can't infinite-loop on a slow-to-scroll page. (2) Stability check: extended `checkStable` to compare `getComputedStyle(el).transform` strings alongside `getBoundingClientRect()` across the 4-sample window (was 3). The matrix-string diff catches transform-only motion that pixel-rounds the bbox back to baseline (matrix(...)/matrix3d(...) differs at sub-pixel offsets where x/y still floor to the same integer); the 4th sample further reduces the chance of a velocity-zero coincidence. Added 5 new vitest cases to `tests/inject-scripts/actionability.test.ts` covering: scrollIntoView recovers an offscreen element when the scroll actually moves the rect; offscreen with `left:-9999px` still fails `not_visible` after recovery attempt; `display:none` does NOT trigger the recovery (saves a frame of latency); transform diff catches sub-pixel motion when bbox rounds equal; static transform across sampler returns stable. Total: actionability.test.ts 36/36 pass; full chrome-extension suite 1631 pass + 7 skipped; tsc clean.
- **Why**: Matrix run showed two actionability gaps after IMP-0103/0104:
- **Cost**: M
- **Value**: M
  - **Offscreen scroll-into-view**: `chrome_click_element({selector:'#vis-offscreen'})` (button at `x:-9999, y:563`) returned `NOT_ACTIONABLE failures:['not_visible']` instead of attempting scrollIntoView first (Playwright's standard behavior); even though the actual fixture can't be scrolled into view, the contract is to try-then-fail not fail-without-trying. Elements in overflow-scroll containers were never recovered.
  - **Animation unstable_bbox**: `chrome_click_element({selector:'#sliding-btn'})` (a 4s infinite `transform: translateX()` animation) succeeded without `force:true` — the bbox-stability check rounded sub-pixel motion to identical x/y across samples and missed it. Should return `NOT_ACTIONABLE failures:['unstable_bbox']`.

### IMP-0136 · chrome_inject_script bridge-inject (ISOLATED) skips classifyFrameError — silent failure when bridge CSP-blocked (bug) · score: 6

- **Proposed by**: bug-scout · 2026-05-19
- **Status**: done
- **Completed**: 2026-05-19
- **Summary**: Added `classifyFrameError` to the bridge-inject step at `app/chrome-extension/entrypoints/background/tools/browser/inject-script.ts:305` — completing the silent-success coverage from PR #219 (bugs #216/#217) which classified the MAIN-world inject and ISOLATED-only-mode inject but missed the file-based bridge inject that runs BEFORE the MAIN-world user code. Pre-fix, when the bridge inject returned a per-frame `result.error` (page denies extension content scripts via manifest CSP, detached frame, restricted URL race, "Cannot access contents of url ..."), the await resolved without throwing, the tool proceeded to inject the user code into MAIN, the sentinel verify passed (sentinel is set inside the user-code wrapper, not the bridge), and the tool returned `{injected:true}` — but the bridge listener never installed, so subsequent `chrome_send_command_to_inject_script` calls hung forever (no listener to forward `targetWorld:MAIN` messages). Post-fix, the bridge result is cast to `InjectionFrameError[]` and passed through the same `classifyFrameError(_, "bridge inject")` already used by the other two sites, returning `INJECTION_FAILED` with `details.reason ∈ {CSP_BLOCKED, INJECTION_ERROR}` and `details.phase: "bridge inject"`. Early return prevents the MAIN-world inject from running and leaves no entry in `injectedTabs` (no phantom records in `list_injected_scripts`). `docs/AGENTS.md` already lists `bridge inject` in the `INJECTION_TIMEOUT` phase set, so no doc update needed — same string surface area, just now also reachable via `INJECTION_FAILED`. Added 5 vitest cases to `tests/tools/browser/inject-script-timeout-csp.test.ts` mirroring the bug #217 describe block: non-CSP bridge frame error → `INJECTION_ERROR`, CSP-pattern bridge frame error → `CSP_BLOCKED`, asserts exactly one `executeScript` call on failure (no MAIN inject, no verify), asserts no `injectedTabs` map entry remains, asserts happy path (3 calls, sentinel set) still returns `{injected:true, success:true}`. Total: inject-script-timeout-csp suite 15/15 pass (10 pre-existing + 5 new), lazy-tool-registry clean, typecheck clean.
- **Why**: IMP-#216/#217 PR added `classifyFrameError` to detect per-frame CSP rejections in MAIN-world inject AND ISOLATED-only inject (lines 338, 381) — but the bridge inject at inject-script.ts:305 (ISOLATED-world, file-based, runs BEFORE the MAIN-world user code) did NOT inspect `result.error`. If the bridge failed to inject (page denies extension content scripts via specific manifest content_security_policy, frame in detached state, or any per-frame error), the await resolved without error, MAIN-world inject proceeded without a bridge, the sentinel verify passed (sentinel is set in the inject func itself, not the bridge), and the tool returned `{injected:true}`. Later calls to `chrome_send_command_to_inject_script` then hung or failed because the bridge listener that forwards `targetWorld:MAIN` messages was never installed. Caller had no way to know the silent bridge-failure occurred.
- **Cost**: S
- **Value**: M

### IMP-0135 · chrome_wait_for(load_state) race: load event fires between readyState check and listener install (bug) · score: 6

- **Proposed by**: bug-scout · 2026-05-19
- **Status**: done
- **Completed**: 2026-05-19
- **Summary**: Reordered `waitForLoadState` and `waitForUrl` in `app/chrome-extension/entrypoints/background/tools/browser/wait-for.ts` so the `chrome.webNavigation` listener is attached BEFORE the `document.readyState` / `chrome.tabs.get` fast-path probe runs. Pre-fix, the `await readReadyState()` (a `chrome.scripting.executeScript` round-trip, ~10-100ms in practice) sat between the wait entry and `addListener`, opening a window where the page's `load` / `DOMContentLoaded` / navigation-commit event could fire unobserved — the wait then sat idle until the 30s timeout. Post-fix, both `waitForLoadState` and `waitForUrl` enter the Promise executor, synchronously install listeners + the timeout timer, THEN kick off the probe via `.then(...)`; the fast-path branch and the listener share a single `settled` flag so resolution is exclusive. Added 9 vitest cases (`tests/tools/browser/wait-for.test.ts` IMP-0135 describe block) covering the race directly via a deferred-promise mock for `chrome.scripting.executeScript` and `chrome.tabs.get` — the event fires before the probe resolves, and the wait still resolves from the listener; reverse-order ("late-arriving readyState/URL after listener already resolved") is asserted to not double-resolve; happy-path fast-path and timeout-only paths are re-covered against the new code. Total: wait-for suite 25/25 pass, typecheck clean, `lazy-tool-registry.test.ts` clean.
- **Why**: `chrome_wait_for({kind:"load_state"})` did `await readReadyState()` (which performs a `chrome.scripting.executeScript` round-trip, ~10-100ms) at wait-for.ts:273, then if the readyState didn't yet satisfy the wait, installed the `onCompleted`/`onDOMContentLoaded` listener at line 321. During that ~10-100ms gap, the navigation could transition from `loading→complete` and the load event fired WITHOUT a listener attached. The wait then sat idle for the full timeoutMs (default 30s) and returned TIMEOUT, even though the page was actually loaded. Particularly painful on fast in-process navigations (SPA route changes that re-fire load) and tests where pages load in <100ms. The IMP-0102 ship note specifically called out the fast-path as an optimization — it accidentally introduced a race. Same root cause in `waitForUrl` (line 350-358) where `chrome.tabs.get` takes ~ms and the URL could change in between.
- **Cost**: S
- **Value**: M

### IMP-0134 · chrome_paste reports `pasted:true` when event fired but no text inserted (bug) · score: 6

- **Proposed by**: bug-scout · 2026-05-19
- **Status**: done
- **Completed**: 2026-05-19
- **Summary**: Rewrote `pasteShim` in `app/chrome-extension/entrypoints/background/tools/browser/paste.ts` so `pasted` derives from a textBefore/textAfter diff rather than from "did we successfully dispatch an event". A page listener that consumes the paste event for telemetry without inserting text, followed by an `execCommand('insertText')` that returns true on readonly inputs / `contenteditable=false` without writing, now correctly reports `pasted:false, mode:'none', textInserted:0` — closing the same IMP-0092 silent-success class on the paste path. Added `textInserted: number` (after-before character delta) and changed `mode` to track which path actually wrote text (`'event' | 'execCommand' | 'none'`, replacing the prior `'both'` which couldn't happen given the guard order). Exposed `_pasteShimForTest` per the load-bearing `_`-prefix convention so jsdom tests can exercise the shim against a real DOM (the existing chrome.scripting.executeScript-mocking tests never reached the textBefore/textAfter path). Added 9 new in-shim tests covering: input + execCommand happy path, paste-listener happy path (no double-insert), readonly-input silent-success regression (the canonical IMP-0134 repro), contenteditable=false silent-success regression, contenteditable=true execCommand path, partial-insert detection (textInserted < text.length when listener sanitizes), clipboard-only mode preserved, execCommand-returns-false explicit guard, and mode:event precedence over execCommand. Existing dispatcher-level tests updated to include the new `textInserted` field. Total: paste suite 24/24 pass.
- **Why**: After PR #218, paste.ts derived `pasted = eventDispatched || execCommandDispatched`. Both flags flipped to true on any `target.dispatchEvent(ev)` / `execCommand('insertText', ...)` call regardless of whether text was actually inserted. Readonly inputs, `contenteditable=false`, and pages whose paste listener is purely for telemetry all reported `pasted:true` while leaving the field empty — caller had no signal that the paste failed, downstream waits timed out. Same class of bug as IMP-0092 (click reporting success without dispatching), now structurally impossible on paste because the boolean is computed from "did the text change", not from "did the call succeed".
- **Cost**: S
- **Value**: M

### IMP-0123 · `preHandler.test.ts` entire file flaky under parallel jest — quarantined (bug) · score: 7

- **Proposed by**: claude · 2026-05-18 (broadened 2026-05-18 — initially quarantined 2 tests; turned out all 9 are flaky under parallel load)
- **Status**: done
- **Completed**: 2026-05-19
- **Summary**: Split `app/native-server/src/server/preHandler.test.ts` into three sibling files — `preHandler-host.test.ts`, `preHandler-origin.test.ts`, `preHandler-bearer.test.ts` — so each describe block gets its own jest worker. Each file is fully self-contained (own `buildServer()` helper, own `beforeEach`/`afterEach` env reset) and removes the `describe.skip` so all 9 tests now run. Pre-fix: 9 tests skipped, regression coverage was a placeholder. Post-fix: 9 tests active, run cleanly under parallel jest load, restoring the preHandler gate (Host DNS-rebinding defence, Origin allowlist, HUMANCHROME_TOKEN bearer auth). Verified via `pnpm test` run twice — both fully green, no preHandler timeouts. Removed the IMP-0123 carve-out from `CLAUDE.md` so `pnpm test` green is once again the canonical CI signal with no documented flake exemption.

### IMP-0138 · chrome_wait_for(js) TDZ ReferenceError on first-check-true — silent 120s timeout (bug) · score: 8

- **Proposed by**: bug-scout · 2026-05-19
- **Status**: done
- **Completed**: 2026-05-19
- **Summary**: Hoisted the `poller`/`timer` (and analogous `idleTimer`/`deadline`) lexical bindings in all five executor bodies inside `app/chrome-extension/inject-scripts/wait-helper.js` (`waitFor`, `waitForElement`, `waitForSelector`, `waitForNetworkIdle`, `waitForJs`) so the initial synchronous `check()` can call `done()` safely when the predicate is already satisfied on first poll. Pre-fix, `done()` referenced `const`-declared timers that were still in TDZ; the ReferenceError escaped the Promise executor, the executor rejected silently, the SW message router got nothing back, and the caller observed a 120s MCP transport timeout instead of the requested timeoutMs. `clearTimeout(undefined)` / `clearInterval(undefined)` are no-ops, so the early-done() path is safe even before the timers are assigned. Added 8 new test cases in `tests/inject-scripts/wait-helper.test.ts` covering: waitForJs first-check-true (the canonical regression), waitForJs against `document.readyState === "complete"` (the production repro), waitFor (text-presence) with element already present, waitForNetworkIdle on a quiet page, waitForJs flipping after a DOM mutation (no slow-path regression), waitForJs timeout envelope shape, waitForJs compile-error envelope, and a `wait_helper_ping` sanity check. All 8 pass; without the fix, the first-check-true tests would hang past vitest's default timeout because `sendResponse` is never invoked.
- **Why**: `wait-helper.js:469` calls `check()` synchronously BEFORE declaring `const poller` (line 470) and `const timer` (line 471). If `evalFn()` returns truthy on first call (the expression is ALREADY satisfied), `check()` calls `done()` which references `poller` and `timer` at lines 446-447 — both in TDZ. ReferenceError propagates out of the Promise executor, the promise rejects with no payload to the SW message router, the SW sendMessage callback never gets a structured response, and the caller times out at the MCP transport default (120s). Effect: `chrome_wait_for({kind:"js", expression:"document.readyState === 'complete'"})` against an already-loaded page TIMES OUT instead of returning success in <5ms — the exact case the JS wait was designed for (poll-until-ready). Identical bug present in `waitFor` / `waitForElement` / `waitForSelector` / `waitForNetworkIdle` — all fixed in one pass to prevent latent regressions.
- **Cost**: S
- **Value**: L

### IMP-0137 · runActionability silently degrades to {ok:true} when actionability.js fails to inject — masks click/fill regressions (bug) · score: 9

- **Proposed by**: bug-scout · 2026-05-19
- **Status**: done
- **Completed**: 2026-05-19
- **Summary**: Hard-failed `runActionability` in both `inject-scripts/click-helper.js` and `inject-scripts/fill-helper.js` when `window.__actionability` is absent — they now return `{ok:false, failures:['actionability_unavailable']}` instead of the silent `{ok:true}` fallback that masked every pre-action check. Existing `notActionable` envelope handling in `interaction.ts` then surfaces the failure as `NOT_ACTIONABLE` with the new `actionability_unavailable` token. Added `assertHelperPresent` on `BaseBrowserToolExecutor` (pings the companion helper's `<helper>_ping` action and throws `INJECTION_FAILED` when silent); wired into both `ClickTool` and `FillTool` so build-misconfiguration (file dropped from inject list, file missing from build output) surfaces with a precise message at the contract boundary instead of a per-element `NOT_ACTIONABLE`. Preserved the explicit `force: true` escape hatch in the helper-side wrapper — callers who opted out of the actionability suite aren't blocked by a missing primitive. Added 12 new test cases in `tests/tools/browser/imp0137-actionability-hard-fail.test.ts` (helper-inline hard-fail, force:true short-circuit, dispatcher classification, dispatcher self-test failure & happy path). Updated `tests/tools/browser/click-element.test.ts` (loadHelper now stubs `window.__actionability` by default so IMP-0092 race tests still hit the simulateClick branch), and `tests/tools/browser/interaction-actionability.test.ts` + `tests/tools/browser/imp0104-inject-acc-tree.test.ts` mocks to return `pong` for `actionability_ping`. Documented the new `actionability_unavailable` token in `docs/AGENTS.md` § ToolErrorCode. Total: chrome-extension 1597/1597 pass.
- **Why**: Both `click-helper.js:340-343` and `fill-helper.js:399-405` defined `runActionability` that checks `window.__actionability`. When the actionability primitive isn't loaded (because `actionability.js` failed to inject for ANY reason — file missing from build, CSP blocked, race with cleanup, etc.), the helper logged a `console.warn` and returned `Promise.resolve({ok: true})`. Effect: ALL pre-action checks (visible/stable/enabled/editable/hit-test) were silently skipped, exactly as if `force:true` were set everywhere. The user thought IMP-0097 actionability was protecting them; in reality it wasn't, until they happened to check DevTools console. Symptom in production: regression to pre-IMP-0097 silent-click-on-overlay behavior, no error envelope, no failure token. Comment said "production callers always inject it alongside fill-helper" — but that was a hope, not a guarantee. If `interaction.ts` ever dropped `actionability.js` from the `injectContentScript` list (regression during refactor), it silently disabled protection across all click/fill paths.
- **Cost**: S
- **Value**: L

### IMP-0097 · Shared actionability primitive — visible/stable/enabled/hit-test before every action (feat) · score: 5

- **Status**: done (2026-05-16)
- **Completed**: 2026-05-16
- **Summary**: New `inject-scripts/actionability.js` exports `awaitActionable(el, opts)` with all five Playwright-style checks (visible/enabled/editable/stable via rAF/hit-test with occluder identification by tag#id or tag.class), auto-`scrollIntoView({block:'center'})` pre-check, `force: true` bypass, default 5000ms timeout, per-call `position` override. Wired into every interaction path: `click-helper.js` (all 3 paths — ref/coords/selector; coords path pins hit-test to the click point so IMP-0092's silent-success-over-overlay class is structurally impossible), `fill-helper.js`, `drag-drop.ts` MAIN-world shim (source + target), `focus.ts` ISOLATED shim, `computer.ts` handlers + click/fill/key/type. Per-action check matrix mirrors Playwright: click/dblclick/tap/check (visible+stable+enabled+hit-test), hover/dragTo (visible+stable+hit-test), fill/clear/selectOption (visible+enabled+editable), focus/blur/press/dispatchEvent (visible). New `ToolErrorCode.NOT_ACTIONABLE` with `details.failures: string[]` carrying tokens like `not_visible`, `disabled`, `not_editable`, `unstable_bbox`, `occluded_by:tag#id`, `no_element_at_point`. `base-browser.ts` `sendMessageToTab` passes `{notActionable:true, failures}` envelopes through untouched. Schemas in `packages/shared/src/tools.ts` APPEND `force` + `actionabilityTimeoutMs` to 5 tools (no reorders). Tests: `actionability.test.ts` (31), `interaction-actionability.test.ts` (7), drag-drop +4, focus +3. Total: extension 1525/1525 pass. Coordinated merge: kept IMP-0092's coord-mode error return AND IMP-0098's strict-mode try/catch in click; passed force/actionabilityTimeoutMs into focus shim alongside IMP-0098's prefixed-selector resolution.

### IMP-0092 · ClickTool reports success: true after coordinate-click hit empty space (no event dispatched) (bug) · score: 6

- **Proposed by**: bug-scout · 2026-05-16
- **Status**: done (2026-05-16)
- **Why**: Coordinate-mode clicks on empty space (elementFromPoint returns null) silently return success:true even though no mouse event was dispatched. Agents see no error, retry never fires, and downstream waits time out because the modal/button never received the synthetic click. Common when a scrim flashes over a button mid-click or when the click target scrolled off-screen between coordinate calculation and dispatch.
- **Cost**: S
- **Value**: M
- **Repro**: Call `chrome_click` with `coordinates: {x: 100, y: 100}` on a page where (100,100) has no element (e.g. a transparent area). Result is `{success: true, message: "Element clicked successfully", elementInfo: {warning: "No element found at the specified coordinates"}, navigationOccurred: false}`. Nothing actually clicked.
- **Fix sketch**: In `app/chrome-extension/inject-scripts/click-helper.js` line 111-117, when `elementFromPoint` returns null in coord-mode, return `{error: "No element at coordinates (x, y)"}` instead of building a `warning`-only `elementInfo`. The early-return on line 219/229 in `simulateClick`/`simulateDoubleClick` already short-circuits dispatch — surface that as an error so `sendMessageToTab` in `base-browser.ts:145-147` re-throws and ClickTool returns an error envelope. Optional: keep the soft-fail behavior behind an opt-in `allowMissingTarget: true` arg.
- **Notes**: The selector/ref paths both check visibility / DOM presence and error correctly; only the coordinate branch is broken. Same shape applies to right-click button==2 + the double-click setTimeout follow-up in `dispatchClickSequence`.

### IMP-0093 · chrome_intercept_response returns full response bodies — violates documented 1 MiB cap (bug) · score: 6

- **Proposed by**: bug-scout · 2026-05-16
- **Status**: done (2026-05-16)
- **Why**: CLAUDE.md / docs/AGENTS.md document a hard 1 MiB cap on proxied response bodies, surfaced as responseBodyTruncation. chrome_intercept_response ignores this cap entirely: it passes the raw body string from Network.getResponseBody straight into the response envelope. A single matched 50 MB JSON response blows past MCP transport limits and OOMs the bridge. chrome_network_capture debugger backend honors the cap correctly — only intercept-response is leaking.
- **Cost**: S
- **Value**: M
- **Repro**: Run chrome_intercept_response with urlPattern matching a URL whose response body is >1 MiB. The returned envelope contains the full uncapped body string; responseBodyTruncation field is absent. Compare with chrome_network_capture flush envelope on the same request: responseBodyTruncation.truncated:true is present.
- **Fix sketch**: app/chrome-extension/entrypoints/background/tools/browser/intercept-response.ts lines 351-409 — after Network.getResponseBody resolves, pipe body.body through the same truncateString helper + MAX_RESPONSE_BODY_BYTES from utils/timeouts.ts:45 that network-capture-debugger.ts:471-485 uses, and add a responseBodyTruncation field to the envelope and to the CompletedMatch interface lines 60-66. Same change applies to the multi-match path. Parse JSON only when not truncated.
- **Notes**: Tools that call intercept-response indirectly (chrome_wait_for response_match) opt out via returnBody:false and are unaffected — only direct body-consuming callers trip the leak.

### IMP-0094 · chrome_intercept_response hangs until timeout when CDP detaches mid-flight (bug) · score: 6

- **Proposed by**: bug-scout · 2026-05-16
- **Status**: done (2026-05-16)
- **Why**: intercept-response attaches the debugger and waits for Network.responseReceived but never installs a chrome.debugger.onDetach listener. If the user opens DevTools, another tool detaches CDP, or the tab navigates and Chrome auto-detaches the session, the listener stops receiving events but the Promise never resolves. The tool blocks for the full timeoutMs (default 15s, max 120s) and returns a misleading TIMEOUT envelope. network-capture-debugger.ts:88 installs an onDetach handler correctly — intercept-response is the outlier.
- **Cost**: S
- **Value**: M
- **Repro**: Start chrome_intercept_response with timeoutMs:60000 against a URL the page will fetch in 5s. While waiting, open DevTools on the same tab to force-detach the extension debugger. The tool sits idle for the full 55 remaining seconds and returns TIMEOUT, even though the user clearly broke the CDP session.
- **Fix sketch**: app/chrome-extension/entrypoints/background/tools/browser/intercept-response.ts — add chrome.debugger.onDetach.addListener inside the Promise body that, when source.tabId===tabId, clears the timer, runs cleanup, and resolves with a CDP_BUSY or DETACHED error envelope. Mirror the cleanup pattern at network-capture-debugger.ts:88 / handleDebuggerDetach.
- **Notes**: Related: when Page navigates mid-call the requestIds for matches from the OLD document can still be in pendingByRequestId, never to receive Network.loadingFinished. A Page.frameNavigated listener for the main frame could drop those and short-circuit the timeout.

### IMP-0095 · chrome_await_element returns found:true after waiting for state=absent (bug) · score: 4

- **Proposed by**: bug-scout · 2026-05-16
- **Status**: done (2026-05-16)
- **Why**: When awaiting state=absent and the element actually disappears, the envelope returns found:true even though the whole point of the wait was the element being NOT FOUND. Agents conditioning on found:false to know an element was successfully waited-away cannot distinguish present-from-absent. Worse, the response shape carries an undefined ref field for the absent path so ref ?? resp.matched.ref is undefined — masking the success of the underlying poll.
- **Cost**: S
- **Value**: S
- **Repro**: Inject a <div id="modal"> on the page, then chrome_await_element with selector:"#modal", state:"absent", timeoutMs:5000. Remove the div externally. The envelope returns success:true, found:true, matched:null. Expected: found:false (or some clear absent:true) to communicate the wait succeeded because the element vanished.
- **Fix sketch**: app/chrome-extension/entrypoints/background/tools/browser/await-element.ts lines 119-134 — set found = (state === "present") so absent-mode success surfaces as found:false. Document in the schema (packages/shared/src/tools.ts await_element entry) what found means under each state. The wait-helper.js side at lines 205-237 is already correct (returns success:true regardless of state); only the tool wrapper mis-shapes the envelope.
- **Notes**: Pure shape bug, no behavior change in the underlying poller. Low value because absent-mode is uncommon but absolutely surprising when hit. Bundles well with adding a dedicated absent:true field.

### IMP-0096 · chrome_file_upload synthesized change-event silently drops when selector contains quotes (bug) · score: 4

- **Proposed by**: bug-scout · 2026-05-16
- **Status**: done (2026-05-16)
- **Why**: After DOM.setFileInputFiles attaches the file, chrome_file_upload synthesizes a change event by interpolating the raw selector into a Runtime.evaluate string with only naive single-quote escaping. Selectors with backslashes, double-quotes, or escaped attribute values fail to parse — files attach but the page never sees the change event, so React/Vue form handlers never fire. Agents see a success envelope and never retry. Bonus: code-injection surface via Runtime.evaluate.
- **Cost**: S
- **Value**: S
- **Repro**: Call chrome_file_upload with a selector whose attribute value contains a literal single-quote, e.g. an input named "o" + apostrophe + "brien". DOM.setFileInputFiles still attaches the files via the CDP nodeId, but the synthesized change event never fires because the Runtime.evaluate expression fails to parse. React/Vue form handlers tied to onChange never run.
- **Fix sketch**: app/chrome-extension/entrypoints/background/tools/browser/file-upload.ts lines 134-147 — drop the document.querySelector re-resolution entirely. The DOM.querySelector call at line 94 already returned the nodeId. Use chained CDP calls: DOM.resolveNode against nodeId to get an objectId, then Runtime.callFunctionOn with that objectId and functionDeclaration: function(){this.dispatchEvent(new Event('change',{bubbles:true}))}. No user-controlled selector ever crosses the eval boundary, the parse-error class of bugs disappears, and we save one selector-resolution round-trip on the page side.
- **Notes**: Naive single-quote-only escaping does not handle backslashes, double-quotes, newlines, or template-literal interpolation in the selector — any of which silently break the change-event dispatch. Also a code-injection surface via Runtime.evaluate MAIN world if the selector originates from a prompt-injected page string.

### IMP-0098 · Playwright-style locator engine — role/text/label/placeholder/alt/title/testid + uniform strict mode (feat) · score: 4

- **Proposed by**: user · 2026-05-16
- **Status**: done (2026-05-16)
- **Why**: Selector surface today is `css` / `xpath` / `ref` only. Audit confirmed `shared/selector/strategies/` already exists with testid/aria/text/css-unique/css-path/anchor-relpath skeletons + a stability/fingerprint runtime — but there are no first-class `getByRole`/`getByText`/`getByLabel`/`getByPlaceholder`/`getByAltText`/`getByTitle` resolvers as either generators or runtime branches. With these added and strict mode unified across all selector paths, LLM agents can author resilient selectors like `role:button[name="Submit"]` instead of `body > div:nth-child(3) > button.css-1234`. Single biggest UX/reliability lever after actionability.
- **Cost**: L (4-5 days)
- **Value**: L
- **Files**: new strategies under `app/chrome-extension/shared/selector/strategies/`: `role.ts`, `label.ts`, `placeholder.ts`, `alt-text.ts`, `title.ts`; extend `testid.ts` for configurable attribute list (per-client extension storage, default `['data-testid','data-cy','data-test','data-qa']`); new `app/chrome-extension/shared/selector/accessible-name.ts` (W3C accname-1.2 subset); runtime resolver in `shared/selector/locator.ts:355+` (extend `tryCandidate`); tool param schemas in `packages/shared/src/tools.ts` adding `selectorType` values `role`/`label`/`placeholder`/`alt`/`title`/`testid`/`text` to: click_element, fill_or_select, await_element, wait_for, focus, drag_drop, computer; strict-mode unification at `inject-scripts/click-helper.js:119` (raw-CSS fast-path routes through `querySelectorWithUniquenessCheck`). Tests: per-strategy unit (especially accessible-name edge cases — `aria-labelledby` chains, `<label for>`/wrapping, image alt for buttons, `aria-label` precedence); integration against fixture pages with role-able buttons, labelled inputs, testid-tagged elements.
- **Sketch**: Each strategy exposes `generate(el): Candidate[]` (recorder use — feeds IMP-0099) and `resolve(value, scope): Element[]` (runtime use). Parser maps prefixed strings: `role:button[name="Submit",exact=true]` → role strategy with name filter; `label:Email` → label strategy. Composite still works: `iframe#payment |> role:button[name="Pay"]`. Strict mode: every resolution path errors with `INVALID_ARGS` + `details: {matchCount, samples: [...]}` if >1 match and neither `index` nor `multi: true` supplied. Add uniform `index` param everywhere (default behavior = "the only match — error if >1"; explicit `index: N` picks the Nth). Accessible-name compute: subset of W3C accname-1.2 — handles aria-labelledby, aria-label, label[for], wrapping label, alt, title, contents (in that order); skip CSS pseudo-content rules.
- **Notes**: Hard prereq for IMP-0099. Filtering DSL (`.filter({hasText})`) and locator chaining deliberately deferred — refId path covers most use cases. Add later if real demand surfaces. Strict-mode unification is part of this scope (not separate).

### IMP-0101 · chrome_locator_handler — auto-dismiss sticky overlays (cookie banners, GDPR modals, newsletter popups) (feat) · score: 4

- **Proposed by**: user · 2026-05-16
- **Status**: done (2026-05-16)
- **Why**: Real-world sites are saturated with cookie banners, GDPR consent modals, newsletter-subscribe popups, and "we use cookies" overlays that intercept clicks and break LLM flows. Playwright's `addLocatorHandler` lets you declaratively say "if this selector becomes visible, click that dismiss button before continuing." Massive ergonomic win for any flow against a public site. We have userscripts + inject-script + MutationObserver primitives — composing them into a first-class tool is small.
- **Cost**: S (1-2 days)
- **Value**: M
- **Files**: new `app/chrome-extension/entrypoints/background/tools/browser/locator-handler.ts` (5-file recipe — schema in `packages/shared/src/tools.ts`, barrel export, dispatcher entry, test); new `app/chrome-extension/inject-scripts/locator-handler.js` (MAIN-world MutationObserver + IntersectionObserver). Tests: `tests/tools/browser/locator-handler.test.ts`.
- **Sketch**: Tool actions: `register({selector, dismissSelector, dismissAction: 'click'|'press', key?, tabId, persistent?: boolean, times?})`; `list`; `remove({handlerId})`; `clear({tabId})`. Inject script installs MutationObserver on `document.body`; when registered selector becomes visible (IntersectionObserver — non-empty bbox + not display:none/visibility:hidden), runs dismissAction on dismissSelector. Per-handler `times` limit defaults to unlimited; `persistent: true` survives navigation (re-injects via `chrome.webNavigation.onDOMContentLoaded` for that tab). Reuse IMP-0097 `awaitActionable` before dispatching dismiss click. `list` returns `{handlerId, selector, dismissedCount, lastDismissedAt}` per handler.
- **Notes**: Standalone (soft-prereq on IMP-0097 for the actionability check — works without it but less reliable). Independent ergonomic win. Particularly valuable paired with the pacing `careful` profile when running against LinkedIn/news sites.

### IMP-0102 · Add `load_state` and `url` kinds to chrome_wait_for (feat) · score: 2

- **Proposed by**: user · 2026-05-16
- **Status**: done (2026-05-16)
- **Why**: `chrome_wait_for` covers element / network_idle / response_match / js but is missing two Playwright primitives that come up constantly: `waitForLoadState('load'|'domcontentloaded')` and `waitForURL(pattern)`. First is needed when a flow depends on full-page resource load (not just network idle, e.g. waiting for late `<img>`/`<script>` to finish before a screenshot). Second is the canonical "wait for SPA to push /checkout to history" pattern. Cheap to add with `chrome.webNavigation` events.
- **Cost**: S (1 day)
- **Value**: S
- **Files**: `app/chrome-extension/entrypoints/background/tools/browser/wait-for.ts` (two new `kind` branches); `packages/shared/src/tools.ts` (schema additions for `state` and `pattern` params). Tests: extend `tests/tools/browser/wait-for.test.ts`.
- **Sketch**: `kind: 'load_state'` with `state: 'load'|'domcontentloaded'|'complete'`. Subscribe `chrome.webNavigation.onCompleted` (for `load`/`complete`) or `onDOMContentLoaded` (for `domcontentloaded`) filtered to target frameId+tabId; resolve when next event fires OR inject a one-shot readyState check for synchronous resolve if already loaded. `kind: 'url'` with `pattern` (string substring or `/regex/flags` matching existing intercept-response pattern syntax). Subscribe `chrome.webNavigation.onHistoryStateUpdated` + `onCommitted` filtered to tabId; resolve when URL matches. Both clamp to `[0, 120000]` ms like existing waits.
- **Notes**: Standalone. Filler item between bigger pieces — good first-PR for someone new to the codebase.

### IMP-0100 · Proactive dialog handler — auto-handle alert/confirm/prompt via Page.javascriptDialogOpening (feat) · score: 5

- **Status**: done (2026-05-16)
- **Completed**: 2026-05-16
- **Summary**: `chrome_handle_dialog` extended from a single one-shot handler into a multi-action tool. New actions: `register_default({tabId, defaultBehavior, promptText?})` subscribes `Page.javascriptDialogOpening` via a persistent CDP attach (refcounted through `cdpSessionManager` with owner tag `dialog-default`); incoming dialogs are auto-answered with the configured behavior (`accept` | `dismiss` | `prompt_with_text`) and appended to a per-tab buffer capped at 50 entries (oldest dropped). `unregister_default({tabId})` releases the attach + listener. `list_defaults({tabId?})` returns registered policies plus each tab's recent dialog log (read-only). Re-registering on the same tab replaces the prior policy without erroring. Cleanup hooks: `chrome.tabs.onRemoved` clears policies for closed tabs; the bridge's `CLIENT_DISCONNECTED` path in `native-host.ts` calls `releaseDialogDefaultsForTabs` with the disconnecting client's owned tabs (so policies don't outlive their session); `chrome.debugger.onDetach` fires a warning and clears the policy if Chrome detaches externally (DevTools opened, etc.). Legacy `action: 'accept'|'dismiss'` two-field call still works for backward compatibility. Tool description warns about the "Chrome is being controlled" banner that the persistent CDP attach surfaces. Schema in `packages/shared/src/tools.ts` extended with the new action enum + `defaultBehavior` / `behavior` fields. New tests at `tests/tools/browser/dialog.test.ts` (21 cases) cover legacy compat, register/unregister/list, log cap, CDP_BUSY classification, replace-on-re-register, and the cleanup hook contract.
