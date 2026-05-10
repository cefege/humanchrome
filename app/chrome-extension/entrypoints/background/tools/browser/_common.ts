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
