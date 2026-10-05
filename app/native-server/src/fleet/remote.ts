import type { FleetNodeConfig } from './config';
import type { ProfileState } from './supervisor';

export const NODE_SEPARATOR = ':';
const NODE_TIMEOUT_MS = 3_000;

export interface RemoteProfile {
  name: string;
  port: number;
  labels: string[];
  purpose: string | null;
  enabled: boolean;
  state: ProfileState;
}

/**
 * Reads a peer machine's `/v1/profiles`. Throws on any failure — a caller that
 * needs a fallback entry (the gateway's `unreachable` route) supplies its own,
 * while a caller that must prove something about the whole fleet
 * (`purpose add`) needs the failure to surface.
 */
export async function fetchNodeProfiles(
  node: FleetNodeConfig,
  timeoutMs: number = NODE_TIMEOUT_MS,
): Promise<RemoteProfile[]> {
  const response = await fetch(`http://${node.host}:${node.port}/v1/profiles`, {
    headers: node.token ? { authorization: `Bearer ${node.token}` } : {},
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`status ${response.status}`);
  const profiles = (await response.json()) as Array<{
    name: string;
    port: number;
    labels: string[];
    purpose?: string | null;
    enabled?: boolean;
    state: ProfileState;
  }>;
  return profiles.map((profile) => ({
    name: profile.name,
    port: profile.port,
    labels: profile.labels,
    purpose: profile.purpose ?? null,
    enabled: profile.enabled ?? true,
    state: profile.state,
  }));
}

/** The local gateway's own view of this machine's profiles, when `serve` is up. */
export async function fetchLocalProfiles(
  gatewayHost: string,
  gatewayPort: number,
  token: string | null,
  timeoutMs = NODE_TIMEOUT_MS,
): Promise<Array<{ name: string; state: ProfileState; purpose: string | null }>> {
  const response = await fetch(`http://${gatewayHost}:${gatewayPort}/v1/profiles`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`status ${response.status}`);
  const profiles = (await response.json()) as Array<{
    name: string;
    state: ProfileState;
    purpose?: string | null;
  }>;
  return profiles.map((profile) => ({
    name: profile.name,
    state: profile.state,
    purpose: profile.purpose ?? null,
  }));
}
