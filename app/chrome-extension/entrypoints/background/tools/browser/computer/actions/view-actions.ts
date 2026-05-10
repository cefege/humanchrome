/**
 * View action handlers extracted from computer.ts (IMP-0054 slice 5).
 * Covers `resize_page`, `hover` (and its DOM fallback), and `screenshot`.
 *
 * Same deps bag shape as click/scroll/input — see ClickActionDeps.
 */
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { screenshotContextManager } from '@/utils/screenshot-context';
import { CDPHelper } from '../cdp-helper';
import { screenshotTool } from '../../screenshot';
import { checkDomainShift, type ComputerParams, type Coordinates } from '../../computer';
import { type ClickActionDeps } from './click-actions';

export type ViewActionDeps = ClickActionDeps;

/** Handles `resize_page`. */
export async function handleResizePage(
  params: ComputerParams,
  deps: ViewActionDeps,
): Promise<ToolResult> {
  const { tab } = deps;
  const tabId = tab.id!;

  // Accept dimensions either via dedicated width/height (preferred) or as a
  // fallback through text/value/coordinates so older callers that piggybacked
  // those slots before width/height existed still work.
  const widthFallback = Number(params.coordinates?.x ?? params.text);
  const heightFallback = Number(params.coordinates?.y ?? params.value);
  const w = Number(params.width ?? widthFallback);
  const h = Number(params.height ?? heightFallback);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return createErrorResponse('Provide width and height for resize_page (positive numbers)');
  }

  try {
    await CDPHelper.attach(tabId);
    try {
      await CDPHelper.send(tabId, 'Emulation.setDeviceMetricsOverride', {
        width: Math.round(w),
        height: Math.round(h),
        deviceScaleFactor: 0,
        mobile: false,
        screenWidth: Math.round(w),
        screenHeight: Math.round(h),
      });
    } finally {
      await CDPHelper.detach(tabId);
    }
  } catch (e) {
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

/** Handles `hover` — CDP path with DOM fallback. */
export async function handleHover(
  params: ComputerParams,
  deps: ViewActionDeps,
): Promise<ToolResult> {
  const { tab, project, injectContentScript, sendMessageToTab } = deps;
  const tabId = tab.id!;

  let coord: Coordinates | undefined;
  let resolvedBy: 'ref' | 'selector' | 'coordinates' | undefined;

  try {
    if (params.ref) {
      await injectContentScript(tabId, ['inject-scripts/accessibility-tree-helper.js']);
      try {
        await sendMessageToTab(tabId, { action: 'focusByRef', ref: params.ref });
      } catch {
        // best effort
      }
      const resolved = await sendMessageToTab(tabId, {
        action: TOOL_MESSAGE_TYPES.RESOLVE_REF,
        ref: params.ref,
      });
      if (resolved && resolved.success && resolved.center) {
        coord = project({ x: resolved.center.x, y: resolved.center.y });
        resolvedBy = 'ref';
      }
    } else if (params.selector) {
      await injectContentScript(tabId, ['inject-scripts/accessibility-tree-helper.js']);
      const selectorType = params.selectorType || 'css';
      const ensured = await sendMessageToTab(tabId, {
        action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
        selector: params.selector,
        isXPath: selectorType === 'xpath',
      });
      if (ensured && ensured.success && ensured.center) {
        const resolvedRef = typeof ensured.ref === 'string' ? ensured.ref : undefined;
        if (resolvedRef) {
          try {
            await sendMessageToTab(tabId, { action: 'focusByRef', ref: resolvedRef });
          } catch {
            // best effort
          }
          const reResolved = await sendMessageToTab(tabId, {
            action: TOOL_MESSAGE_TYPES.RESOLVE_REF,
            ref: resolvedRef,
          });
          if (reResolved && reResolved.success && reResolved.center) {
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
  } catch {
    // fall through to error handling below
  }

  if (!coord) {
    return createErrorResponse(
      'Provide ref or selector or coordinates for hover, or failed to resolve target',
    );
  }
  if (params.coordinates) {
    const stale = checkDomainShift(screenshotContextManager.getContext(tabId), tab.url, 'hover');
    if (stale) return stale;
  }

  try {
    await CDPHelper.attach(tabId);
    try {
      // Single mouseMoved is enough; the browser synthesizes mouseover/mouseenter.
      await CDPHelper.dispatchMouseEvent(tabId, {
        type: 'mouseMoved',
        x: coord.x,
        y: coord.y,
        button: 'none',
        buttons: 0,
      });
    } finally {
      await CDPHelper.detach(tabId);
    }

    // Optional hold to allow UI (menus/tooltips) to appear
    const holdMs = Math.max(0, Math.min(params.duration ? params.duration * 1000 : 400, 5000));
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
    return domHoverFallback(tabId, sendMessageToTab, coord, resolvedBy, params.ref);
  }
}

/** DOM-based hover fallback when CDP is unavailable.
 *  Tries ref-based dispatch first (works with iframes), falls back to coordinates. */
async function domHoverFallback(
  tabId: number,
  sendMessageToTab: ViewActionDeps['sendMessageToTab'],
  coord?: Coordinates,
  resolvedBy?: 'ref' | 'selector' | 'coordinates',
  ref?: string,
): Promise<ToolResult> {
  if (ref) {
    try {
      const resp = await sendMessageToTab(tabId, {
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

/** Handles `screenshot` — thin delegation to the standalone screenshot tool. */
export async function handleScreenshot(
  _params: ComputerParams,
  _deps: ViewActionDeps,
): Promise<ToolResult> {
  return screenshotTool.execute({
    name: 'computer',
    storeBase64: true,
    fullPage: false,
  });
}
