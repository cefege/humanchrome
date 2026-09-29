/**
 * Durable background task queue for the bridge.
 *
 * Decouples submission from execution: a client can fire a burst of tool
 * calls and get an immediate ack while an in-process drain worker executes
 * them over time, in a deterministic order (priority DESC, then FIFO),
 * respecting a global concurrency cap and per-lane serialization ("don't
 * drive the same account/tab twice at once"). Execution reuses the existing
 * `dispatchTool` path, so tab ownership, per-tab locks, `chrome_pace`
 * pacing, redaction, and the error envelope all keep working unchanged.
 *
 * Persistence is the shared agent SQLite DB (`tasks` table). In-memory
 * counters are authoritative for scheduling; the DB is durability + status.
 */
import { randomUUID } from 'node:crypto';
import { and, or, eq, isNull, lte, inArray, notInArray, desc, asc, sql } from 'drizzle-orm';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { isKnownToolName, TOOL_NAMES } from 'humanchrome-shared';
import { getDb, tasks, type DrizzleDB, type TaskRow } from '../agent/db';
import nativeMessagingHostInstance from '../native-messaging-host';
import { dispatchTool, toErrorEnvelopeText } from '../mcp/dispatch';

const FLOW_PREFIX = 'flow.';
const TERMINAL_STATUSES: readonly string[] = ['done', 'failed', 'cancelled'];
const TRANSIENT_DISCONNECT_MARKERS = ['source disconnected', 'no active native-messaging source'];
const TRANSIENT_RETRY_DELAY_MS = 2000;
const MAX_BACKOFF_MS = 60_000;

export type TaskExecutor = (
  tool: string,
  args: unknown,
  clientId?: string,
) => Promise<CallToolResult>;

export interface TaskQueueDeps {
  db?: DrizzleDB;
  execute?: TaskExecutor;
  isSourceActive?: () => boolean;
  now?: () => number;
  globalConcurrency?: number;
  laneConcurrency?: number;
  pollMs?: number;
}

export interface EnqueueInput {
  tool: string;
  args?: unknown;
  clientId?: string;
  lane?: string;
  priority?: number;
  notBefore?: string;
  maxAttempts?: number;
  idemKey?: string;
}

export interface EnqueueResult {
  taskId: string;
  deduped: boolean;
}

export interface ListTasksInput {
  status?: string;
  lane?: string;
  limit?: number;
}

export interface CancelResult {
  cancelled: boolean;
  status: string;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export class TaskQueueService {
  private readonly db: DrizzleDB;
  private readonly execute: TaskExecutor;
  private readonly isSourceActive: () => boolean;
  private readonly now: () => number;
  private readonly globalConcurrency: number;
  private readonly laneConcurrency: number;
  private readonly pollMs: number;

  private globalInFlight = 0;
  private readonly laneInFlight = new Map<string, number>();
  private readonly waiters = new Map<string, Set<(row: TaskRow) => void>>();
  private interval: NodeJS.Timeout | undefined;
  private started = false;

  constructor(deps: TaskQueueDeps = {}) {
    this.db = deps.db ?? getDb();
    this.execute = deps.execute ?? ((tool, args, clientId) => dispatchTool(tool, args, clientId));
    this.isSourceActive =
      deps.isSourceActive ?? (() => nativeMessagingHostInstance.isSourceActive());
    this.now = deps.now ?? Date.now;
    this.globalConcurrency = deps.globalConcurrency ?? envInt('HUMANCHROME_QUEUE_CONCURRENCY', 3);
    this.laneConcurrency = deps.laneConcurrency ?? envInt('HUMANCHROME_QUEUE_LANE_CONCURRENCY', 1);
    this.pollMs = deps.pollMs ?? envInt('HUMANCHROME_QUEUE_POLL_MS', 5000);
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  private insert(input: EnqueueInput): EnqueueResult {
    const tool = input.tool;
    if (typeof tool !== 'string' || tool.length === 0) {
      throw new Error('`tool` is required (string).');
    }
    if (tool === TOOL_NAMES.BROWSER.TASKS) {
      throw new Error('`tool` cannot be chrome_tasks (no recursive queueing).');
    }
    if (!isKnownToolName(tool) && !tool.startsWith(FLOW_PREFIX)) {
      throw new Error(`Unknown tool: ${tool}`);
    }
    if (input.notBefore !== undefined && Number.isNaN(Date.parse(input.notBefore))) {
      throw new Error(`\`notBefore\` is not a valid ISO date: ${input.notBefore}`);
    }

    const clientId = input.clientId ?? null;
    const lane = input.lane ?? input.clientId ?? 'default';
    const idemKey = input.idemKey ?? null;

    if (idemKey !== null) {
      const existing = this.db
        .select()
        .from(tasks)
        .where(
          and(
            clientId === null ? isNull(tasks.clientId) : eq(tasks.clientId, clientId),
            eq(tasks.idemKey, idemKey),
            inArray(tasks.status, ['queued', 'running']),
          ),
        )
        .limit(1)
        .all();
      if (existing.length > 0) {
        return { taskId: existing[0].id, deduped: true };
      }
    }

    const iso = this.nowIso();
    const id = randomUUID();
    this.db
      .insert(tasks)
      .values({
        id,
        clientId,
        lane,
        tool,
        args: JSON.stringify(input.args ?? {}),
        priority: input.priority ?? 0,
        status: 'queued',
        attempt: 0,
        maxAttempts: input.maxAttempts ?? 1,
        notBefore: input.notBefore ?? null,
        idemKey,
        result: null,
        error: null,
        createdAt: iso,
        updatedAt: iso,
        startedAt: null,
        completedAt: null,
      })
      .run();

    return { taskId: id, deduped: false };
  }

  enqueue(input: EnqueueInput): EnqueueResult {
    const result = this.insert(input);
    this.kick();
    return result;
  }

  enqueueBatch(inputs: EnqueueInput[]): EnqueueResult[] {
    const results = inputs.map((input) => this.insert(input));
    this.kick();
    return results;
  }

  getTask(id: string): TaskRow | null {
    const rows = this.db.select().from(tasks).where(eq(tasks.id, id)).limit(1).all();
    return rows.length > 0 ? rows[0] : null;
  }

  listTasks(input: ListTasksInput = {}): TaskRow[] {
    const conditions = [];
    if (input.status) conditions.push(eq(tasks.status, input.status));
    if (input.lane) conditions.push(eq(tasks.lane, input.lane));
    const base = this.db.select().from(tasks);
    const filtered = conditions.length > 0 ? base.where(and(...conditions)) : base;
    return filtered
      .orderBy(desc(tasks.priority), asc(tasks.createdAt))
      .limit(input.limit ?? 100)
      .all();
  }

  cancel(id: string): CancelResult {
    const task = this.getTask(id);
    if (!task) return { cancelled: false, status: 'unknown' };
    if (task.status !== 'queued') return { cancelled: false, status: task.status };
    const iso = this.nowIso();
    this.db
      .update(tasks)
      .set({ status: 'cancelled', updatedAt: iso, completedAt: iso })
      .where(eq(tasks.id, id))
      .run();
    this.notifyWaiters(id);
    return { cancelled: true, status: 'cancelled' };
  }

  recoverOnBoot(): void {
    const iso = this.nowIso();
    this.db
      .update(tasks)
      .set({
        status: 'failed',
        error: 'interrupted by bridge restart',
        completedAt: iso,
        updatedAt: iso,
      })
      .where(eq(tasks.status, 'running'))
      .run();
    this.globalInFlight = 0;
    this.laneInFlight.clear();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.recoverOnBoot();
    this.interval = setInterval(() => this.kick(), this.pollMs);
    this.interval.unref?.();
    this.kick();
  }

  stop(): void {
    clearInterval(this.interval);
    this.interval = undefined;
    this.started = false;
  }

  waitForTask(id: string, timeoutMs: number): Promise<TaskRow | null> {
    const current = this.getTask(id);
    if (!current) return Promise.resolve(null);
    if (TERMINAL_STATUSES.includes(current.status)) return Promise.resolve(current);

    // ES2022 lib target — no Promise.withResolvers; the executor form is
    // the supported way to expose the resolver to the waiter set + timer.
    return new Promise<TaskRow | null>((resolve) => {
      let settled = false;
      const resolver = (row: TaskRow) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.removeWaiter(id, resolver);
        resolve(row);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.removeWaiter(id, resolver);
        resolve(this.getTask(id));
      }, timeoutMs);
      timer.unref?.();

      let set = this.waiters.get(id);
      if (!set) {
        set = new Set();
        this.waiters.set(id, set);
      }
      set.add(resolver);
    });
  }

  private removeWaiter(id: string, resolver: (row: TaskRow) => void): void {
    const set = this.waiters.get(id);
    if (!set) return;
    set.delete(resolver);
    if (set.size === 0) this.waiters.delete(id);
  }

  private notifyWaiters(id: string): void {
    const set = this.waiters.get(id);
    if (!set || set.size === 0) return;
    const row = this.getTask(id);
    if (!row) return;
    for (const resolver of [...set]) resolver(row);
  }

  private release(lane: string): void {
    this.globalInFlight = Math.max(0, this.globalInFlight - 1);
    const n = this.laneInFlight.get(lane) ?? 0;
    if (n <= 1) this.laneInFlight.delete(lane);
    else this.laneInFlight.set(lane, n - 1);
  }

  kick(): void {
    if (!this.isSourceActive()) return;
    while (this.globalInFlight < this.globalConcurrency) {
      const atCapLanes: string[] = [];
      for (const [lane, n] of this.laneInFlight) {
        if (n >= this.laneConcurrency) atCapLanes.push(lane);
      }

      const conditions = [
        eq(tasks.status, 'queued'),
        or(isNull(tasks.notBefore), lte(tasks.notBefore, this.nowIso())),
      ];
      if (atCapLanes.length > 0) conditions.push(notInArray(tasks.lane, atCapLanes));

      const rows = this.db
        .select()
        .from(tasks)
        .where(and(...conditions))
        .orderBy(desc(tasks.priority), asc(tasks.createdAt))
        .limit(1)
        .all();
      if (rows.length === 0) break;

      const task = rows[0];
      const iso = this.nowIso();
      this.db
        .update(tasks)
        .set({
          status: 'running',
          startedAt: iso,
          attempt: sql`${tasks.attempt} + 1`,
          updatedAt: iso,
        })
        .where(eq(tasks.id, task.id))
        .run();

      this.globalInFlight += 1;
      this.laneInFlight.set(task.lane, (this.laneInFlight.get(task.lane) ?? 0) + 1);

      const { id, lane, tool } = task;
      let parsedArgs: unknown;
      try {
        parsedArgs = JSON.parse(task.args);
      } catch {
        parsedArgs = {};
      }

      Promise.resolve()
        .then(() => this.execute(tool, parsedArgs, task.clientId ?? undefined))
        .then((result) => this.onSettle(id, lane, result))
        .catch((err) => this.onError(id, lane, err));
    }
  }

  private onSettle(id: string, lane: string, result: CallToolResult): void {
    this.release(lane);
    const task = this.getTask(id);
    if (task) {
      if (result?.isError) {
        this.handleFailure(task, extractErrorText(result));
      } else {
        const iso = this.nowIso();
        this.db
          .update(tasks)
          .set({
            status: 'done',
            result: JSON.stringify(result),
            completedAt: iso,
            updatedAt: iso,
          })
          .where(eq(tasks.id, id))
          .run();
        this.notifyWaiters(id);
      }
    }
    this.kick();
  }

  private onError(id: string, lane: string, err: unknown): void {
    this.release(lane);
    const message = err instanceof Error ? err.message : String(err);
    const task = this.getTask(id);
    if (task) {
      if (isTransientDisconnect(message)) {
        const iso = this.nowIso();
        const notBefore = new Date(this.now() + TRANSIENT_RETRY_DELAY_MS).toISOString();
        this.db
          .update(tasks)
          .set({
            status: 'queued',
            attempt: Math.max(0, task.attempt - 1),
            notBefore,
            updatedAt: iso,
          })
          .where(eq(tasks.id, id))
          .run();
      } else {
        this.handleFailure(task, toErrorEnvelopeText(message));
      }
    }
    this.kick();
  }

  private handleFailure(task: TaskRow, errorText: string): void {
    const iso = this.nowIso();
    if (task.attempt < task.maxAttempts) {
      const backoff = Math.min(1000 * 2 ** (task.attempt - 1), MAX_BACKOFF_MS);
      const notBefore = new Date(this.now() + backoff).toISOString();
      this.db
        .update(tasks)
        .set({ status: 'queued', notBefore, error: errorText, updatedAt: iso })
        .where(eq(tasks.id, task.id))
        .run();
    } else {
      this.db
        .update(tasks)
        .set({ status: 'failed', error: errorText, completedAt: iso, updatedAt: iso })
        .where(eq(tasks.id, task.id))
        .run();
      this.notifyWaiters(task.id);
    }
  }
}

function extractErrorText(result: CallToolResult): string {
  const block = result?.content?.find((c) => c.type === 'text');
  if (block && block.type === 'text') return block.text;
  return 'tool error';
}

function isTransientDisconnect(message: string): boolean {
  const lower = message.toLowerCase();
  return TRANSIENT_DISCONNECT_MARKERS.some((m) => lower.includes(m));
}

let singleton: TaskQueueService | null = null;

export function getTaskQueue(): TaskQueueService {
  if (!singleton) singleton = new TaskQueueService();
  return singleton;
}
