import type { PersonId, Store } from '../journey.js';
import type { RoomFailure, RoomResult } from '../../../../shared/api.js';
import type { About, Notice, Reply, Thread, VoweRecord, Work } from '../contracts/model.js';
import type { VoweServices } from '../contracts/services.js';
import type { DeskAct } from '../desk/Desk.js';
import type { Attn } from '../state/attention.js';
import type { Names } from '../state/directory.js';
import { applyOp, decide as decideChange, openChanges } from '../state/plan.js';
import { maySign } from '../state/permissions.js';
import type { Ui } from '../state/ui.js';
import { openAttention, uiActions } from '../room/navigation.js';

// The production DeskAct: every record change goes through VoweServices and nothing else. Plan edits and
// change decisions apply locally first (the same pure functions the server should run), and roll back with
// the failure's message if the service refuses. Everything else waits for the service and re-reads the record.
// Nothing here approves, authorizes, signs or resolves on anyone's behalf: each of those is one person's click.

export interface HostDeps {
  roomId: string;
  ui: Ui;
  record: Store<VoweRecord>;
  services: VoweServices;
  names: Names;
  /** Light parts on the canvas (the Desk pointing at them). */
  light(parts: string[] | null): void;
  /** Journey's ShareDialog. */
  invite(): void;
  /** Open an https link in the system browser. */
  openExternal(url: string): void;
  /** The single selected canvas part, for a new thread about it. */
  selection(): { id: string; name: string } | null;
}

const MESSAGE: Record<RoomFailure['code'], string> = {
  'not-found': 'That isn’t in the room any more.',
  'permission-denied': 'Your role in this room doesn’t allow that.',
  invalid: 'That couldn’t be saved as it is.',
  conflict: 'Someone changed this while you were editing. You’re seeing their version now.',
  'signed-out': 'You’re signed out. Sign in again to keep working.',
  'not-configured': 'This room’s backend isn’t set up for that yet.',
  network: 'You’re offline. Nothing was saved.',
  unknown: 'That didn’t work. Nothing was saved.',
};

export function createDeskActions(d: HostDeps): DeskAct {
  const { roomId, ui, record, services: s, names } = d;
  const me = names.me;
  const nav = uiActions(ui, d.light);
  const r = () => record.state;
  const fail = (e: RoomFailure) => ui.setState({ toast: { text: e.message && e.code === 'invalid' ? e.message : MESSAGE[e.code] } });
  const reload = async () => { const x = await s.record.load(roomId); if (x.ok) record.setState(x.value); };
  /** Run a write; re-read the record either way so the Desk shows what's true. */
  async function run<T>(write: Promise<RoomResult<T>>): Promise<T | null> {
    const res = await write;
    await reload();
    if (!res.ok) { fail(res.error); return null; }
    return res.value;
  }
  /** Apply locally, then write; on failure put the record back. */
  async function optimistic<T>(local: (rec: VoweRecord) => Partial<VoweRecord>, write: () => Promise<RoomResult<T>>): Promise<T | null> {
    const before = r();
    record.setState(local(before));
    const res = await write();
    if (!res.ok) { record.setState(before); fail(res.error); if (res.error.code === 'conflict') await reload(); return null; }
    return res.value;
  }
  const work = (id: string) => r().work.find((w) => w.id === id);
  const upW = (rec: VoweRecord, id: string, f: (w: Work) => Partial<Work>): Partial<VoweRecord> => ({ work: rec.work.map((w) => (w.id === id ? { ...w, ...f(w) } : w)) });
  /** "@Name" in a comment asks that member directly. */
  const mentioned = (body: string): PersonId | undefined => {
    const m = /@(\w+)/.exec(body);
    if (!m) return undefined;
    return r().members.find((x) => x.who !== me && names.nameOf(x.who).toLowerCase().startsWith(m[1].toLowerCase()))?.who;
  };
  const thread = async (about: About, body: string, extra: { quote?: string; waiting?: PersonId } = {}) => {
    const res = await run(s.threads.create(roomId, { about, body, ...extra }));
    return res?.id ?? null;
  };

  const act: DeskAct = {
    ...nav,
    invite: d.invite,
    openExternal: (url) => { if (/^https:\/\//.test(url)) d.openExternal(url); },

    // Discuss
    // A message shows the moment it's sent; the write and the re-read follow, and a failure takes it back out.
    reply: (t, body, parent) => {
      if (t.startsWith('line:')) { const [, dec, line] = t.split(':'); void thread({ kind: 'line', id: line, decision: dec, name: 'Decision line' }, body); return; }
      const mine: Reply = { id: `local:${Date.now()}`, by: me, body, ago: 'now', ...(parent ? { parent } : {}) };
      void optimistic((rec) => ({ threads: rec.threads.map((x) => (x.id === t ? { ...x, replies: [...x.replies, mine] } : x)) }), () => s.threads.reply(roomId, t, body, parent))
        .then((ok) => { if (ok) void reload(); });
    },
    offer: (t, reply, accept) => void run(s.threads.answerOffer(roomId, t, reply, accept)),
    resolveThread: (t, reopen) => void run(s.threads.resolve(roomId, t, reopen)),
    // A new thread opens at once under a local id, which becomes the server's when it answers.
    newThread: (body) => {
      if (!body) return;
      const sel = d.selection();
      const about: About = sel ? { kind: 'part', id: sel.id, name: sel.name } : { kind: 'part', id: 'canvas', name: 'Canvas' };
      const waiting = mentioned(body), id = `local:${Date.now()}`;
      const mine: Thread = { id, about, status: 'open', replies: [{ id: `${id}:0`, by: me, body, ago: 'now' }], ...(waiting ? { waiting } : {}) };
      record.setState({ threads: [...r().threads, mine] });
      nav.thread(id);
      void s.threads.create(roomId, { about, body, ...(waiting ? { waiting } : {}) }).then(async (res) => {
        if (!res.ok) { record.setState({ threads: r().threads.filter((x) => x.id !== id) }); if (ui.state.thread === id) nav.thread(null); fail(res.error); return; }
        await reload();
        if (ui.state.thread === id) ui.setState({ thread: res.value.id });
      });
    },

    // Decide
    sign: (id) => { const dec = r().decisions.find((x) => x.id === id); if (dec) void run(s.decisions.sign(roomId, id, dec.version)); },
    askReview: (id) => {
      const dec = r().decisions.find((x) => x.id === id);
      if (!dec) return;
      if (dec.state === 'suggested') void run(s.decisions.setSuggested(roomId, id, 'draft'));
      else void run(s.decisions.requestSignatures(roomId, id, r().members.filter((m) => maySign(m.role) && m.who !== me).map((m) => m.who)));
    },
    askFor: (id, who) => void run(s.decisions.requestSignatures(roomId, id, who.filter((x) => x !== me))).then((ok) => {
      const others = who.filter((x) => x !== me);
      if (ok !== null) ui.setState({ toast: { text: others.length ? `Asked ${others.map(names.nameOf).join(', ')} to sign. It’s in their Inbox.` : 'It’s in review. Sign it when it’s ready.' } });
    }),
    takeEdit: (id, line, accept) => void run(s.decisions.takeSuggestion(roomId, id, line, accept)),
    dismissSuggested: (id) => void run(s.decisions.setSuggested(roomId, id, 'dismissed')),
    restoreDecision: (id) => void run(s.decisions.setSuggested(roomId, id, 'draft')),
    requestChanges: (id, text) => {
      const dec = r().decisions.find((x) => x.id === id);
      if (!dec) return;
      const i = ui.state.inspect;
      void run(s.decisions.requestChanges(roomId, id, dec.version, text)).then((ok) => {
        if (ok !== null && i?.kind === 'decision' && i.line) void thread({ kind: 'line', id: i.line, decision: id, name: 'Decision line' }, `Requested changes: ${text}`);
      });
    },
    amend: (id) => void run(s.decisions.amend(roomId, id)).then((x) => { if (x) nav.inspect({ kind: 'decision', id: x.id }); }),
    editLine: (id, line, text) => void run(s.decisions.editLine(roomId, id, line, text)),
    editDoc: (id, field, text) => void run(s.decisions.editDoc(roomId, id, field, text)),
    addLine: (id, kind, text) => void run(s.decisions.addLine(roomId, id, kind, text)),
    newDecision: (title, line) => void run(s.decisions.create(roomId, { title, line })).then((x) => { if (x) nav.inspect({ kind: 'decision', id: x.id }); }),
    draftFrom: (t) => {
      const th = r().threads.find((x) => x.id === t);
      void run(s.decisions.create(roomId, { title: th ? `Decide: ${th.about.name}` : 'New decision', from: t, problem: th?.replies[0]?.body })).then((x) => { if (x) nav.inspect({ kind: 'decision', id: x.id }); });
    },

    // Work
    prepareWork: (id) => {
      const dec = r().decisions.find((x) => x.id === id);
      if (!dec) return;
      void run(s.work.create(roomId, { title: dec.title, objective: dec.lines.find((l) => l.kind === 'decide')?.text ?? '', decision: id })).then((x) => { if (x) nav.inspect({ kind: 'work', id: x.id, section: 'plan' }); });
    },
    newWork: (title, objective) => void run(s.work.create(roomId, { title, objective })).then((x) => { if (x) nav.inspect({ kind: 'work', id: x.id, section: 'plan' }); }),
    plan: (w, op) => {
      const x = work(w);
      if (!x) return;
      void optimistic((rec) => upW(rec, w, (y) => applyOp(y, op, me)), () => s.work.plan(roomId, w, op, x.version));
    },
    editStep: (w, step, text) => act.plan(w, { op: 'edit', step, text }),
    chooseDoer: (w, doer) => act.plan(w, { op: 'doer', doer }),
    removeStep: (w, step, i) => {
      act.plan(w, { op: 'remove', step: step.id });
      ui.setState({ toast: { text: `Removed step ${i + 1}`, undo: () => act.plan(w, { op: 'restore', step, index: i }) } });
    },
    decide: (w, c, accept) => void optimistic((rec) => decideChange(rec, w, c, accept, me), () => s.work.decideChange(roomId, w, c, accept)),
    decideAll: (w, accept) => { const x = work(w); if (x) for (const c of openChanges(x)) act.decide(w, c.id, accept); },
    comment: (w, step, quote, body) => {
      const x = work(w);
      const n = (x?.plan.findIndex((p) => p.id === step) ?? 0) + 1;
      void thread({ kind: 'step', id: step, work: w, name: `Plan · step ${n}` }, body, { quote: quote || undefined, waiting: mentioned(body) }).then((id) => {
        if (id) ui.setState({ inspect: { kind: 'work', id: w, section: 'plan', thread: id } });
      });
    },
    discussCheck: (w, pr, check) => {
      const p = r().work.flatMap((y) => y.prs).find((y) => y.id === pr);
      const existing = r().threads.find((t) => t.about.kind === 'check' && t.about.pr === pr && t.about.id === check && t.status === 'open');
      if (existing) { ui.setState({ inspect: { kind: 'work', id: w, section: 'prs', pr } }); return; }
      void thread({ kind: 'check', id: check, pr, name: `#${p?.num ?? ''} · ${check}` }, `Looking at ${check}.`).then(() => ui.setState({ inspect: { kind: 'work', id: w, section: 'prs', pr } }));
    },
    authorize: (w) => {
      const x = work(w);
      if (!x) return;
      void run(s.work.authorize(roomId, w, x.version)).then(async (ok) => {
        if (ok === null) return;
        // Only a runner the room can reach starts here, and only because a person just authorized it.
        if (s.runs && x.doer?.kind === 'agent') { const started = await s.runs.start(roomId, w, x.version); await reload(); if (!started.ok) fail(started.error); }
        ui.setState({ toast: { text: `Plan v${x.version} is approved and frozen.${s.runs && x.doer?.kind === 'agent' ? ' The run is bound to it.' : ' Nothing runs by itself.'}` } });
      });
    },
    allowScope: (w, allow) => void run(s.work.allowScope(roomId, w, allow)),
    answer: (w, text) => { const q = work(w)?.question; if (q) void run(s.work.answer(roomId, w, q.id, text)); },
    defer: (w) => { const q = work(w)?.question; if (q) void run(s.work.defer(roomId, w, q.id)); },
    discussQuestion: (w) => {
      const x = work(w), q = x?.question;
      if (!x || !q) return;
      void thread({ kind: 'step', id: q.step ?? x.plan[0]?.id ?? w, work: w, name: 'Plan · the agent’s question' }, q.text, { waiting: me }).then((id) => { if (id) nav.thread(id); });
    },
    takeFinding: (w) => {
      const x = work(w), runNow = x?.runs.at(-1);
      if (!s.runs || !x?.finding || !runNow) return;
      void run(s.runs.note(roomId, w, runNow.id, x.finding.text));
    },
    askFix: (w, pr, check) => {
      const x = work(w), runNow = x?.runs.at(-1), p = x?.prs.find((y) => y.id === pr);
      if (!s.runs || !runNow) return;
      void run(s.runs.note(roomId, w, runNow.id, `Look at ${check} on #${p?.num ?? ''}, inside plan v${runNow.plan}.`)).then((ok) => { if (ok !== null) ui.setState({ toast: { text: `Sent to ${runNow.agent} as a note on its run. It stays inside the approved plan.` } }); });
    },
    stopRun: (w) => {
      const runNow = work(w)?.runs.at(-1);
      if (!s.runs || !runNow) return;
      void run(s.runs.stop(roomId, w, runNow.id)).then((ok) => { if (ok !== null) ui.setState({ toast: { text: `${runNow.agent} will stop after its current step.` } }); });
    },
    resolve: (w) => void run(s.work.resolve(roomId, w)),

    // Attention
    markDone: (ids) => void optimistic((rec) => ({ done: [...rec.done, ...ids] }), () => s.attention.markDone(roomId, ids)),
    notice: (n: Notice | Attn) => {
      if (!('kind' in n)) return;
      openAttention(ui, r(), n);
      act.markDone([n.id]);
    },
    renameAgent: (name) => {
      if (!s.settings) { ui.setState({ toast: { text: 'Renaming the assistant isn’t available in this room yet.' } }); return; }
      void run(s.settings.agentName(roomId, name)).then((ok) => { if (ok !== null) ui.setState({ toast: { text: name ? `The assistant is now called ${name} in this workspace.` : 'The assistant is called Vowe again.' } }); });
    },
    sinceShow: () => {
      const parts = [...new Set((r().since?.items ?? []).flatMap((i) => i.parts ?? []))];
      d.light(parts);
      ui.setState({ sinceOpen: false });
      setTimeout(() => d.light(null), 2600);
    },
  };
  return act;
}
