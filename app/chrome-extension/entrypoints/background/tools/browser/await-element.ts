import {
  createErrorResponse,
  createErrorResponseFromThrown,
  ToolResult,
} from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode, invalidArgsEnumDetails } from 'humanchrome-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { ERROR_MESSAGES } from '@/common/constants';
import { DEFAULT_AWAIT_ELEMENT_TIMEOUT_MS } from '../../utils/timeouts';

import { STRUCTURED_SELECTOR_KINDS, type SelectorType } from './_selector-resolve';
import { parsePrefixedSelector } from '@/shared/selector/prefixed-parser';

interface AwaitElementToolParams {
  selector?: string;
  selectorType?: SelectorType;
  ref?: string;
  state?: 'present' | 'absent';
  timeoutMs?: number;
  tabId?: number;
  windowId?: number;
  frameId?: number;
  background?: boolean;
  /** IMP-0098: index for multi-match strict mode. */
  index?: number;
  /** IMP-0098: opt out of strict-mode multi-match. */
  multi?: boolean;
}

const DEFAULT_TIMEOUT_MS = DEFAULT_AWAIT_ELEMENT_TIMEOUT_MS;
const MAX_TIMEOUT_MS = 120000;

/**
 * Wait until a DOM element matching the given selector/ref reaches the desired
 * `state` ('present' | 'absent') via a MutationObserver injected into the tab.
 *
 * Read-only — does not set `mutates = true`. Multiple awaits can run in parallel
 * against the same tab and they don't conflict with mutating tools.
 */
class AwaitElementTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.AWAIT_ELEMENT;

  async execute(args: AwaitElementToolParams): Promise<ToolResult> {
    const { selector, selectorType = 'css', ref, state = 'present', frameId } = args;

    if (!selector && !ref) {
      return createErrorResponse(
        ERROR_MESSAGES.INVALID_PARAMETERS + ': Provide ref or selector',
        ToolErrorCode.INVALID_ARGS,
      );
    }

    if (state !== 'present' && state !== 'absent') {
      return createErrorResponse(
        `Invalid state "${state}": expected "present" or "absent"`,
        ToolErrorCode.INVALID_ARGS,
        invalidArgsEnumDetails('state', state, ['present', 'absent']),
      );
    }

    const validTypes: SelectorType[] = ['css', 'xpath', ...STRUCTURED_SELECTOR_KINDS];
    if (!validTypes.includes(selectorType as SelectorType)) {
      return createErrorResponse(
        `Invalid selectorType "${selectorType}"`,
        ToolErrorCode.INVALID_ARGS,
        invalidArgsEnumDetails('selectorType', selectorType, validTypes),
      );
    }

    const requestedTimeout =
      typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs)
        ? args.timeoutMs
        : DEFAULT_TIMEOUT_MS;
    const timeoutMs = Math.max(0, Math.min(requestedTimeout, MAX_TIMEOUT_MS));

    try {
      const tab = await this.getOwnedTab({
        explicit: args.tabId,
        windowId: args.windowId,
        isRead: true,
      });
      if (!tab.id) {
        return createErrorResponse(ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID');
      }

      await this.injectContentScript(
        tab.id,
        ['inject-scripts/wait-helper.js'],
        false,
        'ISOLATED',
        true,
      );

      const startedAt = Date.now();

      // IMP-0098: forward structured selector payload to the wait-helper.
      // The helper's resolveBySelector branches off `selectorType` and reads
      // the inline role/name/text/exact/attribute/index fields.
      let extraSelectorPayload: Record<string, unknown> = {};
      if (selectorType !== 'css' && selectorType !== 'xpath' && typeof selector === 'string') {
        if (selectorType === 'role') {
          const parsed = parsePrefixedSelector(`role:${selector}`);
          extraSelectorPayload = {
            role: parsed.role,
            name: parsed.name,
            exact: parsed.exact,
          };
        } else if (selectorType === 'testid') {
          extraSelectorPayload = { text: selector, attribute: undefined };
        } else {
          extraSelectorPayload = { text: selector };
        }
      } else if (selectorType === 'css' && typeof selector === 'string') {
        const parsed = parsePrefixedSelector(selector);
        if (parsed.kind !== 'css' && parsed.kind !== 'xpath') {
          // Promote prefixed CSS string into a structured payload on the wire.
          extraSelectorPayload =
            parsed.kind === 'role'
              ? { role: parsed.role, name: parsed.name, exact: parsed.exact }
              : { text: parsed.value, exact: parsed.exact };
          // Override selectorType for the helper too.
          (extraSelectorPayload as Record<string, unknown>).__selectorType = parsed.kind;
        }
      }

      const overrideType =
        (extraSelectorPayload as { __selectorType?: SelectorType }).__selectorType ?? selectorType;
      delete (extraSelectorPayload as { __selectorType?: SelectorType }).__selectorType;

      const resp = await this.sendMessageToTab(
        tab.id,
        {
          action: TOOL_MESSAGE_TYPES.WAIT_FOR_ELEMENT,
          selector,
          selectorType: overrideType,
          ref,
          state,
          timeout: timeoutMs,
          index: args.index,
          multi: args.multi,
          ...extraSelectorPayload,
        },
        frameId,
      );

      const elapsedMs = typeof resp?.tookMs === 'number' ? resp.tookMs : Date.now() - startedAt;

      if (!resp || resp.success !== true) {
        const reason = resp?.reason || resp?.error;
        if (reason === 'timeout') {
          return createErrorResponse(
            `chrome_await_element timed out after ${timeoutMs}ms waiting for ${state} (${ref ? `ref=${ref}` : `selector=${selector}`})`,
            ToolErrorCode.TIMEOUT,
            {
              selector: ref ? undefined : selector,
              selectorType: ref ? undefined : selectorType,
              ref: ref || undefined,
              state,
              timeoutMs,
              elapsedMs,
            },
          );
        }
        return createErrorResponse(`chrome_await_element failed: ${reason || 'unknown error'}`);
      }

      // `found` mirrors the post-wait DOM truth, not the wait's success:
      //   state="present" success → the element exists now    → found:true
      //   state="absent"  success → the element is gone now   → found:false
      // The TIMEOUT branch above carries no `found` (the goal was never reached).
      // `absent:true` is the positive twin of `found:true` for absent-mode
      // callers conditioning on a single boolean field.
      const isPresentSuccess = state === 'present';
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              found: isPresentSuccess,
              absent: !isPresentSuccess,
              selector: ref ? undefined : selector,
              selectorType: ref ? undefined : selectorType,
              ref: isPresentSuccess ? ref || resp?.matched?.ref : ref || undefined,
              state,
              elapsedMs,
              matched: resp.matched || null,
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error in chrome_await_element:', error);
      return createErrorResponseFromThrown(error);
    }
  }
}

export const awaitElementTool = new AwaitElementTool();
