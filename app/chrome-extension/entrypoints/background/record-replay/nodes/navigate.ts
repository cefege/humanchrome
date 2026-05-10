import { TOOL_NAMES } from 'humanchrome-shared';
import { handleCallTool } from '@/entrypoints/background/tools';
import type { StepNavigate } from '../legacy-types';
import type { ExecCtx, ExecResult, NodeRuntime } from './types';

export const navigateNode: NodeRuntime<StepNavigate> = {
  validate: (step) => {
    const ok = !!step.url;
    return ok ? { ok } : { ok, errors: ['Missing URL'] };
  },
  run: async (_ctx: ExecCtx, step: StepNavigate) => {
    const res = await handleCallTool({
      name: TOOL_NAMES.BROWSER.NAVIGATE,
      args: { url: step.url },
    });
    if ((res as { isError?: boolean }).isError) throw new Error('navigate failed');
    return {} as ExecResult;
  },
};
