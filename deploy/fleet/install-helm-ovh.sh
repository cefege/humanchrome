#!/usr/bin/env bash
set -euo pipefail

# Official Helm v4.3.1 linux/amd64 release and its published SHA-256.
version=v4.3.1
checksum=0403a88ae20913d11b10a2467b50087721fea7581736da6b9d3992f5357fe54b
if command -v helm >/dev/null; then
  helm version --short
  exit 0
fi
if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  printf '%s\n' 'This bootstrap is only for the verified OVH Linux amd64 node.' >&2
  exit 2
fi
for binary in curl tar sha256sum sudo; do
  command -v "$binary" >/dev/null
done
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT
archive="$tmpdir/helm-$version-linux-amd64.tar.gz"
curl --fail --silent --show-error --location "https://get.helm.sh/helm-$version-linux-amd64.tar.gz" --output "$archive"
printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check -
tar --extract --gzip --file "$archive" --directory "$tmpdir"
sudo -n install -m 0755 "$tmpdir/linux-amd64/helm" /usr/local/bin/helm
helm version --short
