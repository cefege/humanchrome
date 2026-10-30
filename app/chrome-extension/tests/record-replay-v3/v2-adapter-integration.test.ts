/**
 * @fileoverview V2 Action Adapter integration tests
 * @description Tests the full flow of V2 handlers through V3 runner
 *
 * This test uses real V2 handlers (like 'if') to verify:
 * - Handler registration works
 * - V3 runner can execute V2 handlers
 * - Edge following based on nextLabel
 * - Event emission for adapted nodes
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FlowV3 } from '@/entrypoints/background/record-replay-v3';
import {
  FLOW_SCHEMA_VERSION,
  RUN_SCHEMA_VERSION,
  closeRrV3Db,
  deleteRrV3Db,
  resetBreakpointRegistry,
} from '@/entrypoints/background/record-replay-v3';

import { PluginRegistry } from '@/entrypoints/background/record-replay-v3/engine/plugins/registry';
import { ifHandler } from '@/entrypoints/background/record-replay/actions/handlers/control-flow';
import {
  tryResolveJson,
  tryResolveNumber,
  tryResolveString,
} from '@/entrypoints/background/record-replay/actions/registry';
import { delayHandler } from '@/entrypoints/background/record-replay/actions/handlers/delay';
import { adaptV2ActionHandlerToV3NodeDefinition } from '@/entrypoints/background/record-replay-v3/engine/plugins/v2-action-adapter';
import { createV3E2EHarness, type V3E2EHarness, type RpcClient } from './v3-e2e-harness';
import { asSucceeded } from './test-utils/result-helpers';

// ==================== Test Fixtures ====================

/**
 * Create a Flow that uses the 'if' node with branching
 */
function createIfBranchingFlow(id: string, conditionVar: string): FlowV3 {
  const iso = new Date(0).toISOString();
  return {
    schemaVersion: FLOW_SCHEMA_VERSION,
    id,
    name: `If Branching Flow ${id}`,
    createdAt: iso,
    updatedAt: iso,
    entryNodeId: 'if-node',
    nodes: [
      {
        id: 'if-node',
        kind: 'if',
        config: {
          mode: 'binary',
          condition: {
            kind: 'truthy',
            value: { kind: 'var', ref: { name: conditionVar } },
          },
          trueLabel: 'true',
          falseLabel: 'false',
        },
      },
      {
        id: 'true-node',
        kind: 'test',
        config: { action: 'succeed', outputs: { result: 'true-path' } },
      },
      {
        id: 'false-node',
        kind: 'test',
        config: { action: 'succeed', outputs: { result: 'false-path' } },
      },
    ],
    edges: [
      { id: 'e1', from: 'if-node', to: 'true-node', label: 'true' },
      { id: 'e2', from: 'if-node', to: 'false-node', label: 'false' },
    ],
  };
}

/**
 * Create a simple delay flow to test timing-based handlers
 */
function createDelayFlow(id: string, delayMs: number): FlowV3 {
  const iso = new Date(0).toISOString();
  return {
    schemaVersion: FLOW_SCHEMA_VERSION,
    id,
    name: `Delay Flow ${id}`,
    createdAt: iso,
    updatedAt: iso,
    entryNodeId: 'delay-node',
    nodes: [
      {
        id: 'delay-node',
        kind: 'delay',
        config: { ms: delayMs },
      },
    ],
    edges: [],
  };
}

// ==================== Custom Harness with V2 Handlers ====================

/**
 * Extended harness that registers real V2 handlers
 */
function createV2IntegrationHarness(): V3E2EHarness {
  // First create base harness (which registers 'test' node)
  const harness = createV3E2EHarness({ autoStartScheduler: false });

  // Register V2 handlers via adapter
  // Note: We need to access the internal plugins registry
  // For this test, we'll directly register to the runner factory's plugins
  return harness;
}

// ==================== Tests ====================

describe('V2 Action Adapter Integration', () => {
  let h: V3E2EHarness;
  let client: RpcClient;
  let plugins: PluginRegistry;

  beforeEach(async () => {
    await deleteRrV3Db();
    closeRrV3Db();
    resetBreakpointRegistry();

    // Create harness without auto-starting scheduler
    h = createV3E2EHarness({ autoStartScheduler: false });
    client = h.createClient();

    // Create a separate plugin registry for testing
    plugins = new PluginRegistry();
  });

  afterEach(async () => {
    await h.dispose();
  });

  describe('if handler through adapter', () => {
    it('adapts if handler to V3 NodeDefinition', () => {
      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(ifHandler);

      expect(nodeDef.kind).toBe('if');
      expect(typeof nodeDef.execute).toBe('function');
    });

    it('registers if handler in PluginRegistry', () => {
      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(ifHandler);
      plugins.registerNode(nodeDef as any);

      expect(plugins.hasNode('if')).toBe(true);
      expect(plugins.getNode('if')).toBeDefined();
    });

    it('keeps generic resolver object handles intact', () => {
      const shared = { value: 1 };
      const left = { value: 1 };
      const right = { value: 1 };
      const vars = { shared, alias: shared, left, right };
      const same = tryResolveJson({ kind: 'var', ref: { name: 'shared' } }, vars);
      const alias = tryResolveJson({ kind: 'var', ref: { name: 'alias' } }, vars);
      const distinctLeft = tryResolveJson({ kind: 'var', ref: { name: 'left' } }, vars);
      const distinctRight = tryResolveJson({ kind: 'var', ref: { name: 'right' } }, vars);
      const fallback = tryResolveJson(
        { kind: 'var', ref: { name: 'missing' }, default: shared },
        {},
      );
      const literal = tryResolveJson(shared, {});

      expect(same).toEqual({ ok: true, value: shared });
      expect(alias).toEqual({ ok: true, value: shared });
      expect(distinctLeft).toEqual({ ok: true, value: left });
      expect(distinctRight).toEqual({ ok: true, value: right });
      expect(fallback).toEqual({ ok: true, value: shared });
      expect(literal).toEqual({ ok: true, value: shared });
      if (same.ok && alias.ok && distinctLeft.ok && distinctRight.ok && fallback.ok && literal.ok) {
        expect(same.value).toBe(shared);
        expect(alias.value).toBe(same.value);
        expect(distinctLeft.value).not.toBe(distinctRight.value);
        expect(fallback.value).toBe(shared);
        expect(literal.value).toBe(shared);
      }
    });

    it('preserves legacy string and numeric coercion boundaries', () => {
      const cyclic: { self?: unknown } = {};
      cyclic.self = cyclic;
      expect(tryResolveString({ kind: 'var', ref: { name: 'nan' } }, { nan: Number.NaN })).toEqual({
        ok: true,
        value: 'NaN',
      });
      expect(
        tryResolveString(
          {
            kind: 'template',
            parts: [
              { kind: 'text', value: 'json=' },
              { kind: 'insert', value: { kind: 'var', ref: { name: 'missing' } }, format: 'json' },
              { kind: 'insert', value: { kind: 'var', ref: { name: 'space' } }, format: 'urlEncoded' },
            ],
          },
          { space: 'a b' },
        ),
      ).toEqual({ ok: true, value: 'json=nulla%20b' });
      expect(
        tryResolveString({ kind: 'var', ref: { name: 'cyclic' } }, { cyclic: cyclic as never }),
      ).toEqual({
        ok: true,
        value: '[object Object]',
      });
      expect(tryResolveNumber({ kind: 'var', ref: { name: 'blank' }, default: 3 }, { blank: '  ' })).toEqual({
        ok: true,
        value: 3,
      });
      expect(tryResolveNumber({ kind: 'var', ref: { name: 'number' } }, { number: '0x10' })).toEqual({
        ok: true,
        value: 16,
      });
      expect(
        tryResolveString(
          { kind: 'template', parts: [{ kind: 'text', value: 1 }] } as never,
          {},
        ),
      ).toEqual({ ok: false, error: 'Invalid template text part' });
    });

    it('evaluates truthy condition and returns true label', async () => {
      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(ifHandler);

      const mockCtx = {
        runId: 'run-1',
        flow: { policy: {} } as any,
        nodeId: 'if-node',
        tabId: 1,
        vars: { flag: true },
        log: vi.fn(),
        chooseNext: (label: string) => ({ kind: 'edgeLabel' as const, label }),
        artifacts: { screenshot: vi.fn() },
        persistent: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
      };

      const node = {
        id: 'if-node',
        kind: 'if',
        config: {
          mode: 'binary',
          condition: { kind: 'truthy', value: { kind: 'var', ref: { name: 'flag' } } },
          trueLabel: 'yes',
          falseLabel: 'no',
        },
      };

      const result = await nodeDef.execute(mockCtx as any, node as any);

      expect(result.status).toBe('succeeded');
      expect(asSucceeded(result).next).toEqual({ kind: 'edgeLabel', label: 'yes' });
    });

    it('evaluates falsy condition and returns false label', async () => {
      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(ifHandler);

      const mockCtx = {
        runId: 'run-1',
        flow: { policy: {} } as any,
        nodeId: 'if-node',
        tabId: 1,
        vars: { flag: false },
        log: vi.fn(),
        chooseNext: (label: string) => ({ kind: 'edgeLabel' as const, label }),
        artifacts: { screenshot: vi.fn() },
        persistent: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
      };

      const node = {
        id: 'if-node',
        kind: 'if',
        config: {
          mode: 'binary',
          condition: { kind: 'truthy', value: { kind: 'var', ref: { name: 'flag' } } },
          trueLabel: 'yes',
          falseLabel: 'no',
        },
      };

      const result = await nodeDef.execute(mockCtx as any, node as any);

      expect(result.status).toBe('succeeded');
      expect(asSucceeded(result).next).toEqual({ kind: 'edgeLabel', label: 'no' });
    });

    it('handles compare condition (eq)', async () => {
      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(ifHandler);

      const mockCtx = {
        runId: 'run-1',
        flow: { policy: {} } as any,
        nodeId: 'if-node',
        tabId: 1,
        vars: { value: 42 },
        log: vi.fn(),
        chooseNext: (label: string) => ({ kind: 'edgeLabel' as const, label }),
        artifacts: { screenshot: vi.fn() },
        persistent: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
      };

      const node = {
        id: 'if-node',
        kind: 'if',
        config: {
          mode: 'binary',
          condition: {
            kind: 'compare',
            left: { kind: 'var', ref: { name: 'value' } },
            op: 'eq',
            right: 42,
          },
        },
      };

      const result = await nodeDef.execute(mockCtx as any, node as any);

      expect(result.status).toBe('succeeded');
      expect(asSucceeded(result).next).toEqual({ kind: 'edgeLabel', label: 'true' });
    });

    it('handles branches mode', async () => {
      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(ifHandler);

      const mockCtx = {
        runId: 'run-1',
        flow: { policy: {} } as any,
        nodeId: 'if-node',
        tabId: 1,
        vars: { status: 'pending' },
        log: vi.fn(),
        chooseNext: (label: string) => ({ kind: 'edgeLabel' as const, label }),
        artifacts: { screenshot: vi.fn() },
        persistent: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
      };

      const node = {
        id: 'if-node',
        kind: 'if',
        config: {
          mode: 'branches',
          branches: [
            {
              label: 'completed',
              condition: {
                kind: 'compare',
                left: { kind: 'var', ref: { name: 'status' } },
                op: 'eq',
                right: 'done',
              },
            },
            {
              label: 'in-progress',
              condition: {
                kind: 'compare',
                left: { kind: 'var', ref: { name: 'status' } },
                op: 'eq',
                right: 'pending',
              },
            },
          ],
          elseLabel: 'unknown',
        },
      };

      const result = await nodeDef.execute(mockCtx as any, node as any);

      expect(result.status).toBe('succeeded');
      expect(asSucceeded(result).next).toEqual({ kind: 'edgeLabel', label: 'in-progress' });
    });
  });

  describe('delay handler through adapter', () => {
    it('adapts delay handler and executes', async () => {
      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(delayHandler);

      const mockCtx = {
        runId: 'run-1',
        flow: { policy: {} } as any,
        nodeId: 'delay-node',
        tabId: 1,
        vars: {},
        log: vi.fn(),
        chooseNext: (label: string) => ({ kind: 'edgeLabel' as const, label }),
        artifacts: { screenshot: vi.fn() },
        persistent: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
      };

      const node = {
        id: 'delay-node',
        kind: 'delay',
        config: { sleep: 10 }, // delay handler uses 'sleep' param
      };

      const startTime = Date.now();
      const result = await nodeDef.execute(mockCtx as any, node as any);
      const elapsed = Date.now() - startTime;

      expect(result.status).toBe('succeeded');
      expect(elapsed).toBeGreaterThanOrEqual(9); // Allow some tolerance
    });

    it('supports variable-based delay', async () => {
      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(delayHandler);

      const mockCtx = {
        runId: 'run-1',
        flow: { policy: {} } as any,
        nodeId: 'delay-node',
        tabId: 1,
        vars: { waitTime: 15 },
        log: vi.fn(),
        chooseNext: (label: string) => ({ kind: 'edgeLabel' as const, label }),
        artifacts: { screenshot: vi.fn() },
        persistent: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
      };

      const node = {
        id: 'delay-node',
        kind: 'delay',
        config: {
          sleep: { kind: 'var', ref: { name: 'waitTime' } },
        },
      };

      const startTime = Date.now();
      const result = await nodeDef.execute(mockCtx as any, node as any);
      const elapsed = Date.now() - startTime;

      expect(result.status).toBe('succeeded');
      expect(elapsed).toBeGreaterThanOrEqual(14);
    });
  });

  describe('Complex conditions', () => {
    it('handles AND condition', async () => {
      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(ifHandler);

      const mockCtx = {
        runId: 'run-1',
        flow: { policy: {} } as any,
        nodeId: 'if-node',
        tabId: 1,
        vars: { a: true, b: true },
        log: vi.fn(),
        chooseNext: (label: string) => ({ kind: 'edgeLabel' as const, label }),
        artifacts: { screenshot: vi.fn() },
        persistent: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
      };

      const node = {
        id: 'if-node',
        kind: 'if',
        config: {
          mode: 'binary',
          condition: {
            kind: 'and',
            conditions: [
              { kind: 'truthy', value: { kind: 'var', ref: { name: 'a' } } },
              { kind: 'truthy', value: { kind: 'var', ref: { name: 'b' } } },
            ],
          },
        },
      };

      const result = await nodeDef.execute(mockCtx as any, node as any);
      expect(asSucceeded(result).next).toEqual({ kind: 'edgeLabel', label: 'true' });
    });

    it('handles OR condition', async () => {
      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(ifHandler);

      const mockCtx = {
        runId: 'run-1',
        flow: { policy: {} } as any,
        nodeId: 'if-node',
        tabId: 1,
        vars: { a: false, b: true },
        log: vi.fn(),
        chooseNext: (label: string) => ({ kind: 'edgeLabel' as const, label }),
        artifacts: { screenshot: vi.fn() },
        persistent: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
      };

      const node = {
        id: 'if-node',
        kind: 'if',
        config: {
          mode: 'binary',
          condition: {
            kind: 'or',
            conditions: [
              { kind: 'truthy', value: { kind: 'var', ref: { name: 'a' } } },
              { kind: 'truthy', value: { kind: 'var', ref: { name: 'b' } } },
            ],
          },
        },
      };

      const result = await nodeDef.execute(mockCtx as any, node as any);
      expect(asSucceeded(result).next).toEqual({ kind: 'edgeLabel', label: 'true' });
    });

    it('handles NOT condition', async () => {
      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(ifHandler);

      const mockCtx = {
        runId: 'run-1',
        flow: { policy: {} } as any,
        nodeId: 'if-node',
        tabId: 1,
        vars: { flag: false },
        log: vi.fn(),
        chooseNext: (label: string) => ({ kind: 'edgeLabel' as const, label }),
        artifacts: { screenshot: vi.fn() },
        persistent: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
      };

      const node = {
        id: 'if-node',
        kind: 'if',
        config: {
          mode: 'binary',
          condition: {
            kind: 'not',
            condition: { kind: 'truthy', value: { kind: 'var', ref: { name: 'flag' } } },
          },
        },
      };

      const result = await nodeDef.execute(mockCtx as any, node as any);
      expect(asSucceeded(result).next).toEqual({ kind: 'edgeLabel', label: 'true' });
    });

    it('handles string comparison operators', async () => {
      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(ifHandler);

      const testCases = [
        { op: 'contains', value: 'hello world', right: 'world', expected: true },
        { op: 'containsI', value: 'Hello World', right: 'WORLD', expected: true },
        { op: 'startsWith', value: 'hello world', right: 'hello', expected: true },
        { op: 'endsWith', value: 'hello world', right: 'world', expected: true },
        { op: 'regex', value: 'test123', right: '\\d+', expected: true },
        { op: 'regex', value: 'test123', right: '[', expected: false },
      ];

      for (const { op, value, right, expected } of testCases) {
        const mockCtx = {
          runId: 'run-1',
          flow: { policy: {} } as any,
          nodeId: 'if-node',
          tabId: 1,
          vars: { str: value },
          log: vi.fn(),
          chooseNext: (label: string) => ({ kind: 'edgeLabel' as const, label }),
          artifacts: { screenshot: vi.fn() },
          persistent: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
        };

        const node = {
          id: 'if-node',
          kind: 'if',
          config: {
            mode: 'binary',
            condition: {
              kind: 'compare',
              left: { kind: 'var', ref: { name: 'str' } },
              op,
              right,
            },
          },
        };

        const result = await nodeDef.execute(mockCtx as any, node as any);
        const expectedLabel = expected ? 'true' : 'false';
        expect(asSucceeded(result).next).toEqual({ kind: 'edgeLabel', label: expectedLabel });
      }
    });

    it('preserves strict object identity instead of structural JSON equality', async () => {
      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(ifHandler);
      const shared = { value: 1 };
      const ctx = {
        runId: 'run-1',
        flow: { policy: {} },
        nodeId: 'if-node',
        tabId: 1,
        vars: { left: shared, alias: shared, right: { value: 1 } },
        log: vi.fn(),
        chooseNext: (label: string) => ({ kind: 'edgeLabel' as const, label }),
        artifacts: { screenshot: vi.fn() },
        persistent: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
      };
      const distinctNode = {
        id: 'if-node',
        kind: 'if',
        config: {
          mode: 'binary',
          condition: {
            kind: 'compare',
            left: { kind: 'var', ref: { name: 'left' } },
            op: 'eq',
            right: { kind: 'var', ref: { name: 'right' } },
          },
        },
      };
      const sameNode = {
        ...distinctNode,
        config: {
          mode: 'binary',
          condition: {
            kind: 'compare',
            left: { kind: 'var', ref: { name: 'left' } },
            op: 'eq',
            right: { kind: 'var', ref: { name: 'left' } },
          },
        },
      };
      const aliasNode = {
        ...distinctNode,
        config: {
          mode: 'binary',
          condition: {
            kind: 'compare',
            left: { kind: 'var', ref: { name: 'left' } },
            op: 'eq',
            right: { kind: 'var', ref: { name: 'alias' } },
          },
        },
      };

      const distinctResult = await nodeDef.execute(
        ctx as unknown as Parameters<typeof nodeDef.execute>[0],
        distinctNode as unknown as Parameters<typeof nodeDef.execute>[1],
      );
      const sameResult = await nodeDef.execute(
        ctx as unknown as Parameters<typeof nodeDef.execute>[0],
        sameNode as unknown as Parameters<typeof nodeDef.execute>[1],
      );
      const aliasResult = await nodeDef.execute(
        ctx as unknown as Parameters<typeof nodeDef.execute>[0],
        aliasNode as unknown as Parameters<typeof nodeDef.execute>[1],
      );

      expect(asSucceeded(distinctResult).next).toEqual({ kind: 'edgeLabel', label: 'false' });
      expect(asSucceeded(sameResult).next).toEqual({ kind: 'edgeLabel', label: 'true' });
      expect(asSucceeded(aliasResult).next).toEqual({ kind: 'edgeLabel', label: 'true' });
    });

    it('retains the identity of literal resolver defaults', async () => {
      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(ifHandler);
      const fallback = { value: 1 };
      const ctx = {
        runId: 'run-1',
        flow: { policy: {} },
        nodeId: 'if-node',
        tabId: 1,
        vars: {},
        log: vi.fn(),
        chooseNext: (label: string) => ({ kind: 'edgeLabel' as const, label }),
        artifacts: { screenshot: vi.fn() },
        persistent: { get: vi.fn() },
      };
      const node = {
        id: 'if-node',
        kind: 'if',
        config: {
          mode: 'binary',
          condition: {
            kind: 'compare',
            left: { kind: 'var', ref: { name: 'missing-left' }, default: fallback },
            op: 'eq',
            right: { kind: 'var', ref: { name: 'missing-right' }, default: fallback },
          },
        },
      };

      const result = await nodeDef.execute(
        ctx as unknown as Parameters<typeof nodeDef.execute>[0],
        node as unknown as Parameters<typeof nodeDef.execute>[1],
      );

      expect(asSucceeded(result).next).toEqual({ kind: 'edgeLabel', label: 'true' });
    });

    it('short-circuits before resolving later conditions', async () => {
      const reads: string[] = [];
      const vars = new Proxy(
        { first: false, second: true },
        {
          get(target, key, receiver) {
            reads.push(String(key));
            return Reflect.get(target, key, receiver);
          },
        },
      );
      const action = {
        id: 'if-node',
        type: 'if',
        params: {
          mode: 'binary',
          condition: {
            kind: 'and',
            conditions: [
              { kind: 'truthy', value: { kind: 'var', ref: { name: 'first' } } },
              { kind: 'truthy', value: { kind: 'var', ref: { name: 'second' } } },
            ],
          },
        },
      };

      const result = await ifHandler.run(
        { vars } as unknown as Parameters<typeof ifHandler.run>[0],
        action as unknown as Parameters<typeof ifHandler.run>[1],
      );

      expect(result).toEqual({ status: 'success', nextLabel: 'false' });
      expect(reads).toEqual(['first']);
    });

    it('treats resolver failures as false except for falsy conditions', async () => {
      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(ifHandler);
      const ctx = {
        runId: 'run-1',
        flow: { policy: {} },
        nodeId: 'if-node',
        tabId: 1,
        vars: {},
        log: vi.fn(),
        chooseNext: (label: string) => ({ kind: 'edgeLabel' as const, label }),
        artifacts: { screenshot: vi.fn() },
        persistent: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
      };
      const node = {
        id: 'if-node',
        kind: 'if',
        config: {
          mode: 'branches',
          branches: [
            {
              label: 'truthy',
              condition: { kind: 'truthy', value: { kind: 'var', ref: { name: 'missing' } } },
            },
            {
              label: 'falsy',
              condition: { kind: 'falsy', value: { kind: 'var', ref: { name: 'missing' } } },
            },
          ],
        },
      };

      const result = await nodeDef.execute(
        ctx as unknown as Parameters<typeof nodeDef.execute>[0],
        node as unknown as Parameters<typeof nodeDef.execute>[1],
      );

      expect(asSucceeded(result).next).toEqual({ kind: 'edgeLabel', label: 'falsy' });
    });
  });
});
