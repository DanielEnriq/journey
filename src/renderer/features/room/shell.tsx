import { h, type ComponentChildren } from '../../vendor/preact.js';
import { useEffect, useRef, useState } from '../../vendor/preact-hooks.js';
import { PanelRight } from '../../shared/components/icons.js';
import { IconButton } from '../../ui/components.js';
import { AccountFoot } from '../../shared/components/Account.js';
import type { PersonRef, RoomSummary } from './types.js';
import { CallCluster } from './call/CallControls.js';

// The window around every room screen, in the call or not: the band with its toggles, the rooms panel,
// and how a room's presence is drawn.

export function Lights() {
  return (
    <div class="lights" aria-hidden="true">
      <span style="background:#ff5f57"></span>
      <span style="background:#febc2e"></span>
      <span style="background:#28c840"></span>
    </div>
  );
}

export interface ChromeProps {
  side: boolean;
  toggleSide(): void;
  /** What the arrows step through; the window's history when absent (as on Home). */
  nav?: { back(): void; fwd(): void; backLabel: string | null; fwdLabel: string | null };
  desk?: boolean | null;
  deskUnseen?: boolean;
  toggleDesk?(): void;
  /** On the band's right, before the desk toggle: the room's Share. */
  actions?: ComponentChildren;
  /** What the right toggle shows and hides: the call's panel, "where we are" (default), or the room's inspector. */
  deskName?: string;
  /** What the left toggle shows and hides: Journey's rooms panel (default) or the shared sidebar. */
  sideName?: 'rooms' | 'sidebar';
  /** Draws the call cluster first in the band's right end (Vowe rooms). `looking` is this room; with its canvas
      on screen, its CallBar is too, so the cluster in the call's own room shows presence only. */
  call?: { looking: string; canvasShown: boolean };
}

export function Chrome({ side, desk = null, deskUnseen, toggleSide, toggleDesk, nav, actions, sideName = 'rooms', deskName = 'where we are', call }: ChromeProps) {
  const sideLabel = `${side ? 'Hide' : 'Show'} ${sideName}`, deskLabel = `${desk ? 'Hide' : 'Show'} ${deskName}`;
  return (
    <header class="top-chrome">
      {/* The same buttons, sizes and spacing as Home's band (AppShell), so the corner doesn't shift on entering a room. */}
      <div class="chrome-controls">
        <IconButton icon="sidebar" label={sideLabel} tip={`${sideLabel} · [`} aria-pressed={side} onClick={toggleSide} />
        <span class="vh-band-nav" role="group" aria-label="History">
          <IconButton icon="chevron-l" label="Back" tip={nav?.backLabel ? `Back to ${nav.backLabel} · ⌘[` : 'Back · ⌘['} aria-disabled={nav && !nav.backLabel ? 'true' : undefined} onClick={nav ? () => { if (nav.backLabel) nav.back(); } : () => history.back()} />
          <IconButton icon="chevron-r" label="Forward" tip={nav?.fwdLabel ? `Forward to ${nav.fwdLabel} · ⌘]` : 'Forward · ⌘]'} aria-disabled={nav && !nav.fwdLabel ? 'true' : undefined} onClick={nav ? () => { if (nav.fwdLabel) nav.fwd(); } : () => history.forward()} />
        </span>
      </div>
      {(desk !== null || actions || call) && (
        <div class="chrome-actions">
          {call ? <CallCluster looking={call.looking} canvasShown={call.canvasShown} /> : null}
          {actions}
          {desk !== null && <button class={'panel-toggle' + (desk ? ' open' : '')} type="button" aria-label={deskLabel} title={`${deskLabel} · ]`} aria-expanded={desk} onClick={toggleDesk}>
            <PanelRight />
            {deskUnseen && <span class="unseen" aria-hidden="true"></span>}
          </button>}
        </div>
      )}
    </header>
  );
}

/** One room in a list: amber when it needs you, brighter when a call is on, quiet otherwise. */
export function roomLine(r: RoomSummary) {
  const names = r.inCall.filter((p) => p.tone !== 'me').map((p) => p.name);
  const you = r.inCall.some((p) => p.tone === 'me');
  const call = r.inCall.length > 0;
  return {
    dot: 'dot' + (r.needs ? ' needs' : call ? ' call' : ''),
    act: r.needs ?? (call ? (you && !names.length ? 'You’re in the call' : `${listNames(names, you)} in the call`) : r.activity),
    actCls: 'act' + (r.needs ? ' ask' : ''),
  };
}

export function listNames(names: string[], you = false) {
  const all = (you ? ['You'] : []).concat(names);
  const verb = all.length === 1 && !you ? 'is' : 'are';
  const joined = all.length <= 1 ? all[0] ?? '' : all.slice(0, -1).join(', ') + ' and ' + all[all.length - 1];
  return `${joined} ${verb}`;
}

interface PanelProps {
  rooms: RoomSummary[];
  current: string;
  ask?: { text: string; go(): void } | null;
  onOpenRoom(id: string): void;
  hidden: boolean;
}

export function RoomsPanel({ rooms, current, ask, onOpenRoom, hidden }: PanelProps) {
  return (
    <aside class="sidebar" aria-hidden={hidden}>
      <div class="sidebar-title"><span class="eyebrow">Rooms</span></div>
      <nav class="sidebar-nav" aria-label="Rooms">
        {rooms.map((r) => {
          const l = roomLine(r);
          return [
            <button key={r.id} class={'row' + (r.id === current ? ' selected' : '')} type="button" aria-current={r.id === current ? 'page' : undefined} onClick={() => onOpenRoom(r.id)}>
              <span class={l.dot}></span>
              <span class="txt"><span class="name">{r.name}</span><span class={l.actCls}>{l.act}</span></span>
            </button>,
            r.id === current && ask && <button key={r.id + '-ask'} class="subrow" type="button" onClick={ask.go}><span class="dot needs"></span><span>{ask.text}</span></button>,
          ];
        })}
      </nav>
      <AccountFoot />
    </aside>
  );
}

/** Avatars of who is in a call; Vowe's orb last, still, since it only speaks inside the call. */
export function Who({ people, vowe, ring }: { people: PersonRef[]; vowe: boolean; ring?: Record<string, string> }) {
  return (
    <div class="who">
      {people.map((p) => <span key={p.initials} class={`avatar ${p.tone === 'me' ? '' : p.tone} ${ring?.[p.initials] ?? ''}`} title={p.name}>{p.initials}</span>)}
      {vowe && <span class="orb small" title="Vowe"></span>}
    </div>
  );
}

/**
 * The room's name in the toolbar, and the Space it's in beside it in grey. Owners click the name to rename it in
 * place, as a Mac window's title is renamed: Return keeps it, Escape puts it back, clicking away keeps it.
 */
export function RoomTitle({ name, space, onRename }: { name: string; space?: string | null; onRename?: (name: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) field.current?.select(); }, [editing]);
  const done = (keep: boolean) => {
    const next = field.current?.value.trim() ?? '';
    setEditing(false);
    if (keep && onRename && next && next !== name) void onRename(next).catch(() => { /* the name stays as it was */ });
  };
  return (
    <span class="room-title">
      {editing ? (
        <input ref={field} class="room-title-field" defaultValue={name} aria-label="Room name"
          onKeyDown={(e) => { if (e.key === 'Enter') done(true); else if (e.key === 'Escape') done(false); }} onBlur={() => done(true)} />
      ) : onRename ? (
        <h1><button type="button" class="room-title-name" title="Rename" onClick={() => setEditing(true)}>{name}</button></h1>
      ) : <h1>{name}</h1>}
      {space ? <span class="room-title-space">{space}</span> : null}
    </span>
  );
}

/** Who has the room open but isn't in its call: their faces, faded, as Figma shows who's looking. */
export function Viewers({ people }: { people: PersonRef[] }) {
  if (!people.length) return null;
  const shown = people.slice(0, 3), more = people.length - shown.length;
  return (
    <div class="who viewers" role="group" aria-label={`${people.map((p) => p.name).join(', ')} ${people.length === 1 ? 'has' : 'have'} the room open`}>
      {shown.map((p) => <span key={p.initials} class={`avatar ${p.tone === 'me' ? '' : p.tone}`} title={`${p.name} · looking`}>{p.initials}</span>)}
      {more > 0 ? <span class="avatar more" title={people.slice(3).map((p) => p.name).join(', ')}>+{more}</span> : null}
    </div>
  );
}
