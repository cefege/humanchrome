/**
 * Lightweight structured logger.
 *
 * Writes to stderr only — stdout is reserved for native messaging framing,
 * so any accidental stdout write would corrupt the protocol.
 *
 * Goals:
 * - Per-request binding so each tool call is traceable end-to-end via a
 *   correlation `requestId` shared with the extension's debug log.
 * - Levels filterable at runtime via `MCP_LOG_LEVEL=debug|info|warn|error`.
 * - Zero deps. No file output here — the extension keeps the persistent log;
 *   the server just emits to stderr where it can be tail'd alongside the
 *   native-host process.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function envLevel(): LogLevel {
  const raw = (process.env.MCP_LOG_LEVEL || 'info').toLowerCase();
  if (raw in LEVEL_ORDER) return raw as LogLevel;
  return 'info';
}

let activeLevel: LogLevel = envLevel();

export function setLogLevel(level: LogLevel): void {
  activeLevel = level;
}

interface LogContext {
  requestId?: string;
  tool?: string;
  [key: string]: unknown;
}

function emit(level: LogLevel, msg: string, ctx?: LogContext): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[activeLevel]) return;
  const ts = new Date().toISOString();
  const ctxStr = ctx && Object.keys(ctx).length ? ' ' + JSON.stringify(ctx) : '';
  process.stderr.write(`[${ts}] [${level.toUpperCase()}] ${msg}${ctxStr}\n`);
}

export const logger = {
  debug: (msg: string, ctx?: LogContext) => emit('debug', msg, ctx),
  info: (msg: string, ctx?: LogContext) => emit('info', msg, ctx),
  warn: (msg: string, ctx?: LogContext) => emit('warn', msg, ctx),
  error: (msg: string, ctx?: LogContext) => emit('error', msg, ctx),
  /**
   * Bind a context object so subsequent calls share its fields.
   * Use one bound logger per request: `const log = logger.with({ requestId, tool })`.
   */
  with(base: LogContext) {
    return {
      debug: (msg: string, extra?: LogContext) => emit('debug', msg, { ...base, ...extra }),
      info: (msg: string, extra?: LogContext) => emit('info', msg, { ...base, ...extra }),
      warn: (msg: string, extra?: LogContext) => emit('warn', msg, { ...base, ...extra }),
      error: (msg: string, extra?: LogContext) => emit('error', msg, { ...base, ...extra }),
    };
  },
};

export type { LogLevel, LogContext };
