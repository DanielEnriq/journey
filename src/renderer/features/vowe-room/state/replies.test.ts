import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Reply } from '../contracts/model.js';
import { countUnder, facesUnder, replyTree } from './replies.js';

const r = (id: string, by: string, parent?: string): Reply => ({ id, by, body: id, ago: '1m', ...(parent ? { parent } : {}) });
const shape = (ns: ReturnType<typeof replyTree>): unknown => ns.map((n) => (n.kids.length ? { [n.r.id]: shape(n.kids) } : n.r.id));

test('replies hang under the reply they answer, in order; the thread itself is not a node', () => {
  const tree = replyTree([r('root', 'me'), r('a', 'dot'), r('b', 'kp', 'a'), r('c', 'me', 'b'), r('d', 'ap', 'a'), r('e', 'kp')]);
  assert.deepEqual(shape(tree), [{ a: [{ b: ['c'] }, 'd'] }, 'e']);
  assert.equal(countUnder(tree[0]!), 3);
  assert.deepEqual(facesUnder(tree[0]!), ['kp', 'me', 'ap']);
});

test('a missing parent, or one that would loop, answers the thread', () => {
  assert.deepEqual(shape(replyTree([r('root', 'me'), r('a', 'me', 'gone'), r('b', 'me', 'c'), r('c', 'me', 'b')])), ['a', { c: ['b'] }]);
});
