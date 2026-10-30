import { replayPolicy } from 'humanchrome-shared';
import type { StepIf } from '../legacy-types';
import type { ExecCtx, ExecResult, NodeRuntime } from './types';

interface IfBranch {
  id?: string;
  label?: string;
  expr?: string;
}

interface IfBranchesShape {
  branches?: IfBranch[];
  else?: string;
}

export const ifNode: NodeRuntime<StepIf> = {
  validate: (step: StepIf) => {
    const ext = step as StepIf & IfBranchesShape;
    const hasBranches = Array.isArray(ext.branches) && ext.branches.length > 0;
    const error = replayPolicy.replayValidateIf(hasBranches, !!step.condition);
    return error ? { ok: false, errors: [error] } : { ok: true };
  },
  run: async (ctx: ExecCtx, step: StepIf) => {
    const ext = step as StepIf & IfBranchesShape;
    if (Array.isArray(ext.branches) && ext.branches.length > 0) {
      const evalExpr = (expr: string): boolean => {
        const code = String(expr || '').trim();
        if (!code) return false;
        try {
          const fn = new Function(
            'vars',
            'workflow',
            `try { return !!(${code}); } catch (e) { return false; }`,
          );
          return !!fn(ctx.vars, ctx.vars);
        } catch {
          return false;
        }
      };
      const labels = ext.branches.map((branch) =>
        String(branch?.label || `case:${branch?.id || 'match'}`),
      );
      const matchingIndex = ext.branches.findIndex(
        (branch) => !!branch?.expr && evalExpr(String(branch.expr)),
      );
      return {
        nextLabel: replayPolicy.replayIfBranchLabel(
          labels,
          matchingIndex < 0 ? undefined : matchingIndex,
          'else' in ext,
          String(ext.else || 'default'),
        ),
      } as ExecResult;
    }
    // legacy condition: { var/equals | expression }
    try {
      let result = false;
      const cond = step.condition as
        | { expression?: string; var?: string; equals?: unknown }
        | undefined
        | null;
      if (cond && typeof cond.expression === 'string' && cond.expression.trim()) {
        const fn = new Function(
          'vars',
          `try { return !!(${cond.expression}); } catch (e) { return false; }`,
        );
        result = !!fn(ctx.vars);
      } else if (cond && typeof cond.var === 'string') {
        const v = ctx.vars[cond.var];
        if ('equals' in cond) result = String(v) === String(cond.equals);
        else result = !!v;
      }
      return {
        nextLabel: replayPolicy.replayIfBranchLabel(['false', 'true'], result ? 1 : 0, false, 'default'),
      } as ExecResult;
    } catch {
      return {
        nextLabel: replayPolicy.replayIfBranchLabel(['false'], 0, false, 'default'),
      } as ExecResult;
    }
  },
};
