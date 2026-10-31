# 🚀 Installation and Connection Issues

## Quick Diagnosis

Run the diagnostic tool to inspect the installed native manifest, executable,
permissions, and registration:

```bash
humanchrome-bridge doctor
```

To apply the supported registration repair actions:

```bash
humanchrome-bridge doctor --fix
```

## Export Report for GitHub Issues

If you need to open an issue, export a diagnostic report:

```bash
# Print Markdown report to terminal (copy/paste into GitHub Issue)
humanchrome-bridge report

# Write to a file
humanchrome-bridge report --output mcp-report.md

# Copy directly to clipboard
humanchrome-bridge report --copy
```

By default, usernames, paths, and tokens are redacted. Use `--no-redact` if you're comfortable sharing full paths.

## If Connection Fails After Clicking the Connect Button on the Extension

1. **Run the diagnostic tool first**

```bash
humanchrome-bridge doctor
```

This checks the native executable path, manifest, permissions, and registration
state. It does not require a Node runtime.

2. **Check that an installed native bundle is registered**

```bash
humanchrome-bridge --version
```

The source build in `target/release/` is an uninstalled candidate. Do not use
it to replace a daily Chrome registration until the installation cutover is
approved.

3. **Check that the manifest file is in the correct directory**

Windows path: `C:\Users\xxx\AppData\Roaming\Google\Chrome\NativeMessagingHosts`

macOS path: `/Users/xxx/Library/Application Support/Google/Chrome/NativeMessagingHosts`

The manifest is named `com.humanchrome.nativehost.json` and its `path` must name
an absolute executable `humanchrome-nativehost` path.

4. **Check logs**

- **macOS**: `~/Library/Logs/humanchrome-bridge/`
- **Windows**: `%LOCALAPPDATA%\humanchrome-bridge\logs\`
- **Linux**: `~/.local/state/humanchrome-bridge/logs/`

5. **Check executable permissions**

Open the manifest and inspect its `path`. The referenced
`humanchrome-nativehost` executable must be readable and executable by Chrome.
Run:

```bash
humanchrome-bridge fix-permissions
```

## Log Locations

Wrapper logs are now stored in user-writable locations:

- **macOS**: `~/Library/Logs/humanchrome-bridge/`
- **Windows**: `%LOCALAPPDATA%\humanchrome-bridge\logs\`
- **Linux**: `~/.local/state/humanchrome-bridge/logs/`

## Chrome fleet (`humanchrome-bridge fleet`)

The fleet keeps its own log and its own error vocabulary, documented in
[`FLEET.md`](FLEET.md).

- Supervisor diagnostics: `~/Library/Application Support/humanchrome-fleet/logs/serve.log`.
  Every line starts with `fleet: `.
- `humanchrome-bridge fleet status` — states (`stopped`/`starting`/`running`/`healthy`/`backoff`/`unreachable`),
  lease holders and `lastError`. Says `serve: up` or `serve: down`; an offline
  run reports `unknown` for purpose states rather than inventing `stopped`.
- Gateway errors: `401 unauthorized`, `403 origin_not_allowed`,
  `403 agent_mismatch`, `400 missing_agent|invalid_agent`,
  `404 unknown_profile|not_found`, `409 profile_busy`, `503 no_free_profile`,
  `503 profile_unavailable`.
