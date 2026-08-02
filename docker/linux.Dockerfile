# ─────────────────────────────────────────────────────────────────────────────
# LittlePad — build image for LINUX (plain executable, no installer)
#
# Recommended usage: ./scripts/build-linux.sh
#
# Manual:
#   docker build -t littlepad-builder-linux -f docker/linux.Dockerfile .
#   docker run --rm -v "$(pwd)/out:/out" littlepad-builder-linux
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

# ── npm dependencies (cacheable layer: only redone if the locks change) ─────
COPY package.json ./
RUN npm install && npm ci

# ── Source code ──────────────────────────────────────────────────────────────
COPY . .

# AppImage's tooling (linuxdeploy) uses FUSE, which isn't available inside a
# container: this variable makes it self-extract and run instead.
ENV APPIMAGE_EXTRACT_AND_RUN=1
ENV NO_STRIP=true

# ── Generate icons from app-icon.svg, build (executable only, no
#    .deb/.rpm/.AppImage), and export to /out ─────────────────────────────────
CMD ["bash", "-euxc", "\
    npm run tauri icon app-icon.svg && \
    npm run tauri build -- --no-bundle && \
    mkdir -p /out && \
    cp -v src-tauri/target/release/littlepad /out/littlepad-linux-x86_64 && \
    echo '── Artifact generated ──' && ls -lh /out \
"]
