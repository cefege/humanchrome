import type { Flow, NodeBase, Step, VariableDef } from '../types';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { mapStepToNodeConfig, replayPolicy, stepsToDAG } from 'humanchrome-shared';
import { getCurrentRequestContext } from '../../utils/request-context';

/**
 * Recording status state machine:
 * - idle: No active recording
 * - recording: Actively capturing user interactions
 * - paused: Temporarily paused (UI can resume)
 * - stopping: Draining final steps from content scripts before save
 */
export type RecordingStatus = 'idle' | 'recording' | 'paused' | 'stopping';

export interface RecordingSessionState {
  sessionId: string;
  status: RecordingStatus;
  originTabId: number | null;
  flow: Flow | null;
  // Track tabs that have participated in this recording session
  activeTabs: Set<number>;
  // Track which tabs have acknowledged stop command
  stoppedTabs: Set<number>;
}


export class RecordingSessionManager {
  private state: RecordingSessionState = {
    sessionId: '',
    status: 'idle',
    originTabId: null,
    flow: null,
    activeTabs: new Set<number>(),
    stoppedTabs: new Set<number>(),
  };

  // Session-level cache for incremental DAG sync (cleared on session start/stop)
  // Note: stepIndexMap removed - we no longer write to flow.steps
  private nodeIndexMap: Map<string, number> = new Map();
  // Monotonic counter for edge id generation (avoids collision on delete/reorder)
  private edgeSeq: number = 0;

  getStatus(): RecordingStatus {
    return this.state.status;
  }

  getSession(): Readonly<RecordingSessionState> {
    return this.state;
  }

  getFlow(): Flow | null {
    return this.state.flow;
  }

  getOriginTabId(): number | null {
    return this.state.originTabId;
  }

  addActiveTab(tabId: number): void {
    if (typeof tabId === 'number') this.state.activeTabs.add(tabId);
  }

  removeActiveTab(tabId: number): void {
    this.state.activeTabs.delete(tabId);
  }

  getActiveTabs(): number[] {
    return Array.from(this.state.activeTabs);
  }

  async startSession(flow: Flow, originTabId: number): Promise<void> {
    // Clear cache for fresh session
    this.nodeIndexMap.clear();
    this.edgeSeq = 0;

    this.state = {
      sessionId: `sess_${Date.now()}`,
      status: 'recording',
      originTabId,
      flow,
      activeTabs: new Set<number>([originTabId]),
      stoppedTabs: new Set<number>(),
    };

    // Initialize caches from existing flow data (supports resume scenarios)
    this.rebuildCaches();
  }

  /**
   * Transition to stopping state. Content scripts can still send final steps.
   * Returns the sessionId for barrier verification.
   */
  beginStopping(): string {
    if (this.state.status === 'idle') return '';
    this.state.status = 'stopping';
    this.state.stoppedTabs.clear();
    return this.state.sessionId;
  }

  /**
   * Mark a tab as having acknowledged the stop command.
   * Returns true if all active tabs have stopped.
   */
  markTabStopped(tabId: number): boolean {
    this.state.stoppedTabs.add(tabId);
    // Check if all active tabs have acknowledged
    for (const activeTabId of this.state.activeTabs) {
      if (!this.state.stoppedTabs.has(activeTabId)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Check if we're in stopping state (still accepting final steps).
   */
  isStopping(): boolean {
    return this.state.status === 'stopping';
  }

  /**
   * Check if we can accept steps (recording or stopping).
   */
  canAcceptSteps(): boolean {
    return this.state.status === 'recording' || this.state.status === 'stopping';
  }

  /**
   * Transition to paused state.
   */
  pause(): void {
    if (this.state.status === 'recording') {
      this.state.status = 'paused';
    }
  }

  /**
   * Resume from paused state.
   */
  resume(): void {
    if (this.state.status === 'paused') {
      this.state.status = 'recording';
    }
  }

  /**
   * Finalize stop and clear session state.
   */
  async stopSession(): Promise<Flow | null> {
    const flow = this.state.flow;
    this.state.status = 'idle';
    this.state.flow = null;
    this.state.originTabId = null;
    this.state.activeTabs.clear();
    this.state.stoppedTabs.clear();
    // Clear cache
    this.nodeIndexMap.clear();
    this.edgeSeq = 0;
    return flow;
  }

  updateFlow(mutator: (f: Flow) => void): void {
    const f = this.state.flow;
    if (!f) return;
    mutator(f);
    try {
      (f.meta as any).updatedAt = new Date().toISOString();
    } catch (e) {
      // ignore meta update errors
    }
  }

  /**
   * Append or upsert steps to the flow with incremental DAG sync.
   * Uses upsert semantics: if a step with the same id exists, update it in place.
   * This ensures fill steps get their final value even after initial flush.
   *
   * DAG sync: maintains flow.nodes/edges during recording.
   * - New step → create node + edge from previous node
   * - Upsert step → update node.config and node.type
   * - Invariant violation → fallback to linear DAG rebuild
   *
   * Note: flow.steps is no longer written. Nodes are the source of truth.
   */
  appendSteps(steps: Step[]): void {
    const f = this.state.flow;
    if (!f || !Array.isArray(steps) || steps.length === 0) return;

    if (!Array.isArray(f.nodes)) f.nodes = [];
    if (!Array.isArray(f.edges)) f.edges = [];
    if (f.nodes.length === 0 && Array.isArray(f.steps) && f.steps.length > 0) {
      this.rebuildDagFromSteps();
    }

    for (const step of steps) {
      if (!step.id) {
        step.id = `step_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      }
    }

    const nodes = f.nodes;
    const edges = f.edges;
    const plan = replayPolicy.replayRecordingAppendPlan({
      nodes: nodes.map(({ id }) => ({ id })),
      edges: edges.map(({ to }) => ({ to })),
      cache: Array.from(this.nodeIndexMap.entries()),
      edgeSeq: this.edgeSeq,
      steps: steps.map(({ id, type }) => ({ id, type })),
    });
    const replaceEdges = (planned: readonly replayPolicy.RecordingEdgePlan[]) => {
      edges.splice(
        0,
        edges.length,
        ...planned.map((edge) => ({ ...edge })),
      );
    };
    if (plan.rechainBefore) replaceEdges(plan.rechainBefore);

    for (const operation of plan.operations) {
      const step = steps[operation.stepIndex];
      if (!step || operation.kind === 'skip') continue;
      if (operation.fallbackType) {
        console.warn(
          `[RecordingSession] Unknown step type "${step.type}", falling back to "script"`,
        );
      }
      if (operation.kind === 'update') {
        const node = nodes[operation.nodeIndex];
        if (!node) continue;
        nodes[operation.nodeIndex] = {
          ...node,
          type: operation.nodeType as NodeBase['type'],
          config: mapStepToNodeConfig(step),
        };
        continue;
      }
      nodes.push({
        id: step.id,
        type: operation.nodeType as NodeBase['type'],
        config: mapStepToNodeConfig(step),
      });
      if (operation.edge) edges.push({ ...operation.edge });
    }
    if (plan.rechainAfter) replaceEdges(plan.rechainAfter);

    this.nodeIndexMap.clear();
    for (const [id, index] of plan.cache.nodeIndexes) this.nodeIndexMap.set(id, index);
    this.edgeSeq = plan.cache.edgeSeq;

    try {
      if (f.meta) f.meta.updatedAt = new Date().toISOString();
    } catch {
      // ignore meta update errors
    }
    this.broadcastTimelineUpdate();
  }


  /**
   * Rebuild caches from current flow state.
   * Called on session start and after DAG rebuild.
   */
  private rebuildCaches(): void {
    const f = this.state.flow;
    if (!f) return;
    const cache = replayPolicy.replayRecordingCachePlan(
      Array.isArray(f.nodes) ? f.nodes.map(({ id }) => ({ id })) : [],
      Array.isArray(f.edges) ? f.edges.length : 0,
    );
    this.nodeIndexMap.clear();
    for (const [id, index] of cache.nodeIndexes) this.nodeIndexMap.set(id, index);
    this.edgeSeq = cache.edgeSeq;
  }

  /**
   * Full DAG rebuild from legacy steps.
   * Used when flow only has steps[] but no nodes[].
   */
  private rebuildDagFromSteps(): void {
    const f = this.state.flow;
    if (!f || !Array.isArray(f.steps) || f.steps.length === 0) return;

    const dag = stepsToDAG(f.steps);

    // Clear and repopulate nodes
    if (!Array.isArray(f.nodes)) f.nodes = [];
    f.nodes.length = 0;
    for (const n of dag.nodes) {
      const typePlan = replayPolicy.replayRecordingNodeTypePlan(n.type);
      if (typePlan.fallbackType) {
        console.warn(`[RecordingSession] Unknown step type "${n.type}", falling back to "script"`);
      }
      f.nodes.push({
        id: n.id,
        type: typePlan.nodeType as NodeBase['type'],
        config: n.config,
      });
    }

    // Clear and repopulate edges
    if (!Array.isArray(f.edges)) f.edges = [];
    f.edges.length = 0;
    for (const e of dag.edges) {
      f.edges.push({
        id: e.id,
        from: e.from,
        to: e.to,
        label: e.label,
      });
    }

    // Rebuild caches
    this.rebuildCaches();
  }


  /**
   * Append variables to the flow. Deduplicates by key.
   */
  appendVariables(variables: VariableDef[]): void {
    const f = this.state.flow;
    if (!f || !Array.isArray(variables) || variables.length === 0) return;

    if (!f.variables) {
      f.variables = [];
    }

    const operations = replayPolicy.replayRecordingVariableAppendPlan(
      f.variables.map((variable) => variable.key),
      variables.map((variable) => variable.key),
    );
    for (const operation of operations) {
      f.variables[operation.targetIndex] = variables[operation.sourceIndex];
    }

    // Update meta timestamp
    try {
      if (f.meta) {
        f.meta.updatedAt = new Date().toISOString();
      }
    } catch {
      // ignore meta update errors
    }
  }

  /**
   * Derive timeline steps from nodes for UI broadcast.
   * This keeps protocol compatibility with recorder.js without storing steps.
   */
  private getTimelineSteps(): Step[] {
    const f = this.state.flow;
    if (!f) return [];

    // Primary: derive from nodes
    if (Array.isArray(f.nodes) && f.nodes.length > 0) {
      return f.nodes.map((n) => {
        const cfg =
          n && typeof n.config === 'object' && n.config != null
            ? (n.config as Record<string, unknown>)
            : {};
        // Important: id and type must override any values in config
        // (config may contain 'type' for trigger nodes, etc.)
        return { ...cfg, id: n.id, type: n.type } as Step;
      });
    }

    // Legacy fallback: use steps if no nodes (shouldn't happen in normal recording)
    if (Array.isArray(f.steps) && f.steps.length > 0) {
      return f.steps;
    }

    return [];
  }

  // Broadcast timeline updates to relevant tabs (top-frame only)
  broadcastTimelineUpdate(): void {
    try {
      // Derive steps from nodes for UI consumption (protocol unchanged)
      const fullSteps = this.getTimelineSteps();
      if (fullSteps.length === 0) return;

      // Prefer broadcasting to all tabs that participated in this session, so timeline
      // stays consistent when user switches across tabs/windows during a single session.
      const targets = this.getActiveTabs();
      const list =
        targets && targets.length
          ? targets
          : this.state.originTabId != null
            ? [this.state.originTabId]
            : [];
      for (const tabId of list) {
        chrome.tabs.sendMessage(
          tabId,
          { action: TOOL_MESSAGE_TYPES.RR_TIMELINE_UPDATE, steps: fullSteps },
          { frameId: 0 },
        );
      }
    } catch {}
  }
}

// =============================================================================
// IMP-0165: per-client recording sessions (was: single module-scope singleton)
//
// Two MCP clients can now each have their own RecordingSessionManager — calls
// from client A's request context don't see/clobber client B's session. A
// Proxy at the module boundary keeps the existing `recordingSession` import
// surface unchanged (~14 callsites in recorder-manager + flow-builder +
// record-replay/index.ts), so the de-singleton is invisible to callers.
//
// Routing uses `getCurrentRequestContext()?.clientId`. Contexts without a
// request (content-script step messages, tab event handlers, the v2
// recorder-manager bootstrap) fall back to the `__system` bucket — which
// means a single client's recorder still works exactly as before for any
// legacy caller. Multi-client isolation only kicks in when the calling
// code actually has a different clientId on the context stack.
//
// Per-tab exclusivity (one tab can host at most one active recording even
// across clients) is NOT enforced in this PR — a follow-up IMP can add the
// `RECORDING_IN_PROGRESS` error if two clients try to record the same tab.
// Today: two clients recording the same tab would both send start/stop
// messages to the content script, which is undefined behavior we'd rather
// catch than tolerate, but the PR scope is "de-singleton, don't regress."
// =============================================================================

const SYSTEM_CLIENT = '__system';
const sessions = new Map<string, RecordingSessionManager>();

function currentClientId(): string {
  return getCurrentRequestContext()?.clientId ?? SYSTEM_CLIENT;
}

export function getRecordingSessionForClient(clientId?: string): RecordingSessionManager {
  const key = clientId ?? currentClientId();
  let s = sessions.get(key);
  if (!s) {
    s = new RecordingSessionManager();
    sessions.set(key, s);
  }
  return s;
}

/** Test-only — drop every per-client manager so each test starts fresh. */
export function _resetRecordingSessionsForTest(): void {
  sessions.clear();
}

/**
 * Test-only — enumerate every (clientId, sessionId, status) triple so
 * isolation tests can assert "client A's session is recording, B's is idle"
 * without poking at internals.
 */
export function _listRecordingSessionsForTest(): Array<{
  clientId: string;
  sessionId: string;
  status: RecordingStatus;
}> {
  const out: Array<{ clientId: string; sessionId: string; status: RecordingStatus }> = [];
  for (const [clientId, mgr] of sessions) {
    const session = mgr.getSession();
    out.push({ clientId, sessionId: session.sessionId, status: mgr.getStatus() });
  }
  return out;
}

/**
 * Back-compat singleton handle. Every property access routes to the
 * per-client manager resolved by the current request context. Existing
 * callers (`recorder-manager.ts`, `flow-builder.ts`, `record-replay/index.ts`)
 * see the same shape they always did — they just operate on the right
 * client's state automatically.
 */
export const recordingSession = new Proxy({} as RecordingSessionManager, {
  get(_target, prop: keyof RecordingSessionManager) {
    const target = getRecordingSessionForClient();
    const value = target[prop];
    // ESLint bans the bare `Function` type — use the precise call
    // signature so `this` binds correctly for any method.
    return typeof value === 'function'
      ? (value as (...args: unknown[]) => unknown).bind(target)
      : value;
  },
  has(_target, prop: PropertyKey) {
    return prop in getRecordingSessionForClient();
  },
});
