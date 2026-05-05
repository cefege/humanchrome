---
description: Refresh the improvement backlog (running scouts if stale), present the top 5 items, let the user pick one, and spawn an isolated implementer agent.
---

You are running the `/improve` orchestration. Follow these steps in order; do
not skip.

## Step 0 — Refuse if the working tree is dirty

Implementer agents work in `git worktree`s, which branch from the **committed**
state of `main`. Any uncommitted changes in the main working tree are invisible
to them — so each successive `/improve` would build on stale code, not on the
work that just landed. The only way to keep improvements compounding is to
require a clean tree before each run.

Run this check from `/Users/mike/Documents/Code/humanchrome`:

```bash
node /Users/mike/Documents/Code/humanchrome/.claude/scripts/check-clean.mjs
```

The script prints `clean` and exits 0 when the tree has no uncommitted changes
outside the always-ignored set (`.claude/worktrees/`, anything `.gitignore`d).
Otherwise it prints the dirty paths and exits 1.

If the tree is dirty:

- Print the offending paths to the user.
- Stop immediately. Tell them: "commit (or stash) your changes, then re-run
  `/improve`." Do **not** try to commit on their behalf, do **not** stash on
  their behalf, do **not** proceed.
- Exception: if `docs/improvement-backlog.md` is the **only** dirty path AND
  the only edits are status flips left over from a prior `/improve` run, you
  may auto-commit that single file with message
  `chore(backlog): sync state` before continuing. (See Step 6 — that step also
  auto-commits, so this only triggers when an earlier run was interrupted.)

## Step 1 — Check backlog freshness

Read `docs/improvement-backlog.md`. Look at the most recent `Proposed by:`
date across all `## Active` items. If that date is **today**, the backlog is
fresh — skip to step 3. Otherwise, the backlog is stale — do step 2.

## Step 2 — Refresh by running scouts in parallel

Spawn three subagents in **a single message with three Agent tool calls** so
they run in parallel:

- `subagent_type: feature-scout` — prompt: "Refresh the backlog with new
  feature ideas. Read the current backlog, dedupe, append at most 5 items.
  When done, run the triage script."
- `subagent_type: bug-scout` — prompt: same shape, for bugs.
- `subagent_type: optimization-scout` — prompt: same shape, for perf/refactor.

Wait for all three to complete. Then run the triage script once more to be
safe (idempotent):

```bash
node /Users/mike/Documents/Code/humanchrome/.claude/scripts/triage-backlog.mjs
```

## Step 3 — Read and present the top 5

Read the now-current `docs/improvement-backlog.md`. Take the first 5 entries
from `## Active` (already sorted by score descending).

Present them via `AskUserQuestion`:

- Question: "Which item should I work on next?"
- Header: "Pick item"
- Options (max 4 + Other auto-added by the tool):
  - Top 4 items, formatted as `IMP-NNNN · short title (kind, score N)` with
    the `why` line as the option's `description`.
  - The 5th item goes into the "Other" path — if the user types its id, treat
    it as a pick.
  - Single-select.

If the user picks "Other" and types something that's not an IMP-id, ask once
for clarification (id or "skip"). If they say "skip", end the turn cleanly
with a one-line note: "no item selected — backlog stays as is."

## Step 4 — Mark picked item in-progress

Edit `docs/improvement-backlog.md` to change the picked item's
`- **Status**: queued` line to `- **Status**: in-progress`. Use the Edit tool
on the exact line.

## Step 5 — Spawn the implementer agent

Spawn a `general-purpose` subagent with `isolation: "worktree"`. The prompt
**must** be self-contained (the agent has no conversation context).

**Read the current main commit hash first**: run
`git -C /Users/mike/Documents/Code/humanchrome rev-parse main` — capture
as `MAIN_SHA`. The worktree harness branches from a stale, session-fixed
base, not current main HEAD. The implementer must sync to MAIN_SHA before
any other action, otherwise the change is built on missing renames /
missing tools / dropped fixes from earlier `/improve` runs.

Include this in the prompt (substitute `{MAIN_SHA}`):

```
You're implementing one item from the humanchrome improvement backlog.

Sync first (mandatory, before any other action). From inside your
worktree, run:

  node /Users/mike/Documents/Code/humanchrome/.claude/scripts/sync-worktree-to-main.mjs {MAIN_SHA}

The script fetches main from the source repo, hard-resets HEAD to
{MAIN_SHA}, and exits non-zero on mismatch. If it exits non-zero, abort —
do not work on stale code.

Then:

  1. Implement the change.
  2. Run pnpm -w build (must finish green).
  3. Run pnpm --filter humanchrome-bridge test for any change touching the
     native server, and pnpm --dir app/chrome-extension test for any change
     touching the extension.
  4. Report (in your single returned message): files changed with line
     counts, build status, test status, any blockers, the worktree path +
     branch name, and **the synced HEAD (it must match {MAIN_SHA})**.

DO NOT commit. DO NOT push. Leave the worktree clean for the user to
review. If the change is not feasible as scoped, stop and report why.

--- backlog entry (verbatim) ---
{paste the full markdown entry, including the ### header line}
--- end ---

Likely-relevant files (best-effort grep): {list of file paths from a quick
search using the title and "why" keywords}
```

After the agent returns, check the report mentions a HEAD matching
MAIN_SHA. If it doesn't (or the sync script wasn't called), the work is
suspect — rebase the worktree onto current main yourself before merging,
the same way IMP-0002 was rebased.

The implementer agent runs in the foreground (the user is waiting). When it
returns:

## Step 6 — Update backlog and surface the report

- If the agent reports success and tests are green:
  - Move the item from `## Active` to `## Done`. Append a short summary line:
    `### IMP-NNNN · {title} (kind) · score: N\n- **Status**: done\n- **Completed**: YYYY-MM-DD\n- **Summary**: {one-line summary from the agent's report}\n- **Worktree**: {path/branch}`
  - **Commit the backlog change** so the next `/improve` starts clean:
    ```bash
    cd /Users/mike/Documents/Code/humanchrome && git add docs/improvement-backlog.md && git commit -m "chore(backlog): IMP-NNNN done — short title"
    ```
- If the agent reports a blocker:
  - Set status back to `queued` and append a `- **Blocker**: ...` note to the
    item with what went wrong.
  - Commit the backlog change with message
    `chore(backlog): IMP-NNNN blocked — short title`.
- Either way, surface the agent's report verbatim to the user (it's their
  diff to review).

The backlog commit is small (a single file, status changes only). It exists so
the working tree returns to clean after every `/improve` run, which is what
Step 0 enforces. Reviewing the implementer's worktree is a separate action
(the user does that on their schedule).

## Notes

- This command is the only place that calls scouts and the implementer. If
  the user wants to just run scouts without picking, suggest they edit the
  backlog manually.
- If the backlog is empty, say so plainly and stop. Don't fabricate items.
- Triage is deterministic and cheap — re-run it freely.
