import type { CommandArgs } from '../commands.js';

// Systems to load as structured input. The payment system is the one the Payment Reliability design
// draws: loading it and asking the design's questions reproduces its Architecture, Failure flow and
// Concurrency boards from the document alone. The orders system is a second, different system, so tests
// and the harness show the views aren't fitted to one example.

export const PAYMENT_SYSTEM: CommandArgs['load_system'] = {
  components: [
    { id: 'payments-service', kind: 'boundary', name: 'payments service' },
    { id: 'webhook-api', kind: 'service', name: 'Webhook API', short: 'the webhook API', tech: 'receives provider events', endpoint: 'POST /webhooks/payment', note: 'payment.failed → enqueue a retry' },
    { id: 'retry-queue', kind: 'queue', name: 'Retry Queue', short: 'the queue', tech: 'jobs · 30s lease', lease: '30s', parent: 'payments-service', facts: { item: 'retry' } },
    { id: 'payment-worker', kind: 'worker', name: 'Payment Worker', short: 'the worker', tech: 'retry-worker', parent: 'payments-service' },
    { id: 'payment-provider', kind: 'external', name: 'Payment Provider', short: 'the provider', tech: 'external · you don’t run it', facts: { subject: 'card' } },
    { id: 'ledger', kind: 'database', name: 'Ledger', short: 'the ledger', tech: 'payments db', parent: 'payments-service', rows: [['payment', 'amount', 'status'], ['#4180', '$12.00', 'settled'], ['#4181', '$30.00', 'settled']] },
    { id: 'job-4181', kind: 'event', name: 'Retry #4181', label: '#4181', parent: 'retry-queue', state: 'done', amount: '$30.00', facts: { subject: 'payment' } },
    { id: 'job-4182', kind: 'event', name: 'Retry #4182', label: '#4182', parent: 'retry-queue', state: 'leased', amount: '$48.00', facts: { subject: 'payment' } },
    { id: 'job-4183', kind: 'event', name: 'Retry #4183', label: '#4183', parent: 'retry-queue', state: 'waiting', amount: '$22.00', facts: { subject: 'payment' } },
  ],
  relationships: [
    { from: 'webhook-api', to: 'retry-queue', kind: 'publishes', label: 'enqueue' },
    { from: 'payment-worker', to: 'retry-queue', kind: 'consumes', label: 'lease' },
    { from: 'payment-worker', to: 'payment-provider', kind: 'calls', label: 'charge', past: 'charged' },
    { from: 'payment-worker', to: 'ledger', kind: 'reads_writes', label: 'record' },
  ],
};

export const ORDERS_SYSTEM: CommandArgs['load_system'] = {
  components: [
    { id: 'orders-api', kind: 'service', name: 'Orders API', short: 'the API', tech: 'orders-api', endpoint: 'POST /orders' },
    { id: 'order-events', kind: 'queue', name: 'Order Events', short: 'the topic', tech: 'kafka · orders.created', facts: { item: 'event' } },
    { id: 'email-sender', kind: 'worker', name: 'Email Sender', short: 'the sender', tech: 'mailer', facts: { instance: 'sender' } },
    { id: 'mail-provider', kind: 'external', name: 'Mail Provider', short: 'the mail provider', tech: 'external · SMTP relay', facts: { subject: 'receipt' } },
    { id: 'orders-db', kind: 'database', name: 'Orders DB', tech: 'postgres', rows: [['order', 'total', 'state'], ['o-77', '$18.00', 'paid']] },
    { id: 'evt-77', kind: 'event', name: 'Order o-77 created', label: 'o-77', parent: 'order-events', state: 'leased', facts: { subject: 'order' } },
  ],
  relationships: [
    { from: 'orders-api', to: 'orders-db', kind: 'reads_writes', label: 'insert' },
    { from: 'orders-api', to: 'order-events', kind: 'publishes', label: 'publish' },
    { from: 'email-sender', to: 'order-events', kind: 'consumes', label: 'poll' },
    { from: 'email-sender', to: 'mail-provider', kind: 'calls', label: 'send', past: 'sent' },
  ],
};
