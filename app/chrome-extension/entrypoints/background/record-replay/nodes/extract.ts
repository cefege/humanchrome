import type { StepExtract } from '../legacy-types';
import { expandTemplatesDeep } from '../rr-utils';
import type { ExecCtx, ExecResult, NodeRuntime } from './types';

export const extractNode: NodeRuntime<StepExtract> = {
  run: async (ctx: ExecCtx, step: StepExtract) => {
    const s = expandTemplatesDeep<StepExtract>(step, ctx.vars);
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs?.[0]?.id;
    if (typeof tabId !== 'number') throw new Error('Active tab not found');
    let value: unknown = null;
    if (s.js && String(s.js).trim()) {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (code: string) => {
          try {
            return (0, eval)(code);
          } catch {
            return null;
          }
        },
        args: [String(s.js)],
      });
      value = result;
    } else if (s.selector) {
      const attr = String(s.attr || 'text');
      const sel = String(s.selector);
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (selector: string, a: string) => {
          try {
            const el = document.querySelector(selector);
            if (!el) return null;
            if (a === 'text' || a === 'textContent') return (el.textContent || '').trim();
            return el.getAttribute ? el.getAttribute(a) : null;
          } catch {
            return null;
          }
        },
        args: [sel, attr],
      });
      value = result;
    }
    if (s.saveAs) ctx.vars[s.saveAs] = value;
    return {} as ExecResult;
  },
};
