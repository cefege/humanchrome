import type { Step } from '../types';
import type { StepExecuteFlow } from '../legacy-types';
import type { ExecCtx, ExecResult, NodeRuntime } from './types';

interface ClickStepAfter {
  waitForNavigation?: boolean;
  waitForNetworkIdle?: boolean;
}

interface FlowDag {
  nodes?: unknown[];
  edges?: unknown[];
}

export const executeFlowNode: NodeRuntime<StepExecuteFlow> = {
  validate: (step: StepExecuteFlow) => {
    const ok = typeof step.flowId === 'string' && !!step.flowId;
    return ok ? { ok } : { ok, errors: ['flowId is required'] };
  },
  run: async (ctx: ExecCtx, step: StepExecuteFlow) => {
    const { getFlow } = await import('../flow-store');
    const flow = await getFlow(String(step.flowId));
    if (!flow) throw new Error('referenced flow not found');
    const inline = step.inline !== false; // default inline
    if (!inline) {
      const { runFlow } = await import('../flow-runner');
      await runFlow(flow, { args: step.args || {}, returnLogs: false });
      return {} as ExecResult;
    }
    const { defaultEdgesOnly, topoOrder, mapDagNodeToStep, waitForNetworkIdle, waitForNavigation } =
      await import('../rr-utils');
    const vars = ctx.vars;
    if (step.args && typeof step.args === 'object') Object.assign(vars, step.args);

    const dag = flow as FlowDag;
    const nodes = dag.nodes || [];
    const edges = dag.edges || [];
    if (nodes.length === 0) {
      throw new Error(
        'Flow has no DAG nodes. Linear steps are no longer supported. Please migrate this flow to nodes/edges.',
      );
    }
    const defaultEdges = defaultEdgesOnly(edges as Parameters<typeof defaultEdgesOnly>[0]);
    const order = topoOrder(
      nodes as Parameters<typeof topoOrder>[0],
      defaultEdges as Parameters<typeof topoOrder>[1],
    );
    const stepsToRun: Step[] = order.map((n) =>
      mapDagNodeToStep(n as Parameters<typeof mapDagNodeToStep>[0]),
    ) as Step[];
    for (const st of stepsToRun) {
      const t0 = Date.now();
      const maxRetries = Math.max(0, st.retry?.count ?? 0);
      const baseInterval = Math.max(0, st.retry?.intervalMs ?? 0);
      let attempt = 0;
      const doDelay = async (i: number) => {
        const delay =
          baseInterval > 0
            ? st.retry?.backoff === 'exp'
              ? baseInterval * Math.pow(2, i)
              : baseInterval
            : 0;
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      };
      while (true) {
        try {
          const beforeInfo = await (async () => {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            const tab = tabs[0];
            return { url: tab?.url || '', status: tab?.status || '' };
          })();
          const { executeStep } = await import('../nodes');
          const result = await executeStep(ctx, st);
          if (st.type === 'click' || st.type === 'dblclick') {
            const after = (st as Step & { after?: ClickStepAfter }).after;
            if (after?.waitForNavigation) {
              await waitForNavigation(st.timeoutMs, beforeInfo.url);
            } else if (after?.waitForNetworkIdle) {
              await waitForNetworkIdle(Math.min(st.timeoutMs || 5000, 120000), 1200);
            }
          }
          if (!result?.alreadyLogged) {
            ctx.logger({ stepId: st.id, status: 'success', tookMs: Date.now() - t0 });
          }
          break;
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          if (attempt < maxRetries) {
            ctx.logger({ stepId: st.id, status: 'retrying', message });
            await doDelay(attempt);
            attempt += 1;
            continue;
          }
          ctx.logger({
            stepId: st.id,
            status: 'failed',
            message,
            tookMs: Date.now() - t0,
          });
          throw e;
        }
      }
    }
    return {} as ExecResult;
  },
};
