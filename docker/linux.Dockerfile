# ─────────────────────────────────────────────────────────────────────────────
# LittlePad — build ENVIRONMENT for LINUX (plain executable, no installer)
#
# This image only provides the toolchain (Rust, Node, system libs) — it does
# NOT contain a copy of the source. scripts/build-linux.sh bind-mounts the
# repo into it at `docker run` time instead of baking a `COPY . .` snapshot
# in here at `docker build` time, so a build always compiles whatever is
# actually on disk right now, never a stale copy left over from an earlier
# image build.
#
# Recommended usage: ./scripts/build-linux.sh
#
# Manual:
#   docker build -t littlepad-builder-linux -f docker/linux.Dockerfile docker/
#   docker run --rm --user "$(id -u):$(id -g)" \
#     -v "$PWD:/app" -v "$PWD/out:/out" littlepad-builder-linux
#   (see build-linux.sh for why --user matters, and for fixing up any named
#   cache volumes that were already created by an earlier, root-run build)
# ─────────────────────────────────────────────────────────────────────────────

FROM rust:1-bookworm

# ── System dependencies for Tauri 2 (Debian bookworm) ────────────────────────
# libfontconfig1-dev/libfreetype6-dev/pkg-config: needed by the font-kit crate
# (Settings → font picker's "list installed system fonts" feature).
RUN apt-get update && apt-get install -y --no-install-recommends \
    libwebkit2gtk-4.1-dev \
    build-essential \
    curl \
    wget \
    file \
    libxdo-dev \
    libssl-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    patchelf \
    ca-certificates \
    xz-utils \
    xdg-utils \
    libfontconfig1-dev \
    libfreetype6-dev \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

# ── Node.js 22 LTS (NodeSource) ──────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# AppImage's tooling (linuxdeploy) uses FUSE, which isn't available inside a
# container: this variable makes it self-extract and run instead.
ENV APPIMAGE_EXTRACT_AND_RUN=1
ENV NO_STRIP=true

# build-linux.sh runs this container as the host user (--user "$(id -u):$(id
# -g)"), so output files land back on the host owned by that user, not root
# — but that UID/GID has no matching /etc/passwd entry inside the image, so
# it has no real $HOME. Point HOME at /tmp (world-writable, no setup needed)
# and give npm an explicit, HOME-independent cache path — both just need
# *some* writable directory, not persistence beyond what's already cached
# via the named volumes build-linux.sh mounts over them.
ENV HOME=/tmp
ENV npm_config_cache=/npm-cache

# No COPY of source here on purpose — see the header comment. Everything,
# including `npm install`, runs here in CMD instead, against whatever
# scripts/build-linux.sh bind-mounts at /app for this specific run — so
# there's nothing in the image itself that can go stale between builds.
#
# The app binary's source name below is "LittlePad" — Cargo.toml's package
# name, case as-is (`cargo`/`tauri build` don't lowercase it); the /out/
# name is ours to pick, kept lowercase for a nicer downloadable filename.
CMD ["bash", "-euxc", "\
    npm install && npm ci && \
    npm run tauri icon app-icon.svg && \
    npm run tauri build -- --no-bundle && \
    cargo build --release -p relay-server && \
    mkdir -p /out && \
    cp -v target/release/LittlePad /out/littlepad-linux-x86_64 && \
    cp -v target/release/littlepad-relay-server /out/littlepad-relay-server-linux-x86_64 && \
    echo '── Artifacts generated ──' && ls -lh /out \
"]
