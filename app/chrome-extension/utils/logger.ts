/**
 * Extension-wide structured logger.
 *
 * Goals:
 * - Survive a service-worker restart so a tool failure can be diagnosed even
 *   after the SW is reaped (vanilla console.log loses everything).
 * - Tag each entry with the same `requestId` the native bridge logs to stderr,
 *   so the server-side and extension-side trail can be stitched together via
 *   `chrome_debug_dump`.
 * - Redact obvious secrets (`password`, `token`, `authorization`, `cookie`,
 *   `apiKey`, `Authorization`, `set-cookie`) before they hit storage or the
 *   console — since we mirror to the console for live DevTools debugging,
 *   redaction has to happen at the entry level.
 *
 * Storage strategy:
 * - In-memory ring buffer (`buffer`) is the source of truth during a SW life.
 * - chrome.storage.local — survives both SW restart and browser restart.
 *   Capacity is bounded both by entry count (BUFFER_CAP) and serialized
 *   byte budget (~5 MB), oldest-dropped-first.
 *
 * Levels:
 * - 'debug' < 'info' < 'warn' < 'error'. Level filtered via the
 *   `humanchrome:logLevel` key in chrome.storage.local; defaults to 'info'.
 */

const BUFFER_CAP = 4000;
const PERSIST_KEY = '__humanchrome_log_v2';
const LEVEL_KEY = 'humanchrome:logLevel';
// Pre-IMP-0059 this was 250 ms unconditionally — every tool call dropped
// 3+ events into the ring and each fired a JSON.stringify of the whole 5 MB
// buffer 4× per second. Bumping to 5 s when persistence IS enabled (and
// disabling persistence by default — see PERSIST_ENABLED_KEY) cuts steady-
// state SW CPU from ~240 chrome.storage.local writes/min to ~12.
const PERSIST_DEBOUNCE_MS = 5_000;
const PERSIST_BYTE_BUDGET = 5 * 1024 * 1024; // ~5 MB
const PERSIST_ENABLED_KEY = 'humanchrome:logPersistEnabled';

export const DEBUG_LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type DebugLogLevel = (typeof DEBUG_LOG_LEVELS)[number];

const LEVEL_RANK: Record<DebugLogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogContext {
  requestId?: string;
  clientId?: string;
  tool?: string;
  tabId?: number;
  data?: Record<string, unknown>;
}

export interface DebugLogEntry {
  ts: number;
  level: DebugLogLevel;
  requestId?: string;
  clientId?: string;
  tool?: string;
  tabId?: number;
  msg: string;
  data?: Record<string, unknown>;
  extensionVersion?: string;
}

const REDACT_KEYS = new Set([
  'password',
  'token',
  'authorization',
  'cookie',
  'apikey',
  'set-cookie',
]);

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACT_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : redact(v, depth + 1);
  }
  return out;
}

let buffer: DebugLogEntry[] = [];
let restored = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let activeLevel: DebugLogLevel = 'info';
let levelLoaded = false;
let extensionVersion: string | undefined;
// Persistence to chrome.storage.local is OFF by default — see IMP-0059 for
// the SW-CPU rationale. Toggle via setPersistEnabled (or chrome_debug_dump
// with `persist: true`) when you actually want logs to survive a SW restart.
// The flag is itself persisted under PERSIST_ENABLED_KEY so it survives.
let persistEnabled = false;
let persistEnabledLoaded = false;

function getExtensionVersion(): string | undefined {
  if (extensionVersion !== undefined) return extensionVersion;
  try {
    const m = (typeof chrome !== 'undefined' && chrome.runtime?.getManifest?.()) || undefined;
    extensionVersion = m?.version;
  } catch {
    extensionVersion = undefined;
  }
  return extensionVersion;
}

async function loadLevel(): Promise<void> {
  if (levelLoaded) return;
  levelLoaded = true;
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    const got = await chrome.storage.local.get(LEVEL_KEY);
    const raw = got?.[LEVEL_KEY];
    if (typeof raw === 'string' && (DEBUG_LOG_LEVELS as readonly string[]).includes(raw)) {
      activeLevel = raw as DebugLogLevel;
    }
  } catch {
    /* ignore */
  }
}

async function loadPersistEnabled(): Promise<void> {
  if (persistEnabledLoaded) return;
  persistEnabledLoaded = true;
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    const got = await chrome.storage.local.get(PERSIST_ENABLED_KEY);
    const raw = got?.[PERSIST_ENABLED_KEY];
    if (raw === true) persistEnabled = true;
  } catch {
    /* ignore */
  }
}

/**
 * Toggle whether log entries get written through to chrome.storage.local.
 * When false (default), the in-memory ring is the only home for logs and
 * chrome.storage.local sees zero traffic — eliminates the dominant
 * steady-state SW CPU cost during automation runs (IMP-0059).
 *
 * Side-effects:
 *  - on→off: drops the persisted blob so the next SW boot starts clean
 *    (in-memory buffer is left intact for the rest of the SW life)
 *  - off→on: schedules a flush so any logs accumulated since boot are
 *    written through, with the same 5 s debounce that gates ongoing writes.
 */
export async function setPersistEnabled(enabled: boolean): Promise<void> {
  persistEnabled = enabled;
  persistEnabledLoaded = true;
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    await chrome.storage.local.set({ [PERSIST_ENABLED_KEY]: enabled });
    if (!enabled) {
      // Drop the persisted blob so SW restart doesn't resurrect old logs.
      await chrome.storage.local.remove(PERSIST_KEY);
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
    } else {
      schedulePersist();
    }
  } catch {
    /* ignore */
  }
}

export function getPersistEnabled(): boolean {
  return persistEnabled;
}

export function setLogLevel(level: DebugLogLevel): void {
  activeLevel = level;
  try {
    void chrome?.storage?.local?.set?.({ [LEVEL_KEY]: level });
  } catch {
    /* ignore */
  }
}

export function getLogLevel(): DebugLogLevel {
  return activeLevel;
}

async function restoreFromStorage(): Promise<void> {
  if (restored) return;
  restored = true;
  await loadLevel();
  await loadPersistEnabled();
  // Only restore the ring buffer when persistence is on; otherwise we know
  // the persisted blob (if any) is stale from a previous "on" session.
  if (!persistEnabled) return;
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    const got = await chrome.storage.local.get(PERSIST_KEY);
    const entries = got?.[PERSIST_KEY];
    if (Array.isArray(entries)) {
      buffer = entries.slice(-BUFFER_CAP);
    }
  } catch {
    // ignore — we'll just start fresh
  }
}

function trimToByteBudget(): void {
  // Cheap heuristic: serialize once and shed oldest entries until under budget.
  // This runs on the persist tick so callers don't pay the JSON cost per log.
  let serialized = '';
  try {
    serialized = JSON.stringify(buffer);
  } catch {
    return;
  }
  if (serialized.length <= PERSIST_BYTE_BUDGET) return;
  while (buffer.length > 0 && serialized.length > PERSIST_BYTE_BUDGET) {
    // Drop ~10% of oldest entries at a time so we don't re-serialize per entry.
    const dropCount = Math.max(1, Math.floor(buffer.length * 0.1));
    buffer.splice(0, dropCount);
    try {
      serialized = JSON.stringify(buffer);
    } catch {
      break;
    }
  }
}

function schedulePersist(): void {
  // Skip the work entirely when persistence is off — this is the IMP-0059
  // hot path that pre-fix was firing 4×/sec during automation runs.
  if (!persistEnabled) return;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistNow();
  }, PERSIST_DEBOUNCE_MS);
}

async function persistNow(): Promise<void> {
  if (!persistEnabled) return;
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    trimToByteBudget();
    await chrome.storage.local.set({ [PERSIST_KEY]: buffer });
  } catch {
    // ignore
  }
}

function append(entry: DebugLogEntry): void {
  buffer.push(entry);
  if (buffer.length > BUFFER_CAP) {
    buffer.splice(0, buffer.length - BUFFER_CAP);
  }
  schedulePersist();
}

export function logEvent(level: DebugLogLevel, msg: string, ctx?: LogContext): void {
  void restoreFromStorage();
  if (LEVEL_RANK[level] < LEVEL_RANK[activeLevel]) return;
  const safeData = ctx?.data ? (redact(ctx.data) as Record<string, unknown>) : undefined;
  const entry: DebugLogEntry = {
    ts: Date.now(),
    level,
    msg,
    ...(ctx?.requestId ? { requestId: ctx.requestId } : {}),
    ...(ctx?.clientId ? { clientId: ctx.clientId } : {}),
    ...(ctx?.tool ? { tool: ctx.tool } : {}),
    ...(typeof ctx?.tabId === 'number' ? { tabId: ctx.tabId } : {}),
    ...(safeData ? { data: safeData } : {}),
    ...(getExtensionVersion() ? { extensionVersion: getExtensionVersion() } : {}),
  };
  append(entry);
  // Mirror to console for live DevTools debugging when SW is alive. Use redacted
  // ctx so secrets never reach the console either.
  const consoleCtx = { ...entry };
  delete (consoleCtx as { msg?: string }).msg;
  const line = `[humanchrome] ${msg}`;
  if (level === 'error') console.error(line, consoleCtx);
  else if (level === 'warn') console.warn(line, consoleCtx);
  else if (level === 'debug') console.debug(line, consoleCtx);
  else console.log(line, consoleCtx);
}

export const logger = {
  debug: (msg: string, ctx?: LogContext) => logEvent('debug', msg, ctx),
  info: (msg: string, ctx?: LogContext) => logEvent('info', msg, ctx),
  warn: (msg: string, ctx?: LogContext) => logEvent('warn', msg, ctx),
  error: (msg: string, ctx?: LogContext) => logEvent('error', msg, ctx),
  /**
   * Bind a context object so subsequent calls share its fields. Use one bound
   * logger per request: `const log = logger.with({ requestId, tool });`.
   */
  with(base: LogContext) {
    return {
      debug: (msg: string, extra?: LogContext) => logEvent('debug', msg, mergeCtx(base, extra)),
      info: (msg: string, extra?: LogContext) => logEvent('info', msg, mergeCtx(base, extra)),
      warn: (msg: string, extra?: LogContext) => logEvent('warn', msg, mergeCtx(base, extra)),
      error: (msg: string, extra?: LogContext) => logEvent('error', msg, mergeCtx(base, extra)),
    };
  },
};

function mergeCtx(base: LogContext, extra?: LogContext): LogContext {
  if (!extra) return base;
  return {
    ...base,
    ...extra,
    data: extra.data || base.data ? { ...(base.data || {}), ...(extra.data || {}) } : undefined,
  };
}

export interface DumpFilter {
  requestId?: string;
  clientId?: string;
  tool?: string;
  tabId?: number;
  level?: DebugLogLevel;
  /** Return entries newer than this absolute timestamp (ms epoch). */
  sinceMs?: number;
  /** Cap on entries returned — defaults to 200, max BUFFER_CAP. */
  limit?: number;
  /** Pagination offset (for "newest-first then skip N"). Defaults to 0. */
  offset?: number;
  /** When true, return newest-first instead of chronological. Defaults to true. */
  newestFirst?: boolean;
}

export async function dumpLog(filter: DumpFilter = {}): Promise<DebugLogEntry[]> {
  await restoreFromStorage();
  const limit = Math.max(1, Math.min(filter.limit ?? 200, BUFFER_CAP));
  const offset = Math.max(0, filter.offset ?? 0);
  const newestFirst = filter.newestFirst !== false;
  const minLevelRank = filter.level ? LEVEL_RANK[filter.level] : 0;
  const matched: DebugLogEntry[] = [];
  for (let i = buffer.length - 1; i >= 0; i--) {
    const e = buffer[i];
    if (filter.requestId && e.requestId !== filter.requestId) continue;
    if (filter.clientId && e.clientId !== filter.clientId) continue;
    if (filter.tool && e.tool !== filter.tool) continue;
    if (typeof filter.tabId === 'number' && e.tabId !== filter.tabId) continue;
    if (filter.level && LEVEL_RANK[e.level] < minLevelRank) continue;
    if (typeof filter.sinceMs === 'number' && e.ts < filter.sinceMs) continue;
    matched.push(e);
  }
  const paged = matched.slice(offset, offset + limit);
  return newestFirst ? paged : paged.reverse();
}

export async function clearLog(): Promise<void> {
  buffer = [];
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.remove(PERSIST_KEY);
    }
  } catch {
    // ignore
  }
}

export function getBufferSize(): number {
  return buffer.length;
}
