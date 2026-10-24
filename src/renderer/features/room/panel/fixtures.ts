import type { RoomPanelProps } from './types.js';

/** The Payment Reliability room from the design canvas, as panel props. */
export const paymentRoom: Omit<RoomPanelProps, `on${string}`> = {
  meId: 'daniel',
  subtitle: '3 here',
  people: {
    daniel: { id: 'daniel', name: 'Daniel', initials: 'DE', kind: 'human', tone: 'me' },
    john: { id: 'john', name: 'John', initials: 'JM', kind: 'human', tone: 'peer' },
    srikar: { id: 'srikar', name: 'Srikar', initials: 'SR', kind: 'human', tone: 'peer2' },
    vowe: { id: 'vowe', name: 'Vowe', initials: 'V', kind: 'agent' },
  },
  goal: { text: 'Retries can never produce a duplicate charge.', by: 'john' },
  decision: {
    id: 'dec-idem',
    version: 2,
    title: 'Use idempotent processing for concurrent worker execution.',
    verify: 'Concurrent pickup; worker crash after charge',
    proposedBy: 'john',
    proposedAgo: '18m',
    approvers: [
      { personId: 'john', signedVersion: 2 },
      { personId: 'daniel', signedVersion: null },
    ],
    status: 'proposed',
    earlierVersions: 1,
  },
  threads: [
    {
      id: 'n2', kind: 'concern', anchor: { id: 'worker', name: 'Payment Worker' },
      root: { id: 'n2-r', authorId: 'daniel', body: 'If the worker crashes after the charge, the job is redelivered and charged again.', ago: '14m' },
      replies: [
        { id: 'n2-1', authorId: 'john', body: 'Confirmed in the logs: #4182 was charged at 14:02 and again at 14:03.', ago: '11m' },
        { id: 'n2-2', authorId: 'vowe', body: 'Pinned that run to the failure view, steps 3 to 5.', ago: '10m' },
      ],
    },
    {
      id: 'n3', kind: 'avoid', anchor: { id: 'worker', name: 'Payment Worker' },
      root: { id: 'n3-r', authorId: 'daniel', body: 'A distributed lock, unless new evidence says we need one.', ago: '9m' },
      replies: [],
    },
    {
      id: 'n4', kind: 'constraint', anchor: { id: 'queue', name: 'Retry Queue' },
      root: { id: 'n4-r', authorId: 'john', body: 'Retries stay reliable.', ago: '8m' },
      replies: [{ id: 'n4-1', authorId: 'daniel', body: 'Agreed. Keys shouldn’t change retry timing at all.', ago: '6m' }],
    },
    {
      id: 'n5', kind: 'question', anchor: { id: 'queue', name: 'Retry Queue' },
      root: { id: 'n5-r', authorId: 'vowe', body: 'How do we notice an acknowledgment that never arrived?', ago: '2m' },
      replies: [],
    },
  ],
  setAside: [{ label: 'Distributed lock', reason: 'unless idempotency keys can’t cover a provider timeout.' }],
  streams: [
    { id: 's1', title: 'Retry worker', agent: 'Claude Code', meta: 'payments/retry-worker · tests 14 of 22', state: 'running' },
  ],
};
