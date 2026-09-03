#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Builds LittlePad for LINUX (.deb, .rpm, .AppImage) inside Docker.
# Works on any host with Docker (Linux, macOS, Windows+WSL/Git Bash).
#
# The image (docker/linux.Dockerfile) only holds the toolchain — the repo
# itself is bind-mounted in at run time (see the -v "$PWD:/app" below), so
# every run builds whatever is actually on disk right now. This means
# rebuilding the image (--no-cache or otherwise) is only ever needed when
# the toolchain/system deps change, never just to pick up code changes.
#
# The build container runs as the current host user (--user "$(id -u):$(id
# -g)"), not root — so everything it writes into the bind-mounted repo
# (dist/, src-tauri/icons/, out/…) comes back owned by you, not root, and
# you can delete/edit it normally afterwards. Step 2 below also fixes up
# any of those same paths a much older version of this script left owned
# by root, so that's true even on a repo this script has touched before.
#
# Usage:  ./scripts/build-linux.sh [--no-cache]
# Output: ./out/
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE=littlepad-builder-linux
HOST_UID="$(id -u)"
HOST_GID="$(id -g)"
CACHE_VOLUMES=(littlepad-node-modules littlepad-npm-cache littlepad-cargo littlepad-target-linux)
# Build outputs that could exist directly in the bind-mounted repo (as
# opposed to node_modules/cargo/target, which live in the named volumes
# above instead) — narrowly scoped on purpose, see step 2 below. Paths only,
# checked for existence before touching anything.
REPO_OWNED_PATHS=(
  node_modules
  package-lock.json
  dist
  out
  src-tauri/icons
  src-tauri/gen
)
DOCKER_ARGS=()
[[ "${1:-}" == "--no-cache" ]] && DOCKER_ARGS+=(--no-cache)

echo "── [1/3] Building image ${IMAGE} ──"
# Context is docker/ (not the repo root): the Dockerfile no longer COPYs
# anything from it — see its header comment — so there's nothing the repo
# root would add here, only slow the build context transfer down.
# Not "${DOCKER_ARGS[@]}" directly: macOS's default /bin/bash (3.2) throws
# "unbound variable" under `set -u` when expanding an empty array, even
# though it's declared — ${#DOCKER_ARGS[@]} (just counting) doesn't trigger
# that bug, so branch on it instead (see build-macos.sh for the same fix).
if [[ ${#DOCKER_ARGS[@]} -gt 0 ]]; then
  docker build "${DOCKER_ARGS[@]}" -t "$IMAGE" -f docker/linux.Dockerfile docker/
else
  docker build -t "$IMAGE" -f docker/linux.Dockerfile docker/
fi

echo "── [2/3] Fixing ownership of the repo's build outputs and cached volumes (${HOST_UID}:${HOST_GID}) ──"
# The named volumes below persist Rust/npm caches across runs (see step 3)
# and are created empty, owned by root, the first time each is used.
# REPO_OWNED_PATHS covers the flip side: build outputs that a much older
# version of this script (from before it ran step 3 as the host user) could
# have left behind owned by root directly in the bind-mounted repo — fixed
# here too so a stale one doesn't need `sudo` to clean up, ever. Narrowly
# scoped to just those specific paths (never the whole repo) so this can't
# touch anything of yours it has no business touching.
#
# Either way, a quick throwaway root container fixes it upfront so step 3,
# run as the host user, can actually write into (or over) all of it.
VOLUME_MOUNTS=()
for v in "${CACHE_VOLUMES[@]}"; do
  docker volume create "$v" >/dev/null
  VOLUME_MOUNTS+=(-v "$v:/vol/$v")
done
REPO_PATH_ARGS=("${REPO_OWNED_PATHS[@]/#//app/}")
docker run --rm \
  -v "$PWD:/app" \
  "${VOLUME_MOUNTS[@]}" \
  -e "HOST_UID=${HOST_UID}" \
  -e "HOST_GID=${HOST_GID}" \
  alpine sh -c '
    chown -R "$HOST_UID:$HOST_GID" /vol
    for p in "$@"; do
      [ -e "$p" ] && chown -R "$HOST_UID:$HOST_GID" "$p"
    done
  ' _ "${REPO_PATH_ARGS[@]}"

echo "── [3/3] Building (artifacts → ./out) ──"
mkdir -p out
docker run --rm \
  --user "${HOST_UID}:${HOST_GID}" \
  -v "$PWD:/app" \
  -v "$PWD/out:/out" \
  -v littlepad-node-modules:/app/node_modules \
  -v littlepad-npm-cache:/npm-cache \
  -v littlepad-cargo:/usr/local/cargo/registry \
  -v littlepad-target-linux:/app/target \
  "$IMAGE"

echo "✔ Linux OK — artifacts in ./out/"
