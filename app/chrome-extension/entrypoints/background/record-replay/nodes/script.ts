import type { StepScript } from '../legacy-types';
import { expandTemplatesDeep, applyAssign } from '../rr-utils';
import type { ExecCtx, ExecResult, NodeRuntime } from './types';

interface ScriptStepExtras {
  saveAs?: string;
  assign?: Record<string, string>;
}

export const scriptNode: NodeRuntime<StepScript> = {
  run: async (ctx: ExecCtx, step: StepScript) => {
    const s = expandTemplatesDeep<StepScript>(step, ctx.vars);
    if (s.when === 'after') return { deferAfterScript: s } as ExecResult;
    const world = s.world || 'ISOLATED';
    const code = String(s.code || '');
    if (!code.trim()) return {} as ExecResult;
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs?.[0]?.id;
    if (typeof tabId !== 'number') throw new Error('Active tab not found');
    const frameIds = typeof ctx.frameId === 'number' ? [ctx.frameId] : undefined;
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId, frameIds },
      func: (userCode: string) => {
        try {
          return (0, eval)(userCode);
        } catch {
          return null;
        }
      },
      args: [code],
      world,
    });
    const ext = s as StepScript & ScriptStepExtras;
    if (ext.saveAs) ctx.vars[ext.saveAs] = result;
    if (ext.assign && typeof ext.assign === 'object') applyAssign(ctx.vars, result, ext.assign);
    return {} as ExecResult;
  },
};
