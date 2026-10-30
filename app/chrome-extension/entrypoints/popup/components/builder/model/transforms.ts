import type {
  Flow as FlowV2,
  NodeBase,
  Edge as EdgeV2,
} from '@/entrypoints/background/record-replay/types';
import {
  builderPolicy,
  legacyBuilderStepIndexes,
  legacyExecutionPlan,
  nodesToSteps as sharedNodesToSteps,
  stepsToNodes as sharedStepsToNodes,
  STEP_TYPES,
  EDGE_LABELS,
} from 'humanchrome-shared';

export function newId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}

export type NodeType = NodeBase['type'];

export function defaultConfigFor(t: NodeType): any {
  const branchId = t === STEP_TYPES.IF ? newId('case') : '';
  const config = builderPolicy.builderDefaultConfig(t, branchId);
  return t === STEP_TYPES.CLICK ? { ...config, value: undefined } : config;
}

export function stepsToNodes(steps: any[]): NodeBase[] {
  const base = sharedStepsToNodes(steps) as unknown as NodeBase[];
  // add simple UI positions
  base.forEach((n, i) => {
    (n as any).ui = (n as any).ui || { x: 200, y: 120 + i * 120 };
  });
  return base;
}

export function topoOrder(nodes: NodeBase[], edges: EdgeV2[]): NodeBase[] {
  return legacyExecutionPlan(nodes, edges).orderedNodeIndexes.map((index) => nodes[index]);
}

export function nodesToSteps(nodes: NodeBase[], edges: EdgeV2[]): Record<string, unknown>[] {
  const executableNodes = legacyBuilderStepIndexes(nodes, edges).map((index) => nodes[index]);
  return sharedNodesToSteps(executableNodes, []);
}

export function autoChainEdges(nodes: NodeBase[]): EdgeV2[] {
  const arr: EdgeV2[] = [];
  for (let i = 0; i < nodes.length - 1; i++)
    arr.push({
      id: newId('e'),
      from: nodes[i].id,
      to: nodes[i + 1].id,
      label: EDGE_LABELS.DEFAULT,
    });
  return arr;
}

export function summarizeNode(n?: NodeBase | null): string {
  if (!n) return '';
  if (n.type === STEP_TYPES.CLICK || n.type === STEP_TYPES.FILL)
    return n.config?.target?.candidates?.[0]?.value || 'No selector configured';
  if (n.type === STEP_TYPES.NAVIGATE) return n.config?.url || '';
  if (n.type === STEP_TYPES.KEY) return n.config?.keys || '';
  if (n.type === STEP_TYPES.DELAY) return `${Number(n.config?.ms || 0)}ms`;
  if (n.type === STEP_TYPES.HTTP) return `${n.config?.method || 'GET'} ${n.config?.url || ''}`;
  if (n.type === STEP_TYPES.EXTRACT)
    return `${n.config?.selector || ''} -> ${n.config?.saveAs || ''}`;
  if (n.type === STEP_TYPES.SCREENSHOT)
    return n.config?.selector
      ? `el(${n.config.selector}) -> ${n.config?.saveAs || ''}`
      : `fullPage -> ${n.config?.saveAs || ''}`;
  if (n.type === STEP_TYPES.TRIGGER_EVENT)
    return `${n.config?.event || ''} ${n.config?.target?.candidates?.[0]?.value || ''}`;
  if (n.type === STEP_TYPES.SET_ATTRIBUTE)
    return `${n.config?.name || ''}=${n.config?.value ?? ''}`;
  if (n.type === STEP_TYPES.LOOP_ELEMENTS)
    return `${n.config?.selector || ''} as ${n.config?.itemVar || 'item'} -> ${n.config?.subflowId || ''}`;
  if (n.type === STEP_TYPES.SWITCH_FRAME)
    return n.config?.frame?.urlContains
      ? `url~${n.config.frame.urlContains}`
      : `index=${Number(n.config?.frame?.index ?? 0)}`;
  if (n.type === STEP_TYPES.OPEN_TAB) return `open ${n.config?.url || ''}`;
  if (n.type === STEP_TYPES.SWITCH_TAB)
    return `switch ${n.config?.tabId || n.config?.urlContains || n.config?.titleContains || ''}`;
  if (n.type === STEP_TYPES.CLOSE_TAB) return `close ${n.config?.url || ''}`;
  if (n.type === STEP_TYPES.HANDLE_DOWNLOAD) return `download ${n.config?.filenameContains || ''}`;
  if (n.type === STEP_TYPES.WAIT) return JSON.stringify(n.config?.condition || {});
  if (n.type === STEP_TYPES.ASSERT) return JSON.stringify(n.config?.assert || {});
  if (n.type === STEP_TYPES.IF) {
    const cnt = Array.isArray(n.config?.branches) ? n.config.branches.length : 0;
    return `if/else branches ${cnt}${n.config?.else === false ? '' : ' + else'}`;
  }
  if (n.type === STEP_TYPES.SCRIPT) return (n.config?.code || '').slice(0, 30);
  if (n.type === STEP_TYPES.DRAG) {
    const a = n.config?.start?.candidates?.[0]?.value || '';
    const b = n.config?.end?.candidates?.[0]?.value || '';
    return a || b ? `${a} -> ${b}` : 'drag';
  }
  if (n.type === STEP_TYPES.SCROLL) {
    const mode = n.config?.mode || 'offset';
    if (mode === 'offset' || mode === 'container') {
      const x = Number(n.config?.offset?.x ?? 0);
      const y = Number(n.config?.offset?.y ?? 0);
      return `${mode} (${x}, ${y})`;
    }
    const sel = n.config?.target?.candidates?.[0]?.value || '';
    return sel ? `element ${sel}` : 'element';
  }
  if (n.type === STEP_TYPES.EXECUTE_FLOW) return `exec ${n.config?.flowId || ''}`;
  return '';
}

export function cloneFlow(flow: FlowV2): FlowV2 {
  return JSON.parse(JSON.stringify(flow));
}
