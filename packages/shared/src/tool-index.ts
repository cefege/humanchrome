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
    'Call as `{ name: "<tool>", args: { ... }, raw?: boolean }`. Set `raw: true` to bypass the output-size cap. Use `chrome_help({})` for one-line descriptions of every tool, or `chrome_help({name: "<tool>"})` for a single tool.',
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
 * Build the payload returned by the `chrome_help` meta-tool.
 *
 * - `buildToolHelp()` returns `{ tools: [{name, summary}, ...] }` covering every
 *   schema, sorted by name. Use to recover the picking signal that lived in
 *   the pre-BUG-003 dispatcher description.
 * - `buildToolHelp(name)` returns `{ name, summary, description }` for a
 *   single tool (full description, not just first sentence). Returns
 *   `{ name, found: false }` if `name` is not in the catalog.
 */
export function buildToolHelp(
  name?: string,
  tools: readonly Tool[] = TOOL_SCHEMAS,
): Record<string, unknown> {
  if (typeof name === 'string' && name.length > 0) {
    const t = tools.find((tool) => tool.name === name);
    if (!t) return { name, found: false };
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
