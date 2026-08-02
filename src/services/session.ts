/**
 * Session autosave (PLAN.md §5.2).
 * 1.5 s debounce per tab with a 5 s maxWait from the first change: on power
 * loss you lose at most ~5 s of typing.
 */
import * as backend from './backend';
import { editorBridge } from './editorBridge';
import { saveStore } from '../store/misc';
import { getTab, sessionIndex } from '../store/tabs';
import type { Tab, TabMeta } from '../types';

const DEBOUNCE_MS = 1500;
const MAX_WAIT_MS = 5000;

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const firstChangeAt = new Map<string, number>();

export function toMeta(tab: Tab): TabMeta {
  return {
    id: tab.id,
    title: tab.title,
    filePath: tab.filePath,
    language: tab.language,
    languageManual: tab.languageManual,
    dirty: tab.dirty,
    cursor: tab.cursor,
  };
}

/** Schedules autosaving a tab after a change. */
export function scheduleSave(tabId: string): void {
  saveStore.set({ ...saveStore.get(), pending: true });
  const now = Date.now();
  if (!firstChangeAt.has(tabId)) firstChangeAt.set(tabId, now);

  const elapsed = now - firstChangeAt.get(tabId)!;
  const wait = Math.min(DEBOUNCE_MS, Math.max(0, MAX_WAIT_MS - elapsed));

  clearTimeout(timers.get(tabId));
  timers.set(
    tabId,
    setTimeout(() => void flushTab(tabId), wait),
  );
}

/** Immediately saves a tab to the session. */
export async function flushTab(tabId: string): Promise<void> {
  clearTimeout(timers.get(tabId));
  timers.delete(tabId);
  firstChangeAt.delete(tabId);

  const tab = getTab(tabId);
  if (!tab) return;
  const content = editorBridge.getContent(tabId);
  if (content === null) return;

  try {
    await backend.saveSessionTab(tabId, content, toMeta(tab));
    saveStore.set({ lastSaved: Date.now(), pending: timers.size > 0, error: null });
  } catch (e) {
    saveStore.set({
      ...saveStore.get(),
      error: `Autosave failed: ${e instanceof Error ? e.message : e}`,
    });
  }
}

/** Saves a tab's metadata without touching its content (rename, type, etc.). */
export async function flushMeta(tabId: string): Promise<void> {
  if (timers.has(tabId)) return flushTab(tabId); // content already pending
  return flushTab(tabId);
}

/** Flushes all pending tabs + the index (when closing the app). */
export async function flushAll(tabIds: string[]): Promise<void> {
  await Promise.all(tabIds.map((id) => flushTab(id)));
  await saveIndex();
}

let indexTimer: ReturnType<typeof setTimeout> | undefined;

/** Saves the session index (tab order and active tab), with a short debounce. */
export function scheduleSaveIndex(): void {
  clearTimeout(indexTimer);
  indexTimer = setTimeout(() => void saveIndex(), 400);
}

export async function saveIndex(): Promise<void> {
  clearTimeout(indexTimer);
  try {
    await backend.saveSessionIndex(sessionIndex());
  } catch {
    /* the index will be retried on the next change */
  }
}

export async function deleteTab(tabId: string): Promise<void> {
  clearTimeout(timers.get(tabId));
  timers.delete(tabId);
  firstChangeAt.delete(tabId);
  await backend.deleteSessionTab(tabId);
  scheduleSaveIndex();
}
