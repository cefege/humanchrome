import { promises as fs } from 'node:fs';
import type { CdpPipe } from './cdp';

export const SESSION_FILE = '.hc-session.json';

const SAME_SITE = new Set(['Strict', 'Lax', 'None']);
/**
 * CDP's `Cookie.sourceScheme` is an enum, not a URL scheme: `Secure` (https),
 * `NonSecure` (http) or `Unset`. Only the two web schemes may be replayed —
 * `chrome-extension://`, `devtools://` and `file://` state all report `Unset`
 * or another value and must never be written back into a browser.
 */
const WEB_SOURCE_SCHEMES = new Set(['Secure', 'NonSecure']);

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

interface CapturedCookie {
  name?: unknown;
  value?: unknown;
  domain?: unknown;
  path?: unknown;
  sourceScheme?: unknown;
  expires?: unknown;
  httpOnly?: unknown;
  secure?: unknown;
  sameSite?: unknown;
  session?: unknown;
}

/**
 * Chrome only persists a cookie that carries a real expiry, so every login held
 * by a session cookie dies with the browser. The fleet snapshots the live
 * cookie store on the way out and replays it on the way in; the price is
 * plaintext session tokens at 0600 inside the profile directory.
 */
export async function captureSession(
  cdp: CdpPipe,
  file: string,
  profile = 'browser',
): Promise<number> {
  const response = await cdp.send('Storage.getCookies', {});
  if (response.error) {
    throw new Error(`Storage.getCookies failed: ${response.error.message ?? 'unknown'}`);
  }
  const raw = ((response.result as { cookies?: CapturedCookie[] } | undefined)?.cookies ??
    []) as CapturedCookie[];
  const cookies: StoredCookie[] = [];
  for (const cookie of raw) {
    // `Unset` covers chrome-extension://, devtools:// and file:// state, none of
    // which may be replayed into a browser.
    if (typeof cookie.sourceScheme !== 'string' || !WEB_SOURCE_SCHEMES.has(cookie.sourceScheme)) {
      continue;
    }
    if (typeof cookie.name !== 'string' || typeof cookie.value !== 'string') continue;
    if (typeof cookie.domain !== 'string' || typeof cookie.path !== 'string') continue;
    if (typeof cookie.sameSite !== 'string' || !SAME_SITE.has(cookie.sameSite)) continue;
    cookies.push({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      // A session cookie reports -1; keep it out of the file so Chrome treats
      // the replayed cookie as a session cookie again.
      expires: typeof cookie.expires === 'number' && cookie.expires > 0 ? cookie.expires : -1,
      httpOnly: Boolean(cookie.httpOnly),
      secure: Boolean(cookie.secure),
      sameSite: cookie.sameSite as StoredCookie['sameSite'],
    });
  }
  // Write-then-rename: this file is the only copy of the fleet's logins, and an
  // in-place write truncates it first, so a crash mid-write loses every cookie.
  const temporaryPath = `${file}.${process.pid}.tmp`;
  await fs.writeFile(
    temporaryPath,
    `${JSON.stringify({ capturedAt: new Date().toISOString(), cookies })}\n`,
    { mode: 0o600 },
  );
  await fs.rename(temporaryPath, file);
  // The chmod fixes the mode of a pre-existing file the rename has replaced; the
  // write mode only applies when the file is created.
  await fs.chmod(file, 0o600);
  return cookies.length;
}

/**
 * Never throws and never blocks a launch: a browser without its old session
 * still starts, it just needs one login.
 */
export async function restoreSession(
  cdp: CdpPipe,
  file: string,
  profile = 'browser',
): Promise<number> {
  const skip = (stage: string, message: string): number => {
    console.error(`fleet: session restore skipped for ${profile} (${stage}): ${message}`);
    return 0;
  };
  let cookies: StoredCookie[];
  try {
    const raw = await fs.readFile(file, 'utf8');
    cookies = (JSON.parse(raw) as { cookies?: StoredCookie[] }).cookies ?? [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    return skip('read', (error as Error).message);
  }
  if (!cookies.length) return 0;
  try {
    const response = await cdp.send('Storage.setCookies', { cookies });
    if (response.error) {
      return skip('setCookies', response.error.message ?? 'unknown');
    }
  } catch (error) {
    return skip('setCookies', (error as Error).message);
  }
  return cookies.length;
}
