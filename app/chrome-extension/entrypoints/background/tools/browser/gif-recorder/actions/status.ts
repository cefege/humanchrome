/**
 * GIF recorder `action: 'status'` handler.
 */
import type { ToolResult } from '@/common/tool-handler';
import { getAutoCaptureStatus, isAutoCaptureActive } from '../../gif-auto-capture';
import { getRecordingStatus } from '../fixed-fps';
import { getAutoCaptureMetadata, type GifRecorderParams } from '../state';
import { buildResponse, type GifActionDeps } from '../utils';

export async function runStatus(
  _deps: GifActionDeps,
  _args: GifRecorderParams,
): Promise<ToolResult> {
  // Check auto-capture status first
  const autoTab = getAutoCaptureMetadata()?.tabId;
  if (autoTab !== undefined && isAutoCaptureActive(autoTab)) {
    const status = getAutoCaptureStatus(autoTab);
    return buildResponse({
      success: true,
      action: 'status',
      tabId: autoTab,
      isRecording: status.active,
      mode: 'auto_capture',
      frameCount: status.frameCount,
      durationMs: status.durationMs,
      actionsCount: status.actionsCount,
    });
  }

  // Fall back to fixed-FPS status
  const result = getRecordingStatus();
  if (result.isRecording) {
    result.mode = 'fixed_fps';
  }
  return buildResponse(result);
}
