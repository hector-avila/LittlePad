export type DetectedType =
  | 'json'
  | 'xml'
  | 'yaml'
  | 'toml'
  | 'ini'
  | 'log'
  | 'javascript'
  | 'java'
  | 'python'
  | 'markdown'
  | 'plain';

export const LANGUAGE_LABELS: Record<DetectedType, string> = {
  json: 'JSON',
  xml: 'XML',
  yaml: 'YAML',
  toml: 'TOML',
  ini: 'INI',
  log: 'Log',
  javascript: 'JavaScript',
  java: 'Java',
  python: 'Python',
  markdown: 'Markdown',
  plain: 'Plain text',
};

/** Whether this instance created a share ('owner') or joined one ('peer'). */
export type ShareRole = 'owner' | 'peer';

export interface Tab {
  id: string;
  title: string;
  filePath: string | null;
  language: DetectedType;
  languageManual: boolean;
  dirty: boolean;
  encoding: 'utf-8' | 'latin1';
  cursor: number;
  /**
   * Real-time sharing state (see services/shareClient.ts). `isShared` and
   * `shareRole` never survive a restart — they're re-derived from
   * `shareId`/`shareReadOnly` below, which DO (see TabMeta): only for a
   * joined (peer) share, never for the owner's own (session.ts's toMeta()
   * only carries them for `shareRole === 'peer'`) — an owner's tab always
   * reopens as a plain local one; a peer's instead prompts to reconnect
   * with just the password (see store/share.ts's reconnect queue).
   */
  isShared?: boolean;
  shareId?: string;
  shareReadOnly?: boolean;
  shareRole?: ShareRole;
  /**
   * Per-share override of the global word-wrap setting, synced in real time
   * across every instance holding this share (see shareClient.ts's
   * `setShareWordWrap`/Properties message) — `undefined` means "use the
   * global Settings value". Only the owner may change it; like `shareId`
   * above it's part of a share's ephemeral state, not persisted.
   */
  shareWordWrap?: boolean;
}

export interface SessionIndex {
  tabOrder: string[];
  activeTabId: string | null;
}

export interface TabMeta {
  id: string;
  title: string;
  filePath: string | null;
  language: string;
  languageManual: boolean;
  dirty: boolean;
  cursor: number;
  /** Only set for a joined (peer) share — see `Tab`'s doc comment above. */
  shareId?: string;
  shareReadOnly?: boolean;
}

export interface SessionTab {
  meta: TabMeta;
  content: string;
}

export interface SessionData {
  index: SessionIndex | null;
  tabs: SessionTab[];
}
