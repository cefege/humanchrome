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

import { runPolicy } from 'humanchrome-shared';

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


export function createTriggerManager(deps: TriggerManagerDeps): TriggerManager {
  const logger = deps.logger ?? console;
  const now = deps.now ?? (() => Date.now());

  const admission = new runPolicy.RustTriggerAdmissionState(deps.storm);

  // The host retains trigger specs only to construct enqueue effects. Rust owns eligibility.
  const installed = new Map<TriggerId, TriggerSpec>();
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
    const t = now();
    const queuedCount =
      admission.isStarted() && admission.hasQueueCap()
        ? (await deps.storage.queue.list('queued')).length
        : 0;
    const decision = admission.admit(triggerId, t, queuedCount);
    if (decision.kind === 'drop') {
      logger.debug(`[TriggerManager] ${decision.message}`);
      if (options?.throwOnDrop) {
        throw new Error(decision.message);
      }
      return null;
    }

    const trigger = installed.get(triggerId);
    if (!trigger) {
      admission.finish(decision.ticket, false);
      throw new Error(`Trigger "${triggerId}" is not installed`);
    }
    const triggerContext: TriggerFireContext = {
      triggerId: trigger.id,
      kind: trigger.kind,
      firedAt: t,
      sourceTabId: context.sourceTabId,
      sourceUrl: context.sourceUrl,
    };

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
      admission.finish(decision.ticket, true);
      return result;
    } catch (e) {
      admission.finish(decision.ticket, false);
      const msg = e instanceof Error ? e.message : String(e);
      logger.error(`[TriggerManager] enqueueRun failed for trigger "${triggerId}":`, e);
      if (options?.throwOnDrop) {
        throw new Error(`enqueueRun failed for trigger "${triggerId}": ${msg}`);
      }
      return null;
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
    if (!admission.isStarted()) return;

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
    admission.clearInstalled();

    for (const trigger of triggers) {
      if (!admission.isStarted()) return;
      if (!trigger.enabled) continue;

      const handler = handlers.get(trigger.kind);
      if (!handler) {
        logger.warn(`[TriggerManager] No handler registered for kind "${trigger.kind}"`);
        continue;
      }

      try {
        await handler.install(trigger as Parameters<typeof handler.install>[0]);
        installed.set(trigger.id, trigger);
        admission.install(trigger.id);
      } catch (e) {
        logger.error(`[TriggerManager] Failed to install trigger "${trigger.id}":`, e);
      }
    }
  }

  async function refresh(): Promise<void> {
    if (!admission.isStarted()) {
      throw new Error('TriggerManager is not started');
    }

    pendingRefresh = true;
    if (!refreshPromise) {
      refreshPromise = (async () => {
        while (admission.isStarted() && pendingRefresh) {
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
    if (admission.isStarted()) return;
    admission.start();
    await refresh();
  }

  async function stop(): Promise<void> {
    if (!admission.isStarted()) return;

    admission.stop();
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
  }

  async function dispose(): Promise<void> {
    await stop();
  }

  function getState(): TriggerManagerState {
    return {
      started: admission.isStarted(),
      installedTriggerIds: admission.installedIds() as TriggerId[],
    };
  }

  return { start, stop, refresh, fire, dispose, getState };
}
