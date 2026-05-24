/**
 * GIF recorder `action: 'start'` handler — fixed-FPS recording.
 */
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { isAutoCaptureActive } from '../../gif-auto-capture';
import { startRecording } from '../fixed-fps';
import {
  DEFAULT_DURATION_MS,
  DEFAULT_FPS,
  DEFAULT_HEIGHT,
  DEFAULT_MAX_COLORS,
  DEFAULT_MAX_FRAMES,
  DEFAULT_WIDTH,
  type GifRecorderParams,
} from '../state';
import { buildResponse, isRestrictedUrl, normalizePositiveInt, type GifActionDeps } from '../utils';

export async function runStart(deps: GifActionDeps, args: GifRecorderParams): Promise<ToolResult> {
  // Fixed-FPS mode: captures frames at regular intervals
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

  // Check if auto-capture is active
  if (isAutoCaptureActive(tab.id)) {
    return createErrorResponse(
      'Auto-capture mode is active for this tab. Use action="stop" to stop it first.',
    );
  }

  const fps = normalizePositiveInt(args.fps, DEFAULT_FPS, 30);
  const durationMs = normalizePositiveInt(args.durationMs, DEFAULT_DURATION_MS, 60000);
  const maxFrames = normalizePositiveInt(args.maxFrames, DEFAULT_MAX_FRAMES, 300);
  const width = normalizePositiveInt(args.width, DEFAULT_WIDTH, 1920);
  const height = normalizePositiveInt(args.height, DEFAULT_HEIGHT, 1080);
  const maxColors = normalizePositiveInt(args.maxColors, DEFAULT_MAX_COLORS, 256);

  const result = await startRecording(
    tab.id,
    fps,
    durationMs,
    maxFrames,
    width,
    height,
    maxColors,
    args.filename,
  );

  if (result.success) {
    result.mode = 'fixed_fps';
  }

  return buildResponse(result);
}
