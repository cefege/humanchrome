import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import { getCurrentRequestContext } from '../../utils/request-context';
import { setClientPacing, type PacingProfile } from '../../utils/client-state';

interface PaceToolParams {
  profile: PacingProfile;
  minGapMs?: number;
  jitterMs?: number;
}

const VALID_PROFILES: PacingProfile[] = ['off', 'human', 'careful', 'fast'];

/**
 * Set a per-MCP-client pacing profile. The throttle gate lives in
 * `tools/index.ts:handleCallTool` — when a mutating tool is dispatched and
 * the calling client has a profile, the handler sleeps for the computed gap
 * before forwarding to the tool's `execute()`. Reads stay un-throttled.
 *
 * State lives in `utils/client-state.ts` next to the existing per-client
 * tab pinning. Service-worker restart resets to off (intentional —
 * pacing is an optimization, not a contract).
 */
class PaceTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.PACE;

  async execute(args: PaceToolParams): Promise<ToolResult> {
    const ctx = getCurrentRequestContext();
    const clientId = ctx?.clientId;

    if (!args || typeof args.profile !== 'string') {
      return createErrorResponse(
        '`profile` is required (one of: off, human, careful, fast)',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'profile' },
      );
    }
    if (!VALID_PROFILES.includes(args.profile as PacingProfile)) {
      return createErrorResponse(
        `Invalid profile "${args.profile}": expected one of ${VALID_PROFILES.join(', ')}`,
        ToolErrorCode.INVALID_ARGS,
        { arg: 'profile' },
      );
    }
    if (!clientId) {
      // Without a clientId we have nowhere to attach the profile — this
      // shouldn't happen on the MCP path (the bridge always passes it),
      // but guard against the REST path or test contexts.
      return createErrorResponse(
        'No client id available — pacing profiles are per-MCP-client. Set X-Client-Id on REST calls.',
        ToolErrorCode.INVALID_ARGS,
      );
    }

    const overrides: { minGapMs?: number; jitterMs?: number } = {};
    if (typeof args.minGapMs === 'number' && Number.isFinite(args.minGapMs)) {
      overrides.minGapMs = Math.max(0, Math.min(args.minGapMs, 30_000));
    }
    if (typeof args.jitterMs === 'number' && Number.isFinite(args.jitterMs)) {
      overrides.jitterMs = Math.max(0, Math.min(args.jitterMs, 30_000));
    }

    const next = setClientPacing(clientId, args.profile as PacingProfile, overrides);
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
