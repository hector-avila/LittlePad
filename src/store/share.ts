import { createStore } from './createStore';

/** One shared file as known to the relay server (metadata only — see PLAN). */
export interface ShareEntry {
  shareId: string;
  filename: string;
  readOnly: boolean;
  /** True if THIS instance owns or has joined this share (vs. only having seen it announced by a peer). */
  mine: boolean;
  /** How many instances currently hold this share open (the owner + every peer that's joined and stayed). */
  connected: number;
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/** Connection to the relay server + the tenant-wide list of shared files. */
export const shareStore = createStore<{
  status: ConnectionStatus;
  error: string | null;
  shares: ShareEntry[];
}>({ status: 'disconnected', error: null, shares: [] });

export function setShareConnectionStatus(status: ConnectionStatus, error: string | null = null): void {
  shareStore.set((s) => ({ ...s, status, error }));
}

export function setShareList(shares: ShareEntry[]): void {
  shareStore.set((s) => ({ ...s, shares }));
}

export function upsertShare(entry: ShareEntry): void {
  shareStore.set((s) => ({
    ...s,
    shares: [...s.shares.filter((e) => e.shareId !== entry.shareId), entry],
  }));
}

export function removeShareFromList(shareId: string): void {
  shareStore.set((s) => ({ ...s, shares: s.shares.filter((e) => e.shareId !== shareId) }));
}

/**
 * Incoming "someone shared a file" notifications, queued so they're shown
 * one at a time (same pattern as `externalChangeStore` in store/misc.ts).
 * Only entries from OTHER instances end up here — sharing a file yourself
 * never queues a notification for it.
 */
export const shareNotificationStore = createStore<{ queue: ShareEntry[] }>({ queue: [] });

export function queueShareNotification(entry: ShareEntry): void {
  shareNotificationStore.set((s) =>
    s.queue.some((e) => e.shareId === entry.shareId) ? s : { queue: [...s.queue, entry] },
  );
}

export function dismissShareNotification(shareId: string): void {
  shareNotificationStore.set((s) => ({ queue: s.queue.filter((e) => e.shareId !== shareId) }));
}

/**
 * Visibility of the Share dialog. 'create' shares the tab `tabId`; 'join'
 * opens the share `share` (from a notification, or from the Settings list);
 * 'reconnect' resumes a tab restored from a previous session that was part
 * of a joined (peer) share (see `shareReconnectStore` below) — same as
 * 'join', but against an existing tab (`tabId`) instead of creating a new
 * one, and asking only for the password (everything else was already known).
 */
export const shareDialogStore = createStore<{
  mode: 'create' | 'join' | 'reconnect' | null;
  tabId: string | null;
  share: ShareEntry | null;
}>({ mode: null, tabId: null, share: null });

export function openCreateShareDialog(tabId: string): void {
  shareDialogStore.set({ mode: 'create', tabId, share: null });
}

export function openJoinShareDialog(share: ShareEntry): void {
  shareDialogStore.set({ mode: 'join', tabId: null, share });
}

export function openReconnectShareDialog(tabId: string): void {
  shareDialogStore.set({ mode: 'reconnect', tabId, share: null });
}

export function closeShareDialog(): void {
  shareDialogStore.set({ mode: null, tabId: null, share: null });
}

/**
 * Tab ids restored from a previous session that were part of a joined
 * (peer) share (see types.ts's Tab/TabMeta doc comments) — queued so
 * ShareDialog offers to reconnect them one at a time, same pattern as
 * `externalChangeStore` in store/misc.ts. Owners never end up here: they
 * must re-share explicitly, with a new password.
 */
export const shareReconnectStore = createStore<{ queue: string[] }>({ queue: [] });

export function queueShareReconnect(tabId: string): void {
  shareReconnectStore.set((s) => (s.queue.includes(tabId) ? s : { queue: [...s.queue, tabId] }));
}

export function dismissShareReconnect(tabId: string): void {
  shareReconnectStore.set((s) => ({ queue: s.queue.filter((id) => id !== tabId) }));
}
