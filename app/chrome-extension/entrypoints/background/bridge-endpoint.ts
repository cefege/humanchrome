/**
 * Bridge endpoint resolver.
 *
 * Every Chrome profile in the fleet spawns its own bridge, pinned to a
 * different port via `HC_BRIDGE_PORT` (daily Chrome = 12306, fleet p01 =
 * 12500, ...). The bridge reports the port it ACTUALLY bound in the
 * SERVER_STARTED native-message payload, which the extension persists as
 * `serverStatus.port`.
 *
 * Consumers must therefore never assume a port — they resolve it here.
 * Precedence:
 *   1. live GET_SERVER_STATUS response port
 *   2. chrome.storage.local `serverStatus.port`
 *   3. chrome.storage.local `nativeServerPort`
 *   4. NATIVE_HOST.DEFAULT_PORT (12306)
 *
 * 127.0.0.1 stays hardcoded: cross-machine addressing is the native
 * server's job, not the extension's.
 */
import { NATIVE_HOST, STORAGE_KEYS } from '@/common/constants';
import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';

/** Shape of the status record persisted by the native host listener. */
interface StoredServerStatus {
  port?: unknown;
}

interface ServerStatusResponse {
  serverStatus?: StoredServerStatus;
  connected?: boolean;
}

/** Coerce an arbitrary stored value into a usable TCP port, or null. */
function normalizePort(value: unknown): number | null {
  const num =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;

  if (!Number.isFinite(num)) return null;

  const port = Math.floor(num);
  if (port <= 0 || port > 65535) return null;

  return port;
}

/**
 * Ask the background for the current server status.
 *
 * Returns null whenever the message cannot be delivered or the response
 * carries no usable port — callers degrade to the storage-based steps.
 */
async function fetchLiveServerStatusPort(): Promise<number | null> {
  try {
    const response = (await chrome.runtime.sendMessage({
      type: BACKGROUND_MESSAGE_TYPES.GET_SERVER_STATUS,
    })) as ServerStatusResponse | undefined;

    return normalizePort(response?.serverStatus?.port);
  } catch {
    return null;
  }
}

/** Read both port-bearing storage keys in one round-trip. */
async function readStoredPorts(): Promise<{
  statusPort: number | null;
  configPort: number | null;
}> {
  try {
    const stored = await chrome.storage.local.get([
      STORAGE_KEYS.SERVER_STATUS,
      STORAGE_KEYS.NATIVE_SERVER_PORT,
    ]);

    return {
      statusPort: normalizePort(
        (stored?.[STORAGE_KEYS.SERVER_STATUS] as StoredServerStatus | undefined)?.port,
      ),
      configPort: normalizePort(stored?.[STORAGE_KEYS.NATIVE_SERVER_PORT]),
    };
  } catch {
    return { statusPort: null, configPort: null };
  }
}

/**
 * Resolve the port this Chrome profile's bridge is listening on.
 *
 * Never throws; always yields a usable port.
 */
export async function resolveBridgePort(): Promise<number> {
  const livePort = await fetchLiveServerStatusPort();
  if (livePort) return livePort;

  const { statusPort, configPort } = await readStoredPorts();
  if (statusPort) return statusPort;
  if (configPort) return configPort;

  return NATIVE_HOST.DEFAULT_PORT;
}

/**
 * Resolve the bridge origin (`http://127.0.0.1:<port>`) for this profile.
 *
 * Use this instead of hand-building URLs from a port number.
 */
export async function resolveBridgeBaseUrl(): Promise<string> {
  return `http://127.0.0.1:${await resolveBridgePort()}`;
}
