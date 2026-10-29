import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encodeMentions, mentionsIn, plainMentions, queryAt, rank, tokenOf, type MentionItem } from './mentions.js';

const dana: MentionItem = { kind: 'person', id: 'u2', label: 'Dana Lee' };
const dan: MentionItem = { kind: 'person', id: 'u3', label: 'Dana' };
const auth: MentionItem = { kind: 'part', id: 'auth-service', label: 'Auth service', also: 'Go' };

describe('mentions', () => {
  it('finds the query after an @ that starts a word, up to the caret', () => {
    assert.deepEqual(queryAt('ask @da', 7), { start: 4, q: 'da' });
    assert.deepEqual(queryAt('@', 1), { start: 0, q: '' });
    assert.deepEqual(queryAt('(@au', 4), { start: 1, q: 'au' });
    assert.equal(queryAt('mail ops@vowe', 13), null);
    assert.equal(queryAt('@dana lee', 9), null);
  });

  it('turns only what was picked into tokens, longest label first', () => {
    const text = 'ask @Dana Lee and @Dana, not @Sam';
    assert.equal(encodeMentions(text, [dan, dana]), `ask ${tokenOf(dana)} and ${tokenOf(dan)}, not @Sam`);
    assert.equal(encodeMentions('ask @Dana Lee', []), 'ask @Dana Lee');
  });

  it('reads tokens back as words and as references', () => {
    const body = `can ${tokenOf(dana)} look at ${tokenOf(auth)}?`;
    assert.equal(plainMentions(body), 'can @Dana Lee look at @Auth service?');
    assert.deepEqual(mentionsIn(body).map((m) => `${m.kind}:${m.id}`), ['person:u2', 'part:auth-service']);
  });

  it('ranks a label start over a word start over a match in the grey words', () => {
    const items: MentionItem[] = [{ kind: 'part', id: 'a', label: 'Gateway', also: 'auth proxy' }, auth, { kind: 'part', id: 'c', label: 'OAuth callback' }];
    assert.deepEqual(rank(items, 'au').map((m) => m.id), ['auth-service', 'c', 'a']);
    assert.deepEqual(rank(items, 'zz'), []);
    assert.equal(rank(items, '', 2).length, 2);
  });
});
