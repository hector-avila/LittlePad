# Changelog

## [1.2.1] - 2026-09-04

- Fixed the "Support ending for Intel-based Apps" warning on Apple Silicon
  Macs (macOS release is now a single universal binary).

## [1.2.0] - 2026-09-03

- Share files in real time between LittlePad instances (Settings → Share),
  self-hosted and end-to-end encrypted — see [SERVER.md](SERVER.md).
- Share Settings: one Server URL field (supports a custom path), wider
  inputs, and a link to SERVER.md.
- Resizable find/replace input fields, remembered across launches.
- Fixed a macOS bundle identifier warning when building
  (`com.littlepad.app` → `com.littlepad.desktop`).

## [1.1.0] - 2026-08-28

- Configurable interface text size, separate from the editor font.
- Smarter find/replace: select-all on open, better Tab order.
- Notifies you when a new version is available.
- Optional "Open with LittlePad" file associations.
- Settings window is now bigger, resizable, and remembers its size.

## [1.0.0] - 2026-08-01

First stable release.

- Multiple tabs, drag & drop, reopen closed tab, crash-proof autosave.
- Find & replace with live highlighting, match count, and regex/case toggles.
- Column (multi-cursor) editing, duplicate line, move line up/down.
- Auto language detection and syntax highlighting (JSON, XML, YAML, TOML,
  INI, logs, JS, Java, Python, Markdown).
- Pretty-printing for JSON, XML, and YAML.
- Configurable keyboard shortcuts, editor font, and data location.
- Cross-platform (Windows, Linux, macOS), no installer required.
