import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';
import { getCurrentRequestContext } from '../../utils/request-context';
import { setClientPacing, getClientPacing, type PacingProfile } from '../../utils/client-state';

interface PaceToolParams {
  profile?: PacingProfile;
  minGapMs?: number;
  jitterMs?: number;
}

const VALID_PROFILES: PacingProfile[] = ['off', 'human', 'careful', 'fast'];

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

    // No profile arg → read current pacing (former chrome_pace_get path).
    if (args.profile === undefined) {
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

    if (typeof args.profile !== 'string') {
      return createErrorResponse(
        '`profile` must be one of: off, human, careful, fast (or omit it to read current state)',
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
