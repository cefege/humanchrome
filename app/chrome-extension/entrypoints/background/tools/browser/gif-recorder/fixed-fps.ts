/**
 * Fixed-FPS recording engine for the GIF recorder (IMP-0130 split).
 *
 * startRecording — attaches CDP, builds RecordingState, kicks off
 *   captureTick loop. Stamps `currentRecordingClientId` for IMP-0166.
 * stopRecording — drains in-flight capture, asks offscreen to encode,
 *   downloads the GIF, caches it for later export. Owner-gated.
 * getRecordingStatus — passive snapshot.
 */
import { OFFSCREEN_MESSAGE_TYPES } from '@/common/message-types';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { sendToOffscreen } from './offscreen';
import { captureAndEncodeFrame, captureFrame } from './frame-capture';
import { blobToDataUrl } from './utils';
import {
  callerClientId,
  CDP_SESSION_KEY,
  getCurrentRecordingClientId,
  getRecordingState,
  getStopPromise,
  setCurrentRecordingClientId,
  setLastRecordedGif,
  setRecordingState,
  setStopPromise,
  SYSTEM_CLIENT,
  type GifResult,
  type RecordingState,
} from './state';

async function captureTick(state: RecordingState): Promise<void> {
  if (getRecordingState() !== state || !state.isRecording || state.isStopping) {
    return;
  }

  const elapsed = Date.now() - state.startTime;
  if (elapsed >= state.durationMs || state.frameCount >= state.maxFrames) {
    await stopRecording();
    return;
  }

  const startedAt = Date.now();
  state.captureInProgress = captureAndEncodeFrame(state);

  try {
    await state.captureInProgress;
  } catch (error) {
    console.error('Frame capture error:', error);
  } finally {
    if (getRecordingState() === state) {
      state.captureInProgress = null;
    }
  }

  if (getRecordingState() !== state || !state.isRecording || state.isStopping) {
    return;
  }

  const elapsedAfter = Date.now() - state.startTime;
  if (elapsedAfter >= state.durationMs || state.frameCount >= state.maxFrames) {
    await stopRecording();
    return;
  }

  const delayMs = Math.max(0, state.frameIntervalMs - (Date.now() - startedAt));
  state.captureTimer = setTimeout(() => {
    void captureTick(state).catch((error) => {
      console.error('GIF recorder tick error:', error);
    });
  }, delayMs);
}

export async function startRecording(
  tabId: number,
  fps: number,
  durationMs: number,
  maxFrames: number,
  width: number,
  height: number,
  maxColors: number,
  filename?: string,
): Promise<GifResult> {
  const existing = getRecordingState();
  if (getStopPromise() || existing?.isRecording || existing?.isStopping) {
    // IMP-0166: tell the caller WHICH client owns the in-flight recording
    // so a second client gets actionable error context instead of a
    // generic "already in progress". The underlying CDP screencast is a
    // single per-Chrome resource — only one gif at a time, regardless
    // of which client started it.
    const owner = getCurrentRecordingClientId() ?? SYSTEM_CLIENT;
    return {
      success: false,
      action: 'start',
      error: `Recording already in progress (owned by client ${owner})`,
    };
  }

  try {
    await cdpSessionManager.attach(tabId, CDP_SESSION_KEY);
  } catch (error) {
    return {
      success: false,
      action: 'start',
      error: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    await sendToOffscreen(OFFSCREEN_MESSAGE_TYPES.GIF_RESET, {});

    if (typeof OffscreenCanvas === 'undefined') {
      throw new Error('OffscreenCanvas not available in this context');
    }

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to get canvas context');
    }

    const frameIntervalMs = Math.round(1000 / fps);
    const frameDelayCs = Math.max(1, Math.round(100 / fps));

    const state: RecordingState = {
      isRecording: true,
      isStopping: false,
      tabId,
      width,
      height,
      fps,
      durationMs,
      frameIntervalMs,
      frameDelayCs,
      maxFrames,
      maxColors,
      frameCount: 0,
      startTime: Date.now(),
      captureTimer: null,
      captureInProgress: null,
      canvas,
      ctx,
      filename,
    };

    setRecordingState(state);
    // IMP-0166: stamp the owning client so subsequent stop/start calls
    // from other clients can be rejected with `owner=<id>` context.
    setCurrentRecordingClientId(callerClientId());

    // Capture first frame eagerly so start() fails fast if capture/encoding is broken
    await captureAndEncodeFrame(state);

    state.captureTimer = setTimeout(() => {
      void captureTick(state).catch((error) => {
        console.error('GIF recorder tick error:', error);
      });
    }, frameIntervalMs);

    return {
      success: true,
      action: 'start',
      tabId,
      isRecording: true,
    };
  } catch (error) {
    setRecordingState(null);
    // IMP-0166: roll back ownership if start failed mid-init so the
    // next start() isn't blocked by a stale ownership stamp.
    setCurrentRecordingClientId(null);
    try {
      await cdpSessionManager.detach(tabId, CDP_SESSION_KEY);
    } catch {
      // ignore
    }
    return {
      success: false,
      action: 'start',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function stopRecording(): Promise<GifResult> {
  const existingStop = getStopPromise();
  if (existingStop) {
    return existingStop;
  }

  const current = getRecordingState();
  if (!current || (!current.isRecording && !current.isStopping)) {
    return {
      success: false,
      action: 'stop',
      error: 'No recording in progress',
    };
  }

  // IMP-0166: only the client that started the recording can stop it.
  // Cross-client stop is rejected with the owner's id so the caller knows
  // who to coordinate with. The exception is the system bucket — internal
  // callers (auto-cleanup on tab close, tests via the singleton path) can
  // always stop.
  const owner = getCurrentRecordingClientId();
  const caller = callerClientId();
  if (owner !== null && owner !== SYSTEM_CLIENT && caller !== SYSTEM_CLIENT && owner !== caller) {
    return {
      success: false,
      action: 'stop',
      error: `Recording owned by client ${owner}; client ${caller} cannot stop it`,
    };
  }

  const promise = (async (): Promise<GifResult> => {
    const state = getRecordingState()!;
    const tabId = state.tabId;

    // Stop capture timer
    if (state.captureTimer) {
      clearTimeout(state.captureTimer);
      state.captureTimer = null;
    }

    state.isStopping = true;
    state.isRecording = false;

    try {
      await state.captureInProgress;
    } catch {
      // ignore
    }

    // Best-effort final frame capture to preserve end state
    try {
      const frameData = await captureFrame(state.tabId, state.width, state.height, state.ctx);
      await sendToOffscreen(OFFSCREEN_MESSAGE_TYPES.GIF_ADD_FRAME, {
        imageData: Array.from(frameData),
        width: state.width,
        height: state.height,
        delay: state.frameDelayCs,
        maxColors: state.maxColors,
      });
      state.frameCount += 1;
    } catch (error) {
      console.warn('GIF recorder: Final frame capture error (non-fatal):', error);
    }

    const frameCount = state.frameCount;
    const durationMs = Date.now() - state.startTime;
    const filename = state.filename;

    try {
      if (frameCount <= 0) {
        try {
          await sendToOffscreen(OFFSCREEN_MESSAGE_TYPES.GIF_RESET, {});
        } catch {
          // ignore
        }
        return {
          success: false,
          action: 'stop' as const,
          tabId,
          frameCount,
          durationMs,
          error: 'No frames captured',
        };
      }

      const response = await sendToOffscreen<{
        success: boolean;
        gifData?: number[];
        byteLength?: number;
      }>(OFFSCREEN_MESSAGE_TYPES.GIF_FINISH, {});

      if (!response.gifData || response.gifData.length === 0) {
        return {
          success: false,
          action: 'stop' as const,
          tabId,
          frameCount,
          durationMs,
          error: 'No frames captured',
        };
      }

      // Convert to Uint8Array and create blob
      const gifBytes = new Uint8Array(response.gifData);

      // Cache for later export
      setLastRecordedGif({
        gifData: gifBytes,
        width: state.width,
        height: state.height,
        frameCount,
        durationMs,
        tabId,
        filename,
        mode: 'fixed_fps',
        createdAt: Date.now(),
      });

      const blob = new Blob([gifBytes], { type: 'image/gif' });
      const dataUrl = await blobToDataUrl(blob);

      // Save GIF file
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const outputFilename = filename?.replace(/[^a-z0-9_-]/gi, '_') || `recording_${timestamp}`;
      const fullFilename = outputFilename.endsWith('.gif')
        ? outputFilename
        : `${outputFilename}.gif`;

      const downloadId = await chrome.downloads.download({
        url: dataUrl,
        filename: fullFilename,
        saveAs: false,
      });

      // Wait briefly to get download info
      await new Promise((resolve) => setTimeout(resolve, 100));

      let fullPath: string | undefined;
      try {
        const [downloadItem] = await chrome.downloads.search({ id: downloadId });
        fullPath = downloadItem?.filename;
      } catch {
        // Ignore path lookup errors
      }

      return {
        success: true,
        action: 'stop' as const,
        tabId,
        frameCount,
        durationMs,
        byteLength: response.byteLength ?? gifBytes.byteLength,
        downloadId,
        filename: fullFilename,
        fullPath,
      };
    } catch (error) {
      return {
        success: false,
        action: 'stop' as const,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      try {
        await cdpSessionManager.detach(tabId, CDP_SESSION_KEY);
      } catch {
        // ignore
      }
      setRecordingState(null);
      // IMP-0166: clear ownership so the next start() from any client
      // is unblocked.
      setCurrentRecordingClientId(null);
    }
  })();

  setStopPromise(promise);

  return await promise.finally(() => {
    setStopPromise(null);
  });
}

export function getRecordingStatus(): GifResult {
  const state = getRecordingState();
  if (!state) {
    return {
      success: true,
      action: 'status',
      isRecording: false,
    };
  }

  return {
    success: true,
    action: 'status',
    isRecording: state.isRecording,
    tabId: state.tabId,
    frameCount: state.frameCount,
    durationMs: Date.now() - state.startTime,
  };
}
