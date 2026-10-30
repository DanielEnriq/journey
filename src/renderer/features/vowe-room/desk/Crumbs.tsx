import { h, Fragment, useEffect, useRef, useState } from '../journey.js';
import type { Thread, VoweRecord } from '../contracts/model.js';
import type { Tab } from '../state/ui.js';
import type { Doing } from '../state/agent-doing.js';
import { Icon } from '../../../ui/icons.js';
import type { DeskAct } from './Desk.js';
import type { Crumbs } from './Focus.js';
import { SECTION, liveDecisions, threadTitle } from './focus-pick.js';

// Full screen's band: Room / Section / Item, each a way somewhere. The room goes back to the canvas; the section
// and the item open a menu of their siblings (the other sections; the section's other threads, decisions or
// work). After them, the agent's trail: what it's doing, and the thread it's in when that's elsewhere.

interface Item { id: string; label: string; key?: string }

function Menu({ label, cls, items, current, pick, tip }: { label: string; cls: string; items: Item[]; current: string | null; pick(id: string): void; tip?: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    // Esc closes the menu, not full screen: caught on the way down, before the room's keys hear it.
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc, true);
    return () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', esc, true); };
  }, [open]);
  // Arrows walk the menu, from the crumb too (opening it).
  const move = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if (!open) { e.preventDefault(); setOpen(true); return; }
    e.preventDefault();
    const all = [...(box.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
    const i = all.indexOf(document.activeElement as HTMLElement);
    all[(i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus();
  };
  return (
    <span class={'nx-crumbwrap ' + cls} ref={box} onKeyDown={move}>
      <button type="button" class={'nx-fo-crumb ' + cls} aria-haspopup="menu" aria-expanded={open} data-tip={open ? undefined : tip} onClick={() => setOpen(!open)}>{label}</button>
      {open ? (
        <div class="nx-crumbmenu" role="menu">
          {items.length ? items.map((it) => (
            <button key={it.id} type="button" role="menuitemradio" aria-checked={it.id === current} class="nx-crumbmenu-i" onClick={() => { setOpen(false); pick(it.id); }}>
              <span>{it.label}</span>{it.key ? <kbd>{it.key}</kbd> : null}<span class="nx-crumbmenu-ck">{it.id === current ? <Icon name="check" size={14} /> : null}</span>
            </button>
          )) : <span class="nx-crumbmenu-none">Nothing here yet</span>}
        </div>
      ) : null}
    </span>
  );
}

function siblings(rec: VoweRecord, tab: Tab): Item[] {
  if (tab === 'discuss') return [...rec.threads].reverse().filter((t) => t.status === 'open').map((t) => ({ id: t.id, label: threadTitle(t) }));
  if (tab === 'decide') return liveDecisions(rec).map((d) => ({ id: d.id, label: d.title }));
  return rec.work.filter((w) => w.state !== 'closed').map((w) => ({ id: w.id, label: w.title }));
}

export function FocusCrumbs({ room, crumbs, rec, act, back, agent }: {
  room: string; crumbs: Crumbs; rec: VoweRecord; act: DeskAct; back(): void;
  agent: { name: string; doing: Doing; away: Thread | null } | null;
}) {
  const open = (id: string) => (crumbs.tab === 'discuss' ? act.thread(id) : crumbs.tab === 'decide' ? act.inspect({ kind: 'decision', id }) : act.inspect({ kind: 'work', id, section: 'plan' }));
  const sections: Item[] = (['discuss', 'decide', 'work'] as Tab[]).map((t, i) => ({ id: t, label: SECTION[t], key: `⌥${i + 1}` }));
  const d = agent?.doing;
  return (
    <nav class="nx-fo-crumbs" aria-label="Where you are">
      <button type="button" class="nx-fo-crumb" data-tip="Back to the canvas · Esc" onClick={back}>{room}</button>
      <i aria-hidden="true">/</i>
      <Menu label={crumbs.section} cls="is-sec" items={sections} current={crumbs.tab} pick={(t) => act.fsec(t as Tab)} />
      {crumbs.item ? <><i aria-hidden="true">/</i><Menu label={crumbs.item} cls="is-item" items={siblings(rec, crumbs.tab)} current={crumbs.current} pick={open} /></> : null}
      {agent && d ? (
        <span class="nx-fo-agent" role="status">
          <i class="nx-agentmark" aria-hidden="true"></i><b>{agent.name}</b>
          {agent.away ? <><i aria-hidden="true">›</i><button type="button" class="nx-fo-agent-at" data-tip="Open the thread" onClick={() => act.thread(agent.away!.id)}>{threadTitle(agent.away)}</button></> : null}
          <i aria-hidden="true">›</i>
          <span class={'nx-fo-agent-do' + (d.parts ? ' lights' : '')} data-tip={d.tip}
            onPointerEnter={d.parts ? () => act.light(d.parts!) : undefined} onPointerLeave={d.parts ? () => act.light(null) : undefined}>
            <span>{d.verb}</span>{d.what ? <span class="nx-fo-agent-on">{d.what}</span> : null}
          </span>
        </span>
      ) : null}
    </nav>
  );
}
