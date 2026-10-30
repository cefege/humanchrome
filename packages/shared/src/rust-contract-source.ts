import { z } from 'zod';
import { DEFAULT_SERVER_PORT, HOST_NAME } from './constants';
import { DEFAULT_CODEX_CONFIG } from './agent-types';
import { ToolErrorCode } from './error-codes';
import {
  CallToolMessageSchema,
  CallToolPayloadSchema,
  ClientDisconnectedMessageSchema,
  ClientIdSchema,
  FileOperationMessageSchema,
  FileOperationPayloadSchema,
  JsonValueSchema,
  NativeMessageSchema,
  PingFromExtensionMessageSchema,
  ResponseMessageSchema,
  StartServerMessageSchema,
  StopServerMessageSchema,
  ToolCallArgsSchema,
  ToolCallBodySchema,
  UnknownTypedMessageSchema,
} from './ipc-schemas';
import { EDGE_LABELS } from './labels';
import { RR_STEP_TYPES } from './rr-step-types';
import { STEP_TYPES } from './step-types';
import { SUNSET_TOOL_REPLACEMENTS } from './sunset-tool-replacements';
import { DISPATCHER_TOOL_NAME, LEGACY_TOOL_ALIASES, dispatcherInputSchema } from './tool-contract';
import { TOOL_CATEGORIES, TOOL_CATEGORY_ORDER, TOOL_NAMES, TOOL_SCHEMAS } from './tools';
import { NativeMessageType } from './types';

const IPC_SCHEMAS = {
  JsonValueSchema,
  FileOperationPayloadSchema,
  ClientIdSchema,
  StartServerMessageSchema,
  StopServerMessageSchema,
  PingFromExtensionMessageSchema,
  FileOperationMessageSchema,
  CallToolPayloadSchema,
  CallToolMessageSchema,
  ClientDisconnectedMessageSchema,
  ResponseMessageSchema,
  UnknownTypedMessageSchema,
  NativeMessageSchema,
  ToolCallBodySchema,
  ToolCallArgsSchema,
} as const;

type JsonRecord = Record<string, unknown>;

function objectRecord(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Unexpected Zod internal shape for ${context}`);
  }
  return value as Record<string, unknown>;
}

function zodDef(value: unknown, context: string): Record<string, unknown> {
  const outer = objectRecord(value, context);
  return objectRecord(objectRecord(outer._zod, `${context}._zod`).def, `${context}._zod.def`);
}

function jsonSafe(value: unknown): unknown {
  if (typeof value === 'function' || value === undefined) return undefined;
  if (value instanceof RegExp) return { source: value.source, flags: value.flags };
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(objectRecord(value, 'JSON-safe Zod metadata'))
        .map(([key, nested]) => [key, jsonSafe(nested)] as const)
        .filter(([, nested]) => nested !== undefined),
    );
  }
  return value;
}

function zodErrorNode(schema: unknown): JsonRecord {
  const def = zodDef(schema, 'schema');
  const type = String(def.type);
  if (type === 'optional') {
    return { type, inner: zodErrorNode(def.innerType) };
  }
  if (type === 'object') {
    const catchall = zodDef(def.catchall, 'object catchall');
    return {
      type,
      shape: Object.fromEntries(
        Object.entries(objectRecord(def.shape, 'object shape')).map(([key, value]) => [
          key,
          zodErrorNode(value),
        ]),
      ),
      unknownKeys: catchall.type === 'never' ? 'strict' : 'passthrough',
    };
  }
  if (type === 'union') {
    if (!Array.isArray(def.options)) throw new Error('Unexpected Zod union options');
    return { type, options: def.options.map(zodErrorNode) };
  }
  if (type === 'literal') return { type, values: jsonSafe(def.values) };
  if (type === 'enum') return { type, values: jsonSafe(Object.values(objectRecord(def.entries, 'enum entries'))) };
  if (type === 'record') {
    return { type, key: zodErrorNode(def.keyType), value: zodErrorNode(def.valueType) };
  }
  if (type === 'lazy') return { type };
  if (type !== 'string' && type !== 'number' && type !== 'unknown') {
    throw new Error(`Unsupported Zod IPC error metadata type: ${type}`);
  }

  const checks = Array.isArray(def.checks)
    ? def.checks.map((check) => {
        const checkDef = zodDef(check, 'check');
        const checkName = String(checkDef.check);
        const supported =
          (type === 'string' &&
            (checkName === 'min_length' ||
              checkName === 'max_length' ||
              checkName === 'string_format')) ||
          (type === 'number' &&
            (checkName === 'number_format' || checkName === 'greater_than'));
        if (!supported) {
          throw new Error(`Unsupported Zod ${type} IPC check: ${checkName}`);
        }
        return jsonSafe(checkDef);
      })
    : undefined;
  return checks ? { type, checks } : { type };
}

function zodErrorMetadata(): JsonRecord {
  return Object.fromEntries(
    Object.entries(IPC_SCHEMAS).map(([name, schema]) => [name, zodErrorNode(schema)]),
  );
}

function issueContract(schema: z.ZodType, input: unknown): unknown[] {
  const result = schema.safeParse(input);
  if (result.success) throw new Error('Expected invalid IPC refinement probe');
  return result.error.issues;
}

const SORTED_TOOL_NAMES = [...TOOL_SCHEMAS]
  .sort((a, b) => a.name.localeCompare(b.name))
  .map((tool) => tool.name);

function buildStaticAliases(): Record<string, string> {
  const names = SORTED_TOOL_NAMES;
  const catalog = new Set(names);
  const aliases: Record<string, string> = {};
  for (const name of names) {
    const unprefixed = name.startsWith('chrome_')
      ? name.slice('chrome_'.length)
      : name.startsWith('browser_')
        ? name.slice('browser_'.length)
        : null;
    if (!unprefixed || catalog.has(unprefixed)) continue;

    const chromePrefixed = `chrome_${unprefixed}`;
    const browserPrefixed = `browser_${unprefixed}`;
    aliases[unprefixed] = catalog.has(chromePrefixed) ? chromePrefixed : browserPrefixed;
  }
  return aliases;
}


/**
 * Declarative-only source entrypoint for export-rust-contract.mjs.
 *
 * Keep imports limited to catalog, wire, schema, graph, node-spec, and agent
 * contract sources. In particular, do not add the package barrel or a browser
 * / WASM runtime import here: this module is compiled in a temporary directory
 * solely to produce the Rust contract artifact.
 */
export function buildRustContractInputs(): JsonRecord {
  const ipcJsonSchemas = Object.fromEntries(
    Object.entries(IPC_SCHEMAS).map(([name, schema]) => [name, z.toJSONSchema(schema)]),
  );

  return {
    catalog: {
      toolNames: TOOL_NAMES,
      toolSchemas: TOOL_SCHEMAS,
      toolSchemaOrder: TOOL_SCHEMAS.map((tool) => tool.name),
      knownToolNames: SORTED_TOOL_NAMES,
      categoryOrder: TOOL_CATEGORY_ORDER,
      categories: TOOL_CATEGORIES,
      dispatcherToolName: DISPATCHER_TOOL_NAME,
      dispatcherInputSchema: dispatcherInputSchema(),
      staticAliases: buildStaticAliases(),
      aliasResolutionOrder: ['exact', 'chrome_prefix', 'browser_prefix'],
      sunsetReplacements: SUNSET_TOOL_REPLACEMENTS,
      legacyToolAliases: LEGACY_TOOL_ALIASES,
    },
    wire: {
      nativeMessageTypes: NativeMessageType,
      defaultServerPort: DEFAULT_SERVER_PORT,
      nativeHostName: HOST_NAME,
    },
    errors: {
      toolErrorCodes: Object.values(ToolErrorCode),
    },
    ipc: {
      jsonSchemas: ipcJsonSchemas,
      zodErrorMetadata: zodErrorMetadata(),
      validation: {
        unknownKeyPolicy: {
          nativeMessages: 'passthrough',
          toolCallBody: 'strict',
        },
        strictReparseMessageTypes: [
          NativeMessageType.CALL_TOOL,
          NativeMessageType.CLIENT_DISCONNECTED,
        ],
        errorShape: {
          type: 'ZodError',
          issuesProperty: 'issues',
          issueFieldsArePreserved: true,
        },
        refinementChecks: [
          {
            schema: 'ClientIdSchema',
            input: 'invalid client id',
            issues: issueContract(ClientIdSchema, 'invalid client id'),
          },
          {
            schema: 'StartServerMessageSchema',
            input: { type: NativeMessageType.START, payload: { port: 0 } },
            issues: issueContract(StartServerMessageSchema, {
              type: NativeMessageType.START,
              payload: { port: 0 },
            }),
          },
          {
            schema: 'CallToolMessageSchema',
            input: { type: NativeMessageType.CALL_TOOL, requestId: '', clientId: 'bad id' },
            issues: issueContract(CallToolMessageSchema, {
              type: NativeMessageType.CALL_TOOL,
              requestId: '',
              clientId: 'bad id',
            }),
          },
          {
            schema: 'ToolCallBodySchema',
            input: { args: {}, clientId: 'not-allowed' },
            issues: issueContract(ToolCallBodySchema, { args: {}, clientId: 'not-allowed' }),
          },
        ],
      },
    },
    declarativeInputs: {
      graph: {
        edgeLabels: EDGE_LABELS,
        stepTypes: STEP_TYPES,
        rrStepTypes: RR_STEP_TYPES,
      },
      node: {
        sourceDeclarationInputs: ['src/node-spec.ts', 'src/node-specs-builtin.ts'],
      },
      agent: {
        defaultCodexConfig: DEFAULT_CODEX_CONFIG,
      },
    },
  };
}
