import { type ReactNode } from 'react';

interface Props {
  markdown: string;
}

/**
 * Minimal Markdown renderer for CHANGELOG.md (headings, bullet lists, and
 * inline **bold**) — just enough for the About section, without pulling in
 * a full Markdown library for one static file.
 */
export default function Changelog({ markdown }: Props) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  let key = 0;

  const flushList = () => {
    if (list.length === 0) return;
    blocks.push(
      <ul key={key++}>
        {list.map((item, i) => (
          <li key={i}>{renderInline(item)}</li>
        ))}
      </ul>,
    );
    list = [];
  };

  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trimEnd();
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^[-*]\s+(.*)$/.exec(line);

    if (heading) {
      flushList();
      const [, hashes, text] = heading;
      const content = renderInline(text);
      if (hashes.length === 1) blocks.push(<h1 key={key++}>{content}</h1>);
      else if (hashes.length === 2) blocks.push(<h2 key={key++}>{content}</h2>);
      else blocks.push(<h3 key={key++}>{content}</h3>);
    } else if (bullet) {
      list.push(bullet[1]);
    } else if (line.trim() === '') {
      flushList();
    } else {
      flushList();
      blocks.push(<p key={key++}>{renderInline(line)}</p>);
    }
  }
  flushList();

  return <div className="changelog">{blocks}</div>;
}

function renderInline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? (
      <strong key={i}>{part.slice(2, -2)}</strong>
    ) : (
      part
    ),
  );
}
