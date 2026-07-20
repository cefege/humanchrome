# Open Bugs

Reported by Mihai via Claude Code during real workflow runs. Each entry has reproducer + suggested fix.

---

## BUG-001 — `chrome_navigate({newTab: true})` is silently ignored when a same-host tab is already open

**Reported:** 2026-06-02 during INBOUND_SWEEP → LINKEDIN_REPLY (Phil Heath send).

**Severity:** high — blocks LinkedIn send workflows when a stale LinkedIn tab is open.

**Reproducer:**

1. Open Chrome, navigate one tab to `https://www.linkedin.com/feed/` manually.
2. From a humanchrome MCP client, call:
   ```
   chrome_navigate({newTab: true, url: "https://www.linkedin.com/messaging/thread/2-.../"})
   ```
3. Expected: a NEW tab opens at the messaging URL, leaving the feed tab alone.
4. Actual: response is `{"success": true, "message": "Activated existing tab", "tabId": <existing-feed-tab-id>, "url": "https://www.linkedin.com/feed/"}`. The flag was ignored; the feed tab was activated and presumably will navigate to the new URL on its own — but the previous CDP session bound to that tab persists.

**Knock-on bug (BUG-002):** the next `chrome_javascript` call against that same `tabId` fails with `"DevTools appears to be attached to tab N. Close the DevTools panel on that tab and retry."` even though no user-opened Chrome DevTools panel exists. The bridge's own prior CDP session is what's actually blocking the new script — but the error message frames it as a user-side problem.

**Suggested fix:**

- Honor `newTab: true` unconditionally. The host-match optimization is fine as a DEFAULT, but the explicit flag must override it.
- When the bridge re-attaches CDP to a tab it previously used, release the prior session first. The "DevTools appears to be attached" path should never fire for the bridge's own sessions.
- If a third-party CDP attach truly exists (Chrome DevTools panel, IDE debugger, another MCP client), the error message should say so explicitly — e.g., `"another CDP client is attached: <client_id or hint>"` — not the ambiguous "DevTools" framing that misleads users into thinking they did something wrong.

**Workaround in caller (already applied in `discussion/pipeline/scripts/send_linkedin.py` 2026-06-02):**
prepend `browser_close_my_tabs({})` before every `chrome_navigate` in send flows. Forces a clean slate. See `discussion/memory/op_humanchrome_gotchas.md` gotchas #14 + #15.

---

## BUG-002 — "DevTools appears to be attached" error is misleading user-facing jargon

**Reported:** 2026-06-02 (same incident as BUG-001).

**Severity:** medium — bad error UX; sends users on a wild goose chase looking for a DevTools panel they didn't open.

**Reproducer:** see BUG-001 step 2 — the second `chrome_javascript` call after the silent tab-activation produces this error.

**Suggested fix:** see BUG-001 third bullet. Differentiate between "your own stale session" vs "a true third-party attach" vs "an actual user-opened Chrome DevTools panel". Each needs distinct error text + remediation.

---

## BUG-003 — Dispatcher catalog (11 KB) is truncated by MCP clients, making most tools undiscoverable

**Reported:** 2026-06-07 during a Ghișeul.ro navigation session.

**Severity:** high — only ~14 of 98 tools are visible to the LLM; everything after `chrome_bookmark_update` (alphabetically) is unreachable without source access.

**Reproducer:**

1. Use humanchrome as an MCP server in Claude Code.
2. Inspect the `humanchrome` dispatcher tool description as the LLM sees it.
3. Observe the description ends mid-line at `chrome_bookmark_update` followed by `… [truncated]`, hiding ~84 tools including `chrome_click_element`, `chrome_javascript`, `chrome_read_page`, etc.
4. Calls like `chrome_click` / `chrome_click_element` round-trip through the `Unknown tool` error path before the LLM finds the real name — only the `didYouMean` suggester rescues nearby misses.

**Measured:** `buildDispatcherDescription()` produces 11,355 chars / 101 lines from `packages/shared/src/tool-index.ts:55`. Claude Code's tool-list renderer truncates around ~2,000 chars (≈14 catalog lines), explicitly appending `… [truncated]`.

**Why the existing 10× shrink test misses this:** `packages/shared/src/tool-index.test.ts:52` only asserts the dispatcher is 10× smaller than `JSON.stringify(TOOL_SCHEMAS)` (~150 KB). It doesn't bound the absolute byte size, so growth past common client display caps goes unnoticed.

**Suggested fix (one of):**

1. **Name-only catalog** — drop the first-sentence per tool in `buildDispatcherDescription`. ~98 names × ~22 chars ≈ 2.2 KB, fits even tight client caps. Pair with a new `chrome_help({name?})` meta-tool that returns the full first-sentence (or full description) for one or all tools on demand. Trade-off: LLM loses inline picking signal but gains full discoverability.
2. **Two-line max per entry** — keep verb-phrase but truncate to ~20 chars + ellipsis. ~98 × 45 ≈ 4.4 KB. May still exceed some clients.
3. **Category-paginated dispatcher** — first call lists categories (`Interaction`, `Network`, `Bookmarks`, …), second call lists tools in a category. Heavier UX, defeats the single-tool promise.

Recommendation: **(1)**. Add an absolute-size assertion to `tool-index.test.ts` (e.g. `expect(desc.length).toBeLessThan(4000)`) so this regresses loudly next time the catalog grows.

**Workaround until fixed:** read `packages/shared/src/tools.ts:39-150` (the `TOOL_NAMES` block) directly to discover canonical names.

**Fix landed (unverified in-the-wild — MCP client must restart to pick up the new bridge):**

- `packages/shared/src/tool-index.ts` — names-only catalog (2,685 chars, 76% smaller); new `buildToolHelp(name?)` returns `{name, summary}` for all or `{name, summary, description}` for one.
- `packages/shared/src/tools.ts` — added `TOOL_NAMES.BROWSER.HELP = 'chrome_help'` + `TOOL_SCHEMAS` entry + `TOOL_CATEGORIES['chrome_help'] = 'Diagnostics'`.
- `app/native-server/src/mcp/register-tools.ts` — intercepts `chrome_help` at the dispatcher layer in both lazy and legacy mode (no extension round-trip).
- `packages/shared/src/tool-index.test.ts` — new tests for `<3 KB` absolute size, names-only line format, `chrome_help` presence, `buildToolHelp` shapes (all / single / unknown). Regenerated `tool-index.snapshot.json` for the new byte-stable description.
- `app/chrome-extension/tests/tools/lazy-tool-registry.test.ts` — exempts `chrome_help` from "every BROWSER name must have an extension handler" since it's dispatcher-handled.

---

## chrome_fill_lwc — KNOWN REMAINING LIMITATIONS (tracked at tool-add time, 2026-06-25)

`chrome_fill_lwc` (added 2026-06-25) commits a value into a single Salesforce
LWC control via the component's own `@api value` setter + a native `change`
event — the only path proven to persist on Save for rich-text, combobox, and
plain input/textarea fields. Two field classes are explicitly OUT OF SCOPE and
still fail; do not assume the tool covers them:

1. **Multi-field LWC records (repeating "experience"-style records).** A record
   built from several child fields (e.g. an "experience" entry = title + dates +
   description) may still not persist when filled field-by-field. Root cause: the
   parent record aggregator captures child values from the natural per-field
   user-event chain (focus → input → blur → internal record-update event), not
   from a programmatic `.value` set on each child. The aggregator never sees the
   child commit, so on Save the record is empty/partial. Fix needs replaying the
   real per-field event sequence (trusted focus + keystroke + blur) so the parent
   record binds each child the way it does for a human.

2. **SLDS lookup / typeahead fields (record-backed pickers, e.g. "Language" or
   "Skill").** Cannot be filled this way. Root cause is twofold: (a) a coordinate
   click does not focus the inner input — `document.activeElement` stays `body`,
   so keystrokes go nowhere; and (b) setting `.value` directly stores an invalid
   placeholder record id (the picker expects a real record reference resolved from
   the async results list, not a raw string). Fix needs deep-shadow focus of the
   inner input, then driving the typeahead and selecting an option against the
   async results — i.e. the `chrome_combobox_select` / `chrome_typeahead_probe`
   shape adapted to SLDS lookups, not a `.value` write.

---
