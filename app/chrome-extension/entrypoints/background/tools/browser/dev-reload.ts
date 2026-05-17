import { ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'humanchrome-shared';

class DevReloadTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.DEV_RELOAD;
  static readonly autoSpawnTab = false;

  async execute(): Promise<ToolResult> {
    // Defer until the next microtask so the response postMessage flushes
    // through native messaging before the SW tears down.
    queueMicrotask(() => setTimeout(() => chrome.runtime.reload(), 0));
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            message: 'chrome.runtime.reload() scheduled; SW will respawn from disk',
          }),
        },
      ],
      isError: false,
    };
  }
}

export const devReloadTool = new DevReloadTool();
