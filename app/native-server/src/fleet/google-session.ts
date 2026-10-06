import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Whether a browser holds a live Google session, as Google itself answers it.
 *
 * Cookies on disk cannot tell: a profile whose source had already been signed
 * out carries every google.com cookie and lands on "Verify it's you"
 * (`/v3/signin/confirmidentifier`) all the same. The answer comes from
 * `ListAccounts`, the call Chrome's account reconcilor makes. Each account is a
 * JSON list; Chromium's own parser reads index 9 as "this account's session is
 * valid" and index 14 as "signed out" (`google_apis/gaia/gaia_auth_util.cc`,
 * M100). Index 9 is read strictly: an account that does not say it is valid is
 * not counted as signed in, so a format change fails the gate instead of
 * passing a signed-out profile.
 *
 * - `session`: at least one account with a live session.
 * - `remembered`: Google lists accounts, none with a session (sign-in needed).
 * - `none`: no account at all.
 */
export type GoogleSessionState = 'session' | 'remembered' | 'none';

export interface GoogleSession {
  state: GoogleSessionState;
  /** Accounts Google lists for this browser, signed in or not. */
  accounts: number;
  /** Of those, the ones with a live session. */
  signedIn: number;
}

export function classifyListAccounts(body: string): GoogleSession {
  const start = body.indexOf('[');
  let parsed: unknown = null;
  if (start >= 0) {
    try {
      parsed = JSON.parse(body.slice(start));
    } catch {
      parsed = null;
    }
  }
  if (!Array.isArray(parsed) || parsed[0] !== 'gaia.l.a.r' || !Array.isArray(parsed[1])) {
    throw new Error('ListAccounts answered in an unrecognized format');
  }
  const accounts = parsed[1].filter((entry): entry is unknown[] => Array.isArray(entry));
  const signedIn = accounts.filter((account) => account[9] === 1 && account[14] !== 1).length;
  const state: GoogleSessionState =
    signedIn > 0 ? 'session' : accounts.length > 0 ? 'remembered' : 'none';
  return { state, accounts: accounts.length, signedIn };
}

/**
 * Why a profile that should hold a Google session does not, or null when it
 * does or was never expected to. `sourcePendingSince` names the moment the seed
 * Chrome itself went into Google sign-in pending: a copy cannot carry a session
 * its source no longer has.
 */
export function googleSessionLoss(
  expected: boolean,
  found: GoogleSession,
  sourcePendingSince: string | null = null,
): string | null {
  if (!expected || found.state === 'session') return null;
  const what =
    found.state === 'remembered'
      ? `Google remembers ${found.accounts} account(s) but none has a live session`
      : 'Google lists no account at all';
  const source = sourcePendingSince
    ? `; the seed Chrome itself has shown Google sign-in pending since ${sourcePendingSince}, ` +
      'so it had no session to copy: sign in to Google there first'
    : '';
  return `its copied Google login is not live (${found.state}: ${what})${source}`;
}

/** Microseconds between 1601-01-01, Chrome's time epoch, and the Unix epoch. */
export const CHROME_EPOCH_OFFSET_US = 11_644_473_600_000_000n;

/**
 * When a Chrome profile entered Google "sign-in pending", read from its own
 * `Preferences`, or null when it is not pending or the file cannot be read.
 * Chrome sets `signin.signin_pending_start_time` once its reconcilor finds the
 * web session gone while the browser account is still present.
 */
export function signinPendingSince(userDataDir: string): string | null {
  let prefs: unknown;
  try {
    prefs = JSON.parse(readFileSync(path.join(userDataDir, 'Default', 'Preferences'), 'utf8'));
  } catch {
    return null;
  }
  const signin = prefs && typeof prefs === 'object' && 'signin' in prefs ? prefs.signin : null;
  const raw =
    signin && typeof signin === 'object' && 'signin_pending_start_time' in signin
      ? signin.signin_pending_start_time
      : null;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const unixMs = (BigInt(raw) - CHROME_EPOCH_OFFSET_US) / 1000n;
  return new Date(Number(unixMs)).toISOString();
}

/**
 * A same-origin page for the probe to run in. `ListAccounts` only answers a
 * POST with the browser's own cookies, so it is fetched from inside
 * accounts.google.com; `robots.txt` is the lightest document there.
 */
const PROBE_PAGE = 'https://accounts.google.com/robots.txt';
const PROBE_CODE =
  "const response = await fetch('/ListAccounts?gpsia=1&source=ChromiumBrowser&json=standard', " +
  "{ method: 'POST', credentials: 'include', body: ' ' });" +
  ' return { status: response.status, body: await response.text() };';
const PROBE_CLIENT = 'fleet-google-probe';
const TOOL_TIMEOUT_MS = 30_000;

export type BridgeToolCall = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/**
 * One tool call against a profile's bridge REST surface. The text block of a
 * tool result is the tool's JSON payload; a tool-level error throws.
 */
export function bridgeTools(port: number, token: string): BridgeToolCall {
  return async (name, args) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/tools/${name}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-client-id': PROBE_CLIENT,
      },
      body: JSON.stringify({ args }),
      signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
    });
    const payload: unknown = await response.json().catch(() => null);
    const text = toolText(payload);
    const failed =
      !response.ok ||
      (payload !== null && typeof payload === 'object' && 'isError' in payload && payload.isError);
    if (failed || text === null) {
      throw new Error(`${name} failed (HTTP ${response.status}): ${text ?? 'no result'}`);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`${name} answered with non-JSON text`);
    }
  };
}

function toolText(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || !('content' in payload)) return null;
  if (!Array.isArray(payload.content)) return null;
  for (const block of payload.content) {
    if (block && typeof block === 'object' && 'text' in block && typeof block.text === 'string') {
      return block.text;
    }
  }
  return null;
}

function probeTabId(opened: unknown): number {
  const tabs = opened && typeof opened === 'object' && 'tabs' in opened ? opened.tabs : null;
  const first: unknown = Array.isArray(tabs) ? tabs[0] : null;
  const tabId = first && typeof first === 'object' && 'tabId' in first ? first.tabId : null;
  if (typeof tabId !== 'number') throw new Error('the bridge opened no probe tab');
  return tabId;
}

function listAccountsBody(ran: unknown): string {
  const result = ran && typeof ran === 'object' && 'result' in ran ? ran.result : null;
  let answer: unknown = null;
  try {
    answer = typeof result === 'string' ? (JSON.parse(result) as unknown) : null;
  } catch {
    answer = null;
  }
  if (!answer || typeof answer !== 'object' || !('status' in answer) || !('body' in answer)) {
    throw new Error('the ListAccounts probe returned nothing');
  }
  if (answer.status !== 200 || typeof answer.body !== 'string') {
    throw new Error(`ListAccounts answered HTTP ${String(answer.status)}`);
  }
  return answer.body;
}

/**
 * Asks a running profile's own browser whether Google sees it signed in, by
 * opening a background tab on accounts.google.com, running `ListAccounts`
 * there and closing the tab. Goes through the profile's bridge, so it works on
 * a browser `serve` adopted without a DevTools pipe as well as one it launched.
 */
export async function probeGoogleSession(call: BridgeToolCall): Promise<GoogleSession> {
  const tabId = probeTabId(
    await call('chrome_navigate_batch', { urls: [PROBE_PAGE], background: true }),
  );
  try {
    await call('chrome_wait_for', { kind: 'load_state', state: 'complete', tabId });
    return classifyListAccounts(
      listAccountsBody(await call('chrome_javascript', { tabId, code: PROBE_CODE })),
    );
  } finally {
    await call('chrome_close_tabs', { action: 'ids', tabIds: [tabId] }).catch(() => undefined);
  }
}

/** Frees the probe's client lane in the bridge; best effort, like the gateway's. */
export async function releaseProbeClient(port: number, token: string): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${port}/api/clients/${PROBE_CLIENT}/release`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
    });
  } catch {
    /* best effort */
  }
}

/** The probe against the bridge on `port`, with its client lane released after. */
export async function probeProfileGoogleSession(
  port: number,
  token: string,
): Promise<GoogleSession> {
  try {
    return await probeGoogleSession(bridgeTools(port, token));
  } finally {
    await releaseProbeClient(port, token);
  }
}
