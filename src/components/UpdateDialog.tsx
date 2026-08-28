import { useStore } from '../store/createStore';
import { updateStore, closeUpdateDialog, dismissUpdateVersion } from '../store/update';
import { openExternal } from '../services/backend';
import Changelog from './Changelog';

export default function UpdateDialog() {
  const { open, info } = useStore(updateStore);

  if (!open || !info) return null;

  return (
    <div className="dialog-overlay" onClick={() => closeUpdateDialog()}>
      <div
        className="settings-dialog update-dialog"
        role="dialog"
        aria-label="Update available"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="settings-subheading" style={{ marginTop: 0 }}>
          LittlePad v{info.version} is available
        </h3>
        {info.notes && <Changelog markdown={info.notes} />}
        <div className="close-confirm-actions">
          {info.downloadUrl && (
            <button onClick={() => void openExternal(info.downloadUrl!)}>
              Download for {info.downloadLabel}
            </button>
          )}
          <button onClick={() => void openExternal(info.releaseUrl)}>View on GitHub</button>
          <button onClick={() => dismissUpdateVersion()}>Don't show again for this version</button>
        </div>
      </div>
    </div>
  );
}
