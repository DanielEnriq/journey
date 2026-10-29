import { h, type ComponentChildren } from '../../../vendor/preact.js';
import { useState } from '../../../vendor/preact-hooks.js';
import { Icon } from '../../../ui/icons.js';

// The room's inspector as cards floating on its plane, the way Claude Code stacks its own: each a raised
// surface with a small title, a disclosure triangle, and a few words on the right that say what's inside
// without opening it. Folded, a card is one line. Which cards you folded is kept on this machine.

const FOLDED_KEY = 'vowe.room.cards.folded';

function readFolded(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(FOLDED_KEY) ?? '{}') as Record<string, boolean>; } catch { return {}; }
}

export function Card({ id, title, summary, needs, closedByDefault = false, children }: {
  /** Names the card for remembering whether it's folded. */
  id: string;
  title: string;
  /** What's inside, in a few words, on the header's right: shown open or folded. */
  summary?: ComponentChildren;
  /** Something inside waits on you: the summary takes the signal colour. */
  needs?: boolean;
  closedByDefault?: boolean;
  children: ComponentChildren;
}) {
  const [open, setOpen] = useState(() => !(readFolded()[id] ?? closedByDefault));
  const toggle = () => {
    try { localStorage.setItem(FOLDED_KEY, JSON.stringify({ ...readFolded(), [id]: open })); } catch { /* lasts this session */ }
    setOpen(!open);
  };
  const body = `icard-${id}`;
  return (
    <section class={'icard' + (open ? ' is-open' : '')} aria-label={title}>
      <button type="button" class="icard-h" aria-expanded={open} aria-controls={body} onClick={toggle}>
        <span class="icard-t">{title}</span>
        <Icon name="chevron-r" size={14} />
        {summary ? <span class={'icard-s' + (needs ? ' is-needs' : '')}>{summary}</span> : null}
      </button>
      {open ? <div id={body} class="icard-b">{children}</div> : null}
    </section>
  );
}
