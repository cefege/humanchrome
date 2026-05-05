import { NativeMessageType } from 'humanchrome-shared';
import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import { NATIVE_HOST, STORAGE_KEYS, ERROR_MESSAGES, SUCCESS_MESSAGES } from '@/common/constants';
import { handleCallTool } from './tools';
import { listPublished, getFlow } from './record-replay/flow-store';
import { acquireKeepalive } from './keepalive-manager';
import { debugLog } from './utils/debug-log';

const log = debugLog.with({ tool: 'native-host' });

let nativePort: chrome.runtime.Port | null = null;
export const HOST_NAME = NATIVE_HOST.NAME;

// Background-context callers that need a request/response round-trip with the
// native host (file uploads, perf traces) used to go through a
// `chrome.runtime.sendMessage({type: 'forward_to_native'})` round-trip and
// listen via `chrome.runtime.onMessage`. That doesn't work from the
// background SW — `chrome.runtime.sendMessage` doesn't deliver to listeners
// in the same context, so the response is never observed and callers time
// out. This map owns pending direct-to-native requests by id; the
// nativePort.onMessage handler resolves them on `file_operation_response`.
interface PendingNativeRequest {
  resolve: (payload: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
const pendingNativeRequests = new Map<string, PendingNativeRequest>();

/**
 * Post a request directly to the native host and resolve when its
 * `file_operation_response` (or compatible) arrives matching `requestId`.
 *
 * Use this from background-context tools instead of the `forward_to_native`
 * runtime-message dance — the latter only works from non-background contexts.
 */
export function sendNativeRequest<T = any>(
  type: string,
  payload: any,
  timeoutMs = 30_000,
): Promise<T> {
  if (!nativePort) {
    return Promise.reject(new Error('Native host not connected'));
  }
  const requestId = `native-req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingNativeRequests.delete(requestId);
      reject(new Error(`Native request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pendingNativeRequests.set(requestId, { resolve, reject, timer });
    try {
      nativePort!.postMessage({ type, requestId, payload });
    } catch (err) {
      clearTimeout(timer);
      pendingNativeRequests.delete(requestId);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

// ==================== Reconnect Configuration ====================

const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 60_000;
const RECONNECT_MAX_FAST_ATTEMPTS = 8;
const RECONNECT_COOLDOWN_DELAY_MS = 5 * 60_000;

// ==================== Auto-connect State ====================

let keepaliveRelease: (() => void) | null = null;
let autoConnectEnabled = true;
let autoConnectLoaded = false;
let ensurePromise: Promise<boolean> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let manualDisconnect = false;

/**
 * Server status management interface
 */
interface ServerStatus {
  isRunning: boolean;
  port?: number;
  lastUpdated: number;
}

let currentServerStatus: ServerStatus = {
  isRunning: false,
  lastUpdated: Date.now(),
};

/**
 * Save server status to chrome.storage
 */
async function saveServerStatus(status: ServerStatus): Promise<void> {
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.SERVER_STATUS]: status });
  } catch (error) {
    log.error(ERROR_MESSAGES.SERVER_STATUS_SAVE_FAILED, {
      data: { err: error instanceof Error ? error.message : String(error) },
    });
  }
}

/**
 * Load server status from chrome.storage
 */
async function loadServerStatus(): Promise<ServerStatus> {
  try {
    const result = await chrome.storage.local.get([STORAGE_KEYS.SERVER_STATUS]);
    if (result[STORAGE_KEYS.SERVER_STATUS]) {
      return result[STORAGE_KEYS.SERVER_STATUS];
    }
  } catch (error) {
    log.error(ERROR_MESSAGES.SERVER_STATUS_LOAD_FAILED, {
      data: { err: error instanceof Error ? error.message : String(error) },
    });
  }
  return {
    isRunning: false,
    lastUpdated: Date.now(),
  };
}

/**
 * Broadcast server status change to all listeners
 */
function broadcastServerStatusChange(status: ServerStatus): void {
  chrome.runtime
    .sendMessage({
      type: BACKGROUND_MESSAGE_TYPES.SERVER_STATUS_CHANGED,
      payload: status,
    })
    .catch(() => {
      // Ignore errors if no listeners are present
    });
}

// ==================== Port Normalization ====================

/**
 * Normalize a port value to a valid port number or null.
 */
function normalizePort(value: unknown): number | null {
  const n =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(n)) return null;
  const port = Math.floor(n);
  if (port <= 0 || port > 65535) return null;
  return port;
}

// ==================== Reconnect Utilities ====================

/**
 * Add jitter to a delay value to avoid thundering herd.
 */
function withJitter(ms: number): number {
  const ratio = 0.7 + Math.random() * 0.6;
  return Math.max(0, Math.round(ms * ratio));
}

/**
 * Calculate reconnect delay based on attempt number.
 * Uses exponential backoff with jitter, then switches to cooldown interval.
 */
function getReconnectDelayMs(attempt: number): number {
  if (attempt >= RECONNECT_MAX_FAST_ATTEMPTS) {
    return withJitter(RECONNECT_COOLDOWN_DELAY_MS);
  }
  const delay = Math.min(RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt), RECONNECT_MAX_DELAY_MS);
  return withJitter(delay);
}

/**
 * Clear the reconnect timer if active.
 */
function clearReconnectTimer(): void {
  if (!reconnectTimer) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

/**
 * Reset reconnect state after successful connection.
 */
function resetReconnectState(): void {
  reconnectAttempts = 0;
  clearReconnectTimer();
}

// ==================== Keepalive Management ====================

/**
 * Sync keepalive hold based on autoConnectEnabled state.
 * When auto-connect is enabled, we hold a keepalive reference to keep SW alive.
 */
function syncKeepaliveHold(): void {
  if (autoConnectEnabled) {
    if (!keepaliveRelease) {
      keepaliveRelease = acquireKeepalive('native-host');
      log.debug('acquired keepalive');
    }
    return;
  }
  if (keepaliveRelease) {
    try {
      keepaliveRelease();
      log.debug('released keepalive');
    } catch {
      // Ignore
    }
    keepaliveRelease = null;
  }
}

// ==================== Auto-connect Settings ====================

/**
 * Load the nativeAutoConnectEnabled setting from storage.
 */
async function loadNativeAutoConnectEnabled(): Promise<boolean> {
  try {
    const result = await chrome.storage.local.get([STORAGE_KEYS.NATIVE_AUTO_CONNECT_ENABLED]);
    const raw = result[STORAGE_KEYS.NATIVE_AUTO_CONNECT_ENABLED];
    if (typeof raw === 'boolean') return raw;
  } catch (error) {
    log.warn('failed to load nativeAutoConnectEnabled', {
      data: { err: error instanceof Error ? error.message : String(error) },
    });
  }
  return true; // Default to enabled
}

/**
 * Set the nativeAutoConnectEnabled setting and persist to storage.
 */
async function setNativeAutoConnectEnabled(enabled: boolean): Promise<void> {
  autoConnectEnabled = enabled;
  autoConnectLoaded = true;
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.NATIVE_AUTO_CONNECT_ENABLED]: enabled });
    log.debug('set nativeAutoConnectEnabled', { data: { enabled } });
  } catch (error) {
    log.warn('failed to persist nativeAutoConnectEnabled', {
      data: { err: error instanceof Error ? error.message : String(error) },
    });
  }
  syncKeepaliveHold();
}

// ==================== Port Preference ====================

/**
 * Get the preferred port for connecting to native server.
 * Priority: explicit override > user preference > last known port > default
 */
async function getPreferredPort(override?: unknown): Promise<number> {
  const explicit = normalizePort(override);
  if (explicit) return explicit;

  try {
    const result = await chrome.storage.local.get([
      STORAGE_KEYS.NATIVE_SERVER_PORT,
      STORAGE_KEYS.SERVER_STATUS,
    ]);

    const userPort = normalizePort(result[STORAGE_KEYS.NATIVE_SERVER_PORT]);
    if (userPort) return userPort;

    const status = result[STORAGE_KEYS.SERVER_STATUS] as Partial<ServerStatus> | undefined;
    const statusPort = normalizePort(status?.port);
    if (statusPort) return statusPort;
  } catch (error) {
    log.warn('failed to read preferred port', {
      data: { err: error instanceof Error ? error.message : String(error) },
    });
  }

  const inMemoryPort = normalizePort(currentServerStatus.port);
  if (inMemoryPort) return inMemoryPort;

  return NATIVE_HOST.DEFAULT_PORT;
}

// ==================== Reconnect Scheduling ====================

/**
 * Schedule a reconnect attempt with exponential backoff.
 */
function scheduleReconnect(reason: string): void {
  if (nativePort) return;
  if (manualDisconnect) return;
  if (!autoConnectEnabled) return;
  if (reconnectTimer) return;

  const delay = getReconnectDelayMs(reconnectAttempts);
  log.debug('reconnect scheduled', {
    data: { delayMs: delay, attempt: reconnectAttempts, reason },
  });

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (nativePort) return;
    if (manualDisconnect || !autoConnectEnabled) return;

    reconnectAttempts += 1;
    void ensureNativeConnected(`reconnect:${reason}`).catch(() => {});
  }, delay);
}

// ==================== Server Status Update ====================

/**
 * Mark server as stopped and broadcast the change.
 */
async function markServerStopped(reason: string): Promise<void> {
  currentServerStatus = {
    isRunning: false,
    port: currentServerStatus.port,
    lastUpdated: Date.now(),
  };
  try {
    await saveServerStatus(currentServerStatus);
  } catch {
    // Ignore
  }
  broadcastServerStatusChange(currentServerStatus);
  log.debug('server marked stopped', { data: { reason } });
}

// ==================== Core Ensure Function ====================

/**
 * Ensure native connection is established.
 * This is the main entry point for auto-connect logic.
 *
 * @param trigger - Description of what triggered this call (for logging)
 * @param portOverride - Optional explicit port to use
 * @returns Whether the connection is now established
 */
async function ensureNativeConnected(trigger: string, portOverride?: unknown): Promise<boolean> {
  // Concurrency protection: only one ensure flow at a time
  if (ensurePromise) return ensurePromise;

  ensurePromise = (async () => {
    // Load auto-connect setting if not yet loaded
    if (!autoConnectLoaded) {
      autoConnectEnabled = await loadNativeAutoConnectEnabled();
      autoConnectLoaded = true;
      syncKeepaliveHold();
    }

    // If auto-connect is disabled, do nothing
    if (!autoConnectEnabled) {
      log.debug('auto-connect disabled, skipping ensure', { data: { trigger } });
      return false;
    }

    // Sync keepalive hold
    syncKeepaliveHold();

    // Already connected
    if (nativePort) {
      log.debug('already connected', { data: { trigger } });
      return true;
    }

    // Get the port to use
    const port = await getPreferredPort(portOverride);
    log.debug('attempting connection', { data: { port, trigger } });

    // Attempt connection
    const ok = connectNativeHost(port);
    if (!ok) {
      log.warn('connection failed', { data: { trigger } });
      scheduleReconnect(`connect_failed:${trigger}`);
      return false;
    }

    log.debug('connection initiated successfully', { data: { trigger } });
    // Note: Don't reset reconnect state here. Wait for SERVER_STARTED confirmation.
    // Chrome may return a Port but disconnect immediately if native host is missing.
    return true;
  })().finally(() => {
    ensurePromise = null;
  });

  return ensurePromise;
}

/**
 * Connect to the native messaging host
 * @returns Whether the connection was initiated successfully
 */
export function connectNativeHost(port: number = NATIVE_HOST.DEFAULT_PORT): boolean {
  if (nativePort) {
    return true;
  }

  try {
    nativePort = chrome.runtime.connectNative(HOST_NAME);

    nativePort.onMessage.addListener(async (message) => {
      if (message.type === NativeMessageType.PROCESS_DATA && message.requestId) {
        const requestId = message.requestId;
        const requestPayload = message.payload;

        nativePort?.postMessage({
          responseToRequestId: requestId,
          payload: {
            status: 'success',
            message: SUCCESS_MESSAGES.TOOL_EXECUTED,
            data: requestPayload,
          },
        });
      } else if (message.type === NativeMessageType.CALL_TOOL && message.requestId) {
        const requestId = message.requestId;
        const clientId: string | undefined = message.clientId;
        try {
          const result = await handleCallTool(message.payload, requestId, clientId);
          nativePort?.postMessage({
            responseToRequestId: requestId,
            payload: {
              status: 'success',
              message: SUCCESS_MESSAGES.TOOL_EXECUTED,
              data: result,
            },
          });
        } catch (error) {
          nativePort?.postMessage({
            responseToRequestId: requestId,
            payload: {
              status: 'error',
              message: ERROR_MESSAGES.TOOL_EXECUTION_FAILED,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
      } else if (message.type === 'rr_list_published_flows' && message.requestId) {
        const requestId = message.requestId;
        try {
          const published = await listPublished();
          const items = [] as any[];
          for (const p of published) {
            const flow = await getFlow(p.id);
            if (!flow) continue;
            items.push({
              id: p.id,
              slug: p.slug,
              version: p.version,
              name: p.name,
              description: p.description || flow.description || '',
              variables: flow.variables || [],
              meta: flow.meta || {},
            });
          }
          nativePort?.postMessage({
            responseToRequestId: requestId,
            payload: { status: 'success', items },
          });
        } catch (error: any) {
          nativePort?.postMessage({
            responseToRequestId: requestId,
            payload: { status: 'error', error: error?.message || String(error) },
          });
        }
      } else if (message.type === NativeMessageType.SERVER_STARTED) {
        const port = message.payload?.port;
        currentServerStatus = {
          isRunning: true,
          port: port,
          lastUpdated: Date.now(),
        };
        await saveServerStatus(currentServerStatus);
        broadcastServerStatusChange(currentServerStatus);
        // Server is confirmed running - now we can reset reconnect state
        resetReconnectState();
        log.info(SUCCESS_MESSAGES.SERVER_STARTED, { data: { port } });
      } else if (message.type === NativeMessageType.SERVER_STOPPED) {
        currentServerStatus = {
          isRunning: false,
          port: currentServerStatus.port, // Keep last known port for reconnection
          lastUpdated: Date.now(),
        };
        await saveServerStatus(currentServerStatus);
        broadcastServerStatusChange(currentServerStatus);
        log.info(SUCCESS_MESSAGES.SERVER_STOPPED);
      } else if (message.type === NativeMessageType.ERROR_FROM_NATIVE_HOST) {
        log.error('error from native host', {
          data: { msg: message.payload?.message || 'Unknown error' },
        });
      } else if (message.type === 'file_operation_response') {
        // Resolve a pending direct-to-native request (background-context
        // callers that used sendNativeRequest). Fall through to the legacy
        // runtime-message broadcast for any non-background listener that
        // might still depend on it (e.g. content scripts).
        const id = message.responseToRequestId as string | undefined;
        const pending = id ? pendingNativeRequests.get(id) : undefined;
        if (pending) {
          clearTimeout(pending.timer);
          pendingNativeRequests.delete(id!);
          if (message.error) {
            pending.reject(new Error(message.error));
          } else {
            pending.resolve(message.payload);
          }
        } else {
          chrome.runtime.sendMessage(message).catch(() => {
            // Ignore if no listeners
          });
        }
      }
    });

    nativePort.onDisconnect.addListener(() => {
      log.warn(ERROR_MESSAGES.NATIVE_DISCONNECTED, {
        data: { lastError: chrome.runtime.lastError?.message },
      });
      nativePort = null;
      // Reject any in-flight direct-to-native requests so callers don't hang
      // until their own timeouts fire.
      for (const [id, pending] of pendingNativeRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Native host disconnected'));
        pendingNativeRequests.delete(id);
      }

      // Mark server as stopped since native host disconnection means server is down
      void markServerStopped('native_port_disconnected');

      // Handle reconnection based on disconnect reason
      if (manualDisconnect) {
        manualDisconnect = false;
        return;
      }
      if (!autoConnectEnabled) return;
      scheduleReconnect('native_port_disconnected');
    });

    nativePort.postMessage({ type: NativeMessageType.START, payload: { port } });
    // Note: Don't reset reconnect state here. Wait for SERVER_STARTED confirmation.
    // Chrome may return a Port but disconnect immediately if native host is missing.
    return true;
  } catch (error) {
    log.warn(ERROR_MESSAGES.NATIVE_CONNECTION_FAILED, {
      data: { err: error instanceof Error ? error.message : String(error) },
    });
    nativePort = null;
    return false;
  }
}

/**
 * Initialize native host listeners and load initial state
 */
export const initNativeHostListener = () => {
  // Initialize server status from storage
  loadServerStatus()
    .then((status) => {
      currentServerStatus = status;
    })
    .catch((error) => {
      log.error(ERROR_MESSAGES.SERVER_STATUS_LOAD_FAILED, {
        data: { err: error instanceof Error ? error.message : String(error) },
      });
    });

  // Auto-connect on SW activation (covers SW restart after idle termination)
  void ensureNativeConnected('sw_startup').catch(() => {});

  // Auto-connect on Chrome browser startup
  chrome.runtime.onStartup.addListener(() => {
    void ensureNativeConnected('onStartup').catch(() => {});
  });

  // Auto-connect on extension install/update
  chrome.runtime.onInstalled.addListener(() => {
    void ensureNativeConnected('onInstalled').catch(() => {});
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    // Allow UI to call tools directly
    if (message && message.type === 'call_tool' && message.name) {
      handleCallTool({ name: message.name, args: message.args })
        .then((res) => sendResponse({ success: true, result: res }))
        .catch((err) =>
          sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) }),
        );
      return true;
    }

    const msgType = typeof message === 'string' ? message : message?.type;

    // ENSURE_NATIVE: Trigger ensure without changing autoConnectEnabled
    if (msgType === NativeMessageType.ENSURE_NATIVE) {
      const portOverride = typeof message === 'object' ? message.port : undefined;
      ensureNativeConnected('ui_ensure', portOverride)
        .then((connected) => {
          sendResponse({ success: true, connected, autoConnectEnabled });
        })
        .catch((e) => {
          sendResponse({ success: false, connected: nativePort !== null, error: String(e) });
        });
      return true;
    }

    // CONNECT_NATIVE: Explicit user connect, re-enables auto-connect
    if (msgType === NativeMessageType.CONNECT_NATIVE) {
      const portOverride = typeof message === 'object' ? message.port : undefined;
      const normalized = normalizePort(portOverride);

      (async () => {
        // Explicit user connect: re-enable auto-connect
        await setNativeAutoConnectEnabled(true);

        if (normalized) {
          // Best-effort: persist preferred port
          try {
            await chrome.storage.local.set({ [STORAGE_KEYS.NATIVE_SERVER_PORT]: normalized });
          } catch {
            // Ignore
          }
        }

        return ensureNativeConnected('ui_connect', normalized ?? undefined);
      })()
        .then((connected) => {
          sendResponse({ success: true, connected });
        })
        .catch((e) => {
          sendResponse({ success: false, connected: nativePort !== null, error: String(e) });
        });
      return true;
    }

    if (msgType === NativeMessageType.PING_NATIVE) {
      const connected = nativePort !== null;
      sendResponse({ connected, autoConnectEnabled });
      return true;
    }

    // DISCONNECT_NATIVE: Explicit user disconnect, disables auto-connect
    if (msgType === NativeMessageType.DISCONNECT_NATIVE) {
      (async () => {
        // Explicit user disconnect: disable auto-connect and stop reconnect loop
        await setNativeAutoConnectEnabled(false);
        clearReconnectTimer();
        reconnectAttempts = 0;
        syncKeepaliveHold();

        if (nativePort) {
          // Only set manualDisconnect if we actually have a port to disconnect.
          // This prevents the flag from persisting when there's no active connection.
          manualDisconnect = true;
          try {
            nativePort.disconnect();
          } catch {
            // Ignore
          }
          nativePort = null;
        }
        await markServerStopped('manual_disconnect');
      })()
        .then(() => {
          sendResponse({ success: true });
        })
        .catch((e) => {
          sendResponse({ success: false, error: String(e) });
        });
      return true;
    }

    if (message.type === BACKGROUND_MESSAGE_TYPES.GET_SERVER_STATUS) {
      sendResponse({
        success: true,
        serverStatus: currentServerStatus,
        connected: nativePort !== null,
      });
      return true;
    }

    if (message.type === BACKGROUND_MESSAGE_TYPES.REFRESH_SERVER_STATUS) {
      loadServerStatus()
        .then((storedStatus) => {
          currentServerStatus = storedStatus;
          sendResponse({
            success: true,
            serverStatus: currentServerStatus,
            connected: nativePort !== null,
          });
        })
        .catch((error) => {
          log.error(ERROR_MESSAGES.SERVER_STATUS_LOAD_FAILED, {
            data: { err: error instanceof Error ? error.message : String(error) },
          });
          sendResponse({
            success: false,
            error: ERROR_MESSAGES.SERVER_STATUS_LOAD_FAILED,
            serverStatus: currentServerStatus,
            connected: nativePort !== null,
          });
        });
      return true;
    }

    // Forward file operation messages to native host
    if (message.type === 'forward_to_native' && message.message) {
      if (nativePort) {
        nativePort.postMessage(message.message);
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'Native host not connected' });
      }
      return true;
    }
  });
};
