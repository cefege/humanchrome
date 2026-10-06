# Chrome fleet operations

A fleet is a set of real, logged-in Chrome profiles on one or more macOS
machines, supervised by `fleet serve` and fronted by an HTTP gateway that
speaks MCP. Agents reach browsers through the gateway; operators reach the fleet
through the CLI.

- [Mac setup](#mac-setup)
- [Provisioning](#provisioning)
- [Commands](#commands)
- [Gateway](#gateway)
- [Fleet MCP tools](#fleet-mcp-tools)
- [fleet.json](#fleetjson)
- [States](#states)
- [Leases](#leases)
- [Multiple machines](#multiple-machines)
- [Purposes](#purposes)
- [Agent config](#agent-config)
- [Orphans and duplicate browsers](#orphans-and-duplicate-browsers)
- [Troubleshooting](#troubleshooting)

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
5. Set `HC_FLEET_ROOT` only when the fleet must live outside the default
   `~/Library/Application Support/humanchrome-fleet` directory.

## Provisioning

Provisioning is fully automated — no Developer-mode click-through, no visible
template window. Each launch spawns Chrome with `--remote-debugging-pipe` and
then calls CDP `Extensions.loadUnpacked` against the configured `extensionDir`
over stdio, so no debugging port is ever bound and nothing on the LAN can drive
a profile. The load is re-applied on **every** launch: Chrome >= 137 ignores
`--load-extension`, and a profile that relies on a persisted copy silently loses
the extension the moment the build directory moves.

The extension ID is the hardcoded `EXTENSION_ID` in
`app/native-server/src/scripts/constant.ts`. The build must contain a manifest
`key`; without it provisioning stops with an explicit rebuild error. The native
host manifest is written per profile and refuses to point at a host script that
does not exist — Chrome accepts such a manifest and then fails every
`connectNative()` with "Native host has exited.", which looks like a dead
extension rather than a bad path.

Create the template once (it seeds cookies/bookmarks for new profiles):

```bash
humanchrome-bridge fleet init
humanchrome-bridge fleet template init
```

`fleet template init` launches the template profile, loads the extension over
CDP, waits for the bridge to answer on `basePort - 1`, and shuts the browser
down again. The template lives at
`~/Library/Application Support/humanchrome-fleet/profiles/_template`; profiles
clone it without singleton locks and caches. It is optional — a profile created
without one starts with an empty Chrome profile and still gets the extension.

Ports are handed out from `basePort`: the template takes `basePort - 1` and the
first profile added takes `basePort`, each subsequent profile one above the
highest already in use.

Create profiles:

```bash
humanchrome-bridge fleet profile add p01 --labels google
humanchrome-bridge fleet profile add p02 --labels google
humanchrome-bridge fleet install-agent
```

`fleet serve` keeps the gateway and supervisor in the foreground. The launchd
agent uses `KeepAlive` and leaves Chrome processes running when the supervisor
itself stops, allowing the next start to adopt them.

To clone an existing login instead of the template, seed a profile:

```bash
humanchrome-bridge fleet profile add p03 --seed daily              # this Mac's main Chrome
humanchrome-bridge fleet profile add p04 --seed /path/to/user-data-dir
```

`fleet status` reports `seededFrom` on such profiles, and the bridge refuses an
unscoped `chrome_clear_browsing_data` on them (see
[Purposes](#purposes)).

### Where a profile is launched, and the cookie gate

Chrome on macOS encrypts every cookie with the `Chrome Safe Storage` key in the
login Keychain. An SSH login is its own security session, and in it the login
Keychain is locked: a Chrome started there cannot decrypt the cookies it finds
on disk and **deletes them** on first load. A copy of the daily profile's 420
cookies came up with 0 that way, while the same copy launched from the GUI
session kept all 420.

So the fleet launches Chrome only where the Keychain is readable:

- `profile add` is handed to the running `serve` (`provisioning through serve
(pid N)`), whose launchd agent lives in the Mac's GUI session. That is what
  makes `profile add` over SSH safe.
- Every launch, by `serve` or by the CLI, first checks `security
show-keychain-info`. Where it fails, the launch is refused with `this session
cannot read the login Keychain (…)` instead of starting a browser that wipes
  its own logins. Without a running `serve`, run `profile add` from the Mac's
  GUI session (Terminal, or over Screen Sharing).

After the first launch, `profile add` compares the copy against what the
browser kept: persistent, unexpired, unpartitioned cookies read from the copied
cookie store before launch, against `Storage.getCookies` once the extension
answers. The add fails, the browser is killed, the directory is deleted and
nothing is registered when the browser kept **fewer than 90%** of them, or
**none of its google.com cookies** while the copy had some. Decryption loss is
all-or-nothing, while the churn between copy and check (a cookie expiring in
that minute) is a handful; google.com is checked on its own so a ratio cannot
hide losing the session seeding exists for.

### The Google session gate

Cookies on disk cannot say whether Google still accepts them. A copy of a daily
Chrome that Google had already signed out carries every google.com cookie and
lands on "Verify it's you" (`accounts.google.com/v3/signin/confirmidentifier`).
So once the cookie gate passes, `profile add` asks Google: it opens a background
tab on `accounts.google.com`, runs `ListAccounts` there (the call Chrome's own
account reconcilor makes) through the new profile's bridge, and closes the tab.
The answer is one of:

| State        | Meaning                                                             |
| ------------ | ------------------------------------------------------------------- |
| `session`    | At least one account has a live session.                            |
| `remembered` | Google lists the account(s) but none has a session: sign-in needed. |
| `none`       | No account at all.                                                  |

When the copy carried a Google login (an unexpired `SID` or `__Secure-1PSID` on
`.google.com`), anything but `session` fails the add and discards the profile,
as does an answer that cannot be read. When the seed Chrome is itself in Google
"sign-in pending" (`signin.signin_pending_start_time` in its `Preferences`), the
error says so: a copy cannot carry a session its source no longer has, and the
fix is to sign in to Google in the source first. A profile given no Google login
is reported, not gated. A successful add prints all three:

```text
added {"name":"p03","port":12509,"copied":{"persistent":254,"google":53},"kept":{"persistent":254,"google":53},"google":{"state":"session","accounts":1,"signedIn":1}}
```

`profile verify <name>` asks the same question of a running profile at any
time. It talks to the profile's bridge on loopback, so it works over SSH and on
a browser `serve` adopted, prints `{"name":…,"google":{…}}` and exits 1 unless
the state is `session`.

## Commands

All commands live under `humanchrome-bridge fleet …`.

| Command                                                   | What it does                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init [--gateway-port N] [--base-port N]`                 | Create `fleet.json` and its directories. Client auth starts **off**; the loopback bridge credential is always minted.                                                                                                                                                                                                                                         |
| `init --token <hex>`                                      | Require that bearer token from LAN clients. `--token none` leaves the fleet open.                                                                                                                                                                                                                                                                             |
| `init --print-token`                                      | Echo the token already in `fleet.json` (the only way to read it back).                                                                                                                                                                                                                                                                                        |
| `init --force-new-token`                                  | Rotate both tokens and turn client auth on, preserving profiles.                                                                                                                                                                                                                                                                                              |
| `template init`                                           | Create the one-time `_template` profile on `basePort - 1`.                                                                                                                                                                                                                                                                                                    |
| `serve`                                                   | Run the supervisor, the gateway and the MCP endpoint.                                                                                                                                                                                                                                                                                                         |
| `profile add <name> [--labels a,b] [--seed daily\|<dir>]` | Provision a profile, cloning the template or a seed directory. Runs inside a live `serve`; registers the profile only if its browser kept the cookies it was given ([cookie gate](#where-a-profile-is-launched-and-the-cookie-gate)) and, when it was given a Google login, Google confirms a live session ([Google session gate](#the-google-session-gate)). |
| `profile verify <name>`                                   | Ask Google whether a running profile is signed in; prints `session`, `remembered` or `none` and exits 1 unless `session`.                                                                                                                                                                                                                                     |
| `profile rm <name> [--delete-data]`                       | Remove the profile from the fleet. Data is kept unless `--delete-data`; either way the browser is terminated first.                                                                                                                                                                                                                                           |
| `profile ls`                                              | Print every profile in `fleet.json` as JSON.                                                                                                                                                                                                                                                                                                                  |
| `profile enable <name>` / `profile disable <name>`        | Let the supervisor run a profile again, or stop it and keep it stopped. Data is untouched.                                                                                                                                                                                                                                                                    |
| `start <name>` / `stop <name>` / `restart <name>`         | One browser. Routed through the running `serve` when there is one, applied locally otherwise.                                                                                                                                                                                                                                                                 |
| `down` / `up`                                             | Park (stop everything and keep it stopped) / unpark the fleet.                                                                                                                                                                                                                                                                                                |
| `status`                                                  | Profiles, states and leases. Says `serve: up` or `serve: down`.                                                                                                                                                                                                                                                                                               |
| `node add <id> <host> [--port N] [--token <hex>]`         | Register a peer gateway. `--token` may be omitted on a trusted LAN.                                                                                                                                                                                                                                                                                           |
| `node ls` / `node rm <id>`                                | List or remove peers.                                                                                                                                                                                                                                                                                                                                         |
| `purpose add <tag> <profile>`                             | Bind a purpose tag to exactly one browser, fleet-wide.                                                                                                                                                                                                                                                                                                        |
| `purpose rm <tag>`                                        | Release a tag. The browser and its logins are untouched.                                                                                                                                                                                                                                                                                                      |
| `purpose ls [--json]`                                     | Every purpose tag, the browser serving it, and its live state.                                                                                                                                                                                                                                                                                                |
| `install-agent` / `uninstall-agent`                       | Install or remove the launchd supervisor (`com.humanchrome.fleet`).                                                                                                                                                                                                                                                                                           |

Every fleet diagnostic is written to `serve.log` and starts with `fleet: `.
Component lines add their component: `fleet: gateway: node worker did not
answer: …`, `fleet: session restore skipped for p01 (setCookies): …`.

## Gateway

`fleet serve` listens on `gateway.host:gateway.port` (`0.0.0.0:12300` by
default). Every request carrying an `Origin` header is refused with
`403 origin_not_allowed` — a browser must never be able to drive the fleet.

| Route                             | Behaviour                                                                                                                                                                               |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/profiles`                | Local snapshots plus one row per peer profile, keyed `nodeId:profile`.                                                                                                                  |
| `POST /v1/profiles`               | Body `{name, labels, seed}` (`seed`: absolute user-data-dir or `null`). Runs `profile add` inside `serve`, one at a time; 201 with the cookie counts, 422 `add_failed` with the reason. |
| `POST /v1/profiles/:name/start`   | 202 `{starting: name}`; 404 `unknown_profile`; 409 `profile_busy` when another agent holds it.                                                                                          |
| `POST /v1/profiles/:name/stop`    | 202 `{stopping: name}`; same error shape.                                                                                                                                               |
| `POST /v1/profiles/:name/restart` | 202 `{restarting: name}`; same error shape.                                                                                                                                             |
| `GET /v1/leases`                  | Every live lease: agent, profile, last seen.                                                                                                                                            |
| `DELETE /v1/leases/:agent`        | Releases that agent's leases and frees its client lane inside each browser. The `x-humanchrome-agent` header must name the same agent as the path segment, else `403 agent_mismatch`.   |
| `POST\|GET\|DELETE /v1/fleet/mcp` | [Fleet MCP tools](#fleet-mcp-tools).                                                                                                                                                    |
| `ALL /v1/profiles/:name/*`        | Proxy to one browser's bridge.                                                                                                                                                          |
| `ALL /v1/pool/:label/*`           | Lease a browser matching a label (or a purpose tag) and proxy to it.                                                                                                                    |
| `ALL /v1/node/:name/*`            | Federation entry point, resolved by a peer gateway against **local** profiles only.                                                                                                     |

Proxying to a browser only reaches that browser's `/api/*`, `/mcp` and `/ping`.
Anything else — the agent chat surface, the extension's raw bridge — is `404
not_found`. The list is an allowlist: a route added to a bridge is private to
the LAN until it is added here.

Responses carry `X-Humanchrome-Profile` naming the browser that served the
request, so a client can tell which of its leases answered.

| Status | Body                                      | When                                                                                             |
| ------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `400`  | `missing_agent` / `invalid_agent`         | No usable `x-humanchrome-agent` header / unusable agent name in the path.                        |
| `401`  | `unauthorized`                            | A token is configured and the bearer does not match it (or `/v1/node/*` without a peer token).   |
| `403`  | `origin_not_allowed` / `agent_mismatch`   | Request carries an `Origin` header / lease release for an agent the caller does not claim to be. |
| `404`  | `unknown_profile` / `not_found`           | No such profile (locally or on a peer) / proxy path outside the allowlist.                       |
| `409`  | `profile_busy`                            | The browser is held by another agent, or a control verb targets one.                             |
| `503`  | `no_free_profile` / `profile_unavailable` | No healthy candidate for the label / the profile exists but is not healthy yet.                  |

### Status page

`GET /` (and `GET /ui`) serves a read-only dashboard: browsers running,
healthy / not healthy, leases held, and a per-profile table with state, pid,
port, labels, purpose, enabled, lease holder and `lastError`, refreshing every
3s. It is served by the gateway itself, so it is reachable wherever the gateway
is and needs no second process.

It is deliberately read-only. The gateway refuses any request carrying an
`Origin` header, and a browser only omits that for same-origin GETs — which a
polling page satisfies and a click-to-act button would not. Changes stay on the
CLI and the `fleet_*` MCP tools, where an operator can see what they are about
to do.

### Client auth

A freshly initialised fleet is **open**: `token` is `null` and any caller on the
network may use it. That is the default for a trusted LAN. Auth is opt-in:

```bash
humanchrome-bridge fleet init --force-new-token   # rotate both tokens, auth on
humanchrome-bridge fleet init --print-token       # read the current one back
humanchrome-bridge fleet init --token none        # go back to open
```

An existing `fleet.json` that carries a token keeps enforcing it, so upgrading
never opens a fleet that was previously closed.

The per-profile bridge credential (`bridgeToken`) is never optional: it is what
the gateway injects when it talks to a browser on loopback.

## Fleet MCP tools

`POST /v1/fleet/mcp` serves fleet control over MCP. It is a separate endpoint
from `/v1/pool/any/mcp` so an agent gets fleet control and a leased browser from
two clearly-named URLs, and every tool is `fleet_`-prefixed so a client merging
both servers cannot collide.

| Tool             | Arguments                              | What it does                                                             |
| ---------------- | -------------------------------------- | ------------------------------------------------------------------------ |
| `fleet_profiles` | —                                      | Every browser with its state, lease holder and last failure. Start here. |
| `fleet_profile`  | `action: start\|stop\|restart`, `name` | One browser. `name` may be a peer profile as `nodeId:profile`.           |
| `fleet_leases`   | `action: list\|release`, `agent`       | Who holds what; `release` also frees the browser-side client lane.       |
| `fleet_purposes` | —                                      | Each purpose tag and the browser serving it, with the live state.        |
| `fleet_park`     | `parked: boolean`                      | Stop every browser and keep them stopped, or start them all again.       |

Results are JSON text; a refused call carries `isError` and says why
(`unknown profile: nope`), rather than failing the whole MCP session.

```bash
humanchrome-bridge fleet init    # prints the mcpServers block for both endpoints
```

## fleet.json

`~/Library/Application Support/humanchrome-fleet/fleet.json`, written atomically
(temporary file + rename) at mode `0600`.

| Key                             | Meaning                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------- |
| `version`                       | Schema version; must be `1`.                                                      |
| `gateway.host` / `gateway.port` | Where the gateway listens. Default `0.0.0.0:12300`.                               |
| `token`                         | `null` (open) or the bearer LAN clients must present.                             |
| `bridgeToken`                   | Credential the gateway injects toward each profile's bridge. Always present.      |
| `chromePath`                    | Chrome binary used for spawns and for finding orphans.                            |
| `extensionDir`                  | Unpacked extension loaded over CDP on every launch.                               |
| `basePort`                      | First profile port; the template takes `basePort - 1`.                            |
| `leaseIdleTtlSec`               | Idle seconds before a lease expires. Backfilled to `900` when absent.             |
| `profiles[]`                    | `{ name, port, labels, enabled, purpose?, seededFrom?, seededAt? }`.              |
| `parked`                        | When true, nothing runs and nothing is relaunched.                                |
| `nodeId`                        | This machine in `nodeId:profile` keys. Defaults to the hostname.                  |
| `nodes[]`                       | `{ id, host, port, token }` peer gateways. `token` may be empty on a trusted LAN. |
| `dailyProfileDir`               | Default source for `--seed daily`.                                                |

Two CLI processes mutating the file at the same instant can still lose one
another's change; each individual write is atomic.

## States

| State         | Meaning                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------- |
| `stopped`     | No browser, and none will be launched while disabled or parked.                                   |
| `starting`    | A launch is in flight.                                                                            |
| `running`     | Chrome is up; the bridge has not answered `/ping` yet.                                            |
| `healthy`     | Chrome is up and its bridge answers. **Only this state is handed out.**                           |
| `backoff`     | The browser died or failed to launch; a relaunch is scheduled with exponential backoff up to 60s. |
| `unreachable` | A peer gateway did not answer. Only ever reported for peer profiles.                              |

`fleet purpose ls` reports `unknown` rather than `stopped` for a local profile
when `serve` is down: nothing is reporting, and a fabricated `stopped` reads as
a measurement.

## Leases

Leases are keyed by profile and hold an agent name, not a session. A lease is
live for `leaseIdleTtlSec` since the holder last made a request; only the
holder's own traffic refreshes it. Expired leases are swept every 30 seconds.

- A pool request (`/v1/pool/<label>/*`) leases the first free healthy candidate
  in name order, or reuses one this agent already holds.
- A named request (`/v1/profiles/<name>/*`) leases exactly that browser and
  answers `409 profile_busy` when someone else holds it.
- Taking over an expired lease releases the evicted agent's client lane inside
  the browser, so a stale agent never keeps driving a page.

## Multiple machines

Every machine runs its own `fleet serve`. A central machine registers its peers
and dispatches work to them; clients keep talking to a single gateway.

```bash
# on the worker machine
humanchrome-bridge fleet serve

# on the central machine
humanchrome-bridge fleet node add workstation 100.x.y.z --port 12300 --token <worker gateway token>
humanchrome-bridge fleet node ls
humanchrome-bridge fleet node rm workstation
```

- Peer profiles appear in `fleet status` and `/v1/profiles` as `nodeId:profile`
  (for example `workstation:p01`). Local profile names cannot contain `:`, so a
  qualified name never shadows a local one.
- `/v1/pool/<label>/*` leases across local _and_ peer profiles; the request is
  forwarded to the peer's `/v1/node/<profile>/*`, which injects that machine's
  bridge credential and forwards to the browser. The hop only ever resolves
  local profiles, so a request cannot loop back out.
- `/v1/node/*` requires a bearer matching one of the configured peers' tokens.
  When no peer carries a token the fleet is trusted end to end and the route
  behaves like any other open route.
- Peer profile lists are cached per node for 5 seconds, so one dark machine does
  not expire a healthy peer's routes. A peer that does not answer is reported as
  `unreachable`, is logged once per cache window, and is never handed out.
- A node id must not equal the machine's own `nodeId` (defaults to the
  hostname); `loadConfig` rejects the collision. Ids also match the profile-name
  shape, so an id containing `:` cannot break the key scheme.

## Purposes

A purpose tag names _why_ a browser exists — an account it keeps logged into.
It is bound fleet-wide to exactly one browser, is usable anywhere a pool label
is, and never replaces a label: a purpose-bound profile stays reachable through
its labels.

```bash
humanchrome-bridge fleet purpose add linkedin p01
humanchrome-bridge fleet purpose ls --json
humanchrome-bridge fleet purpose rm linkedin
```

Binding fails closed: if a configured peer cannot be reached, the add is refused
rather than risking a duplicate binding on a machine that cannot be asked.

On a purpose-bound or seeded profile, `chrome_clear_browsing_data` without
`origins` is refused — that call clears every login in the browser. Pass
`origins` to scope it, or `confirmProfileWipe: true` to mean it.

## Google sign-in

`--remote-debugging-pipe` on its own turns on Blink's `AutomationControlled`
feature: every page sees `navigator.webdriver === true`, and Google's sign-in
refuses the browser with "Couldn't sign you in. This browser or app may not be
secure" (`/v3/signin/rejected`). Fleet browsers therefore launch with
`--disable-blink-features=AutomationControlled`, which keeps the pipe and the
extension and lets sign-in proceed to the password or passkey challenge. A
browser started before that flag existed keeps the old behaviour until it is
relaunched (`fleet restart <name>`).

Connect with Screen Sharing. Open the profile window, sign in to Google once,
then run `fleet profile verify <name>`. The session lives in the profile's own
cookie store and survives restarts. Do not automate phone verification or
account creation.

## Agent config

`humanchrome-bridge fleet init` prints the `mcpServers` block to paste into an
agent config. It contains two entries:

- `humanchrome` → `http://<mac-host>:12300/v1/pool/any/mcp` — a leased browser.
- `humanchromeFleet` → `http://<mac-host>:12300/v1/fleet/mcp` — fleet control.

Both carry `X-Humanchrome-Agent: <unique-agent-name>`. An `Authorization` header
is printed only when the fleet has a token.

Keep any token private. On an untrusted network, put the gateway behind Tailscale
or another private overlay and set `gateway.host` to its interface address.

## Orphans and duplicate browsers

Chrome is spawned as a process-group leader, so every kill path signals the
whole group. A browser that survives a kill is found again by command line
(`ps -Ao pid=,command=`, matching the configured `chromePath` and the profile's
`--user-data-dir`) rather than trusted from `run/<name>.pid` alone:

- **bridge answers `/ping`** → the browser is adopted (`fleet: adopted running
browser for <name> (pid N)`). Its tabs and session are kept; nothing is
  relaunched and the pid file is rewritten.
- **nothing answers `/ping`** → the browser is stopped and a clean one is
  launched, because a live-but-unserving browser holds the profile's
  `SingletonLock` and would fail every future launch.
- **more than one match** → the lowest pid is kept and the rest are stopped
  (`fleet: stopped duplicate browser for <name> (pid N)`).
- **a malformed pid file** → it is deleted and the profile treated as stopped,
  rather than re-read on every tick forever.

A browser that is already adopted can still stop answering: the extension's
service worker dies, or `Extensions.loadUnpacked` leaves the extension disabled
pending a reload, and Chrome itself stays up — so the monitor sees a live pid
and never revives it, while every client gets `browser_bridge_unavailable`.
The health loop is what ends that state: after six consecutive ticks (60s)
without a `/ping` it snapshots the session, stops the browser and launches a
clean one (`fleet: no bridge on port <port> for <name>; replacing the
browser`). A pid file alone is no longer enough to adopt a browser either —
that branch probes `/ping` too, exactly as the orphan scan does.

Stopping a browser never deletes cookies, logins or history: they live in the
profile directory. It is signalled with `SIGTERM` and only escalated to `SIGKILL`
after a 5s grace period, so Chrome closes its profile and flushes pending writes
first. Live cookies are snapshotted on the way out and replayed on the way in;
the snapshot is written through a temporary file and renamed, because it is the
only copy of the fleet's logins.

Adopted browsers have no DevTools pipe, so window labelling and session capture
do not run for them until their next supervised launch.

`fleet status` reports `lastError` for every profile: the last launch failure,
cleared when the profile is up again. The same message is logged once per
incident rather than once per monitor tick, and `fleet: profile <name> is up
again` marks recovery.

## Updating the extension

Every profile runs the unpacked build in `extensionDir`, and updates on the
fly: no restart, no logins touched, nothing to click.

```bash
cd app/chrome-extension && pnpm build
```

The build bakes one identity into the bundle (`__HC_BUILD_HASH__`,
`__HC_BUILT_AT__`) and writes the same one beside it as `build-info.json`; its
postbuild step copies both into `extensionDir`. Each profile's self-update
watcher compares the two every 30 seconds and calls `chrome.runtime.reload()`
when they differ, so every running browser is on the new build within about
half a minute.

To see what a profile is running, call `chrome_diagnostics` with
`{"action": "runtime_info"}`: its `builtAt` must equal the one in
`extensionDir/build-info.json`.

- A browser restart on its own does not update the extension. Chrome can start
  a stored copy of the previous service worker; the watcher compares against the
  identity baked into the code it is running, so it catches that on start.
- The build needs `CHROME_EXTENSION_KEY` (in `app/chrome-extension/.env.local`)
  or the extension id changes and the native host refuses it.
- A profile whose extension no longer answers cannot reload itself:
  `humanchrome-bridge fleet restart <profile>`.

## Troubleshooting

- `extension did not connect`: verify `humanchrome-bridge register`, confirm `extensionDir/manifest.json` has a key, inspect `~/Library/Application Support/humanchrome-fleet/logs/serve.log`, and rerun `fleet status`. A profile stuck in `backoff` in `fleet status` means the launch itself failed — the reason is logged to `serve.log`. A port collision surfaces the same way, not as a distinct "port busy" error.
- `native host script missing`: the fleet was provisioned from a source checkout. Rebuild and reinstall the bridge (`cd app/native-server && npm run build`) and re-add the profile.
- `profile failed to launch: extension build missing`: run `pnpm build:extension`, or point `extensionDir` in `fleet.json` at an existing build.
- `invalid fleet.json: <field> is missing`: a required key was trimmed out of the file. Restore it; the message names the field.
- `Specified native messaging host not found` in the browser console: the profile's `NativeMessagingHosts/com.humanchrome.nativehost.json` is gone. Re-create the profile (or restore that one file) — Chrome accepts the manifest silently and only fails at `connectNative()`.
- `fleet serve` is not running: `humanchrome-bridge fleet status`; restart with `humanchrome-bridge fleet serve` or reinstall the launchd agent. Mutating commands signal the running serve with `SIGHUP`; a serve that ignores `SIGHUP` (for example one started under `nohup`) will not pick up the change until it restarts.
- `this session cannot read the login Keychain`: the command ran over SSH (or another non-GUI session) with no `serve` to hand the launch to. Start the launchd agent (`fleet install-agent`) and retry, or run the command in the Mac's GUI session. Never work around it by launching Chrome anyway: that browser deletes every cookie in its profile.
- `<name> lost its seeded cookies: …`: the first launch did not keep the cookies it was given, so the profile was discarded and not registered. Check the Keychain line above, then re-run `profile add`.
- A `start`/`stop`/`restart` that printed `sent to serve (pid N)` was applied by the running supervisor. That is the correct path — a second supervisor in the CLI process would fight the running one over the same pid file and Chrome.
- `403 agent_mismatch` on a lease release: send `x-humanchrome-agent` naming the same agent as the path segment.
- `404 not_found` through a profile URL: the path is outside the bridge allowlist (`/api/*`, `/mcp`, `/ping`).
- Daily Chrome remains on port `12306`; fleet profiles use ports from `basePort` and isolated daemon sockets. Each profile's bridge port is pinned by `HC_BRIDGE_PORT` in that profile's Chrome environment, so profiles never collide with each other or with the daily bridge.
- Never expose the gateway to an untrusted network. Browser `Origin` headers are rejected by design, and bearer auth is off unless you turn it on.
