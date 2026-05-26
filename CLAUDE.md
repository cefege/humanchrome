# CLAUDE.md — Orientation for Claude Code (and other LLM agents)

Loaded automatically by Claude Code every session. This is the source of truth for "how do I add a tool?", "what conventions does this codebase enforce?", and "where do things live?". For the runtime caller contract (what the bridge promises to _return_ on every call), see `docs/AGENTS.md`.

---

## What humanchrome is

An MCP (Model Context Protocol) server that exposes Chrome browser automation as tools an LLM can call. Three workspaces:

| Path                    | What                                                                               | Runtime                            |
| ----------------------- | ---------------------------------------------------------------------------------- | ---------------------------------- |
| `app/chrome-extension/` | Chrome MV3 extension. Tools and UI live here.                                      | Service worker + Vue 3 + WXT       |
| `app/native-server/`    | Node bridge that MCP clients connect to. Speaks native messaging to the extension. | Node 20+ / Fastify                 |
| `packages/shared/`      | Tool name enum, JSON schemas, error codes, IPC types — the contract surface.       | tsup-built, consumed by both sides |

`docs/` is hand-written except for `docs/TOOLS.md`, which is generated from `packages/shared/src/tools.ts` — never edit it directly.

---

## Adding a new tool — the 5-file recipe

Every new MCP tool is exactly 5 file edits. Steps 2-4 each touch a registry; the coverage tests at step 5 fail fast on any missing entry.

1. **Tool.** Create `app/chrome-extension/entrypoints/background/tools/browser/<slug>.ts`. Class extends `BaseBrowserToolExecutor`, sets `name = TOOL_NAMES.BROWSER.<X>`, sets `static readonly mutates = true` for state-changing tools (the dispatcher gates these through pacing + per-tab locks). `execute(args)` returns `Promise<ToolResult>`; failures use `createErrorResponse(msg, ToolErrorCode.X, details?)` from `@/common/tool-handler`. Multi-action tools take an `action` enum — see `tab-groups.ts`, `network-capture.ts`, `sessions.ts`.

2. **Shared registry — append-only.** Edit `packages/shared/src/tools.ts`:
   - Append to `TOOL_NAMES.BROWSER` (object literal near the top).
   - Append the schema entry (`name`, `description`, `inputSchema`) to the end of `TOOL_SCHEMAS`.
   - Append a category mapping to `TOOL_CATEGORIES`. Categories are defined in `TOOL_CATEGORY_ORDER` in the same file; copy the label exactly.
   - **Never reorder existing entries** — every tool PR touches this file and reorders cause merge conflicts.

3. **Barrel — append-only.** Add `export { newTool } from './<slug>';` to `tools/browser/index.ts`.

4. **Dispatcher — append-only.** Edit `tools/index.ts`: add the import, push the singleton into `eagerTools`. For heavy bundles (anything pulling in tensorflow / sharp / ffmpeg-style deps, or wrapping `chrome.debugger`/CDP), register in `lazyLoaders` instead — the `lazy-tool-registry.test.ts` enforces the eager/lazy split.

5. **Tests.** Create `tests/tools/browser/<slug>.test.ts`. 8-15 cases: arg validation, happy path per action, error classifications, missing-API/permission path. Vitest; mock `chrome.*` via `(globalThis.chrome as any).<api> = { ... }` in `beforeEach`. Canonical shapes: `idle.test.ts` (single-action), `drag-drop.test.ts` (MAIN-world shim), `keyboard-shortcuts.test.ts` (uses `_resetXForTest` helper).

After the 5 edits:

- `cd packages/shared && npm run build` — regenerates `dist/` so the extension typechecks against the new TOOL_NAMES entry.
- `cd app/chrome-extension && npx tsc --noEmit -p .` — must be clean.
- `npx vitest run --reporter=dot tests/tools/browser/<slug>.test.ts tests/tools/lazy-tool-registry.test.ts` — both must pass.
- `cd app/native-server && node scripts/generate-tools-doc.mjs` — regenerates `docs/TOOLS.md`.
- `cd app/native-server && npm test` only if bridge code was touched.
- **E2E verification (mandatory for chrome-extension changes)** — see § "E2E verification — required for every chrome-extension change" below. Build the extension, run the fixture matrix via `chrome-devtools-mcp` + `humanchrome` side-by-side per `docs/E2E-VERIFICATION.md`, extend the fixture if a new tool/contract was added. Push is not done until this passes.

Long-form templates with copy-pasteable file scaffolds: [`docs/AUTHORING-A-TOOL.md`](docs/AUTHORING-A-TOOL.md).

> **Authoring is unchanged after IMP-0177 (single-tool MCP dispatcher).** The bridge can serve tools in two modes — `legacy` (the default; full 96-tool MCP manifest) and `lazy` (one `humanchrome(name, args)` dispatcher whose description carries the catalog, ~15× boot-token reduction). The mode is selected by `HUMANCHROME_TOOL_MODE=lazy|legacy` on the bridge process. Either mode reads `TOOL_SCHEMAS` directly — append your tool there per step 2 and it auto-appears in both surfaces. Do not edit `packages/shared/src/tool-index.ts` by hand; it builds from `TOOL_SCHEMAS`.

---

## Canonical templates by tool shape

When unsure how to structure a new tool, copy the closest of these:

| Shape                                           | Template                                             |
| ----------------------------------------------- | ---------------------------------------------------- |
| Read-only, no params                            | `pace.ts` (`PaceGetTool`)                            |
| Wraps a single chrome.\* API call               | `idle.ts`                                            |
| Multi-action enum (CRUD or start/stop/status)   | `tab-groups.ts`, `network-capture.ts`, `sessions.ts` |
| Holds module-scope state, exposes a test seeder | `inject-script.ts` (`_seedInjectedTabForTest`)       |
| Caches platform info, exposes a test reset      | `keyboard.ts` (`_resetPlatformCacheForTest`)         |
| Synthesizes events via a MAIN-world shim        | `drag-drop.ts`                                       |

---

## Error classification

Use `ToolErrorCode` from `packages/shared/src/error-codes.ts`. The codes you'll typically reach for when authoring a tool:

- `INVALID_ARGS` — required field missing / wrong shape / out-of-range. Set `details: { arg: 'fieldName' }`.
- `TAB_CLOSED` — caught error matches `/no tab with id/i` (and `/receiving end does not exist/i` for content-script paths).
- `TAB_NOT_FOUND` — no active tab matched, or `tabId` lookup miss.
- `UNKNOWN` — everything else; include the original `error.message`.

The full table — including caller-side recovery semantics for `TARGET_NAVIGATED_AWAY`, `INJECTION_FAILED`, `CDP_BUSY`, `TAB_LOCK_TIMEOUT`, `TIMEOUT`, `PERMISSION_DENIED`, etc. — is in `docs/AGENTS.md` § 1. Don't duplicate it here; if you're adding a new code, edit `error-codes.ts` and `AGENTS.md` together.

---

## Load-bearing conventions

Not lint-enforced, but every PR follows them.

- **Test-only escape hatches use `_`-prefix.** When module-scope state needs a reset or seed for tests, export a function named `_resetXForTest()` / `_seedXForTest(...)`. Examples: `_resetPlatformCacheForTest` in `keyboard.ts`, `_seedInjectedTabForTest` in `inject-script.ts`. The underscore signals "not part of the runtime API" without needing `// @internal` JSDoc.
- **Reach into private methods via cast, not `eslint-disable`.** Pattern: `(tool as unknown as { privateMethod: (x: number) => string }).privateMethod(42)`. Used across the native-server engine tests; same pattern applies to extension tool tests when needed.
- **Single-window default.** humanchrome runs in one Chrome window by default. Tools needing a `windowId` should resolve via `chrome_get_windows_and_tabs` (or the `getActiveTabOrThrowInWindow` helper on `BaseBrowserToolExecutor`) rather than spawning new windows.
- **Conventional Commits with IMP id + Co-Author footer.** Subject: `<type>(<scope>): <imperative> (IMP-NNNN)`. Body ends with `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`. Commitlint enforces type/scope.
- **Response-body cap is 1 MiB.** When proxying response bodies (network-capture, intercept-response), cap at `1 * 1024 * 1024` bytes and surface truncation as `responseBodyTruncation: { truncated, originalSize, limit, unit:"bytes" }`.
- **Per-client tab ownership.** The dispatcher (`tools/index.ts`) resolves the target tab from the calling client's owned set (`utils/client-state.ts`); it never falls back to the globally-active tab. Mutating tools without an explicit `tabId` get a fresh background tab auto-spawned and claimed for the client — opt out by setting `static readonly autoSpawnTab = false` on tools that don't need a tab (`pace`, `pace_get`) or that scan the whole browser (`get_windows_and_tabs`, `claim-tab`). Targeting a tab owned by another client returns `TAB_NOT_OWNED`.
- **`pnpm test` should be green — no exemptions.** Every test failure is real; don't dismiss any as flake. The preHandler regression coverage (`preHandler-host.test.ts` / `preHandler-origin.test.ts` / `preHandler-bearer.test.ts`) is active again after the IMP-0123 split into three sibling files (each describe gets its own jest worker). If you find yourself wanting to quarantine a flake, fix the root cause instead — file an IMP if the fix is non-trivial.

---

## E2E verification — required for every chrome-extension change

**Hard rule:** any change touching `app/chrome-extension/` (tools,
inject-scripts, selector strategies, shared library, recorder, popup,
sidepanel, builder, web-editor) MUST be E2E-verified in a real
Chrome before the change is considered shipped. Vitest with mocked
`chrome.*` proves the shape contract; it does NOT prove the tool
works against a live DOM.

The harness:

1. `.mcp.json` at repo root registers both `humanchrome` (HTTP bridge
   at :12306) and `chrome-devtools` (`npx -y chrome-devtools-mcp@latest`)
   so Claude Code sessions in this repo automatically have both
   available.
2. `app/chrome-extension/tests/e2e/fixtures/*.html` — static fixtures
   covering every distinct tool/contract. Anchored sections, one per
   feature, with expected outcomes inline.
3. `docs/E2E-VERIFICATION.md` — the runbook. Self-contained prompt
   for a fresh Claude Code session to execute the full matrix and
   produce a pass/fail per IMP.

Workflow for every chrome-extension PR:

1. `pnpm --filter chrome-extension build` (produces `.output/chrome-mv3/`).
2. If the change added a new tool / selector type / actionability rule
   / dialog action / wait kind / inject-script behaviour: append a row
   (and the matching `<section>`) to `playwright-parity.html` and a
   row to the matrix in `docs/E2E-VERIFICATION.md`. One row per
   distinct contract — don't bloat with per-code-path variants.
3. Open a fresh Claude Code session, run the verification prompt from
   `docs/E2E-VERIFICATION.md`. Expect a clean pass.
4. Any unexpected failures → file as `bug-scout`-format IMP entries in
   `docs/improvement-backlog.md` BEFORE merging. The push is blocked
   until either the bug is fixed or the regression is explicitly
   accepted in the IMP entry.

When NOT required:

- Pure-docs / pure-backlog changes.
- `app/native-server/` (bridge) changes that don't touch the
  extension — the native-server has its own jest suite.
- `packages/shared/` changes that are pure type/schema additions with
  no extension-side consumer (rare; usually the extension consumes
  the schema and so the rule applies).

When in doubt, run it. Skipping E2E for "this is a trivial change"
is how regressions hit production unnoticed — every previous
"trivial" actionability tweak that broke clicks would have been
caught here.

### Never ask the user to drive the browser — own the verification loop

**Hard rule:** Do NOT ask the user to click "Reload" in chrome://extensions,
clear the Errors panel, open the popup/sidepanel/options page, copy a
screenshot of devtools, paste console output, navigate to a URL, or
otherwise do _anything_ in their daily-driver browser. Every recurring
"can you just…" message is a signal that the harness is missing a
capability — go build the capability, don't pile friction onto the user.

How to verify a chrome-extension change WITHOUT user involvement:

1. **Code-deploy is automatic.** `pnpm build:extension` →
   `scripts/sync-installed.mjs` mirrors `.output/chrome-mv3/` into the
   TCC-safe install dir AND writes a fresh `build-info.json`. The
   IMP-0119 self-update watcher in the running SW polls that file via
   `chrome.alarms` every 30s and calls `chrome.runtime.reload()` on
   mismatch — the user's installed extension picks up the new bundle
   without a click. The bootstrap reload happened once (IMP-0119 PR
   #201); never ask for it again.
2. **Direct bridge probes.** While the user's Chrome is open the SW
   spawns `humanchrome-bridge` on :12306. `curl -s -X POST
http://127.0.0.1:12306/api/tools/<name> -H 'content-type:
application/json' -H 'x-client-id: diag' -d '{"args":{...}}'`
   exercises any tool against the LIVE SW. Multi-instance ports are
   resolved via the on-disk registry at
   `~/Library/Application Support/humanchrome-bridge/instances/`
   (IMP-0115). Use this to confirm a fix landed without touching the
   browser.
3. **Spawn your own Chrome.** `pnpm e2e:isolated` (in
   `app/chrome-extension/`) launches Chrome for Testing with the
   extension preloaded, runs the matrix in `scripts/run-e2e-matrix.mjs`,
   tears down cleanly. Per IMP-0114/0115/0111b this runs alongside the
   user's daily Chrome — no need to ask them to quit anything.
4. **chrome-devtools-mcp.** Registered in `.mcp.json`. Drive any URL,
   inspect console messages, take screenshots — all programmatic. The
   `mcp__chrome-devtools__*` tool family is your DevTools panel.
5. **Last resort: Playwright.** If the matrix doesn't cover what you
   need, write a Playwright test under `app/chrome-extension/tests/e2e/`
   that loads the unpacked extension via `chromium.launchPersistentContext`
   with `--load-extension=.output/chrome-mv3` (works because Playwright
   ships Chromium, not stable Chrome — `--load-extension` still works).
   New permanent capabilities go into the matrix runner so the next
   change benefits too.

If your first instinct is to type "can you reload / open / paste /
click…" — stop. Pick #1–#5 above. The user has stated explicitly that
manual browser steps are the single biggest blocker to letting you
work autonomously; treat every avoidance as load-bearing.

When the harness is genuinely missing a capability you need, **build
it** (extend the matrix runner, add a chrome-devtools-mcp helper,
write a Playwright fixture) — that effort pays back the next time and
every time after. Asking the user is free for you and expensive for
them; building infrastructure is the inverse.

---

## Pre-merge guards (tests as contract)

These will fail your PR if you forget a registry update:

- `app/chrome-extension/tests/tools/lazy-tool-registry.test.ts` — every `TOOL_NAMES.BROWSER` and `TOOL_NAMES.RECORD_REPLAY` value is reachable; heavy tools land in `lazyLoaders`, not `eagerTools`.
- `app/native-server/src/scripts/tool-categories-coverage.test.ts` — every `TOOL_SCHEMAS` entry has a `TOOL_CATEGORIES` mapping; no stale labels.
- `packages/shared/src/ipc-schemas.test.ts` — IPC schema shape coverage.
- `app/chrome-extension/tests/record-replay/*.contract.test.ts` and `tests/record-replay-v3/*.contract.test.ts` — adapter-handler parity, legacy node coverage, runner-onError, etc.

When adding a new "must not drift" invariant, name the file `*.contract.test.ts` so the convention is visible.

---

## Where to find things

- **Backlog**: `docs/improvement-backlog.md` — IMP entries follow the format spec in the HTML comment at the top; scoring is computed by `.claude/scripts/triage-backlog.mjs`.
- **Architecture**: `docs/ARCHITECTURE.md`.
- **Performance**: `docs/PERFORMANCE.md`.
- **Logging / troubleshooting**: `docs/LOGGING.md`, `docs/TROUBLESHOOTING.md`.
- **Visual editor**: `docs/VisualEditor.md`.
- **Caller contract** (calling tools, not authoring them): `docs/AGENTS.md`.
- **Auto-generated tool reference**: `docs/TOOLS.md` (regenerate via `cd app/native-server && node scripts/generate-tools-doc.mjs`).
- **E2E verification recipe**: `docs/E2E-VERIFICATION.md` + `app/chrome-extension/tests/e2e/` — runbook + HTML fixtures for real-browser verification driven by `chrome-devtools-mcp` + `humanchrome` side-by-side (the `.mcp.json` at repo root registers both). Use after any push that touches interaction tools, selector strategies, or inject-scripts.

---

## What's intentionally NOT here

- **Vue UI conventions** — read existing `*.vue` files under `entrypoints/popup/`, `sidepanel/`, `builder/`, `web-editor-v2/ui/`. Not stable enough for prescriptive docs.
- **MCP protocol details** — moving target; follow compile errors when `@modelcontextprotocol/sdk` types change.
- **In-flight refactors** — see `docs/improvement-backlog.md` `## Active` for what's mid-slice. Each IMP is its own multi-PR exercise; don't bundle them.
