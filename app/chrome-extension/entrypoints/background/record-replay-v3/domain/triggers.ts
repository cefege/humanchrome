import type { JsonObject, UnixMillis } from './json';
import type { FlowId, TriggerId } from './ids';

export type TriggerKind =
  | 'manual'
  | 'url'
  | 'cron'
  | 'interval'
  | 'once'
  | 'command'
  | 'contextMenu'
  | 'dom';

export interface TriggerSpecBase {
  id: TriggerId;
  kind: TriggerKind;
  enabled: boolean;
  flowId: FlowId;
  /** Args passed to the Flow when triggered. */
  args?: JsonObject;
}

export interface UrlMatchRule {
  kind: 'url' | 'domain' | 'path';
  value: string;
}

export type TriggerSpec =
  | (TriggerSpecBase & { kind: 'manual' })
  | (TriggerSpecBase & {
      kind: 'url';
      match: UrlMatchRule[];
    })
  | (TriggerSpecBase & {
      kind: 'cron';
      cron: string;
      timezone?: string;
    })
  | (TriggerSpecBase & {
      kind: 'interval';
      /** Interval in minutes; minimum 1. */
      periodMinutes: number;
    })
  | (TriggerSpecBase & {
      kind: 'once';
      /** Fires once at this Unix-millis timestamp, then auto-disables. */
      whenMs: UnixMillis;
    })
  | (TriggerSpecBase & {
      kind: 'command';
      commandKey: string;
    })
  | (TriggerSpecBase & {
      kind: 'contextMenu';
      title: string;
      contexts?: ReadonlyArray<string>;
    })
  | (TriggerSpecBase & {
      kind: 'dom';
      selector: string;
      appear?: boolean;
      once?: boolean;
      debounceMs?: UnixMillis;
    });

export interface TriggerFireContext {
  triggerId: TriggerId;
  kind: TriggerKind;
  firedAt: UnixMillis;
  sourceTabId?: number;
  sourceUrl?: string;
}

export type TriggerSpecByKind<K extends TriggerKind> = Extract<TriggerSpec, { kind: K }>;

export function isTriggerEnabled(trigger: TriggerSpec): boolean {
  return trigger.enabled;
}

export function createTriggerFireContext(
  trigger: TriggerSpec,
  options?: { sourceTabId?: number; sourceUrl?: string },
): TriggerFireContext {
  return {
    triggerId: trigger.id,
    kind: trigger.kind,
    firedAt: Date.now(),
    sourceTabId: options?.sourceTabId,
    sourceUrl: options?.sourceUrl,
  };
}
