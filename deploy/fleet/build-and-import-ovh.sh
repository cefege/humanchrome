#!/usr/bin/env bash
set -euo pipefail

image=

usage() {
  cat <<'USAGE'
Usage: build-and-import-ovh.sh --image <repository:unique-tag>

Run this on the OVH k3s node after placing this checkout there. It builds the
linux/amd64 coordinator image with the node's Docker daemon, saves it as a
temporary OCI archive, and imports it into the k3s containerd image store.
No registry credential or public image repository is required.

Use a new immutable tag for every deployment, for example:
  humanchrome-coordinator:$(git rev-parse --short=12 HEAD)
USAGE
}

while (($#)); do
  case "$1" in
    --image) image=$2; shift 2 ;;
    --help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$image" || "${image##*/}" != *:* ]]; then
  printf '%s\n' '--image must include a unique repository tag' >&2
  exit 2
fi
for binary in docker sudo; do
  if ! command -v "$binary" >/dev/null; then
    printf '%s is required\n' "$binary" >&2
    exit 127
  fi
done
if ! sudo -n /usr/local/bin/k3s ctr version >/dev/null 2>&1; then
  printf '%s\n' 'passwordless sudo access to /usr/local/bin/k3s ctr is required' >&2
  exit 1
fi

root=$(cd "$(dirname "$0")/../.." && pwd)
archive=$(mktemp "${TMPDIR:-/tmp}/humanchrome-coordinator.XXXXXX.tar")
trap 'rm -f "$archive"' EXIT

docker build --platform linux/amd64 --file "$root/Dockerfile.coordinator" --tag "$image" "$root"
docker image save --output "$archive" "$image"
sudo -n /usr/local/bin/k3s ctr images import "$archive"
printf 'Imported %s into the k3s containerd image store.\n' "$image"
