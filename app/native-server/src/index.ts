#!/usr/bin/env node
import serverInstance from './server';
import nativeMessagingHostInstance from './native-messaging-host';
import fileHandler from './file-handler';
import { logger } from './util/logger';

try {
  serverInstance.setNativeHost(nativeMessagingHostInstance); // Server needs setNativeHost method
  nativeMessagingHostInstance.setServer(serverInstance); // NativeHost needs setServer method
  nativeMessagingHostInstance.start();

  // Sweep stale temp uploads on startup, then every 30 minutes. Without this
  // the temp dir grows monotonically across sessions.
  fileHandler.cleanupOldFiles();
  setInterval(() => fileHandler.cleanupOldFiles(), 30 * 60 * 1000).unref();
  logger.info('humanchrome bridge entry started');
} catch (error: any) {
  logger.fatal({ err: error?.message || String(error) }, 'fatal during bridge startup');
  process.exit(1);
}

process.on('error', (error) => {
  logger.fatal({ err: (error as Error)?.message || String(error) }, 'process error');
  process.exit(1);
});

// Handle process signals and uncaught exceptions
process.on('SIGINT', () => {
  logger.info('SIGINT received — exiting');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received — exiting');
  process.exit(0);
});

process.on('exit', (code) => {
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
