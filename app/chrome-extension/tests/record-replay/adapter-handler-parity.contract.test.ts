/**
 * Adapter / Handler Registry Parity Contract Tests
 *
 * Guards against the kind of bug fixed in IMP-0036, where a handler is
 * implemented and registered in ALL_HANDLERS but the corresponding entry
 * is missing from STEP_TYPE_TO_ACTION_TYPE in adapter.ts.
 *
 * In actions-only execution mode (strict=true), any recorded flow step
 * whose type is missing from STEP_TYPE_TO_ACTION_TYPE throws an
 * unhandled error from createStepExecutor instead of executing.
 *
 * Contract:
 * - For every action type that has a registered replay handler AND whose
 *   step-type name matches the action-type name, STEP_TYPE_TO_ACTION_TYPE
 *   must contain a 1:1 mapping. The recorder emits step.type values that
 *   match these action types verbatim, so missing an entry breaks
 *   actions-only replay for that step type.
 * - Conversely, every step type listed in STEP_TYPE_TO_ACTION_TYPE must
 *   point to an action type that has a registered handler. A dangling
 *   mapping would let stepToAction() succeed but registry.get() would
 *   then fail at execution time.
 *
 * Notes / known exceptions:
 * - 'trigger' is not an executable action type (it is a Flow entrypoint
 *   marker), so even if it had a step counterpart it would be excluded
 *   from this parity check.
 * - 'loopElements' and 'executeFlow' are tracked separately as IMP-0040.
 *   Until handlers exist for them, they appear as legacy step types
 *   without a registered action handler and are intentionally absent
 *   from STEP_TYPE_TO_ACTION_TYPE.
 */

import { describe, expect, it } from 'vitest';

import {
  getActionType,
  isActionSupported,
} from '@/entrypoints/background/record-replay/actions/adapter';
import { getSupportedActionTypes } from '@/entrypoints/background/record-replay/actions/handlers';

// Action types that are intentionally not surfaced via STEP_TYPE_TO_ACTION_TYPE
// because no corresponding legacy step type exists or the wiring is
// tracked separately.
const ACTION_TYPES_WITHOUT_STEP_MAPPING = new Set<string>([
  // 'trigger' is excluded from EXECUTABLE_ACTION_TYPES already, but list
  // here defensively in case the registry ever surfaces it.
  'trigger',
]);

// Step types intentionally absent from STEP_TYPE_TO_ACTION_TYPE because
// their handlers do not yet exist (tracked by IMP-0040).
const STEP_TYPES_WITHOUT_HANDLER_YET = new Set<string>([
  'loopElements',
  'executeFlow',
]);

describe('STEP_TYPE_TO_ACTION_TYPE / ALL_HANDLERS parity', () => {
  it('every registered action handler with a 1:1 step-type counterpart is reachable via the adapter map', () => {
    const registeredTypes = getSupportedActionTypes().filter(
      (t) => !ACTION_TYPES_WITHOUT_STEP_MAPPING.has(t),
    );

    const missing: string[] = [];
    for (const actionType of registeredTypes) {
      // The recorder emits step.type === action type verbatim for the
      // 1:1 mappings exercised here. If a handler is registered but the
      // adapter does not map step.type -> action type, actions-only
      // replay throws "Unsupported step type for ActionRegistry: <type>".
      if (!isActionSupported(actionType)) {
        missing.push(actionType);
      }
    }

    expect(
      missing,
      `Action handlers are registered for these types but STEP_TYPE_TO_ACTION_TYPE is missing entries: ${missing.join(
        ', ',
      )}. Add entries to adapter.ts or, if a step type intentionally has no 1:1 mapping, document it in this test's exclusion list.`,
    ).toEqual([]);
  });

  it('triggerEvent and setAttribute (IMP-0036 regression) are wired through the adapter', () => {
    // Explicit assertions for the exact bug IMP-0036 fixed: the entries
    // were commented out even though handlers existed.
    expect(isActionSupported('triggerEvent')).toBe(true);
    expect(getActionType('triggerEvent')).toBe('triggerEvent');
    expect(isActionSupported('setAttribute')).toBe(true);
    expect(getActionType('setAttribute')).toBe('setAttribute');

    // And both must be backed by a registered handler.
    const registered = new Set(getSupportedActionTypes());
    expect(registered.has('triggerEvent')).toBe(true);
    expect(registered.has('setAttribute')).toBe(true);
  });

  it('every adapter-mapped step type points to a registered handler', () => {
    // Step types that are known to be handler-less today (tracked
    // separately) must remain absent from the adapter map; if they
    // ever appear here they should have a handler registered first.
    const registered = new Set(getSupportedActionTypes());
    const dangling: Array<{ stepType: string; actionType: string }> = [];

    // Collect via the public helper. We don't have a direct iterator
    // over the map, so we test the known step-type universe by walking
    // the registered action types plus the IMP-0040 placeholders.
    const candidateStepTypes = [
      ...registered,
      ...STEP_TYPES_WITHOUT_HANDLER_YET,
    ];

    for (const stepType of candidateStepTypes) {
      if (!isActionSupported(stepType)) {
        // Either intentionally unmapped (IMP-0040) or not exposed - skip.
        continue;
      }
      const mapped = getActionType(stepType);
      if (!mapped || !registered.has(mapped)) {
        dangling.push({ stepType, actionType: mapped ?? '<undefined>' });
      }
    }

    expect(
      dangling,
      `STEP_TYPE_TO_ACTION_TYPE maps these step types to action types with no registered handler: ${dangling
        .map((d) => `${d.stepType} -> ${d.actionType}`)
        .join(', ')}.`,
    ).toEqual([]);
  });

  it('IMP-0040 placeholders remain unmapped until their handlers ship', () => {
    // Sanity guard: if someone wires loopElements/executeFlow into the
    // adapter without registering handlers, this fires immediately.
    for (const stepType of STEP_TYPES_WITHOUT_HANDLER_YET) {
      const mapped = isActionSupported(stepType);
      const registered = new Set(getSupportedActionTypes());
      // Either both unmapped and unregistered (current state), or both
      // present together (future state once IMP-0040 lands).
      const handlerExists = registered.has(stepType);
      expect(
        mapped === handlerExists,
        `Step type "${stepType}" has adapter-mapped=${mapped} but handler-registered=${handlerExists}; these must move together.`,
      ).toBe(true);
    }
  });
});
