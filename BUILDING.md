# Building LittlePad from source

This is for developers who want to run LittlePad from source or build their
own executable. If you just want to use the app, see the main
[README.md](README.md) instead.

## Requirements

Node.js ≥ 20 and Rust (stable) are needed on every platform. Each section
below lists what else that specific platform needs.

## Development

```bash
npm install
npm run tauri dev      # full desktop app, dev mode
npm run dev            # frontend only, in a browser (session in localStorage)
```

## Windows

Requirements: Rust, Node.js ≥ 20, and the MSVC linker (`link.exe`) — it
doesn't ship with Rust or Node. If the build fails with "linker `link.exe`
not found", install
**["Build Tools for Visual Studio"](https://visualstudio.microsoft.com/visual-cpp-build-tools/)**
with the "Desktop development with C++" workload (this is **not** the full
Visual Studio IDE — a separate, much lighter installer with just the
command-line compiler/linker).

```bat
scripts\build-windows.bat
```

Builds natively on Windows (no Docker) and produces a plain `.exe` — no
installer — at `out\littlepad.exe`, plus the share relay server (see
[Share relay server](#share-relay-server) below) at
`out\littlepad-relay-server.exe`.

## Linux

Requirement: Docker (this builds inside a container, so it works from any
host — Linux, macOS, or Windows with Docker installed).

```bash
./scripts/build-linux.sh
```

Produces a plain executable — no `.deb`/`.rpm`/`.AppImage` — at
`out/littlepad-linux-x86_64`, plus the share relay server (see
[Share relay server](#share-relay-server) below) at
`out/littlepad-relay-server-linux-x86_64`. Uses named Docker volumes
(`littlepad-cargo`, `littlepad-target-linux`) to keep rebuilds fast.

## macOS

Requirements: Xcode Command Line Tools (`xcode-select --install`), Rust,
and Node.js ≥ 20. **Must run natively on a Mac** — Apple's SDK and WebKit
frameworks aren't available in Docker.

```bash
./scripts/build-macos.sh              # current Mac's architecture
./scripts/build-macos.sh --universal  # universal binary (Intel + Apple Silicon)
```

Produces `out/LittlePad.app` (and a `.zip` of it) — a `.app` bundle instead
of a plain binary, because Finder can't launch a raw Unix executable as a
GUI app (double-clicking one opens a Terminal instead). It's still just
packaging, not an installer: no `.dmg`/`.pkg`, no code signing or
notarization.

`LittlePad.app` will likely be blocked by Gatekeeper the first time you
open it, since it's unsigned — right-click → **Open** once, or run
`xattr -cr LittlePad.app` if it was downloaded (clears the quarantine
attribute).

Also produces the share relay server (see [Share relay
server](#share-relay-server) below) at `out/littlepad-relay-server`, for the
current Mac's native architecture (not built as a universal binary even
with `--universal` — it's a server you run yourself, not something Finder
or Gatekeeper needs to open).

## Share relay server

`relay-server/` is a separate, standalone binary — a stateless WebSocket
relay for the real-time file sharing feature (Settings → Share). It never
persists anything to disk and never sees document content or passwords: it
only relays already-encrypted bytes between LittlePad instances that share
the same Share API key, plus the minimal metadata (filename, read-only
flag) needed to list currently-shared files. See `relay-server/src/main.rs`
for the full picture.

```bash
littlepad-relay-server --host 0.0.0.0 --port 7878 --base-path /some/path
# all three flags are optional; --host/--port shown above are the defaults,
# --base-path is empty (serves at "/ws") unless given
```

**[SERVER.md](SERVER.md)** is the full guide: every flag, how to point
LittlePad's Settings → Share → Server URL at it (matching `--base-path`,
if you set one), the security model, and copy-pasteable NGINX/Apache
reverse proxy configs — including serving it at a custom URL path (e.g.
`https://my.domain/share`) instead of a dedicated subdomain.

`scripts/build-windows.bat` and `scripts/build-macos.sh` build it alongside
the app; on Linux it's produced by `scripts/build-linux.sh` (see above).
The published GitHub Release also attaches Linux x86_64 and arm64 builds
directly (see `.github/workflows/release.yml`'s `build-relay` job) since
self-hosting it on a Linux server is the expected common case.

## Building for every platform

Windows and macOS builds must run **natively on their own OS** — neither
can be cross-compiled from Docker. Linux is the only one that can build
from any host, via Docker. In practice, that means:

- Building all three yourself requires access to a Windows machine, a Mac,
  and (for Linux) just Docker — run each platform's script above, on that
  platform.
- **No access to a Windows or Mac machine?** `.github/workflows/release.yml`
  is the alternative: pushing a `v*` tag makes GitHub Actions build all
  three (Windows/Linux plain executables, a macOS `.app` for Intel + Apple
  Silicon) and attach them to a draft Release, without you needing to own
  any of those machines yourself.

All three scripts regenerate the app icon from `app-icon.svg` under the
hood (`npm run tauri icon app-icon.svg`) before building, and every
artifact ends up in `./out/`.

> **Note:** `package.json` pins `rollup` to its WASM build
> (`@rollup/wasm-node`) for compatibility with older-glibc environments.
> On a modern machine you can remove the `overrides` section to use
> Rollup's native binary instead (slightly faster builds).

## Architecture

```
src/                      Frontend (React + CodeMirror 6)
├── actions.ts            open/save/close/format tab logic (reused by
│                         App.tsx, TabBar, and CloseConfirmDialog)
├── components/           TabBar (includes the ☰ menu), EditorHost,
│                         StatusBar, Banner, FindReplaceDialog,
│                         SettingsDialog, CloseConfirmDialog,
│                         OnboardingDialog, ShareDialog, ShareNotifications
├── editor/               CM6 language wiring + log highlighter
├── services/
│   ├── detector.ts       heuristic language detection
│   ├── formatter.ts      JSON/XML/YAML pretty-printers
│   ├── session.ts        autosave with a 1.5s debounce / 5s max wait
│   ├── backend.ts        Tauri IPC (with a localStorage fallback in-browser)
│   ├── editorBridge.ts   React ↔ EditorView bridge (incl. find/replace,
│   │                     and applying remote real-time edits)
│   ├── shareClient.ts    real-time sharing: relay WebSocket client,
│   │                     protocol, encryption orchestration
│   ├── shareDiskSync.ts  two-way disk sync for a shared file saved locally
│   └── fileMtimeTracker.ts  on-disk mtime baselines (shared by
│                         externalChanges.ts and shareDiskSync.ts)
└── store/                lightweight stores (useSyncExternalStore);
                          settings.ts stores per-action shortcuts (and the
                          Share server/API key) in localStorage

relay-server/src/         The share relay server (standalone binary — see
                          "Share relay server" below), a separate Cargo
                          workspace member from src-tauri/
├── main.rs               CLI (--host/--port) + the axum WebSocket server
├── protocol.rs           wire message types (mirrored in shareClient.ts)
├── state.rs              in-memory-only tenant/share state
└── ws.rs                 per-connection auth + message relay

src-tauri/src/            Backend (Rust) — the desktop app itself
├── commands.rs           IPC commands (incl. get/set_data_dir,
│                         get_launch_files, check_first_run, setup_shortcuts,
│                         and the share_* encryption commands)
├── session.rs            atomic-write session persistence; configurable
│                         data directory (data_root, defaults to
│                         $HOME/.littlepad); window position/size/maximized
│                         state
├── onboarding.rs         first-run desktop shortcut + PATH setup,
│                         per-platform (Windows/Linux/macOS)
└── share_crypto.rs       end-to-end encryption for shared documents
                          (Argon2id key derivation + AES-256-GCM)
```

Opening a file from the CLI while LittlePad is already running is handled
by `tauri-plugin-single-instance`: the second launch attempt forwards its
arguments to the running instance (via an `open-files` event) instead of
starting a new one, and the window is brought to the front. (There's no OS
file-association registration — that would require an installer, which
this project intentionally doesn't ship — so double-clicking a file in a
file manager won't open it in LittlePad unless you set that up yourself.)

Session data — default location (configurable from ⚙ Settings),
**the same on all three platforms**:
```
$HOME/.littlepad/session/
```

If you change the location, the pointer to the new one is stored at
`$HOME/.littlepad/data-location.json` (a fixed path that never moves,
even if the actual data lives elsewhere).

## Contributing

Pull requests are welcome. There's a much more detailed developer guide in
[`AGENTS.md`](AGENTS.md) covering architecture rationale, known gotchas,
and conventions — worth a skim before diving in.
