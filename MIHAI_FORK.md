# Mihai's mcp-chrome fork — six patches

Branch: `mihai-fork`. Target upstream: hangwin/mcp-chrome @ f48e717 (last upstream commit 2026-01-06).

## What's in the fork

| #   | Patch                                                | File(s)                                                                                                           | Status                    |
| --- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 1   | Redaction toggle (`rawOutput` flag)                  | `app/chrome-extension/utils/output-sanitizer.ts`                                                                  | Built ✓ Smoke ✓           |
| 2   | `chrome_javascript` auto-return for bare expressions | `app/chrome-extension/entrypoints/background/tools/browser/javascript.ts`                                         | Built ✓ Smoke ✓           |
| 3   | Per-session McpServer factory (multi-client)         | `app/native-server/src/mcp/mcp-server.ts`, `app/native-server/src/server/index.ts`                                | Built ✓ Smoke ✓           |
| 4   | `fill_or_select` native value-setter for React       | `app/chrome-extension/inject-scripts/fill-helper.js`                                                              | Built ✓ — needs live test |
| 5   | `chrome_intercept_response` new tool                 | `packages/shared/src/tools.ts`, `app/chrome-extension/entrypoints/background/tools/browser/intercept-response.ts` | Built ✓ — needs live test |
| 6   | `POST /admin/reset`                                  | `app/native-server/src/server/index.ts`                                                                           | Built ✓ Smoke ✓           |

## Smoke-test results (no Chrome required)

```bash
# Bridge: T7 multi-client + T11 admin/reset
cd app/native-server && node smoke-test.mjs
# → 4 passed, 0 failed

# Extension: T1, T2 redaction toggle + T4, T5, T6 auto-return
cd app/chrome-extension && node smoke-test.mjs
# → 7 passed, 0 failed
```

## Rollout (live install)

These steps replace the running upstream install. Reversible: `npm install -g mcp-chrome-bridge` restores upstream.

### 1. Build everything

```bash
cd ~/Documents/Code/mcp-chrome-fork
pnpm install --ignore-scripts
pnpm build:shared && pnpm build:native && pnpm build:extension
```

### 2. Replace the bridge

```bash
# stop any running bridge process (the one Chrome's native messaging launched)
# — restarting Chrome is the easy way

npm uninstall -g mcp-chrome-bridge
npm install -g ~/Documents/Code/mcp-chrome-fork/app/native-server
mcp-chrome-bridge register   # rewrites the native-messaging-host manifest
```

### 3. Reload the extension

Open `chrome://extensions/`. Remove the existing chrome-mcp extension (the one
with id matching the unpacked install at `~/.mcp-chrome/extension/`). Click
"Load unpacked" → choose:

```
~/Documents/Code/mcp-chrome-fork/app/chrome-extension/.output/chrome-mv3/
```

Pin it. Click the icon → Connect. The popup should show "Connected".

### 4. Verify live

```bash
curl http://127.0.0.1:12306/ping
# {"status":"ok","message":"pong"}

curl -X POST http://127.0.0.1:12306/admin/reset
# {"ok":true,"cleared":0}   <-- patch 6 reaches production
```

## Live test matrix (T3, T8, T9, T12, T13)

These need a live LinkedIn / form / page. Run in Claude Code via mcp**chrome**\* tools.

| #   | Test                   | Tool calls                                                                                                                                                                     |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T3  | URN through unredacted | After enabling rawOutput in chrome.storage.local: navigate to `linkedin.com/messaging/thread/...`, then `chrome_javascript({code: 'location.href'})`. Expect full URN.         |
| T8  | React fill             | Open Freelancermap "Bewerben" form, `chrome_fill_or_select` the message textarea. The submit button should enable (proves React state updated).                                |
| T9  | Intercept Voyager      | Navigate to `linkedin.com/messaging/`, then `chrome_intercept_response({url_pattern: 'voyager/api/messaging/conversations'})`. Expect parsed JSON body with `entityUrn` field. |
| T10 | Timeout                | `chrome_intercept_response({url_pattern: 'never-match', timeout_ms: 200})`. Expect timeout error within ~250 ms.                                                               |
| T12 | W3 regression          | Run W3 LinkedIn Connect end-to-end: 5 connections from saved-people queue.                                                                                                     |
| T13 | W6 regression          | Run W6 LinkedIn Inbox sweep, capture URN per thread. URNs full base64, no `chunk()` workaround.                                                                                |

## Enabling rawOutput

The redaction bypass is opt-in. Two ways to flip it:

```js
// in the extension's background-page console (chrome://extensions → service worker)
globalThis.__MCP_RAW_OUTPUT__ = true; // live, no reload

// or persist via chrome.storage.local
chrome.storage.local.set({ rawOutput: true });
```

Default (off) preserves the upstream privacy posture. With it on, base64 URNs,
JWT-shaped strings, and cookie/query-shaped data flow through verbatim.

## Reverting to upstream

```bash
npm uninstall -g mcp-chrome-bridge
npm install -g mcp-chrome-bridge
mcp-chrome-bridge register
# In chrome://extensions/ → reload from ~/.mcp-chrome/extension/ (the upstream copy)
```
