/** V2 data reader (placeholder until Phase 5+). */
export interface V2Reader {
  readFlows(): Promise<unknown[]>;
  readRuns(): Promise<unknown[]>;
  readTriggers(): Promise<unknown[]>;
  readSchedules(): Promise<unknown[]>;
}

export function createNotImplementedV2Reader(): V2Reader {
  const notImplemented = async () => {
    throw new Error('V2Reader not implemented');
  };

  return {
    readFlows: notImplemented,
    readRuns: notImplemented,
    readTriggers: notImplemented,
    readSchedules: notImplemented,
  };
}
