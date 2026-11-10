import {
  REGISTRY_SCHEMA, relationKey,
  type Entity, type EntityKind, type EntityLevel, type Evidence, type Relation, type RelationKind, type Sequence, type SequenceStep, type SystemRegistry,
} from '../model.js';
import { sortedRecord } from '../registry-utils.js';

// A second, hand-made system for testing the canvas against a different application and question: a
// payments service with an HTTP API, a job queue, a charge worker, a card provider's webhook, a Postgres
// store and an event stream that a notification worker consumes. It is a FIXTURE: no repository was
// indexed, every piece of evidence points at a `fixture://` path, and the registry says so in `fixture`.
// Never present it as a description of real code.

const NOTE = 'Hand-made fixture describing a fictional payments system (no repository was indexed). Evidence paths are fixture:// placeholders, not real files.';

class Fixture {
  entities: Record<string, Entity> = {};
  relations: Record<string, Relation> = {};
  evidence: Record<string, Evidence> = {};
  sequences: Record<string, Sequence> = {};
  private line = 1;

  ev(summary: string, file: string, kind: Evidence['kind'] = 'definition'): string {
    const id = `ev:fixture:${Object.keys(this.evidence).length + 1}`;
    const line = this.line; this.line += 7;
    this.evidence[id] = { id, kind, summary: `Fixture: ${summary}`, range: { file: `fixture://ledgerline/${file}`, start: { line, col: 1 }, end: { line: line + 5, col: 1 } } };
    return id;
  }

  ent(id: string, kind: EntityKind, name: string, level: EntityLevel, parent: string | undefined, file: string, extra: { summary?: string; attrs?: Entity['attrs'] } = {}) {
    const ev = this.ev(`${name} (${kind})`, file);
    this.entities[id] = {
      id, kind, name, level, ...(parent ? { parent } : {}), ...(extra.summary ? { summary: extra.summary } : {}),
      anchors: [{ file: `fixture://ledgerline/${file}` }], attrs: { fixture: true, ...(extra.attrs ?? {}) },
      provenance: 'code', evidence: [ev], status: 'current',
    };
    if (parent) this.rel('contains', parent, id);
    return id;
  }

  rel(kind: RelationKind, from: string, to: string, label?: string, file = 'wiring.ts') {
    const id = relationKey(from, kind, to);
    const ev = this.ev(`${from} ${kind} ${to}${label ? ` (${label})` : ''}`, file, kind === 'contains' ? 'definition' : 'reference');
    this.relations[id] = { id, kind, from, to, ...(label ? { label } : {}), provenance: 'code', evidence: [ev], status: 'current' };
    return id;
  }

  seq(id: string, title: string, subject: string, notes: string[], steps: (Omit<SequenceStep, 'evidence'> & { file?: string })[]) {
    this.sequences[id] = {
      id, title, kind: 'code-path', subject, provenance: 'inferred', notes, evidence: [this.ev(title, 'sequences.md', 'flow')],
      steps: steps.map(({ file, ...s }) => ({ ...s, evidence: [this.ev(s.label, file ?? 'flow.ts', 'flow')] })),
    };
  }
}

function build(): SystemRegistry {
  const f = new Fixture();
  const sys = f.ent('system:ledgerline', 'system', 'Ledgerline payments', 'system', undefined, 'README.md', { summary: 'Takes card payments, settles them through a card provider, and tells customers.' });
  const api = f.ent('subsystem:api', 'subsystem', 'API', 'system', sys, 'api/');
  const work = f.ent('subsystem:workers', 'subsystem', 'Workers', 'system', sys, 'workers/');
  const data = f.ent('subsystem:data', 'subsystem', 'Data', 'system', sys, 'db/');
  const outside = f.ent('subsystem:outside', 'subsystem', 'Outside', 'system', sys, 'external.md');

  // API
  const dash = f.ent('component:merchant-dashboard', 'interface', 'Merchant dashboard', 'component', api, 'web/Dashboard.tsx', { summary: 'Where a merchant sees payments and issues refunds.' });
  f.ent('interaction:merchant-dashboard/refund', 'interaction', 'Refund', 'element', dash, 'web/Dashboard.tsx', { attrs: { tool: 'refund', label: 'Refund' } });
  f.ent('interaction:merchant-dashboard/retry', 'interaction', 'Retry charge', 'element', dash, 'web/Dashboard.tsx', { attrs: { tool: 'retry', label: 'Retry charge' } });
  const http = f.ent('component:payments-api', 'service', 'Payments API', 'component', api, 'api/server.ts', { summary: 'HTTP API: takes payments and the provider\'s webhooks.' });
  const postPay = f.ent('endpoint:post-payments', 'endpoint', 'POST /payments', 'element', http, 'api/payments.ts', { attrs: { route: '/payments', method: 'POST' } });
  const postRefund = f.ent('endpoint:post-refunds', 'endpoint', 'POST /refunds', 'element', http, 'api/refunds.ts', { attrs: { route: '/refunds', method: 'POST' } });
  const hook = f.ent('endpoint:post-webhooks-provider', 'endpoint', 'POST /webhooks/provider', 'element', http, 'api/webhooks.ts', { attrs: { route: '/webhooks/provider', method: 'POST' } });
  const verify = f.ent('validator:payments-api/verify-signature', 'validator', 'verifySignature', 'element', http, 'api/webhooks.ts', { summary: 'Rejects a webhook whose signature does not match the shared secret.' });
  const handleHook = f.ent('function:payments-api/handle-webhook', 'function', 'handleWebhook', 'element', http, 'api/webhooks.ts');

  // Workers
  const queue = f.ent('component:job-queue', 'queue', 'Job queue', 'component', work, 'queue/jobs.ts', { summary: 'Charges waiting for the worker; 30s visibility timeout.', attrs: { lease: '30s' } });
  const charge = f.ent('component:charge-worker', 'worker', 'Charge worker', 'component', work, 'workers/charge.ts', { summary: 'Leases a charge job and asks the provider to capture it.' });
  const chargeRun = f.ent('method:charge-worker/run', 'method', 'run', 'element', charge, 'workers/charge.ts');
  const notify = f.ent('component:notification-worker', 'worker', 'Notification worker', 'component', work, 'workers/notify.ts', { summary: 'Turns payment events into customer emails.' });
  const ledger = f.ent('component:ledger-engine', 'engine', 'Ledger engine', 'component', work, 'ledger/engine.ts', { summary: 'Applies payment events to the ledger: one handler per event type.' });
  const capture = f.ent('command:ledger-engine/capture', 'command', 'capture', 'element', ledger, 'ledger/engine.ts', { attrs: { key: 'capture' } });
  f.ent('command:ledger-engine/refund', 'command', 'refund', 'element', ledger, 'ledger/engine.ts', { attrs: { key: 'refund' } });
  f.ent('command:ledger-engine/settle', 'command', 'settle', 'element', ledger, 'ledger/engine.ts', { attrs: { key: 'settle' } });

  // Data
  const db = f.ent('component:payments-db', 'store', 'Payments database', 'component', data, 'db/schema.sql', { summary: 'Postgres: payments, the ledger, received webhooks, the outbox.', attrs: { engine: 'postgres' } });
  const payments = f.ent('table:payments', 'table', 'payments', 'element', db, 'db/schema.sql', { attrs: { columns: ['id', 'amount', 'status', 'provider_ref'], keys: ['id'] } });
  const entries = f.ent('table:ledger-entries', 'table', 'ledger_entries', 'element', db, 'db/schema.sql', { attrs: { columns: ['id', 'payment_id', 'kind', 'amount'], keys: ['id'] } });
  const events = f.ent('table:webhook-events', 'table', 'webhook_events', 'element', db, 'db/schema.sql', { attrs: { columns: ['provider_event_id', 'payload', 'received_at'], keys: ['provider_event_id'] } });
  const outbox = f.ent('table:outbox', 'table', 'outbox', 'element', db, 'db/schema.sql', { attrs: { columns: ['id', 'topic', 'payload', 'sent_at'], keys: ['id'] } });
  const record = f.ent('store-function:record-webhook', 'store-function', 'record_webhook', 'element', db, 'db/schema.sql', { summary: 'Inserts a webhook event once: returns false when the provider already sent it.' });
  const stream = f.ent('event-channel:payment-events', 'event-channel', 'payment events', 'component', data, 'events/topics.ts', { summary: 'payment.succeeded / payment.failed, relayed from the outbox.' });

  // Outside
  const provider = f.ent('component:card-provider', 'external', 'Card provider', 'component', outside, 'external.md', { summary: 'A third-party card processor; calls our webhook, retrying with backoff until it gets a 2xx.' });
  const email = f.ent('component:email-provider', 'external', 'Email provider', 'component', outside, 'external.md');

  // Relations
  f.rel('calls', dash, http, 'POST /payments, /refunds');
  f.rel('produces', 'interaction:merchant-dashboard/refund', postRefund, 'refund');
  f.rel('produces', 'interaction:merchant-dashboard/retry', postPay, 'retry');
  f.rel('publishes', http, queue, 'enqueue charge');
  f.rel('consumes', charge, queue, 'lease');
  f.rel('calls', charge, provider, 'capture');
  f.rel('writes', charge, db, 'payments.status');
  f.rel('writes', chargeRun, payments, 'status = pending');
  f.rel('sends', provider, hook, 'payment.captured');
  f.rel('sends', provider, http, 'webhooks');
  f.rel('handles', hook, handleHook);
  f.rel('calls', handleHook, verify);
  f.rel('calls', handleHook, record, 'record_webhook');
  f.rel('calls', http, db, 'record_webhook');
  f.rel('writes', record, events, 'insert … on conflict do nothing');
  f.rel('calls', http, ledger, 'apply');
  f.rel('calls', handleHook, capture, 'capture');
  f.rel('writes', capture, entries);
  f.rel('writes', capture, payments, 'status = captured');
  f.rel('writes', capture, outbox, 'payment.succeeded');
  f.rel('writes', ledger, db);
  f.rel('publishes', db, stream, 'outbox relay');
  f.rel('consumes', notify, stream, 'payment.succeeded');
  f.rel('calls', notify, email, 'send receipt');
  f.ent('test:webhooks-test', 'test', 'Webhook tests', 'element', http, 'api/webhooks.test.ts', { attrs: { cases: 6 } });
  f.rel('verified_by', http, 'test:webhooks-test');

  f.seq('sequence:webhook-retry', 'A provider webhook, delivered at least once', 'endpoint:post-webhooks-provider', [
    'Fixture: a hand-made possible path, not derived from code and not a recorded run.',
    'The provider retries any non-2xx answer with backoff; record_webhook makes a repeat delivery a no-op.',
  ], [
    { id: 'w1', entity: provider, label: 'POST /webhooks/provider', detail: 'payment.captured', relation: relationKey(provider, 'sends', hook), file: 'external.md' },
    { id: 'w2', entity: hook, label: 'receive event', file: 'api/webhooks.ts' },
    { id: 'w3', entity: verify, label: 'verifySignature(body, header)', relation: relationKey(handleHook, 'calls', verify), ctx: ['try'], file: 'api/webhooks.ts' },
    { id: 'w4', entity: record, label: "rpc('record_webhook')", relation: relationKey(handleHook, 'calls', record), ctx: ['try'], next: ['w5', 'w6'], file: 'api/webhooks.ts' },
    { id: 'w5', entity: hook, label: 'already recorded: answer 200', guard: 'if (!inserted)', ctx: ['branch'], next: [], file: 'api/webhooks.ts' },
    { id: 'w6', entity: capture, label: "apply('capture')", relation: relationKey(handleHook, 'calls', capture), ctx: ['try'], next: ['w7', 'w9'], file: 'ledger/engine.ts' },
    { id: 'w7', entity: entries, label: 'insert ledger entry, outbox row', relation: relationKey(capture, 'writes', entries), ctx: ['try'], file: 'ledger/engine.ts' },
    { id: 'w8', entity: hook, label: 'answer 200', next: [], file: 'api/webhooks.ts' },
    { id: 'w9', entity: hook, label: 'database timeout: answer 500', guard: 'catch (err)', ctx: ['catch'], next: ['w10'], file: 'api/webhooks.ts' },
    { id: 'w10', entity: provider, label: 'retry with backoff (≤ 3 days)', ctx: ['loop'], guard: 'while (status >= 500)', next: ['w1'], file: 'external.md' },
  ]);
  f.seq('sequence:command-path:charge', 'How a charge travels: from POST /payments to the provider', 'endpoint:post-payments', [
    'Fixture: a hand-made possible path, not derived from code and not a recorded run.',
  ], [
    { id: 'c1', entity: dash, label: 'Pay', file: 'web/Dashboard.tsx' },
    { id: 'c2', entity: postPay, label: 'POST /payments', relation: relationKey(dash, 'calls', http), file: 'api/payments.ts' },
    { id: 'c3', entity: queue, label: 'enqueue charge', relation: relationKey(http, 'publishes', queue), file: 'api/payments.ts' },
    { id: 'c4', entity: chargeRun, label: 'lease job', relation: relationKey(charge, 'consumes', queue), file: 'workers/charge.ts' },
    { id: 'c5', entity: payments, label: 'status = pending', relation: relationKey(chargeRun, 'writes', payments), file: 'workers/charge.ts' },
    { id: 'c6', entity: provider, label: 'capture', relation: relationKey(charge, 'calls', provider), file: 'workers/charge.ts' },
  ]);

  return {
    schema: REGISTRY_SCHEMA,
    revision: {
      repo: { id: 'fixture:ledgerline', name: 'ledgerline (fixture)', root: 'fixture://ledgerline' },
      head: null, branch: null, dirty: [], indexedAt: '2026-11-10T00:00:00.000Z', fingerprint: 'fixture-ledgerline-1',
    },
    rules: 'fixture',
    entities: sortedRecord(f.entities), relations: sortedRecord(f.relations), evidence: sortedRecord(f.evidence), sequences: sortedRecord(f.sequences),
    interpretations: {}, diagnostics: [{ severity: 'info', message: NOTE }],
    coverage: { byLang: {}, limits: ['Fixture: nothing was indexed.'], diagnostics: {} },
    incomplete: false,
    fixture: { label: 'Ledgerline payments (fixture)', note: NOTE },
  };
}

export const PAYMENTS_FIXTURE: SystemRegistry = build();
