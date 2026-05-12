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

4. **Dispatcher — append-only.** Edit `tools/index.ts`: add the import, push the singleton into `eagerTools`. (IMP-0056's eager+lazy split was reverted in IMP-0086 — Rolldown hoisted the dynamic imports back to static AND made lazy chunks back-edge import `BaseBrowserToolExecutor` from `background.js`, which crashed the MV3 service worker at registration. All tools are eager again until `Base` is moved to a leaf module.)

5. **Tests.** Create `tests/tools/browser/<slug>.test.ts`. 8-15 cases: arg validation, happy path per action, error classifications, missing-API/permission path. Vitest; mock `chrome.*` via `(globalThis.chrome as any).<api> = { ... }` in `beforeEach`. Canonical shapes: `idle.test.ts` (single-action), `drag-drop.test.ts` (MAIN-world shim), `keyboard-shortcuts.test.ts` (uses `_resetXForTest` helper).

After the 5 edits:

- `cd packages/shared && npm run build` — regenerates `dist/` so the extension typechecks against the new TOOL_NAMES entry.
- `cd app/chrome-extension && npx tsc --noEmit -p .` — must be clean.
- `npx vitest run --reporter=dot tests/tools/browser/<slug>.test.ts` — must pass.
- `cd app/native-server && node scripts/generate-tools-doc.mjs` — regenerates `docs/TOOLS.md`.
- `cd app/native-server && npm test` only if bridge code was touched.

Long-form templates with copy-pasteable file scaffolds: [`docs/AUTHORING-A-TOOL.md`](docs/AUTHORING-A-TOOL.md).

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
- **CI flake to ignore.** `app/native-server/src/server/preHandler.test.ts` has a 5s-timeout flake under parallel jest load; re-run in isolation before treating as a regression.

---

## Pre-merge guards (tests as contract)

These will fail your PR if you forget a registry update:

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

---

## What's intentionally NOT here

- **Vue UI conventions** — read existing `*.vue` files under `entrypoints/popup/`, `sidepanel/`, `builder/`, `web-editor-v2/ui/`. Not stable enough for prescriptive docs.
- **MCP protocol details** — moving target; follow compile errors when `@modelcontextprotocol/sdk` types change.
- **In-flight refactors** — see `docs/improvement-backlog.md` `## Active` for what's mid-slice. Each IMP is its own multi-PR exercise; don't bundle them.
