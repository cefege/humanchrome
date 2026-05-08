/**
 * Web-editor SSE client + execution-status cache.
 *
 * Maintains:
 *   - In-memory `executionStatusCache` keyed by requestId, with TTL
 *     pruning when the cache grows.
 *   - Per-session SSE connections to the bridge's
 *     `/agent/chat/<sessionId>/stream` endpoint, used to surface live
 *     Agent status (starting / running / completed / failed / cancelled)
 *     to the web editor without long-polling.
 *
 * The SSE reader translates Agent stream events into status entries
 * the message-router can read back via `getExecutionStatus(requestId)`.
 *
 * Lifecycle:
 *   - `subscribeToSessionStatus(sessionId, requestId, port)` opens an
 *     SSE connection (closing any prior one for the same session) and
 *     keeps it open until the response stream ends or
 *     `cancelSseConnection(sessionId)` is called.
 *   - `cancelSseConnection(sessionId)` aborts the underlying fetch and
 *     clears the connection entry.
 *
 * State is module-private. External callers go through the exported
 * functions; do not introspect the maps directly.
 */

interface ExecutionStatusEntry {
  status: string;
  message?: string;
  updatedAt: number;
  result?: { success: boolean; summary?: string; error?: string };
}

const executionStatusCache = new Map<string, ExecutionStatusEntry>();
const STATUS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function cleanupExpiredStatuses(): void {
  const now = Date.now();
  for (const [key, entry] of executionStatusCache) {
    if (now - entry.updatedAt > STATUS_CACHE_TTL) {
      executionStatusCache.delete(key);
    }
  }
}

// Run periodic TTL pruning regardless of cache size. Without this, a
// quiescent cache holds stale entries past TTL until something triggers
// a new write — easily forever in a low-traffic session.
const STATUS_CACHE_PRUNE_INTERVAL = 60 * 1000; // 1 minute
if (typeof setInterval === 'function') {
  setInterval(cleanupExpiredStatuses, STATUS_CACHE_PRUNE_INTERVAL);
}

export function setExecutionStatus(
  requestId: string,
  status: string,
  message?: string,
  result?: ExecutionStatusEntry['result'],
): void {
  executionStatusCache.set(requestId, {
    status,
    message,
    updatedAt: Date.now(),
    result,
  });
}

export function getExecutionStatus(requestId: string): ExecutionStatusEntry | undefined {
  return executionStatusCache.get(requestId);
}

const sseConnections = new Map<string, { abort: AbortController; lastRequestId: string }>();

/**
 * Whether an SSE connection is currently registered for `sessionId`.
 */
export function hasSseConnection(sessionId: string): boolean {
  return sseConnections.has(sessionId);
}

/**
 * Abort and forget the SSE connection for `sessionId`, if one exists.
 * No-op when none is registered.
 */
export function cancelSseConnection(sessionId: string): void {
  const conn = sseConnections.get(sessionId);
  if (!conn) return;
  conn.abort.abort();
  sseConnections.delete(sessionId);
}

/**
 * Cancel the SSE connection for `sessionId` only if its last request id
 * matches `requestId`. Used by the cancel-execution path so a stale
 * cancel for an old request doesn't tear down a fresh connection that
 * a newer request just opened on the same session.
 */
export function cancelSseConnectionForRequest(sessionId: string, requestId: string): void {
  const conn = sseConnections.get(sessionId);
  if (!conn || conn.lastRequestId !== requestId) return;
  conn.abort.abort();
  sseConnections.delete(sessionId);
}

/**
 * Open an SSE subscription for `sessionId` and stream Agent status
 * updates into the executionStatusCache. Closes any existing connection
 * for the same session first. Resolves when the stream completes; rejects
 * are swallowed so callers can fire-and-forget with `.catch(() => {})`.
 */
export async function subscribeToSessionStatus(
  sessionId: string,
  requestId: string,
  port: number,
): Promise<void> {
  // Close existing connection for this session if any
  cancelSseConnection(sessionId);

  const abortController = new AbortController();
  sseConnections.set(sessionId, { abort: abortController, lastRequestId: requestId });

  // Set initial status
  setExecutionStatus(requestId, 'starting', 'Connecting to Agent...');

  const sseUrl = `http://127.0.0.1:${port}/agent/chat/${encodeURIComponent(sessionId)}/stream`;

  try {
    const response = await fetch(sseUrl, {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
      signal: abortController.signal,
    });

    if (!response.ok || !response.body) {
      setExecutionStatus(requestId, 'running', 'Agent processing...');
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    setExecutionStatus(requestId, 'running', 'Agent processing...');

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('data:')) {
          try {
            const data = JSON.parse(line.slice(5).trim());
            handleSseEvent(requestId, data);
          } catch {
            // Ignore parse errors
          }
        }
      }
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      // Intentionally aborted, not an error
      return;
    }
    // Connection error - mark as unknown but not failed (Agent may still be running)
    const cached = getExecutionStatus(requestId);
    if (cached && !['completed', 'failed', 'cancelled'].includes(cached.status)) {
      setExecutionStatus(requestId, 'running', 'Agent processing (connection lost)...');
    }
  } finally {
    // Only clear the entry if it's still ours. A subsequent
    // subscribeToSessionStatus call for the same session will have
    // installed a new controller; deleting unconditionally here would
    // orphan that fresh connection's tracking.
    const current = sseConnections.get(sessionId);
    if (current?.abort === abortController) {
      sseConnections.delete(sessionId);
    }
  }
}

/**
 * Translate one Agent SSE event into the status cache. Filters by
 * `eventRequestId` so multiplexed sessions don't update each other's
 * status. Maps Agent statuses (`ready`, `error`) into UI statuses
 * (`running`, `failed`).
 */
function handleSseEvent(requestId: string, event: unknown): void {
  if (!event || typeof event !== 'object') return;
  const e = event as Record<string, unknown>;
  const type = e.type;
  const data = e.data as Record<string, unknown> | undefined;

  // Check if this event is for our request
  const eventRequestId = data?.requestId as string | undefined;
  if (eventRequestId && eventRequestId !== requestId) return;

  if (type === 'status' && data) {
    const status = data.status as string;
    const message = data.message as string | undefined;

    // Map Agent status to our status:
    // - 'ready' is a sub-state of running, normalise so the UI doesn't
    //   show two "running"-flavoured states.
    // - 'error' is the server's name for what the UI calls 'failed'.
    let mappedStatus = status;
    if (status === 'ready') mappedStatus = 'running';
    if (status === 'error') mappedStatus = 'failed';

    setExecutionStatus(requestId, mappedStatus, message);
  } else if (type === 'message' && data) {
    // Update status to show we're receiving messages
    const cached = getExecutionStatus(requestId);
    if (cached && cached.status === 'starting') {
      setExecutionStatus(requestId, 'running', 'Agent is working...');
    }

    // Check for completion indicators in message content
    const role = data.role as string | undefined;
    const isFinal = data.isFinal as boolean | undefined;
    if (role === 'assistant' && isFinal) {
      const content = data.content as string | undefined;
      setExecutionStatus(requestId, 'completed', 'Completed', {
        success: true,
        summary: content?.slice(0, 200),
      });
    }
  } else if (type === 'error') {
    const errorMsg = (e.error as string) || 'Unknown error';
    setExecutionStatus(requestId, 'failed', errorMsg, {
      success: false,
      error: errorMsg,
    });
  }
}
