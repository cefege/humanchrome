import { builderPolicy } from 'humanchrome-shared';

// Simple in-memory screenshot context manager per tab
// Used to scale coordinates from screenshot space to viewport space

export interface ScreenshotContext {
  // Final screenshot dimensions (in CSS pixels after any scaling)
  screenshotWidth: number;
  screenshotHeight: number;
  // Viewport dimensions (CSS pixels)
  viewportWidth: number;
  viewportHeight: number;
  // Device pixel ratio at capture time (optional, for reference)
  devicePixelRatio?: number;
  // Hostname of the page when the screenshot was taken (used for domain safety checks)
  hostname?: string;
  // Timestamp
  timestamp: number;
}

const contexts = new Map<number, ScreenshotContext>();

export const screenshotContextManager = {
  setContext(tabId: number, ctx: Omit<ScreenshotContext, 'timestamp'>) {
    contexts.set(tabId, { ...ctx, timestamp: Date.now() });
  },
  getContext(tabId: number): ScreenshotContext | undefined {
    const ctx = contexts.get(tabId);
    if (!ctx) return undefined;
    if (builderPolicy.builderScreenshotContextExpired(ctx.timestamp, Date.now())) {
      contexts.delete(tabId);
      return undefined;
    }
    return ctx;
  },
  clear(tabId: number) {
    contexts.delete(tabId);
  },
};

// Scale screenshot-space coordinates (x,y) to viewport CSS pixels
export function scaleCoordinates(
  x: number,
  y: number,
  ctx: ScreenshotContext,
): { x: number; y: number } {
  return builderPolicy.builderScaleScreenshotCoordinates({
    x,
    y,
    screenshotWidth: ctx.screenshotWidth,
    screenshotHeight: ctx.screenshotHeight,
    viewportWidth: ctx.viewportWidth,
    viewportHeight: ctx.viewportHeight,
  });
}
