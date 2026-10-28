#!/usr/bin/env bash
set -euo pipefail

namespace=humanchrome-fleet
operator_namespace=tailscale
restart_tailscale_proxies=false
require_tailscale=true

usage() {
  cat <<'USAGE'
Usage: verify.sh [--namespace <name>] [--operator-namespace <name>] [--restart-tailscale-proxies] [--without-tailscale]

Performs read-only application, egress, ingress-proxy state, and health checks.
With --restart-tailscale-proxies, rolls only the operator proxies associated
with this deployment and proves their state Secret and tailnet identity survive.
Use --without-tailscale only to verify the temporary SSH-port-forward staging
deployment before Tailscale Operator OAuth prerequisites are available.
USAGE
}

while (($#)); do
  case "$1" in
    --namespace) namespace=$2; shift 2 ;;
    --operator-namespace) operator_namespace=$2; shift 2 ;;
    --restart-tailscale-proxies) restart_tailscale_proxies=true; shift ;;
    --without-tailscale) require_tailscale=false; shift ;;
    --help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

if ! "$require_tailscale" && "$restart_tailscale_proxies"; then
  printf '%s\n' '--restart-tailscale-proxies cannot be combined with --without-tailscale' >&2
  exit 2
fi

for binary in kubectl curl; do
  if ! command -v "$binary" >/dev/null; then
    printf '%s is required\n' "$binary" >&2
    exit 127
  fi
done
if "$require_tailscale" && ! command -v jq >/dev/null; then
  printf '%s\n' 'jq is required for Tailscale proxy identity verification' >&2
  exit 127
fi

kubectl -n "$namespace" rollout status statefulset/fleet-postgres --timeout=5m
kubectl -n "$namespace" rollout status deployment/fleet-coordinator --timeout=5m
if "$require_tailscale"; then
  kubectl -n "$namespace" wait service/fleet-worker --for=condition=TailscaleProxyReady=true --timeout=5m
else
  printf '%s\n' 'Skipping Tailscale verification: this is an SSH-port-forward-only staging deployment.'
fi
kubectl -n "$namespace" get service fleet-coordinator fleet-worker
kubectl -n "$namespace" get pods -l app.kubernetes.io/part-of=humanchrome-fleet

if "$require_tailscale"; then
  proxy_statefulsets=()
  for parent_service in fleet-coordinator fleet-worker; do
    selector="tailscale.com/parent-resource-type=svc,tailscale.com/parent-resource=$parent_service,tailscale.com/parent-resource-ns=$namespace"
    while IFS= read -r statefulset; do
      [[ -n "$statefulset" ]] || continue
      proxy_statefulsets+=("$parent_service:${statefulset#statefulset.apps/}")
    done < <(kubectl -n "$operator_namespace" get statefulset -l "$selector" -o name)
  done
  if ((${#proxy_statefulsets[@]} != 2)); then
    printf '%s\n' 'Expected exactly one Tailscale proxy StatefulSet for each fleet Service; inspect the operator before accepting deployment.' >&2
    exit 1
  fi

  for proxy in "${proxy_statefulsets[@]}"; do
    parent_service=${proxy%%:*}
    statefulset=${proxy#*:}
    kubectl -n "$operator_namespace" rollout status statefulset/"$statefulset" --timeout=5m
    selector="tailscale.com/parent-resource-type=svc,tailscale.com/parent-resource=$parent_service,tailscale.com/parent-resource-ns=$namespace"
    proxy_container=$(kubectl -n "$operator_namespace" get statefulset "$statefulset" -o json | jq -er '[.spec.template.spec.containers[] | select(any(.env[]?; .name == "TS_KUBE_SECRET")) | .name][0]')
    proxy_pod=$(kubectl -n "$operator_namespace" get pod -l "$selector" --field-selector=status.phase=Running -o json | jq -er '.items | sort_by(.metadata.creationTimestamp) | .[0].metadata.name')
    state_secret=$(kubectl -n "$operator_namespace" exec "$proxy_pod" -c "$proxy_container" -- printenv TS_KUBE_SECRET)
    state_secret_uid=$(kubectl -n "$operator_namespace" get secret "$state_secret" -o jsonpath='{.metadata.uid}')
    proxy_identity=$(kubectl -n "$operator_namespace" exec "$proxy_pod" -c "$proxy_container" -- tailscale status --json | jq -er '.Self.ID // .Self.PublicKey')
    if [[ -z "$state_secret_uid" || -z "$proxy_identity" ]]; then
      printf 'Tailscale proxy %s is missing durable state or a tailnet identity.\n' "$statefulset" >&2
      exit 1
    fi
    printf 'Tailscale proxy for %s has a persistent state Secret and an active tailnet identity.\n' "$parent_service"
    if "$restart_tailscale_proxies"; then
      kubectl -n "$operator_namespace" rollout restart statefulset/"$statefulset"
      kubectl -n "$operator_namespace" rollout status statefulset/"$statefulset" --timeout=10m
      actual_secret_uid=$(kubectl -n "$operator_namespace" get secret "$state_secret" -o jsonpath='{.metadata.uid}')
      proxy_pod=$(kubectl -n "$operator_namespace" get pod -l "$selector" --field-selector=status.phase=Running -o json | jq -er '.items | sort_by(.metadata.creationTimestamp) | .[0].metadata.name')
      actual_identity=$(kubectl -n "$operator_namespace" exec "$proxy_pod" -c "$proxy_container" -- tailscale status --json | jq -er '.Self.ID // .Self.PublicKey')
      if [[ "$actual_secret_uid" != "$state_secret_uid" || "$actual_identity" != "$proxy_identity" ]]; then
        printf 'Tailscale proxy %s lost its persistent identity during recovery.\n' "$statefulset" >&2
        exit 1
      fi
    fi
  done
fi

port=
log_file=$(mktemp)
cleanup() {
  if [[ -n "${forward_pid:-}" ]]; then kill "$forward_pid" 2>/dev/null || true; fi
  rm -f "$log_file"
}
trap cleanup EXIT
kubectl -n "$namespace" port-forward service/fleet-coordinator :12301 --address=127.0.0.1 >"$log_file" 2>&1 &
forward_pid=$!
for _ in {1..30}; do
  while IFS= read -r line; do
    if [[ "$line" == "Forwarding from 127.0.0.1:"* ]]; then
      port=${line#*127.0.0.1:}
      port=${port%% *}
      break
    fi
  done <"$log_file"
  if [[ -n "$port" ]] && curl --fail --silent --show-error "http://127.0.0.1:$port/healthz" >/dev/null; then
    curl --fail --silent --show-error "http://127.0.0.1:$port/readyz" >/dev/null
    printf 'Coordinator /healthz and /readyz passed through the cluster Service.\n'
    exit 0
  fi
  if ! kill -0 "$forward_pid" 2>/dev/null; then
    cat "$log_file" >&2
    exit 1
  fi
  sleep 1
done
cat "$log_file" >&2
printf '%s\n' 'Coordinator health endpoint did not become reachable through port-forward.' >&2
exit 1
