import { useStore } from '../store/createStore';
import { cursorStore, columnModeStore, saveStore } from '../store/misc';
import { tabsStore, setLanguage } from '../store/tabs';
import { settingsStore, toggleWordWrap, formatShortcut } from '../store/settings';
import * as session from '../services/session';
import { LANGUAGE_LABELS, type DetectedType } from '../types';

export default function StatusBar() {
  const { tabs, activeId } = useStore(tabsStore);
  const cursor = useStore(cursorStore);
  const save = useStore(saveStore);
  const { wordWrap, shortcuts } = useStore(settingsStore);
  const { armed: columnModeArmed } = useStore(columnModeStore);
  const tab = tabs.find((t) => t.id === activeId);

  return (
    <div className="statusbar">
      {tab ? (
        <>
          <span className="lang-select-wrap">
            <select
              className="lang-select"
              value={tab.language}
              title="Text type (force manually)"
              onChange={(e) => {
                setLanguage(tab.id, e.target.value as DetectedType, true);
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
            className={`wrap-toggle${wordWrap ? ' active' : ''}`}
            title="Toggle word wrap"
            aria-pressed={wordWrap}
            onClick={() => toggleWordWrap()}
          >
            Wrap
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
