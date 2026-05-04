/**
 * Structured logger for the live-test run.
 *
 * Every assertion writes one JSONL line. Failures are also written to a
 * per-failure markdown file optimized for pasting into an LLM ("here's the
 * args, expected, got, debug-dump — diagnose"). At the end of the run we
 * emit a short markdown summary.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(HERE, 'results');
const JSONL_PATH = path.join(RESULTS_DIR, 'live-test-results.jsonl');
const FAILURES_DIR = path.join(RESULTS_DIR, 'failures');
const SUMMARY_PATH = path.join(RESULTS_DIR, 'live-test-summary.md');

export async function initRunDir() {
  await fs.mkdir(RESULTS_DIR, { recursive: true });
  await fs.mkdir(FAILURES_DIR, { recursive: true });
  // Truncate the JSONL each run so consumers don't paginate stale rows.
  await fs.writeFile(JSONL_PATH, '');
  // Wipe per-failure markdown so a clean run doesn't leave yesterday's
  // failures lying around for an LLM to misread as current.
  for (const f of await fs.readdir(FAILURES_DIR)) {
    if (f.endsWith('.md')) await fs.unlink(path.join(FAILURES_DIR, f));
  }
}

function safeFilename(s) {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

/**
 * Write one assertion result as a JSONL line. Failures additionally get a
 * markdown file with the same content formatted for an LLM to read cold.
 */
export async function recordResult(record) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record });
  await fs.appendFile(JSONL_PATH, line + '\n');
  if (record.status === 'fail') {
    const file = path.join(FAILURES_DIR, safeFilename(record.name) + '.md');
    await fs.writeFile(file, formatFailureMd(record));
  }
}

function formatFailureMd(rec) {
  const fenced = (val) =>
    '```json\n' + JSON.stringify(val ?? null, null, 2) + '\n```';
  return [
    `# ${rec.name}`,
    '',
    `**Status:** ${rec.status}`,
    rec.tool ? `**Tool:** ${rec.tool}` : '',
    rec.client ? `**Client:** ${rec.client}` : '',
    rec.requestId ? `**RequestId:** ${rec.requestId}` : '',
    rec.note ? `**Note:** ${rec.note}` : '',
    '',
    '## Args sent',
    fenced(rec.args),
    '',
    '## Expected',
    fenced(rec.expected),
    '',
    '## Got',
    fenced(rec.got),
    '',
    '## Debug-dump (extension-side trail for this requestId)',
    fenced(rec.debugDump ?? []),
    '',
    '## Diagnosis prompt',
    '> Above are the args sent, the response received, the contract expected, and the extension-side debug log entries for this call. Identify the root cause and suggest a one-line fix.',
    '',
  ]
    .filter(Boolean)
    .join('\n');
}

export async function writeSummary({ passed, failed, skipped, byTest }) {
  const lines = [
    '# Live-test summary',
    '',
    `- **Passed:** ${passed}`,
    `- **Failed:** ${failed}`,
    `- **Skipped:** ${skipped}`,
    `- **Generated:** ${new Date().toISOString()}`,
    '',
  ];
  if (failed > 0) {
    lines.push('## First failures');
    lines.push('');
    let n = 0;
    for (const rec of byTest) {
      if (rec.status !== 'fail') continue;
      n += 1;
      if (n > 5) break;
      lines.push(`### ${rec.name}`);
      lines.push('');
      lines.push(`Expected: \`${JSON.stringify(rec.expected)}\``);
      lines.push(`Got: \`${JSON.stringify(rec.got).slice(0, 500)}\``);
      if (rec.note) lines.push(`Note: ${rec.note}`);
      lines.push('');
      lines.push(
        `Full failure details: \`live-test/results/failures/${safeFilename(rec.name)}.md\``,
      );
      lines.push('');
    }
  }
  await fs.writeFile(SUMMARY_PATH, lines.join('\n'));
}

export const PATHS = { RESULTS_DIR, JSONL_PATH, FAILURES_DIR, SUMMARY_PATH };
