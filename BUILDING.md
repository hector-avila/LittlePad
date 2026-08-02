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
installer — at `out\littlepad.exe`.

## Linux

Requirement: Docker (this builds inside a container, so it works from any
host — Linux, macOS, or Windows with Docker installed).

```bash
./scripts/build-linux.sh
```

Produces a plain executable — no `.deb`/`.rpm`/`.AppImage` — at
`out/littlepad-linux-x86_64`. Uses named Docker volumes
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
│                         OnboardingDialog
├── editor/               CM6 language wiring + log highlighter
├── services/
│   ├── detector.ts       heuristic language detection
│   ├── formatter.ts      JSON/XML/YAML pretty-printers
│   ├── session.ts        autosave with a 1.5s debounce / 5s max wait
│   ├── backend.ts        Tauri IPC (with a localStorage fallback in-browser)
│   └── editorBridge.ts   React ↔ EditorView bridge (incl. find/replace)
└── store/                lightweight stores (useSyncExternalStore);
                          settings.ts stores per-action shortcuts in
                          localStorage

src-tauri/src/            Backend (Rust)
├── commands.rs           IPC commands (incl. get/set_data_dir,
│                         get_launch_files, check_first_run, setup_shortcuts)
├── session.rs            atomic-write session persistence; configurable
│                         data directory (data_root, defaults to
│                         $HOME/.littlepad); window position/size/maximized
│                         state
└── onboarding.rs         first-run desktop shortcut + PATH setup,
                          per-platform (Windows/Linux/macOS)
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
