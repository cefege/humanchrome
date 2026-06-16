import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import { debugDumpTool } from './debug-dump';
import { queueInspectTool } from './queue-inspect';
import { runtimeInfoTool } from './runtime-info';
import { devReloadTool } from './dev-reload';

/**
 * Unified chrome_diagnostics tool (Slice 11 of IMP-0188 catalog consolidation).
 * Routes by `action` to the four previous standalone diagnostic tools.
 */
type DiagnosticsAction = 'dump_logs' | 'queue' | 'runtime_info' | 'dev_reload';
const DIAGNOSTICS_ACTIONS: readonly DiagnosticsAction[] = [
  'dump_logs',
  'queue',
  'runtime_info',
  'dev_reload',
] as const;

class DiagnosticsTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.DIAGNOSTICS;
  static readonly autoSpawnTab = false;

  async execute(
    args: { action: DiagnosticsAction } & Record<string, unknown>,
  ): Promise<ToolResult> {
    if (!args || typeof args.action !== 'string') {
      return createErrorResponse(
        `\`action\` is required (one of: ${DIAGNOSTICS_ACTIONS.join(', ')})`,
        ToolErrorCode.INVALID_ARGS,
        { arg: 'action' },
      );
    }
    if (!DIAGNOSTICS_ACTIONS.includes(args.action)) {
      return createErrorResponse(
        `Invalid action "${args.action}": expected one of ${DIAGNOSTICS_ACTIONS.join(', ')}`,
        ToolErrorCode.INVALID_ARGS,
        { arg: 'action' },
      );
    }
    switch (args.action) {
      case 'dump_logs':
        return debugDumpTool.execute(args as Parameters<typeof debugDumpTool.execute>[0]);
      case 'queue':
        return queueInspectTool.execute(args as Parameters<typeof queueInspectTool.execute>[0]);
      case 'runtime_info':
        return runtimeInfoTool.execute();
      case 'dev_reload':
        return devReloadTool.execute();
      default:
        return createErrorResponse(`Unreachable: ${args.action}`, ToolErrorCode.INVALID_ARGS);
    }
  }
}

export const diagnosticsTool = new DiagnosticsTool();
