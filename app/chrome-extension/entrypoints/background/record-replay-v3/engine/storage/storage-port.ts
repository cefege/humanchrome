import type { FlowId, RunId, TriggerId } from '../../domain/ids';
import type { FlowV3 } from '../../domain/flow';
import type { RunEvent, RunEventInput, RunRecordV3 } from '../../domain/events';
import type { PersistentVarRecord, PersistentVariableName } from '../../domain/variables';
import type { TriggerSpec } from '../../domain/triggers';
import type { RunQueue } from '../queue/queue';

export interface FlowsStore {
  list(): Promise<FlowV3[]>;
  get(id: FlowId): Promise<FlowV3 | null>;
  save(flow: FlowV3): Promise<void>;
  delete(id: FlowId): Promise<void>;
}

export interface RunsStore {
  list(): Promise<RunRecordV3[]>;
  get(id: RunId): Promise<RunRecordV3 | null>;
  save(record: RunRecordV3): Promise<void>;
  patch(id: RunId, patch: Partial<RunRecordV3>): Promise<void>;
}

export interface EventsStore {
  /**
   * Append an event with atomic seq assignment.
   * Single transaction: read RunRecordV3.nextSeq -> write event -> bump nextSeq.
   * Returns the full event (with assigned seq and ts).
   */
  append(event: RunEventInput): Promise<RunEvent>;

  list(runId: RunId, opts?: { fromSeq?: number; limit?: number }): Promise<RunEvent[]>;
}

export interface PersistentVarsStore {
  get(key: PersistentVariableName): Promise<PersistentVarRecord | undefined>;
  set(
    key: PersistentVariableName,
    value: PersistentVarRecord['value'],
  ): Promise<PersistentVarRecord>;
  delete(key: PersistentVariableName): Promise<void>;
  list(prefix?: PersistentVariableName): Promise<PersistentVarRecord[]>;
}

export interface TriggersStore {
  list(): Promise<TriggerSpec[]>;
  get(id: TriggerId): Promise<TriggerSpec | null>;
  save(spec: TriggerSpec): Promise<void>;
  delete(id: TriggerId): Promise<void>;
}

export interface StoragePort {
  flows: FlowsStore;
  runs: RunsStore;
  events: EventsStore;
  queue: RunQueue;
  persistentVars: PersistentVarsStore;
  triggers: TriggersStore;
}

function createNotImplementedStore<T extends object>(name: string): T {
  const target = {} as T;
  return new Proxy(target, {
    get(_, prop) {
      // Returning undefined for 'then' avoids accidental thenable behavior.
      if (prop === 'then') {
        return undefined;
      }
      return async () => {
        throw new Error(`${name}.${String(prop)} not implemented`);
      };
    },
  });
}

export function createNotImplementedStoragePort(): StoragePort {
  return {
    flows: createNotImplementedStore<FlowsStore>('FlowsStore'),
    runs: createNotImplementedStore<RunsStore>('RunsStore'),
    events: createNotImplementedStore<EventsStore>('EventsStore'),
    queue: createNotImplementedStore<RunQueue>('RunQueue'),
    persistentVars: createNotImplementedStore<PersistentVarsStore>('PersistentVarsStore'),
    triggers: createNotImplementedStore<TriggersStore>('TriggersStore'),
  };
}
