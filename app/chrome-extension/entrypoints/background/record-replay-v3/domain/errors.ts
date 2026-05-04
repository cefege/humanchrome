import type { JsonValue } from './json';

export const RR_ERROR_CODES = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNSUPPORTED_NODE: 'UNSUPPORTED_NODE',
  DAG_INVALID: 'DAG_INVALID',
  DAG_CYCLE: 'DAG_CYCLE',

  TIMEOUT: 'TIMEOUT',
  TAB_NOT_FOUND: 'TAB_NOT_FOUND',
  FRAME_NOT_FOUND: 'FRAME_NOT_FOUND',
  TARGET_NOT_FOUND: 'TARGET_NOT_FOUND',
  ELEMENT_NOT_VISIBLE: 'ELEMENT_NOT_VISIBLE',
  NAVIGATION_FAILED: 'NAVIGATION_FAILED',
  NETWORK_REQUEST_FAILED: 'NETWORK_REQUEST_FAILED',

  SCRIPT_FAILED: 'SCRIPT_FAILED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  TOOL_ERROR: 'TOOL_ERROR',

  RUN_CANCELED: 'RUN_CANCELED',
  RUN_PAUSED: 'RUN_PAUSED',

  INTERNAL: 'INTERNAL',
  INVARIANT_VIOLATION: 'INVARIANT_VIOLATION',
} as const;

export type RRErrorCode = (typeof RR_ERROR_CODES)[keyof typeof RR_ERROR_CODES];

export interface RRError {
  code: RRErrorCode;
  message: string;
  data?: JsonValue;
  retryable?: boolean;
  /** Cause chain. */
  cause?: RRError;
}

export function createRRError(
  code: RRErrorCode,
  message: string,
  options?: { data?: JsonValue; retryable?: boolean; cause?: RRError },
): RRError {
  return {
    code,
    message,
    ...(options?.data !== undefined && { data: options.data }),
    ...(options?.retryable !== undefined && { retryable: options.retryable }),
    ...(options?.cause !== undefined && { cause: options.cause }),
  };
}
