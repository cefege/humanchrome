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
    const ok = hasBranches || !!step.condition;
    return ok ? { ok } : { ok, errors: ['Missing condition or branch'] };
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
      for (const br of ext.branches) {
        if (br?.expr && evalExpr(String(br.expr))) {
          return { nextLabel: String(br.label || `case:${br.id || 'match'}`) } as ExecResult;
        }
      }
      if ('else' in ext) return { nextLabel: String(ext.else || 'default') } as ExecResult;
      return { nextLabel: 'default' } as ExecResult;
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
      return { nextLabel: result ? 'true' : 'false' } as ExecResult;
    } catch {
      return { nextLabel: 'false' } as ExecResult;
    }
  },
};
