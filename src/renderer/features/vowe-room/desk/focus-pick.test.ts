import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Decision, Thread, VoweRecord, Work } from '../contracts/model.js';
import { focusTarget, pickDecision, pickThread, pickWork, threadTitle } from './focus-pick.js';

const ME = 'me';
const thread = (id: string, o: Partial<Thread> = {}): Thread =>
  ({ id, about: { kind: 'part', id: 'api', name: 'API' }, replies: [{ id: 'r', by: 'ann', body: `Body of ${id}`, ago: '2m' }], status: 'open', ...o }) as Thread;
const decision = (id: string, o: Partial<Decision> = {}): Decision =>
  ({ id, title: id, state: 'agreed', version: 1, lines: [], approvers: [], parts: [], by: { who: 'ann' }, ago: '1h', ...o }) as unknown as Decision;
const work = (id: string, o: Partial<Work> = {}): Work =>
  ({ id, title: id, owner: 'ann', doer: null, state: 'draft', plan: [], parts: [], runs: [], prs: [], version: 1, ...o }) as unknown as Work;
const rec = (o: Partial<VoweRecord>): VoweRecord => ({ threads: [], decisions: [], work: [], ...o }) as unknown as VoweRecord;

describe('Focus pickers', () => {
  it('threads: what you had open (even resolved), else what waits on you, else the newest open one', () => {
    const r = rec({ threads: [thread('a'), thread('b', { waiting: ME }), thread('c'), thread('d', { status: 'resolved' })] });
    assert.equal(pickThread(r, ME, 'c')?.id, 'c');
    assert.equal(pickThread(r, ME, null)?.id, 'b');
    assert.equal(pickThread(r, ME, 'd')?.id, 'd');
    assert.equal(pickThread(r, ME, 'gone')?.id, 'b');
    assert.equal(pickThread(rec({ threads: [thread('a'), thread('c')] }), ME, null)?.id, 'c');
    assert.equal(pickThread(rec({}), ME, null), null);
  });
  it('decisions: what you had open, else the one waiting for your signature, else the newest live one', () => {
    const owe = decision('owe', { state: 'review', version: 2, approvers: [{ who: ME, signed: 1 }] as Decision['approvers'] });
    const signed = decision('signed', { state: 'review', version: 2, approvers: [{ who: ME, signed: 2 }] as Decision['approvers'] });
    const asked = decision('asked', { state: 'review', version: 1, approvers: [{ who: ME, signed: null, changes: 'no' }] as unknown as Decision['approvers'] });
    const r = rec({ decisions: [decision('old', { state: 'superseded' }), owe, decision('x'), signed, asked, decision('gone', { state: 'dismissed' })] });
    assert.equal(pickDecision(r, ME, 'x')?.id, 'x');
    assert.equal(pickDecision(r, ME, 'old')?.id, 'old');
    assert.equal(pickDecision(r, ME, null)?.id, 'owe');
    assert.equal(pickDecision(rec({ decisions: [decision('a'), signed, decision('dz', { state: 'dismissed' })] }), ME, null)?.id, 'signed');
    assert.equal(pickDecision(rec({ decisions: [decision('s', { state: 'superseded' })] }), ME, null), null);
  });
  it('work: what you had open, else the one with a question for you, else the first', () => {
    const q = (o: object) => ({ id: 'q', text: '?', about: 'x', for: ME, options: [], ...o });
    const r = rec({ work: [work('a'), work('b', { question: q({ answer: { by: ME, text: 'y' } }) }), work('c', { question: q({}) }), work('d', { question: q({ deferred: true }) })] });
    assert.equal(pickWork(r, ME, 'b')?.id, 'b');
    assert.equal(pickWork(r, ME, null)?.id, 'c');
    assert.equal(pickWork(rec({ work: [work('a'), work('d', { question: q({ deferred: true }) })] }), ME, null)?.id, 'a');
    assert.equal(pickWork(rec({}), ME, null), null);
  });
  it('the page acts on what you opened in this section, else on the picked item', () => {
    const r = rec({ decisions: [decision('a'), decision('b')], work: [work('w', { question: { id: 'q', text: '?', about: 'x', for: ME, options: [] } })] });
    assert.deepEqual(focusTarget(r, ME, { fsec: 'decide', openThread: null, inspect: { kind: 'decision', id: 'a', line: 'l1' } }).inspect, { kind: 'decision', id: 'a', line: 'l1' });
    assert.deepEqual(focusTarget(r, ME, { fsec: 'decide', openThread: null, inspect: null }).inspect, { kind: 'decision', id: 'b' });
    assert.deepEqual(focusTarget(r, ME, { fsec: 'work', openThread: null, inspect: { kind: 'decision', id: 'a' } }).inspect, { kind: 'work', id: 'w', section: 'run' });
    const d = focusTarget(r, ME, { fsec: 'discuss', openThread: null, inspect: { kind: 'decision', id: 'a' } });
    assert.equal(d.inspect, null);
    assert.equal(d.thread, null);
  });
  it('titles a thread by its title, or its first message without canvas refs', () => {
    assert.equal(threadTitle(thread('a', { title: 'Retry budget' })), 'Retry budget');
    assert.equal(threadTitle(thread('a', { title: 'Question', replies: [{ id: 'r', by: 'x', body: 'Why does [the queue|q1] stall?', ago: '1m' }] })), 'Why does the queue stall?');
  });
});
