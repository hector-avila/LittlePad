import { useState } from 'react';
import { useStore } from '../store/createStore';
import { tabsStore, setActive, updateTab } from '../store/tabs';
import * as session from '../services/session';
import { openSettings, menuOpenStore, toggleMenu, closeMenu } from '../store/misc';
import { settingsStore, formatShortcut } from '../store/settings';
import { reopenClosedFile, exitAction } from '../actions';
import { LANGUAGE_LABELS } from '../types';

interface Props {
  onNewTab: () => void;
  onCloseTab: (id: string) => void;
  onOpenFile: () => void;
}

export default function TabBar({ onNewTab, onCloseTab, onOpenFile }: Props) {
  const { tabs, activeId } = useStore(tabsStore);
  const { open } = useStore(menuOpenStore);
  const { shortcuts } = useStore(settingsStore);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const commitRename = () => {
    if (renamingId && renameValue.trim()) {
      updateTab(renamingId, { title: renameValue.trim() });
      void session.flushMeta(renamingId);
    }
    setRenamingId(null);
  };

  const run = (fn: () => void) => {
    closeMenu();
    fn();
  };

  return (
    <div className="tabbar-row">
      <button
        className="menu-button"
        onClick={toggleMenu}
        title="Menu (Alt)"
        aria-haspopup="true"
        aria-expanded={open}
      >
        ☰
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={closeMenu} />
          <div className="menu-dropdown" role="menu">
            <button role="menuitem" onClick={() => run(onNewTab)}>
              <span>📄 New tab</span>
              <span className="menu-shortcut">{formatShortcut(shortcuts.newTab)}</span>
            </button>
            <button role="menuitem" onClick={() => run(onOpenFile)}>
              <span>📂 Open file</span>
              <span className="menu-shortcut">{formatShortcut(shortcuts.openFile)}</span>
            </button>
            <button role="menuitem" onClick={() => run(() => void reopenClosedFile())}>
              <span>↩ Reopen closed tab</span>
              <span className="menu-shortcut">{formatShortcut(shortcuts.reopenClosed)}</span>
            </button>
            <div className="menu-sep" />
            <button role="menuitem" onClick={() => run(openSettings)}>
              <span>⚙ Settings</span>
            </button>
            <div className="menu-sep" />
            <button role="menuitem" onClick={() => run(() => void exitAction())}>
              <span>⏻ Exit</span>
            </button>
          </div>
        </>
      )}
      <div className="tabbar" role="tablist">
        {tabs.map((t) => (
          <div
            key={t.id}
            role="tab"
            aria-selected={t.id === activeId}
            className={`tab ${t.id === activeId ? 'active' : ''}`}
            onClick={() => setActive(t.id)}
            onDoubleClick={() => {
              setRenamingId(t.id);
              setRenameValue(t.title);
            }}
            onAuxClick={(e) => {
              if (e.button === 1) onCloseTab(t.id); // middle-click closes
            }}
            title={t.filePath ?? t.title}
          >
            <span className={`tab-badge lang-${t.language}`}>{LANGUAGE_LABELS[t.language]}</span>
            {renamingId === t.id ? (
              <input
                className="tab-rename"
                value={renameValue}
                autoFocus
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') setRenamingId(null);
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="tab-title">
                {t.title}
                {t.dirty && t.filePath && <span className="tab-dirty"> ●</span>}
              </span>
            )}
            <button
              className="tab-close"
              aria-label={`Close ${t.title}`}
              onClick={(e) => {
                e.stopPropagation();
                onCloseTab(t.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
        <button className="tab-new" onClick={onNewTab} title="New tab (Ctrl+N)">
          +
        </button>
      </div>
    </div>
  );
}
