import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, ToolErrorCode } from 'humanchrome-shared';

type BlockOrRedirectAction = 'add' | 'remove' | 'list' | 'clear';
type RuleAction = 'block' | 'redirect';
type ResourceType =
  | 'main_frame'
  | 'sub_frame'
  | 'stylesheet'
  | 'script'
  | 'image'
  | 'font'
  | 'object'
  | 'xmlhttprequest'
  | 'ping'
  | 'csp_report'
  | 'media'
  | 'websocket'
  | 'webtransport'
  | 'webbundle'
  | 'other';

interface BlockOrRedirectParams {
  action: BlockOrRedirectAction;
  ruleId?: number;
  urlFilter?: string;
  ruleAction?: RuleAction;
  redirectUrl?: string;
  resourceTypes?: ResourceType[];
}

class BlockOrRedirectTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.BLOCK_OR_REDIRECT;
  static readonly mutates = true;

  async execute(args: BlockOrRedirectParams): Promise<ToolResult> {
    const action = args?.action;
    if (action !== 'add' && action !== 'remove' && action !== 'list' && action !== 'clear') {
      return createErrorResponse(
        'Parameter [action] is required and must be one of: add, remove, list, clear.',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'action' },
      );
    }
    if (typeof chrome.declarativeNetRequest === 'undefined') {
      return createErrorResponse(
        'chrome.declarativeNetRequest is unavailable.',
        ToolErrorCode.UNKNOWN,
      );
    }

    try {
      switch (action) {
        case 'add':
          return await this.actionAdd(args);
        case 'remove':
          return await this.actionRemove(args);
        case 'list':
          return await this.actionList();
        case 'clear':
          return await this.actionClear();
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('Error in BlockOrRedirectTool.execute:', error);
      return createErrorResponse(`chrome_block_or_redirect failed: ${msg}`, ToolErrorCode.UNKNOWN, {
        action,
      });
    }
  }

  private async nextRuleId(): Promise<number> {
    const existing = await chrome.declarativeNetRequest.getSessionRules();
    let max = 0;
    for (const rule of existing) {
      if (rule.id > max) max = rule.id;
    }
    return max + 1;
  }

  private async actionAdd(args: BlockOrRedirectParams): Promise<ToolResult> {
    if (typeof args.urlFilter !== 'string' || args.urlFilter.length === 0) {
      return createErrorResponse(
        'Parameter [urlFilter] is required for action="add".',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'urlFilter' },
      );
    }
    if (args.ruleAction !== 'block' && args.ruleAction !== 'redirect') {
      return createErrorResponse(
        'Parameter [ruleAction] is required and must be "block" or "redirect".',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'ruleAction' },
      );
    }
    if (args.ruleAction === 'redirect') {
      if (typeof args.redirectUrl !== 'string' || args.redirectUrl.length === 0) {
        return createErrorResponse(
          'Parameter [redirectUrl] is required when ruleAction="redirect".',
          ToolErrorCode.INVALID_ARGS,
          { arg: 'redirectUrl' },
        );
      }
    }

    const ruleId = typeof args.ruleId === 'number' ? args.ruleId : await this.nextRuleId();

    const ruleActionShape =
      args.ruleAction === 'redirect'
        ? {
            type: 'redirect' as chrome.declarativeNetRequest.RuleActionType,
            redirect: { url: args.redirectUrl as string },
          }
        : { type: 'block' as chrome.declarativeNetRequest.RuleActionType };

    const rule: chrome.declarativeNetRequest.Rule = {
      id: ruleId,
      priority: 1,
      action: ruleActionShape,
      condition: {
        urlFilter: args.urlFilter,
        ...(Array.isArray(args.resourceTypes) && args.resourceTypes.length > 0
          ? {
              resourceTypes:
                args.resourceTypes as unknown as chrome.declarativeNetRequest.ResourceType[],
            }
          : {}),
      },
    };

    await chrome.declarativeNetRequest.updateSessionRules({ addRules: [rule] });
    return jsonOk({ ok: true, action: 'add', ruleId, rule });
  }

  private async actionRemove(args: BlockOrRedirectParams): Promise<ToolResult> {
    if (typeof args.ruleId !== 'number') {
      return createErrorResponse(
        'Parameter [ruleId] is required for action="remove".',
        ToolErrorCode.INVALID_ARGS,
        { arg: 'ruleId' },
      );
    }
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [args.ruleId] });
    return jsonOk({ ok: true, action: 'remove', ruleId: args.ruleId });
  }

  private async actionList(): Promise<ToolResult> {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    return jsonOk({ ok: true, action: 'list', rules, count: rules.length });
  }

  private async actionClear(): Promise<ToolResult> {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const ids = rules.map((r) => r.id);
    if (ids.length > 0) {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
    }
    return jsonOk({ ok: true, action: 'clear', removed: ids.length });
  }
}

function jsonOk(body: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false };
}

export const blockOrRedirectTool = new BlockOrRedirectTool();
