# Live tests

End-to-end tests that drive the running MCP bridge against a real Chrome
instance. Locks down the contracts the unit-level smoke tests can only
mirror.

## Run

```bash
# 1. Build extension and bridge (if you haven't already today)
pnpm --filter humanchrome-shared build
pnpm --filter humanchrome-extension build
pnpm --filter humanchrome-bridge build

# 2. Make sure Chrome is running with the extension loaded
#    (chrome://extensions → load unpacked → app/chrome-extension/.output/chrome-mv3/)
#    The extension auto-spawns the native host which listens on :12306.

# 3. Run the suite
node app/native-server/live-test/run.mjs
```

`--with-manual` runs tests gated on a human action (e.g. DevTools-open).

## Output

```
app/native-server/live-test/results/
├── live-test-results.jsonl   # one assertion per line
├── live-test-summary.md      # human-scannable pass/fail
└── failures/
    └── <test-name>.md         # per-failure copy-pasteable LLM prompt
```

Every failure entry includes:

- args sent to the tool
- expected contract
- actual response
- the extension-side debug-log entries correlated by `requestId`
- a "diagnosis prompt" tail you can paste into an LLM with no other context

## Test categories

| File                  | Locks down                                                                    |
| --------------------- | ----------------------------------------------------------------------------- |
| `01-navigate.mjs`     | Bridge reachable; navigate dispatches; bogus `tabId` doesn't silently succeed |
| `02-read-page.mjs`    | Tree mode, fallback path, `raw:true` round-trip, truncation envelope          |
| `03-click-fill.mjs`   | Click by selector + verify in-page state; fill text + select                  |
| `04-error-codes.mjs`  | `TAB_NOT_FOUND`, `INVALID_ARGS`, `INJECTION_FAILED` (or fallback)             |
| `05-tab-safety.mjs`   | `TARGET_NAVIGATED_AWAY` race in click; `TAB_CLOSED` mid-call                  |
| `06-multi-client.mjs` | Two clients, implicit calls hit each client's preferred tab                   |
| `07-per-tab-lock.mjs` | Two parallel JS calls on same tab → serialized FIFO                           |
| `08-truncation.mjs`   | `chrome_console` `argsTruncated` round-trip; JS output cap                    |
| `09-debug-dump.mjs`   | requestId correlation; ordered start/done entries; invalid-level rejection    |

## Adding a test

1. Drop a new `<NN>-name.mjs` in `tests/`.
2. Default-export an array of `{name, run(ctx)}`. `ctx` is `{A, B, fixtureBase, skipManual}`.
3. Each test returns one or more `outcome(...)` records (use the helpers in `assertions.mjs`).
4. Don't `throw` — record `FAIL` and move on. The runner catches throws as test bugs.

## Why a custom harness instead of vitest/jest

The bridge runs out-of-process in Chrome's native-host context. We're
asserting against a live system, not unit-testing a module. A bespoke
runner gives us:

- one-shot HTTP client without test-framework lifecycle churn
- direct JSONL output the LLM can consume cold
- per-failure markdown files that copy-paste into a prompt
- skip-by-default for tests that need DevTools or other manual setup
