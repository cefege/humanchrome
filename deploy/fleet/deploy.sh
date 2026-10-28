#!/usr/bin/env bash
set -euo pipefail

namespace=humanchrome-fleet
require_tailscale=true
image=

usage() {
  cat <<'USAGE'
Usage: deploy.sh --image <repository:unique-tag> [--namespace <name>] [--without-tailscale]

Applies the coordinator, its durable PostgreSQL store, and private Tailscale
ingress configuration. Before running:
  1. Install the Tailscale Kubernetes Operator.
  2. Run generate-secrets.sh with the native worker MagicDNS name and tokens.
  3. Make the supplied image available to k3s containerd (for OVH, use
     build-and-import-ovh.sh with this exact immutable image tag).

The image reference is injected by a temporary Kustomize overlay; it is never
written back to a checked-in manifest.
Use --without-tailscale only for the temporary SSH-port-forward validation
stage while OAuth/operator prerequisites are unavailable. It leaves the Service
ClusterIP-only and does not claim a private Tailscale deployment.
USAGE
}

while (($#)); do
  case "$1" in
    --namespace) namespace=$2; shift 2 ;;
    --image) image=$2; shift 2 ;;
    --without-tailscale) require_tailscale=false; shift ;;
    --help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$image" || "${image##*/}" != *:* ]]; then
  printf '%s\n' '--image must include a unique repository tag' >&2
  exit 2
fi
for binary in kubectl; do
  if ! command -v "$binary" >/dev/null; then
    printf '%s is required\n' "$binary" >&2
    exit 127
  fi
done

image_name=${image%:*}
image_tag=${image##*:}
if [[ "$image_name" == "$image" || "$image_tag" == */* ]]; then
  printf '%s\n' '--image must have a tag after its final slash' >&2
  exit 2
fi

if "$require_tailscale"; then
  kubectl get crd proxygroups.tailscale.com >/dev/null
  kubectl -n tailscale get deployment operator >/dev/null
fi
kubectl -n "$namespace" get secret fleet-postgres >/dev/null
kubectl -n "$namespace" get secret fleet-coordinator-config >/dev/null
kubectl -n "$namespace" get service fleet-worker >/dev/null

root=$(cd "$(dirname "$0")/../.." && pwd)
tmpdir=$(mktemp -d "$root/deploy/.fleet-overlay.XXXXXX")
trap 'rm -rf "$tmpdir"' EXIT
cat >"$tmpdir/kustomization.yaml" <<EOF
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: $namespace
resources:
  - ../fleet
images:
  - name: humanchrome-coordinator
    newName: $image_name
    newTag: $image_tag
EOF

kubectl kustomize "$tmpdir" --load-restrictor LoadRestrictionsNone | kubectl apply -f -
kubectl -n "$namespace" rollout status statefulset/fleet-postgres --timeout=10m
if "$require_tailscale"; then
  kubectl -n "$namespace" wait service/fleet-worker --for=condition=TailscaleProxyReady=true --timeout=5m
else
  printf '%s\n' 'Skipping Tailscale readiness: this is an SSH-port-forward-only staging deployment.'
fi
kubectl -n "$namespace" rollout restart deployment/fleet-coordinator
kubectl -n "$namespace" rollout status deployment/fleet-coordinator --timeout=10m
printf 'Fleet coordinator deployed with image %s. Run verify.sh for health and identity-state checks.\n' "$image"
