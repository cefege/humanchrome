import type { NodeKind } from '../../domain/flow';
import type { TriggerKind } from '../../domain/triggers';
import { RR_ERROR_CODES, createRRError } from '../../domain/errors';
import type {
  NodeDefinition,
  TriggerDefinition,
  PluginRegistrationContext,
  RRPlugin,
} from './types';

export class PluginRegistry implements PluginRegistrationContext {
  private nodes = new Map<NodeKind, NodeDefinition>();
  private triggers = new Map<TriggerKind, TriggerDefinition>();

  /** Overwrites any existing definition with the same kind. */
  registerNode(def: NodeDefinition): void {
    this.nodes.set(def.kind, def);
  }

  /** Overwrites any existing definition with the same kind. */
  registerTrigger(def: TriggerDefinition): void {
    this.triggers.set(def.kind, def);
  }

  getNode(kind: NodeKind): NodeDefinition | undefined {
    return this.nodes.get(kind);
  }

  /** @throws RRError when the node kind is not registered. */
  getNodeOrThrow(kind: NodeKind): NodeDefinition {
    const def = this.nodes.get(kind);
    if (!def) {
      throw createRRError(RR_ERROR_CODES.UNSUPPORTED_NODE, `Node kind "${kind}" is not registered`);
    }
    return def;
  }

  getTrigger(kind: TriggerKind): TriggerDefinition | undefined {
    return this.triggers.get(kind);
  }

  /** @throws RRError when the trigger kind is not registered. */
  getTriggerOrThrow(kind: TriggerKind): TriggerDefinition {
    const def = this.triggers.get(kind);
    if (!def) {
      throw createRRError(
        RR_ERROR_CODES.UNSUPPORTED_NODE,
        `Trigger kind "${kind}" is not registered`,
      );
    }
    return def;
  }

  hasNode(kind: NodeKind): boolean {
    return this.nodes.has(kind);
  }

  hasTrigger(kind: TriggerKind): boolean {
    return this.triggers.has(kind);
  }

  listNodeKinds(): NodeKind[] {
    return Array.from(this.nodes.keys());
  }

  listTriggerKinds(): TriggerKind[] {
    return Array.from(this.triggers.keys());
  }

  registerPlugin(plugin: RRPlugin): void {
    plugin.register(this);
  }

  registerPlugins(plugins: RRPlugin[]): void {
    for (const plugin of plugins) {
      this.registerPlugin(plugin);
    }
  }

  /** Clear all registrations — primarily used by tests. */
  clear(): void {
    this.nodes.clear();
    this.triggers.clear();
  }
}

let globalRegistry: PluginRegistry | null = null;

export function getPluginRegistry(): PluginRegistry {
  if (!globalRegistry) {
    globalRegistry = new PluginRegistry();
  }
  return globalRegistry;
}

/** Reset the global registry — primarily used by tests. */
export function resetPluginRegistry(): void {
  globalRegistry = null;
}
