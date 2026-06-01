export const SNAPSHOT_PATH: string;

export type SnapshotShape = {
  $comment: string;
  toolCount: number;
  descriptionLength: number;
  descriptionSha256: string;
  toolNames: string[];
  description: string;
};

export function buildSnapshot(): Promise<SnapshotShape>;
export function writeSnapshot(): Promise<SnapshotShape>;
