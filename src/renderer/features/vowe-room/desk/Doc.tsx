import { h, Fragment, useEffect, useRef, useState, type ComponentChildren } from '../journey.js';
import { AGENT, type By } from '../contracts/model.js';
import { Who, type DeskProps } from './Desk.js';
import { useNames } from '../state/directory.js';
import { mayWrite } from '../state/permissions.js';

// Document primitives shared by the plan and the decision: prose that renders code, paths and canvas
// references inline; quiet attribution; calm proposed edits; and the layout that is the same artifact at
// three depths (the expanded Desk stacks it, Focus gives it an outline and a margin).

const PATH = /(`[^`]+`|\[[^|\]]+\|[^\]]+\]|\b(?:[\w-]+\/)+[\w.*-]+(?::\d+(?:[–-]\d+)?)?)/g;

/** Prose with `code`, file paths and [label|part] canvas references rendered inline. */
export function Rich({ text, light }: { text: string; light?(parts: string[] | null): void }) {
  const out: (string | h.JSX.Element)[] = [];
  let last = 0, m: RegExpExecArray | null, k = 0;
  PATH.lastIndex = 0;
  while ((m = PATH.exec(text))) {
    out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('`')) out.push(<code key={k++} class="nx-ic">{t.slice(1, -1)}</code>);
    else if (t.startsWith('[')) { const [, label, id] = /\[([^|\]]+)\|([^\]]+)\]/.exec(t)!; out.push(<span key={k++} class="nx-cref" title="On the canvas" onPointerEnter={() => light?.([id])} onPointerLeave={() => light?.(null)}>{label}</span>); }
    else out.push(<code key={k++} class="nx-ic nx-path">{t}</code>);
    last = m.index + t.length;
  }
  out.push(text.slice(last));
  return <>{out}</>;
}

/** Who wrote something: a person's name, or the agent marked as such. Quiet, in the margin. */
export function By_({ by, edited }: { by: By; edited?: string }) {
  const { nameOf, agentName } = useNames();
  const agent = by.who === AGENT;
  return (
    <span class={'nx-by' + (agent ? ' agent' : '')} title={agent ? `${agentName()} is an AI agent in this room` : ''}>
      {agent ? <i class="nx-agentmark" aria-hidden="true"></i> : null}
      {agent ? `${agentName()}${by.how === 'inferred' ? ' · inferred' : ''}` : nameOf(by.who)}
      {edited && edited !== by.who ? ` · ${nameOf(edited)} edited` : by.how === 'edited' && !agent ? ' · edited' : ''}
    </span>
  );
}

/** A proposed edit, inline and calm: a margin rule, who suggested it and why, Accept and Reject as words. */
export function Proposed({ by, why, state, decidedBy, me, can, onAccept, onReject, children }: {
  by: string; why?: string; state: 'open' | 'accepted' | 'rejected'; decidedBy?: string; me: string; can: boolean; onAccept(): void; onReject(): void; children?: ComponentChildren;
}) {
  const { nameOf } = useNames();
  return (
    <div class={'nx-prop ' + state}>
      {children}
      <span class="nx-prop-meta">
        <span class={'nx-by' + (by === AGENT ? ' agent' : '')}>{by === AGENT ? <i class="nx-agentmark" aria-hidden="true"></i> : null}Suggested by {nameOf(by)}</span>
        {why ? <span class="nx-prop-why">{why}</span> : null}
        {state === 'open' ? (can ? <span class="nx-prop-a"><button type="button" class="nx-textbtn strong" onClick={onAccept}>Accept</button><button type="button" class="nx-textbtn" onClick={onReject}>Reject</button></span> : null)
          : <span class="nx-prop-d">{state === 'accepted' ? 'Accepted' : 'Rejected'} by {decidedBy === me ? 'you' : nameOf(decidedBy ?? '')}</span>}
      </span>
    </div>
  );
}

/** Show the difference between two strings, word by word, or as a replaced line when little survives. */
export function Diff({ a, b, diff }: { a: string; b: string; diff: (a: string, b: string) => { t: string; k: 'same' | 'del' | 'add' }[] }) {
  const d = diff(a, b);
  const same = d.filter((x) => x.k === 'same').reduce((n, x) => n + x.t.trim().split(/\s+/).filter(Boolean).length, 0);
  if (same / Math.max(1, b.split(/\s+/).length) < 0.5) return <span class="nx-dif block"><del>{a}</del><ins>{b}</ins></span>;
  return <span class="nx-dif">{d.map((x, k) => x.k === 'same' ? <span key={k}>{x.t}</span> : x.k === 'del' ? <del key={k}>{x.t}</del> : <ins key={k}>{x.t}</ins>)}</span>;
}

/** The same document at three depths: stacked in the expanded Desk, outline + page + margin in Focus. */
export function DocLayout({ p, outline, rail, children, docKey }: { p: DeskProps; outline: { id: string; label: string; note?: string }[]; rail: ComponentChildren; children: ComponentChildren; docKey: string }) {
  // In the full-screen workspace the rail and list take the left; the document keeps its page and margin.
  const focus = p.depth === 'focus' && !p.shell;
  const page = useRef<HTMLDivElement>(null);
  const go = (id: string) => { const el = page.current?.querySelector(`[data-sec="${id}"]`) as HTMLElement | null; el?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); };
  return (
    <div class={'nx-docl' + (focus ? ' focus' : '') + (p.shell ? ' shell' : '') + (p.narrow && !focus && !p.shell ? ' narrow' : '')}>
      {focus ? (
        <nav class="nx-outline" aria-label="Sections">
          {outline.map((o) => <button key={o.id} type="button" onClick={() => go(o.id)}><span>{o.label}</span>{o.note ? <em>{o.note}</em> : null}</button>)}
          <span class="nx-keys"><b>J</b><b>K</b> move · <b>↵</b> edit · <b>C</b> comment · <b>Esc</b> back</span>
        </nav>
      ) : null}
      <div class="nx-page" ref={page} key={docKey}>{children}</div>
      <aside class="nx-margin">{rail}</aside>
    </div>
  );
}

/** A section of a document: a quiet heading and its body, no box. */
export function Sec({ id, title, note, children, action }: { id: string; title: string; note?: ComponentChildren; children: ComponentChildren; action?: ComponentChildren }) {
  return (
    <section class="nx-dsec" data-sec={id}>
      <h4><span>{title}</span>{note ? <em>{note}</em> : null}{action ? <span class="nx-dsec-a">{action}</span> : null}</h4>
      {children}
    </section>
  );
}

/** Text that reads as prose and edits in place: click (or Enter when focused) to edit, Esc to cancel. */
export function Prose({ text, can, onSave, placeholder, cls, light, onKey, editing }: { text: string; can: boolean; onSave(t: string): void; placeholder?: string; cls?: string; light?(p: string[] | null): void; onKey?(e: KeyboardEvent): boolean; editing?: boolean }) {
  const [ed, setEd] = useState(!!editing && can);
  const [v, setV] = useState(text);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (!ed) setV(text); }, [text, ed]);
  useEffect(() => { if (ed && ref.current) { ref.current.focus(); ref.current.style.height = ref.current.scrollHeight + 'px'; } }, [ed]);
  if (!ed) return <p class={'nx-prose ' + (cls ?? '') + (can ? ' can' : '') + (!text ? ' empty' : '')} tabIndex={can ? 0 : -1} onKeyDown={(e) => { if (can && e.key === 'Enter') { e.preventDefault(); setEd(true); } }} onClick={() => can && !window.getSelection()?.toString() && setEd(true)}>{text ? <Rich text={text} light={light} /> : placeholder ?? 'Write…'}</p>;
  return (
    <textarea ref={ref} class={'nx-prose-in ' + (cls ?? '')} value={v} rows={1} placeholder={placeholder}
      onInput={(e) => { setV(e.currentTarget.value); e.currentTarget.style.height = 'auto'; e.currentTarget.style.height = e.currentTarget.scrollHeight + 'px'; }}
      onBlur={() => { setEd(false); if (v.trim() !== text) onSave(v.trim()); }}
      onKeyDown={(e) => { if (onKey?.(e)) return; if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); (e.currentTarget as HTMLTextAreaElement).blur(); } if (e.key === 'Escape') { e.stopPropagation(); (e.currentTarget as HTMLTextAreaElement).blur(); } }} />
  );
}

export function MentionHint({ text, p }: { text: string; p: DeskProps }) {
  const { nameOf, agentName } = useNames();
  const m = /@(\w*)$/.exec(text);
  if (!m) return null;
  const q = m[1].toLowerCase();
  const people = p.rec.members.filter((x) => x.who !== p.me && nameOf(x.who).toLowerCase().startsWith(q));
  return (
    <div class="nx-mention" role="listbox">
      {p.rec.vowe && agentName().toLowerCase().startsWith(q) ? <span class="nx-mopt"><i class="nx-agentmark"></i>{agentName()}<small>AI agent · checks it and replies</small></span> : null}
      {people.map((x) => <span key={x.who} class="nx-mopt"><Who id={x.who} size={16} />{nameOf(x.who)}<small>{!mayWrite(x.role) ? 'viewer: can read and comment' : x.role}</small></span>)}
      {!people.length ? <span class="nx-mopt none">Nobody in this room is called “{m[1]}”.<button type="button" class="rp-link" onClick={() => p.act.invite()}>Invite to the room</button></span> : null}
    </div>
  );
}

export const Lock = () => <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 015 0v2" /></svg>;
export const Ext = () => <span class="nx-ext" aria-label="opens outside the room">↗</span>;
