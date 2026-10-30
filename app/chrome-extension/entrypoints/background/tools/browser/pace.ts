import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { browserMetadataPolicy, TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import { getCurrentRequestContext } from '../../utils/request-context';
import { setClientPacing, getClientPacing, type PacingProfile } from '../../utils/client-state';

interface PaceToolParams {
  profile?: PacingProfile;
  minGapMs?: number;
  jitterMs?: number;
}

/**
 * Per-MCP-client pacing profile. Calling with `profile` sets it; calling
 * with no `profile` returns the current state (replaces the previous
 * `chrome_pace_get` tool — Slice 1 of catalog consolidation).
 *
 * The throttle gate lives in `tools/index.ts:handleCallTool` — when a
 * mutating tool is dispatched and the calling client has a profile, the
 * handler sleeps for the computed gap before forwarding to the tool's
 * `execute()`. Reads stay un-throttled.
 *
 * State lives in `utils/client-state.ts` next to the existing per-client
 * tab pinning. Service-worker restart resets to off (intentional —
 * pacing is an optimization, not a contract).
 */
class PaceTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.PACE;
  static readonly autoSpawnTab = false;

  async execute(args: PaceToolParams = {}): Promise<ToolResult> {
    const ctx = getCurrentRequestContext();
    const clientId = ctx?.clientId;

    if (!clientId) {
      // Without a clientId we have nowhere to attach the profile — this
      // shouldn't happen on the MCP path (the bridge always passes it),
      // but guard against the REST path or test contexts.
      return createErrorResponse(
        'No client id available — pacing profiles are per-MCP-client. Set X-Client-Id on REST calls.',
        ToolErrorCode.INVALID_ARGS,
      );
    }

    const plan = browserMetadataPolicy.planPacingInput(
      args.profile,
      args.minGapMs,
      args.jitterMs,
    );
    if (plan.kind === 'read') {
      const pacing = getClientPacing(clientId);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              clientId,
              profile: pacing?.profile ?? 'off',
              minGapMs: pacing?.minGapMs ?? 0,
              jitterMs: pacing?.jitterMs ?? 0,
            }),
          },
        ],
        isError: false,
      };
    }
    if (plan.kind === 'invalidProfileType') {
      return createErrorResponse(
        '`profile` must be one of: off, human, careful, fast (or omit it to read current state)',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'profile' },
      );
    }
    if (plan.kind === 'invalidProfileValue') {
      return createErrorResponse(
        `Invalid profile "${plan.profile}": expected one of off, human, careful, fast`,
        ToolErrorCode.INVALID_ARGS,
        { arg: 'profile' },
      );
    }

    const overrides: { minGapMs?: number; jitterMs?: number } = {};
    if (plan.minGapMs !== null) overrides.minGapMs = plan.minGapMs;
    if (plan.jitterMs !== null) overrides.jitterMs = plan.jitterMs;

    const next = setClientPacing(clientId, plan.profile, overrides);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            clientId,
            ...(next ?? { profile: 'off' as const }),
          }),
        },
      ],
      isError: false,
    };
  }
}

export const paceTool = new PaceTool();
