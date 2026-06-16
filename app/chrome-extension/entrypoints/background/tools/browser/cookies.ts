import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';

/**
 * chrome_get_cookies parameters.
 */
interface GetCookiesParams {
  url?: string;
  domain?: string;
  name?: string;
  path?: string;
  secure?: boolean;
  session?: boolean;
  storeId?: string;
}

/**
 * chrome_set_cookie parameters. Mirrors chrome.cookies.SetDetails.
 */
interface SetCookieParams {
  url?: string;
  name?: string;
  value?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: chrome.cookies.SameSiteStatus;
  expirationDate?: number;
  storeId?: string;
}

/**
 * chrome_remove_cookie parameters. Mirrors chrome.cookies.CookieDetails.
 */
interface RemoveCookieParams {
  url?: string;
  name?: string;
  storeId?: string;
}

/**
 * Read cookies from the Chrome cookie store.
 *
 * chrome.cookies is profile-scoped (not tab-scoped), so this tool does not
 * resolve a tab and does not opt into the per-tab serialization lock.
 * Requires at least one of `url` or `domain` to keep the response bounded —
 * passing neither could return every cookie in the profile.
 */
class GetCookiesTool extends BaseBrowserToolExecutor {
  name = 'chrome_cookies__get_internal';

  async execute(args: GetCookiesParams): Promise<ToolResult> {
    const { url, domain, name, path, secure, session, storeId } = args || {};

    if (!url && !domain) {
      return createErrorResponse(
        'At least one of `url` or `domain` is required to bound the cookie query.',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'url|domain' },
      );
    }

    const filter: chrome.cookies.GetAllDetails = {};
    if (url !== undefined) filter.url = url;
    if (domain !== undefined) filter.domain = domain;
    if (name !== undefined) filter.name = name;
    if (path !== undefined) filter.path = path;
    if (secure !== undefined) filter.secure = secure;
    if (session !== undefined) filter.session = session;
    if (storeId !== undefined) filter.storeId = storeId;

    try {
      const cookies = await chrome.cookies.getAll(filter);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                count: cookies.length,
                filter,
                cookies,
              },
              null,
              2,
            ),
          },
        ],
        isError: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return createErrorResponse(`Error reading cookies: ${message}`);
    }
  }
}

/**
 * Set a single cookie. `url` is required because chrome.cookies.set uses it
 * to derive default `domain`/`path` and to validate Secure cookies.
 */
class SetCookieTool extends BaseBrowserToolExecutor {
  name = 'chrome_cookies__set_internal';

  async execute(args: SetCookieParams): Promise<ToolResult> {
    const { url, name, value, domain, path, secure, httpOnly, sameSite, expirationDate, storeId } =
      args || {};

    if (!url) {
      return createErrorResponse(
        '`url` is required by chrome.cookies.set (used to derive default domain/path).',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'url' },
      );
    }

    const details: chrome.cookies.SetDetails = { url };
    if (name !== undefined) details.name = name;
    if (value !== undefined) details.value = value;
    if (domain !== undefined) details.domain = domain;
    if (path !== undefined) details.path = path;
    if (secure !== undefined) details.secure = secure;
    if (httpOnly !== undefined) details.httpOnly = httpOnly;
    if (sameSite !== undefined) details.sameSite = sameSite;
    if (expirationDate !== undefined) details.expirationDate = expirationDate;
    if (storeId !== undefined) details.storeId = storeId;

    try {
      const cookie = await chrome.cookies.set(details);

      // chrome.cookies.set resolves with `null` when the write was rejected
      // (invalid attributes, restricted cookie, etc). Surface that as an error
      // rather than a misleading success.
      if (!cookie) {
        return createErrorResponse(
          'chrome.cookies.set returned null — the cookie was not stored. Common causes: Secure flag without https URL, mismatched domain/url, or invalid SameSite value.',
          ToolErrorCode.INVALID_ARGS,
          { details },
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                cookie,
              },
              null,
              2,
            ),
          },
        ],
        isError: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return createErrorResponse(`Error setting cookie: ${message}`);
    }
  }
}

/**
 * Delete a single cookie by URL + name.
 */
class RemoveCookieTool extends BaseBrowserToolExecutor {
  name = 'chrome_cookies__remove_internal';

  async execute(args: RemoveCookieParams): Promise<ToolResult> {
    const { url, name, storeId } = args || {};

    if (!url || !name) {
      return createErrorResponse(
        'Both `url` and `name` are required to identify the cookie to remove.',
        ToolErrorCode.INVALID_ARGS,
        { arg: !url ? 'url' : 'name' },
      );
    }

    const details: chrome.cookies.CookieDetails = { url, name };
    if (storeId !== undefined) details.storeId = storeId;

    try {
      const removed = await chrome.cookies.remove(details);

      // chrome.cookies.remove resolves with null when no matching cookie was
      // found. That's an expected "no-op" outcome for callers, not a failure.
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                removed: removed ?? null,
              },
              null,
              2,
            ),
          },
        ],
        isError: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return createErrorResponse(`Error removing cookie: ${message}`);
    }
  }
}

const getCookiesInternal = new GetCookiesTool();
const setCookieInternal = new SetCookieTool();
const removeCookieInternal = new RemoveCookieTool();

/**
 * Unified chrome_cookies tool (Slice 5 of IMP-0188 catalog consolidation).
 * Routes by `action` to the get/set/remove handlers.
 */
type CookiesAction = 'get' | 'set' | 'remove';
const COOKIES_ACTIONS: readonly CookiesAction[] = ['get', 'set', 'remove'] as const;

interface CookiesToolParams extends GetCookiesParams, SetCookieParams, RemoveCookieParams {
  action: CookiesAction;
}

class CookiesTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.COOKIES;
  static readonly mutates = true;

  async execute(args: CookiesToolParams): Promise<ToolResult> {
    if (!args || typeof args.action !== 'string') {
      return createErrorResponse(
        `\`action\` is required (one of: ${COOKIES_ACTIONS.join(', ')})`,
        ToolErrorCode.INVALID_ARGS,
        { arg: 'action' },
      );
    }
    if (!COOKIES_ACTIONS.includes(args.action)) {
      return createErrorResponse(
        `Invalid action "${args.action}": expected one of ${COOKIES_ACTIONS.join(', ')}`,
        ToolErrorCode.INVALID_ARGS,
        { arg: 'action' },
      );
    }
    switch (args.action) {
      case 'get':
        return getCookiesInternal.execute(args);
      case 'set':
        return setCookieInternal.execute(args);
      case 'remove':
        return removeCookieInternal.execute(args);
    }
  }
}

export const cookiesTool = new CookiesTool();
