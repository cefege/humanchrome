// subflow-runner.ts — execute a subflow (nodes/edges) using DAG traversal with branch support

import {
  legacyDefaultSuccessorEdgeIndex,
  legacyExecutionPlan,
  legacyLabeledEdgeIndex,
  legacyNextEdgeIndex,
  STEP_TYPES,
} from 'humanchrome-shared';
import type { ExecCtx } from '../../nodes';
import { RunLogger } from '../logging/run-logger';
import { PluginManager } from '../plugins/manager';
import { mapDagNodeToStep } from '../../rr-utils';
import type { Edge, NodeBase, Step } from '../../types';
import { StepRunner } from './step-runner';
import { ENGINE_CONSTANTS } from '../constants';

export interface SubflowEnv {
  runId: string;
  flow: any;
  vars: Record<string, any>;
  logger: RunLogger;
  pluginManager: PluginManager;
  stepRunner: StepRunner;
}

export class SubflowRunner {
  constructor(private env: SubflowEnv) {}

  async runSubflowById(subflowId: string, ctx: ExecCtx, pausedRef: () => boolean): Promise<void> {
    const sub = (this.env.flow.subflows || {})[subflowId];
    if (!sub || !Array.isArray(sub.nodes) || sub.nodes.length === 0) return;

    try {
      await this.env.pluginManager.subflowStart({
        runId: this.env.runId,
        flow: this.env.flow,
        vars: this.env.vars,
        subflowId,
      });
    } catch (e: any) {
      this.env.logger.push({
        stepId: `subflow:${subflowId}`,
        status: 'warning',
        message: `plugin.subflowStart error: ${e?.message || String(e)}`,
      });
    }

    const sNodes: NodeBase[] = sub.nodes;
    const sEdges: Edge[] = sub.edges || [];

    const id2node = new Map(sNodes.map((node) => [node.id, node] as const));
    const graphPlan = legacyExecutionPlan(sNodes, sEdges);
    let currentId: string | undefined =
      graphPlan.startNodeIndex === null ? undefined : sNodes[graphPlan.startNodeIndex]?.id;
    let guard = 0;
    const maxIterations = ENGINE_CONSTANTS.MAX_ITERATIONS;

    const ok = (s: Step) => this.env.logger.overlayAppend(`✔ ${s.type} (${s.id})`);
    const fail = (s: Step, e: any) =>
      this.env.logger.overlayAppend(`✘ ${s.type} (${s.id}) -> ${e?.message || String(e)}`);

    while (currentId) {
      if (pausedRef()) break;
      if (guard++ >= maxIterations) {
        this.env.logger.push({
          stepId: `subflow:${subflowId}`,
          status: 'warning',
          message: `Subflow exceeded ${maxIterations} iterations - possible cycle`,
        });
        break;
      }

      const node = id2node.get(currentId);
      if (!node) break;

      if (node.type === STEP_TYPES.TRIGGER) {
        const edgeIndex = legacyDefaultSuccessorEdgeIndex(sEdges, currentId);
        const defaultEdge = edgeIndex === undefined ? undefined : sEdges[edgeIndex];
        if (defaultEdge) {
          currentId = defaultEdge.to;
          continue;
        }
        break;
      }

      const step: Step = mapDagNodeToStep(node);
      const r = await this.env.stepRunner.run(ctx, step, ok, fail);

      if (r.status === 'paused' || pausedRef()) break;

      if (r.status === 'failed') {
        const edgeIndex = legacyLabeledEdgeIndex(
          sEdges,
          currentId,
          ENGINE_CONSTANTS.EDGE_LABELS.ON_ERROR,
        );
        const errEdge = edgeIndex === undefined ? undefined : sEdges[edgeIndex];
        if (errEdge) {
          currentId = errEdge.to;
          continue;
        }
        break;
      }

      const suggestedLabel = r.nextLabel
        ? String(r.nextLabel)
        : ENGINE_CONSTANTS.EDGE_LABELS.DEFAULT;
      const edgeIndex = legacyNextEdgeIndex(sEdges, currentId, suggestedLabel);
      const nextEdge = edgeIndex === undefined ? undefined : sEdges[edgeIndex];

      if (!nextEdge) {
        const outgoing = sEdges.filter((edge) => edge.from === currentId);
        if (r.nextLabel && outgoing.length > 0) {
          const availableLabels = outgoing.map(
            (edge) => edge.label || ENGINE_CONSTANTS.EDGE_LABELS.DEFAULT,
          );
          this.env.logger.push({
            stepId: step.id,
            status: 'warning',
            message: `No edge for label '${suggestedLabel}'. Available: [${availableLabels.join(', ')}]`,
          });
        }
        break;
      }
      currentId = nextEdge.to;
    }

    try {
      await this.env.pluginManager.subflowEnd({
        runId: this.env.runId,
        flow: this.env.flow,
        vars: this.env.vars,
        subflowId,
      });
    } catch (e: any) {
      this.env.logger.push({
        stepId: `subflow:${subflowId}`,
        status: 'warning',
        message: `plugin.subflowEnd error: ${e?.message || String(e)}`,
      });
    }
  }
}
