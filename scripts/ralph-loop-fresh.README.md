# `ralph-loop-fresh.sh` — fresh-context autonomous loop

Alternative to the official `ralph-loop` plugin. Spawns one
`claude -p` process per iteration so each iteration starts with **zero
conversation context** carried over from the previous one. The plugin
re-injects the prompt via a Stop hook (in-session block-decision), which
keeps the conversation alive and bills the prompt cache for compounding
context — that's what this script is built to avoid.

## When to use which

|                            | `ralph-loop` plugin            | `ralph-loop-fresh.sh`                         |
| -------------------------- | ------------------------------ | --------------------------------------------- |
| Context carryover          | Yes (in-session)               | **No** (fresh process per iteration)          |
| Visibility                 | In your live conversation      | Per-iteration log files                       |
| Manual `/clear` needed     | Yes (every few iterations)     | **No** (handled by spawn boundary)            |
| Stop condition             | `<promise>X</promise>` tag     | `RALPH_LOOP_DONE` line in stdout              |
| Failure recovery           | Loop blocks on the stop hook   | Wrapper bails on dirty tree / non-zero exit   |
| Latency between iterations | Single conversation, immediate | One `claude` cold start (~1-3s) per iteration |

Use the plugin when you want to watch the work happen and steer
mid-flight. Use this script when you want to walk away and come back to
a stack of merged PRs.

## Quick start

```bash
# Default: up to 50 iterations, prompt at scripts/ralph-loop-fresh.prompt.md
bash scripts/ralph-loop-fresh.sh

# Cap iterations
RALPH_MAX_ITER=5 bash scripts/ralph-loop-fresh.sh

# Cap dollar spend
RALPH_BUDGET_USD=20 bash scripts/ralph-loop-fresh.sh

# Pick model + effort
RALPH_MODEL=opus RALPH_EFFORT=high bash scripts/ralph-loop-fresh.sh

# Use a custom prompt
bash scripts/ralph-loop-fresh.sh path/to/my-prompt.md

# Dry-run (print the command without running)
RALPH_DRY_RUN=1 bash scripts/ralph-loop-fresh.sh
```

## Environment variables

| Var                   | Default                   | Effect                                                  |
| --------------------- | ------------------------- | ------------------------------------------------------- |
| `RALPH_MAX_ITER`      | `50`                      | Hard cap on iterations                                  |
| `RALPH_LOG_DIR`       | `.claude/ralph-loop-logs` | Per-iteration log files                                 |
| `RALPH_SLEEP_SECONDS` | `5`                       | Pause between iterations                                |
| `RALPH_MODEL`         | unset                     | Passed to `claude --model`                              |
| `RALPH_EFFORT`        | unset                     | Passed to `claude --effort` (low/medium/high/xhigh/max) |
| `RALPH_BUDGET_USD`    | unset                     | Passed to `claude --max-budget-usd`                     |
| `RALPH_DRY_RUN`       | unset                     | Print the command instead of running it                 |

## Safety

- **Dirty working tree → exit 2 immediately** (before iteration 1) and
  again **after every iteration** if the previous one didn't commit
  cleanly. Prevents one iteration's uncommitted state from corrupting
  the next.
- `--dangerously-skip-permissions` is on. Don't run this in a directory
  you don't fully trust — Claude can drive `git`, `gh`, `npm`, `bash`,
  and `chrome` (via the humanchrome MCP server) without prompting.
- The wrapper aborts on any non-zero `claude` exit. Logs are kept under
  `.claude/ralph-loop-logs/` so you can diagnose.

## Completion

The wrapper greps each iteration's log for the literal string
`RALPH_LOOP_DONE`. The default prompt instructs each iteration to emit
that line on its own when the backlog `## Active` section has no
`proposed` items left. On match, the wrapper exits 0.

If `RALPH_MAX_ITER` is hit without the sentinel, the wrapper exits 1.

## Known limitations

- **Per-iteration cold start**: launching `claude -p` takes ~1-3 seconds
  before the model starts thinking. With `RALPH_SLEEP_SECONDS=5` the
  total overhead per iteration is ~6-10s, which compounds across long
  runs. Acceptable trade for context isolation.
- **No partial-iteration resume**: if the wrapper dies mid-iteration
  (Ctrl-C, crash), git state may be partial. Manually clean up
  (`git checkout main`, `git branch -D <wip>`) before re-running.
- **No mid-iteration intervention**: the spawned process is autonomous;
  you can't say "stop, redo that part" from outside without killing the
  process.
- **Auto-memory**: each iteration writes to the persistent memory dir
  the same way an interactive session would. Memories from one iteration
  ARE visible to the next iteration (memory is file-based, not
  conversation-based).

## Why a wrapper, not a plugin patch?

Verified against the Claude Code 2026 docs: the Stop hook output schema
has no `clear` or `compact` field; `/clear` and `/compact` are not
exposed as Skills; there's no SIGHUP/control-file/MCP path that resets
a live session. Programmatic clearing inside an in-session loop is not
possible with current Claude Code. External orchestration is the only
path. See `~/.claude/projects/-Users-mike-Documents-Code-humanchrome/
memory/feedback_loop_clear_after_done.md` for the research notes.
