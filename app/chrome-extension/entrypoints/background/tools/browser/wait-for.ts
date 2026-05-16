import {
  createErrorResponse,
  createErrorResponseFromThrown,
  ToolResult,
} from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { ERROR_MESSAGES } from '@/common/constants';
import { interceptResponseTool, compilePattern } from './intercept-response';
import { DEFAULT_WAIT_FOR_TIMEOUT_MS } from '../../utils/timeouts';

import { STRUCTURED_SELECTOR_KINDS, type SelectorType } from './_selector-resolve';
import { parsePrefixedSelector } from '@/shared/selector/prefixed-parser';

type LoadState = 'load' | 'domcontentloaded' | 'complete';
type ElementState = 'present' | 'absent';

interface WaitForToolParams {
  kind: 'element' | 'network_idle' | 'response_match' | 'js' | 'load_state' | 'url';
  timeoutMs?: number;
  selector?: string;
  selectorType?: SelectorType;
  ref?: string;
  /**
   * For kind="element": 'present' (default) or 'absent'.
   * For kind="load_state": 'load' | 'domcontentloaded' | 'complete'.
   * Overloaded because the wait_for schema treats the param as a single
   * shape across kinds; the runtime branches on `kind` so the overload is
   * unambiguous in practice.
   */
  state?: ElementState | LoadState;
  quietMs?: number;
  urlPattern?: string;
  method?: string;
  expression?: string;
  /** For kind="url": substring or /regex/flags matcher (intercept-response syntax). */
  pattern?: string;
  tabId?: number;
  windowId?: number;
  frameId?: number;
  index?: number;
  multi?: boolean;
}

const DEFAULT_TIMEOUT_MS = DEFAULT_WAIT_FOR_TIMEOUT_MS;
const MAX_TIMEOUT_MS = 120000;
const DEFAULT_QUIET_MS = 500;

const LOAD_STATES: ReadonlySet<LoadState> = new Set(['load', 'domcontentloaded', 'complete']);

class WaitForTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.WAIT_FOR;

  async execute(args: WaitForToolParams): Promise<ToolResult> {
    const kind = args?.kind;
    if (!kind) {
      return createErrorResponse(
        'Provide `kind` (one of: element, network_idle, response_match, js, load_state, url)',
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

      const start = Date.now();

      if (kind === 'load_state') {
        return await this.waitForLoadState(tab.id, args, timeoutMs, start);
      }

      if (kind === 'url') {
        return await this.waitForUrl(tab.id, args, timeoutMs, start);
      }

      await this.injectContentScript(
        tab.id,
        ['inject-scripts/wait-helper.js'],
        false,
        'ISOLATED',
        true,
      );

      if (kind === 'element') {
        if (!args.selector && !args.ref) {
          return createErrorResponse(
            'selector or ref is required when kind="element"',
            ToolErrorCode.INVALID_ARGS,
          );
        }
        const requestedType = (args.selectorType ?? 'css') as SelectorType;
        let selectorType: SelectorType = requestedType;
        let extras: Record<string, unknown> = {};
        if (typeof args.selector === 'string') {
          if (STRUCTURED_SELECTOR_KINDS.includes(requestedType)) {
            if (requestedType === 'role') {
              const parsed = parsePrefixedSelector(`role:${args.selector}`);
              extras = { role: parsed.role, name: parsed.name, exact: parsed.exact };
            } else if (requestedType === 'testid') {
              extras = { text: args.selector };
            } else {
              extras = { text: args.selector };
            }
          } else if (requestedType === 'css') {
            // Auto-detect prefixed selectors.
            const parsed = parsePrefixedSelector(args.selector);
            if (parsed.kind !== 'css' && parsed.kind !== 'xpath') {
              selectorType = parsed.kind as SelectorType;
              extras =
                parsed.kind === 'role'
                  ? { role: parsed.role, name: parsed.name, exact: parsed.exact }
                  : { text: parsed.value, exact: parsed.exact };
            }
          }
        }

        const elementState = (args.state as ElementState) ?? 'present';
        const resp = await this.sendMessageToTab(
          tab.id,
          {
            action: TOOL_MESSAGE_TYPES.WAIT_FOR_ELEMENT,
            selector: args.selector,
            selectorType,
            ref: args.ref,
            state: elementState,
            timeout: timeoutMs,
            index: args.index,
            multi: args.multi,
            ...extras,
          },
          args.frameId,
        );
        return this.shapeResponse('element', resp, timeoutMs, start, {
          selector: args.selector,
          ref: args.ref,
          state: elementState,
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

  /**
   * kind="load_state": wait for a Playwright-style load state. Mirrors
   * `page.waitForLoadState('load'|'domcontentloaded')`. 'complete' is a
   * Playwright synonym for 'load' and maps to the same `webNavigation.onCompleted`.
   *
   * Fast path: query `document.readyState` first via a MAIN-world shim. If
   * the document already satisfies the requested state, resolve synchronously
   * without subscribing to anything. Otherwise subscribe to the appropriate
   * webNavigation event filtered by tabId + (optional) frameId.
   */
  private async waitForLoadState(
    tabId: number,
    args: WaitForToolParams,
    timeoutMs: number,
    startedAt: number,
  ): Promise<ToolResult> {
    const rawState = (args.state ?? 'load') as LoadState;
    if (!LOAD_STATES.has(rawState)) {
      return createErrorResponse(
        `state must be one of: load, domcontentloaded, complete (got: ${rawState})`,
        ToolErrorCode.INVALID_ARGS,
        { arg: 'state' },
      );
    }
    const wantComplete = rawState === 'load' || rawState === 'complete';
    const frameId = typeof args.frameId === 'number' ? args.frameId : 0;

    // One-shot readyState check via MAIN-world shim. If the document is
    // already loaded enough, resolve immediately and skip the listener.
    const readyState = await this.readReadyState(tabId, frameId);
    if (readyState && this.readyStateSatisfies(readyState, rawState)) {
      return this.buildLoadStateResult(rawState, readyState, true, timeoutMs, startedAt, frameId);
    }

    const eventApi = wantComplete
      ? chrome.webNavigation?.onCompleted
      : chrome.webNavigation?.onDOMContentLoaded;
    if (!eventApi || typeof eventApi.addListener !== 'function') {
      return createErrorResponse(
        'chrome.webNavigation is unavailable in this context',
        ToolErrorCode.UNKNOWN,
      );
    }

    return new Promise<ToolResult>((resolve) => {
      let settled = false;
      const listener = (details: chrome.webNavigation.WebNavigationFramedCallbackDetails): void => {
        if (settled) return;
        if (details.tabId !== tabId) return;
        if (details.frameId !== frameId) return;
        settled = true;
        clearTimeout(timer);
        try {
          eventApi.removeListener(listener);
        } catch {
          // ignore
        }
        resolve(
          this.buildLoadStateResult(rawState, undefined, false, timeoutMs, startedAt, frameId),
        );
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          eventApi.removeListener(listener);
        } catch {
          // ignore
        }
        resolve(
          createErrorResponse(
            `chrome_wait_for(load_state) timed out after ${timeoutMs}ms`,
            ToolErrorCode.TIMEOUT,
            { kind: 'load_state', timeoutMs, state: rawState, frameId },
          ),
        );
      }, timeoutMs);
      eventApi.addListener(listener);
    });
  }

  /**
   * kind="url": wait for the tab URL to match a substring or /regex/flags
   * pattern (intercept-response syntax). Mirrors Playwright's
   * `page.waitForURL(pattern)`. Subscribes to both `onCommitted` (hard nav)
   * and `onHistoryStateUpdated` (SPA pushState/replaceState).
   *
   * Fast path: read the current URL via `chrome.tabs.get` before subscribing;
   * if it already matches, resolve synchronously.
   */
  private async waitForUrl(
    tabId: number,
    args: WaitForToolParams,
    timeoutMs: number,
    startedAt: number,
  ): Promise<ToolResult> {
    const rawPattern = typeof args.pattern === 'string' ? args.pattern.trim() : '';
    if (!rawPattern) {
      return createErrorResponse(
        'pattern is required when kind="url"',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'pattern' },
      );
    }
    const matches = compilePattern(rawPattern);

    // Fast-path: current URL already matches → resolve immediately.
    let currentUrl: string | undefined;
    try {
      const tab = await chrome.tabs.get(tabId);
      currentUrl = tab.url || tab.pendingUrl || '';
    } catch {
      currentUrl = '';
    }
    if (currentUrl && matches(currentUrl)) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              kind: 'url',
              tookMs: Date.now() - startedAt,
              pattern: rawPattern,
              url: currentUrl,
              alreadyMatched: true,
            }),
          },
        ],
        isError: false,
      };
    }

    const onCommitted = chrome.webNavigation?.onCommitted;
    const onHistory = chrome.webNavigation?.onHistoryStateUpdated;
    if (
      !onCommitted ||
      typeof onCommitted.addListener !== 'function' ||
      !onHistory ||
      typeof onHistory.addListener !== 'function'
    ) {
      return createErrorResponse(
        'chrome.webNavigation is unavailable in this context',
        ToolErrorCode.UNKNOWN,
      );
    }

    return new Promise<ToolResult>((resolve) => {
      let settled = false;
      const cleanup = (): void => {
        try {
          onCommitted.removeListener(committedListener);
        } catch {
          // ignore
        }
        try {
          onHistory.removeListener(historyListener);
        } catch {
          // ignore
        }
      };
      const finish = (url: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        resolve({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                kind: 'url',
                tookMs: Date.now() - startedAt,
                pattern: rawPattern,
                url,
                alreadyMatched: false,
              }),
            },
          ],
          isError: false,
        });
      };
      const committedListener = (
        details: chrome.webNavigation.WebNavigationTransitionCallbackDetails,
      ): void => {
        if (settled) return;
        if (details.tabId !== tabId) return;
        if (details.frameId !== 0) return; // main frame only
        if (details.url && matches(details.url)) finish(details.url);
      };
      const historyListener = (
        details: chrome.webNavigation.WebNavigationTransitionCallbackDetails,
      ): void => {
        if (settled) return;
        if (details.tabId !== tabId) return;
        if (details.frameId !== 0) return;
        if (details.url && matches(details.url)) finish(details.url);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(
          createErrorResponse(
            `chrome_wait_for(url) timed out after ${timeoutMs}ms`,
            ToolErrorCode.TIMEOUT,
            { kind: 'url', timeoutMs, pattern: rawPattern },
          ),
        );
      }, timeoutMs);
      onCommitted.addListener(committedListener);
      onHistory.addListener(historyListener);
    });
  }

  /**
   * Query `document.readyState` in the page via a MAIN-world shim. Returns
   * undefined when `chrome.scripting` isn't available, when the injection
   * throws, or when the script returns nothing — callers fall back to
   * event subscription in that case.
   */
  private async readReadyState(
    tabId: number,
    frameId: number,
  ): Promise<DocumentReadyState | undefined> {
    if (!chrome.scripting || typeof chrome.scripting.executeScript !== 'function') {
      return undefined;
    }
    try {
      const target: { tabId: number; frameIds?: number[] } = { tabId };
      if (typeof frameId === 'number') target.frameIds = [frameId];
      const results = await chrome.scripting.executeScript({
        target,
        world: 'MAIN',
        func: (): DocumentReadyState => document.readyState,
      });
      const first = Array.isArray(results) ? results[0] : undefined;
      const value = first && (first as { result?: unknown }).result;
      if (value === 'loading' || value === 'interactive' || value === 'complete') {
        return value;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  /** True iff the observed readyState already satisfies the requested wait. */
  private readyStateSatisfies(actual: DocumentReadyState, want: LoadState): boolean {
    if (want === 'domcontentloaded') {
      return actual === 'interactive' || actual === 'complete';
    }
    // 'load' and 'complete' both require document.readyState === 'complete'.
    return actual === 'complete';
  }

  private buildLoadStateResult(
    state: LoadState,
    readyState: DocumentReadyState | undefined,
    alreadyLoaded: boolean,
    _timeoutMs: number,
    startedAt: number,
    frameId: number,
  ): ToolResult {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            kind: 'load_state',
            tookMs: Date.now() - startedAt,
            state,
            frameId,
            alreadyLoaded,
            readyState,
          }),
        },
      ],
      isError: false,
    };
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
