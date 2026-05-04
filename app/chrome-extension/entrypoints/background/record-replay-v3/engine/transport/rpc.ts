/** Port RPC protocol used over chrome.runtime.Port. */

import type { JsonObject, JsonValue } from '../../domain/json';
import type { RunId } from '../../domain/ids';
import type { RunEvent } from '../../domain/events';

export const RR_V3_PORT_NAME = 'rr_v3' as const;

export type RpcMethod =
  | 'rr_v3.listRuns'
  | 'rr_v3.getRun'
  | 'rr_v3.getEvents'
  | 'rr_v3.getFlow'
  | 'rr_v3.listFlows'
  | 'rr_v3.saveFlow'
  | 'rr_v3.deleteFlow'
  | 'rr_v3.createTrigger'
  | 'rr_v3.updateTrigger'
  | 'rr_v3.deleteTrigger'
  | 'rr_v3.getTrigger'
  | 'rr_v3.listTriggers'
  | 'rr_v3.enableTrigger'
  | 'rr_v3.disableTrigger'
  | 'rr_v3.fireTrigger'
  | 'rr_v3.enqueueRun'
  | 'rr_v3.listQueue'
  | 'rr_v3.cancelQueueItem'
  | 'rr_v3.startRun'
  | 'rr_v3.cancelRun'
  | 'rr_v3.pauseRun'
  | 'rr_v3.resumeRun'
  | 'rr_v3.debug'
  | 'rr_v3.subscribe'
  | 'rr_v3.unsubscribe';

export interface RpcRequest {
  type: 'rr_v3.request';
  requestId: string;
  method: RpcMethod;
  params?: JsonObject;
}

export interface RpcResponseOk {
  type: 'rr_v3.response';
  requestId: string;
  ok: true;
  result: JsonValue;
}

export interface RpcResponseErr {
  type: 'rr_v3.response';
  requestId: string;
  ok: false;
  error: string;
}

export type RpcResponse = RpcResponseOk | RpcResponseErr;

export interface RpcEventMessage {
  type: 'rr_v3.event';
  event: RunEvent;
}

export interface RpcSubscribeAck {
  type: 'rr_v3.subscribeAck';
  /** Subscribed Run ID; null means subscribe to all. */
  runId: RunId | null;
}

export type RpcMessage =
  | RpcRequest
  | RpcResponseOk
  | RpcResponseErr
  | RpcEventMessage
  | RpcSubscribeAck;

export function generateRequestId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function isRpcRequest(msg: unknown): msg is RpcRequest {
  return typeof msg === 'object' && msg !== null && (msg as RpcRequest).type === 'rr_v3.request';
}

export function isRpcResponse(msg: unknown): msg is RpcResponse {
  return typeof msg === 'object' && msg !== null && (msg as RpcResponse).type === 'rr_v3.response';
}

export function isRpcEvent(msg: unknown): msg is RpcEventMessage {
  return typeof msg === 'object' && msg !== null && (msg as RpcEventMessage).type === 'rr_v3.event';
}

export function createRpcRequest(method: RpcMethod, params?: JsonObject): RpcRequest {
  return {
    type: 'rr_v3.request',
    requestId: generateRequestId(),
    method,
    params,
  };
}

export function createRpcResponseOk(requestId: string, result: JsonValue): RpcResponseOk {
  return {
    type: 'rr_v3.response',
    requestId,
    ok: true,
    result,
  };
}

export function createRpcResponseErr(requestId: string, error: string): RpcResponseErr {
  return {
    type: 'rr_v3.response',
    requestId,
    ok: false,
    error,
  };
}

export function createRpcEventMessage(event: RunEvent): RpcEventMessage {
  return {
    type: 'rr_v3.event',
    event,
  };
}
