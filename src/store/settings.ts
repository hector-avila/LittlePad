import { createStore } from './createStore';

/**
 * A key combination. Every action requires Ctrl/Cmd, except `columnMode`
 * (see `shortcutRequiresCtrl`), which instead requires Alt — it's an
 * Alt+Shift+Insert-style combo by default and would collide with normal
 * typing if it didn't require some modifier.
 */
export interface Shortcut {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

/** Actions with a shortcut configurable from the Settings screen. */
export type ActionId =
  | 'newTab'
  | 'openFile'
  | 'reopenClosed'
  | 'saveFile'
  | 'closeTab'
  | 'format'
  | 'foldAll'
  | 'unfoldAll'
  | 'find'
  | 'replace'
  | 'nextTab'
  | 'previousTab'
  | 'duplicateLine'
  | 'moveLineUp'
  | 'moveLineDown'
  | 'zoomIn'
  | 'zoomOut'
  | 'resetZoom'
  | 'columnMode';

export const ACTION_ORDER: ActionId[] = [
  'newTab',
  'openFile',
  'reopenClosed',
  'saveFile',
  'closeTab',
  'format',
  'foldAll',
  'unfoldAll',
  'find',
  'replace',
  'nextTab',
  'previousTab',
  'duplicateLine',
  'moveLineUp',
  'moveLineDown',
  'zoomIn',
  'zoomOut',
  'resetZoom',
  'columnMode',
];

export const ACTION_LABELS: Record<ActionId, string> = {
  newTab: 'New tab',
  openFile: 'Open file',
  reopenClosed: 'Reopen closed tab',
  saveFile: 'Save file',
  closeTab: 'Close tab',
  format: 'Format document',
  foldAll: 'Fold all',
  unfoldAll: 'Unfold all',
  find: 'Find',
  replace: 'Replace',
  nextTab: 'Next tab',
  previousTab: 'Previous tab',
  duplicateLine: 'Duplicate line/selection',
  moveLineUp: 'Move line up',
  moveLineDown: 'Move line down',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  resetZoom: 'Reset zoom',
  columnMode: 'Column (multi-cursor) edit mode',
};

/** `columnMode` doesn't need Ctrl/Cmd — it requires Alt instead (see `Shortcut`). */
export function shortcutRequiresCtrl(id: ActionId): boolean {
  return id !== 'columnMode';
}

export type Shortcuts = Record<ActionId, Shortcut>;

const DEFAULT_SHORTCUTS: Shortcuts = {
  newTab: { key: 'n', ctrl: true, shift: false, alt: false },
  openFile: { key: 'o', ctrl: true, shift: false, alt: false },
  reopenClosed: { key: 't', ctrl: true, shift: true, alt: false },
  saveFile: { key: 's', ctrl: true, shift: false, alt: false },
  closeTab: { key: 'w', ctrl: true, shift: false, alt: false },
  format: { key: 'f', ctrl: true, shift: true, alt: false },
  foldAll: { key: '[', ctrl: true, shift: false, alt: false },
  unfoldAll: { key: ']', ctrl: true, shift: false, alt: false },
  find: { key: 'f', ctrl: true, shift: false, alt: false },
  replace: { key: 'r', ctrl: true, shift: false, alt: false },
  nextTab: { key: 'pagedown', ctrl: true, shift: false, alt: false },
  previousTab: { key: 'pageup', ctrl: true, shift: false, alt: false },
  duplicateLine: { key: 'd', ctrl: true, shift: false, alt: false },
  moveLineUp: { key: 'arrowup', ctrl: true, shift: true, alt: false },
  moveLineDown: { key: 'arrowdown', ctrl: true, shift: true, alt: false },
  zoomIn: { key: '=', ctrl: true, shift: false, alt: false },
  zoomOut: { key: '-', ctrl: true, shift: false, alt: false },
  resetZoom: { key: '0', ctrl: true, shift: false, alt: false },
  columnMode: { key: 'insert', ctrl: false, shift: true, alt: true },
};

/** The built-in normal font size, in px — used to seed `baseFontSize` for new/legacy settings. */
export const DEFAULT_FONT_SIZE = 13;
export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 32;
const FONT_SIZE_STEP = 1;

/**
 * The built-in interface text size, in px. This scales the UI chrome
 * (toolbar, menus, dialogs, status bar…) via `--ui-font-scale` — it's
 * independent from the editor's own font size above.
 */
export const DEFAULT_UI_FONT_SIZE = 13;
export const MIN_UI_FONT_SIZE = 10;
export const MAX_UI_FONT_SIZE = 20;

/** Fonts bundled in `public/fonts` (declared via @font-face in App.css). */
export const BUNDLED_FONTS = ['Ubuntu Monospace', 'MesloLGS NF'] as const;

/**
 * The built-in Settings dialog size, in px — used to seed `settingsDialogSize`
 * for new/legacy settings. Users with a larger `uiFontSize` typically need a
 * bigger dialog too, hence it's resizable and remembered (see
 * `setSettingsDialogSize`).
 */
export const DEFAULT_SETTINGS_DIALOG_WIDTH = 680;
export const DEFAULT_SETTINGS_DIALOG_HEIGHT = 580;
export const MIN_SETTINGS_DIALOG_WIDTH = 420;
export const MIN_SETTINGS_DIALOG_HEIGHT = 360;

/**
 * Extensions LittlePad's language detection recognizes (see
 * `services/detector.ts`'s `EXT_MAP`) — offered as checkboxes on the
 * Settings screen's "File associations" section (Windows and Linux); the
 * user can also type in any extension not listed here.
 */
export const KNOWN_FILE_EXTENSIONS = [
  '.json', '.json5', '.jsonc', '.xml', '.xsd', '.xsl', '.svg', '.pom', '.yaml', '.yml',
  '.toml', '.ini', '.cfg', '.conf', '.properties', '.log', '.js', '.mjs', '.cjs', '.jsx',
  '.ts', '.tsx', '.java', '.py', '.md', '.markdown', '.mdx', '.txt',
] as const;

/**
 * Normalizes user-typed extension input ("json", ".JSON", " .json ") into
 * the `.ext` form the registry keys use, or null if it isn't a plausible
 * extension at all.
 */
export function normalizeExtension(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  const withDot = trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
  return /^\.[a-z0-9]{1,31}$/.test(withDot) ? withDot : null;
}

export interface Settings {
  shortcuts: Shortcuts;
  /** The user's chosen "normal" font size, in px — the floor Ctrl+Scroll-down zoom never goes below. */
  baseFontSize: number;
  /** Current effective editor font size in px (>= baseFontSize), adjusted by Ctrl+Scroll wheel. */
  fontSize: number;
  /** Editor font family name, or '' for the built-in default stack. */
  fontFamily: string;
  /** Whether long lines wrap instead of scrolling horizontally. */
  wordWrap: boolean;
  /** Interface text size, in px (toolbar, menus, dialogs, status bar…). */
  uiFontSize: number;
  /**
   * File extensions (".ext" form) currently registered with Windows'
   * "Open with" menu (see the Settings "File associations" section) —
   * empty everywhere else. This list is the source of truth for what's
   * actually registered, so it can be handed back to the Rust side to
   * clean up on "Remove all" or uninstall.
   */
  associatedExtensions: string[];
  /** Settings dialog size, in px — resizable by dragging its corner, remembered across launches. */
  settingsDialogSize: { width: number; height: number };
}

const DEFAULT_SETTINGS: Settings = {
  shortcuts: DEFAULT_SHORTCUTS,
  baseFontSize: DEFAULT_FONT_SIZE,
  fontSize: DEFAULT_FONT_SIZE,
  fontFamily: '',
  wordWrap: true,
  uiFontSize: DEFAULT_UI_FONT_SIZE,
  associatedExtensions: [],
  settingsDialogSize: {
    width: DEFAULT_SETTINGS_DIALOG_WIDTH,
    height: DEFAULT_SETTINGS_DIALOG_HEIGHT,
  },
};

// The only fixed, non-configurable shortcut left: Ctrl+Tab / Ctrl+Shift+Tab
// as a bonus, always-on tab-cycling gesture (browser convention), on top of
// the fully configurable nextTab/previousTab actions above. Every other
// shortcut in the app is configurable — see ACTION_ORDER.
const FIXED_SHORTCUTS: Shortcut[] = [
  { key: 'tab', ctrl: true, shift: false, alt: false },
  { key: 'tab', ctrl: true, shift: true, alt: false },
];

const LS_KEY = 'littlepad.settings';

function sameShortcut(a: Shortcut, b: Shortcut): boolean {
  return a.key === b.key && a.ctrl === b.ctrl && a.shift === b.shift && a.alt === b.alt;
}

/**
 * Returns which action already uses that shortcut ('fixed' if it's one of
 * the non-configurable fixed shortcuts), or null if it's free. `exclude`
 * allows reassigning an action to the shortcut it already had without
 * reporting it as a collision with itself.
 */
export function isTaken(
  shortcut: Shortcut,
  shortcuts: Shortcuts,
  exclude?: ActionId,
): ActionId | 'fixed' | null {
  if (FIXED_SHORTCUTS.some((f) => sameShortcut(f, shortcut))) return 'fixed';
  for (const id of ACTION_ORDER) {
    if (id !== exclude && sameShortcut(shortcuts[id], shortcut)) return id;
  }
  return null;
}

function clampSize(size: number, min: number): number {
  return Math.min(MAX_FONT_SIZE, Math.max(min, size));
}

function clampUiFontSize(size: number): number {
  return Math.min(MAX_UI_FONT_SIZE, Math.max(MIN_UI_FONT_SIZE, size));
}

function clampSettingsDialogSize(size: { width: number; height: number }): {
  width: number;
  height: number;
} {
  return {
    width: Math.max(MIN_SETTINGS_DIALOG_WIDTH, Math.round(size.width)),
    height: Math.max(MIN_SETTINGS_DIALOG_HEIGHT, Math.round(size.height)),
  };
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const baseFontSize =
      typeof parsed.baseFontSize === 'number'
        ? clampSize(parsed.baseFontSize, MIN_FONT_SIZE)
        : DEFAULT_SETTINGS.baseFontSize;
    return {
      shortcuts: { ...DEFAULT_SHORTCUTS, ...parsed.shortcuts },
      baseFontSize,
      fontSize:
        typeof parsed.fontSize === 'number'
          ? clampSize(parsed.fontSize, baseFontSize)
          : baseFontSize,
      fontFamily: parsed.fontFamily ?? DEFAULT_SETTINGS.fontFamily,
      wordWrap: typeof parsed.wordWrap === 'boolean' ? parsed.wordWrap : DEFAULT_SETTINGS.wordWrap,
      uiFontSize:
        typeof parsed.uiFontSize === 'number'
          ? clampUiFontSize(parsed.uiFontSize)
          : DEFAULT_SETTINGS.uiFontSize,
      associatedExtensions: Array.isArray(parsed.associatedExtensions)
        ? parsed.associatedExtensions.filter((e): e is string => typeof e === 'string')
        : DEFAULT_SETTINGS.associatedExtensions,
      settingsDialogSize:
        parsed.settingsDialogSize &&
        typeof parsed.settingsDialogSize.width === 'number' &&
        typeof parsed.settingsDialogSize.height === 'number'
          ? clampSettingsDialogSize(parsed.settingsDialogSize)
          : DEFAULT_SETTINGS.settingsDialogSize,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export const settingsStore = createStore<Settings>(load());

function persist(): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(settingsStore.get()));
  } catch {
    // localStorage not available: the preference only lasts this session.
  }
}

export function setShortcut(id: ActionId, shortcut: Shortcut): void {
  settingsStore.set((s) => ({ ...s, shortcuts: { ...s.shortcuts, [id]: shortcut } }));
  persist();
}

/** Ctrl+Scroll wheel up: grow the editor font, up to MAX_FONT_SIZE. */
export function zoomIn(): void {
  settingsStore.set((s) => ({
    ...s,
    fontSize: clampSize(s.fontSize + FONT_SIZE_STEP, s.baseFontSize),
  }));
  persist();
}

/** Ctrl+Scroll wheel down: shrink the editor font, never below `baseFontSize`. */
export function zoomOut(): void {
  settingsStore.set((s) => ({
    ...s,
    fontSize: clampSize(s.fontSize - FONT_SIZE_STEP, s.baseFontSize),
  }));
  persist();
}

/** Ctrl+0: resets the current effective size back to `baseFontSize`. */
export function resetFontSize(): void {
  settingsStore.set((s) => ({ ...s, fontSize: s.baseFontSize }));
  persist();
}

export function setFontFamily(fontFamily: string): void {
  settingsStore.set((s) => ({ ...s, fontFamily }));
  persist();
}

export function toggleWordWrap(): void {
  settingsStore.set((s) => ({ ...s, wordWrap: !s.wordWrap }));
  persist();
}

/** Sets the interface text size from Settings (toolbar, menus, dialogs…). */
export function setUiFontSize(size: number): void {
  settingsStore.set((s) => ({ ...s, uiFontSize: clampUiFontSize(Math.round(size)) }));
  persist();
}

/**
 * Records the Settings dialog's current size (dragged via its resize
 * handle), so it reopens at the same size next time — useful since a
 * larger `uiFontSize` usually calls for a bigger dialog too.
 */
export function setSettingsDialogSize(width: number, height: number): void {
  settingsStore.set((s) => ({
    ...s,
    settingsDialogSize: clampSettingsDialogSize({ width, height }),
  }));
  persist();
}

/**
 * Sets the "normal" font size from Settings — the floor for Ctrl+Scroll
 * zoom. Also resets the current effective size to it (so the change is
 * immediately visible, not just a new floor for future zooming).
 */
export function setBaseFontSize(size: number): void {
  settingsStore.set((s) => {
    const baseFontSize = clampSize(Math.round(size), MIN_FONT_SIZE);
    return { ...s, baseFontSize, fontSize: baseFontSize };
  });
  persist();
}

/** Records `ext` as registered (see backend.registerFileAssociation()). */
export function addAssociatedExtension(ext: string): void {
  settingsStore.set((s) =>
    s.associatedExtensions.includes(ext)
      ? s
      : { ...s, associatedExtensions: [...s.associatedExtensions, ext] },
  );
  persist();
}

/** Records `ext` as no longer registered (see backend.unregisterFileAssociation()). */
export function removeAssociatedExtension(ext: string): void {
  settingsStore.set((s) => ({
    ...s,
    associatedExtensions: s.associatedExtensions.filter((e) => e !== ext),
  }));
  persist();
}

/** Clears the whole list (see backend.removeAllFileAssociations()). */
export function clearAssociatedExtensions(): void {
  settingsStore.set((s) => ({ ...s, associatedExtensions: [] }));
  persist();
}

export function matchesShortcut(e: KeyboardEvent, s: Shortcut): boolean {
  const mod = e.ctrlKey || e.metaKey;
  return (
    mod === s.ctrl &&
    e.shiftKey === s.shift &&
    e.altKey === s.alt &&
    e.key.toLowerCase() === s.key
  );
}

export function formatShortcut(s: Shortcut): string {
  const parts: string[] = [];
  if (s.ctrl) parts.push('Ctrl');
  if (s.shift) parts.push('Shift');
  if (s.alt) parts.push('Alt');
  parts.push(
    s.key.length === 1 ? s.key.toUpperCase() : s.key.charAt(0).toUpperCase() + s.key.slice(1),
  );
  return parts.join('+');
}
