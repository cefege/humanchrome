/**
 * Misc utilities for the GIF recorder (IMP-0130 split).
 */
import type { ToolResult } from '@/common/tool-handler';
import type { GifResult } from './state';

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read blob'));
    reader.readAsDataURL(blob);
  });
}

export function normalizePositiveInt(value: unknown, fallback: number, max?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  const result = Math.max(1, Math.floor(value));
  return max !== undefined ? Math.min(result, max) : result;
}

export function isRestrictedUrl(url?: string): boolean {
  if (!url) return false;
  return (
    url.startsWith('chrome://') ||
    url.startsWith('edge://') ||
    url.startsWith('https://chrome.google.com/webstore') ||
    url.startsWith('https://microsoftedge.microsoft.com/')
  );
}

export function buildResponse(result: GifResult): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    isError: !result.success,
  };
}

/**
 * Shared dependencies passed from the dispatcher class to each action
 * handler. Mirrors the `ClickActionDeps` pattern used in the
 * computer/actions/ split — handlers stay free functions and can be
 * unit-tested without instantiating the tool class.
 */
export interface GifActionDeps {
  resolveTargetTab: (tabId?: number) => Promise<chrome.tabs.Tab | null>;
  injectContentScript: (tabId: number, files: string[]) => Promise<void>;
  sendMessageToTab: (
    tabId: number,
    message: Record<string, unknown>,
    frameId?: number,
  ) => Promise<{ success?: boolean; center?: { x: number; y: number }; [k: string]: unknown }>;
}
