import { h, Fragment, useState, type ComponentChildren } from '../journey.js';
import { highlight, isPlain, parseBlocks, parseInline, type Block, type Inline } from '../state/markdown.js';

// A message's Markdown, drawn as elements (never as HTML). Plain words go back to the caller, which renders
// @mentions and canvas references in them. A one-liner with no markup stays a line.

type Words = (text: string, key: string) => ComponentChildren;

function inline(nodes: Inline[], words: Words, key: string): ComponentChildren[] {
  return nodes.map((n, i) => {
    const k = `${key}.${i}`;
    if (n.kind === 'text') return <Fragment key={k}>{words(n.text, k)}</Fragment>;
    if (n.kind === 'code') return <code key={k} class="nx-ic">{n.text}</code>;
    const Tag = n.kind === 'b' ? 'strong' : 'em';
    return <Tag key={k}>{inline(n.children, words, k)}</Tag>;
  });
}

/** A paragraph's single line breaks stay line breaks, as people type them. */
function lines(text: string, words: Words, key: string): ComponentChildren[] {
  return text.split('\n').flatMap((line, i) => [i ? <br key={`${key}br${i}`} /> : null, ...inline(parseInline(line), words, `${key}l${i}`)]);
}

function Code({ b }: { b: Extract<Block, { kind: 'code' }> }) {
  const [copied, setCopied] = useState(false);
  const rows = b.code.split('\n');
  const to = b.from != null ? b.from + rows.length - 1 : null;
  const copy = (e: Event) => {
    e.preventDefault(); e.stopPropagation();
    void navigator.clipboard.writeText(b.code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); });
  };
  const tokens = highlight(b.code, b.lang);
  // Split the coloured tokens back into lines, so each line can carry its number.
  const out: ComponentChildren[][] = [[]];
  tokens.forEach((t, i) => t.text.split('\n').forEach((part, j) => {
    if (j) out.push([]);
    if (part) out[out.length - 1].push(t.kind === 'p' ? part : <span key={`${i}.${j}`} class={`nx-tk-${t.kind}`}>{part}</span>);
  }));
  return (
    <div class="nx-cb">
      <div class="nx-cb-h">
        <span class="nx-cb-i" aria-hidden="true">&lt;/&gt;</span>
        {b.path ? <span class="nx-cb-path">{b.path}</span> : b.lang ? <span class="nx-cb-lang">{b.lang}</span> : null}
        {b.from != null ? <span class="nx-cb-range">{b.from === to ? b.from : `${b.from}–${to}`}</span> : null}
        <span class="nx-cb-copy" role="button" tabIndex={0} onClick={copy} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && copy(e)}>{copied ? 'Copied' : 'Copy'}</span>
      </div>
      <pre class="nx-cb-pre">{out.map((row, i) => (
        <span key={i} class="nx-cb-row">{b.from != null ? <span class="nx-cb-ln" aria-hidden="true">{b.from + i}</span> : null}{row.length ? row : ' '}{'\n'}</span>
      ))}</pre>
    </div>
  );
}

export function Markdown({ text, words }: { text: string; words: Words }) {
  if (isPlain(text)) return <>{words(text, 'w')}</>;
  return (
    <span class="nx-md">
      {parseBlocks(text).map((b, i) => {
        const k = `b${i}`;
        if (b.kind === 'p') return <span key={k} class="nx-md-p">{lines(b.text, words, k)}</span>;
        if (b.kind === 'code') return <Code key={k} b={b} />;
        const List = b.ordered ? 'ol' : 'ul';
        return <List key={k} class="nx-md-list" style={b.ordered && b.start !== 1 ? `--start:${b.start}` : undefined}>{b.items.map((it, j) => <li key={j}>{lines(it, words, `${k}i${j}`)}</li>)}</List>;
      })}
    </span>
  );
}
