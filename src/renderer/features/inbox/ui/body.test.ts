import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { InboxItem } from '../model.js';
import { bodyKind, canMarkDone, canOpen } from './body.js';

const item = (kind: InboxItem['subject']['kind'], obligation?: InboxItem['obligation'], tier: InboxItem['tier'] = 'needs') =>
  ({ subject: { kind, id: 'x', title: 'x' }, obligation, tier }) as Pick<InboxItem, 'subject' | 'obligation' | 'tier'>;

describe('Inbox reading pages', () => {
  it('picks the page from the subject and what you owe', () => {
    assert.equal(bodyKind(item('decision', 'sign')), 'sign');
    assert.equal(bodyKind(item('decision', undefined, 'following')), 'generic');
    assert.equal(bodyKind(item('question', 'answer')), 'question');
    assert.equal(bodyKind(item('thread', 'reply')), 'thread');
    assert.equal(bodyKind(item('thread', undefined, 'following')), 'thread');
    assert.equal(bodyKind(item('invitation', 'accept')), 'invitation');
    assert.equal(bodyKind(item('plan', 'authorize')), 'authorize');
    assert.equal(bodyKind(item('plan', 'allow')), 'allow');
    assert.equal(bodyKind(item('plan', 'review')), 'generic');
    assert.equal(bodyKind(item('run')), 'generic');
  });
  it('lets you mark done only what doesn’t need you, and open anything but an invitation', () => {
    assert.equal(canMarkDone(item('thread', 'reply')), false);
    assert.equal(canMarkDone(item('thread', undefined, 'following')), true);
    assert.equal(canOpen(item('invitation', 'accept')), false);
    assert.equal(canOpen(item('decision', 'sign')), true);
  });
});
