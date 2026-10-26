import { useEffect, useRef, useState } from '../../../vendor/preact-hooks.js';
import type { VoweRecord } from '../contracts/model.js';
import type { Attn } from '../state/attention.js';
import type { Depth, Inspect, Tab, Ui, UiState } from '../state/ui.js';
import type { DeskAct } from '../desk/Desk.js';

// Everything about moving around the room that touches only your own UI state: tabs, the open artifact,
// depth, history and keys. The same in production and in the prototype; none of it writes the record.

export type UiActions = Pick<DeskAct,
  'tab' | 'inspect' | 'depth' | 'wide' | 'light' | 'thread' | 'fsec' | 'everywhere' | 'compare' | 'passage' | 'lineThread' | 'focusAll' | 'sinceFold' | 'toast'>;

/** Where Escape and the expand button return to from full screen. */
export const exitDepth = (st: UiState): Depth => (st.prevDepth && st.prevDepth !== 'focus' ? st.prevDepth : 'compact');

export function uiActions(ui: Ui, light: (parts: string[] | null) => void): UiActions {
  const set = (p: Partial<UiState>) => ui.setState(p);
  const self: UiActions = {
    tab: (t) => set({ tab: t, fsec: t, inspect: null }),
    inspect: (i) => {
      if (!i) { set({ inspect: null, compare: null }); return; }
      const st = ui.state;
      const same = st.inspect && st.inspect.id === i.id;
      // Width is only width: opening an artifact never changes how wide the Desk is.
      set({ inspect: i, deskOpen: true, tab: i.kind === 'decision' ? 'decide' : 'work', fsec: i.kind === 'decision' ? 'decide' : 'work', compare: same ? st.compare : null });
    },
    depth: (to) => {
      const st = ui.state;
      if (to === 'focus') set({ depth: 'focus', deskOpen: true, prevDepth: st.depth !== 'focus' ? st.depth : st.prevDepth, fsec: st.inspect ? (st.inspect.kind === 'decision' ? 'decide' : 'work') : st.tab });
      else set({ depth: to, deskOpen: true });
    },
    wide: (on) => self.depth(on ? 'expanded' : 'compact'),
    light,
    thread: (id) => set({ thread: id, ...(id ? { tab: 'discuss' as Tab, fsec: 'discuss' as Tab, inspect: null } : {}) }),
    fsec: (sec) => {
      const cur = ui.state.inspect;
      const keep = cur && (sec === 'decide' || sec === 'work') && (cur.kind === 'decision') === (sec === 'decide');
      set({ fsec: sec, tab: sec, inspect: keep ? cur : null });
    },
    everywhere: (on) => set({ everywhere: on }),
    compare: (v) => set({ compare: v }),
    passage: (w, step, quote, thread, close) => set({ inspect: close ? { kind: 'work', id: w, section: 'plan' } : thread ? { kind: 'work', id: w, section: 'plan', thread } : { kind: 'work', id: w, section: 'plan', step, quote } }),
    lineThread: (d, line) => set({ inspect: { kind: 'decision', id: d, line }, tab: 'decide' }),
    focusAll: () => set({ focusOn: false }),
    sinceFold: () => set({ sinceOpen: false }),
    toast: (text) => set({ toast: { text } }),
  };
  return self;
}

/** Open what an attention item is about, in the place that answers it. Marks it done (the caller persists that). */
export function openAttention(ui: Ui, rec: VoweRecord, a: Attn): void {
  const t = rec.threads.find((x) => x.id === a.to.id);
  if (t && t.about.kind === 'step') { ui.setState({ tab: 'work', fsec: 'work', inspect: { kind: 'work', id: t.about.work, section: 'plan', thread: t.id } }); return; }
  if (t && (t.about.kind === 'pr' || t.about.kind === 'check')) {
    const pr = t.about.kind === 'pr' ? t.about.id : t.about.pr;
    const w = rec.work.find((x) => x.prs.some((y) => y.id === pr));
    if (w) { ui.setState({ tab: 'work', fsec: 'work', inspect: { kind: 'work', id: w.id, section: 'prs', pr } }); return; }
  }
  if (t && t.about.kind === 'line') { ui.setState({ tab: 'decide', fsec: 'decide', inspect: { kind: 'decision', id: t.about.decision, line: t.about.id } }); return; }
  const kind = a.to.tab === 'decide' ? 'decision' : 'work';
  const section = a.id.startsWith('q:') ? 'run' : a.id.startsWith('ci:') || a.id.startsWith('pc:') ? 'prs' : 'plan';
  const inspect: Inspect = a.to.tab === 'discuss' ? null
    : a.to.inspect || (a.kind === 'respond' && a.to.tab === 'work') ? (kind === 'work' ? { kind: 'work', id: a.to.id, section } : { kind: 'decision', id: a.to.id })
    : null;
  ui.setState({ tab: a.to.tab, fsec: a.to.tab, flash: `${t ? 'thread' : kind}:${a.to.id}`, thread: t ? t.id : ui.state.thread, sel: a.part ? [{ component: a.part }] : [], inspect });
}

/** A place in the Desk, as history keeps it. Width is not part of a place; only full screen is. */
type Place = Pick<UiState, 'tab' | 'inspect' | 'depth' | 'thread' | 'compare' | 'fsec'>;
export interface DeskNav { back(): void; fwd(): void; backLabel: string | null; fwdLabel: string | null }

/** Back and forward through what you've opened, like a browser (⌘[ and ⌘]). */
export function useDeskHistory(ui: Ui, u: UiState, record: () => VoweRecord): DeskNav {
  const hist = useRef<{ list: Place[]; i: number; skip: boolean }>({ list: [], i: -1, skip: false });
  const [, bump] = useState(0);
  const placeOf = (st: UiState): Place => ({ tab: st.tab, inspect: st.inspect, depth: st.depth === 'focus' ? 'focus' : 'compact', thread: st.thread, compare: st.compare, fsec: st.fsec });
  const key = (x: Place) => JSON.stringify(x);
  useEffect(() => {
    const h = hist.current, cur = placeOf(u);
    if (h.skip) { h.skip = false; return; }
    if (h.i >= 0 && key(h.list[h.i]) === key(cur)) return;
    h.list = [...h.list.slice(0, h.i + 1), cur].slice(-50);
    h.i = h.list.length - 1;
    bump((n) => n + 1);
  }, [u.tab, u.inspect, u.depth === 'focus', u.thread, u.compare, u.fsec]);
  const label = (x?: Place): string | null => {
    if (!x) return null;
    const r = record();
    if (x.inspect?.kind === 'decision') { const d = r.decisions.find((y) => y.id === x.inspect!.id); return d ? `${d.title}${x.compare ? ` (changes since v${x.compare})` : ''}` : 'a decision'; }
    if (x.inspect?.kind === 'work') {
      const w = r.work.find((y) => y.id === x.inspect!.id);
      const sec = x.inspect.section && x.inspect.section !== 'plan' ? ` · ${({ run: 'Run', prs: 'Pull requests', outcome: 'Outcome' } as Record<string, string>)[x.inspect.section]}` : ' · Plan';
      return w ? `${w.title}${sec}` : 'work';
    }
    if (x.tab === 'discuss' && x.thread) { const t = r.threads.find((y) => y.id === x.thread); return t ? `the ${t.about.name} thread` : 'Discuss'; }
    return ({ discuss: 'Discuss', decide: 'Decide', work: 'Work' } as Record<string, string>)[x.tab];
  };
  const go = (d: number) => {
    const h = hist.current, j = h.i + d;
    if (j < 0 || j >= h.list.length) return;
    h.i = j; h.skip = true;
    const x = h.list[j], r = record(), st = ui.state;
    // Something deleted since stays deleted: go to its tab instead.
    const exists = !x.inspect || (x.inspect.kind === 'decision' ? r.decisions.some((y) => y.id === x.inspect!.id) : r.work.some((y) => y.id === x.inspect!.id));
    ui.setState({ ...x, inspect: exists ? x.inspect : null, deskOpen: true, depth: x.depth === 'focus' ? 'focus' : st.depth === 'focus' ? exitDepth(st) : st.depth });
    bump((n) => n + 1);
  };
  const h = hist.current;
  return { back: () => go(-1), fwd: () => go(1), backLabel: label(h.list[h.i - 1]), fwdLabel: label(h.list[h.i + 1]) };
}

/** The Desk's keys. Ignored while typing. */
export function useDeskKeys(ui: Ui, act: Pick<DeskAct, 'depth' | 'fsec' | 'inspect'>, nav: DeskNav): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const st = ui.state, d = st.depth;
      if ((e.metaKey || e.ctrlKey) && (e.code === 'BracketLeft' || e.code === 'BracketRight')) { e.preventDefault(); (e.code === 'BracketLeft' ? nav.back : nav.fwd)(); return; }
      if (e.code === 'BracketRight' && e.shiftKey) { e.preventDefault(); act.depth(d === 'expanded' ? 'compact' : 'expanded'); }
      else if (e.code === 'BracketRight') { e.preventDefault(); ui.setState(st.deskOpen ? { deskOpen: false } : { deskOpen: true, depth: 'compact' }); }
      else if (e.key === 'F' && e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); act.depth(d === 'focus' ? exitDepth(st) : 'focus'); }
      else if (d === 'focus' && e.altKey && /^Digit[1-3]$/.test(e.code)) { e.preventDefault(); act.fsec((['discuss', 'decide', 'work'] as const)[+e.code.slice(5) - 1]); }
      else if (e.key === 'Escape') { if (d === 'focus') act.depth(exitDepth(st)); else if (st.inspect) act.inspect(null); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });
}

/** Toasts leave on their own; one with Undo stays a little longer. */
export function useToastTimeout(ui: Ui, u: UiState): void {
  useEffect(() => {
    if (!u.toast) return;
    const t = setTimeout(() => ui.setState({ toast: null }), u.toast.undo ? 6000 : 3200);
    return () => clearTimeout(t);
  }, [u.toast]);
}
