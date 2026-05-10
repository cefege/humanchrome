/**
 * Scroll + zoom action handlers extracted from computer.ts (IMP-0054 slice 3).
 *
 * Reuses the deps bag shape from click-actions; identical needs (tab,
 * project, injectContentScript, sendMessageToTab). When all action slices
 * land we'll consolidate into a shared ActionDeps in a barrel file.
 */
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { screenshotContextManager } from '@/utils/screenshot-context';
import { CDPHelper } from '../cdp-helper';
import { checkDomainShift, type ComputerParams, type Coordinates } from '../../computer';
import { type ClickActionDeps } from './click-actions';

export type ScrollActionDeps = ClickActionDeps;

interface LayoutViewport {
  clientWidth?: number;
  clientHeight?: number;
  pageX?: number;
  pageY?: number;
}

/** Handles `scroll`. */
export async function handleScroll(
  params: ComputerParams,
  deps: ScrollActionDeps,
): Promise<ToolResult> {
  const { tab, project, injectContentScript, sendMessageToTab } = deps;
  const tabId = tab.id!;

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
      // ignore
    }
  }

  // No ref/coordinates: scroll the page itself by dispatching the wheel
  // at the viewport center. CDP's mouseWheel routes the event to whatever
  // element is at that point; on a typical page that scrolls the document
  // the same way a user spinning the wheel would.
  if (!coord) {
    try {
      await CDPHelper.attach(tabId);
      const metrics = (await CDPHelper.send(tabId, 'Page.getLayoutMetrics', {})) as {
        layoutViewport?: LayoutViewport;
        visualViewport?: LayoutViewport;
      };
      const viewport: LayoutViewport = metrics?.layoutViewport ||
        metrics?.visualViewport || { clientWidth: 800, clientHeight: 600 };
      const vw = Math.round(Number(viewport.clientWidth || 800));
      const vh = Math.round(Number(viewport.clientHeight || 600));
      coord = { x: Math.floor(vw / 2), y: Math.floor(vh / 2) };
    } catch {
      coord = { x: 400, y: 400 };
    }
  }
  if (!coord) return createErrorResponse('Failed to resolve scroll coordinates');
  if (params.coordinates) {
    const stale = checkDomainShift(screenshotContextManager.getContext(tabId), tab.url, 'scroll');
    if (stale) return stale;
  }

  const direction = params.scrollDirection || 'down';
  const amount = Math.max(1, Math.min(params.scrollAmount || 3, 10));
  const unit = 100; // ~px per tick
  let deltaX = 0;
  let deltaY = 0;
  if (direction === 'up') deltaY = -amount * unit;
  if (direction === 'down') deltaY = amount * unit;
  if (direction === 'left') deltaX = -amount * unit;
  if (direction === 'right') deltaX = amount * unit;

  try {
    await CDPHelper.attach(tabId);
    await CDPHelper.dispatchMouseEvent(tabId, {
      type: 'mouseWheel',
      x: coord.x,
      y: coord.y,
      deltaX,
      deltaY,
    });
    await CDPHelper.detach(tabId);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            action: 'scroll',
            coordinates: coord,
            deltaX,
            deltaY,
          }),
        },
      ],
      isError: false,
    };
  } catch (e) {
    await CDPHelper.detach(tabId);
    return createErrorResponse(`Scroll failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Handles `scroll_to` (ref-based focus). */
export async function handleScrollTo(
  params: ComputerParams,
  deps: ScrollActionDeps,
): Promise<ToolResult> {
  const { tab, injectContentScript, sendMessageToTab } = deps;
  const tabId = tab.id!;

  if (!params.ref) {
    return createErrorResponse('ref is required for scroll_to action');
  }
  try {
    await injectContentScript(tabId, ['inject-scripts/accessibility-tree-helper.js']);
    const resp = await sendMessageToTab(tabId, {
      action: 'focusByRef',
      ref: params.ref,
    });
    if (!resp || resp.success !== true) {
      return createErrorResponse(
        (typeof resp?.error === 'string' ? resp.error : undefined) ||
          'scroll_to failed: element not found',
      );
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: true, action: 'scroll_to', ref: params.ref }),
        },
      ],
      isError: false,
    };
  } catch (e) {
    return createErrorResponse(`scroll_to failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Handles `zoom` — captures a CDP screenshot of the requested screenshot-space region. */
export async function handleZoom(
  params: ComputerParams,
  deps: ScrollActionDeps,
): Promise<ToolResult> {
  const { tab, project } = deps;
  const tabId = tab.id!;

  const region = params.region;
  if (!region) {
    return createErrorResponse('region is required for zoom action');
  }
  const x0 = Number(region.x0);
  const y0 = Number(region.y0);
  const x1 = Number(region.x1);
  const y1 = Number(region.y1);
  if (![x0, y0, x1, y1].every(Number.isFinite)) {
    return createErrorResponse('region must contain finite numbers (x0, y0, x1, y1)');
  }
  if (x0 < 0 || y0 < 0 || x1 <= x0 || y1 <= y0) {
    return createErrorResponse('Invalid region: require x0>=0, y0>=0 and x1>x0, y1>y0');
  }

  // Project coordinates from screenshot space to viewport space
  const p0 = project({ x: x0, y: y0 })!;
  const p1 = project({ x: x1, y: y1 })!;
  const rx0 = Math.min(p0.x, p1.x);
  const ry0 = Math.min(p0.y, p1.y);
  const rx1 = Math.max(p0.x, p1.x);
  const ry1 = Math.max(p0.y, p1.y);
  const w = rx1 - rx0;
  const h = ry1 - ry0;
  if (w <= 0 || h <= 0) {
    return createErrorResponse('Invalid region after projection');
  }

  const stale = checkDomainShift(
    screenshotContextManager.getContext(tabId),
    tab.url,
    'zoom',
    'first',
  );
  if (stale) return stale;

  try {
    await CDPHelper.attach(tabId);
    const metrics = (await CDPHelper.send(tabId, 'Page.getLayoutMetrics', {})) as {
      layoutViewport?: LayoutViewport;
      visualViewport?: LayoutViewport;
    };
    const viewport: LayoutViewport = metrics?.layoutViewport ||
      metrics?.visualViewport || {
        clientWidth: 800,
        clientHeight: 600,
        pageX: 0,
        pageY: 0,
      };
    const vw = Math.round(Number(viewport.clientWidth || 800));
    const vh = Math.round(Number(viewport.clientHeight || 600));
    if (rx1 > vw || ry1 > vh) {
      await CDPHelper.detach(tabId);
      return createErrorResponse(
        `Region exceeds viewport boundaries (${vw}x${vh}). Choose a region within the visible viewport.`,
      );
    }
    const pageX = Number(viewport.pageX || 0);
    const pageY = Number(viewport.pageY || 0);

    const shot = (await CDPHelper.send(tabId, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      fromSurface: true,
      clip: {
        x: pageX + rx0,
        y: pageY + ry0,
        width: w,
        height: h,
        scale: 1,
      },
    })) as { data?: string };
    await CDPHelper.detach(tabId);

    const base64Data = String(shot?.data || '');
    if (!base64Data) {
      return createErrorResponse('Failed to capture zoom screenshot via CDP');
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            action: 'zoom',
            mimeType: 'image/png',
            base64Data,
            region: { x0: rx0, y0: ry0, x1: rx1, y1: ry1 },
          }),
        },
      ],
      isError: false,
    };
  } catch (e) {
    await CDPHelper.detach(tabId);
    return createErrorResponse(`zoom failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
