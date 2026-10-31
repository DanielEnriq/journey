import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { About, Thread } from '../contracts/model.js';
import { preview, sections } from './threads.js';

const part = (id: string): About => ({ kind: 'part', id, name: id });
const t = (id: string, about: About, extra: Partial<Thread> = {}): Thread => ({ id, about, status: 'open', replies: [{ id: `${id}0`, by: 'kp', body: id, ago: '1m' }], ...extra });

test('a message reads as one plain line', () => {
  assert.equal(preview('@[dot|agent:vowe] is **[Main|main]** ok?\n\n```ts\nx()\n```\nSee `restore()`'), '@dot is Main ok? See restore()');
});

test('threads sort into needs you, here, then the rest, newest first', () => {
  const parts = (x: Thread) => (x.about.kind === 'part' ? [x.about.id] : []);
  const list = [t('a', part('main')), t('b', part('db'), { waiting: 'me' }), t('c', { kind: 'decision', id: 'd', name: 'D' }), t('d', part('main'))];
  const keys = (s: ReturnType<typeof sections>) => s.map((x) => [x.key, x.threads.map((y) => y.id).join('')]);
  assert.deepEqual(keys(sections(list, { me: 'me', parts })), [['needs', 'b'], ['here', 'da'], ['rest', 'c']]);
  assert.deepEqual(keys(sections(list, { me: 'me', parts, focus: 'db' })), [['needs', 'b'], ['rest', 'dca']]);
  assert.deepEqual(keys(sections(list, { me: 'me', parts, view: new Set(['main']) })), [['needs', 'b'], ['here', 'da'], ['rest', 'c']]);
});
