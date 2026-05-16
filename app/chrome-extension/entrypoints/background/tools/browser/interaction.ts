import {
  createErrorResponse,
  createErrorResponseFromThrown,
  ToolResult,
} from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { TIMEOUTS, ERROR_MESSAGES } from '@/common/constants';
import {
  STRUCTURED_SELECTOR_KINDS,
  resolveSelectorToRef,
  type SelectorType,
} from './_selector-resolve';
import { parsePrefixedSelector } from '@/shared/selector/prefixed-parser';

interface Coordinates {
  x: number;
  y: number;
}

interface ClickToolParams {
  selector?: string; // Selector for the element to click
  selectorType?: SelectorType; // Type of selector (default: 'css')
  ref?: string; // Element ref from accessibility tree (window.__claudeElementMap)
  coordinates?: Coordinates; // Coordinates to click at (x, y relative to viewport)
  waitForNavigation?: boolean; // Whether to wait for navigation to complete after click
  timeoutMs?: number; // Timeout in milliseconds for waiting for the element or navigation
  frameId?: number; // Target frame for ref/selector resolution
  double?: boolean; // Perform double click when true
  button?: 'left' | 'right' | 'middle';
  bubbles?: boolean;
  cancelable?: boolean;
  modifiers?: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean };
  tabId?: number; // target existing tab id
  windowId?: number; // when no tabId, pick active tab from this window
  /** IMP-0098: zero-based match index when multiple elements satisfy the selector. */
  index?: number;
  /** IMP-0098: opt out of strict-mode multi-match error (first match wins). */
  multi?: boolean;
}

/**
 * Tool for clicking elements on web pages
 */
class ClickTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.CLICK;
  static readonly mutates = true;

  /**
   * Execute click operation
   */
  async execute(args: ClickToolParams): Promise<ToolResult> {
    const {
      selector,
      selectorType = 'css',
      coordinates,
      waitForNavigation = false,
      timeoutMs = TIMEOUTS.DEFAULT_WAIT * 5,
      frameId,
      button,
      bubbles,
      cancelable,
      modifiers,
    } = args;

    console.log(`Starting click operation with options:`, args);

    if (!selector && !coordinates && !args.ref) {
      return createErrorResponse(
        ERROR_MESSAGES.INVALID_PARAMETERS + ': Provide ref or selector or coordinates',
      );
    }

    try {
      // Resolve tab
      const explicit = await this.tryGetTab(args.tabId);
      const tab = explicit || (await this.getActiveTabOrThrowInWindow(args.windowId));
      if (!tab.id) {
        return createErrorResponse(ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID');
      }

      // Snapshot the document we're targeting. Click can legitimately navigate
      // (waitForNavigation:true), so we only assert the document hasn't changed
      // *before* the click fires — catching the case where the page navigated
      // between ref resolution and dispatch (silent wrong-target execution).
      // Snapshot in parallel with click-helper injection — they're independent
      // and both incur an IPC round-trip.
      const [snapshot] = await Promise.all([
        this.snapshotTabState(tab.id),
        this.injectContentScript(tab.id, ['inject-scripts/click-helper.js']),
      ]);

      let finalRef = args.ref;
      let finalSelector = selector;

      // IMP-0098: XPath + new Playwright-style selectors resolve via the
      // accessibility-tree-helper, which produces a ref the click-helper
      // can act on without re-running the resolver. Also auto-detect
      // prefixed selectors when caller passed selectorType='css'.
      const prefixDetected =
        selector && selectorType === 'css' ? parsePrefixedSelector(selector).kind !== 'css' : false;
      const needsResolve =
        selector &&
        (selectorType === 'xpath' ||
          STRUCTURED_SELECTOR_KINDS.includes(selectorType as SelectorType) ||
          prefixDetected);

      if (needsResolve) {
        const resolved = await resolveSelectorToRef(this, {
          tabId: tab.id,
          frameId,
          selector: selector ?? '',
          selectorType,
          index: args.index,
          multi: args.multi,
        });
        if (!resolved.ok) return resolved.error;
        finalRef = resolved.ref;
        finalSelector = undefined;
      }

      await this.assertSameDocument(snapshot);

      // Send click message to content script. Wrap in try/catch because
      // sendMessageToTab throws when response.error is set — but for IMP-0098
      // we want to inspect `response.strict` BEFORE the wrap converts it to
      // a ToolError.
      interface ClickHelperResponse {
        success?: boolean;
        message?: string;
        elementInfo?: Record<string, unknown>;
        navigationOccurred?: boolean;
        error?: string;
        strict?: { matchCount: number; samples?: Array<{ tag?: string; text?: string }> };
      }
      let result: ClickHelperResponse;
      try {
        if (typeof frameId === 'number') {
          result = await chrome.tabs.sendMessage(
            tab.id,
            {
              action: TOOL_MESSAGE_TYPES.CLICK_ELEMENT,
              selector: finalSelector,
              coordinates,
              ref: finalRef,
              waitForNavigation,
              timeout: timeoutMs,
              double: args.double === true,
              button,
              bubbles,
              cancelable,
              modifiers,
              allowMultiple: args.multi === true,
            },
            { frameId },
          );
        } else {
          result = await chrome.tabs.sendMessage(tab.id, {
            action: TOOL_MESSAGE_TYPES.CLICK_ELEMENT,
            selector: finalSelector,
            coordinates,
            ref: finalRef,
            waitForNavigation,
            timeout: timeoutMs,
            double: args.double === true,
            button,
            bubbles,
            cancelable,
            modifiers,
            allowMultiple: args.multi === true,
          });
        }
      } catch (err) {
        return createErrorResponseFromThrown(err);
      }

      // Helper returned strict-mode violation envelope?
      if (result && result.error && result.strict) {
        return createErrorResponse(result.error, ToolErrorCode.INVALID_ARGS, {
          matchCount: result.strict.matchCount,
          samples: result.strict.samples ?? [],
        });
      }
      // Generic error envelope (no strict info).
      if (result && result.error) {
        return createErrorResponse(result.error);
      }

      // Determine actual click method used
      let clickMethod: string;
      if (coordinates) {
        clickMethod = 'coordinates';
      } else if (finalRef) {
        clickMethod = 'ref';
      } else if (finalSelector) {
        clickMethod = 'selector';
      } else {
        clickMethod = 'unknown';
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: result.message || 'Click operation successful',
              elementInfo: result.elementInfo,
              navigationOccurred: result.navigationOccurred,
              clickMethod,
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error in click operation:', error);
      return createErrorResponseFromThrown(error);
    }
  }
}

export const clickTool = new ClickTool();

interface FillToolParams {
  selector?: string;
  selectorType?: SelectorType; // Type of selector (default: 'css')
  ref?: string; // Element ref from accessibility tree
  // Accept string | number | boolean for broader form input coverage
  value: string | number | boolean;
  frameId?: number;
  tabId?: number; // target existing tab id
  windowId?: number; // when no tabId, pick active tab from this window
  index?: number;
  multi?: boolean;
}

/**
 * Tool for filling form elements on web pages
 */
class FillTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.FILL;
  static readonly mutates = true;

  /**
   * Execute fill operation
   */
  async execute(args: FillToolParams): Promise<ToolResult> {
    const { selector, selectorType = 'css', ref, value, frameId } = args;

    console.log(`Starting fill operation with options:`, args);

    if (!selector && !ref) {
      return createErrorResponse(ERROR_MESSAGES.INVALID_PARAMETERS + ': Provide ref or selector');
    }

    if (value === undefined || value === null) {
      return createErrorResponse(ERROR_MESSAGES.INVALID_PARAMETERS + ': Value must be provided');
    }

    try {
      const explicit = await this.tryGetTab(args.tabId);
      const tab = explicit || (await this.getActiveTabOrThrowInWindow(args.windowId));
      if (!tab.id) {
        return createErrorResponse(ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID');
      }
      const tabId = tab.id;

      let finalRef = ref;
      let finalSelector = selector;

      // IMP-0098: XPath + structured Playwright-style selectors resolve to a
      // ref before the fill-helper takes over.
      const needsResolve =
        selector &&
        (selectorType === 'xpath' ||
          STRUCTURED_SELECTOR_KINDS.includes(selectorType as SelectorType));
      if (needsResolve) {
        const resolved = await resolveSelectorToRef(this, {
          tabId: tab.id,
          frameId,
          selector: selector ?? '',
          selectorType,
          index: args.index,
          multi: args.multi,
        });
        if (!resolved.ok) return resolved.error;
        finalRef = resolved.ref;
        finalSelector = undefined;
      }

      await this.injectContentScript(tab.id, ['inject-scripts/fill-helper.js']);

      // Fill should never navigate. Wrap with the snapshot+post-assert guard so
      // a mid-call hard navigation surfaces as TARGET_NAVIGATED_AWAY rather
      // than the value getting written to the wrong document silently.
      const result = await this.withNavigationGuard(tabId, () =>
        this.sendMessageToTab(
          tabId,
          {
            action: TOOL_MESSAGE_TYPES.FILL_ELEMENT,
            selector: finalSelector,
            ref: finalRef,
            value,
          },
          frameId,
        ),
      );

      if (result && result.error) {
        return createErrorResponse(result.error);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: result.message || 'Fill operation successful',
              elementInfo: result.elementInfo,
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error in fill operation:', error);
      return createErrorResponseFromThrown(error);
    }
  }
}

export const fillTool = new FillTool();
