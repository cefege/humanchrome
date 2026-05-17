/**
 * IMP-0120: bridge startup orchestrator — primary (daemon) vs relay.
 *
 * Decides at startup which role the freshly-spawned bridge process plays.
 * See util/daemon-socket.ts for the architecture overview.
 */
import { stdin as processStdin, stdout as processStdout } from 'node:process';
import type { Server as NetServer, Socket } from 'node:net';
import { NativeMessagingHost } from './native-messaging-host';
import { Server } from './server';
import { tryAcquireDaemonLock, connectAsRelay, daemonSocketPath } from './util/daemon-socket';
import { withContext } from './util/logger';

const log = withContext({ component: 'bridge-orchestrator' });

export interface OrchestratorDeps {
  nativeHost: NativeMessagingHost;
  server: Server;
}

/**
 * Run as primary daemon. Binds the HTTP server (via the existing NM
 * START flow), accepts UDS connections from successor bridges, and
 * hot-swaps the NM source between own-stdin and the most-recent relay
 * socket so the HTTP server stays up across SW reloads.
 */
export function runAsPrimary(
  deps: OrchestratorDeps,
  udsServer: NetServer,
  socketPath: string,
): void {
  const { nativeHost } = deps;
  let activeRelay: Socket | null = null;
  let lastClosedAt = 0;
  let idleExitTimer: NodeJS.Timeout | null = null;

  // If the daemon sits with no NM source for longer than this, exit so a
  // future SW reload can spawn a fresh primary with up-to-date bridge
  // code. Long enough to cover a normal MV3 SW reload (where the new SW
  // may not spawn until the next event), short enough to refresh after a
  // `pnpm build:native`. Override via env for tests.
  const idleTimeoutMs = Number(process.env.HC_DAEMON_IDLE_TIMEOUT_MS) || 5 * 60 * 1000;

  const clearIdleTimer = () => {
    if (idleExitTimer) {
      clearTimeout(idleExitTimer);
      idleExitTimer = null;
    }
  };

  const armIdleTimer = () => {
    clearIdleTimer();
    idleExitTimer = setTimeout(() => {
      log.info({ idleTimeoutMs }, 'daemon idle past timeout — exiting so next SW spawns fresh');
      process.exit(0);
    }, idleTimeoutMs);
    idleExitTimer.unref();
  };

  // When the NM source drops, decide what to do: if a relay was the
  // source, just wait for the next one. If our own stdin was the source
  // (first SW that spawned us), also wait — Chrome will respawn the SW
  // and a fresh bridge will connect as a relay within a few seconds.
  nativeHost.setSourceClosedHandler((reason) => {
    lastClosedAt = Date.now();
    log.info(
      { reason, hasActiveRelay: !!activeRelay },
      'NM source closed — waiting for relay (HTTP stays up)',
    );
    // Tear down the relay socket reference if it was the source.
    if (activeRelay) {
      try {
        activeRelay.destroy();
      } catch {
        /* ignore */
      }
      activeRelay = null;
    }
    armIdleTimer();
  });

  // Start NM host bound initially to our own stdin/stdout. This is the
  // very first SW connection that spawned us — handles START → HTTP
  // listen → SERVER_STARTED before any relay ever connects.
  nativeHost.start(processStdin, processStdout);

  udsServer.on('connection', (socket: Socket) => {
    log.info({ socketPath }, 'relay connected — swapping NM source');
    clearIdleTimer();
    // Supersede any prior relay (and free up our own stdin if it was
    // still the source). Most reloads close stdin first, so this is
    // typically a fresh switch from "no source" → relay.
    if (activeRelay) {
      try {
        activeRelay.destroy();
      } catch {
        /* ignore */
      }
    }
    activeRelay = socket;
    socket.on('error', (err) => {
      log.warn({ err: err.message }, 'relay socket error');
    });
    socket.on('close', () => {
      log.info({ uptimeMs: Date.now() - lastClosedAt }, 'relay socket closed');
      if (activeRelay === socket) activeRelay = null;
    });
    nativeHost.setStreams(socket, socket);
  });

  udsServer.on('error', (err) => {
    log.error({ err: err.message, socketPath }, 'UDS server error');
  });

  log.info({ socketPath, idleTimeoutMs }, 'running as primary bridge (daemon)');
}

/**
 * Run as relay. Connects to the existing primary daemon via UDS and
 * shuttles bytes between own stdin/stdout and the socket. Exits when
 * either side closes — the daemon stays alive to serve the next relay.
 */
export async function runAsRelay(socketPath: string): Promise<void> {
  let socket: Socket;
  try {
    socket = await connectAsRelay(socketPath);
  } catch (err: any) {
    log.error({ err: err?.message || String(err), socketPath }, 'failed to connect as relay');
    throw err;
  }
  log.info({ socketPath }, 'running as relay bridge');

  const exitOnce = (() => {
    let exited = false;
    return (code: number, why: string) => {
      if (exited) return;
      exited = true;
      log.info({ why, code }, 'relay exiting');
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      process.exit(code);
    };
  })();

  // SW → daemon
  processStdin.on('data', (chunk) => {
    if (!socket.writable) return;
    socket.write(chunk);
  });
  processStdin.on('end', () => exitOnce(0, 'stdin-end'));
  processStdin.on('error', () => exitOnce(0, 'stdin-error'));

  // daemon → SW
  socket.on('data', (chunk) => {
    if (!processStdout.writable) return;
    processStdout.write(chunk);
  });
  socket.on('end', () => exitOnce(0, 'socket-end'));
  socket.on('error', (err) => {
    log.warn({ err: err.message }, 'relay socket error');
    exitOnce(1, 'socket-error');
  });
  socket.on('close', () => exitOnce(0, 'socket-close'));
}

/**
 * Pick the role and run. If daemon mode is disabled via env var, falls
 * back to legacy standalone behaviour (own stdin/stdout, exit on close).
 */
export async function startBridge(deps: OrchestratorDeps): Promise<void> {
  if (process.env.HC_DISABLE_DAEMON === '1') {
    log.info('HC_DISABLE_DAEMON=1 — running standalone (legacy mode)');
    deps.nativeHost.start();
    return;
  }

  const socketPath = daemonSocketPath();
  const udsServer = await tryAcquireDaemonLock(socketPath);
  if (udsServer) {
    runAsPrimary(deps, udsServer, socketPath);
    return;
  }

  try {
    await runAsRelay(socketPath);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'relay connect failed — falling back to standalone mode',
    );
    deps.nativeHost.start();
  }
}
