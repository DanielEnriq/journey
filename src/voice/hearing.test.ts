import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { HeardSpeech } from './contract.js';
import { Hearing } from './hearing.js';
import { ScriptedRecognizer, frame, tick, until } from './testing.js';

const DANIEL = { userId: 'u-daniel', name: 'Daniel' };

async function hearing(timing = {}) {
  const recognizer = new ScriptedRecognizer();
  const heard: HeardSpeech[] = [];
  const errors: string[] = [];
  const h = new Hearing({ self: DANIEL, recognizer, timing: { settleMs: 20, ...timing }, onSpeech: (s) => heard.push(s), onError: (e) => errors.push(e) });
  await h.start();
  return { h, recognizer, heard, errors };
}

describe('Hearing', () => {
  it('passes on what you say, as you, and marks what was said to Vowe', async () => {
    const { h, recognizer, heard } = await hearing();
    recognizer.event({ type: 'partial', text: 'So the' });
    recognizer.event({ type: 'final', text: 'So the worker leases the job.' });
    recognizer.event({ type: 'final', text: 'Voe, what happens if this crashes after charging?' });
    await until(() => heard.length === 3);
    assert.deepEqual(
      heard.map(({ participant, text, final, addressed }) => ({ participant, text, final, addressed })),
      [
        { participant: DANIEL, text: 'So the', final: false, addressed: undefined },
        { participant: DANIEL, text: 'So the worker leases the job.', final: true, addressed: false },
        // However the recognizer spelled the name, the runtime's wake word sees "Vowe".
        { participant: DANIEL, text: 'Vowe, What happens if this crashes after charging?', final: true, addressed: true },
      ],
    );
    h.stop();
  });

  it('takes "Vowe?" then the question as one address, and waits for the rest of a question', async () => {
    const { h, recognizer, heard } = await hearing();
    recognizer.event({ type: 'final', text: 'Vowe?' });
    recognizer.event({ type: 'final', text: 'What does the ledger do' });
    recognizer.event({ type: 'partial', text: 'when' });
    await tick(40);
    assert.equal(heard.filter((s) => s.final).length, 0, 'still talking: nothing passed on yet');
    recognizer.event({ type: 'final', text: 'when a charge fails?' });
    await until(() => heard.some((s) => s.final));
    assert.equal(heard.find((s) => s.final)?.text, 'Vowe, What does the ledger do when a charge fails?');
    h.stop();
  });

  it('while Vowe speaks: ignores what may be its own echo, and reports sustained voice as an interruption', async () => {
    const { h, recognizer, heard } = await hearing();
    h.setVoweSpeaking(true);
    recognizer.event({ type: 'partial', text: 'the retry charges' }); // Vowe's words leaking into the microphone
    recognizer.event({ type: 'final', text: 'The retry charges twice.' });
    for (let i = 0; i < 4; i++) h.audio(frame(true)); // a cough: 80 ms
    for (let i = 0; i < 10; i++) h.audio(frame(false));
    assert.equal(heard.length, 0);

    for (let i = 0; i < 12; i++) h.audio(frame(true)); // "wait, wait"
    assert.deepEqual(heard.map((s) => [s.text, s.final]), [['…', false]]);
    recognizer.event({ type: 'final', text: 'Wait, hold on.' }); // theirs now, after talking over Vowe
    assert.deepEqual(heard.at(-1)?.text, 'Wait, hold on.');
    h.stop();
  });

  it('reopens recognition that fails, and stops trying once stopped', async () => {
    const { h, recognizer, errors } = await hearing({ recognitionRetryMs: [5, 5] });
    recognizer.failNext = 1;
    recognizer.event({ type: 'error', message: 'socket closed', retryable: true });
    await until(() => recognizer.opened === 3, 1000, 'two reopen attempts');
    assert.equal(errors.length, 2);
    assert.equal(recognizer.stream?.closed, false);
    h.stop();
    assert.equal(recognizer.stream?.closed, true);
  });
});
