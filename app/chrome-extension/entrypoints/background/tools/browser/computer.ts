/**
 * ComputerTool — the omnibus `chrome_computer` action dispatcher backing the
 * Anthropic computer-use tool surface. One MCP tool routes 16+ low-level
 * actions (left_click, scroll, key, type, screenshot, drag, ...) through a
 * single execute() switch so the model sees one stable interface.
 *
 * Why one mega-tool instead of 16 small ones: the Claude computer-use
 * contract pins this exact tool name + action enum. Splitting would force
 * the bridge to translate names and break compatibility with existing
 * trained behavior. Instead, each action delegates to a focused helper
 * (clickTool, fillTool, keyboardTool, screenshotTool, CDPHelper) so per-
 * action logic lives in its own file.
 *
 * Coordinate scaling: callers think in the model's logical viewport;
 * scaleCoordinates + screenshotContextManager translate to real pixels
 * captured by the most recent screenshot. Always check checkDomainShift
 * before reusing a stale context — coords from a different page are a
 * silent foot-gun.
 *
 * GIF auto-capture (gif-recorder) hooks every action when active; keep new
 * action branches calling captureFrameOnAction so recordings stay complete.
 */
import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'humanchrome-shared';
import { ERROR_MESSAGES } from '@/common/constants';
import {
  screenshotContextManager,
  scaleCoordinates,
  type ScreenshotContext,
} from '@/utils/screenshot-context';
import {
  captureFrameOnAction,
  isAutoCaptureActive,
  type ActionMetadata,
  type ActionType,
} from './gif-recorder';
import { CDPHelper } from './computer/cdp-helper';
import {
  handleClick,
  handleMultiClick,
  handleLeftClickDrag,
  type ClickActionDeps,
} from './computer/actions/click-actions';
import { handleScroll, handleScrollTo, handleZoom } from './computer/actions/scroll-zoom-actions';
import {
  handleType,
  handleFill,
  handleFillForm,
  handleKey,
  handleWait,
} from './computer/actions/input-actions';
import { handleResizePage, handleHover, handleScreenshot } from './computer/actions/view-actions';

export type MouseButton = 'left' | 'right' | 'middle';

export interface Coordinates {
  x: number;
  y: number;
}

export interface ZoomRegion {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Modifiers {
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

export interface ComputerParams {
  action:
    | 'left_click'
    | 'right_click'
    | 'double_click'
    | 'triple_click'
    | 'left_click_drag'
    | 'scroll'
    | 'type'
    | 'key'
    | 'hover'
    | 'wait'
    | 'fill'
    | 'fill_form'
    | 'resize_page'
    | 'scroll_to'
    | 'zoom'
    | 'screenshot';
  // click/scroll coordinates in screenshot space (if screenshot context exists) or viewport space
  coordinates?: Coordinates; // for click/scroll; for drag, this is endCoordinates
  startCoordinates?: Coordinates; // for drag start
  // Optional element refs (from chrome_read_page) as alternative to coordinates
  ref?: string; // click target or drag end
  startRef?: string; // drag start
  scrollDirection?: 'up' | 'down' | 'left' | 'right';
  scrollAmount?: number;
  text?: string; // for type/key
  repeat?: number; // for key action (1-100)
  modifiers?: Modifiers; // for click actions
  region?: ZoomRegion; // for zoom action
  duration?: number; // seconds for wait
  // For fill / fill_form
  selector?: string;
  selectorType?: 'css' | 'xpath'; // Type of selector (default: 'css')
  // Accept string | number | boolean to match FillToolParams; the schema
  // exposes the union so the LLM can pass the right shape per element.
  value?: string | number | boolean;
  elements?: Array<{ ref: string; value: string | number | boolean }>;
  // For resize_page (Emulation.setDeviceMetricsOverride dimensions).
  width?: number;
  height?: number;
  // For action=wait with text — whether the helper should wait for the
  // text to appear (true, default) or disappear (false).
  appear?: boolean;
  frameId?: number; // Target frame for selector/ref resolution
  tabId?: number; // target existing tab id
  windowId?: number;
  background?: boolean; // avoid focusing/activating
  // Caps the per-CDP-command timeout for this invocation; for action='wait'
  // with text it also caps the wait deadline. Default 10000ms (CDP) or
  // 10000ms (wait); clamped to [1000, 120000].
  timeoutMs?: number;
}

// Extract the hostname component of a URL, returning '' for unparseable input.
function getHostnameFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

// Verify the screenshot context's hostname still matches the tab's current
// hostname. If the domain changed since the last screenshot, returns a
// `ToolResult` error response that the caller should early-return; otherwise
// returns `null`.
//
// The default trailing message ("Capture a new screenshot or use ref/selector.")
// matches the coordinate-driven actions; pass `trailing: 'first'` to emit
// "Capture a new screenshot first." for actions that have no ref-based fallback
// (e.g. zoom).
export function checkDomainShift(
  ctx: ScreenshotContext | undefined,
  tabUrl: string | undefined,
  action: string,
  trailing: 'or-ref' | 'first' = 'or-ref',
): ToolResult | null {
  const contextHostname = ctx?.hostname;
  if (!contextHostname) return null;
  const currentHostname = getHostnameFromUrl(tabUrl || '');
  if (contextHostname === currentHostname) return null;
  const tail =
    trailing === 'first'
      ? 'Capture a new screenshot first.'
      : 'Capture a new screenshot or use ref/selector.';
  return createErrorResponse(
    `Security check failed: Domain changed since last screenshot (from ${contextHostname} to ${currentHostname}) during ${action}. ${tail}`,
  );
}

class ComputerTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.COMPUTER;
  static readonly mutates = true;

  async execute(args: ComputerParams): Promise<ToolResult> {
    const params = args || ({} as ComputerParams);
    if (!params.action) return createErrorResponse('Action parameter is required');

    try {
      const explicit = await this.tryGetTab(args.tabId);
      const tab = explicit || (await this.getActiveTabOrThrowInWindow(args.windowId));
      if (!tab.id)
        return createErrorResponse(ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID');

      // Optional per-call CDP timeout. The default in cdpSessionManager
      // (10s) is conservative; legitimate work on heavy pages can exceed
      // it, and the timeout error message tells the LLM it can retry with
      // a higher value. Clamp to [1000, 120000] to keep the surface sane.
      let cdpTimeoutMs: number | undefined;
      if (typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs)) {
        cdpTimeoutMs = Math.max(1000, Math.min(params.timeoutMs, 120000));
      }

      // Execute the action and capture frame on success
      const result = tab.id
        ? await CDPHelper.withTimeout(tab.id, cdpTimeoutMs, () => this.executeAction(params, tab))
        : await this.executeAction(params, tab);

      // Trigger auto-capture on successful actions (except screenshot which is read-only)
      if (!result.isError && params.action !== 'screenshot' && params.action !== 'wait') {
        const actionType = this.mapActionToCapture(params.action);
        if (actionType) {
          // Convert to viewport-space coordinates for GIF overlays
          // params.coordinates may be screenshot-space when screenshot context exists
          const ctx = screenshotContextManager.getContext(tab.id);
          const toViewport = (c?: Coordinates): { x: number; y: number } | undefined => {
            if (!c) return undefined;
            if (!ctx) return { x: c.x, y: c.y };
            const scaled = scaleCoordinates(c.x, c.y, ctx);
            return { x: scaled.x, y: scaled.y };
          };

          const endCoords = toViewport(params.coordinates);
          const startCoords = toViewport(params.startCoordinates);

          await this.triggerAutoCapture(tab.id, actionType, {
            coordinateSpace: 'viewport',
            coordinates: endCoords,
            startCoordinates: startCoords,
            endCoordinates: actionType === 'drag' ? endCoords : undefined,
            text: params.text,
            ref: params.ref,
          });
        }
      }

      return result;
    } catch (error) {
      console.error('Error in computer tool:', error);
      return createErrorResponse(
        `Failed to execute action: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private mapActionToCapture(action: string): ActionType | null {
    const mapping: Record<string, ActionType> = {
      left_click: 'click',
      right_click: 'right_click',
      double_click: 'double_click',
      triple_click: 'triple_click',
      left_click_drag: 'drag',
      scroll: 'scroll',
      type: 'type',
      key: 'key',
      hover: 'hover',
      fill: 'fill',
      fill_form: 'fill',
      resize_page: 'other',
      scroll_to: 'scroll',
      zoom: 'other',
    };
    return mapping[action] || null;
  }

  /**
   * Build the deps bag passed to extracted action handlers so they can call
   * back into base-class helpers without inheriting from us.
   */
  private buildClickDeps(tab: chrome.tabs.Tab): ClickActionDeps {
    return {
      tab,
      project: (c) => {
        if (!c) return undefined;
        const ctx = screenshotContextManager.getContext(tab.id!);
        if (!ctx) return c;
        const scaled = scaleCoordinates(c.x, c.y, ctx);
        return { x: scaled.x, y: scaled.y };
      },
      injectContentScript: (tabId, files, injectImmediately, world, allFrames) =>
        this.injectContentScript(tabId, files, injectImmediately, world, allFrames),
      sendMessageToTab: (tabId, msg, frameId) => this.sendMessageToTab(tabId, msg, frameId),
    };
  }

  private async executeAction(params: ComputerParams, tab: chrome.tabs.Tab): Promise<ToolResult> {
    if (!tab.id) {
      return createErrorResponse(ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID');
    }

    // Helper to project coordinates using screenshot context when available
    const project = (c?: Coordinates): Coordinates | undefined => {
      if (!c) return undefined;
      const ctx = screenshotContextManager.getContext(tab.id!);
      if (!ctx) return c;
      const scaled = scaleCoordinates(c.x, c.y, ctx);
      return { x: scaled.x, y: scaled.y };
    };

    switch (params.action) {
      case 'resize_page':
        return handleResizePage(params, this.buildClickDeps(tab));
      case 'hover':
        return handleHover(params, this.buildClickDeps(tab));
      case 'left_click':
      case 'right_click':
        return handleClick(params, this.buildClickDeps(tab));
      case 'double_click':
      case 'triple_click':
        return handleMultiClick(params, this.buildClickDeps(tab));
      case 'left_click_drag':
        return handleLeftClickDrag(params, this.buildClickDeps(tab));
      case 'scroll':
        return handleScroll(params, this.buildClickDeps(tab));
      case 'type':
        return handleType(params, this.buildClickDeps(tab));
      case 'fill':
        return handleFill(params, this.buildClickDeps(tab));
      case 'fill_form':
        return handleFillForm(params, this.buildClickDeps(tab));
      case 'key':
        return handleKey(params, this.buildClickDeps(tab));
      case 'wait':
        return handleWait(params, this.buildClickDeps(tab));
      case 'scroll_to':
        return handleScrollTo(params, this.buildClickDeps(tab));
      case 'zoom':
        return handleZoom(params, this.buildClickDeps(tab));
      case 'screenshot':
        return handleScreenshot(params, this.buildClickDeps(tab));
      default:
        return createErrorResponse(`Unsupported action: ${params.action}`);
    }
  }

  /**
   * Trigger GIF auto-capture after a successful action.
   * This is a no-op if auto-capture is not active.
   */
  private async triggerAutoCapture(
    tabId: number,
    actionType: ActionType,
    metadata?: Partial<ActionMetadata>,
  ): Promise<void> {
    if (!isAutoCaptureActive(tabId)) {
      return;
    }

    try {
      await captureFrameOnAction(tabId, {
        type: actionType,
        ...metadata,
      });
    } catch (error) {
      // Log but don't fail the main action
      console.warn('[ComputerTool] Auto-capture failed:', error);
    }
  }
}

export const computerTool = new ComputerTool();
