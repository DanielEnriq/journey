/**
 * The contract between Vowe's runtime and the canvas engine, version 1.
 *
 * In: a CanvasSnapshot, what the asking person's canvas shows (the view, its components and
 * relationships, what they selected or circled). The canvas engine sends it with each question.
 *
 * Out: CanvasCommands, requests to change the canvas, each naming components by their stable ids.
 * The runtime only emits commands that validate against this schema and against the snapshot they
 * were made from; the canvas engine owns executing and drawing them, and may decline any. Commands
 * never carry markup, code, or images: only ids, a few enumerated options, and short text.
 *
 * View ids and component kinds are the canvas's own (renderer/features/room/types.ts); the type
 * checks below fail the build if the two drift apart.
 */

import { z } from 'zod';
import type { PartKind, ViewId } from '../renderer/features/room/types.js';

export const CANVAS_CONTRACT_VERSION = 1;

export const VIEW_IDS = ['arch', 'failure', 'alternatives', 'concurrency', 'impl', 'timeout', 'ui'] as const;
export const COMPONENT_KINDS = ['service', 'queue', 'external', 'store', 'client', 'code'] as const;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _views: Same<(typeof VIEW_IDS)[number], ViewId> = true;
const _kinds: Same<(typeof COMPONENT_KINDS)[number], PartKind> = true;
void _views, void _kinds;

const componentId = z.string().regex(/^[A-Za-z][\w-]{0,63}$/, 'a component id: a letter, then letters, digits, - or _');
const shortText = (max: number) => z.string().trim().min(1).max(max);

// ─── In: what the canvas shows ───────────────────────────────────────────────

export const canvasSnapshotSchema = z
  .object({
    version: z.literal(CANVAS_CONTRACT_VERSION),
    view: z.enum(VIEW_IDS),
    /** Views the room has, with the question each answers. */
    views: z.array(z.object({ id: z.enum(VIEW_IDS), name: shortText(60), question: z.string().max(200).optional() }).strict()).max(20),
    components: z
      .array(
        z
          .object({
            id: componentId,
            name: shortText(80),
            kind: z.enum(COMPONENT_KINDS),
            /** How it's named mid-sentence: "the worker". */
            short: z.string().max(80).optional(),
            /** What it is, as the canvas labels it: "retry-worker", "jobs · 30s lease". */
            tech: z.string().max(120).optional(),
            /** Dashed: proposed, not agreed. */
            proposed: z.boolean().optional(),
            /** Repository paths the canvas binds to this component, when it knows them. */
            paths: z.array(z.string().max(300)).max(20).optional(),
          })
          .strict(),
      )
      .max(200),
    relationships: z.array(z.object({ from: componentId, to: componentId, label: z.string().max(60).optional() }).strict()).max(400),
    selection: z.object({ selected: z.array(componentId).max(50), circled: z.array(componentId).max(50) }).strict(),
  })
  .strict();

export type CanvasSnapshot = z.infer<typeof canvasSnapshotSchema>;

// ─── Out: what Vowe asks the canvas to do ────────────────────────────────────

/** Payloads, as the model's canvas tools take them. */
export const canvasPayloads = {
  highlight_component: z
    .object({
      componentIds: z.array(componentId).min(1).max(8),
      /** focus: what the answer is about; risk: where it goes wrong; verified: checked against evidence. */
      tone: z.enum(['focus', 'risk', 'verified']),
    })
    .strict(),
  annotate_component: z
    .object({
      componentId,
      /** The record's thread kinds Vowe may suggest. Suggested notes stay outlined until a person keeps them. */
      kind: z.enum(['note', 'concern', 'question', 'constraint']),
      text: shortText(280),
    })
    .strict(),
  show_view: z
    .object({
      view: z.enum(VIEW_IDS),
      focus: z.array(componentId).max(8).optional(),
      /** For sequence views (failure, timeout, concurrency): who acts, and what happens, in order. */
      sequence: z
        .object({
          actors: z.array(componentId).min(1).max(6),
          steps: z
            .array(
              z
                .object({
                  actor: componentId,
                  title: shortText(60),
                  detail: z.string().trim().max(140).optional(),
                  tone: z.enum(['normal', 'crash', 'bad', 'good']).default('normal'),
                })
                .strict(),
            )
            .min(1)
            .max(12),
        })
        .strict()
        .optional(),
    })
    .strict(),
  propose_component: z
    .object({
      component: z.object({ id: componentId, name: shortText(80), kind: z.enum(COMPONENT_KINDS), tech: z.string().max(120).optional() }).strict(),
      near: componentId.optional(),
    })
    .strict(),
  connect_components: z.object({ from: componentId, to: componentId, label: shortText(40) }).strict(),
} as const;

export type CanvasCommandType = keyof typeof canvasPayloads;
export const CANVAS_COMMAND_TYPES = Object.keys(canvasPayloads) as CanvasCommandType[];

const envelope = {
  v: z.literal(CANVAS_CONTRACT_VERSION),
  /** Unique per command. */
  id: z.string().min(1).max(100),
  roomId: z.string().min(1).max(100),
  turnId: z.string().min(1).max(100),
  /** The cloud user whose question led to it. */
  requestedBy: z.string().min(1).max(100),
  /** Why, in a sentence a person reads on the canvas. */
  reason: shortText(240),
  /** Evidence ids from the turn (see evidence.ts) that support it; may be empty for a pure illustration. */
  evidence: z.array(z.string().max(20)).max(20),
  /** Room-visible: commands change the shared canvas. */
  visibility: z.literal('room'),
};

export const canvasCommandSchema = z.discriminatedUnion('type', [
  z.object({ ...envelope, type: z.literal('highlight_component'), payload: canvasPayloads.highlight_component }).strict(),
  z.object({ ...envelope, type: z.literal('annotate_component'), payload: canvasPayloads.annotate_component }).strict(),
  z.object({ ...envelope, type: z.literal('show_view'), payload: canvasPayloads.show_view }).strict(),
  z.object({ ...envelope, type: z.literal('propose_component'), payload: canvasPayloads.propose_component }).strict(),
  z.object({ ...envelope, type: z.literal('connect_components'), payload: canvasPayloads.connect_components }).strict(),
]);

export type CanvasCommand = z.infer<typeof canvasCommandSchema>;

export type CanvasValidation = { ok: true; command: CanvasCommand } | { ok: false; errors: string[] };

/**
 * Validates a command: its shape, then that every component it names exists in the snapshot (or was
 * proposed earlier in the same turn), and that a proposed component doesn't reuse a taken id.
 */
export function validateCanvasCommand(value: unknown, snapshot: CanvasSnapshot, proposedEarlier: ReadonlySet<string> = new Set()): CanvasValidation {
  const parsed = canvasCommandSchema.safeParse(value);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || 'command'}: ${i.message}`) };
  const command = parsed.data;
  const known = new Set([...snapshot.components.map((c) => c.id), ...proposedEarlier]);
  const errors: string[] = [];
  const need = (id: string | undefined, where: string) => {
    if (id !== undefined && !known.has(id)) errors.push(`${where}: no component "${id}" on this canvas`);
  };
  switch (command.type) {
    case 'highlight_component':
      command.payload.componentIds.forEach((id, i) => need(id, `payload.componentIds.${i}`));
      break;
    case 'annotate_component':
      need(command.payload.componentId, 'payload.componentId');
      break;
    case 'show_view': {
      const { focus, sequence } = command.payload;
      focus?.forEach((id, i) => need(id, `payload.focus.${i}`));
      sequence?.actors.forEach((id, i) => need(id, `payload.sequence.actors.${i}`));
      const actors = new Set(sequence?.actors);
      sequence?.steps.forEach((s, i) => {
        if (!actors.has(s.actor)) errors.push(`payload.sequence.steps.${i}.actor: "${s.actor}" is not one of the sequence's actors`);
      });
      if (sequence && !['failure', 'timeout', 'concurrency'].includes(command.payload.view)) errors.push(`payload.sequence: the ${command.payload.view} view isn't a sequence`);
      break;
    }
    case 'propose_component':
      if (known.has(command.payload.component.id)) errors.push(`payload.component.id: "${command.payload.component.id}" is already on the canvas`);
      need(command.payload.near, 'payload.near');
      break;
    case 'connect_components':
      need(command.payload.from, 'payload.from');
      need(command.payload.to, 'payload.to');
      if (command.payload.from === command.payload.to) errors.push('payload: a component can’t connect to itself');
      break;
  }
  return errors.length ? { ok: false, errors } : { ok: true, command };
}

/** The components a question is about: what the person circled, else what they selected. */
export function focusOf(snapshot: CanvasSnapshot) {
  const ids = snapshot.selection.circled.length ? snapshot.selection.circled : snapshot.selection.selected;
  const byId = new Map(snapshot.components.map((c) => [c.id, c]));
  return {
    how: snapshot.selection.circled.length ? ('circled' as const) : snapshot.selection.selected.length ? ('selected' as const) : ('none' as const),
    components: ids.flatMap((id) => byId.get(id) ?? []),
    /** Ids the canvas sent that it doesn't show: stale selections. */
    missing: ids.filter((id) => !byId.has(id)),
  };
}
