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

export function createTriggerManager(deps: TriggerManagerDeps): TriggerManager {
  const logger = deps.logger ?? console;
  const now = deps.now ?? (() => Date.now());

  const cooldownMs = normalizeNonNegativeInt(deps.storm?.cooldownMs, 0, 'storm.cooldownMs');
  const maxQueued =
    deps.storm?.maxQueued === undefined || deps.storm?.maxQueued === null
      ? undefined
      : normalizePositiveInt(deps.storm.maxQueued, 'storm.maxQueued');

  const installed = new Map<TriggerId, TriggerSpec>();
  const lastFireAt = new Map<TriggerId, UnixMillis>();
  let started = false;
  let inFlightEnqueues = 0;

  // Refresh re-entry guard: collapse concurrent calls into one in-flight run.
  let refreshPromise: Promise<void> | null = null;
  let pendingRefresh = false;

  const handlers = new Map<TriggerKind, TriggerHandler<TriggerKind>>();

  const fireCallback: TriggerFireCallback = {
    onFire: async (triggerId, context) => {
      // Swallow exceptions so we never throw inside chrome API listeners.
      try {
        await handleFire(triggerId as TriggerId, context);
      } catch (e) {
        logger.error('[TriggerManager] onFire failed:', e);
      }
    },
  };

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
   * Internal fire handler. When `throwOnDrop` is true, cooldown / maxQueued
   * drops are surfaced as errors instead of being silently dropped.
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

    const prevLastFireAt = lastFireAt.get(triggerId);
    if (cooldownMs > 0 && prevLastFireAt !== undefined && t - prevLastFireAt < cooldownMs) {
      logger.debug(`[TriggerManager] Dropping trigger "${triggerId}" (cooldown ${cooldownMs}ms)`);
      if (options?.throwOnDrop) {
        throw new Error(`Trigger "${triggerId}" dropped (cooldown ${cooldownMs}ms)`);
      }
      return null;
    }

    // maxQueued check runs before cooldown is bumped so a maxQueued drop does
    // not also consume the cooldown window.
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

    if (cooldownMs > 0) {
      lastFireAt.set(triggerId, t);
    }

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
      // Roll back the cooldown stamp so a failed enqueue does not silence
      // the next legitimate fire.
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

  async function doRefresh(): Promise<void> {
    const triggers = await deps.storage.triggers.list();
    if (!started) return;

    // Uninstall everything then re-install: simpler and consistent. Failures
    // in one handler do not block the rest.
    for (const handler of handlers.values()) {
      try {
        await handler.uninstallAll();
      } catch (e) {
        logger.warn(`[TriggerManager] Error during uninstallAll for kind "${handler.kind}":`, e);
      }
    }
    installed.clear();

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

  async function start(): Promise<void> {
    if (started) return;
    started = true;
    await refresh();
  }

  async function stop(): Promise<void> {
    if (!started) return;

    started = false;
    pendingRefresh = false;

    if (refreshPromise) {
      try {
        await refreshPromise;
      } catch {
        /* ignore refresh errors during shutdown */
      }
    }

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

  async function dispose(): Promise<void> {
    await stop();
  }

  function getState(): TriggerManagerState {
    return {
      started,
      installedTriggerIds: Array.from(installed.keys()),
    };
  }

  return { start, stop, refresh, fire, dispose, getState };
}
