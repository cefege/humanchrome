#!/usr/bin/env node
/**
 * IMP-0180 audit — per-tool description token counts.
 *
 * Lists every TOOL_SCHEMAS entry sorted by description size; flags tools
 * that exceed the 80-token skeleton target. Used to scope the mechanical
 * rewrite — tools already at-or-under budget are skipped.
 */
import { TOOL_SCHEMAS } from 'humanchrome-shared';

const TOKEN_TARGET = 80;
const CHARS_PER_TOKEN = 4;
const estTokens = (s) => Math.ceil((s ?? '').length / CHARS_PER_TOKEN);

const rows = TOOL_SCHEMAS.map((t) => ({
  name: t.name,
  descChars: (t.description ?? '').length,
  descTokens: estTokens(t.description ?? ''),
  hasExample: /Example:/i.test(t.description ?? ''),
  hasMarkdownHeader: /^#{1,6}\s/m.test(t.description ?? ''),
})).sort((a, b) => b.descTokens - a.descTokens);

const overBudget = rows.filter((r) => r.descTokens > TOKEN_TARGET);
const underBudget = rows.filter((r) => r.descTokens <= TOKEN_TARGET);
const missingExample = rows.filter((r) => !r.hasExample);
const hasMarkdown = rows.filter((r) => r.hasMarkdownHeader);

console.log(`Tools                : ${TOOL_SCHEMAS.length}`);
console.log(`Skeleton target       : ≤${TOKEN_TARGET} tokens, contains "Example:", no markdown headers`);
console.log(`Over budget (> ${TOKEN_TARGET}) : ${overBudget.length}`);
console.log(`Under budget         : ${underBudget.length}`);
console.log(`Missing Example:      : ${missingExample.length}`);
console.log(`Has markdown headers  : ${hasMarkdown.length}`);
console.log('');
console.log('Over-budget tools (must rewrite):');
console.log(`  ${'name'.padEnd(40)} ${'desc-tk'.padStart(8)} ${'example'.padStart(8)} ${'md-header'.padStart(10)}`);
console.log(`  ${'-'.repeat(40)} ${'-'.repeat(8)} ${'-'.repeat(8)} ${'-'.repeat(10)}`);
for (const r of overBudget) {
  console.log(
    `  ${r.name.padEnd(40)} ${String(r.descTokens).padStart(8)} ${String(r.hasExample).padStart(8)} ${String(r.hasMarkdownHeader).padStart(10)}`,
  );
}
console.log('');
console.log('At-budget tools missing Example: (must add):');
const underNoExample = underBudget.filter((r) => !r.hasExample);
console.log(`  ${underNoExample.length} tools to backfill`);

if (process.argv.includes('--print-names')) {
  console.log('');
  console.log('Tool names that need rewriting (over-budget OR missing example OR markdown header):');
  const needRewrite = new Set([
    ...overBudget.map((r) => r.name),
    ...missingExample.map((r) => r.name),
    ...hasMarkdown.map((r) => r.name),
  ]);
  for (const n of Array.from(needRewrite).sort()) console.log(`  ${n}`);
  console.log('');
  console.log(`Total tools to rewrite: ${needRewrite.size}`);
}
