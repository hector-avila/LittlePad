import { useEffect, useRef, useState } from 'react';
import TabBar from './components/TabBar';
import EditorHost from './components/EditorHost';
import StatusBar from './components/StatusBar';
import Banner from './components/Banner';
import SettingsDialog from './components/SettingsDialog';
import CloseConfirmDialog from './components/CloseConfirmDialog';
import OnboardingDialog from './components/OnboardingDialog';
import ExternalChangeDialog from './components/ExternalChangeDialog';
import * as backend from './services/backend';
import * as session from './services/session';
import { editorBridge } from './services/editorBridge';
import { seedFileMtime, checkForExternalChanges } from './services/externalChanges';
import {
  showBanner,
  toggleFind,
  toggleReplace,
  findReplaceStore,
  closeFindReplace,
  settingsOpenStore,
  closeSettingsDialog,
  menuOpenStore,
  closeMenu,
  toggleMenu,
  openOnboarding,
} from './store/misc';
import { settingsStore, matchesShortcut, zoomIn, zoomOut, resetFontSize } from './store/settings';
import { tabsStore, addTab, activeTab, sessionIndex } from './store/tabs';
import {
  newTab,
  openPath,
  openFileAction,
  openDroppedBrowserFile,
  saveFileAction,
  reopenClosedFile,
  closeTabAction,
  formatAction,
  cycleTab,
} from './actions';
import type { DetectedType } from './types';
import './App.css';

export default function App() {
  const loadedRef = useRef(false);
  const [dragActive, setDragActive] = useState(false);

  // Restore the session on startup
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;

    void (async () => {
      try {
        const data = await backend.loadSession();
        if (data.tabs.length === 0) {
          newTab();
          return;
        }
        for (const st of data.tabs) {
          addTab(
            {
              id: st.meta.id,
              title: st.meta.title,
              filePath: st.meta.filePath,
              language: (st.meta.language as DetectedType) ?? 'plain',
              languageManual: st.meta.languageManual,
              dirty: st.meta.dirty,
              cursor: st.meta.cursor,
            },
            st.content,
          );
          // Baseline for external-change detection (see checkForExternalChanges):
          // without this, the first focus check after startup would think
          // every restored file "changed" since it never recorded one.
          if (st.meta.filePath) void seedFileMtime(st.meta.id, st.meta.filePath);
        }
        const activeId = data.index?.activeTabId;
        if (activeId && data.tabs.some((t) => t.meta.id === activeId)) {
          tabsStore.set((s) => ({ ...s, activeId }));
        }
      } catch (e) {
        showBanner(`Could not restore the session: ${e}`, 'error');
        newTab();
      }

      // Files passed as CLI arguments to this launch (e.g. `littlepad foo.json`).
      try {
        const launchFiles = await backend.getLaunchFiles();
        for (const path of launchFiles) {
          void openPath(path);
        }
      } catch {
        /* no launch files to open, or not running in Tauri */
      }

      // First-run onboarding: offer to create a shortcut and add to PATH.
      try {
        if (await backend.checkFirstRun()) openOnboarding();
      } catch {
        /* couldn't determine first-run status: don't bother the user */
      }
    })();
  }, []);

  // Save the index whenever the structure/active tab changes
  useEffect(() => {
    let prev = '';
    return tabsStore.subscribe(() => {
      const now = JSON.stringify(sessionIndex());
      if (now !== prev) {
        prev = now;
        session.scheduleSaveIndex();
      }
    });
  }, []);

  // Flush on window close (Tauri) / beforeunload (browser)
  useEffect(() => {
    const flushEverything = () =>
      session.flushAll(tabsStore.get().tabs.map((t) => t.id));

    if (backend.isTauri) {
      let unlisten: (() => void) | undefined;
      let unlistenResized: (() => void) | undefined;
      let unlistenMoved: (() => void) | undefined;
      let closing = false;
      // Position/size to persist on close. Maximizing a window reports its
      // full-screen bounds via outerPosition()/outerSize() — saving those
      // as-is would make a later un-maximize snap to that (wrong) size
      // instead of the size the user actually resized it to. So this is
      // only ever updated while the window is NOT maximized, and combined
      // with the (separately tracked) maximized flag only at close time.
      const lastNormalBounds = { x: 0, y: 0, width: 0, height: 0 };
      void (async () => {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();

        const captureIfNormal = async () => {
          if (await win.isMaximized()) return;
          const pos = await win.outerPosition();
          const size = await win.outerSize();
          lastNormalBounds.x = pos.x;
          lastNormalBounds.y = pos.y;
          lastNormalBounds.width = size.width;
          lastNormalBounds.height = size.height;
        };
        // Seed with the current bounds (even if currently maximized — a
        // harmless fallback that's immediately corrected the moment the
        // window is un-maximized, if ever).
        const seedPos = await win.outerPosition();
        const seedSize = await win.outerSize();
        lastNormalBounds.x = seedPos.x;
        lastNormalBounds.y = seedPos.y;
        lastNormalBounds.width = seedSize.width;
        lastNormalBounds.height = seedSize.height;

        unlistenResized = await win.onResized(() => void captureIfNormal());
        unlistenMoved = await win.onMoved(() => void captureIfNormal());

        unlisten = await win.onCloseRequested(async (event) => {
          if (closing) return;
          closing = true;
          event.preventDefault();
          await flushEverything();
          try {
            const maximized = await win.isMaximized();
            await backend.saveWindowState({ ...lastNormalBounds, maximized });
          } catch {
            /* not fatal: closing must never be blocked by this */
          }
          try {
            await win.destroy();
          } catch {
            // Fallback if destroy() fails for some reason (e.g. permissions):
            // close() still lets the window close either way.
            await win.close();
          }
        });
      })();
      return () => {
        unlisten?.();
        unlistenResized?.();
        unlistenMoved?.();
      };
    } else {
      const handler = () => void flushEverything();
      window.addEventListener('beforeunload', handler);
      return () => window.removeEventListener('beforeunload', handler);
    }
  }, []);

  // Drag and drop files to open them. Two mechanisms run side by side:
  //
  //  1. Tauri's own webview-level drag-drop event (real filesystem paths,
  //     so the opened tab is tied to the actual file — Save writes back to
  //     it). Primary mechanism on desktop.
  //  2. The plain HTML5 drag-and-drop API (dataTransfer/File), always
  //     wired up too — it's the ONLY mechanism in the browser dev build,
  //     but it also acts as a safety net on desktop: some Linux/Wayland
  //     setups have a known upstream bug where Tauri's own 'drop' event
  //     silently never fires (drag-enter/over/leave still do) — see
  //     https://github.com/tauri-apps/tauri/issues/11282. Without a real
  //     path, files opened this way behave like the browser fallback
  //     always did (no on-disk path until explicitly saved), but that's
  //     strictly better than drag & drop doing nothing at all.
  //
  // `tauriDropAt` lets the HTML5 handler recognize "Tauri's own mechanism
  // just handled this exact drop" (both fire on some setups) and skip
  // re-opening the same files as a second, path-less tab.
  useEffect(() => {
    let tauriDropAt = 0;
    let tauriDragActive = false;
    let htmlDragActive = false;
    const updateDragActive = () => setDragActive(tauriDragActive || htmlDragActive);

    let unlistenTauriDrag: (() => void) | undefined;
    if (backend.isTauri) {
      void (async () => {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview');
        unlistenTauriDrag = await getCurrentWebview().onDragDropEvent((event) => {
          if (event.payload.type === 'enter' || event.payload.type === 'over') {
            tauriDragActive = true;
            updateDragActive();
          } else if (event.payload.type === 'leave') {
            tauriDragActive = false;
            updateDragActive();
          } else if (event.payload.type === 'drop') {
            tauriDragActive = false;
            updateDragActive();
            tauriDropAt = Date.now();
            for (const path of event.payload.paths) {
              void openPath(path);
            }
          }
        });
      })();
    }

    // Counts nested dragenter/dragleave pairs (they fire per DOM element the
    // cursor passes over while dragging, not just once for the window), so
    // the overlay doesn't flicker as the drag moves over child elements.
    let htmlDragDepth = 0;
    const onDragEnter = (e: DragEvent) => {
      e.preventDefault();
      htmlDragDepth++;
      htmlDragActive = true;
      updateDragActive();
    };
    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onDragLeave = (e: DragEvent) => {
      e.preventDefault();
      htmlDragDepth = Math.max(0, htmlDragDepth - 1);
      if (htmlDragDepth === 0) {
        htmlDragActive = false;
        updateDragActive();
      }
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      htmlDragDepth = 0;
      htmlDragActive = false;
      updateDragActive();
      if (Date.now() - tauriDropAt < 500) return; // already opened natively
      const files = e.dataTransfer?.files;
      if (!files) return;
      for (const file of Array.from(files)) {
        void openDroppedBrowserFile(file);
      }
    };
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      unlistenTauriDrag?.();
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  // When the window regains focus, check every open file for changes made
  // outside the app (another program editing it) — see
  // services/externalChanges.ts for the confirm/reload flow.
  useEffect(() => {
    if (backend.isTauri) {
      let unlisten: (() => void) | undefined;
      void (async () => {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        unlisten = await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
          if (focused) void checkForExternalChanges();
        });
      })();
      return () => unlisten?.();
    } else {
      const handler = () => void checkForExternalChanges();
      window.addEventListener('focus', handler);
      return () => window.removeEventListener('focus', handler);
    }
  }, []);

  // Open files requested by a second launch attempt (single-instance plugin)
  useEffect(() => {
    if (!backend.isTauri) return;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen<{ paths: string[] }>('open-files', (event) => {
        for (const path of event.payload.paths) {
          void openPath(path);
        }
      });
    })();
    return () => unlisten?.();
  }, []);

  // Disable the native right-click context menu everywhere except inside
  // the CodeMirror editor (so cut/copy/paste/spellcheck there still work).
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('.cm-editor')) return;
      e.preventDefault();
    };
    window.addEventListener('contextmenu', handler);
    return () => window.removeEventListener('contextmenu', handler);
  }, []);

  // Keyboard shortcuts + the Alt key to open/close the menu
  useEffect(() => {
    // true while Alt is held down and hasn't been combined with another key.
    let altAlone = false;

    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Alt') {
        altAlone = true;
        e.preventDefault();
        return;
      }
      altAlone = false;

      if (e.key === 'Escape') {
        if (findReplaceStore.get().open) {
          e.preventDefault();
          editorBridge.clearSearch();
          closeFindReplace();
          editorBridge.focus();
          return;
        }
        if (settingsOpenStore.get().open) {
          closeSettingsDialog();
          return;
        }
        if (menuOpenStore.get().open) closeMenu();
        return;
      }

      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;

      const { shortcuts } = settingsStore.get();
      if (matchesShortcut(e, shortcuts.newTab)) {
        e.preventDefault();
        newTab();
      } else if (matchesShortcut(e, shortcuts.openFile)) {
        e.preventDefault();
        void openFileAction();
      } else if (matchesShortcut(e, shortcuts.reopenClosed)) {
        e.preventDefault();
        void reopenClosedFile();
      } else if (matchesShortcut(e, shortcuts.saveFile)) {
        e.preventDefault();
        void saveFileAction();
      } else if (matchesShortcut(e, shortcuts.format)) {
        e.preventDefault();
        formatAction();
      } else if (matchesShortcut(e, shortcuts.foldAll)) {
        e.preventDefault();
        editorBridge.foldAll();
      } else if (matchesShortcut(e, shortcuts.unfoldAll)) {
        e.preventDefault();
        editorBridge.unfoldAll();
      } else if (matchesShortcut(e, shortcuts.find)) {
        e.preventDefault();
        toggleFind();
      } else if (matchesShortcut(e, shortcuts.replace)) {
        e.preventDefault();
        toggleReplace();
      } else if (matchesShortcut(e, shortcuts.nextTab)) {
        e.preventDefault();
        cycleTab(1);
      } else if (matchesShortcut(e, shortcuts.previousTab)) {
        e.preventDefault();
        cycleTab(-1);
      } else if (matchesShortcut(e, shortcuts.closeTab)) {
        e.preventDefault();
        const tab = activeTab();
        if (tab) closeTabAction(tab.id);
      } else if (matchesShortcut(e, shortcuts.zoomIn)) {
        e.preventDefault();
        zoomIn();
      } else if (matchesShortcut(e, shortcuts.zoomOut)) {
        e.preventDefault();
        zoomOut();
      } else if (matchesShortcut(e, shortcuts.resetZoom)) {
        e.preventDefault();
        resetFontSize();
      } else {
        const key = e.key.toLowerCase();
        if (key === 'tab') {
          // Fixed, always-on alias for nextTab/previousTab (see settings.ts).
          e.preventDefault();
          cycleTab(e.shiftKey ? -1 : 1);
        } else if (key === 'a' || key === 'e') {
          // Select-all/end-of-line-ish native behavior: only let it reach the
          // editor's own handling or a regular text field (e.g. the find/
          // replace inputs); block it everywhere else (tab bar, menu, status
          // bar, gutter/line numbers) so it can't select page chrome.
          const target = e.target as HTMLElement | null;
          if (!target?.closest('.cm-editor') && target?.tagName !== 'INPUT' && target?.tagName !== 'TEXTAREA') {
            e.preventDefault();
          }
        }
      }
    };

    const keyupHandler = (e: KeyboardEvent) => {
      if (e.key === 'Alt') {
        if (altAlone) toggleMenu();
        altAlone = false;
      }
    };

    window.addEventListener('keydown', handler);
    window.addEventListener('keyup', keyupHandler);
    return () => {
      window.removeEventListener('keydown', handler);
      window.removeEventListener('keyup', keyupHandler);
    };
  }, []);

  return (
    <div className="app">
      <TabBar
        onNewTab={newTab}
        onCloseTab={closeTabAction}
        onOpenFile={() => void openFileAction()}
      />
      <Banner />
      <EditorHost />
      <StatusBar />
      <SettingsDialog />
      <CloseConfirmDialog />
      <OnboardingDialog />
      <ExternalChangeDialog />
      {dragActive && (
        <div className="drag-overlay">
          <div className="drag-overlay-message">
            <span className="drag-overlay-icon">📂</span>
            <p>Drop file to open</p>
          </div>
        </div>
      )}
    </div>
  );
}
