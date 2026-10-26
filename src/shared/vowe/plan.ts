import type { RoomRole, Change, PlanBody, VoweRecord, Step, Work } from './model.js';
import type { RoomRole as Role } from '../api.js';

/** Owners and members edit the record (Journey's edit_canvas ability, features/membership/model.ts). */
const can = (role: Role | null | undefined, _ability: 'edit_canvas') => role === 'owner' || role === 'member';

// Plan operations: pure functions over the room's record. A plan is a versioned document. The working
// copy is `work.version`; approved versions are frozen in `work.versions`. The first edit after a
// snapshot opens the next version as a draft, so an approval is never changed underneath anyone.

export const bodyOf = (w: Work): PlanBody => ({ objective: w.why, plan: w.plan, may: w.may, mayNot: w.mayNot, askWhen: w.askWhen, accept: w.accept });
export const approvedOf = (w: Work) => [...w.versions].reverse().find((v) => v.approved);
export const isDraft = (w: Work) => !w.versions.some((v) => v.version === w.version);
export const openChanges = (w: Work) => w.revision?.changes.filter((c) => c.state === 'open') ?? [];
/** Can the plan be authorized as it stands? Returns the reason it can't, or null. */
export function blockedWhy(w: Work, role: RoomRole): string | null {
  if (!can(role, 'edit_canvas')) return 'Viewers can read the plan but can’t authorize it';
  if (!w.doer) return 'Choose who does it first';
  if (openChanges(w).length) return `${openChanges(w).length} suggested change${openChanges(w).length > 1 ? 's' : ''} still need a decision`;
  const ap = approvedOf(w);
  if (ap && ap.version === w.version) return null;
  return null;
}

let n = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(n++).toString(36)}`;

/** Record an edit: opens the next draft version if the working copy is a snapshot, and logs who did it. */
function touch(w: Work, who: string, text: string): Partial<Work> {
  const bump = !isDraft(w);
  const next = bump ? Math.max(...w.versions.map((v) => v.version)) + 1 : w.version;
  const last = w.log[w.log.length - 1];
  const log = last && last.who === who && last.text === text ? w.log : [...w.log, { who, text, ago: 'now' }];
  return { version: next, log };
}

export type PlanOp =
  | { op: 'edit'; step: string; text: string }
  | { op: 'add'; after: string | null; text?: string }
  | { op: 'remove'; step: string }
  | { op: 'restore'; step: Step; index: number }
  | { op: 'move'; step: string; to: number }
  | { op: 'split'; step: string; at?: number }
  | { op: 'objective'; text: string }
  | { op: 'list'; list: 'may' | 'mayNot' | 'askWhen' | 'accept'; index: number; text: string | null }
  | { op: 'doer'; doer: Work['doer'] }
  | { op: 'prs'; prs: Work['exec']['prs'] }
  | { op: 'state'; step: string; state: Step['state'] }
  | { op: 'pr'; step: string; pr: string }
  | { op: 'revise' };

const LIST_WORD = { may: 'what it may do', mayNot: 'what it must not do', askWhen: 'when it must ask', accept: 'verification' };

export function applyOp(w: Work, op: PlanOp, who: string): Partial<Work> {
  const i = (id: string) => w.plan.findIndex((s) => s.id === id);
  switch (op.op) {
    case 'edit': {
      const s = w.plan[i(op.step)];
      if (!s || s.text === op.text) return {};
      return { ...touch(w, who, `Edited step ${i(op.step) + 1}`), plan: w.plan.map((x) => x.id === op.step ? { ...x, text: op.text, edited: who } : x) };
    }
    case 'add': {
      const at = op.after === null ? 0 : i(op.after) + 1;
      const plan = [...w.plan];
      plan.splice(at, 0, { id: uid('s'), text: op.text ?? '', by: { who, how: 'stated' }, state: 'todo' });
      return { ...touch(w, who, `Added step ${at + 1}`), plan };
    }
    case 'remove': return { ...touch(w, who, `Removed step ${i(op.step) + 1}`), plan: w.plan.filter((s) => s.id !== op.step) };
    case 'restore': { const plan = [...w.plan]; plan.splice(op.index, 0, op.step); return { ...touch(w, who, `Restored step ${op.index + 1}`), plan }; }
    case 'move': {
      const from = i(op.step);
      const to = Math.max(0, Math.min(w.plan.length - 1, op.to));
      if (from < 0 || from === to) return {};
      const plan = [...w.plan];
      const [s] = plan.splice(from, 1);
      plan.splice(to, 0, s);
      return { ...touch(w, who, `Moved step ${from + 1} to ${to + 1}`), plan };
    }
    case 'split': {
      // At the caret when editing; otherwise at a sentence or clause boundary; with none, a new empty step to write.
      const k = i(op.step);
      const s = w.plan[k];
      if (!s) return {};
      let at = op.at ?? -1;
      if (at <= 0 || at >= s.text.length - 1) {
        const m = /(; |\. |, then | then )/.exec(s.text.slice(6));
        at = m ? m.index + 6 + (m[0].startsWith('.') ? 1 : 0) : -1;
      }
      const plan = [...w.plan];
      if (at < 0) {
        plan.splice(k + 1, 0, { id: uid('s'), text: '', by: { who, how: 'stated' }, state: 'todo' });
        return { ...touch(w, who, `Split step ${k + 1}`), plan };
      }
      const a = s.text.slice(0, at).replace(/[;,\s]+(then)?\s*$/, '').trim();
      let b = s.text.slice(at).replace(/^[;,.\s]*(then)?\s*/i, '').trim();
      b = b.charAt(0).toUpperCase() + b.slice(1);
      plan.splice(k, 1, { ...s, text: /[.;]$/.test(a) ? a : a + '.', edited: who }, { id: uid('s'), text: b, by: { who, how: 'edited' }, state: 'todo' });
      return { ...touch(w, who, `Split step ${k + 1}`), plan };
    }
    case 'objective': return w.why === op.text ? {} : { ...touch(w, who, 'Edited the objective'), why: op.text };
    case 'list': {
      const cur = [...w[op.list]];
      if (op.text === null) cur.splice(op.index, 1);
      else if (op.index >= cur.length) cur.push(op.text);
      else cur[op.index] = op.text;
      return { ...touch(w, who, `Changed ${LIST_WORD[op.list]}`), [op.list]: cur } as Partial<Work>;
    }
    case 'doer': return { doer: op.doer };
    case 'prs': return { exec: { ...w.exec, prs: op.prs } };
    case 'state': return { plan: w.plan.map((s) => s.id === op.step ? { ...s, state: op.state } : s) };
    case 'revise': return isDraft(w) ? {} : touch(w, who, `Started revising (v${Math.max(...w.versions.map((v) => v.version)) + 1})`);
    case 'pr': return { plan: w.plan.map((s) => s.id === op.step ? { ...s, pr: op.pr } : s) };
  }
}

/** Accept or reject one suggested change. Promoting a step creates the dependent work item. */
export function decide(r: VoweRecord, workId: string, changeId: string, accept: boolean, who: string): Partial<VoweRecord> {
  const w = r.work.find((x) => x.id === workId);
  const c = w?.revision?.changes.find((x) => x.id === changeId);
  if (!w || !c || c.state !== 'open') return {};
  let next: Work = { ...w, revision: { ...w.revision!, changes: w.revision!.changes.map((x) => x.id === changeId ? { ...x, state: accept ? 'accepted' : 'rejected', decidedBy: who } : x) } };
  let extra: Work | null = null;
  if (accept) {
    const by = { who: w.revision!.by, how: 'edited' as const };
    const idx = (id?: string) => next.plan.findIndex((s) => s.id === id);
    if (c.kind === 'edit') next = { ...next, ...touch(next, who, `Took the suggested edit to step ${idx(c.step) + 1}`), plan: next.plan.map((s) => s.id === c.step ? { ...s, text: c.text!, edited: w.revision!.by } : s) };
    if (c.kind === 'add') { const plan = [...next.plan]; plan.splice(c.after === null ? 0 : idx(c.after!) + 1, 0, { id: 'n' + c.id, text: c.text!, by, state: 'todo' }); next = { ...next, ...touch(next, who, 'Took the suggested new step'), plan }; }
    if (c.kind === 'remove') next = { ...next, ...touch(next, who, 'Took the suggested removal'), plan: next.plan.filter((s) => s.id !== c.step) };
    if (c.kind === 'move') { const plan = [...next.plan]; const from = idx(c.step); const [s] = plan.splice(from, 1); plan.splice(c.after === null ? 0 : plan.findIndex((x) => x.id === c.after) + 1, 0, s); next = { ...next, ...touch(next, who, 'Took the suggested reorder'), plan }; }
    if (c.kind === 'bound' && c.list) next = { ...next, ...touch(next, who, `Changed ${LIST_WORD[c.list]}`), [c.list]: [...next[c.list], c.text!] };
    if (c.kind === 'verify') next = { ...next, ...touch(next, who, 'Added a verification check'), accept: [...next.accept, c.text!] };
    if (c.kind === 'promote') {
      const id = c.seed?.id ?? `${w.id}-${c.id}`;
      const at = w.plan.findIndex((s) => s.id === c.step) + 1;
      extra = {
        id, title: c.title!, why: c.seed?.why ?? c.note ?? '', decision: w.decision, thread: w.revision!.from, repo: w.repo,
        parts: c.seed?.parts ?? [], owner: w.owner, doer: w.doer, state: 'proposed', ago: 'now', blocks: w.id,
        plan: [{ id: 'k1', text: c.text!, by, state: 'todo' }],
        may: c.seed?.may ?? [], mayNot: c.seed?.mayNot ?? [...w.mayNot], askWhen: c.seed?.askWhen ?? [], accept: c.seed?.accept ?? [],
        context: [{ id: 'y1', kind: 'work', label: w.title, sub: 'depends on this', target: w.id }, ...w.context.filter((x) => x.kind === 'decision')],
        version: 1, versions: [{ version: 1, by: [w.revision!.by, who], ago: 'now', body: { objective: '', plan: [], may: [], mayNot: [], askWhen: [], accept: [] } }],
        exec: { where: w.exec.where, prs: 'per-step' }, log: [{ who, text: `Split from ${w.title}, step ${at}`, ago: 'now' }], runs: [], prs: [],
      };
      extra.versions[0].body = bodyOf(extra);
      const plan = [...next.plan];
      plan.splice(idx(c.step), 0, { id: 's2a', text: c.title!, by, state: 'todo', promoted: id });
      next = { ...next, ...touch(next, who, 'Split the schema into its own work item'), plan, dependsOn: id };
    }
  }
  let threads = r.threads;
  if (next.revision && next.revision.changes.every((x) => x.state !== 'open')) {
    next = { ...next, log: [...next.log, { who, text: `Finished reviewing the ${next.revision.changes.length} suggestions`, ago: 'now' }] };
    threads = r.threads.map((t) => t.id === next.revision!.from ? { ...t, status: 'resolved' as const } : t);
  }
  const work = r.work.map((x) => x.id === workId ? next : x);
  return { threads, work: extra && !work.some((x) => x.id === extra!.id) ? [...work.slice(0, work.findIndex((x) => x.id === workId)), extra, ...work.slice(work.findIndex((x) => x.id === workId))] : work };
}

/** Authorize: freeze the working copy as an approved version (and any dependent proposed work it includes). */
export function approve(r: VoweRecord, workId: string, who: string): Partial<VoweRecord> {
  const w = r.work.find((x) => x.id === workId);
  if (!w || !w.doer) return {};
  const dep = r.work.find((x) => x.id === w.dependsOn && x.state === 'proposed');
  const snap = (x: Work, includes?: string[]): Work => {
    const scope = x.may.filter((m) => /^Edit /.test(m)).map((m) => m.replace(/^Edit /, '')).join(' · ') + ' · draft PRs';
    const approved = { by: who, ago: 'now', doer: w.doer!.name, scope, includes };
    const versions = x.versions.some((v) => v.version === x.version) ? x.versions.map((v) => v.version === x.version ? { ...v, approved } : v) : [...x.versions, { version: x.version, by: [...new Set(x.log.map((l) => l.who))], ago: 'now', approved, body: bodyOf(x) }];
    const runs = w.doer!.kind === 'person' ? x.runs : x.runs.length && x.runs[x.runs.length - 1].state !== 'finished'
      ? x.runs.map((r0, k) => k === x.runs.length - 1 ? { ...r0, plan: x.version, events: [...r0.events, { text: `Now working from plan v${x.version}`, ago: 'now', kind: 'git' as const }] } : r0)
      : [...x.runs, { id: 'run-' + x.id, agent: w.doer!.name, where: x.exec.where.replace(/ on .*/, ''), state: 'running' as const, plan: x.version, events: [{ text: `Started plan v${x.version} in ${x.exec.where.replace(/ on .*/, '')}`, ago: 'now', kind: 'git' as const }] }];
    return { ...x, doer: x.doer ?? w.doer, versions, revision: undefined, state: x.state === 'proposed' || x.state === 'draft' ? 'running' : x.state, authorized: { by: who, ago: 'now', scope }, runs, log: [...x.log, { who, text: `Authorized ${w.doer!.name} to run v${x.version}`, ago: 'now' }] };
  };
  return { work: r.work.map((x) => x.id === workId ? snap(x, dep ? [dep.title] : undefined) : dep && x.id === dep.id ? snap(x) : x) };
}

/** Word-level diff, for showing a suggested edit in place. */
export function wordDiff(a: string, b: string): { t: string; k: 'same' | 'del' | 'add' }[] {
  const A = a.split(/(\s+)/), B = b.split(/(\s+)/);
  const L = Array.from({ length: A.length + 1 }, () => new Array<number>(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: { t: string; k: 'same' | 'del' | 'add' }[] = [];
  let i = 0, j = 0;
  const push = (t: string, k: 'same' | 'del' | 'add') => { const l = out[out.length - 1]; if (l && l.k === k) l.t += t; else out.push({ t, k }); };
  while (i < A.length && j < B.length) { if (A[i] === B[j]) { push(A[i], 'same'); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) push(A[i++], 'del'); else push(B[j++], 'add'); }
  while (i < A.length) push(A[i++], 'del');
  while (j < B.length) push(B[j++], 'add');
  return out;
}

export type { Change };
