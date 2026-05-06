import {
  createErrorResponse,
  createErrorResponseFromThrown,
  ToolResult,
} from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { ERROR_MESSAGES } from '@/common/constants';
import { interceptResponseTool } from './intercept-response';

interface WaitForToolParams {
  kind: 'element' | 'network_idle' | 'response_match' | 'js';
  timeoutMs?: number;
  selector?: string;
  selectorType?: 'css' | 'xpath';
  ref?: string;
  state?: 'present' | 'absent';
  quietMs?: number;
  urlPattern?: string;
  method?: string;
  expression?: string;
  tabId?: number;
  windowId?: number;
  frameId?: number;
}

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 120000;
const DEFAULT_QUIET_MS = 500;

class WaitForTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.WAIT_FOR;

  async execute(args: WaitForToolParams): Promise<ToolResult> {
    const kind = args?.kind;
    if (!kind) {
      return createErrorResponse(
        'Provide `kind` (one of: element, network_idle, response_match, js)',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'kind' },
      );
    }

    const requested =
      typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs)
        ? args.timeoutMs
        : DEFAULT_TIMEOUT_MS;
    const timeoutMs = Math.max(0, Math.min(requested, MAX_TIMEOUT_MS));

    // response_match delegates to chrome_intercept_response — that path
    // resolves the tab itself and runs CDP attach/detach, so no need to do
    // tab resolution up here.
    if (kind === 'response_match') {
      if (!args.urlPattern) {
        return createErrorResponse(
          'urlPattern is required when kind="response_match"',
          ToolErrorCode.INVALID_ARGS,
          { arg: 'urlPattern' },
        );
      }
      const start = Date.now();
      const result = await interceptResponseTool.execute({
        urlPattern: args.urlPattern,
        method: args.method,
        timeoutMs,
        tabId: args.tabId,
        returnBody: false,
      } as never);
      // Pass the structured envelope through unchanged on error; on success
      // re-shape into the wait-for return form. Both shapes still parseable.
      if (result.isError) return result;
      try {
        const inner = JSON.parse(
          result.content[0]?.type === 'text' ? result.content[0].text : '{}',
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                kind: 'response_match',
                tookMs: Date.now() - start,
                url: inner.url,
                status: inner.status,
                method: inner.method,
              }),
            },
          ],
          isError: false,
        };
      } catch {
        return result;
      }
    }

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

      const start = Date.now();

      if (kind === 'element') {
        if (!args.selector && !args.ref) {
          return createErrorResponse(
            'selector or ref is required when kind="element"',
            ToolErrorCode.INVALID_ARGS,
          );
        }
        const resp = await this.sendMessageToTab(
          tab.id,
          {
            action: TOOL_MESSAGE_TYPES.WAIT_FOR_ELEMENT,
            selector: args.selector,
            selectorType: args.selectorType ?? 'css',
            ref: args.ref,
            state: args.state ?? 'present',
            timeout: timeoutMs,
          },
          args.frameId,
        );
        return this.shapeResponse('element', resp, timeoutMs, start, {
          selector: args.selector,
          ref: args.ref,
          state: args.state ?? 'present',
        });
      }

      if (kind === 'network_idle') {
        const quietMs =
          typeof args.quietMs === 'number' && Number.isFinite(args.quietMs)
            ? Math.max(0, args.quietMs)
            : DEFAULT_QUIET_MS;
        const resp = await this.sendMessageToTab(
          tab.id,
          {
            action: TOOL_MESSAGE_TYPES.WAIT_FOR_NETWORK_IDLE,
            quietMs,
            timeout: timeoutMs,
          },
          args.frameId,
        );
        return this.shapeResponse('network_idle', resp, timeoutMs, start, { quietMs });
      }

      if (kind === 'js') {
        const expression = typeof args.expression === 'string' ? args.expression.trim() : '';
        if (!expression) {
          return createErrorResponse(
            'expression is required when kind="js"',
            ToolErrorCode.INVALID_ARGS,
          );
        }
        const resp = await this.sendMessageToTab(
          tab.id,
          {
            action: TOOL_MESSAGE_TYPES.WAIT_FOR_JS,
            expression,
            timeout: timeoutMs,
          },
          args.frameId,
        );
        return this.shapeResponse('js', resp, timeoutMs, start, { expression });
      }

      return createErrorResponse(`unknown kind: ${kind}`, ToolErrorCode.INVALID_ARGS, {
        arg: 'kind',
      });
    } catch (err) {
      return createErrorResponseFromThrown(err);
    }
  }

  /** Convert a wait-helper.js response into a ToolResult: success → ok JSON;
   *  reason==='timeout' → TIMEOUT envelope; anything else → UNKNOWN error. */
  private shapeResponse(
    kind: WaitForToolParams['kind'],
    resp: {
      success?: boolean;
      reason?: string;
      error?: string;
      tookMs?: number;
      [k: string]: unknown;
    },
    timeoutMs: number,
    startedAt: number,
    extra: Record<string, unknown>,
  ): ToolResult {
    if (resp && resp.success === true) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              kind,
              tookMs: resp.tookMs ?? Date.now() - startedAt,
              ...extra,
              ...(resp as Record<string, unknown>),
            }),
          },
        ],
        isError: false,
      };
    }
    if (resp && resp.reason === 'timeout') {
      return createErrorResponse(
        `chrome_wait_for(${kind}) timed out after ${timeoutMs}ms`,
        ToolErrorCode.TIMEOUT,
        { kind, timeoutMs, ...extra },
      );
    }
    return createErrorResponse(
      `chrome_wait_for(${kind}) failed: ${resp?.error ?? 'unknown'}`,
      ToolErrorCode.UNKNOWN,
      { kind, ...extra },
    );
  }
}

export const waitForTool = new WaitForTool();
