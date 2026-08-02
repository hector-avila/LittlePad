import { useEffect } from 'react';
import { useStore } from '../store/createStore';
import { externalChangeStore, advanceToDiscardConfirm, dismissCurrentExternalChange } from '../store/misc';
import { tabsStore } from '../store/tabs';
import { keepCurrentVersion, reloadFromDisk } from '../services/externalChanges';

export default function ExternalChangeDialog() {
  const { queue, stage } = useStore(externalChangeStore);
  const { tabs } = useStore(tabsStore);
  const tabId = queue[0];
  const tab = tabId ? tabs.find((t) => t.id === tabId) : undefined;

  // Defensive: if the queued tab got closed some other way while its prompt
  // was pending, drop it instead of permanently blocking the queue behind a
  // dead id.
  useEffect(() => {
    if (tabId && !tab) dismissCurrentExternalChange();
  }, [tabId, tab]);

  if (!tabId || !tab) return null;

  const keep = () => void keepCurrentVersion(tabId);
  const reload = () => {
    if (tab.dirty) advanceToDiscardConfirm();
    else void reloadFromDisk(tabId);
  };
  const discardAndReload = () => void reloadFromDisk(tabId);

  return (
    <div className="dialog-overlay" onClick={keep}>
      <div
        className="settings-dialog close-confirm-dialog"
        role="alertdialog"
        aria-label="File changed on disk"
        onClick={(e) => e.stopPropagation()}
      >
        {stage === 'ask' ? (
          <>
            <p>
              <strong>"{tab.title}"</strong> has changed on disk. Reload it?
            </p>
            <div className="close-confirm-actions">
              <button onClick={reload}>Reload</button>
              <button onClick={keep}>Keep my version</button>
            </div>
          </>
        ) : (
          <>
            <p>
              <strong>"{tab.title}"</strong> has unsaved changes. Reloading will
              discard them — this can't be undone. Continue?
            </p>
            <div className="close-confirm-actions">
              <button onClick={discardAndReload}>Discard &amp; Reload</button>
              <button onClick={keep}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
