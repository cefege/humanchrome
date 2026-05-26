/**
 * Shared helpers for browser tools. The underscore prefix marks this
 * file as internal infrastructure — there is no `chrome_common` MCP
 * tool and the barrel `index.ts` does not re-export from here.
 *
 * Extracted in the LLM-friendliness pass: every tool used to inline a
 * 3-line `jsonOk` helper, so 24 copies drifted independently. Now there
 * is one canonical implementation; tools `import { jsonOk } from './_common'`.
 */

import { ToolResult } from '@/common/tool-handler';

/**
 * Wrap a JSON-serializable body as a successful `ToolResult`. The body
 * is rendered with `JSON.stringify` (no formatting) into a single
 * text content block. Mirrors the pattern every browser tool was
 * previously inlining.
 */
export function jsonOk(body: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false };
}

/**
 * Maximum entries in a single `_meta.suggested_next` hint (IMP-0182). Caps the
 * affordance to ~4 tool names so the model gets a focused next-step menu, not
 * a kitchen sink.
 */
export const MAX_SUGGESTED_NEXT = 4;

/**
 * IMP-0182 — attach `_meta.suggested_next: string[]` to a tool result without
 * touching its content blocks. The list is the tool's recommendation for the
 * most likely next tool calls given what just happened (e.g. `read_page`
 * suggests `click_element` / `fill_or_select` because its refs feed both).
 *
 * Capped at MAX_SUGGESTED_NEXT entries. Deduplicates and drops empty strings.
 * No-op on error results (the IMP-0178 envelope is the recovery surface).
 */
export function withSuggestedNext(result: ToolResult, hints: readonly string[]): ToolResult {
  if (result.isError) return result;
  const clean: string[] = [];
  for (const h of hints) {
    if (!h || typeof h !== 'string') continue;
    if (clean.includes(h)) continue;
    clean.push(h);
    if (clean.length >= MAX_SUGGESTED_NEXT) break;
  }
  if (clean.length === 0) return result;
  return {
    ...result,
    _meta: { ...(result._meta ?? {}), suggested_next: clean },
  };
}
