/**
 * Declarative tool-catalog constants shared by the runtime index and Rust export.
 * Keep this module free of ranking, search, browser, and WASM dependencies.
 */
import type { Tool } from '@modelcontextprotocol/server';

export const DISPATCHER_TOOL_NAME = 'humanchrome';

/** Fresh declarative schema shared by descriptor construction and contract export. */
export function dispatcherInputSchema(): Tool['inputSchema'] {
  return {
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
  };
}

/**
 * Sunset aliases that need a fixed argument translation before dispatch.
 * Kept separate from name-only resolution and replacement hints because these
 * aliases rewrite a call rather than merely suggesting its successor.
 */
export interface LegacyToolAlias {
  tool: string;
  args?: Record<string, unknown>;
}

export const LEGACY_TOOL_ALIASES: Readonly<Record<string, LegacyToolAlias>> = Object.freeze({
  chrome_await_element: { tool: 'chrome_wait_for', args: { kind: 'element' } },
  chrome_aria_snapshot: { tool: 'chrome_read_page', args: { format: 'aria' } },
});
