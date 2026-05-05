# HumanChrome — Privacy Policy

_Last updated: 2026-05-03_

HumanChrome is a Chrome extension that lets an AI client you control drive the browser you already use. Privacy is a first-class concern, because the extension necessarily has access to whatever pages you have open. This document describes what the extension reads, what leaves your machine, and what does not.

If you find anything in this document that does not match the code, please open an issue at <https://github.com/cefege/humanchrome/issues> — the source is the source of truth and we will fix the documentation.

## Who runs HumanChrome

HumanChrome is open source software (MIT). It runs entirely on your computer. There is no HumanChrome backend, no HumanChrome account, and no HumanChrome server that receives your data. The "we" in this document refers to the maintainers of the open source project, who do not see your traffic.

## What the extension reads

To do its job — letting an AI agent click, fill, screenshot, and read pages on your behalf — the extension can read:

- **Active page DOM and content.** When you (or your AI client through you) invoke a tool, the extension injects helper scripts into the active tab to read the DOM, the visible text, the interactive elements, screenshots, and other page state. This is the same data the page would expose to any other extension you give "read and change all your data on the websites you visit" permission to.
- **Tab metadata.** Tab id, URL, and title for the active tab and any tab the AI is asked to operate on. This is required for tool routing.
- **Browser state you opt into per tool.** History (only when `chrome_history` is invoked), bookmarks (only when `chrome_bookmark_*` is invoked), downloads (only when `chrome_handle_download` is invoked), network requests (only when `chrome_network_capture` is recording), CDP-level state (only when the `debugger` permission is exercised by a tool that needs it).
- **User-marked elements and saved workflows.** When you use the element marker or save a workflow, the resulting selectors and steps are stored locally.

The extension does not screen-scrape pages in the background. Tools run on demand.

## What leaves your machine

Nothing about HumanChrome itself sends your data anywhere external. Specifically:

- **No telemetry.** The extension does not phone home with usage stats, error counts, performance metrics, or anything else.
- **No crash reporting.** No Sentry, Bugsnag, Crashlytics, or equivalent. Errors are logged locally only.
- **No third-party analytics.** No Google Analytics, no Mixpanel, no Amplitude, no Segment, no PostHog, no Plausible, no anything.
- **No advertising SDKs.** The extension contains no ad networks, no fingerprinting libraries, and no tracking pixels.
- **No HumanChrome cloud.** There is no HumanChrome server. We could not collect your data even if we wanted to, because there is nowhere for it to land.

The one and only network egress path triggered by HumanChrome is this:

> When you have configured an AI client (Claude Desktop, Cursor, Cherry Studio, Continue, your own script, etc.) to use HumanChrome and you ask that client to perform a browser action, the AI client sends the tool call and the tool result to its own model provider (Anthropic, OpenAI, your local model, etc.). This traffic goes from your AI client directly to that provider. It does not pass through HumanChrome servers, because there are no HumanChrome servers.

You are responsible for whatever data your chosen AI client sends. If you point Claude Desktop at HumanChrome and ask it to "summarize my LinkedIn inbox," the contents of that inbox will be sent to Anthropic by Claude Desktop, the same as if you pasted it into a Claude conversation manually. This is a property of the AI client you chose, not of HumanChrome.

The local bridge (`humanchrome-bridge`) listens only on `127.0.0.1:12306` (the loopback interface). It is not reachable from other devices on your network or from the public internet. The bridge is the IPC channel between your local AI client and the local Chrome extension; it never opens an outbound connection on its own.

## Local storage

The extension uses local browser storage for a small number of things, all of which stay on your machine:

- **`chrome.storage.local` / `chrome.storage.sync`.** Extension settings, the redaction toggle, element markers, saved workflows, and similar configuration.
- **IndexedDB.** Vector cache for the semantic tab search feature (`chrome_search_tabs_content`), saved workflows, and recorder artifacts. The vector index is built locally from the pages you ask it to index; the embeddings never leave your machine.
- **Local files in your OS profile directory.** The bridge writes logs to:
  - macOS: `~/Library/Logs/humanchrome-bridge`
  - Windows: `%LOCALAPPDATA%\humanchrome-bridge\logs`
  - Linux: `~/.local/state/humanchrome-bridge/logs`

You can clear all of this at any time by removing the extension or by clearing the relevant Chrome storage.

## Permissions

The extension requests the broad set of permissions an automation agent requires. Each permission is justified one-by-one in [`PERMISSIONS.md`](./PERMISSIONS.md). In short: every permission is exercised only when a tool that needs it is invoked.

## Children

HumanChrome is not directed at children under 13 (or under 16 in the EEA). Do not install it on a device used by a child.

## Changes

Privacy policy changes are made in this file in the public repository. The "Last updated" date at the top reflects the most recent revision.

## Contact

Privacy questions: open an issue at <https://github.com/cefege/humanchrome/issues>.
Security disclosures: <https://github.com/cefege/humanchrome/security/advisories/new> (do not file public issues).
