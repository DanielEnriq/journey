import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CAPTION_CHARS, Captions, captionText } from './captions.js';

const me = { userId: 'u1', name: 'Daniel' };
const speech = (text: string, final: boolean) => ({ participant: me, text, final });

describe('Captions', () => {
  it('replaces a partial with the next, and keeps a final as the current line', () => {
    const c = new Captions();
    c.heard(speech('the payment', false));
    c.heard(speech('the payment worker', false));
    assert.deepEqual(c.store.state.cur, { who: 'you', text: 'the payment worker', live: true });
    c.heard(speech('The payment worker retries.', true));
    assert.deepEqual(c.store.state, { prev: null, cur: { who: 'you', text: 'The payment worker retries.', live: false } });
  });

  it('moves a finished line up when the next one starts', () => {
    const c = new Captions();
    c.heard(speech('First thing.', true));
    c.heard(speech('second', false));
    assert.equal(c.store.state.prev?.text, 'First thing.');
    assert.deepEqual(c.store.state.cur, { who: 'you', text: 'second', live: true });
  });

  it('skips the interruption marker and empty speech', () => {
    const c = new Captions();
    c.heard(speech('…', false));
    c.heard(speech('  ', true));
    assert.deepEqual(c.store.state, { prev: null, cur: null });
  });

  it('runs one turn of Vowe’s sentences together, and starts a new line for the next turn', () => {
    const c = new Captions();
    c.heard(speech('Vowe, what retries?', true));
    c.said('t1', 'The worker does.');
    c.said('t1', 'Up to three times.');
    assert.equal(c.store.state.prev?.who, 'you');
    assert.deepEqual(c.store.state.cur, { who: 'vowe', text: 'The worker does. Up to three times.', live: false, turnId: 't1' });
    c.said('t2', 'Another answer.');
    assert.equal(c.store.state.prev?.text, 'The worker does. Up to three times.');
    assert.equal(c.store.state.cur?.text, 'Another answer.');
  });

  it('settles your partial when Vowe starts talking over it', () => {
    const c = new Captions();
    c.heard(speech('wait', false));
    c.said('t1', 'Sure.');
    assert.deepEqual(c.store.state.prev, { who: 'you', text: 'wait', live: false });
  });
});

describe('captionText', () => {
  it('keeps short lines whole and the end of long ones, from a word', () => {
    assert.equal(captionText('short'), 'short');
    const long = Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ');
    const shown = captionText(long);
    assert.ok(shown.startsWith('…w'));
    assert.ok(shown.endsWith('w59'));
    assert.ok(shown.length <= CAPTION_CHARS + 1);
    // Cut on a space, or exactly at a word's start: no leading space, no word dropped.
    const word = 'x'.repeat(9);
    assert.equal(captionText('a ' + `${word} `.repeat(18) + 'end'), '…' + `${word} `.repeat(17) + 'end');
    assert.equal(captionText('lead ' + 'y'.repeat(CAPTION_CHARS)), '…' + 'y'.repeat(CAPTION_CHARS));
  });
});
