# humanchrome-extension

The Chrome extension half of [HumanChrome](https://github.com/cefege/humanchrome). Hosts the AI agent UI (popup, side panel, builder), the workflow record/replay engine, the in-page web editor, and the inject scripts that read/write the active page through the user's real Chrome session.

This package pairs with `humanchrome-bridge` (in `../native-server`), which the extension talks to over Native Messaging to expose the browser to MCP/HTTP clients.

## Build

From the monorepo root:

```bash
pnpm install
pnpm --filter humanchrome-extension build
```

The unpacked MV3 build lands in `.output/chrome-mv3/`. Load it via `chrome://extensions/` → Developer mode → "Load unpacked".

## Develop

```bash
pnpm --filter humanchrome-extension dev
```

WXT runs HMR against the dev profile. Firefox: append `:firefox` to either script.

## Layout

- `entrypoints/background/` — service worker (MCP server, agent handler, record-replay engine, web editor controller, tools)
- `entrypoints/popup/` — toolbar popup with the workflow builder
- `entrypoints/sidepanel/` — agent chat side panel
- `entrypoints/builder/` — standalone workflow editor window
- `entrypoints/web-editor-v2/` — in-page visual editor (shadow DOM)
- `inject-scripts/` — content scripts injected into target pages
- `shared/selector/` — selector generation + stability scoring (used by both the extension and the native bridge)

See [`../../docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) for the full system overview.
