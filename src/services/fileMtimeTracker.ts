/**
 * Last known on-disk modified time (ms since epoch) per tab id — shared
 * between `externalChanges.ts` (the interactive "reload from disk?" flow)
 * and `shareDiskSync.ts` (the silent two-way sync used by shared tabs
 * saved to a real path). Split out into its own module so neither needs to
 * import the other just for this.
 */
import * as backend from './backend';

const knownMtimes = new Map<string, number>();

export function forgetFileMtime(tabId: string): void {
  knownMtimes.delete(tabId);
}

export function getKnownMtime(tabId: string): number | undefined {
  return knownMtimes.get(tabId);
}

export function setKnownMtime(tabId: string, mtime: number): void {
  knownMtimes.set(tabId, mtime);
}

/**
 * Fetches and records the current on-disk mtime for a tab that was just
 * opened, saved, restored, or reloaded — so its content is known to match
 * disk, and future checks have a correct baseline. Best-effort: a failure
 * (e.g. the file was deleted, or permissions) just means this tab won't be
 * checked until it's saved again.
 */
export async function seedFileMtime(tabId: string, path: string): Promise<void> {
  try {
    setKnownMtime(tabId, await backend.getFileMtime(path));
  } catch {
    forgetFileMtime(tabId);
  }
}
