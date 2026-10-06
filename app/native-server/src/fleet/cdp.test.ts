import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import {
  assertKeychainReadable,
  CdpPipe,
  chromeArgs,
  findChromeForProfile,
  killChromeGroup,
  readExtensionManifest,
  terminateChrome,
} from './cdp';

function fixture() {
  const written: string[] = [];
  const input = new Writable({
    write(chunk, _encoding, callback) {
      written.push(chunk.toString());
      callback();
    },
  });
  const output = new PassThrough();
  return { cdp: new CdpPipe(input, output), written, output };
}

describe('CdpPipe framing', () => {
  test('resolves a response split across chunk boundaries', async () => {
    const { cdp, written, output } = fixture();
    const pending = cdp.send('Extensions.loadUnpacked', { path: '/ext' });
    output.write('{"id":1,"result":{"id":"abc"');
    output.write('}}\0');
    await expect(pending).resolves.toEqual({ id: 1, result: { id: 'abc' } });
    expect(JSON.parse(written[0].replace(/\0$/, ''))).toEqual({
      id: 1,
      method: 'Extensions.loadUnpacked',
      params: { path: '/ext' },
    });
  });

  test('resolves several in-flight requests independently and skips events', async () => {
    const { cdp, output } = fixture();
    const first = cdp.send('Target.getTargets');
    const second = cdp.send('Extensions.loadUnpacked', { path: '/ext' });
    output.write('{"method":"Target.targetCreated","params":{}}\0');
    output.write('{"id":2,"result":{"id":"dhab"}}\0{"id":1,"result":{"targetInfos":[]}}\0');
    await expect(second).resolves.toEqual({ id: 2, result: { id: 'dhab' } });
    await expect(first).resolves.toEqual({ id: 1, result: { targetInfos: [] } });
  });

  test('ignores a malformed frame without stalling the next response', async () => {
    const { cdp, output } = fixture();
    const pending = cdp.send('Extensions.loadUnpacked', { path: '/ext' });
    output.write('not json\0{"id":1,"result":{"id":"dhab"}}\0');
    await expect(pending).resolves.toEqual({ id: 1, result: { id: 'dhab' } });
  });

  test('surfaces a CDP error response', async () => {
    const { cdp, output } = fixture();
    const pending = cdp.loadUnpacked('/missing');
    output.write('{"id":1,"error":{"message":"Extension not found"}}\0');
    await expect(pending).rejects.toThrow('Extensions.loadUnpacked failed: Extension not found');
  });

  test('rejects when the response carries no extension id', async () => {
    const { cdp, output } = fixture();
    const pending = cdp.loadUnpacked('/ext');
    output.write('{"id":1,"result":{}}\0');
    await expect(pending).rejects.toThrow('returned no extension id');
  });

  test('times out a request the browser never answers', async () => {
    const { cdp } = fixture();
    await expect(cdp.send('Target.getTargets', {}, 20)).rejects.toThrow('cdp timeout');
  });

  test('rejects sends after dispose', async () => {
    const { cdp } = fixture();
    cdp.dispose();
    await expect(cdp.send('Target.getTargets')).rejects.toThrow('cdp pipe closed');
  });

  test('dispose is idempotent', () => {
    const { cdp } = fixture();
    cdp.dispose();
    expect(() => cdp.dispose()).not.toThrow();
  });
});

describe('chromeArgs', () => {
  test('launches the profile with the DevTools protocol on stdio and no debug port', () => {
    const args = chromeArgs('/profiles/p01');
    expect(args).toContain('--user-data-dir=/profiles/p01');
    expect(args).toContain('--remote-debugging-pipe');
    expect(args.some((arg) => arg.startsWith('--remote-debugging-port'))).toBe(false);
  });

  test('hides the debug pipe from pages, or Google refuses to sign the browser in', () => {
    // The pipe sets navigator.webdriver; Google's sign-in rejects such a browser.
    expect(chromeArgs('/profiles/p01')).toContain('--disable-blink-features=AutomationControlled');
  });
});

describe('readExtensionManifest', () => {
  test('reports the rebuild command when the build directory is gone', async () => {
    await expect(readExtensionManifest('/nonexistent-extension-dir')).rejects.toThrow(
      'pnpm build:extension',
    );
  });
});

describe('killChromeGroup', () => {
  test('signals the whole process group', () => {
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
    killChromeGroup(4242, 'SIGKILL');
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
    kill.mockRestore();
  });

  test('falls back to the bare pid when the group is already gone', () => {
    const kill = jest.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      if (pid < 0) throw new Error('ESRCH');
      return true;
    }) as typeof process.kill);
    killChromeGroup(4242, 'SIGTERM');
    expect(kill).toHaveBeenNthCalledWith(1, -4242, 'SIGTERM');
    expect(kill).toHaveBeenNthCalledWith(2, 4242, 'SIGTERM');
    kill.mockRestore();
  });

  test('no-ops for a missing or invalid pid', () => {
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
    killChromeGroup(0, 'SIGKILL');
    killChromeGroup(-1, 'SIGKILL');
    expect(kill).not.toHaveBeenCalled();
    kill.mockRestore();
  });

  test('swallows the error when the pid has already exited', () => {
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });
    expect(() => killChromeGroup(4242, 'SIGKILL')).not.toThrow();
    kill.mockRestore();
  });
});

describe('findChromeForProfile', () => {
  const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const DIR = '/fleet/profiles/p01';

  test('returns only the browser process, sorted ascending', async () => {
    const ps = [
      `  900 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/Current/Helpers/Google Chrome Helper (Renderer) --user-data-dir=${DIR} --remote-debugging-pipe`,
      `  700 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${DIR} --remote-debugging-pipe`,
      `  901 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/Current/Helpers/Google Chrome Helper (GPU) --user-data-dir=${DIR}`,
      `  800 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${DIR} --remote-debugging-pipe`,
      `  800 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/fleet/profiles/p02`,
      `  800 /Applications/Chromium.app/Contents/MacOS/Chromium --user-data-dir=${DIR}`,
    ].join('\n');
    await expect(findChromeForProfile(CHROME, DIR, async () => ps)).resolves.toEqual([700, 800]);
  });

  test('degrades to no adoption when ps is unavailable', async () => {
    const failing = async () => {
      throw new Error('ps: command not found');
    };
    await expect(findChromeForProfile(CHROME, DIR, failing)).resolves.toEqual([]);
  });
});

describe('CdpPipe disposal', () => {
  test('an in-flight send rejects immediately when the pipe is disposed', async () => {
    const { cdp } = fixture();
    const pending = cdp.send('Storage.getCookies', {}, 15_000);
    const started = Date.now();
    cdp.dispose();
    // The 15s default must not be waited out: a closed pipe is not a timeout.
    await expect(pending).rejects.toThrow(/cdp pipe closed/);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test('a writer error disposes the pipe instead of throwing unhandled', async () => {
    const { cdp } = fixture();
    // The writer is captured by the pipe; an EPIPE there must close the pipe
    // rather than surface as an uncaught 'error' event.
    const input = (cdp as unknown as { input: Writable }).input;
    expect(() => input.emit('error', new Error('EPIPE'))).not.toThrow();
    await expect(cdp.send('Storage.getCookies')).rejects.toThrow(/cdp pipe closed/);
  });

  test('a send after disposal is refused without a round trip', async () => {
    const { cdp } = fixture();
    cdp.dispose();
    await expect(cdp.send('Target.getTargets')).rejects.toThrow(/cdp pipe closed/);
  });
});

describe('assertKeychainReadable', () => {
  test('passes where the login Keychain is readable', async () => {
    const calls: Array<[string, string[]]> = [];
    await assertKeychainReadable(async (file, args) => {
      calls.push([file, args]);
    }, 'darwin');
    // Settings only: the check must never read an item, let alone a secret.
    expect(calls).toEqual([['/usr/bin/security', ['show-keychain-info']]]);
  });

  test('refuses an SSH session, naming the Keychain error', async () => {
    const locked = Object.assign(new Error('Command failed'), {
      stderr: 'security: SecKeychainCopySettings <NULL>: User interaction is not allowed.\n',
    });
    await expect(
      assertKeychainReadable(async () => {
        throw locked;
      }, 'darwin'),
    ).rejects.toThrow(
      'this session cannot read the login Keychain (security: SecKeychainCopySettings <NULL>: ' +
        'User interaction is not allowed.)',
    );
  });

  test('is a no-op off macOS, where Chrome keeps no Keychain key', async () => {
    await assertKeychainReadable(async () => {
      throw new Error('must not run');
    }, 'linux');
  });
});

describe('terminateChrome', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('SIGTERMs the group and stops polling once the pid is gone', async () => {
    let alive = true;
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => {
      if (!alive) throw new Error('ESRCH');
      return true;
    });
    setTimeout(() => {
      alive = false;
    }, 250);

    await terminateChrome(4242, 5_000);

    // Signal 0 is the liveness probe, not a kill.
    const signals = kill.mock.calls.map(([, signal]) => signal).filter(Boolean);
    expect(signals[0]).toBe('SIGTERM');
    // It returns as soon as the process is gone rather than polling out the
    // whole grace period, so no escalation is ever sent.
    expect(signals.every((signal) => signal === 'SIGTERM')).toBe(true);
  });

  test('escalates to SIGKILL when the group refuses to exit', async () => {
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
    await terminateChrome(4242, 300);
    const signals = kill.mock.calls.map(([, signal]) => signal).filter(Boolean);
    expect(signals[0]).toBe('SIGTERM');
    expect(signals.at(-1)).toBe('SIGKILL');
  });

  test('a pid of zero is a no-op, not a signal to the process group', async () => {
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
    await terminateChrome(0);
    expect(kill).not.toHaveBeenCalled();
  });
});
