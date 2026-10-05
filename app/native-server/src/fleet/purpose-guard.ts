import { TOOL_NAMES } from 'humanchrome-shared';
import { loadConfig } from './config';

const TIMERS = { cacheMs: 30_000 } as const;

export interface GuardVerdict {
  allowed: boolean;
  args: unknown;
  message?: string;
}

let cached: { at: number; protection: string | null } | null = null;

/**
 * The human-readable reason this browser's data is worth protecting, or null
 * when the profile is an ordinary one. `purpose add` signals `serve` and not the
 * bridge, so the answer is cached briefly: a bridge that started before the tag
 * must still see it, and one that started after it must not be stale forever.
 */
export async function currentProfileProtection(): Promise<string | null> {
  if (!process.env.HC_FLEET_PROFILE) return null;
  if (cached && Date.now() - cached.at < TIMERS.cacheMs) return cached.protection;
  let protection: string | null = null;
  try {
    const config = await loadConfig();
    const profile = config.profiles.find((entry) => entry.name === process.env.HC_FLEET_PROFILE);
    if (profile?.purpose) protection = `bound to purpose "${profile.purpose}"`;
    else if (profile?.seededFrom) protection = `seeded from ${profile.seededFrom}`;
  } catch (error) {
    // Never cache a read failure: it would disarm the destructive-clear guard
    // for 30s precisely when the fleet is broken, which is when it must hold.
    console.error(`fleet: purpose guard could not read fleet.json: ${(error as Error).message}`);
    return cached?.protection ?? null;
  }
  cached = { at: Date.now(), protection };
  return protection;
}

/** Test seam: a cached protection must not outlive a config change in a test run. */
export function _resetProtectionCacheForTest(): void {
  cached = null;
}

const REFUSAL = (protection: string) =>
  `profile is ${protection}; chrome_clear_browsing_data without "origins" clears every login in this browser — pass origins to scope it, or confirmProfileWipe: true to wipe it anyway`;

/**
 * A bare `chrome_clear_browsing_data` builds removalOptions with no `origins`,
 * which clears every origin in the profile — every login in that browser. On a
 * purpose-bound or seeded browser that is a one-way loss of an inherited
 * login, so it is refused unless the caller scopes it or confirms it.
 */
export function evaluatePurposeGuard(
  toolName: string,
  args: unknown,
  protection: string | null,
): GuardVerdict {
  if (protection === null || toolName !== TOOL_NAMES.BROWSER.CLEAR_BROWSING_DATA) {
    return { allowed: true, args: stripConfirmation(args) };
  }
  const shaped = (typeof args === 'object' && args !== null ? args : {}) as {
    origins?: unknown;
    confirmProfileWipe?: unknown;
  };
  if (
    shaped.confirmProfileWipe === true ||
    (Array.isArray(shaped.origins) && shaped.origins.length > 0)
  ) {
    return { allowed: true, args: stripConfirmation(args) };
  }
  return { allowed: false, args, message: REFUSAL(protection) };
}

/** The bridge-level confirmation flag must never reach the extension. */
function stripConfirmation(args: unknown): unknown {
  if (typeof args !== 'object' || args === null) return args;
  if (!('confirmProfileWipe' in (args as object))) return args;
  const { confirmProfileWipe: _ignored, ...rest } = args as Record<string, unknown>;
  return rest;
}
