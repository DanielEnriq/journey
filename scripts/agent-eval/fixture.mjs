// The eval's world: a small payments repository (a worker that charges, records, then acknowledges a
// leased job), the Payment Reliability canvas with the Payment Worker selected, and a room record.
// Everything here is synthetic, so sharing it with a model needs no one's consent.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const FILES = {
  'README.md': '# payments\n\nCheckout enqueues a charge job; the payment worker leases it, charges the card, and acknowledges it.\n',
  'src/queue/jobs.ts': `export interface Job { id: string; orderId: string; amountCents: number; cardToken: string }

/** Leases are 30 seconds. A job that isn't acknowledged before its lease expires is delivered again. */
export const LEASE_SECONDS = 30;

export interface JobQueue {
  lease(worker: string, seconds?: number): Promise<Job | null>;
  /** Removes the job for good. Until this runs, the job will be redelivered once the lease expires. */
  acknowledge(jobId: string): Promise<void>;
}
`,
  'src/payments/processor.ts': `export interface Charge { id: string; status: 'succeeded' | 'failed' }

export interface CardProcessor {
  /** Charges the card. Each call is a new charge: no idempotency key is sent. */
  charge(cardToken: string, amountCents: number): Promise<Charge>;
}
`,
  'src/payments/worker.ts': `import type { CardProcessor } from './processor';
import type { JobQueue } from '../queue/jobs';
import { LEASE_SECONDS } from '../queue/jobs';
import type { Orders } from '../store/orders';

export async function runPaymentWorker(queue: JobQueue, processor: CardProcessor, orders: Orders) {
  for (;;) {
    const job = await queue.lease('payment-worker', LEASE_SECONDS);
    if (!job) continue;

    const charge = await processor.charge(job.cardToken, job.amountCents);
    await orders.markPaid(job.orderId, charge.id);

    await queue.acknowledge(job.id);
  }
}
`,
  'src/store/orders.ts': `export interface Orders {
  /** Records the charge on the order. Overwrites any earlier charge id. */
  markPaid(orderId: string, chargeId: string): Promise<void>;
}
`,
  'test/worker.test.ts': `// TODO: the happy path only. No test covers a crash or a redelivered job.
`,
};

export function createFixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), 'vowe-eval-payments-'));
  for (const [path, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.name=Eval', '-c', 'user.email=eval@example.com', 'commit', '-q', '-m', 'Payment worker');
  return root;
}

export const people = {
  daniel: { userId: 'eval-daniel', name: 'Daniel' },
  priya: { userId: 'eval-priya', name: 'Priya' },
};

export const canvas = {
  version: 1,
  view: 'arch',
  views: [
    { id: 'arch', name: 'Architecture', question: 'What talks to what?' },
    { id: 'failure', name: 'Failure', question: 'What breaks, and how?' },
    { id: 'alternatives', name: 'Alternatives' },
  ],
  components: [
    { id: 'checkout', name: 'Checkout API', kind: 'service', tech: 'checkout-api' },
    { id: 'jobs', name: 'Jobs Queue', kind: 'queue', tech: 'jobs · 30s lease' },
    { id: 'payment-worker', name: 'Payment Worker', kind: 'service', short: 'the worker', tech: 'payment-worker' },
    { id: 'processor', name: 'Card Processor', kind: 'external', tech: 'PSP' },
    { id: 'orders', name: 'Orders DB', kind: 'store', tech: 'postgres' },
  ],
  relationships: [
    { from: 'checkout', to: 'jobs', label: 'enqueue charge' },
    { from: 'jobs', to: 'payment-worker', label: 'lease' },
    { from: 'payment-worker', to: 'processor', label: 'charge' },
    { from: 'payment-worker', to: 'orders', label: 'mark paid' },
  ],
  selection: { selected: ['payment-worker'], circled: [] },
};

const now = new Date().toISOString();
const member = (p, role) => ({ roomId: 'eval-room', userId: p.userId, role, joinedAt: now, email: `${p.name.toLowerCase()}@example.com`, name: p.name, avatarUrl: null });

export const room = {
  details: { id: 'eval-room', name: 'Payment Reliability', goal: 'Every order is charged exactly once', repository: 'github.com/example/payments', memberCount: 2 },
  members: [member(people.daniel, 'owner'), member(people.priya, 'member')],
  record: {
    roomId: 'eval-room',
    threads: [
      {
        id: 'thread-lease-0001',
        roomId: 'eval-room',
        kind: 'concern',
        anchor: { id: 'jobs', name: 'Jobs Queue', x: null, y: null },
        body: 'What happens to a job whose worker dies mid-way? The lease is only 30s.',
        author: { id: people.priya.userId, name: 'Priya', avatarUrl: null },
        createdAt: now,
        resolvedAt: null,
        replies: [],
      },
    ],
    decisions: [],
    activity: [],
    lastSeenAt: null,
  },
};
