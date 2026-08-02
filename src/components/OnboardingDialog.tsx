import { useState } from 'react';
import { useStore } from '../store/createStore';
import { onboardingStore, closeOnboarding, showBanner } from '../store/misc';
import * as backend from '../services/backend';

export default function OnboardingDialog() {
  const { open } = useStore(onboardingStore);
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  const accept = async () => {
    setBusy(true);
    try {
      const message = await backend.setupShortcuts();
      showBanner(message);
    } catch (e) {
      showBanner(String(e), 'error');
    } finally {
      setBusy(false);
      closeOnboarding();
    }
  };

  return (
    <div className="dialog-overlay" onClick={() => closeOnboarding()}>
      <div
        className="settings-dialog close-confirm-dialog"
        role="dialog"
        aria-label="Create shortcut"
        onClick={(e) => e.stopPropagation()}
      >
        <p>
          Create a desktop shortcut for LittlePad and add it to your PATH, so
          you can also launch it by typing <code>littlepad</code> in a
          terminal?
        </p>
        <div className="close-confirm-actions">
          <button disabled={busy} onClick={() => void accept()}>
            {busy ? 'Working…' : 'Yes'}
          </button>
          <button disabled={busy} onClick={() => closeOnboarding()}>
            No
          </button>
        </div>
      </div>
    </div>
  );
}
