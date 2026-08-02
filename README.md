# LittlePad

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)

LittlePad is a small, free desktop app for Windows, Linux, and macOS where
you can paste or open configuration files and logs — JSON, XML, YAML, and
more — and instantly get them colored, tidied up, and easy to read. No
installation wizard, no setup, no account: download it, open it, and start
pasting.

> **A friendly heads-up:** this app was "vibecoded" — written entirely
> with the help of AI, start to finish. It's not a big company's product;
> it's a small, free tool made with real care and attention by one human
> who wanted a nicer way to read logs and configs. Use it with that in
> mind, and if something looks off, it's still looked after.

## What can I do with it?

- **No telemetry, no internet, just you and your editor**: LittlePad
  doesn't phone home, doesn't check for updates behind your back, and
  doesn't need a connection to work. What you paste stays on your
  computer.
- **Paste anything and it "just works"**: paste a messy JSON, XML, YAML, or
  log file and LittlePad automatically figures out what it is, colors it,
  and can tidy up ("format") the indentation for you.
- **Never lose your text**: LittlePad quietly saves what you're working on
  as you type. If the app crashes, the power goes out, or you close it by
  mistake, your text is still there the next time you open it — even if
  you never saved it to a file.
- **Work with several files at once**, in tabs, just like a web browser.
  Double-click a tab to rename it; middle-click (or the × button) to close
  it.
- **Find and replace text**, with the matches highlighted as you type, and
  a counter showing how many were found.
- **Drag and drop files** onto the window to open them.
- **Fold sections of a file** (collapse/expand) to hide parts you don't
  need to look at right now — handy for long JSON/XML/YAML files.
- **Pick your own editor font** from the ⚙ Settings screen.
- **Closing the app never asks "Are you sure?"** — it just remembers
  everything and picks up right where you left off next time.

## Getting LittlePad

LittlePad doesn't need to be installed — it's a single file you download
and run.

1. Go to the project's **Releases** page and download the file for your
   operating system.
2. Put it wherever you like (Desktop, Documents, a USB stick — it doesn't
   matter) and open it. (On macOS, the first time you open it you may need
   to right-click the app and choose **Open** once, since it isn't signed
   by an "identified developer.")
3. The first time you run it, LittlePad will offer to add a shortcut to
   your Desktop (and Start Menu, on Windows) so it's easier to find next
   time. You can say no and set this up later from ⚙ Settings.

There's nothing to uninstall beyond deleting that one file — LittlePad
doesn't write anything to your system outside its own data folder (see
⚙ Settings → "Danger zone" for a one-click cleanup of that folder too).

## Keyboard shortcuts

Every keyboard shortcut in LittlePad — new tab, save, find, zoom, all of
them — lives in one place and can be changed to whatever you like: open
⚙ Settings → Keyboard shortcuts.

## For developers

Want to build LittlePad from source or contribute to it? See
[BUILDING.md](BUILDING.md) for build instructions, and
[AGENTS.md](AGENTS.md) for a deeper developer guide — and for the
wonderfully paranoid people who never trust a stranger's binary from the
internet (they're doing it right!), that's also where you'll find how to
build your own.

## License

LittlePad is licensed under the [GNU General Public License v3.0 or later](LICENSE)
(GPL-3.0-or-later). See the [`LICENSE`](LICENSE) file for the full text.

## Icon credit

The app icon ([`app-icon.svg`](app-icon.svg)) is
["Gartoon apps kedit.svg"](https://commons.wikimedia.org/wiki/File:Gartoon_apps_kedit.svg)
by Zeus, Patrick Yavitz, La Mula Francis
([GPL](http://www.gnu.org/licenses/gpl.html) or
[DSL](http://www.fsf.org/licensing/licenses/dsl.html)), via Wikimedia
Commons. The platform-specific icon files under `src-tauri/icons/` are
generated from it by `tauri icon` (see [BUILDING.md](BUILDING.md)).
