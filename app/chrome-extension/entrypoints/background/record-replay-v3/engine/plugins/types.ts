import { z } from 'zod';

import type { JsonObject, JsonValue } from '../../domain/json';
import type { FlowId, NodeId, RunId, TriggerId } from '../../domain/ids';
import type { NodeKind } from '../../domain/flow';
import type { RRError } from '../../domain/errors';
import type { NodePolicy } from '../../domain/policy';
import type { FlowV3, NodeV3 } from '../../domain/flow';
import type { TriggerKind } from '../../domain/triggers';

export type Schema<T> = z.ZodType<T>;

export interface NodeExecutionContext {
  runId: RunId;
  /** Snapshot of the Flow definition. */
  flow: FlowV3;
  nodeId: NodeId;

  /** Bound Tab ID — each Run owns its tab exclusively. */
  tabId: number;
  /** Defaults to 0 (the main frame). */
  frameId?: number;

  vars: Record<string, JsonValue>;

  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: JsonValue) => void;

  /** Select the next edge label — used by conditional branch nodes. */
  chooseNext: (label: string) => { kind: 'edgeLabel'; label: string };

  artifacts: {
    screenshot: () => Promise<{ ok: true; base64: string } | { ok: false; error: RRError }>;
  };

  persistent: {
    get: (name: `$${string}`) => Promise<JsonValue | undefined>;
    set: (name: `$${string}`, value: JsonValue) => Promise<void>;
    delete: (name: `$${string}`) => Promise<void>;
  };
}

export interface VarsPatchOp {
  op: 'set' | 'delete';
  name: string;
  value?: JsonValue;
}

export type NodeExecutionResult =
  | {
      status: 'succeeded';
      next?: { kind: 'edgeLabel'; label: string } | { kind: 'end' };
      outputs?: JsonObject;
      varsPatch?: VarsPatchOp[];
    }
  | { status: 'failed'; error: RRError };

export interface NodeDefinition<
  TKind extends NodeKind = NodeKind,
  TConfig extends JsonObject = JsonObject,
> {
  kind: TKind;
  schema: Schema<TConfig>;
  defaultPolicy?: NodePolicy;
  execute(
    ctx: NodeExecutionContext,
    node: NodeV3 & { kind: TKind; config: TConfig },
  ): Promise<NodeExecutionResult>;
}

export interface TriggerInstallContext<
  TKind extends TriggerKind = TriggerKind,
  TConfig extends JsonObject = JsonObject,
> {
  triggerId: TriggerId;
  kind: TKind;
  enabled: boolean;
  flowId: FlowId;
  config: TConfig;
  /** Args passed to the Flow when triggered. */
  args?: JsonObject;
}

export interface TriggerDefinition<
  TKind extends TriggerKind = TriggerKind,
  TConfig extends JsonObject = JsonObject,
> {
  kind: TKind;
  schema: Schema<TConfig>;
  install(ctx: TriggerInstallContext<TKind, TConfig>): Promise<void> | void;
  uninstall(ctx: TriggerInstallContext<TKind, TConfig>): Promise<void> | void;
}

export interface PluginRegistrationContext {
  registerNode(def: NodeDefinition): void;
  registerTrigger(def: TriggerDefinition): void;
}

export interface RRPlugin {
  name: string;
  register(ctx: PluginRegistrationContext): void;
}
