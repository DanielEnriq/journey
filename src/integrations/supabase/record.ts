import type {
  NewThread,
  RoomActivity,
  RoomActivityKind,
  RoomAuthor,
  RoomComment,
  RoomDecision,
  RoomRecord,
  RoomThread,
  ThreadKind,
} from '../../shared/api.js';
import type { Cloud } from './index.js';
import { RoomError, toRoomError } from './rooms.js';

/**
 * A room's record, as the signed-in member: threads and replies, decisions with their versions and
 * signatures, activity, and your "last looked" marker. RLS in supabase/migrations/*_room_record.sql is
 * the authority, and the database sets authors, versions and timestamps; this module only shapes
 * calls and turns failures into RoomErrors. A room you aren't a member of reads as not-found.
 */

export type RoomRecordService = ReturnType<typeof createRoomRecordService>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS: ThreadKind[] = ['note', 'concern', 'avoid', 'constraint', 'question', 'goal'];
const ACTIVITY_LIMIT = 50;
const ACTIVITY_KINDS: RoomActivityKind[] = ['thread', 'reply', 'decision', 'amended', 'signed', 'repository', 'call-started', 'call-left', 'joined', 'left', 'removed', 'role'];
const AUTHOR = 'id, name, email';

export function createRoomRecordService(client: () => Promise<Cloud>) {
  async function signedIn(): Promise<{ supabase: Cloud; selfId: string }> {
    const supabase = await client();
    const { data, error } = await supabase.auth.getSession();
    if (error) throw toRoomError(error);
    if (!data.session) throw new RoomError('signed-out', 'Sign in to use rooms');
    return { supabase, selfId: data.session.user.id };
  }

  /** Throws not-found unless you can use the room; RLS would otherwise just return nothing. */
  async function requireRoom(supabase: Cloud, roomId: string): Promise<void> {
    const { data, error } = await supabase.from('rooms').select('id').eq('id', roomId).maybeSingle();
    if (error) throw toRoomError(error);
    if (!data) throw notFound();
  }

  async function decision(supabase: Cloud, roomId: string, decisionId: string): Promise<RoomDecision> {
    const { data, error } = await supabase
      .from('room_decisions')
      .select(`*, proposer:users!room_decisions_proposed_by_fkey(${AUTHOR}), room_signatures(*), room_decision_versions!room_decision_versions_decision_id_fkey(*, proposer:users!room_decision_versions_proposed_by_fkey(${AUTHOR}))`)
      .eq('id', decisionId)
      .eq('room_id', roomId)
      .maybeSingle();
    if (error) throw toRoomError(error);
    if (!data) throw new RoomError('not-found', 'No such decision in this room');
    return toDecision(data);
  }

  return {
    async getRecord(roomId: string): Promise<RoomRecord> {
      const room = requireId(roomId, 'Room');
      const { supabase, selfId } = await signedIn();
      await requireRoom(supabase, room);
      const [threads, decisions, activity, visit] = await Promise.all([
        supabase
          .from('room_threads')
          .select(`*, author:users!room_threads_created_by_fkey(${AUTHOR}), room_comments(*, author:users!room_comments_created_by_fkey(${AUTHOR}))`)
          .eq('room_id', room)
          .is('resolved_at', null)
          .order('created_at'),
        supabase
          .from('room_decisions')
          .select(`*, proposer:users!room_decisions_proposed_by_fkey(${AUTHOR}), room_signatures(*), room_decision_versions!room_decision_versions_decision_id_fkey(*, proposer:users!room_decision_versions_proposed_by_fkey(${AUTHOR}))`)
          .eq('room_id', room)
          .order('created_at', { ascending: false }),
        supabase
          .from('room_activity')
          .select(`*, actor:users!room_activity_actor_id_fkey(${AUTHOR})`)
          .eq('room_id', room)
          .in('kind', ACTIVITY_KINDS) // the Vowe room's kinds (review, agreed, plan…) are read through vowe-record.ts
          .order('created_at', { ascending: false })
          .limit(ACTIVITY_LIMIT),
        supabase.from('room_visits').select('seen_at').eq('room_id', room).eq('user_id', selfId).maybeSingle(),
      ]);
      for (const r of [threads, decisions, activity, visit]) if (r.error) throw toRoomError(r.error);
      return {
        roomId: room,
        threads: threads.data!.map(toThread),
        decisions: decisions.data!.map(toDecision),
        activity: activity.data!.filter(isRoomActivity).map(toActivity),
        lastSeenAt: visit.data?.seen_at ?? null,
      };
    },

    async addThread(roomId: string, input: NewThread): Promise<RoomThread> {
      const room = requireId(roomId, 'Room');
      if (!isRecord(input) || !isRecord(input.anchor)) throw new RoomError('invalid', 'A thread needs a kind, an anchor and some text');
      if (!KINDS.includes(input.kind)) throw new RoomError('invalid', `Thread kind must be one of ${KINDS.join(', ')}`);
      const row = {
        room_id: room,
        kind: input.kind,
        anchor_id: requireText(input.anchor.id, 'Anchor id', 200),
        anchor_name: requireText(input.anchor.name, 'Anchor name', 200),
        anchor_x: optionalNumber(input.anchor.x, 'Anchor x'),
        anchor_y: optionalNumber(input.anchor.y, 'Anchor y'),
        body: requireText(input.body, 'Thread text', 4000),
      };
      const { supabase } = await signedIn();
      await requireRoom(supabase, room);
      const { data, error } = await supabase
        .from('room_threads')
        .insert(row)
        .select(`*, author:users!room_threads_created_by_fkey(${AUTHOR}), room_comments(*, author:users!room_comments_created_by_fkey(${AUTHOR}))`)
        .single();
      if (error) throw toRoomError(error);
      return toThread(data);
    },

    /** `agent`: Vowe's reply, written from this person's app on their model, saved as theirs and shown as Vowe's. */
    /** `parentId`: the reply this one answers, in the same thread (the database refuses one from elsewhere). */
    async reply(roomId: string, threadId: string, body: string, authorKind: 'human' | 'agent' = 'human', parentId: string | null = null): Promise<RoomComment> {
      const room = requireId(roomId, 'Room');
      const thread = requireId(threadId, 'Thread');
      const parent = parentId === null ? null : requireId(parentId, 'Reply');
      const text = requireText(body, 'Reply', 4000);
      const { supabase } = await signedIn();
      await requireRoom(supabase, room);
      const { data, error } = await supabase
        .from('room_comments')
        .insert({ room_id: room, thread_id: thread, body: text, ...(authorKind === 'agent' ? { author_kind: 'agent' } : {}), ...(parent ? { parent_id: parent } : {}) })
        .select(`*, author:users!room_comments_created_by_fkey(${AUTHOR})`)
        .single();
      // The composite keys refuse a thread from another room, or a parent from another thread, as missing.
      if (error?.code === '23503') throw new RoomError('not-found', parent ? 'No such reply in this thread' : 'No such thread in this room');
      if (error) throw toRoomError(error);
      return toComment(data);
    },

    /** Resolves a thread, or with `reopen` opens it again. */
    async resolve(roomId: string, threadId: string, reopen = false): Promise<void> {
      const room = requireId(roomId, 'Room');
      const thread = requireId(threadId, 'Thread');
      const { supabase } = await signedIn();
      const { data, error } = await supabase
        .from('room_threads')
        .update({ resolved_at: reopen === true ? null : new Date().toISOString() })
        .eq('id', thread)
        .eq('room_id', room)
        .select('id');
      if (error) throw toRoomError(error);
      if (!data.length) throw new RoomError('not-found', 'No such thread in this room');
    },

    async propose(roomId: string, input: { title: string; verify: string }): Promise<RoomDecision> {
      const room = requireId(roomId, 'Room');
      if (!isRecord(input)) throw new RoomError('invalid', 'A decision needs a title and its checks');
      const row = { room_id: room, title: requireText(input.title, 'Decision', 500), verify: requireText(input.verify, 'Checks', 2000) };
      const { supabase } = await signedIn();
      await requireRoom(supabase, room);
      const { data, error } = await supabase.from('room_decisions').insert(row).select('id').single();
      if (error) throw toRoomError(error);
      return decision(supabase, room, data.id);
    },

    /** A new version, when the title or checks actually change; signatures on the old one stop counting. */
    async amend(roomId: string, decisionId: string, change: { title?: string; verify?: string }): Promise<RoomDecision> {
      const room = requireId(roomId, 'Room');
      const id = requireId(decisionId, 'Decision');
      if (!isRecord(change)) throw new RoomError('invalid', 'Changes must be an object');
      const patch: { title?: string; verify?: string } = {};
      if (change.title !== undefined) patch.title = requireText(change.title, 'Decision', 500);
      if (change.verify !== undefined) patch.verify = requireText(change.verify, 'Checks', 2000);
      const { supabase } = await signedIn();
      if (Object.keys(patch).length) {
        const { data, error } = await supabase.from('room_decisions').update(patch).eq('id', id).eq('room_id', room).select('id');
        if (error) throw toRoomError(error);
        if (!data.length) throw new RoomError('not-found', 'No such decision in this room');
      }
      return decision(supabase, room, id);
    },

    /** Signs the current version as you. Signing it twice is a no-op; signing an old version is refused. */
    async sign(roomId: string, decisionId: string, version: number): Promise<RoomDecision> {
      const room = requireId(roomId, 'Room');
      const id = requireId(decisionId, 'Decision');
      if (!Number.isInteger(version) || version < 1) throw new RoomError('invalid', 'Version must be a positive whole number');
      const { supabase } = await signedIn();
      const current = await decision(supabase, room, id);
      if (current.version !== version) {
        throw new RoomError('conflict', `Version ${version} isn’t current any more; v${current.version} is. Read it before signing.`);
      }
      const { error } = await supabase.from('room_signatures').insert({ decision_id: id, version });
      if (error && error.code !== '23505') {
        // RLS also refuses a version that changed between the read and the insert.
        if (error.code === '42501') throw new RoomError('conflict', 'The decision changed while you were signing; read it again');
        throw toRoomError(error);
      }
      return decision(supabase, room, id);
    },

    async markSeen(roomId: string): Promise<void> {
      const room = requireId(roomId, 'Room');
      const { supabase } = await signedIn();
      await requireRoom(supabase, room);
      const { error } = await supabase
        .from('room_visits')
        .upsert({ room_id: room, seen_at: new Date().toISOString() }, { onConflict: 'room_id,user_id' });
      if (error) throw toRoomError(error);
    },

    async logCall(roomId: string, what: 'call-started' | 'call-left'): Promise<void> {
      const room = requireId(roomId, 'Room');
      if (what !== 'call-started' && what !== 'call-left') throw new RoomError('invalid', 'Unknown call activity');
      const { supabase } = await signedIn();
      await requireRoom(supabase, room);
      const { error } = await supabase.from('room_activity').insert({ room_id: room, kind: what });
      if (error) throw toRoomError(error);
    },
  };
}

// ─── Rows ────────────────────────────────────────────────────────────────────

type AuthorRow = { id: string; name: string | null; email: string } | null;

function toAuthor(row: AuthorRow): RoomAuthor {
  // A deleted account leaves its rows (or cascades them away); a missing join reads as someone.
  return row ? { id: row.id, name: row.name, email: row.email } : { id: '', name: null, email: '' };
}

type CommentRow = { id: string; body: string; created_at: string; author_kind?: string; author: AuthorRow };

function toComment(row: CommentRow): RoomComment {
  return { id: row.id, body: row.body, author: toAuthor(row.author), authorKind: row.author_kind === 'agent' ? 'agent' : 'human', createdAt: row.created_at };
}

type ThreadRow = {
  id: string;
  room_id: string;
  kind: ThreadKind;
  anchor_id: string;
  anchor_name: string;
  anchor_x: number | null;
  anchor_y: number | null;
  body: string;
  created_at: string;
  resolved_at: string | null;
  author: AuthorRow;
  room_comments: CommentRow[];
};

export function toThread(row: ThreadRow): RoomThread {
  return {
    id: row.id,
    roomId: row.room_id,
    kind: row.kind,
    anchor: { id: row.anchor_id, name: row.anchor_name, x: row.anchor_x, y: row.anchor_y },
    body: row.body,
    author: toAuthor(row.author),
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    replies: row.room_comments.map(toComment).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  };
}

type DecisionRow = {
  id: string;
  room_id: string;
  title: string;
  verify: string;
  version: number;
  created_at: string;
  updated_at: string;
  proposer: AuthorRow;
  room_signatures: { user_id: string; version: number; signed_at: string }[];
  room_decision_versions: { version: number; title: string; verify: string; created_at: string; proposer: AuthorRow }[];
};

export function toDecision(row: DecisionRow): RoomDecision {
  return {
    id: row.id,
    roomId: row.room_id,
    title: row.title,
    verify: row.verify,
    version: row.version,
    proposedBy: toAuthor(row.proposer),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    signatures: row.room_signatures.map((s) => ({ userId: s.user_id, version: s.version, signedAt: s.signed_at })),
    history: row.room_decision_versions
      .filter((v) => v.version < row.version)
      .sort((a, b) => b.version - a.version)
      .map((v) => ({ version: v.version, title: v.title, verify: v.verify, proposedBy: toAuthor(v.proposer), createdAt: v.created_at })),
  };
}

type ActivityRow = { id: string; kind: RoomActivityKind; subject: string | null; version: number | null; created_at: string; actor: AuthorRow };
// The query asks only for these kinds; the guard keeps the type honest now the enum holds the Vowe room's too.
const isRoomActivity = <R extends { kind: string }>(row: R): row is R & { kind: RoomActivityKind } => (ACTIVITY_KINDS as string[]).includes(row.kind);

function toActivity(row: ActivityRow): RoomActivity {
  return {
    id: row.id,
    kind: row.kind,
    actor: row.actor ? toAuthor(row.actor) : null,
    subject: row.subject,
    version: row.version,
    createdAt: row.created_at,
  };
}

// ─── Input ───────────────────────────────────────────────────────────────────

const notFound = () => new RoomError('not-found', 'No such room, or you are not a member of it');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireId(value: unknown, what: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new RoomError('invalid', `${what} id must be a UUID`);
  return value.toLowerCase();
}

function requireText(value: unknown, what: string, max: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new RoomError('invalid', `${what} must not be empty`);
  if (text.length > max) throw new RoomError('invalid', `${what} must be at most ${max} characters`);
  return text;
}

function optionalNumber(value: unknown, what: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new RoomError('invalid', `${what} must be a number`);
  return value;
}
