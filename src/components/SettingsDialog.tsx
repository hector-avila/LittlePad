import { useEffect, useState, type KeyboardEvent } from 'react';
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
  formatShortcut,
  isTaken,
  shortcutRequiresCtrl,
  ACTION_ORDER,
  ACTION_LABELS,
  BUNDLED_FONTS,
  MIN_FONT_SIZE,
  MAX_FONT_SIZE,
  type ActionId,
  type Shortcut,
} from '../store/settings';

const IGNORED_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta']);

const FONT_LICENSES: Record<(typeof BUNDLED_FONTS)[number], string> = {
  'Ubuntu Monospace': 'https://canonical.com/legal/font-licence',
  'MesloLGS NF': 'https://github.com/romkatv/dotfiles-public/tree/master/.local/share/fonts/NerdFonts',
};

async function openExternal(url: string): Promise<void> {
  if (backend.isTauri) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

type SectionId = 'shortcuts' | 'font' | 'data' | 'shortcut' | 'danger' | 'about';

/** Left-nav sections; `tauriOnly` ones are hidden entirely in the browser dev build. */
const SECTIONS: { id: SectionId; label: string; tauriOnly?: boolean }[] = [
  { id: 'shortcuts', label: 'Keyboard shortcuts' },
  { id: 'font', label: 'Editor font' },
  { id: 'data', label: 'Data location' },
  { id: 'shortcut', label: 'Desktop shortcut & PATH', tauriOnly: true },
  { id: 'danger', label: 'Danger zone', tauriOnly: true },
  { id: 'about', label: 'About' },
];

export default function SettingsDialog() {
  const { open } = useStore(settingsOpenStore);
  const settings = useStore(settingsStore);
  const [recording, setRecording] = useState<ActionId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dataDir, setDataDir] = useState<string | null>(null);
  const [systemFonts, setSystemFonts] = useState<string[]>([]);
  const [section, setSection] = useState<SectionId>('shortcuts');

  useEffect(() => {
    if (!open || !backend.isTauri) return;
    backend.getDataDir().then(setDataDir).catch(() => setDataDir(null));
    backend.listSystemFonts().then(setSystemFonts).catch(() => setSystemFonts([]));
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

  const uninstall = async () => {
    const { ask, message } = await import('@tauri-apps/plugin-dialog');
    const confirmed = await ask(
      'This permanently deletes every tab and autosaved file LittlePad has ' +
        'stored, and removes its desktop shortcut and PATH entry. This ' +
        'cannot be undone.\n\nDelete everything?',
      { title: 'Uninstall LittlePad', kind: 'warning', okLabel: 'Delete everything', cancelLabel: 'Cancel' },
    );
    if (!confirmed) return;

    // Best-effort: a missing shortcut/PATH entry, or lack of permission to
    // remove one, shouldn't block deleting the data itself.
    await backend.removeShortcuts().catch(() => {});

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

  return (
    <div className="dialog-overlay" onClick={() => closeSettingsDialog()}>
      <div
        className="settings-dialog settings-dialog-split"
        role="dialog"
        aria-label="Settings"
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
                      <button type="button" onClick={() => void openExternal(FONT_LICENSES[name])}>
                        license
                      </button>
                      )
                    </span>
                  ))}
                </p>
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
