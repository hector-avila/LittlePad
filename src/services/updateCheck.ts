/**
 * Best-effort check against GitHub Releases for a version newer than this
 * build — no auto-download/install, just a link + a matching asset for
 * `UpdateDialog` to point at. See CHANGELOG.md / the release workflow
 * (.github/workflows/release.yml) for how assets are named.
 */
import { isTauri, getPlatformInfo } from './backend';
import { version as appVersion } from '../../package.json';
import type { UpdateInfo } from '../store/update';

const REPO = 'hector-avila/LittlePad';

interface GithubAsset {
  name: string;
  browser_download_url: string;
}

interface GithubRelease {
  tag_name: string;
  body: string | null;
  html_url: string;
  assets: GithubAsset[];
}

/** True if `remote` (e.g. "1.2.0", optionally "v"-prefixed) outranks `current`. */
function isNewerVersion(remote: string, current: string): boolean {
  const r = remote.replace(/^v/, '').split('.').map(Number);
  const c = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const rv = r[i] ?? 0;
    const cv = c[i] ?? 0;
    if (rv !== cv) return rv > cv;
  }
  return false;
}

const OS_LABELS: Record<string, string> = {
  windows: 'Windows',
  linux: 'Linux',
  macos: 'macOS',
};

/** Matches the release asset built for this OS/CPU — see release.yml's matrix. */
function pickAsset(assets: GithubAsset[], os: string, arch: string): GithubAsset | null {
  const pattern =
    os === 'windows'
      ? /_windows_x64\.exe$/
      : os === 'linux'
        ? /_linux_x64$/
        : os === 'macos'
          ? arch === 'aarch64'
            ? /_aarch64\.app\.tar\.gz$/
            : /_x64\.app\.tar\.gz$/
          : null;
  if (!pattern) return null;
  return assets.find((a) => pattern.test(a.name)) ?? null;
}

/**
 * Checks GitHub for a newer published release than this build. Returns
 * null on anything short of "yes, there's a newer one" — offline, the API
 * rate-limited, nothing newer — this only ever informs the user, never
 * blocks or errors the app.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!isTauri) return null;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`);
    if (!res.ok) return null;
    const release = (await res.json()) as GithubRelease;
    const remoteVersion = release.tag_name.replace(/^v/, '');
    if (!isNewerVersion(remoteVersion, appVersion)) return null;

    const platform = await getPlatformInfo();
    const asset = platform ? pickAsset(release.assets, platform.os, platform.arch) : null;

    return {
      version: remoteVersion,
      notes: release.body ?? '',
      releaseUrl: release.html_url,
      downloadUrl: asset?.browser_download_url ?? null,
      downloadLabel: (platform && OS_LABELS[platform.os]) ?? 'your OS',
    };
  } catch {
    return null;
  }
}
