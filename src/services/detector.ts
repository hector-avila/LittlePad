/**
 * Heuristic detection of the text type (cascade, see PLAN.md §5.3).
 * Only analyzes the first 64 KB to keep performance good on large logs.
 */
import * as yaml from 'js-yaml';
import type { DetectedType } from '../types';

const SAMPLE_BYTES = 64 * 1024;

const EXT_MAP: Record<string, DetectedType> = {
  json: 'json',
  json5: 'json',
  jsonc: 'json',
  xml: 'xml',
  xsd: 'xml',
  xsl: 'xml',
  svg: 'xml',
  pom: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  properties: 'ini',
  log: 'log',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'javascript',
  tsx: 'javascript',
  java: 'java',
  py: 'python',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  txt: 'plain',
};

export function detectByPath(filePath: string): DetectedType | null {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return EXT_MAP[ext] ?? null;
}

export function detect(text: string, filePath?: string | null): DetectedType {
  // 1. File extension
  if (filePath) {
    const byExt = detectByPath(filePath);
    if (byExt) return byExt;
  }

  const sample = text.slice(0, SAMPLE_BYTES);
  const trimmed = sample.trimStart();
  if (!trimmed) return 'plain';

  // 2. First non-blank character
  const first = trimmed[0];
  if (first === '{' || first === '[') {
    if (isJson(sample)) return 'json';
  }
  if (first === '<') {
    if (/^<\?xml|^<!DOCTYPE(?!\s+html)|^<[a-zA-Z_][\w.:-]*[\s>/]/.test(trimmed)) {
      return 'xml';
    }
  }

  // 3. Shebang
  const shebang = trimmed.match(/^#!.*\b(node|python\d*|java)\b/);
  if (shebang) {
    if (shebang[1] === 'node') return 'javascript';
    if (shebang[1].startsWith('python')) return 'python';
  }

  // 4. Logs: timestamps + levels across multiple lines
  if (looksLikeLog(sample)) return 'log';

  // 5. Code: weighted keywords
  const code = detectCode(sample);
  if (code) return code;

  // 6. Markdown: headings/links/lists/code blocks with enough signal
  if (looksLikeMarkdown(trimmed)) return 'markdown';

  // 7. Config file structures
  if (looksLikeToml(trimmed)) return 'toml';
  if (looksLikeIni(trimmed)) return 'ini';
  if (looksLikeYaml(sample, trimmed)) return 'yaml';

  return 'plain';
}

function isJson(sample: string): boolean {
  try {
    JSON.parse(sample);
    return true;
  } catch {
    // Might be truncated JSON (we only look at 64 KB) or have comments.
    // Loose heuristic: "key": value pair structure
    return /^[\s]*[{[][\s]*("|\d|\{|\[|true|false|null|])/.test(sample) &&
      /"[^"\n]*"\s*:/.test(sample);
  }
}

function looksLikeLog(sample: string): boolean {
  const lines = sample.split('\n', 50);
  if (lines.length < 3) return false;
  const tsRe =
    /^\s*[[(]?(\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}|\d{2}:\d{2}:\d{2}[.,]\d+|[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})/;
  const levelRe = /\b(TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|SEVERE|FATAL|CRITICAL)\b/;
  let hits = 0;
  for (const line of lines) {
    if (tsRe.test(line) || levelRe.test(line)) hits++;
  }
  return hits / lines.length > 0.4;
}

function detectCode(sample: string): DetectedType | null {
  const scores = { javascript: 0, java: 0, python: 0 };

  // JavaScript / Node.js
  if (/\b(const|let)\s+\w+\s*=/.test(sample)) scores.javascript += 2;
  if (/=>\s*[{(]|=>\s*\w/.test(sample)) scores.javascript += 2;
  if (/\brequire\s*\(\s*['"]|module\.exports|console\.log/.test(sample)) scores.javascript += 3;
  if (/\bimport\s+.+\s+from\s+['"]/.test(sample)) scores.javascript += 2;
  if (/\bfunction\s+\w+\s*\(/.test(sample)) scores.javascript += 1;

  // Java
  if (/\b(public|private|protected)\s+(static\s+)?(class|void|int|String|final)/.test(sample)) scores.java += 3;
  if (/System\.out\.print|@Override|package\s+[\w.]+;/.test(sample)) scores.java += 3;
  if (/\bimport\s+java[x]?\./.test(sample)) scores.java += 3;

  // Python
  if (/^\s*def\s+\w+\s*\(.*\)\s*:/m.test(sample)) scores.python += 3;
  if (/^\s*(from\s+[\w.]+\s+)?import\s+\w+$/m.test(sample)) scores.python += 2;
  if (/\bself\.|__init__|elif\s|print\s*\(/.test(sample)) scores.python += 2;
  if (/^\s*class\s+\w+(\(.*\))?\s*:/m.test(sample)) scores.python += 2;

  const best = (Object.entries(scores) as [DetectedType, number][]).sort(
    (a, b) => b[1] - a[1],
  )[0];
  return best[1] >= 3 ? best[0] : null;
}

function looksLikeMarkdown(trimmed: string): boolean {
  // Accumulated score: requires several signals (or one very distinctive
  // one, like a ``` code block) to avoid confusion with prose or TOML/INI
  // comments (which also use '#').
  let score = 0;
  if (/^#{1,6}\s+\S/m.test(trimmed)) score += 2; // # Heading
  if (/^-{3,}\s*$|^={3,}\s*$/m.test(trimmed)) score += 1; // setext-style heading
  if (/^```/m.test(trimmed)) score += 3; // code block
  if (/\[[^\]\n]+\]\([^)\n]+\)/.test(trimmed)) score += 2; // [text](url)
  if (/^\s*[-*+]\s+\S/m.test(trimmed)) score += 1; // bullet list
  if (/^\s*\d+\.\s+\S/m.test(trimmed)) score += 1; // numbered list
  if (/\*\*[^*\n]+\*\*|__[^_\n]+__/.test(trimmed)) score += 1; // **bold**
  if (/^>\s+\S/m.test(trimmed)) score += 1; // > blockquote
  return score >= 3;
}

function looksLikeToml(trimmed: string): boolean {
  // Traits that distinguish TOML from INI: double tables [[x]],
  // space-padded assignment (`key = value`), or typed/quoted values.
  const hasDoubleTable = /^\s*\[\[[\w.\-"']+\]\]\s*$/m.test(trimmed);
  const hasTable = /^\s*\[[\w.\-"']+\]\s*$/m.test(trimmed);
  const spacedAssign = /^\s*[\w.\-"']+ = /m.test(trimmed);
  const typedValue = /^\s*[\w.\-"']+\s*=\s*("|'|true\b|false\b|\[|\{)/m.test(trimmed);
  return hasDoubleTable || (hasTable && (spacedAssign || typedValue));
}

function looksLikeIni(trimmed: string): boolean {
  const hasSection = /^\s*\[[^\]\n]+\]\s*$/m.test(trimmed);
  const hasAssign = /^\s*[^=\n;#[]+=[^=\n]*$/m.test(trimmed);
  // .properties: plain key=value with no sections counts too
  const lines = trimmed.split('\n', 30).filter((l) => l.trim() && !/^\s*[;#]/.test(l));
  const assignRatio =
    lines.length > 0
      ? lines.filter((l) => /^[^=\s][^=]*=/.test(l.trim())).length / lines.length
      : 0;
  return (hasSection && hasAssign) || assignRatio > 0.8;
}

function looksLikeYaml(sample: string, trimmed: string): boolean {
  if (/^---\s*$/m.test(trimmed) || /^\s*- /m.test(trimmed) || /^[\w.-]+:\s/m.test(trimmed)) {
    try {
      const doc = yaml.load(sample);
      // A lone scalar ("hello") is also valid YAML; require structure
      return typeof doc === 'object' && doc !== null;
    } catch {
      // May be truncated to 64 KB: accept if the key: value pattern dominates
      const lines = trimmed.split('\n', 30).filter((l) => l.trim() && !l.trim().startsWith('#'));
      const kv = lines.filter((l) => /^\s*(- )?[\w.\-"']+:(\s|$)/.test(l)).length;
      return lines.length > 0 && kv / lines.length > 0.6;
    }
  }
  return false;
}
