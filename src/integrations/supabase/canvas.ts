import { EventEmitter } from 'node:events';
import {
  CanvasError, emptyDocument, execute, failure, parseDocument, readSystem, viewOf,
  type Actor, type CanvasCommand, type CanvasPresence, type CanvasStore, type CommandResult, type StoredCanvas,
} from '../../shared/canvas/index.js';
import type { Cloud } from './index.js';
import { toRoomError } from './rooms.js';

/**
 * Each room's canvas in Supabase (supabase/migrations/*_room_canvas.sql), and the hub every change goes
 * through: a person's pen in a renderer (IPC `canvas:execute`) and Vowe's tool calls (in main) run the
 * same command through the same engine, the same permission check and the same save.
 *
 *   load       reads the room's document; a room nobody has drawn on yet is an empty canvas.
 *   commit     public.commit_canvas(): saves if the canvas is still at the revision the command was
 *              applied to, as the signed-in user, who must be an owner or member of the room.
 *   hub        one command at a time per room; after a save, tells this app's windows (`changed`) and
 *              the rest of the room (`announce`, a realtime `canvas:changed` carrying only the revision).
 *              A remote `canvas:changed` makes the hub re-read and tell this app's windows in turn.
 *
 * Electron-free, so the integration tests run it against a local stack as several real users.
 */

export function createCanvasStore(client: () => Promise<Cloud>): CanvasStore {
  return {
    async load(roomId) {
      const supabase = await client().catch((err) => { throw toCanvasError(err); });
      const { data, error } = await supabase.from('room_canvases').select('revision, document').eq('room_id', roomId).maybeSingle();
      if (error) throw toCanvasError(error);
      if (!data) return { revision: 0, doc: emptyDocument() };
      return { revision: data.revision, doc: parseDocument(data.document) };
    },
    async commit(roomId, base, doc, cmd, actor) {
      const supabase = await client().catch((err) => { throw toCanvasError(err); });
      const { data, error } = await supabase.rpc('commit_canvas', {
        room: roomId, base_revision: base, document: doc as never, command: cmd as never, actor_kind: actor.kind,
      });
      if (error) throw toCanvasError(error);
      return (data as number | null) ?? null;
    },
  };
}

export function toCanvasError(err: unknown): CanvasError {
  if (err instanceof CanvasError) return err;
  const { code, message } = toRoomError(err);
  switch (code) {
    case 'permission-denied': return new CanvasError('permission-denied', 'Only the room’s owners and members can change its canvas');
    case 'signed-out': case 'network': case 'invalid': case 'not-found': case 'conflict': return new CanvasError(code, message);
    case 'not-configured': return new CanvasError('signed-out', message);
  }
  return new CanvasError('unknown', message);
}

export const VOWE: Actor = { kind: 'agent', id: 'vowe', name: 'Vowe' };

export interface CanvasChange { roomId: string; canvas: StoredCanvas; result?: Extract<CommandResult, { ok: true }> }

export interface CanvasHubOptions {
  store: CanvasStore;
  /** The signed-in person, as the canvas names them. */
  person: () => Promise<Actor>;
  /** Tells everyone else in the room; resolves even if nobody is connected. */
  announce: (roomId: string, change: { revision: number; command: string; name: string }) => Promise<void>;
  now?: () => string;
}

export type CanvasHub = ReturnType<typeof createCanvasHub>;

export function createCanvasHub({ store, person, announce, now }: CanvasHubOptions) {
  const events = new EventEmitter<{ changed: [CanvasChange] }>();
  const queues = new Map<string, Promise<unknown>>();
  const latest = new Map<string, StoredCanvas>();
  const presence = new Map<string, CanvasPresence>();

  /** Runs one task per room at a time, so this app never races itself. */
  function serial<T>(roomId: string, task: () => Promise<T>): Promise<T> {
    const run = (queues.get(roomId) ?? Promise.resolve()).then(task, task);
    queues.set(roomId, run.catch(() => {}));
    return run;
  }

  function remember(roomId: string, canvas: StoredCanvas, result?: CanvasChange['result']) {
    const known = latest.get(roomId);
    if (known && known.revision >= canvas.revision && !result) return;
    latest.set(roomId, canvas);
    events.emit('changed', { roomId, canvas, ...(result ? { result } : {}) });
  }

  async function run(roomId: string, raw: unknown, actor: Actor): Promise<{ result: CommandResult; canvas: StoredCanvas }> {
    return serial(roomId, async () => {
      let out;
      try { out = await execute(store, roomId, raw, actor, now); }
      catch (err) {
        const e = toCanvasError(err);
        if (e.code === 'unknown') console.warn('[canvas]', err);
        return { result: failure(raw as CanvasCommand, e), canvas: latest.get(roomId) ?? { revision: 0, doc: emptyDocument() } };
      }
      const { result, canvas } = out;
      if (!result.ok || result.applied === 'noop') remember(roomId, canvas);
      else {
        remember(roomId, canvas, result);
        announce(roomId, { revision: result.revision, command: result.command, name: result.name })
          .catch((err: Error) => console.warn(`[canvas] change not announced in ${roomId}:`, err.message));
      }
      return out;
    });
  }

  return {
    events,

    async load(roomId: string): Promise<StoredCanvas> {
      const canvas = await store.load(roomId);
      remember(roomId, canvas);
      return canvas;
    },

    /** A person's command, from a renderer. The actor is always the signed-in user, never the renderer's claim. */
    async execute(roomId: string, raw: unknown) {
      return run(roomId, raw, await person());
    },

    /** Vowe's command: a tool call from the reasoning runtime, in main. Lands as a proposal where it changes the system. */
    async executeAsAgent(roomId: string, raw: unknown) {
      return run(roomId, raw, VOWE);
    },

    /** Someone else saved; re-read unless we already have that revision. */
    async remoteChanged(roomId: string, revision: number) {
      if ((latest.get(roomId)?.revision ?? -1) >= revision) return;
      await serial(roomId, async () => remember(roomId, await store.load(roomId)));
    },

    /** What the signed-in person is pointing at in this app, so "this" means something to Vowe. */
    setPresence(roomId: string, p: CanvasPresence) { presence.set(roomId, p); },

    /**
     * What Vowe needs to know about a room's canvas before it acts: the system by id, the views, what is
     * on screen and what the person has selected. Compact JSON, for a tool result or a system prompt.
     */
    async context(roomId: string) {
      const canvas = latest.get(roomId) ?? await this.load(roomId);
      return canvasContext(canvas, presence.get(roomId) ?? null);
    },

    forget(roomId: string) { latest.delete(roomId); presence.delete(roomId); queues.delete(roomId); },
  };
}

/** The canvas as the reasoning runtime reads it. */
export function canvasContext({ revision, doc }: StoredCanvas, here: CanvasPresence | null) {
  const sys = readSystem(doc);
  const name = (id: string) => doc.components[id]?.name ?? id;
  return {
    revision,
    activeView: doc.activeView,
    activeViewName: viewOf(doc, doc.activeView)?.name ?? doc.activeView,
    selection: (here?.selection ?? []).map((r) => ({ ...r, name: name(r.component) })),
    highlight: doc.highlight?.components ?? [],
    components: Object.values(doc.components).map((c) => ({
      id: c.id, kind: c.kind, name: c.name, ...(c.parent ? { parent: c.parent } : {}), ...(c.status === 'proposed' ? { status: c.status } : {}),
    })),
    relationships: sys.rels.map((r) => ({ from: r.from, kind: r.kind, to: r.to, ...(r.label ? { label: r.label } : {}), ...(r.status === 'proposed' ? { status: r.status } : {}) })),
    views: Object.values(doc.views).map((v) => ({ id: v.id, type: v.type, name: v.name, question: v.question, ...(v.focus ? { focus: v.focus } : {}), status: v.status })),
    openProposals: Object.values(doc.proposals).filter((p) => p.status === 'open').map((p) => ({ id: p.id, title: p.title, by: p.by.name })),
    notes: Object.values(doc.annotations).flatMap((a) => a.kind === 'note' ? [{ id: a.id, on: a.on, kind: a.note, text: a.text, status: a.status, by: a.by.name }] : []),
  };
}

export type CanvasContext = ReturnType<typeof canvasContext>;
