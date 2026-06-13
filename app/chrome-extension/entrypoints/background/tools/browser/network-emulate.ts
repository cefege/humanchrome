import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { jsonOk } from './_common';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import { cdpSessionManager } from '@/utils/cdp-session-manager';

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
const SESSION_OWNER = 'network-emulate';

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
      await cdpSessionManager.attach(args.tabId, SESSION_OWNER);

      if (action === 'reset') {
        await cdpSessionManager.sendCommand(args.tabId, 'Network.emulateNetworkConditions', {
          offline: false,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1,
        });
        await cdpSessionManager.detach(args.tabId, SESSION_OWNER);
        return jsonOk({ ok: true, action: 'reset', tabId: args.tabId });
      }

      // set — stay attached via the session manager so the conditions persist
      // and other tools using cdpSessionManager share the same session safely.
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
      await cdpSessionManager.sendCommand(
        args.tabId,
        'Network.emulateNetworkConditions',
        conditions,
      );
      return jsonOk({ ok: true, action: 'set', tabId: args.tabId, conditions });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await cdpSessionManager.detach(args.tabId, SESSION_OWNER);
      if (/no tab with id|cannot access|target closed/i.test(msg)) {
        return createErrorResponse(`Tab ${args.tabId} not found`, ToolErrorCode.TAB_CLOSED, {
          tabId: args.tabId,
        });
      }
      if (
        /another cdp client|chrome devtools is open|another debugger|already attached/i.test(msg)
      ) {
        return createErrorResponse(msg, ToolErrorCode.CDP_BUSY, { tabId: args.tabId });
      }
      console.error('Error in NetworkEmulateTool.execute:', error);
      return createErrorResponse(`chrome_network_emulate failed: ${msg}`, ToolErrorCode.UNKNOWN, {
        action,
        tabId: args.tabId,
      });
    }
  }
}

export const networkEmulateTool = new NetworkEmulateTool();
