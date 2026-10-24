import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SentenceSplitter, spoken } from './sentences.js';

describe('SentenceSplitter', () => {
  it('releases each sentence as soon as it is complete', () => {
    const s = new SentenceSplitter();
    assert.deepEqual(s.push('If the worker crashes after charging, '), []);
    assert.deepEqual(s.push('the charge is kept but the order is not marked paid. The '), [
      'If the worker crashes after charging, the charge is kept but the order is not marked paid.',
    ]);
    assert.deepEqual(s.push('retry charges again'), []);
    assert.deepEqual(s.flush(), ['The retry charges again']);
  });

  it('joins sentences too short to say on their own', () => {
    const s = new SentenceSplitter();
    assert.deepEqual(s.push('Yes. It retries without an idempotency key. '), ['Yes. It retries without an idempotency key.']);
  });

  it('breaks at line ends, and drops what is only formatting', () => {
    const s = new SentenceSplitter();
    assert.deepEqual(s.push('Two risks:\n- double charge\n'), ['Two risks:', 'double charge']);
    assert.deepEqual(s.flush(), []);
  });
});

describe('spoken', () => {
  it('reads Markdown the way a person would say it', () => {
    assert.equal(spoken('The **ledger** guards it in `ledger.ts` (`session 1a2b3c4d #42`).'), 'The ledger guards it in ledger.ts.');
    assert.equal(spoken('See [the worker](src/worker.ts).'), 'See the worker.');
    assert.equal(spoken('It charges before it acknowledges (`src/payments/worker.ts:12-14`).'), 'It charges before it acknowledges.');
  });
});
