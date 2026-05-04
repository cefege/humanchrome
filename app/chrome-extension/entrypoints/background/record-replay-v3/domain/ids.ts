export type FlowId = string;
export type NodeId = string;
export type EdgeId = string;
export type RunId = string;
export type TriggerId = string;
export type EdgeLabel = string;

export const EDGE_LABELS = {
  DEFAULT: 'default',
  ON_ERROR: 'onError',
  TRUE: 'true',
  FALSE: 'false',
} as const;

export type EdgeLabelValue = (typeof EDGE_LABELS)[keyof typeof EDGE_LABELS];
