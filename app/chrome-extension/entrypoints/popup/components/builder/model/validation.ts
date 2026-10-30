import type { NodeBase } from '@/entrypoints/background/record-replay/types';
import { builderPolicy } from 'humanchrome-shared';

export function validateNode(n: NodeBase): string[] {
  return builderPolicy.builderValidateNode(n.type, n.config || {});
}

export function validateFlow(nodes: NodeBase[]): {
  totalErrors: number;
  nodeErrors: Record<string, string[]>;
} {
  const nodeErrors: Record<string, string[]> = {};
  let totalErrors = 0;
  for (const n of nodes) {
    const e = validateNode(n);
    if (e.length) {
      nodeErrors[n.id] = e;
      totalErrors += e.length;
    }
  }
  return { totalErrors, nodeErrors };
}
