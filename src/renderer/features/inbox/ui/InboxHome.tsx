import { h, Fragment, type ComponentChildren } from '../../../vendor/preact.js';
import { useEffect, useRef, useState } from '../../../vendor/preact-hooks.js';
import { requestAnchor } from '../../../shared/nav.js';
import { Spinner, Toast } from '../../../ui/components.js';
import { Icon } from '../../../ui/icons.js';
import { OBLIGATION_VERB, SOURCE_LABEL, type InboxItem } from '../model.js';
import type { InboxSource, InboxState } from '../source.js';
import { canMarkDone, canOpen } from './body.js';
import { Face, ItemMenu, nameIn, type ItemMenuActs } from './bits.js';
import { useInboxState } from './hooks.js';
import { Preview } from './Preview.js';
import { ago, dayLine, inOrder, nextAfter, partOfDay, step, waiting } from './time.js';

// Home as the Inbox: on the left, what's addressed to you (Needs you), what you're part of (Following) and what
// moved in your rooms (In your rooms); on the right, the selected item's reading page. Everything comes from the
// workspace's InboxSource: the list never invents an item, a count or a time, and every act goes through it.
// Keys (outside text fields): j/k or the arrows move, Enter opens in the room, E marks done, Esc clears.

export interface InboxHomeProps {
  source: InboxSource;
  firstName: string;
  /** The selected item (controlled by the route when the app passes it); undefined: kept here. */
  selected?: string | null;
  onSelect?(id: string | null): void;
  onOpenRoom(roomId: string): void;
}

type Foot = null | 'done' | 'snoozed';

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

export function InboxHome(p: InboxHomeProps) {
  const st = useInboxState(p.source);
  const [own, setOwn] = useState<string | null>(null);
  const sel = p.selected !== undefined ? p.selected : own;
  const select = (id: string | null) => { if (p.selected === undefined) setOwn(id); p.onSelect?.(id); };
  const [foot, setFoot] = useState<Foot>(null);
  const [menu, setMenu] = useState<{ it: InboxItem; x: number; y: number } | null>(null);
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const prevIds = useRef<string[]>([]);

  const view = st && st.status !== 'loading' ? st.view : null;
  const ids = view ? inOrder(view).map((x) => x.id) : [];
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

  // Selecting what you follow or saw in your rooms clears its new events; what needs you stays until it's done.
  useEffect(() => { if (it && it.tier !== 'needs' && it.unseen > 0) p.source.seen(it); }, [it?.id]);

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
      else if (k === 'Escape' && sel) { e.preventDefault(); select(null); }
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  });

  if (!st || st.status === 'loading') {
    return <div class="vi-home"><div class="vi-list"><div class="vi-loading" role="status"><Spinner /> Reading your rooms…</div></div><div class="vi-page" /></div>;
  }
  const v = st.view;
  const row = (x: InboxItem) => <Row key={x.id} it={x} st={st} selected={x.id === sel} onSelect={() => select(x.id)} onMenu={(e) => { e.preventDefault(); select(x.id); setMenu({ it: x, x: e.clientX, y: e.clientY }); }} onOpen={() => acts.open(x)} />;
  const doneToday = v.resolved.filter((r) => new Date(r.at).toDateString() === new Date(st.now).toDateString());

  return (
    <div class="vi-home">
      <div class="vi-list" ref={list}>
        <header class="vi-head">
          <div class="vi-eyebrow">{dayLine(st.now)}</div>
          <h1 class="vi-hello">{partOfDay(st.now)}{p.firstName ? `, ${p.firstName}` : ''}.{v.needs.length ? null : <> <em>Nothing needs you.</em></>}</h1>
          {v.away ? <p class="vi-away"><b>{v.away.label}:</b> {v.away.summary}</p> : null}
        </header>
        {st.status === 'failed' ? (
          <div class="vi-error" role="alert"><Icon name="warn" /><span>Couldn’t read your rooms{st.error ? `: ${st.error}` : ''}.{ids.length ? ' Showing what was read last.' : ''}</span>
            <button type="button" class="v-btn v-btn-sm" onClick={() => p.source.refresh()}>Retry</button></div>
        ) : null}
        {foot ? (
          <section class="vi-sec" aria-label={foot === 'done' ? 'Done today' : 'Snoozed'}>
            <div class="vi-sec-h"><button type="button" class="vi-back" onClick={() => setFoot(null)}><Icon name="chevron-l" size={14} />Inbox</button><span>{foot === 'done' ? 'Done today' : 'Snoozed'}</span></div>
            {foot === 'done'
              ? (doneToday.length ? doneToday.map((r) => <Row key={r.item.id} it={r.item} st={st} selected={r.item.id === sel} note={r.how} onSelect={() => select(r.item.id)} onOpen={() => acts.open(r.item)} />) : <p class="vi-none">Nothing done yet today.</p>)
              : (v.snoozed.length ? v.snoozed.map((x) => (
                <div key={x.id} class="vi-snoozed">
                  <Row it={x} st={st} selected={x.id === sel} onSelect={() => select(x.id)} onOpen={() => acts.open(x)} />
                  <button type="button" class="v-btn v-btn-quiet v-btn-sm" onClick={() => { p.source.unsnooze(x.id); setToast({ text: 'Back in your Inbox' }); }}>Unsnooze</button>
                </div>
              )) : <p class="vi-none">Nothing snoozed.</p>)}
          </section>
        ) : (
          <div class="vi-secs" role="listbox" aria-label="Your Inbox" aria-activedescendant={sel ? `vi-row-${sel}` : undefined}>
            <Section title="Needs you" note="addressed to you, waiting on you" items={v.needs} row={row} calm={<p class="vi-none is-calm"><Icon name="check" />Nothing is waiting on you.</p>} />
            <Section title="Following" note="what you’re part of" items={v.following} row={row} />
            <Section title="In your rooms" note="no action needed" items={v.activity} row={row} />
          </div>
        )}
        <footer class="vi-foot">
          <button type="button" class="vi-footbtn" aria-pressed={foot === 'done'} onClick={() => setFoot(foot === 'done' ? null : 'done')}>Done today · {doneToday.length}</button>
          <button type="button" class="vi-footbtn" aria-pressed={foot === 'snoozed'} onClick={() => setFoot(foot === 'snoozed' ? null : 'snoozed')}>Snoozed · {v.snoozed.length}</button>
          {st.unavailable.length ? <span class="vi-unavail" title="These sources don’t feed the Inbox yet">Not in Journey yet: {st.unavailable.map((s) => SOURCE_LABEL[s]).join(', ')}</span> : null}
        </footer>
      </div>
      <div class="vi-page" aria-live="polite">
        {it ? <Preview key={it.id} it={it} source={p.source} now={st.now} me={st.me} people={st.people} acts={acts} resolvedHow={resolved?.how}
          onJoined={(roomId) => p.onOpenRoom(roomId)} /> : (
          <div class="vi-empty">
            <p>{v.needs.length ? `${v.needs.length} thing${v.needs.length > 1 ? 's' : ''} ${v.needs.length > 1 ? 'are' : 'is'} waiting on you. Pick one to read it here.` : 'Nothing needs you. Pick anything to read it here.'}</p>
            <p class="vi-keys"><kbd class="v-kbd">J</kbd><kbd class="v-kbd">K</kbd> move · <kbd class="v-kbd">↵</kbd> open in room · <kbd class="v-kbd">E</kbd> done</p>
          </div>
        )}
      </div>
      {menu ? <ItemMenu it={menu.it} now={st.now} at={{ x: menu.x, y: menu.y }} acts={acts} onClose={() => setMenu(null)} /> : null}
      {toast ? (
        <div class="vi-toast"><Toast>{toast.text}{toast.undo ? <button type="button" class="v-btn v-btn-quiet v-btn-sm" onClick={() => { toast.undo!(); setToast(null); }}>Undo</button> : null}</Toast></div>
      ) : null}
    </div>
  );
}

function Section({ title, note, items, row, calm }: { title: string; note: string; items: InboxItem[]; row(x: InboxItem): ComponentChildren; calm?: ComponentChildren }) {
  if (!items.length && !calm) return null;
  return (
    <section class="vi-sec" aria-label={title}>
      <div class="vi-sec-h" role="presentation"><span>{title}{items.length ? <b>{items.length}</b> : null}</span><em>{note}</em></div>
      {items.length ? items.map(row) : calm}
    </section>
  );
}

function Row({ it, st, selected, note, onSelect, onMenu, onOpen }: { it: InboxItem; st: InboxState; selected: boolean; note?: string; onSelect(): void; onMenu?(e: MouseEvent): void; onOpen(): void }) {
  const name = nameIn(st.people, st.me);
  const verb = it.obligation ? OBLIGATION_VERB[it.obligation] : null;
  const when = it.tier === 'needs' && it.waitingSince ? waiting(it.waitingSince, st.now) : ago(it.at, st.now);
  return (
    <div id={`vi-row-${it.id}`} data-id={it.id} role="option" aria-selected={selected} tabIndex={selected ? 0 : -1}
      class={'vi-row' + (selected ? ' is-sel' : '') + (it.tier === 'needs' ? ' is-needs' : '') + (it.unseen ? ' is-new' : '')}
      onClick={onSelect} onDblClick={() => canOpen(it) && onOpen()} onContextMenu={onMenu} onFocus={() => !selected && onSelect()}>
      <span class="vi-face"><Face id={it.actor} people={st.people} /></span>
      <span class="vi-main">
        <span class="vi-l1">
          <span class="vi-hl">{verb ? <b class="vi-verb">{verb}</b> : null}{it.headline}</span>
          <span class="vi-t">{when}</span>
        </span>
        {it.raised && it.tier !== 'needs' ? <span class="vi-raised">{it.raised}</span> : null}
        {it.excerpt ? <span class="vi-ex"><b>{name(it.excerpt.by)}:</b> {it.excerpt.text.replace(/\[([^|\]]+)\|[^\]]+\]/g, '$1')}</span> : null}
        {it.progress ? <span class="vi-progress" aria-label={`${it.progress.done} of ${it.progress.of}`}>{Array.from({ length: it.progress.of }, (_, i) => <i key={i} class={i < it.progress!.done ? 'is-done' : ''} />)}</span> : null}
        <span class="vi-meta">
          <span>{it.room.name}</span>{it.whyShort || note ? <><i aria-hidden="true">·</i><span>{note ?? it.whyShort}</span></> : null}
          {it.unseen && it.tier !== 'needs' ? <span class="vi-newn">{it.unseen} new</span> : null}
        </span>
      </span>
    </div>
  );
}
