/**
 * Common utilities for Action handlers
 *
 * Shared helpers for:
 * - Variable resolution and template interpolation
 * - Selector target conversion
 * - Element visibility verification
 * - Logging utilities
 */

import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import {
  createChromeSelectorLocator,
  type SelectorTarget,
} from '@/shared/selector';
import { selectorPolicy, workflowPolicy } from 'humanchrome-shared';
import { tryResolveString } from '../registry';
import type { ActionExecutionContext, ElementTarget, Resolvable, VariableStore } from '../types';

// ================================
// Selector Locator Instance
// ================================

export const selectorLocator = createChromeSelectorLocator();

// ================================
// String Resolution Utilities
// ================================

/**
 * Interpolate {varName} placeholders in a string using variable store.
 */
export function interpolateBraces(template: string, vars: VariableStore): string {
  return workflowPolicy.workflowLegacyExpandTemplatesDeep(String(template || ''), vars);
}

/**
 * Resolve a Resolvable<string> value with template interpolation
 */
export function resolveString(
  value: Resolvable<string>,
  vars: VariableStore,
): { ok: true; value: string } | { ok: false; error: string } {
  const resolved = tryResolveString(value, vars);
  if (!resolved.ok) return resolved;
  return { ok: true, value: interpolateBraces(resolved.value, vars) };
}

/**
 * Resolve an optional Resolvable<string> value
 */
export function resolveOptionalString(
  value: Resolvable<string> | undefined,
  vars: VariableStore,
): string | undefined {
  if (value === undefined) return undefined;
  const resolved = resolveString(value, vars);
  if (!resolved.ok) return undefined;
  const out = resolved.value.trim();
  return out.length > 0 ? out : undefined;
}

// ================================
// Number Utilities
// ================================

/**
 * Clamp a number to a range with integer conversion
 */
export function clampInt(value: number, min: number, max: number): number {
  return selectorPolicy.clampRustActionInteger(value, min, max);
}

// ================================
// Selector Target Conversion
// ================================

export interface ConvertedSelectorTarget {
  selectorTarget: SelectorTarget;
  /** Type of the first candidate (for fallback logging) */
  firstCandidateType?: string;
  /** First CSS or attr selector value (for tool fallback) */
  firstCssOrAttr?: string;
}

/**
 * Convert Action ElementTarget to shared SelectorTarget
 *
 * Handles:
 * - Resolvable candidate values
 * - Template interpolation
 * - Weight assignment for locator priority
 */
export function toSelectorTarget(
  target: ElementTarget,
  vars: VariableStore,
): ConvertedSelectorTarget {
  return selectorPolicy.prepareRustActionSelectorTarget(target, vars);
}

// ================================
// Chrome Message Utilities
// ================================

/**
 * Result type for sendMessageToTab
 */
export type SendMessageResult<T = unknown> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Send message to tab with optional frameId
 * Returns structured result to avoid silent failures
 */
export async function sendMessageToTab<T = unknown>(
  tabId: number,
  message: unknown,
  frameId?: number,
): Promise<SendMessageResult<T>> {
  try {
    let response: T;
    if (typeof frameId === 'number') {
      response = await chrome.tabs.sendMessage(tabId, message, { frameId });
    } else {
      response = await chrome.tabs.sendMessage(tabId, message);
    }
    return { ok: true, value: response };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ================================
// Element Verification
// ================================

/**
 * Verify element is visible by checking its bounding rect
 */
export async function ensureElementVisible(
  tabId: number,
  ref: string,
  frameId: number | undefined,
): Promise<boolean> {
  const result = await sendMessageToTab<{ rect?: { width: number; height: number } }>(
    tabId,
    { action: TOOL_MESSAGE_TYPES.RESOLVE_REF, ref },
    frameId,
  );
  if (!result.ok) return false;
  const rect = result.value?.rect;
  return !!rect && rect.width > 0 && rect.height > 0;
}

/**
 * Get current tab URL
 */
export async function readTabUrl(tabId: number): Promise<string> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab?.url || '';
  } catch {
    return '';
  }
}

// ================================
// Logging Utilities
// ================================

export interface FallbackLogEntry {
  stepId: string;
  status: 'success';
  message: string;
  fallbackUsed: boolean;
  fallbackFrom: string;
  fallbackTo: string;
}

/**
 * Log selector fallback usage for debugging
 */
export function logSelectorFallback(
  ctx: Pick<ActionExecutionContext, 'pushLog'>,
  actionId: string,
  from: string,
  to: string,
): void {
  try {
    ctx.pushLog?.({
      stepId: actionId,
      status: 'success',
      message: `Selector fallback used (${from} -> ${to})`,
      fallbackUsed: true,
      fallbackFrom: from,
      fallbackTo: to,
    });
  } catch {
    // Ignore logging errors
  }
}
