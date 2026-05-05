#!/usr/bin/env node
/**
 * Re-score and re-sort docs/improvement-backlog.md.
 *
 * Idempotent: stable sort + deterministic scoring → second run produces zero
 * diff. The script preserves any free-text edits the user made (notes / repro /
 * fix sketch / worktree) by round-tripping each item's raw text when only the
 * score field changed.
 *
 * Run from the repo root:
 *   node .claude/scripts/triage-backlog.mjs
 *
 * Exit codes:
 *   0  — success (file may or may not have changed)
 *   1  — backlog file is malformed / missing required sections
 */
import { loadBacklog, saveBacklog } from './scout-shared.mjs';

const VALUE_WEIGHT = { S: 2, M: 4, L: 6 };
const COST_WEIGHT = { S: 0, M: 1, L: 2 };

function score(item) {
  // Be lenient on value/cost spellings: "M (multi-window)" → just take the first letter.
  const v = (item.value || '').trim().toUpperCase().charAt(0);
  const c = (item.cost || '').trim().toUpperCase().charAt(0);
  let s = (VALUE_WEIGHT[v] ?? 0) - (COST_WEIGHT[c] ?? 0);
  if (item.kind === 'bug') s += 2;
  // Regression bonus: heuristic — title says "regression" or notes mention it
  if (/regression/i.test(item.title) || /regression/i.test(item.notes || '')) s += 1;
  // Staleness penalty: proposed >14 days ago and still queued
  const m = (item.proposedBy || '').match(/(\d{4}-\d{2}-\d{2})/);
  if (m && item.status === 'queued') {
    const proposedAt = new Date(m[1]).getTime();
    const ageDays = (Date.now() - proposedAt) / (24 * 3600 * 1000);
    if (ageDays > 14) s -= 1;
  }
  return Math.max(0, Math.round(s));
}

function main() {
  return loadBacklog().then((parsed) => {
    let dirty = false;

    for (const item of parsed.active) {
      const newScore = score(item);
      if (newScore !== item.score) {
        item.score = newScore;
        // Re-render this item: its raw text contained the old score in the
        // header line, so we can't round-trip it verbatim.
        item._dirty = true;
        dirty = true;
      }
    }

    // Sort active by score desc, then by id ascending (stable identity).
    const before = parsed.active.map((i) => i.id).join(',');
    parsed.active.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.id.localeCompare(b.id);
    });
    const after = parsed.active.map((i) => i.id).join(',');
    if (before !== after) dirty = true;

    // Always save once on first run so the score column reflects scoring.
    // Subsequent runs with no changes are no-ops at the FS level (writeFile
    // with identical content, but git diff stays clean).
    return saveBacklog(parsed).then(() => {
      const summary = parsed.active
        .slice(0, 5)
        .map((i) => `${i.id} (${i.score}) ${i.title}`)
        .join('\n  ');
      process.stdout.write(
        `triage: ${parsed.active.length} active, ${parsed.done.length} done${dirty ? ' (re-sorted)' : ''}\nTop:\n  ${summary}\n`,
      );
    });
  });
}

main().catch((err) => {
  process.stderr.write(`triage failed: ${err.message}\n`);
  process.exit(1);
});
