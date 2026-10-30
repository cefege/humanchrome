# Security Policy

## Reporting a vulnerability

If you find a security issue in HumanChrome, please do not file a public GitHub issue. Use GitHub's private security advisory form instead:

<https://github.com/cefege/humanchrome/security/advisories/new>

That form sends the report only to the project maintainer and lets us coordinate a fix and a public advisory before disclosure.

## What to include

- A description of the issue and its potential impact.
- Steps to reproduce, ideally with a minimal example.
- The bridge version (`humanchrome-bridge -V`), Chrome version, and OS.
- Any logs or stack traces.

## What you can expect

- Acknowledgement of your report within 7 days.
- A first assessment within 14 days, including whether we accept the issue, what severity we assign it, and a rough timeline for the fix.
- A 90-day disclosure window. After a fix is released and users have had a reasonable time to update, we will publish a security advisory crediting your report (unless you'd prefer to remain anonymous).
- We do not currently offer a bug bounty.

## Threat model

The local browser bridge normally listens on `127.0.0.1:12306`. Native fleet
workers may instead be controlled through an authenticated, browserless
coordinator on a private Tailscale network. Chrome profiles and cookies stay
on the Mac workers; the coordinator holds routing and lease state in PostgreSQL.
Tailnet membership is not a substitute for application bearer authentication.
Worker credentials, coordinator client tokens, and Operator OAuth credentials
are separate secrets and must not be committed to Git.

What we worry about:

- Path traversal or arbitrary-file-read in the file-handling tools.
- Native messaging host registration that could be hijacked by another application.
- Output redaction bypass (when `rawOutput` is off, sensitive shapes should not leak through).
- Server-side request forgery via tools that fetch URLs.
- Code execution in the bridge process from a malicious tool argument.

What is explicitly out of scope:

- Misuse of the tools by the user against their own browser. The whole point of the tool is that it can drive a logged-in browser; that is not a vulnerability.
- Behavior of third-party MCP clients connected to the bridge.
- Bans, account suspensions, or terms-of-service violations on websites you automate. Pace your automations responsibly; this tool does not promise undetectability.

## Dependency updates

Security version floors and vendor patches are defined once in
`pnpm-workspace.yaml`; `pnpm-lock.yaml` records the resolved graph. Prefer
patched releases in the existing supported major version. A breaking parent
upgrade must preserve the configured behavior and pass real-browser verification
when it affects the extension.

The 2026-10-29 dependency update reduced `pnpm audit` from 152 findings to one
low-severity version-based finding. No critical, high, or moderate findings
remain in that audited graph. The remaining advisory is
[GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4)
for `deepmerge@4.3.1`, which has no fixed upstream release.

`patches/deepmerge@4.3.1.patch` applies the fix submitted in
[upstream PR #274](https://github.com/TehShrike/deepmerge/pull/274)
(not merged or published upstream), including its CJS and UMD runtime bundles.
The regression contract exercises Jest's actual patched dependency with
null-prototype targets, nested null placeholders, and own `__proto__` keys.
The exploit was also reproduced against the original package and rejected by
the patched runtime. Normal nested and array merging remain covered.

The advisory is not muted: `pnpm audit` still exits nonzero because registry
advisories identify package versions, not this local patch. Remove the vendor
patch only after a fixed upstream release replaces it and the regression
contract passes. Do not obtain a clean audit by ignoring the advisory or
downgrading outside its reported range.

Run `pnpm audit`, `pnpm typecheck`, and `pnpm test` after dependency updates.
The extension additionally requires the isolated real-Chrome matrix described
in [E2E verification](docs/E2E-VERIFICATION.md).

