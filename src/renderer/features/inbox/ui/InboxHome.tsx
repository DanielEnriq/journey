import { h, Fragment, type ComponentChildren } from '../../../vendor/preact.js';
import { useEffect, useRef, useState } from '../../../vendor/preact-hooks.js';
import { requestAnchor } from '../../../shared/nav.js';
import { IconButton, Spinner, Toast } from '../../../ui/components.js';
import { Icon, type IconName } from '../../../ui/icons.js';
import { JoinByLink } from '../../../ui/pass2/invites/JoinByLink.js';
import type { InviteKey } from '../../../../shared/api.js';
import { OBLIGATION_VERB, type InboxItem } from '../model.js';
import type { InboxSource, InboxState } from '../source.js';
import { canMarkDone, canOpen } from './body.js';
import { Face, ItemMenu, nameIn, type ItemMenuActs } from './bits.js';
import { useInboxState } from './hooks.js';
import { Preview } from './Preview.js';
import { ago, inOrder, nextAfter, partOfDay, step } from './time.js';

// Home as the Inbox: on the left, what's addressed to you (Needs you), what you're part of (Following) and what
// moved in your rooms (In your rooms); on the right, the selected item's reading page. Everything comes from the
// workspace's InboxSource: the list never invents an item, a count or a time, and every act goes through it.
// Keys (outside text fields): j/k or the arrows move, Enter opens in the room, E marks done, U marks read or unread,
// Esc clears.

export interface InboxHomeProps {
  source: InboxSource;
  firstName: string;
  /** The selected item (controlled by the route when the app passes it); undefined: kept here. */
  selected?: string | null;
  onSelect?(id: string | null): void;
  onOpenRoom(roomId: string): void;
  /** The reading page with nothing selected (Home: your rooms); without it, a hint to pick an item. */
  idle?(st: InboxState): ComponentChildren;
  /** Something Home itself couldn't do (adding a repository, say), shown under the greeting. */
  notice?: string | null;
  /** Opens an invite from a pasted link (email invitations arrive as items); absent in the demo. */
  onOpenInvite?(key: InviteKey): void;
}

type Foot = null | 'done' | 'snoozed' | 'link';
const FOOT_TITLE = { inbox: 'Inbox', done: 'Done today', snoozed: 'Snoozed', link: 'Invite link' } as const;

/** The list's width, until you drag its right edge (kept on this machine; storage may be unavailable). */
const LIST_W = 380, LIST_MIN = 300, LIST_MAX = 560, LIST_KEY = 'vowe.inbox.listWidth';
const clampList = (w: number) => Math.round(Math.max(LIST_MIN, Math.min(LIST_MAX, w)));
const readList = () => { try { const w = Number(localStorage.getItem(LIST_KEY)); return w ? clampList(w) : LIST_W; } catch { return LIST_W; } };
const keepList = (w: number) => { try { localStorage.setItem(LIST_KEY, String(w)); } catch { /* lasts this session */ } };

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

export function InboxHome(p: InboxHomeProps) {
  const st = useInboxState(p.source);
  const [own, setOwn] = useState<string | null>(null);
  const sel = p.selected !== undefined ? p.selected : own;
  const select = (id: string | null) => { if (p.selected === undefined) setOwn(id); p.onSelect?.(id); };
  const [foot, setFoot] = useState<Foot>(null);
  const [menu, setMenu] = useState<{ it: InboxItem; x: number; y: number } | null>(null);
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null);
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const [listW, setListW] = useState(readList);
  const list = useRef<HTMLDivElement>(null);
  const prevIds = useRef<string[]>([]);

  const view = st && st.status !== 'loading' ? st.view : null;
  // What the keys move through: the items of the sections that aren't folded.
  const ids = view ? inOrder(view).filter((x) => !folded[x.tier]).map((x) => x.id) : [];
  const idKey = ids.join('\n');

  // When the selected item leaves the list (signed, answered, snoozed, done), the next one takes its place.
  useEffect(() => {
    if (sel && view && !ids.includes(sel) && prevIds.current.includes(sel) && !view.resolved.some((r) => r.item.id === sel) && !view.snoozed.some((x) => x.id === sel)) {
      select(nextAfter(prevIds.current, sel));
    }
    prevIds.current = ids;
  }, [idKey]);

  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 6000); return () => clearTimeout(t); }, [toast]);

  const all = view ? [...inOrder(view), ...view.snoozed, ...view.resolved.map((r) => r.item)] : [];
  const it = sel ? all.find((x) => x.id === sel) ?? null : null;
  const resolved = it && view && !ids.includes(it.id) ? view.resolved.find((r) => r.item.id === it.id) : undefined;

  // Selecting an item reads it (what needs you stays in the list until it's done); U marks it read or unread.
  useEffect(() => { if (it && it.unseen > 0) p.source.seen(it); }, [it?.id]);

  const acts: ItemMenuActs = {
    snooze: (x, until, label) => {
      const next = nextAfter(ids, x.id);
      p.source.snooze(x, until, label);
      if (x.id === sel) select(next);
      setToast({ text: `Snoozed ${label.replace(/^Until/, 'until')}`, undo: () => p.source.unsnooze(x.id) });
    },
    done: (x) => {
      if (!canMarkDone(x)) return;
      const next = nextAfter(ids, x.id);
      const undo = p.source.done(x);
      if (x.id === sel) select(next);
      setToast({ text: 'Marked done', undo });
    },
    follow: (x, on) => { p.source.follow(x, on); setToast({ text: on ? 'Following. New activity shows here.' : 'Unfollowed. It leaves Following.' }); },
    read: (x, on) => { if (on) p.source.seen(x); else p.source.unread(x); },
    open: (x) => { if (!canOpen(x)) return; requestAnchor(x.anchor); p.source.seen(x); p.onOpenRoom(x.anchor.roomId); },
  };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || menu) return;
      if (document.querySelector('.v-sheet, [role="dialog"][aria-modal="true"]')) return;
      const inList = !!list.current?.contains(document.activeElement);
      const k = e.key;
      if (k === 'j' || k === 'k' || ((k === 'ArrowDown' || k === 'ArrowUp') && inList)) {
        e.preventDefault();
        const id = step(ids, sel, k === 'j' || k === 'ArrowDown' ? 1 : -1);
        if (id) { select(id); list.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.focus(); }
      } else if (k === 'Enter' && it && inList && canOpen(it)) { e.preventDefault(); acts.open(it); }
      else if ((k === 'e' || k === 'E') && it && canMarkDone(it) && !resolved) { e.preventDefault(); acts.done(it); }
      else if ((k === 'u' || k === 'U') && it && !resolved) { e.preventDefault(); acts.read(it, !!it.unseen); }
      else if (k === 'Escape' && sel) { e.preventDefault(); select(null); }
      else if (k === 'Escape' && foot) { e.preventDefault(); setFoot(null); }
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  });

  if (!st || st.status === 'loading') {
    return <div class="vi-home" style={`--vi-list-w:${listW}px`}><div class="vi-list"><div class="vi-loading" role="status"><Spinner /> Reading your rooms…</div></div><div class="vi-page" /></div>;
  }
  const v = st.view;
  const row = (x: InboxItem) => <Row key={x.id} it={x} st={st} selected={x.id === sel} onSelect={() => select(x.id)} onMenu={(e) => { e.preventDefault(); select(x.id); setMenu({ it: x, x: e.clientX, y: e.clientY }); }} onOpen={() => acts.open(x)} />;
  const doneToday = v.resolved.filter((r) => new Date(r.at).toDateString() === new Date(st.now).toDateString());

  return (
    <div class="vi-home" style={`--vi-list-w:${listW}px`}>
      <div class="vi-list" ref={list}>
        <div class="vi-tb">
          <b>{FOOT_TITLE[foot ?? 'inbox']}</b>
          <span class="vi-tb-acts">
            <IconButton icon="check" label="Done today" tip={`Done today${doneToday.length ? ` · ${doneToday.length}` : ''}`} active={foot === 'done'} onClick={() => setFoot(foot === 'done' ? null : 'done')} />
            <IconButton icon="snooze" label="Snoozed" tip={`Snoozed${v.snoozed.length ? ` · ${v.snoozed.length}` : ''}`} active={foot === 'snoozed'} onClick={() => setFoot(foot === 'snoozed' ? null : 'snoozed')} />
            {p.onOpenInvite ? <IconButton icon="link" label="Open an invite link" tip="Invite link" tipEnd active={foot === 'link'} onClick={() => setFoot(foot === 'link' ? null : 'link')} /> : null}
          </span>
        </div>
        {p.notice ? <div class="vi-notice" role="alert"><Icon name="warn" /><span>{p.notice}</span></div> : null}
        {st.status === 'failed' ? (
          <div class="vi-error" role="alert"><Icon name="warn" /><span>Couldn’t read your rooms{st.error ? `: ${st.error}` : ''}.{ids.length ? ' Showing what was read last.' : ''}</span>
            <button type="button" class="v-btn v-btn-sm" onClick={() => p.source.refresh()}>Retry</button></div>
        ) : null}
        {foot === 'link' && p.onOpenInvite ? (
          <section class="vi-sec" aria-label="Open an invite link">
            <div class="vi-link"><JoinByLink onOpen={p.onOpenInvite} autoFocus /></div>
          </section>
        ) : foot && foot !== 'link' ? (
          <section class="vi-sec" aria-label={FOOT_TITLE[foot]}>
            {foot === 'done'
              ? (doneToday.length ? <div class="vi-box">{doneToday.map((r) => <Row key={r.item.id} it={r.item} st={st} selected={r.item.id === sel} note={r.how} onSelect={() => select(r.item.id)} onOpen={() => acts.open(r.item)} />)}</div> : <p class="vi-none">Nothing done today</p>)
              : (v.snoozed.length ? <div class="vi-box">{v.snoozed.map((x) => (
                <div key={x.id} class="vi-snoozed">
                  <Row it={x} st={st} selected={x.id === sel} onSelect={() => select(x.id)} onOpen={() => acts.open(x)} />
                  <button type="button" class="v-btn v-btn-quiet v-btn-sm" onClick={() => { p.source.unsnooze(x.id); setToast({ text: 'Back in your Inbox' }); }}>Unsnooze</button>
                </div>
              ))}</div> : <p class="vi-none">Nothing snoozed</p>)}
          </section>
        ) : (
          <div class="vi-secs" role="listbox" aria-label="Your Inbox" aria-activedescendant={sel ? `vi-row-${sel}` : undefined}>
            <Section title="Needs you" items={v.needs} row={row} folded={!!folded.needs} onFold={(on) => setFolded((f) => ({ ...f, needs: on }))} calm={<p class="vi-none">Nothing needs you</p>} />
            <Section title="Following" items={v.following} row={row} folded={!!folded.following} onFold={(on) => setFolded((f) => ({ ...f, following: on }))} />
            <Section title="In your rooms" items={v.activity} row={row} folded={!!folded.activity} onFold={(on) => setFolded((f) => ({ ...f, activity: on }))} />
          </div>
        )}
      </div>
      <ListEdge width={listW} onWidth={setListW} />
      <div class="vi-page" aria-live="polite">
        {it ? <Preview key={it.id} it={it} source={p.source} now={st.now} me={st.me} people={st.people} acts={acts} resolvedHow={resolved?.how}
          onJoined={(roomId) => p.onOpenRoom(roomId)} /> : (
          // Nothing selected: the greeting, then your rooms, where Mail says "No message selected".
          <>
            <div class="vi-bar" />
            <div class="vi-page-body vi-idle">
              <header class="vi-head">
                <h1 class="vi-hello">{partOfDay(st.now)}{p.firstName ? `, ${p.firstName}` : ''}.</h1>
              </header>
              {p.idle?.(st)}
            </div>
          </>
        )}
      </div>
      {menu ? <ItemMenu it={menu.it} now={st.now} at={{ x: menu.x, y: menu.y }} acts={acts} onClose={() => setMenu(null)} /> : null}
      {toast ? (
        <div class="vi-toast"><Toast>{toast.text}{toast.undo ? <button type="button" class="v-btn v-btn-quiet v-btn-sm" onClick={() => { toast.undo!(); setToast(null); }}>Undo</button> : null}</Toast></div>
      ) : null}
    </div>
  );
}

/** The list's right edge: drag it to widen or narrow the list (double-click for the usual width), or focus it and use
    the arrow keys. Like the sidebar's edge. */
function ListEdge({ width, onWidth }: { width: number; onWidth(w: number): void }) {
  const set = (w: number, keep = true) => { const c = clampList(w); onWidth(c); if (keep) keepList(c); };
  const drag = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX, w0 = width;
    let last = w0;
    const move = (ev: PointerEvent) => { last = w0 + ev.clientX - x0; set(last, false); };
    const up = () => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up);
      document.body.classList.remove('vh-sb-resizing');
      set(last);
    };
    document.body.classList.add('vh-sb-resizing');
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  };
  const key = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 40 : 10;
    const to = e.key === 'ArrowLeft' ? width - step : e.key === 'ArrowRight' ? width + step : e.key === 'Home' ? LIST_MIN : e.key === 'End' ? LIST_MAX : null;
    if (to === null) return;
    e.preventDefault();
    set(to);
  };
  return (
    <div class="vi-edge" role="separator" aria-orientation="vertical" aria-label="List width" tabIndex={0}
      aria-valuenow={width} aria-valuemin={LIST_MIN} aria-valuemax={LIST_MAX}
      onPointerDown={drag} onDblClick={() => set(LIST_W)} onKeyDown={key} />
  );
}

/** A section of the list: a heading whose chevron folds it, then its items in one rounded box. */
function Section({ title, items, row, calm, folded, onFold }: { title: string; items: InboxItem[]; row(x: InboxItem): ComponentChildren; calm?: ComponentChildren; folded: boolean; onFold(on: boolean): void }) {
  if (!items.length && !calm) return null;
  return (
    <section class={`vi-sec${title === 'Needs you' && items.length ? ' is-needs' : ''}`} aria-label={title}>
      {items.length ? <>
        <button type="button" class="vi-sec-h" aria-expanded={!folded} onClick={() => onFold(!folded)}
          onKeyDown={(e) => { if ((e.key === 'ArrowLeft') === !folded && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); onFold(!folded); } }}>
          <span class="vi-sec-chev" aria-hidden="true"><Icon name="chevron-r" size={14} /></span><span>{title}</span><b>{items.length}</b>
        </button>
        {folded ? null : <div class="vi-box">{items.map(row)}</div>}
      </> : calm}
    </section>
  );
}

/** The row's glyph: what you owe (Needs you), or what kind of thing moved. */
const OWED: Record<NonNullable<InboxItem['obligation']>, IconName> = {
  sign: 'pen', answer: 'question', reply: 'reply', review: 'decision', authorize: 'lock', accept: 'mail', allow: 'lock',
};
const KIND: Record<InboxItem['subject']['kind'], IconName> = {
  decision: 'decision', thread: 'comment', question: 'question', plan: 'decision', run: 'terminal', pr: 'branch', invitation: 'mail', room: 'room',
};

function Row({ it, st, selected, note, onSelect, onMenu, onOpen }: { it: InboxItem; st: InboxState; selected: boolean; note?: string; onSelect(): void; onMenu?(e: MouseEvent): void; onOpen(): void }) {
  const name = nameIn(st.people, st.me);
  const needs = it.tier === 'needs';
  const verb = needs && it.obligation ? OBLIGATION_VERB[it.obligation] : null;
  const when = ago(needs && it.waitingSince ? it.waitingSince : it.at, st.now);
  const unread = it.unseen > 0;
  const p = it.progress;
  // Two lines. First: who, the headline, and the glyph for what it is (signal when it's yours to do). Second: what
  // happened, in a phrase (what was said, for Following), then the room, and when.
  const said = it.excerpt && it.tier === 'following' ? `${name(it.excerpt.by)}: ${it.excerpt.text.replace(/\[([^|\]]+)\|[^\]]+\]/g, '$1')}` : null;
  const on = it.path[1] && !it.headline.includes(it.path[1]) ? it.path[1] : null;
  const what = note ?? said ?? (needs ? it.why.split(' · ')[0] : on ?? it.whyShort ?? null);
  return (
    <div id={`vi-row-${it.id}`} data-id={it.id} role="option" aria-selected={selected} tabIndex={selected ? 0 : -1}
      aria-label={[verb, it.headline, what, it.room.name, when].filter(Boolean).join(', ')}
      class={'vi-row' + (needs ? ' is-needs' : '') + (unread ? ' is-unread' : '')}
      onClick={onSelect} onDblClick={() => canOpen(it) && onOpen()} onContextMenu={onMenu} onFocus={() => !selected && onSelect()}>
      <span class="vi-face"><Face id={it.actor} people={st.people} size={24} /></span>
      <span class="vi-hl">{it.headline}</span>
      <span class="vi-r">
        {it.raised ? <span class="vi-raised" title={it.raised}><Icon name="raise" size={14} /></span> : null}
        {p ? <span class="vi-progress" aria-label={`${p.done} of ${p.of} steps done`}>{Array.from({ length: p.of }, (_, i) => <i key={i} class={i < p.done ? 'is-done' : i === p.done && needs ? 'is-wait' : ''} />)}</span> : null}
        <span class="vi-glyph" title={verb ?? undefined} aria-hidden="true"><Icon name={it.obligation && needs ? OWED[it.obligation] : KIND[it.subject.kind]} size={14} /></span>
      </span>
      <span class="vi-sub">{what ? <span class="vi-what">{what}</span> : null}<span class="vi-where">{it.room.name}</span></span>
      <span class="vi-at">{when}</span>
    </div>
  );
}
