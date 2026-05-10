import { TOOL_NAMES } from 'humanchrome-shared';
import { handleCallTool } from '@/entrypoints/background/tools';
import type { StepOpenTab, StepSwitchTab, StepCloseTab } from '../legacy-types';
import { expandTemplatesDeep } from '../rr-utils';
import type { ExecCtx, ExecResult, NodeRuntime } from './types';

export const openTabNode: NodeRuntime<StepOpenTab> = {
  run: async (ctx: ExecCtx, step: StepOpenTab) => {
    const s = expandTemplatesDeep<StepOpenTab>(step, ctx.vars);
    if (s.newWindow) await chrome.windows.create({ url: s.url || undefined, focused: true });
    else await chrome.tabs.create({ url: s.url || undefined, active: true });
    return {} as ExecResult;
  },
};

export const switchTabNode: NodeRuntime<StepSwitchTab> = {
  run: async (ctx: ExecCtx, step: StepSwitchTab) => {
    const s = expandTemplatesDeep<StepSwitchTab>(step, ctx.vars);
    let targetTabId: number | undefined = s.tabId;
    if (!targetTabId) {
      const tabs = await chrome.tabs.query({});
      const hit = tabs.find(
        (t) =>
          (s.urlContains && (t.url || '').includes(String(s.urlContains))) ||
          (s.titleContains && (t.title || '').includes(String(s.titleContains))),
      );
      targetTabId = hit?.id;
    }
    if (!targetTabId) throw new Error('switchTab: no matching tab');
    const res = await handleCallTool({
      name: TOOL_NAMES.BROWSER.SWITCH_TAB,
      args: { tabId: targetTabId },
    });
    if ((res as { isError?: boolean }).isError) throw new Error('switchTab failed');
    return {} as ExecResult;
  },
};

export const closeTabNode: NodeRuntime<StepCloseTab> = {
  run: async (ctx: ExecCtx, step: StepCloseTab) => {
    const s = expandTemplatesDeep<StepCloseTab>(step, ctx.vars);
    const args: { tabIds?: number[]; url?: string } = {};
    if (Array.isArray(s.tabIds) && s.tabIds.length) args.tabIds = s.tabIds;
    if (s.url) args.url = s.url;
    const res = await handleCallTool({ name: TOOL_NAMES.BROWSER.CLOSE_TAB, args });
    if ((res as { isError?: boolean }).isError) throw new Error('closeTab failed');
    return {} as ExecResult;
  },
};
