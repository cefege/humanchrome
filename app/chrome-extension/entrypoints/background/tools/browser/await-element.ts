import {
  createErrorResponse,
  createErrorResponseFromThrown,
  ToolResult,
} from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { ERROR_MESSAGES } from '@/common/constants';
import { DEFAULT_AWAIT_ELEMENT_TIMEOUT_MS } from '../../utils/timeouts';

interface AwaitElementToolParams {
  selector?: string;
  selectorType?: 'css' | 'xpath';
  ref?: string;
  state?: 'present' | 'absent';
  timeoutMs?: number;
  tabId?: number;
  windowId?: number;
  frameId?: number;
  background?: boolean;
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
        { arg: 'state' },
      );
    }

    if (selectorType !== 'css' && selectorType !== 'xpath') {
      return createErrorResponse(
        `Invalid selectorType "${selectorType}": expected "css" or "xpath"`,
        ToolErrorCode.INVALID_ARGS,
        { arg: 'selectorType' },
      );
    }

    const requestedTimeout =
      typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs)
        ? args.timeoutMs
        : DEFAULT_TIMEOUT_MS;
    const timeoutMs = Math.max(0, Math.min(requestedTimeout, MAX_TIMEOUT_MS));

    try {
      const explicit = await this.tryGetTab(args.tabId);
      const tab = explicit || (await this.getActiveTabOrThrowInWindow(args.windowId));
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
      const resp = await this.sendMessageToTab(
        tab.id,
        {
          action: TOOL_MESSAGE_TYPES.WAIT_FOR_ELEMENT,
          selector,
          selectorType,
          ref,
          state,
          timeout: timeoutMs,
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

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              found: true,
              selector: ref ? undefined : selector,
              selectorType: ref ? undefined : selectorType,
              ref: ref || resp?.matched?.ref,
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
