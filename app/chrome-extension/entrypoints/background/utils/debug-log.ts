/**
 * In-extension persistent debug log.
 *
 * Goals:
 * - Survive a service-worker restart so a tool failure can be diagnosed even
 *   after the SW is reaped (vanilla console.log loses everything).
 * - Tag each entry with the same `requestId` the native server logs to stderr,
 *   so the server-side and extension-side trail can be stitched together.
 * - Be readable by the LLM via the `chrome_debug_dump` tool — that's the
 *   primary consumer, not a human in DevTools.
 *
 * Storage strategy:
 * - In-memory ring buffer (`buffer`) is the source of truth during a SW life.
 * - chrome.storage.session — persists across SW restarts within a browser
 *   session; cleared on browser restart. Cheap and large-quota.
 * - We do NOT spill to chrome.storage.local by default: there's no privacy
 *   review on what tool args contain, and a session-scoped log avoids
 *   leaving payloads on disk.
 */

const BUFFER_CAP = 1000;
const PERSIST_KEY = '__mcp_debug_log_v1';
const PERSIST_DEBOUNCE_MS = 250;

export const DEBUG_LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type DebugLogLevel = (typeof DEBUG_LOG_LEVELS)[number];

export interface DebugLogEntry {
  ts: number;
  level: DebugLogLevel;
  requestId?: string;
  tool?: string;
  tabId?: number;
  msg: string;
  data?: Record<string, unknown>;
}

let buffer: DebugLogEntry[] = [];
let restored = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

async function restoreFromStorage(): Promise<void> {
  if (restored) return;
  restored = true;
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.session) return;
    const got = await chrome.storage.session.get(PERSIST_KEY);
    const entries = got?.[PERSIST_KEY];
    if (Array.isArray(entries)) {
      buffer = entries.slice(-BUFFER_CAP);
    }
  } catch {
    // ignore — we'll just start fresh
  }
}

function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistNow();
  }, PERSIST_DEBOUNCE_MS);
}

async function persistNow(): Promise<void> {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.session) return;
    await chrome.storage.session.set({ [PERSIST_KEY]: buffer });
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

export function logEvent(
  level: DebugLogLevel,
  msg: string,
  ctx?: { requestId?: string; tool?: string; tabId?: number; data?: Record<string, unknown> },
): void {
  void restoreFromStorage();
  const entry: DebugLogEntry = {
    ts: Date.now(),
    level,
    msg,
    ...(ctx?.requestId ? { requestId: ctx.requestId } : {}),
    ...(ctx?.tool ? { tool: ctx.tool } : {}),
    ...(typeof ctx?.tabId === 'number' ? { tabId: ctx.tabId } : {}),
    ...(ctx?.data ? { data: ctx.data } : {}),
  };
  append(entry);
  // Mirror to console for live DevTools debugging when SW is alive.
  const line = `[mcp-debug] ${msg}`;
  if (level === 'error') console.error(line, ctx);
  else if (level === 'warn') console.warn(line, ctx);
  else console.log(line, ctx);
}

export const debugLog = {
  debug: (msg: string, ctx?: Parameters<typeof logEvent>[2]) => logEvent('debug', msg, ctx),
  info: (msg: string, ctx?: Parameters<typeof logEvent>[2]) => logEvent('info', msg, ctx),
  warn: (msg: string, ctx?: Parameters<typeof logEvent>[2]) => logEvent('warn', msg, ctx),
  error: (msg: string, ctx?: Parameters<typeof logEvent>[2]) => logEvent('error', msg, ctx),
};

export interface DumpFilter {
  requestId?: string;
  tool?: string;
  tabId?: number;
  level?: DebugLogLevel;
  /** Return entries newer than this absolute timestamp (ms epoch). */
  sinceMs?: number;
  /** Cap on entries returned — defaults to 200, max 1000. */
  limit?: number;
}

export async function dumpLog(filter: DumpFilter = {}): Promise<DebugLogEntry[]> {
  await restoreFromStorage();
  const limit = Math.max(1, Math.min(filter.limit ?? 200, BUFFER_CAP));
  const result: DebugLogEntry[] = [];
  // Walk newest-first so we collect the most recent N matching entries cheaply,
  // then reverse so the caller sees chronological order.
  for (let i = buffer.length - 1; i >= 0 && result.length < limit; i--) {
    const e = buffer[i];
    if (filter.requestId && e.requestId !== filter.requestId) continue;
    if (filter.tool && e.tool !== filter.tool) continue;
    if (typeof filter.tabId === 'number' && e.tabId !== filter.tabId) continue;
    if (filter.level && e.level !== filter.level) continue;
    if (typeof filter.sinceMs === 'number' && e.ts < filter.sinceMs) continue;
    result.push(e);
  }
  return result.reverse();
}

export async function clearLog(): Promise<void> {
  buffer = [];
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.session) {
      await chrome.storage.session.remove(PERSIST_KEY);
    }
  } catch {
    // ignore
  }
}

export function getBufferSize(): number {
  return buffer.length;
}
