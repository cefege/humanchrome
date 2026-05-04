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

HumanChrome runs entirely on your machine. The bridge listens on `127.0.0.1:12306` only, with CORS limited to localhost origins. Tool calls are forwarded to your Chrome extension over Chrome's native messaging IPC.

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
