/**
 * GIF recorder `action: 'clear'` handler — full reset.
 *
 * Cancels in-flight auto-capture + fixed-FPS recordings, drops the
 * exportable-gif cache, and resets the offscreen encoder. Synchronous
 * (no awaiting stopRecording's encode/download path).
 */
import { OFFSCREEN_MESSAGE_TYPES } from '@/common/message-types';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import type { ToolResult } from '@/common/tool-handler';
import { isAutoCaptureActive, stopAutoCapture } from '../../gif-auto-capture';
import { sendToOffscreen } from '../offscreen';
import {
  CDP_SESSION_KEY,
  getAutoCaptureMetadata,
  getLastRecordedGif,
  getRecordingState,
  setAutoCaptureMetadata,
  setLastRecordedGif,
  setRecordingState,
  setStopPromise,
  type GifRecorderParams,
  type GifResult,
} from '../state';
import { buildResponse, type GifActionDeps } from '../utils';

export async function runClear(
  _deps: GifActionDeps,
  _args: GifRecorderParams,
): Promise<ToolResult> {
  // Clear all recording state and cached GIF
  let clearedAuto = false;
  let clearedFixedFps = false;
  let clearedCache = false;

  // Stop auto-capture if active
  const autoTab = getAutoCaptureMetadata()?.tabId;
  if (autoTab !== undefined && isAutoCaptureActive(autoTab)) {
    await stopAutoCapture(autoTab);
    setAutoCaptureMetadata(null);
    clearedAuto = true;
  }

  // Stop fixed-FPS recording if active or stopping
  const current = getRecordingState();
  if (current) {
    // Cancel timer and cleanup without waiting for finish
    if (current.captureTimer) {
      clearTimeout(current.captureTimer);
      current.captureTimer = null;
    }
    try {
      await current.captureInProgress;
    } catch {
      // ignore
    }
    try {
      await cdpSessionManager.detach(current.tabId, CDP_SESSION_KEY);
    } catch {
      // ignore
    }
    const wasRecording = current.isRecording || current.isStopping;
    setRecordingState(null);
    setStopPromise(null); // Clear any pending stop promise
    if (wasRecording) {
      clearedFixedFps = true;
    }
  }

  // Reset offscreen encoder
  try {
    await sendToOffscreen(OFFSCREEN_MESSAGE_TYPES.GIF_RESET, {});
  } catch {
    // ignore
  }

  // Clear cached GIF
  if (getLastRecordedGif()) {
    setLastRecordedGif(null);
    clearedCache = true;
  }

  return buildResponse({
    success: true,
    action: 'clear',
    clearedAutoCapture: clearedAuto,
    clearedFixedFps,
    clearedCache,
  } as GifResult);
}
