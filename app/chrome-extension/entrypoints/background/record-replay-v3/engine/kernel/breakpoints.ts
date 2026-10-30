import { runPolicy } from 'humanchrome-shared';
import type { NodeId, RunId } from '../../domain/ids';
import type { Breakpoint } from '../../domain/debug';

/** Synchronous host facade over the Rust-owned breakpoint state for one active run. */
export class BreakpointManager {
  private readonly state: runPolicy.RustRunBreakpointState;

  constructor(initialBreakpoints?: NodeId[]) {
    this.state = new runPolicy.RustRunBreakpointState(initialBreakpoints);
  }

  add(nodeId: NodeId): void {
    this.state.add(nodeId);
  }

  remove(nodeId: NodeId): void {
    this.state.remove(nodeId);
  }

  /** Replace all breakpoints with the given list. */
  setAll(nodeIds: NodeId[]): void {
    this.state.setAll(nodeIds);
  }

  enable(nodeId: NodeId): void {
    this.state.enable(nodeId);
  }

  disable(nodeId: NodeId): void {
    this.state.disable(nodeId);
  }

  hasBreakpoint(nodeId: NodeId): boolean {
    return this.state.hasBreakpoint(nodeId);
  }

  /** Pause when the node has a breakpoint or step-over is active. */
  shouldPauseAt(nodeId: NodeId): boolean {
    return this.state.shouldPauseAt(nodeId);
  }

  getAll(): Breakpoint[] {
    return this.state.getAll();
  }

  getEnabled(): Breakpoint[] {
    return this.state.getEnabled();
  }

  setStepMode(mode: 'none' | 'stepOver'): void {
    this.state.setStepMode(mode);
  }

  getStepMode(): 'none' | 'stepOver' {
    return this.state.getStepMode();
  }

  clear(): void {
    this.state.clear();
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
