import type { StepForeach, StepWhile } from '../legacy-types';
import type { ExecCtx, ExecResult, NodeRuntime } from './types';
import { ENGINE_CONSTANTS } from '../engine/constants';

interface ForeachExtras {
  concurrency?: number;
}

export const foreachNode: NodeRuntime<StepForeach> = {
  validate: (step: StepForeach) => {
    const ok =
      typeof step.listVar === 'string' &&
      !!step.listVar &&
      typeof step.subflowId === 'string' &&
      !!step.subflowId;
    return ok ? { ok } : { ok, errors: ['foreach: listVar and subflowId are required'] };
  },
  run: async (_ctx: ExecCtx, step: StepForeach) => {
    const itemVar = typeof step.itemVar === 'string' && step.itemVar ? step.itemVar : 'item';
    const ext = step as StepForeach & ForeachExtras;
    return {
      control: {
        kind: 'foreach',
        listVar: String(step.listVar),
        itemVar,
        subflowId: String(step.subflowId),
        concurrency: Math.max(
          1,
          Math.min(ENGINE_CONSTANTS.MAX_FOREACH_CONCURRENCY, Number(ext.concurrency ?? 1)),
        ),
      },
    } as ExecResult;
  },
};

export const whileNode: NodeRuntime<StepWhile> = {
  validate: (step: StepWhile) => {
    const ok = !!step.condition && typeof step.subflowId === 'string' && !!step.subflowId;
    return ok ? { ok } : { ok, errors: ['while: condition and subflowId are required'] };
  },
  run: async (_ctx: ExecCtx, step: StepWhile) => {
    const max = Math.max(1, Math.min(10000, Number(step.maxIterations ?? 100)));
    return {
      control: {
        kind: 'while',
        condition: step.condition,
        subflowId: String(step.subflowId),
        maxIterations: max,
      },
    } as ExecResult;
  },
};
