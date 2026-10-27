import {
  applyCommand, buildScenes, CanvasError, command, emptyDocument, execute, failure, memoryStore, parseDocument,
  type Actor, type CanvasCommand, type CanvasDocument, type CanvasPresence, type CommandArgs, type CommandName, type CommandResult,
  type Scene, type StoredCanvas,
} from '../../../shared/canvas/index.js';
import { Store } from '../../shared/store.js';

// A room's canvas in the renderer: the saved document, the commands of yours still on their way, and
// the other people on it. Every change is a Canvas Command run by the one engine (src/shared/canvas):
// in a real room, main runs it as the signed-in person and saves it (IPC `canvas:execute`); in the dev
// harness, an in-memory store does, through the same `execute`. Nothing here decides what a command
// does; it shows your own commands straight away by applying them to the last saved document, and
// drops that guess as soon as the saved answer arrives.

export interface CanvasPeer {
  id: string;
  name: string;
  /** Their colour: the design has two peer tones. */
  tone: 'peer' | 'p2';
  presence: CanvasPresence;
}

/** Where a room's canvas is kept, and how its call hears about it. */
export interface CanvasTransport {
  /** Who is acting here, for showing your own commands before they are saved. */
  me(): Actor;
  load(roomId: string): Promise<StoredCanvas>;
  execute(roomId: string, cmd: CanvasCommand): Promise<{ result: CommandResult; canvas: StoredCanvas }>;
  /** Someone (here or elsewhere) saved. */
  onChanged(roomId: string, fn: (canvas: StoredCanvas) => void): () => void;
  sendPresence(roomId: string, p: CanvasPresence): void;
  /** Someone else's view, pen and selection; null when they left. */
  onPresence(roomId: string, fn: (id: string, name: string, p: CanvasPresence | null) => void): () => void;
}

export interface CanvasState {
  status: 'loading' | 'ready' | 'failed';
  /** The last saved canvas. */
  saved: StoredCanvas;
  /** What to draw: the saved document with your unsaved commands applied. */
  doc: CanvasDocument;
  scenes: Record<string, Scene>;
  pending: number;
  /** The last command of yours that didn't land, in words. */
  error: string | null;
  /** Your latest command that landed, for the receipt's Undo. */
  last: Extract<CommandResult, { ok: true }> | null;
  peers: Record<string, CanvasPeer>;
}

const PRESENCE_EVERY = 60;

export class CanvasClient {
  readonly store: Store<CanvasState>;
  private queue: CanvasCommand[] = [];
  private offs: (() => void)[] = [];
  private presenceT: ReturnType<typeof setTimeout> | undefined;
  private presenceNext: CanvasPresence | null = null;
  private presenceAt = 0;
  private disposed = false;

  constructor(readonly roomId: string, readonly transport: CanvasTransport) {
    const doc = emptyDocument();
    this.store = new Store<CanvasState>({
      status: 'loading', saved: { revision: 0, doc }, doc, scenes: buildScenes(doc), pending: 0, error: null, last: null, peers: {},
    });
    this.offs.push(transport.onChanged(roomId, (c) => this.saved(c)));
    this.offs.push(transport.onPresence(roomId, (id, name, p) => this.peer(id, name, p)));
    void this.reload();
  }

  get state() { return this.store.state; }

  /** Reads the saved canvas again, as a fresh window would. */
  async reload(): Promise<StoredCanvas | null> {
    try {
      const c = await this.transport.load(this.roomId);
      this.saved(c, true);
      if (!this.disposed) this.store.setState({ status: 'ready' });
      return c;
    } catch (err) {
      if (!this.disposed) this.store.setState({ status: 'failed', error: (err as Error).message });
      return null;
    }
  }

  /** Runs a command as you. Resolves with what it did; a refusal is in the result, never thrown. */
  async run<K extends CommandName>(name: K, args: CommandArgs[K]): Promise<CommandResult> {
    const cmd = command(name, args);
    this.queue.push(cmd);
    this.redraw();
    let result: CommandResult;
    try {
      const out = await this.transport.execute(this.roomId, cmd);
      result = out.result;
      this.queue = this.queue.filter((c) => c !== cmd);
      this.saved(out.canvas);
    } catch (err) {
      this.queue = this.queue.filter((c) => c !== cmd);
      result = failure(cmd, err instanceof CanvasError ? err : new CanvasError('network', (err as Error).message));
      this.redraw();
    }
    if (!this.disposed) this.store.setState(result.ok ? { error: null, last: result.applied === 'noop' ? this.state.last : result } : { error: result.error.message });
    return result;
  }

  /** Where you are on the canvas, for the call and for Vowe's "this". Sent at most every 60ms. */
  share(p: CanvasPresence) {
    this.presenceNext = p;
    if (this.presenceT) return;
    const wait = Math.max(0, PRESENCE_EVERY - (Date.now() - this.presenceAt));
    this.presenceT = setTimeout(() => {
      this.presenceT = undefined;
      if (!this.presenceNext || this.disposed) return;
      this.presenceAt = Date.now();
      this.transport.sendPresence(this.roomId, this.presenceNext);
      this.presenceNext = null;
    }, wait);
  }

  dismissError() { this.store.setState({ error: null }); }

  dispose() {
    this.disposed = true;
    clearTimeout(this.presenceT);
    this.offs.forEach((off) => off());
  }

  private saved(c: StoredCanvas, force = false) {
    if (this.disposed) return;
    if (!force && c.revision < this.state.saved.revision) return;
    this.store.setState({ saved: c });
    this.redraw();
  }

  /** The saved document with your commands still in flight applied on top, in order. */
  private redraw() {
    if (this.disposed) return;
    let doc = this.state.saved.doc;
    for (const cmd of this.queue) {
      if (cmd.name === 'undo') continue; // whose change it undoes is main's to say
      try { doc = applyCommand(doc, cmd, this.transport.me()).doc; } catch { /* main will say why */ }
    }
    this.store.setState({ doc, scenes: buildScenes(doc), pending: this.queue.length });
  }

  private peer(id: string, name: string, p: CanvasPresence | null) {
    if (this.disposed) return;
    const peers = { ...this.state.peers };
    if (!p) delete peers[id];
    else {
      const tone = peers[id]?.tone ?? (Object.values(peers).some((x) => x.tone === 'peer') ? 'p2' : 'peer');
      peers[id] = { id, name, tone, presence: p };
    }
    this.store.setState({ peers });
  }
}

/* ---------- In a real room: main's hub, over IPC. ---------- */

export function ipcTransport(me: () => Actor): CanvasTransport {
  const j = window.journey;
  const names = new Map<string, string>();
  return {
    me,
    async load(roomId) {
      const r = await j.canvas.load(roomId);
      if (!r.ok) throw new CanvasError(r.error.code === 'not-configured' ? 'signed-out' : r.error.code, r.error.message);
      return { revision: r.value.revision, doc: parseDocument(r.value.doc) };
    },
    async execute(roomId, cmd) {
      const { result, canvas } = await j.canvas.execute(roomId, cmd);
      return { result, canvas: { revision: canvas.revision, doc: parseDocument(canvas.doc) } };
    },
    onChanged(roomId, fn) {
      return j.canvas.onChanged((c) => { if (c.roomId === roomId) fn({ revision: c.revision, doc: parseDocument(c.doc) }); });
    },
    sendPresence(roomId, p) { j.canvas.presence(roomId, p).catch(() => {}); },
    onPresence(roomId, fn) {
      const offEvent = j.rooms.onEvent((e) => {
        if (e.roomId !== roomId || e.type !== 'canvas:presence') return;
        fn(e.senderId, names.get(e.senderId) ?? 'Someone', e.payload);
      });
      // Names come from the call's presence; someone who left the call leaves the canvas too.
      const offPresence = j.rooms.onPresence(({ roomId: id, participants }) => {
        if (id !== roomId) return;
        const here = new Set(participants.map((p) => p.userId));
        participants.forEach((p) => names.set(p.userId, p.name ?? 'Someone'));
        [...names.keys()].forEach((uid) => { if (!here.has(uid)) { names.delete(uid); fn(uid, '', null); } });
      });
      return () => { offEvent(); offPresence(); };
    },
  };
}

/* ---------- In the dev harness: the same engine over a store in this browser. ---------- */

const DEV_KEY = 'vowe.canvas.dev';

/**
 * A canvas kept in this window's local storage, shared with other windows of the same app through a
 * BroadcastChannel, so two windows on the harness are two people in one room. `actor` says who each
 * command is from; the harness switches it to Vowe for Vowe's steps. `key` keeps the demo's canvases apart
 * from the harness's. Development and the demo only.
 */
export function memoryTransport(actor: () => Actor, key = DEV_KEY): CanvasTransport & { forget(roomId: string): void } {
  const read = (): Record<string, StoredCanvas> => {
    try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; }
  };
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(key) : null;
  const changed = new Set<(roomId: string, c: StoredCanvas) => void>();
  const presence = new Set<(roomId: string, id: string, name: string, p: CanvasPresence | null) => void>();
  const store = memoryStore({}, (roomId, c) => {
    try { localStorage.setItem(key, JSON.stringify({ ...read(), [roomId]: c })); } catch { /* storage may be full or off */ }
    changed.forEach((fn) => fn(roomId, c));
    channel?.postMessage({ t: 'changed', roomId });
  });
  // Always start from what is stored, so another window's save (or a reload) is seen.
  const fresh = (roomId: string) => { const c = read()[roomId]; if (c) store.rooms[roomId] = c; else delete store.rooms[roomId]; };
  if (channel) channel.onmessage = (e: MessageEvent) => {
    const m = e.data as { t: string; roomId: string; id?: string; name?: string; p?: CanvasPresence | null };
    if (m.t === 'changed') { fresh(m.roomId); const c = store.rooms[m.roomId]; if (c) changed.forEach((fn) => fn(m.roomId, c)); }
    if (m.t === 'presence') presence.forEach((fn) => fn(m.roomId, m.id!, m.name!, m.p ?? null));
  };
  const self = { id: 'w' + Math.random().toString(36).slice(2, 8) };
  addEventListener('pagehide', () => channel?.postMessage({ t: 'presence', roomId: '*', id: self.id, name: '', p: null }));
  return {
    me: actor,
    async load(roomId) { fresh(roomId); return store.load(roomId); },
    async execute(roomId, cmd) { fresh(roomId); return execute(store, roomId, cmd, actor()); },
    onChanged(roomId, fn) {
      const h = (id: string, c: StoredCanvas) => { if (id === roomId) fn(c); };
      changed.add(h);
      return () => changed.delete(h);
    },
    sendPresence(roomId, p) { channel?.postMessage({ t: 'presence', roomId, id: self.id, name: actor().name, p }); },
    onPresence(roomId, fn) {
      const h = (id: string, peerId: string, name: string, p: CanvasPresence | null) => { if (id === roomId || id === '*') fn(peerId, name, p); };
      presence.add(h);
      return () => presence.delete(h);
    },
    forget(roomId) {
      const all = read();
      delete all[roomId];
      try { localStorage.setItem(key, JSON.stringify(all)); } catch { /* storage may be off */ }
      delete store.rooms[roomId];
      channel?.postMessage({ t: 'changed', roomId });
    },
  };
}
