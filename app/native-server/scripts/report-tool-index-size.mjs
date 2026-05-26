#!/usr/bin/env node
/**
 * Token-budget audit for the 1-tool MCP surface (project_one_tool_mcp_surface).
 *
 * Compares the current MCP manifest (every entry in `TOOL_SCHEMAS` advertised
 * as its own first-class tool) against the projected single-dispatcher design
 * where one `humanchrome(name, args)` tool carries the full catalog as a
 * compact index inside its `description` field.
 *
 * Reports:
 *   - per-tool current cost (top N)
 *   - current manifest total (chars + estimated tokens)
 *   - projected 1-tool description total (chars + estimated tokens)
 *   - savings ratio
 *
 * Token estimate: chars/4 — Claude's BPE averages ~4 chars/token on English
 * JSON-ish text; close enough for an architecture-go/no-go decision. Real
 * tokenizer wiring is future work if we want sub-percent precision.
 *
 * Run via: `node app/native-server/scripts/report-tool-index-size.mjs`
 * Requires: `pnpm -w build` (loads the built humanchrome-shared dist).
 */
import { TOOL_SCHEMAS } from 'humanchrome-shared';

const CHARS_PER_TOKEN = 4;

function estTokens(s) {
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}

function fmt(n) {
  return n.toLocaleString('en-US');
}

function pad(s, width, align = 'left') {
  s = String(s);
  if (s.length >= width) return s;
  const padding = ' '.repeat(width - s.length);
  return align === 'right' ? padding + s : s + padding;
}

function firstSentence(desc) {
  if (!desc) return '';
  const m = desc.match(/^(.+?[.!?])(\s|$)/);
  return (m ? m[1] : desc).replace(/\s+/g, ' ').trim();
}

function serializeAsMcpTool(tool) {
  return JSON.stringify({
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema ?? {},
  });
}

function buildOneToolDescription(tools) {
  const header = [
    'humanchrome dispatches any browser-automation tool by name. Args are validated server-side; on INVALID_ARGS the error response includes the expected schema. Catalog:',
    '',
  ].join('\n');
  const lines = tools.map((t) => `- ${t.name}: ${firstSentence(t.description)}`);
  return header + lines.join('\n');
}

function dispatcherInputSchema() {
  return {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Tool name from the catalog above.' },
      args: { type: 'object', description: 'Tool-specific arguments object.' },
    },
    required: ['name'],
  };
}

function projectedOneToolManifestEntry(tools) {
  return JSON.stringify({
    name: 'humanchrome',
    description: buildOneToolDescription(tools),
    inputSchema: dispatcherInputSchema(),
  });
}

function main() {
  const tools = TOOL_SCHEMAS.slice().sort((a, b) => a.name.localeCompare(b.name));

  const perTool = tools.map((t) => {
    const json = serializeAsMcpTool(t);
    return {
      name: t.name,
      chars: json.length,
      tokens: estTokens(json),
      descChars: (t.description ?? '').length,
      schemaChars: JSON.stringify(t.inputSchema ?? {}).length,
    };
  });

  const currentTotalChars = perTool.reduce((a, p) => a + p.chars, 0);
  const currentTotalTokens = perTool.reduce((a, p) => a + p.tokens, 0);

  const projectedJson = projectedOneToolManifestEntry(tools);
  const projectedChars = projectedJson.length;
  const projectedTokens = estTokens(projectedJson);

  const ratio = currentTotalTokens / projectedTokens;
  const savingsTokens = currentTotalTokens - projectedTokens;
  const savingsPct = (savingsTokens / currentTotalTokens) * 100;

  console.log('='.repeat(78));
  console.log('Tool-index size audit — current MCP manifest vs. 1-tool dispatcher');
  console.log('='.repeat(78));
  console.log(`Tool count                  : ${fmt(tools.length)}`);
  console.log(`Token estimate              : chars / ${CHARS_PER_TOKEN}`);
  console.log('');

  console.log('CURRENT (one MCP tool per TOOL_SCHEMAS entry):');
  console.log(`  total chars               : ${fmt(currentTotalChars)}`);
  console.log(`  total tokens (est)        : ${fmt(currentTotalTokens)}`);
  console.log(
    `  avg tokens / tool         : ${fmt(Math.round(currentTotalTokens / tools.length))}`,
  );
  console.log('');

  console.log('PROJECTED (single `humanchrome(name, args)` dispatcher):');
  console.log(`  description chars         : ${fmt(projectedChars)}`);
  console.log(`  description tokens (est)  : ${fmt(projectedTokens)}`);
  console.log('');

  console.log('SAVINGS:');
  console.log(`  reduction factor          : ${ratio.toFixed(2)}×`);
  console.log(`  tokens saved              : ${fmt(savingsTokens)}  (${savingsPct.toFixed(1)}%)`);
  console.log('');

  const topN = 15;
  const heaviest = perTool.slice().sort((a, b) => b.tokens - a.tokens).slice(0, topN);
  console.log(`TOP ${topN} HEAVIEST TOOLS (by current token cost):`);
  console.log(
    `  ${pad('name', 42)} ${pad('tokens', 8, 'right')} ${pad('desc-tk', 8, 'right')} ${pad('schema-tk', 10, 'right')}`,
  );
  console.log(`  ${'-'.repeat(42)} ${'-'.repeat(8)} ${'-'.repeat(8)} ${'-'.repeat(10)}`);
  for (const p of heaviest) {
    console.log(
      `  ${pad(p.name, 42)} ${pad(fmt(p.tokens), 8, 'right')} ${pad(fmt(estTokens('x'.repeat(p.descChars))), 8, 'right')} ${pad(fmt(estTokens('x'.repeat(p.schemaChars))), 10, 'right')}`,
    );
  }
  console.log('');

  const verdict =
    ratio >= 5
      ? 'VERDICT: ship the 1-tool dispatcher — projected win matches the architectural bet.'
      : ratio >= 2
        ? 'VERDICT: meaningful but smaller than the 10× bet — re-examine the description format before committing.'
        : 'VERDICT: win is marginal — the architectural bet does NOT pay off; reconsider.';
  console.log(verdict);
}

main();
