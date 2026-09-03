/**
 * Two-way disk sync for a shared tab that's also been saved to a real path
 * ("Save As" on a shared file — see PLAN.md). This is intentionally
 * separate from session.ts's autosave (which writes to LittlePad's internal
 * session store, never to `tab.filePath`): every remote edit applied to
 * such a tab gets written straight to its real file, debounced, and the
 * on-disk-change side of the loop is handled by externalChanges.ts's
 * silent branch (gated on `isSyncingToDisk` below so the two don't race).
 */
import * as backend from './backend';
import { getTab } from '../store/tabs';
import { editorBridge } from './editorBridge';
import { seedFileMtime } from './fileMtimeTracker';

const DEBOUNCE_MS = 400;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** tabIds this instance is currently writing to disk for — see `checkForExternalChanges`. */
const writing = new Set<string>();

export function isSyncingToDisk(tabId: string): boolean {
  return writing.has(tabId);
}

/**
 * Marks a write as starting before the content is even applied to the
 * editor (used ahead of a `resync`/snapshot apply, which itself triggers a
 * write via the normal edit path) — belt-and-suspenders against a
 * focus-triggered external-change check landing in the middle of it.
 */
export function notifyOwnWrite(tabId: string): void {
  writing.add(tabId);
}

/** Schedules writing `tabId`'s current content to its real file, if it has one. */
export function syncSharedTabToDisk(tabId: string): void {
  const tab = getTab(tabId);
  if (!tab?.filePath) return; // only relevant once "Save As" has given it a real path
  clearTimeout(timers.get(tabId));
  timers.set(tabId, setTimeout(() => void flush(tabId), DEBOUNCE_MS));
}

async function flush(tabId: string): Promise<void> {
  timers.delete(tabId);
  const tab = getTab(tabId);
  if (!tab?.filePath) return;
  const content = editorBridge.getContent(tabId);
  if (content === null) return;
  writing.add(tabId);
  try {
    await backend.saveFile(tab.filePath, content, tab.encoding);
    await seedFileMtime(tabId, tab.filePath);
  } catch {
    /* best-effort: the next remote edit retries the write */
  } finally {
    writing.delete(tabId);
  }
}
