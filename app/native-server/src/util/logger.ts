/**
 * Structured logger (pino) for the native bridge.
 *
 * CRITICAL: stdout is reserved for the Chrome Native Messaging wire format
 * (4-byte length-prefixed JSON frames). Anything we accidentally write to
 * stdout corrupts the protocol and tears down the host. Therefore the logger
 * is hard-pinned to `process.stderr`. Do not change the destination.
 *
 * Configuration (env):
 * - `HUMANCHROME_LOG_LEVEL` — trace|debug|info|warn|error|fatal (default: info)
 * - `NODE_ENV`               — when not "production", logs are pretty-printed
 *                              if stderr is a TTY; otherwise NDJSON.
 *
 * Conventions:
 * - One bound logger per request: `const log = withContext({ requestId, tool });`
 * - Pass correlation fields explicitly. The same `requestId` shows up in the
 *   extension's ring buffer (chrome_debug_dump), so traces can be stitched.
 */
import pino, { type Logger, type LoggerOptions } from 'pino';
import * as path from 'path';

let pkgVersion = '0.0.0';
try {
  // src/util/logger.ts → ../../package.json. After build the file ends up at
  // dist/util/logger.js, same relative path, so this resolves both pre- and
  // post-compile. Wrapped in try/catch so a renamed package.json never crashes
  // the host on startup.

  pkgVersion =
    (require(path.join(__dirname, '..', '..', 'package.json')) as { version: string }).version ||
    pkgVersion;
} catch {
  /* keep default */
}

const VALID_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
type LogLevel = (typeof VALID_LEVELS)[number];

function resolveLevel(): LogLevel {
  const raw = (process.env.HUMANCHROME_LOG_LEVEL || '').trim().toLowerCase();
  if ((VALID_LEVELS as readonly string[]).includes(raw)) return raw as LogLevel;
  // Legacy var kept for backwards compatibility with existing dev scripts.
  const legacy = (process.env.MCP_LOG_LEVEL || '').trim().toLowerCase();
  if ((VALID_LEVELS as readonly string[]).includes(legacy)) return legacy as LogLevel;
  return 'info';
}

const REDACT_PATHS = [
  'password',
  'token',
  'authorization',
  'cookie',
  'apiKey',
  'Authorization',
  'set-cookie',
  '*.password',
  '*.token',
  '*.authorization',
  '*.cookie',
  '*.apiKey',
  '*.Authorization',
  'headers.authorization',
  'headers.cookie',
  'headers["set-cookie"]',
  'headers["Authorization"]',
];

function buildLogger(): Logger {
  const level = resolveLevel();
  const isProduction = process.env.NODE_ENV === 'production';
  const isTTY = Boolean((process.stderr as NodeJS.WriteStream).isTTY);

  const options: LoggerOptions = {
    level,
    base: { pid: process.pid, version: pkgVersion },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    formatters: {
      level: (label) => ({ level: label }),
    },
  };

  // Pretty-print only in dev TTY. In prod or when piped to a wrapper log file,
  // emit NDJSON so log shippers can parse it. We avoid pino.transport() because
  // worker threads conflict with how Chrome launches the native host.
  if (!isProduction && isTTY) {
    try {
      const pretty = require('pino-pretty');
      const stream = pretty({
        destination: 2, // stderr
        colorize: true,
        translateTime: 'SYS:HH:MM:ss.l',
        ignore: 'pid,hostname,version',
        singleLine: false,
      });
      return pino(options, stream);
    } catch {
      /* fall through to NDJSON on stderr */
    }
  }

  // Default: NDJSON to stderr. Never use the default pino destination (stdout).
  // Sync mode is used in tests so the logger doesn't keep an open handle that
  // jest's --detectOpenHandles would flag and that can delay process exit.
  const isTest = process.env.NODE_ENV === 'test' || !!process.env.JEST_WORKER_ID;
  return pino(options, pino.destination({ fd: 2, sync: isTest }));
}

const baseLogger: Logger = buildLogger();

export type { LogLevel };
export type LogContext = Record<string, unknown>;

export const logger = baseLogger;

/**
 * Create a child logger bound to a request/tool/etc. Prefer this at the start
 * of any request handler so every downstream line carries the same correlation
 * fields.
 */
export function withContext(ctx: LogContext): Logger {
  return baseLogger.child(ctx);
}

export function setLogLevel(level: LogLevel): void {
  baseLogger.level = level;
}
