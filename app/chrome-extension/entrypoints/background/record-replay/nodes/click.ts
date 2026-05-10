import { TOOL_NAMES } from 'humanchrome-shared';
import { handleCallTool } from '@/entrypoints/background/tools';
import type { StepClick } from '../legacy-types';
import { locateElement } from '../selector-engine';
import { expandTemplatesDeep } from '../rr-utils';
import type { ExecCtx, ExecResult, NodeRuntime } from './types';

interface ResolveRefResponse {
  rect?: { width: number; height: number };
  [k: string]: unknown;
}

async function runClickStep(
  ctx: ExecCtx,
  step: StepClick,
  options: { double?: boolean; failureMessage: string },
): Promise<ExecResult> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const firstTab = tabs && tabs[0];
  const tabId = firstTab && typeof firstTab.id === 'number' ? firstTab.id : undefined;
  if (!tabId) throw new Error('Active tab not found');
  await handleCallTool({ name: TOOL_NAMES.BROWSER.READ_PAGE, args: {} });
  const s = expandTemplatesDeep<StepClick>(step, ctx.vars);
  const located = await locateElement(tabId, s.target, ctx.frameId);
  const frameId = located?.frameId ?? ctx.frameId;
  const first = s.target?.candidates?.[0]?.type;
  const resolvedBy = located?.resolvedBy || (located?.ref ? 'ref' : '');
  const fallbackUsed = resolvedBy && first && resolvedBy !== 'ref' && resolvedBy !== first;
  if (located?.ref) {
    const resolved = (await chrome.tabs.sendMessage(
      tabId,
      { action: 'resolveRef', ref: located.ref },
      { frameId },
    )) as ResolveRefResponse;
    const rect = resolved?.rect;
    if (!rect || rect.width <= 0 || rect.height <= 0) throw new Error('element not visible');
  }
  const res = await handleCallTool({
    name: TOOL_NAMES.BROWSER.CLICK,
    args: {
      ref: located?.ref || step.target?.ref,
      selector: !located?.ref
        ? s.target?.candidates?.find((c) => c.type === 'css' || c.type === 'attr')?.value
        : undefined,
      waitForNavigation: false,
      timeout: Math.max(1000, Math.min(s.timeoutMs || 10000, 30000)),
      frameId,
      ...(options.double ? { double: true } : {}),
    },
  });
  if ((res as { isError?: boolean }).isError) throw new Error(options.failureMessage);
  if (fallbackUsed) {
    ctx.logger({
      stepId: step.id,
      status: 'success',
      message: `Selector fallback used (${String(first)} -> ${String(resolvedBy)})`,
      fallbackUsed: true,
      fallbackFrom: String(first),
      fallbackTo: String(resolvedBy),
    });
  }
  return {} as ExecResult;
}

export const clickNode: NodeRuntime<StepClick> = {
  validate: (step: StepClick) => {
    const ok = !!step.target?.candidates?.length;
    return ok ? { ok } : { ok, errors: ['Missing target selector candidates'] };
  },
  run: (ctx, step) => runClickStep(ctx, step, { failureMessage: 'click failed' }),
};

export const dblclickNode: NodeRuntime<StepClick> = {
  validate: clickNode.validate,
  run: (ctx, step) => runClickStep(ctx, step, { double: true, failureMessage: 'dblclick failed' }),
};
