/**
 * Real-time file sharing: the WebSocket client for the relay server (see
 * relay-server/, and PLAN.md's "Compartir archivos en tiempo real").
 *
 * The relay is a pure, stateless message router — it never sees document
 * content or passwords, only opaque `ciphertext`/`iv` and the minimal
 * metadata (`filename`, `readOnly`) needed to list shares. This module owns:
 *   - the connection lifecycle (connect/reconnect using Settings → Share),
 *   - the wire protocol (mirrors relay-server/src/protocol.rs exactly),
 *   - deriving/caching each share's AES key and encrypting/decrypting
 *     every message through the Rust `share_*` commands,
 *   - the last-writer-wins safety net (seq/baseSeq/docLen — see
 *     editorBridge.applyRemoteChanges), and
 *   - handing decrypted content to editorBridge / opening new tabs.
 */
import * as backend from './backend';
import { editorBridge } from './editorBridge';
import { settingsStore, parseShareServerUrl } from '../store/settings';
import { addTab, getTab, updateTab, setLanguage, effectiveWordWrap } from '../store/tabs';
import { showBanner } from '../store/misc';
import type { DetectedType } from '../types';
import {
  setShareConnectionStatus,
  setShareList,
  upsertShare,
  removeShareFromList,
  queueShareNotification,
  type ShareEntry,
} from '../store/share';
import { notifyOwnWrite, syncSharedTabToDisk } from './shareDiskSync';
import * as session from './session';

// ── Wire protocol — mirrors relay-server/src/protocol.rs ───────────────────

interface ShareInfo {
  shareId: string;
  filename: string;
  readOnly: boolean;
  /** How many instances currently hold this share open (owner + acked peers) — see JoinAck below. */
  connected: number;
}

type ServerMessage =
  | { type: 'welcome'; clientId: string }
  | { type: 'error'; code: string }
  | { type: 'shares'; shares: ShareInfo[] }
  | { type: 'share_created'; shareId: string }
  | { type: 'share_added'; share: ShareInfo }
  | { type: 'share_updated'; share: ShareInfo }
  | { type: 'share_removed'; shareId: string }
  | { type: 'snapshot_request'; shareId: string; forClientId: string }
  | {
      type: 'joined';
      shareId: string;
      seq: number;
      ciphertext: string;
      iv: string;
      salt: string;
      wordWrap: boolean;
      language: string;
    }
  | { type: 'edit'; shareId: string; ciphertext: string; iv: string }
  | { type: 'resync_request'; shareId: string; seq: number }
  | { type: 'resync'; shareId: string; seq: number; ciphertext: string; iv: string }
  | { type: 'properties'; shareId: string; wordWrap: boolean; language: string };

type ClientMessage =
  | { type: 'list' }
  | { type: 'share_create'; shareId: string; filename: string; readOnly: boolean }
  | { type: 'join'; shareId: string }
  | {
      type: 'snapshot';
      shareId: string;
      toClientId: string;
      seq: number;
      ciphertext: string;
      iv: string;
      salt: string;
      wordWrap: boolean;
      language: string;
    }
  /** Sent once, right after successfully decrypting a `joined` snapshot — see relay-server/src/protocol.rs's JoinAck. */
  | { type: 'join_ack'; shareId: string }
  | { type: 'edit'; shareId: string; ciphertext: string; iv: string }
  | { type: 'resync_request'; shareId: string; seq: number }
  | { type: 'resync'; shareId: string; seq: number; ciphertext: string; iv: string }
  /** Owner-only (enforced client-side — see `setShareWordWrap`/`setShareLanguage`): the share's current word-wrap/language. */
  | { type: 'properties'; shareId: string; wordWrap: boolean; language: string }
  | { type: 'unshare'; shareId: string }
  | { type: 'leave'; shareId: string };

/** The encrypted payload of an `edit`/`resync` message, once decrypted. */
interface EditPayload {
  seq: number;
  baseSeq: number;
  changes: unknown;
  docLen: number;
}

// ── Active shares this instance participates in ─────────────────────────

interface ActiveShare {
  tabId: string;
  role: 'owner' | 'peer';
  readOnly: boolean;
  password: string;
  salt: string;
  key: string; // derived AES key, base64 — cached, never re-derived per edit
  seq: number; // last seq this instance's document reflects
  filename: string;
}

const activeShares = new Map<string, ActiveShare>(); // shareId -> ActiveShare
const shareIdByTab = new Map<string, string>(); // tabId -> shareId

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let intentionallyClosed = false;
/**
 * Messages sent while a connection is still in flight (e.g. a reconnect
 * prompt answered right at app startup, before the socket's even open) —
 * flushed in order once it opens, instead of being silently dropped.
 */
let outbox: ClientMessage[] = [];

/**
 * Builds the relay's WebSocket URL from Settings → Share's `shareServerUrl`
 * (see `parseShareServerUrl` — it's what makes a custom path like `/share`
 * work, per SERVER.md), appending the `/ws` endpoint.
 */
function relayUrl(): { url: string | null; error: string | null } {
  const { url, error } = parseShareServerUrl(settingsStore.get().shareServerUrl);
  return { url: url ? `${url}/ws` : null, error };
}

/**
 * Encodes the API key as a valid WebSocket subprotocol token (base64url, no
 * padding — only `A-Za-z0-9-_`) so it can travel as the `Sec-WebSocket-Protocol`
 * handshake header (see relay-server/src/ws.rs's `extract_api_key`) — the one
 * header a browser/webview `WebSocket` can set from JS, since arbitrary
 * headers (e.g. `Authorization`) aren't available to it.
 */
function apiKeySubprotocol(apiKey: string): string {
  const bytes = new TextEncoder().encode(apiKey);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function send(msg: ClientMessage): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  } else if (socket) {
    outbox.push(msg); // still connecting — flushed from ws.onopen
  }
}

/** (Re)connects using the current Settings → Share values. Safe to call repeatedly. */
export function connect(): void {
  if (!backend.isTauri) return; // sharing needs the Rust crypto commands
  const { url, error } = relayUrl();
  const { shareApiKey } = settingsStore.get();
  disconnect();
  if (error) {
    setShareConnectionStatus('error', error);
    return;
  }
  if (!url || !shareApiKey.trim()) return;

  intentionallyClosed = false;
  setShareConnectionStatus('connecting');
  const ws = new WebSocket(url, [apiKeySubprotocol(shareApiKey)]);
  socket = ws;

  ws.onopen = () => {
    setShareConnectionStatus('connected');
    send({ type: 'list' });
    const queued = outbox;
    outbox = [];
    for (const m of queued) send(m);
  };
  ws.onclose = () => {
    if (socket !== ws) return; // superseded by a newer connection
    socket = null;
    if (intentionallyClosed) {
      setShareConnectionStatus('disconnected');
      return;
    }
    setShareConnectionStatus('error', 'Disconnected — retrying…');
    scheduleReconnect();
  };
  ws.onerror = () => {
    /* onclose always follows; nothing extra to do here */
  };
  ws.onmessage = (event) => {
    if (typeof event.data !== 'string') return;
    let msg: ServerMessage;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    void handleServerMessage(msg);
  };
}

function scheduleReconnect(): void {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 3000);
}

export function disconnect(): void {
  intentionallyClosed = true;
  clearTimeout(reconnectTimer);
  socket?.close();
  socket = null;
  outbox = [];
}

/** Called whenever Settings → Share values change. */
export function reconnectIfNeeded(): void {
  connect();
}

// ── Creating / joining / leaving a share ────────────────────────────────

/**
 * `fileName` names an unsaved tab for the peers who join it (ShareDialog's
 * "File name" field, only shown when the tab has no `filePath` yet) — it
 * becomes both this share's `filename` metadata and this tab's own title,
 * exactly like "Save as" would. Ignored for a tab that already has one
 * (its real, on-disk name is used instead, same as before).
 */
export async function createShare(
  tabId: string,
  password: string,
  readOnly: boolean,
  fileName?: string,
): Promise<void> {
  const tab = getTab(tabId);
  if (!tab) throw new Error('Tab no longer exists');
  const { shareApiKey } = settingsStore.get();
  if (!shareApiKey.trim()) throw new Error('Configure a Share API key in Settings first');

  const shareId = crypto.randomUUID();
  const salt = await backend.shareGenerateSalt();
  const key = await backend.shareDeriveKey(shareApiKey, password, salt);
  const filename = !tab.filePath && fileName?.trim() ? fileName.trim() : tab.title;
  if (filename !== tab.title) updateTab(tabId, { title: filename });

  activeShares.set(shareId, {
    tabId,
    role: 'owner',
    readOnly,
    password,
    salt,
    key,
    seq: 0,
    filename,
  });
  shareIdByTab.set(tabId, shareId);
  updateTab(tabId, { isShared: true, shareId, shareReadOnly: readOnly, shareRole: 'owner' });
  send({ type: 'share_create', shareId, filename, readOnly });
}

/**
 * Result of attempting to join a share — 'wrong-password' means decryption
 * failed, 'canceled' means the caller gave up early (see `cancelJoin`)
 * rather than the 10s timeout elapsing on its own.
 */
export type JoinResult = 'ok' | 'wrong-password' | 'timeout' | 'error' | 'canceled';

export function joinShare(share: ShareEntry, password: string): Promise<JoinResult> {
  return joinOrReconnect(share.shareId, password, share.readOnly, share.filename);
}

/**
 * Resumes a tab restored from a previous session that was part of a joined
 * (peer) share (see types.ts's Tab/TabMeta doc comments, store/share.ts's
 * `shareReconnectStore`) — same underlying `join` as `joinShare`, but
 * applies the result to the existing `tabId` instead of creating a new tab,
 * and reuses the read-only flag as last known (there's no live ShareEntry
 * to read it from until the `join` round-trip actually succeeds).
 */
export function reconnectShare(tabId: string, shareId: string, password: string): Promise<JoinResult> {
  const tab = getTab(tabId);
  return joinOrReconnect(shareId, password, tab?.shareReadOnly ?? true, tab?.title ?? 'shared file', tabId);
}

function joinOrReconnect(
  shareId: string,
  password: string,
  readOnly: boolean,
  filename: string,
  existingTabId?: string,
): Promise<JoinResult> {
  return new Promise((resolve) => {
    const { shareApiKey } = settingsStore.get();
    if (!shareApiKey.trim()) {
      resolve('error');
      return;
    }

    const timeout = setTimeout(() => {
      pendingJoins.delete(shareId);
      resolve('timeout');
    }, 10_000);

    pendingJoins.set(shareId, {
      password,
      readOnly,
      filename,
      existingTabId,
      resolve: (r) => {
        clearTimeout(timeout);
        resolve(r);
      },
    });
    send({ type: 'join', shareId });
  });
}

const pendingJoins = new Map<
  string,
  {
    password: string;
    readOnly: boolean;
    filename: string;
    /** Set only by reconnectShare() — apply the result to this tab instead of creating a new one. */
    existingTabId?: string;
    resolve: (r: JoinResult) => void;
  }
>();

/**
 * Gives up on a join/reconnect still waiting for a `joined` response,
 * instead of leaving the caller blocked for the full 10s timeout — e.g.
 * ShareDialog's Cancel button, so it's never stuck disabled while the
 * share it's waiting on turns out to be gone for good (every participant
 * disconnected before this instance came back online). A no-op if nothing
 * is pending for `shareId` (it may have just resolved on its own).
 */
export function cancelJoin(shareId: string): void {
  const pending = pendingJoins.get(shareId);
  if (!pending) return;
  // Delete first, same as the timeout path above: a `joined` that still
  // arrives after this must be treated as unsolicited (see the `joined`
  // handler's `if (!pending) return`) instead of resurrecting a join the
  // user already gave up on.
  pendingJoins.delete(shareId);
  pending.resolve('canceled');
}

/** Convenience for the Settings → Share list, which only has the shareId. */
export function unshareByShareId(shareId: string): void {
  const active = activeShares.get(shareId);
  if (active) unshareTab(active.tabId);
}

export function unshareTab(tabId: string): void {
  const shareId = shareIdByTab.get(tabId);
  if (!shareId) return;
  const active = activeShares.get(shareId);
  activeShares.delete(shareId);
  shareIdByTab.delete(tabId);
  updateTab(tabId, {
    isShared: false,
    shareId: undefined,
    shareReadOnly: undefined,
    shareRole: undefined,
    shareWordWrap: undefined,
  });
  if (active?.role === 'owner') {
    send({ type: 'unshare', shareId });
  } else {
    send({ type: 'leave', shareId });
  }
  removeShareFromList(shareId);
}

/** Called when a tab is closed outright — stops sharing it, if it was shared. */
export function onTabClosed(tabId: string): void {
  if (shareIdByTab.has(tabId)) unshareTab(tabId);
}

// ── Broadcasting local edits (called from EditorHost's updateListener) ──

export function broadcastLocalEdit(tabId: string, changes: unknown, docLen: number): void {
  const shareId = shareIdByTab.get(tabId);
  if (!shareId) return;
  const active = activeShares.get(shareId);
  if (!active) return;
  if (active.role !== 'owner' && active.readOnly) return; // shouldn't happen (editor is locked), but never trust it alone

  const baseSeq = active.seq;
  const seq = baseSeq + 1;
  const payload: EditPayload = { seq, baseSeq, changes, docLen };
  active.seq = seq;
  void backend
    .shareEncrypt(active.key, JSON.stringify(payload))
    .then(({ ciphertext, iv }) => send({ type: 'edit', shareId, ciphertext, iv }))
    .catch(() => {
      /* best-effort: a dropped edit is recoverable via the resync safety net */
    });

  syncSharedTabToDisk(tabId);
}

// ── Server -> client message handling ───────────────────────────────────

async function handleServerMessage(msg: ServerMessage): Promise<void> {
  switch (msg.type) {
    case 'welcome':
      return;

    case 'error':
      setShareConnectionStatus('error', msg.code);
      return;

    case 'shares': {
      const mine = new Set(activeShares.keys());
      setShareList(msg.shares.map((s) => ({ ...s, mine: mine.has(s.shareId) })));
      return;
    }

    case 'share_created':
      return; // ack only; local state was already set optimistically in createShare()

    case 'share_added': {
      const entry: ShareEntry = { ...msg.share, mine: activeShares.has(msg.share.shareId) };
      upsertShare(entry);
      if (!entry.mine) queueShareNotification(entry);
      return;
    }

    case 'share_updated': {
      // Same shape as share_added, just not a brand-new share — typically
      // its `connected` count changed (see JoinAck below). Never queues a
      // notification.
      upsertShare({ ...msg.share, mine: activeShares.has(msg.share.shareId) });
      return;
    }

    case 'share_removed': {
      removeShareFromList(msg.shareId);
      const active = activeShares.get(msg.shareId);
      if (active && active.role !== 'owner') {
        // The owner unshared it or disconnected: this instance keeps its
        // (now-local, no-longer-synced) copy rather than losing content.
        activeShares.delete(msg.shareId);
        shareIdByTab.delete(active.tabId);
        updateTab(active.tabId, {
          isShared: false,
          shareId: undefined,
          shareReadOnly: undefined,
          shareRole: undefined,
          shareWordWrap: undefined,
        });
        showBanner(`"${active.filename}" is no longer shared`);
      }
      return;
    }

    case 'snapshot_request': {
      const active = activeShares.get(msg.shareId);
      if (!active) return; // I don't hold this share; someone else will answer
      const content = editorBridge.getContent(active.tabId) ?? '';
      const tab = getTab(active.tabId);
      void backend.shareEncrypt(active.key, content).then(({ ciphertext, iv }) => {
        send({
          type: 'snapshot',
          shareId: msg.shareId,
          toClientId: msg.forClientId,
          seq: active.seq,
          ciphertext,
          iv,
          salt: active.salt,
          // Whoever answers a join already reflects the owner's current
          // choice — the owner from the moment they set it, a peer from the
          // Properties broadcast that told them about it (see below).
          wordWrap: effectiveWordWrap(tab, settingsStore.get().wordWrap),
          language: tab?.language ?? 'plain',
        });
      });
      return;
    }

    case 'joined': {
      const pending = pendingJoins.get(msg.shareId);
      if (!pending) return; // a join we didn't ask for, or it already timed out
      pendingJoins.delete(msg.shareId);
      const { shareApiKey } = settingsStore.get();
      const key = await backend.shareDeriveKey(shareApiKey, pending.password, msg.salt);
      let content: string;
      try {
        content = await backend.shareDecrypt(key, msg.ciphertext, msg.iv);
      } catch {
        pending.resolve('wrong-password');
        return;
      }
      let tabId: string;
      if (pending.existingTabId && getTab(pending.existingTabId)) {
        // Reconnecting a tab restored from a previous session — replace its
        // (possibly stale) content with the fresh snapshot, silently (not
        // via setContent, which would broadcast it back out as if it were
        // a local edit — there's nothing to broadcast yet, we just joined).
        tabId = pending.existingTabId;
        editorBridge.applyRemoteSnapshot(tabId, content);
        updateTab(tabId, {
          isShared: true,
          shareId: msg.shareId,
          shareReadOnly: pending.readOnly,
          shareRole: 'peer',
          shareWordWrap: msg.wordWrap,
          language: msg.language as DetectedType,
          languageManual: true,
        });
      } else {
        tabId = addTab(
          {
            // The owner's real filename, or the name they picked for it if
            // it wasn't saved to disk (see createShare's `fileName`) — a
            // shared tab is visually distinct via its tab color (see
            // App.css's `.tab-is-shared`), so the title no longer needs to
            // say "shared" itself.
            title: pending.filename,
            isShared: true,
            shareId: msg.shareId,
            shareReadOnly: pending.readOnly,
            shareRole: 'peer',
            shareWordWrap: msg.wordWrap,
            language: msg.language as DetectedType,
            languageManual: true,
          },
          content,
        ).id;
      }
      activeShares.set(msg.shareId, {
        tabId,
        role: 'peer',
        readOnly: pending.readOnly,
        password: pending.password,
        salt: msg.salt,
        key,
        seq: msg.seq,
        filename: pending.filename,
      });
      shareIdByTab.set(tabId, msg.shareId);
      void session.flushTab(tabId);
      // Tells the server to count this instance towards ShareInfo.connected
      // — sent only now, since decryption just succeeded (a wrong password
      // never reaches this line, so it's never miscounted as connected).
      send({ type: 'join_ack', shareId: msg.shareId });
      pending.resolve('ok');
      return;
    }

    case 'edit': {
      const active = activeShares.get(msg.shareId);
      if (!active) return;
      let payload: EditPayload;
      try {
        payload = JSON.parse(await backend.shareDecrypt(active.key, msg.ciphertext, msg.iv));
      } catch {
        return; // wrong key (shouldn't happen once joined) or corrupted frame
      }
      if (payload.baseSeq !== active.seq) {
        requestResync(msg.shareId, active);
        return;
      }
      const applied = editorBridge.applyRemoteChanges(active.tabId, payload.changes, payload.docLen);
      if (!applied) {
        requestResync(msg.shareId, active);
        return;
      }
      active.seq = payload.seq;
      syncSharedTabToDisk(active.tabId);
      return;
    }

    case 'resync_request': {
      const active = activeShares.get(msg.shareId);
      if (!active) return;
      const content = editorBridge.getContent(active.tabId) ?? '';
      void backend.shareEncrypt(active.key, content).then(({ ciphertext, iv }) => {
        send({ type: 'resync', shareId: msg.shareId, seq: active.seq, ciphertext, iv });
      });
      return;
    }

    case 'resync': {
      const active = activeShares.get(msg.shareId);
      if (!active) return;
      let content: string;
      try {
        content = await backend.shareDecrypt(active.key, msg.ciphertext, msg.iv);
      } catch {
        return;
      }
      notifyOwnWrite(active.tabId);
      editorBridge.applyRemoteSnapshot(active.tabId, content);
      active.seq = msg.seq;
      syncSharedTabToDisk(active.tabId);
      return;
    }

    case 'properties': {
      // Broadcasts exclude the sender (see relay-server/src/ws.rs's pure
      // relay group), so this instance never receives its own update back —
      // whatever arrives here always came from the owner.
      const active = activeShares.get(msg.shareId);
      if (!active) return;
      updateTab(active.tabId, {
        shareWordWrap: msg.wordWrap,
        language: msg.language as DetectedType,
        languageManual: true,
      });
      return;
    }
  }
}

function requestResync(shareId: string, active: ActiveShare): void {
  send({ type: 'resync_request', shareId, seq: active.seq });
}

/** True if `tabId` is currently shared with edit permission for this instance. */
export function canEdit(tabId: string): boolean {
  const shareId = shareIdByTab.get(tabId);
  if (!shareId) return true; // not shared: always editable
  const active = activeShares.get(shareId);
  return !active || active.role === 'owner' || !active.readOnly;
}

// ── Word wrap / language: synced in real time, owner-decided only ──────

/** Sends the owner's current word-wrap/language to every other participant. Owner-only; a no-op otherwise. */
function broadcastProperties(tabId: string): void {
  const shareId = shareIdByTab.get(tabId);
  if (!shareId) return;
  const active = activeShares.get(shareId);
  if (!active || active.role !== 'owner') return;
  const tab = getTab(tabId);
  if (!tab) return;
  send({
    type: 'properties',
    shareId,
    wordWrap: effectiveWordWrap(tab, settingsStore.get().wordWrap),
    language: tab.language,
  });
}

/**
 * Sets the word-wrap override for a shared tab and broadcasts it — only the
 * share's owner may decide this (per-share, like `setShareLanguage` below);
 * a no-op for a peer, read-only or not.
 */
export function setShareWordWrap(tabId: string, wrap: boolean): void {
  const tab = getTab(tabId);
  if (!tab?.isShared || tab.shareRole !== 'owner') return;
  updateTab(tabId, { shareWordWrap: wrap });
  broadcastProperties(tabId);
}

/**
 * Sets the language for a shared tab and broadcasts it — only the share's
 * owner may decide this, whether picked manually or auto-detected on their
 * own instance (see EditorHost.tsx's scheduleDetection); a no-op for a peer.
 */
export function setShareLanguage(tabId: string, language: DetectedType, manual: boolean): void {
  const tab = getTab(tabId);
  if (!tab?.isShared || tab.shareRole !== 'owner') return;
  setLanguage(tabId, language, manual);
  broadcastProperties(tabId);
}

// Reconnect automatically whenever the Share settings change.
let lastConnKey = '';
settingsStore.subscribe(() => {
  const { shareServerUrl, shareApiKey } = settingsStore.get();
  const key = `${shareServerUrl}:${shareApiKey}`;
  if (key !== lastConnKey) {
    lastConnKey = key;
    reconnectIfNeeded();
  }
});
