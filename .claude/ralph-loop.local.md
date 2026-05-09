---
active: true
iteration: 1
session_id:
max_iterations: 30
completion_promise: 'RALPH_QUEUE_DONE'
started_at: '2026-05-09T16:35:20Z'
---

You are running an autonomous loop to ship the IMP-0074..IMP-0084 work queue defined in docs/improvement-backlog.md. Each iteration ships ONE new IMP and merges it before the next iteration starts.

ON EVERY ITERATION:

Step 1. cd /Users/mike/Documents/Code/humanchrome and run "git checkout main && git pull --ff-only origin main".

Step 2. Read docs/improvement-backlog.md. Pick the LOWEST-numbered IMP-NNNN entry in the IMP-0074 through IMP-0084 range whose Status field is "proposed". Skip any marked "done" or "blocked". If every entry in that range is done or blocked, output the literal string RALPH_QUEUE_DONE on its own line and exit successfully — that is the completion signal.

Step 3. Create a feature branch: "git checkout -b feat/imp-NNNN-SLUG" where SLUG is a short kebab-case version of the tool name (focus, paste, select-text, window, web-vitals, idle, alarms, clear-browsing-data, proxy, identity, drag-drop).

Step 4. Implement the tool by following the Fix sketch in the IMP entry verbatim. The Fix sketch is detailed enough that no design decisions are needed — just execute it. Create the new tool file at app/chrome-extension/entrypoints/background/tools/browser/SLUG.ts. The class extends BaseBrowserToolExecutor. Error mapping: TAB_CLOSED for any error message matching /no tab with id/i, INVALID_ARGS for argument validation failures, UNKNOWN otherwise. Use the just-shipped tools as canonical templates: notifications.ts, sessions.ts, tab-lifecycle.ts, network-emulate.ts, print-to-pdf.ts, block-or-redirect.ts, action-badge.ts, keep-awake.ts, context-menu.ts, clipboard.ts, tab-groups.ts in the same directory.

Step 5. APPEND-ONLY edits to packages/shared/src/tools.ts: add TOOL_NAMES.BROWSER.NEW_KEY at the END of the BROWSER object, append a new TOOL_SCHEMAS entry just before the closing "];", append a new TOOL_CATEGORIES entry just before the RECORD_REPLAY block. Never reorder existing entries; never edit other tools' descriptors.

Step 6. APPEND-ONLY edit to app/chrome-extension/entrypoints/background/tools/browser/index.ts: add an "export { newTool } from './SLUG';" line near the other recently-added exports.

Step 7. APPEND-ONLY edit to app/chrome-extension/entrypoints/background/tools/index.ts: add an "import { newTool } from './browser/SLUG';" line and append "newTool," into the eagerTools array.

Step 8. If the Fix sketch lists new manifest permissions, add them to the permissions array in app/chrome-extension/wxt.config.ts.

Step 9. Write tests at app/chrome-extension/tests/tools/browser/SLUG.test.ts. Aim for 8 to 15 cases covering argument validation per action, happy path per action, error classifications (TAB_CLOSED, INVALID_ARGS), and the missing-permission path when applicable. Use the just-shipped test files in the same directory as the canonical pattern: vi.fn() mocks for chrome.\* APIs, JSON.parse(res.content[0].text) helper, beforeEach/afterEach setup.

Step 10. Run "cd packages/shared && npm run build" to regenerate dist/ with the new TOOL_NAMES so the extension typechecks.

Step 11. Run "cd ../../app/chrome-extension && npx tsc --noEmit -p ." — must pass with zero errors. Fix any errors before continuing.

Step 12. Run "npx vitest run --reporter=dot" — all tests must pass (the existing 932 plus your new 8-15 cases).

Step 13. Run "cd ../native-server && npm test" — bridge tests must pass (77).

Step 14. Edit docs/improvement-backlog.md: move the IMP-NNNN entry from the ## Active section to the ## Done section with a one-paragraph summary covering: what shipped, the action surface, error classification, test count, full extension test count after the addition, and any manifest delta. Use the IMP-0064 through IMP-0073 done summaries as the format template.

Step 15. cd /Users/mike/Documents/Code/humanchrome. Run "git add -A && git commit" with a message like "feat(extension): <one-line summary> (IMP-NNNN)" and the standard "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>" footer. Use a heredoc for multi-line commit bodies to avoid escaping.

Step 16. Run "git push -u origin feat/imp-NNNN-SLUG".

Step 17. Run "gh pr create" with a Summary plus Test plan body matching the format used for PRs #98 and #99 in this repo.

Step 18. Wait for CI: "gh run watch $(gh run list --branch feat/imp-NNNN-SLUG --limit 1 --json databaseId -q '.[0].databaseId') --exit-status".

Step 19. Run "gh pr merge PR_NUMBER --squash --delete-branch".

Step 20. Run "git checkout main && git pull --ff-only origin main" to verify the merge landed.

Step 21. End iteration. The next iteration starts at step 1 against freshly-merged main.

CONFLICT-AVOIDANCE RULES (non-negotiable):

Always pull main first, every iteration, no exceptions. All edits to packages/shared/src/tools.ts, the barrel, and the dispatcher are append-only — never reorder existing entries, never edit existing tool descriptors. One IMP per PR, no multi-feature batches. New tools live in their own .ts file; never modify other tools' files unless the Fix sketch explicitly calls for it.

STOP CONDITIONS:

If IMP-0074 through IMP-0084 are all marked done or blocked, output RALPH_QUEUE_DONE and exit. If two consecutive iterations fail CI for the same root cause (signal something is structurally broken upstream), output RALPH_QUEUE_DONE with a brief note explaining why and exit.

SAFETY NET:

If an iteration cannot pass typecheck, vitest, bridge tests, or CI after one retry with a clean rebase against main, abort the iteration without opening a PR. Run "git checkout main && git branch -D feat/imp-NNNN-SLUG" to clean up. Then edit docs/improvement-backlog.md to append a "- **Status**: blocked" line and a "- **Notes**: <one-line reason>" line to that IMP entry, commit and push the doc change directly to main as a small chore commit, and move on to the next iteration. Do not loop forever on a broken iteration.

The eleven entries in IMP-0074 through IMP-0084 cover: chrome_focus, chrome_paste, chrome_select_text, chrome_window, chrome_web_vitals, chrome_idle, chrome_alarms, chrome_clear_browsing_data, chrome_proxy, chrome_identity, chrome_drag_drop. Each entry's Fix sketch in docs/improvement-backlog.md has the full implementation spec. Do not second-guess the spec — ship it as written.
