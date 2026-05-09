/**
 * Backwards-compat shim for the in-extension debug log.
 *
 * The real implementation lives in `app/chrome-extension/utils/logger.ts` —
 * this file just re-exports the same symbols so the existing
 * `from '../utils/debug-log'` imports keep working without churn.
 */
export {
  DEBUG_LOG_LEVELS,
  type DebugLogLevel,
  type DebugLogEntry,
  type DumpFilter,
  type LogContext,
  logger as debugLog,
  logEvent,
  dumpLog,
  clearLog,
  getBufferSize,
  setLogLevel,
  getLogLevel,
  setPersistEnabled,
  getPersistEnabled,
} from '@/utils/logger';
