#!/bin/bash
set -euo pipefail
umask 077

fail() { printf 'fleet-vm-guest: %s\n' "$*" >&2; exit 1; }
json_value() { /usr/bin/plutil -extract "$2" raw -o - "$1"; }
file_digest() { local value; value=$(/usr/bin/shasum -a 256 "$1"); printf '%s' "${value%% *}"; }

# This script must never register a native host or launch Chrome on the physical Mac.
[[ "$(/usr/bin/uname -s)" == Darwin ]] || fail 'macOS guest required'
[[ "$(/usr/sbin/sysctl -n hw.model)" == VirtualMac* ]] || fail 'refusing to run outside a macOS virtual machine'
[[ "$(/usr/bin/id -un)" == admin ]] || fail 'expected the dedicated guest admin account'
: "${HC_VM_RELEASE_DIR:?unpacked native core release required}"
: "${HC_VM_EXTENSION_DIR:?unpacked keyed extension required}"
: "${HC_VM_ENGINES_DIR:?unpacked matching optional engines release required}"
: "${HC_VM_WORKER_ID:?worker identity required}"
: "${HC_VM_WORKER_HOST:?guest Tailscale IPv4 required}"

root=${HC_VM_FLEET_ROOT:-"$HOME/Library/Application Support/humanchrome-worker"}
chrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
extension="$HOME/Library/Application Support/humanchrome-extension/chrome-mv3"
manifest="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.humanchrome.nativehost.json"
agent="$HOME/Library/LaunchAgents/com.humanchrome.fleet-worker.plist"
service="gui/$(/usr/bin/id -u)/com.humanchrome.fleet-worker"

[[ "$root" == "$HOME/Library/Application Support/humanchrome-worker" ]] || fail 'unexpected worker root'
[[ ! -L "$root" && ! -L "$extension" && ! -L "$manifest" ]] || fail 'refusing symlinked deployment paths'
[[ -x "$chrome" ]] || fail 'install Google Chrome in the guest first'
[[ -x "$HC_VM_RELEASE_DIR/humanchrome-bridge" && -x "$HC_VM_RELEASE_DIR/humanchrome-nativehost" && -x "$HC_VM_RELEASE_DIR/humanchrome-stdio" ]] || fail 'incomplete native core release'
[[ -f "$HC_VM_RELEASE_DIR/mcp/stdio-config.json" ]] || fail 'missing native stdio contract'
[[ -f "$HC_VM_EXTENSION_DIR/manifest.json" ]] || fail 'missing extension manifest'
[[ -x "$HC_VM_ENGINES_DIR/adapters/runtime/bin/node" && -x "$HC_VM_ENGINES_DIR/adapters/runtime/bin/codex" ]] || fail 'incomplete packaged engine runtimes'
[[ -f "$HC_VM_ENGINES_DIR/adapters/third-party.mjs" && -f "$HC_VM_ENGINES_DIR/adapters/devtools-engine.mjs" ]] || fail 'incomplete optional engines'
[[ "$(json_value "$HC_VM_ENGINES_DIR/adapters/optional-engines.json" target)" == aarch64-apple-darwin ]] || fail 'unexpected optional engine target'
json_value "$HC_VM_EXTENSION_DIR/manifest.json" key >/dev/null || fail 'extension requires its stable public manifest key'
[[ ${#HC_VM_WORKER_ID} -le 32 && "$HC_VM_WORKER_ID" =~ ^[a-z0-9][a-z0-9-]*$ ]] || fail 'invalid worker identity'
[[ "$HC_VM_WORKER_HOST" =~ ^100\.([6-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]+\.[0-9]+$ ]] || fail 'worker listener must use its Tailscale IPv4'

# SSH has a different macOS security session. Initialize Chrome in the guest's
# already logged-in GUI session so its login Keychain is actually available.
if [[ ! -f "$root/worker.json" && "${HC_VM_GUI_BOOTSTRAP:-}" != 1 ]]; then
  exec /usr/bin/sudo -n /bin/launchctl asuser "$(/usr/bin/id -u)" \
    /usr/bin/sudo -n -H -u admin /usr/bin/env \
    HC_VM_GUI_BOOTSTRAP=1 HC_VM_RELEASE_DIR="$HC_VM_RELEASE_DIR" \
    HC_VM_EXTENSION_DIR="$HC_VM_EXTENSION_DIR" HC_VM_WORKER_ID="$HC_VM_WORKER_ID" \
    HC_VM_ENGINES_DIR="$HC_VM_ENGINES_DIR" \
    HC_VM_WORKER_HOST="$HC_VM_WORKER_HOST" HC_VM_FLEET_ROOT="$root" \
    /bin/bash "$0"
fi

if [[ -f "$manifest" ]]; then
  native_host=$(json_value "$manifest" path)
  [[ "$native_host" == "$HOME/Library/Application Support/humanchrome-bridge/releases/"*/humanchrome-nativehost ]] || fail 'foreign native host registration'
  installed_release=${native_host%/*}
  for binary in humanchrome-bridge humanchrome-nativehost humanchrome-stdio; do
    [[ -x "$installed_release/$binary" ]] || fail 'installed release is incomplete'
    [[ "$(file_digest "$installed_release/$binary")" == "$(file_digest "$HC_VM_RELEASE_DIR/$binary")" ]] || fail 'native upgrade requires a separate stopped maintenance operation'
  done
else
  "$HC_VM_RELEASE_DIR/humanchrome-bridge" register --browser chrome
  native_host=$(json_value "$manifest" path)
  installed_release=${native_host%/*}
fi
bridge="$installed_release/humanchrome-bridge"

if [[ -d "$installed_release/adapters" ]]; then
  /usr/bin/diff -qr "$HC_VM_ENGINES_DIR/adapters" "$installed_release/adapters" >/dev/null || fail 'engine upgrade requires a separate stopped maintenance operation'
else
  /usr/bin/ditto "$HC_VM_ENGINES_DIR/adapters" "$installed_release/adapters"
fi

if [[ -d "$extension" ]]; then
  /usr/bin/diff -qr "$HC_VM_EXTENSION_DIR" "$extension" >/dev/null || fail 'extension upgrade requires a separate stopped maintenance operation'
else
  /bin/mkdir -p "${extension%/*}"
  /usr/bin/ditto "$HC_VM_EXTENSION_DIR" "$extension"
fi

/bin/mkdir -p "$root"
/bin/chmod 700 "$root"
if [[ -f "$root/worker.json" ]]; then
  [[ -f "$root/fleet.json" ]] || fail 'partial worker initialization: fleet.json missing'
  [[ "$(json_value "$root/worker.json" id)" == "$HC_VM_WORKER_ID" ]] || fail 'worker identity mismatch'
  [[ "$(json_value "$root/worker.json" host)" == "$HC_VM_WORKER_HOST" ]] || fail 'worker address changed; explicit configuration maintenance required'
  [[ "$(json_value "$root/worker.json" port)" == 12310 ]] || fail 'unexpected worker port'
  allowed=$(/usr/bin/plutil -extract profiles json -o - "$root/worker.json" | /usr/bin/tr -d '[:space:]')
  [[ "$allowed" == '["browser"]' ]] || fail 'unexpected worker profile allowlist'
  [[ "$(json_value "$root/fleet.json" profiles.0.name)" == browser ]] || fail 'partial or foreign browser configuration'
  [[ "$(json_value "$root/fleet.json" chromePath)" == "$chrome" ]] || fail 'Chrome path mismatch'
  [[ "$(json_value "$root/fleet.json" extensionDir)" == "$extension" ]] || fail 'extension path mismatch'
else
  [[ ! -e "$root/fleet.json" ]] || fail 'refusing an existing non-worker fleet root'
  # Native initialization returns the worker token; keep that output private, never in logs.
  "$bridge" fleet worker init "$HC_VM_WORKER_ID" --root "$root" \
    --host "$HC_VM_WORKER_HOST" --port 12310 --base-port 12900 \
    --chrome-path "$chrome" --extension-dir "$extension" \
    --seed-source daily=null >"$root/.worker-init.json"
  temporary=$(/usr/bin/mktemp "$root/.fleet.XXXXXX")
  /usr/bin/plutil -convert json -o "$temporary" "$root/fleet.json"
  /usr/bin/plutil -replace profiles.0.labels -json '["research","vm-pilot"]' "$temporary"
  /bin/chmod 600 "$temporary"
  /bin/mv "$temporary" "$root/fleet.json"
  /bin/rm "$root/.worker-init.json"
fi

if [[ -f "$agent" ]]; then
  [[ "$(json_value "$agent" ProgramArguments.0)" == "$bridge" ]] || fail 'foreign worker launch agent executable'
  [[ "$(json_value "$agent" ProgramArguments.5)" == "$root" ]] || fail 'foreign worker launch agent root'
fi
if ! /bin/launchctl print "$service" >/dev/null 2>&1; then
  "$bridge" fleet worker install-agent --root "$root" --allow-agent-install
fi

printf 'fleet-vm-guest: worker=%s host=%s port=12310 profile=browser\n' "$HC_VM_WORKER_ID" "$HC_VM_WORKER_HOST"
printf 'fleet-vm-guest: root=%s\n' "$root"
printf 'fleet-vm-guest: credentials remain in worker.json; none printed\n'
