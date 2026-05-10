# Ralph loop iteration prompt (fresh-context wrapper)

You are running ONE iteration of the autonomous improvement loop. The
parent shell wrapper (`scripts/ralph-loop-fresh.sh`) spawned you in a
brand-new Claude Code process — there is **no conversation history** from
the prior iteration. State carries between iterations only through:

- `docs/improvement-backlog.md` (the work queue)
- git history (what's already merged on `main`)
- persistent memory under `~/.claude/projects/-Users-mike-Documents-Code-humanchrome/memory/`

## Your job

Pick the highest-value Active backlog item and ship it end-to-end as a
single PR. Then exit.

If the backlog has no Active items left, output the literal string
`RALPH_LOOP_DONE` on its own line and exit. The wrapper greps stdout for
that exact string and stops the loop.

## Iteration steps

1. `git checkout main && git pull --ff-only origin main`. Refuse to
   continue if the working tree is dirty.
2. Read `docs/improvement-backlog.md`. Pick the first item under
   `## Active` whose `Status` is `proposed`. Skip anything `blocked`,
   `done`, or already in-progress in another branch. Tie-break by score
   descending, then by IMP id ascending. If nothing is `proposed` and
   nothing is `in-progress (slice 1 of N landed: ...)`, output
   `RALPH_LOOP_DONE` and exit.
3. Branch: `git checkout -b <kind>/imp-NNNN-<slug>` where `<kind>` is
   `feat` for new tools/features and `refactor` for splits.
4. Implement the IMP per the entry's Fix sketch. Touch only the files
   the sketch lists. New tests live in
   `app/chrome-extension/tests/tools/browser/<slug>.test.ts` (extension
   tools) or `app/native-server/src/agent/engines/<file>.test.ts`
   (bridge code).
5. **Spawn the `code-simplifier` agent** on the just-modified files
   BEFORE running tests (per `feedback_loop_simplify_step.md`):
   `Agent({subagent_type: 'general-purpose', model: 'opus', prompt:
<brief naming the files + IMP + permission to apply edits>})`.
6. Apply the simplifier's edits.
7. Run verification:
   - `cd packages/shared && npm run build` (if the shared package
     touched)
   - `cd app/chrome-extension && npx tsc --noEmit -p .`
   - `npx vitest run --reporter=dot tests/...` (targeted)
   - `cd app/native-server && npm test` (when bridge code touched)
   - `cd app/native-server && node scripts/generate-tools-doc.mjs` (when
     `packages/shared/src/tools.ts` schema changed)
8. Move the IMP entry from `## Active` to `## Done` with a one-paragraph
   summary covering: what shipped, the action surface, error
   classification, test count, full extension test count after the
   addition (for new tools), any manifest delta.
9. `git add -A && git commit` with a Conventional-Commits message
   (`feat(extension):`, `refactor(bridge):`, `fix(extension):`, etc.)
   ending with the standard `Co-Authored-By: Claude Opus 4.7 (1M
context) <noreply@anthropic.com>` footer.
10. `git push -u origin <branch>`.
11. `gh pr create` with a `## Summary` + `## Test plan` body matching
    recent PRs (#114, #116, #117, #119, #121 are templates).
12. Wait for CI: `gh run watch $(gh run list --branch <branch> --limit
1 --json databaseId -q '.[0].databaseId') --exit-status`.
13. `gh pr merge --squash --delete-branch`.
14. `git checkout main && git pull --ff-only origin main` to confirm
    the merge landed.
15. Exit. The wrapper handles the next iteration in a fresh process.

## Memory & feedback

The persistent memory under
`~/.claude/projects/-Users-mike-Documents-Code-humanchrome/memory/`
applies to every iteration:

- `feedback_max_effort_in_ralph_loop.md` — apply max effort in
  iterations AND in spawned Agent prompts
- `feedback_loop_autonomy.md` — don't surface scope/PR-shape
  decisions; just ship
- `feedback_loop_simplify_step.md` — `/simplify` (code-simplifier
  agent) runs BEFORE the verification suite
- `feedback_loop_clear_after_done.md` — do NOT prompt for `/clear`
  between iterations (the wrapper handles fresh-context for you)
- `feedback_agent_model.md` — every spawned Agent call gets
  `model: 'opus'`
- `feedback_low_permission_friction.md` — act, don't ask;
  `--dangerously-skip-permissions` is in effect

## Conflict-avoidance rules

- All edits to `packages/shared/src/tools.ts` are append-only: TOOL_NAMES
  at the end of the BROWSER object, TOOL_SCHEMAS at the end of the
  array, TOOL_CATEGORIES at the end of its map. Never reorder.
- Same for the dispatcher (`app/chrome-extension/entrypoints/background/
tools/index.ts`) and the barrel
  (`app/chrome-extension/entrypoints/background/tools/browser/index.ts`).
- One IMP per PR. No multi-feature batches. (Doc closures of stale
  entries can piggyback on a related PR — see #121's IMP-0035 closure
  for the pattern.)

## Failure handling

- If typecheck fails: fix it, don't paper over.
- If tests fail and the failure is unrelated to your change (the
  `preHandler.test.ts` 5s-timeout flake is a known pre-existing issue
  under parallel load), verify in isolation and proceed.
- If the iteration cannot finish cleanly (irrecoverable error,
  conflicting branch state, ambiguous scope), abort the iteration:
  delete the branch (`git checkout main && git branch -D <branch>`),
  append `**Status**: blocked\n- **Notes**: <one-line reason>` to the
  IMP entry, commit and push that doc change directly to main as a
  small `chore` commit, then exit. The wrapper picks up the next item
  on the next iteration. Do NOT loop forever on a broken iteration.

## Completion sentinel

When you've confirmed `## Active` has no `proposed` items left (after
your work or finding the queue already empty), output exactly:

```
RALPH_LOOP_DONE
```

on its own line, then end the response. The wrapper detects this and
stops the loop cleanly.
