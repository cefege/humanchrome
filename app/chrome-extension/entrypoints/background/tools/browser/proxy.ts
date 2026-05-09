import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';

type ProxyAction = 'set' | 'clear' | 'get';
type ProxyMode = 'direct' | 'system' | 'fixed_servers' | 'pac_script';
type ProxyScheme = 'http' | 'https' | 'quic' | 'socks4' | 'socks5';

interface ProxyParams {
  action: ProxyAction;
  mode?: ProxyMode;
  singleProxy?: { scheme?: ProxyScheme; host: string; port: number };
  bypassList?: string[];
  pacUrl?: string;
}

interface ProxySettingsResult {
  value: chrome.proxy.ProxyConfig;
  levelOfControl: string;
  incognitoSpecific?: boolean;
}

class ProxyTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.PROXY;
  static readonly mutates = true;

  async execute(args: ProxyParams): Promise<ToolResult> {
    const action = args?.action;
    if (action !== 'set' && action !== 'clear' && action !== 'get') {
      return createErrorResponse(
        'Parameter [action] is required and must be one of: set, clear, get.',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'action' },
      );
    }
    if (typeof chrome.proxy === 'undefined') {
      return createErrorResponse(
        'chrome.proxy is unavailable — the `proxy` permission is not granted.',
        ToolErrorCode.UNKNOWN,
      );
    }

    try {
      switch (action) {
        case 'set':
          return await this.actionSet(args);
        case 'clear':
          return await this.actionClear();
        case 'get':
          return await this.actionGet();
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('Error in ProxyTool.execute:', error);
      return createErrorResponse(`chrome_proxy failed: ${msg}`, ToolErrorCode.UNKNOWN, { action });
    }
  }

  private async actionSet(args: ProxyParams): Promise<ToolResult> {
    const mode = args.mode;
    if (
      mode !== 'direct' &&
      mode !== 'system' &&
      mode !== 'fixed_servers' &&
      mode !== 'pac_script'
    ) {
      return createErrorResponse(
        'Parameter [mode] is required for action="set" and must be one of: direct, system, fixed_servers, pac_script.',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'mode' },
      );
    }

    const config: chrome.proxy.ProxyConfig = { mode };

    if (mode === 'fixed_servers') {
      const sp = args.singleProxy;
      if (
        !sp ||
        typeof sp.host !== 'string' ||
        sp.host.length === 0 ||
        typeof sp.port !== 'number'
      ) {
        return createErrorResponse(
          'Parameter [singleProxy] (with host + port) is required when mode="fixed_servers".',
          ToolErrorCode.INVALID_ARGS,
          { arg: 'singleProxy' },
        );
      }
      const rules: chrome.proxy.ProxyRules = {
        singleProxy: {
          scheme: sp.scheme ?? 'http',
          host: sp.host,
          port: sp.port,
        },
      };
      if (Array.isArray(args.bypassList) && args.bypassList.length > 0) {
        rules.bypassList = args.bypassList;
      }
      config.rules = rules;
    } else if (mode === 'pac_script') {
      if (typeof args.pacUrl !== 'string' || args.pacUrl.length === 0) {
        return createErrorResponse(
          'Parameter [pacUrl] is required when mode="pac_script".',
          ToolErrorCode.INVALID_ARGS,
          { arg: 'pacUrl' },
        );
      }
      config.pacScript = { url: args.pacUrl, mandatory: true };
    }

    await chrome.proxy.settings.set({ value: config, scope: 'regular' });
    return jsonOk({ ok: true, action: 'set', mode, config });
  }

  private async actionClear(): Promise<ToolResult> {
    await chrome.proxy.settings.clear({ scope: 'regular' });
    return jsonOk({ ok: true, action: 'clear' });
  }

  private async actionGet(): Promise<ToolResult> {
    const result = await new Promise<ProxySettingsResult>((resolve) =>
      chrome.proxy.settings.get({}, (details) => resolve(details as ProxySettingsResult)),
    );
    return jsonOk({
      ok: true,
      action: 'get',
      value: result.value,
      levelOfControl: result.levelOfControl,
      incognitoSpecific: result.incognitoSpecific ?? null,
    });
  }
}

function jsonOk(body: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false };
}

export const proxyTool = new ProxyTool();
