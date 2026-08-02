/**
 * Detects files changed outside the app (by another program) while a tab
 * for that file is open, and reloading them with user confirmation. Checked
 * whenever the app window regains focus — see App.tsx.
 */
import * as backend from './backend';
import { editorBridge } from './editorBridge';
import { tabsStore, getTab, updateTab } from '../store/tabs';
import { showBanner, queueExternalChange, dismissCurrentExternalChange } from '../store/misc';
import * as session from './session';
import type { Tab } from '../types';

/**
 * Last known on-disk modified time (ms since epoch) per tab id — the
 * baseline `checkForExternalChanges` compares against. A tab with no entry
 * here is never checked (e.g. untitled tabs, or ones whose baseline
 * couldn't be read).
 */
const knownMtimes = new Map<string, number>();

export function forgetFileMtime(tabId: string): void {
  knownMtimes.delete(tabId);
}

/**
 * Fetches and records the current on-disk mtime for a tab that was just
 * opened, saved, restored, or reloaded — so its content is known to match
 * disk, and future focus checks have a correct baseline. Best-effort: a
 * failure (e.g. the file was deleted, or permissions) just means this tab
 * won't be checked until it's saved again.
 */
export async function seedFileMtime(tabId: string, path: string): Promise<void> {
  try {
    knownMtimes.set(tabId, await backend.getFileMtime(path));
  } catch {
    knownMtimes.delete(tabId);
  }
}

/**
 * Checks every open tab with a real file path (untitled tabs never have
 * one, and are always skipped) for changes made outside the app, and
 * queues a confirmation prompt for any that changed.
 */
export async function checkForExternalChanges(): Promise<void> {
  if (!backend.isTauri) return;
  for (const tab of tabsStore.get().tabs) {
    if (!tab.filePath) continue;
    const known = knownMtimes.get(tab.id);
    if (known === undefined) continue;
    try {
      const current = await backend.getFileMtime(tab.filePath);
      if (current !== known) queueExternalChange(tab.id);
    } catch {
      /* file missing/inaccessible: nothing useful to prompt about here */
    }
  }
}

/**
 * "Keep my version": dismiss without touching the tab's content, but
 * update the known mtime so this same external change doesn't prompt again
 * the next time the window regains focus (a genuinely new change still
 * will). Also used when the user backs out of the "discard unsaved
 * changes?" confirmation — same outcome, nothing is reloaded.
 */
export async function keepCurrentVersion(tabId: string): Promise<void> {
  const tab = getTab(tabId);
  if (tab?.filePath) await seedFileMtime(tabId, tab.filePath);
  dismissCurrentExternalChange();
}

/** "Reload": re-reads the file from disk and replaces the tab's content. */
export async function reloadFromDisk(tabId: string): Promise<void> {
  const tab = getTab(tabId);
  if (!tab?.filePath) {
    dismissCurrentExternalChange();
    return;
  }
  try {
    const { content, encoding } = await backend.openFile(tab.filePath);
    editorBridge.setContent(tabId, content);
    updateTab(tabId, { encoding: encoding as Tab['encoding'], dirty: false });
    await seedFileMtime(tabId, tab.filePath);
    void session.flushTab(tabId);
  } catch (e) {
    showBanner(String(e), 'error');
  }
  dismissCurrentExternalChange();
}
