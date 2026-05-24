/**
 * Shared selector-resolution helper (IMP-0098).
 *
 * Wraps the call to `ENSURE_REF_FOR_SELECTOR` for Playwright-style
 * selectors (`role`, `label`, `placeholder`, `alt`, `title`, `testid`, `text`,
 * `xpath`) and surfaces strict-mode multi-match as a structured INVALID_ARGS
 * envelope with `{matchCount, samples}`.
 *
 * Tools that own a click/fill/keyboard/focus/drag etc. pipeline call this
 * BEFORE their helper invocation so the rest of the pipeline can keep
 * operating on a ref. The page-side `ensureRefForSelector` handles all the
 * resolution; this module is just the typed thin wrapper.
 */

import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { ToolErrorCode } from 'humanchrome-shared';
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import {
  parsePrefixedSelector,
  type PrefixedSelectorKind,
} from '@/shared/selector/prefixed-parser';
import type { BaseBrowserToolExecutor } from '../base-browser';

export type SelectorType =
  | 'css'
  | 'xpath'
  | 'role'
  | 'label'
  | 'placeholder'
  | 'alt'
  | 'title'
  | 'testid'
  | 'text';

export const STRUCTURED_SELECTOR_KINDS: SelectorType[] = [
  'role',
  'label',
  'placeholder',
  'alt',
  'title',
  'testid',
  'text',
];

export interface ResolveSelectorOptions {
  tabId: number;
  frameId?: number;
  selector: string;
  selectorType: SelectorType;
  /** Strict-mode index hint (picks the Nth match). */
  index?: number;
  /** Opt out of strict-mode multi-match error. */
  multi?: boolean;
}

export type ResolveSelectorResult =
  | { ok: true; ref: string; matchCount?: number }
  | { ok: false; error: ToolResult };

/**
 * Resolve a selector to an element ref via the page-side helper.
 *
 * Handles three shapes:
 *   1. selectorType === 'xpath' — send isXPath=true
 *   2. selectorType is a structured kind — send the parsed payload
 *   3. selectorType === 'css' with a prefixed selector string (`role:button[...]`)
 *      — parse the prefix first, then dispatch as (2).
 *
 * Returns a `ToolResult` error envelope on failure (including strict-mode
 * violations carrying `details: {matchCount, samples}`).
 */
export async function resolveSelectorToRef(
  tool: BaseBrowserToolExecutor,
  opts: ResolveSelectorOptions,
): Promise<ResolveSelectorResult> {
  const { tabId, frameId, selector, selectorType, index, multi } = opts;

  if (!selector) {
    return {
      ok: false,
      error: createErrorResponse('Missing selector', ToolErrorCode.INVALID_ARGS, {
        arg: 'selector',
      }),
    };
  }

  await (
    tool as unknown as {
      injectContentScript: (id: number, paths: string[]) => Promise<void>;
    }
  ).injectContentScript(tabId, ['inject-scripts/accessibility-tree-helper.js']);

  // 1) Parse prefix (e.g. `role:button[name="Submit"]`) when the caller
  //    passed it via selector + selectorType='css'.
  let kind: SelectorType = selectorType;
  let payload: Record<string, unknown> = {};

  if (selectorType === 'css') {
    const parsed = parsePrefixedSelector(selector);
    if (parsed.kind !== 'css') {
      kind = parsed.kind as SelectorType;
      if (kind === 'role') {
        payload = { role: parsed.role, name: parsed.name, exact: parsed.exact };
      } else if (kind === 'testid') {
        payload = { text: parsed.value };
      } else {
        payload = { text: parsed.value, exact: parsed.exact };
      }
    }
  } else if (selectorType === 'role') {
    // Allow `role` selectorType + bracketed selector string.
    const parsed = parsePrefixedSelector(`role:${selector}`);
    payload = { role: parsed.role, name: parsed.name, exact: parsed.exact };
  } else if (selectorType === 'testid') {
    payload = { text: selector };
  } else if (
    selectorType === 'label' ||
    selectorType === 'placeholder' ||
    selectorType === 'alt' ||
    selectorType === 'title' ||
    selectorType === 'text'
  ) {
    payload = { text: selector };
  }

  // Validate role parsed
  if (kind === 'role' && (!payload.role || typeof payload.role !== 'string')) {
    return {
      ok: false,
      error: createErrorResponse(
        `role selector requires a role token (got "${selector}")`,
        ToolErrorCode.INVALID_ARGS,
        { arg: 'selector' },
      ),
    };
  }

  const message: Record<string, unknown> = {
    action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
    selector,
    allowMultiple: multi === true || typeof index === 'number',
    ...payload,
    index: typeof index === 'number' ? index : undefined,
  };

  if (kind === 'xpath') {
    message.isXPath = true;
  } else if (kind !== 'css') {
    message.selectorKind = kind;
  }

  // Send via raw chrome.tabs.sendMessage so the structured `strict` envelope
  // survives — BaseBrowserToolExecutor.sendMessageToTab throws on response.error
  // which would lose it.
  interface EnsureRefResponse {
    success: boolean;
    ref?: string;
    matchCount?: number;
    error?: string;
    strict?: { matchCount: number; samples?: Array<{ tag?: string; text?: string }> };
  }
  let resolved: EnsureRefResponse | undefined;
  try {
    if (typeof frameId === 'number') {
      resolved = (await chrome.tabs.sendMessage(tabId, message, {
        frameId,
      })) as EnsureRefResponse;
    } else {
      resolved = (await chrome.tabs.sendMessage(tabId, message)) as EnsureRefResponse;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: createErrorResponse(`Failed to resolve selector: ${msg}`, ToolErrorCode.UNKNOWN),
    };
  }

  if (!resolved || resolved.success !== true) {
    if (resolved && resolved.strict && typeof resolved.strict.matchCount === 'number') {
      return {
        ok: false,
        error: createErrorResponse(
          resolved.error || 'Selector matched multiple elements',
          ToolErrorCode.INVALID_ARGS,
          {
            matchCount: resolved.strict.matchCount,
            samples: resolved.strict.samples ?? [],
            selectorType: kind,
          },
        ),
      };
    }
    return {
      ok: false,
      error: createErrorResponse(
        `Failed to resolve ${kind} selector: ${resolved?.error || 'unknown error'}`,
        ToolErrorCode.INVALID_ARGS,
        { selectorType: kind, selector },
      ),
    };
  }

  if (!resolved.ref) {
    return {
      ok: false,
      error: createErrorResponse(
        `Failed to resolve ${kind} selector: helper returned no ref`,
        ToolErrorCode.UNKNOWN,
      ),
    };
  }
  return { ok: true, ref: resolved.ref, matchCount: resolved.matchCount };
}

/** Re-export for type narrowing in callers. */
export type { PrefixedSelectorKind };

/**
 * Inputs for the per-tool ISOLATED-world shim — either a raw CSS selector
 * the shim's `document.querySelector` can handle, or a ref that resolves
 * via `window.__claudeElementMap`. Structured selector kinds (`role`,
 * `label`, `placeholder`, etc.) and prefixed CSS strings (`role:button…`)
 * get pre-resolved to a ref here so the shim only has to handle two shapes.
 */
export type ShimSelectorInputs =
  | { ok: true; shimSelector: string | null; shimRef: string | null }
  | { ok: false; error: ToolResult };

export interface ResolveToShimInputsArgs {
  selector?: string;
  selectorType?: SelectorType;
  ref?: string;
  index?: number;
  multi?: boolean;
  tabId: number;
  frameId?: number;
}

/**
 * The pre-shim resolution dance every "single element + shim" tool runs:
 * if the caller gave us a structured/prefixed selector, resolve it to a
 * ref via the accessibility-tree-helper; otherwise pass the raw selector/
 * ref straight through. Shared because the IIFE that decides "does this
 * need resolving?" was copy-pasted across focus / hover / type-into /
 * get-attributes — flagged by /simplify against the IMP-0125-0143 batch.
 */
export async function resolveToShimInputs(
  tool: BaseBrowserToolExecutor,
  args: ResolveToShimInputsArgs,
): Promise<ShimSelectorInputs> {
  const shimSelector: string | null = args.selector ?? null;
  const shimRef: string | null = args.ref ?? null;

  // Only structured/xpath/prefixed-CSS need round-tripping through the
  // resolver. Plain `selectorType:'css'` with a non-prefixed string and
  // `ref` callers pass straight through.
  const needsResolve =
    !shimRef &&
    !!shimSelector &&
    (() => {
      if (args.selectorType && STRUCTURED_SELECTOR_KINDS.includes(args.selectorType)) return true;
      if (args.selectorType === 'xpath') return true;
      if (!args.selectorType || args.selectorType === 'css') {
        const parsed = parsePrefixedSelector(shimSelector!);
        return parsed.kind !== 'css';
      }
      return false;
    })();

  if (!needsResolve) {
    return { ok: true, shimSelector, shimRef };
  }

  const resolved = await resolveSelectorToRef(tool, {
    tabId: args.tabId,
    frameId: args.frameId,
    selector: shimSelector!,
    selectorType: (args.selectorType ?? 'css') as SelectorType,
    index: args.index,
    multi: args.multi,
  });
  if (!resolved.ok) return { ok: false, error: resolved.error };
  return { ok: true, shimSelector: null, shimRef: resolved.ref };
}
