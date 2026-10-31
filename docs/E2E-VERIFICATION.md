# E2E verification recipe

## TL;DR — `pnpm e2e:full` (unattended)

```bash
pnpm e2e:full      # rebuild everything → reload SW → run matrix → write /tmp/e2e-result.json
pnpm e2e:matrix    # skip the rebuild, just run the matrix against the running SW
```

`scripts/run-e2e-matrix.mjs` talks straight to the bridge's REST and MCP HTTP
endpoints on `:12306` (no external MCP client or Claude Code session needed). It probes
`chrome_runtime_info` to verify the SW is on the latest bundle, calls
`chrome_dev_reload` to flush if needed, and walks every matrix row
returning structured pass/fail per IMP.

Exit codes: `0` clean, `1` matrix/task failure, `2` SW pre-bootstrap,
`3` isolated handshake or SW reload failure, `4` fixture navigation failed.
Use `--launch-chrome` for a fresh owned Chrome/SW when bootstrap is missing;
never ask an operator to reload the daily browser.

The rest of this document describes the deeper recipe (manual rows,
chrome-devtools-mcp cross-verification, fixture-addition rules) for
cases where the standalone runner doesn't cover what you need.

## Isolated Rust-native / TypeScript-browser gate

Build the Rust binaries and retained numeric SIMD, shared and worker assets
without installed-runtime synchronization. There is no general browser
Rust/WASM policy kernel. Select Chrome for Testing explicitly:

```bash
pnpm build:wasm
pnpm build:shared
node scripts/build-browser-workers.mjs
HC_TEST_NATIVE_BIN="$PWD/target/release/humanchrome-nativehost" \
HC_CHROME_PATH="/absolute/path/to/Google Chrome for Testing" \
  node scripts/verify-rust-transition.mjs --suite browser
```

Separate native provenance for candidate-browser work is immutable revision
[`5f223ec9d3a62ce9fb42ed8bbe708c6fc7ff4473`](https://github.com/cefege/humanchrome/actions/runs/41071714692):
all four platform jobs and the Linux coordinator image passed. Its opt-in
real-PostgreSQL TLS release case passed. The corrected
`target/rust-transition/performance-native.json` validates fully read successful
response bodies and records controlled TypeScript → Rust startup, MCP-help and
REST-forwarding comparisons; it excludes Chrome, ONNX and optional SDK processes,
so it is neither a browser result nor a whole-feature-set Node-free claim.

This gate does **not** use `--build`: ordinary build scripts can synchronize into
the installed runtime. It invokes WXT's build API with a private output directory,
without package lifecycle/postbuild hooks or changes to the normal `.output/`.
It creates a private HOME, native manifest, database, registry, daemon socket and
Chrome profile, then checks the actual candidate PID. Matrix, fleet-worker and
lifecycle fixtures can select an isolated artifact with `HC_E2E_EXTENSION_DIR`.
The main WXT build aliases `humanchrome-shared` to its TypeScript source;
generated worker/recorder bundles consume the freshly built shared dist above.
The staged manifest's public key determines its allowed origin when present;
unkeyed builds use the canonical filesystem path, including macOS `/tmp` →
`/private/tmp` resolution. CDP uses an allocated port, not another browser's debugger.
Fixture calls keep the explicit navigated tab ID rather than relying on global
focus or an implicit mutation target.
On macOS these credential-free DOM fixtures use Chrome's test-only Keychain so
a private HOME cannot block cookie initialization on an interactive prompt.
This gate does not prove real-Keychain compatibility; the isolated fleet
lifecycle suite exercises encrypted cookies with the actual unlocked Keychain.

The matrix's `--with-tasks` option additionally runs local fixture task scenarios
against that same owned bridge before cleanup, including form input, clicks,
keyboard actions and a multi-step browser workflow. It requires
`--launch-chrome`; no live-network task or paid model is enabled. Reports remain
under `target/rust-transition/`. Any matrix/task failure remains nonzero; a known
baseline issue is not silently converted into a passing browser contract.

The owned candidate also runs these browser-policy contracts. They use the real
packaged extension and native bridge, not test-only policy exports:

| Row             | Surface                                         | Required observation                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Rust-6-ui`     | Popup, options, sidepanel, builder, welcome     | Each actual Vue page mounts and completes its packaged JavaScript helper calls; no synthetic kernel-readiness flag is used.                                                                                                                                                                                                                                                                                                                                              |
| `Rust-6-editor` | `#rust-6-editor`                                | In an owned foreground fixture tab, toggle the V2 editor and require an open `[data-mcp-web-editor="v2"]` shadow root with `[role="toolbar"][aria-label="Web Editor Toolbar"]` and `.we-prop-panel`; select `#rust-editor-target`, commit `0.42` through `input[aria-label="Opacity value"]`, and require its inline `style.opacity === "0.42"`. Record `browser-rust-6-editor.png` plus its bytes/SHA-256 in the matrix JSON, then toggle off and remove the owned tab. |
| `IMP-0200`      | Sidepanel                                       | A real native project/session is persisted through REST, loaded by the actual UI and opened; only the private fixture records are removed.                                                                                                                                                                                                                                                                                                                               |
| `Rust-7a`       | Owned fixture tabs                              | Separate clients, cross-client mutation rejection, usable aliases, deterministic pacing and release without closing the tab. Alias refresh uses `refresh:true`; URL calls retain their existing tool-owned targeting exception.                                                                                                                                                                                                                                          |
| `Rust-7b`       | `#rust-recorder-workflow`                       | First recorded interaction, initialized restrictive-CSP frame, exact generated-target comparison with the frozen original executable, persisted-target comparison and actual replayed counter change.                                                                                                                                                                                                                                                                    |
| `Rust-7c`       | `#rust-recorder-workflow` and builder           | Variable branch, two retry attempts, cycle rejection, deterministic pause/resume/cancel, event ordering and actual V2 file import with coordinate/ID root choice and visible warnings.                                                                                                                                                                                                                                                                                   |
| `Rust-7d`       | `rust-semantic-policy.html`                     | Genuine tokenizer/model loading and ONNX inference, HNSW indexing/ranking, finite scores, matching snippets and a persistable corpus. No replacement vectors or model are injected.                                                                                                                                                                                                                                                                                      |
| `Rust-6`        | Service-worker stop/start, not extension reload | Native HTTP stays available; the first workflow read sent during activation completes after crash recovery, ownership/aliases restore, pacing resets, workflow events/`nextSeq` survive, and HNSW results match after the offscreen document is explicitly closed and recreated. Cold reset before model readiness must reopen a zero-document/zero-tab index with `search:[]`. Missing prerequisites fail rather than becoming passing partial coverage.                |

Owned Option A evidence includes keyed `browser-hc-rt-hziSan.json` and keyless
`browser-hc-rt-vxH0UF.json`, each with its `.tasks.json` sidecar under
`target/rust-transition/`. Each passed 35/35 matrix rows and 17/17 task scenarios.
All five actual Vue realms mounted; the V2 editor committed opacity `0.42` and
recorded its screenshot. Queue fairness, tab closure, six frozen recorder
targets, actual recorded-flow replay, workflow lifecycle, genuine ONNX/HNSW,
persisted-query reopen, service-worker/native-channel replacement and cold
vector reset passed. This is an isolated Chrome-for-Testing result, not proof
of a production installation. Native artifact installation and deployment are
separate gates.

The workflow activation fix is verified by `browser-hc-rt-GoFeWg.json` and its
`.tasks.json` sidecar: Chrome for Testing `156.0.8078.80`, 35/35 matrix rows and
17/17 task scenarios. Four actual worker activations completed the immediately
submitted workflow read, without retrying it or waiting for a startup sleep.
This run explicitly used `HC_E2E_HEADLESS=1` for a real Chrome compositor
independent of the daily-driver desktop. The runner otherwise remains headed by
default; both modes keep the same native bridge, extension, trusted input and
assertions. Owned launches disable renderer background throttling/occlusion,
and editor clicks include the pointer move used by production trusted clicks.

Performance references are observational, not acceptance gates or speed claims:
`performance-extension-startup.json` records three same-backend source/current
startup samples; `performance-browser.json` records the exact-output recorder
regression; and `performance-workflow-vector.json` records actual-Chrome
workflow/vector parity alongside the remaining CPU regressions. Browser
functional acceptance remains the matrix/task evidence above.

Recorder setup sends a JSON `number[]` through Chrome's argument boundary.
Same-origin isolated extension worlds may privately reuse a compiled module from
an ancestor when `srcdoc` CSP blocks compilation; the page receives neither the
module nor a message bridge, and its CSP is not changed. Recorder DOM extraction
keeps the original eight-strategy producer configuration while sharing Rust
candidate policy with the modern locator configuration.

The production connection policy permits the dynamic-port bridge at
`http://127.0.0.1:*` and the observed Hugging Face data redirect at
`https://us.aws.cdn.hf.co`, in addition to its previous allowed origins. These
two changes were explicitly approved; they do not relax script policy, page CSP,
Chrome permissions or native server checks.

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
3. The checked-in project MCP configuration targets the private OVH fleet.
   The isolated matrix runner talks to its own temporary bridge directly and
   does not use that configuration. Manual cross-verification needs MCP entries
   for the specific verification bridge and `chrome-devtools`; do not send
   fixture calls to another worker unintentionally.
4. Network access for the late-image case (the fixture hits
   `httpbin.org/delay/2`). If running offline, skip the
   `kind:load_state` section.

## Unattended service-worker restart protocol (no human in the loop)

The owned candidate already starts from its freshly packaged extension and isolated
native bridge. For the persistence/restart gate, terminate **only** its extension
service worker through the owned browser's DevTools target, then issue the next
bridge operation so Chrome starts a new worker. Explicitly close the offscreen
document before termination; the next semantic request must reopen the persisted
HNSW corpus.

Do **not** call `chrome.runtime.reload()` or reload/update the extension for this
gate. Chrome clears `chrome.storage.session` on a full extension reload/update,
erasing the ownership state under test. A separate minimal `chrome.runtime.reload()`
probe kept HTTP available but did not observe a new worker; it is not a passing
result and is not a substitute for this required service-worker stop/start
contract.

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
  The runner holds a shared dialog CDP session and backgrounds the fixture
  before committing; it also requires `document.visibilityState === 'hidden'`
  afterward. This catches dropped keyboard events without stealing window focus.
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

### Native-MCP — request versus notification

The runner navigates to the existing fixture through a real MCP `tools/call`,
then sends a `tools/call` notification containing a different navigation URL.
The notification must acknowledge with HTTP 202 without changing the live tab.
A subsequent browser JavaScript call observes the actual location.

Run an uninstalled native candidate without synchronizing production artifacts:

```bash
HC_TEST_NATIVE_BIN="$PWD/target/release/humanchrome-nativehost" \
  node scripts/run-e2e-matrix.mjs --launch-chrome --only Native-MCP
```

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
