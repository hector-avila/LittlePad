import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/createStore';
import {
  shareDialogStore,
  closeShareDialog,
  openReconnectShareDialog,
  shareReconnectStore,
  dismissShareReconnect,
} from '../store/share';
import { getTab, updateTab } from '../store/tabs';
import * as shareClient from '../services/shareClient';
import * as session from '../services/session';
import { showBanner, closeSettingsDialog } from '../store/misc';
import PasswordInput from './PasswordInput';

/**
 * One dialog, three modes (see store/share.ts's `shareDialogStore`):
 *   - 'create': the current user is about to share a tab — asks for a
 *     password (the document's end-to-end encryption key material, see
 *     src-tauri/src/share_crypto.rs) and whether others may edit it.
 *   - 'join': a peer announced a share (or it was picked from the Settings
 *     → Share list) and this instance wants to open it — asks only for the
 *     password; a wrong one simply fails to decrypt, so that's reported
 *     directly, not as a separate server-side check.
 *   - 'reconnect': a tab restored from a previous session was part of a
 *     joined share (see `shareReconnectStore`) — same as 'join' against an
 *     existing tab instead of a new one. Canceling doesn't lose anything:
 *     the tab just keeps its last-synced content as a plain local tab.
 */
export default function ShareDialog() {
  const { mode, tabId, share } = useStore(shareDialogStore);
  const { queue: reconnectQueue } = useStore(shareReconnectStore);
  const [password, setPassword] = useState('');
  const [allowEdit, setAllowEdit] = useState(false);
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const fileNameRef = useRef<HTMLInputElement>(null);

  // Reconnect prompts are queued (one at a time) rather than triggered by a
  // click — open the next one whenever nothing else is showing.
  useEffect(() => {
    if (mode || reconnectQueue.length === 0) return;
    openReconnectShareDialog(reconnectQueue[0]);
  }, [mode, reconnectQueue]);

  useEffect(() => {
    if (!mode) return;
    setPassword('');
    setAllowEdit(false);
    setBusy(false);
    setError(null);
    // An unsaved tab has no real filename yet — pre-fill with its current
    // (untitled) title so there's something to edit, but require the user
    // to actually confirm/pick one (see the submit button's `disabled`):
    // peers who join will see exactly this as their tab's name.
    const t = mode === 'create' && tabId ? getTab(tabId) : undefined;
    const needsName = !!t && !t.filePath;
    setFileName(needsName ? t.title : '');
    const raf = requestAnimationFrame(() => (needsName ? fileNameRef : passwordRef).current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [mode, tabId]);

  if (!mode) return null;
  const tab = (mode === 'create' || mode === 'reconnect') && tabId ? getTab(tabId) : undefined;
  if ((mode === 'create' || mode === 'reconnect') && (!tabId || !tab)) return null;
  if (mode === 'join' && !share) return null;
  // An unsaved tab has no real filename for peers to see — require one
  // (see the "File name" field below) instead of falling back to
  // "untitled N", which would be a confusing name to show them.
  const needsFileName = mode === 'create' && !!tab && !tab.filePath;

  /** Reconnect canceled/failed for good: keep the tab, just stop treating it as a live share. */
  const demote = (id: string) => {
    updateTab(id, {
      isShared: false,
      shareId: undefined,
      shareReadOnly: undefined,
      shareRole: undefined,
      shareWordWrap: undefined,
    });
    void session.flushMeta(id);
    dismissShareReconnect(id);
  };

  const close = () => {
    // Always allowed, even mid-attempt: previously this was blocked while
    // `busy` (waiting on the network), so if a join/reconnect ended up
    // stuck — e.g. reconnecting to a share whose last participant already
    // disconnected, which can never succeed — there was no way to dismiss
    // the dialog short of waiting out the full 10s timeout. Canceling the
    // pending attempt lets submitJoin/submitReconnect's `await` unblock
    // immediately instead of leaving `busy` (and the dialog) stuck.
    const pendingShareId = mode === 'reconnect' ? tab?.shareId : mode === 'join' ? share?.shareId : undefined;
    if (busy && pendingShareId) shareClient.cancelJoin(pendingShareId);
    if (mode === 'reconnect' && tabId) demote(tabId);
    closeShareDialog();
  };

  const submitCreate = async () => {
    if (!tabId || !password || (needsFileName && !fileName.trim())) return;
    setBusy(true);
    setError(null);
    try {
      await shareClient.createShare(tabId, password, !allowEdit, fileName);
      showBanner(`Sharing "${getTab(tabId)?.title ?? tab?.title}"`);
      closeShareDialog();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const submitJoin = async () => {
    if (!share || !password) return;
    setBusy(true);
    setError(null);
    try {
      const result = await shareClient.joinShare(share, password);
      if (result === 'ok') {
        showBanner(`Opened "${share.filename}"`);
        closeShareDialog();
        // joinShare's addTab() already made the new tab active — closing
        // Settings (safe no-op if it wasn't open) is what actually brings
        // it into view when opened from the Settings → Share list.
        closeSettingsDialog();
      } else if (result === 'wrong-password') {
        setError('Wrong password');
      } else if (result !== 'canceled') {
        // 'canceled' means the user already hit Cancel (see close()) — the
        // dialog is on its way out, showing an error for it now would just
        // flash one nobody asked to see.
        setError('Could not join the share — the other instance may be offline');
      }
    } finally {
      setBusy(false);
    }
  };

  const submitReconnect = async () => {
    if (!tabId || !tab?.shareId || !password) return;
    setBusy(true);
    setError(null);
    try {
      const result = await shareClient.reconnectShare(tabId, tab.shareId, password);
      if (result === 'ok') {
        showBanner(`Reconnected "${tab.title}"`);
        dismissShareReconnect(tabId);
        closeShareDialog();
      } else if (result === 'wrong-password') {
        setError('Wrong password');
      } else if (result !== 'canceled') {
        setError('Could not reconnect — the share may no longer be available');
      }
    } finally {
      setBusy(false);
    }
  };

  const submit = () =>
    void (mode === 'create' ? submitCreate() : mode === 'join' ? submitJoin() : submitReconnect());

  const title =
    mode === 'create'
      ? `Share "${needsFileName ? fileName : tab?.title}"`
      : mode === 'reconnect'
        ? `Reconnect "${tab?.title}"`
        : `Open "${share?.filename}"`;
  const hint =
    mode === 'create'
      ? needsFileName
        ? "This tab isn't saved yet — pick a name for it; that's what everyone who opens it will see."
        : 'Anyone on the same Share server with the same API key and this password can open it.'
      : mode === 'reconnect'
        ? 'This file was part of a shared session. Enter the password to reconnect it.'
        : 'Enter the password the sharer set for this file.';
  const submitLabel = mode === 'create' ? 'Share' : mode === 'reconnect' ? 'Reconnect' : 'Open';

  return (
    <div className="dialog-overlay" onClick={close}>
      <div
        className="settings-dialog share-dialog"
        role="dialog"
        aria-label={mode === 'create' ? 'Share file' : mode === 'reconnect' ? 'Reconnect shared file' : 'Open shared file'}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="settings-subheading">{title}</h3>
        <p className="settings-hint">{hint}</p>
        <div className="settings-row settings-row-column">
          {needsFileName && (
            <input
              ref={fileNameRef}
              className="settings-number-input settings-wide-input"
              placeholder="File name (shown to everyone who opens it)"
              value={fileName}
              disabled={busy}
              onChange={(e) => setFileName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') passwordRef.current?.focus();
                if (e.key === 'Escape') close();
              }}
            />
          )}
          <PasswordInput
            ref={passwordRef}
            wide
            className="settings-number-input settings-wide-input"
            placeholder="Password"
            value={password}
            disabled={busy}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
              if (e.key === 'Escape') close();
            }}
          />
          {mode === 'create' && (
            <label className="ext-chip">
              <input
                type="checkbox"
                checked={allowEdit}
                disabled={busy}
                onChange={(e) => setAllowEdit(e.target.checked)}
              />
              Allow others to edit
            </label>
          )}
        </div>
        {error && <div className="settings-error">{error}</div>}
        <div className="close-confirm-actions">
          <button disabled={busy || !password || (needsFileName && !fileName.trim())} onClick={submit}>
            {submitLabel}
          </button>
          <button onClick={close}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
