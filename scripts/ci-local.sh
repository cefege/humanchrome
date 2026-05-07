#!/bin/bash
# Reproduce every meaningful CI check from .github/workflows/ci.yml locally.
#
# Why: GitHub Actions logs are slow to consult and noisy to parse. Run this
# before pushing and you find every failure in one shot.
#
# Usage (from repo root):
#   bash scripts/ci-local.sh           # fast: keep dist/.output/.wxt
#   bash scripts/ci-local.sh --clean   # fresh: nuke build outputs first
#
# Mirrors ci.yml; the macos-build TCC guard step calls
# scripts/verify-tcc-guard.mjs so both this script and ci.yml stay in sync.

# No -e: keep going past failures so FAILURES gathers them all in one run.
set -uo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

CLEAN=0
for arg in "$@"; do
  case "$arg" in
    --clean) CLEAN=1 ;;
    --skip-clean) CLEAN=0 ;;  # back-compat alias; --clean is the explicit form
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

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

run_in() {
  local dir="$1"; local label="$2"; shift 2
  if (cd "$dir" && "$@"); then
    echo "  ✓ $label"
  else
    echo "  ✗ $label"
    FAILURES+=("$label")
  fi
}

if [ "$CLEAN" -eq 1 ]; then
  step "clean (match a fresh CI checkout)"
  rm -rf packages/shared/dist app/native-server/dist app/chrome-extension/.output app/chrome-extension/.wxt
fi

step "build job: pnpm build"
run "pnpm build" pnpm build

# pnpm build must finish before lint/typecheck can run (typecheck imports
# the built shared/dist; chrome-extension typecheck needs .wxt/tsconfig.json
# generated during build). After that, lint and typecheck are read-only and
# share no write paths — fan them out.
step "build job: lint + typecheck (parallel)"
LINT_LOG="$(mktemp)"
TC_LOG="$(mktemp)"
pnpm lint > "$LINT_LOG" 2>&1 & LINT_PID=$!
pnpm typecheck > "$TC_LOG" 2>&1 & TC_PID=$!
if wait "$LINT_PID"; then echo "  ✓ pnpm lint"; else echo "  ✗ pnpm lint"; FAILURES+=("pnpm lint"); cat "$LINT_LOG"; fi
if wait "$TC_PID"; then echo "  ✓ pnpm typecheck"; else echo "  ✗ pnpm typecheck"; FAILURES+=("pnpm typecheck"); cat "$TC_LOG"; fi
rm -f "$LINT_LOG" "$TC_LOG"

step "build job: unit tests (shared + bridge + extension)"
run "pnpm -r test" pnpm -r --filter='!@humanchrome/wasm-simd' --filter='!humanchrome-monorepo' test

step "build job: bridge smoke"
run_in app/native-server "bridge smoke" node smoke-test.mjs

step "build job: extension smoke"
run_in app/chrome-extension "extension smoke" node smoke-test.mjs

step "chrome-smoke job: extension zip"
run "wxt zip" pnpm --filter humanchrome-extension zip

step "chrome-smoke job: zip presence + size sanity"
shopt -s nullglob
ZIP_CANDIDATES=("$ROOT"/app/chrome-extension/.output/humanchrome-*.zip)
shopt -u nullglob
ZIP_PATH="${ZIP_CANDIDATES[0]:-}"
if [ -z "$ZIP_PATH" ]; then
  echo "  ✗ zip locate"
  FAILURES+=("zip locate")
else
  ZIP_SIZE=$(stat -f%z "$ZIP_PATH" 2>/dev/null || stat -c%s "$ZIP_PATH" 2>/dev/null)
  if [ "${ZIP_SIZE:-0}" -lt 10000 ]; then
    echo "  ✗ zip size (only $ZIP_SIZE bytes)"
    FAILURES+=("zip size")
  else
    echo "  ✓ $(basename "$ZIP_PATH") ($ZIP_SIZE bytes)"
  fi
fi

step "macos-build job: TCC guard (macOS only)"
if [[ "$OSTYPE" == darwin* ]]; then
  run "TCC guard" node "$ROOT/scripts/verify-tcc-guard.mjs"
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
