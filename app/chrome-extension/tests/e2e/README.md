# E2E verification fixtures

Static HTML fixtures driven by `chrome-devtools-mcp` + `humanchrome`
side-by-side to validate that the new tools actually behave in a real
Chrome (versus only being unit-tested with mocked `chrome.*` APIs in
`tests/tools/`).

These are NOT vitest tests — they're plain HTML pages served from disk
or any static server, with a runbook in `docs/E2E-VERIFICATION.md` that
a Claude Code session executes against them.

## When to run

After any push that touches:

- Selector resolution (`shared/selector/*`, `inject-scripts/accessibility-tree-helper.js`)
- Actionability (`inject-scripts/actionability.js`, the per-action wiring)
- Dialog handling (`tools/browser/dialog.ts`)
- The locator-handler tool
- The wait_for tool (new kinds)
- The intercept-response / network-capture path
- Any inject-script that's part of an interaction tool's hot path

Unit tests with mocked `chrome.*` cover shape contracts; this layer
catches the things mocks can't — bbox-stability under animation, true
hit-test against a styled overlay, real CDP attach/detach lifecycles.

## How to run

See `docs/E2E-VERIFICATION.md` for the full recipe. Short version:

1. Build the extension: `pnpm --filter chrome-extension build`
2. Start the bridge if not already running.
3. Open a fresh Claude Code session in this repo (it picks up
   `.mcp.json`, which registers both `humanchrome` and
   `chrome-devtools` MCP servers).
4. Tell Claude: "run the e2e verification per `docs/E2E-VERIFICATION.md`".

Claude will:

- Install the built extension via `chrome-devtools.install_extension`
- Serve / open the fixture via `chrome-devtools.navigate_page`
- Exercise each section using the `humanchrome` tools
- Verify outcomes via `chrome-devtools.take_snapshot` /
  `take_screenshot` / `evaluate_script`
- Report a pass/fail matrix

## Layout

- `fixtures/playwright-parity.html` — composite fixture for the
  10-IMP Playwright-parity push (IMP-0092..0102). Anchored sections,
  one per feature, with expected outcomes inline.

Add fixtures here as new tool surfaces ship; keep one fixture per
push (composite is fine if the features interrelate) so the runbook
stays diff-friendly.
