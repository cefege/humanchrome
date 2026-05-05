import { stdin, stdout } from 'process';
import { Server } from './server';
import { v4 as uuidv4 } from 'uuid';
import { NativeMessageSchema, NativeMessageType } from 'humanchrome-shared';
import { TIMEOUTS } from './constant';
import fileHandler from './file-handler';
import { withContext } from './util/logger';

const log = withContext({ component: 'native-messaging-host' });

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
  timeoutId: NodeJS.Timeout;
}

export class NativeMessagingHost {
  private associatedServer: Server | null = null;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private static readonly MAX_PENDING_REQUESTS = 1000;

  public setServer(serverInstance: Server): void {
    this.associatedServer = serverInstance;
  }

  // add message handler to wait for start server
  public start(): void {
    try {
      this.setupMessageHandling();
      log.info('native messaging host started');
    } catch (error: any) {
      log.fatal({ err: error?.message || String(error) }, 'failed to start native messaging host');
      process.exit(1);
    }
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

    stdin.on('readable', () => {
      let chunk;
      while ((chunk = stdin.read()) !== null) {
        buffer = Buffer.concat([buffer, chunk]);
        processAvailable();
      }
    });

    stdin.on('end', () => {
      log.info('stdin ended — cleaning up');
      this.cleanup();
    });

    stdin.on('error', (err) => {
      log.error({ err: (err as Error)?.message || String(err) }, 'stdin error — cleaning up');
      this.cleanup();
    });
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

      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timeoutId });

      const envelope: any = {
        type: messageType,
        payload: messagePayload,
        requestId: id,
      };
      if (clientId) envelope.clientId = clientId;
      this.sendMessage(envelope);
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

      await this.associatedServer.start(port, this);
      log.info({ port }, 'fastify server started');

      this.sendMessage({
        type: NativeMessageType.SERVER_STARTED,
        payload: { port },
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
      stdout.write(Buffer.concat([headerBuffer, messageBuffer]), (err) => {
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
   * Clean up resources
   */
  private cleanup(): void {
    log.info({ pendingCount: this.pendingRequests.size }, 'cleanup starting');
    // Reject all pending requests
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
