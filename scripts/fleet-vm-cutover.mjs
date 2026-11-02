#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const root = join(homedir(), 'Library/Application Support/humanchrome-vm-pilot');
const privateRoot = join(root, 'private');
const namespace = 'humanchrome-fleet';
const secret = 'fleet-coordinator-config';
const service = 'fleet-worker-laptop-vm-1';
const origin = 'http://humanchrome-fleet-coordinator.tail67850e.ts.net:12301';
const mode = process.argv[2];

function quote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function kubectl(args, input) {
  return new Promise((resolve, reject) => {
    const remote = ['sudo', '-n', '/usr/local/bin/k3s', 'kubectl', '-n', namespace, ...args];
    const child = spawn(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'ovh1', remote.map(quote).join(' ')],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    // Kubernetes errors can include submitted Secret data. Do not echo them.
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(stdout)
        : reject(
            new Error(`Remote kubectl ${args[0]} failed (${code}); credential output withheld.`),
          ),
    );
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') reject(error);
    });
    child.stdin.end(input);
  });
}

function configuration(snapshot) {
  return JSON.parse(Buffer.from(snapshot.data['coordinator.json'], 'base64').toString('utf8'));
}

async function api(path, token) {
  const response = await fetch(`${origin}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Coordinator ${path} returned ${response.status}.`);
  return response.json();
}

async function assertIdle(admin) {
  const leases = await api('/v1/leases', admin);
  if (!Array.isArray(leases) || leases.length !== 0) {
    throw new Error('Coordinator has active assignments; drain/release them before cutover.');
  }
}

async function waitForRouting(expectedWorkers, admin) {
  const expected = new Set(expectedWorkers.map((worker) => worker.id));
  const deadline = Date.now() + 90000;
  while (true) {
    const workers = await api('/v1/workers', admin);
    const profiles = await api('/v1/profiles', admin);
    const ready =
      workers.length === expected.size &&
      workers.every((worker) => expected.has(worker.id) && worker.available) &&
      [...expected].every((id) =>
        profiles.some(
          (profile) =>
            profile.worker === id &&
            profile.available &&
            profile.enabled &&
            profile.state === 'healthy',
        ),
      );
    if (ready) return { workers, profiles };
    if (Date.now() >= deadline) {
      throw new Error(
        'Coordinator restarted but the configured worker browsers did not become healthy.',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function prepareService(worker, dnsName) {
  if (!/^[a-z0-9-]+\.tail[a-z0-9]+\.ts\.net\.?$/.test(dnsName)) {
    throw new Error('Guest must have a verified Tailscale MagicDNS identity.');
  }
  const existingText = await kubectl([
    'get',
    'service',
    service,
    '--ignore-not-found',
    '-o',
    'json',
  ]);
  if (existingText.trim()) {
    const existing = JSON.parse(existingText);
    if (existing.metadata.labels?.['app.kubernetes.io/managed-by'] !== 'humanchrome-vm-pilot') {
      throw new Error('Refusing to replace an unowned worker egress Service.');
    }
  }
  const resource = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: service,
      namespace,
      labels: { 'app.kubernetes.io/managed-by': 'humanchrome-vm-pilot' },
      annotations: { 'tailscale.com/tailnet-fqdn': dnsName.replace(/\.$/, '') },
    },
    spec: {
      type: 'ExternalName',
      externalName: 'placeholder.invalid',
      ports: [{ name: 'http', protocol: 'TCP', port: worker.port }],
    },
  };
  await kubectl(['apply', '-f', '-'], JSON.stringify(resource));
  await kubectl([
    'wait',
    '--for=condition=TailscaleProxyReady',
    `service/${service}`,
    '--timeout=180s',
  ]);
}

async function main() {
  if (!['apply', 'rollback'].includes(mode)) {
    throw new Error('Usage: node scripts/fleet-vm-cutover.mjs apply|rollback');
  }
  const deployment = JSON.parse(await readFile(join(root, 'deployment.json'), 'utf8'));
  if (deployment.owner !== 'humanchrome-vm-pilot' || deployment.workerId !== 'laptop-vm-1') {
    throw new Error('Unrecognized VM deployment.');
  }
  const snapshot = JSON.parse(await kubectl(['get', 'secret', secret, '-o', 'json']));
  const config = configuration(snapshot);
  const admin = config.clients.find((client) => client.admin)?.token;
  if (!admin) throw new Error('Coordinator has no admin credential.');
  await assertIdle(admin);
  let workers;
  if (mode === 'apply') {
    const worker = JSON.parse(await readFile(join(privateRoot, 'guest-worker.json'), 'utf8'));
    const identity = JSON.parse(await readFile(join(root, 'guest-network.json'), 'utf8'));
    if (worker.id !== deployment.workerId || worker.port !== 12310 || worker.token.length < 32) {
      throw new Error('Guest worker identity or credential is invalid.');
    }
    const inventoryResponse = await fetch(`http://${worker.host}:${worker.port}/v1/worker`, {
      headers: { Authorization: `Bearer ${worker.token}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!inventoryResponse.ok)
      throw new Error(`Guest inventory returned ${inventoryResponse.status}.`);
    const inventory = await inventoryResponse.json();
    if (
      inventory.id !== worker.id ||
      !inventory.profiles?.some(
        (profile) =>
          profile.name === 'browser' &&
          profile.enabled &&
          profile.state === 'healthy' &&
          profile.labels?.includes('research'),
      )
    ) {
      throw new Error('Guest research browser has not proven healthy.');
    }
    await prepareService(worker, identity.dnsName);
    workers = [
      {
        id: worker.id,
        url: `http://${service}.${namespace}.svc.cluster.local:${worker.port}`,
        token: worker.token,
      },
    ];
    if (JSON.stringify(config.workers) === JSON.stringify(workers)) {
      console.log('The VM is already the sole configured worker; no restart performed.');
      console.log(JSON.stringify(await waitForRouting(workers, admin), null, 2));
      return;
    }
    const backupPath = join(privateRoot, 'coordinator-before-cutover.json');
    try {
      await writeFile(backupPath, JSON.stringify(snapshot), { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const backup = JSON.parse(await readFile(backupPath, 'utf8'));
      const previous = configuration(backup);
      if (
        backup.metadata.uid !== snapshot.metadata.uid ||
        previous.id !== config.id ||
        JSON.stringify(previous.workers) !== JSON.stringify(config.workers)
      ) {
        throw new Error(
          'Existing rollback snapshot belongs to a different pre-cutover worker inventory.',
        );
      }
    }
  } else {
    const before = JSON.parse(
      await readFile(join(privateRoot, 'coordinator-before-cutover.json'), 'utf8'),
    );
    const previous = configuration(before);
    if (previous.id !== config.id) throw new Error('Rollback belongs to a different coordinator.');
    workers = previous.workers;
  }
  // Preserve current clients, database identity and settings, including later credential rotations.
  const next = { ...config, workers };
  await assertIdle(admin);
  const patch = [
    { op: 'test', path: '/metadata/resourceVersion', value: snapshot.metadata.resourceVersion },
    {
      op: 'replace',
      path: '/data/coordinator.json',
      value: Buffer.from(JSON.stringify(next)).toString('base64'),
    },
  ];
  await kubectl(
    ['patch', 'secret', secret, '--type=json', '--patch-file=/dev/stdin', '-o', 'name'],
    JSON.stringify(patch),
  );
  await kubectl(['rollout', 'restart', 'deployment/fleet-coordinator']);
  await kubectl(['rollout', 'status', 'deployment/fleet-coordinator', '--timeout=180s']);
  for (const path of ['/healthz', '/readyz']) {
    const response = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Post-cutover ${path} returned ${response.status}.`);
  }
  console.log(JSON.stringify({ mode, ...(await waitForRouting(workers, admin)) }, null, 2));
}

main().catch((error) => {
  console.error(`fleet-vm-cutover: ${error.message}`);
  process.exitCode = 1;
});
