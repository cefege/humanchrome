/**
 * GIF recorder `action: 'auto_start'` handler — auto-capture mode.
 */
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import {
  captureInitialFrame,
  isAutoCaptureActive,
  startAutoCapture,
} from '../../gif-auto-capture';
import {
  DEFAULT_HEIGHT,
  DEFAULT_MAX_COLORS,
  DEFAULT_WIDTH,
  getRecordingState,
  setAutoCaptureMetadata,
  type GifRecorderParams,
} from '../state';
import { buildResponse, isRestrictedUrl, normalizePositiveInt, type GifActionDeps } from '../utils';

export async function runAutoStart(
  deps: GifActionDeps,
  args: GifRecorderParams,
): Promise<ToolResult> {
  // Auto-capture mode: captures frames when tools succeed
  const tab = await deps.resolveTargetTab(args.tabId);
  if (!tab?.id) {
    return createErrorResponse(
      typeof args.tabId === 'number' ? `Tab not found: ${args.tabId}` : 'No active tab found',
    );
  }

  if (isRestrictedUrl(tab.url)) {
    return createErrorResponse(
      'Cannot record special browser pages or web store pages due to security restrictions.',
    );
  }

  // Check if fixed-FPS recording is active
  const current = getRecordingState();
  if (current?.isRecording && current.tabId === tab.id) {
    return createErrorResponse(
      'Fixed-FPS recording is active for this tab. Use action="stop" to stop it first.',
    );
  }

  // Check if auto-capture is already active
  if (isAutoCaptureActive(tab.id)) {
    return createErrorResponse('Auto-capture is already active for this tab.');
  }

  const width = normalizePositiveInt(args.width, DEFAULT_WIDTH, 1920);
  const height = normalizePositiveInt(args.height, DEFAULT_HEIGHT, 1080);
  const maxColors = normalizePositiveInt(args.maxColors, DEFAULT_MAX_COLORS, 256);
  const maxFrames = normalizePositiveInt(args.maxFrames, 100, 300);
  const captureDelayMs = normalizePositiveInt(args.captureDelayMs, 150, 2000);
  const frameDelayCs = normalizePositiveInt(args.frameDelayCs, 20, 100);

  const startResult = await startAutoCapture(tab.id, {
    width,
    height,
    maxColors,
    maxFrames,
    captureDelayMs,
    frameDelayCs,
    enhancedRendering: args.enhancedRendering,
  });

  if (!startResult.success) {
    return buildResponse({
      success: false,
      action: 'auto_start',
      tabId: tab.id,
      error: startResult.error,
    });
  }

  // Store metadata for stop
  setAutoCaptureMetadata({
    tabId: tab.id,
    filename: args.filename,
  });

  // Capture initial frame
  await captureInitialFrame(tab.id);

  return buildResponse({
    success: true,
    action: 'auto_start',
    tabId: tab.id,
    mode: 'auto_capture',
    isRecording: true,
  });
}
