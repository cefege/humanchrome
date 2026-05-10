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
import { ERROR_MESSAGES, TIMEOUTS } from '@/common/constants';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { clickTool, fillTool } from './interaction';
import { keyboardTool } from './keyboard';
import { screenshotTool } from './screenshot';
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
      injectContentScript: (tabId, files) => this.injectContentScript(tabId, files),
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
      case 'resize_page': {
        // Accept dimensions either via dedicated width/height (preferred)
        // or as a fallback through text/value/coordinates so older callers
        // that piggybacked these slots before width/height existed still
        // work.
        const widthFallback = Number(params.coordinates?.x ?? params.text);
        const heightFallback = Number(params.coordinates?.y ?? params.value);
        const w = Number(params.width ?? widthFallback);
        const h = Number(params.height ?? heightFallback);
        if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
          return createErrorResponse('Provide width and height for resize_page (positive numbers)');
        }
        try {
          // Prefer precise CDP emulation
          await CDPHelper.attach(tab.id);
          try {
            await CDPHelper.send(tab.id, 'Emulation.setDeviceMetricsOverride', {
              width: Math.round(w),
              height: Math.round(h),
              deviceScaleFactor: 0,
              mobile: false,
              screenWidth: Math.round(w),
              screenHeight: Math.round(h),
            });
          } finally {
            await CDPHelper.detach(tab.id);
          }
        } catch (e) {
          // Fallback: window resize
          if (tab.windowId !== undefined) {
            await chrome.windows.update(tab.windowId, {
              width: Math.round(w),
              height: Math.round(h),
            });
          } else {
            return createErrorResponse(
              `Failed to resize via CDP and cannot determine windowId: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, action: 'resize_page', width: w, height: h }),
            },
          ],
          isError: false,
        };
      }
      case 'hover': {
        // Resolve target point from ref | selector | coordinates
        let coord: Coordinates | undefined = undefined;
        let resolvedBy: 'ref' | 'selector' | 'coordinates' | undefined;

        try {
          if (params.ref) {
            await this.injectContentScript(tab.id, ['inject-scripts/accessibility-tree-helper.js']);
            // Scroll element into view first to ensure it's visible
            try {
              await this.sendMessageToTab(tab.id, { action: 'focusByRef', ref: params.ref });
            } catch {
              // Best effort - continue even if scroll fails
            }
            // Re-resolve coordinates after scroll
            const resolved = await this.sendMessageToTab(tab.id, {
              action: TOOL_MESSAGE_TYPES.RESOLVE_REF,
              ref: params.ref,
            });
            if (resolved && resolved.success) {
              coord = project({ x: resolved.center.x, y: resolved.center.y });
              resolvedBy = 'ref';
            }
          } else if (params.selector) {
            await this.injectContentScript(tab.id, ['inject-scripts/accessibility-tree-helper.js']);
            const selectorType = params.selectorType || 'css';
            const ensured = await this.sendMessageToTab(tab.id, {
              action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
              selector: params.selector,
              isXPath: selectorType === 'xpath',
            });
            if (ensured && ensured.success) {
              // Scroll element into view first to ensure it's visible
              const resolvedRef = typeof ensured.ref === 'string' ? ensured.ref : undefined;
              if (resolvedRef) {
                try {
                  await this.sendMessageToTab(tab.id, { action: 'focusByRef', ref: resolvedRef });
                } catch {
                  // Best effort - continue even if scroll fails
                }
                // Re-resolve coordinates after scroll
                const reResolved = await this.sendMessageToTab(tab.id, {
                  action: TOOL_MESSAGE_TYPES.RESOLVE_REF,
                  ref: resolvedRef,
                });
                if (reResolved && reResolved.success) {
                  coord = project({ x: reResolved.center.x, y: reResolved.center.y });
                } else {
                  coord = project({ x: ensured.center.x, y: ensured.center.y });
                }
              } else {
                coord = project({ x: ensured.center.x, y: ensured.center.y });
              }
              resolvedBy = 'selector';
            }
          } else if (params.coordinates) {
            coord = project(params.coordinates);
            resolvedBy = 'coordinates';
          }
        } catch (e) {
          // fall through to error handling below
        }

        if (!coord)
          return createErrorResponse(
            'Provide ref or selector or coordinates for hover, or failed to resolve target',
          );
        if (params.coordinates) {
          const stale = checkDomainShift(
            screenshotContextManager.getContext(tab.id!),
            tab.url,
            'hover',
          );
          if (stale) return stale;
        }

        try {
          await CDPHelper.attach(tab.id);
          try {
            // Move pointer to target. We can dispatch a single mouseMoved; browsers will generate mouseover/mouseenter as needed.
            await CDPHelper.dispatchMouseEvent(tab.id, {
              type: 'mouseMoved',
              x: coord.x,
              y: coord.y,
              button: 'none',
              buttons: 0,
            });
          } finally {
            await CDPHelper.detach(tab.id);
          }

          // Optional hold to allow UI (menus/tooltips) to appear
          const holdMs = Math.max(
            0,
            Math.min(params.duration ? params.duration * 1000 : 400, 5000),
          );
          if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  action: 'hover',
                  coordinates: coord,
                  resolvedBy,
                  transport: 'cdp',
                }),
              },
            ],
            isError: false,
          };
        } catch (error) {
          console.warn('[ComputerTool] CDP hover failed, attempting DOM fallback', error);
          return await this.domHoverFallback(tab.id, coord, resolvedBy, params.ref);
        }
      }
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
      case 'type': {
        if (!params.text) return createErrorResponse('Text parameter is required for type action');
        try {
          // Optional focus via ref before typing
          if (params.ref) {
            await clickTool.execute({
              ref: params.ref,
              waitForNavigation: false,
              timeoutMs: TIMEOUTS.DEFAULT_WAIT * 5,
            });
          }
          await CDPHelper.attach(tab.id);
          // Use CDP insertText to avoid complex KeyboardEvent emulation for long text
          await CDPHelper.insertText(tab.id, params.text);
          await CDPHelper.detach(tab.id);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  action: 'type',
                  length: params.text.length,
                }),
              },
            ],
            isError: false,
          };
        } catch (e) {
          await CDPHelper.detach(tab.id);
          // Fallback to DOM-based keyboard tool
          const res = await keyboardTool.execute({
            keys: params.text.split('').join(','),
            delay: 0,
            selector: undefined,
          });
          return res;
        }
      }
      case 'fill': {
        if (!params.ref && !params.selector) {
          return createErrorResponse('Provide ref or selector and a value for fill');
        }
        if (params.value === undefined) {
          return createErrorResponse('Provide a value for fill');
        }
        // Reuse existing fill tool to leverage robust DOM event behavior
        const res = await fillTool.execute({
          selector: params.selector,
          selectorType: params.selectorType,
          ref: params.ref,
          value: params.value,
          tabId: params.tabId,
          windowId: params.windowId,
          frameId: params.frameId,
        });
        return res;
      }
      case 'fill_form': {
        const elements = params.elements;
        if (!Array.isArray(elements) || elements.length === 0) {
          return createErrorResponse('elements must be a non-empty array for fill_form');
        }
        const results: Array<{ ref: string; ok: boolean; error?: string }> = [];
        for (const item of elements) {
          if (!item || !item.ref) {
            results.push({ ref: String(item?.ref || ''), ok: false, error: 'missing ref' });
            continue;
          }
          try {
            const r = await fillTool.execute({
              ref: item.ref,
              value: item.value,
              tabId: params.tabId,
              windowId: params.windowId,
              frameId: params.frameId,
            });
            const ok = !r.isError;
            results.push({ ref: item.ref, ok, error: ok ? undefined : 'failed' });
          } catch (e) {
            results.push({
              ref: item.ref,
              ok: false,
              error: String(e instanceof Error ? e.message : e),
            });
          }
        }
        const successCount = results.filter((r) => r.ok).length;
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                action: 'fill_form',
                filled: successCount,
                total: results.length,
                results,
              }),
            },
          ],
          isError: false,
        };
      }
      case 'key': {
        if (!params.text)
          return createErrorResponse(
            'text is required for key action (e.g., "Backspace Backspace Enter" or "cmd+a")',
          );
        const tokens = params.text.trim().split(/\s+/).filter(Boolean);
        const repeat = params.repeat ?? 1;
        if (!Number.isInteger(repeat) || repeat < 1 || repeat > 100) {
          return createErrorResponse('repeat must be an integer between 1 and 100 for key action');
        }
        try {
          // Optional focus via ref before key events
          if (params.ref) {
            await clickTool.execute({
              ref: params.ref,
              waitForNavigation: false,
              timeoutMs: TIMEOUTS.DEFAULT_WAIT * 5,
            });
          }
          await CDPHelper.attach(tab.id);
          for (let i = 0; i < repeat; i++) {
            for (const t of tokens) {
              if (t.includes('+')) await CDPHelper.dispatchKeyChord(tab.id, t);
              else await CDPHelper.dispatchSimpleKey(tab.id, t);
            }
          }
          await CDPHelper.detach(tab.id);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ success: true, action: 'key', keys: tokens, repeat }),
              },
            ],
            isError: false,
          };
        } catch (e) {
          await CDPHelper.detach(tab.id);
          // Fallback to DOM keyboard simulation (comma-separated combinations)
          const keysStr = tokens.join(',');
          const repeatedKeys =
            repeat === 1 ? keysStr : Array.from({ length: repeat }, () => keysStr).join(',');
          const res = await keyboardTool.execute({ keys: repeatedKeys });
          return res;
        }
      }
      case 'wait': {
        const waitText = typeof params.text === 'string' ? params.text : '';
        const hasTextCondition = waitText.trim().length > 0;
        if (hasTextCondition) {
          try {
            // Conditional wait for text appearance/disappearance using content script
            await this.injectContentScript(
              tab.id,
              ['inject-scripts/wait-helper.js'],
              false,
              'ISOLATED',
              true,
            );
            const appear = params.appear !== false; // default to true
            const timeoutMs = Math.max(0, Math.min(params.timeoutMs ?? 10000, 120000));
            const resp = await this.sendMessageToTab(tab.id, {
              action: TOOL_MESSAGE_TYPES.WAIT_FOR_TEXT,
              text: waitText,
              appear,
              timeout: timeoutMs,
            });
            if (!resp || resp.success !== true) {
              return createErrorResponse(
                resp && resp.reason === 'timeout'
                  ? `wait_for timed out after ${timeoutMs}ms for text: ${waitText}`
                  : `wait_for failed: ${resp && resp.error ? resp.error : 'unknown error'}`,
              );
            }
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    action: 'wait_for',
                    appear,
                    text: waitText,
                    matched: resp.matched || null,
                    tookMs: resp.tookMs,
                  }),
                },
              ],
              isError: false,
            };
          } catch (e) {
            return createErrorResponse(
              `wait_for failed: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        } else {
          const seconds = Math.max(0, Math.min(params.duration ?? 0, 30));
          if (!seconds)
            return createErrorResponse('Duration parameter is required and must be > 0');
          await new Promise((r) => setTimeout(r, seconds * 1000));
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ success: true, action: 'wait', duration: seconds }),
              },
            ],
            isError: false,
          };
        }
      }
      case 'scroll_to':
        return handleScrollTo(params, this.buildClickDeps(tab));
      case 'zoom':
        return handleZoom(params, this.buildClickDeps(tab));
      case 'screenshot': {
        // Reuse existing screenshot tool; it already supports base64 save option
        const result = await screenshotTool.execute({
          name: 'computer',
          storeBase64: true,
          fullPage: false,
        });
        return result;
      }
      default:
        return createErrorResponse(`Unsupported action: ${params.action}`);
    }
  }

  /**
   * DOM-based hover fallback when CDP is unavailable
   * Tries ref-based approach first (works with iframes), falls back to coordinates
   */
  private async domHoverFallback(
    tabId: number,
    coord?: Coordinates,
    resolvedBy?: 'ref' | 'selector' | 'coordinates',
    ref?: string,
  ): Promise<ToolResult> {
    // Try ref-based approach first (handles iframes correctly)
    if (ref) {
      try {
        const resp = await this.sendMessageToTab(tabId, {
          action: TOOL_MESSAGE_TYPES.DISPATCH_HOVER_FOR_REF,
          ref,
        });
        if (resp?.success) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  action: 'hover',
                  resolvedBy: 'ref',
                  transport: 'dom-ref',
                  target: resp.target,
                }),
              },
            ],
            isError: false,
          };
        }
      } catch (error) {
        console.warn('[ComputerTool] DOM ref hover failed, falling back to coordinates', error);
      }
    }

    // Fallback to coordinate-based approach
    if (!coord) {
      return createErrorResponse('Hover fallback requires coordinates or ref');
    }

    try {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (point) => {
          const target = document.elementFromPoint(point.x, point.y);
          if (!target) {
            return { success: false, error: 'No element found at coordinates' };
          }

          // Dispatch hover-related events
          for (const type of ['mousemove', 'mouseover', 'mouseenter']) {
            target.dispatchEvent(
              new MouseEvent(type, {
                bubbles: true,
                cancelable: true,
                clientX: point.x,
                clientY: point.y,
                view: window,
              }),
            );
          }

          return {
            success: true,
            target: {
              tagName: target.tagName,
              id: target.id,
              className: target.className,
              text: target.textContent?.trim()?.slice(0, 100) || '',
            },
          };
        },
        args: [coord],
      });

      const payload = injection?.result;
      if (!payload?.success) {
        return createErrorResponse(payload?.error || 'DOM hover fallback failed');
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              action: 'hover',
              coordinates: coord,
              resolvedBy,
              transport: 'dom',
              target: payload.target,
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      return createErrorResponse(
        `DOM hover fallback failed: ${error instanceof Error ? error.message : String(error)}`,
      );
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
