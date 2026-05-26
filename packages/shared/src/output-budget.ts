/**
 * Universal output budget enforcement at the MCP dispatcher (IMP-0179).
 *
 * Tool result bloat is the single largest source of silent context exhaustion
 * in agentic loops. Today every tool implements its own truncation (or none);
 * IMP-0179 puts the cap at the one chokepoint — the dispatcher in
 * `tools/index.ts` — and lets each tool override the limit via a static
 * `outputBudgetBytes` field.
 *
 * Contract surface added to oversized results:
 *
 *   {
 *     content: [{ type: 'text', text: <head-of-original> + '\n\n' + footer }],
 *     isError: false,
 *     truncation: {
 *       truncated: true,
 *       originalSize: number,
 *       limit: number,
 *       unit: 'bytes',
 *       hint: 'set raw=true to opt out',
 *     }
 *   }
 *
 * Footer is a stable line the LLM can parse:
 *   [Result truncated by dispatcher: originalSize=X bytes, limit=Y bytes. Pass raw=true to bypass.]
 *
 * Preserves all existing per-tool truncation envelopes (network-capture's
 * `responseBodyTruncation`, userscript's `maxOutputBytes`, console's
 * `truncation`) — the dispatcher cap is the outer guard, not a replacement.
 *
 * Image content (screenshot, gif) is NEVER truncated — partial base64 would
 * corrupt the asset. Multi-block results with mixed text+image are passed
 * through unchanged when the image dominates; the text block (if any) gets
 * its own head-truncation when oversized.
 */

const DEFAULT_BUDGET_BYTES = 25 * 1024;
const HEADROOM_BYTES = 256;

export interface TruncationMeta {
  truncated: true;
  originalSize: number;
  limit: number;
  unit: 'bytes';
  hint: string;
}

interface CallToolContent {
  type: string;
  text?: string;
  [key: string]: unknown;
}

interface CallToolLike {
  content?: CallToolContent[];
  isError?: boolean;
  truncation?: TruncationMeta;
  [key: string]: unknown;
}

function byteLengthUtf8(s: string): number {
  return new TextEncoder().encode(s).length;
}

function truncateUtf8(s: string, maxBytes: number): string {
  const enc = new TextEncoder();
  const bytes = enc.encode(s);
  if (bytes.length <= maxBytes) return s;
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, maxBytes));
}

export interface EnforceOutputBudgetOptions {
  /** Bypass entirely — used when the caller passed `raw: true`. */
  raw?: boolean;
  /** Override the default 25 KiB cap. */
  budgetBytes?: number;
}

/**
 * Apply the budget to a tool result. Returns the same object reference if no
 * truncation was needed; returns a new object with appended truncation
 * metadata otherwise.
 *
 * Error results (`isError: true`) bypass the budget entirely — error envelopes
 * are bounded by construction and need to surface intact.
 */
export function enforceOutputBudget<T extends CallToolLike>(
  result: T,
  opts: EnforceOutputBudgetOptions = {},
): T {
  if (opts.raw) return result;
  if (!result || typeof result !== 'object') return result;
  if (result.isError) return result;
  if (!Array.isArray(result.content)) return result;

  const budget = Math.max(1024, opts.budgetBytes ?? DEFAULT_BUDGET_BYTES);

  // Serialize ONLY the text blocks for size accounting. Image content has
  // its own size constraints handled upstream and we never partial-cut base64.
  const textBlocks: Array<CallToolContent & { text: string; _bytes: number }> = [];
  for (const c of result.content) {
    if (c?.type === 'text' && typeof c.text === 'string') {
      textBlocks.push({ ...c, text: c.text, _bytes: byteLengthUtf8(c.text) });
    }
  }
  if (textBlocks.length === 0) return result;

  const totalTextBytes = textBlocks.reduce((acc, b) => acc + b._bytes, 0);
  if (totalTextBytes <= budget) return result;

  // Single-text-block path: most common, keep simple.
  const reservedFooter = HEADROOM_BYTES;
  const headBudget = Math.max(1024, budget - reservedFooter);

  if (textBlocks.length === 1 && result.content.length === 1) {
    const original = textBlocks[0].text;
    const head = truncateUtf8(original, headBudget);
    const footer = `\n\n[Result truncated by dispatcher: originalSize=${totalTextBytes} bytes, limit=${budget} bytes. Pass raw=true to bypass.]`;
    const truncation: TruncationMeta = {
      truncated: true,
      originalSize: totalTextBytes,
      limit: budget,
      unit: 'bytes',
      hint: 'set raw=true to opt out',
    };
    return {
      ...result,
      content: [{ type: 'text', text: head + footer }],
      truncation,
    } as T;
  }

  // Multi-block path: cap each text block proportionally; preserve images.
  // Sizes were measured once above; reuse via a name-keyed Map (text content
  // is the only block kind we touch, and identical-text duplicates collapse
  // to the same key — fine since the budget is the same either way).
  const perBlockBudget = Math.max(512, Math.floor(headBudget / textBlocks.length));
  const sizeByText = new Map<string, number>(textBlocks.map((b) => [b.text, b._bytes]));
  const newContent = result.content.map((c) => {
    if (c?.type === 'text' && typeof c.text === 'string') {
      const bytes = sizeByText.get(c.text) ?? byteLengthUtf8(c.text);
      if (bytes <= perBlockBudget) return c;
      return {
        ...c,
        text:
          truncateUtf8(c.text, perBlockBudget) +
          `\n\n[Block truncated by dispatcher: per-block limit=${perBlockBudget} bytes.]`,
      };
    }
    return c;
  });
  const truncation: TruncationMeta = {
    truncated: true,
    originalSize: totalTextBytes,
    limit: budget,
    unit: 'bytes',
    hint: 'set raw=true to opt out',
  };
  return { ...result, content: newContent, truncation } as T;
}

export const DEFAULT_OUTPUT_BUDGET_BYTES = DEFAULT_BUDGET_BYTES;
