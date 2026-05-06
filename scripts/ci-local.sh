#!/bin/bash
# Reproduce every meaningful CI check from .github/workflows/ci.yml locally.
#
# Why: GitHub Actions logs are slow to consult and noisy to parse. Run this
# before pushing and you find every failure in one shot.
#
# Usage (from repo root):
#   bash scripts/ci-local.sh
#   bash scripts/ci-local.sh --skip-clean   # keep dist/.output/.wxt for speed
#
# Mirrors ci.yml as of commit 54cb2a7. If ci.yml changes, update here.

set -uo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
SKIP_CLEAN="${1:-}"
FAILURES=()

step() {
  echo
  echo "============================================================"
  echo "STEP: $1"
  echo "============================================================"
}

run() {
  local label="$1"; shift
  if "$@"; then
    echo "  ✓ $label"
  else
    echo "  ✗ $label"
    FAILURES+=("$label")
  fi
}

if [ "$SKIP_CLEAN" != "--skip-clean" ]; then
  step "clean (match a fresh CI checkout)"
  rm -rf packages/shared/dist app/native-server/dist app/chrome-extension/.output app/chrome-extension/.wxt
fi

step "build job: pnpm build"
run "pnpm build" pnpm build

step "build job: pnpm lint"
run "pnpm lint" pnpm lint

step "build job + typecheck-node22 job: pnpm typecheck"
run "pnpm typecheck" pnpm typecheck

step "build job: bridge smoke"
(cd app/native-server && node smoke-test.mjs)
if [ $? -ne 0 ]; then FAILURES+=("bridge smoke"); fi

step "build job: extension smoke"
(cd app/chrome-extension && node smoke-test.mjs)
if [ $? -ne 0 ]; then FAILURES+=("extension smoke"); fi

step "chrome-smoke job: extension zip"
run "wxt zip" pnpm --filter humanchrome-extension zip

step "chrome-smoke job: zip presence + size sanity"
ZIP_PATH="$(ls "$ROOT"/app/chrome-extension/.output/humanchrome-*.zip 2>/dev/null | head -n 1 || true)"
if [ -z "${ZIP_PATH}" ]; then
  echo "  ✗ no humanchrome-*.zip found"
  FAILURES+=("zip-locate")
else
  ZIP_SIZE=$(stat -f%z "$ZIP_PATH" 2>/dev/null || stat -c%s "$ZIP_PATH" 2>/dev/null)
  if [ "${ZIP_SIZE:-0}" -lt 10000 ]; then
    echo "  ✗ zip suspiciously small ($ZIP_SIZE bytes)"
    FAILURES+=("zip-size")
  else
    echo "  ✓ $(basename "$ZIP_PATH") ($ZIP_SIZE bytes)"
  fi
fi

step "macos-build job: TCC guard (macOS only)"
if [[ "$OSTYPE" == darwin* ]]; then
  STAGE="$HOME/Documents/humanchrome-tcc-guard-smoke/dist"
  rm -rf "$HOME/Documents/humanchrome-tcc-guard-smoke"
  mkdir -p "$STAGE"
  cp -R app/native-server/dist/. "$STAGE/"
  if node -e "
    const { tccProtectedRootContaining } = require('$STAGE/scripts/utils.js');
    const r = tccProtectedRootContaining('$STAGE/run_host.sh');
    if (!r) { console.error('FAIL: TCC guard did not flag ~/Documents path'); process.exit(1); }
    console.log('OK: TCC guard flagged path under', r);
  "; then
    echo "  ✓ TCC guard"
  else
    echo "  ✗ TCC guard"
    FAILURES+=("tcc-guard")
  fi
  rm -rf "$HOME/Documents/humanchrome-tcc-guard-smoke"
else
  echo "  (skipped — not on macOS)"
fi

echo
echo "============================================================"
if [ ${#FAILURES[@]} -eq 0 ]; then
  echo "ALL CI CHECKS PASSED LOCALLY ✓"
  exit 0
else
  echo "FAILURES:"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  echo
  echo "Fix the above before pushing — CI will fail on the same things."
  exit 1
fi
