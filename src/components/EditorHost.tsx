/**
 * Hosts the single CodeMirror EditorView and keeps one EditorState per tab
 * (swapped in when switching tabs — low RAM usage).
 */
import { useEffect, useRef, type CSSProperties } from 'react';
import { basicSetup } from 'codemirror';
import {
  EditorState,
  EditorSelection,
  Compartment,
  Prec,
  StateEffect,
  StateField,
  Annotation,
  ChangeSet,
  Text,
  RangeSetBuilder,
  type SelectionRange,
} from '@codemirror/state';
import { EditorView, Decoration, ViewPlugin, keymap, type DecorationSet, type KeyBinding, type ViewUpdate } from '@codemirror/view';
import { indentWithTab, simplifySelection, moveLineUp, moveLineDown } from '@codemirror/commands';
import { foldAll, unfoldAll, indentUnit } from '@codemirror/language';
import {
  search,
  SearchQuery,
  setSearchQuery,
  getSearchQuery,
  findNext as cmFindNext,
  findPrevious as cmFindPrevious,
  replaceNext as cmReplaceNext,
  replaceAll as cmReplaceAll,
} from '@codemirror/search';
import { oneDark } from '@codemirror/theme-one-dark';
import { languageExtension } from '../editor/languages';
import { editorBridge, type FindQuery, type FindOutcome, type MatchCount } from '../services/editorBridge';
import * as session from '../services/session';
import * as shareClient from '../services/shareClient';
import { detect } from '../services/detector';
import { formatText } from '../services/formatter';
import { cursorStore, columnModeStore, showBanner, toggleFind, toggleReplace } from '../store/misc';
import {
  tabsStore,
  initialContents,
  getTab,
  updateTab,
  setLanguage,
  isLockedForMe,
  effectiveWordWrap,
} from '../store/tabs';
import { settingsStore, matchesShortcut, matchesShortcutKey, zoomIn, zoomOut } from '../store/settings';
import { useStore } from '../store/createStore';
import type { DetectedType } from '../types';
import FindReplaceDialog from './FindReplaceDialog';

/**
 * Tags a transaction as having been applied from a remote real-time edit
 * (see services/shareClient.ts) rather than typed locally — the
 * `updateListener` below checks for it to avoid re-broadcasting an edit
 * that just came in over the network.
 */
const remoteSyncAnnotation = Annotation.define<boolean>();

const DETECT_DEBOUNCE_MS = 1200;

/**
 * Live match highlighting for the FindReplaceDialog. Independent of
 * CodeMirror's own built-in search decorations, which only render while its
 * native search panel is open (see @codemirror/search's `searchHighlighter`)
 * — this app never opens that panel, it drives search purely through the
 * `setSearchQuery` effect/API, so without this the dialog would show no
 * visual feedback for matches beyond a possibly-hard-to-see selection.
 */
const setHighlightQuery = StateEffect.define<SearchQuery | null>();

const highlightQueryField = StateField.define<SearchQuery | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setHighlightQuery)) value = effect.value;
    }
    return value;
  },
});

const matchMark = Decoration.mark({ class: 'cm-searchMatch' });
const selectedMatchMark = Decoration.mark({ class: 'cm-searchMatch cm-searchMatch-selected' });

function buildMatchDecorations(view: EditorView): DecorationSet {
  const query = view.state.field(highlightQueryField);
  if (!query || !query.valid || !query.search) return Decoration.none;

  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    const cursor = query.getCursor(view.state, from, to);
    let result = cursor.next();
    while (!result.done) {
      const { from: mFrom, to: mTo } = result.value;
      const selected = view.state.selection.ranges.some((r) => r.from === mFrom && r.to === mTo);
      builder.add(mFrom, mTo, selected ? selectedMatchMark : matchMark);
      result = cursor.next();
    }
  }
  return builder.finish();
}

const searchMatchHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildMatchDecorations(view);
    }
    update(update: ViewUpdate) {
      const queryChanged = update.transactions.some((tr) =>
        tr.effects.some((e) => e.is(setHighlightQuery)),
      );
      if (update.docChanged || update.viewportChanged || update.selectionSet || queryChanged) {
        this.decorations = buildMatchDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

const searchMatchTheme = EditorView.baseTheme({
  '.cm-searchMatch': { backgroundColor: 'rgba(255, 215, 0, 0.35)' },
  '.cm-searchMatch-selected': { backgroundColor: 'rgba(255, 140, 0, 0.55)' },
});

const searchHighlightExtension = [highlightQueryField, searchMatchHighlighter, searchMatchTheme];

export default function EditorHost() {
  const { tabs, activeId } = useStore(tabsStore);
  const { fontSize, fontFamily, wordWrap } = useStore(settingsStore);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const statesRef = useRef(new Map<string, EditorState>());
  const currentIdRef = useRef<string | null>(null);
  const langCompartment = useRef(new Compartment()).current;
  const wrapCompartment = useRef(new Compartment()).current;
  const shareLockCompartment = useRef(new Compartment()).current;
  const detectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const activeTab = tabs.find((t) => t.id === activeId);

  // ── Create the EditorView (only once) ──────────────────────────────────
  useEffect(() => {
    const updateListener = EditorView.updateListener.of((u) => {
      const id = currentIdRef.current;
      if (!id) return;

      if (u.docChanged) {
        updateTab(id, { dirty: true });
        session.scheduleSave(id);
        scheduleDetection(id, u.view);
        // Broadcast to the other share participants, unless this change
        // just came FROM one of them (see applyRemoteChanges/applyRemoteSnapshot
        // below) — otherwise every remote edit would immediately echo back.
        if (!u.transactions.some((tr) => tr.annotation(remoteSyncAnnotation))) {
          shareClient.broadcastLocalEdit(id, u.changes.toJSON(), u.state.doc.length);
        }
      }
      if (u.selectionSet || u.docChanged) {
        const head = u.state.selection.main.head;
        const line = u.state.doc.lineAt(head);
        cursorStore.set({ line: line.number, col: head - line.from + 1 });
        updateTab(id, { cursor: head });
      }
    });

    // For a shared tab, only the owner's instance may change the language
    // (see shareClient.setShareLanguage) — everyone else's is dictated by
    // Properties broadcasts, so their own auto-detection must stay silent.
    const applyDetectedLanguage = (id: string, lang: DetectedType) => {
      const tab = getTab(id);
      if (tab?.isShared) {
        if (tab.shareRole === 'owner') shareClient.setShareLanguage(id, lang, false);
      } else {
        setLanguage(id, lang, false);
      }
    };

    const scheduleDetection = (id: string, view: EditorView) => {
      clearTimeout(detectTimer.current);
      detectTimer.current = setTimeout(() => {
        const tab = getTab(id);
        if (!tab || tab.languageManual) return;
        if (tab.isShared && tab.shareRole !== 'owner') return; // owner-decided; see applyDetectedLanguage
        const text = view.state.doc.sliceString(0, 64 * 1024);
        const lang = detect(text, tab.filePath);
        if (lang !== tab.language) applyDetectedLanguage(id, lang);
      }, DETECT_DEBOUNCE_MS);
    };

    // On paste: always normalize line endings to LF. Auto-format only kicks
    // in when the paste replaces the ENTIRE document — an empty tab, or the
    // whole text explicitly selected (e.g. Ctrl+A then paste) — never when
    // pasting into a document that still has other text left untouched.
    const handlePaste = (event: ClipboardEvent, pasteView: EditorView): boolean => {
      // A read-only share (see isLockedForMe below): CodeMirror's own
      // built-in paste handler already checks this, but this custom one
      // runs first and dispatches unconditionally — without this check it
      // would silently bypass the lock. The pasted text stays purely local
      // (broadcastLocalEdit already refuses to send it), so previously it
      // just got wiped by the next real edit from the owner.
      if (pasteView.state.readOnly) {
        event.preventDefault();
        return true;
      }
      const text = event.clipboardData?.getData('text/plain');
      if (text == null) return false;
      const normalized = text.replace(/\r\n|\r/g, '\n');
      event.preventDefault();

      const id = currentIdRef.current;
      const state = pasteView.state;
      const main = state.selection.main;
      const isFullReplace =
        state.doc.length === 0 ||
        (state.selection.ranges.length === 1 && main.from === 0 && main.to === state.doc.length);

      if (isFullReplace && id) {
        const lang = detect(normalized, getTab(id)?.filePath ?? null);
        const result = formatText(normalized, lang);
        const finalText = result.ok ? result.text : normalized;
        pasteView.dispatch({
          changes: { from: 0, to: state.doc.length, insert: finalText },
          selection: { anchor: finalText.length },
        });
        applyDetectedLanguage(id, lang);
        if (result.ok) showBanner('Document formatted automatically');
        return true;
      }

      // Multiple cursors (e.g. column edit mode): our preventDefault() above
      // bypasses CodeMirror's own native paste handling, so replicate it here
      // — if the clipboard has exactly one line per cursor, distribute one
      // line to each; otherwise insert the same text at every cursor (both
      // match @codemirror/view's own `doPaste` behavior for multi-range
      // pastes). For the common single-cursor case this behaves exactly as
      // before.
      const pasted = state.toText(normalized);
      const byLine = pasted.lines === state.selection.ranges.length;
      let lineIndex = 1;
      const spec = byLine
        ? state.changeByRange((range) => {
            const line = pasted.line(lineIndex++);
            return {
              changes: { from: range.from, to: range.to, insert: line.text },
              range: EditorSelection.cursor(range.from + line.text.length),
            };
          })
        : state.replaceSelection(pasted);
      pasteView.dispatch(state.update(spec, { scrollIntoView: true }));
      return true;
    };

    // Column (multi-cursor / box) edit mode: a configurable shortcut
    // (default Alt+Shift+Insert, store/settings.ts's `columnMode`)
    // arms/disarms it. While armed:
    //   - Shift+Up/Down grows or shrinks a rectangular column selection (one
    //     cursor per row, all at the same column) from a fixed anchor point
    //     to the row the head is currently on — like a normal Shift+Arrow
    //     selection, just one cursor per line instead of one continuous
    //     range. Typing/deleting then applies to every row at once
    //     (CodeMirror already supports that natively for any multi-range
    //     selection).
    //   - Plain Up/Down (no Shift) never adds/removes cursors — arrows move
    //     exactly as they do when the mode is off.
    //   - Escape does NOT disarm it (unlike most other CM6 UI in this app) —
    //     only pressing the shortcut again turns it off. This, and requiring
    //     Shift for selection, mirrors how "column mode" behaves in
    //     Notepad++/similar editors, per explicit request.
    // It's global to this single EditorView, not per-tab, so switching tabs
    // always disarms it (see the tab-swap effect below) — otherwise it would
    // silently carry over onto a different, unrelated document.
    let columnModeArmed = false;
    // The box selection's fixed corner (line + column) and the line its
    // moving edge is currently on; both cleared whenever the box collapses
    // (mode toggled, or a non-Shift arrow press — see `columnModeKeymap`).
    let boxAnchor: { line: number; col: number } | null = null;
    let boxHeadLine: number | null = null;

    const resetColumnBox = () => {
      boxAnchor = null;
      boxHeadLine = null;
    };

    const setColumnModeArmed = (next: boolean) => {
      if (columnModeArmed === next) return;
      columnModeArmed = next;
      resetColumnBox();
      columnModeStore.set({ armed: next });
      // Disarming: collapse any stacked column cursors down to just the
      // main one, the same way CodeMirror's own Escape handling collapses
      // an ordinary selection (see @codemirror/commands' simplifySelection).
      if (!next) simplifySelection(view);
    };

    const extendColumnSelection = (v: EditorView, dir: 1 | -1): boolean => {
      const state = v.state;
      // Copied to locals so TS can narrow them (it won't narrow the
      // outer `let`s across the other closures that also reassign them).
      let anchor = boxAnchor;
      let headLine = boxHeadLine;
      if (anchor === null || headLine === null) {
        const head = state.selection.main.head;
        const line = state.doc.lineAt(head);
        anchor = { line: line.number, col: head - line.from };
        headLine = line.number;
      }
      const nextHeadLine = headLine + dir;
      if (nextHeadLine < 1 || nextHeadLine > state.doc.lines) return true;
      headLine = nextHeadLine;
      boxAnchor = anchor;
      boxHeadLine = headLine;

      const from = Math.min(anchor.line, headLine);
      const to = Math.max(anchor.line, headLine);
      const ranges: SelectionRange[] = [];
      for (let ln = from; ln <= to; ln++) {
        const line = state.doc.line(ln);
        ranges.push(EditorSelection.cursor(line.from + Math.min(anchor.col, line.length)));
      }
      v.dispatch({ selection: EditorSelection.create(ranges, headLine - from) });
      return true;
    };

    // The toggle itself is handled outside CodeMirror's keymap DSL (which
    // needs static key strings) so it can be reconfigured live from
    // Settings: it just compares every keydown against the current
    // `columnMode` shortcut, the same way App.tsx's global shortcuts do.
    const handleColumnModeToggleKey = (event: KeyboardEvent): boolean => {
      if (!matchesShortcut(event, settingsStore.get().shortcuts.columnMode)) return false;
      event.preventDefault();
      setColumnModeArmed(!columnModeArmed);
      return true;
    };

    // Same reconfigurable-from-Settings approach as column mode above: also
    // overrides basicSetup's own Mod-f -> openSearchPanel (CodeMirror's
    // built-in search UI), which would otherwise pop up its own panel
    // whenever focus is inside the editor. Ctrl+F/Ctrl+R always open our own
    // FindReplaceDialog instead (in 'find'/'replace' mode respectively) —
    // one dialog, not two different-looking ones.
    // stopPropagation() is required here (not just preventDefault()): this
    // handler and App.tsx's window-level one both match the same shortcut,
    // and since the native keydown bubbles from the editor up to window,
    // without it App.tsx's handler would ALSO fire for the same keypress —
    // toggling the dialog open then immediately closed again.
    const handleFindReplaceToggleKey = (event: KeyboardEvent): boolean => {
      const { shortcuts } = settingsStore.get();
      if (matchesShortcut(event, shortcuts.find)) {
        event.preventDefault();
        event.stopPropagation();
        toggleFind();
        return true;
      }
      if (matchesShortcut(event, shortcuts.replace)) {
        event.preventDefault();
        event.stopPropagation();
        toggleReplace();
        return true;
      }
      // Shift is a "find previous instead" direction modifier here, not
      // part of the shortcut's identity — see matchesShortcutKey.
      if (matchesShortcutKey(event, shortcuts.findNext)) {
        event.preventDefault();
        event.stopPropagation();
        repeatFind(event.shiftKey ? -1 : 1);
        return true;
      }
      return false;
    };

    const columnModeKeymap: KeyBinding[] = [
      {
        key: 'Shift-ArrowDown',
        run: (v) => (columnModeArmed ? extendColumnSelection(v, 1) : false),
      },
      {
        key: 'Shift-ArrowUp',
        run: (v) => (columnModeArmed ? extendColumnSelection(v, -1) : false),
      },
      {
        key: 'ArrowDown',
        run: () => {
          if (columnModeArmed) resetColumnBox();
          return false; // always let CodeMirror's normal navigation run too
        },
      },
      {
        key: 'ArrowUp',
        run: () => {
          if (columnModeArmed) resetColumnBox();
          return false;
        },
      },
    ];

    // Duplicates the selected text right after itself, or — if there's no
    // selection — the current line, right below it. Handles multiple
    // cursors/selections at once via changeByRange.
    const duplicateSelectionOrLine = (v: EditorView): boolean => {
      const { state } = v;
      // Custom command, unlike moveLineUp/moveLineDown below (built into
      // @codemirror/commands, which already self-guard on this) — see the
      // same note on handlePaste.
      if (state.readOnly) return true;
      const changes = state.changeByRange((range) => {
        if (range.empty) {
          const line = state.doc.lineAt(range.from);
          const lineText = state.doc.sliceString(line.from, line.to);
          const insertText = '\n' + lineText;
          return {
            changes: { from: line.to, insert: insertText },
            range: EditorSelection.cursor(range.from + insertText.length),
          };
        }
        const text = state.sliceDoc(range.from, range.to);
        return {
          changes: { from: range.to, insert: text },
          range: EditorSelection.range(range.to, range.to + text.length),
        };
      });
      v.dispatch(state.update(changes, { scrollIntoView: true }));
      return true;
    };

    // Reconfigurable-from-Settings, same approach as column mode/find above:
    // duplicate line/selection and move line up/down all have configurable
    // shortcuts (settings.ts's `duplicateLine`/`moveLineUp`/`moveLineDown`),
    // so they can't be bound via CodeMirror's static keymap DSL either.
    // moveLineUp/moveLineDown are CM6's own @codemirror/commands.
    const handleEditingShortcuts = (event: KeyboardEvent): boolean => {
      const { shortcuts } = settingsStore.get();
      if (matchesShortcut(event, shortcuts.duplicateLine)) {
        event.preventDefault();
        duplicateSelectionOrLine(view);
        return true;
      }
      if (matchesShortcut(event, shortcuts.moveLineUp)) {
        event.preventDefault();
        moveLineUp(view);
        return true;
      }
      if (matchesShortcut(event, shortcuts.moveLineDown)) {
        event.preventDefault();
        moveLineDown(view);
        return true;
      }
      return false;
    };

    const buildExtensions = (lang: DetectedType, locked: boolean, wrap: boolean) => [
      basicSetup,
      keymap.of([indentWithTab]),
      Prec.highest(keymap.of(columnModeKeymap)),
      Prec.highest(EditorView.domEventHandlers({ keydown: handleColumnModeToggleKey })),
      Prec.highest(EditorView.domEventHandlers({ keydown: handleFindReplaceToggleKey })),
      Prec.highest(EditorView.domEventHandlers({ keydown: handleEditingShortcuts })),
      search({ top: true }),
      searchHighlightExtension,
      EditorView.domEventHandlers({ paste: handlePaste }),
      oneDark,
      indentUnit.of('  '),
      wrapCompartment.of(wrap ? [EditorView.lineWrapping] : []),
      langCompartment.of(languageExtension(lang)),
      shareLockCompartment.of(EditorState.readOnly.of(locked)),
      updateListener,
    ];

    const view = new EditorView({
      state: EditorState.create({ doc: '', extensions: buildExtensions('plain', false, settingsStore.get().wordWrap) }),
      parent: containerRef.current!,
    });
    viewRef.current = view;

    const createState = (tabId: string): EditorState => {
      const tab = getTab(tabId);
      const content = initialContents.get(tabId) ?? '';
      initialContents.delete(tabId);
      const cursor = Math.min(tab?.cursor ?? 0, content.length);
      return EditorState.create({
        doc: content,
        selection: { anchor: cursor },
        extensions: buildExtensions(
          tab?.language ?? 'plain',
          isLockedForMe(tab),
          effectiveWordWrap(tab, settingsStore.get().wordWrap),
        ),
      });
    };

    const runQuery = (q: FindQuery, cmd: (v: EditorView) => boolean): FindOutcome => {
      const query = new SearchQuery({
        search: q.search,
        replace: q.replace,
        regexp: q.regexp,
        caseSensitive: q.caseSensitive,
      });
      view.dispatch({ effects: setSearchQuery.of(query) });
      if (!query.valid) return { valid: false, found: false };
      return { valid: true, found: cmd(view) };
    };

    // F3/Shift+F3 (see handleFindReplaceToggleKey and App.tsx): repeats
    // whichever search is already active in CodeMirror's own state, without
    // rebuilding the query — works even if the Find/Replace dialog is
    // closed, as long as a search was run at least once since it last opened.
    const repeatFind = (direction: 1 | -1): FindOutcome => {
      const query = getSearchQuery(view.state);
      if (!query.valid || !query.search) return { valid: false, found: false };
      const found = direction === 1 ? cmFindNext(view) : cmFindPrevious(view);
      return { valid: true, found };
    };

    // ── API exposed to the rest of the app ───────────────────────────────
    editorBridge.impl = {
      getContent: (tabId) => {
        if (tabId === currentIdRef.current) return view.state.doc.toString();
        const st = statesRef.current.get(tabId);
        if (st) return st.doc.toString();
        return initialContents.get(tabId) ?? null;
      },
      setActiveContent: (content) => {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: content },
        });
      },
      setContent: (tabId, content) => {
        if (tabId === currentIdRef.current) {
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: content },
          });
          return;
        }
        const st = statesRef.current.get(tabId);
        if (st) {
          const tr = st.update({ changes: { from: 0, to: st.doc.length, insert: content } });
          statesRef.current.set(tabId, tr.state);
          return;
        }
        // Never activated yet (e.g. a session tab restored at startup that
        // the user hasn't switched to): its EditorState doesn't exist yet,
        // it's still lazily pending in `initialContents` — update that
        // instead, so createState() picks up the new content whenever the
        // tab is eventually activated.
        if (initialContents.has(tabId)) {
          initialContents.set(tabId, content);
        }
      },
      applyRemoteChanges: (tabId, changesJson, expectedDocLen) => {
        try {
          const changes = ChangeSet.fromJSON(changesJson);
          if (tabId === currentIdRef.current) {
            const prevState = view.state;
            view.dispatch({ changes, annotations: remoteSyncAnnotation.of(true) });
            if (view.state.doc.length !== expectedDocLen) {
              view.setState(prevState); // roll back rather than leave a half-applied edit visible
              return false;
            }
            return true;
          }
          const st = statesRef.current.get(tabId);
          if (st) {
            const tr = st.update({ changes, annotations: remoteSyncAnnotation.of(true) });
            if (tr.state.doc.length !== expectedDocLen) return false;
            statesRef.current.set(tabId, tr.state);
            return true;
          }
          // Not yet activated: apply directly to the pending plain-text
          // content (no live EditorState exists for it yet).
          const content = initialContents.get(tabId);
          if (content === undefined) return false;
          const newDoc = changes.apply(Text.of(content.split('\n')));
          if (newDoc.length !== expectedDocLen) return false;
          initialContents.set(tabId, newDoc.toString());
          return true;
        } catch {
          return false; // malformed/out-of-range ChangeSet: caller should resync
        }
      },
      applyRemoteSnapshot: (tabId, content) => {
        if (tabId === currentIdRef.current) {
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: content },
            annotations: remoteSyncAnnotation.of(true),
          });
          return;
        }
        const st = statesRef.current.get(tabId);
        if (st) {
          const tr = st.update({
            changes: { from: 0, to: st.doc.length, insert: content },
            annotations: remoteSyncAnnotation.of(true),
          });
          statesRef.current.set(tabId, tr.state);
          return;
        }
        if (initialContents.has(tabId)) initialContents.set(tabId, content);
      },
      getSelection: () => {
        const sel = view.state.selection.main;
        return view.state.sliceDoc(sel.from, sel.to);
      },
      foldAll: () => foldAll(view),
      unfoldAll: () => unfoldAll(view),
      focus: () => view.focus(),
      findNext: (q) => runQuery(q, cmFindNext),
      findPrevious: (q) => runQuery(q, cmFindPrevious),
      repeatFind,
      replaceNext: (q) => runQuery(q, cmReplaceNext),
      replaceAll: (q) => runQuery(q, cmReplaceAll),
      countMatches: (q): MatchCount => {
        if (!q.search) return { valid: true, count: 0 };
        const query = new SearchQuery({
          search: q.search,
          replace: q.replace,
          regexp: q.regexp,
          caseSensitive: q.caseSensitive,
        });
        if (!query.valid) return { valid: false, count: 0 };
        const cursor = query.getCursor(view.state);
        let count = 0;
        while (!cursor.next().done) count++;
        return { valid: true, count };
      },
      previewSearch: (q) => {
        const query = q.search
          ? new SearchQuery({
              search: q.search,
              replace: q.replace,
              regexp: q.regexp,
              caseSensitive: q.caseSensitive,
            })
          : null;
        view.dispatch({ effects: setHighlightQuery.of(query) });
      },
      clearSearch: () => {
        view.dispatch({
          effects: [setSearchQuery.of(new SearchQuery({ search: '' })), setHighlightQuery.of(null)],
        });
      },
    };

    // Expose createState/setColumnModeArmed for the tab-swap effect (via ref)
    createStateRef.current = createState;
    setColumnModeArmedRef.current = setColumnModeArmed;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const createStateRef = useRef<(tabId: string) => EditorState>(null!);
  const setColumnModeArmedRef = useRef<(armed: boolean) => void>(null!);

  // ── Ctrl+Scroll wheel: zoom the editor font in/out ─────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      if (e.deltaY < 0) zoomIn();
      else if (e.deltaY > 0) zoomOut();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // ── Word wrap: apply to the currently active tab's view whenever the
  //    effective value changes — the global Settings toggle, OR (for a
  //    shared tab) the owner's per-share override arriving via Properties
  //    (see shareClient.setShareWordWrap) ───────────────────────────────
  const activeWrap = effectiveWordWrap(activeTab, wordWrap);
  useEffect(() => {
    const view = viewRef.current;
    if (!view || currentIdRef.current !== activeId) return;
    view.dispatch({
      effects: wrapCompartment.reconfigure(activeWrap ? [EditorView.lineWrapping] : []),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWrap, activeId]);

  // ── Swap the EditorState when switching tabs ───────────────────────────
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    // Save the outgoing tab's state
    if (currentIdRef.current && currentIdRef.current !== activeId) {
      statesRef.current.set(currentIdRef.current, view.state);
    }

    // Purge state for closed tabs
    const alive = new Set(tabs.map((t) => t.id));
    for (const id of statesRef.current.keys()) {
      if (!alive.has(id)) statesRef.current.delete(id);
    }

    if (!activeId) {
      currentIdRef.current = null;
      return;
    }
    if (currentIdRef.current !== activeId) {
      currentIdRef.current = activeId;
      // Column edit mode is global to this view, not per-tab: never let it
      // silently carry over onto the tab we're switching to.
      setColumnModeArmedRef.current(false);
      const state = statesRef.current.get(activeId) ?? createStateRef.current(activeId);
      view.setState(state);
      // Make sure the state's language, word wrap and share lock match the
      // current settings/tab (a background tab's state can be stale on any
      // of these if they changed while it wasn't active).
      const tab = getTab(activeId);
      if (tab) {
        view.dispatch({
          effects: [
            langCompartment.reconfigure(languageExtension(tab.language)),
            wrapCompartment.reconfigure(effectiveWordWrap(tab, wordWrap) ? [EditorView.lineWrapping] : []),
            shareLockCompartment.reconfigure(EditorState.readOnly.of(isLockedForMe(tab))),
          ],
        });
        const head = view.state.selection.main.head;
        const line = view.state.doc.lineAt(head);
        cursorStore.set({ line: line.number, col: head - line.from + 1 });
      }
      view.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, tabs]);

  // ── Reconfigure the language when it changes (detection or manual pick) ─
  const activeLang = activeTab?.language;
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !activeLang || currentIdRef.current !== activeId) return;
    view.dispatch({
      effects: langCompartment.reconfigure(languageExtension(activeLang)),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLang, activeId]);

  // ── Lock/unlock the editor when the active tab's share permission changes
  //    (e.g. its read-only flag flips, or its share is revoked) ───────────
  const activeLocked = isLockedForMe(activeTab);
  useEffect(() => {
    const view = viewRef.current;
    if (!view || currentIdRef.current !== activeId) return;
    view.dispatch({
      effects: shareLockCompartment.reconfigure(EditorState.readOnly.of(activeLocked)),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLocked, activeId]);

  const editorStyle = {
    '--editor-font-family': fontFamily ? `"${fontFamily}", var(--font-mono-fallback)` : undefined,
    '--editor-font-size': `${fontSize}px`,
  } as CSSProperties;

  return (
    <div className="editor-host" style={editorStyle}>
      <FindReplaceDialog />
      <div className="editor-surface" ref={containerRef}>
        {tabs.length === 0 && (
          <div className="editor-empty">
            <p>No tabs open</p>
            <p className="hint">
              Ctrl+N for a new tab · Ctrl+O to open a file
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
