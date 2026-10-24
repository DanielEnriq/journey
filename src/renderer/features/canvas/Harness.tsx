import { Fragment, h } from '../../vendor/preact.js';
import { useEffect, useMemo, useRef, useState } from '../../vendor/preact-hooks.js';
import { useStore } from '../../shared/store.js';
import { account } from '../../shared/account.js';
import {
  buildScenes, ORDERS_SYSTEM, PAYMENT_SYSTEM, type Actor, type CommandArgs, type CommandName, type CommandResult,
} from '../../../shared/canvas/index.js';
import { Lights } from '../room/shell.js';
import type { Point } from '../room/types.js';
import { CanvasClient, ipcTransport, memoryTransport, type CanvasTransport } from './client.js';
import { circled, LiveSurface } from './LiveSurface.js';

// A developer's harness for the canvas engine (#/dev/canvas): the payment scenario in eight steps,
// run through the same client, engine and surface a real room uses. Each step is one Canvas Command
// (or a check), from you or from Vowe, and says what it did. Nothing here is a second canvas.
//
//   #/dev/canvas          an in-memory room in this window's storage. Vowe's steps run as Vowe (the
//                         agent actor), so they land as proposals. Open it in two windows of the
//                         preview to be two people: cursors, selections and saves travel between them.
//   #/dev/canvas/<room>   a real room, through main's hub and Supabase. A renderer can only act as
//                         the signed-in person, so Vowe's steps run as you there.

const ROOM = 'dev-harness';
/** Each window of the harness is its own person, kept across reloads of that window. */
const YOU: Actor = (() => {
  let id = '';
  try { id = sessionStorage.getItem('vowe.canvas.dev.me') ?? ''; } catch { /* storage may be off */ }
  if (!id) { id = 'dev-' + Math.random().toString(36).slice(2, 6); try { sessionStorage.setItem('vowe.canvas.dev.me', id); } catch { /* as above */ } }
  return { kind: 'human', id, name: 'Person ' + id.slice(4).toUpperCase() };
})();
const VOWE: Actor = { kind: 'agent', id: 'vowe', name: 'Vowe' };

type Who = 'you' | 'vowe';
interface Step {
  title: string;
  who: Who | 'check';
  run(h: Harness): Promise<string>;
}

interface Harness {
  client: CanvasClient;
  as<K extends CommandName>(who: Who, name: K, args: CommandArgs[K]): Promise<string>;
  /** Reads the room again from where it is kept, as a new window would, and compares. */
  reload(): Promise<string>;
}

const say = (r: CommandResult) => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return `${r.message} (${r.applied}, revision ${r.revision})`;
};
const check = (ok: boolean, yes: string, no: string) => { if (!ok) throw new Error(no); return yes; };

/** A circle drawn around a rect, as a pen would: twelve points on an ellipse a little outside it. */
function ring([x, y, w, h]: [number, number, number, number]): Point[] {
  return Array.from({ length: 12 }, (_, i) => {
    const a = (i / 12) * Math.PI * 2;
    return [x + w / 2 + Math.cos(a) * (w / 2 + 18), y + h / 2 + Math.sin(a) * (h / 2 + 18)] as Point;
  });
}
const path = (pts: Point[]) => pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ') + ' Z';

const STEPS: Step[] = [
  { title: 'Load the payment architecture', who: 'you', run: (x) => x.as('you', 'load_system', { ...PAYMENT_SYSTEM, replace: true }) },
  { title: 'Highlight the worker', who: 'vowe', run: (x) => x.as('vowe', 'highlight_component', { components: ['payment-worker'] }) },
  { title: 'Show Failure Flow', who: 'vowe', run: (x) => x.as('vowe', 'show_view', { view: 'failure-flow', focus: 'payment-worker' }) },
  { title: 'Add the failure after the charge, before the ack', who: 'vowe', run: (x) => x.as('vowe', 'add_failure', { component: 'payment-worker', mode: 'crash' }) },
  { title: 'Show Concurrency', who: 'vowe', run: (x) => x.as('vowe', 'show_view', { view: 'concurrency', focus: 'payment-worker' }) },
  {
    title: 'Two workers on the same job', who: 'check', run: async (x) => {
      const sc = x.client.state.scenes.concurrency, doc = x.client.state.doc;
      const copies = sc?.nodes.filter((n) => n.component === 'payment-worker') ?? [];
      const components = Object.keys(doc.components).filter((id) => id.startsWith('payment-worker'));
      return check(copies.length === 2 && components.length === 1,
        `Concurrency draws ${copies.map((n) => n.key).join(' and ')}: two copies of one component (${components.join(', ')}), both on ${sc!.nodes[0].name}’s job.`,
        `expected two copies of one worker, got ${copies.length} copies of ${components.length} components`);
    },
  },
  {
    title: 'Circle the provider', who: 'you', run: async (x) => {
      const sc = x.client.state.scenes[x.client.state.doc.activeView];
      const provider = sc?.nodes.find((n) => n.component === 'payment-provider');
      if (!sc || !provider) throw new Error('the provider isn’t on this view');
      const pts = ring(provider.rect), hits = circled(sc, pts);
      return x.as('you', 'draw', { view: sc.view, kind: 'circle', d: path(pts), refs: hits.map((t) => t.ref) })
        .then((m) => `${m} Resolved to ${JSON.stringify(hits.map((t) => t.ref))}.`);
    },
  },
  { title: 'Reload and verify', who: 'check', run: (x) => x.reload() },
];

export function CanvasHarness({ roomId, light }: { roomId?: string; light: boolean }) {
  const real = !!roomId && !!window.journey;
  const { user } = useStore(account);
  const actor = useRef<Actor>(YOU);
  const me = (): Actor => real ? { kind: 'human', id: user?.id ?? 'me', name: user?.name ?? 'You' } : actor.current;
  const transport = useMemo<CanvasTransport & { forget?(id: string): void }>(() => real ? ipcTransport(me) : memoryTransport(() => actor.current), [real]);
  const room = real ? roomId! : ROOM;
  const client = useMemo(() => new CanvasClient(room, transport), [room, transport]);
  useEffect(() => () => client.dispose(), [client]);
  const s = useStore(client.store);
  const [done, setDone] = useState<{ ok: boolean; text: string }[]>([]);
  const [busy, setBusy] = useState(false);

  const harness: Harness = {
    client,
    async as(who, name, args) {
      actor.current = who === 'vowe' && !real ? VOWE : YOU;
      try { return say(await client.run(name, args)); } finally { actor.current = YOU; }
    },
    async reload() {
      const before = client.state.saved;
      const fresh = new CanvasClient(room, real ? ipcTransport(me) : memoryTransport(() => YOU));
      const after = await fresh.reload();
      fresh.dispose();
      if (!after) throw new Error(`couldn’t read the room again: ${fresh.state.error}`);
      const same = JSON.stringify(after.doc) === JSON.stringify(before.doc);
      const scenes = JSON.stringify(buildScenes(after.doc)) === JSON.stringify(buildScenes(before.doc));
      const circles = Object.values(after.doc.annotations).filter((a) => a.kind === 'circle');
      return check(same && scenes && after.revision === before.revision,
        `Read again from ${real ? 'Supabase' : 'local storage'} at revision ${after.revision}: the same document, the same ${Object.keys(buildScenes(after.doc)).length} views, active view ${after.doc.activeView}, highlight on ${after.doc.highlight?.components.join(', ') || 'nothing'}, ${circles.length} circle${circles.length === 1 ? '' : 's'} around ${circles.flatMap((c) => c.kind === 'circle' ? c.refs.map((r) => r.component) : []).join(', ') || 'nothing'}.`,
        `the room read back differently: document ${same ? 'same' : 'differs'}, views ${scenes ? 'same' : 'differ'}, revision ${before.revision} → ${after.revision}`);
    },
  };

  const step = async (i: number) => {
    setBusy(true);
    try {
      const text = await STEPS[i].run(harness);
      setDone((d) => { const n = d.slice(0, i); n[i] = { ok: true, text }; return n; });
      return true;
    } catch (err) {
      setDone((d) => { const n = d.slice(0, i); n[i] = { ok: false, text: (err as Error).message }; return n; });
      return false;
    } finally { setBusy(false); }
  };
  const all = async () => { for (let i = 0; i < STEPS.length; i++) if (!(await step(i))) break; };
  const reset = async () => {
    if (real) return;
    transport.forget?.(ROOM);
    await client.reload();
    setDone([]);
  };
  const next = done.length;

  return (
    <div class="room-screen">
      <div class={'win in-call desk-open' + (light ? ' light' : '')}>
        <Lights />
        <main class="room">
          <div class="room-identity">
            <h1>Canvas harness</h1>
            <span class="q">{real ? `Room ${roomId} · Supabase` : 'In memory · this window’s storage'} · revision {s.saved.revision}{s.pending ? ` · ${s.pending} saving` : ''}</span>
          </div>
          <LiveSurface client={client}>
            {!Object.keys(s.doc.components).length && (
              <div class="fresh-empty">
                <span class="orb"></span>
                <b>Nothing drawn yet</b>
                <span>Run the steps, or draw on the canvas: every gesture is a Canvas Command.</span>
              </div>
            )}
          </LiveSurface>
        </main>
        <aside class="desk" aria-label="Harness steps">
          <div class="desk-inner">
            <p class="wnote">The payment scenario, one Canvas Command per step, through the same engine and surface as a real room.{real ? ' Vowe’s steps run as you: a renderer can only act as the signed-in person.' : ' Vowe’s steps run as Vowe, so they land as proposals.'}</p>
            <p class="wnote">
              <button class="mini strong" type="button" disabled={busy || next >= STEPS.length} onClick={() => { void step(next); }}>Run step {Math.min(next + 1, STEPS.length)}</button>
              <button class="mini" type="button" disabled={busy} onClick={() => { void all(); }}>Run all</button>
              {!real && <button class="mini ghost" type="button" disabled={busy} onClick={() => { void reset(); }}>Reset</button>}
              {!real && <button class="mini ghost" type="button" disabled={busy} onClick={() => { void harness.as('you', 'load_system', { ...ORDERS_SYSTEM, replace: true }); setDone([]); }}>Load a different system</button>}
            </p>
            <ol style="margin:0;padding:0;list-style:none">
              {STEPS.map((st, i) => (
                <li key={st.title}>
                  <p class="wnote">
                    <span class={'dot ' + (done[i] ? (done[i].ok ? 'live' : 'needs') : 'run')}></span>
                    <b>{i + 1}. {st.title}</b> · {st.who === 'check' ? 'check' : st.who === 'vowe' ? 'Vowe' : 'you'}
                  </p>
                  {done[i] && <p class="wnote" role={done[i].ok ? undefined : 'alert'}>{done[i].ok ? '' : 'Failed: '}{done[i].text}</p>}
                </li>
              ))}
            </ol>
            {s.error && <p class="wnote" role="alert">Last refusal: {s.error}</p>}
          </div>
        </aside>
      </div>
    </div>
  );
}
