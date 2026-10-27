import { Fragment, h, type ComponentChildren } from '../../../vendor/preact.js';
import { useEffect, useState } from '../../../vendor/preact-hooks.js';
import { Icon } from '../../../ui/icons.js';

// Code-shaped text (a branch, a commit, an issue number, a file path) is set in mono and copies on click.
// Everything else stays in the reading face: mono is a signal that this is something you'd paste elsewhere.

/** A mono chip that copies `text`; a check stands in for the copy icon for a moment after. */
export function Copy({ text, children, label }: { text: string; children?: ComponentChildren; label?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1200);
    return () => clearTimeout(t);
  }, [done]);
  const copy = (e: MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(() => setDone(true), () => {});
  };
  return (
    <button class={'cp' + (done ? ' done' : '')} type="button" onClick={copy} aria-label={`Copy ${label ?? text}`} data-tip={done ? 'Copied' : 'Copy'}>
      <span class="cpt">{children ?? text}</span>
      <Icon name={done ? 'check' : 'copy'} size={14} />
    </button>
  );
}

// An issue or PR number, a commit hash (7–40 hex characters with at least one digit and one letter), or a path
// that ends in a source file's extension.
const CODE = /(#\d+\b|\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b|(?:[\w.~-]+\/)*[\w.-]+\.(?:tsx?|jsx?|mjs|cjs|css|json|md|sql|py|go|rs|rb|java|kt|swift|ya?ml|toml|sh)\b)/g;

/** `text` with its code-shaped parts set as copyable chips. */
export function CodeText({ text }: { text: string }) {
  const parts = text.split(CODE);
  if (parts.length === 1) return <>{text}</>;
  return <>{parts.map((p, i) => (i % 2 ? <Copy key={i} text={p} /> : p))}</>;
}
