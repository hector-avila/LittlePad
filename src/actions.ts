/**
 * The app's business actions (open/save/close/format tabs).
 * Kept separate from App.tsx so other components (e.g. CloseConfirmDialog)
 * can reuse them without depending on App's React tree.
 */
import * as backend from './services/backend';
import * as session from './services/session';
import { detect, detectByPath } from './services/detector';
import { formatText } from './services/formatter';
import { editorBridge } from './services/editorBridge';
import { seedFileMtime, forgetFileMtime } from './services/externalChanges';
import { showBanner, askCloseConfirm, pushClosedFile, popClosedFile } from './store/misc';
import {
  tabsStore,
  addTab,
  removeTab,
  updateTab,
  activeTab,
} from './store/tabs';
import type { DetectedType, Tab } from './types';

export function newTab(): void {
  const tab = addTab({});
  void session.flushTab(tab.id);
  void session.saveIndex();
  editorBridge.focus();
}

/** Opens (or activates, if already open) a filesystem file by its path. */
export async function openPath(path: string): Promise<void> {
  const existing = tabsStore.get().tabs.find((t) => t.filePath === path);
  if (existing) {
    tabsStore.set((s) => ({ ...s, activeId: existing.id }));
    return;
  }

  try {
    const { content, encoding } = await backend.openFile(path);
    const title = path.split(/[\\/]/).pop() ?? path;
    const language = detectByPath(path) ?? detect(content, path);
    const tab = addTab(
      {
        title,
        filePath: path,
        language,
        encoding: encoding as Tab['encoding'],
      },
      content,
    );
    void seedFileMtime(tab.id, path);
    await session.flushTab(tab.id);
    await session.saveIndex();
  } catch (e) {
    showBanner(String(e), 'error');
  }
}

export async function openFileAction(): Promise<void> {
  if (!backend.isTauri) {
    showBanner('Opening files requires the desktop app (Tauri)', 'error');
    return;
  }
  const { open } = await import('@tauri-apps/plugin-dialog');
  const path = await open({ multiple: false, title: 'Open file' });
  if (typeof path !== 'string') return;
  await openPath(path);
}

/** Reopens the last closed file (Ctrl+Shift+T). Only files with a real path. */
export async function reopenClosedFile(): Promise<void> {
  const path = popClosedFile();
  if (!path) {
    showBanner('No closed files to reopen');
    return;
  }
  await openPath(path);
}

/** New tab from a File dropped in the browser (no real path). */
export async function openDroppedBrowserFile(file: File): Promise<void> {
  const content = await file.text();
  const language = detectByPath(file.name) ?? detect(content, file.name);
  const tab = addTab({ title: file.name, language }, content);
  void session.flushTab(tab.id);
  void session.saveIndex();
}

/** Saves a specific tab to its file (prompting for a path if it's new). */
export async function saveTab(tab: Tab): Promise<boolean> {
  if (!backend.isTauri) {
    showBanner('Saving files requires the desktop app (Tauri)', 'error');
    return false;
  }

  let path = tab.filePath;
  if (!path) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const chosen = await save({
      title: 'Save as',
      defaultPath: `${tab.title.replace(/\s+/g, '-')}.${extFor(tab.language)}`,
    });
    if (!chosen) return false;
    path = chosen;
  }

  const content = editorBridge.getContent(tab.id) ?? '';
  try {
    await backend.saveFile(path, content, tab.encoding);
    updateTab(tab.id, {
      filePath: path,
      title: path.split(/[\\/]/).pop() ?? tab.title,
      dirty: false,
    });
    void seedFileMtime(tab.id, path);
    await session.flushTab(tab.id);
    showBanner(`Saved to ${path}`);
    return true;
  } catch (e) {
    showBanner(String(e), 'error');
    return false;
  }
}

export async function saveFileAction(): Promise<void> {
  const tab = activeTab();
  if (!tab) return;
  await saveTab(tab);
}

export function extFor(lang: DetectedType): string {
  const map: Partial<Record<DetectedType, string>> = {
    json: 'json',
    xml: 'xml',
    yaml: 'yaml',
    toml: 'toml',
    ini: 'ini',
    log: 'log',
    javascript: 'js',
    java: 'java',
    python: 'py',
    markdown: 'md',
  };
  return map[lang] ?? 'txt';
}

/** Closes a tab for good (without asking anything else). */
export function finishCloseTab(tab: Tab): void {
  if (tab.filePath) pushClosedFile(tab.filePath);
  removeTab(tab.id);
  forgetFileMtime(tab.id);
  void session.deleteTab(tab.id);
}

/**
 * Closes a tab; if it has unsaved changes to a file, or it's a new tab with
 * non-empty text, asks for confirmation (Save/Don't Save/Cancel) before
 * actually closing it.
 */
export function closeTabAction(id: string): void {
  const tab = tabsStore.get().tabs.find((t) => t.id === id);
  if (!tab) return;

  const needsConfirm =
    (tab.dirty && !!tab.filePath) ||
    (!tab.filePath && (editorBridge.getContent(id) ?? '').trim().length > 0);

  if (needsConfirm) {
    askCloseConfirm(id);
    return;
  }
  finishCloseTab(tab);
}

export function formatAction(): void {
  const tab = activeTab();
  if (!tab) return;
  const content = editorBridge.getContent(tab.id) ?? '';
  const result = formatText(content, tab.language);
  if (result.ok) {
    editorBridge.setActiveContent(result.text);
    showBanner('Document formatted');
  } else {
    showBanner(result.error, 'error');
  }
}

export function cycleTab(dir: 1 | -1): void {
  const { tabs, activeId } = tabsStore.get();
  if (tabs.length < 2) return;
  const idx = tabs.findIndex((t) => t.id === activeId);
  const next = tabs[(idx + dir + tabs.length) % tabs.length];
  tabsStore.set((s) => ({ ...s, activeId: next.id }));
}

/** Quits the app. Requests a window close, which reuses App.tsx's existing
 * onCloseRequested handler (flushes the session, then destroys the window)
 * instead of duplicating that logic here. */
export async function exitAction(): Promise<void> {
  if (!backend.isTauri) {
    showBanner('Exiting requires the desktop app (Tauri)', 'error');
    return;
  }
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().close();
}
