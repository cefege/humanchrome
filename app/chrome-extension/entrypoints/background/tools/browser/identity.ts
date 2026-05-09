import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';

type IdentityAction = 'get_token' | 'remove_token' | 'get_profile';

interface IdentityParams {
  action: IdentityAction;
  scopes?: string[];
  interactive?: boolean;
  token?: string;
}

const PLACEHOLDER_CLIENT_ID = '__SET_HUMANCHROME_OAUTH_CLIENT_ID__';

class IdentityTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.IDENTITY;
  static readonly mutates = true;

  async execute(args: IdentityParams): Promise<ToolResult> {
    const action = args?.action;
    if (action !== 'get_token' && action !== 'remove_token' && action !== 'get_profile') {
      return createErrorResponse(
        'Parameter [action] is required and must be one of: get_token, remove_token, get_profile.',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'action' },
      );
    }
    if (typeof chrome.identity === 'undefined') {
      return createErrorResponse(
        'chrome.identity is unavailable — the `identity` permission is not granted.',
        ToolErrorCode.UNKNOWN,
      );
    }

    try {
      switch (action) {
        case 'get_token':
          return await this.actionGetToken(args);
        case 'remove_token':
          return await this.actionRemoveToken(args);
        case 'get_profile':
          return await this.actionGetProfile();
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // Placeholder client_id, OAuth not granted, missing scopes — these all
      // bubble up as runtime errors. Surface the placeholder-specific case
      // with INVALID_ARGS so the agent can see "config drift" not "Google
      // rejected us".
      if (
        /OAuth2 not granted|oauth2.client_id|client_id|__SET_HUMANCHROME_OAUTH_CLIENT_ID__/i.test(
          msg,
        )
      ) {
        return createErrorResponse(
          `OAuth2 client_id is not configured. Set HUMANCHROME_OAUTH_CLIENT_ID env var (placeholder is "${PLACEHOLDER_CLIENT_ID}") and rebuild the extension. Original error: ${msg}`,
          ToolErrorCode.INVALID_ARGS,
          { arg: 'oauth2.client_id' },
        );
      }
      console.error('Error in IdentityTool.execute:', error);
      return createErrorResponse(`chrome_identity failed: ${msg}`, ToolErrorCode.UNKNOWN, {
        action,
      });
    }
  }

  private async actionGetToken(args: IdentityParams): Promise<ToolResult> {
    const scopes = Array.isArray(args.scopes) ? args.scopes : [];
    const interactive = args.interactive === true;
    const token = await new Promise<string>((resolve, reject) => {
      const opts: chrome.identity.TokenDetails = { interactive };
      if (scopes.length > 0) opts.scopes = scopes;
      chrome.identity.getAuthToken(opts, (t) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (typeof t === 'string') {
          resolve(t);
        } else if (t && typeof (t as { token?: string }).token === 'string') {
          resolve((t as { token: string }).token);
        } else {
          reject(new Error('getAuthToken returned no token'));
        }
      });
    });
    return jsonOk({
      ok: true,
      action: 'get_token',
      token,
      interactive,
      scopes,
    });
  }

  private async actionRemoveToken(args: IdentityParams): Promise<ToolResult> {
    if (typeof args.token !== 'string' || args.token.length === 0) {
      return createErrorResponse(
        'Parameter [token] is required for action="remove_token".',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'token' },
      );
    }
    await new Promise<void>((resolve) =>
      chrome.identity.removeCachedAuthToken({ token: args.token as string }, () => resolve()),
    );
    return jsonOk({ ok: true, action: 'remove_token' });
  }

  private async actionGetProfile(): Promise<ToolResult> {
    const info = await new Promise<{ email?: string; id?: string }>((resolve) =>
      chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }, (i) =>
        resolve(i as { email?: string; id?: string }),
      ),
    );
    return jsonOk({
      ok: true,
      action: 'get_profile',
      email: info.email ?? '',
      id: info.id ?? '',
    });
  }
}

function jsonOk(body: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false };
}

export const identityTool = new IdentityTool();
