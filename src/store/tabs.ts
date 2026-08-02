import type { DetectedType, SessionIndex, Tab } from '../types';
import { createStore } from './createStore';

export interface TabsState {
  tabs: Tab[];
  activeId: string | null;
}

export const tabsStore = createStore<TabsState>({ tabs: [], activeId: null });

/**
 * Initial content of each tab (restored from session or from a file).
 * EditorHost consumes it when creating the EditorState, then removes it.
 */
export const initialContents = new Map<string, string>();

export function getTab(id: string): Tab | undefined {
  return tabsStore.get().tabs.find((t) => t.id === id);
}

export function activeTab(): Tab | undefined {
  const { tabs, activeId } = tabsStore.get();
  return tabs.find((t) => t.id === activeId);
}

let untitledCounter = 0;

export function nextUntitledTitle(): string {
  const existing = new Set(tabsStore.get().tabs.map((t) => t.title));
  let title: string;
  do {
    untitledCounter += 1;
    title = `untitled ${untitledCounter}`;
  } while (existing.has(title));
  return title;
}

export function addTab(partial: Partial<Tab>, content = ''): Tab {
  const tab: Tab = {
    id: partial.id ?? crypto.randomUUID(),
    title: partial.title ?? nextUntitledTitle(),
    filePath: partial.filePath ?? null,
    language: partial.language ?? 'plain',
    languageManual: partial.languageManual ?? false,
    dirty: partial.dirty ?? false,
    encoding: partial.encoding ?? 'utf-8',
    cursor: partial.cursor ?? 0,
  };
  initialContents.set(tab.id, content);
  tabsStore.set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }));
  return tab;
}

export function updateTab(id: string, patch: Partial<Tab>): void {
  tabsStore.set((s) => ({
    ...s,
    tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)),
  }));
}

export function setActive(id: string): void {
  tabsStore.set((s) => ({ ...s, activeId: id }));
}

export function removeTab(id: string): void {
  initialContents.delete(id);
  tabsStore.set((s) => {
    const idx = s.tabs.findIndex((t) => t.id === id);
    const tabs = s.tabs.filter((t) => t.id !== id);
    let activeId = s.activeId;
    if (activeId === id) {
      activeId = tabs[Math.min(idx, tabs.length - 1)]?.id ?? null;
    }
    return { tabs, activeId };
  });
}

export function setLanguage(
  id: string,
  language: DetectedType,
  manual: boolean,
): void {
  updateTab(id, { language, languageManual: manual });
}

export function sessionIndex(): SessionIndex {
  const { tabs, activeId } = tabsStore.get();
  return { tabOrder: tabs.map((t) => t.id), activeTabId: activeId };
}
