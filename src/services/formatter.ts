/** Pretty-printers per text type (PLAN.md §5.4). */
import * as yaml from 'js-yaml';
import xmlFormat from 'xml-formatter';
import type { DetectedType } from '../types';

export type FormatResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

const FORMATTABLE: DetectedType[] = ['json', 'xml', 'yaml'];

export function canFormat(lang: DetectedType): boolean {
  return FORMATTABLE.includes(lang);
}

export function formatText(
  text: string,
  lang: DetectedType,
  indent = 2,
): FormatResult {
  try {
    switch (lang) {
      case 'json': {
        const obj = JSON.parse(text);
        return { ok: true, text: JSON.stringify(obj, null, indent) + '\n' };
      }
      case 'xml': {
        const out = xmlFormat(text, {
          indentation: ' '.repeat(indent),
          collapseContent: true,
          lineSeparator: '\n',
        });
        return { ok: true, text: out + '\n' };
      }
      case 'yaml': {
        const docs: unknown[] = [];
        yaml.loadAll(text, (d) => docs.push(d));
        const out = docs
          .map((d) => yaml.dump(d, { indent, lineWidth: 120, noRefs: true }))
          .join('---\n');
        return { ok: true, text: out };
      }
      default:
        return { ok: false, error: `Formatting is not supported for ${lang}` };
    }
  } catch (e) {
    return { ok: false, error: parseError(e, lang) };
  }
}

function parseError(e: unknown, lang: DetectedType): string {
  const msg = e instanceof Error ? e.message : String(e);
  // V8's JSON.parse: "... at position 123 (line 4 column 5)"
  const m = msg.match(/line (\d+)[^\d]+(?:column )?(\d+)/i);
  if (m) return `${lang.toUpperCase()} syntax error at line ${m[1]}, column ${m[2]}: ${msg}`;
  return `${lang.toUpperCase()} syntax error: ${msg}`;
}
