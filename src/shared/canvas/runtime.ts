import type { CanvasCommand as VoweRequest, CanvasSnapshot } from '../../assistant/canvas.js';
import type { AgentEvent } from '../api.js';
import { command, type CanvasCommand, type CommandResult, type ComponentInput, type ProposalChange } from './commands.js';
import { emptyDocument, ID_MAX, ID_PATTERN, type CanvasDocument, type CanvasRef, type ComponentKind, type RelationshipKind, type ViewType } from './model.js';
import { viewOf, viewsOf } from './views/index.js';

// The one adapter between Vowe's reasoning runtime (src/assistant/canvas.ts, contract v1) and this
// canvas engine. The runtime speaks a small, stable vocabulary: five requests, the renderer's view ids
// and part kinds. The engine speaks 19 commands over a semantic document. Both directions live here:
//
//   snapshotOf   the engine's document (and what the asker selected or circled) as the runtime's
//                CanvasSnapshot, so the runtime validates its requests against the canvas the engine
//                will run them on.
//   TurnCanvas   one turn's requests as engine commands. Pointing, notes and views run as they arrive.
//                Structural requests (propose_component, connect_components) are gathered and become
//                ONE proposal when the turn ends, so a person accepts or rejects what Vowe suggested as
//                a whole; requests that name a component that proposal adds wait for it.
//   canvasEvents a turn's event stream with its requests run on a canvas hub as Vowe, outcomes reported
//                as `canvas.applied`, and the ending event held back until they're saved.
//
// Types only from the runtime, so the renderer can import this without zod. Pure: no I/O.

type RuntimeView = CanvasSnapshot['view'];
type RuntimeKind = CanvasSnapshot['components'][number]['kind'];

const VIEW_TO_RUNTIME: Record<ViewType, RuntimeView> = { architecture: 'arch', 'failure-flow': 'failure', concurrency: 'concurrency' };

/** The runtime's part kinds are the design's; where one is coarser, `tech` keeps the engine's word. */
const KIND_TO_RUNTIME: Record<ComponentKind, RuntimeKind> = {
  service: 'service', worker: 'service', queue: 'queue', database: 'store', external: 'external', event: 'queue', boundary: 'service',
};
const LOSSY: ReadonlySet<ComponentKind> = new Set(['worker', 'event', 'boundary']);

const KIND_FROM_RUNTIME: Record<RuntimeKind, ComponentKind> = {
  service: 'service', queue: 'queue', external: 'external', store: 'database', client: 'service', code: 'service',
};

const RELATION_WORDS: Record<RelationshipKind, string> = {
  calls: 'calls', publishes: 'publishes to', consumes: 'consumes', reads_writes: 'reads and writes', depends_on: 'depends on', retries: 'retries',
};

const clip = (s: string, n: number) => s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;

/** Component ids a set of references names, in order, without repeats. */
export function componentsOf(refs: readonly CanvasRef[]): string[] {
  return [...new Set(refs.map((r) => r.component))];
}

/** What the asker is looking at, as the runtime reads it. Ids the document no longer has are dropped. */
export function snapshotOf(doc: CanvasDocument, here: { selected: readonly string[]; circled: readonly string[] }): CanvasSnapshot {
  const known = (ids: readonly string[]) => [...new Set(ids)].filter((id) => doc.components[id]).slice(0, 50);
  const views = new Map<RuntimeView, CanvasSnapshot['views'][number]>();
  for (const v of viewsOf(doc)) {
    const id = VIEW_TO_RUNTIME[v.type];
    if (!views.has(id)) views.set(id, { id, name: clip(v.name, 60), ...(v.question ? { question: clip(v.question, 200) } : {}) });
  }
  return {
    version: 1,
    view: VIEW_TO_RUNTIME[viewOf(doc, doc.activeView)?.type ?? 'architecture'],
    views: [...views.values()].slice(0, 20),
    components: Object.values(doc.components).slice(0, 200).map((c) => {
      const tech = LOSSY.has(c.kind) ? [c.kind, c.tech].filter(Boolean).join(' · ') : c.tech;
      return {
        id: c.id, name: clip(c.name, 80), kind: KIND_TO_RUNTIME[c.kind],
        ...(c.short ? { short: clip(c.short, 80) } : {}), ...(tech ? { tech: clip(tech, 120) } : {}),
        ...(c.status === 'proposed' ? { proposed: true } : {}),
      };
    }),
    relationships: Object.values(doc.relationships).slice(0, 400).map((r) => ({ from: r.from, to: r.to, label: clip(r.label ?? RELATION_WORDS[r.kind], 60) })),
    selection: { selected: known(here.selected), circled: known(here.circled) },
  };
}

/** A runtime id as an engine id: `PaymentWorker` and `payment_worker` both become `payment-worker`. */
export function engineId(id: string): string | null {
  const out = id.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+/, '').slice(0, ID_MAX).replace(/-+$/, '');
  return ID_PATTERN.test(out) ? out : null;
}

/** One engine command, and the runtime requests it carries out. */
export interface CanvasStep { requests: string[]; command: CanvasCommand }

export type Taken = { run: CanvasStep[] } | { declined: string };

/**
 * The engine relationship a runtime connection most likely means, from what it connects (the engine
 * checks kinds against their ends). The label breaks the tie between publishing and consuming.
 */
export function relationshipKind(from: ComponentKind, to: ComponentKind, label = ''): RelationshipKind | null {
  if (from === 'event' || from === 'boundary' || to === 'event' || to === 'boundary') return null;
  if (to === 'queue') {
    if (/consum|lease|pull|poll|take|read|dequeue/i.test(label)) return 'consumes';
    if (/publish|enqueue|push|emit|send|put|write/i.test(label)) return 'publishes';
    return from === 'worker' ? 'consumes' : 'publishes';
  }
  if (to === 'database') return 'reads_writes';
  return 'calls';
}

/** One turn's canvas requests, as engine commands, in order. */
export class TurnCanvas {
  private changes: ProposalChange[] = [];
  private structural: VoweRequest[] = [];
  private waiting: CanvasStep[] = [];
  /** Runtime id → engine id, for components this turn proposes. */
  private added = new Map<string, { id: string; kind: ComponentKind; name: string }>();

  constructor(private readonly doc: () => CanvasDocument) {}

  /** What to run now for one request; nothing yet if it waits for the turn's proposal. */
  take(req: VoweRequest): Taken {
    switch (req.type) {
      case 'highlight_component':
        return this.now(req, command('highlight_component', { components: req.payload.componentIds.map((c) => this.id(c)) }, req.id), req.payload.componentIds);
      case 'annotate_component':
        return this.now(req, command('annotate_component', { component: this.id(req.payload.componentId), text: req.payload.text, kind: req.payload.kind }, req.id), [req.payload.componentId]);
      case 'show_view':
        return this.view(req);
      case 'propose_component': {
        const id = engineId(req.payload.component.id);
        if (!id) return { declined: `“${req.payload.component.id}” can’t be a component id on the canvas` };
        if (this.doc().components[id] || [...this.added.values()].some((a) => a.id === id)) return { declined: `“${id}” is already on the canvas` };
        const kind = /worker|consumer/i.test(`${req.payload.component.id} ${req.payload.component.name}`) && req.payload.component.kind === 'service' ? 'worker' : KIND_FROM_RUNTIME[req.payload.component.kind];
        const component: ComponentInput = { id, kind, name: req.payload.component.name, ...(req.payload.component.tech ? { tech: req.payload.component.tech } : {}) };
        this.added.set(req.payload.component.id, { id, kind, name: req.payload.component.name });
        this.changes.push({ name: 'add_component', args: { component } });
        this.structural.push(req);
        return { run: [] };
      }
      case 'connect_components': {
        const from = this.part(req.payload.from), to = this.part(req.payload.to);
        if (!from || !to) return { declined: `No component “${from ? req.payload.to : req.payload.from}” on the canvas` };
        const kind = relationshipKind(from.kind, to.kind, req.payload.label);
        if (!kind) return { declined: `${from.name} and ${to.name} can’t be connected on the canvas: ${from.kind === 'event' || from.kind === 'boundary' ? from.name : to.name} is a ${from.kind === 'event' || from.kind === 'boundary' ? from.kind : to.kind}` };
        this.changes.push({ name: 'connect_components', args: { from: from.id, to: to.id, kind, label: req.payload.label } });
        this.structural.push(req);
        return { run: [] };
      }
    }
  }

  /** When the turn has answered: its one proposal, then whatever waited on it. */
  finish(): CanvasStep[] {
    const out: CanvasStep[] = [];
    if (this.changes.length) {
      const names = [...this.added.values()].map((a) => a.name);
      const title = names.length ? `Add ${list(names)}` : this.changes.length === 1 ? connectTitle(this.changes[0]!, this.doc()) : 'Connect parts of the system';
      const reasons = [...new Set(this.structural.map((r) => r.reason))].join(' ');
      out.push({
        requests: this.structural.map((r) => r.id),
        command: command('propose_change', { title: clip(title, 200), rationale: clip(reasons, 1000), changes: this.changes }, `${this.structural[0]!.id}-p`),
      });
    }
    out.push(...this.waiting);
    this.drop();
    return out;
  }

  /** A turn that was cancelled or failed proposes nothing. */
  drop() { this.changes = []; this.structural = []; this.waiting = []; this.added.clear(); }

  private id(runtimeId: string) { return this.added.get(runtimeId)?.id ?? runtimeId; }

  private part(runtimeId: string): { id: string; kind: ComponentKind; name: string } | null {
    const added = this.added.get(runtimeId);
    if (added) return added;
    const c = this.doc().components[runtimeId];
    return c ? { id: c.id, kind: c.kind, name: c.name } : null;
  }

  /** Runs now, unless it names a component this turn's proposal is still to add. */
  private now(req: VoweRequest, cmd: CanvasCommand, names: readonly (string | undefined)[]): Taken {
    const step = { requests: [req.id], command: cmd };
    if (names.some((n) => n !== undefined && this.added.has(n))) { this.waiting.push(step); return { run: [] }; }
    return { run: [step] };
  }

  private view(req: Extract<VoweRequest, { type: 'show_view' }>): Taken {
    const { view, focus, sequence } = req.payload;
    const parts = [...(focus ?? []), ...(sequence?.actors ?? [])];
    const firstWorker = parts.map((id) => this.part(id)).find((c) => c?.kind === 'worker' || c?.kind === 'service')?.id;
    const about = (focus?.[0] ? this.id(focus[0]) : undefined) ?? firstWorker;
    switch (view) {
      case 'arch':
        return this.now(req, command('show_view', { view: 'architecture' }, req.id), []);
      case 'concurrency':
        return this.now(req, command('show_view', { view: 'concurrency', ...(about ? { focus: about } : {}) }, req.id), parts);
      case 'failure':
      case 'timeout': {
        // The engine draws a failure from the system itself (who leases, what's called, when it acks),
        // in the design's grammar, so a crash is asked for by who crashes rather than step by step.
        const crash = sequence?.steps.find((s) => s.tone === 'crash');
        const who = crash ? this.id(crash.actor) : about;
        if (who && (crash || view === 'timeout')) {
          return this.now(req, command('add_failure', { component: who, mode: view === 'timeout' ? 'timeout' : 'crash' }, req.id), parts);
        }
        return this.now(req, command('show_view', { view: 'failure-flow', ...(who ? { focus: who } : {}) }, req.id), parts);
      }
      default:
        return { declined: `The room’s canvas has no ${VIEW_NAMES[view]} view yet; it draws Architecture, Failure flow and Concurrency` };
    }
  }
}

const VIEW_NAMES: Record<RuntimeView, string> = {
  arch: 'Architecture', failure: 'Failure flow', alternatives: 'Alternatives', concurrency: 'Concurrency', impl: 'Implementation', timeout: 'Provider timeout', ui: 'Checkout UI',
};

function list(names: string[]) {
  return names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function connectTitle(change: ProposalChange, doc: CanvasDocument) {
  if (change.name !== 'connect_components') return 'Change the system';
  const name = (id: string) => doc.components[id]?.name ?? id;
  return `${name(change.args.from)} ${RELATION_WORDS[change.args.kind]} ${name(change.args.to)}`;
}

/** The part of the canvas hub (integrations/supabase/canvas.ts) a turn needs. */
export interface TurnHub {
  peek(roomId: string): { doc: CanvasDocument } | null;
  executeAsAgent(roomId: string, raw: unknown): Promise<{ result: CommandResult }>;
}

/**
 * Wraps a turn's event stream: forwards every event, runs canvas requests on the hub as they're validated,
 * and holds the ending event until the turn's proposal (if any) is saved, so it stays the last event.
 */
export function canvasEvents(hub: TurnHub, roomId: string, forward: (event: AgentEvent) => void): (event: AgentEvent) => void {
  const turn = new TurnCanvas(() => hub.peek(roomId)?.doc ?? emptyDocument());
  let queue = Promise.resolve();
  const run = (turnId: string, steps: CanvasStep[]) => {
    if (!steps.length) return;
    queue = queue.then(async () => {
      for (const { requests, command: cmd } of steps) {
        const { result } = await hub.executeAsAgent(roomId, cmd);
        forward({ type: 'canvas.applied', turnId, requests, result });
      }
    }).catch((err: Error) => console.warn('[vowe canvas]', err.message));
  };

  return (event) => {
    switch (event.type) {
      case 'canvas.command': {
        forward(event);
        const taken = turn.take(event.command);
        if ('run' in taken) run(event.turnId, taken.run);
        else {
          forward({
            type: 'canvas.applied', turnId: event.turnId, requests: [event.command.id],
            result: { ok: false, command: event.command.id, name: event.command.type, error: { code: 'unsupported', message: taken.declined } },
          });
        }
        return;
      }
      case 'turn.completed':
        run(event.turnId, turn.finish());
        void queue.then(() => forward(event));
        return;
      case 'turn.cancelled':
      case 'turn.failed':
        turn.drop();
        void queue.then(() => forward(event));
        return;
      default:
        forward(event);
    }
  };
}
