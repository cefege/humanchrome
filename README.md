<div align="center">

<img src="app/chrome-extension/public/icon/128.png" width="72" alt="HumanChrome logo">

# HumanChrome

**Built for AI engineers. Give your agents the real, signed-in Chrome you already use — cookies, sessions, history and all — so they work on the platforms that flag everything else.**

HumanChrome is browser control for AI engineers. It runs as an extension inside the Chrome you already have open, so when an agent clicks, types, scrolls, reads the DOM, or taps the network, it does it in your real session with your real cookies. Drive it from any MCP client — Claude Code, Claude Desktop, Cursor, Codex CLI, Continue, Cherry Studio — or skip MCP entirely and call a local HTTP API. It generalizes to anything Chrome can do, but the design pressure came from the platforms that punish automation hardest: LinkedIn, WhatsApp, Tinder, Facebook, Instagram.

_Built by Mihai Mateias, an AI engineer. The tool I point my own agents at when the target site fights back — real infrastructure, not a demo._

[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg)
![Chrome](https://img.shields.io/badge/chrome-MV3-blue.svg?logo=googlechrome&logoColor=white)
![TypeScript](https://img.shields.io/badge/typescript-6%2B-blue.svg?logo=typescript&logoColor=white)

</div>

## What it is

HumanChrome lets an AI drive the Chrome you already use, in your real logged-in session. It runs as an extension inside your open browser and exposes every browser action — click, fill, navigate, screenshot, run JS, capture network, handle dialogs, upload files, read console, history, and bookmarks — to your AI client. You reach it two ways: over MCP from any MCP-aware client, or over a plain local HTTP API from a script, an SDK, or a curl pipeline.

```text
your AI client  →  MCP or plain HTTP  →  local bridge  →  Chrome extension  →  your real Chrome
```

It generalizes to anything Chrome can do on any site, but it was built under pressure from the platforms other automation tools choke on: the social and messaging apps with serious anti-bot defenses.

## The problem

Most "AI browser automation" spins up a clean Chromium via Playwright or Puppeteer. That's fine for testing, but on adversarial sites the instance has no usage history and no real cookies. It looks like exactly what it is — a fresh, headless-ish browser — and the anti-bot layer flags it. LinkedIn flags clean Playwright within a session or two. WhatsApp Web wants a QR scan on every fresh launch. Tinder profiles the browser environment hard. Facebook and Instagram push you into checkpoint flows the moment a fingerprint looks off.

HumanChrome runs inside the Chrome you already have open. The AI clicks around in your real session with your real cookies. Nothing about the browser is fresh, so the anti-bot layer has nothing to flag at the environment level.

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

## What you get

**Your real browser, not a fresh one.** The agent acts inside the Chrome you already have open, with your cookies, your login state, and your browsing history. There's nothing fresh for an anti-bot layer to flag at the environment level, because nothing about the environment is fresh.

**Tuned for the platforms that punish bots.** The patches in this codebase came from breaking against real automations on the sites that punish automation hardest — LinkedIn message threads, connection-request flows, and Voyager-API URN handling; WhatsApp Web dispatch and contact lookup without re-pairing every session; Tinder, Facebook, and Instagram profile and messaging actions that survive device-trust and checkpoint heuristics. Everything else Chrome can do works too; those platforms are just where the broken edges lived.

**MCP or plain HTTP, your choice.** The same tool catalog is exposed both ways. Point any MCP-aware client at it, or POST to a local REST surface with a generated OpenAPI spec when you're calling from a custom script, the Anthropic or OpenAI SDK, or a curl pipeline that doesn't speak MCP.

**Multiple clients, no tab fights.** Several clients can connect at once. Each MCP session keeps its own preferred-tab state, and per-tab JS locks keep concurrent calls from stepping on each other, so two AI clients don't fight over which tab is "current".

**Data that survives the round-trip.** By default the extension redacts cookies, JWTs, base64 IDs, and URNs so you don't leak session tokens into a chat transcript. One toggle passes them through verbatim for the workflows that genuinely need raw values, like LinkedIn URN handling.

**Automation that behaves like a real page.** A React-compatible form-fill that actually fires the `onChange` events frameworks listen for, fetch/XHR response interception from inside the page, screenshots, arbitrary JS execution, dialog handling, file upload, and console + network capture.

**Unstick without a restart.** If a session jams mid-init, reset the transport with a single call — no Chrome relaunch, no re-pairing.

**Local by construction.** The bridge listens on `127.0.0.1` and talks to the extension over Chrome's native-messaging IPC. HumanChrome itself sends nothing to any external service.

## How it works

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

The bridge is a native-messaging host that exposes the browser tool catalog over both an MCP endpoint and a plain HTTP REST surface. Chrome's extension does the actual work in your live session. For the full tour, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Install

HumanChrome needs Node 24+ and pnpm, plus Google Chrome or Chromium. Quickstart:

```bash
# 1. Clone and build the bridge (Node 24+, pnpm)
git clone https://github.com/cefege/humanchrome.git
cd humanchrome
pnpm install
pnpm --filter humanchrome-bridge build

# 2. Deploy to a stable install dir outside the repo, then install globally
SAFE_DIR="$HOME/Library/Application Support/humanchrome-bridge"
pnpm deploy --filter humanchrome-bridge --prod --legacy "$SAFE_DIR"
npm install -g "$SAFE_DIR"

# 3. Register the native messaging host
humanchrome-bridge register
```

> **Why deploy outside the repo.** Don't `npm install -g ./app/native-server`
> from inside the workspace — pnpm intercepts that and creates a global symlink
> back into the repo, which on macOS often sits under `~/Documents`. That
> matters because macOS TCC blocks Chrome from `exec()`'ing scripts under
> `~/Documents`, `~/Desktop`, `~/Downloads`, `~/Pictures`, `~/Movies`,
> `~/Music`, or iCloud Drive — even with Full Disk Access. Registration
> succeeds but every `connectNative()` silently fails, with Chrome reporting
> `Native host has exited.` `humanchrome-bridge register` refuses to write a
> manifest pointing into a TCC-protected dir, and `humanchrome-bridge doctor`
> flags existing bad manifests from earlier installs.

4. Load the extension in Chrome:
   - Go to `chrome://extensions/`, enable Developer mode.
   - "Load unpacked" → pick `app/chrome-extension/.output/chrome-mv3/` from your clone (or the released zip from the GitHub Releases tab).
   - Click the extension icon, then **Connect**.

5. Confirm the bridge is up:

```bash
curl http://127.0.0.1:12306/ping
# {"status":"ok","message":"pong"}
```

### Connect an MCP client

For Claude Code, Claude Desktop, Cursor, Codex CLI, Continue, Cherry Studio, or any other MCP-aware client.

**Streamable HTTP (recommended)**

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

**Stdio**

```json
{
  "mcpServers": {
    "humanchrome": {
      "command": "humanchrome-stdio"
    }
  }
}
```

Drop one of the JSON blocks above into your client's MCP config file:

| Client                | Config path                                                                                                                          | Format |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| **Claude Code** (CLI) | `claude mcp add humanchrome --transport http http://127.0.0.1:12306/mcp` (or edit `~/.claude.json` directly)                         | JSON   |
| **Claude Desktop**    | macOS: `~/Library/Application Support/Claude/claude_desktop_config.json` <br> Windows: `%APPDATA%\Claude\claude_desktop_config.json` | JSON   |
| **Cursor**            | Project-scoped: `.cursor/mcp.json` <br> Global: `~/.cursor/mcp.json`                                                                 | JSON   |
| **Codex CLI**         | `~/.codex/config.toml` (use the TOML equivalent — `[mcp_servers.humanchrome]` table)                                                 | TOML   |
| **Continue**          | `~/.continue/config.yaml` (use the YAML `mcpServers:` mapping)                                                                       | YAML   |
| **Cherry Studio**     | Settings → MCP Servers → Add (paste the JSON block)                                                                                  | UI     |

After saving, restart the client. You should see `humanchrome` and its tools in the client's MCP tool list. Multiple clients can connect at once, and each keeps its own preferred-tab state.

### Or use it without MCP (plain HTTP)

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

## Tools

Full reference (categorized, with parameters) in [`docs/TOOLS.md`](docs/TOOLS.md) — generated from the schemas in `packages/shared/src/tools.ts`, refresh with `pnpm -w build && pnpm --filter humanchrome-bridge run docs:tools`. For the multi-tab "open many, drain serially" pattern, see [Multi-tab fan-out workflow](docs/TOOLS.md#multi-tab-fan-out-workflow).

## HumanChrome vs. clean-browser automation

Playwright, Puppeteer, and browser-use spin up a fresh browser you script against. That's the right tool for testing and for sites that don't care who's driving. On adversarial platforms it's the wrong shape: a clean instance with no history and no real cookies is exactly what the anti-bot layer is built to catch. HumanChrome inverts that — it drives the browser you already live in.

|                      | Playwright / Puppeteer / browser-use                                | HumanChrome                                             |
| -------------------- | ------------------------------------------------------------------- | ------------------------------------------------------- |
| **Browser instance** | Fresh Chromium you spawn                                            | The Chrome you already have open                        |
| **Cookies & login**  | None; you script login on every run                                 | Your real, already-signed-in sessions                   |
| **Anti-bot posture** | Flagged as fresh / headless-ish on LinkedIn, WhatsApp, Tinder, etc. | Nothing fresh at the environment level to flag          |
| **WhatsApp Web**     | QR scan on every fresh launch                                       | Your already-paired session                             |
| **Interface**        | A library you write code against                                    | MCP tool catalog or plain HTTP, driven by any AI client |
| **Where it runs**    | A browser you spawn and own                                         | Your everyday Chrome profile                            |

HumanChrome isn't a replacement for headless testing frameworks; it's the piece they can't be, which is native automation of the real, trusted browser you already use.

## FAQ

**Q: Will I get banned from LinkedIn / WhatsApp / Tinder / Facebook / Instagram for using this?**
Automation runs inside the browser session you already use. The fingerprint, login state, and browsing history are yours, so there is nothing fresh for an anti-bot system to flag at the environment level. Behavior is a different story. Anti-bot systems will still catch you if you fire 1000 requests per second or hit identical timing intervals between actions, so pace things at human speed. No tool can guarantee you won't get banned for what you do with it.

**Q: Does this work with Claude Desktop / Cursor / Cherry Studio / Continue?**
Yes. Any MCP-aware client. Use the Streamable HTTP config block above.

**Q: Does this work without MCP?**
Yes. POST to `http://127.0.0.1:12306/api/tools/<name>`. See "Or use it without MCP" above. The OpenAPI spec at `/api/openapi.json` is generated from the same tool catalog.

**Q: Does this work in Firefox?**
No, and not planned. The native messaging host registers Chrome/Chromium hosts only. Adding Firefox would need MV3 + a separate `~/.mozilla/native-messaging-hosts/` registration path. Open an issue if you want to discuss it.

**Q: How do I debug when something goes wrong?**
The bridge logs to `~/Library/Logs/humanchrome-bridge` (macOS), `%LOCALAPPDATA%\humanchrome-bridge\logs` (Windows), or `~/.local/state/humanchrome-bridge/logs` (Linux). Every tool call is correlated by `requestId`. The `chrome_debug_dump` tool returns the per-call entries. Failures in the live-test harness produce paste-ready markdown prompts under `app/native-server/live-test/results/failures/`.

**Q: Will my prompts and data leave my machine?**
The bridge is local. It listens on `127.0.0.1:12306` and talks to the extension over Chrome's native messaging IPC. Nothing about HumanChrome itself sends data anywhere external. Whatever AI client you connect _to_ the bridge will of course send your tool calls and their results to its own model. That is between you and the client.

More: [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md).

## Status

Honest about what's solid. HumanChrome is what I drive my own agents with daily, so the paths I hit are real.

- **Chrome / Chromium only.** The native-messaging host registers Chrome/Chromium hosts; Firefox isn't supported and isn't planned.
- **Cross-platform bridge, macOS-detailed install.** The bridge runs and logs on macOS, Windows, and Linux; the install walkthrough above (and its TCC caveat) is written for macOS.
- **Forked and reoriented.** Descended from `mcp-chrome`, rebranded, switched to English, and pointed at hard-to-automate platforms.

## Built with

- **Extension:** WXT + Vue 3 + Tailwind CSS 4, Manifest V3, TypeScript, Zod schemas, on-device embeddings (`@huggingface/transformers`, `hnswlib-wasm`) for tool selection
- **Bridge:** Node 24, Fastify 5, `@modelcontextprotocol/sdk` (MCP over Streamable HTTP + stdio), a plain HTTP/OpenAPI surface, `better-sqlite3` + Drizzle ORM, `pino` logging, `commander` CLI
- **Transport:** Chrome native messaging (bridge ↔ extension), MCP or plain HTTP (AI client ↔ bridge)

## Built by

HumanChrome is designed, built, and operated by one AI engineer, [Mihai Mateias](https://github.com/cefege). It isn't a portfolio piece assembled to look good in a repo. It's the tool I point my own coding agents at when a site fights back, which is why the hard parts are real and load-bearing: an extension that drives your actual signed-in session instead of a clean Chromium, a redaction layer that knows the difference between a leaked token and a LinkedIn URN you actually need, a React-aware form-fill that fires the events the framework listens for, fetch/XHR response interception from inside the page, multi-client MCP sessions that don't fight over the active tab, and a transport you can reset mid-jam without restarting Chrome.

If you hire AI engineers who ship production systems end to end rather than prototypes, this repository is the resume. Read the code, then read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

Reach me on [GitHub](https://github.com/cefege) or [LinkedIn](https://de.linkedin.com/in/mihai-mateias).

## Contributing

PRs welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup, build commands, and the commit style. Bugs and feature requests go in [GitHub Issues](https://github.com/cefege/humanchrome/issues). Questions and broader discussion in [GitHub Discussions](https://github.com/cefege/humanchrome/discussions).

## Security

Found a vulnerability? Open a private security advisory: <https://github.com/cefege/humanchrome/security/advisories/new>. Do not file a public issue. Details in [`SECURITY.md`](SECURITY.md).

## License

MIT. See [`LICENSE`](LICENSE).

---

Forked from [hangwin/mcp-chrome](https://github.com/hangwin/mcp-chrome) (MIT). The fork rebrands the project, switches the UI to English, and reorients it around hard-to-automate platforms.
