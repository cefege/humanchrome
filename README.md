# HumanChrome

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/Node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![Chrome Extension](https://img.shields.io/badge/Chrome-MV3-blue.svg)](https://developer.chrome.com/docs/extensions/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8%2B-blue.svg)](https://www.typescriptlang.org/)

AI controls the Chrome browser you already use, with your real cookies and sessions. Built for the platforms other browser-automation tools choke on: LinkedIn, WhatsApp, Tinder, Facebook, Instagram. Drive it from any MCP client, or skip MCP and call the local HTTP API directly.

```text
your AI client  →  MCP or plain HTTP  →  local bridge  →  Chrome extension  →  your real Chrome
```

## Why this exists

This was built because every other MCP and browser-automation tool fell over on the platforms that matter most: the social and messaging apps with serious anti-bot defenses. LinkedIn flags clean Playwright instances within a session or two. WhatsApp Web wants you to scan a QR code on every fresh launch. Tinder profiles the browser environment hard. Facebook and Instagram send you to checkpoint flows the moment a fingerprint looks off.

The cause is the same in every case. Most "AI browser automation" tools spin up a clean Chromium via Playwright or Puppeteer. That's fine for testing, but on adversarial sites the instance has no usage history and no real cookies. It looks like what it is, a fresh headless-ish browser, and the anti-bot layer flags it.

HumanChrome runs as an extension inside the Chrome you already have open. The AI clicks around in your real session with your real cookies. Nothing about the browser is fresh, so the anti-bot layer has nothing to flag at the environment level. It generalizes to anything Chrome can do, but the design pressure came from those specific sticky platforms.

## Does this fix your problem?

If you searched for any of these, yes:

- "Browser automation that doesn't get flagged as a bot"
- "AI that controls my logged-in LinkedIn account"
- "WhatsApp Web automation without QR scanning every time"
- "Tinder automation that uses my real profile"
- "Facebook automation that doesn't trigger checkpoint"
- "Instagram automation without account locks"
- "MCP server for hard-to-automate sites"
- "MCP server for Chrome that handles multiple clients at once"
- "Chrome extension that doesn't redact base64 IDs, URNs, or JWTs"
- "React form fill that actually triggers `onChange`"
- "Intercept fetch or XHR responses from a Chrome extension"
- "Reset a stuck MCP transport without restarting Chrome"
- "Browser automation alternative to Playwright, Puppeteer, browser-use"
- "Run AI agents on my actual Chrome profile, not a clean one"
- "Local HTTP API for browser automation, no MCP required"

## Built for the hard platforms

The patches that shipped in this codebase came from breaking against real automations on the sites that punish bots hardest. Most of the engineering pressure came from this list:

- **LinkedIn** — message threads, connection-request flows, profile scraping, URN handling through the Voyager API.
- **WhatsApp Web** — message dispatch, contact lookup, multi-thread orchestration without re-pairing every session.
- **Tinder** — profile interactions and messaging on the real account, without tripping device-trust heuristics.
- **Facebook** — feed and profile interactions that survive the checkpoint flow.
- **Instagram** — DM and profile actions on the real account, without account locks.

That bias shaped the fixes: a redaction toggle that preserves base64 URNs and JWTs, a React-compatible form-fill, response interception for fetch/XHR, multi-client MCP sessions, per-tab JS locks, and a way to reset stuck transports without restarting Chrome.

It works for anything else Chrome can do (any site, any tool in the catalog: click, fill, navigate, screenshot, network capture, JS execution, dialog handling, file upload, console capture, history, bookmarks). The platforms above are just where the broken edges lived.

## Quickstart

```bash
# 1. Clone and build the bridge (Node 20+, pnpm)
git clone https://github.com/cefege/humanchrome.git
cd humanchrome
pnpm install
pnpm --filter humanchrome-bridge build

# 2. Install the bridge globally from the built workspace
npm install -g ./app/native-server

# 3. Register the native messaging host
humanchrome-bridge register
```

4. Load the extension in Chrome:
   - Go to `chrome://extensions/`, enable Developer mode.
   - "Load unpacked" → pick `app/chrome-extension/.output/chrome-mv3/` from your clone (or the released zip from the GitHub Releases tab).
   - Click the extension icon, then **Connect**.

5. Confirm the bridge is up:

```bash
curl http://127.0.0.1:12306/ping
# {"status":"ok","message":"pong"}
```

## Use it without MCP (plain HTTP)

The bridge exposes the same browser tools over a plain HTTP REST surface. No MCP session, no protocol overhead. Useful when you're calling from a custom script, the Anthropic SDK, the OpenAI SDK, a curl pipeline, or anything that doesn't speak MCP.

```bash
# List the available tools
curl http://127.0.0.1:12306/api/tools

# Get the OpenAPI spec
curl http://127.0.0.1:12306/api/openapi.json

# Take a screenshot of the active tab
curl -X POST http://127.0.0.1:12306/api/tools/chrome_screenshot \
  -H 'Content-Type: application/json' \
  -d '{"args":{"fullPage":true}}'

# Run JS in the active tab and read it back
curl -X POST http://127.0.0.1:12306/api/tools/chrome_javascript \
  -H 'Content-Type: application/json' \
  -d '{"args":{"code":"document.title"}}'
```

The response shape matches MCP's `CallToolResult`: `content` is an array of items, `isError` is `true` on tool-level failure. Pass an `X-Client-Id` header if you want preferred-tab continuity across calls.

## Use it with MCP

For Claude Desktop, Cursor, Cherry Studio, Continue, or any other MCP-aware client.

### Streamable HTTP (recommended)

```json
{
  "mcpServers": {
    "humanchrome": {
      "type": "streamableHttp",
      "url": "http://127.0.0.1:12306/mcp"
    }
  }
}
```

### Stdio

```json
{
  "mcpServers": {
    "humanchrome": {
      "command": "humanchrome-stdio"
    }
  }
}
```

Multiple clients can connect at once. Each gets its own MCP session, and each session keeps its own preferred-tab state, so two AI clients don't fight over which tab is "current".

## Tools

Roughly 30 tools across these categories. Full reference in [`docs/TOOLS.md`](docs/TOOLS.md).

| Category           | Tools                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| Browser management | `get_windows_and_tabs`, `chrome_navigate`, `chrome_switch_tab`, `chrome_close_tabs`, `chrome_inject_script`   |
| Interaction        | `chrome_click_element`, `chrome_fill_or_select`, `chrome_keyboard`, `chrome_handle_dialog`                    |
| Reading            | `chrome_get_web_content`, `chrome_read_page`, `chrome_get_interactive_elements`, `chrome_screenshot`          |
| Scripting          | `chrome_javascript`, `chrome_userscript`, `chrome_send_command_to_inject_script`                              |
| Network            | `chrome_network_capture`, `chrome_network_request`, `chrome_intercept_response`                               |
| Files              | `chrome_upload_file`, `chrome_handle_download`, `chrome_gif_recorder`                                         |
| State              | `chrome_console`, `chrome_history`, `chrome_bookmark_search`, `chrome_bookmark_add`, `chrome_bookmark_delete` |
| Search             | `search_tabs_content` (semantic vector search across open tabs)                                               |
| Performance        | `performance_start_trace`, `performance_stop_trace`, `performance_analyze_insight`                            |
| Diagnostics        | `chrome_debug_dump`, `chrome_computer`                                                                        |

## Architecture

```text
AI client (MCP or HTTP)
        │
        ▼
Local bridge on :12306 (Fastify, Node)
        │   native messaging
        ▼
Chrome extension (background, popup, sidepanel)
        │
        ▼
Active tab (your real Chrome session)
```

Details in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Configuration

### Output redaction

By default the extension redacts shapes that look like cookies, JWTs, base64 IDs, and URNs from tool output. This keeps you from accidentally leaking session tokens into a chat transcript. Some workflows (LinkedIn URN handling, anything that needs raw API tokens) need that data through verbatim. Two ways to flip it:

```js
// In the extension's background-page console (chrome://extensions → service worker):
globalThis.__MCP_RAW_OUTPUT__ = true; // live, no reload

// Or persist via storage:
chrome.storage.local.set({ rawOutput: true });
```

### Port

Default `12306`. Override with `MCP_HTTP_PORT=12345` before launching the bridge, or change it in the extension settings.

### Node executable path

If the bridge can't find Node on your system, set `HUMANCHROME_NODE_PATH=/path/to/node` before Chrome launches the native host, or run `humanchrome-bridge doctor --fix`.

### Stuck-transport reset

If a session gets jammed mid-init:

```bash
curl -X POST http://127.0.0.1:12306/admin/reset
# {"ok":true,"cleared":N}
```

## FAQ

**Q: Will I get banned from LinkedIn / WhatsApp / Tinder / Facebook / Instagram for using this?**
Automation runs inside the browser session you already use. The fingerprint, login state, and browsing history are yours, so there is nothing fresh for an anti-bot system to flag at the environment level. Behavior is a different story. Anti-bot systems will still catch you if you fire 1000 requests per second or hit identical timing intervals between actions, so pace things at human speed. No tool can guarantee you won't get banned for what you do with it.

**Q: Does this work with Claude Desktop / Cursor / Cherry Studio / Continue?**
Yes. Any MCP-aware client. Use the Streamable HTTP config block above.

**Q: Does this work without MCP?**
Yes. POST to `http://127.0.0.1:12306/api/tools/<name>`. See "Use it without MCP" above. The OpenAPI spec at `/api/openapi.json` is generated from the same tool catalog.

**Q: Does this work in Firefox?**
Not yet. Manifest V3 plus native messaging in Firefox needs a separate code path. Open an issue if you want it.

**Q: How do I debug when something goes wrong?**
The bridge logs to `~/Library/Logs/humanchrome-bridge` (macOS), `%LOCALAPPDATA%\humanchrome-bridge\logs` (Windows), or `~/.local/state/humanchrome-bridge/logs` (Linux). Every tool call is correlated by `requestId`. The `chrome_debug_dump` tool returns the per-call entries. Failures in the live-test harness produce paste-ready markdown prompts under `app/native-server/live-test/results/failures/`.

**Q: Will my prompts and data leave my machine?**
The bridge is local. It listens on `127.0.0.1:12306` and talks to the extension over Chrome's native messaging IPC. Nothing about HumanChrome itself sends data anywhere external. Whatever AI client you connect _to_ the bridge will of course send your tool calls and their results to its own model. That is between you and the client.

More: [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md).

## Contributing

PRs welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup, build commands, and the commit style. Bugs and feature requests go in [GitHub Issues](https://github.com/cefege/humanchrome/issues). Questions and broader discussion in [GitHub Discussions](https://github.com/cefege/humanchrome/discussions).

## License

MIT. See [`LICENSE`](LICENSE).

## Security

Found a vulnerability? Open a private security advisory: <https://github.com/cefege/humanchrome/security/advisories/new>. Do not file a public issue. Details in [`SECURITY.md`](SECURITY.md).

---

Originally derived from earlier open-source work on Chrome-extension-based browser automation.
