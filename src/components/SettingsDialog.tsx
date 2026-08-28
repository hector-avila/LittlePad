import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useStore } from '../store/createStore';
import { settingsOpenStore, closeSettingsDialog, showBanner } from '../store/misc';
import * as backend from '../services/backend';
import Changelog from './Changelog';
import changelogSource from '../../CHANGELOG.md?raw';
import { version as appVersion } from '../../package.json';
import {
  settingsStore,
  setShortcut,
  setFontFamily,
  setBaseFontSize,
  setUiFontSize,
  setSettingsDialogSize,
  formatShortcut,
  isTaken,
  shortcutRequiresCtrl,
  normalizeExtension,
  addAssociatedExtension,
  removeAssociatedExtension,
  clearAssociatedExtensions,
  ACTION_ORDER,
  ACTION_LABELS,
  BUNDLED_FONTS,
  KNOWN_FILE_EXTENSIONS,
  MIN_FONT_SIZE,
  MAX_FONT_SIZE,
  MIN_UI_FONT_SIZE,
  MAX_UI_FONT_SIZE,
  type ActionId,
  type Shortcut,
} from '../store/settings';

const IGNORED_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta']);

const FONT_LICENSES: Record<(typeof BUNDLED_FONTS)[number], string> = {
  'Ubuntu Monospace': 'https://canonical.com/legal/font-licence',
  'MesloLGS NF': 'https://github.com/romkatv/dotfiles-public/tree/master/.local/share/fonts/NerdFonts',
};

type SectionId =
  | 'shortcuts'
  | 'font'
  | 'interface'
  | 'data'
  | 'shortcut'
  | 'fileAssociations'
  | 'danger'
  | 'about';

/** Left-nav sections; `tauriOnly` ones are hidden entirely in the browser dev build. */
const SECTIONS: { id: SectionId; label: string; tauriOnly?: boolean }[] = [
  { id: 'shortcuts', label: 'Keyboard shortcuts' },
  { id: 'font', label: 'Editor font' },
  { id: 'interface', label: 'Interface' },
  { id: 'data', label: 'Data location' },
  { id: 'shortcut', label: 'Desktop shortcut & PATH', tauriOnly: true },
  { id: 'fileAssociations', label: 'File associations', tauriOnly: true },
  { id: 'danger', label: 'Danger zone', tauriOnly: true },
  { id: 'about', label: 'About' },
];

/** Whether this OS supports the interactive, per-extension "Open with" checklist. */
function supportsFileAssociations(os: string | undefined): boolean {
  return os === 'windows' || os === 'linux';
}

export default function SettingsDialog() {
  const { open } = useStore(settingsOpenStore);
  const settings = useStore(settingsStore);
  const [recording, setRecording] = useState<ActionId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dataDir, setDataDir] = useState<string | null>(null);
  const [systemFonts, setSystemFonts] = useState<string[]>([]);
  const [platform, setPlatform] = useState<{ os: string; arch: string } | null>(null);
  const [section, setSection] = useState<SectionId>('shortcuts');
  const [extInput, setExtInput] = useState('');
  const [extBusy, setExtBusy] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // True while (and for a beat after) the user drags the resize handle:
  // releasing the pointer past the dialog's edge mid-drag registers as a
  // click on the overlay behind it, which would otherwise close the dialog
  // (see the overlay's onClick below).
  const resizingRef = useRef(false);
  const resizingTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!open || !backend.isTauri) return;
    backend.getDataDir().then(setDataDir).catch(() => setDataDir(null));
    backend.listSystemFonts().then(setSystemFonts).catch(() => setSystemFonts([]));
    backend.getPlatformInfo().then(setPlatform).catch(() => setPlatform(null));
  }, [open]);

  // Persists the dialog's size after the user drags its resize handle
  // (debounced so dragging doesn't spam localStorage on every pixel).
  useEffect(() => {
    if (!open) return;
    const el = dialogRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver(() => {
      resizingRef.current = true;
      clearTimeout(resizingTimeoutRef.current);
      resizingTimeoutRef.current = setTimeout(() => {
        resizingRef.current = false;
      }, 1000);

      clearTimeout(timer);
      timer = setTimeout(() => {
        if (dialogRef.current) {
          setSettingsDialogSize(dialogRef.current.offsetWidth, dialogRef.current.offsetHeight);
        }
      }, 300);
    });
    observer.observe(el);
    return () => {
      clearTimeout(resizingTimeoutRef.current);
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [open]);

  if (!open) return null;

  const chooseDataDir = async () => {
    const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
    const chosen = await openDialog({ directory: true, multiple: false, title: 'Choose data folder' });
    if (typeof chosen !== 'string') return;
    try {
      await backend.setDataDir(chosen);
      setDataDir(chosen);
      showBanner('Location updated. Restart the app for it to take effect.');
    } catch (e) {
      showBanner(String(e), 'error');
    }
  };

  const recreateShortcuts = async () => {
    try {
      const message = await backend.setupShortcuts();
      showBanner(message);
    } catch (e) {
      showBanner(String(e), 'error');
    }
  };

  // Toggles one extension's Windows "Open with" registration. Also used to
  // register a brand-new custom extension (it's simply not in
  // `associatedExtensions` yet, so this takes the "register" branch).
  const toggleExtension = async (ext: string) => {
    const active = settings.associatedExtensions.includes(ext);
    setExtBusy(ext);
    try {
      if (active) {
        await backend.unregisterFileAssociation(ext);
        removeAssociatedExtension(ext);
      } else {
        await backend.registerFileAssociation(ext);
        addAssociatedExtension(ext);
      }
    } catch (e) {
      showBanner(String(e), 'error');
    } finally {
      setExtBusy(null);
    }
  };

  const addCustomExtension = () => {
    const normalized = normalizeExtension(extInput);
    if (!normalized) {
      showBanner('Enter a valid extension, e.g. "rs" or ".rs"', 'error');
      return;
    }
    setExtInput('');
    if (!settings.associatedExtensions.includes(normalized)) void toggleExtension(normalized);
  };

  const removeAllAssociations = async () => {
    try {
      const message = await backend.removeAllFileAssociations(settings.associatedExtensions);
      clearAssociatedExtensions();
      showBanner(message);
    } catch (e) {
      showBanner(String(e), 'error');
    }
  };

  const uninstall = async () => {
    const { ask, message } = await import('@tauri-apps/plugin-dialog');
    const confirmed = await ask(
      'This permanently deletes every tab and autosaved file LittlePad has ' +
        'stored, and removes its desktop shortcut and PATH entry. This ' +
        'cannot be undone.\n\nDelete everything?',
      { title: 'Uninstall LittlePad', kind: 'warning', okLabel: 'Delete everything', cancelLabel: 'Cancel' },
    );
    if (!confirmed) return;

    // Best-effort: a missing shortcut/PATH entry (or, on non-Windows, the
    // fact that file associations don't apply at all) shouldn't block
    // deleting the data itself.
    await backend.removeShortcuts().catch(() => {});
    await backend.removeAllFileAssociations(settings.associatedExtensions).catch(() => {});

    try {
      await backend.deleteAppData();
    } catch (e) {
      showBanner(`Could not delete app data: ${e}`, 'error');
      return;
    }

    await message(
      'All LittlePad data has been removed. The app will now close — you ' +
        'can delete the executable file yourself.',
      { title: 'Uninstall complete', kind: 'info' },
    );
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().destroy();
  };

  const capture = (id: ActionId, e: KeyboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      setRecording(null);
      setError(null);
      return;
    }
    if (IGNORED_KEYS.has(e.key)) return;

    const mod = e.ctrlKey || e.metaKey;
    if (shortcutRequiresCtrl(id)) {
      if (!mod) {
        setError('The shortcut must include Ctrl');
        return;
      }
    } else if (!mod && !e.altKey) {
      setError('The shortcut must include Ctrl or Alt');
      return;
    }
    const shortcut: Shortcut = {
      key: e.key.toLowerCase(),
      ctrl: mod,
      shift: e.shiftKey,
      alt: e.altKey,
    };
    const taken = isTaken(shortcut, settings.shortcuts, id);
    if (taken) {
      setError(
        taken === 'fixed'
          ? 'That shortcut is already used by a fixed action (close tab, switch tab…)'
          : `That shortcut is already used by "${ACTION_LABELS[taken]}"`,
      );
      return;
    }
    setShortcut(id, shortcut);
    setRecording(null);
    setError(null);
    showBanner(`"${ACTION_LABELS[id]}" is now ${formatShortcut(shortcut)}`);
  };

  const visibleSections = SECTIONS.filter((s) => !s.tauriOnly || backend.isTauri);

  // Extensions the user added that aren't in the built-in checklist, so
  // they still show up (and stay checked/removable) once registered.
  const customExtensions = settings.associatedExtensions.filter(
    (e) => !(KNOWN_FILE_EXTENSIONS as readonly string[]).includes(e),
  );

  return (
    <div
      className="dialog-overlay"
      onClick={() => {
        if (!resizingRef.current) closeSettingsDialog();
      }}
    >
      <div
        ref={dialogRef}
        className="settings-dialog settings-dialog-split"
        role="dialog"
        aria-label="Settings"
        style={{
          width: settings.settingsDialogSize.width,
          height: settings.settingsDialogSize.height,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-header">
          <h2>Settings</h2>
          <button onClick={() => closeSettingsDialog()} title="Close">
            ×
          </button>
        </div>

        <div className="settings-body">
          <nav className="settings-nav">
            {visibleSections.map((s) => (
              <button
                key={s.id}
                className={`settings-nav-item${section === s.id ? ' active' : ''}`}
                onClick={() => setSection(s.id)}
              >
                {s.label}
              </button>
            ))}
          </nav>

          <div className="settings-content">
            {section === 'shortcuts' && (
              <>
                <h3 className="settings-subheading">Keyboard shortcuts</h3>
                <p className="settings-hint">
                  Hold Ctrl (or Alt, for column edit mode) and press a key to reassign
                </p>
                {ACTION_ORDER.map((id) => (
                  <div className="settings-row" key={id}>
                    <span>{ACTION_LABELS[id]}</span>
                    {recording === id ? (
                      <input
                        className="shortcut-input recording"
                        autoFocus
                        readOnly
                        value="Press a key combination…"
                        onKeyDown={(e) => capture(id, e)}
                        onBlur={() => setRecording(null)}
                      />
                    ) : (
                      <button
                        className="shortcut-btn"
                        onClick={() => {
                          setRecording(id);
                          setError(null);
                        }}
                      >
                        {formatShortcut(settings.shortcuts[id])}
                      </button>
                    )}
                  </div>
                ))}
                {error && <div className="settings-error">{error}</div>}
              </>
            )}

            {section === 'font' && (
              <>
                <h3 className="settings-subheading">Editor font</h3>
                <p className="settings-hint">
                  Ctrl+Scroll wheel (or Ctrl+Plus/Minus) zooms the text size in/out — never
                  below "Normal size" here; Ctrl+0 resets it
                </p>
                <div className="settings-row">
                  <span>Normal size</span>
                  <input
                    type="number"
                    className="settings-number-input"
                    min={MIN_FONT_SIZE}
                    max={MAX_FONT_SIZE}
                    value={settings.baseFontSize}
                    onChange={(e) => {
                      const n = parseInt(e.target.value, 10);
                      if (!Number.isNaN(n)) setBaseFontSize(n);
                    }}
                  />
                </div>
                <div className="settings-row">
                  <span>Font family</span>
                  <select
                    className="settings-select"
                    value={settings.fontFamily}
                    onChange={(e) => setFontFamily(e.target.value)}
                  >
                    <option value="">System default (monospace)</option>
                    <optgroup label="Bundled">
                      {BUNDLED_FONTS.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </optgroup>
                    {backend.isTauri && systemFonts.length > 0 && (
                      <optgroup label="System fonts">
                        {systemFonts
                          .filter((name) => !(BUNDLED_FONTS as readonly string[]).includes(name))
                          .map((name) => (
                            <option key={name} value={name}>
                              {name}
                            </option>
                          ))}
                      </optgroup>
                    )}
                  </select>
                </div>
                <p className="settings-font-license">
                  {BUNDLED_FONTS.map((name, i) => (
                    <span key={name}>
                      {i > 0 && ' · '}
                      {name} (
                      <button type="button" onClick={() => void backend.openExternal(FONT_LICENSES[name])}>
                        license
                      </button>
                      )
                    </span>
                  ))}
                </p>
              </>
            )}

            {section === 'interface' && (
              <>
                <h3 className="settings-subheading">Interface</h3>
                <p className="settings-hint">
                  Size of the interface text — toolbar, menus, dialogs, status bar…
                  Doesn't affect the editor's own font size (see "Editor font").
                </p>
                <div className="settings-row">
                  <span>Text size</span>
                  <input
                    type="number"
                    className="settings-number-input"
                    min={MIN_UI_FONT_SIZE}
                    max={MAX_UI_FONT_SIZE}
                    value={settings.uiFontSize}
                    onChange={(e) => {
                      const n = parseInt(e.target.value, 10);
                      if (!Number.isNaN(n)) setUiFontSize(n);
                    }}
                  />
                </div>
              </>
            )}

            {section === 'data' && (
              <>
                <h3 className="settings-subheading">Data location</h3>
                <p className="settings-hint">Where the session and autosave data is stored</p>
                {backend.isTauri ? (
                  <div className="settings-row settings-row-column">
                    <div className="settings-path" title={dataDir ?? ''}>
                      {dataDir ?? 'Loading…'}
                    </div>
                    <button className="shortcut-btn" onClick={() => void chooseDataDir()}>
                      Change…
                    </button>
                  </div>
                ) : (
                  <div className="settings-path">Only available in the desktop app</div>
                )}
              </>
            )}

            {section === 'shortcut' && backend.isTauri && (
              <>
                <h3 className="settings-subheading">Desktop shortcut &amp; PATH</h3>
                <p className="settings-hint">
                  Recreate the shortcut and PATH entry (e.g. after updating LittlePad, if the
                  shortcut's icon looks outdated or missing).
                </p>
                <div className="settings-row settings-row-column">
                  <button className="shortcut-btn" onClick={() => void recreateShortcuts()}>
                    Recreate shortcut…
                  </button>
                </div>
              </>
            )}

            {section === 'fileAssociations' && backend.isTauri && (
              <>
                <h3 className="settings-subheading">File associations</h3>
                {platform === null && <p className="settings-hint">Loading…</p>}
                {platform && supportsFileAssociations(platform.os) && (
                  <>
                    <p className="settings-hint">
                      Check the file types you want LittlePad to appear under in your file
                      manager's "Open with" menu. This alone doesn't change what opens when
                      you double-click a file: to make LittlePad the default for a file type,
                      right-click a file of that type, choose Open with → LittlePad, and set
                      it as the default from there.
                    </p>
                    <div className="ext-grid">
                      {[...KNOWN_FILE_EXTENSIONS, ...customExtensions].map((ext) => (
                        <label className="ext-chip" key={ext}>
                          <input
                            type="checkbox"
                            checked={settings.associatedExtensions.includes(ext)}
                            disabled={extBusy === ext}
                            onChange={() => void toggleExtension(ext)}
                          />
                          {ext}
                        </label>
                      ))}
                    </div>
                    <div className="settings-row">
                      <input
                        type="text"
                        className="settings-number-input ext-input"
                        placeholder="Other extension…"
                        value={extInput}
                        onChange={(e) => setExtInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') addCustomExtension();
                        }}
                      />
                      <button className="shortcut-btn" onClick={addCustomExtension}>
                        Add
                      </button>
                    </div>
                  </>
                )}
                {platform && platform.os === 'macos' && (
                  <>
                    <p className="settings-hint">
                      LittlePad already appears under "Open with" in Finder for these file
                      types — this is decided when the app is built, not something to pick per
                      file here. To make LittlePad the default for one of them, right-click a
                      file of that type, choose Open With → LittlePad, and click "Change All…".
                    </p>
                    <div className="ext-grid">
                      {KNOWN_FILE_EXTENSIONS.map((ext) => (
                        <span className="ext-chip ext-chip-static" key={ext}>
                          {ext}
                        </span>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}

            {section === 'danger' && backend.isTauri && (
              <>
                <h3 className="settings-subheading settings-subheading-danger">Danger zone</h3>
                <p className="settings-hint">
                  Removes the desktop shortcut and PATH entry, and permanently deletes every
                  tab and autosaved file. Use this to fully uninstall LittlePad.
                </p>
                <div className="settings-row settings-row-column">
                  <button className="shortcut-btn danger-btn" onClick={() => void uninstall()}>
                    Uninstall LittlePad…
                  </button>
                  {platform && supportsFileAssociations(platform.os) && (
                    <button
                      className="shortcut-btn danger-btn"
                      disabled={settings.associatedExtensions.length === 0}
                      onClick={() => void removeAllAssociations()}
                    >
                      Remove file associations…
                    </button>
                  )}
                </div>
              </>
            )}

            {section === 'about' && (
              <>
                <h3 className="settings-subheading">About</h3>
                <p className="about-version">
                  LittlePad <span className="about-version-number">v{appVersion}</span>
                </p>
                <Changelog markdown={changelogSource} />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
