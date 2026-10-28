#!/usr/bin/env bash
set -euo pipefail

namespace=humanchrome-fleet
worker_id=mac-1
worker_fqdn=
worker_port=12310
client_id=default

usage() {
  cat <<'USAGE'
Usage: generate-secrets.sh --worker-fqdn <MagicDNS-name> [options]

Creates or updates only these private inputs in the target namespace:
  - fleet-postgres (database bootstrap credentials)
  - fleet-coordinator-config (coordinator JSON and database URL)
  - fleet-worker (Tailscale Operator egress Service)

Options:
  --namespace <name>       Kubernetes namespace (default: humanchrome-fleet)
  --worker-id <id>         Coordinator worker ID (default: mac-1)
  --worker-fqdn <fqdn>     Native worker full MagicDNS name (required)
  --worker-port <port>     Native worker HTTP port (default: 12310)
  --client-id <id>         Initial coordinator client ID (default: default)

The script prompts for the native-worker and coordinator client bearer tokens.
They are never printed or written into this repository.
USAGE
}

while (($#)); do
  case "$1" in
    --namespace) namespace=$2; shift 2 ;;
    --worker-id) worker_id=$2; shift 2 ;;
    --worker-fqdn) worker_fqdn=$2; shift 2 ;;
    --worker-port) worker_port=$2; shift 2 ;;
    --client-id) client_id=$2; shift 2 ;;
    --help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$worker_fqdn" || "$worker_fqdn" != *.* ]]; then
  printf '%s\n' '--worker-fqdn must be the worker’s full MagicDNS name' >&2
  exit 2
fi
if ! [[ "$worker_port" =~ ^[1-9][0-9]{0,4}$ ]] || ((worker_port > 65535)); then
  printf '%s\n' '--worker-port must be a TCP port from 1 through 65535' >&2
  exit 2
fi
for binary in kubectl node openssl; do
  if ! command -v "$binary" >/dev/null; then
    printf '%s is required\n' "$binary" >&2
    exit 127
  fi
done

read -r -s -p 'Native worker bearer token: ' worker_token
printf '\n'
read -r -s -p 'Coordinator client bearer token: ' client_token
printf '\n'
if ((${#worker_token} < 32 || ${#client_token} < 32)) || [[ "$worker_token" == "$client_token" ]]; then
  printf '%s\n' 'Worker and coordinator client tokens must be distinct and each contain at least 32 characters' >&2
  exit 2
fi

umask 077
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT
if kubectl -n "$namespace" get secret fleet-postgres >/dev/null 2>&1; then
  postgres_password_data=$(kubectl -n "$namespace" get secret fleet-postgres -o jsonpath='{.data.POSTGRES_PASSWORD}')
  if [[ -z "$postgres_password_data" ]]; then
    printf '%s\n' 'Existing fleet-postgres Secret has no POSTGRES_PASSWORD key' >&2
    exit 1
  fi
  postgres_password=
else
  postgres_password_data=
  postgres_password=$(openssl rand -hex 32)
fi

export namespace worker_id worker_fqdn worker_port client_id worker_token client_token postgres_password postgres_password_data tmpdir
node <<'NODE'
import { writeFileSync } from 'node:fs';

const env = process.env;
const encode = (value) => Buffer.from(value).toString('base64');
const workerUrl = `http://fleet-worker.${env.namespace}.svc.cluster.local:${env.worker_port}`;
const coordinator = {
  id: 'ovh-fleet-coordinator',
  host: '0.0.0.0',
  port: 12301,
  leaseTtlSec: 900,
  clients: [{ id: env.client_id, token: env.client_token, admin: true }],
  workers: [{ id: env.worker_id, url: workerUrl, token: env.worker_token }],
};
const postgresPassword = env.postgres_password_data
  ? Buffer.from(env.postgres_password_data, 'base64').toString('utf8')
  : env.postgres_password;
const postgresPasswordData = env.postgres_password_data || encode(postgresPassword);
const databaseUrl = `postgresql://fleet:${encodeURIComponent(postgresPassword)}@fleet-postgres.${env.namespace}.svc.cluster.local:5432/fleet`;
const secrets = {
  apiVersion: 'v1',
  kind: 'List',
  items: [
    {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'fleet-postgres', namespace: env.namespace },
      type: 'Opaque',
      data: {
        POSTGRES_DB: encode('fleet'),
        POSTGRES_USER: encode('fleet'),
        POSTGRES_PASSWORD: postgresPasswordData,
      },
    },
    {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'fleet-coordinator-config', namespace: env.namespace },
      type: 'Opaque',
      data: {
        'coordinator.json': encode(`${JSON.stringify(coordinator, null, 2)}\n`),
        coordinatorDatabaseUrl: encode(databaseUrl),
      },
    },
  ],
};
const egressService = {
  apiVersion: 'v1',
  kind: 'Service',
  metadata: {
    name: 'fleet-worker',
    namespace: env.namespace,
    labels: {
      'app.kubernetes.io/name': 'fleet-worker-egress',
      'app.kubernetes.io/part-of': 'humanchrome-fleet',
    },
    annotations: {
      'tailscale.com/tailnet-fqdn': env.worker_fqdn,
    },
  },
  spec: {
    type: 'ExternalName',
    externalName: 'placeholder.invalid',
    ports: [{ name: 'http', protocol: 'TCP', port: Number(env.worker_port) }],
  },
};
writeFileSync(`${env.tmpdir}/secrets.json`, `${JSON.stringify(secrets)}\n`, { mode: 0o600 });
writeFileSync(`${env.tmpdir}/egress-service.json`, `${JSON.stringify(egressService)}\n`, { mode: 0o600 });
NODE

kubectl apply -f "$(dirname "$0")/namespace.yaml"
kubectl apply -f "$tmpdir/secrets.json"
kubectl apply -f "$tmpdir/egress-service.json"
printf 'Generated private coordinator configuration and fleet-worker egress Service in namespace %s.\n' "$namespace"
