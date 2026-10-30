import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { doingOf } from './agent-doing.js';

const name = (id: string) => ({ api: 'API', db: 'Database' })[id] ?? id;

test('a tool call reads as what the agent is on', () => {
  assert.deepEqual(doingOf('read_code', { path: 'src/renderer/Mention.tsx', from: 1 }, name), { verb: 'Reading', what: 'Mention.tsx', tip: 'src/renderer/Mention.tsx' });
  assert.deepEqual(doingOf('search_code', { terms: ['retry', 'queue'], path: 'src' }, name), { verb: 'Searching for', what: 'retry, queue', tip: 'in src' });
  assert.deepEqual(doingOf('highlight_component', { componentIds: ['api', 'db'], tone: 'risk' }, name), { verb: 'Pointing at', what: 'API, Database', parts: ['api', 'db'] });
  assert.deepEqual(doingOf('describe_canvas', {}, name), { verb: 'Looking at the canvas' });
});

test('a malformed or unknown call still says something', () => {
  assert.deepEqual(doingOf('read_code', { path: 4 }, name), { verb: 'Reading code' });
  assert.deepEqual(doingOf('highlight_component', null, name), { verb: 'Pointing at' });
  assert.deepEqual(doingOf('something_new', 'x', name), { verb: 'Working' });
});
