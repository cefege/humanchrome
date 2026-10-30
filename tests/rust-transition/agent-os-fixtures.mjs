import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executable, frame, isolatedRun, NativePeer } from './process-host.mjs';
import { agentFleetReference } from './agent-fleet-reference.mjs';

// Controlled OS processes exercise error classification without opening a desktop dialog.
// This is not visual proof of the native picker UI.
export async function verifyMacOsRoutes() {
  assert.equal(process.platform, 'darwin', 'macOS picker boundary requires macOS');
  const reference = await agentFleetReference();
  assert.deepEqual(await exercise(), reference.agentOs, 'picker command failure diverged from the captured Node contract');
  console.log('PASS macOS picker boundary: command failure is HTTP 500, user cancellation is HTTP 200; no desktop dialog opened');
}

async function exercise() {
  return isolatedRun(async (scope) => {
    const bin = join(scope.directory, 'os-fault-bin');
    await mkdir(bin);
    await writeFile(join(bin, 'osascript'), `#!${process.execPath}\nprocess.stderr.write('controlled picker failure\\n'); process.exit(Number(process.env.HC_OS_PICKER_EXIT));\n`, { mode: 0o755 });
    const [command, args] = executable();
    const results = [];
    // Each process captures the outcome once; no process-global test mode is added to the app.
    for (const exitCode of [1, 42]) {
      await isolatedRun(async (childScope) => {
        const peer = new NativePeer(childScope.spawn(command, args, {
          PATH: `${bin}:${process.env.PATH}`, HUMANCHROME_TOKEN: '', HC_OS_PICKER_EXIT: String(exitCode),
        }));
        const started = await peer.exchange(frame({ type: 'start', payload: { port: childScope.port, extensionId: 'os-fault-probe' } }));
        assert.equal(started.type, 'server_started');
        const response = await fetch(`http://127.0.0.1:${childScope.port}/agent/projects/pick-directory`, { method: 'POST', signal: AbortSignal.timeout(10_000) });
        const body = await response.json();
        if (exitCode === 1) {
          assert.equal(response.status, 200);
          assert.deepEqual(body, { success: false, cancelled: true });
        } else {
          assert.equal(response.status, 500, 'OS failure must remain observable rather than suppressing it as cancellation');
          assert.equal(body.success, false);
          assert.equal(body.cancelled, undefined);
          assert.equal(typeof body.error, 'string');
        }
        results.push({ exitCode, status: response.status, body });
      });
    }
    return results;
  });
}

 

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  verifyMacOsRoutes().catch((error) => { console.error(error); process.exitCode = 1; });
}
