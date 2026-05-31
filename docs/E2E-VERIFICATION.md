# E2E verification recipe

## TL;DR — `pnpm e2e:full` (unattended)

```bash
pnpm e2e:full      # rebuild everything → reload SW → run matrix → write /tmp/e2e-result.json
pnpm e2e:matrix    # skip the rebuild, just run the matrix against the running SW
```

`scripts/run-e2e-matrix.mjs` talks straight to the bridge's HTTP API on
`:12306` (no MCP, no Claude Code session needed). It probes
`chrome_runtime_info` to verify the SW is on the latest bundle, calls
`chrome_dev_reload` to flush if needed, and walks every matrix row
returning structured pass/fail per IMP.

Exit codes: `0` clean, `1` matrix failure, `2` SW pre-bootstrap (run a
one-time manual reload at `chrome://extensions/?id=hbdgbgagpkpjffpklnamcljpakneikee`
to load `chrome_runtime_info` + `chrome_dev_reload`; every run after that
is unattended), `3` SW reload didn't take effect, `4` fixture navigation
failed.

The rest of this document describes the deeper recipe (manual rows,
chrome-devtools-mcp cross-verification, fixture-addition rules) for
cases where the standalone runner doesn't cover what you need.

---

Real-browser verification of humanchrome tools using
`chrome-devtools-mcp` and `humanchrome` running side-by-side in one
Claude Code session. Catches the things `vitest run` can't:
bbox-stability under animation, true hit-test against styled overlays,
real CDP attach/detach lifecycles, actual selector resolution against
non-mocked DOM.

## Prerequisites

1. Bridge installed and running (`humanchrome-bridge register` once,
   then it auto-starts when Chrome connects).
2. Extension built: `pnpm --filter chrome-extension build` — produces
   `app/chrome-extension/.output/chrome-mv3/`.
3. `.mcp.json` in repo root (already committed) — registers both
   `humanchrome` and `chrome-devtools` servers so Claude Code picks
   them up automatically on session start.
4. Network access for the late-image case (the fixture hits
   `httpbin.org/delay/2`). If running offline, skip the
   `kind:load_state` section.

## Unattended reload pipeline (no human in the loop)

Bridge + extension code changes don't auto-flush. The recipe:

```bash
pnpm build:shared && pnpm build:native && pnpm build:extension
```

…rebuilds everything and `sync-installed.mjs` (postbuild hook on `build:native`)
copies the bridge bundle to `~/Library/Application Support/humanchrome-bridge/`.
The running bridge process (spawned by Chrome native messaging) and the
service-worker still hold the OLD code in memory. To flush them:

- Bridge: `kill $(pgrep -f 'humanchrome-bridge/dist/index.js')` — Chrome
  respawns it on the next native message.
- Service worker: call the MCP tool `chrome_dev_reload` — fires
  `chrome.runtime.reload()` from the SW context which restarts the
  extension and picks up the new `.output/chrome-mv3/` bundle.

Bootstrap caveat: `chrome_dev_reload` itself needs to be present in the
running SW to be callable. If you're on a SW that pre-dates this tool,
do ONE manual reload (`chrome://extensions/?id=...` → reload icon) so the
SW picks up the build that contains the tool, then every subsequent
test cycle is unattended.

## Run

Open a fresh Claude Code session in the repo root. Then prompt:

```
Run the e2e verification per docs/E2E-VERIFICATION.md. Use
chrome-devtools to load the built extension at
app/chrome-extension/.output/chrome-mv3/ and to open the fixture at
app/chrome-extension/tests/e2e/fixtures/playwright-parity.html (use
file:// URL). Then use humanchrome to exercise each section.
Report a pass/fail matrix per IMP. Don't stop at the first failure
— keep going so we get full coverage in one run.
```

Claude will iterate through the matrix below.

## Verification matrix

Each row: section anchor on the fixture, command sketch, expected
outcome. Cross-verify with `chrome-devtools.take_snapshot` after each
action to confirm the DOM ended up where humanchrome thinks it did.

### IMP-0098 — locator engine

| Test                              | humanchrome call                                                                         | Expected                         |
| --------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------- |
| `role + name` exact               | `chrome_click_element({selectorType:'role', selector:'button[name="Submit"]'})`          | clicks `#submit-btn`             |
| `role + name` for link            | `chrome_click_element({selectorType:'role', selector:'link[name="Sign up"]'})`           | navigates `#signup-link`         |
| `role` for div with explicit role | `chrome_click_element({selectorType:'role', selector:'button[name="Custom button"]'})`   | clicks the `<div role="button">` |
| `label` wrapping                  | `chrome_fill_or_select({selectorType:'label', selector:'Username', value:'alice'})`      | fills `#username-in`             |
| `label` with `for`                | `chrome_fill_or_select({selectorType:'label', selector:'Email address', value:'a@b.c'})` | fills `#email-in`                |
| `placeholder`                     | `chrome_fill_or_select({selectorType:'placeholder', selector:'Search…', value:'q'})`     | fills `#search-in`               |
| `alt`                             | `chrome_click_element({selectorType:'alt', selector:'Profile photo'})`                   | clicks the image                 |
| `title`                           | `chrome_click_element({selectorType:'title', selector:'Tooltip target'})`                | clicks the span                  |
| `testid` (none here)              | n/a                                                                                      | covered by unit tests            |

### IMP-0098 — strict mode

| Test                          | call                                                      | Expected                                    |
| ----------------------------- | --------------------------------------------------------- | ------------------------------------------- |
| Multi-match without index     | `chrome_click_element({selector:'.row-btn'})`             | `INVALID_ARGS` + `details.matchCount === 3` |
| Multi-match with `index`      | `chrome_click_element({selector:'.row-btn', index:1})`    | clicks the second `.row-btn`                |
| Multi-match with `multi:true` | `chrome_click_element({selector:'.row-btn', multi:true})` | clicks the first (no error)                 |

### IMP-0097 — actionability

| Test                     | call                                                                      | Expected `failures`           |
| ------------------------ | ------------------------------------------------------------------------- | ----------------------------- |
| display:none             | `chrome_click_element({selector:'#vis-display-none'})`                    | `['not_visible']`             |
| visibility:hidden        | `chrome_click_element({selector:'#vis-visibility'})`                      | `['not_visible']`             |
| opacity:0                | `chrome_click_element({selector:'#vis-opacity'})`                         | `['not_visible']`             |
| pointer-events:none      | `chrome_click_element({selector:'#vis-pointer-events'})`                  | `['not_visible']`             |
| Off-screen + scroll      | `chrome_click_element({selector:'#vis-offscreen'})`                       | succeeds (scrolled into view) |
| Animation mid-flight     | `chrome_click_element({selector:'#sliding-btn'})`                         | `['unstable_bbox']`           |
| Animation w/ force       | `chrome_click_element({selector:'#sliding-btn', force:true})`             | succeeds (lands arbitrary)    |
| Occluded by overlay      | `chrome_click_element({selector:'#occluded-btn'})`                        | `['occluded_by:div#overlay']` |
| Disabled attr            | `chrome_click_element({selector:'#disabled-btn'})`                        | `['disabled']`                |
| aria-disabled            | `chrome_click_element({selector:'#aria-disabled-btn'})`                   | `['disabled']`                |
| Inside disabled fieldset | `chrome_fill_or_select({selector:'#fieldset-disabled-input', value:'x'})` | `['disabled']`                |
| Readonly input           | `chrome_fill_or_select({selector:'#readonly-in', value:'x'})`             | `['not_editable']`            |

### IMP-0100 — proactive dialog

| Step             | call                                                                          | Expected                                                              |
| ---------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Register default | `chrome_handle_dialog({action:'register_default', defaultBehavior:'accept'})` | success; "Chrome is being controlled" banner appears                  |
| Trigger alert    | `chrome_click_element({selector:'#trigger-alert'})`                           | click returns; `#dialog-log` shows the alert text                     |
| Trigger confirm  | `chrome_click_element({selector:'#trigger-confirm'})`                         | click returns; `window.lastConfirm === true`                          |
| List defaults    | `chrome_handle_dialog({action:'list_defaults'})`                              | returns the policy + recent log                                       |
| Unregister       | `chrome_handle_dialog({action:'unregister_default'})`                         | success; banner stays open after another click until manually handled |

### IMP-0101 — locator-handler

| Step                  | call                                                                                                                                                      | Expected                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Register              | `chrome_locator_handler({action:'register', selector:'#cookie-banner.shown', dismissSelector:'#accept-cookies', dismissAction:'click', persistent:true})` | returns `handlerId`                               |
| Trigger banner        | `chrome_click_element({selector:'#show-banner'})`                                                                                                         | banner appears, then auto-dismisses within ~200ms |
| Action after          | `chrome_click_element({selector:'#protected-action'})`                                                                                                    | clicks succeed (banner is gone)                   |
| List                  | `chrome_locator_handler({action:'list'})`                                                                                                                 | `dismissedCount >= 1`, recent `lastDismissedAt`   |
| Persistent across nav | navigate, return, click `#show-banner` again                                                                                                              | handler still fires                               |
| Clear                 | `chrome_locator_handler({action:'clear'})`                                                                                                                | future banners stay                               |

### IMP-0102 — wait_for additions

| Test                             | call                                                                                | Expected                                    |
| -------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------- |
| `kind:url` already-match         | navigate to `#checkout`, then `chrome_wait_for({kind:'url', pattern:'#'})`          | resolves immediately, `alreadyMatched:true` |
| `kind:url` on pushState          | click `#push-state` then `chrome_wait_for({kind:'url', pattern:'/checkout'})`       | resolves after the click fires              |
| `kind:url` regex                 | `chrome_wait_for({kind:'url', pattern:'/\\\\/checkout\\\\?step=\\\\d+/'})`          | resolves on regex match                     |
| `kind:load_state` already-loaded | `chrome_wait_for({kind:'load_state', state:'load'})`                                | resolves immediately                        |
| `kind:load_state` waiting        | click `#load-late-image`, then `chrome_wait_for({kind:'load_state', state:'load'})` | resolves after image loads (~2s)            |

### IMP-0092 — coord-mode empty space

| Test               | call                                                   | Expected                                 |
| ------------------ | ------------------------------------------------------ | ---------------------------------------- |
| Click empty coords | `chrome_click_element({coordinates:{x:9999, y:9999}})` | error envelope, NOT success-with-warning |

### IMP-0095 — await-element absent envelope

| Test                                        | call                                                                                                                                       | Expected                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| Click `#ephemeral-modal`, then await absent | `chrome_click_element({selector:'#ephemeral-modal'})` then `chrome_await_element({selector:'#ephemeral', state:'absent', timeoutMs:3000})` | `success:true, found:false, absent:true` |

### IMP-0096 — file-upload quote-safe

| Test                          | call                                                                 | Expected                                                                                                                                     |
| ----------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Upload with quote in selector | `chrome_upload_file({selector:'input[name="o\\'brien-file"]', ...})` | files attach AND change event dispatches (verify via `evaluate_script: document.querySelector('input[name="o\\'brien-file"]').files.length`) |

### IMP-0093 / IMP-0094 — intercept-response

Out of fixture scope (needs a real network request). Cover instead by
pointing the fixture at any URL that returns a `>1 MiB` JSON payload
and starting `chrome_intercept_response` against it. Verify
`responseBodyTruncation.truncated === true`. For IMP-0094, open
DevTools on the same tab mid-wait and confirm the tool returns
`CDP_DETACHED` immediately rather than hanging.

### IMP-0124..0143 — new-tools coverage (matrix rows added 2026-05-24)

Six matrix rows added in the same PR that ships this section. Each
asserts the canonical happy path for tools that previously had only
vitest coverage:

- **IMP-0127** `chrome_aria_snapshot` — output contains
  `- button "Submit" [ref=ref_…]` against the existing
  `#role-selectors` section.
- **IMP-0126** `chrome_get_attributes` — reads `href=/x` +
  `aria-label=hi` from `#attr-target`.
- **IMP-0125** `chrome_hover` — dispatches hover, then verifies the
  fixture's `mouseover` listener added the `.tooltip-active` class
  via `chrome_get_attributes`. (`:hover` pseudo-class doesn't fire
  from synthesized pointer events in Chromium, so the fixture flips a
  class instead.)
- **IMP-0143** `chrome_type_into` — types `hello` into `#type-target`
  with `perKeyDelayMs:0, jitterMs:0`; asserts `finalValue === 'hello'`.
- **Bug-007** `chrome_combobox_select` — calls
  `{comboboxSelector:'#combobox-input', query:'LangGraph',
  perKeyDelayMs:0, jitterMs:0}` against the keyboard-commit combobox
  fixture and asserts `#combobox-selected.innerText === 'LangGraph'`.
  The fixture's option `click` handler is intentionally a no-op (matches
  LinkedIn Downshift behaviour), so a regression that routes through
  synthetic option-click fails the assertion.
- **Bug-008-probe** `chrome_typeahead_probe` — types a single char into
  `#probe-input` (a static fixture input whose `input` listener fires a
  fetch to `/typeahead-fixture-stub`). Asserts `summary.inputFired` +
  `summary.lookupFetchFired` are true. **Does NOT assert
  `summary.keydownFired`** — its observed value is the Bug-008 divergence
  diagnostic. Compare this row's `summary.keydownFired` between CFT
  (`pnpm e2e:isolated` output) and daily Chrome (run the same probe via
  the bridge against a local fixture) to confirm whether suppressed-
  keydown is environment-uniform or a CFT-vs-daily divergence.
- **IMP-0124** `chrome_emulate` — `set_device({preset:'iphone-15'})`
  then `chrome_javascript({code:'innerWidth'})` returns 393. Calls
  `reset_all` at the end so subsequent rows see the original viewport.
- **IMP-0142** `chrome_set_extra_http_headers` — set/get/clear
  roundtrip on the in-memory tab map (doesn't issue a network request
  against an echo server — that needs httpbin.org and would make the
  row flaky).

## Reporting

End with a single table:

```
IMP-0092: PASS / FAIL
IMP-0093: PASS / FAIL / SKIPPED
...
```

Append any unexpected failures or surprising behaviour to
`docs/improvement-backlog.md` as bug-shaped IMP entries (the
`bug-scout` agent format applies).

## When to update this doc

Whenever a new IMP touches an interaction tool, a selector strategy,
or an inject-script. Add a row + the matching section to
`fixtures/playwright-parity.html`. Keep the matrix lean — one row per
distinct contract, not per code path.
