import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useStore } from '../store/createStore';
import { findReplaceStore, closeFindReplace } from '../store/misc';
import { editorBridge, type FindQuery, type FindOutcome } from '../services/editorBridge';
import {
  settingsStore,
  matchesShortcutKey,
  setFindReplaceInputWidthPercent,
} from '../store/settings';

type Status = 'idle' | 'invalid' | 'not-found';

/**
 * Wires up one row's text input so its width gets persisted — as a
 * percentage of the row's width, so it stays meaningful across window
 * sizes — to Settings whenever it changes (dragged via that row's
 * `.fr-drag-handle`, see `beginResize` below). Also keeps the row's
 * `--fr-actions-width` CSS variable in sync with however wide its own
 * buttons currently render (they can change width if the UI text size
 * changes), which is what CSS uses to cap the input's `max-width` so a drag
 * can never cover them.
 *
 * Not a hook (called directly from a couple of plain `useEffect`s below,
 * once per row) — nothing here needs to run on every render, only when a
 * row actually mounts.
 */
function observeResizableInput(
  input: HTMLInputElement,
  row: HTMLDivElement,
  actions: HTMLDivElement,
): () => void {
  const applyActionsWidth = () => {
    row.style.setProperty('--fr-actions-width', `${actions.offsetWidth}px`);
  };
  applyActionsWidth();
  const actionsObserver = new ResizeObserver(applyActionsWidth);
  actionsObserver.observe(actions);

  // Debounced the same way SettingsDialog debounces its own resize handle,
  // so dragging doesn't spam localStorage on every pixel.
  let timer: ReturnType<typeof setTimeout>;
  const inputObserver = new ResizeObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (row.clientWidth <= 0) return;
      setFindReplaceInputWidthPercent((input.offsetWidth / row.clientWidth) * 100);
    }, 300);
  });
  inputObserver.observe(input);

  return () => {
    clearTimeout(timer);
    actionsObserver.disconnect();
    inputObserver.disconnect();
  };
}

/**
 * The `.fr-drag-handle`'s own width plus the row's two 6px flex gaps around
 * it (input↔handle, handle↔actions) — see App.css's `.fr-row`/
 * `.fr-drag-handle`. Reserved out of the drag's max width below, mirroring
 * the same allowance CSS's `max-width: calc(...)` already carves out of the
 * input's rendered size, so a drag never visually overruns the buttons.
 */
const HANDLE_RESERVED_PX = 22;

/** One row's input + the row itself + its buttons wrapper — see `beginResize`. */
interface ResizeTarget {
  input: HTMLInputElement;
  row: HTMLDivElement;
  actions: HTMLDivElement;
}

/**
 * Starts a pointer drag on a `.fr-drag-handle` — replaces the old native
 * corner-resize handle with an explicit, easier-to-grab drag target.
 * `targets` is every row that should resize together (both Find and
 * Replace's inputs share one width — see `resizeTargets` below — so
 * dragging either row's handle moves both at once, live): sets each one's
 * width directly on the DOM node for immediate visual feedback while
 * dragging; the `ResizeObserver` already watching each of them
 * (`observeResizableInput` above) picks up the resulting size and persists
 * it exactly as before.
 */
function beginResize(e: ReactPointerEvent<HTMLDivElement>, targets: ResizeTarget[]): void {
  if (targets.length === 0) return;
  e.preventDefault();
  const handle = e.currentTarget;
  handle.setPointerCapture(e.pointerId);
  const startX = e.clientX;
  // They're always kept at the same width (that's the whole point), so any
  // one of them is a fine starting point.
  const startWidth = targets[0].input.offsetWidth;
  // Mirrors the inputs' CSS `min-width` (App.css) — the drag shouldn't be
  // able to shrink them past what CSS itself allows.
  const minWidth = 100;
  // The TIGHTEST of every linked row's allowance — so growing from either
  // handle can never cover ANY linked row's buttons, not just the one
  // being dragged (rows can differ here: Find has 4 buttons, Replace 2).
  const maxWidth = Math.max(
    minWidth,
    Math.min(...targets.map((t) => t.row.clientWidth - t.actions.offsetWidth - HANDLE_RESERVED_PX)),
  );
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';

  const onMove = (ev: PointerEvent) => {
    const next = Math.min(maxWidth, Math.max(minWidth, startWidth + (ev.clientX - startX)));
    for (const t of targets) t.input.style.width = `${next}px`;
  };
  const onUp = (ev: PointerEvent) => {
    handle.releasePointerCapture(ev.pointerId);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

export default function FindReplaceDialog() {
  const { open, mode } = useStore(findReplaceStore);
  const { findReplaceInputWidthPercent } = useStore(settingsStore);
  const [searchText, setSearchText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [regexp, setRegexp] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [matchCount, setMatchCount] = useState<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const searchRowRef = useRef<HTMLDivElement>(null);
  const searchActionsRef = useRef<HTMLDivElement>(null);
  const replaceRowRef = useRef<HTMLDivElement>(null);
  const replaceActionsRef = useRef<HTMLDivElement>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!open) return;
    const selection = editorBridge.getSelection();
    if (selection) setSearchText(selection);
    setStatus('idle');
    const raf = requestAnimationFrame(() => searchRef.current?.select());
    return () => cancelAnimationFrame(raf);
  }, [open, mode]);

  // Live preview (debounced): highlights every match and updates the count
  // as the query changes, before Enter/Find is even pressed.
  useEffect(() => {
    if (!open) return;
    clearTimeout(previewTimer.current);
    if (!searchText) {
      setMatchCount(null);
      editorBridge.previewSearch({ search: '', replace: replaceText, regexp, caseSensitive });
      return;
    }
    previewTimer.current = setTimeout(() => {
      const q = { search: searchText, replace: replaceText, regexp, caseSensitive };
      const result = editorBridge.countMatches(q);
      setMatchCount(result.valid ? result.count : null);
      editorBridge.previewSearch(q);
    }, 150);
    return () => clearTimeout(previewTimer.current);
  }, [open, searchText, replaceText, regexp, caseSensitive]);

  // Resizable search input — always present while open.
  useEffect(() => {
    if (!open) return;
    const input = searchRef.current;
    const row = searchRowRef.current;
    const actions = searchActionsRef.current;
    if (!input || !row || !actions) return;
    return observeResizableInput(input, row, actions);
  }, [open]);

  // Resizable replace input — only mounted in 'replace' mode.
  useEffect(() => {
    if (!open || mode !== 'replace') return;
    const input = replaceRef.current;
    const row = replaceRowRef.current;
    const actions = replaceActionsRef.current;
    if (!input || !row || !actions) return;
    return observeResizableInput(input, row, actions);
  }, [open, mode]);

  if (!open) return null;

  const query: FindQuery = { search: searchText, replace: replaceText, regexp, caseSensitive };
  const inputStyle: CSSProperties = { width: `${findReplaceInputWidthPercent}%` };

  /**
   * Every row currently on screen that a drag should resize together — just
   * the Find row in 'find' mode, both Find and Replace in 'replace' mode
   * (see `beginResize`).
   */
  const resizeTargets = (): ResizeTarget[] => {
    const targets: ResizeTarget[] = [];
    if (searchRef.current && searchRowRef.current && searchActionsRef.current) {
      targets.push({ input: searchRef.current, row: searchRowRef.current, actions: searchActionsRef.current });
    }
    if (mode === 'replace' && replaceRef.current && replaceRowRef.current && replaceActionsRef.current) {
      targets.push({ input: replaceRef.current, row: replaceRowRef.current, actions: replaceActionsRef.current });
    }
    return targets;
  };

  const report = (result: FindOutcome) => {
    setStatus(!result.valid ? 'invalid' : result.found ? 'idle' : 'not-found');
    if (searchText) {
      const count = editorBridge.countMatches(query);
      setMatchCount(count.valid ? count.count : null);
      editorBridge.previewSearch(query);
    }
  };

  const close = () => {
    editorBridge.clearSearch();
    closeFindReplace();
    editorBridge.focus();
  };

  const handleFieldKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    // F3/Shift+F3 (configurable in Settings — see store/settings.ts):
    // handled here too, not just globally, so the status/match-count line
    // stays in sync while focus is in one of these inputs. stopPropagation
    // so App.tsx's window-level fallback doesn't also run it a second time.
    if (matchesShortcutKey(e, settingsStore.get().shortcuts.findNext)) {
      e.preventDefault();
      e.stopPropagation();
      report(e.shiftKey ? editorBridge.findPrevious(query) : editorBridge.findNext(query));
    }
  };

  return (
    <div
      className="find-replace-dialog"
      role="dialog"
      aria-label={mode === 'replace' ? 'Find and replace' : 'Find'}
    >
      <div className="fr-row" ref={searchRowRef}>
        <input
          ref={searchRef}
          type="text"
          tabIndex={1}
          style={inputStyle}
          value={searchText}
          placeholder="Find…"
          onChange={(e) => setSearchText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              report(e.shiftKey ? editorBridge.findPrevious(query) : editorBridge.findNext(query));
            } else {
              handleFieldKeyDown(e);
            }
          }}
        />
        <div
          className="fr-drag-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize search field"
          onPointerDown={(e) => beginResize(e, resizeTargets())}
        />
        <div className="fr-row-actions" ref={searchActionsRef}>
          <button
            type="button"
            tabIndex={5}
            className={`fr-icon-toggle${regexp ? ' active' : ''}`}
            aria-pressed={regexp}
            title="Regular expression"
            onClick={() => setRegexp((v) => !v)}
          >
            .*
          </button>
          <button
            type="button"
            tabIndex={6}
            className={`fr-icon-toggle${caseSensitive ? ' active' : ''}`}
            aria-pressed={caseSensitive}
            title="Case sensitive"
            onClick={() => setCaseSensitive((v) => !v)}
          >
            Aa
          </button>
          <button tabIndex={7} onClick={() => report(editorBridge.findPrevious(query))} title="Previous">
            ▲
          </button>
          <button tabIndex={8} onClick={() => report(editorBridge.findNext(query))} title="Next">
            ▼
          </button>
        </div>
      </div>
      {mode === 'replace' && (
        <div className="fr-row" ref={replaceRowRef}>
          <input
            ref={replaceRef}
            type="text"
            tabIndex={2}
            style={inputStyle}
            value={replaceText}
            placeholder="Replace with…"
            onChange={(e) => setReplaceText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                report(editorBridge.replaceNext(query));
              } else {
                handleFieldKeyDown(e);
              }
            }}
          />
          <div
            className="fr-drag-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize replace field"
            onPointerDown={(e) => beginResize(e, resizeTargets())}
          />
          <div className="fr-row-actions" ref={replaceActionsRef}>
            <button tabIndex={3} onClick={() => report(editorBridge.replaceNext(query))}>Replace</button>
            <button tabIndex={4} onClick={() => report(editorBridge.replaceAll(query))}>Replace all</button>
          </div>
        </div>
      )}
      {(status === 'invalid' || matchCount !== null) && (
        <div className="fr-row fr-options">
          {status === 'invalid' && (
            <span className="fr-status fr-error">Invalid regular expression</span>
          )}
          {status !== 'invalid' && matchCount !== null && (
            <span className="fr-status">
              {matchCount === 0 ? 'No matches' : `${matchCount} match${matchCount === 1 ? '' : 'es'}`}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
