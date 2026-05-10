# Authoring a new MCP tool

Long-form companion to the 5-file recipe in [`/CLAUDE.md`](../CLAUDE.md). Read CLAUDE.md first for the orientation; this doc supplies templates and per-step commentary.

---

## New tool vs. extend existing

Add a new tool when the surface is **a new verb on a new noun**. Extend an existing tool when the surface is **the same noun, a new mode** — a new action on an existing dispatcher.

| Scenario                                                                                | Add new tool             | Extend existing |
| --------------------------------------------------------------------------------------- | ------------------------ | --------------- |
| Wrap a chrome.\* API not yet exposed (`chrome.idle`, `chrome.alarms`)                   | yes                      |                 |
| Add a `status` / new action to an existing multi-action tool                            |                          | yes             |
| High-level alias / convenience input on existing tool                                   |                          | yes             |
| Cross-cutting capability split into siblings (e.g. `download_list` + `download_cancel`) | yes (one PR per sibling) |                 |
| Close a CRUD lifecycle gap (delete for a noun that has create/list)                     | yes                      |                 |

When unsure, find the closest sibling in `docs/improvement-backlog.md` § Done — its summary records which way the boundary was drawn and why.

---

## File 1 — `tools/browser/<slug>.ts`

Single-action skeleton. Save as `app/chrome-extension/entrypoints/background/tools/browser/<slug>.ts`:

```ts
import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';

export interface FooParams {
  bar?: string;
  tabId?: number;
}

class FooTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.FOO;
  static readonly mutates = true;

  async execute(args: FooParams = {}): Promise<ToolResult> {
    if (!args.bar) {
      return createErrorResponse('`bar` (string) is required.', ToolErrorCode.INVALID_ARGS, {
        arg: 'bar',
      });
    }
    if (!chrome.someApi?.someMethod) {
      return createErrorResponse(
        'chrome.someApi.someMethod is unavailable. The "someApi" permission is required.',
        ToolErrorCode.UNKNOWN,
      );
    }
    try {
      const result = await chrome.someApi.someMethod(args.bar);
      return jsonOk({ ok: true, value: result });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/no tab with id/i.test(msg)) {
        return createErrorResponse(`Tab not found: ${msg}`, ToolErrorCode.TAB_CLOSED);
      }
      return createErrorResponse(`chrome_foo failed: ${msg}`, ToolErrorCode.UNKNOWN);
    }
  }
}

// Local helper — every tool currently defines its own copy. There's an open
// task to extract this to a shared module; until then, copy as-is.
function jsonOk(body: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false };
}

export const fooTool = new FooTool();
```

Multi-action tools use an `action` enum and a switch (or a `HANDLERS` dispatch table once you cross ~5 actions). Canonical: `tools/browser/tab-groups.ts`.

`BaseBrowserToolExecutor` provides:

- `this.getActiveTabOrThrowInWindow(windowId?)` — resolve the target tab, falling back to the current window's active tab.
- `this.injectContentScript(tabId, files, immediate?, world?, allFrames?, frameIds?)` — idempotent inject + readiness ping.
- `this.sendMessageToTab(tabId, msg, frameId?)` — wraps `chrome.tabs.sendMessage` with `TAB_CLOSED` / `TARGET_NAVIGATED_AWAY` classification.
- `this.snapshotTabState(tabId)` + `this.assertSameDocument(snap)` (or the wrapper `this.withNavigationGuard(tabId, fn)`) — detect mid-call navigation.

---

## File 2 — `packages/shared/src/tools.ts` (3 appends)

Append-only. Never reorder existing entries.

```ts
// 1. TOOL_NAMES.BROWSER — append at the end of the BROWSER object
FOO: 'chrome_foo',

// 2. TOOL_SCHEMAS — append before the closing `];`
{
  name: TOOL_NAMES.BROWSER.FOO,
  description:
    'One-paragraph description in plain English. Tell the agent (a) what the tool does, ' +
    '(b) when to reach for it vs alternatives, (c) the return shape, (d) error semantics. ' +
    'Be specific about side effects ("idempotent", "mutates the X registry"). ' +
    '200-400 chars is typical.',
  inputSchema: {
    type: 'object',
    properties: {
      bar: { type: 'string', description: 'What bar means to the caller.' },
      tabId: { type: 'number', description: 'Target tab. Falls back to the active tab when omitted.' },
    },
    required: ['bar'],
  },
},

// 3. TOOL_CATEGORIES — append before the RECORD_REPLAY block
[TOOL_NAMES.BROWSER.FOO]: 'Interaction',
```

Valid category labels live in `TOOL_CATEGORY_ORDER` in the same file (`Browser management`, `Reading`, `Interaction`, `Scripting`, `Network`, `Files`, `State`, `System`, `Performance`, `Diagnostics`, `Pacing`, `Workflows`). The string is type-checked against that array — typos are compile errors.

---

## File 3 — `tools/browser/index.ts` (barrel)

```ts
// ... existing exports ...
export { fooTool } from './foo';
```

---

## File 4 — `tools/index.ts` (dispatcher)

Eager (most tools):

```ts
import { fooTool } from './browser/foo';

const eagerTools: ToolInstance[] = [
  // ...
  fooTool,
];
```

Lazy (heavy bundles — tensorflow / sharp / ffmpeg deps, anything wrapping `chrome.debugger` or CDP, anything ~50 KB+ minified):

```ts
const lazyLoaders: Record<string, LazyLoader> = {
  // ...
  [TOOL_NAMES.BROWSER.FOO]: async () => (await import('./browser/foo')).fooTool,
};
```

`lazy-tool-registry.test.ts` enforces (a) every `TOOL_NAMES.BROWSER` / `TOOL_NAMES.RECORD_REPLAY` value is reachable through one of the two registries, (b) heavy tools stay in `lazyLoaders` so the SW boot bundle doesn't regress.

---

## File 5 — `tests/tools/browser/<slug>.test.ts`

8-15 cases minimum: arg validation per branch, happy path per action, error classifications (`TAB_CLOSED`, `INVALID_ARGS`, `UNKNOWN`), missing-permission / missing-API path.

```ts
/**
 * chrome_foo tests (IMP-NNNN).
 *
 * Locks the contract: <one-line summary of what the tool guarantees>.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fooTool } from '@/entrypoints/background/tools/browser/foo';

let someMethodMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  someMethodMock = vi.fn().mockResolvedValue({ ok: true });
  (globalThis.chrome as any).someApi = { someMethod: someMethodMock };
  (globalThis.chrome as any).tabs = {
    ...(globalThis.chrome as any).tabs,
    query: vi.fn().mockResolvedValue([{ id: 7, windowId: 1 }]),
  };
});

afterEach(() => {
  delete (globalThis.chrome as any).someApi;
});

function parseBody(res: any): any {
  return JSON.parse(res.content[0].text);
}

describe('chrome_foo', () => {
  it('rejects when bar is missing', async () => {
    const res = await fooTool.execute({});
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('INVALID_ARGS');
    expect((res.content[0] as any).text).toContain('bar');
  });

  it('returns the value from chrome.someApi.someMethod', async () => {
    someMethodMock.mockResolvedValueOnce({ ok: true, value: 42 });
    const body = parseBody(await fooTool.execute({ bar: 'baz' }));
    expect(body.ok).toBe(true);
    expect(body.value).toEqual({ ok: true, value: 42 });
    expect(someMethodMock).toHaveBeenCalledWith('baz');
  });

  it('classifies "no tab with id" as TAB_CLOSED', async () => {
    someMethodMock.mockRejectedValueOnce(new Error('No tab with id: 99'));
    const res = await fooTool.execute({ bar: 'baz' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('TAB_CLOSED');
  });

  it('returns UNKNOWN when chrome.someApi is missing', async () => {
    delete (globalThis.chrome as any).someApi;
    const res = await fooTool.execute({ bar: 'baz' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain('UNKNOWN');
  });
});
```

If a tool holds module-scope state (a cache, a Map, an injected-tabs registry), export an underscore-prefixed reset/seed:

```ts
// in foo.ts
let cachedFoo: Foo | undefined;

export function _resetFooCacheForTest(): void {
  cachedFoo = undefined;
}
```

```ts
// in foo.test.ts
import { fooTool, _resetFooCacheForTest } from '@/entrypoints/background/tools/browser/foo';

beforeEach(() => {
  _resetFooCacheForTest();
});
```

To drive a private method directly without `eslint-disable`, cast through `unknown`:

```ts
const result = (fooTool as unknown as { privateMethod: (x: number) => string }).privateMethod(42);
```

The pattern is used widely in the native-server engine tests (e.g. `app/native-server/src/agent/engines/claude.build-run-options.test.ts`) and applies the same way here.

---

## Manifest permissions

If the tool needs a chrome permission the extension doesn't already declare, add it to `app/chrome-extension/wxt.config.ts` under `manifest.permissions` (or `optional_permissions` for ones that should prompt at first use).

The current set lives in `wxt.config.ts` — grep before adding to avoid duplicates. Common API → permission mappings: `chrome.alarms.*` → `"alarms"`, `chrome.identity.*` → `"identity"` + an `oauth2` block, `chrome.proxy.*` → `"proxy"`, `chrome.browsingData.*` → `"browsingData"`. `chrome.idle` and `chrome.downloads` are already declared.

When in doubt, try without the permission first, see what Chrome refuses, then add the minimum needed.

---

## Verification, in order

```bash
# 1. Rebuild shared so the new TOOL_NAMES entry is in dist/
cd packages/shared && npm run build

# 2. Typecheck the extension against the new entry
cd ../../app/chrome-extension && npx tsc --noEmit -p .

# 3. Run the new test + the registry shape guard
npx vitest run --reporter=dot tests/tools/browser/<slug>.test.ts tests/tools/lazy-tool-registry.test.ts

# 4. Regenerate the auto-doc (so docs/TOOLS.md reflects the new tool)
cd ../native-server && node scripts/generate-tools-doc.mjs

# 5. Run bridge tests ONLY if you touched bridge code
npm test
```

If any step fails, fix before proceeding. Don't paper over typecheck or test failures.

---

## Move the IMP entry to Done

When the PR is ready to open, edit `docs/improvement-backlog.md`: remove the IMP entry from `## Active`, append it to `## Done` with a one-paragraph summary covering what shipped, the action surface, error classification, test count, and manifest delta. Mirror the format of the most recent Done entries.

---

## Commit and PR

Conventional Commits, with the IMP id and Co-Author footer:

```
feat(extension): add chrome_foo tool — wraps chrome.someApi.someMethod (IMP-NNNN)

<2-3 paragraph body covering what the tool does, the action surface,
error classification, test count, manifest delta. Mirror the structure
of recent Done summaries.>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

PR body — copy a recent merged tool PR for the canonical shape:

```markdown
## Summary

- One bullet per line: what the tool is, what it returns, error semantics.

## Test plan

- [x] `npm run build` in `packages/shared`
- [x] `npx tsc --noEmit -p .` in `app/chrome-extension`
- [x] N new tests at `tests/tools/browser/<slug>.test.ts`
- [x] `tests/tools/lazy-tool-registry.test.ts` — confirms TOOL_NAMES.BROWSER.FOO is registered
- [ ] Full extension suite + bridge (deferred to CI)
```
