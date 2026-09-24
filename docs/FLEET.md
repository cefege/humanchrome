# Chrome fleet operations

## Mac setup

1. Use a dedicated macOS user with auto-login.
2. Prevent sleep and disk sleep:

   ```bash
   sudo pmset -a sleep 0 disksleep 0
   sudo pmset -a disablesleep 1
   defaults write NSGlobalDomain NSAppSleepDisabled -bool YES
   ```

3. Enable **System Settings → General → Sharing → Screen Sharing**.
4. Install Google Chrome, run `pnpm build`, and run `humanchrome-bridge register`.
5. Set `HC_FLEET_ROOT` only when the fleet must live outside the default `~/Library/Application Support/humanchrome-fleet` directory.

## Provisioning

Phase 0 result on this Mac: CDP `Extensions.loadUnpacked` installed the active keyless extension (`dekkpcefpenbgcegejbolgkhkkcidaoj`) but the extension did not reconnect after a normal restart. The fleet therefore uses the **template** path.

Create the template once:

```bash
humanchrome-bridge fleet init
humanchrome-bridge fleet template init
```

In the visible template Chrome window: enable Developer mode → Load unpacked → `Cmd+Shift+G` → paste the configured `extensionDir` → Select → quit Chrome. The template is stored at `~/Library/Application Support/humanchrome-fleet/profiles/_template`; profiles clone it without singleton locks and caches.

The production extension build must contain a manifest `key`; otherwise provisioning stops with an explicit rebuild error. The bridge native-host manifest must already be registered.

Create profiles:

```bash
humanchrome-bridge fleet profile add p01 --labels google
humanchrome-bridge fleet profile add p02 --labels google
humanchrome-bridge fleet install-agent
```

`fleet serve` keeps the gateway and supervisor in the foreground. The launchd agent uses `KeepAlive` and leaves Chrome processes running when the supervisor itself stops, allowing the next start to adopt them.

## Google sign-in

Connect with Screen Sharing. Open each profile window, navigate to the required Google service, and sign in once per profile. Cookies and profile state persist in `profiles/<name>`. Do not automate phone verification or account creation.

## Agent config

```json
{
  "mcpServers": {
    "humanchrome": {
      "type": "http",
      "url": "http://<mac-host>:12300/v1/pool/any/mcp",
      "headers": {
        "Authorization": "Bearer <token>",
        "X-Humanchrome-Agent": "<unique-agent-name>"
      }
    }
  }
}
```

The gateway binds to `0.0.0.0:12300` by default. Keep the bearer token private. For an untrusted network, put the gateway behind Tailscale or another private overlay and set `gateway.host` to its interface address.

## Troubleshooting

- `pinned port busy`: another process owns the profile port. Stop that process or change the profile port in `fleet.json`, then `humanchrome-bridge fleet restart <name>`.
- `extension did not connect`: verify `humanchrome-bridge register`, confirm `extensionDir/manifest.json` has a key, inspect `~/Library/Application Support/humanchrome-fleet/logs/serve.log`, and rerun `fleet status`.
- `fleet serve` is not running: `humanchrome-bridge fleet status`; restart with `humanchrome-bridge fleet serve` or reinstall the launchd agent.
- Daily Chrome remains on port `12306`; fleet profiles use ports from `basePort` and isolated daemon sockets.
- Never expose the gateway without bearer authentication. Browser `Origin` headers are rejected by design.
