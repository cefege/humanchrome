/**
 * @fileoverview RR V3 Keepalive Protocol Constants
 * @description Shared protocol constants for Background-Offscreen keepalive communication
 */

export const RR_V3_KEEPALIVE_PORT_NAME = 'rr_v3_keepalive' as const;

export type KeepaliveMessageType =
  | 'keepalive.ping'
  | 'keepalive.pong'
  | 'keepalive.start'
  | 'keepalive.stop';

export interface KeepaliveMessage {
  type: KeepaliveMessageType;
  timestamp: number;
}

export const DEFAULT_KEEPALIVE_PING_INTERVAL_MS = 20_000;

// Chrome MV3 service worker terminates after ~30s idle; stay under that.
export const MAX_KEEPALIVE_PING_INTERVAL_MS = 25_000;
