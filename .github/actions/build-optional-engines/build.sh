#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  printf '%s\n' 'Optional engine archives currently support darwin arm64 only.' >&2
  exit 1
fi
if [[ $# != 1 ]]; then
  printf '%s\n' 'Usage: build.sh <fresh-output-directory>' >&2
  exit 2
fi
root=$(cd "$(dirname "$0")/../../.." && pwd)
runtimes=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/hc-engine-inputs.XXXXXX")
trap 'rm -rf "$runtimes"' EXIT

# Explicit inputs to the builder's independently checked runtime/version pins.
curl --fail --location --silent --show-error \
  https://nodejs.org/dist/v24.22.2/node-v24.22.2-darwin-arm64.tar.xz \
  --output "$runtimes/node.tar.xz"
printf '%s  %s\n' \
  1f5ac075be50bed4780ea3be19a007fda95ea4d527d28d76d0b91de47d915115 \
  "$runtimes/node.tar.xz" | shasum -a 256 --check
curl --fail --location --silent --show-error \
  https://github.com/openai/codex/releases/download/rust-v0.154.0/codex-aarch64-apple-darwin.tar.gz \
  --output "$runtimes/codex.tar.gz"
printf '%s  %s\n' \
  344310a0a591c1b192e04feff304321a69907c9498baaac331ca7e16ebcef9d7 \
  "$runtimes/codex.tar.gz" | shasum -a 256 --check
tar -xzf "$runtimes/codex.tar.gz" -C "$runtimes"

node "$root/scripts/build-optional-engines.mjs" \
  --target aarch64-apple-darwin \
  --output-dir "$1" \
  --node-archive "$runtimes/node.tar.xz" \
  --codex-path "$runtimes/codex-aarch64-apple-darwin"
