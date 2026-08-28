import { createStore } from './createStore';

/** A newer published release, as surfaced by `services/updateCheck.ts`. */
export interface UpdateInfo {
  /** e.g. "1.2.0" (no leading "v"). */
  version: string;
  /** The GitHub release's notes (Markdown), rendered with `<Changelog>`. */
  notes: string;
  /** The release page on GitHub, e.g. for platforms with no matching asset. */
  releaseUrl: string;
  /** Direct download URL for this OS/CPU's asset, or null if none matched. */
  downloadUrl: string | null;
  /** Human-readable OS name for the download button, e.g. "Windows". */
  downloadLabel: string;
}

export const updateStore = createStore<{ open: boolean; info: UpdateInfo | null }>({
  open: false,
  info: null,
});

const LS_KEY = 'littlepad.dismissedUpdateVersion';

function getDismissedVersion(): string | null {
  try {
    return localStorage.getItem(LS_KEY);
  } catch {
    return null;
  }
}

function setDismissedVersion(version: string): void {
  try {
    localStorage.setItem(LS_KEY, version);
  } catch {
    // localStorage not available: the dismissal just won't persist across restarts.
  }
}

/**
 * Opens the update dialog for `info`, unless the user already dismissed
 * this exact version (see `dismissUpdateVersion`) — a later version still
 * shows normally.
 */
export function showUpdate(info: UpdateInfo): void {
  if (getDismissedVersion() === info.version) return;
  updateStore.set({ open: true, info });
}

/** Closes the dialog for this session only — it shows again next launch. */
export function closeUpdateDialog(): void {
  updateStore.set((s) => ({ ...s, open: false }));
}

/** Closes the dialog and silences this specific version for future launches. */
export function dismissUpdateVersion(): void {
  const { info } = updateStore.get();
  if (info) setDismissedVersion(info.version);
  closeUpdateDialog();
}
