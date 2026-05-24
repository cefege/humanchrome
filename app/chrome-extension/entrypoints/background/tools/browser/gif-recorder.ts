/**
 * GIF Recorder Tool
 *
 * Records browser tab activity as an animated GIF.
 *
 * Features:
 * - Two recording modes:
 *   1. Fixed FPS mode (start): Captures frames at regular intervals
 *   2. Auto-capture mode (auto_start): Captures frames on tool actions
 * - Configurable frame rate, duration, and dimensions
 * - Quality/size optimization options
 * - CDP-based screenshot capture for background recording
 * - Offscreen document encoding via gifenc
 *
 * This file is the thin dispatcher only. The 7 per-action handlers,
 * recording engine, frame-capture pipeline, and module-scope state
 * live in ./gif-recorder/. See ./gif-recorder/state.ts for the
 * singleton state model and IMP-0166 ownership semantics.
 */

import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'humanchrome-shared';
import { runStart } from './gif-recorder/actions/start';
import { runAutoStart } from './gif-recorder/actions/auto-start';
import { runCapture } from './gif-recorder/actions/capture';
import { runStop } from './gif-recorder/actions/stop';
import { runStatus } from './gif-recorder/actions/status';
import { runClear } from './gif-recorder/actions/clear';
import { runExport } from './gif-recorder/actions/export';
import {
  setCurrentRecordingClientId,
  setRecordingState,
  setStopPromise,
  type GifRecorderParams,
} from './gif-recorder/state';
import type { GifActionDeps } from './gif-recorder/utils';

class GifRecorderTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.GIF_RECORDER;

  async execute(args: GifRecorderParams): Promise<ToolResult> {
    const action = args.action;
    const validActions = ['start', 'stop', 'status', 'auto_start', 'capture', 'clear', 'export'];

    if (!action || !validActions.includes(action)) {
      return createErrorResponse(
        `Parameter [action] is required and must be one of: ${validActions.join(', ')}`,
      );
    }

    const deps: GifActionDeps = {
      resolveTargetTab: (tabId?: number) => this.getOwnedTab({ explicit: tabId, required: false }),
      injectContentScript: (tabId, files) => this.injectContentScript(tabId, files),
      sendMessageToTab: (tabId, message, frameId) => this.sendMessageToTab(tabId, message, frameId),
    };

    try {
      switch (action) {
        case 'start':
          return await runStart(deps, args);
        case 'auto_start':
          return await runAutoStart(deps, args);
        case 'capture':
          return await runCapture(deps, args);
        case 'stop':
          return await runStop(deps, args);
        case 'status':
          return await runStatus(deps, args);
        case 'clear':
          return await runClear(deps, args);
        case 'export':
          return await runExport(deps, args);
        default:
          return createErrorResponse(`Unknown action: ${action}`);
      }
    } catch (error) {
      console.error('GifRecorderTool.execute error:', error);
      return createErrorResponse(
        `GIF recorder error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const gifRecorderTool = new GifRecorderTool();

/**
 * IMP-0166 test seam — let tests assert the cross-client ownership gate
 * without spinning up the full offscreen + CDP + capture pipeline.
 *
 * Use `_setRecordingOwnerForTest('alice')` to mark the gif recorder as
 * "owned by alice", then verify that bob's start/stop is rejected with the
 * owner naming alice. `_resetRecordingOwnerForTest()` clears the stamp
 * between tests.
 *
 * Production code MUST NOT call these — they bypass the ordinary
 * recordingState lifecycle.
 */
export function _setRecordingOwnerForTest(
  clientId: string | null,
  alsoSetMockState: boolean = true,
): void {
  setCurrentRecordingClientId(clientId);
  if (alsoSetMockState && clientId !== null) {
    // The ownership gate inside startRecording short-circuits on
    // `recordingState?.isRecording`, so flip that bit too if we want a
    // second-start attempt to actually hit the owner-id error path.
    setRecordingState({
      isRecording: true,
      isStopping: false,
      tabId: 1,
      width: 0,
      height: 0,
      fps: 1,
      durationMs: 0,
      frameIntervalMs: 0,
      frameDelayCs: 1,
      maxFrames: 0,
      maxColors: 0,
      frameCount: 0,
      startTime: Date.now(),
      captureTimer: null,
      captureInProgress: null,
      canvas: null as unknown as OffscreenCanvas,
      ctx: null as unknown as OffscreenCanvasRenderingContext2D,
    });
  } else if (clientId === null) {
    setRecordingState(null);
  }
}

export function _resetRecordingOwnerForTest(): void {
  setCurrentRecordingClientId(null);
  setRecordingState(null);
  setStopPromise(null);
}

// Re-export auto-capture utilities for use by other tools (e.g., chrome_computer, chrome_navigate)
export {
  captureFrameOnAction,
  isAutoCaptureActive,
  type ActionMetadata,
  type ActionType,
} from './gif-auto-capture';
