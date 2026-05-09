import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';

type NetworkEmulateAction = 'set' | 'reset';

interface NetworkEmulateParams {
  action: NetworkEmulateAction;
  tabId: number;
  offline?: boolean;
  latencyMs?: number;
  downloadKbps?: number;
  uploadKbps?: number;
}

const KBPS_TO_BYTES_PER_SEC = 1024 / 8;

async function attachDebugger(tabId: number): Promise<void> {
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // "Another debugger is already attached" — fine, existing attach is reusable.
    if (!/already attached/i.test(msg)) throw err;
  }
}

async function detachDebugger(tabId: number): Promise<void> {
  try {
    await chrome.debugger.detach({ tabId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // "is not attached" — already detached, fine.
    if (!/not attached/i.test(msg)) throw err;
  }
}

class NetworkEmulateTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.NETWORK_EMULATE;
  static readonly mutates = true;

  async execute(args: NetworkEmulateParams): Promise<ToolResult> {
    const action = args?.action;
    if (action !== 'set' && action !== 'reset') {
      return createErrorResponse(
        'Parameter [action] is required and must be one of: set, reset.',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'action' },
      );
    }
    if (typeof args.tabId !== 'number') {
      return createErrorResponse('Parameter [tabId] is required.', ToolErrorCode.INVALID_ARGS, {
        arg: 'tabId',
      });
    }
    if (typeof chrome.debugger === 'undefined') {
      return createErrorResponse('chrome.debugger is unavailable.', ToolErrorCode.UNKNOWN);
    }

    try {
      await attachDebugger(args.tabId);

      if (action === 'reset') {
        await chrome.debugger.sendCommand(
          { tabId: args.tabId },
          'Network.emulateNetworkConditions',
          {
            offline: false,
            latency: 0,
            downloadThroughput: -1,
            uploadThroughput: -1,
          },
        );
        await detachDebugger(args.tabId);
        return jsonOk({ ok: true, action: 'reset', tabId: args.tabId });
      }

      // set
      const conditions = {
        offline: !!args.offline,
        latency: typeof args.latencyMs === 'number' ? args.latencyMs : 0,
        downloadThroughput:
          typeof args.downloadKbps === 'number' && args.downloadKbps >= 0
            ? args.downloadKbps * KBPS_TO_BYTES_PER_SEC
            : -1,
        uploadThroughput:
          typeof args.uploadKbps === 'number' && args.uploadKbps >= 0
            ? args.uploadKbps * KBPS_TO_BYTES_PER_SEC
            : -1,
      };
      await chrome.debugger.sendCommand(
        { tabId: args.tabId },
        'Network.emulateNetworkConditions',
        conditions,
      );
      // Stay attached so subsequent calls don't need to re-attach.
      return jsonOk({ ok: true, action: 'set', tabId: args.tabId, conditions });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // Best-effort detach so a stale attach doesn't block the user manually opening DevTools.
      try {
        await detachDebugger(args.tabId);
      } catch {
        // already cleaned up or never attached
      }
      if (/no tab with id|cannot access|target closed/i.test(msg)) {
        return createErrorResponse(`Tab ${args.tabId} not found`, ToolErrorCode.TAB_CLOSED, {
          tabId: args.tabId,
        });
      }
      console.error('Error in NetworkEmulateTool.execute:', error);
      return createErrorResponse(`chrome_network_emulate failed: ${msg}`, ToolErrorCode.UNKNOWN, {
        action,
        tabId: args.tabId,
      });
    }
  }
}

function jsonOk(body: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false };
}

export const networkEmulateTool = new NetworkEmulateTool();
