/**
 * Runtime validation schemas for IPC boundaries.
 *
 * These Zod schemas are intentionally permissive: they reject obvious garbage
 * (missing `type`, wrong primitive types, etc.) while allowing forward-
 * compatible extensions via `.passthrough()`. They are additive — existing
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
    z.record(JsonValueSchema),
  ]),
);

// ---------------------------------------------------------------------------
// File operation payload (inner `payload` of a `file_operation` message)
// ---------------------------------------------------------------------------

/**
 * Schema for the inner `payload` of a `file_operation` message.
 * Mirrors the field set consumed by `FileHandler.handleFileRequest`.
 *
 * `.passthrough()` so future actions can add fields without breaking
 * existing builds — we only block obviously-bad shapes (e.g. non-string
 * `action`, missing object).
 */
export const FileOperationPayloadSchema = z
  .object({
    action: z.enum(['prepareFile', 'readBase64File', 'cleanupFile', 'analyzeTrace']),
    fileUrl: z.string().optional(),
    base64Data: z.string().optional(),
    fileName: z.string().optional(),
    filePath: z.string().optional(),
    traceFilePath: z.string().optional(),
    insightName: z.string().optional(),
  })
  .passthrough();

export type FileOperationPayload = z.infer<typeof FileOperationPayloadSchema>;

// ---------------------------------------------------------------------------
// Native messages received over stdio
// ---------------------------------------------------------------------------

/**
 * Common base — every wire message is an object with at least one of:
 * `type` (directive from extension) or `responseToRequestId` (response to a
 * request the host previously sent).
 *
 * `.passthrough()` keeps unknown keys so a slightly-newer extension build can
 * include extra metadata without us rejecting the whole frame.
 */
const NativeMessageBaseSchema = z
  .object({
    type: z.string().optional(),
    requestId: z.string().optional(),
    responseToRequestId: z.string().optional(),
    clientId: z.string().optional(),
    payload: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .passthrough();

/**
 * `start_server` — extension asks the host to bring up the local Fastify
 * server on a given port. Payload is optional; the host falls back to the
 * default port when absent.
 */
export const StartServerMessageSchema = NativeMessageBaseSchema.extend({
  type: z.literal(NativeMessageType.START),
  payload: z.object({ port: z.number().int().positive().optional() }).passthrough().optional(),
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
  ResponseMessageSchema,
  UnknownTypedMessageSchema,
]);

export type NativeMessageInput = z.infer<typeof NativeMessageSchema>;

// ---------------------------------------------------------------------------
// REST `/api/tools/:name` body
// ---------------------------------------------------------------------------

/**
 * `args` is intentionally `unknown` here — per-tool validation already lives
 * in each tool's `inputSchema`, so doing it twice would only add maintenance
 * cost. `.strict()` rejects extra top-level keys (defends against e.g.
 * a caller stuffing `clientId` into the body when they should use the
 * `X-Client-Id` header).
 */
export const ToolCallBodySchema = z
  .object({
    args: z.unknown(),
  })
  .strict();

export type ToolCallBodyInput = z.infer<typeof ToolCallBodySchema>;

/**
 * Generic tool args record. Most tools accept a flat object of JSON values;
 * the per-tool `inputSchema` does the real validation.
 */
export const ToolCallArgsSchema = z.record(JsonValueSchema);
export type ToolCallArgs = z.infer<typeof ToolCallArgsSchema>;
