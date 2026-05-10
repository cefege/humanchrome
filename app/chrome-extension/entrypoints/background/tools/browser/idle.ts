import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { jsonOk } from './_common';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';

interface IdleParams {
  detectionIntervalSec?: number;
}

const DEFAULT_INTERVAL_SEC = 60;
const MIN_INTERVAL_SEC = 15;
const MAX_INTERVAL_SEC = 14400;

class IdleTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.IDLE;
  static readonly mutates = false;

  async execute(args: IdleParams = {}): Promise<ToolResult> {
    if (typeof chrome.idle === 'undefined') {
      return createErrorResponse(
        'chrome.idle is unavailable — the `idle` permission is not granted.',
        ToolErrorCode.UNKNOWN,
      );
    }

    const interval =
      typeof args.detectionIntervalSec === 'number'
        ? args.detectionIntervalSec
        : DEFAULT_INTERVAL_SEC;
    if (interval < MIN_INTERVAL_SEC || interval > MAX_INTERVAL_SEC) {
      return createErrorResponse(
        `Parameter [detectionIntervalSec] must be between ${MIN_INTERVAL_SEC} and ${MAX_INTERVAL_SEC} seconds (Chrome's accepted range).`,
        ToolErrorCode.INVALID_ARGS,
        { arg: 'detectionIntervalSec', got: interval },
      );
    }

    try {
      const state = await new Promise<chrome.idle.IdleState>((resolve) =>
        chrome.idle.queryState(interval, (s) => resolve(s)),
      );
      return jsonOk({ ok: true, state, detectionIntervalSec: interval });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('Error in IdleTool.execute:', error);
      return createErrorResponse(`chrome_idle failed: ${msg}`, ToolErrorCode.UNKNOWN);
    }
  }
}

export const idleTool = new IdleTool();
