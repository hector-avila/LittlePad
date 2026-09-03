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
import { forgetFileMtime, getKnownMtime, seedFileMtime } from './fileMtimeTracker';
import { isSyncingToDisk } from './shareDiskSync';
import type { Tab } from '../types';

export { forgetFileMtime, seedFileMtime };

/**
 * Checks every open tab with a real file path (untitled tabs never have
 * one, and are always skipped) for changes made outside the app.
 *
 * A shared tab (see services/shareClient.ts) that's also synced to a real
 * path is handled silently — read, diffed in as a normal local edit (so it
 * broadcasts to the other participants), no prompt — since asking "reload
 * from disk?" on every remote edit that lands there would make sharing
 * unusable. Every other tab keeps the interactive confirm/reload flow.
 */
export async function checkForExternalChanges(): Promise<void> {
  if (!backend.isTauri) return;
  for (const tab of tabsStore.get().tabs) {
    if (!tab.filePath) continue;
    if (isSyncingToDisk(tab.id)) continue; // this instance just wrote it itself
    const known = getKnownMtime(tab.id);
    if (known === undefined) continue;
    try {
      const current = await backend.getFileMtime(tab.filePath);
      if (current === known) continue;
      if (tab.isShared) {
        await syncSharedTabFromDisk(tab, tab.filePath);
      } else {
        queueExternalChange(tab.id);
      }
    } catch {
      /* file missing/inaccessible: nothing useful to prompt about here */
    }
  }
}

/** The silent path for a shared+disk-synced tab — see `checkForExternalChanges`. */
async function syncSharedTabFromDisk(tab: Tab, path: string): Promise<void> {
  try {
    const { content, encoding } = await backend.openFile(path);
    // An untagged full-content replace: EditorHost's updateListener sees it
    // as a normal local edit and broadcasts it to the other participants,
    // exactly like typing would — see services/shareClient.broadcastLocalEdit.
    editorBridge.setContent(tab.id, content);
    updateTab(tab.id, { encoding: encoding as Tab['encoding'], dirty: false });
    await seedFileMtime(tab.id, path);
  } catch (e) {
    showBanner(`Could not sync "${tab.title}" from disk: ${e}`, 'error');
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
