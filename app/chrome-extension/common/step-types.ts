// step-types.ts — re-export shared constants to keep single source of truth
export { STEP_TYPES } from 'humanchrome-shared';
export type StepTypeConst =
  (typeof import('humanchrome-shared'))['STEP_TYPES'][keyof (typeof import('humanchrome-shared'))['STEP_TYPES']];
