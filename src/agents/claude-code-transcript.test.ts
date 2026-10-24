// Transcript parsing and incremental reads, against fixture lines shaped like Claude Code's own.
// Plain Node (no Electron, no database, no model): `pnpm test`.

import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import type { ClaudeCodeEvent } from '../shared/api.js';
import { newCursor, parseTranscriptBytes, readTranscript } from './claude-code-transcript.js';

const SESSION = '11111111-2222-3333-4444-555555555555';
const CWD = '/work/repo';
let clock = Date.parse('2026-10-24T12:00:00Z');

function line(entry: Record<string, unknown>) {
  clock += 1000;
  return `${JSON.stringify({ sessionId: SESSION, cwd: CWD, gitBranch: 'main', isSidechain: false, timestamp: new Date(clock).toISOString(), ...entry })}\n`;
}
const prompt = (uuid: string, content: unknown, extra = {}) => line({ type: 'user', uuid, message: { role: 'user', content }, ...extra });
const toolUse = (uuid: string, id: string, name: string, input: unknown, extra = {}) =>
  line({ type: 'assistant', uuid, message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] }, ...extra });
const toolResult = (uuid: string, id: string, content: string, isError = false) =>
  line({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
const reply = (uuid: string, text: string, extra = {}) =>
  line({ type: 'assistant', uuid, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] }, ...extra });

/** A short session: a prompt, a successful edit, a failed command, and the final reply, plus records that aren't events. */
const SESSION_LINES = [
  line({ type: 'permission-mode', permissionMode: 'default' }),
  prompt('u1', 'Fix the failing test — ünïcødé ✓'),
  toolUse('a1', 'toolu_1', 'Edit', { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' }),
  toolResult('u2', 'toolu_1', 'The file has been updated.'),
  toolUse('a2', 'toolu_2', 'Bash', { command: 'pnpm test', description: 'Run tests' }),
  toolResult('u3', 'toolu_2', 'exit code 1', true),
  prompt('u4', '<command-name>/clear</command-name>'),
  prompt('u5', 'Caveat: meta', { isMeta: true }),
  reply('a3', 'Subagent done', { isSidechain: true }),
  reply('a4', 'Fixed it.'),
];

const shape = (events: ClaudeCodeEvent[]) => events.map((e) => [e.id, e.type, e.toolName, e.filePath]);
const EXPECTED = [
  ['transcript:u1', 'UserPromptSubmit', null, null],
  ['transcript:u2:toolu_1', 'PostToolUse', 'Edit', '/work/repo/src/a.ts'],
  ['transcript:u3:toolu_2', 'PostToolUseFailure', 'Bash', null],
  ['transcript:a4', 'Stop', null, null],
];

describe('parseTranscriptBytes', () => {
  test('extracts prompts, tool results with their tool, failures, and completed turns', () => {
    const { events, consumed } = parseTranscriptBytes(Buffer.from(SESSION_LINES.join('')), 'fallback', new Map());
    assert.deepEqual(shape(events), EXPECTED);
    assert.equal(consumed, Buffer.byteLength(SESSION_LINES.join('')));
    assert.ok(events.every((e) => e.source === 'transcript' && e.sessionId === SESSION && e.cwd === CWD && !e.subagent));
    assert.match(events[0].summary!, /ünïcødé ✓/);
    assert.match(events[2].summary!, /exit code 1/);
    assert.equal(events[3].summary, 'Fixed it.');
  });

  test('gives the same events whatever byte boundaries the writes fall on, including inside a character', () => {
    const bytes = Buffer.from(SESSION_LINES.join(''));
    const multibyte = bytes.indexOf(Buffer.from('ü')) + 1; // between the two bytes of ü
    for (const splits of [[multibyte], [1, 2, 3], [bytes.length - 1], Array.from({ length: 40 }, (_, i) => Math.floor((bytes.length * (i + 1)) / 41))]) {
      const tools = new Map();
      const events: ClaudeCodeEvent[] = [];
      let buffered = Buffer.alloc(0);
      const bounds = [0, ...splits, bytes.length];
      for (let i = 1; i < bounds.length; i++) {
        buffered = Buffer.concat([buffered, bytes.subarray(bounds[i - 1], bounds[i])]);
        const parsed = parseTranscriptBytes(buffered, SESSION, tools);
        events.push(...parsed.events);
        buffered = buffered.subarray(parsed.consumed);
      }
      assert.deepEqual(shape(events), EXPECTED, `splits ${splits.slice(0, 3)}`);
      assert.equal(buffered.length, 0);
    }
  });

  test('leaves a trailing partial line unconsumed', () => {
    const text = prompt('p1', 'complete') + prompt('p2', 'still being written').slice(0, 30);
    const { events, consumed } = parseTranscriptBytes(Buffer.from(text), SESSION, new Map());
    assert.deepEqual(events.map((e) => e.id), ['transcript:p1']);
    assert.equal(consumed, text.indexOf('\n') + 1);
  });

  test('skips malformed and unrelated lines', () => {
    const text = '{not json\n' + '[1,2]\n' + '\n' + line({ type: 'user', message: { content: 'no uuid' } }) + prompt('ok', 'kept');
    const { events } = parseTranscriptBytes(Buffer.from(text), SESSION, new Map());
    assert.deepEqual(events.map((e) => e.id), ['transcript:ok']);
  });

  test('marks subagent tool results, and uses the file name when a line has no session id', () => {
    const text =
      toolUse('s1', 'toolu_s', 'Read', { file_path: '/abs/b.ts' }, { isSidechain: true, sessionId: undefined }) +
      line({ type: 'user', uuid: 's2', isSidechain: true, sessionId: undefined, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_s', content: 'ok' }] } });
    const { events } = parseTranscriptBytes(Buffer.from(text), 'from-file-name', new Map());
    assert.deepEqual(shape(events), [['transcript:s2:toolu_s', 'PostToolUse', 'Read', '/abs/b.ts']]);
    assert.equal(events[0].subagent, true);
    assert.equal(events[0].sessionId, 'from-file-name');
  });
});

describe('readTranscript', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vowe-transcript-test-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('reads only what was appended, waits out a partial line, and resumes from a saved position', async () => {
    const path = join(dir, `${SESSION}.jsonl`);
    const [first, ...rest] = SESSION_LINES.slice(1);
    writeFileSync(path, first);
    let r = await readTranscript(path, SESSION, newCursor());
    assert.deepEqual(r.events.map((e) => e.id), ['transcript:u1']);

    const next = rest.join('');
    appendFileSync(path, next.slice(0, 50)); // Claude Code mid-write
    r = await readTranscript(path, SESSION, r.cursor);
    assert.deepEqual(r.events, []);
    assert.equal(r.cursor.offset, Buffer.byteLength(first));

    appendFileSync(path, next.slice(50));
    // As after a restart: offset and inode survive, pending tool names don't.
    const saved = { offset: r.cursor.offset, inode: r.cursor.inode, tools: new Map() };
    r = await readTranscript(path, SESSION, saved);
    assert.deepEqual(shape(r.events), EXPECTED.slice(1));

    r = await readTranscript(path, SESSION, r.cursor);
    assert.deepEqual(r.events, [], 'nothing new, nothing read');
  });

  test('starts over when the file is truncated or replaced; ids repeat so storage can drop them', async () => {
    const path = join(dir, 'replaced.jsonl');
    writeFileSync(path, prompt('r1', 'one') + prompt('r2', 'two'));
    const firstRead = await readTranscript(path, SESSION, newCursor());

    writeFileSync(path, prompt('r1', 'one')); // shorter: rewritten in place
    let r = await readTranscript(path, SESSION, firstRead.cursor);
    assert.deepEqual(r.events.map((e) => e.id), ['transcript:r1']);

    const replacement = join(dir, 'replacement.jsonl');
    writeFileSync(replacement, prompt('r1', 'one') + prompt('r2', 'two') + prompt('r3', 'three'));
    renameSync(replacement, path); // same name, new inode
    r = await readTranscript(path, SESSION, firstRead.cursor);
    assert.deepEqual(r.events.map((e) => e.id), ['transcript:r1', 'transcript:r2', 'transcript:r3']);
  });

  test('reads a line longer than one read chunk', async () => {
    const path = join(dir, 'long.jsonl');
    writeFileSync(path, prompt('big', 'x'.repeat(5 * 1024 * 1024)) + prompt('after', 'small'));
    const r = await readTranscript(path, SESSION, newCursor());
    assert.deepEqual(r.events.map((e) => e.id), ['transcript:big', 'transcript:after']);
  });
});
