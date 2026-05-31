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
  /** Printable text to type or paste. Special chars escaped for AppleScript. */
  text: string;
  /** When true, presses Return after the text (key code 36 on macOS). */
  withReturn?: boolean;
  /** Per-call timeout in ms. Defaults to 10000. */
  timeoutMs?: number;
  /**
   * 'paste' (default) is much faster: one Cmd+V keystroke instead of N per-char
   * keystrokes, so the foreground-Chrome window is shorter. Saves and restores
   * the user's clipboard so we don't clobber what they had. 'keystroke' types
   * char-by-char — slower but useful when the page debounces by per-key cadence.
   */
  mode?: 'paste' | 'keystroke';
  /**
   * Optional list of acceptable frontmost-app names. If provided, the host
   * reads the actual frontmost app before keystroke and refuses with
   * `wrong_frontmost_app` if it isn't in the list. Set by the BG tool to
   * ["Google Chrome", "Google Chrome Canary", "Google Chrome for Testing",
   * "Chromium"] so the keystrokes don't land in the wrong app if focus
   * shifted between our activation step and the keystroke.
   */
  expectedFrontmostApp?: string[];
};

export type NativeKeystrokeResult =
  | {
      success: true;
      platform: 'darwin' | 'linux' | 'win32';
      mode: 'paste' | 'keystroke';
      charsTyped: number;
      durationMs: number;
      /** Name of the frontmost app immediately BEFORE the keystroke fired. */
      frontmostBefore?: string;
    }
  | {
      success: false;
      platform: string;
      error: string;
      code:
        | 'not_supported'
        | 'permission_denied'
        | 'osascript_failed'
        | 'invalid_args'
        | 'timeout'
        | 'wrong_frontmost_app';
      /** Set when code === 'wrong_frontmost_app' — what was actually frontmost. */
      frontmostBefore?: string;
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

/**
 * Read the frontmost-app name via osascript. Returns null if osascript
 * fails — the caller should treat that as "couldn't verify" not "wrong app".
 */
async function readFrontmostApp(timeoutMs: number): Promise<string | null> {
  return await new Promise<string | null>((resolve) => {
    const child = spawn('osascript', [
      '-e',
      'tell application "System Events" to name of first application process whose frontmost is true',
    ]);
    let stdout = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {}
      resolve(null);
    }, timeoutMs);
    child.stdout?.on('data', (d) => {
      stdout += String(d);
    });
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code === 0 ? stdout.trim() : null);
    });
  });
}

function buildKeystrokeScript(payload: NativeKeystrokePayload): string {
  // AppleScript string literal escape: \ → \\ and " → \"
  const safeText = payload.text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
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
  return `tell application "System Events"\n${parts.map((p) => '  ' + p).join('\n')}\nend tell`;
}

function buildPasteScript(payload: NativeKeystrokePayload): string {
  // Paste mode: save the user's clipboard, set ours, Cmd+V, restore.
  // Wrapped in try/end try so the clipboard restore always runs even if
  // the paste keystroke fails — leaving the user's clipboard clobbered
  // is the worst-case UX failure mode here.
  //
  // Special handling for the clipboard: AppleScript's `the clipboard`
  // may not preserve all formats (RTF, image, etc.) — we treat it as a
  // best-effort restore. For pure-text clipboards (the common case)
  // round-trips cleanly.
  const safeText = payload.text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const lines: string[] = [
    'set _saved to ""',
    'try',
    '  set _saved to the clipboard',
    'end try',
    `set the clipboard to "${safeText}"`,
    'tell application "System Events"',
    '  keystroke "v" using command down',
  ];
  if (payload.withReturn === true) {
    lines.push('  key code 36');
  }
  lines.push('end tell');
  // Small delay so the paste lands BEFORE we overwrite the clipboard back.
  // 80ms is the empirical floor on a busy Mac — paste keystroke + DOM
  // insertion + input-event dispatch typically completes in <50ms.
  lines.push('delay 0.08');
  lines.push('try');
  lines.push('  set the clipboard to _saved');
  lines.push('end try');
  return lines.join('\n');
}

async function runMacOs(
  payload: NativeKeystrokePayload,
  timeoutMs: number,
  start: number,
): Promise<NativeKeystrokeResult> {
  const mode: 'paste' | 'keystroke' = payload.mode === 'keystroke' ? 'keystroke' : 'paste';

  // Frontmost-app guard. If the caller gave us a list of acceptable apps,
  // verify we're actually focused on one of them BEFORE firing the
  // keystroke. Without this guard, a user clicking away during humanchrome's
  // window-activation settle could send keystrokes into VS Code / Slack /
  // their terminal — exactly the "fuck things up" failure mode this layer
  // exists to prevent.
  let frontmostBefore: string | null = null;
  if (Array.isArray(payload.expectedFrontmostApp) && payload.expectedFrontmostApp.length > 0) {
    frontmostBefore = await readFrontmostApp(Math.min(3000, timeoutMs));
    if (frontmostBefore !== null && !payload.expectedFrontmostApp.includes(frontmostBefore)) {
      return {
        success: false,
        platform: 'darwin',
        error:
          `Refusing to send keystrokes: frontmost app is "${frontmostBefore}", ` +
          `expected one of [${payload.expectedFrontmostApp.join(', ')}]. ` +
          `Bring Chrome to the foreground and retry.`,
        code: 'wrong_frontmost_app',
        frontmostBefore,
      };
    }
  }

  // Short-circuit: no text and no Return to press → done.
  if (payload.text.length === 0 && payload.withReturn !== true) {
    return {
      success: true,
      platform: 'darwin',
      mode,
      charsTyped: 0,
      durationMs: Date.now() - start,
      ...(frontmostBefore ? { frontmostBefore } : {}),
    };
  }

  const script =
    mode === 'paste' && payload.text.length > 0
      ? buildPasteScript(payload)
      : buildKeystrokeScript(payload);

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
          mode,
          charsTyped: payload.text.length,
          durationMs: Date.now() - start,
          ...(frontmostBefore ? { frontmostBefore } : {}),
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
