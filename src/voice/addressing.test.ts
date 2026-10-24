import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseAddress } from './addressing.js';

describe('parseAddress', () => {
  it('takes the name off the front', () => {
    assert.deepEqual(parseAddress('Vowe, what happens if this crashes after charging?'), {
      addressed: true,
      question: 'What happens if this crashes after charging?',
    });
    assert.deepEqual(parseAddress('hey vow show me the failure flow'), { addressed: true, question: 'Show me the failure flow' });
    assert.deepEqual(parseAddress('Okay, Vowe. Why is the queue there?'), { addressed: true, question: 'Why is the queue there?' });
  });

  it('takes the name off the end', () => {
    assert.deepEqual(parseAddress('What happens if this crashes, Vowe?'), { addressed: true, question: 'What happens if this crashes' });
  });

  it('notices the name said alone, with the question still to come', () => {
    assert.deepEqual(parseAddress('Vowe?'), { addressed: true, question: '' });
    assert.deepEqual(parseAddress('Hey Vowe.'), { addressed: true, question: '' });
  });

  it('ignores people talking to each other, or about Vowe', () => {
    for (const text of [
      'I think the worker retries after charging.',
      'We vowed to fix this last sprint.',
      'Should we ask Vowe about the queue?',
      'Those vowels are hard to say.',
      '',
    ]) {
      assert.equal(parseAddress(text).addressed, false, text);
    }
  });
});
