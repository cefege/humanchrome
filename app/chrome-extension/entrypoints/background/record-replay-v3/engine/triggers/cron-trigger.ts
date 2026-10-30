/**
 * @fileoverview Cron Trigger Handler (P4-07)
 * @description
 * Schedules cron triggers via `chrome.alarms` (MV3).
 *
 * Strategy:
 * - One alarm per trigger (one-shot `when` alarm).
 * - When fired: call `fireCallback.onFire(triggerId)` then compute and schedule next.
 *
 * Timezone:
 * - Accepts IANA timezones (e.g. "UTC", "Asia/Shanghai").
 * - Rust owns grammar, validation, and next-fire search; Date/Intl remains a narrow host observer.
 */

import { runPolicy } from 'humanchrome-shared';

import type { UnixMillis } from '../../domain/json';
import type { TriggerId } from '../../domain/ids';
import type { TriggerSpecByKind } from '../../domain/triggers';
import type { TriggerFireCallback, TriggerHandler, TriggerHandlerFactory } from './trigger-handler';

// ==================== Types ====================

type CronTriggerSpec = TriggerSpecByKind<'cron'>;

/**
 * Function to compute next fire time from cron expression
 */
export type ComputeNextFireAtMs = (input: {
  cron: string;
  timezone?: string;
  fromMs: UnixMillis;
}) => UnixMillis | Promise<UnixMillis>;

export interface CronTriggerHandlerDeps {
  logger?: Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;
  now?: () => UnixMillis;
  computeNextFireAtMs?: ComputeNextFireAtMs;
}

interface InstalledCronTrigger {
  spec: CronTriggerSpec;
  timezone?: string;
  version: number;
}

// ==================== Constants ====================

const ALARM_PREFIX = 'rr_v3_cron_';

// ==================== Utilities ====================

/** Normalizes through the narrow String callback while Rust owns empty/grammar policy. */
function normalizeCronExpression(value: unknown): string {
  return runPolicy.normalizeRunCron(value, (input) => {
    const raw = typeof input === 'string' ? input : String(input ?? '');
    return raw.trim().replace(/\s+/g, ' ');
  });
}

/** Validates through the narrow Intl callback while Rust owns absence/type/error policy. */
function normalizeTimezone(value: unknown): string | undefined {
  return runPolicy.normalizeRunCronTimezone(
    value,
    (timezone) => timezone.trim(),
    (timezone) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0));
        return true;
      } catch {
        return false;
      }
    },
  );
}

/**
 * Generate alarm name for trigger
 */
function alarmNameForTrigger(triggerId: TriggerId): string {
  return `${ALARM_PREFIX}${triggerId}`;
}

/**
 * Parse trigger ID from alarm name
 */
function parseTriggerIdFromAlarmName(name: string): TriggerId | null {
  if (!name.startsWith(ALARM_PREFIX)) return null;
  const id = name.slice(ALARM_PREFIX.length);
  return id ? (id as TriggerId) : null;
}

/**
 * Host Date observation for the local-time branch. Rust owns field matching and search order.
 */
function observeLocalCandidate(
  fromMs: UnixMillis,
  dayOffset: number,
  hour: number,
  minute: number,
): runPolicy.CronClockParts {
  const candidate = new Date(fromMs + 1000);
  candidate.setDate(candidate.getDate() + dayOffset);
  candidate.setHours(hour, minute, 0, 0);
  return {
    timestampMs: candidate.getTime(),
    year: candidate.getFullYear(),
    month: candidate.getMonth() + 1,
    day: candidate.getDate(),
    hour: candidate.getHours(),
    minute: candidate.getMinutes(),
    dayOfWeek: candidate.getDay(),
  };
}

// Cache DateTimeFormat instances per timezone for the narrow Intl observation boundary.
const dtfCache = new Map<string, Intl.DateTimeFormat>();

function getDateTimeFormat(timezone: string): Intl.DateTimeFormat {
  let dtf = dtfCache.get(timezone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    });
    dtfCache.set(timezone, dtf);
  }
  return dtf;
}

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Host Intl observation for the zoned branch; no cron decision lives here. */
function observeZonedParts(utcMs: UnixMillis, timezone: string): runPolicy.CronClockParts {
  const parts = getDateTimeFormat(timezone).formatToParts(new Date(utcMs));
  const map: Record<string, string> = Object.create(null);
  for (const part of parts) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  const rawHour = Number(map.hour);
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: rawHour === 24 ? 0 : rawHour,
    minute: Number(map.minute),
    dayOfWeek: WEEKDAY_MAP[map.weekday] ?? 0,
  };
}

function defaultComputeNextFireAtMs(input: {
  cron: string;
  timezone?: string;
  fromMs: UnixMillis;
}): UnixMillis {
  return input.timezone
    ? runPolicy.nextRunCronZoned(input.cron, input.timezone, input.fromMs, observeZonedParts)
    : runPolicy.nextRunCronLocal(input.cron, input.fromMs, observeLocalCandidate);
}

// ==================== Handler Implementation ====================

/**
 * Create cron trigger handler factory
 */
export function createCronTriggerHandlerFactory(
  deps?: CronTriggerHandlerDeps,
): TriggerHandlerFactory<'cron'> {
  return (fireCallback) => createCronTriggerHandler(fireCallback, deps);
}

/**
 * Create cron trigger handler
 */
export function createCronTriggerHandler(
  fireCallback: TriggerFireCallback,
  deps?: CronTriggerHandlerDeps,
): TriggerHandler<'cron'> {
  const logger = deps?.logger ?? console;
  const now = deps?.now ?? (() => Date.now());
  const computeNextFireAtMs: ComputeNextFireAtMs =
    deps?.computeNextFireAtMs ?? defaultComputeNextFireAtMs;

  const installed = new Map<TriggerId, InstalledCronTrigger>();
  const versions = new Map<TriggerId, number>();
  let listening = false;

  /**
   * Bump version to invalidate pending operations
   */
  function bumpVersion(triggerId: TriggerId): number {
    const next = (versions.get(triggerId) ?? 0) + 1;
    versions.set(triggerId, next);
    return next;
  }

  /**
   * Clear alarm by name
   */
  async function clearAlarmByName(name: string): Promise<void> {
    if (!chrome.alarms?.clear) return;
    try {
      await Promise.resolve(chrome.alarms.clear(name));
    } catch (e) {
      logger.debug('[CronTriggerHandler] alarms.clear failed:', e);
    }
  }

  /**
   * Clear all cron alarms
   */
  async function clearAllCronAlarms(): Promise<void> {
    if (!chrome.alarms?.getAll || !chrome.alarms?.clear) return;
    try {
      const alarms = await Promise.resolve(chrome.alarms.getAll());
      const list = Array.isArray(alarms) ? alarms : [];
      await Promise.all(
        list
          .filter((a) => a?.name && a.name.startsWith(ALARM_PREFIX))
          .map((a) => clearAlarmByName(a.name)),
      );
    } catch (e) {
      logger.debug('[CronTriggerHandler] alarms.getAll failed:', e);
    }
  }

  /**
   * Schedule next alarm for trigger
   */
  async function scheduleNext(triggerId: TriggerId, expectedVersion: number): Promise<void> {
    if (!chrome.alarms?.create) {
      logger.warn('[CronTriggerHandler] chrome.alarms.create is unavailable');
      return;
    }

    const entry = installed.get(triggerId);
    if (!entry || entry.version !== expectedVersion) return;

    const fromMs = now();
    const nextMs = await Promise.resolve(
      computeNextFireAtMs({
        cron: entry.spec.cron,
        timezone: entry.timezone,
        fromMs,
      }),
    );

    // Check version again after async
    if (installed.get(triggerId)?.version !== expectedVersion) return;

    const name = alarmNameForTrigger(triggerId);
    await Promise.resolve(chrome.alarms.create(name, { when: nextMs }));
  }

  /**
   * Handle alarm event
   */
  const onAlarm = (alarm: chrome.alarms.Alarm): void => {
    const triggerId = parseTriggerIdFromAlarmName(alarm?.name ?? '');
    if (!triggerId) return;

    const entry = installed.get(triggerId);
    if (!entry) return;

    const expectedVersion = entry.version;

    void (async () => {
      try {
        await fireCallback.onFire(triggerId, {
          sourceTabId: undefined,
          sourceUrl: undefined,
        });
      } catch (e) {
        logger.error(`[CronTriggerHandler] onFire failed for trigger "${triggerId}":`, e);
      } finally {
        // Reschedule if still valid
        // eslint-disable-next-line no-unsafe-finally
        if (installed.get(triggerId)?.version !== expectedVersion) return;
        try {
          await scheduleNext(triggerId, expectedVersion);
        } catch (e) {
          logger.error(`[CronTriggerHandler] Failed to reschedule trigger "${triggerId}":`, e);
        }
      }
    })();
  };

  function ensureListening(): void {
    if (listening) return;
    if (!chrome.alarms?.onAlarm?.addListener) {
      logger.warn('[CronTriggerHandler] chrome.alarms.onAlarm is unavailable');
      return;
    }
    chrome.alarms.onAlarm.addListener(onAlarm);
    listening = true;
  }

  function stopListening(): void {
    if (!listening) return;
    try {
      chrome.alarms.onAlarm.removeListener(onAlarm);
    } catch (e) {
      logger.debug('[CronTriggerHandler] alarms.onAlarm.removeListener failed:', e);
    } finally {
      listening = false;
    }
  }

  return {
    kind: 'cron',

    async install(trigger: CronTriggerSpec): Promise<void> {
      const cron = normalizeCronExpression(trigger.cron);
      const timezone = normalizeTimezone(trigger.timezone);

      const version = bumpVersion(trigger.id);
      installed.set(trigger.id, {
        spec: { ...trigger, cron },
        timezone,
        version,
      });

      ensureListening();
      await scheduleNext(trigger.id, version);
    },

    async uninstall(triggerId: string): Promise<void> {
      const id = triggerId as TriggerId;
      bumpVersion(id);
      installed.delete(id);
      await clearAlarmByName(alarmNameForTrigger(id));

      if (installed.size === 0) {
        stopListening();
      }
    },

    async uninstallAll(): Promise<void> {
      for (const id of installed.keys()) bumpVersion(id);
      installed.clear();
      await clearAllCronAlarms();
      stopListening();
    },

    getInstalledIds(): string[] {
      return Array.from(installed.keys());
    },
  };
}
