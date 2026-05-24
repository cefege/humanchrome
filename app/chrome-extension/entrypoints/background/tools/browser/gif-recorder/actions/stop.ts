/**
 * GIF recorder `action: 'stop'` handler — stops either auto-capture or
 * fixed-FPS recording, encodes, downloads the resulting GIF, caches
 * for later export.
 */
import type { ToolResult } from '@/common/tool-handler';
import { isAutoCaptureActive, stopAutoCapture } from '../../gif-auto-capture';
import { stopRecording } from '../fixed-fps';
import {
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  getAutoCaptureMetadata,
  setAutoCaptureMetadata,
  setLastRecordedGif,
  type GifRecorderParams,
} from '../state';
import { blobToDataUrl, buildResponse, type GifActionDeps } from '../utils';

export async function runStop(_deps: GifActionDeps, _args: GifRecorderParams): Promise<ToolResult> {
  // Stop either mode
  // Check auto-capture first
  const meta = getAutoCaptureMetadata();
  const autoTab = meta?.tabId;
  if (autoTab !== undefined && isAutoCaptureActive(autoTab)) {
    const stopResult = await stopAutoCapture(autoTab);
    const filename = meta?.filename;
    setAutoCaptureMetadata(null);

    if (!stopResult.success || !stopResult.gifData) {
      return buildResponse({
        success: false,
        action: 'stop',
        tabId: autoTab,
        mode: 'auto_capture',
        frameCount: stopResult.frameCount,
        durationMs: stopResult.durationMs,
        actionsCount: stopResult.actions?.length,
        error: stopResult.error || 'No GIF data generated',
      });
    }

    // Cache for later export
    setLastRecordedGif({
      gifData: stopResult.gifData,
      width: DEFAULT_WIDTH, // auto mode uses default dimensions
      height: DEFAULT_HEIGHT,
      frameCount: stopResult.frameCount ?? 0,
      durationMs: stopResult.durationMs ?? 0,
      tabId: autoTab,
      filename,
      actionsCount: stopResult.actions?.length,
      mode: 'auto_capture',
      createdAt: Date.now(),
    });

    // Save GIF file
    // Reconstruct as Uint8Array<ArrayBuffer> so it satisfies BlobPart under newer TS lib.
    const blob = new Blob([new Uint8Array(stopResult.gifData)], { type: 'image/gif' });
    const dataUrl = await blobToDataUrl(blob);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputFilename = filename?.replace(/[^a-z0-9_-]/gi, '_') || `recording_${timestamp}`;
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
      action: 'stop',
      tabId: autoTab,
      mode: 'auto_capture',
      frameCount: stopResult.frameCount,
      durationMs: stopResult.durationMs,
      byteLength: stopResult.gifData.byteLength,
      actionsCount: stopResult.actions?.length,
      downloadId,
      filename: fullFilename,
      fullPath,
    });
  }

  // Fall back to fixed-FPS stop
  const result = await stopRecording();
  if (result.success) {
    result.mode = 'fixed_fps';
  }
  return buildResponse(result);
}
