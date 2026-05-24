#!/usr/bin/env node
// IMP-0163: bridge startup instrumentation. Emit a single boot line to
// stderr BEFORE we import anything that might throw — so even an
// import-time crash leaves a trace in chrome_debug.log. The Chrome NM
// child captures stderr and routes it through `--enable-logging`, so
// these lines surface in the chrome_debug.log lines the matrix runner
// already inspects on failure. The payload is minimal but enough to
// confirm (a) the bridge process actually started and (b) which
// HC_INSTANCE_REGISTRY_DIR / HC_BRIDGE_DAEMON_SOCKET / HC_CHROME_BINARY
// env vars Chrome propagated to us.
process.stderr.write(
  `[bridge-boot] pid=${process.pid} ` +
    `node=${process.version} ` +
    `argv0=${process.argv0 ?? '?'} ` +
    `HC_INSTANCE_REGISTRY_DIR=${process.env.HC_INSTANCE_REGISTRY_DIR ?? '<unset>'} ` +
    `HC_BRIDGE_DAEMON_SOCKET=${process.env.HC_BRIDGE_DAEMON_SOCKET ?? '<unset>'} ` +
    `HC_DISABLE_DAEMON=${process.env.HC_DISABLE_DAEMON ?? '<unset>'} ` +
    `HC_CHROME_BINARY=${process.env.HC_CHROME_BINARY ?? '<unset>'}\n`,
);

import serverInstance from './server';
import nativeMessagingHostInstance from './native-messaging-host';
import fileHandler from './file-handler';
import { logger } from './util/logger';
import { listInstances, removeInstance } from './util/instance-registry';
import { startBridge } from './bridge-orchestrator';

// IMP-0163: top-level safety net. If anything throws before our normal
// error handlers attach (e.g. an import side-effect crashes), the
// uncaught exception kills the process and Chrome sees a "Native host
// has exited" disconnect with no further context. Stamp stderr so we
// at least know we got that far.
process.on('uncaughtException', (err) => {
  process.stderr.write(
    `[bridge-fatal] uncaughtException pid=${process.pid}: ${err?.message ?? err}\n${err?.stack ?? ''}\n`,
  );
});

(async () => {
  try {
    process.stderr.write(`[bridge-boot] entering main pid=${process.pid}\n`);
    serverInstance.setNativeHost(nativeMessagingHostInstance); // Server needs setNativeHost method
    nativeMessagingHostInstance.setServer(serverInstance); // NativeHost needs setServer method

    // IMP-0121: proactively sweep stale registry entries on startup
    // (listInstances filters + unlinks dead pid records at read time).
    // Lets `humanchrome-bridge doctor` and the matrix runner see clean
    // state without having to wait for the next consumer to read.
    try {
      listInstances();
    } catch (err) {
      logger.warn({ err: (err as Error)?.message || String(err) }, 'registry sweep failed');
    }

    // IMP-0120: orchestrator decides primary (daemon owning HTTP across
    // SW reloads) vs relay (forwards stdin to existing daemon). Falls
    // back to legacy standalone behaviour if HC_DISABLE_DAEMON=1.
    await startBridge({ nativeHost: nativeMessagingHostInstance, server: serverInstance });

    // Sweep stale temp uploads on startup, then every 30 minutes. Without this
    // the temp dir grows monotonically across sessions.
    fileHandler.cleanupOldFiles();
    setInterval(() => fileHandler.cleanupOldFiles(), 30 * 60 * 1000).unref();
    logger.info('humanchrome bridge entry started');
  } catch (error: any) {
    logger.fatal({ err: error?.message || String(error) }, 'fatal during bridge startup');
    process.exit(1);
  }
})();

process.on('error', (error) => {
  logger.fatal({ err: (error as Error)?.message || String(error) }, 'process error');
  process.exit(1);
});

// Handle process signals and uncaught exceptions
process.on('SIGINT', () => {
  logger.info('SIGINT received — exiting');
  removeInstance(process.pid);
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received — exiting');
  removeInstance(process.pid);
  process.exit(0);
});

process.on('exit', (code) => {
  // Best-effort registry cleanup — won't run on hard kills (SIGKILL,
  // crash) but listInstances() filters dead pids at read time so orphans
  // self-heal.
  removeInstance(process.pid);
  logger.debug({ code }, 'process exit');
});

process.on('uncaughtException', (error) => {
  logger.fatal({ err: error?.message || String(error), stack: error?.stack }, 'uncaughtException');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  // Don't exit immediately, let the program continue running
  logger.error(
    { reason: reason instanceof Error ? reason.message : String(reason) },
    'unhandledRejection',
  );
});
