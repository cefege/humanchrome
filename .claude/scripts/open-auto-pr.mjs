#!/usr/bin/env node
/**
 * Open an auto-merge PR for an /improve-auto iteration. Wraps `gh pr create`
 * and `gh pr merge --auto --squash` so the parent orchestrator has one
 * structured call to make.
 *
 * Usage:
 *   node .claude/scripts/open-auto-pr.mjs \
 *     --imp IMP-NNNN \
 *     --branch auto/imp-NNNN-slug \
 *     --title "fix(scope): subject (IMP-NNNN)" \
 *     --report-file /path/to/implementer-report.md \
 *     [--no-automerge]
 *
 * The report file should be the implementer agent's full structured report
 * (files changed, build/test status, simplify-pass output, verification
 * results). It gets embedded into the PR body via the template at
 * .claude/templates/auto-pr-body.md.
 *
 * Output (stdout):
 *   pr=<number> url=<https://github.com/...> automerge=<on|off>
 *
 * Exit code: 0 on success, 1 on any failure (gh, fs, template render).
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = resolve(import.meta.dirname || new URL('.', import.meta.url).pathname, '..', '..');
const TEMPLATE_PATH = resolve(REPO_ROOT, '.claude', 'templates', 'auto-pr-body.md');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || i === process.argv.length - 1) return undefined;
  return process.argv[i + 1];
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}

const imp = arg('imp');
const branch = arg('branch');
const title = arg('title');
const reportFile = arg('report-file');
const noAutomerge = flag('no-automerge');

if (!imp || !branch || !title || !reportFile) {
  process.stderr.write('usage: open-auto-pr.mjs --imp IMP-NNNN --branch <name> --title <text> --report-file <path>\n');
  process.exit(1);
}

function sh(cmd, opts = {}) {
  const r = spawnSync('sh', ['-c', cmd], { encoding: 'utf8', ...opts });
  return { code: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

let template;
try {
  template = await readFile(TEMPLATE_PATH, 'utf8');
} catch (err) {
  process.stderr.write(`failed to read template at ${TEMPLATE_PATH}: ${err.message}\n`);
  process.exit(1);
}

let report;
try {
  report = await readFile(reportFile, 'utf8');
} catch (err) {
  process.stderr.write(`failed to read report at ${reportFile}: ${err.message}\n`);
  process.exit(1);
}

const now = new Date();
const body = template
  .replaceAll('{{IMP}}', imp)
  .replaceAll('{{TITLE}}', title)
  .replaceAll('{{REPORT}}', report)
  .replaceAll('{{TIMESTAMP}}', now.toISOString());

const bodyPath = resolve(tmpdir(), `auto-pr-body-${imp}-${Date.now()}.md`);
await mkdir(dirname(bodyPath), { recursive: true });
await writeFile(bodyPath, body, 'utf8');

const createCmd = `gh pr create --base main --head '${branch}' --title ${JSON.stringify(title)} --body-file '${bodyPath}' --label automated`;
const createRes = sh(createCmd, { cwd: REPO_ROOT });
if (createRes.code !== 0) {
  process.stderr.write(`gh pr create failed: ${createRes.stderr || createRes.stdout}\n`);
  process.exit(1);
}
const url = createRes.stdout.trim().split('\n').pop();
const num = url.match(/\/pull\/(\d+)/)?.[1];
if (!num) {
  process.stderr.write(`could not parse PR number from gh output: ${url}\n`);
  process.exit(1);
}

let automerge = 'off';
if (!noAutomerge) {
  const mergeRes = sh(`gh pr merge ${num} --auto --squash`, { cwd: REPO_ROOT });
  if (mergeRes.code === 0) {
    automerge = 'on';
  } else {
    // Don't fail the whole call -- the PR is open. Parent can still mark
    // the IMP done; auto-merge enablement is a soft requirement.
    process.stderr.write(`gh pr merge --auto failed (PR ${num} still open): ${mergeRes.stderr || mergeRes.stdout}\n`);
  }
}

process.stdout.write(`pr=${num} url=${url} automerge=${automerge}\n`);
process.exit(0);
