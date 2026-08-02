import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useStore } from '../store/createStore';
import { findReplaceStore, closeFindReplace } from '../store/misc';
import { editorBridge, type FindQuery, type FindOutcome } from '../services/editorBridge';

type Status = 'idle' | 'invalid' | 'not-found';

export default function FindReplaceDialog() {
  const { open, mode } = useStore(findReplaceStore);
  const [searchText, setSearchText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [regexp, setRegexp] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [matchCount, setMatchCount] = useState<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!open) return;
    const selection = editorBridge.getSelection();
    if (selection) setSearchText(selection);
    setStatus('idle');
    const raf = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open]);

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

  if (!open) return null;

  const query: FindQuery = { search: searchText, replace: replaceText, regexp, caseSensitive };

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
    }
  };

  return (
    <div
      className="find-replace-dialog"
      role="dialog"
      aria-label={mode === 'replace' ? 'Find and replace' : 'Find'}
    >
      <div className="fr-row">
        <input
          ref={searchRef}
          type="text"
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
        <button
          type="button"
          className={`fr-icon-toggle${regexp ? ' active' : ''}`}
          aria-pressed={regexp}
          title="Regular expression"
          onClick={() => setRegexp((v) => !v)}
        >
          .*
        </button>
        <button
          type="button"
          className={`fr-icon-toggle${caseSensitive ? ' active' : ''}`}
          aria-pressed={caseSensitive}
          title="Case sensitive"
          onClick={() => setCaseSensitive((v) => !v)}
        >
          Aa
        </button>
        <button onClick={() => report(editorBridge.findPrevious(query))} title="Previous">
          ▲
        </button>
        <button onClick={() => report(editorBridge.findNext(query))} title="Next">
          ▼
        </button>
        <button className="fr-close" onClick={close} title="Close (Esc)">
          ×
        </button>
      </div>
      {mode === 'replace' && (
        <div className="fr-row">
          <input
            type="text"
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
          <button onClick={() => report(editorBridge.replaceNext(query))}>Replace</button>
          <button onClick={() => report(editorBridge.replaceAll(query))}>Replace all</button>
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
