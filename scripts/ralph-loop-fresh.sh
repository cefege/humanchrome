#!/usr/bin/env bash
# ralph-loop-fresh.sh — autonomous-loop orchestrator with fresh context per iteration.
#
# Why this exists:
#   The official ralph-loop plugin re-injects the prompt via a Stop hook
#   that returns {decision: block, reason: <prompt>}. That keeps the same
#   conversation alive across iterations and the prompt cache + context
#   grow unboundedly. There is no way to invoke /clear from a hook
#   (verified against the Stop hook output schema: no clear/compact field;
#   Skill tool doesn't expose /clear; no SIGHUP/control-file path).
#
#   This script is the canonical alternative: spawn `claude -p` per
#   iteration. Every iteration is a brand-new process with zero context
#   carried over. Iterations communicate state through the file system
#   (docs/improvement-backlog.md, git, persistent memory under
#   ~/.claude/projects/).
#
# Usage:
#   bash scripts/ralph-loop-fresh.sh                # default prompt + 50 iter cap
#   RALPH_MAX_ITER=10 bash scripts/ralph-loop-fresh.sh
#   bash scripts/ralph-loop-fresh.sh path/to/custom-prompt.md
#
# Env knobs:
#   RALPH_MAX_ITER       hard cap on iterations (default 50)
#   RALPH_LOG_DIR        per-iteration logs (default .claude/ralph-loop-logs)
#   RALPH_SLEEP_SECONDS  pause between iterations (default 5)
#   RALPH_MODEL          claude model alias / id (default unset, claude picks)
#   RALPH_EFFORT         effort level (low|medium|high|xhigh|max — default unset)
#   RALPH_BUDGET_USD     max spend; aborts the loop if exceeded (default unset)
#   RALPH_DRY_RUN        if set, prints the command instead of running it
#
# Completion: an iteration signals "queue empty" by emitting the literal
# string RALPH_LOOP_DONE on its own line in stdout. The wrapper greps the
# log; on match it exits 0 immediately. If RALPH_MAX_ITER is reached
# without that sentinel, exits 1.

set -euo pipefail

PROMPT_FILE="${1:-scripts/ralph-loop-fresh.prompt.md}"
MAX_ITER="${RALPH_MAX_ITER:-50}"
LOG_DIR="${RALPH_LOG_DIR:-.claude/ralph-loop-logs}"
SLEEP_SECONDS="${RALPH_SLEEP_SECONDS:-5}"
SENTINEL="RALPH_LOOP_DONE"

if [[ ! -f "$PROMPT_FILE" ]]; then
  echo "ralph-loop-fresh: prompt file not found: $PROMPT_FILE" >&2
  exit 2
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "ralph-loop-fresh: 'claude' CLI not on PATH" >&2
  exit 2
fi

mkdir -p "$LOG_DIR"

PROMPT="$(cat "$PROMPT_FILE")"

# Build the claude argv from env knobs. --no-session-persistence keeps
# the per-iteration session out of the picker; --dangerously-skip-
# permissions is required because the iteration drives git, gh, npm, and
# tsc with no user at the keyboard. Don't run this in a directory you
# don't trust.
#
# Defined as a regular array (not via mapfile) so this stays compatible
# with macOS's default bash 3.2.
CLAUDE_ARGS=(
  -p
  --print
  --dangerously-skip-permissions
  --no-session-persistence
  --output-format stream-json
  --include-partial-messages
  --verbose
)
if [[ -n "${RALPH_MODEL:-}" ]]; then
  CLAUDE_ARGS+=(--model "$RALPH_MODEL")
fi
if [[ -n "${RALPH_EFFORT:-}" ]]; then
  CLAUDE_ARGS+=(--effort "$RALPH_EFFORT")
fi
if [[ -n "${RALPH_BUDGET_USD:-}" ]]; then
  CLAUDE_ARGS+=(--max-budget-usd "$RALPH_BUDGET_USD")
fi

echo "ralph-loop-fresh: starting (max $MAX_ITER iterations, log dir $LOG_DIR)"
echo "ralph-loop-fresh: prompt=$PROMPT_FILE"
echo "ralph-loop-fresh: claude args=${CLAUDE_ARGS[*]}"
echo

# Dry-run short-circuits BEFORE the dirty-tree check so the wrapper is
# usable while iterating on the script itself. The actual run-time
# dirty-tree check still runs per iteration below.
if [[ -n "${RALPH_DRY_RUN:-}" ]]; then
  echo "[dry-run] Would loop up to $MAX_ITER times, executing:"
  echo "[dry-run]   claude ${CLAUDE_ARGS[*]} \"\$(cat $PROMPT_FILE)\""
  echo "[dry-run] Per-iteration log: $LOG_DIR/iter-<timestamp>-<n>.log"
  echo "[dry-run] Stop sentinel: $SENTINEL"
  exit 0
fi

# Refuse to start with a dirty working tree — an iteration mid-flight
# from a previous run would corrupt this run.
if [[ -n "$(git status --porcelain 2>/dev/null || true)" ]]; then
  echo "ralph-loop-fresh: working tree is dirty. Commit, stash, or clean before starting." >&2
  git status --short
  exit 2
fi

start_ts="$(date +%s)"

for ((i=1; i<=MAX_ITER; i++)); do
  iter_log="$LOG_DIR/iter-$(date +%Y%m%d-%H%M%S)-$i.log"
  echo "=== ralph-loop-fresh: iteration $i/$MAX_ITER (log: $iter_log) ==="

  # Run claude. Tee both stdout (the stream-json events) and stderr to
  # the log AND to the user's terminal so they can watch in real time.
  set +e
  claude "${CLAUDE_ARGS[@]}" "$PROMPT" 2>&1 | tee "$iter_log"
  rc=${PIPESTATUS[0]}
  set -e

  if [[ "$rc" -ne 0 ]]; then
    echo "ralph-loop-fresh: iteration $i failed (claude exit $rc). See $iter_log." >&2
    exit 1
  fi

  # Sentinel detection. Look in the assistant message text blocks of the
  # stream-json output. Use a tolerant grep so quoting variations don't
  # break it.
  if grep -q -F "$SENTINEL" "$iter_log"; then
    elapsed=$(( $(date +%s) - start_ts ))
    echo
    echo "ralph-loop-fresh: completion sentinel detected after $i iterations (${elapsed}s total)."
    exit 0
  fi

  # Sanity: if the iteration left the working tree dirty (uncommitted
  # changes), the iteration didn't finish cleanly. Fail loudly so the
  # user can investigate before the next iteration scribbles over it.
  if [[ -n "$(git status --porcelain 2>/dev/null || true)" ]]; then
    echo "ralph-loop-fresh: iteration $i left an uncommitted working tree." >&2
    git status --short
    echo "ralph-loop-fresh: aborting to avoid corruption. Commit/stash and re-run." >&2
    exit 1
  fi

  echo "ralph-loop-fresh: iteration $i complete; sleeping ${SLEEP_SECONDS}s before next."
  sleep "$SLEEP_SECONDS"
done

elapsed=$(( $(date +%s) - start_ts ))
echo "ralph-loop-fresh: max iterations ($MAX_ITER) reached without completion sentinel (${elapsed}s total)." >&2
exit 1
