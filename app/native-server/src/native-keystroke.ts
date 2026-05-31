/**
 * Bug-008 workaround — deliver real OS-level keystrokes that produce
 * trusted `keydown` DOM events on stable Chrome 145, where CDP
 * `Input.dispatchKeyEvent` keyDown is silently suppressed.
 *
 * The runtime check is platform-dependent:
 *   - macOS: AppleScript `tell application "System Events" to keystroke`
 *     delivers to the FRONTMOST app. Requires Accessibility permission
 *     for the host process — granted once via System Settings → Privacy
 *     & Security → Accessibility. Returns a structured error on perm
 *     denial so the BG tool can surface a clear "click the toggle" hint.
 *   - Linux / Windows: not yet implemented; returns `not_supported`.
 */
import { spawn } from 'node:child_process';
import { platform } from 'node:os';

export type NativeKeystrokePayload = {
  /** Printable text to type. Special chars escaped for AppleScript. */
  text: string;
  /** When true, presses Return after the text (key code 36 on macOS). */
  withReturn?: boolean;
  /** Per-call timeout in ms. Defaults to 10000. */
  timeoutMs?: number;
};

export type NativeKeystrokeResult =
  | { success: true; platform: 'darwin' | 'linux' | 'win32'; charsTyped: number; durationMs: number }
  | {
      success: false;
      platform: string;
      error: string;
      code:
        | 'not_supported'
        | 'permission_denied'
        | 'osascript_failed'
        | 'invalid_args'
        | 'timeout';
    };

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TEXT_LENGTH = 4096;

export async function nativeKeystroke(
  payload: NativeKeystrokePayload,
): Promise<NativeKeystrokeResult> {
  const start = Date.now();

  if (typeof payload?.text !== 'string') {
    return {
      success: false,
      platform: platform(),
      error: 'payload.text must be a string',
      code: 'invalid_args',
    };
  }
  if (payload.text.length > MAX_TEXT_LENGTH) {
    return {
      success: false,
      platform: platform(),
      error: `payload.text too long (${payload.text.length} > ${MAX_TEXT_LENGTH})`,
      code: 'invalid_args',
    };
  }
  const timeoutMs =
    typeof payload.timeoutMs === 'number' && payload.timeoutMs > 0
      ? Math.min(payload.timeoutMs, 60_000)
      : DEFAULT_TIMEOUT_MS;

  const p = platform();
  if (p === 'darwin') {
    return await runMacOs(payload, timeoutMs, start);
  }
  return {
    success: false,
    platform: p,
    error: `native_keystroke not implemented for platform "${p}" yet (macOS only)`,
    code: 'not_supported',
  };
}

async function runMacOs(
  payload: NativeKeystrokePayload,
  timeoutMs: number,
  start: number,
): Promise<NativeKeystrokeResult> {
  // AppleScript string literal escape: \ → \\ and " → \"
  const safeText = payload.text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  // `keystroke ""` is illegal on some macOS versions; only emit the
  // keystroke clause when there's actual text.
  const parts: string[] = [];
  if (safeText.length > 0) {
    parts.push(`keystroke "${safeText}"`);
  }
  if (payload.withReturn === true) {
    // key code 36 = Return. Use "key code" not "keystroke return" so
    // multi-line text in the same call doesn't recursively try to
    // dispatch "return" as a printable keyword.
    parts.push('key code 36');
  }
  if (parts.length === 0) {
    return {
      success: true,
      platform: 'darwin',
      charsTyped: 0,
      durationMs: Date.now() - start,
    };
  }
  const script = `tell application "System Events"\n${parts.map((p) => '  ' + p).join('\n')}\nend tell`;

  return await new Promise<NativeKeystrokeResult>((resolve) => {
    let settled = false;
    const child = spawn('osascript', ['-e', script]);
    let stderr = '';
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {}
      // First-time osascript invocation can hang on the macOS Accessibility
      // permission prompt — if the user never granted, the OS pops a dialog
      // and osascript blocks waiting for it. The hang LOOKS like a timeout
      // but the underlying cause is permissions. Surface the hint here.
      resolve({
        success: false,
        platform: 'darwin',
        error:
          `osascript exceeded ${timeoutMs}ms timeout. First-time use frequently means ` +
          `macOS Accessibility permission was not yet granted — check System Settings → ` +
          `Privacy & Security → Accessibility and enable the entry for the process running ` +
          `osascript (often "Terminal", "iTerm", or the parent app of humanchrome's native ` +
          `host). If a dialog popped up, accept it and retry.`,
        code: 'timeout',
      });
    }, timeoutMs);

    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        success: false,
        platform: 'darwin',
        error: `osascript spawn failed: ${err.message}`,
        code: 'osascript_failed',
      });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({
          success: true,
          platform: 'darwin',
          charsTyped: payload.text.length,
          durationMs: Date.now() - start,
        });
        return;
      }
      // Accessibility permission denials look like:
      //   "execution error: System Events got an error: osascript is not
      //    allowed to send keystrokes. (1002)"
      if (/not allowed to send keystrokes|not authorized|-1002|-1719/i.test(stderr)) {
        resolve({
          success: false,
          platform: 'darwin',
          error:
            'osascript blocked by macOS Accessibility. Grant in System Settings → ' +
            'Privacy & Security → Accessibility → enable osascript / Terminal / the ' +
            'parent process, then retry. Detail: ' +
            stderr.trim().slice(0, 200),
          code: 'permission_denied',
        });
        return;
      }
      resolve({
        success: false,
        platform: 'darwin',
        error: `osascript exit ${code}: ${stderr.trim().slice(0, 300)}`,
        code: 'osascript_failed',
      });
    });
  });
}
