#!/usr/bin/env bash
set -euo pipefail

namespace=tailscale
release=tailscale-operator
chart_version=1.98.4

usage() {
  cat <<'USAGE'
Usage: install-tailscale-operator.sh [options]

Installs the pinned Tailscale Kubernetes Operator using a pre-created OAuth
Secret. It does not enable Funnel or public ingress.

Options:
  --namespace <name>        Operator namespace (default: tailscale)
  --release <name>          Helm release name (default: tailscale-operator)
  --chart-version <version> Chart version (default: 1.98.4)

Before running, create Tailscale ACL tags tag:k8s-operator and tag:k8s, make
 tag:k8s-operator an owner of tag:k8s, and create an OAuth client with write
scope for Services, Devices/Core, and Keys/Auth Keys tagged tag:k8s-operator.
USAGE
}

while (($#)); do
  case "$1" in
    --namespace) namespace=$2; shift 2 ;;
    --release) release=$2; shift 2 ;;
    --chart-version) chart_version=$2; shift 2 ;;
    --help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

for binary in kubectl helm node; do
  if ! command -v "$binary" >/dev/null; then
    printf '%s is required\n' "$binary" >&2
    exit 127
  fi
done

read -r -p 'Tailscale OAuth client ID: ' oauth_client_id
read -r -s -p 'Tailscale OAuth client secret: ' oauth_client_secret
printf '\n'
if [[ -z "$oauth_client_id" || -z "$oauth_client_secret" ]]; then
  printf '%s\n' 'Both OAuth credential fields are required' >&2
  exit 2
fi

umask 077
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT
export namespace oauth_client_id oauth_client_secret tmpdir
node <<'NODE'
import { writeFileSync } from 'node:fs';
const encode = (value) => Buffer.from(value).toString('base64');
const secret = {
  apiVersion: 'v1',
  kind: 'Secret',
  metadata: { name: 'operator-oauth', namespace: process.env.namespace },
  type: 'Opaque',
  data: {
    client_id: encode(process.env.oauth_client_id),
    client_secret: encode(process.env.oauth_client_secret),
  },
};
writeFileSync(`${process.env.tmpdir}/operator-oauth.json`, `${JSON.stringify(secret)}\n`, { mode: 0o600 });
NODE

kubectl create namespace "$namespace" --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f "$tmpdir/operator-oauth.json"
helm repo add tailscale https://pkgs.tailscale.com/helmcharts
helm repo update tailscale
helm upgrade --install "$release" tailscale/tailscale-operator \
  --namespace "$namespace" \
  --version "$chart_version" \
  --set installCRDs=true \
  --set 'operatorConfig.defaultTags[0]=tag:k8s-operator' \
  --set 'proxyConfig.defaultTags=tag:k8s' \
  --wait
kubectl -n "$namespace" rollout status deployment/operator --timeout=5m
kubectl get crd proxygroups.tailscale.com >/dev/null
printf 'Tailscale operator %s is ready in namespace %s.\n' "$release" "$namespace"
