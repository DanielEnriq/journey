import type { JourneyApi, RoomEvent, RoomResult, VoweNewThread } from '../../../../shared/api.js';
import { parseDecisionVersionId } from '../../../../shared/vowe/ids.js';
import type { NewThread, SettingsService, VoweServices } from '../../vowe-room/contracts/services.js';

// The Vowe room's services over IPC (window.journey), for RoomScreen's Desk. Main runs every write as one
// checked database function (integrations/supabase/vowe-record.ts); this only forwards calls and turns
// results into the shapes the Desk asks for. Replies, resolving and signing reuse the room record's
// existing calls. After a successful write, this window's own listeners re-read at once; everyone else
// hears the record:changed event the database sends on the room's channel.
//
// Not offered, on purpose (the Desk shows these truthfully as unavailable):
//   runs           PASS3_BACKEND: no unattended agent execution; nothing dispatches or steers a run.
//   github         PASS3_BACKEND: no GitHub App/OAuth scope for PR and CI state; PRs are what people track.
//   notifications  PASS3_BACKEND: no outbound channel (email, push); For you stays in the app.

export type RealVoweServices = VoweServices & { settings: SettingsService | null };

type Journey = Pick<JourneyApi, 'vowe' | 'record' | 'rooms'>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A RoomResult with its value dropped. */
export function voidResult<T>(r: RoomResult<T>): RoomResult<void> {
  return r.ok ? { ok: true, value: undefined } : r;
}

/** The Desk's new thread as main takes it: `waiting` only when it names a person (a cloud user id). */
export function toNewThread(t: NewThread): VoweNewThread {
  const out: VoweNewThread = { about: t.about, body: t.body };
  if (t.quote) out.quote = t.quote;
  if (t.at) out.at = { x: t.at.x, y: t.at.y };
  if (t.waiting && UUID.test(t.waiting)) out.waiting = t.waiting;
  return out;
}

const invalid = (message: string): RoomResult<never> => ({ ok: false, error: { code: 'invalid', message } });

/**
 * @param journey the preload API (window.journey); a stand-in in tests.
 */
export function createVoweServices(journey: () => Journey = () => window.journey): RealVoweServices {
  const listeners = new Map<string, Set<() => void>>();
  const changed = (roomId: string) => { for (const fn of listeners.get(roomId) ?? []) fn(); };
  /** Runs a write; on success this window's listeners re-read. */
  async function write<T>(roomId: string, run: () => Promise<RoomResult<T>>): Promise<RoomResult<T>> {
    const res = await run();
    if (res.ok) changed(roomId);
    return res;
  }
  const j = () => journey();

  return {
    record: {
      load: (roomId) => j().vowe.load(roomId),
      subscribe(roomId, fn) {
        let set = listeners.get(roomId);
        if (!set) listeners.set(roomId, (set = new Set()));
        set.add(fn);
        const off = j().rooms.onEvent((e: RoomEvent) => { if (e.type === 'record:changed' && e.roomId === roomId) fn(); });
        return () => { set!.delete(fn); off(); };
      },
    },
    threads: {
      create: (roomId, t) => write(roomId, () => j().vowe.thread(roomId, toNewThread(t))),
      reply: (roomId, threadId, body) => write(roomId, async () => voidResult(await j().record.reply(roomId, threadId, body))),
      resolve: (roomId, threadId) => write(roomId, () => j().record.resolve(roomId, threadId)),
      answerOffer: (roomId, threadId, replyId, accept) => write(roomId, () => j().vowe.answerOffer(roomId, threadId, replyId, accept)),
    },
    decisions: {
      create: (roomId, d) => write(roomId, () => j().vowe.decisions.create(roomId, d)),
      editLine: (roomId, id, lineId, text) => write(roomId, () => j().vowe.decisions.editLine(roomId, id, lineId, text)),
      addLine: (roomId, id, kind, text) => write(roomId, () => j().vowe.decisions.addLine(roomId, id, kind, text)),
      editDoc: (roomId, id, field, text) => write(roomId, () => j().vowe.decisions.editDoc(roomId, id, field, text)),
      takeSuggestion: (roomId, id, lineId, accept) => write(roomId, () => j().vowe.decisions.takeSuggestion(roomId, id, lineId, accept)),
      requestSignatures: (roomId, id, who) => write(roomId, () => j().vowe.decisions.requestSignatures(roomId, id, who)),
      // Signing is the room record's own call, on the database decision and the version read.
      async sign(roomId, id, version) {
        const d = parseDecisionVersionId(id);
        if (!d) return invalid('That decision id isn’t valid');
        const res = await write(roomId, async () => voidResult(await j().record.sign(roomId, d.decisionId, version)));
        // record.sign is Journey's write, which doesn't notify from the database: tell the room, as Journey does.
        if (res.ok) j().rooms.send(roomId, 'record:changed', { what: 'signature' }).catch(() => {});
        return res;
      },
      requestChanges: (roomId, id, version, text) => write(roomId, () => j().vowe.decisions.requestChanges(roomId, id, version, text)),
      amend: (roomId, id) => write(roomId, () => j().vowe.decisions.amend(roomId, id)),
      setSuggested: (roomId, id, state) => write(roomId, () => j().vowe.decisions.setSuggested(roomId, id, state)),
    },
    work: {
      create: (roomId, w) => write(roomId, () => j().vowe.work.create(roomId, w)),
      // The op runs in main against the stored plan; the Desk's optimistic copy is replaced by the re-read.
      plan: (roomId, workId, op, base) => write(roomId, async () => voidResult(await j().vowe.work.plan(roomId, workId, op, base))),
      decideChange: (roomId, workId, changeId, accept) => write(roomId, () => j().vowe.work.decideChange(roomId, workId, changeId, accept)),
      authorize: (roomId, workId, version) => write(roomId, () => j().vowe.work.authorize(roomId, workId, version)),
      allowScope: (roomId, workId, allow) => write(roomId, () => j().vowe.work.allowScope(roomId, workId, allow)),
      answer: (roomId, workId, questionId, text) => write(roomId, () => j().vowe.work.answer(roomId, workId, questionId, text)),
      defer: (roomId, workId, questionId) => write(roomId, () => j().vowe.work.defer(roomId, workId, questionId)),
      resolve: (roomId, workId) => write(roomId, () => j().vowe.work.resolve(roomId, workId)),
    },
    attention: {
      markDone: (roomId, ids) => j().vowe.markDone(roomId, ids), // your own marks; nobody else re-reads for them
    },
    settings: {
      agentName: (roomId, name) => write(roomId, async () => voidResult(await j().vowe.setAgentName(roomId, name))),
    },
    runs: null, // PASS3_BACKEND: unattended agent runs aren't enabled; authorizing a plan starts nothing.
    github: null, // PASS3_BACKEND: no GitHub App/OAuth scopes for PR/CI sync; PRs are tracked by people.
    notifications: null, // PASS3_BACKEND: no outbound notification channel; For you is in-app only.
  };
}

/** The assistant's name for a room, read from its record (workspace setting; 'Vowe' by default). */
export async function agentNameOf(roomId: string, journey: () => Journey = () => window.journey): Promise<string> {
  const r = await journey().vowe.load(roomId);
  return r.ok ? r.value.agentName ?? 'Vowe' : 'Vowe';
}

/** Renames the assistant for the room's workspace ('' → 'Vowe'); room or workspace owners only. */
export function setAgentName(roomId: string, name: string, journey: () => Journey = () => window.journey): Promise<RoomResult<string>> {
  return journey().vowe.setAgentName(roomId, name);
}
