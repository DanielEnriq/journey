import { h, Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentChildren } from '../journey.js';
import { createContext } from '../../../vendor/preact.js';
import { useContext } from '../../../vendor/preact-hooks.js';
import { AGENT, type Decision } from '../contracts/model.js';
import { useNames, usePresence } from '../state/directory.js';
import { encodeMentions, MENTION, queryAt, rank, type MentionItem, type MentionKind } from '../state/mentions.js';
import { Icon } from '../../../ui/icons.js';
import type { DeskProps } from './Desk.js';
import { Who } from './Desk.js';

// The @ menu every composer in the Desk shares: the room's people (the agent among them, marked as one), the
// coding sessions attached to it, its decisions, and the parts on the canvas. Arrows move, Enter or Tab picks,
// Esc closes. A pick shows as "@Label" in the field and is sent as a token (state/mentions.ts).
// The field grows with what's written, up to a few lines, then scrolls. Enter sends, Shift-Enter starts a new line.

/** What the Desk can't read from the record: the room's attached sessions and the canvas's parts. */
export const MentionSources = createContext<{ sessions: MentionItem[]; parts: MentionItem[] }>({ sessions: [], parts: [] });

const SECTIONS: { kind: MentionKind[]; title: string }[] = [
  { kind: ['agent', 'person'], title: 'People' },
  { kind: ['session'], title: 'Sessions' },
  { kind: ['decision'], title: 'Decisions' },
  { kind: ['part'], title: 'On the canvas' },
];

const DECISION_ORDER: Decision['state'][] = ['review', 'draft', 'suggested', 'agreed'];
const PRESENCE_ORDER = { call: 0, room: 1, away: 2 } as const;

function useItems(p: DeskProps): MentionItem[] {
  const { nameOf, agentName } = useNames();
  const presence = usePresence();
  const src = useContext(MentionSources);
  const { rec, me } = p;
  {
    const people: MentionItem[] = rec.members.filter((m) => m.who !== me && m.who !== AGENT)
      .map((m) => ({ kind: 'person' as const, id: m.who, label: nameOf(m.who), state: presence[m.who] ?? 'away' }))
      .sort((a, b) => PRESENCE_ORDER[a.state as keyof typeof PRESENCE_ORDER] - PRESENCE_ORDER[b.state as keyof typeof PRESENCE_ORDER]);
    const decisions: MentionItem[] = rec.decisions.filter((d) => DECISION_ORDER.includes(d.state))
      .sort((a, b) => DECISION_ORDER.indexOf(a.state) - DECISION_ORDER.indexOf(b.state))
      .map((d) => ({ kind: 'decision', id: d.id, label: d.title, key: `v${d.version}`, state: d.state }));
    return [
      ...(rec.vowe ? [{ kind: 'agent' as const, id: AGENT, label: agentName(), also: 'agent ai' }] : []),
      ...people, ...src.sessions, ...decisions, ...src.parts,
    ];
  }
}

/** A row's mark: a face, the agent's orb, or what state the thing is in. */
function Mark({ m }: { m: MentionItem }) {
  if (m.kind === 'agent') return <i class="nx-agentmark" aria-hidden="true"></i>;
  if (m.kind === 'person') return <span class={'nx-mface' + (m.state === 'call' || m.state === 'room' ? ' here' : '')}><Who id={m.id} size={18} /></span>;
  if (m.kind === 'part') return <svg class="nx-mglyph" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="9" rx="2.2" /></svg>;
  return <i class={`nx-mstate ${m.kind}-${m.state ?? 'none'}`} aria-hidden="true"></i>;
}

const STATE_WORDS: Record<string, string> = {
  call: 'on the call', room: 'here', 'session-active': 'running', 'session-attention': 'needs you', 'session-waiting': 'waiting on someone',
  'session-completed': 'done', 'decision-review': 'in review', 'decision-draft': 'draft', 'decision-suggested': 'suggested', 'decision-agreed': 'agreed',
};
const stateWords = (m: MentionItem) => STATE_WORDS[m.kind === 'person' ? m.state ?? '' : `${m.kind}-${m.state}`];

export function MentionField({ value, onInput, onSubmit, p, placeholder, label, autoFocus, disabled, onKeyDown }: {
  value: string;
  onInput(v: string): void;
  /** Enter (not Shift-Enter) with the menu closed: the text with picked mentions as tokens. */
  onSubmit(text: string): void;
  p: DeskProps;
  placeholder?: string;
  label?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  /** Keys the field doesn't use itself (Escape to cancel), when the menu is closed. */
  onKeyDown?(e: KeyboardEvent): void;
}) {
  const items = useItems(p);
  const input = useRef<HTMLTextAreaElement>(null);
  const picked = useRef<MentionItem[]>([]);
  const [caret, setCaret] = useState(0);
  const [closed, setClosed] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  useEffect(() => { if (!value) picked.current = []; }, [value]);
  useEffect(() => { if (autoFocus) input.current?.focus(); }, []);
  // Fit the field to its text; the max-height in CSS decides when it scrolls instead.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  const at = disabled ? null : queryAt(value, caret);
  const open = !!at && closed !== at.start;
  const groups = useMemo(() => {
    if (!at) return [];
    return SECTIONS.map((s) => ({ title: s.title, items: rank(items.filter((m) => s.kind.includes(m.kind)), at.q, at.q ? 4 : s.kind.includes('person') ? 5 : 3) })).filter((g) => g.items.length);
  }, [items, at?.q, at?.start]);
  const flat = groups.flatMap((g) => g.items);
  const cur = flat[Math.min(active, flat.length - 1)];
  // Pointing at a part in the menu lights it on the canvas, the way hovering a reference does.
  useEffect(() => { if (!open || cur?.kind !== 'part') return; p.act.light([cur.id]); return () => p.act.light(null); }, [open, cur?.kind, cur?.id]);

  const pick = (m: MentionItem) => {
    if (!at) return;
    const next = `${value.slice(0, at.start)}@${m.label} ${value.slice(caret)}`;
    picked.current = [...picked.current, m];
    onInput(next);
    const pos = at.start + m.label.length + 2;
    setCaret(pos);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(pos, pos); });
  };

  const key = (e: KeyboardEvent) => {
    if (open && (flat.length || e.key === 'Escape')) {
      if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) { e.preventDefault(); setActive((i) => (i + 1) % flat.length); return; }
      if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) { e.preventDefault(); setActive((i) => (i - 1 + flat.length) % flat.length); return; }
      if ((e.key === 'Enter' || e.key === 'Tab') && cur) { e.preventDefault(); pick(cur); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setClosed(at!.start); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && value.trim()) { e.preventDefault(); onSubmit(encodeMentions(value.trim(), picked.current)); return; }
    onKeyDown?.(e);
  };
  const sync = () => setCaret(input.current?.selectionStart ?? 0);
  const listId = useMemo(() => `nx-m-${Math.random().toString(36).slice(2, 8)}`, []);

  return (
    <>
      <textarea ref={input} rows={1} placeholder={placeholder} aria-label={label} value={value} disabled={disabled}
        role="combobox" aria-expanded={open} aria-controls={open ? listId : undefined} aria-autocomplete="list"
        aria-activedescendant={open && cur ? `${listId}-${flat.indexOf(cur)}` : undefined}
        onInput={(e) => { onInput(e.currentTarget.value); setCaret(e.currentTarget.selectionStart ?? 0); setClosed(null); setActive(0); }}
        onKeyDown={key} onKeyUp={(e) => { if (/^(Arrow(Left|Right|Up|Down)|Home|End)$/.test(e.key)) sync(); }} onClick={sync}
        onBlur={() => setClosed(at?.start ?? null)} onFocus={() => { sync(); setClosed(null); }} />
      {open ? <MentionMenu id={listId} anchor={input} groups={groups} flat={flat} cur={cur} setActive={setActive} pick={pick}
        empty={at!.q ? { q: at!.q, invite: () => p.act.invite() } : null} /> : null}
    </>
  );
}

function MentionMenu({ id, anchor, groups, flat, cur, setActive, pick, empty }: {
  id: string; anchor: { current: HTMLTextAreaElement | null }; groups: { title: string; items: MentionItem[] }[]; flat: MentionItem[]; cur?: MentionItem;
  setActive(i: number): void; pick(m: MentionItem): void; empty: { q: string; invite(): void } | null;
}) {
  const box = useRef<HTMLDivElement>(null);
  // Fixed under the field (over it when there's no room below), measured against where it actually landed,
  // so a transformed ancestor can't throw it off.
  useLayoutEffect(() => {
    const el = box.current, a = anchor.current?.closest('label') ?? anchor.current;
    if (!el || !a) return;
    const r = a.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight;
    const w = Math.min(Math.max(r.width, 320), vw - 16);
    const left = Math.max(8, Math.min(r.left, vw - w - 8));
    const below = vh - r.bottom - 8, above = r.top - 8;
    const up = below < Math.min(el.scrollHeight, 360) && above > below;
    el.style.width = `${w}px`;
    el.style.maxHeight = `${Math.min(360, up ? above : below)}px`;
    el.style.left = `${left}px`;
    el.style.top = up ? `${r.top - 4 - Math.min(el.scrollHeight, 360, above)}px` : `${r.bottom + 4}px`;
    const got = el.getBoundingClientRect();
    el.style.left = `${left + (left - got.left)}px`;
    el.style.top = `${parseFloat(el.style.top) + (parseFloat(el.style.top) - got.top)}px`;
  });
  useEffect(() => { box.current?.querySelector('.on')?.scrollIntoView({ block: 'nearest' }); }, [cur]);
  return (
    <div ref={box} id={id} class="nx-mmenu" role="listbox" onMouseDown={(e) => e.preventDefault()}>
      {groups.map((g) => (
        <div key={g.title} class="nx-mgroup" role="group" aria-label={g.title}>
          <span class="nx-mhead" aria-hidden="true">{g.title}</span>
          {g.items.map((m) => {
            const i = flat.indexOf(m), words = stateWords(m);
            return (
              <div key={`${m.kind}:${m.id}`} id={`${id}-${i}`} role="option" aria-selected={m === cur} class={'nx-mrow' + (m === cur ? ' on' : '')}
                title={words} onMouseMove={() => m !== cur && setActive(i)} onClick={() => pick(m)}>
                <Mark m={m} />
                {m.key ? <span class="nx-mkey">{m.key}</span> : null}
                <span class="nx-mlabel">{m.label}</span>
                {m.kind === 'agent' ? <span class="nx-mtag">Agent</span> : null}
              </div>
            );
          })}
        </div>
      ))}
      {!flat.length && empty ? (
        <div class="nx-mrow on" role="option" aria-selected="true" onClick={empty.invite}>
          <Icon name="plus" size={14} /><span class="nx-mlabel">Invite “{empty.q}” to the room</span>
        </div>
      ) : null}
    </div>
  );
}

/** A mention in a message: the name, quiet but distinct; a part lights on the canvas, a decision opens. */
export function MentionToken({ kind, id, label, p }: { kind: MentionKind; id: string; label: string; p?: Pick<DeskProps, 'act'> }) {
  const act = p?.act;
  if (kind === 'part' && act) return <span class="nx-mtok" onPointerEnter={() => act.light([id])} onPointerLeave={() => act.light(null)}>@{label}</span>;
  if (kind === 'decision' && act) return <button type="button" class="nx-mtok" onClick={() => act.inspect({ kind: 'decision', id })}>@{label}</button>;
  return <span class={'nx-mtok' + (kind === 'agent' ? ' agent' : '')}>@{label}</span>;
}

/** Text with its mention tokens drawn as mentions; everything between goes through `rest`. */
export function withTokens(text: string, rest: (s: string, key: number) => ComponentChildren, act?: DeskProps['act']): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  let last = 0, k = 0;
  for (const m of text.matchAll(MENTION)) {
    out.push(rest(text.slice(last, m.index), k++));
    out.push(<MentionToken key={`m${k++}`} label={m[1]} kind={m[2] as MentionKind} id={m[3]} p={act && { act }} />);
    last = m.index! + m[0].length;
  }
  out.push(rest(text.slice(last), k));
  return out;
}
