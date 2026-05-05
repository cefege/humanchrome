#!/usr/bin/env node
/**
 * Helpers shared by feature-scout / bug-scout / optimization-scout and by
 * the /improve slash command. No deps; reads/writes docs/improvement-backlog.md.
 *
 * Format spec lives at the top of the backlog file itself. The parser here is
 * intentionally lenient: it round-trips field-level edits without clobbering
 * free text, and falls back to "skip this entry" rather than throwing on
 * malformed items so a hand-edit doesn't break the whole pipeline.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '..', '..');
export const BACKLOG_PATH = resolve(REPO_ROOT, 'docs', 'improvement-backlog.md');

const ID_RE = /^IMP-(\d{4,})$/;
const HEADER_RE = /^### (IMP-\d{4,})\s*·\s*(.+?)\s*\((feat|bug|perf|refactor|docs)\)\s*·\s*score:\s*(-?\d+)\s*$/;

/**
 * @typedef {object} BacklogItem
 * @property {string} id
 * @property {string} title
 * @property {'feat'|'bug'|'perf'|'refactor'|'docs'} kind
 * @property {number} score
 * @property {'proposed'|'queued'|'in-progress'|'done'|'wontdo'} status
 * @property {string} proposedBy   // e.g. "feature-scout · 2026-05-05"
 * @property {string} why
 * @property {'S'|'M'|'L'|string} cost
 * @property {'S'|'M'|'L'|string} value
 * @property {string} notes        // notes / repro / fix sketch / worktree, raw markdown
 * @property {boolean} done        // bucket: in ## Active vs ## Done
 * @property {string} raw          // exact original text of this entry — used to round-trip unchanged content
 */

/**
 * Parse the backlog into structured items + the surrounding markdown chrome
 * (header, format spec, section dividers). Items keep their `raw` text so the
 * writer can re-emit any item that wasn't modified verbatim — no whitespace
 * drift, no comment-clobbering.
 */
export async function loadBacklog() {
  const text = await readFile(BACKLOG_PATH, 'utf8');

  // Split into pre-active header, active section, done section, trailing.
  // Section markers are level-2 headings: "## Active" and "## Done".
  const activeIdx = text.indexOf('\n## Active\n');
  const doneIdx = text.indexOf('\n## Done\n', activeIdx);
  if (activeIdx === -1 || doneIdx === -1) {
    throw new Error(
      `Backlog at ${BACKLOG_PATH} is missing "## Active" or "## Done" sections; aborting to avoid clobbering hand-edited content.`,
    );
  }

  const head = text.slice(0, activeIdx + 1); // include the leading newline of \n## Active
  const activeBlock = text.slice(activeIdx + 1, doneIdx + 1);
  const doneBlock = text.slice(doneIdx + 1);

  const active = parseSection(activeBlock, false);
  const done = parseSection(doneBlock, true);

  return {
    head,                        // everything before "## Active" (kept verbatim on save)
    activeHeader: '## Active\n', // the section heading itself
    doneHeader: '## Done\n',
    active,
    done,
    raw: text,
  };
}

function parseSection(block, isDone) {
  // block starts with "## Active" or "## Done" line
  const lines = block.split('\n');
  // Find each "### IMP-####" header start
  const items = [];
  let i = 0;
  // Skip the section heading line + any leading prose/comments until we hit the first ### or end
  while (i < lines.length) {
    if (lines[i].startsWith('### ')) break;
    i++;
  }
  while (i < lines.length) {
    if (!lines[i].startsWith('### ')) {
      i++;
      continue;
    }
    const start = i;
    i++;
    while (i < lines.length && !lines[i].startsWith('### ') && !lines[i].startsWith('## ')) {
      i++;
    }
    const itemLines = lines.slice(start, i);
    const item = parseItem(itemLines.join('\n'), isDone);
    if (item) items.push(item);
    if (i < lines.length && lines[i].startsWith('## ')) break;
  }
  return items;
}

function parseItem(raw, done) {
  const lines = raw.split('\n');
  const m = lines[0].match(HEADER_RE);
  if (!m) return null;
  const [, id, title, kind, scoreStr] = m;

  // Field extraction is line-based; we only pull the structured fields we
  // care about for triage/dedupe. Everything else is preserved as `notes`
  // so the writer round-trips it unchanged.
  let status = 'queued';
  let proposedBy = '';
  let why = '';
  let cost = '';
  let value = '';
  const notesLines = [];
  for (const line of lines.slice(1)) {
    const fm = line.match(/^- \*\*([^*]+)\*\*:\s*(.*)$/);
    if (!fm) {
      notesLines.push(line);
      continue;
    }
    const [, key, rest] = fm;
    const k = key.trim().toLowerCase();
    if (k === 'status') status = (rest.trim() || 'queued');
    else if (k === 'proposed by') proposedBy = rest.trim();
    else if (k === 'why') why = rest.trim();
    else if (k === 'cost') cost = rest.trim();
    else if (k === 'value') value = rest.trim();
    else notesLines.push(line);
  }
  return {
    id,
    title: title.trim(),
    kind,
    score: parseInt(scoreStr, 10),
    status,
    proposedBy,
    why,
    cost,
    value,
    notes: notesLines.join('\n').replace(/\n+$/, ''),
    done,
    raw: raw.replace(/\n+$/, ''),
  };
}

/**
 * Render the full file back from a parsed structure. Items kept on `raw`
 * round-trip unchanged; items the caller mutated should have their `raw` set
 * to undefined so we re-render from fields.
 */
export function renderBacklog(parsed) {
  const activeBody = parsed.active.map(renderItem).join('\n\n');
  const doneBody = parsed.done.map(renderItem).join('\n\n');
  const sections = [
    parsed.head.replace(/\n+$/, '\n') + '\n',
    parsed.activeHeader,
    activeBody ? '\n' + activeBody + '\n' : '',
    '\n',
    parsed.doneHeader,
    doneBody ? '\n' + doneBody + '\n' : '\n<!-- Items the implementer agent finished move here, with a one-line summary\n     and the date completed. -->\n',
  ];
  return sections.join('').replace(/\n{3,}/g, '\n\n').replace(/\n*$/, '\n');
}

function renderItem(item) {
  if (item.raw && item._dirty !== true) return item.raw;
  const head = `### ${item.id} · ${item.title} (${item.kind}) · score: ${item.score}`;
  const lines = [head];
  if (item.proposedBy) lines.push(`- **Proposed by**: ${item.proposedBy}`);
  lines.push(`- **Status**: ${item.status}`);
  if (item.why) lines.push(`- **Why**: ${item.why}`);
  if (item.cost) lines.push(`- **Cost**: ${item.cost}`);
  if (item.value) lines.push(`- **Value**: ${item.value}`);
  if (item.notes && item.notes.trim()) lines.push(item.notes.trimEnd());
  return lines.join('\n');
}

export async function saveBacklog(parsed) {
  const text = renderBacklog(parsed);
  await writeFile(BACKLOG_PATH, text, 'utf8');
}

/**
 * Allocate the next IMP-NNNN id by reading max existing id across both
 * sections. Pads to 4 digits.
 */
export function allocateNextId(parsed) {
  let max = 0;
  for (const it of [...parsed.active, ...parsed.done]) {
    const m = it.id.match(ID_RE);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `IMP-${String(max + 1).padStart(4, '0')}`;
}

/**
 * Dedupe key: lowercased, alphanumeric-only title. Stops scouts from re-adding
 * the same idea with slight wording variations across runs. If you want to
 * intentionally re-propose, change the title.
 */
export function titleKey(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function findByTitleSimilarity(parsed, title) {
  const key = titleKey(title);
  if (!key) return null;
  for (const it of [...parsed.active, ...parsed.done]) {
    if (titleKey(it.title) === key) return it;
  }
  return null;
}

/**
 * Append a single proposed item to ## Active. Returns the assigned id, or
 * null if a near-duplicate was found and skipped. The triage script will
 * re-score afterward.
 *
 * @param {{
 *   title: string,
 *   kind: BacklogItem['kind'],
 *   why: string,
 *   cost?: string,
 *   value?: string,
 *   notes?: string,
 *   proposedBy: string,   // e.g. "feature-scout"
 * }} draft
 */
export async function appendProposal(draft) {
  if (!draft || !draft.title || !draft.kind || !draft.why || !draft.proposedBy) {
    throw new Error('appendProposal: title, kind, why, proposedBy are required');
  }
  const parsed = await loadBacklog();
  const existing = findByTitleSimilarity(parsed, draft.title);
  if (existing) return null;

  const today = new Date().toISOString().slice(0, 10);
  const id = allocateNextId(parsed);
  const item = {
    id,
    title: draft.title.trim(),
    kind: draft.kind,
    score: 0, // triage will fill in
    status: 'proposed',
    proposedBy: `${draft.proposedBy} · ${today}`,
    why: draft.why.trim(),
    cost: draft.cost?.trim() || 'M',
    value: draft.value?.trim() || 'M',
    notes: (draft.notes || '').trim(),
    done: false,
    raw: undefined,
    _dirty: true,
  };
  parsed.active.push(item);
  await saveBacklog(parsed);
  return id;
}
