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

/** Trim a tool description to its first sentence, collapsed to one line. */
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
 * Build the dispatcher tool's `description` field. Begins with a short
 * usage header, then one line per tool: `- <name>: <first-sentence>`.
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
  const header =
    [
      'Dispatches any humanchrome browser-automation tool by name. Args validated server-side; on INVALID_ARGS the response carries `details.expected` (schema fragment) and `details.hint` (did-you-mean) so you can self-correct in one round-trip.',
      'Call as `{ name: "<tool>", args: { ... }, raw?: boolean }`. Set `raw: true` to bypass the dispatcher\'s output-size cap.',
      'Catalog:',
      '',
    ].join('\n');
  const lines = sortedTools(tools).map(
    (t) => `- ${t.name}: ${firstSentence(t.description ?? '')}`,
  );
  const out = header + lines.join('\n');
  if (tools === TOOL_SCHEMAS) cachedDefaultDescription = out;
  return out;
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
