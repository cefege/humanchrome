import {
  classifyTabError,
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
import { cdpSessionManager } from '@/utils/cdp-session-manager';

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
  // IMP-0097: skip the visible+stable+enabled+hit-test suite. scrollIntoView
  // still runs. Default false; pass true only when the agent knows the suite
  // is producing a false positive (e.g. clicking a pseudo-element that the
  // hit-test can't resolve).
  force?: boolean;
  // IMP-0097: per-call cap on time spent waiting for actionability to pass.
  // Default 5000ms (matches Playwright). Override when the page has a long
  // settle (heavy SPA hydration) or to fail fast on a known-bad target.
  actionabilityTimeoutMs?: number;
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
      const tab = await this.getOwnedTab({
        explicit: args.tabId,
        windowId: args.windowId,
      });
      if (!tab.id) {
        return createErrorResponse(ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID');
      }

      // Snapshot the document we're targeting. Click can legitimately navigate
      // (waitForNavigation:true), so we only assert the document hasn't changed
      // *before* the click fires — catching the case where the page navigated
      // between ref resolution and dispatch (silent wrong-target execution).
      // Snapshot in parallel with click-helper + actionability injection —
      // they're independent and both incur an IPC round-trip. Actionability
      // (IMP-0097) is the shared visible/stable/enabled/hit-test primitive
      // that click-helper reaches through `window.__actionability`.
      const [snapshot] = await Promise.all([
        this.snapshotTabState(tab.id),
        // IMP-0104: accessibility-tree-helper.js installs window.__hcQuerySelectorUnique,
        // which click-helper reaches through for strict-mode multi-match detection.
        // Without it the helper falls through to a single document.querySelector and
        // silently picks the first of N matches, defeating IMP-0098's safety guard.
        this.injectContentScript(tab.id, [
          'inject-scripts/accessibility-tree-helper.js',
          'inject-scripts/actionability.js',
          'inject-scripts/click-helper.js',
        ]),
      ]);

      // IMP-0137: confirm actionability.js actually installed window.__actionability
      // before letting click-helper depend on it. If a future refactor drops
      // actionability.js from the file list (or the build output is missing it),
      // fail loudly at the contract boundary instead of silently degrading to
      // a permissive click (the runActionability fallback in click-helper now
      // returns actionability_unavailable, but failing here gives a clearer
      // build-misconfiguration error rather than a per-element NOT_ACTIONABLE).
      await this.assertHelperPresent(tab.id, 'actionability_ping', 'actionability.js', frameId);

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
        notActionable?: boolean;
        failures?: string[];
        method?: string;
        clickPosition?: unknown;
        // Bug-002: helper now returns coords + cdpReady so BG can dispatch
        // the click via trusted CDP `Input.dispatchMouseEvent`.
        cdpReady?: boolean;
        clickX?: number;
        clickY?: number;
        isDouble?: boolean;
      }
      const clickMessage = {
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
        index: typeof args.index === 'number' ? args.index : undefined,
        force: args.force === true,
        actionabilityTimeoutMs: args.actionabilityTimeoutMs,
        // Bug-002: ask helper to resolve coords + actionability + return,
        // skipping the synthetic dispatchEvent path. BG then sends a trusted
        // CDP click — same path chrome_computer uses. Synthetic dispatch was
        // silently no-op'ing on Ember-routed nav listitems + React combobox
        // option commits because `isTrusted:false` events fail the page's
        // trust gate.
        cdpDispatch: true,
      };
      let result: ClickHelperResponse;
      try {
        result =
          typeof frameId === 'number'
            ? await chrome.tabs.sendMessage(tab.id, clickMessage, { frameId })
            : await chrome.tabs.sendMessage(tab.id, clickMessage);
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
      if (result && result.error && !result.notActionable) {
        return createErrorResponse(result.error);
      }

      // Actionability failures (IMP-0097) carry a structured envelope
      // (`notActionable: true` + `failures: string[]`) so the tool can
      // surface them as NOT_ACTIONABLE without reparsing the message.
      if (result && result.notActionable === true) {
        return createErrorResponse(
          result.error || 'Element is not actionable',
          ToolErrorCode.NOT_ACTIONABLE,
          {
            failures: Array.isArray(result.failures) ? result.failures : [],
            ...(result.method ? { method: result.method } : {}),
            ...(result.elementInfo ? { elementInfo: result.elementInfo } : {}),
            ...(result.clickPosition ? { clickPosition: result.clickPosition } : {}),
          },
        );
      }

      // Bug-002: helper handed us coords; dispatch via CDP from BG.
      if (
        !result ||
        result.cdpReady !== true ||
        typeof result.clickX !== 'number' ||
        typeof result.clickY !== 'number'
      ) {
        return createErrorResponse(
          'click-helper did not return CDP-ready coordinates',
          ToolErrorCode.UNKNOWN,
          { tabId: tab.id },
        );
      }
      const cdpX = result.clickX;
      const cdpY = result.clickY;
      const cdpButton: 'left' | 'middle' | 'right' = button ?? 'left';
      const cdpButtons = cdpButton === 'right' ? 2 : cdpButton === 'middle' ? 4 : 1;
      const cdpModifiers =
        (modifiers?.altKey ? 1 : 0) |
        (modifiers?.ctrlKey ? 2 : 0) |
        (modifiers?.metaKey ? 4 : 0) |
        (modifiers?.shiftKey ? 8 : 0);
      const isDouble = result.isDouble === true || args.double === true;

      // Set up navigation watcher BEFORE the click so we don't miss a fast
      // commit. Resolves to true on the next URL change for this tab, or
      // false on timeout. Used only when caller asked for waitForNavigation.
      const navWatch =
        waitForNavigation && tab.id ? watchTabNavigation(tab.id, timeoutMs) : null;

      try {
        await cdpSessionManager.withSession(tab.id, 'click', async () => {
          // Move first — chrome_computer's path does this too. Some click
          // handlers (Ember route delegates, custom dropdown triggers) gate
          // on a pointermove preceding the press, which a bare press/release
          // pair doesn't satisfy.
          await cdpSessionManager.sendCommand(tab.id!, 'Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: cdpX,
            y: cdpY,
            button: 'none',
            buttons: 0,
            modifiers: cdpModifiers,
          });
          await cdpSessionManager.sendCommand(tab.id!, 'Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: cdpX,
            y: cdpY,
            button: cdpButton,
            buttons: cdpButtons,
            clickCount: isDouble ? 2 : 1,
            modifiers: cdpModifiers,
          });
          await cdpSessionManager.sendCommand(tab.id!, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: cdpX,
            y: cdpY,
            button: cdpButton,
            buttons: 0,
            clickCount: isDouble ? 2 : 1,
            modifiers: cdpModifiers,
          });
          if (isDouble) {
            await cdpSessionManager.sendCommand(tab.id!, 'Input.dispatchMouseEvent', {
              type: 'mousePressed',
              x: cdpX,
              y: cdpY,
              button: cdpButton,
              buttons: cdpButtons,
              clickCount: 2,
              modifiers: cdpModifiers,
            });
            await cdpSessionManager.sendCommand(tab.id!, 'Input.dispatchMouseEvent', {
              type: 'mouseReleased',
              x: cdpX,
              y: cdpY,
              button: cdpButton,
              buttons: 0,
              clickCount: 2,
              modifiers: cdpModifiers,
            });
          }
        });
      } catch (cdpErr) {
        const msg = cdpErr instanceof Error ? cdpErr.message : String(cdpErr);
        if (/another debugger|already attached/i.test(msg)) {
          return createErrorResponse(msg, ToolErrorCode.CDP_BUSY, { tabId: tab.id });
        }
        return classifyTabError(cdpErr, {
          toolName: TOOL_NAMES.BROWSER.CLICK,
          tabId: tab.id,
          extraDetails: { clickX: cdpX, clickY: cdpY },
        });
      }

      let navigationOccurred = false;
      if (navWatch) {
        navigationOccurred = await navWatch;
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
              navigationOccurred,
              clickMethod,
              clickPosition: { x: cdpX, y: cdpY },
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

/**
 * Resolve to `true` when the tab navigates (URL changes from snapshot) within
 * `timeoutMs`, else `false`. Replaces click-helper's beforeunload listener so
 * waitForNavigation continues to work after the dispatch moved to BG CDP.
 */
async function watchTabNavigation(tabId: number, timeoutMs: number): Promise<boolean> {
  let startUrl = '';
  try {
    const tab = await chrome.tabs.get(tabId);
    startUrl = tab.url ?? '';
  } catch {
    return false;
  }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      try {
        chrome.tabs.onUpdated.removeListener(onUpdated);
      } catch {}
      resolve(value);
    };
    const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id !== tabId) return;
      // URL change OR loading state — either signals the click triggered nav.
      if (info.url && info.url !== startUrl) settle(true);
      else if (info.status === 'loading') settle(true);
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    setTimeout(() => settle(false), Math.max(0, timeoutMs));
  });
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
  // IMP-0097: skip the visible+enabled+editable suite. scrollIntoView still
  // runs. Default false.
  force?: boolean;
  // IMP-0097: per-call cap on actionability wait. Default 5000ms.
  actionabilityTimeoutMs?: number;
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
      const tab = await this.getOwnedTab({
        explicit: args.tabId,
        windowId: args.windowId,
      });
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

      // Inject actionability primitive alongside fill-helper. The helper
      // reaches through `window.__actionability` for the visible+enabled+
      // editable suite (IMP-0097). accessibility-tree-helper.js installs
      // window.__hcQuerySelectorUnique for strict-mode multi-match (IMP-0104).
      await this.injectContentScript(tab.id, [
        'inject-scripts/accessibility-tree-helper.js',
        'inject-scripts/actionability.js',
        'inject-scripts/fill-helper.js',
      ]);

      // IMP-0137: contract boundary check — same rationale as ClickTool.
      // Without window.__actionability, fill-helper would (post-fix) refuse
      // every action with actionability_unavailable. Catching it here gives
      // the caller a precise build-misconfiguration error.
      await this.assertHelperPresent(tab.id, 'actionability_ping', 'actionability.js', frameId);

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
            allowMultiple: args.multi === true,
            index: typeof args.index === 'number' ? args.index : undefined,
            force: args.force === true,
            actionabilityTimeoutMs: args.actionabilityTimeoutMs,
          },
          frameId,
        ),
      );

      if (result && result.notActionable === true) {
        return createErrorResponse(
          result.error || 'Element is not actionable',
          ToolErrorCode.NOT_ACTIONABLE,
          {
            failures: Array.isArray(result.failures) ? result.failures : [],
            ...(result.elementInfo ? { elementInfo: result.elementInfo } : {}),
          },
        );
      }

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
