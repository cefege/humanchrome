/**
 * Runtime validation schemas for IPC boundaries.
 *
 * These Zod schemas are intentionally permissive: they reject obvious garbage
 * (missing `type`, wrong primitive types, etc.) while allowing forward-
 * compatible extensions via `z.looseObject()`. They are additive — existing
 * TypeScript interfaces in `types.ts` remain the source of truth for static
 * types; these schemas only run at the wire boundary.
 *
 * Where they're used:
 *   - native-server `handleMessage`: validates messages received from the
 *     extension over stdio.
 *   - native-server `handleFileRequest`: validates the inner file_operation
 *     payload before dispatch.
 *   - native-server `/api/tools/:name` POST: validates the request body.
 *
 * Per-tool argument validation lives in each tool's own `inputSchema`, so
 * `ToolCallArgsSchema` here is intentionally a generic record.
 */
import { z } from 'zod';
import { NativeMessageType } from './types';

/**
 * Recursive JSON-like value. Used as a permissive payload type when we don't
 * want to lock down the inner shape but still want to reject non-JSON garbage.
 */
type JsonLike = string | number | boolean | null | JsonLike[] | { [key: string]: JsonLike };

export const JsonValueSchema: z.ZodType<JsonLike> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

// ---------------------------------------------------------------------------
// File operation payload (inner `payload` of a `file_operation` message)
// ---------------------------------------------------------------------------

/**
 * Schema for the inner `payload` of a `file_operation` message.
 * Mirrors the field set consumed by `FileHandler.handleFileRequest`.
 *
 * `z.looseObject` so future actions can add fields without breaking
 * existing builds — we only block obviously-bad shapes (e.g. non-string
 * `action`, missing object).
 */
export const FileOperationPayloadSchema = z.looseObject({
  action: z.enum(['prepareFile', 'readBase64File', 'cleanupFile', 'analyzeTrace', 'saveToPath']),
  fileUrl: z.string().optional(),
  base64Data: z.string().optional(),
  fileName: z.string().optional(),
  filePath: z.string().optional(),
  destPath: z.string().optional(), // absolute destination path for saveToPath action
  textData: z.string().optional(), // raw text/HTML content for saveToPath action
  traceFilePath: z.string().optional(),
  insightName: z.string().optional(),
});

export type FileOperationPayload = z.infer<typeof FileOperationPayloadSchema>;

// ---------------------------------------------------------------------------
// Native messages received over stdio
// ---------------------------------------------------------------------------

/**
 * MCP client identity stamped on every CALL_TOOL and CLIENT_DISCONNECTED
 * envelope (load-bearing for per-client tab ownership — IMP-0086 / IMP-0091).
 *
 * Permissive on shape so we don't have to schema-bump every time a new lane
 * is added (UUID fallback, normalized sessionName, `__ui:<surface>`,
 * potentially `__cron:` / others later). The producers are the gatekeepers:
 * `normalizeSessionName` (stdio + HTTP transports) and `stampUiClientId`
 * (extension UI surfaces) constrain what actually appears on the wire.
 * This schema just rejects garbage — whitespace, empty string, anything
 * longer than 128 chars, or non-alphanumeric/sep characters.
 */
export const ClientIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/);

/**
 * Common base — every wire message is an object with at least one of:
 * `type` (directive from extension) or `responseToRequestId` (response to a
 * request the host previously sent).
 *
 * `z.looseObject` keeps unknown keys so a slightly-newer extension build can
 * include extra metadata without us rejecting the whole frame.
 *
 * `clientId` is **optional at the base level**: directive frames that don't
 * carry MCP context (START, STOP, PING_FROM_EXTENSION, RESPONSE) legitimately
 * omit it. Per-type schemas tighten it to required where load-bearing
 * (CALL_TOOL, CLIENT_DISCONNECTED).
 */
const NativeMessageBaseSchema = z.looseObject({
  type: z.string().optional(),
  requestId: z.string().optional(),
  responseToRequestId: z.string().optional(),
  clientId: ClientIdSchema.optional(),
  payload: z.unknown().optional(),
  error: z.unknown().optional(),
});

/**
 * `start_server` — extension asks the host to bring up the local Fastify
 * server on a given port. Payload is optional; the host falls back to the
 * default port when absent.
 */
export const StartServerMessageSchema = NativeMessageBaseSchema.extend({
  type: z.literal(NativeMessageType.START),
  payload: z.looseObject({ port: z.number().int().positive().optional() }).optional(),
});

/**
 * `stop_server` — extension asks the host to shut down the Fastify server.
 */
export const StopServerMessageSchema = NativeMessageBaseSchema.extend({
  type: z.literal(NativeMessageType.STOP),
});

/**
 * `ping_from_extension` — simple liveness probe. The host replies with
 * `pong_to_extension`. Distinct from the request/response correlation
 * machinery used by `request_data` / `call_tool`.
 */
export const PingFromExtensionMessageSchema = NativeMessageBaseSchema.extend({
  type: z.literal('ping_from_extension'),
});

/**
 * `file_operation` — extension delegates a file action (download, base64
 * read, cleanup, trace analyze) to the host because the renderer can't touch
 * the filesystem. Validated against `FileOperationPayloadSchema` separately
 * inside the handler so a bad payload reports a clean error.
 */
export const FileOperationMessageSchema = NativeMessageBaseSchema.extend({
  type: z.literal('file_operation'),
  payload: z.unknown(),
});

/**
 * `call_tool` — bridge dispatches an MCP tool call to the extension. Wire
 * frame is built by `buildCallToolEnvelope` in the bridge (`native-messaging-host.ts`)
 * and consumed by the extension's `nativePort.onMessage` handler. Both
 * `requestId` and `clientId` are load-bearing: requestId correlates the
 * eventual response, clientId drives per-client tab ownership (IMP-0086).
 *
 * NOTE: a parallel `chrome.runtime.sendMessage({type:'call_tool', ...})`
 * path from extension UI surfaces (popup, sidepanel, options) is a
 * *different transport* and does NOT pass through this schema. That path
 * is handled directly by `chrome.runtime.onMessage` in the extension and
 * gets its `clientId` stamped by `stampUiClientId`.
 */
export const CallToolPayloadSchema = z.looseObject({
  name: z.string().min(1),
  args: z.unknown().optional(),
});

export const CallToolMessageSchema = NativeMessageBaseSchema.extend({
  type: z.literal(NativeMessageType.CALL_TOOL),
  requestId: z.string().min(1),
  clientId: ClientIdSchema,
  payload: CallToolPayloadSchema,
});

/**
 * `client_disconnected` — bridge tells the extension that an MCP session
 * has closed so the extension can `releaseClient(clientId)` and drop that
 * client's owned tabs back to the unowned pool. Tabs themselves stay open.
 *
 * `payload.clientId` is tolerated for forward-compat with any pre-IMP-0086
 * dev build that stuffed it inside the payload, but the top-level
 * `clientId` is the trusted source.
 */
export const ClientDisconnectedMessageSchema = NativeMessageBaseSchema.extend({
  type: z.literal(NativeMessageType.CLIENT_DISCONNECTED),
  clientId: ClientIdSchema,
  payload: z.looseObject({ clientId: z.string().optional() }).optional(),
});

/**
 * Generic response-shaped message. These don't carry a `type` (they're
 * correlated by `responseToRequestId`) and the resolver branches on
 * presence of `error` vs `payload` itself.
 */
export const ResponseMessageSchema = NativeMessageBaseSchema.extend({
  responseToRequestId: z.string().min(1),
});

/**
 * Catch-all for messages with a `type` we don't have a tighter schema for
 * yet. `handleMessage` already special-cases unknown types with a clear
 * error — this exists so the union doesn't reject forward-compat traffic
 * outright.
 */
export const UnknownTypedMessageSchema = NativeMessageBaseSchema.extend({
  type: z.string().min(1),
});

/**
 * Union of every message shape the host accepts on stdio. Order matters:
 * specific schemas first, generic catch-alls last. The whole union is
 * passthrough-friendly so a newer extension can include unknown keys without
 * being dropped.
 */
export const NativeMessageSchema = z.union([
  StartServerMessageSchema,
  StopServerMessageSchema,
  PingFromExtensionMessageSchema,
  FileOperationMessageSchema,
  CallToolMessageSchema,
  ClientDisconnectedMessageSchema,
  ResponseMessageSchema,
  UnknownTypedMessageSchema,
]);

export type NativeMessageInput = z.infer<typeof NativeMessageSchema>;
export type NativeMessageFrame = z.infer<typeof NativeMessageSchema>;
export type CallToolMessage = z.infer<typeof CallToolMessageSchema>;
export type CallToolPayload = z.infer<typeof CallToolPayloadSchema>;
export type ClientDisconnectedMessage = z.infer<typeof ClientDisconnectedMessageSchema>;
export type ClientId = z.infer<typeof ClientIdSchema>;

/**
 * Parse + narrow helper for consumers. Returns a discriminated result so the
 * caller doesn't have to know the Zod surface. On `ok: false`, `error` is a
 * short human-readable summary suitable for logging at warn level.
 *
 * Performs a strict per-type re-parse for known load-bearing message types
 * (CALL_TOOL, CLIENT_DISCONNECTED) so a malformed frame can't sneak through
 * the union's forward-compat `UnknownTypedMessageSchema` catch-all.
 */
export function parseNativeMessage(
  raw: unknown,
): { ok: true; data: NativeMessageFrame } | { ok: false; error: string } {
  const result = NativeMessageSchema.safeParse(raw);
  if (!result.success) return { ok: false, error: result.error.message };
  const data = result.data;
  if (data?.type === NativeMessageType.CALL_TOOL) {
    const strict = CallToolMessageSchema.safeParse(raw);
    if (!strict.success) return { ok: false, error: strict.error.message };
    return { ok: true, data: strict.data };
  }
  if (data?.type === NativeMessageType.CLIENT_DISCONNECTED) {
    const strict = ClientDisconnectedMessageSchema.safeParse(raw);
    if (!strict.success) return { ok: false, error: strict.error.message };
    return { ok: true, data: strict.data };
  }
  return { ok: true, data };
}

export function isCallToolMessage(m: NativeMessageFrame): m is CallToolMessage {
  return m?.type === NativeMessageType.CALL_TOOL;
}

export function isClientDisconnectedMessage(m: NativeMessageFrame): m is ClientDisconnectedMessage {
  return m?.type === NativeMessageType.CLIENT_DISCONNECTED;
}

/**
 * Build a schema-valid CALL_TOOL envelope. Throws synchronously if any
 * required field is missing or malformed — caller bug, not a network bug.
 */
export function buildCallToolEnvelope(input: {
  name: string;
  args?: unknown;
  requestId: string;
  clientId: string;
}): CallToolMessage {
  const envelope = {
    type: NativeMessageType.CALL_TOOL,
    requestId: input.requestId,
    clientId: input.clientId,
    payload: { name: input.name, args: input.args },
  };
  return CallToolMessageSchema.parse(envelope);
}

/**
 * Build a schema-valid CLIENT_DISCONNECTED envelope.
 */
export function buildClientDisconnectedEnvelope(input: {
  clientId: string;
}): ClientDisconnectedMessage {
  return ClientDisconnectedMessageSchema.parse({
    type: NativeMessageType.CLIENT_DISCONNECTED,
    clientId: input.clientId,
  });
}

// ---------------------------------------------------------------------------
// REST `/api/tools/:name` body
// ---------------------------------------------------------------------------

/**
 * `args` is intentionally `unknown` here — per-tool validation already lives
 * in each tool's `inputSchema`, so doing it twice would only add maintenance
 * cost. `z.strictObject` rejects extra top-level keys (defends against e.g.
 * a caller stuffing `clientId` into the body when they should use the
 * `X-Client-Id` header).
 */
export const ToolCallBodySchema = z.strictObject({
  args: z.unknown().optional(),
});

export type ToolCallBodyInput = z.infer<typeof ToolCallBodySchema>;

/**
 * Generic tool args record. Most tools accept a flat object of JSON values;
 * the per-tool `inputSchema` does the real validation.
 */
export const ToolCallArgsSchema = z.record(z.string(), JsonValueSchema);
export type ToolCallArgs = z.infer<typeof ToolCallArgsSchema>;
