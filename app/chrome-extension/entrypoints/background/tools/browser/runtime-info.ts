import { ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'humanchrome-shared';

// Replaced by wxt's vite `define` at build time. If the build skipped the
// define the runtime sees the literal placeholder string.
declare const __HC_BUILD_HASH__: string;
declare const __HC_BUILT_AT__: string;

const STARTED_AT = Date.now();

class RuntimeInfoTool extends BaseBrowserToolExecutor {
  name = 'chrome_diagnostics__runtime_info_internal';
  static readonly autoSpawnTab = false;

  async execute(): Promise<ToolResult> {
    // Deferred to break the cycle: this module is loaded by ../index during
    // eagerTools construction; importing ../index back at top-level would
    // see runtimeInfoTool === undefined.
    const { listRegisteredToolNames } = await import('../index');
    const toolNames = listRegisteredToolNames().sort();
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            extensionVersion: chrome.runtime.getManifest().version,
            extensionId: chrome.runtime.id,
            toolNames,
            toolCount: toolNames.length,
            buildHash: __HC_BUILD_HASH__,
            builtAt: __HC_BUILT_AT__,
            uptimeMs: Date.now() - STARTED_AT,
          }),
        },
      ],
      isError: false,
    };
  }
}

export const runtimeInfoTool = new RuntimeInfoTool();
