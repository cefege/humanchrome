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

import { getRustKernel } from './rust-bindings';
export { DEFAULT_OUTPUT_BUDGET_BYTES } from '../generated/rust-kernel-id';

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

interface OutputBudgetPlan {
  singleText: boolean;
  patches: Array<{ index: number; text: string }>;
  truncation: TruncationMeta;
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
  const plan = getRustKernel().output_budget_plan(result, opts) as OutputBudgetPlan | undefined;
  if (plan === undefined) return result;
  if (plan.singleText) {
    return {
      ...result,
      content: [{ type: 'text', text: plan.patches[0]!.text }],
      truncation: plan.truncation,
    } as T;
  }
  const content = result.content!.slice();
  for (const patch of plan.patches) {
    content[patch.index] = { ...content[patch.index]!, text: patch.text };
  }
  return { ...result, content, truncation: plan.truncation };
}

