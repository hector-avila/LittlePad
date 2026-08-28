/**
 * Access layer for the Rust backend (Tauri IPC).
 * Includes a localStorage fallback so the app can be developed/tested in a
 * browser (`npm run dev` without Tauri).
 */
import { invoke } from '@tauri-apps/api/core';
import type { SessionData, SessionIndex, SessionTab, TabMeta } from '../types';

export const isTauri =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

const LS_PREFIX = 'littlepad.session.';

export async function loadSession(): Promise<SessionData> {
  if (isTauri) return invoke<SessionData>('load_session');

  // Browser fallback
  const indexRaw = localStorage.getItem(`${LS_PREFIX}index`);
  const index: SessionIndex | null = indexRaw ? JSON.parse(indexRaw) : null;
  const tabs: SessionTab[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)!;
    if (key.startsWith(`${LS_PREFIX}tab.`)) {
      try {
        tabs.push(JSON.parse(localStorage.getItem(key)!));
      } catch {
        /* corrupt entry: ignore */
      }
    }
  }
  if (index) {
    const pos = (id: string) => {
      const p = index.tabOrder.indexOf(id);
      return p === -1 ? Number.MAX_SAFE_INTEGER : p;
    };
    tabs.sort((a, b) => pos(a.meta.id) - pos(b.meta.id));
  }
  return { index, tabs };
}

export async function saveSessionTab(
  id: string,
  content: string,
  meta: TabMeta,
): Promise<void> {
  if (isTauri) return invoke('save_session_tab', { id, content, meta });
  localStorage.setItem(`${LS_PREFIX}tab.${id}`, JSON.stringify({ meta, content }));
}

export async function deleteSessionTab(id: string): Promise<void> {
  if (isTauri) return invoke('delete_session_tab', { id });
  localStorage.removeItem(`${LS_PREFIX}tab.${id}`);
}

export async function saveSessionIndex(index: SessionIndex): Promise<void> {
  if (isTauri) return invoke('save_session_index', { index });
  localStorage.setItem(`${LS_PREFIX}index`, JSON.stringify(index));
}

export async function openFile(
  path: string,
): Promise<{ content: string; encoding: string }> {
  if (!isTauri) throw new Error('Opening files requires the desktop app');
  return invoke('open_file', { path });
}

/**
 * A file's last-modified time (ms since epoch), for detecting changes made
 * outside the app. Not available in the browser dev build (no real
 * filesystem to check).
 */
export async function getFileMtime(path: string): Promise<number> {
  if (!isTauri) throw new Error('Only available in the desktop app');
  return invoke('get_file_mtime', { path });
}

export async function saveFile(
  path: string,
  content: string,
  encoding: string,
): Promise<void> {
  if (!isTauri) throw new Error('Saving files requires the desktop app');
  return invoke('save_file', { path, content, encoding });
}

/** Directory where the session/autosave data is stored. */
export async function getDataDir(): Promise<string> {
  if (!isTauri) throw new Error('Only available in the desktop app');
  return invoke('get_data_dir');
}

/** Changes the data directory (takes effect after restarting the app). */
export async function setDataDir(path: string): Promise<void> {
  if (!isTauri) throw new Error('Only available in the desktop app');
  return invoke('set_data_dir', { path });
}

/** Files passed as CLI arguments when this instance was launched (consumed once). */
export async function getLaunchFiles(): Promise<string[]> {
  if (!isTauri) return [];
  return invoke('get_launch_files');
}

/** True only the very first time the app has ever run. */
export async function checkFirstRun(): Promise<boolean> {
  if (!isTauri) return false;
  return invoke('check_first_run');
}

/** Creates a desktop shortcut and adds the app to the user's PATH. */
export async function setupShortcuts(): Promise<string> {
  if (!isTauri) throw new Error('Only available in the desktop app');
  return invoke('setup_shortcuts');
}

/** Removes the desktop shortcut and PATH entry created by setupShortcuts(). */
export async function removeShortcuts(): Promise<string> {
  if (!isTauri) throw new Error('Only available in the desktop app');
  return invoke('remove_shortcuts');
}

/**
 * Registers LittlePad as an "Open with" candidate in Windows Explorer for
 * one file extension the user picked on the Settings screen. Opt-in,
 * per-extension — Windows only (rejects on other platforms/outside Tauri,
 * same as the Rust command it calls).
 */
export async function registerFileAssociation(ext: string): Promise<void> {
  if (!isTauri) throw new Error('Only available in the desktop app');
  return invoke('register_file_association', { ext });
}

/** Undoes registerFileAssociation() for one extension. */
export async function unregisterFileAssociation(ext: string): Promise<void> {
  if (!isTauri) throw new Error('Only available in the desktop app');
  return invoke('unregister_file_association', { ext });
}

/** Removes every extension in `extensions`, plus the "Open with" registration itself. */
export async function removeAllFileAssociations(extensions: string[]): Promise<string> {
  if (!isTauri) throw new Error('Only available in the desktop app');
  return invoke('remove_all_file_associations', { extensions });
}

/**
 * Deletes all app data on disk: every tab's autosaved content, the
 * first-run marker, and the data-location override. Irreversible.
 */
export async function deleteAppData(): Promise<void> {
  if (!isTauri) throw new Error('Only available in the desktop app');
  return invoke('delete_app_data');
}

/** Family names of every font installed on the OS (empty outside Tauri). */
export async function listSystemFonts(): Promise<string[]> {
  if (!isTauri) return [];
  return invoke('list_system_fonts');
}

/**
 * OS name ('windows'/'linux'/'macos'/…) and CPU architecture
 * ('x86_64'/'aarch64'/…) of this build — used by the update checker to
 * pick the matching release asset. Null outside Tauri.
 */
export async function getPlatformInfo(): Promise<{ os: string; arch: string } | null> {
  if (!isTauri) return null;
  const [os, arch] = await invoke<[string, string]>('platform_info');
  return { os, arch };
}

/** Opens a URL in the system's default browser (a new tab outside Tauri). */
export async function openExternal(url: string): Promise<void> {
  if (isTauri) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

/** Window position/size (last non-maximized bounds) plus maximized state. */
export interface WindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

/**
 * Saves the window's position/size/maximized state so the next launch can
 * restore it (see `src-tauri/src/lib.rs`'s `setup()` hook, which applies it
 * before the window is shown). No-op outside Tauri.
 */
export async function saveWindowState(state: WindowState): Promise<void> {
  if (!isTauri) return;
  return invoke('save_window_state', { state });
}
