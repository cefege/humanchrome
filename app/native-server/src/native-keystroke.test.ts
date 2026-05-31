/**
 * Tests for the native_keystroke handler. We mock `child_process.spawn`
 * so the suite never actually shells out to osascript / xdotool; we just
 * assert the right command is built and outputs are mapped correctly.
 */
import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';

// --- Spawn mock ------------------------------------------------------------

type SpawnCall = { cmd: string; args: string[]; child: FakeChild };

class FakeChild extends EventEmitter {
  stderr: EventEmitter;
  stdout: EventEmitter;
  killed = false;
  constructor() {
    super();
    this.stderr = new EventEmitter();
    this.stdout = new EventEmitter();
  }
  kill() {
    this.killed = true;
  }
}

let spawnCalls: SpawnCall[] = [];

jest.mock('node:child_process', () => ({
  spawn: jest.fn((cmd: string, args: string[]) => {
    const child = new FakeChild();
    spawnCalls.push({ cmd, args, child });
    return child as any;
  }),
}));

// --- Platform mock (always darwin for these tests; override per-test) ------

let mockPlatform: 'darwin' | 'linux' | 'win32' = 'darwin';
jest.mock('node:os', () => ({
  platform: () => mockPlatform,
}));

// --- Import under test (after mocks) ---------------------------------------

import { nativeKeystroke } from './native-keystroke';

beforeEach(() => {
  spawnCalls = [];
  mockPlatform = 'darwin';
});

describe('nativeKeystroke — input validation', () => {
  test('rejects non-string text', async () => {
    const res = await nativeKeystroke({ text: 42 as any });
    expect(res.success).toBe(false);
    expect(res.success === false && res.code).toBe('invalid_args');
  });

  test('rejects text longer than the cap', async () => {
    const res = await nativeKeystroke({ text: 'a'.repeat(5000) });
    expect(res.success).toBe(false);
    expect(res.success === false && res.code).toBe('invalid_args');
  });
});

describe('nativeKeystroke — non-macOS platforms', () => {
  test('linux → not_supported (no spawn)', async () => {
    mockPlatform = 'linux';
    const res = await nativeKeystroke({ text: 'hi' });
    expect(res.success).toBe(false);
    expect(res.success === false && res.code).toBe('not_supported');
    expect(spawnCalls.length).toBe(0);
  });

  test('windows → not_supported', async () => {
    mockPlatform = 'win32';
    const res = await nativeKeystroke({ text: 'hi' });
    expect(res.success).toBe(false);
    expect(res.success === false && res.code).toBe('not_supported');
  });
});

describe('nativeKeystroke — macOS happy path', () => {
  test('builds AppleScript with keystroke clause and resolves on exit 0', async () => {
    const promise = nativeKeystroke({ text: 'hello', mode: 'keystroke' });
    // Let spawn fire + osascript "complete" successfully.
    await Promise.resolve();
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].cmd).toBe('osascript');
    expect(spawnCalls[0].args[0]).toBe('-e');
    const script = spawnCalls[0].args[1];
    expect(script).toContain('tell application "System Events"');
    expect(script).toContain('keystroke "hello"');
    expect(script).not.toContain('key code 36');

    spawnCalls[0].child.emit('close', 0);
    const res = await promise;
    expect(res.success).toBe(true);
    expect(res.success && res.platform).toBe('darwin');
    expect(res.success && res.charsTyped).toBe(5);
  });

  test('pressEnter:true appends key code 36 (Return)', async () => {
    const promise = nativeKeystroke({ text: 'GraphQL', withReturn: true, mode: 'keystroke' });
    await Promise.resolve();
    const script = spawnCalls[0].args[1];
    expect(script).toContain('keystroke "GraphQL"');
    expect(script).toContain('key code 36');
    spawnCalls[0].child.emit('close', 0);
    expect((await promise).success).toBe(true);
  });

  test('text with double-quotes and backslashes is escaped', async () => {
    const promise = nativeKeystroke({ text: 'a"b\\c', mode: 'keystroke' });
    await Promise.resolve();
    const script = spawnCalls[0].args[1];
    // " → \", \ → \\, so a"b\c becomes a\"b\\c inside the literal
    expect(script).toContain('keystroke "a\\"b\\\\c"');
    spawnCalls[0].child.emit('close', 0);
    expect((await promise).success).toBe(true);
  });

  test('empty text + withReturn:true sends only key code 36', async () => {
    const promise = nativeKeystroke({ text: '', withReturn: true });
    await Promise.resolve();
    const script = spawnCalls[0].args[1];
    expect(script).not.toContain('keystroke ""');
    expect(script).toContain('key code 36');
    spawnCalls[0].child.emit('close', 0);
    expect((await promise).success).toBe(true);
  });

  test('empty text + withReturn:false short-circuits with no spawn', async () => {
    const res = await nativeKeystroke({ text: '' });
    expect(res.success).toBe(true);
    expect(res.success && res.charsTyped).toBe(0);
    expect(spawnCalls.length).toBe(0);
  });
});

describe('nativeKeystroke — macOS failure paths', () => {
  test('accessibility denial → permission_denied with hint', async () => {
    const promise = nativeKeystroke({ text: 'x' });
    await Promise.resolve();
    spawnCalls[0].child.stderr.emit(
      'data',
      Buffer.from(
        'execution error: System Events got an error: osascript is not allowed to send keystrokes. (-1719)',
      ),
    );
    spawnCalls[0].child.emit('close', 1);
    const res = await promise;
    expect(res.success).toBe(false);
    expect(res.success === false && res.code).toBe('permission_denied');
    expect(res.success === false && res.error).toContain('Accessibility');
  });

  test('generic osascript failure → osascript_failed', async () => {
    const promise = nativeKeystroke({ text: 'x' });
    await Promise.resolve();
    spawnCalls[0].child.stderr.emit('data', Buffer.from('execution error: something else'));
    spawnCalls[0].child.emit('close', 2);
    const res = await promise;
    expect(res.success).toBe(false);
    expect(res.success === false && res.code).toBe('osascript_failed');
  });

  test('spawn error (osascript missing) → osascript_failed', async () => {
    const promise = nativeKeystroke({ text: 'x' });
    await Promise.resolve();
    spawnCalls[0].child.emit('error', new Error('ENOENT'));
    const res = await promise;
    expect(res.success).toBe(false);
    expect(res.success === false && res.code).toBe('osascript_failed');
  });

  test('timeout cancels the child and resolves timeout with Accessibility hint', async () => {
    const promise = nativeKeystroke({ text: 'x', timeoutMs: 10 });
    // Don't emit close — let the timeout fire.
    const res = await promise;
    expect(res.success).toBe(false);
    expect(res.success === false && res.code).toBe('timeout');
    expect(spawnCalls[0].child.killed).toBe(true);
    // The timeout message should mention Accessibility — first-time
    // osascript hangs are almost always the permission dialog.
    expect(res.success === false && res.error).toContain('Accessibility');
  });
});

describe('nativeKeystroke — paste mode', () => {
  test('builds paste script with clipboard save/restore + Cmd+V', async () => {
    // First spawn = readFrontmostApp (we did NOT pass expectedFrontmostApp
    // so it's skipped). Actually with no expectedFrontmostApp, frontmost
    // probe is skipped entirely.
    const promise = nativeKeystroke({ text: 'GraphQL', mode: 'paste' });
    await Promise.resolve();
    expect(spawnCalls.length).toBe(1);
    const script = spawnCalls[0].args[1];
    expect(script).toContain('set _saved to the clipboard');
    expect(script).toContain('set the clipboard to "GraphQL"');
    expect(script).toContain('keystroke "v" using command down');
    expect(script).toContain('set the clipboard to _saved');
    expect(script).not.toContain('key code 36');
    spawnCalls[0].child.emit('close', 0);
    const res = await promise;
    expect(res.success).toBe(true);
    expect(res.success && res.mode).toBe('paste');
  });

  test('paste + pressEnter appends key code 36 inside the System Events tell', async () => {
    const promise = nativeKeystroke({ text: 'GraphQL', mode: 'paste', withReturn: true });
    await Promise.resolve();
    const script = spawnCalls[0].args[1];
    expect(script).toContain('keystroke "v" using command down');
    expect(script).toContain('key code 36');
    spawnCalls[0].child.emit('close', 0);
    expect((await promise).success).toBe(true);
  });

  test("explicit mode:'keystroke' uses the char-by-char path, not paste", async () => {
    const promise = nativeKeystroke({ text: 'hi', mode: 'keystroke' });
    await Promise.resolve();
    const script = spawnCalls[0].args[1];
    expect(script).not.toContain('set the clipboard');
    expect(script).toContain('keystroke "hi"');
    spawnCalls[0].child.emit('close', 0);
    expect((await promise).success).toBe(true);
  });
});

describe('nativeKeystroke — frontmost-app guard', () => {
  test('reads frontmost; refuses when not in expectedFrontmostApp list', async () => {
    const promise = nativeKeystroke({
      text: 'hi',
      expectedFrontmostApp: ['Google Chrome'],
    });
    await Promise.resolve();
    // First spawn = readFrontmostApp probe. Return "Visual Studio Code".
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].args[1]).toContain('frontmost is true');
    spawnCalls[0].child.stdout.emit('data', Buffer.from('Visual Studio Code\n'));
    spawnCalls[0].child.emit('close', 0);
    const res = await promise;
    expect(res.success).toBe(false);
    expect(res.success === false && res.code).toBe('wrong_frontmost_app');
    expect(res.success === false && res.frontmostBefore).toBe('Visual Studio Code');
    // No keystroke spawn happens after the refusal.
    expect(spawnCalls.length).toBe(1);
  });

  test('proceeds when frontmost is in the allow-list; includes frontmostBefore in result', async () => {
    const promise = nativeKeystroke({
      text: 'hi',
      expectedFrontmostApp: ['Google Chrome', 'Google Chrome for Testing'],
    });
    await Promise.resolve();
    // First spawn = frontmost probe — return "Google Chrome".
    spawnCalls[0].child.stdout.emit('data', Buffer.from('Google Chrome\n'));
    spawnCalls[0].child.emit('close', 0);
    // Need a microtask so the keystroke spawn is queued.
    await new Promise((r) => setTimeout(r, 5));
    expect(spawnCalls.length).toBe(2);
    // Second spawn = the actual paste/keystroke. Close with 0.
    spawnCalls[1].child.emit('close', 0);
    const res = await promise;
    expect(res.success).toBe(true);
    expect(res.success && res.frontmostBefore).toBe('Google Chrome');
  });
});
