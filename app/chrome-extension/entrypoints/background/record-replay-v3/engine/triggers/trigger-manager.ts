/**
 * TriggerManager — orchestrates per-kind trigger Handlers.
 *
 * Responsibilities:
 * - Load triggers from the TriggerStore and install them.
 * - Receive fire events from Handlers and enqueue Runs.
 * - Provide storm control: per-trigger cooldown + global maxQueued (best-effort).
 *
 * The manager itself contains no chrome API logic — Handlers do that. At
 * construction it creates one Handler instance per kind via the supplied
 * factories, injecting the shared fireCallback.
 */

import type { UnixMillis } from '../../domain/json';
import type { RunId, TriggerId } from '../../domain/ids';
import type { TriggerFireContext, TriggerKind, TriggerSpec } from '../../domain/triggers';
import type { StoragePort } from '../storage/storage-port';
import type { EventsBus } from '../transport/events-bus';
import type { RunScheduler } from '../queue/scheduler';
import { enqueueRun, type EnqueueRunResult } from '../queue/enqueue-run';
import type { TriggerFireCallback, TriggerHandler, TriggerHandlerFactory } from './trigger-handler';

export type TriggerHandlerFactories = Partial<{
  [K in TriggerKind]: TriggerHandlerFactory<K>;
}>;

export interface TriggerManagerStormControl {
  /** Minimum gap between two fires of the same trigger; 0/undefined disables. */
  cooldownMs?: number;

  /**
   * Global queue cap. When reached, new fires are dropped.
   * undefined disables the check. The check is best-effort, not atomic.
   */
  maxQueued?: number;
}

export interface TriggerManagerDeps {
  storage: Pick<StoragePort, 'triggers' | 'flows' | 'runs' | 'queue'>;
  events: Pick<EventsBus, 'append'>;
  scheduler?: Pick<RunScheduler, 'kick'>;
  handlerFactories: TriggerHandlerFactories;
  storm?: TriggerManagerStormControl;
  generateRunId?: () => RunId;
  now?: () => UnixMillis;
  logger?: Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;
}

export interface TriggerManagerState {
  started: boolean;
  installedTriggerIds: TriggerId[];
}

export interface TriggerManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  refresh(): Promise<void>;
  /** Manually fire a trigger. Used by RPC/UI for `manual` triggers. */
  fire(
    triggerId: TriggerId,
    context?: { sourceTabId?: number; sourceUrl?: string },
  ): Promise<EnqueueRunResult>;
  dispose(): Promise<void>;
  getState(): TriggerManagerState;
}

function normalizeNonNegativeInt(value: unknown, fallback: number, fieldName: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a finite number`);
  }
  return Math.max(0, Math.floor(value));
}

function normalizePositiveInt(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a finite number`);
  }
  const intValue = Math.floor(value);
  if (intValue < 1) {
    throw new Error(`${fieldName} must be >= 1`);
  }
  return intValue;
}

// ==================== Implementation ====================

/**
 * 创建 TriggerManager
 */
export function createTriggerManager(deps: TriggerManagerDeps): TriggerManager {
  const logger = deps.logger ?? console;
  const now = deps.now ?? (() => Date.now());

  // 防风暴参数
  const cooldownMs = normalizeNonNegativeInt(deps.storm?.cooldownMs, 0, 'storm.cooldownMs');
  const maxQueued =
    deps.storm?.maxQueued === undefined || deps.storm?.maxQueued === null
      ? undefined
      : normalizePositiveInt(deps.storm.maxQueued, 'storm.maxQueued');

  // 状态
  const installed = new Map<TriggerId, TriggerSpec>();
  const lastFireAt = new Map<TriggerId, UnixMillis>();
  let started = false;
  let inFlightEnqueues = 0;

  // 防止 refresh 重入
  let refreshPromise: Promise<void> | null = null;
  let pendingRefresh = false;

  // Handler 实例
  const handlers = new Map<TriggerKind, TriggerHandler<TriggerKind>>();

  // 触发回调
  const fireCallback: TriggerFireCallback = {
    onFire: async (triggerId, context) => {
      // 捕获所有异常，避免抛入 chrome API 监听器
      try {
        await handleFire(triggerId as TriggerId, context);
      } catch (e) {
        logger.error('[TriggerManager] onFire failed:', e);
      }
    },
  };

  // 初始化 Handler 实例
  for (const [kind, factory] of Object.entries(deps.handlerFactories) as Array<
    [TriggerKind, TriggerHandlerFactory<TriggerKind> | undefined]
  >) {
    if (!factory) continue; // Skip undefined factory values

    const handler = factory(fireCallback) as TriggerHandler<TriggerKind>;
    if (handler.kind !== kind) {
      throw new Error(
        `[TriggerManager] Handler kind mismatch: factory key is "${kind}", but handler.kind is "${handler.kind}"`,
      );
    }
    handlers.set(kind, handler);
  }

  /**
   * 处理触发器触发（内部方法）
   * @param throwOnDrop 如果为 true，则在 cooldown/maxQueued 等情况下抛出错误
   * @returns EnqueueRunResult 或 null（静默丢弃）
   */
  async function handleFire(
    triggerId: TriggerId,
    context: { sourceTabId?: number; sourceUrl?: string },
    options?: { throwOnDrop?: boolean },
  ): Promise<EnqueueRunResult | null> {
    if (!started) {
      if (options?.throwOnDrop) {
        throw new Error('TriggerManager is not started');
      }
      return null;
    }

    const trigger = installed.get(triggerId);
    if (!trigger) {
      if (options?.throwOnDrop) {
        throw new Error(`Trigger "${triggerId}" is not installed`);
      }
      return null;
    }

    const t = now();

    // Per-trigger cooldown 检查
    const prevLastFireAt = lastFireAt.get(triggerId);
    if (cooldownMs > 0 && prevLastFireAt !== undefined && t - prevLastFireAt < cooldownMs) {
      logger.debug(`[TriggerManager] Dropping trigger "${triggerId}" (cooldown ${cooldownMs}ms)`);
      if (options?.throwOnDrop) {
        throw new Error(`Trigger "${triggerId}" dropped (cooldown ${cooldownMs}ms)`);
      }
      return null;
    }

    // Global maxQueued 检查 (best-effort)
    // 注意：在 cooldown 设置前检查，避免因 maxQueued drop 而误设 cooldown
    if (maxQueued !== undefined) {
      const queued = await deps.storage.queue.list('queued');
      if (queued.length + inFlightEnqueues >= maxQueued) {
        logger.warn(
          `[TriggerManager] Dropping trigger "${triggerId}" (queued=${queued.length}, inFlight=${inFlightEnqueues}, maxQueued=${maxQueued})`,
        );
        if (options?.throwOnDrop) {
          throw new Error(`Trigger "${triggerId}" dropped (maxQueued=${maxQueued})`);
        }
        return null;
      }
    }

    // 设置 lastFireAt 以抑制并发触发（在 maxQueued 检查通过后）
    if (cooldownMs > 0) {
      lastFireAt.set(triggerId, t);
    }

    // 构建触发上下文
    const triggerContext: TriggerFireContext = {
      triggerId: trigger.id,
      kind: trigger.kind,
      firedAt: t,
      sourceTabId: context.sourceTabId,
      sourceUrl: context.sourceUrl,
    };

    inFlightEnqueues += 1;
    try {
      const result = await enqueueRun(
        {
          storage: deps.storage,
          events: deps.events,
          scheduler: deps.scheduler,
          generateRunId: deps.generateRunId,
          now,
        },
        {
          flowId: trigger.flowId,
          args: trigger.args,
          trigger: triggerContext,
        },
      );
      return result;
    } catch (e) {
      // 入队失败时回滚 cooldown 标记
      if (cooldownMs > 0) {
        if (prevLastFireAt === undefined) {
          lastFireAt.delete(triggerId);
        } else {
          lastFireAt.set(triggerId, prevLastFireAt);
        }
      }
      const msg = e instanceof Error ? e.message : String(e);
      logger.error(`[TriggerManager] enqueueRun failed for trigger "${triggerId}":`, e);
      if (options?.throwOnDrop) {
        throw new Error(`enqueueRun failed for trigger "${triggerId}": ${msg}`);
      }
      return null;
    } finally {
      inFlightEnqueues -= 1;
    }
  }

  /**
   * 手动触发一个触发器（对外暴露）
   * @description 用于 RPC/UI 调用，会抛出错误而不是静默丢弃
   */
  async function fire(
    triggerId: TriggerId,
    context: { sourceTabId?: number; sourceUrl?: string } = {},
  ): Promise<EnqueueRunResult> {
    const result = await handleFire(triggerId, context, { throwOnDrop: true });
    if (!result) {
      throw new Error(`Trigger "${triggerId}" did not enqueue a run`);
    }
    return result;
  }

  /**
   * 执行刷新
   */
  async function doRefresh(): Promise<void> {
    const triggers = await deps.storage.triggers.list();
    if (!started) return;

    // 先卸载所有，再重新安装 (简单策略，保证一致性)
    // Best-effort: 单个 handler 卸载失败不影响其他
    for (const handler of handlers.values()) {
      try {
        await handler.uninstallAll();
      } catch (e) {
        logger.warn(`[TriggerManager] Error during uninstallAll for kind "${handler.kind}":`, e);
      }
    }
    installed.clear();

    // 安装启用的触发器
    for (const trigger of triggers) {
      if (!started) return;
      if (!trigger.enabled) continue;

      const handler = handlers.get(trigger.kind);
      if (!handler) {
        logger.warn(`[TriggerManager] No handler registered for kind "${trigger.kind}"`);
        continue;
      }

      try {
        await handler.install(trigger as Parameters<typeof handler.install>[0]);
        installed.set(trigger.id, trigger);
      } catch (e) {
        logger.error(`[TriggerManager] Failed to install trigger "${trigger.id}":`, e);
      }
    }
  }

  /**
   * 刷新触发器 (合并并发调用)
   */
  async function refresh(): Promise<void> {
    if (!started) {
      throw new Error('TriggerManager is not started');
    }

    pendingRefresh = true;
    if (!refreshPromise) {
      refreshPromise = (async () => {
        while (started && pendingRefresh) {
          pendingRefresh = false;
          await doRefresh();
        }
      })().finally(() => {
        refreshPromise = null;
      });
    }

    return refreshPromise;
  }

  /**
   * 启动管理器
   */
  async function start(): Promise<void> {
    if (started) return;
    started = true;
    await refresh();
  }

  /**
   * 停止管理器
   */
  async function stop(): Promise<void> {
    if (!started) return;

    started = false;
    pendingRefresh = false;

    // 等待进行中的 refresh 完成
    if (refreshPromise) {
      try {
        await refreshPromise;
      } catch {
        // 忽略 refresh 错误
      }
    }

    // 卸载所有触发器
    for (const handler of handlers.values()) {
      try {
        await handler.uninstallAll();
      } catch (e) {
        logger.warn('[TriggerManager] Error uninstalling handler:', e);
      }
    }
    installed.clear();
    lastFireAt.clear();
  }

  /**
   * 销毁管理器
   */
  async function dispose(): Promise<void> {
    await stop();
  }

  /**
   * 获取状态
   */
  function getState(): TriggerManagerState {
    return {
      started,
      installedTriggerIds: Array.from(installed.keys()),
    };
  }

  return { start, stop, refresh, fire, dispose, getState };
}
