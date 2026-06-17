/**
 * Single-tool MCP dispatcher index (IMP-0177).
 *
 * Builds a compact `{name → first-sentence-of-description}` catalog from
 * `TOOL_SCHEMAS` and exposes it as a single MCP tool's description. The LLM
 * reads the catalog from the tool description and dispatches by name. The
 * bridge validates the name against the catalog and forwards `args` to the
 * existing per-tool handler — no Zod layer here; each tool's own
 * `INVALID_ARGS` envelope (IMP-0178) tells the model what was wrong with
 * its args.
 *
 * Stability invariant (IMP-0181, follow-up): the description is byte-stable
 * across server starts so Anthropic's prompt cache (5-min TTL) survives.
 * Tools are sorted by name; no timestamps, env vars, or hostnames in the
 * generated text.
 *
 * Boot-manifest impact: ~96 tool schemas (~39 KB serialized) → one
 * dispatcher tool with a ~10 KB description blob. Audit via
 * `app/native-server/scripts/report-tool-index-size.mjs`.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_SCHEMAS } from './tools';
import { didYouMean } from './invalid-args';

export const DISPATCHER_TOOL_NAME = 'humanchrome';

/**
 * Trim a tool description to its verb-phrase (first sentence). Used by
 * `chrome_help` to return picking signal on demand without bloating the
 * cache-stable dispatcher description (BUG-003).
 */
function firstSentence(desc: string): string {
  if (!desc) return '';
  const m = desc.match(/^(.+?[.!?])(\s|$)/);
  return (m ? m[1] : desc).replace(/\s+/g, ' ').trim();
}

/** Deterministic byte-stable index sort — tools by name, ascending. */
function sortedTools(tools: readonly Tool[]): Tool[] {
  return [...tools].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Build the dispatcher tool's `description` field. Names-only catalog
 * (BUG-003 fix): MCP clients (notably Claude Code's tool-list renderer)
 * truncate tool descriptions around ~2 KB, which previously hid ~80% of
 * the catalog when each entry carried its first-sentence verb-phrase.
 *
 * The verb-phrase is still discoverable per-call via the `chrome_help`
 * meta-tool, which returns `{name → firstSentence}` for one or all tools
 * as a regular tool result (not bounded by description rendering).
 *
 * The default-args path is memoized so `tools/list` doesn't rebuild the
 * catalog on every call — this also makes the IMP-0181 byte-stability
 * invariant structural rather than incidental.
 */
let cachedDefaultDescription: string | undefined;
export function buildDispatcherDescription(tools: readonly Tool[] = TOOL_SCHEMAS): string {
  if (tools === TOOL_SCHEMAS && cachedDefaultDescription !== undefined) {
    return cachedDefaultDescription;
  }
  const sorted = sortedTools(tools);
  const header = [
    'Dispatches any humanchrome browser-automation tool by name. Args validated server-side; on INVALID_ARGS the response carries `details.expected` (schema fragment) and `details.hint` (did-you-mean) so you can self-correct.',
    'Call as `{ name: "<tool>", args: { ... }, raw?: boolean }`. Set `raw: true` to bypass the output-size cap. Use `chrome_help({query})` to search the catalog, `chrome_help({})` for the full index, or `chrome_help({name})` for one tool.',
    'Errors: isError=true + JSON body `{"error":{"code":"...","message":"...","details":{...}}}`. Recovery by code: TAB_CLOSED→chrome_navigate to open a new tab; TAB_NOT_FOUND→chrome_get_windows_and_tabs then pass explicit tabId; TARGET_NAVIGATED_AWAY→chrome_read_page then retry with fresh refs; INJECTION_FAILED→fall back to chrome_javascript (CDP path bypasses CSP); CDP_BUSY→retry after 2s or fall back to chrome_inject_script for DOM ops;NOT_ACTIONABLE→check details.failures, scroll/dismiss overlay or pass force:true; TIMEOUT→retry with a larger timeoutMs arg; UNKNOWN→chrome_debug_dump to triage.',
    `Catalog (${sorted.length} tools):`,
    '',
  ].join('\n');
  const lines = sorted.map((t) => `- ${t.name}`);
  const out = header + lines.join('\n');
  if (tools === TOOL_SCHEMAS) cachedDefaultDescription = out;
  return out;
}

/**
 * Tokenize a string into lowercase word-ish parts. Splits on non-alphanumerics
 * AND camelCase boundaries so `chrome_click_element` and `clickElement` both
 * yield `[chrome, click, element]`.
 */
function tokenize(s: string): string[] {
  if (!s) return [];
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Cheap iterative Damerau-Levenshtein-ish edit distance (small strings only). */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (!al) return bl;
  if (!bl) return al;
  const v0 = new Array<number>(bl + 1);
  const v1 = new Array<number>(bl + 1);
  for (let i = 0; i <= bl; i++) v0[i] = i;
  for (let i = 0; i < al; i++) {
    v1[0] = i + 1;
    for (let j = 0; j < bl; j++) {
      const cost = a.charCodeAt(i) === b.charCodeAt(j) ? 0 : 1;
      v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
    }
    for (let j = 0; j <= bl; j++) v0[j] = v1[j];
  }
  return v0[bl];
}

/**
 * Rank tools against a free-text query using token overlap + substring hits +
 * name proximity. Pure heuristic — no embeddings — but the scoring weights
 * make name matches dominate description matches so `query:"click"` surfaces
 * `chrome_click_element` first and synonyms (e.g. tools whose description
 * mentions "click") show up further down.
 *
 * Returns matches sorted by descending score. Caller applies the limit.
 */
export interface ToolSearchHit {
  name: string;
  summary: string;
  score: number;
}

export function searchTools(query: string, tools: readonly Tool[] = TOOL_SCHEMAS): ToolSearchHit[] {
  if (typeof query !== 'string' || !query.trim()) return [];
  // Drop noise tokens (length < 3) so a query like "no such thing" doesn't
  // score every description that happens to contain "no" or "to" or "is".
  const qTokens = tokenize(query).filter((t) => t.length >= 3);
  if (qTokens.length === 0) return [];
  const qLower = query.toLowerCase();
  // Anything that scores only via description hits (3 per token) without any
  // name-side anchor is discarded — that's the "click" tool surfacing for an
  // unrelated query because some description mentioned click in passing.
  const MIN_SCORE = 8;

  const hits: ToolSearchHit[] = [];
  for (const t of tools) {
    const name = t.name;
    const nameLower = name.toLowerCase();
    const desc = (t.description ?? '').toLowerCase();
    const nameTokens = tokenize(name);
    let score = 0;

    // Whole-query substring in name dominates ("click" inside "chrome_click_element").
    if (nameLower.includes(qLower)) score += 50;
    // Whole-query phrase as substring of description — the load-bearing signal
    // for cross-vocabulary lookups like `page.goto` or `browser_press_key`,
    // which appear verbatim in our cross-ref lines. Without this, a query
    // whose tokens (`page`, `browser`) happen to live in unrelated tool names
    // (`chrome_read_page`, `browser_claim_tab`) wins on the name-token bonus.
    else if (qLower.length >= 4 && desc.includes(qLower)) score += 30;

    // Per-token contributions: exact token match in name > token substring in
    // name > token substring in description.
    for (const q of qTokens) {
      if (nameTokens.includes(q)) score += 20;
      else if (nameLower.includes(q)) score += 8;
      if (desc.includes(q)) score += 3;
    }

    // Proximity bonus: edit distance of query against best name token, capped
    // so it only matters for short queries (typos like "clik" → "click").
    if (qLower.length <= 12) {
      let best = Infinity;
      for (const nt of nameTokens) {
        const d = editDistance(qLower, nt);
        if (d < best) best = d;
      }
      if (best <= 2) score += (3 - best) * 4;
    }

    if (score >= MIN_SCORE) hits.push({ name, summary: firstSentence(t.description ?? ''), score });
  }

  hits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return hits;
}

export interface ToolHelpArgs {
  name?: string;
  query?: string;
  limit?: number;
}

/**
 * Build the payload returned by the `chrome_help` meta-tool.
 *
 * - `buildToolHelp()` returns `{ tools: [{name, summary}, ...] }` covering every
 *   schema, sorted by name. Use to recover the picking signal that lived in
 *   the pre-BUG-003 dispatcher description.
 * - `buildToolHelp({name})` returns `{ name, summary, description }` for a
 *   single tool (full description, not just first sentence). Returns
 *   `{ name, found: false }` if `name` is not in the catalog.
 * - `buildToolHelp({query: "click"})` returns `{ query, matches:
 *   [{name, summary, score}, ...] }` ranked by relevance — the way an agent
 *   should discover tools when it doesn't know the canonical name.
 *
 * Legacy positional form `buildToolHelp("chrome_click_element")` is still
 * accepted for in-process callers; the MCP handler always passes the object.
 */
export function buildToolHelp(
  arg?: string | ToolHelpArgs | Record<string, unknown>,
  tools: readonly Tool[] = TOOL_SCHEMAS,
): Record<string, unknown> {
  const args: ToolHelpArgs =
    typeof arg === 'string' ? { name: arg } : ((arg ?? {}) as ToolHelpArgs);

  if (typeof args.query === 'string' && args.query.trim().length > 0) {
    const limit = Math.max(1, Math.min(50, args.limit ?? 10));
    const hits = searchTools(args.query, tools).slice(0, limit);
    return { query: args.query, matches: hits };
  }

  if (typeof args.name === 'string' && args.name.length > 0) {
    const t = tools.find((tool) => tool.name === args.name);
    if (!t) return { name: args.name, found: false };
    return {
      name: t.name,
      summary: firstSentence(t.description ?? ''),
      description: t.description ?? '',
    };
  }

  return {
    tools: sortedTools(tools).map((t) => ({
      name: t.name,
      summary: firstSentence(t.description ?? ''),
    })),
  };
}

/**
 * Build the single MCP tool descriptor exposed in `lazy` mode. Replaces the
 * 96-entry `TOOL_SCHEMAS` array in `tools/list` responses with this one
 * descriptor. Dynamic `flow.<slug>` tools are appended separately at the
 * register-tools layer (they're per-flow, not part of the static catalog).
 */
export function buildDispatcherTool(tools: readonly Tool[] = TOOL_SCHEMAS): Tool {
  return {
    name: DISPATCHER_TOOL_NAME,
    description: buildDispatcherDescription(tools),
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Tool name from the catalog above.',
        },
        args: {
          type: 'object',
          description: 'Tool-specific arguments object. Shape varies by tool.',
        },
        raw: {
          type: 'boolean',
          description:
            'Bypass the dispatcher output-size cap for this call (default false). Use when you genuinely need the unbounded result.',
        },
        idemKey: {
          type: 'string',
          description:
            'Optional idempotency key (IMP-0183). Replaying the same idemKey within 30s returns the prior result with `_meta.idempotent_hit:true` instead of re-dispatching — safe for retries on state-changing tools.',
        },
      },
      required: ['name'],
    },
  };
}

/** Stable list of known names (sorted) — used for catalog lookups + didYouMean hints. */
export function knownToolNames(tools: readonly Tool[] = TOOL_SCHEMAS): string[] {
  return sortedTools(tools).map((t) => t.name);
}

export function isKnownToolName(name: string, tools: readonly Tool[] = TOOL_SCHEMAS): boolean {
  return tools.some((t) => t.name === name);
}

/**
 * Resolve a possibly-unprefixed tool name to its canonical form (#309).
 *
 * Downstream workflow files still reference legacy short names like
 * `get_windows_and_tabs`. The catalog uses `chrome_*` (most tools) or
 * `browser_*` (`browser_claim_tab`, `browser_close_my_tabs`,
 * `browser_alias_tab`). This tries the input verbatim first, then
 * `chrome_<name>`, then `browser_<name>`, against the catalog ∪ extras.
 *
 * Returns the canonical name or `null` when nothing matches.
 */
export function resolveToolName(
  name: string,
  extras: readonly string[] = [],
  tools: readonly Tool[] = TOOL_SCHEMAS,
): string | null {
  if (typeof name !== 'string' || name.length === 0) return null;
  const catalog = new Set<string>([...knownToolNames(tools), ...extras]);
  if (catalog.has(name)) return name;
  const chromePrefixed = `chrome_${name}`;
  if (catalog.has(chromePrefixed)) return chromePrefixed;
  const browserPrefixed = `browser_${name}`;
  if (catalog.has(browserPrefixed)) return browserPrefixed;
  return null;
}

/**
 * Sunset → consolidated tool map.
 *
 * Several single-purpose tools were folded into action-enum tools (cookies
 * CRUD, diagnostics, downloads, bookmarks CRUD, performance, close_tabs).
 * Their old names still appear inside the consolidated tools' descriptions
 * (e.g. "Replaces chrome_get_cookies/..."), which causes `chrome_help`'s
 * substring search to surface a hit — the LLM then dispatches the deprecated
 * name and gets a bare "Tool not found". This map lets the dispatcher
 * surface a precise replacement instead.
 *
 * Keep entries that map cleanly to a single `{tool, action}` call. Don't add
 * names that need multi-arg translation — the hint stays advisory, the LLM
 * still issues the corrected call itself.
 */
export interface SunsetReplacement {
  /** Canonical tool name to use instead. */
  name: string;
  /** Action enum value on the replacement tool, if applicable. */
  action?: string;
}

const SUNSET_TOOL_REPLACEMENTS: Readonly<Record<string, SunsetReplacement>> = Object.freeze({
  // chrome_cookies (action enum)
  chrome_get_cookies: { name: 'chrome_cookies', action: 'get' },
  chrome_set_cookie: { name: 'chrome_cookies', action: 'set' },
  chrome_remove_cookie: { name: 'chrome_cookies', action: 'remove' },
  // chrome_diagnostics (action enum)
  chrome_debug_dump: { name: 'chrome_diagnostics', action: 'dump_logs' },
  chrome_queue_inspect: { name: 'chrome_diagnostics', action: 'queue' },
  chrome_runtime_info: { name: 'chrome_diagnostics', action: 'runtime_info' },
  chrome_dev_reload: { name: 'chrome_diagnostics', action: 'dev_reload' },
  // chrome_performance_trace (action enum)
  chrome_performance_start_trace: { name: 'chrome_performance_trace', action: 'start' },
  chrome_performance_stop_trace: { name: 'chrome_performance_trace', action: 'stop' },
  chrome_performance_analyze_insight: { name: 'chrome_performance_trace', action: 'analyze' },
  // chrome_close_tabs (action enum)
  chrome_close_tab: { name: 'chrome_close_tabs', action: 'ids' },
  chrome_close_tabs_matching: { name: 'chrome_close_tabs', action: 'matching' },
  browser_close_my_tabs: { name: 'chrome_close_tabs', action: 'mine' },
  // chrome_bookmark (action enum)
  chrome_bookmark_search: { name: 'chrome_bookmark', action: 'search' },
  chrome_bookmark_add: { name: 'chrome_bookmark', action: 'add' },
  chrome_bookmark_update: { name: 'chrome_bookmark', action: 'update' },
  chrome_bookmark_delete: { name: 'chrome_bookmark', action: 'delete' },
  // chrome_download (action enum) — chrome_handle_download is a separate live tool.
  chrome_download_list: { name: 'chrome_download', action: 'list' },
  chrome_download_cancel: { name: 'chrome_download', action: 'cancel' },
});

/**
 * Look up the consolidated replacement for a sunset tool name. Returns
 * `null` when the name isn't a known sunset entry.
 */
export function findReplacementForSunsetTool(name: string): SunsetReplacement | null {
  if (typeof name !== 'string') return null;
  return SUNSET_TOOL_REPLACEMENTS[name] ?? null;
}

/**
 * Resolve a "did you mean" suggestion for an unknown tool name. Combines the
 * static catalog with an optional dynamic-tool list (the bridge passes the
 * flow.<slug> names so typos like `flo.checkout` get suggested too).
 */
export function suggestToolName(
  received: string,
  extras: readonly string[] = [],
  tools: readonly Tool[] = TOOL_SCHEMAS,
): string | null {
  const all = [...knownToolNames(tools), ...extras];
  return didYouMean(received, all, 3);
}
