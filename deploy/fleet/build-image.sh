#!/usr/bin/env bash
set -euo pipefail

image=
push=false

usage() {
  cat <<'USAGE'
Usage: build-image.sh --image <registry/repository:tag> [--push]

Builds a linux/amd64 coordinator image from Dockerfile.coordinator. Use --push
for an image registry reachable by the OVH k3s node. Without --push, buildx
loads the image into the local Docker daemon for inspection only.
USAGE
}

while (($#)); do
  case "$1" in
    --image) image=$2; shift 2 ;;
    --push) push=true; shift ;;
    --help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$image" || "${image##*/}" != *:* ]]; then
  printf '%s\n' '--image must include a registry/repository tag' >&2
  exit 2
fi
if ! command -v docker >/dev/null; then
  printf '%s\n' 'docker with buildx is required' >&2
  exit 127
fi

root=$(cd "$(dirname "$0")/../.." && pwd)
args=(buildx build --platform linux/amd64 --file "$root/Dockerfile.coordinator" --tag "$image")
if "$push"; then
  args+=(--push)
else
  args+=(--load)
fi
args+=("$root")
docker "${args[@]}"
printf 'Built coordinator image %s.\n' "$image"
