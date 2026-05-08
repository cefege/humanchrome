/**
 * Pin the legacy `nodes/index.ts` registry for `executeFlow` and
 * `loopElements`. If a future refactor drops either entry, `executeStep`
 * throws the generic `unsupported step type: <type>` — distinct from each
 * node's own validate() error, so the tests below can distinguish "wired
 * but invalid input" from "silently skipped".
 */

import { describe, expect, it } from 'vitest';
import { executeStep } from '@/entrypoints/background/record-replay/nodes';
import { STEP_TYPES } from 'humanchrome-shared';
import { createMockExecCtx, createMockStep } from './_test-helpers';

describe('legacy executeStep — registry wiring', () => {
  it('routes executeFlow steps to executeFlowNode (registry entry present)', async () => {
    const ctx = createMockExecCtx();
    const step = createMockStep(STEP_TYPES.EXECUTE_FLOW);
    await expect(executeStep(ctx, step)).rejects.toThrow(/flowId is required/);
  });

  it('routes loopElements steps to loopElementsNode (registry entry present)', async () => {
    const ctx = createMockExecCtx();
    const step = createMockStep(STEP_TYPES.LOOP_ELEMENTS);
    await expect(executeStep(ctx, step)).rejects.toThrow(/selector and subflowId are required/);
  });

  it('still throws the unsupported-type error for genuinely unknown step types', async () => {
    // Negative-control so the assertions above can distinguish "wired" from
    // "silently skipped" — without this, both branches would look identical.
    const ctx = createMockExecCtx();
    const step = createMockStep('definitely_not_a_real_step_type');
    await expect(executeStep(ctx, step)).rejects.toThrow(/unsupported step type/);
  });
});
