import { useStore } from '../store/createStore';
import { closeConfirmStore, clearCloseConfirm } from '../store/misc';
import { tabsStore } from '../store/tabs';
import { saveTab, finishCloseTab } from '../actions';

export default function CloseConfirmDialog() {
  const { tabId } = useStore(closeConfirmStore);
  const { tabs } = useStore(tabsStore);
  const tab = tabId ? tabs.find((t) => t.id === tabId) : undefined;

  if (!tabId || !tab) return null;

  const save = async () => {
    const ok = await saveTab(tab);
    clearCloseConfirm();
    if (ok) finishCloseTab(tab);
  };

  const discard = () => {
    finishCloseTab(tab);
    clearCloseConfirm();
  };

  return (
    <div className="dialog-overlay" onClick={() => clearCloseConfirm()}>
      <div
        className="settings-dialog close-confirm-dialog"
        role="alertdialog"
        aria-label="Save changes before closing"
        onClick={(e) => e.stopPropagation()}
      >
        <p>
          Save changes to <strong>"{tab.title}"</strong> before closing?
        </p>
        <div className="close-confirm-actions">
          <button onClick={() => void save()}>Save</button>
          <button onClick={discard}>Don't Save</button>
          <button onClick={() => clearCloseConfirm()}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
