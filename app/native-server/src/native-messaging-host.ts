import { stdin as processStdin, stdout as processStdout } from 'process';
import { Server } from './server';
import { v4 as uuidv4 } from 'uuid';
import { buildCallToolEnvelope, NativeMessageSchema, NativeMessageType } from 'humanchrome-shared';
import { TIMEOUTS } from './constant';
import fileHandler from './file-handler';
import { withContext } from './util/logger';

const log = withContext({ component: 'native-messaging-host' });

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
  timeoutId: NodeJS.Timeout;
  clientId?: string;
}

// IMP-0120: source-closed callback so the orchestrator can decide whether
// to exit the process or keep the HTTP server alive while waiting for a
// fresh native-messaging source (e.g. a UDS relay from a respawned SW).
export type SourceClosedHandler = (reason: 'end' | 'error', err?: Error) => void;

interface SourceListeners {
  onReadable: () => void;
  onEnd: () => void;
  onError: (err: Error) => void;
}

export class NativeMessagingHost {
  private associatedServer: Server | null = null;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private static readonly MAX_PENDING_REQUESTS = 1000;
  // IMP-0173: per-client backpressure. The global cap (1000) protects the
  // bridge from a process-wide leak, but doesn't stop one runaway client
  // from monopolizing it and starving every other MCP session. 50 is well
  // above any legitimate batch use (the dispatcher serializes per-tab
  // anyway), well below the global cap. Tracked separately because
  // legacy/system calls (no clientId) shouldn't count toward any
  // per-client tally.
  private static readonly MAX_PENDING_PER_CLIENT = 50;
  // IMP-0115: identity the SW announces in the START message payload, used
  // to stamp the instance-registry record so multi-Chrome callers can route.
  private remoteExtensionId: string | null = null;
  private remoteInstanceId: string | null = null;
  // IMP-0120: streams are swappable so a primary bridge can move its NM
  // source from its own process.stdin to a UDS relay socket when the SW
  // reloads, without dropping the HTTP server. Default is process stdio so
  // the standalone (non-daemon) bridge path keeps working unchanged.
  private inStream: NodeJS.ReadableStream = processStdin;
  private outStream: NodeJS.WritableStream = processStdout;
  private currentListeners: SourceListeners | null = null;
  private sourceClosedHandler: SourceClosedHandler | null = null;
  // IMP-0120: when the NM source has dropped and we're waiting for a
  // fresh relay to connect, fail incoming requests fast rather than
  // letting them hang until the 120s envelope timeout. Defaults to true
  // so callers that pre-date the daemon split (notably the pending-cap
  // test) and the legacy standalone path keep working unchanged.
  private sourceActive = true;

  public setServer(serverInstance: Server): void {
    this.associatedServer = serverInstance;
  }

  public getRemoteExtensionId(): string | null {
    return this.remoteExtensionId;
  }

  public getRemoteInstanceId(): string | null {
    return this.remoteInstanceId;
  }

  /**
   * Install a callback fired when the active NM source ends or errors.
   * The orchestrator uses this to decide whether to exit (standalone /
   * relay mode) or keep running and wait for a replacement source
   * (primary/daemon mode).
   */
  public setSourceClosedHandler(handler: SourceClosedHandler | null): void {
    this.sourceClosedHandler = handler;
  }

  /**
   * Hot-swap the NM source. Detaches listeners from the previous input,
   * resets the framing buffer, and re-attaches to the new pair. Used by
   * the primary/daemon mode to switch from process.stdin → UDS relay
   * socket → next UDS relay socket across SW reloads.
   */
  public setStreams(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): void {
    this.detachSourceListeners();
    this.inStream = input;
    this.outStream = output;
    this.setupMessageHandling();
  }

  // add message handler to wait for start server
  public start(input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream): void {
    try {
      if (input) this.inStream = input;
      if (output) this.outStream = output;
      this.setupMessageHandling();
      log.info('native messaging host started');
    } catch (error: any) {
      log.fatal({ err: error?.message || String(error) }, 'failed to start native messaging host');
      process.exit(1);
    }
  }

  private detachSourceListeners(): void {
    if (!this.currentListeners) return;
    try {
      this.inStream.removeListener('readable', this.currentListeners.onReadable);
      this.inStream.removeListener('end', this.currentListeners.onEnd);
      this.inStream.removeListener('error', this.currentListeners.onError);
    } catch {
      /* stream may already be torn down */
    }
    this.currentListeners = null;
  }

  private setupMessageHandling(): void {
    let buffer = Buffer.alloc(0);
    let expectedLength = -1;
    const MAX_MESSAGES_PER_TICK = 100; // Safety guard to avoid long-running loops per readable tick
    const MAX_MESSAGE_SIZE_BYTES = 16 * 1024 * 1024; // 16MB upper bound for a single message

    const processAvailable = () => {
      let processed = 0;
      while (processed < MAX_MESSAGES_PER_TICK) {
        // Read length header when needed
        if (expectedLength === -1) {
          if (buffer.length < 4) break; // not enough for header
          expectedLength = buffer.readUInt32LE(0);
          buffer = buffer.slice(4);

          // Validate length header
          if (expectedLength <= 0 || expectedLength > MAX_MESSAGE_SIZE_BYTES) {
            this.sendError(`Invalid message length: ${expectedLength}`);
            // Reset state to resynchronize stream
            expectedLength = -1;
            buffer = Buffer.alloc(0);
            break;
          }
        }

        // Wait for complete body
        if (buffer.length < expectedLength) break;

        const messageBuffer = buffer.slice(0, expectedLength);
        buffer = buffer.slice(expectedLength);
        expectedLength = -1;
        processed++;

        try {
          const message = JSON.parse(messageBuffer.toString());
          this.handleMessage(message);
        } catch (error: any) {
          log.warn(
            { err: error?.message || String(error), bytes: messageBuffer.length },
            'failed to parse inbound message',
          );
          this.sendError(`Failed to parse message: ${error.message}`);
        }
      }

      // If we hit the cap but still have at least one complete message pending, schedule to continue soon
      if (processed === MAX_MESSAGES_PER_TICK) {
        setImmediate(processAvailable);
      }
    };

    const input = this.inStream;
    const listeners: SourceListeners = {
      onReadable: () => {
        let chunk;
        while ((chunk = (input as any).read?.()) !== null && chunk !== undefined) {
          buffer = Buffer.concat([buffer, chunk]);
          processAvailable();
        }
      },
      onEnd: () => {
        log.info('NM source ended');
        this.handleSourceClosed('end');
      },
      onError: (err: Error) => {
        log.error({ err: err?.message || String(err) }, 'NM source error');
        this.handleSourceClosed('error', err);
      },
    };
    this.currentListeners = listeners;
    input.on('readable', listeners.onReadable);
    input.on('end', listeners.onEnd);
    input.on('error', listeners.onError);
    this.sourceActive = true;
  }

  private handleSourceClosed(reason: 'end' | 'error', err?: Error): void {
    this.sourceActive = false;
    this.detachSourceListeners();
    // Reject pending requests so callers don't hang waiting for a SW that's
    // about to be replaced by a fresh one (or is gone for good).
    this.pendingRequests.forEach((pending) => {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('Native host source disconnected — request aborted'));
    });
    this.pendingRequests.clear();
    if (this.sourceClosedHandler) {
      try {
        this.sourceClosedHandler(reason, err);
      } catch (e: any) {
        log.error({ err: e?.message || String(e) }, 'sourceClosedHandler threw');
      }
    } else {
      // Legacy behaviour: when no orchestrator is installed (matrix runner
      // / standalone bridge), exit the process so Chrome's NM lifecycle
      // sees us go away cleanly.
      this.cleanup();
    }
  }

  private async handleMessage(rawMessage: any): Promise<void> {
    if (!rawMessage || typeof rawMessage !== 'object') {
      this.sendError('Invalid message format');
      return;
    }

    // Runtime-validate the wire frame at the IPC boundary. The schema is
    // intentionally permissive (passthrough on unknown keys) so a slightly
    // newer extension build can add fields without us rejecting it; we're
    // only filtering obvious garbage here.
    const parsed = NativeMessageSchema.safeParse(rawMessage);
    if (!parsed.success) {
      this.sendError(
        `Invalid native message: ${parsed.error.issues[0]?.message ?? 'schema validation failed'}`,
      );
      return;
    }
    const message: any = parsed.data;

    if (message.responseToRequestId) {
      const requestId = message.responseToRequestId;
      const pending = this.pendingRequests.get(requestId);

      if (pending) {
        clearTimeout(pending.timeoutId);
        if (message.error) {
          pending.reject(new Error(message.error));
        } else {
          pending.resolve(message.payload);
        }
        this.pendingRequests.delete(requestId);
      } else {
        log.debug({ requestId }, 'response for unknown/expired requestId — ignoring');
      }
      return;
    }

    // Handle directive messages from Chrome
    try {
      log.debug({ type: message.type, requestId: message.requestId }, 'inbound directive');
      switch (message.type) {
        case NativeMessageType.START:
          if (typeof message.payload?.extensionId === 'string') {
            this.remoteExtensionId = message.payload.extensionId;
          }
          if (typeof message.payload?.instanceId === 'string') {
            this.remoteInstanceId = message.payload.instanceId;
          }
          await this.startServer(message.payload?.port || 12306);
          break;
        case NativeMessageType.STOP:
          await this.stopServer();
          break;
        // Keep ping/pong for simple liveness detection, but this differs from request-response pattern
        case 'ping_from_extension':
          this.sendMessage({ type: 'pong_to_extension' });
          break;
        case 'file_operation':
          await this.handleFileOperation(message);
          break;
        default:
          // Double check when message type is not supported
          if (!message.responseToRequestId) {
            log.warn({ type: message.type }, 'unknown message type from extension');
            this.sendError(
              `Unknown message type or non-response message: ${message.type || 'no type'}`,
            );
          }
      }
    } catch (error: any) {
      log.error(
        { err: error?.message || String(error), type: message.type },
        'failed to handle directive',
      );
      this.sendError(`Failed to handle directive message: ${error.message}`);
    }
  }

  /**
   * Handle file operations from the extension
   */
  private async handleFileOperation(message: any): Promise<void> {
    const opLog = withContext({
      component: 'file-handler',
      requestId: message?.requestId,
      action: message?.payload?.action,
    });
    try {
      const result = await fileHandler.handleFileRequest(message.payload);

      if (message.requestId) {
        // Send response back with the request ID
        this.sendMessage({
          type: 'file_operation_response',
          responseToRequestId: message.requestId,
          payload: result,
        });
      } else {
        // No request ID, just send result
        this.sendMessage({
          type: 'file_operation_result',
          payload: result,
        });
      }
      opLog.debug({ ok: result?.success ?? true }, 'file operation handled');
    } catch (error: any) {
      const errorResponse = {
        success: false,
        error: error.message || 'Unknown error during file operation',
      };
      opLog.error({ err: errorResponse.error }, 'file operation failed');

      if (message.requestId) {
        this.sendMessage({
          type: 'file_operation_response',
          responseToRequestId: message.requestId,
          error: errorResponse.error,
        });
      } else {
        this.sendError(`File operation failed: ${errorResponse.error}`);
      }
    }
  }

  /**
   * Send request to Chrome and wait for response
   * @param messagePayload Data to send to Chrome
   * @param timeoutMs Timeout for waiting response (milliseconds)
   * @param requestId Optional pre-generated correlation ID. If omitted, a uuid
   *   is generated and the value is hidden from the caller. Pre-generate when
   *   you need to log the same ID alongside this call.
   * @param clientId Optional MCP-session identifier. The extension uses it to
   *   maintain per-client preferred-tab state so two clients don't collide on
   *   the active-tab fallback.
   * @returns Promise, resolves to Chrome's returned payload on success, rejects on failure
   */
  public sendRequestToExtensionAndWait(
    messagePayload: any,
    messageType: string = 'request_data',
    timeoutMs: number = TIMEOUTS.DEFAULT_REQUEST_TIMEOUT,
    requestId?: string,
    clientId?: string,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = requestId || uuidv4();

      // IMP-0120: fail fast when no NM source is connected (SW reloaded,
      // relay hasn't reconnected yet). Better than waiting the full 120s
      // for the envelope timeout.
      if (!this.sourceActive) {
        reject(new Error('Bridge has no active native-messaging source (SW reconnecting)'));
        return;
      }

      // DoS guard: cap how many requests can be in-flight simultaneously so a
      // misbehaving client (or a buggy build) can't grow the Map without bound.
      if (this.pendingRequests.size >= NativeMessagingHost.MAX_PENDING_REQUESTS) {
        reject(
          new Error(
            `Too many pending requests (${this.pendingRequests.size} >= ${NativeMessagingHost.MAX_PENDING_REQUESTS})`,
          ),
        );
        return;
      }

      // IMP-0173: per-client backpressure (see MAX_PENDING_PER_CLIENT).
      if (clientId) {
        let perClient = 0;
        for (const p of this.pendingRequests.values()) {
          if (p.clientId === clientId) perClient += 1;
        }
        if (perClient >= NativeMessagingHost.MAX_PENDING_PER_CLIENT) {
          reject(
            new Error(
              `CLIENT_BUSY: client "${clientId}" has ${perClient} requests in flight (cap ${NativeMessagingHost.MAX_PENDING_PER_CLIENT}). Wait for prior calls to complete before issuing more.`,
            ),
          );
          return;
        }
      }

      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timeoutId, clientId });

      try {
        let envelope: Record<string, unknown>;
        if (messageType === NativeMessageType.CALL_TOOL) {
          if (!clientId) {
            throw new Error('CALL_TOOL envelopes require a clientId');
          }
          const payloadShape = (messagePayload ?? {}) as { name?: unknown; args?: unknown };
          if (typeof payloadShape.name !== 'string' || payloadShape.name.length === 0) {
            throw new Error('CALL_TOOL envelopes require payload.name (non-empty string)');
          }
          envelope = buildCallToolEnvelope({
            name: payloadShape.name,
            args: payloadShape.args,
            requestId: id,
            clientId,
          }) as unknown as Record<string, unknown>;
        } else {
          envelope = {
            type: messageType,
            payload: messagePayload,
            requestId: id,
          };
          if (clientId) envelope.clientId = clientId;
        }
        this.sendMessage(envelope);
      } catch (err) {
        clearTimeout(timeoutId);
        this.pendingRequests.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Generate a fresh correlation id without sending anything. Pair with
   * `sendRequestToExtensionAndWait(payload, type, timeout, id)` when you
   * want to log the id before the request.
   */
  public newRequestId(): string {
    return uuidv4();
  }

  /**
   * Start Fastify server (now accepts Server instance)
   */
  private async startServer(port: number): Promise<void> {
    if (!this.associatedServer) {
      log.error('startServer called before server was associated');
      this.sendError('Internal error: server instance not set');
      return;
    }
    try {
      if (this.associatedServer.isRunning) {
        log.warn({ port }, 'startServer called but server already running');
        this.sendMessage({
          type: NativeMessageType.ERROR,
          payload: { message: 'Server is already running' },
        });
        return;
      }

      // start() walks ports on EADDRINUSE and returns the actually-bound
      // port — may differ from `port` when another bridge owns it. Tell the
      // extension which one we bound so it can persist + use that for future
      // connections (IMP-0114).
      const actualPort = await this.associatedServer.start(port, this);
      log.info({ requestedPort: port, actualPort }, 'fastify server started');

      this.sendMessage({
        type: NativeMessageType.SERVER_STARTED,
        payload: { port: actualPort, requestedPort: port },
      });
    } catch (error: any) {
      log.error({ err: error?.message || String(error), port }, 'failed to start fastify server');
      this.sendError(`Failed to start server: ${error.message}`);
    }
  }

  /**
   * Stop Fastify server
   */
  private async stopServer(): Promise<void> {
    if (!this.associatedServer) {
      log.error('stopServer called before server was associated');
      this.sendError('Internal error: server instance not set');
      return;
    }
    try {
      // Check status through associatedServer
      if (!this.associatedServer.isRunning) {
        log.warn('stopServer called but server already stopped');
        this.sendMessage({
          type: NativeMessageType.ERROR,
          payload: { message: 'Server is not running' },
        });
        return;
      }

      await this.associatedServer.stop();
      log.info('fastify server stopped');
      // this.serverStarted = false; // Server should update its own status after successful stop

      this.sendMessage({ type: NativeMessageType.SERVER_STOPPED }); // Distinguish from previous 'stopped'
    } catch (error: any) {
      log.error({ err: error?.message || String(error) }, 'failed to stop fastify server');
      this.sendError(`Failed to stop server: ${error.message}`);
    }
  }

  /**
   * Send message to Chrome extension
   */
  public sendMessage(message: any): void {
    try {
      const messageString = JSON.stringify(message);
      const messageBuffer = Buffer.from(messageString);
      const headerBuffer = Buffer.alloc(4);
      headerBuffer.writeUInt32LE(messageBuffer.length, 0);
      // Ensure atomic write
      this.outStream.write(Buffer.concat([headerBuffer, messageBuffer]), (err) => {
        if (err) {
          // Don't log to stdout — that's the wire. Logger pins stderr.
          log.warn(
            { err: err.message, type: message?.type, requestId: message?.requestId },
            'native stdout write failed',
          );
        }
      });
    } catch (error: any) {
      log.error(
        {
          err: error?.message || String(error),
          type: message?.type,
          requestId: message?.requestId,
        },
        'failed to serialize native message',
      );
    }
  }

  /**
   * Send error message to Chrome extension (mainly for sending non-request-response type errors)
   */
  private sendError(errorMessage: string): void {
    this.sendMessage({
      type: NativeMessageType.ERROR_FROM_NATIVE_HOST, // Use more explicit type
      payload: { message: errorMessage },
    });
  }

  /**
   * Clean up resources and exit. Only called in the legacy path when no
   * SourceClosedHandler is installed (standalone bridge). Primary/daemon
   * mode installs a handler and keeps the process alive across SW reloads.
   */
  private cleanup(): void {
    log.info({ pendingCount: this.pendingRequests.size }, 'cleanup starting');
    // Reject all pending requests (no-op if already drained by handleSourceClosed)
    this.pendingRequests.forEach((pending) => {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('Native host is shutting down or Chrome disconnected.'));
    });
    this.pendingRequests.clear();

    if (this.associatedServer && this.associatedServer.isRunning) {
      this.associatedServer
        .stop()
        .then(() => {
          log.info('clean shutdown complete');
          process.exit(0);
        })
        .catch((err) => {
          log.error({ err: (err as Error)?.message || String(err) }, 'shutdown error');
          process.exit(1);
        });
    } else {
      process.exit(0);
    }
  }
}

const nativeMessagingHostInstance = new NativeMessagingHost();
export default nativeMessagingHostInstance;
