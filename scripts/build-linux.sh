#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Builds LittlePad for LINUX (.deb, .rpm, .AppImage) inside Docker.
# Works on any host with Docker (Linux, macOS, Windows+WSL/Git Bash).
#
# Usage:  ./scripts/build-linux.sh [--no-cache]
# Output: ./out/
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE=littlepad-builder-linux
DOCKER_ARGS=()
[[ "${1:-}" == "--no-cache" ]] && DOCKER_ARGS+=(--no-cache)

echo "── [1/2] Building image ${IMAGE} ──"
# Not "${DOCKER_ARGS[@]}" directly: macOS's default /bin/bash (3.2) throws
# "unbound variable" under `set -u` when expanding an empty array, even
# though it's declared — ${#DOCKER_ARGS[@]} (just counting) doesn't trigger
# that bug, so branch on it instead (see build-macos.sh for the same fix).
if [[ ${#DOCKER_ARGS[@]} -gt 0 ]]; then
  docker build "${DOCKER_ARGS[@]}" -t "$IMAGE" -f docker/linux.Dockerfile .
else
  docker build -t "$IMAGE" -f docker/linux.Dockerfile .
fi

echo "── [2/2] Building (artifacts → ./out) ──"
mkdir -p out
docker run --rm \
  -v "$PWD/out:/out" \
  -v littlepad-cargo:/usr/local/cargo/registry \
  -v littlepad-target-linux:/app/src-tauri/target \
  "$IMAGE"

echo "✔ Linux OK — artifacts in ./out/"
