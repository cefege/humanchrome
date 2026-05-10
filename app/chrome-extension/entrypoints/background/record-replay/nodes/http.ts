import { TOOL_NAMES } from 'humanchrome-shared';
import { handleCallTool } from '@/entrypoints/background/tools';
import type { StepHttp } from '../legacy-types';
import { applyAssign, expandTemplatesDeep } from '../rr-utils';
import type { ExecCtx, ExecResult, NodeRuntime } from './types';

export const httpNode: NodeRuntime<StepHttp> = {
  run: async (ctx: ExecCtx, step: StepHttp) => {
    const s = expandTemplatesDeep<StepHttp>(step, ctx.vars);
    const res = await handleCallTool({
      name: TOOL_NAMES.BROWSER.NETWORK_REQUEST,
      args: {
        url: s.url,
        method: s.method || 'GET',
        headers: s.headers || {},
        body: s.body,
        formData: s.formData,
      },
    });
    const text = (res as { content?: Array<{ type?: string; text?: string }> })?.content?.find(
      (c) => c.type === 'text',
    )?.text;
    try {
      const payload = text ? JSON.parse(text) : null;
      if (s.saveAs && payload !== undefined) ctx.vars[s.saveAs] = payload;
      if (s.assign && payload !== undefined) applyAssign(ctx.vars, payload, s.assign);
    } catch {}
    return {} as ExecResult;
  },
};
