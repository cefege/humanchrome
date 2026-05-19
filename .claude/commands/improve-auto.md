---
description: Autonomous variant of /improve — picks top backlog item, implements, builds, tests, opens auto-merge PR, all without user input. Designed to run inside /ralph-loop until backlog drains.
---

You are running the `/improve-auto` orchestration. This is the autonomous twin of `/improve` — same shape, but **never asks the user anything** and **commits + pushes + opens an auto-merge PR** at the end. The parent loop (`/ralph-loop`) re-injects this prompt at every Stop until the completion check emits `<promise>BACKLOG_DRAINED</promise>`.

**Loop discipline** (from user memory):

- Apply max effort in every spawned Agent call. Pass `model: "opus"`.
- Don't surface scope or PR-shape decisions — just ship.
- Skip `/clear` between iterations.
- Run `/simplify` before the verification suite, not after.

## Step 0 — Initialize state + assert clean tree

Run from `/Users/mike/Documents/Code/humanchrome`:

```bash
node /Users/mike/Documents/Code/humanchrome/.claude/scripts/loop-state-update.mjs init
node /Users/mike/Documents/Code/humanchrome/.claude/scripts/check-clean.mjs
```

If `check-clean.mjs` prints anything other than `clean` and exits 0:

- Exception: if `docs/improvement-backlog.md` is the **only** dirty path AND the only edits are status flips, auto-commit it with `chore(backlog): sync state` and continue.
- Otherwise: an earlier iteration left a real mess. Surface it as a blocker via `loop-state-update.mjs record-no-pr <last-IMP-or-unknown> 'dirty parent tree'`, then run the Step 8 completion check and end the iteration. Do NOT try to clean up — the next iteration starts fresh.

Then increment the iteration counter:

```bash
ITER=$(node /Users/mike/Documents/Code/humanchrome/.claude/scripts/loop-state-update.mjs begin-iteration)
```

## Step 1 — Decide whether to refresh scouts

Read `/Users/mike/Documents/Code/humanchrome/docs/improvement-backlog.md` and `/Users/mike/Documents/Code/humanchrome/.claude/loop-state.local.json`.

Refresh scouts (Step 2) if **any** of:

- `lastScoutAt` is null (first time).
- `iteration - lastScoutAt.iteration >= 8` (cadence refresh).
- Active items where `kind ∈ {bug, perf, refactor, docs}` AND `score >= 4` AND id not in `state.prsOpened[].imp` is fewer than 3.

Otherwise skip to Step 3.

## Step 2 — Parallel scouts

Spawn three subagents in **a single message with three Agent tool calls** (must run in parallel):

- `subagent_type: bug-scout`, `model: opus` — prompt: "Refresh the backlog with new bug entries. Read the current backlog, dedupe against active+done+archive, append at most 5 items. When done, run the triage script."
- `subagent_type: optimization-scout`, `model: opus` — same shape, for perf/refactor.
- `subagent_type: feature-scout`, `model: opus` — same shape, for feat (logged for future human pick — loop won't implement feats, but scouts surface them so the human sees the backlog state).

Wait for all three. Then run triage:

```bash
node /Users/mike/Documents/Code/humanchrome/.claude/scripts/triage-backlog.mjs
node /Users/mike/Documents/Code/humanchrome/.claude/scripts/loop-state-update.mjs record-scout
```

## Step 3 — Auto-pick the top item

Re-read `docs/improvement-backlog.md`. Walk the `## Active` list (already sorted by score desc, id asc). Pick the **first** item that satisfies ALL:

- `kind ∈ {bug, perf, refactor, docs}` — skip `feat`.
- `score >= 4`.
- Not in `state.prsOpened[].imp` (no re-attempts of an already-shipped item).
- `status` is `proposed` or `queued` (not `in-progress` or `done` or `wontdo`).

If nothing qualifies at `score >= 4`, lower the threshold to `score >= 3` and try again. If still nothing, skip to Step 8 (completion check) — the loop is likely drained.

Once picked, set the local variable `IMP` to the id (e.g. `IMP-0122`), `TITLE` to the title text, and `BACKLOG_ENTRY` to the full markdown block (header + all `- **...**:` lines).

## Step 4 — (no parent-side backlog edits)

Backlog updates land in the IMP's own branch (per Step 5 below) and ride to main via the auto-merge PR. The parent NEVER pushes directly to main — the harness's git-push hook blocks direct-to-main pushes. Every state change goes through a PR.

## Step 5 — Spawn the implementer in a worktree

Capture the main commit hash:

```bash
MAIN_SHA=$(git -C /Users/mike/Documents/Code/humanchrome rev-parse main)
```

Construct the IMP slug (lowercase, dashes, ≤ 40 chars): e.g. `imp-0122-search-tabs-content-offscreen-doc`.

Spawn a `general-purpose` subagent with:

- `isolation: "worktree"`
- `model: "opus"`
- A self-contained prompt with the substitutions below.

### Implementer prompt template

```
You're implementing IMP-{NNNN} from the humanchrome improvement backlog,
inside an isolated git worktree.

# Step A — sync (mandatory, before anything else)

From inside your worktree:

  node /Users/mike/Documents/Code/humanchrome/.claude/scripts/sync-worktree-to-main.mjs {MAIN_SHA}

The script fetches main from the source repo, hard-resets HEAD to {MAIN_SHA},
exits non-zero on mismatch. If it exits non-zero, abort and report
"sync failed: <stderr>".

# Step B — create your branch

git checkout -b auto/{IMP-SLUG}

# Step C — implement the IMP

Apply max effort. Read the backlog entry below, the files it references, and
write code that addresses the root cause -- not a workaround. Cover edge
cases in tests, not just the happy path. Update docs/AGENTS.md, CLAUDE.md,
or any auto-generated doc that changes as a side effect.

If the change touches packages/shared/src/tools.ts (or any tool-schemas/
file): regenerate docs/TOOLS.md by running:
  cd app/native-server && node scripts/generate-tools-doc.mjs

# Step D — flip backlog entry to Done (in the same worktree)

Edit docs/improvement-backlog.md:
  - Move IMP-{NNNN} from `## Active` to `## Done`.
  - Replace its status line with `- **Status**: done`.
  - Append:
      - **Completed**: {YYYY-MM-DD}
      - **Summary**: {one-line summary of what you implemented}

This commit ships the backlog flip alongside the code -- the parent loop
NEVER pushes to main directly (the harness's git hook blocks that). Every
state change goes through the auto-merge PR.

# Step E — verify locally

Run from the worktree root:

  pnpm -w build                  # must finish green
  pnpm test                      # serial workspace (see IMP-0123)
  node app/native-server/smoke-test.mjs
  node app/chrome-extension/smoke-test.mjs

Any red gate -> abort and report the failure. Do not try to "fix the test
to match" -- the test exists for a reason. If the test is wrong, that's a
separate IMP to file, not a unilateral edit.

# Step F — commit (do NOT push)

Conventional Commits subject with IMP id; full body explains WHY and HOW.
Footer must include the Co-Author trailer.

  git add -A   # includes the backlog flip from Step D
  git commit -m "<type>(<scope>): <imperative subject> (IMP-{NNNN})
  ...
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"

# Step G — report (single returned message)

Return a structured markdown report with these sections (the parent will
embed it verbatim into the PR body):

  ## Files changed
  - path/to/file.ts (+12 -3)
  - ...

  ## Tests added or modified
  - path/to/test.ts (5 new cases covering ...)

  ## Verification
  - pnpm -w build: green
  - vitest: 1592/1592 pass
  - jest: 165/165 pass
  - smoke-test bridge: green
  - smoke-test extension: green

  ## Worktree handoff
  - path: {absolute path}
  - branch: auto/{IMP-SLUG}
  - HEAD: {sha}
  - synced from main: {MAIN_SHA}

Do NOT push. Do NOT open a PR. The parent loop handles those.

If the IMP turns out to be infeasible as scoped, stop and report:
  ## Blocker
  <one-line>
  <multi-line context if useful>

--- backlog entry (verbatim) ---
{BACKLOG_ENTRY}
--- end ---
```

Wait for the implementer to return. Parse its report:

- If the report contains a `## Blocker` heading: jump to **Step 5x** (blocker handling).
- Otherwise read the worktree path + branch name from the `## Worktree handoff` section.

## Step 5x — Blocker handling

The implementer hit a wall. Roll back the in-progress flip on the backlog (status → `queued`), append `- **Blocker**: <one-line>`, commit + push the backlog change, record the no-PR result, then jump to Step 8.

```bash
node /Users/mike/Documents/Code/humanchrome/.claude/scripts/loop-state-update.mjs record-no-pr "$IMP" "<one-line blocker>"
```

## Step 5b — Simplify pass (in the worktree)

Spawn a `general-purpose` subagent with `model: "opus"` and **no** isolation (the simplify pass operates on the implementer's existing worktree — `isolation: "worktree"` would create a fresh empty worktree and defeat the purpose). Prompt:

```
You are running a simplify pass on the IMP-{NNNN} commit at HEAD of an
existing worktree.

# Step 1 — switch to the worktree
cd {WORKTREE_PATH}
git log -1 --oneline   # confirm you see the implementer's commit

# Step 2 — invoke the simplify skill
Use the Skill tool with skill="simplify". The skill reviews changes for
reuse, quality, efficiency. Apply any improvements it suggests to the
files in this worktree.

# Step 3 — amend onto HEAD (do NOT create a new commit)
If you made changes:
  git add -A
  git commit --amend --no-edit
If you made no changes: do nothing.

# Step 4 — verify still green
pnpm -w build && pnpm -r --filter='!@humanchrome/wasm-simd' --filter='!humanchrome-monorepo' test
If the simplify pass broke a test, revert your amend:
  git reset --hard ORIG_HEAD
and report "simplify broke tests; reverted: <one-line>".

# Step 5 — report
Return a one-paragraph summary of what was simplified, OR "no changes
needed", OR "simplify broke tests; reverted: <one-line>".
```

Capture the simplify summary; append it to the implementer's report.

## Step 5c — Verification matrix (in the worktree)

Run from the worktree (use the absolute path the implementer returned):

```bash
cd <worktree-path>
pnpm -w build \
  && pnpm -r --filter='!@humanchrome/wasm-simd' --filter='!humanchrome-monorepo' test \
  && node app/native-server/smoke-test.mjs \
  && node app/chrome-extension/smoke-test.mjs
```

On any red: this is a regression introduced by the simplify pass. Treat as a blocker (Step 5x) but include the failure output in the blocker note.

## Step 5d — E2E if extension touched

```bash
cd <worktree-path>
DIFF=$(git diff main --name-only)
if echo "$DIFF" | grep -q '^app/chrome-extension/'; then
  cd app/chrome-extension && pnpm e2e:isolated
fi
```

On any red: blocker (Step 5x).

## Step 5e — Guardrails

```bash
node /Users/mike/Documents/Code/humanchrome/.claude/scripts/loop-guardrails.mjs <worktree-path>
```

If output starts with `refuse:` → blocker (Step 5x), use the refuse reason verbatim in the blocker note.

## Step 6 — Push + open auto-merge PR

```bash
cd <worktree-path>
git push -u origin auto/{IMP-SLUG}

# Write the implementer's enriched report (with simplify summary appended)
# to a tmp file:
REPORT_FILE=$(mktemp -t auto-pr-report-XXXXXX.md)
cat > "$REPORT_FILE" <<'REPORT_EOF'
<paste the full enriched implementer report here>
REPORT_EOF

# Open the PR with auto-merge enabled:
OUT=$(node /Users/mike/Documents/Code/humanchrome/.claude/scripts/open-auto-pr.mjs \
  --imp "$IMP" \
  --branch "auto/{IMP-SLUG}" \
  --title "<implementer's commit subject>" \
  --report-file "$REPORT_FILE")
# OUT format: pr=NNN url=https://... automerge=on
PR_NUM=$(echo "$OUT" | sed 's/.*pr=\([0-9]*\).*/\1/')
PR_URL=$(echo "$OUT" | sed 's/.*url=\([^ ]*\).*/\1/')

node /Users/mike/Documents/Code/humanchrome/.claude/scripts/loop-state-update.mjs record-pr "$IMP" "$PR_NUM" "$PR_URL"
```

## Step 7 — (backlog flip already in the PR)

The implementer's Step D moved the IMP from `## Active` to `## Done` inside the worktree. That edit is part of the auto-merge PR opened in Step 6 — so the backlog reflects "done" the moment GitHub squash-merges. No parent-side commit, no direct main push.

The only remaining update is the PR number: append `- **PR**: #{PR_NUM}` to the Done entry. Do this by pushing a follow-up amend to the same branch:

```bash
cd <worktree-path>
# Find the Done entry just added and append PR line.
# Use sed to insert after the "- **Summary**:" line.
sed -i.bak "/^### IMP-{NNNN}.*$/,/^### /{/^- \*\*Summary\*\*:/a\\
- **PR**: #${PR_NUM}
}" docs/improvement-backlog.md
rm docs/improvement-backlog.md.bak
git add docs/improvement-backlog.md
git commit --amend --no-edit
git push --force-with-lease   # only force-with-lease ever — never plain force
```

`--force-with-lease` is the safe variant: it succeeds only if the remote ref is still pointing at the commit we last pushed (no one else has pushed in between). If a human pushed to the branch in the meantime (unlikely for `auto/*`), the push aborts safely and the parent treats it as a blocker.

## Step 8 — Completion check + promise emission

```bash
STATUS=$(node /Users/mike/Documents/Code/humanchrome/.claude/scripts/loop-completion-check.mjs)
echo "completion-check: $STATUS"
```

Possible outputs:

- `continue` → end the iteration cleanly. The ralph stop-hook re-injects the prompt and the next iteration begins.
- `done-drained` / `done-stalled` / `done-walltime` / `done-ratelimit` / `done-bootstrap` → the loop is finished. Write a final summary to `.claude/loop-final-summary.md`:

```
# Autonomous loop — final summary

- **Stopped at**: {ISO timestamp}
- **Reason**: {STATUS}
- **Iterations**: {state.iteration}
- **PRs opened**: {state.prsOpened.length + state.prsMerged.length}
- **PRs merged**: {state.prsMerged.length}
- **Consecutive no-PR**: {state.consecutiveNoPR}
- **Last failure**: {state.lastFailureSummary?.blocker or 'none'}

## Merged PRs
- IMP-NNNN · #PR · {one-line}

## Open PRs (CI in flight, manual merge optional)
- IMP-NNNN · #PR · {one-line}

## Skipped items still in backlog
- IMP-NNNN · {kind/score} · {one-line why-skipped}
```

Then end your response with literally:

```
<promise>BACKLOG_DRAINED</promise>
```

The ralph-loop stop-hook reads this verbatim and exits the loop. **DO NOT** emit this promise tag at any other time — without it, the loop keeps iterating.

## Notes

- The orchestrator runs in the OUTER session (the one ralph-loop watches). The implementer + simplify-pass run in worktree-isolated subagents. The completion-promise must come from the OUTER session, otherwise ralph won't see it.
- Never push directly to main. The harness's git hook blocks it. EVERY change goes through the auto-merge PR — including the backlog Done flip (in the implementer's commit) and the PR-number annotation (in a force-with-lease amend).
- Never run `git reset --hard` or `git push --force` in the loop. `git push --force-with-lease` IS allowed (and used by Step 7 to amend the PR-number into the backlog) because it refuses if anyone else pushed in between. If a worktree state is broken, abandon it and let the implementer's next attempt branch fresh from main.
- `loop-state.local.json` is in `.gitignore` — it never enters a commit. The PR audit trail comes from `state.prsOpened[]` + `state.prsMerged[]` + the per-PR backlog commits.
