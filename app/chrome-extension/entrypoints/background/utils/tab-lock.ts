/**
 * @deprecated Re-export shim. The implementation moved to `tab-queue.ts` as
 * part of IMP-0087 (round-robin fairness, depth cap, per-call timeout, EWMA
 * inspection). Import from `./tab-queue` directly in new code; this shim
 * keeps the historic surface working until the next cleanup IMP deletes it.
 */
export {
  acquireTabLock,
  withTabLock,
  activeLockedTabCount,
  _resetTabQueueForTests as _resetTabLocksForTests,
  type AcquireOptions,
  type Release,
} from './tab-queue';
