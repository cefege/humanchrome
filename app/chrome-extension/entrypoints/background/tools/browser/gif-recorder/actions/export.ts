/**
 * GIF recorder `action: 'export'` handler — re-uses the cached last
 * recording for either a download or a drag&drop file upload into a
 * page element.
 */
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import {
  EXPORT_CACHE_LIFETIME_MS,
  getLastRecordedGif,
  setLastRecordedGif,
  type GifRecorderParams,
  type GifResult,
} from '../state';
import { blobToDataUrl, buildResponse, isRestrictedUrl, type GifActionDeps } from '../utils';

export async function runExport(
  deps: GifActionDeps,
  args: GifRecorderParams,
): Promise<ToolResult> {
  // Export the last recorded GIF (download or drag&drop upload)

  // Check if cache is valid
  const cached = getLastRecordedGif();
  if (!cached) {
    return createErrorResponse(
      'No recorded GIF available for export. Use action="stop" to finish a recording first.',
    );
  }

  // Check cache expiration
  if (Date.now() - cached.createdAt > EXPORT_CACHE_LIFETIME_MS) {
    setLastRecordedGif(null);
    return createErrorResponse('Cached GIF has expired. Please record a new GIF.');
  }

  const download = args.download !== false; // Default to download

  if (download) {
    // Download mode
    // Reconstruct as Uint8Array<ArrayBuffer> so it satisfies BlobPart under newer TS lib.
    const blob = new Blob([new Uint8Array(cached.gifData)], { type: 'image/gif' });
    const dataUrl = await blobToDataUrl(blob);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = args.filename ?? cached.filename;
    const outputFilename = filename?.replace(/[^a-z0-9_-]/gi, '_') || `export_${timestamp}`;
    const fullFilename = outputFilename.endsWith('.gif') ? outputFilename : `${outputFilename}.gif`;

    const downloadId = await chrome.downloads.download({
      url: dataUrl,
      filename: fullFilename,
      saveAs: false,
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    let fullPath: string | undefined;
    try {
      const [downloadItem] = await chrome.downloads.search({ id: downloadId });
      fullPath = downloadItem?.filename;
    } catch {
      // Ignore
    }

    return buildResponse({
      success: true,
      action: 'export',
      mode: cached.mode,
      frameCount: cached.frameCount,
      durationMs: cached.durationMs,
      byteLength: cached.gifData.byteLength,
      downloadId,
      filename: fullFilename,
      fullPath,
    });
  }

  // Drag&drop upload mode
  const { coordinates, ref, selector } = args;

  if (!coordinates && !ref && !selector) {
    return createErrorResponse(
      'For drag&drop upload, provide coordinates, ref, or selector to identify the drop target.',
    );
  }

  // Resolve target tab
  const tab = await deps.resolveTargetTab(args.tabId);
  if (!tab?.id) {
    return createErrorResponse(
      typeof args.tabId === 'number' ? `Tab not found: ${args.tabId}` : 'No active tab found',
    );
  }

  // Security check
  if (isRestrictedUrl(tab.url)) {
    return createErrorResponse('Cannot upload to special browser pages or web store pages.');
  }

  // Prepare GIF data as base64
  const gifBase64 = btoa(
    Array.from(cached.gifData)
      .map((b) => String.fromCharCode(b))
      .join(''),
  );

  // Resolve drop target coordinates
  let targetX: number | undefined;
  let targetY: number | undefined;

  if (ref) {
    // Use the project's built-in ref resolution mechanism
    try {
      await deps.injectContentScript(tab.id, ['inject-scripts/accessibility-tree-helper.js']);
      const resolved = await deps.sendMessageToTab(tab.id, {
        action: TOOL_MESSAGE_TYPES.RESOLVE_REF,
        ref,
      });
      if (resolved?.success && resolved.center) {
        targetX = resolved.center.x;
        targetY = resolved.center.y;
      } else {
        return createErrorResponse(`Could not resolve ref: ${ref}`);
      }
    } catch (err) {
      return createErrorResponse(
        `Failed to resolve ref: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else if (selector) {
    // Use executeScript to get element center coordinates by CSS selector
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (cssSelector: string) => {
          const el = document.querySelector(cssSelector);
          if (!el) return null;
          const rect = el.getBoundingClientRect();
          return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          };
        },
        args: [selector],
      });

      if (result?.result) {
        targetX = result.result.x;
        targetY = result.result.y;
      } else {
        return createErrorResponse(`Could not find element: ${selector}`);
      }
    } catch (err) {
      return createErrorResponse(
        `Failed to resolve selector: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else if (coordinates) {
    targetX = coordinates.x;
    targetY = coordinates.y;
  }

  if (typeof targetX !== 'number' || typeof targetY !== 'number') {
    return createErrorResponse('Invalid drop target coordinates.');
  }

  // Execute drag&drop upload
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = args.filename ?? cached.filename ?? `recording_${timestamp}`;
    const fullFilename = filename.endsWith('.gif') ? filename : `${filename}.gif`;

    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (base64Data: string, x: number, y: number, fname: string) => {
        // Convert base64 to Blob
        const byteChars = atob(base64Data);
        const byteArray = new Uint8Array(byteChars.length);
        for (let i = 0; i < byteChars.length; i++) {
          byteArray[i] = byteChars.charCodeAt(i);
        }
        const blob = new Blob([byteArray], { type: 'image/gif' });
        const file = new File([blob], fname, { type: 'image/gif' });

        // Find drop target element
        const target = document.elementFromPoint(x, y);
        if (!target) {
          return { success: false, error: 'No element at drop coordinates' };
        }

        // Create DataTransfer with the file
        const dt = new DataTransfer();
        dt.items.add(file);

        // Dispatch drag events
        const events = ['dragenter', 'dragover', 'drop'] as const;
        for (const eventType of events) {
          const evt = new DragEvent(eventType, {
            bubbles: true,
            cancelable: true,
            dataTransfer: dt,
            clientX: x,
            clientY: y,
          });
          target.dispatchEvent(evt);
        }

        return {
          success: true,
          targetTagName: target.tagName,
          targetId: target.id || undefined,
        };
      },
      args: [gifBase64, targetX, targetY, fullFilename],
    });

    if (!result?.result?.success) {
      return createErrorResponse(result?.result?.error || 'Drag&drop upload failed');
    }

    return buildResponse({
      success: true,
      action: 'export',
      mode: cached.mode,
      frameCount: cached.frameCount,
      durationMs: cached.durationMs,
      byteLength: cached.gifData.byteLength,
      uploadTarget: {
        x: targetX,
        y: targetY,
        tagName: result.result.targetTagName,
        id: result.result.targetId,
      },
    } as GifResult);
  } catch (err) {
    return createErrorResponse(
      `Drag&drop upload failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
