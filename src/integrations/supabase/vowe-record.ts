import { randomUUID } from 'node:crypto';
import type { RoomErrorCode } from '../../shared/api.js';
import type { About, Change, Step, VoweRecord, Work } from '../../shared/vowe/model.js';
import { applyOp, decide, type PlanOp } from '../../shared/vowe/plan.js';
import { isUuid, parseDecisionVersionId } from '../../shared/vowe/ids.js';
import type { Cloud } from './index.js';
import { RoomError, toRoomError } from './rooms.js';
import { toVoweRecord, type MapOptions, type RawVoweRecord } from './vowe-map.js';

/**
 * The Vowe room's record, as the signed-in member (supabase/migrations/*_vowe_room_work.sql). Every write is
 * one SECURITY DEFINER function there, which checks who may do it, sets authors and versions, guards signed
 * decisions and approved plans, logs activity and tells the room's channel. This module shapes calls,
 * checks input before it leaves, and runs the shared plan operations (shared/vowe/plan.ts) against the row
 * it read, under the database's version guard.
 *
 * `actorKind: 'agent'` saves Vowe's content from this person's session (theirs, shown as Vowe's), like
 * record:reply. The database refuses it for signing, asking for signatures, accepting changes, authorizing,
 * allowing scope and resolving.
 */

export type VoweRecordService = ReturnType<typeof createVoweRecordService>;
export type ActorKind = 'human' | 'agent';

/** A thread on anything the Desk shows. */
export interface VoweThreadInput { about: About; body: string; quote?: string; at?: { x: number; y: number }; waiting?: string }
export interface VoweOffer { kind: 'decision' | 'work' | 'revision' | 'edit'; text: string; target?: string }
export type VoweChangeInput = Omit<Change, 'id' | 'state' | 'decidedBy'>;

const ABOUT_KINDS: About['kind'][] = ['part', 'edge', 'scenario', 'decision', 'line', 'work', 'step', 'pr', 'check'];
const LINE_KINDS = ['decide', 'because', 'assume', 'open', 'scope'] as const;
const CHANGE_KINDS: Change['kind'][] = ['edit', 'add', 'remove', 'move', 'promote', 'bound', 'verify'];
const PR_STATES = ['draft', 'open', 'review', 'changes', 'merged', 'closed'] as const;
const PLAN_KEYS = ['why', 'plan', 'may', 'mayNot', 'askWhen', 'accept', 'doer', 'exec'] as const;
/** Times main re-reads and re-applies a plan op when the row moved under it (VW412). */
const RETRIES = 3;

// ─── Errors ──────────────────────────────────────────────────────────────────

const VOWE_CODES: Record<string, RoomErrorCode> = {
  VW404: 'not-found', VW403: 'permission-denied', VW409: 'conflict', VW422: 'invalid', VW412: 'conflict',
};

/** The vowe_* functions' errors carry a reason worth showing; everything else maps as rooms do. */
export function toVoweError(error: unknown): RoomError {
  const e = (error ?? {}) as { code?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? VOWE_CODES[e.code] : undefined;
  if (code) return new RoomError(code, typeof e.message === 'string' && e.message ? e.message : 'That isn’t allowed');
  return toRoomError(error);
}

// ─── Input checks (the database checks again) ────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function requireUuid(value: unknown, what: string): string {
  if (!isUuid(value)) throw new RoomError('invalid', `${what} id isn’t valid`);
  return value.toLowerCase();
}

export function requireText(value: unknown, what: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string') throw new RoomError('invalid', `${what} must be text`);
  const t = value.trim();
  if (!t && !allowEmpty) throw new RoomError('invalid', `${what} must not be empty`);
  if (t.length > max) throw new RoomError('invalid', `${what} must be at most ${max} characters`);
  return t;
}

const optionalText = (value: unknown, what: string, max: number) => (value === undefined || value === null || value === '' ? null : requireText(value, what, max));

export function requireActor(value: unknown): ActorKind {
  if (value === undefined) return 'human';
  if (value !== 'human' && value !== 'agent') throw new RoomError('invalid', 'Author must be a person or Vowe');
  return value;
}

export function requireVersion(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1) throw new RoomError('invalid', 'Version must be a positive whole number');
  return value as number;
}

/** A decision id as the Desk names it: the database id and the version it read. */
export function requireDecision(id: unknown): { decisionId: string; version: number } {
  const parsed = typeof id === 'string' ? parseDecisionVersionId(id) : null;
  if (!parsed) throw new RoomError('invalid', 'Decision id isn’t valid');
  return parsed;
}

export function aboutArg(about: unknown): Record<string, string> {
  if (!isRecord(about) || !ABOUT_KINDS.includes(about.kind as About['kind'])) throw new RoomError('invalid', 'A thread must be about something the room shows');
  const out: Record<string, string> = {
    kind: about.kind as string, id: requireText(about.id, 'Subject id', 200), name: requireText(about.name, 'Subject name', 200),
  };
  const parent = about.kind === 'line' ? about.decision : about.kind === 'step' ? about.work : about.kind === 'check' ? about.pr : undefined;
  if (parent !== undefined || ['line', 'step', 'check'].includes(out.kind)) {
    out[about.kind === 'line' ? 'decision' : about.kind === 'step' ? 'work' : 'pr'] = requireText(parent, 'What it belongs to', 200);
  }
  return out;
}

export function offerArg(offer: unknown): VoweOffer | null {
  if (offer === undefined || offer === null) return null;
  if (!isRecord(offer) || !['decision', 'work', 'revision', 'edit'].includes(offer.kind as string)) throw new RoomError('invalid', 'An offer needs a kind and its text');
  const out: VoweOffer = { kind: offer.kind as VoweOffer['kind'], text: requireText(offer.text, 'Offer', 1000) };
  const target = optionalText(offer.target, 'Offer target', 200);
  if (target) out.target = target;
  return out;
}

export function changesArg(changes: unknown): Record<string, unknown>[] {
  if (!Array.isArray(changes) || !changes.length || changes.length > 50) throw new RoomError('invalid', 'A revision has between 1 and 50 changes');
  return changes.map((c) => {
    if (!isRecord(c) || !CHANGE_KINDS.includes(c.kind as Change['kind'])) throw new RoomError('invalid', 'Unknown change kind');
    const out: Record<string, unknown> = { kind: c.kind };
    for (const k of ['step', 'text', 'list', 'title', 'note'] as const) {
      const v = optionalText(c[k], `Change ${k}`, k === 'text' ? 4000 : k === 'title' ? 500 : 2000);
      if (v !== null) out[k] = v;
    }
    if ('after' in c) out.after = c.after === null ? null : requireText(c.after, 'Change position', 100);
    // The new work item's id is the database's (main chooses it when the change is accepted), never the proposer's.
    if (isRecord(c.seed)) { const { id: _ignored, ...seed } = c.seed; out.seed = seed; }
    if (c.kind === 'bound' && !['may', 'mayNot', 'askWhen'].includes(out.list as string)) throw new RoomError('invalid', 'A boundary change names its list');
    if (['edit', 'add', 'bound', 'verify', 'promote'].includes(c.kind as string) && !out.text) throw new RoomError('invalid', 'That change needs its text');
    if (c.kind === 'promote' && !out.title) throw new RoomError('invalid', 'A promoted step needs a title');
    return out;
  });
}

/** What changed in a plan's working copy, as vowe_save_plan takes it. Steps that are new get you as author. */
export function planPatch(before: Work, after: Partial<Work>, me: string): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const k of PLAN_KEYS) {
    if (!(k in after) || JSON.stringify(after[k]) === JSON.stringify(before[k])) continue;
    patch[k] = after[k];
  }
  if (Array.isArray(patch.plan)) {
    const known = new Map(before.plan.map((s) => [s.id, s]));
    patch.plan = (patch.plan as Step[]).map((s) => {
      const was = known.get(s.id);
      const step: Record<string, unknown> = { id: s.id, text: s.text, state: s.state ?? 'todo', by: was?.by ?? { who: me, how: 'stated' } };
      if (s.pr) step.pr = s.pr;
      if (s.promoted) step.promoted = s.promoted;
      if (was && was.text !== s.text) step.edited = me;
      else if (was?.edited) step.edited = was.edited;
      return step;
    });
  }
  return patch;
}

/** The log line an op added, if any. */
function addedLine(before: Work, after: Partial<Work>): string | null {
  const log = after.log;
  if (!log || log.length <= before.log.length) return null;
  return log.slice(before.log.length).map((l) => l.text).find((t) => !/^Finished reviewing/.test(t)) ?? null;
}

/** A plan op as it arrives over IPC: only the known shapes, with bounded text. */
export function requirePlanOp(op: unknown): PlanOp {
  if (!isRecord(op)) throw new RoomError('invalid', 'A plan edit must be an object');
  const step = () => requireText(op.step, 'Step', 100);
  const text = (max = 4000) => requireText(op.text, 'Text', max, true);
  switch (op.op) {
    case 'edit': return { op: 'edit', step: step(), text: text() };
    case 'add': return { op: 'add', after: op.after === null ? null : requireText(op.after, 'Step', 100), ...(op.text === undefined ? {} : { text: text() }) };
    case 'remove': return { op: 'remove', step: step() };
    case 'restore': {
      const s = op.step;
      if (!isRecord(s) || !Number.isInteger(op.index) || (op.index as number) < 0) throw new RoomError('invalid', 'A restored step needs its place');
      return { op: 'restore', index: op.index as number, step: { id: requireText(s.id, 'Step', 100), text: requireText(s.text, 'Text', 4000, true), state: 'todo', by: { who: '' } } };
    }
    case 'move': if (!Number.isInteger(op.to)) throw new RoomError('invalid', 'Where to move it'); return { op: 'move', step: step(), to: op.to as number };
    case 'split': return { op: 'split', step: step(), ...(Number.isInteger(op.at) ? { at: op.at as number } : {}) };
    case 'objective': return { op: 'objective', text: text() };
    case 'list': {
      if (!['may', 'mayNot', 'askWhen', 'accept'].includes(op.list as string) || !Number.isInteger(op.index) || (op.index as number) < 0) throw new RoomError('invalid', 'Which list and where');
      return { op: 'list', list: op.list as 'may', index: op.index as number, text: op.text === null ? null : requireText(op.text, 'Text', 1000) };
    }
    case 'doer': {
      if (op.doer === null) return { op: 'doer', doer: null };
      if (!isRecord(op.doer) || !['agent', 'person'].includes(op.doer.kind as string)) throw new RoomError('invalid', 'Who does it: an agent or a person');
      return { op: 'doer', doer: { kind: op.doer.kind as 'agent', name: requireText(op.doer.name, 'Name', 100) } };
    }
    case 'prs': if (op.prs !== 'per-step' && op.prs !== 'grouped') throw new RoomError('invalid', 'PRs: per step or grouped'); return { op: 'prs', prs: op.prs };
    case 'state': if (!['todo', 'doing', 'done', 'wont'].includes(op.state as string)) throw new RoomError('invalid', 'Unknown step state'); return { op: 'state', step: step(), state: op.state as Step['state'] };
    case 'pr': return { op: 'pr', step: step(), pr: requireText(op.pr, 'PR', 100) };
    case 'revise': return { op: 'revise' };
  }
  throw new RoomError('invalid', 'Unknown plan edit');
}

// ─── The service ─────────────────────────────────────────────────────────────

/** The vowe_* functions and tables aren't in the generated types (types.ts comes from the hosted project). */
interface Untyped {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>;
  from(table: string): {
    select(cols: string): {
      eq(col: string, v: string): { eq(col: string, v: string): { maybeSingle(): PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }> } };
    };
  };
}

export function createVoweRecordService(client: () => Promise<Cloud>) {
  async function signedIn(): Promise<{ db: Untyped; me: string }> {
    const supabase = await client();
    const { data, error } = await supabase.auth.getSession();
    if (error) throw toRoomError(error);
    if (!data.session) throw new RoomError('signed-out', 'Sign in to use rooms');
    return { db: supabase as unknown as Untyped, me: data.session.user.id };
  }

  /** One call as the signed-in person; arguments are checked before anything is sent. */
  async function send<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { db } = await signedIn();
    return call<T>(db, fn, args);
  }

  async function call<T = unknown>(db: Untyped, fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await db.rpc(fn, args);
    if (error) throw toVoweError(error);
    return data as T;
  }

  /** Not-found unless the decision is in this room (and you can see it). */
  async function inRoom(db: Untyped, table: 'room_decisions' | 'room_work', roomId: string, id: string): Promise<void> {
    const { data, error } = await db.from(table).select('id').eq('id', id).eq('room_id', roomId).maybeSingle();
    if (error) throw toVoweError(error);
    if (!data) throw new RoomError('not-found', table === 'room_work' ? 'No such work in this room' : 'No such decision in this room');
  }

  async function raw(db: Untyped, roomId: string): Promise<RawVoweRecord> {
    const data = await call<RawVoweRecord | null>(db, 'vowe_record', { room: roomId });
    if (!data || !data.room) throw new RoomError('not-found', 'No such room, or you are not a member of it');
    return data;
  }

  async function decisionOp(roomId: unknown, id: unknown, fn: string, args: Record<string, unknown>): Promise<void> {
    const room = requireUuid(roomId, 'Room');
    const d = requireDecision(id);
    const { db } = await signedIn();
    await inRoom(db, 'room_decisions', room, d.decisionId);
    await call(db, fn, { decision: d.decisionId, ver: d.version, ...args });
  }

  async function workOp<T = void>(roomId: unknown, workId: unknown, fn: string, args: Record<string, unknown>): Promise<T> {
    const room = requireUuid(roomId, 'Room');
    const work = requireUuid(workId, 'Work');
    const { db } = await signedIn();
    await inRoom(db, 'room_work', room, work);
    return call<T>(db, fn, { work, ...args });
  }

  /** Reads the room, applies `step` to the work as read, and saves it; again if the row moved meanwhile. */
  async function onWork(roomId: unknown, workId: unknown, step: (rec: VoweRecord, w: Work, rev: number, db: Untyped, me: string) => Promise<void>): Promise<void> {
    const room = requireUuid(roomId, 'Room');
    const work = requireUuid(workId, 'Work');
    const { db, me } = await signedIn();
    for (let attempt = 1; ; attempt++) {
      const r = await raw(db, room);
      const row = r.work.find((w) => w.id === work);
      if (!row) throw new RoomError('not-found', 'No such work in this room');
      const rec = toVoweRecord(r);
      try {
        await step(rec, rec.work.find((w) => w.id === work)!, row.rev, db, me);
        return;
      } catch (err) {
        const moved = (err as { code?: unknown })?.code === 'conflict' && /changed while it was being saved/.test(String((err as Error).message));
        if (!moved || attempt >= RETRIES) throw err;
      }
    }
  }

  return {
    async load(roomId: string, opts: Pick<MapOptions, 'agents'> = {}): Promise<VoweRecord> {
      const room = requireUuid(roomId, 'Room');
      const { db } = await signedIn();
      return toVoweRecord(await raw(db, room), opts);
    },

    // Threads (replies without offers and resolving stay on record:reply / record:resolve).
    async createThread(roomId: string, t: VoweThreadInput, actorKind: ActorKind = 'human'): Promise<{ id: string }> {
      const room = requireUuid(roomId, 'Room');
      if (!isRecord(t)) throw new RoomError('invalid', 'A thread needs a subject and some text');
      const at = isRecord(t.at) && Number.isFinite(t.at.x) && Number.isFinite(t.at.y) ? t.at : null;
      const id = await send<string>('vowe_create_thread', {
        room, about: aboutArg(t.about), body: requireText(t.body, 'Thread text', 4000), quote: optionalText(t.quote, 'Quote', 2000),
        at_x: at?.x ?? null, at_y: at?.y ?? null, waiting_on: isUuid(t.waiting) ? t.waiting : null, actor_kind: requireActor(actorKind),
      });
      return { id };
    },

    async reply(roomId: string, threadId: string, body: string, actorKind: ActorKind = 'human', offer?: VoweOffer | null): Promise<{ id: string }> {
      const room = requireUuid(roomId, 'Room');
      const id = await send<string>('vowe_reply', {
        room, thread: requireUuid(threadId, 'Thread'), body: requireText(body, 'Reply', 4000), actor_kind: requireActor(actorKind), offer: offerArg(offer),
      });
      return { id };
    },

    async answerOffer(roomId: string, threadId: string, replyId: string, accept: boolean): Promise<void> {
      const room = requireUuid(roomId, 'Room');
      await send('vowe_answer_offer', { room, thread: requireUuid(threadId, 'Thread'), reply: requireUuid(replyId, 'Reply'), accept: accept === true });
    },

    async linkThread(roomId: string, threadId: string, about: About): Promise<void> {
      const room = requireUuid(roomId, 'Room');
      await send('vowe_link_thread', { room, thread: requireUuid(threadId, 'Thread'), about: aboutArg(about) });
    },

    // Decisions
    async createDecision(roomId: string, d: { title: string; line?: string; from?: string; problem?: string }, actorKind: ActorKind = 'human'): Promise<{ id: string }> {
      const room = requireUuid(roomId, 'Room');
      if (!isRecord(d)) throw new RoomError('invalid', 'A decision needs a title');
      const id = await send<string>('vowe_create_decision', {
        room, title: requireText(d.title, 'Decision', 500), line: optionalText(d.line, 'Decision line', 2000),
        from_thread: d.from === undefined || d.from === null ? null : requireUuid(d.from, 'Thread'), problem: optionalText(d.problem, 'Problem', 4000),
        actor_kind: requireActor(actorKind),
      });
      return { id };
    },

    async addLine(roomId: string, decisionId: string, kind: (typeof LINE_KINDS)[number], text: string, actorKind: ActorKind = 'human'): Promise<{ id: string }> {
      if (!LINE_KINDS.includes(kind)) throw new RoomError('invalid', 'Unknown line kind');
      const room = requireUuid(roomId, 'Room');
      const d = requireDecision(decisionId);
      const { db } = await signedIn();
      await inRoom(db, 'room_decisions', room, d.decisionId);
      const id = await call<string>(db, 'vowe_add_line', { decision: d.decisionId, ver: d.version, kind, body: requireText(text, 'Line', 2000), actor_kind: requireActor(actorKind) });
      return { id };
    },

    editLine: async (roomId: string, decisionId: string, lineId: string, text: string, actorKind: ActorKind = 'human') =>
      decisionOp(roomId, decisionId, 'vowe_edit_line', { line: requireUuid(lineId, 'Line'), body: requireText(text, 'Line', 2000), actor_kind: requireActor(actorKind) }),

    suggestLine: async (roomId: string, decisionId: string, lineId: string, text: string, why: string, actorKind: ActorKind = 'human') =>
      decisionOp(roomId, decisionId, 'vowe_suggest_line', {
        line: requireUuid(lineId, 'Line'), body: requireText(text, 'Suggested text', 2000), why: requireText(why ?? '', 'Why', 2000, true), actor_kind: requireActor(actorKind),
      }),

    takeSuggestion: async (roomId: string, decisionId: string, lineId: string, accept: boolean) =>
      decisionOp(roomId, decisionId, 'vowe_take_suggestion', { line: requireUuid(lineId, 'Line'), accept: accept === true }),

    async editDoc(roomId: string, decisionId: string, field: 'problem' | 'rationale', text: string, actorKind: ActorKind = 'human') {
      if (field !== 'problem' && field !== 'rationale') throw new RoomError('invalid', 'Only the problem or the rationale');
      return decisionOp(roomId, decisionId, 'vowe_edit_doc', { field, body: requireText(text, 'Text', 4000, true), actor_kind: requireActor(actorKind) });
    },

    async requestSignatures(roomId: string, decisionId: string, who: string[]) {
      if (!Array.isArray(who) || who.length > 50) throw new RoomError('invalid', 'At most 50 signers');
      return decisionOp(roomId, decisionId, 'vowe_request_signatures', { who: [...new Set(who.map((x) => requireUuid(x, 'Signer')))] });
    },

    sign: async (roomId: string, decisionId: string, version: number) =>
      decisionOp(roomId, decisionVersion(decisionId, version), 'vowe_sign', {}),

    requestChanges: async (roomId: string, decisionId: string, version: number, text: string) =>
      decisionOp(roomId, decisionVersion(decisionId, version), 'vowe_request_changes', { body: requireText(text, 'What to change', 2000) }),

    /** Returns the new draft's version; the Desk id is decisionVersionId(decision, version). */
    async amend(roomId: string, decisionId: string, actorKind: ActorKind = 'human'): Promise<{ decisionId: string; version: number }> {
      const room = requireUuid(roomId, 'Room');
      const d = requireDecision(decisionId);
      const { db } = await signedIn();
      await inRoom(db, 'room_decisions', room, d.decisionId);
      const version = await call<number>(db, 'vowe_amend', { decision: d.decisionId, actor_kind: requireActor(actorKind) });
      return { decisionId: d.decisionId, version };
    },

    async setSuggested(roomId: string, decisionId: string, state: 'dismissed' | 'draft') {
      if (state !== 'dismissed' && state !== 'draft') throw new RoomError('invalid', 'Dismissed or draft');
      return decisionOp(roomId, decisionId, 'vowe_set_suggested', { to_state: state });
    },

    // Work
    async createWork(roomId: string, w: { title: string; objective: string; decision?: string; thread?: string }, actorKind: ActorKind = 'human'): Promise<{ id: string }> {
      const room = requireUuid(roomId, 'Room');
      if (!isRecord(w)) throw new RoomError('invalid', 'Work needs a title');
      const d = w.decision === undefined || w.decision === null ? null : requireDecision(w.decision);
      const id = await send<string>('vowe_create_work', {
        room, title: requireText(w.title, 'Title', 500), objective: requireText(w.objective ?? '', 'Objective', 4000, true),
        decision: d?.decisionId ?? null, decision_ver: d?.version ?? null,
        thread: w.thread === undefined || w.thread === null ? null : requireUuid(w.thread, 'Thread'), actor_kind: requireActor(actorKind),
      });
      return { id };
    },

    /** One plan op, run here on the plan as stored, saved only if nobody moved it past `base`. */
    async plan(roomId: string, workId: string, opIn: PlanOp, base: number): Promise<{ version: number }> {
      const op = requirePlanOp(opIn);
      const ver = requireVersion(base);
      let saved = { version: ver };
      await onWork(roomId, workId, async (_rec, w, rev, db, me) => {
        if (w.version !== ver) throw new RoomError('conflict', `The plan moved to v${w.version} since you read v${ver}`);
        const after = applyOp(w, op, me);
        const patch = planPatch(w, after, me);
        if (!Object.keys(patch).length && op.op !== 'revise') return;
        const res = await call<{ version: number }>(db, 'vowe_save_plan', {
          work: w.id, base: ver, expected_rev: rev, patch, want_version: op.op === 'revise' ? ver + 1 : null, line: addedLine(w, after),
        });
        saved = { version: res.version };
      });
      return saved;
    },

    /** Suggest changes to a plan (Vowe, or a person); each is accepted or rejected on its own. */
    async suggestRevision(roomId: string, workId: string, s: { base: number; why: string; changes: VoweChangeInput[]; from?: string }, actorKind: ActorKind = 'human'): Promise<{ id: string }> {
      if (!isRecord(s)) throw new RoomError('invalid', 'A revision needs its changes');
      const id = await workOp<string>(roomId, workId, 'vowe_suggest_revision', {
        base: requireVersion(s.base), why: requireText(s.why, 'Why', 2000), changes: changesArg(s.changes),
        from_thread: s.from === undefined || s.from === null ? null : requireUuid(s.from, 'Thread'), actor_kind: requireActor(actorKind),
      });
      return { id };
    },

    async decideChange(roomId: string, workId: string, changeId: string, accept: boolean): Promise<void> {
      const change = requireUuid(changeId, 'Change');
      await onWork(roomId, workId, async (rec, w, rev, db, me) => {
        const c = w.revision?.changes.find((x) => x.id === change);
        if (!c) throw new RoomError('not-found', 'No such suggested change');
        if (c.state !== 'open') throw new RoomError('conflict', 'Someone already decided this change');
        // A promoted step becomes work with an id chosen here, not by whoever suggested it.
        const extraId = accept && c.kind === 'promote' ? randomUUID() : null;
        const r: VoweRecord = extraId
          ? { ...rec, work: rec.work.map((x) => x.id === w.id ? { ...x, revision: { ...x.revision!, changes: x.revision!.changes.map((y) => y.id === change ? { ...y, seed: { ...y.seed, id: extraId } } : y) } } : x) }
          : rec;
        const next = decide(r, w.id, change, accept === true, me);
        const after = next.work?.find((x) => x.id === w.id) ?? w;
        const extra = extraId ? next.work?.find((x) => x.id === extraId) : undefined;
        await call(db, 'vowe_decide_change', {
          work: w.id, change, accept: accept === true, base: w.version, expected_rev: rev,
          patch: accept ? planPatch(w, after, me) : {}, want_version: null, line: accept ? addedLine(w, after) : null,
          extra_id: extra ? extraId : null,
          extra: extra ? {
            title: extra.title, why: extra.why, plan: planPatch({ ...extra, plan: [] }, { plan: extra.plan }, me).plan,
            may: extra.may, mayNot: extra.mayNot, askWhen: extra.askWhen, accept: extra.accept, parts: extra.parts, context: extra.context,
          } : null,
        });
      });
    },

    authorize: async (roomId: string, workId: string, version: number) => workOp(roomId, workId, 'vowe_authorize', { ver: requireVersion(version) }),

    async requestScope(roomId: string, workId: string, s: { text: string; adds: string; by: string }, actorKind: ActorKind = 'human'): Promise<{ id: string }> {
      if (!isRecord(s)) throw new RoomError('invalid', 'A scope request needs what it adds');
      const id = await workOp<string>(roomId, workId, 'vowe_request_scope', {
        body: requireText(s.text, 'The request', 2000), adds: requireText(s.adds, 'What it adds', 1000), asked_as: requireText(s.by, 'Who asks', 100), actor_kind: requireActor(actorKind),
      });
      return { id };
    },

    allowScope: async (roomId: string, workId: string, allow: boolean) => workOp(roomId, workId, 'vowe_allow_scope', { allow: allow === true }),

    async ask(roomId: string, workId: string, q: { text: string; about?: string; step?: string; for: string; options?: string[] }, actorKind: ActorKind = 'human'): Promise<{ id: string }> {
      if (!isRecord(q)) throw new RoomError('invalid', 'A question needs its text');
      const options = Array.isArray(q.options) ? q.options.slice(0, 10).map((o) => requireText(o, 'Option', 200)) : [];
      const id = await workOp<string>(roomId, workId, 'vowe_ask_question', {
        body: requireText(q.text, 'The question', 2000), about: optionalText(q.about, 'About', 200) ?? '', step: optionalText(q.step, 'Step', 100),
        for_user: requireUuid(q.for, 'Person'), options, actor_kind: requireActor(actorKind),
      });
      return { id };
    },

    answer: async (roomId: string, workId: string, questionId: string, text: string) =>
      workOp(roomId, workId, 'vowe_answer_question', { question: requireUuid(questionId, 'Question'), body: requireText(text, 'The answer', 4000) }),

    defer: async (roomId: string, workId: string, questionId: string) => workOp(roomId, workId, 'vowe_defer_question', { question: requireUuid(questionId, 'Question') }),

    async addFinding(roomId: string, workId: string, f: { text: string; evidence?: string[]; offer?: string }, actorKind: ActorKind = 'human'): Promise<{ id: string }> {
      if (!isRecord(f)) throw new RoomError('invalid', 'A finding needs its text');
      const evidence = Array.isArray(f.evidence) ? f.evidence.slice(0, 50).map((e) => requireText(e, 'Evidence', 200)) : [];
      const id = await workOp<string>(roomId, workId, 'vowe_add_finding', {
        body: requireText(f.text, 'The finding', 4000), evidence, offer: optionalText(f.offer, 'Offer', 1000), actor_kind: requireActor(actorKind),
      });
      return { id };
    },

    async trackPr(roomId: string, workId: string, pr: { num: number; title: string; state: (typeof PR_STATES)[number]; branch?: string; url?: string; step?: string }) {
      if (!isRecord(pr) || !Number.isInteger(pr.num) || pr.num < 1) throw new RoomError('invalid', 'A PR needs its number');
      if (!PR_STATES.includes(pr.state)) throw new RoomError('invalid', 'Unknown PR state');
      const url = optionalText(pr.url, 'PR link', 1000);
      if (url && !/^https:\/\//.test(url)) throw new RoomError('invalid', 'A PR link must be https');
      return workOp(roomId, workId, 'vowe_track_pr', {
        num: pr.num, title: requireText(pr.title, 'PR title', 500), state: pr.state, branch: optionalText(pr.branch, 'Branch', 300) ?? '', url, step: optionalText(pr.step, 'Step', 100),
      });
    },

    resolve: async (roomId: string, workId: string) => workOp(roomId, workId, 'vowe_resolve_work', {}),

    // Attention and settings
    async markDone(roomId: string, ids: string[]): Promise<void> {
      const room = requireUuid(roomId, 'Room');
      if (!Array.isArray(ids) || ids.length > 200) throw new RoomError('invalid', 'At most 200 marks');
      const items = [...new Set(ids.map((i) => requireText(i, 'Mark', 300)))];
      if (!items.length) return;
      await send('vowe_mark_done', { room, items });
    },

    /** Renames the assistant for the room's workspace ('' → 'Vowe'). Room or workspace owners. */
    async setAgentName(roomId: string, name: string): Promise<string> {
      const room = requireUuid(roomId, 'Room');
      const text = requireText(name ?? '', 'Name', 40, true);
      return send<string>('vowe_set_agent_name', { room, name: text });
    },
  };
}

/** The Desk's id for the version a person read (sign and request changes name the version separately). */
function decisionVersion(decisionId: string, version: number): string {
  const d = requireDecision(decisionId);
  return `${d.decisionId}${requireVersion(version) > 1 ? `.v${version}` : ''}`;
}
