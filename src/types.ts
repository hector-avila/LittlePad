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

export interface Tab {
  id: string;
  title: string;
  filePath: string | null;
  language: DetectedType;
  languageManual: boolean;
  dirty: boolean;
  encoding: 'utf-8' | 'latin1';
  cursor: number;
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
}

export interface SessionTab {
  meta: TabMeta;
  content: string;
}

export interface SessionData {
  index: SessionIndex | null;
  tabs: SessionTab[];
}
