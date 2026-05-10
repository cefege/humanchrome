/**
 * Click action handlers extracted from computer.ts (IMP-0054 slice 2).
 *
 * Each handler is a free function so the dispatcher in computer.ts can
 * delegate via a `Record<action, handler>` table without inheriting
 * BaseBrowserToolExecutor — the per-instance helpers (injectContentScript,
 * sendMessageToTab) and per-call resolved state (tab, project) are passed
 * via the deps object so handlers stay testable in isolation.
 */
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { TIMEOUTS } from '@/common/constants';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { screenshotContextManager } from '@/utils/screenshot-context';
import { clickTool } from '../../interaction';
import { CDPHelper } from '../cdp-helper';
import {
  checkDomainShift,
  type ComputerParams,
  type Coordinates,
  type MouseButton,
} from '../../computer';

export interface ClickActionDeps {
  tab: chrome.tabs.Tab;
  project: (c?: Coordinates) => Coordinates | undefined;
  injectContentScript: (
    tabId: number,
    files: string[],
    injectImmediately?: boolean,
    world?: 'MAIN' | 'ISOLATED',
    allFrames?: boolean,
  ) => Promise<void>;
  sendMessageToTab: (
    tabId: number,
    msg: Record<string, unknown>,
    frameId?: number,
  ) => Promise<{ success?: boolean; center?: { x: number; y: number }; [k: string]: unknown }>;
  domHoverFallback?: (
    tabId: number,
    coord: Coordinates,
    resolvedBy: string,
    ref?: string,
  ) => Promise<ToolResult>;
}

function modifierMaskFor(params: ComputerParams): number {
  return CDPHelper.modifierMask(
    [
      params.modifiers?.altKey ? 'alt' : undefined,
      params.modifiers?.ctrlKey ? 'ctrl' : undefined,
      params.modifiers?.metaKey ? 'meta' : undefined,
      params.modifiers?.shiftKey ? 'shift' : undefined,
    ].filter((v): v is string => typeof v === 'string'),
  );
}

/** Handles `left_click` and `right_click`. */
export async function handleClick(
  params: ComputerParams,
  deps: ClickActionDeps,
): Promise<ToolResult> {
  const { tab, project } = deps;
  const tabId = tab.id!;
  const modifiersMask = modifierMaskFor(params);

  if (params.ref) {
    return clickTool.execute({
      ref: params.ref,
      waitForNavigation: false,
      timeoutMs: TIMEOUTS.DEFAULT_WAIT * 5,
      button: params.action === 'right_click' ? 'right' : 'left',
      modifiers: params.modifiers,
    });
  }
  if (params.selector) {
    return clickTool.execute({
      selector: params.selector,
      selectorType: params.selectorType,
      frameId: params.frameId,
      waitForNavigation: false,
      timeoutMs: TIMEOUTS.DEFAULT_WAIT * 5,
      button: params.action === 'right_click' ? 'right' : 'left',
      modifiers: params.modifiers,
    });
  }
  if (!params.coordinates) {
    return createErrorResponse('Provide ref, selector, or coordinates for click action');
  }
  const stale = checkDomainShift(
    screenshotContextManager.getContext(tabId),
    tab.url,
    params.action,
  );
  if (stale) return stale;

  const coord = project(params.coordinates)!;
  // Prefer DOM path via existing click tool
  const domResult = await clickTool.execute({
    coordinates: coord,
    waitForNavigation: false,
    timeoutMs: TIMEOUTS.DEFAULT_WAIT * 5,
    button: params.action === 'right_click' ? 'right' : 'left',
    modifiers: params.modifiers,
  });
  if (!domResult.isError) return domResult;

  // Fallback to CDP if DOM failed
  try {
    await CDPHelper.attach(tabId);
    const button: MouseButton = params.action === 'right_click' ? 'right' : 'left';
    await CDPHelper.dispatchMouseEvent(tabId, {
      type: 'mouseMoved',
      x: coord.x,
      y: coord.y,
      button: 'none',
      buttons: 0,
      modifiers: modifiersMask,
    });
    await CDPHelper.dispatchMouseEvent(tabId, {
      type: 'mousePressed',
      x: coord.x,
      y: coord.y,
      button,
      buttons: button === 'left' ? 1 : 2,
      clickCount: 1,
      modifiers: modifiersMask,
    });
    await CDPHelper.dispatchMouseEvent(tabId, {
      type: 'mouseReleased',
      x: coord.x,
      y: coord.y,
      button,
      buttons: 0,
      clickCount: 1,
      modifiers: modifiersMask,
    });
    await CDPHelper.detach(tabId);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: true, action: params.action, coordinates: coord }),
        },
      ],
      isError: false,
    };
  } catch (e) {
    await CDPHelper.detach(tabId);
    return createErrorResponse(`CDP click failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Handles `double_click` and `triple_click`. */
export async function handleMultiClick(
  params: ComputerParams,
  deps: ClickActionDeps,
): Promise<ToolResult> {
  const { tab, project, injectContentScript, sendMessageToTab } = deps;
  const tabId = tab.id!;
  const modifiersMask = modifierMaskFor(params);

  if (!params.coordinates && !params.ref && !params.selector) {
    return createErrorResponse('Provide ref, selector, or coordinates for double/triple click');
  }

  let coord: Coordinates | undefined = params.coordinates ? project(params.coordinates) : undefined;

  if (params.ref) {
    try {
      await injectContentScript(tabId, ['inject-scripts/accessibility-tree-helper.js']);
      const resolved = await sendMessageToTab(tabId, {
        action: TOOL_MESSAGE_TYPES.RESOLVE_REF,
        ref: params.ref,
      });
      if (resolved && resolved.success && resolved.center) {
        coord = project({ x: resolved.center.x, y: resolved.center.y });
      }
    } catch {
      // ignore and use provided coordinates
    }
  } else if (params.selector) {
    try {
      await injectContentScript(tabId, ['inject-scripts/accessibility-tree-helper.js']);
      const selectorType = params.selectorType || 'css';
      const ensured = await sendMessageToTab(
        tabId,
        {
          action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
          selector: params.selector,
          isXPath: selectorType === 'xpath',
        },
        params.frameId,
      );
      if (ensured && ensured.success && ensured.center) {
        coord = project({ x: ensured.center.x, y: ensured.center.y });
      }
    } catch {
      // ignore
    }
  }

  if (!coord) return createErrorResponse('Failed to resolve coordinates from ref/selector');

  if (params.coordinates) {
    const stale = checkDomainShift(
      screenshotContextManager.getContext(tabId),
      tab.url,
      params.action,
    );
    if (stale) return stale;
  }

  try {
    await CDPHelper.attach(tabId);
    const button: MouseButton = 'left';
    const clickCount = params.action === 'double_click' ? 2 : 3;
    await CDPHelper.dispatchMouseEvent(tabId, {
      type: 'mouseMoved',
      x: coord.x,
      y: coord.y,
      button: 'none',
      buttons: 0,
      modifiers: modifiersMask,
    });
    for (let i = 1; i <= clickCount; i++) {
      await CDPHelper.dispatchMouseEvent(tabId, {
        type: 'mousePressed',
        x: coord.x,
        y: coord.y,
        button,
        buttons: 1,
        clickCount: i,
        modifiers: modifiersMask,
      });
      await CDPHelper.dispatchMouseEvent(tabId, {
        type: 'mouseReleased',
        x: coord.x,
        y: coord.y,
        button,
        buttons: 0,
        clickCount: i,
        modifiers: modifiersMask,
      });
    }
    await CDPHelper.detach(tabId);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: true, action: params.action, coordinates: coord }),
        },
      ],
      isError: false,
    };
  } catch (e) {
    await CDPHelper.detach(tabId);
    return createErrorResponse(
      `CDP ${params.action} failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Handles `left_click_drag`. */
export async function handleLeftClickDrag(
  params: ComputerParams,
  deps: ClickActionDeps,
): Promise<ToolResult> {
  const { tab, project, injectContentScript, sendMessageToTab } = deps;
  const tabId = tab.id!;

  if (!params.startCoordinates && !params.startRef) {
    return createErrorResponse('Provide startRef or startCoordinates for drag');
  }
  if (!params.coordinates && !params.ref) {
    return createErrorResponse('Provide ref or end coordinates for drag');
  }

  let start: Coordinates | undefined = params.startCoordinates
    ? project(params.startCoordinates)
    : undefined;
  let end: Coordinates | undefined = params.coordinates ? project(params.coordinates) : undefined;

  if (params.startCoordinates || params.coordinates) {
    const stale = checkDomainShift(
      screenshotContextManager.getContext(tabId),
      tab.url,
      'left_click_drag',
    );
    if (stale) return stale;
  }

  if (params.startRef || params.ref) {
    await injectContentScript(tabId, ['inject-scripts/accessibility-tree-helper.js']);
  }
  if (params.startRef) {
    try {
      const resolved = await sendMessageToTab(tabId, {
        action: TOOL_MESSAGE_TYPES.RESOLVE_REF,
        ref: params.startRef,
      });
      if (resolved && resolved.success && resolved.center) {
        start = project({ x: resolved.center.x, y: resolved.center.y });
      }
    } catch {
      // ignore
    }
  }
  if (params.ref) {
    try {
      const resolved = await sendMessageToTab(tabId, {
        action: TOOL_MESSAGE_TYPES.RESOLVE_REF,
        ref: params.ref,
      });
      if (resolved && resolved.success && resolved.center) {
        end = project({ x: resolved.center.x, y: resolved.center.y });
      }
    } catch {
      // ignore
    }
  }

  if (!start || !end) return createErrorResponse('Failed to resolve drag coordinates');

  try {
    await CDPHelper.attach(tabId);
    await CDPHelper.dispatchMouseEvent(tabId, {
      type: 'mouseMoved',
      x: start.x,
      y: start.y,
      button: 'none',
      buttons: 0,
    });
    await CDPHelper.dispatchMouseEvent(tabId, {
      type: 'mousePressed',
      x: start.x,
      y: start.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await CDPHelper.dispatchMouseEvent(tabId, {
      type: 'mouseMoved',
      x: end.x,
      y: end.y,
      button: 'left',
      buttons: 1,
    });
    await CDPHelper.dispatchMouseEvent(tabId, {
      type: 'mouseReleased',
      x: end.x,
      y: end.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
    await CDPHelper.detach(tabId);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: true, action: 'left_click_drag', start, end }),
        },
      ],
      isError: false,
    };
  } catch (e) {
    await CDPHelper.detach(tabId);
    return createErrorResponse(`Drag failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
