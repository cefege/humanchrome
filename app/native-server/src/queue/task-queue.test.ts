import { describe, it, expect } from '@jest/globals';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as schema from '../agent/db/schema';
import { TaskQueueService, type TaskExecutor, type TaskQueueDeps } from './task-queue';

const TASKS_DDL = `
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  client_id TEXT,
  lane TEXT NOT NULL,
  tool TEXT NOT NULL,
  args TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  not_before TEXT,
  idem_key TEXT,
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);
`;

// A known browser tool name used for enqueue validation. Any real tool works;
// the injected executor never actually forwards it to an extension.
const TOOL = 'chrome_navigate';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readN(args: unknown): number {
  if (isRecord(args) && typeof args.n === 'number') return args.n;
  return -1;
}

const flush = () => new Promise<void>((r) => setImmediate(r));
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await flush();
}

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(TASKS_DDL);
  return drizzle(sqlite, { schema });
}

interface Harness {
  queue: TaskQueueService;
  clock: { t: number };
  active: { on: boolean };
}

function makeQueue(overrides: Partial<TaskQueueDeps>): Harness {
  const clock = { t: 1000 };
  const active = { on: true };
  const queue = new TaskQueueService({
    db: makeDb(),
    now: () => clock.t,
    isSourceActive: () => active.on,
    globalConcurrency: 3,
    laneConcurrency: 1,
    pollMs: 1_000_000,
    ...overrides,
  });
  return { queue, clock, active };
}

/** Executor that stays pending until released; records concurrency + order. */
function gateExecutor() {
  const state = {
    inFlight: 0,
    peak: 0,
    laneInFlight: new Map<string, number>(),
    lanePeak: new Map<string, number>(),
    started: [] as number[],
    pending: [] as Array<() => void>,
  };
  const execute: TaskExecutor = (_tool, args, clientId) => {
    state.inFlight += 1;
    state.peak = Math.max(state.peak, state.inFlight);
    const lane = clientId ?? 'default';
    const c = (state.laneInFlight.get(lane) ?? 0) + 1;
    state.laneInFlight.set(lane, c);
    state.lanePeak.set(lane, Math.max(state.lanePeak.get(lane) ?? 0, c));
    state.started.push(readN(args));
    return new Promise<CallToolResult>((resolve) => {
      state.pending.push(() => {
        state.inFlight -= 1;
        state.laneInFlight.set(lane, (state.laneInFlight.get(lane) ?? 1) - 1);
        resolve({ content: [{ type: 'text', text: 'ok' }] });
      });
    });
  };
  const releaseAll = () => state.pending.splice(0).forEach((f) => f());
  return { execute, state, releaseAll };
}

describe('TaskQueueService', () => {
  it('serializes tasks within a lane; completion order is priority DESC then FIFO', async () => {
    const gate = gateExecutor();
    const { queue, clock, active } = makeQueue({ execute: gate.execute });

    // Queue all three before any can run, so priority actually competes at
    // selection time (a serial lane would otherwise start the first-enqueued
    // task immediately, before the others exist).
    active.on = false;
    queue.enqueue({ tool: TOOL, args: { n: 1 }, clientId: 'c1', priority: 0 });
    clock.t += 1;
    queue.enqueue({ tool: TOOL, args: { n: 2 }, clientId: 'c1', priority: 5 });
    clock.t += 1;
    queue.enqueue({ tool: TOOL, args: { n: 3 }, clientId: 'c1', priority: 0 });
    active.on = true;
    queue.kick();

    // Drain fully by releasing one at a time.
    for (let i = 0; i < 3; i++) {
      await settle();
      expect(gate.state.peak).toBe(1); // never more than one in the lane
      gate.releaseAll();
    }
    await settle();

    expect(gate.state.started).toEqual([2, 1, 3]); // pri 5 first, then FIFO
  });

  it('runs lanes in parallel up to the global cap, one per lane', async () => {
    const gate = gateExecutor();
    const { queue } = makeQueue({
      execute: gate.execute,
      globalConcurrency: 2,
      laneConcurrency: 1,
    });

    queue.enqueue({ tool: TOOL, args: { n: 1 }, clientId: 'A' });
    queue.enqueue({ tool: TOOL, args: { n: 2 }, clientId: 'A' });
    queue.enqueue({ tool: TOOL, args: { n: 3 }, clientId: 'B' });
    queue.enqueue({ tool: TOOL, args: { n: 4 }, clientId: 'B' });

    await settle();
    expect(gate.state.peak).toBe(2); // global cap reached
    expect(gate.state.lanePeak.get('A')).toBe(1);
    expect(gate.state.lanePeak.get('B')).toBe(1);

    gate.releaseAll();
    await settle();
    gate.releaseAll();
    await settle();

    expect(gate.state.started.length).toBe(4);
    expect(gate.state.lanePeak.get('A')).toBe(1);
    expect(gate.state.lanePeak.get('B')).toBe(1);
  });

  it('defers a task with a future notBefore until the clock advances', async () => {
    const gate = gateExecutor();
    const { queue, clock } = makeQueue({ execute: gate.execute });

    const notBefore = new Date(clock.t + 10_000).toISOString();
    const { taskId } = queue.enqueue({ tool: TOOL, args: { n: 1 }, clientId: 'c1', notBefore });

    await settle();
    expect(gate.state.started.length).toBe(0);
    expect(queue.getTask(taskId)?.status).toBe('queued');

    clock.t += 20_000;
    queue.kick();
    await settle();
    expect(gate.state.started).toEqual([1]);
  });

  it('retries up to maxAttempts on tool error, then fails', async () => {
    let calls = 0;
    const execute: TaskExecutor = async () => {
      calls += 1;
      return { content: [{ type: 'text', text: 'boom' }], isError: true };
    };
    const { queue, clock } = makeQueue({ execute });

    const { taskId } = queue.enqueue({ tool: TOOL, clientId: 'c1', maxAttempts: 2 });
    await settle();
    expect(calls).toBe(1);
    expect(queue.getTask(taskId)?.status).toBe('queued'); // requeued with backoff

    clock.t += 5_000;
    queue.kick();
    await settle();
    expect(calls).toBe(2);
    expect(queue.getTask(taskId)?.status).toBe('failed');
  });

  it('fails after a single run when maxAttempts is 1', async () => {
    let calls = 0;
    const execute: TaskExecutor = async () => {
      calls += 1;
      return { content: [{ type: 'text', text: 'boom' }], isError: true };
    };
    const { queue } = makeQueue({ execute });
    const { taskId } = queue.enqueue({ tool: TOOL, clientId: 'c1', maxAttempts: 1 });
    await settle();
    expect(calls).toBe(1);
    expect(queue.getTask(taskId)?.status).toBe('failed');
  });

  it('does not consume an attempt on transient disconnect', async () => {
    const execute: TaskExecutor = async () => {
      throw new Error('dispatch failed: no active native-messaging source');
    };
    const { queue } = makeQueue({ execute });
    const { taskId } = queue.enqueue({ tool: TOOL, clientId: 'c1', maxAttempts: 1 });
    await settle();
    const row = queue.getTask(taskId);
    expect(row?.status).toBe('queued');
    expect(row?.attempt).toBe(0); // undo of the increment
  });

  it('recoverOnBoot marks running tasks as failed', async () => {
    const gate = gateExecutor();
    const { queue } = makeQueue({ execute: gate.execute, isSourceActive: () => true });
    queue.enqueue({ tool: TOOL, args: { n: 9 }, clientId: 'c1' });
    await settle(); // task is now 'running', pending on the gate
    expect(queue.listTasks({ status: 'running' }).length).toBe(1);

    queue.recoverOnBoot();
    const failed = queue.listTasks({ status: 'failed' });
    expect(failed.length).toBe(1);
    expect(failed[0].error).toBe('interrupted by bridge restart');
  });

  it('does not drain while the source is inactive; drains once active', async () => {
    const gate = gateExecutor();
    const { queue, active } = makeQueue({ execute: gate.execute, isSourceActive: () => active.on });
    active.on = false;
    queue.enqueue({ tool: TOOL, args: { n: 1 }, clientId: 'c1' });
    await settle();
    expect(gate.state.started.length).toBe(0);

    active.on = true;
    queue.kick();
    await settle();
    expect(gate.state.started).toEqual([1]);
  });

  it('dedupes by (clientId, idemKey) while queued', () => {
    const { queue } = makeQueue({ execute: gateExecutor().execute, isSourceActive: () => false });
    const a = queue.enqueue({ tool: TOOL, clientId: 'c1', idemKey: 'k1' });
    const b = queue.enqueue({ tool: TOOL, clientId: 'c1', idemKey: 'k1' });
    expect(b.taskId).toBe(a.taskId);
    expect(b.deduped).toBe(true);
    expect(queue.listTasks({}).length).toBe(1);
  });

  it('waitForTask resolves on terminal status and on timeout', async () => {
    const gate = gateExecutor();
    const { queue } = makeQueue({ execute: gate.execute });
    const { taskId } = queue.enqueue({ tool: TOOL, args: { n: 1 }, clientId: 'c1' });
    await settle();

    // Tiny timeout while still running → resolves with a non-terminal row.
    const early = await queue.waitForTask(taskId, 5);
    expect(early).not.toBeNull();
    expect(['queued', 'running']).toContain(early?.status);

    // Long timeout, released before it elapses → resolves with the done row.
    const wait = queue.waitForTask(taskId, 5_000);
    gate.releaseAll();
    const done = await wait;
    expect(done?.status).toBe('done');
    expect(done?.result).not.toBeNull();
  });
});
