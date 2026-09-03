import { useStore } from '../store/createStore';
import { cursorStore, columnModeStore, saveStore } from '../store/misc';
import { tabsStore, setLanguage, effectiveWordWrap, canControlShareProperties } from '../store/tabs';
import { settingsStore, toggleWordWrap, formatShortcut } from '../store/settings';
import { openCreateShareDialog, shareStore } from '../store/share';
import * as shareClient from '../services/shareClient';
import * as session from '../services/session';
import { LANGUAGE_LABELS, type DetectedType } from '../types';

export default function StatusBar() {
  const { tabs, activeId } = useStore(tabsStore);
  const cursor = useStore(cursorStore);
  const save = useStore(saveStore);
  const { wordWrap, shortcuts } = useStore(settingsStore);
  const { armed: columnModeArmed } = useStore(columnModeStore);
  const { shares } = useStore(shareStore);
  const tab = tabs.find((t) => t.id === activeId);
  const connected = tab?.isShared ? shares.find((s) => s.shareId === tab.shareId)?.connected : undefined;
  const ownShareProperties = canControlShareProperties(tab);
  const wrapActive = tab ? effectiveWordWrap(tab, wordWrap) : wordWrap;

  return (
    <div className="statusbar">
      {tab ? (
        <>
          <span className="lang-select-wrap">
            <select
              className="lang-select"
              value={tab.language}
              disabled={!ownShareProperties}
              title={ownShareProperties ? 'Text type (force manually)' : "Text type — set by this share's owner"}
              onChange={(e) => {
                const language = e.target.value as DetectedType;
                if (tab.isShared) shareClient.setShareLanguage(tab.id, language, true);
                else setLanguage(tab.id, language, true);
                void session.flushMeta(tab.id);
              }}
            >
              {(Object.keys(LANGUAGE_LABELS) as DetectedType[]).map((l) => (
                <option key={l} value={l}>
                  {LANGUAGE_LABELS[l]}
                  {l === tab.language && !tab.languageManual ? ' (auto)' : ''}
                </option>
              ))}
            </select>
          </span>
          <button
            type="button"
            className={`wrap-toggle${wrapActive ? ' active' : ''}`}
            title={ownShareProperties ? 'Toggle word wrap' : "Word wrap — set by this share's owner"}
            aria-pressed={wrapActive}
            disabled={!ownShareProperties}
            onClick={() => (tab.isShared ? shareClient.setShareWordWrap(tab.id, !wrapActive) : toggleWordWrap())}
          >
            Wrap
          </button>
          <button
            type="button"
            className={`share-toggle${tab.isShared ? ' active' : ''}`}
            title={
              tab.isShared
                ? `Shared${tab.shareReadOnly ? ' (read-only for others)' : ' (editable by others)'} — click to stop sharing`
                : 'Share this file in real time'
            }
            aria-pressed={!!tab.isShared}
            onClick={() => (tab.isShared ? shareClient.unshareTab(tab.id) : openCreateShareDialog(tab.id))}
          >
            🔗 {tab.isShared ? 'Shared' : 'Share'}
            {connected !== undefined ? ` (${connected})` : ''}
          </button>
          <span>{tab.encoding.toUpperCase()}</span>
          {columnModeArmed && (
            <span
              className="column-mode-badge"
              title={`Column (multi-cursor) edit mode is on — hold Shift with Up/Down to select a column; plain arrows move normally. Press ${formatShortcut(shortcuts.columnMode)} again to turn it off (Escape does not)`}
            >
              ⌶ Column mode
            </span>
          )}
          <span>
            Ln {cursor.line}, Col {cursor.col}
          </span>
        </>
      ) : (
        <span>—</span>
      )}
      <span className="status-spacer" />
      <span className={`save-status ${save.error ? 'error' : ''}`}>
        {save.error
          ? `⚠ ${save.error}`
          : save.pending
            ? '⏳ Saving…'
            : save.lastSaved
              ? `✓ Autosaved ${new Date(save.lastSaved).toLocaleTimeString()}`
              : ''}
      </span>
    </div>
  );
}
