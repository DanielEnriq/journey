import type { CommandName } from './commands.js';
import { COMPONENT_KINDS, NOTE_KINDS, RELATIONSHIP_KINDS, VIEW_TYPES } from './model.js';

// The Canvas Command API as tool definitions for the reasoning runtime: JSON Schema in the shape the
// Anthropic Messages API takes ({ name, description, input_schema }). A tool call comes back through
// `fromToolCall(name, input)` and runs through the same hub as a person's pen. These schemas describe;
// commands.ts is what actually validates, so a call that passes a schema can still be refused there.
//
// Only what Vowe may do is offered: accepting or rejecting proposals, keeping views and notes, and
// removing components are a person's to do, and the engine refuses them from the agent anyway.

type Schema = Record<string, unknown>;
export interface ToolDefinition { name: CommandName; description: string; input_schema: Schema }

const ID: Schema = { type: 'string', pattern: '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$', maxLength: 64, description: 'A stable semantic id, like "payment-worker".' };
const text = (max: number, description?: string): Schema => ({ type: 'string', minLength: 1, maxLength: max, ...(description ? { description } : {}) });
const object = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: 'object', properties, required, additionalProperties: false });

const COMPONENT_FIELDS: Record<string, Schema> = {
  kind: { enum: [...COMPONENT_KINDS] },
  name: text(80, 'What the room calls it: "Payment Worker".'),
  short: text(80, 'How it is named mid-sentence: "the worker".'),
  tech: text(120, 'One line under the name: "retry-worker".'),
  parent: { ...ID, description: 'The boundary a service sits in, or the queue an event waits in.' },
  endpoint: text(120, 'A service’s entry point: "POST /webhooks/payment".'),
  lease: text(40, 'A queue’s lease or visibility timeout: "30s".'),
  rows: { type: 'array', maxItems: 30, items: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 80 } }, description: 'A database’s rows; the first is the header.' },
  label: text(40, 'An event’s label: "#4182".'),
  amount: text(40),
  state: { enum: ['waiting', 'leased', 'done'], description: 'Where an event stands in the steady state.' },
  facts: { type: 'object', additionalProperties: { type: 'string', maxLength: 200 }, maxProperties: 12, description: 'Small facts for wording: { "item": "retry", "subject": "card" }.' },
  note: text(240, 'A caption under it in the Architecture view.'),
};
const COMPONENT = object({ id: ID, ...COMPONENT_FIELDS }, ['id', 'kind', 'name']);
const CONNECTION = object({
  from: ID, to: ID, kind: { enum: [...RELATIONSHIP_KINDS] },
  label: text(40, 'The verb on the wire: "charge".'), past: text(40, 'The verb in the past tense: "charged".'),
}, ['from', 'to', 'kind']);
const REF: Schema = {
  oneOf: [
    object({ component: ID, instance: { type: 'integer', minimum: 1, maximum: 8 } }, ['component']),
    object({ step: text(80), view: ID, component: ID }, ['step', 'view', 'component']),
  ],
};

export const CANVAS_TOOLS: ToolDefinition[] = [
  {
    name: 'load_system', description: 'Puts a whole system on the room’s canvas from structured input. From Vowe it lands as one proposal.',
    input_schema: object({ components: { type: 'array', maxItems: 200, items: COMPONENT }, relationships: { type: 'array', maxItems: 400, items: CONNECTION } }, ['components']),
  },
  { name: 'add_component', description: 'Proposes a new component.', input_schema: object({ component: COMPONENT }, ['component']) },
  {
    name: 'update_component', description: 'Proposes a change to a component. Its id never changes.',
    input_schema: object({ component: ID, patch: object(COMPONENT_FIELDS) }, ['component', 'patch']),
  },
  { name: 'connect_components', description: 'Proposes a relationship between two components.', input_schema: CONNECTION },
  {
    name: 'highlight_component', description: 'Points at components with Vowe’s focus ring, for everyone in the call. An empty list stops pointing.',
    input_schema: object({ components: { type: 'array', maxItems: 20, items: ID } }, ['components']),
  },
  {
    name: 'annotate_component', description: 'Pins a suggested note to a component. A person keeps it or removes it.',
    input_schema: object({ component: ID, text: text(1000), kind: { enum: [...NOTE_KINDS] } }, ['component', 'text']),
  },
  {
    name: 'show_view', description: 'Switches everyone in the call to a view. Give a view id, or a type ("failure-flow", "concurrency"): the room’s view of that type about `focus` is shown, drawn first if there isn’t one.',
    input_schema: object({ view: text(64), focus: ID, instances: { type: 'integer', minimum: 2, maximum: 4 } }, ['view']),
  },
  {
    name: 'create_view', description: 'Draws a new view of the system without changing the system. From Vowe it is proposed until a person keeps it.',
    input_schema: object({
      type: { enum: [...VIEW_TYPES] }, id: ID, name: text(60), question: text(200), focus: ID, subject: ID,
      instances: { type: 'integer', minimum: 2, maximum: 4 }, parent: ID, show: { type: 'boolean' },
    }, ['type']),
  },
  {
    name: 'add_failure', description: 'In a Failure flow, the component crashes (or times out) after a step and before acknowledging its job. Defaults to after its last irreversible call.',
    input_schema: object({ component: ID, view: ID, after: text(80, 'A step id ("s2") or title ("Card charged").'), mode: { enum: ['crash', 'timeout'] } }, ['component']),
  },
  {
    name: 'propose_change', description: 'Proposes several structural changes as one decision the room accepts or rejects.',
    input_schema: object({
      title: text(200), rationale: text(1000),
      changes: {
        type: 'array', minItems: 1, maxItems: 30,
        items: object({ name: { enum: ['add_component', 'update_component', 'connect_components'] }, args: { type: 'object' } }, ['name', 'args']),
      },
    }, ['title', 'changes']),
  },
  { name: 'remove_view', description: 'Removes a view Vowe drew.', input_schema: object({ view: ID }, ['view']) },
  {
    name: 'draw', description: 'Circles or marks parts of a view. `d` is a path of straight segments in the view’s coordinates; `refs` says what it means.',
    input_schema: object({ view: ID, kind: { enum: ['ink', 'circle'] }, d: text(40000), refs: { type: 'array', maxItems: 40, items: REF } }, ['view', 'kind', 'd']),
  },
  { name: 'remove_annotation', description: 'Removes one of Vowe’s own notes or marks.', input_schema: object({ annotation: text(80) }, ['annotation']) },
  { name: 'undo', description: 'Undoes Vowe’s latest change, or the given command, unless someone changed the same thing since.', input_schema: object({ command: text(80) }) },
];
