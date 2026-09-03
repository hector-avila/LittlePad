/** Parameters for a find/replace operation (independent of CodeMirror). */
export interface FindQuery {
  search: string;
  replace: string;
  regexp: boolean;
  caseSensitive: boolean;
}

/** Result of a find/replace operation. */
export interface FindOutcome {
  /** false if `search` is not a valid regular expression (when regexp is on). */
  valid: boolean;
  /** true if there was a match (or replacement, depending on the command). */
  found: boolean;
}

/** How many times `query` matches the active tab's document. */
export interface MatchCount {
  /** false if `search` is not a valid regular expression (when regexp is on). */
  valid: boolean;
  count: number;
}

/**
 * Bridge between React/services and CodeMirror's EditorView
 * (which lives outside the React tree for performance).
 */
export interface EditorApi {
  /** Content of any tab (active or in the background). */
  getContent(tabId: string): string | null;
  /** Replaces the entire document of the active tab. */
  setActiveContent(content: string): void;
  /** Replaces the entire document of any tab (active or in the background) —
   * e.g. reloading a file after it changed on disk. */
  setContent(tabId: string, content: string): void;
  /**
   * Applies an incoming real-time edit (see services/shareClient.ts): a
   * serialized CodeMirror `ChangeSet` produced by a remote participant.
   * Tagged so EditorHost's updateListener doesn't rebroadcast it. Returns
   * false (applying nothing) if the ChangeSet can't apply to the current
   * document, or applies to a different length than `expectedDocLen` — the
   * last-writer-wins safety net's cue to request a fresh resync instead of
   * risking a corrupted document.
   */
  applyRemoteChanges(tabId: string, changes: unknown, expectedDocLen: number): boolean;
  /**
   * Replaces a tab's entire content from a remote snapshot/resync (see
   * services/shareClient.ts) — like `setContent`, but tagged so it doesn't
   * get rebroadcast as if it were a local edit.
   */
  applyRemoteSnapshot(tabId: string, content: string): void;
  /** Selected text in the active tab ('' if there's no selection). */
  getSelection(): string;
  foldAll(): void;
  unfoldAll(): void;
  focus(): void;
  findNext(query: FindQuery): FindOutcome;
  findPrevious(query: FindQuery): FindOutcome;
  /**
   * Repeats whichever search is currently active in CodeMirror's own search
   * state (last set by findNext/findPrevious/replaceNext/replaceAll above),
   * without rebuilding the query — used by the global F3/Shift+F3 shortcut,
   * which works whether the Find/Replace dialog is open or closed, and
   * regardless of where focus currently is.
   */
  repeatFind(direction: 1 | -1): FindOutcome;
  replaceNext(query: FindQuery): FindOutcome;
  replaceAll(query: FindQuery): FindOutcome;
  /** Total number of matches of `query` in the active tab's document. */
  countMatches(query: FindQuery): MatchCount;
  /** Live-highlights every match of `query` (dialog stays open while typing). */
  previewSearch(query: FindQuery): void;
  /** Clears match highlighting (when the dialog is closed). */
  clearSearch(): void;
}

const noopOutcome: FindOutcome = { valid: false, found: false };
const noopCount: MatchCount = { valid: false, count: 0 };

const noop: EditorApi = {
  getContent: () => null,
  setActiveContent: () => {},
  setContent: () => {},
  applyRemoteChanges: () => false,
  applyRemoteSnapshot: () => {},
  getSelection: () => '',
  foldAll: () => {},
  unfoldAll: () => {},
  focus: () => {},
  findNext: () => noopOutcome,
  findPrevious: () => noopOutcome,
  repeatFind: () => noopOutcome,
  replaceNext: () => noopOutcome,
  replaceAll: () => noopOutcome,
  countMatches: () => noopCount,
  previewSearch: () => {},
  clearSearch: () => {},
};

export const editorBridge: { impl: EditorApi } & EditorApi = {
  impl: noop,
  getContent: (id) => editorBridge.impl.getContent(id),
  setActiveContent: (c) => editorBridge.impl.setActiveContent(c),
  setContent: (id, c) => editorBridge.impl.setContent(id, c),
  applyRemoteChanges: (id, changes, expectedDocLen) =>
    editorBridge.impl.applyRemoteChanges(id, changes, expectedDocLen),
  applyRemoteSnapshot: (id, c) => editorBridge.impl.applyRemoteSnapshot(id, c),
  getSelection: () => editorBridge.impl.getSelection(),
  foldAll: () => editorBridge.impl.foldAll(),
  unfoldAll: () => editorBridge.impl.unfoldAll(),
  focus: () => editorBridge.impl.focus(),
  findNext: (q) => editorBridge.impl.findNext(q),
  findPrevious: (q) => editorBridge.impl.findPrevious(q),
  repeatFind: (dir) => editorBridge.impl.repeatFind(dir),
  replaceNext: (q) => editorBridge.impl.replaceNext(q),
  replaceAll: (q) => editorBridge.impl.replaceAll(q),
  countMatches: (q) => editorBridge.impl.countMatches(q),
  previewSearch: (q) => editorBridge.impl.previewSearch(q),
  clearSearch: () => editorBridge.impl.clearSearch(),
};
