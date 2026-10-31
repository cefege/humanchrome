import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, copyFile, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, isolatedRun } from './process-host.mjs';

export async function verify() {
  await isolatedRun(async (scope) => {
    const cli = join(ROOT, 'target/release', process.platform === 'win32' ? 'humanchrome-bridge.exe' : 'humanchrome-bridge');
    const source = join(ROOT, 'target/release', process.platform === 'win32' ? 'humanchrome-nativehost.exe' : 'humanchrome-nativehost');
    const host = join(scope.directory, process.platform === 'win32' ? 'candidate-nativehost.exe' : 'candidate-nativehost');
    await copyFile(source, host);
    if (process.platform !== 'win32') await chmod(host, 0o755);
    async function run(args, success = true) {
      const child = scope.spawn(cli, args);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
      let code;
      try { [code] = await once(child, 'exit'); } finally { clearTimeout(timer); }
      const diagnostic = `${args.join(' ')}: exit ${code}\n${stdout}\n${stderr}`;
      if (success) assert.equal(code, 0, diagnostic);
      else assert.notEqual(code, 0, diagnostic);
      return { stdout, stderr };
    }
    await run(['register', '--host-path', host, '--browser', 'chrome']);
    const manifestPath = process.platform === 'darwin'
      ? join(scope.env.HOME, 'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.humanchrome.nativehost.json')
      : join(scope.env.XDG_CONFIG_HOME, 'google-chrome/NativeMessagingHosts/com.humanchrome.nativehost.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.equal(manifest.name, 'com.humanchrome.nativehost');
    assert.equal(manifest.path, await realpath(host));
    assert.equal(manifest.type, 'stdio');
    assert(manifest.allowed_origins.includes('chrome-extension://hbdgbgagpkpjffpklnamcljpakneikee/'));
    await run(['unregister', '--host-path', host, '--browser', 'chrome']);
    await assert.rejects(stat(manifestPath), { code: 'ENOENT' });
    await run(['register', '--host-path', host, '--browser', 'chrome']);
    const foreign = { ...manifest, path: '/not-the-registered-candidate' };
    await writeFile(manifestPath, JSON.stringify(foreign));
    await run(['unregister', '--host-path', host, '--browser', 'chrome'], false);
    assert.deepEqual(JSON.parse(await readFile(manifestPath, 'utf8')), foreign, 'unregister must preserve a replacement it does not own');
    if (process.platform !== 'win32') {
      await chmod(host, 0o600);
      await run(['register', '--host-path', host, '--browser', 'chromium'], false);
      await run(['fix-permissions', '--host-path', host]);
      assert.notEqual((await stat(host)).mode & 0o111, 0);
    }
    const config = join(scope.directory, 'stdio-config.json');
    await writeFile(config, JSON.stringify({ url: 'http://127.0.0.1:12306/mcp?session=fixture', extra: { retained: true } }));
    await run(['update-port', '14306', '--config', config]);
    assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), { url: 'http://127.0.0.1:14306/mcp?session=fixture', extra: { retained: true } });
    const before = await readFile(config, 'utf8');
    await run(['update-port', '0', '--config', config], false);
    assert.equal(await readFile(config, 'utf8'), before);
  });
  console.log('PASS native CLI: temporary-HOME registration, canonical host path, foreign manifest preservation, permissions and stdio configuration');
}
