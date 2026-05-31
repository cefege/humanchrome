# Bug-008 Chromium upstream repro packet

Standalone reproduction kit for the CDP `Input.dispatchKeyEvent` keydown-delivery divergence between Chrome for Testing 145 and stable Chrome 145.

## The claim

When CDP sends this sequence to a focused `<input>` element:

```text
Input.dispatchKeyEvent { type: "keyDown",  key: "a", code: "KeyA", windowsVirtualKeyCode: 65, unmodifiedText: "a" }
Input.insertText       { text: "a" }
Input.dispatchKeyEvent { type: "keyUp",    key: "a", code: "KeyA", windowsVirtualKeyCode: 65 }
```

- **Chrome for Testing 145** — fires `keydown` + `beforeinput` + `input` + `keyup` DOM events. Text inserts. (Expected behavior.)
- **Stable Chrome 145** — fires `beforeinput` + `input` DOM events ONLY. **No `keydown`, no `keyup`** ever reaches `window`, `document`, or the input element (verified at capture phase, all three scopes). Text inserts via the IME pipeline that `Input.insertText` rides.

Same CDP version. Same major Chrome version. Same bundle. Same fixture HTML. Opposite outcomes for the synthetic `keydown` DOM event.

This is the underlying cause of [`humanchrome` Bug-008](https://github.com/cefege/humanchrome/blob/main/discussion/humanchrome-bugs/008-ember-typeahead-lookup-not-firing.md) — humanchrome's typing primitive can't drive any page that gates UI state on `keydown` (LinkedIn Open to Work's Ember typeahead, for example) when running in a normal user-profile Chrome.

## Why it matters upstream

CDP is the protocol Puppeteer, Playwright, Selenium-CDP, and every Chrome-driving automation framework speak. A divergence between CFT and stable Chrome on a foundational input primitive breaks the "test-with-CFT, run-against-real-Chrome" promise the CDP/CFT story is built on. It's plausibly a regression introduced by a Chromium IME-composition change that landed only in stable (or got patched out of CFT but not stable, or vice versa).

## Files in this folder

| File | Purpose |
|---|---|
| `README.md` | This document |
| `fixture.html` | Standalone HTML page with `<input>` + capture-phase event recorder |
| `repro.mjs` | Node script that connects to a running Chrome over the DevTools Protocol HTTP endpoint, drives the failing CDP sequence, and reports what fired |
| `expected-cft-145.txt` | Verbatim output captured from CFT 145.0.7778.167 — the "expected" baseline |
| `observed-stable-145.txt` | Verbatim output captured from the daily-driver Chrome 145.0.7778.157 — the "regression" reading |

## How to repro

### 0. Prerequisites

```bash
node --version   # >= 20 (uses native fetch + ESM)
```

You need two Chrome installs:
- Chrome for Testing — `npx @puppeteer/browsers install chrome@stable` or use Puppeteer's bundled CFT.
- Stable Chrome — your daily browser.

### 1. Start each Chrome with `--remote-debugging-port`

```bash
# Stable Chrome
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-stable-repro

# Chrome for Testing (separate port, separate profile)
"$(npx @puppeteer/browsers --version > /dev/null; node -e 'console.log(require.resolve("@puppeteer/browsers"))' | xargs dirname)/.../Google Chrome for Testing" \
  --remote-debugging-port=9223 \
  --user-data-dir=/tmp/chrome-cft-repro
```

In each Chrome instance, open `file://<absolute path>/fixture.html`. Leave the tab open and focused.

### 2. Drive the CDP sequence

```bash
# Against stable
node repro.mjs --port 9222 > observed-stable.txt

# Against CFT
node repro.mjs --port 9223 > observed-cft.txt
```

### 3. Diff

```bash
diff observed-stable.txt observed-cft.txt
```

Expected diff: stable observes 0 keydown events, CFT observes 1. Text inserts in both.

## What the fixture proves

The fixture is the smallest possible repro:

```html
<input id="q" autofocus />
<script>
  window.__events = [];
  const i = document.getElementById('q');
  for (const t of ['keydown', 'keyup', 'keypress', 'input', 'beforeinput']) {
    // Capture phase + window/document/element so a stopImmediatePropagation
    // elsewhere can't hide the event from us.
    window.addEventListener(t, (e) => window.__events.push({ scope: 'window', type: t, isTrusted: e.isTrusted, key: e.key }), true);
    document.addEventListener(t, (e) => window.__events.push({ scope: 'document', type: t, isTrusted: e.isTrusted, key: e.key }), true);
    i.addEventListener(t, (e) => window.__events.push({ scope: 'input', type: t, isTrusted: e.isTrusted, key: e.key }), true);
  }
</script>
```

No frameworks. No third-party JS. No Service Worker. No CSP. The fixture exists in isolation. The divergence is therefore not attributable to a page-side handler, an extension, or any DOM-level interception — it's CDP behavior all the way down.

## What we ruled out

- **Page-side `stopImmediatePropagation`** — listeners are at capture phase on `window`, the topmost target. Nothing fires before them.
- **Extension interception** — the fixture is loaded in a profile with no extensions (`--user-data-dir=/tmp/...-repro`).
- **CSP** — `file://` URLs have no CSP.
- **Different Chrome version** — checked via `chrome://version`. Both report 145.0.7778.x.
- **Different CDP version** — CDP `Browser.getVersion` returns the same protocol version on both.
- **An extension-side bug in our test harness** — the original humanchrome test fired the CDP sequence via `chrome.debugger.sendCommand` from a MV3 extension, but this repro drives CDP directly over the HTTP target endpoint, bypassing every extension code path.

## Filing the upstream bug

When the time comes, [crbug.com](https://crbug.com/new) bug report should include:
1. This README (or a link to it once the repo is public).
2. `fixture.html` and `repro.mjs` attached or pasted in full.
3. `observed-stable-145.txt` and `expected-cft-145.txt` as evidence.
4. The exact Chrome version strings from `chrome://version` for both browsers (so a Chromium triager can map back to the commit range).

Component suggestion: `Platform>DevTools>Console` or `Internals>Input`. Title suggestion: "CDP `Input.dispatchKeyEvent` keyDown DOM event suppressed in stable Chrome 145 when followed by `Input.insertText` — works in CFT 145".

## What this packet is NOT

- It is not a fix. The fix lives in Chromium; humanchrome can't route around it short of swapping the entire keystroke pipeline (PR #313 attempted this with `type:"char"` and was reverted because daily Chrome silently dropped text insertion for that too).
- It is not a complete history of the investigation — see `discussion/humanchrome-bugs/008-*.md` in this repo for the multi-PR trail.
- It is not a workaround. The current humanchrome typing path (IMP-0176, `keyDown` + `insertText` + `keyUp`) inserts text reliably on both environments but loses `keydown`. Callers that need `keydown` (Ember typeaheads, some custom autocomplete widgets) cannot be driven from a stable-Chrome humanchrome session today.
