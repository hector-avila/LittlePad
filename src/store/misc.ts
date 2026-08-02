import { createStore } from './createStore';

/** Cursor position in the active tab (for the StatusBar). */
export const cursorStore = createStore<{ line: number; col: number }>({
  line: 1,
  col: 1,
});

/** Whether column (multi-cursor) edit mode is currently armed (for the StatusBar indicator). */
export const columnModeStore = createStore<{ armed: boolean }>({ armed: false });

/** Session autosave status (for the StatusBar). */
export const saveStore = createStore<{
  lastSaved: number | null;
  pending: boolean;
  error: string | null;
}>({ lastSaved: null, pending: false, error: null });

/** Notification/error banner (failed formatting, etc.). */
export const bannerStore = createStore<{
  message: string | null;
  kind: 'error' | 'info';
}>({ message: null, kind: 'info' });

/**
 * Visibility of the find/replace dialog. `mode` controls whether the replace
 * input/buttons are shown: 'find' hides them (Ctrl+F), 'replace' shows them
 * (Ctrl+R) — both share the same dialog and search state.
 */
export const findReplaceStore = createStore<{ open: boolean; mode: 'find' | 'replace' }>({
  open: false,
  mode: 'find',
});

function toggleFindReplaceMode(mode: 'find' | 'replace'): void {
  findReplaceStore.set((s) => (s.open && s.mode === mode ? { ...s, open: false } : { open: true, mode }));
}

export function toggleFind(): void {
  toggleFindReplaceMode('find');
}

export function toggleReplace(): void {
  toggleFindReplaceMode('replace');
}

export function closeFindReplace(): void {
  findReplaceStore.set((s) => ({ ...s, open: false }));
}

/** Visibility of the hamburger menu (minimalist toolbar). */
export const menuOpenStore = createStore<{ open: boolean }>({ open: false });

export function toggleMenu(): void {
  menuOpenStore.set((s) => ({ open: !s.open }));
}

export function closeMenu(): void {
  menuOpenStore.set({ open: false });
}

/** Visibility of the settings dialog. */
export const settingsOpenStore = createStore<{ open: boolean }>({ open: false });

export function openSettings(): void {
  settingsOpenStore.set({ open: true });
}

export function closeSettingsDialog(): void {
  settingsOpenStore.set({ open: false });
}

/** Tab pending a close confirmation (save before closing?), if any. */
export const closeConfirmStore = createStore<{ tabId: string | null }>({ tabId: null });

export function askCloseConfirm(tabId: string): void {
  closeConfirmStore.set({ tabId });
}

export function clearCloseConfirm(): void {
  closeConfirmStore.set({ tabId: null });
}

/**
 * History of closed file paths, for "reopen closed tab" (Ctrl+Shift+T).
 * Lives in memory only: it isn't persisted, and is lost on reload/app close
 * (on purpose). Only files with a real path; unsaved new tabs never end up
 * here.
 */
const closedFilePaths: string[] = [];

export function pushClosedFile(path: string): void {
  closedFilePaths.push(path);
}

export function popClosedFile(): string | null {
  return closedFilePaths.length ? (closedFilePaths.pop() ?? null) : null;
}

/**
 * Tabs (by id) waiting for a "this file changed on disk" prompt, queued so
 * they're asked about one at a time. `stage` is which dialog to show for
 * the front of the queue: 'ask' offers Reload/Keep my version; if the user
 * picks Reload on a tab with unsaved changes, `stage` moves to
 * 'confirmDiscard' to double-check before actually discarding them.
 */
export const externalChangeStore = createStore<{
  queue: string[];
  stage: 'ask' | 'confirmDiscard';
}>({ queue: [], stage: 'ask' });

export function queueExternalChange(tabId: string): void {
  externalChangeStore.set((s) =>
    s.queue.includes(tabId) ? s : { ...s, queue: [...s.queue, tabId] },
  );
}

export function advanceToDiscardConfirm(): void {
  externalChangeStore.set((s) => ({ ...s, stage: 'confirmDiscard' }));
}

export function dismissCurrentExternalChange(): void {
  externalChangeStore.set((s) => ({ queue: s.queue.slice(1), stage: 'ask' }));
}

/** Visibility of the first-run "create shortcut / add to PATH" dialog. */
export const onboardingStore = createStore<{ open: boolean }>({ open: false });

export function openOnboarding(): void {
  onboardingStore.set({ open: true });
}

export function closeOnboarding(): void {
  onboardingStore.set({ open: false });
}

let bannerTimer: ReturnType<typeof setTimeout> | undefined;

export function showBanner(message: string, kind: 'error' | 'info' = 'info') {
  clearTimeout(bannerTimer);
  bannerStore.set({ message, kind });
  bannerTimer = setTimeout(
    () => bannerStore.set({ message: null, kind: 'info' }),
    kind === 'error' ? 8000 : 3500,
  );
}
