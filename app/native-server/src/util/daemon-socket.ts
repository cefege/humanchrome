/**
 * IMP-0120: daemon/relay UDS plumbing.
 *
 * The HTTP server bound to :12306 must outlive Chrome SW reloads. Chrome
 * tears down the native-messaging pipe whenever the SW respawns (which
 * IMP-0119's self-update watcher does on every `pnpm build:extension`),
 * and the old bridge process exits with stdin EOF — taking the HTTP
 * listener down with it. MCP clients connected to :12306 see TCP RST and
 * never reconnect, forcing a manual `/mcp` or session restart.
 *
 * The fix splits the bridge into two roles, decided at startup:
 *
 *   - Primary (daemon): the first bridge to start binds a Unix domain
 *     socket. It owns the HTTP server and the NM message router. Its own
 *     stdin/stdout is the initial NM source. When a relay connects via
 *     UDS, it swaps the NM source to that socket — across SW reloads the
 *     HTTP server never goes down.
 *
 *   - Relay: subsequent bridges (spawned by Chrome when the SW respawns
 *     via connectNative) fail to acquire the UDS, connect to the existing
 *     primary as a client, and shuttle bytes: stdin → UDS, UDS → stdout.
 *     When their own stdin closes, they exit; the primary keeps going.
 *
 * UDS path lives next to the on-disk instance registry, so the matrix
 * runner's `HC_INSTANCE_REGISTRY_DIR` automatically isolates a CFT bridge
 * from the user's regular Chrome — different registry dir → different
 * daemon socket → no cross-Chrome interference.
 */
import { createConnection, createServer, Server, Socket } from 'node:net';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { registryDir } from './instance-registry';

/** Per-machine (per-registry-dir) daemon socket location. */
export function daemonSocketPath(): string {
  if (process.env.HC_BRIDGE_DAEMON_SOCKET) return process.env.HC_BRIDGE_DAEMON_SOCKET;
  // Sibling of the instances/ dir so HC_INSTANCE_REGISTRY_DIR naturally
  // isolates matrix CFT bridges from the user's main Chrome.
  return resolve(registryDir(), '..', 'bridge-daemon.sock');
}

/**
 * Try to bind the daemon UDS. Returns the listening server on success.
 * Returns `null` if another live primary already holds the socket. Cleans
 * up a stale socket file (from a crashed previous primary) before
 * re-attempting.
 */
export async function tryAcquireDaemonLock(socketPath: string): Promise<Server | null> {
  mkdirSync(dirname(socketPath), { recursive: true });

  const attempt = (): Promise<Server | null> =>
    new Promise((resolveFn) => {
      const server = createServer();
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening);
        if (err.code === 'EADDRINUSE') {
          resolveFn(null);
          return;
        }
        resolveFn(null);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolveFn(server);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(socketPath);
    });

  const server = await attempt();
  if (server) return server;

  // EADDRINUSE — could be a live primary OR a stale socket file from a
  // crashed previous primary. Try connecting; if the connection fails, the
  // file is stale and we can unlink + retry the bind.
  const isStale = await new Promise<boolean>((res) => {
    const probe = createConnection(socketPath);
    let settled = false;
    const done = (stale: boolean) => {
      if (settled) return;
      settled = true;
      try {
        probe.destroy();
      } catch {
        /* ignore */
      }
      res(stale);
    };
    probe.once('connect', () => done(false));
    probe.once('error', () => done(true));
    setTimeout(() => done(true), 500);
  });

  if (!isStale) return null;

  try {
    if (existsSync(socketPath)) unlinkSync(socketPath);
  } catch {
    return null;
  }
  return attempt();
}

/**
 * Connect to an existing primary daemon as a relay. Resolves with the
 * connected socket, or rejects if the primary is unreachable.
 */
export function connectAsRelay(socketPath: string, timeoutMs = 3000): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      reject(new Error(`Timed out connecting to daemon at ${socketPath}`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
