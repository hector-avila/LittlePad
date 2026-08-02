/** Maps a detected type to its CodeMirror 6 language extension. */
import type { Extension } from '@codemirror/state';
import { json } from '@codemirror/lang-json';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import { javascript } from '@codemirror/lang-javascript';
import { java } from '@codemirror/lang-java';
import { python } from '@codemirror/lang-python';
import { markdown } from '@codemirror/lang-markdown';
import { StreamLanguage } from '@codemirror/language';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import type { DetectedType } from '../types';
import { logHighlighter } from './logHighlighter';

export function languageExtension(lang: DetectedType): Extension {
  switch (lang) {
    case 'json':
      return json();
    case 'xml':
      return xml();
    case 'yaml':
      return yaml();
    case 'javascript':
      return javascript({ typescript: true });
    case 'java':
      return java();
    case 'python':
      return python();
    case 'markdown':
      return markdown();
    case 'toml':
      return StreamLanguage.define(toml);
    case 'ini':
      return StreamLanguage.define(properties);
    case 'log':
      return logHighlighter();
    case 'plain':
    default:
      return [];
  }
}
