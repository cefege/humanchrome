/**
 * GIF recorder `action: 'capture'` handler — manual frame in auto mode.
 */
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import {
  captureFrameOnAction,
  isAutoCaptureActive,
  type ActionMetadata,
} from '../../gif-auto-capture';
import type { GifRecorderParams } from '../state';
import { buildResponse, type GifActionDeps } from '../utils';

export async function runCapture(
  deps: GifActionDeps,
  args: GifRecorderParams,
): Promise<ToolResult> {
  // Manual frame capture in auto mode
  const tab = await deps.resolveTargetTab(args.tabId);
  if (!tab?.id) {
    return createErrorResponse(
      typeof args.tabId === 'number' ? `Tab not found: ${args.tabId}` : 'No active tab found',
    );
  }

  if (!isAutoCaptureActive(tab.id)) {
    return createErrorResponse(
      'Auto-capture is not active for this tab. Use action="auto_start" first.',
    );
  }

  // Support optional annotation for manual captures
  const annotation =
    typeof args.annotation === 'string' && args.annotation.trim().length > 0
      ? args.annotation.trim()
      : undefined;

  const action: ActionMetadata | undefined = annotation
    ? { type: 'annotation', label: annotation }
    : undefined;

  const captureResult = await captureFrameOnAction(tab.id, action, true);

  return buildResponse({
    success: captureResult.success,
    action: 'capture',
    tabId: tab.id,
    frameCount: captureResult.frameNumber,
    error: captureResult.error,
  });
}
