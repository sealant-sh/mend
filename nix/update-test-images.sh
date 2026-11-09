#!/usr/bin/env bash
set -euo pipefail

jq() { nix run nixpkgs#jq -- "$@"; }
skopeo() { nix run nixpkgs#skopeo -- "$@"; }

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
docker_dir="$root/deploy/docker"
out="$root/nix/test-images.json"

version=$(jq -r .version "$root/apps/cli/package.json")
repository=$(jq -r .mendImageRepository "$docker_dir/setup-contract.v2.json")

mapfile -t images < <(
  printf '%s\n' "$repository:$version"
  sed -nE 's/^ +image: +([a-z0-9][^ $]*) *$/\1/p' \
    "$docker_dir/compose.v2.yaml" "$docker_dir/compose.edge.yaml" "$docker_dir/compose.mirrors.yaml" |
    sort -u
)

entries=()
for image in "${images[@]}"; do
  name=${image%:*}
  tag=${image##*:}
  digest=$(skopeo inspect --raw "docker://$name:$tag" | jq -r '
    if .manifests then
      [.manifests[] | select(.platform.os == "linux" and .platform.architecture == "amd64")][0].digest
    else empty end')
  if [[ -z $digest || $digest == null ]]; then
    digest=$(skopeo inspect --override-os linux --override-arch amd64 --format '{{.Digest}}' "docker://$name:$tag")
  fi
  echo "prefetching $name:$tag at $digest (linux/amd64)" >&2
  entries+=("$(
    nix run nixpkgs#nix-prefetch-docker -- --quiet --json --os linux --arch amd64 \
      --image-name "$name" --image-digest "$digest" --final-image-name "$name" --final-image-tag "$tag"
  )")
done

printf '%s\n' "${entries[@]}" |
  jq -s 'map({ key: "\(.finalImageName):\(.finalImageTag)", value: . }) | from_entries' >"$out"
echo "wrote $out" >&2
