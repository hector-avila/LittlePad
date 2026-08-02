/**
 * Lightweight highlighter for logs: colors timestamps, levels, IPs, and
 * strings, only within the visible ranges (O(viewport) performance, not
 * O(file)).
 */
import {
  Decoration,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  type DecorationSet,
} from '@codemirror/view';
import { RangeSetBuilder, type Extension } from '@codemirror/state';

const RULES: Array<[RegExp, string]> = [
  [
    /\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\b\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g,
    'cm-log-date',
  ],
  [/\b(ERROR|SEVERE|FATAL|CRITICAL)\b/g, 'cm-log-error'],
  [/\b(WARN|WARNING)\b/g, 'cm-log-warn'],
  [/\b(INFO|NOTICE)\b/g, 'cm-log-info'],
  [/\b(DEBUG|TRACE|FINE|FINER|FINEST)\b/g, 'cm-log-debug'],
  [/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g, 'cm-log-ip'],
  [/"[^"\n]*"|'[^'\n]*'/g, 'cm-log-string'],
];

function buildDecorations(view: EditorView): DecorationSet {
  const matches: Array<{ from: number; to: number; cls: string }> = [];
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    for (const [re, cls] of RULES) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (m[0].length === 0) break;
        matches.push({ from: from + m.index, to: from + m.index + m[0].length, cls });
      }
    }
  }
  matches.sort((a, b) => a.from - b.from || a.to - b.to);

  const builder = new RangeSetBuilder<Decoration>();
  let lastEnd = -1;
  for (const { from, to, cls } of matches) {
    if (from < lastEnd) continue; // no overlaps (first matching rule wins)
    builder.add(from, to, Decoration.mark({ class: cls }));
    lastEnd = to;
  }
  return builder.finish();
}

const plugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) {
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

const theme = EditorView.baseTheme({
  '.cm-log-date': { color: '#7d8799' },
  '.cm-log-error': { color: '#ff5c57', fontWeight: 'bold' },
  '.cm-log-warn': { color: '#e5c07b', fontWeight: 'bold' },
  '.cm-log-info': { color: '#61afef' },
  '.cm-log-debug': { color: '#98c379' },
  '.cm-log-ip': { color: '#c678dd' },
  '.cm-log-string': { color: '#98c379' },
});

export function logHighlighter(): Extension {
  return [plugin, theme];
}
