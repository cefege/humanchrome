import { describe, expect, it } from 'vitest';
import {
  FileOperationPayloadSchema,
  JsonValueSchema,
  NativeMessageSchema,
  StartServerMessageSchema,
  StopServerMessageSchema,
  PingFromExtensionMessageSchema,
  FileOperationMessageSchema,
  ResponseMessageSchema,
  UnknownTypedMessageSchema,
  ToolCallBodySchema,
  ToolCallArgsSchema,
} from './ipc-schemas';
import { NativeMessageType } from './types';

// Regression net for the IPC schemas. Locks the parse/reject behavior
// against zod 3 so we can swap zod 4 in and confirm same-shape semantics.

describe('JsonValueSchema', () => {
  it.each([
    ['string', 'hello'],
    ['number', 42],
    ['negative number', -3.14],
    ['boolean true', true],
    ['boolean false', false],
    ['null', null],
    ['empty array', []],
    ['nested array', [1, 'two', [3, [4]]]],
    ['empty object', {}],
    ['nested object', { a: 1, b: { c: [true, null, 'x'] } }],
  ])('accepts JSON-like %s', (_label, value) => {
    expect(JsonValueSchema.parse(value)).toEqual(value);
  });

  it.each([
    ['undefined', undefined],
    ['function', () => 1],
    ['symbol', Symbol('x')],
    ['Date', new Date()],
    ['Map', new Map()],
  ])('rejects non-JSON %s', (_label, value) => {
    expect(() => JsonValueSchema.parse(value)).toThrow();
  });
});

describe('FileOperationPayloadSchema', () => {
  it('accepts every action enum value', () => {
    for (const action of [
      'prepareFile',
      'readBase64File',
      'cleanupFile',
      'analyzeTrace',
    ] as const) {
      const result = FileOperationPayloadSchema.parse({ action });
      expect(result.action).toBe(action);
    }
  });

  it('preserves all known optional string fields', () => {
    const payload = {
      action: 'prepareFile' as const,
      fileUrl: 'https://example.com/x.png',
      base64Data: 'aGVsbG8=',
      fileName: 'x.png',
      filePath: '/tmp/x.png',
      traceFilePath: '/tmp/trace.json.gz',
      insightName: 'LCPBreakdown',
    };
    expect(FileOperationPayloadSchema.parse(payload)).toEqual(payload);
  });

  it('passes unknown keys through (forward-compat)', () => {
    const payload = { action: 'prepareFile' as const, futureKnob: 'shiny' };
    const out = FileOperationPayloadSchema.parse(payload);
    expect((out as Record<string, unknown>).futureKnob).toBe('shiny');
  });

  it('rejects missing action', () => {
    expect(() => FileOperationPayloadSchema.parse({ fileName: 'x' })).toThrow();
  });

  it('rejects unknown action', () => {
    expect(() => FileOperationPayloadSchema.parse({ action: 'launchMissiles' })).toThrow();
  });

  it('rejects non-string optional fields', () => {
    expect(() =>
      FileOperationPayloadSchema.parse({ action: 'prepareFile', fileName: 123 }),
    ).toThrow();
  });
});

describe('NativeMessage variants', () => {
  describe('StartServerMessageSchema', () => {
    it('accepts the minimal start frame', () => {
      const result = StartServerMessageSchema.parse({ type: NativeMessageType.START });
      expect(result.type).toBe(NativeMessageType.START);
    });

    it('accepts a port payload', () => {
      const result = StartServerMessageSchema.parse({
        type: NativeMessageType.START,
        payload: { port: 12306 },
      });
      expect(result.payload).toEqual({ port: 12306 });
    });

    it('accepts an empty payload object', () => {
      expect(() =>
        StartServerMessageSchema.parse({ type: NativeMessageType.START, payload: {} }),
      ).not.toThrow();
    });

    it('rejects a non-positive port', () => {
      expect(() =>
        StartServerMessageSchema.parse({
          type: NativeMessageType.START,
          payload: { port: 0 },
        }),
      ).toThrow();
      expect(() =>
        StartServerMessageSchema.parse({
          type: NativeMessageType.START,
          payload: { port: -1 },
        }),
      ).toThrow();
    });

    it('rejects a non-integer port', () => {
      expect(() =>
        StartServerMessageSchema.parse({
          type: NativeMessageType.START,
          payload: { port: 12306.5 },
        }),
      ).toThrow();
    });

    it('rejects wrong type literal', () => {
      expect(() => StartServerMessageSchema.parse({ type: 'not_start' })).toThrow();
    });
  });

  describe('StopServerMessageSchema', () => {
    it('accepts the bare stop frame', () => {
      const out = StopServerMessageSchema.parse({ type: NativeMessageType.STOP });
      expect(out.type).toBe(NativeMessageType.STOP);
    });

    it('rejects a wrong literal', () => {
      expect(() => StopServerMessageSchema.parse({ type: 'halt' })).toThrow();
    });
  });

  describe('PingFromExtensionMessageSchema', () => {
    it('accepts the bare ping', () => {
      const out = PingFromExtensionMessageSchema.parse({ type: 'ping_from_extension' });
      expect(out.type).toBe('ping_from_extension');
    });

    it('rejects an unrelated literal', () => {
      expect(() => PingFromExtensionMessageSchema.parse({ type: 'pong_from_extension' })).toThrow();
    });
  });

  describe('FileOperationMessageSchema', () => {
    it('accepts a frame with arbitrary inner payload (validated separately)', () => {
      const out = FileOperationMessageSchema.parse({
        type: 'file_operation',
        payload: { anything: true, nested: { a: 1 } },
      });
      expect(out.type).toBe('file_operation');
      expect(out.payload).toEqual({ anything: true, nested: { a: 1 } });
    });

    it('rejects wrong type', () => {
      expect(() => FileOperationMessageSchema.parse({ type: 'fileop', payload: {} })).toThrow();
    });
  });

  describe('ResponseMessageSchema', () => {
    it('accepts a bare response with responseToRequestId', () => {
      const out = ResponseMessageSchema.parse({ responseToRequestId: 'req-1' });
      expect(out.responseToRequestId).toBe('req-1');
    });

    it('accepts a response carrying a payload', () => {
      const out = ResponseMessageSchema.parse({
        responseToRequestId: 'req-2',
        payload: { ok: true, value: 42 },
      });
      expect(out.responseToRequestId).toBe('req-2');
      expect(out.payload).toEqual({ ok: true, value: 42 });
    });

    it('accepts a response carrying an error', () => {
      const out = ResponseMessageSchema.parse({
        responseToRequestId: 'req-3',
        error: { code: 'TIMEOUT', message: 'timed out' },
      });
      expect(out.error).toEqual({ code: 'TIMEOUT', message: 'timed out' });
    });

    it('rejects an empty responseToRequestId', () => {
      expect(() => ResponseMessageSchema.parse({ responseToRequestId: '' })).toThrow();
    });

    it('rejects missing responseToRequestId', () => {
      expect(() => ResponseMessageSchema.parse({})).toThrow();
    });
  });

  describe('UnknownTypedMessageSchema', () => {
    it('accepts a non-empty type string', () => {
      const out = UnknownTypedMessageSchema.parse({ type: 'some_future_message' });
      expect(out.type).toBe('some_future_message');
    });

    it('rejects an empty type', () => {
      expect(() => UnknownTypedMessageSchema.parse({ type: '' })).toThrow();
    });
  });
});

describe('NativeMessageSchema (union dispatch)', () => {
  it.each([
    ['start_server', { type: NativeMessageType.START }],
    ['stop_server', { type: NativeMessageType.STOP }],
    ['ping_from_extension', { type: 'ping_from_extension' }],
    ['file_operation', { type: 'file_operation', payload: { action: 'prepareFile' } }],
    ['response', { responseToRequestId: 'req-x' }],
    ['unknown typed', { type: 'totally_new_message_type' }],
  ])('accepts %s frame', (_label, frame) => {
    const out = NativeMessageSchema.parse(frame);
    expect(out).toBeDefined();
  });

  it('preserves unknown top-level keys (passthrough)', () => {
    const frame = {
      type: NativeMessageType.START,
      futureField: 'shiny',
      anotherOne: 42,
    };
    const out = NativeMessageSchema.parse(frame);
    expect((out as Record<string, unknown>).futureField).toBe('shiny');
    expect((out as Record<string, unknown>).anotherOne).toBe(42);
  });

  it('rejects a frame that has neither type nor responseToRequestId-with-content', () => {
    // Empty object should fall through every variant. UnknownTypedMessageSchema requires
    // a non-empty type; ResponseMessageSchema requires responseToRequestId. Currently the
    // base schema accepts {} via UnknownTypedMessageSchema only if type is set.
    expect(() => NativeMessageSchema.parse({ type: '' })).toThrow();
  });

  it('rejects garbage primitives', () => {
    expect(() => NativeMessageSchema.parse('hello')).toThrow();
    expect(() => NativeMessageSchema.parse(42)).toThrow();
    expect(() => NativeMessageSchema.parse(null)).toThrow();
    expect(() => NativeMessageSchema.parse(undefined)).toThrow();
  });
});

describe('ToolCallBodySchema', () => {
  it('accepts an args field with arbitrary content', () => {
    const out = ToolCallBodySchema.parse({ args: { foo: 'bar' } });
    expect(out.args).toEqual({ foo: 'bar' });
  });

  it('accepts an args field with primitives, arrays, null', () => {
    expect(ToolCallBodySchema.parse({ args: 'string' }).args).toBe('string');
    expect(ToolCallBodySchema.parse({ args: 42 }).args).toBe(42);
    expect(ToolCallBodySchema.parse({ args: [1, 2, 3] }).args).toEqual([1, 2, 3]);
    expect(ToolCallBodySchema.parse({ args: null }).args).toBeNull();
  });

  it('rejects extra top-level keys (strict)', () => {
    expect(() => ToolCallBodySchema.parse({ args: {}, clientId: 'leaked' })).toThrow();
  });

  it('accepts missing args (z.unknown allows undefined)', () => {
    // z.unknown() permits an absent value; per-tool inputSchema does the
    // real arg validation, so the body schema only guards against extra keys.
    expect(() => ToolCallBodySchema.parse({})).not.toThrow();
  });
});

describe('ToolCallArgsSchema', () => {
  it('accepts a flat record of JSON values', () => {
    const args = { foo: 'bar', n: 1, ok: true, none: null, arr: [1, 2] };
    expect(ToolCallArgsSchema.parse(args)).toEqual(args);
  });

  it('accepts nested objects as JSON values', () => {
    const args = { meta: { a: 1, b: { c: 'd' } } };
    expect(ToolCallArgsSchema.parse(args)).toEqual(args);
  });

  it('rejects non-JSON values', () => {
    expect(() => ToolCallArgsSchema.parse({ fn: () => 1 })).toThrow();
    expect(() => ToolCallArgsSchema.parse({ d: new Date() })).toThrow();
  });

  it('accepts an empty record', () => {
    expect(ToolCallArgsSchema.parse({})).toEqual({});
  });
});

describe('Round-trip parity (parse outputs structurally equal inputs for valid frames)', () => {
  const roundTrip = [
    { type: NativeMessageType.START, payload: { port: 12306 } },
    { type: NativeMessageType.STOP },
    { type: 'ping_from_extension' },
    {
      type: 'file_operation',
      requestId: 'r1',
      clientId: 'c1',
      payload: { action: 'prepareFile' as const, fileUrl: 'https://x' },
    },
    { responseToRequestId: 'req-99', payload: { ok: true } },
  ];

  it.each(roundTrip)('round-trips frame: %j', (frame) => {
    const out = NativeMessageSchema.parse(frame);
    // structural equality (passthrough preserves keys; parse may add stripped output)
    expect(out).toEqual(expect.objectContaining(frame as Record<string, unknown>));
  });
});
