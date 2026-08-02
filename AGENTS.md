# AGENTS.md — LittlePad

Guide for coding agents (and humans) continuing development on this project.

## What this project is

**LittlePad**: a lightweight desktop editor (Windows/Linux/macOS) for
pasting, detecting, coloring, and formatting configuration text and logs.
Typical user: an ops/dev person who pastes a JSON/XML/YAML from a log or
config file and wants to see it formatted with colors and a foldable tree,
without fear of losing the text.

**Stack:** Tauri 2 (Rust) + React 19 + CodeMirror 6 + TypeScript + Vite.
UI text and code comments are in **English**.

Name history: **FormatPad** → **OmniText** → **LittlePad** (Tauri's
identifier, the `localStorage` keys, the Docker image/volume names, and the
default data directory were all updated on each rename). If you find leftover
"formatpad"/"omnitext" anywhere (an old comment, a variable name,
`package-lock.json` not yet regenerated) it's debt from an earlier rename,
not intentional — fix it if you touch it.

The full development plan is in `../PLAN.md` (workspace root).

## Key functional requirements (all implemented)

1. **Anti-data-loss autosave** (critical requirement): the session (tabs,
   content, cursor, type) is persisted even if it's never saved to a file.
   On power loss you lose ≤ ~5 s of typing. This autosaves to the **session
   cache** (`data_root/session/`), never to the original file on disk — the
   real file is only touched when you explicitly press Save
   (`saveTab`/`saveFileAction`); these are two completely separate write
   paths (see Architecture).
2. Multiple tabs.
3. Automatic text-type detection with per-type colors: JSON, XML, YAML,
   TOML, INI/properties, logs, JavaScript/Node.js, Java, Python, Markdown.
4. Collapse/expand tree (fold) for nested formats.
5. Formatting (pretty-print) of JSON/XML/YAML with line/column errors.
6. Built-in find & replace (text or regex, optional case sensitivity), in a
   floating dialog over the editor.
7. Smart paste: line endings in pasted text are always normalized to LF
   (`\n`), regardless of the source OS. Pasting into an empty tab also
   detects the language and auto-formats the content.
8. Minimalist menu, flush with the tab bar: a single ☰ button (or the Alt
   key) opens a menu with every action (new tab, open, save, format,
   fold/unfold tree, find & replace, settings). Each action has a keyboard
   shortcut configurable from the Settings window.
9. Drag and drop files onto the window to open them (one or several).
10. Data location (session/autosave) configurable from the Settings window,
    with a folder picker. The default is fixed: **`$HOME/.littlepad`** on
    all three platforms (it doesn't use each OS's specific `app_data_dir`
    conventions).
11. Closing a tab with unsaved changes to a file, or a new tab with text,
    prompts Save / Don't Save / Cancel (never silently closes and loses
    text).
12. Ctrl+Shift+T (configurable) reopens the last closed file, re-reading it
    from disk. History is memory-only (lost when the app closes) and only
    applies to files with a real path — unsaved new tabs never enter it.
13. Closing the window/app **never asks anything**: it flushes the session
    cache and closes directly. Reopening restores everything exactly as it
    was — including unsaved edits to filesystem files (those edits are
    shown, not the on-disk file's content).
14. Column (multi-cursor) editing: a configurable shortcut (default
    Alt+Shift+Insert) arms a mode where Shift+Up/Down selects a rectangular
    column of text (one cursor per row) instead of extending a normal
    selection; typing/deleting then applies to every row at once. Plain
    Up/Down (no Shift) move the caret exactly as when the mode is off —
    they never add cursors by themselves. Escape does **not** disarm it;
    only the shortcut itself (pressed again) does. A "⌶ Column mode" badge
    in the status bar shows when it's armed; switching tabs always disarms
    it (it's global to the editor view, not per-tab).
15. Opening a file from the command line (`littlepad some-file`) while the
    app is already running adds it as a tab in that same window instead of
    starting a second instance, and brings the window to the front.
16. On first run, the app offers to create a desktop shortcut and add
    itself to the user's PATH; asked at most once, ever (a marker file
    remembers the answer was given, regardless of Yes/No).
17. Ctrl+D duplicates the current selection (right after itself) or, if
    nothing is selected, the current line (right below it); works across
    multiple cursors/selections. Configurable (`duplicateLine`).
18. Ctrl+Scroll wheel, Ctrl+Plus (`+`/`=`), and Ctrl+Minus (`-`) zoom the
    editor's font size in/out; zooming out never goes below the "Normal
    size" configured in ⚙ Settings (`baseFontSize`, defaults to
    `DEFAULT_FONT_SIZE` = 13px). Ctrl+0 resets back to that size. The
    keyboard shortcuts (`zoomIn`/`zoomOut`/`resetZoom`) are configurable —
    only Ctrl+Scroll wheel itself stays fixed (`EditorHost.tsx`'s wheel
    listener; not representable in the keyboard-shortcut recorder). Changing
    "Normal size" in Settings also resets the current zoom to it. Persisted
    in `settingsStore` (localStorage), same as the font family below.
19. The editor's font family is choosable from ⚙ Settings: the built-in
    default stack, two bundled fonts (Ubuntu Monospace, MesloLGS NF — see
    `THIRD-PARTY-NOTICES.md` for licenses), or any font installed on the OS
    (enumerated via the Rust `font-kit` crate, `list_system_fonts`).
20. The native right-click context menu is suppressed everywhere except
    inside the CodeMirror editor (`.cm-editor`) — elsewhere it exposed a
    mostly-disabled WebView menu whose one working item, "Reload", reloaded
    the whole app (`App.tsx`'s global `contextmenu` handler).
21. Ctrl+A/Ctrl+E are blocked outside the editor too (same `.cm-editor`
    check, in the main keydown handler) — the WebView's native "select all"
    otherwise highlighted page chrome (line numbers, menu text) when focus
    wasn't inside the editor. Inside the editor these still work normally
    (CodeMirror's own keymap handles them there, e.g. Ctrl+A selects all text).
22. Word wrap is toggleable app-wide from a "Wrap" button in the status bar
    (next to the text-type selector) — not per-tab. Persisted in
    `settingsStore` (`wordWrap`, defaults to on), same as font size/family.
23. Ctrl+Shift+Up/Ctrl+Shift+Down moves the current line (or every line
    touched by the selection) up/down one line, via CM6's built-in
    `moveLineUp`/`moveLineDown`. Configurable (`moveLineUp`/`moveLineDown`).

## Architecture (summary)

- **Frontend owns the UX**; **the Rust backend owns everything that
  touches disk** (durability, atomicity, encoding).
- A single CodeMirror `EditorView`; one `EditorState` per tab, swapped in
  when switching tabs (`src/components/EditorHost.tsx`).
- The editor lives **outside React**; it communicates via
  `src/services/editorBridge.ts` (a singleton) and lightweight stores built
  on `useSyncExternalStore` (`src/store/`). No Redux/Zustand, no CSS
  framework.
- Autosave: 1.5 s debounce + 5 s maxWait per tab (`src/services/session.ts`)
  → Rust command `save_session_tab` → atomic write
  `tmp → fsync → rename → fsync(dir)` (`src-tauri/src/session.rs`). Full
  flush on `onCloseRequested` (with `preventDefault` + `destroy`, **without**
  asking the user anything — see point 13 above and the permissions gotcha
  below).
- Session on disk: `data_root/session/` → `session.json` (index) +
  `tab-<uuid>.txt` (content) + `tab-<uuid>.meta` (metadata JSON). `data_root`
  defaults to **`$HOME/.littlepad`** (fixed, the same on Windows/Linux/
  macOS — independent of Tauri's identifier and of the OS's `app_data_dir`
  conventions), unless the user changed the location from Settings
  (`session::data_root`, see below).
- `src/services/backend.ts` has a **localStorage fallback** when not
  running inside Tauri → `npm run dev` works in a plain browser to test
  the UI.
- Paste: `EditorView.domEventHandlers({ paste })` in `EditorHost.tsx`
  intercepts every paste (replacing CM6's native handling), normalizes
  `\r\n`/`\r` → `\n`, and, if `doc.length === 0` before the paste, also
  detects the language (`detector.ts`) and formats it (`formatter.ts`)
  before inserting.
- Shortcuts: `store/settings.ts` stores a `Record<ActionId, Shortcut>` in
  localStorage (not in Rust's on-disk session — it's a UI preference, not
  content). `App.tsx` resolves configurable shortcuts against
  `settingsStore.get().shortcuts` in the global `keydown` handler; editor-
  only actions (duplicate line, move line up/down) are resolved the same
  way inside `EditorHost.tsx` via `Prec.highest(EditorView.domEventHandlers(...))`
  instead of CM6's static keymap DSL, since that needs compile-time-fixed
  key strings. The only shortcut left genuinely fixed is Ctrl+Tab/Ctrl+Shift+Tab,
  a bonus always-on alias for cycling tabs on top of the configurable
  `nextTab`/`previousTab` (default Ctrl+PageDown/Up) — see `FIXED_SHORTCUTS`
  in `settings.ts`. Every other action, including closing a tab (Ctrl+W), is
  configurable.
- Menu: lives inside `TabBar.tsx` (☰ button + dropdown), flush with the
  tabs — there's no separate toolbar row. It opens on click or by releasing
  `Alt` without having combined it with another key (like a classic desktop
  app menu); that tracking lives in the same `keydown`/`keyup` effect in
  `App.tsx`.
- Drag & drop: in Tauri, `getCurrentWebview().onDragDropEvent(...)`
  (`@tauri-apps/api/webview`) delivers the absolute paths of the dropped
  files → they're opened with `openPath()` (the same function the "Open
  file" dialog uses). In the browser (`npm run dev`), fallback via the DOM
  `dragover`/`drop` events + `File.text()` (no real path, same as pasting
  into a new tab).
- Configurable data directory: `session::data_root()` (Rust) resolves
  `$HOME/.littlepad` by default (`default_data_root()`) or the override
  saved at `$HOME/.littlepad/data-location.json` (a fixed path inside the
  default directory itself — it's the one file that *cannot* move, since
  it's where the pointer is looked up, even if the rest of the data lives
  elsewhere). Changing it (`set_data_root`) COPIES the existing session to
  the new folder without deleting the source (avoiding any risk of data
  loss); the change takes effect after restarting the app. IPC commands:
  `get_data_dir` / `set_data_dir`.
- Business actions (open/save/close/format tabs) live in `src/actions.ts`,
  not in `App.tsx` — so `CloseConfirmDialog.tsx` and `TabBar.tsx` can reuse
  them without depending on App's component tree. `saveFileAction()`
  (Ctrl+S/menu, always on the active tab) is a thin wrapper over
  `saveTab(tab)` (reusable with any tab, including one in the background).
- Closing a tab with changes: `closeTabAction(id)` decides whether
  confirmation is needed (dirty && filePath, or no filePath with non-empty
  text); if so, it stores the id in `closeConfirmStore` (`store/misc.ts`)
  and `CloseConfirmDialog.tsx` offers Save/Don't Save/Cancel. The actual
  close (removing the tab + its session cache) only happens in
  `finishCloseTab(tab)`, never directly in `closeTabAction`. **This only
  applies to closing an individual tab** — closing the whole window/app
  doesn't go through here (see "Closing the app" below).
- Closed-tab history (Ctrl+Shift+T): `finishCloseTab` pushes `tab.filePath`
  (if it exists) onto a **pure in-memory** stack (`store/misc.ts`, neither a
  reactive store nor localStorage — a module-level array) via
  `pushClosedFile`. `reopenClosedFile()` calls `popClosedFile()` and reopens
  with `openPath()`, re-reading the file from disk — it does **not**
  restore the unsaved cached content the tab had when it was closed (that's
  discarded via "Don't Save", on purpose, to avoid conflating "reopen a
  file" with "undo a close").
- Closing the app (window): `onCloseRequested` in `App.tsx` NEVER asks
  anything — it just flushes every tab to the session cache and destroys
  the window. On reopening, `loadSession()` restores content **from the
  cache**, not re-read from the original file, so unsaved edits show up
  intact. This requires the `core:window:allow-destroy` permission in
  `capabilities/default.json` (see gotcha).
- Column edit mode (`EditorHost.tsx`): the arm/disarm **toggle** is handled
  via a `Prec.highest(EditorView.domEventHandlers({ keydown: ... }))` (not
  CM6's `keymap` string DSL, which needs a static key string) that compares
  every keydown against `settingsStore.get().shortcuts.columnMode` using the
  same `matchesShortcut` App.tsx uses for its own global shortcuts — this is
  what makes the shortcut live-reconfigurable from Settings without
  rebuilding editor extensions. While armed (a closure-local
  `columnModeArmed` flag, shared across all tabs since it lives in the outer
  `useEffect` that runs once), a *separate*, still-static
  `Prec.highest(keymap.of([...]))` handles the actual column-selection
  behavior — **revised again** after user feedback that the original
  "Up/Down always stacks a cursor" design felt confusing/non-standard:
  - `Shift-ArrowDown`/`Shift-ArrowUp` call `extendColumnSelection`, which
    grows/shrinks a rectangular selection (one `EditorSelection.cursor` per
    row, all at the same column) from a fixed `boxAnchor` to a moving
    `boxHeadLine` — the same anchor/head mental model as a normal
    Shift+Arrow text selection, just one cursor per line instead of one
    continuous range. Returns `false` (falls through to CM6's default
    Shift+Arrow selection-extend) whenever `columnModeArmed` is false.
  - Plain `ArrowDown`/`ArrowUp` (no Shift) bindings exist ONLY to call
    `resetColumnBox()` as a side effect (clearing `boxAnchor`/`boxHeadLine`
    so the next Shift+Arrow starts a fresh box from wherever the cursor
    ends up) — they always return `false`, so normal arrow-key navigation
    is completely unaffected; plain arrows never add/remove cursors, unlike
    the original design.
  - Escape has **no binding here at all** (removed per explicit request —
    "no puede desactivarse al presionar ESC"): only the configured shortcut,
    pressed again, disarms the mode. Don't re-add an Escape handler for
    this without being asked again.
  All state changes funnel through one `setColumnModeArmed(next)` closure
  (also resets the box, updates `columnModeStore` in `store/misc.ts` — drives
  the status bar's "⌶ Column mode" badge, the only on/off indicator; no
  banner is shown, per explicit request — and, on disarm, collapses any
  stacked column cursors to just the main one via `simplifySelection` from
  `@codemirror/commands`, the same command CM6's own Escape uses to
  collapse an ordinary selection) — arm/disarm never happens in more than
  one place. Because the armed flag (and box state) is shared across all
  tabs (not per-`EditorState`), the tab-swap
  effect calls `setColumnModeArmedRef.current(false)` (exposed via ref, same
  pattern as `createStateRef`) on every tab switch, so it can never silently
  carry over onto a different, unrelated document — this was the main
  source of user-reported confusion before the fix. No new code needed for
  typing across multiple cursors — CM6's transaction system already applies
  edits to every selection range.
- Opening files from the CLI: `tauri-plugin-single-instance` (registered
  **first**, before other plugins, per its own docs) detects a second
  launch attempt, forwards its resolved argv to the first instance as an
  `open-files` event, and focuses that window; the second process never
  creates a window of its own. The *first* launch's own argv (if any) is
  captured once in `.setup()` into Tauri-managed state (`LaunchFiles`) and
  pulled by the frontend via `get_launch_files()` (a "consume once" command
  — `std::mem::take` empties it on read) rather than pushed as an event, to
  avoid a race with the frontend's listener not being attached yet at
  startup. Both paths resolve relative paths against the launching
  process's cwd (`resolve_arg_paths` in `lib.rs`), since a background
  already-running instance's own cwd is unrelated to the *new* invocation's.
- First-run onboarding: `check_first_run` (Rust) atomically checks-and-marks
  a `.onboarded` file inside the data directory — true only the very first
  time it's ever called. The frontend calls it once at startup; if true, it
  shows `OnboardingDialog.tsx`, which on "Yes" calls `setup_shortcuts` →
  `src-tauri/src/onboarding.rs`, with a **different implementation per
  platform** (`#[cfg(target_os = "...")]`): Windows creates **two** `.lnk`
  files — one on the Desktop, one in the per-user Start Menu folder
  (`%APPDATA%\Microsoft\Windows\Start Menu\Programs`) — by shelling out to
  PowerShell's `WScript.Shell` COM object (no extra native dependency); the
  Start Menu one specifically is what makes LittlePad show up in Windows'
  own program list/search, a Desktop shortcut alone does not. It also
  appends the executable's directory to `HKCU\Environment\Path` via the
  `winreg` crate, carefully preserving whether the existing value was
  `REG_SZ` or `REG_EXPAND_SZ` (blindly overwriting the type could break
  `%VAR%` expansion in the user's other PATH entries). Linux writes a
  `.desktop` file (application menu + best-
  effort literal Desktop icon) and symlinks the binary into `~/.local/bin`
  (already on PATH by default on most distros). macOS symlinks onto the
  Desktop and into `~/.local/bin` too — this predates macOS shipping a
  `.app` at all (see the "macOS ships a `.app`" decision below) and hasn't
  been revisited since; the summary message returned to the user still says
  the Desktop symlink "may not behave like a real Mac app when
  double-clicked," which is stale now that a real (if unsigned) `.app`
  exists. Every step is additive/best-
  effort (`let _ = ...` on the non-critical ones) and never deletes or
  overwrites unrelated data.
- **The `.desktop` file's `Icon=` key** (Linux only — this is a launcher/menu
  icon, unrelated to `LITTLEPAD_ICON_HASH`/`default_window_icon` above,
  which only affects the *running window's* icon): the original
  implementation simply omitted `Icon=` entirely, so the app showed up
  iconless in the menu/dock no matter how correct the compiled binary's own
  icon was. Fixed by embedding `src-tauri/icons/128x128.png` at compile
  time (`include_bytes!` in `onboarding.rs` — genuinely tracked by rustc,
  unlike the `generate_context!()` case, so this one didn't need the hash
  trick) and writing it out at `setup()` time to
  `<XDG_DATA_HOME>/littlepad/icon.png`, then pointing `Icon=` at that
  **absolute path** — deliberately not an icon-theme name (`Icon=littlepad`
  installed under `icons/hicolor/...`), to avoid depending on icon-theme
  cache refresh (`gtk-update-icon-cache` etc.) working on every distro/DE.
  `remove()` deletes that file (and the now-empty `littlepad/` dir) as part
  of undoing setup.
- **Windows `.lnk` icon and error handling**: the `.lnk`'s icon is normally
  whatever the target `.exe`'s own PE resource says (fixed separately by
  `LITTLEPAD_ICON_HASH`), but `setup()` also embeds `src-tauri/icons/icon.ico`
  (`include_bytes!`, genuinely tracked by rustc) and writes it to
  `%LOCALAPPDATA%\LittlePad\icon.ico`, then sets both shortcuts'
  `IconLocation` explicitly to that file — belt-and-suspenders so the
  shortcut's icon can never go stale independent of whatever the .exe
  resource embedding does. Also: the original code ran the PowerShell
  script with `let _ = ... .output()`, silently discarding failures and
  *always* returning a hardcoded success message even if the shortcut was
  never actually created — misleading, and indistinguishable from "nothing
  happened" if PowerShell ever failed (execution policy, COM error, etc.).
  Fixed to check `output().status.success()` and fold any failure into a
  warning in the returned message instead of a false claim of success. The
  PATH update is unaffected either way — it uses the `winreg` crate
  directly, not PowerShell.
- **Settings → "Recreate shortcut…"** (`setupShortcuts()`, next to the
  Danger Zone but non-destructive): exists because `setup()` only ever runs
  once automatically (gated by the first-run `.onboarded` marker) — without
  a manual way to rerun it, anyone with a `.desktop` file predating a fix
  like the `Icon=` one above would be stuck with the stale file forever
  (short of using the destructive Uninstall button, which was the wrong
  tool for this). Safe to call repeatedly: `setup()` unconditionally
  overwrites its own files with fresh content every time.
- **Uninstall (Settings → Danger zone)**: the inverse of the above, added on
  request so the app can be fully removed without a package manager. Two
  commands: `remove_shortcuts` (→ `onboarding::remove`, one impl per
  platform, mirrors `setup` — deletes the shortcut/`.desktop` entries and
  `~/.local/bin` symlink, and on Windows strips the exe's directory back out
  of `HKCU\Environment\Path`, still preserving `REG_SZ`/`REG_EXPAND_SZ`) and
  `delete_app_data` (→ `session::delete_all_data`, **irreversible**: removes
  `<data_root>/session/`, then the *default* data dir outright since it's
  exclusively app-owned, then the current data dir too but only via
  `remove_dir` — i.e. only if it's a custom-relocated dir left empty by the
  above, never a recursive delete of a user-chosen folder that might hold
  unrelated files). `SettingsDialog.tsx` gates this behind a native `ask()`
  confirmation (`kind: 'warning'`), ignores `remove_shortcuts` failures
  (best-effort, non-critical), aborts on `delete_app_data` failure, and on
  success shows a `message()` then calls `getCurrentWindow().destroy()`
  directly — **not** `.close()`, so the `onCloseRequested` flush-to-disk
  handler in `App.tsx` never runs and doesn't recreate the just-deleted
  session directory.
- `--no-bundle`: Windows and Linux build paths (`build-windows.bat`,
  `docker/linux.Dockerfile`, and the Windows/Linux matrix entries in
  `.github/workflows/release.yml`) pass `--no-bundle` to `tauri build`, so
  the only output there is the
  plain compiled executable — no `.deb`/`.rpm`/`.AppImage`/`.msi`/NSIS.
  `tauri.conf.json`'s own `bundle` section (`"targets": "all"`) is
  untouched — `--no-bundle` on the CLI overrides it for every invocation
  that passes it, but a bare `npm run tauri build` without any bundle flag
  would fall back to bundling everything (none of the provided scripts do
  that). CI uses `tauri-action`'s `uploadPlainBinary: true` for these
  entries, which the tool's own docs say should only be combined with
  `--no-bundle`.
  **macOS is the one exception**: `build-macos.sh` and the macOS CI matrix
  entries use `--bundles app` instead — see the next bullet for why.
- **macOS ships a `.app`, not a plain binary** (added on request: a raw Unix
  binary double-clicked in Finder opens a Terminal window instead of
  launching as a GUI app — not acceptable for end users). `--bundles app`
  (not `--no-bundle`, and not the CLI's macOS default which also produces a
  `.dmg`) builds *only* the `.app` — still no installer, still nothing gets
  "installed" anywhere, it's just a folder Finder can launch directly.
  `build-macos.sh` copies `LittlePad.app` from
  `src-tauri/target/[universal-apple-darwin/]release/bundle/macos/` into
  `out/`, and also zips it with `ditto` (not plain `zip`, which can corrupt
  a `.app`'s resource forks/metadata) as `out/LittlePad-macos.app.zip` for
  easier distribution. CI mirrors this: macOS matrix entries use
  `uploadPlainBinary: false` with `--bundles app` (Windows/Linux keep
  `uploadPlainBinary: true` with `--no-bundle`) — see
  `.github/workflows/release.yml`'s per-matrix-entry `uploadPlainBinary`.
  Still unsigned/not notarized (no Apple Developer Program membership), so
  Gatekeeper will block first launch (right-click → Open, or
  `xattr -cr LittlePad.app`) — that part hasn't changed.
  **Known follow-up, not yet done**: `onboarding.rs`'s macOS `setup()` still
  symlinks the raw binary (`current_exe()`, which resolves to
  `LittlePad.app/Contents/MacOS/littlepad` when run from inside the bundle)
  onto the Desktop and into `~/.local/bin`, with a summary message that
  predates the `.app` and says double-clicking it "may not open a window
  the way a regular Mac app would." The `~/.local/bin` symlink is still
  exactly what you want for terminal use; the Desktop symlink is redundant
  now that a real `.app` exists to drag to `/Applications` or double-click
  directly, and its message is stale. Wasn't touched this round since it's
  a separate concern from producing the `.app` itself — revisit if asked.

## File map

```
app-icon.svg                   source icon (Wikimedia Commons, see README's
                               "Icon credit"); regenerated into
                               src-tauri/icons/ by `tauri icon` on every
                               build (see build scripts), not hand-edited

src/
├── App.tsx                    orchestrator: session restore, shortcuts,
│                              flush on close, drag&drop (the actions
│                              themselves live in actions.ts)
├── actions.ts                 open/save/close/format tab logic
│                              (newTab, openPath, saveTab, closeTabAction,
│                              finishCloseTab, reopenClosedFile, ...)
├── components/                TabBar (includes the ☰ menu), EditorHost,
│                              StatusBar, Banner, FindReplaceDialog,
│                              SettingsDialog, CloseConfirmDialog,
│                              OnboardingDialog
├── editor/
│   ├── languages.ts           detected type → CM6 language extension (toml/ini via legacy-modes)
│   └── logHighlighter.ts      log decorations, viewport-only (O(visible))
├── services/
│   ├── detector.ts            heuristic cascade (see PLAN.md §5.3); 64 KB max
│   ├── formatter.ts           JSON/XML/YAML pretty-print
│   ├── session.ts             autosave debounce
│   ├── backend.ts             IPC + localStorage fallback
│   └── editorBridge.ts        React ↔ EditorView bridge (incl. find/replace)
├── store/                     createStore.ts (helper), tabs.ts, misc.ts,
│                              settings.ts (configurable shortcuts + editor
│                              fontSize/fontFamily, localStorage)
└── types.ts                   Tab, DetectedType, session types (mirrors the Rust side)

src-tauri/src/
├── lib.rs                     plugin/command registration; single-instance
│                              setup, LaunchFiles state, resolve_arg_paths
├── commands.rs                load_session, save_session_tab, delete_session_tab,
│                              save_session_index, open_file, save_file,
│                              get_data_dir, set_data_dir, get_launch_files,
│                              check_first_run, setup_shortcuts,
│                              remove_shortcuts, delete_app_data,
│                              list_system_fonts (font-kit's SystemSource,
│                              for the Settings font picker)
├── session.rs                 atomic writes, session layout, validate_id,
│                              data_root/set_data_root (defaults to $HOME/.littlepad),
│                              delete_all_data (Settings "uninstall")
└── onboarding.rs               first-run shortcut + PATH setup (and its
                               inverse, `remove`), one `#[cfg(target_os = ...)]`
                               impl per platform; Linux also embeds and
                               installs the launcher icon (Icon=)

docker/linux.Dockerfile        Linux build (plain executable, --no-bundle) — the only remaining Docker use
scripts/build-linux.sh         Linux via Docker
scripts/build-windows.bat      NATIVE Windows build (no Docker; run on Windows)
scripts/build-macos.sh         NATIVE macOS build (no Docker; run on a Mac);
                               produces LittlePad.app (--bundles app), not a
                               plain binary — see "macOS ships a .app" below
.github/workflows/release.yml  native CI for all 3 OSes on a v* tag push;
                               --no-bundle + uploadPlainBinary:true for
                               Windows/Linux, --bundles app +
                               uploadPlainBinary:false for macOS
```

## Commands

```bash
npm run dev              # frontend only, in a browser (session → localStorage)
npm run tauri dev        # full app (requires Rust + Tauri deps)
npm run build            # typecheck (tsc) + Vite bundle
npx tsc --noEmit         # typecheck only
./scripts/build-linux.sh # Linux, via Docker, from any host — see BUILDING.md for Windows/macOS
```

There's no longer a single "build everything" script (`build-all.sh` was
removed — explicit request, "elimina el archivo del script"): Windows and
macOS builds must run natively on their own OS, so BUILDING.md now
documents each platform separately and points to
`.github/workflows/release.yml` for building all three without owning all
three machines.

No test suite is installed yet (see Pending). There used to be a manual
smoke test for the detector via `npx tsx` (12 cases); if you touch
`detector.ts` or `formatter.ts`, validate at least those cases (JSON,
XML×2, YAML, INI×2, TOML, log, JS, Java, Python, plain), and add a Markdown
one while you're at it (new, no smoke test case yet).

## Environment quirks / gotchas

- `package.json` has `overrides.rollup = npm:@rollup/wasm-node@^4` because
  the original dev environment had an old glibc (Rollup's native binary
  failed). **Can be removed on modern machines** (faster build).
- `js-yaml` must be imported as `import * as yaml from 'js-yaml'` (its ESM
  build has no default export; using a default import breaks the Rollup
  build).
- The AppImage bundler needs `xdg-utils` inside the container (already
  added to `linux.Dockerfile`); FUSE is avoided with
  `APPIMAGE_EXTRACT_AND_RUN=1`.
- Windows and macOS build **natively** (`build-windows.bat` /
  `build-macos.sh`), each on its own OS; there's no more Docker
  cross-compile or `cargo-xwin` (`scripts/build-windows.sh` and
  `docker/windows.Dockerfile` were removed). Without that machine on hand,
  use the release workflow (GitHub Actions builds all 3 OSes natively).
- **Native Windows builds require the MSVC linker (`link.exe`)**, which
  doesn't ship with Rust or Node: if `cargo build`/`npm run tauri build`
  fails with "linker `link.exe` not found" (without the quotes), you need
  to install **"Build Tools for Visual Studio"** (workload "Desktop
  development with C++") —
  https://visualstudio.microsoft.com/visual-cpp-build-tools/. Important:
  that is **not** installing Visual Studio (the IDE); it's a separate,
  much lighter installer that only provides the command-line
  compiler/linker. Confirmed as a real issue (a user hit it running
  `build-windows.bat`); the script now surfaces this same hint if the build
  fails. Alternative with nothing from Microsoft: the
  `x86_64-pc-windows-gnu` toolchain + MinGW-w64 — not officially tested
  with Tauri on this project.
- macOS CANNOT be built in Docker under any circumstances (Apple's SDK only
  runs on Apple hardware) — that's the only real reason there isn't also a
  macOS Dockerfile.
- **macOS's default `/bin/bash` is 3.2** (Apple froze it there over the
  GPLv3 and never updated it) — confirmed as a real issue (a user hit
  `TARGET_ARGS[@]: unbound variable` running `build-macos.sh`). Bash 3.2 has
  a known bug: expanding an *empty* array with `"${arr[@]}"` under
  `set -u`/`set -euo pipefail` throws "unbound variable", even though the
  array is declared (fixed in bash 4.4+, but macOS never got that far).
  `${#arr[@]}` (just counting elements) doesn't trigger it, so
  `build-macos.sh` and `build-linux.sh` branch on that instead of expanding
  `TARGET_ARGS`/`DOCKER_ARGS` directly when they might be empty. Watch for
  this in any new script that might run on macOS with `set -u` and an
  optionally-empty array.
- `build-linux.sh` (the only script that still uses Docker) uses named
  volumes for caching: `littlepad-cargo`, `littlepad-target-linux`.
- Tab IDs: UUIDs generated on the frontend (`crypto.randomUUID()`); Rust
  validates them (`validate_id`) against path traversal.
- App identifier: `com.littlepad.app` (previously `com.node.formatpad`).
  Unlike before, **changing it no longer breaks existing sessions**: since
  `data_root` now defaults to `$HOME/.littlepad` (fixed) instead of
  `app_data_dir()` (which did depend on the identifier), the data location
  is independent of the identifier. The identifier now only affects
  bundle/installer metadata (Windows registry, macOS bundle id, etc.).
- **Closing the window ⇒ requires `core:window:allow-destroy`**: the
  `onCloseRequested` code in `App.tsx` calls `win.destroy()` after
  flushing. If that permission is missing from `capabilities/default.json`
  (previously only `core:window:allow-close` was there, not
  `allow-destroy`), `destroy()` is silently rejected (an uncaught promise)
  and the window never closes on the first attempt. If the app ever
  "won't close" again, check this permission before the JS logic.
- `tauri-plugin-single-instance` **must stay the first `.plugin(...)` call**
  in `lib.rs` (the crate's own README says so) — it needs to claim the
  single-instance lock before other plugins/the window get a chance to
  initialize. If you add another plugin, add it *after*, not before.
- Custom `#[tauri::command]`s (everything in `commands.rs`) don't need a
  `capabilities/*.json` entry — the permission system there only gates
  *plugin*-provided commands (`dialog:*`, `core:window:*`, etc.). This has
  been true since the very first commands in this project; don't add
  capability entries for new custom commands, they won't do anything.
- The `winreg`/PowerShell code in `onboarding.rs` (Windows PATH + shortcut)
  is the single riskiest piece of Rust in this project: it edits
  `HKCU\Environment\Path` directly. It reads the existing value's registry
  type (`REG_SZ` vs `REG_EXPAND_SZ`) via `get_raw_value` and writes back
  the *same* type — if you ever touch this code, preserve that, or you can
  silently break `%VARIABLE%` expansion in a real user's other PATH
  entries. It's additive-only by design (never removes existing PATH
  segments) and skips writing if the directory is already present.
- No `WM_SETTINGCHANGE` broadcast is sent after the Windows PATH write, on
  purpose (would need the `windows`/`windows-sys` crate or raw FFI, an
  extra dependency not worth it for a "nice to have"): new terminals opened
  right after may still need one more restart, or the user logging off/on,
  before they see the updated PATH. The onboarding summary message says
  this to the user.

## Conventions

- Code comments and UI text in English; identifiers in English too.
- serde fields with camelCase `rename` to mirror the TS types (`types.ts`
  and `session.rs` must be kept in sync).
- Plain CSS in `App.css` with variables (`--bg`, `--accent`…); per-language
  colors in `.lang-<type>` classes.
- New text types: add to `DetectedType` + `LANGUAGE_LABELS` (types.ts), a
  heuristic in `detector.ts` (extension in `EXT_MAP` +, if applicable, a
  `looksLike*` function in the `detect()` cascade), a CM6 extension in
  `languages.ts`, a `.lang-*` class in App.css, and, if applicable,
  `formatter.ts` + `extFor()` in `actions.ts`. Recent example: Markdown
  (`@codemirror/lang-markdown`, no formatter, highlighting only — same as
  Java/Python).
- New action with a configurable shortcut: add its `ActionId` + an entry in
  `ACTION_ORDER`/`ACTION_LABELS`/`DEFAULT_SHORTCUTS` (`store/settings.ts`,
  being careful not to collide with the existing ones or with
  `FIXED_SHORTCUTS`), an item in `TabBar.tsx`'s dropdown, and a
  `matchesShortcut(...)` branch in `App.tsx`'s `keydown` handler.
  `SettingsDialog.tsx` doesn't need touching: it iterates `ACTION_ORDER`
  automatically.

## Current status

- Phases 0–4 of PLAN.md: **code-complete**. Typecheck and Vite build pass;
  detector smoke tests 12/12 (before the renames, Markdown, and this
  translation — not re-run since).
- Phase 5 (packaging): scripts are ready; the user already built on Linux
  (after the xdg-utils fix, and before the renames — needs rebuilding with
  the current name). Windows/macOS native builds still lack end-to-end
  confirmation on a real machine of each OS.
- **`cargo build` has never run in the original dev environment** (no Rust
  toolchain there): the Linux backend builds in Docker, but any new Rust
  compile error (including this session's, see below) will only be caught
  there or on a machine with Rust installed.
- **Renamed FormatPad → OmniText** (an earlier session): `package.json`,
  `Cargo.toml`, `tauri.conf.json`, `main.rs`, `localStorage` keys, Docker
  image/volume names, script output binaries, window title, CI, identifier
  → `com.omnitext.app`.
- **Renamed OmniText → LittlePad** (a later session, same pattern as
  before): `package.json`, `Cargo.toml` (package and lib name:
  `littlepad_lib`), `tauri.conf.json` (productName, window title,
  `identifier` → `com.littlepad.app`), `main.rs`, `localStorage` keys
  (`littlepad.settings`, `littlepad.session.*`), default data directory
  (`$HOME/.littlepad`, see below), Docker image/volume names, script
  output binaries, CI. `package-lock.json` was **not** hand-edited (it
  resyncs on the next `npm install`) — it may still say "omnitext" in the
  root package name until then; cosmetic, doesn't break anything.
- **GPL-3.0-or-later license added** for public GitHub publication: a
  `LICENSE` file (official FSF text, unmodified) + a `"license"` field in
  `package.json` and `Cargo.toml`. If the project adds dependencies in the
  future, check that they're all GPL-3.0-compatible (most npm/crates.io
  packages in the current stack are MIT/Apache, which are compatible).
- **Default data directory changed to `$HOME/.littlepad`** (previously
  `app_data_dir()`, which varied by OS and depended on the identifier). The
  override pointer file (`data-location.json`) now always lives inside
  `$HOME/.littlepad`, no longer in `app_config_dir()` — simpler and fully
  independent of Tauri's identifier.
- **Window-close bug fixed (high-confidence hypothesis, unable to test
  it)**: `capabilities/default.json` was missing the
  `core:window:allow-destroy` permission (only `allow-close` was there),
  which likely made `win.destroy()` fail silently after
  `preventDefault()`, leaving the window open. The permission was added,
  `closing = true` was moved earlier (before flushing, to close a race if
  the user keeps trying to close while the flush is in flight), and
  `win.close()` was added as a fallback if `destroy()` still fails for any
  other reason.
- Markdown: new `DetectedType`, detected by extension (`.md`/`.markdown`/
  `.mdx`) or by a content heuristic (headings, links, lists, ```` ``` ````
  code blocks, bold, blockquotes — with a score threshold to avoid
  confusion with TOML/INI's `#` comments); colored via
  `@codemirror/lang-markdown` (a new dependency in package.json, with
  `npm install` never run in this environment). No formatter (like
  Java/Python): highlighting + folding only.
- Find & replace (`FindReplaceDialog.tsx`) implemented on top of
  `@codemirror/search` (already a dependency, previously unused);
  `store/settings.ts` stores a configurable shortcut per action (7 total);
  `SettingsDialog.tsx` lists and lets you reassign all of them.
- Smart paste (normalize LF + auto-format/detect on an empty tab) via
  `EditorView.domEventHandlers` in `EditorHost.tsx`.
- Menu merged into `TabBar.tsx` (`Toolbar.tsx` no longer exists, it was
  deleted); drag & drop of files via `onDragDropEvent` (Tauri) with a DOM
  fallback in the browser; the text-type combo box restyled for the dark
  theme.
- Save/Don't Save/Cancel dialog on closing tabs (`CloseConfirmDialog.tsx`)
  replacing the earlier `window.confirm`; to let that dialog reuse saving
  logic, the actions were extracted from `App.tsx` into `src/actions.ts`
  (a refactor, same behavior). Reopen closed tab with Ctrl+Shift+T
  (`reopenClosedFile`), pure in-memory history, new configurable `ActionId`
  `reopenClosed` (8 shortcuts total now).
- **Full translation to English** (this session): every source comment and
  UI string that used to be in Spanish (frontend, Rust backend, build
  scripts, Dockerfile, CI, and this very file) was translated. The project
  used to have an explicit "UI and comments in Spanish" convention (see
  earlier revisions of this file if you need the history) — that's now
  fully reversed. Nothing in the request implied re-translating `LICENSE`
  (official legal text, left untouched) or already-English content.
- Column (multi-cursor) edit mode (Alt+Shift+Insert), implemented entirely
  inside `EditorHost.tsx` via a `Prec.highest` CM6 keymap. Verified against
  the actual `@codemirror/view`/`@codemirror/state` source on GitHub
  (`KeyBinding.key` format, modifier order, `EditorSelection.create`'s
  `mainIndex` semantics after internal sorting) rather than written purely
  from memory, since this project can't compile TS here to check it another
  way — see "Not verified" below for what that research couldn't cover.
  **Later revised** (user reported it as confusing): the toggle became a
  configurable shortcut (see the `columnMode`/`shortcutRequiresCtrl` entries
  above), a status bar badge now indicates when it's armed, and switching
  tabs now always disarms it — previously the armed flag leaked across tabs
  silently, which was the actual root cause of the confusion. Also verified
  against source at the time: `EditorView.domEventHandlers`' `keydown`
  handler returning `true` auto-calls `preventDefault()` **and** pre-empts
  CM6's own keymap-driven handling for that same event when registered at
  higher precedence (confirmed via `@codemirror/view`'s `input.ts`), which is
  what makes the live-reconfigurable toggle safe to coexist with the
  still-static ArrowUp/ArrowDown/Escape keymap bindings.
  **Revised yet again** (explicit follow-up request, same session): the
  behavior didn't match real editors' "column mode" — the fix requires
  Shift for the actual column selection (plain arrows now always behave
  normally) and removes the Escape binding entirely (only the configured
  shortcut disarms it now). See the `EditorHost.tsx` and `Shift-ArrowDown`/
  `Shift-ArrowUp` entries above for the current design.
  **One more round** (same session): disarming while a multi-row column
  selection was active used to leave it selected; now `setColumnModeArmed`
  calls `simplifySelection(view)` on disarm, collapsing it to a single
  cursor. Also removed the top banner shown on arm/disarm entirely — the
  status bar badge alone is the indicator now, per explicit request ("no es
  necesario, ya tenemos el indicador"). Don't re-add either behavior without
  being asked again.
- Open-file-from-CLI into the same instance: `tauri-plugin-single-instance`
  (new dependency) + `LaunchFiles` managed state + `get_launch_files`/
  `open-files` event, per the plugin's own official README (fetched live —
  the exact closure signature, "register first" requirement, and that argv
  includes the exe path at index 0 all come from that doc, not memory).
- First-run "create shortcut + add to PATH" onboarding
  (`onboarding.rs`, `OnboardingDialog.tsx`, `check_first_run`/
  `setup_shortcuts`). The Windows PATH-editing approach (read-modify-write
  `HKCU\Environment\Path` preserving `REG_SZ`/`REG_EXPAND_SZ` via the
  `winreg` crate) and the plugin/API names above were checked against
  `winreg`'s real source/README on GitHub, not guessed — see the gotcha
  above. This is still the least-tested part of the whole project: no
  Windows, Linux desktop environment, or macOS machine is available here
  to actually click through it.
- `--no-bundle` everywhere (scripts, Dockerfile, CI): only a plain
  executable is produced now, no installers of any kind. Verified against
  `tauri-action`'s real README (the `--no-bundle` flag + `uploadPlainBinary`
  pairing is explicitly documented there, including the warning that Tauri
  doesn't officially support "portable mode" on non-Windows platforms —
  worth rereading before relying on this further). **Superseded for macOS**
  by a later session — see "macOS ships a `.app`" below; still accurate for
  Windows/Linux.
- **Not verified with a real build, frontend or backend**: this
  environment has neither Node/npm nor Rust/cargo installed, so NONE of the
  work from any session has been compiled or run. Check with
  `npx tsc --noEmit` + `npm run dev` (frontend) and `npm run tauri dev` or
  `cargo check` (backend) as soon as you can — with **high priority on the
  window-close fix** (it's a blocking bug) and on confirming that
  `@tauri-apps/api` v2 really exposes `app.path().home_dir()` the way it's
  used in `session.rs`. Besides what was already flagged in earlier
  sessions (CodeMirror's `domEventHandlers`/`SearchQuery`, Tauri's
  `onDragDropEvent`), from this session: the exact
  `core:window:allow-destroy` permission name (not checked against the
  installed schema), `@codemirror/lang-markdown`'s version (written from
  memory in package.json), whether the `Cargo.toml` rename (`[package]
  name`) broke anything that depended on the previous binary name
  (`omnitext`/`formatpad` → now `littlepad`; scripts already updated, but
  untested), and — from this translation pass — that no string was
  mistranslated in a way that changes its meaning or breaks a template
  literal/JSX expression (a mechanical but large diff across ~20 files).
  From *this* session, on top of the research-backed pieces noted just
  above: whether `winreg = "0.56"` and `tauri-plugin-single-instance = "2"`
  actually resolve/compile against this project's exact Tauri 2 version
  (only the *API shape* was checked, not that these specific version
  numbers exist and are mutually compatible); the PowerShell/WScript.Shell
  shortcut-creation snippet in `onboarding.rs` (a very standard pattern,
  but not run); and that the multi-cursor typing behavior actually feels
  right in practice (the CM6 API usage is verified, but not the UX).

## Pending (suggested priority)

1. **Verify that the app actually closes** (`npm run tauri dev`, the
   window's X button) — a blocking bug fixed in an earlier session, still
   not confirmed on a real machine.
2. **Verify the first-run onboarding on a real Windows machine**
   (`onboarding.rs`'s registry/PowerShell code) — the highest-risk
   untested piece in the project right now. Also check Linux (`.desktop`
   file actually shows up in the app menu; symlink launches the app) and
   macOS (Desktop symlink behavior, `~/.local/bin` PATH). Same for its
   inverse, Settings → Danger zone → Uninstall (`onboarding::remove`,
   `session::delete_all_data`) — untested on any real machine, and the
   Windows PATH-stripping registry code in particular deserves a careful
   look before trusting it on a machine with a real, hand-edited PATH.
3. **Verify `--no-bundle` actually produces a working binary** on the
   Windows/Linux build paths (scripts + CI), that **macOS's `--bundles app`
   produces a working, launchable `LittlePad.app`** (untested — no Mac
   available in this environment), and that `tauri-action`'s
   `uploadPlainBinary` (true for Windows/Linux, false for macOS) uploads
   the right artifact to a draft Release for all three.
3a. **Update `onboarding.rs`'s macOS `setup()`** for the new `.app` (see the
    "macOS ships a `.app`" decision above) — the Desktop symlink and its
    summary message predate it and are now redundant/stale; not done yet.
4. **Verify opening a file via CLI** into an already-running instance
   (`littlepad foo.json` twice) and via the initial launch's own argv.
5. **Verify column edit mode** feels right in practice: arm it
   (Alt+Shift+Insert by default), confirm plain Up/Down move the caret
   normally (no cursors added), confirm Shift+Up/Down grows/shrinks a
   column selection and that typing/deleting applies across all its rows,
   and confirm Escape does *not* disarm it (only the shortcut, pressed
   again, does) — the CM6 API usage was checked against source, the UX
   wasn't. Also verify: the status bar's "⌶ Column mode" badge
   appears/disappears correctly, reassigning the shortcut from ⚙ Settings →
   Keyboard shortcuts actually takes effect live (no reload needed), and
   switching tabs while armed disarms it instead of carrying over to the
   new tab.
6. End-to-end autosave test: edit → `kill -9` → reopen → verify
   restoration (the "torture test" from PLAN.md phase 3); also verify that
   a filesystem file with unsaved changes shows those changes on reopening.
7. Install Vitest and turn the detector's smoke test into a real suite
   (`src/services/detector.test.ts`, real config/log fixtures, including
   Markdown cases).
8. `tauri-plugin-window-state` plugin (planned in PLAN.md, not yet added;
   `tauri-plugin-single-instance` was the other one planned there and is
   now done).
9. Restore folds and per-tab scroll position (today only the cursor is
   restored).
10. ~~A proper app icon~~ — done this session (`app-icon.svg` + `tauri icon`
    wired into every build script, see below); the committed
    `src-tauri/icons/*` files are still Tauri's defaults until a build
    script actually runs once with the toolchain installed and regenerates
    them.
11. Phase 6+ backlog (PLAN.md §7): diff between tabs, JSON⇄YAML⇄XML
    conversion, minify, fold by level N, read-only mode for huge files
    (>50 MB), a JS formatter, themes.

## Decisions already made (don't reopen without a reason)

- React instead of vanilla/Svelte (user's request).
- No state or CSS framework (keep it lightweight).
- Formatting for Java/Python/Markdown is **out of scope** for the MVP
  (highlighting and folding only); communicated and accepted.
- Close-tab confirmation: only if (dirty && filePath), or if it's a tab
  with no file and non-empty text (closing the tab deletes its session
  cache). A custom 3-option dialog (Save/Don't Save/Cancel). **This only
  applies to closing an individual tab** — closing the whole window/app
  NEVER asks anything (explicit user request): it just flushes and closes,
  and reopening restores everything from the cache exactly as it was.
- Reopen-closed (Ctrl+Shift+T) reopens the FILE from disk, it does not
  restore the tab's unsaved content — a deliberate decision to avoid
  conflating "reopen a file" with "undo a close"; and the history is
  pure memory (doesn't survive an app restart), on purpose, as requested.
- Default data directory fixed at `$HOME/.littlepad` (not each OS's native
  conventions like `~/.local/share/<id>` or `%APPDATA%\<id>`) — simplicity
  and predictability explicitly requested by the user, accepting that it
  doesn't follow each OS's "native" convention.
- Tauri identifier changed to `com.littlepad.app` as part of the rename;
  accepted because it no longer affects the data location (see above).
- License: **GPL-3.0-or-later** (explicit request to publish on GitHub "to
  the whole public"); v2 vs. v3 wasn't asked about — v3 was assumed since
  the FSF recommends it for new projects. If the user actually wanted v2,
  flag it before assuming otherwise going forward.
- Full translation to English (explicit request, this session): the
  project's earlier "Spanish UI/comments, English-only README" convention
  is fully reversed now — everything is English. Don't revert to Spanish
  without being asked.
- Column edit mode's shortcut **used to be** fixed, not user-configurable —
  it didn't fit `store/settings.ts`'s `Shortcut` model, which assumed every
  configurable action requires Ctrl/Cmd. **Later revised** (explicit
  request): rather than loosening that assumption for every action (risky —
  `App.tsx`'s global keydown handler bails out early via `if (!mod) return`
  before ever consulting `shortcuts`, so an Alt-only combo assigned to any
  *App.tsx-handled* action would silently never fire), the fix is scoped to
  just this one action via `shortcutRequiresCtrl(id)`: `columnMode` alone is
  allowed an Alt-only combo (still must include Alt, so it can't collide
  with normal typing), everything else still requires Ctrl exactly as
  before. This is safe specifically because column mode's toggle is handled
  entirely inside `EditorHost.tsx`'s own CodeMirror-level key handling, not
  `App.tsx`'s handler — so that early `if (!mod) return` bailout never
  applies to it in the first place.
- No installers at all, ever, by default (`--no-bundle` baked into every
  Windows/Linux build path) — explicit request ("elimina los
  instaladores... solo entrega los ejecutables"). **Revised for macOS in a
  later session**: the "no Finder double-click" trade-off this bullet used
  to accept turned out to be a real usability problem (double-clicking a
  raw Unix binary opens a Terminal window instead of the app), not just a
  cosmetic one, so macOS now gets `--bundles app` — see "macOS ships a
  `.app`" above. Still no `.dmg`/`.pkg`/code signing/notarization; Windows
  and Linux are unaffected.
- PATH modification uses **additive symlinks into `~/.local/bin`** on
  Linux/macOS (not editing `.bashrc`/`.zshrc`/`.profile`) and a **direct,
  type-preserving registry read-modify-write** on Windows (not `setx`,
  which silently truncates PATH values over ~1024 characters — a known
  footgun). No shell rc file is ever parsed or edited by this project.
- First-run onboarding asks **at most once, ever**, regardless of the
  user's answer (Yes or No) — the marker file is written the moment
  `check_first_run` is first called, not only if the user says yes. There
  is currently no way to re-trigger it from Settings; add one if asked.
- App icon: `app-icon.svg` — user-picked from Wikimedia Commons
  ("Gartoon apps kedit.svg", GPL/DSL), not generated/commissioned. Icons are
  **regenerated on every build** (`tauri icon app-icon.svg`, wired into
  every build script) rather than committed as static PNG/ICO/ICNS —
  explicit request ("agrega esta transformación en los scripts de
  compilación"). Attribution lives in `README.md` (`## Icon credit`,
  user-specified exact wording) and as an XML comment inside the SVG
  itself; don't remove either without a replacement icon that doesn't need
  it.
- **Regenerating icons alone is not enough to change the compiled binary's
  icon** — this bit Cargo's build caching, twice (see git history: an
  earlier attempt at this fix used a `cargo clean -p littlepad` step in
  every build script, which covered `tauri build` but not `tauri dev`).
  Root cause (verified against `tauri-build`'s and `tauri-codegen`'s actual
  source): `tauri-build`'s `build.rs` only emits `cargo:rerun-if-changed`
  for `tauri.conf.json`, not the icon files themselves. Worse, the runtime
  `default_window_icon` (used on every platform, including Linux's
  window/taskbar icon, not just Windows resource embedding) is baked in by
  the `tauri::generate_context!()` proc macro reading icon bytes with plain
  `fs::read` — not `include_bytes!` — so rustc has zero dependency-tracking
  on it either; a cached compile silently keeps the old icon forever,
  **regardless of build profile or command** (`cargo build`, `--release`,
  `tauri dev`, `tauri build`, from any script or none).
  The actual fix, in `src-tauri/build.rs`: declare `rerun-if-changed` on
  `icons/` and `../app-icon.svg` (forces this script to rerun when icons
  change), and — the part that matters — hash the icon files' bytes and
  emit that hash via `cargo:rustc-env=LITTLEPAD_ICON_HASH=...`. Any change
  in a build script's `rustc-env` output invalidates Cargo's fingerprint
  for every target in the package, forcing a real recompile (including
  `generate_context!()`'s re-expansion) exactly when the icon actually
  changed — and only then, so it doesn't force a full rebuild on every
  single build the way `cargo clean` did. This works uniformly across
  `tauri dev`/`tauri build`, debug/release, and CI (where `rust-cache`
  persists `src-tauri/target` **across separate release runs** — this fix
  still applies there since it's keyed off the icon bytes, not the profile
  or command). Nothing in any build script needs to know about this.
- Ctrl+D (duplicate selection/line) **used to be** fixed, not
  user-configurable — same treatment as column edit mode/Ctrl+F above.
  Implemented in `EditorHost.tsx` via `state.changeByRange` (handles
  multi-cursor for free). **Later revised** (explicit request, "asegúrate
  que... todos sean editables"): it's now a configurable action
  (`duplicateLine`), resolved dynamically against `settingsStore` inside
  `handleEditingShortcuts`, still bound at `Prec.highest` (via
  `EditorView.domEventHandlers`, not CM6's static keymap DSL, since that
  needs compile-time-fixed key strings) so it can't be shadowed by CM6's
  default keymap.
- Ctrl+Shift+Up/Ctrl+Shift+Down (move line up/down) reuses CM6's own
  `moveLineUp`/`moveLineDown` from `@codemirror/commands` rather than
  reimplementing line-swapping — verified against `@codemirror/commands`'
  source that these exist and are exactly what's needed (they already
  handle multi-line selections and multiple cursors). **Originally bound to
  plain `Mod-ArrowUp`/`Mod-ArrowDown`, changed to `Mod-Shift-ArrowUp`/
  `Mod-Shift-ArrowDown` per explicit follow-up request** (same session),
  and **originally fixed, later made configurable** (`moveLineUp`/
  `moveLineDown`, same request/session as Ctrl+D above) — same
  `handleEditingShortcuts`/`domEventHandlers` treatment, replacing the old
  static `editingKeymap`. The default (Ctrl+Shift+Up/Down, i.e. `Mod-Shift-`,
  Cmd on macOS) still knowingly shadows CM6 `standardKeymap`'s macOS-only
  default of Cmd+Shift+Up/Down extending the selection to the document
  start/end (`selectDocStart`/`selectDocEnd`, reached via the mac binding's
  `shift:` sub-command on its `Cmd-ArrowUp`/`Cmd-ArrowDown` entries —
  Windows/Linux never bind anything to Mod-Shift-ArrowUp/Down in the first
  place, so no shadowing happens there). Not verified on an actual Mac; flag
  it if a Mac user reports missing document-boundary selection.
- Ctrl+W (close tab) and the zoom shortcuts (Ctrl+Plus/Minus/0) were also
  **originally fixed, later made configurable** in the same request/session
  (`closeTab`, `zoomIn`, `zoomOut`, `resetZoom` in `settings.ts`; resolved in
  `App.tsx`'s global keydown handler like every other app-level action).
  Ctrl+Tab/Ctrl+Shift+Tab (cycling tabs) is the one shortcut that's
  deliberately still fixed — see the `FIXED_SHORTCUTS` note above.
- Editor font size/family live in `store/settings.ts` (`fontSize`,
  `fontFamily`), persisted the same way as shortcuts (localStorage). They're
  applied as CSS custom properties (`--editor-font-family`/`--editor-font-size`,
  set inline on `.editor-host` in `EditorHost.tsx`) that `.cm-scroller` in
  `App.css` reads — not a CodeMirror theme compartment — so a zoom/font
  change never needs to reconfigure editor extensions. Ctrl+Scroll wheel
  zoom clamps at `DEFAULT_FONT_SIZE` (13px) as its floor, per explicit
  request ("bajar el zoom... hasta el tamaño de la fuente normal").
- System font enumeration (`list_system_fonts` in `commands.rs`) uses the
  `font-kit` crate (`SystemSource::new().all_families()`), an **explicit
  choice over a fixed CSS-only font list** after asking the user — it needs
  `libfontconfig1-dev`/`libfreetype6-dev`/`pkg-config` on Linux (added to
  `docker/linux.Dockerfile` and `release.yml`'s Linux step); macOS/Windows
  need no extra system packages (CoreText/DirectWrite ship with the OS
  toolchain). This dependency and its CI/Docker wiring were added without a
  working `cargo`/`npm` in the dev sandbox, so **verify a real
  `cargo build`/`npm run tauri build` on Linux, and ideally macOS/Windows in
  CI, before shipping**.
- Bundled fonts (Ubuntu Monospace, MesloLGS NF, `public/fonts/`) are
  declared via `@font-face` in `App.css` (paths percent-encoded for the
  space in their folder/file names) and offered in Settings' font picker
  alongside the OS's own fonts. Licenses are in `THIRD-PARTY-NOTICES.md`
  *and* linked from the Settings dialog itself (user asked for both).
- Word wrap, unlike font size/family, **is** a CodeMirror compartment
  (`wrapCompartment` in `EditorHost.tsx`, toggling `EditorView.lineWrapping`
  on/off) rather than a CSS variable — wrapping genuinely changes layout
  extensions, there's no CSS-only equivalent. It's global (one `wordWrap` in
  `settingsStore`), not per-tab, so every tab's cached `EditorState` must be
  reconciled to the current value at swap time — same pattern the language
  compartment already used, just replicated: the tab-swap effect
  reconfigures both `langCompartment` and `wrapCompartment` together in one
  dispatch whenever a tab becomes active, so a background tab's stale
  compartment value (baked in whenever that tab's state was created) never
  leaks through after a switch.
