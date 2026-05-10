import type { StepWait } from '../legacy-types';
import { waitForNetworkIdle, waitForNavigation, expandTemplatesDeep } from '../rr-utils';
import type { ExecCtx, ExecResult, NodeRuntime } from './types';

interface WaitHelperResponse {
  success?: boolean;
  [k: string]: unknown;
}

export const waitNode: NodeRuntime<StepWait> = {
  validate: (step: StepWait) => {
    const ok = !!step.condition;
    return ok ? { ok } : { ok, errors: ['Missing wait condition'] };
  },
  run: async (ctx: ExecCtx, step: StepWait) => {
    const s = expandTemplatesDeep<StepWait>(step, ctx.vars);
    const cond = s.condition;
    if ('text' in cond) {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs?.[0]?.id;
      if (typeof tabId !== 'number') throw new Error('Active tab not found');
      const frameIds = typeof ctx.frameId === 'number' ? [ctx.frameId] : undefined;
      await chrome.scripting.executeScript({
        target: { tabId, frameIds },
        files: ['inject-scripts/wait-helper.js'],
        world: 'ISOLATED',
      });
      const resp = (await chrome.tabs.sendMessage(
        tabId,
        {
          action: 'waitForText',
          text: cond.text,
          appear: cond.appear !== false,
          timeout: Math.max(0, Math.min(s.timeoutMs || 10000, 120000)),
        },
        { frameId: ctx.frameId },
      )) as WaitHelperResponse;
      if (!resp || resp.success !== true) throw new Error('wait text failed');
    } else if ('networkIdle' in cond) {
      const total = Math.min(Math.max(1000, s.timeoutMs || 5000), 120000);
      const idle = Math.min(1500, Math.max(500, Math.floor(total / 3)));
      await waitForNetworkIdle(total, idle);
    } else if ('navigation' in cond) {
      await waitForNavigation(s.timeoutMs);
    } else if ('sleep' in cond) {
      const ms = Math.max(0, Number(cond.sleep ?? 0));
      await new Promise((r) => setTimeout(r, ms));
    } else if ('selector' in cond) {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs?.[0]?.id;
      if (typeof tabId !== 'number') throw new Error('Active tab not found');
      const frameIds = typeof ctx.frameId === 'number' ? [ctx.frameId] : undefined;
      await chrome.scripting.executeScript({
        target: { tabId, frameIds },
        files: ['inject-scripts/wait-helper.js'],
        world: 'ISOLATED',
      });
      const resp = (await chrome.tabs.sendMessage(
        tabId,
        {
          action: 'waitForSelector',
          selector: cond.selector,
          visible: cond.visible !== false,
          timeout: Math.max(0, Math.min(s.timeoutMs || 10000, 120000)),
        },
        { frameId: ctx.frameId },
      )) as WaitHelperResponse;
      if (!resp || resp.success !== true) throw new Error('wait selector failed');
    }
    return {} as ExecResult;
  },
};
