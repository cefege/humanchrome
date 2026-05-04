import type { NodeId, RunId } from '../../domain/ids';
import type { Breakpoint, DebuggerState } from '../../domain/debug';

export class BreakpointManager {
  private breakpoints = new Map<NodeId, Breakpoint>();
  private stepMode: 'none' | 'stepOver' = 'none';

  constructor(initialBreakpoints?: NodeId[]) {
    if (initialBreakpoints) {
      for (const nodeId of initialBreakpoints) {
        this.add(nodeId);
      }
    }
  }

  add(nodeId: NodeId): void {
    this.breakpoints.set(nodeId, { nodeId, enabled: true });
  }

  remove(nodeId: NodeId): void {
    this.breakpoints.delete(nodeId);
  }

  /** Replace all breakpoints with the given list. */
  setAll(nodeIds: NodeId[]): void {
    this.breakpoints.clear();
    for (const nodeId of nodeIds) {
      this.add(nodeId);
    }
  }

  enable(nodeId: NodeId): void {
    const bp = this.breakpoints.get(nodeId);
    if (bp) {
      bp.enabled = true;
    }
  }

  disable(nodeId: NodeId): void {
    const bp = this.breakpoints.get(nodeId);
    if (bp) {
      bp.enabled = false;
    }
  }

  hasBreakpoint(nodeId: NodeId): boolean {
    const bp = this.breakpoints.get(nodeId);
    return bp?.enabled ?? false;
  }

  /** Pause when the node has a breakpoint or step-over is active. */
  shouldPauseAt(nodeId: NodeId): boolean {
    if (this.stepMode === 'stepOver') {
      return true;
    }
    return this.hasBreakpoint(nodeId);
  }

  getAll(): Breakpoint[] {
    return Array.from(this.breakpoints.values());
  }

  getEnabled(): Breakpoint[] {
    return this.getAll().filter((bp) => bp.enabled);
  }

  setStepMode(mode: 'none' | 'stepOver'): void {
    this.stepMode = mode;
  }

  getStepMode(): 'none' | 'stepOver' {
    return this.stepMode;
  }

  clear(): void {
    this.breakpoints.clear();
    this.stepMode = 'none';
  }
}

export class BreakpointRegistry {
  private managers = new Map<RunId, BreakpointManager>();

  getOrCreate(runId: RunId, initialBreakpoints?: NodeId[]): BreakpointManager {
    let manager = this.managers.get(runId);
    if (!manager) {
      manager = new BreakpointManager(initialBreakpoints);
      this.managers.set(runId, manager);
    }
    return manager;
  }

  get(runId: RunId): BreakpointManager | undefined {
    return this.managers.get(runId);
  }

  remove(runId: RunId): void {
    this.managers.delete(runId);
  }

  clear(): void {
    this.managers.clear();
  }
}

let globalBreakpointRegistry: BreakpointRegistry | null = null;

export function getBreakpointRegistry(): BreakpointRegistry {
  if (!globalBreakpointRegistry) {
    globalBreakpointRegistry = new BreakpointRegistry();
  }
  return globalBreakpointRegistry;
}

/** Reset the global registry — primarily used by tests. */
export function resetBreakpointRegistry(): void {
  globalBreakpointRegistry = null;
}
