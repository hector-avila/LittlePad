#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Builds LittlePad for MACOS as a double-clickable LittlePad.app (no .dmg
# installer, no code signing/notarization). MUST run on a Mac.
#
# Why a .app and not a plain Unix binary like the other platforms: Finder
# has no way to launch a raw executable as a GUI app — double-clicking it
# opens a Terminal window instead, which isn't something to hand end users.
# A .app bundle is just packaging (a folder Finder knows how to launch
# directly), not an installer — nothing gets "installed" anywhere, and there
# is still no .dmg/.pkg.
#
# macOS CANNOT be built inside Docker: Apple's SDK and WebKit frameworks are
# only available (and licensed) on Apple hardware.
# Alternative without a Mac: GitHub Actions (see .github/workflows/release.yml).
#
# Usage:
#   ./scripts/build-macos.sh              # current Mac's architecture
#   ./scripts/build-macos.sh --universal  # universal binary (Intel + Apple Silicon)
#
# Requirements (validated when run):
#   - Xcode Command Line Tools:  xcode-select --install
#   - Rust:                      https://rustup.rs
#   - Node.js >= 20:             https://nodejs.org
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "✘ This script must run on macOS." >&2
  echo "  macOS can't be built in Docker (Apple's SDK only runs on Apple hardware)." >&2
  echo "  Without a Mac, use GitHub Actions: .github/workflows/release.yml" >&2
  exit 1
fi

command -v cargo >/dev/null || { echo "✘ Missing Rust. Install: https://rustup.rs"; exit 1; }
command -v node  >/dev/null || { echo "✘ Missing Node.js >= 20"; exit 1; }
xcode-select -p >/dev/null 2>&1 || { echo "✘ Missing Xcode CLT: xcode-select --install"; exit 1; }

TARGET_ARGS=()
if [[ "${1:-}" == "--universal" ]]; then
  rustup target add aarch64-apple-darwin x86_64-apple-darwin
  TARGET_ARGS=(--target universal-apple-darwin)
fi

echo "── [1/4] Installing npm dependencies ──"
npm install
npm ci

echo "── [2/4] Generating icons from app-icon.svg ──"
npm run tauri icon app-icon.svg

echo "── [3/4] Building (.app bundle, no .dmg) ──"
# --bundles app (not --no-bundle): produces LittlePad.app and nothing else
# (no .dmg/.pkg), unlike the plain-binary builds on the other platforms.
if [[ ${#TARGET_ARGS[@]} -gt 0 ]]; then
  npm run tauri build -- "${TARGET_ARGS[@]}" --bundles app
else
  npm run tauri build -- --bundles app
fi

echo "── [4/4] Building the share relay server (native arch only — it's a self-hosted server, not something Gatekeeper/Finder needs to open) ──"
cargo build --release -p relay-server

mkdir -p out
# Note: "target/", not "src-tauri/target/" — src-tauri is a Cargo workspace
# member (see the root Cargo.toml, added for relay-server/), and Cargo
# always builds workspace members into one shared target dir at the
# workspace root, regardless of which member's Cargo.toml you build from.
BUNDLE_DIR="target/release/bundle/macos"
[[ "${1:-}" == "--universal" ]] && BUNDLE_DIR="target/universal-apple-darwin/release/bundle/macos"
rm -rf out/LittlePad.app
cp -R "$BUNDLE_DIR/LittlePad.app" out/LittlePad.app
cp -f target/release/littlepad-relay-server out/littlepad-relay-server
# ditto (not zip): the standard macOS tool for zipping .app bundles without
# corrupting resource forks/metadata that a plain `zip` can lose.
ditto -c -k --sequesterRsrc --keepParent out/LittlePad.app out/LittlePad-macos.app.zip

echo "✔ macOS OK — out/LittlePad.app, out/LittlePad-macos.app.zip, and out/littlepad-relay-server ready"
echo "  Note: unsigned, not notarized. On first launch, Gatekeeper will likely"
echo "  block it — right-click LittlePad.app → Open (once), or run:"
echo "    xattr -cr out/LittlePad.app"
echo "  if it was downloaded (clears the quarantine attribute). To distribute"
echo "  without that step: sign with a 'Developer ID' + notarize (requires an"
echo "  Apple Developer Program membership)."
