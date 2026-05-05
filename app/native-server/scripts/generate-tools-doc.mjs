#!/usr/bin/env node
/**
 * Auto-generate the per-tool reference section of `docs/TOOLS.md` from the
 * shared `TOOL_SCHEMAS` + `TOOL_CATEGORIES` maps.
 *
 * Why this exists
 * ---------------
 * `docs/TOOLS.md` used to hand-duplicate every tool description and parameter
 * table from `packages/shared/src/tools.ts`. That drifts every time someone
 * tweaks a schema. This generator reads schemas from the BUILT shared package
 * (so Node can `import` it without a TS loader) and rewrites only the content
 * between two HTML-comment markers, leaving the surrounding intro/trailer
 * prose untouched.
 *
 * Markers (must already exist in docs/TOOLS.md):
 *   <!-- AUTO-GEN BELOW -->
 *   …generated content…
 *   <!-- AUTO-GEN END -->
 *
 * Run via: `pnpm --filter humanchrome-bridge run docs:tools`
 *
 * IMPORTANT: requires `pnpm -w build` to have run first so the shared package
 * has a `dist/`. Node cannot load TypeScript directly here; we deliberately
 * avoid pulling in tsx/ts-node to keep this script's dep surface zero.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const TOOLS_DOC = path.join(REPO_ROOT, 'docs', 'TOOLS.md');

const START_MARKER = '<!-- AUTO-GEN BELOW -->';
const END_MARKER = '<!-- AUTO-GEN END -->';

async function loadShared() {
  // Importing the workspace package by name resolves through pnpm to the built
  // dist/. If the user hasn't built yet, this throws ERR_MODULE_NOT_FOUND with
  // a clear-enough message; we catch it below and translate.
  try {
    return await import('humanchrome-shared');
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    throw new Error(
      `Failed to load humanchrome-shared. Did you run \`pnpm -w build\` first?\n  underlying: ${msg}`,
    );
  }
}

/**
 * Render a single JSON-Schema property type into a short, doc-friendly string.
 * Handles enums, arrays, oneOf/anyOf, unions (type: ['string','number']), and
 * fall back to the bare `type` field. We keep this intentionally small — the
 * goal is "readable", not "lossless".
 */
function renderType(prop) {
  if (!prop || typeof prop !== 'object') return '';
  if (Array.isArray(prop.enum) && prop.enum.length > 0) {
    return prop.enum.map((v) => `\`${v}\``).join(' | ');
  }
  if (Array.isArray(prop.oneOf)) {
    const inner = prop.oneOf.map((s) => renderType(s)).filter(Boolean);
    return inner.length ? inner.join(' | ') : 'oneOf';
  }
  if (Array.isArray(prop.anyOf)) {
    const inner = prop.anyOf.map((s) => renderType(s)).filter(Boolean);
    return inner.length ? inner.join(' | ') : 'anyOf';
  }
  if (Array.isArray(prop.type)) {
    return prop.type.join(' | ');
  }
  if (prop.type === 'array') {
    const items = prop.items;
    if (items && typeof items === 'object') {
      const inner = renderType(items);
      if (inner) return `array<${inner}>`;
    }
    return 'array';
  }
  if (prop.type === 'object') return 'object';
  return prop.type || '';
}

/**
 * Collapse newlines + repeated whitespace inside descriptions so they fit
 * inside a markdown table cell without blowing up the row. Preserves bullet
 * markers introduced by hyphens.
 */
function singleLine(text) {
  if (!text) return '';
  return String(text).replace(/\s+/g, ' ').trim();
}

/**
 * Escape pipes so they don't break markdown tables.
 */
function escapeCell(text) {
  return String(text || '').replace(/\|/g, '\\|');
}

/**
 * Render one tool block:
 *   ### `tool_name`
 *   <description verbatim — multi-line preserved>
 *   <param table OR "No parameters.">
 */
function renderTool(tool) {
  const lines = [];
  lines.push(`### \`${tool.name}\``);
  lines.push('');
  if (tool.description) {
    // Description verbatim. Preserve internal newlines so multi-paragraph
    // tool docs (e.g. chrome_javascript) stay readable.
    lines.push(String(tool.description).trim());
    lines.push('');
  }
  const schema = tool.inputSchema || {};
  const props = schema.properties || {};
  const requiredList = Array.isArray(schema.required) ? schema.required : [];
  const propNames = Object.keys(props);
  if (propNames.length === 0) {
    lines.push('No parameters.');
    lines.push('');
    return lines.join('\n');
  }
  lines.push('| Param | Type | Required | Description |');
  lines.push('|-------|------|----------|-------------|');
  for (const name of propNames) {
    const prop = props[name] || {};
    const type = renderType(prop);
    const required = requiredList.includes(name) ? '✓' : '';
    const desc = singleLine(prop.description);
    lines.push(
      `| \`${escapeCell(name)}\` | ${escapeCell(type)} | ${required} | ${escapeCell(desc)} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

function buildSection(toolsByCategory, categoryOrder) {
  const lines = [];
  for (const category of categoryOrder) {
    const tools = toolsByCategory.get(category);
    if (!tools || tools.length === 0) continue;
    lines.push(`## ${category}`);
    lines.push('');
    for (const tool of tools) {
      lines.push(renderTool(tool));
    }
  }
  // Strip trailing blank lines so the END marker sits flush.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

function groupTools(toolSchemas, toolCategories, categoryOrder) {
  // Validate coverage first — every schema must have a category.
  const uncategorized = toolSchemas
    .map((t) => t.name)
    .filter((name) => !Object.prototype.hasOwnProperty.call(toolCategories, name));
  if (uncategorized.length > 0) {
    for (const name of uncategorized) {
      console.error(`[generate-tools-doc] missing category for tool: ${name}`);
    }
    console.error(
      `[generate-tools-doc] add the missing tool name(s) to TOOL_CATEGORIES in packages/shared/src/tools.ts`,
    );
    process.exit(1);
  }

  // Group, preserving TOOL_SCHEMAS iteration order within each category.
  const byCategory = new Map();
  for (const cat of categoryOrder) byCategory.set(cat, []);
  for (const tool of toolSchemas) {
    const cat = toolCategories[tool.name];
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(tool);
  }

  // Surface any category present in TOOL_CATEGORIES but missing from the
  // explicit order — append them at the end alphabetically so they still
  // ship, but warn (not fatal) so the maintainer can update the order.
  const knownCats = new Set(categoryOrder);
  const extraCats = [];
  for (const cat of byCategory.keys()) {
    if (!knownCats.has(cat)) extraCats.push(cat);
  }
  extraCats.sort();
  if (extraCats.length > 0) {
    console.warn(
      `[generate-tools-doc] categories present in map but not in TOOL_CATEGORY_ORDER: ${extraCats.join(', ')}`,
    );
  }
  const fullOrder = [...categoryOrder, ...extraCats];
  return { byCategory, fullOrder };
}

async function main() {
  const shared = await loadShared();
  const TOOL_SCHEMAS = shared.TOOL_SCHEMAS;
  const TOOL_CATEGORIES = shared.TOOL_CATEGORIES;
  const TOOL_CATEGORY_ORDER = shared.TOOL_CATEGORY_ORDER || [];
  if (!Array.isArray(TOOL_SCHEMAS) || !TOOL_CATEGORIES) {
    throw new Error(
      'humanchrome-shared did not export TOOL_SCHEMAS / TOOL_CATEGORIES — rebuild the shared package.',
    );
  }

  const { byCategory, fullOrder } = groupTools(TOOL_SCHEMAS, TOOL_CATEGORIES, TOOL_CATEGORY_ORDER);

  const original = await fs.readFile(TOOLS_DOC, 'utf8');
  const startIdx = original.indexOf(START_MARKER);
  const endIdx = original.indexOf(END_MARKER);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    console.error(
      `[generate-tools-doc] ${TOOLS_DOC} is missing the AUTO-GEN markers.\n` +
        `Add them once (intro stays above, trailer stays below):\n\n` +
        `  ${START_MARKER}\n  ${END_MARKER}\n\n` +
        `Then rerun this script.`,
    );
    process.exit(1);
  }

  const before = original.slice(0, startIdx + START_MARKER.length);
  const after = original.slice(endIdx);
  const generated = buildSection(byCategory, fullOrder);
  const next = `${before}\n\n${generated}\n\n${after}`;

  if (next === original) {
    console.log(
      `[generate-tools-doc] no changes — wrote ${TOOL_SCHEMAS.length} tools across ${
        fullOrder.filter((c) => (byCategory.get(c) || []).length > 0).length
      } categories (idempotent)`,
    );
    return;
  }

  await fs.writeFile(TOOLS_DOC, next, 'utf8');
  const usedCats = fullOrder.filter((c) => (byCategory.get(c) || []).length > 0).length;
  console.log(
    `[generate-tools-doc] wrote ${TOOL_SCHEMAS.length} tools across ${usedCats} categories → ${path.relative(
      REPO_ROOT,
      TOOLS_DOC,
    )}`,
  );
}

main().catch((err) => {
  console.error(`[generate-tools-doc] ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
