/**
 * Tools for room turns: the room's shared record (goal, decisions, concerns, constraints, notes), the
 * asker's canvas, the five canvas requests, and the reasoning report. Room data is what every member
 * already sees, so reading it needs no approval; canvas requests are room-visible, so they must not
 * quote local transcripts or code the person hasn't shared (the instructions say so, and annotations
 * are short and outlined as suggestions until a person keeps them).
 */

import { z } from 'zod';
import { canvasPayloads, focusOf, type CanvasCommandType } from './canvas.js';
import { clip, defineTool, type AgentTool, type ToolContext } from './tools.js';

function roomOf(ctx: ToolContext) {
  if (!ctx.room) throw new Error('This conversation is not in a room.');
  return ctx.room;
}

// ─── get_room_context ────────────────────────────────────────────────────────

const getRoomContext = defineTool({
  name: 'get_room_context',
  description:
    "Reads the room's shared record: its goal, its decisions (with their checks, version, and whether every member has signed the current version), " +
    'and open threads pinned to canvas components: concerns, constraints, things to avoid, questions, notes. Each item has an evidence id. ' +
    'Only decisions marked agreed are human-approved; proposed ones are not settled.',
  input: z.object({}).strict(),
  async run(_input, ctx) {
    const room = roomOf(ctx);
    const [details, members, record] = await Promise.all([room.source.room(room.id), room.source.members(room.id), room.source.record(room.id)]);
    const name = (id: string) => members.find((m) => m.userId === id)?.name ?? 'a member';
    return {
      room: details.name,
      goal: details.goal && { text: details.goal, evidence: ctx.cite({ kind: 'goal', ref: `room goal`, excerpt: clip(details.goal, 200), visibility: 'room' }) },
      repository: details.repository,
      members: members.length,
      decisions: record.decisions.map((d) => {
        const signers = new Set(d.signatures.filter((s) => s.version === d.version).map((s) => s.userId));
        const agreed = members.length > 0 && members.every((m) => signers.has(m.userId));
        return {
          evidence: ctx.cite({ kind: 'decision', ref: `decision ${d.id.slice(0, 8)} v${d.version}`, excerpt: clip(`${d.title} — checks: ${d.verify}`, 300), visibility: 'room', approved: agreed }),
          title: d.title,
          checks: d.verify.split(';').map((c) => c.trim()).filter(Boolean),
          version: d.version,
          status: agreed ? 'agreed' : 'proposed',
          signed: `${signers.size} of ${members.length} members signed v${d.version}`,
          proposedBy: d.proposedBy.name ?? 'a member',
        };
      }),
      threads: record.threads.map((t) => ({
        evidence: ctx.cite({ kind: 'thread', ref: `${t.kind} on ${t.anchor.name} (${t.id.slice(0, 8)})`, excerpt: clip(t.body, 200), visibility: 'room' }),
        kind: t.kind,
        on: t.anchor.id === 'pin' ? 'the canvas' : `${t.anchor.name} (${t.anchor.id})`,
        text: clip(t.body, 500),
        by: t.author.name ?? name(t.author.id),
        replies: t.replies.slice(-3).map((r) => clip(r.body, 200)),
      })),
    };
  },
});

// ─── describe_canvas ─────────────────────────────────────────────────────────

const describeCanvas = defineTool({
  name: 'describe_canvas',
  description:
    "Describes the asker's canvas: the current view, the views available, every component (id, name, kind, what it is, repository paths bound to it) and the relationships drawn between them, " +
    'and what the asker selected or circled. Component ids are the stable references canvas tools take. A canvas is a drawing: it says what people think the system is, not what the code does.',
  input: z.object({}).strict(),
  async run(_input, ctx) {
    const { canvas } = roomOf(ctx);
    const focus = focusOf(canvas);
    return {
      evidence: ctx.cite({ kind: 'canvas', ref: `canvas: ${canvas.view} view`, excerpt: `${canvas.components.length} components, ${canvas.relationships.length} relationships`, visibility: 'room' }),
      view: canvas.view,
      views: canvas.views,
      focus: { how: focus.how, components: focus.components.map((c) => c.id), stale: focus.missing.length ? focus.missing : undefined },
      components: canvas.components,
      relationships: canvas.relationships,
    };
  },
});

// ─── Canvas requests ─────────────────────────────────────────────────────────

const envelope = {
  reason: z.string().trim().min(1).max(240).describe('Why, in one sentence a person reads on the canvas. No local code or transcript content.'),
  evidence: z.array(z.string()).max(20).default([]).describe('Evidence ids that support this request.'),
};

function canvasTool(type: CanvasCommandType, description: string): AgentTool {
  const input = canvasPayloads[type].extend(envelope);
  return defineTool({
    name: type,
    description: `${description} The canvas engine draws it for the room, and may decline. Validated against the asker's canvas: name components by their ids from describe_canvas.`,
    input: input as z.ZodType<Record<string, unknown> & { reason: string; evidence: string[] }>,
    async run({ reason, evidence, ...payload }, ctx) {
      const result = roomOf(ctx).emit(type, payload, reason, evidence);
      if (!result.ok) throw new Error(`Not sent to the canvas: ${result.errors.join('; ')}`);
      return { sent: true, commandId: result.command.id };
    },
  });
}

const canvasTools = [
  canvasTool('highlight_component', 'Highlights components: what the answer is about (focus), where it goes wrong (risk), or what evidence confirmed (verified).'),
  canvasTool('annotate_component', 'Suggests a short note pinned to a component (a concern, question, constraint or note). It stays outlined as a suggestion until a person keeps it.'),
  canvasTool(
    'show_view',
    'Asks the canvas to show a view. For failure, timeout or concurrency views, include `sequence`: the actors (component ids, in order) and the steps that happen, marking the crash and the bad outcome. Only include steps the evidence supports or that are clearly the hypothetical being asked about.',
  ),
  canvasTool('propose_component', 'Proposes a new component (dashed, until the room agrees), e.g. a store the fix would need.'),
  canvasTool('connect_components', 'Proposes a relationship between two components, drawn dashed until the room agrees.'),
];

// ─── report_reasoning ────────────────────────────────────────────────────────

const reportReasoning = defineTool({
  name: 'report_reasoning',
  description:
    'Reports the claims your answer rests on, once, right before you write the answer. For each claim give its basis and the evidence ids behind it: ' +
    '"observed" (seen in code, Git, transcripts or tool output: cite them), "inferred" (reasoned from what was observed), ' +
    '"hypothetical" (a scenario you are walking through, not a finding), "decided" (a decision every member signed: cite it). ' +
    'List in `gaps` what you could not check (code not found, sharing declined, no tests seen). The runtime checks every citation.',
  input: z
    .object({
      claims: z
        .array(
          z
            .object({
              text: z.string().trim().min(1).max(400),
              basis: z.enum(['observed', 'inferred', 'hypothetical', 'decided']),
              evidence: z.array(z.string()).max(12).default([]),
            })
            .strict(),
        )
        .min(1)
        .max(20),
      gaps: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
    })
    .strict(),
  async run(report, ctx) {
    ctx.report(report);
    return { recorded: true, note: 'Now write the answer for the person.' };
  },
});

export const roomTools: AgentTool[] = [getRoomContext, describeCanvas, ...canvasTools];
export const reasoningTools: AgentTool[] = [reportReasoning];
