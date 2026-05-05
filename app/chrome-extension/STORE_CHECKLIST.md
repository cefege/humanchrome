# HumanChrome — Chrome Web Store Submission Checklist

This file tracks everything that has to be ready before pushing the first build to the Chrome Web Store. Items marked with `(code)` are produced from this repository. Items marked with `(asset)` are user-supplied creative assets that have to be made outside this repo. Items marked with `(form)` are fields filled in directly in the Chrome Web Store Developer Dashboard.

## Code-side artifacts (already in repo)

- [x] `wxt.config.ts` manifest with English `default_locale`
- [x] `_locales/en/messages.json` with `extensionName` + `extensionDescription`
- [x] `PRIVACY.md` — privacy policy (paste contents into the store form, also host as a public URL)
- [x] `PERMISSIONS.md` — per-permission justifications (paste each into the corresponding "permission justification" field in the dashboard)
- [x] MIT `LICENSE` at repo root
- [ ] Production build of the extension: `pnpm --filter humanchrome-chrome-extension build` (verify the resulting `.output/chrome-mv3/` opens via `chrome://extensions` → "Load unpacked")
- [ ] Zipped build: `pnpm --filter humanchrome-chrome-extension zip` — this is the file uploaded to the dashboard

## Listing copy (form)

- [ ] **Extension name** (max 75 chars). Suggestion: "HumanChrome — AI in your real Chrome"
- [ ] **Short description** (max 132 chars). Suggestion: pull the lede from `README.md` ("AI controls the Chrome browser you already use, with your real cookies and sessions").
- [ ] **Detailed description** (max 16,000 chars). Adapt `README.md` sections "Why this exists", "Built for the hard platforms", "Use it without MCP", "Use it with MCP", and "Tools".
- [ ] **Category.** Pick one of: Developer Tools, Productivity. (Recommended: Developer Tools.)
- [ ] **Language.** English (United States).

## Visual assets (asset)

The Chrome Web Store requires the following images. None of these can be generated from the code; the user has to design them.

- [ ] **Icon** — 128 × 128 PNG. The extension itself already ships a 128 px icon, but the store form requires a separate upload of the same file.
- [ ] **Small promo tile** — 440 × 280 PNG or JPEG. Required for store listing.
- [ ] **Marquee promo tile (optional but recommended for featuring)** — 1400 × 560 PNG or JPEG.
- [ ] **At least 1 screenshot, ideally 3-5.** 1280 × 800 or 640 × 400 PNG/JPEG.
  - Suggested screenshots:
    1. The extension popup with "Connect" button + "connected" state.
    2. A real browser session driving LinkedIn, with the AI client side-by-side.
    3. The side panel workflow editor.
    4. A `curl` against `http://127.0.0.1:12306/api/tools/chrome_screenshot` returning a result.
    5. Claude Desktop config snippet (Streamable HTTP) next to the running extension.

## Demo video (asset)

- [ ] **Demo video URL** (YouTube, public or unlisted). Strongly recommended for the listing. Suggested 60–120 second cut: install → register host → connect from Claude Desktop → run `chrome_navigate` + `chrome_click_element` on a real LinkedIn session.

## Privacy & compliance (form)

- [ ] **Privacy policy URL.** Host `PRIVACY.md` somewhere public (e.g. <https://humanchrome.dev/privacy>, GitHub Pages, or the raw GitHub URL of `PRIVACY.md`) and paste the URL into the form.
- [ ] **Single-purpose declaration.** Suggested copy: _"HumanChrome lets a user-chosen AI client control the Chrome browser they already use, by exposing a Native Messaging bridge that brokers tool calls between the AI client and the active tab."_
- [ ] **Permission justifications.** Paste each entry from `PERMISSIONS.md` into its matching field (one field per permission).
- [ ] **Host permission justification (`<all_urls>`).** Paste the `host_permissions` paragraph from `PERMISSIONS.md`.
- [ ] **Remote code disclosure.** The MV3 production CSP allows `connect-src` to `https://cdn.jsdelivr.net` and `https://huggingface.co` for the optional ONNX/JSEP wasm download used by the semantic search worker. Disclose this in the dashboard's "Are you using remote code?" section. _Action item: confirm with the maintainer whether to ship the wasm bundled instead, which would let us answer "no" on this question._
- [ ] **Data-handling declaration.** Tick:
  - "Personally identifiable information": NO (no data leaves the machine via HumanChrome itself).
  - "Authentication information": NO (the extension reads the user's existing session cookies in-page, but does not transmit them).
  - "Financial / health / location / personal communications / web history": NO (read on-device only, never transmitted).
  - "Website content": YES (the extension reads page DOM/text on tool invocation, but only sends it to the AI client the user configured — see PRIVACY.md).
  - "User activity": NO.
  - Confirm "I do not sell or transfer user data to third parties."
  - Confirm "I do not use or transfer user data for purposes unrelated to the item's single purpose."
  - Confirm "I do not use or transfer user data to determine creditworthiness or for lending purposes."

## Distribution (form)

- [ ] **Visibility.** Public (after first review) or Unlisted (recommended for the first private testing window).
- [ ] **Geographic distribution.** All regions, unless there is a reason to restrict.
- [ ] **Pricing.** Free.
- [ ] **Mature content.** No.
- [ ] **Trader status.** Pick the right answer for the publishing entity (individual / business / trader). If publishing as an individual, "Non-trader" is correct in most jurisdictions; consult local law.

## Support (form)

- [ ] **Support email.** Pick the address that should appear publicly. (Note: do NOT use the Anthropic-account email by default; use a dedicated support address.)
- [ ] **Support site URL.** Suggestion: <https://github.com/cefege/humanchrome/issues>.
- [ ] **Homepage URL.** Suggestion: <https://github.com/cefege/humanchrome>.

## Pre-submission smoke tests

- [ ] Load the production zip via "Load unpacked" in a clean Chrome profile and confirm:
  - Popup opens, shows "Connect" or connected state.
  - Side panel opens via `Ctrl/Cmd+Shift+O`.
  - `humanchrome-bridge register` succeeds.
  - `curl http://127.0.0.1:12306/ping` returns `pong`.
  - At least one tool call (e.g. `chrome_screenshot`) round-trips successfully via curl.
- [ ] Confirm no console errors at startup in a vanilla profile.
- [ ] Confirm the manifest version in the zip matches the version planned for submission.

## After submission

- [ ] Monitor the dashboard for review verdict (typical first review: 1–3 business days, sometimes longer for permissions-heavy extensions).
- [ ] Be ready to reply to reviewer questions about `<all_urls>`, `debugger`, and the remote `connect-src` entries.
- [ ] Keep a private "rollback build" of the previous accepted version on hand in case a future submission is rejected.
