import { replayPolicy } from 'humanchrome-shared';
import type { StepForeach, StepWhile } from '../legacy-types';
import type { ExecCtx, ExecResult, NodeRuntime } from './types';

interface ForeachExtras {
  concurrency?: number;
}

export const foreachNode: NodeRuntime<StepForeach> = {
  validate: (step: StepForeach) => {
    try {
      replayPolicy.replayForeachPlan({
        listVar: step.listVar,
        itemVar: step.itemVar,
        subflowId: step.subflowId,
        concurrency: Number((step as StepForeach & ForeachExtras).concurrency ?? 1),
      });
      return { ok: true };
    } catch {
      return { ok: false, errors: ['foreach: listVar and subflowId are required'] };
    }
  },
  run: async (_ctx: ExecCtx, step: StepForeach) => {
    const plan = replayPolicy.replayForeachPlan({
      listVar: step.listVar,
      itemVar: step.itemVar,
      subflowId: step.subflowId,
      concurrency: Number((step as StepForeach & ForeachExtras).concurrency ?? 1),
    });
    return { control: plan } as ExecResult;
  },
};

export const whileNode: NodeRuntime<StepWhile> = {
  validate: (step: StepWhile) => {
    try {
      replayPolicy.replayWhilePlan({
        hasCondition: !!step.condition,
        subflowId: step.subflowId,
        maxIterations: Number(step.maxIterations ?? 100),
      });
      return { ok: true };
    } catch {
      return { ok: false, errors: ['while: condition and subflowId are required'] };
    }
  },
  run: async (_ctx: ExecCtx, step: StepWhile) => {
    const plan = replayPolicy.replayWhilePlan({
      hasCondition: !!step.condition,
      subflowId: step.subflowId,
      maxIterations: Number(step.maxIterations ?? 100),
    });
    return {
      control: { ...plan, condition: step.condition },
    } as ExecResult;
  },
};
