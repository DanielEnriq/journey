import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { fenceInfo, highlight, isPlain, parseBlocks, parseInline } from './markdown.js';

test('blocks: paragraphs, lists and fenced code with a file', () => {
  const md = 'Mostly fine.\nSecond line.\n\n- one\n- **two**\n  continued\n\n1. a\n2. b\n\n```ts src/main/index.ts:40-48\nawait restore();\ncreateWindow();\n```\nAfter.';
  assert.deepEqual(parseBlocks(md), [
    { kind: 'p', text: 'Mostly fine.\nSecond line.' },
    { kind: 'list', ordered: false, start: 1, items: ['one', '**two**\ncontinued'] },
    { kind: 'list', ordered: true, start: 1, items: ['a', 'b'] },
    { kind: 'code', code: 'await restore();\ncreateWindow();', lang: 'ts', path: 'src/main/index.ts', from: 40 },
    { kind: 'p', text: 'After.' },
  ]);
});

test('an unclosed fence runs to the end; a heading reads as a bold line', () => {
  assert.deepEqual(parseBlocks('## Risks\n```\nx'), [{ kind: 'p', text: '**Risks**' }, { kind: 'code', code: 'x', lang: null, path: null, from: null }]);
});

test('fence info: language, file and first line in any order', () => {
  assert.deepEqual(fenceInfo('src/a.tsx:12'), { lang: 'tsx', path: 'src/a.tsx', from: 12 });
  assert.deepEqual(fenceInfo('python'), { lang: 'python', path: null, from: null });
  assert.deepEqual(fenceInfo(''), { lang: null, path: null, from: null });
});

test('inline: code wins over emphasis, and stray stars and underscores stay words', () => {
  assert.deepEqual(parseInline('Use `a*b*c` and **bold _both_** here'), [
    { kind: 'text', text: 'Use ' }, { kind: 'code', text: 'a*b*c' }, { kind: 'text', text: ' and ' },
    { kind: 'b', children: [{ kind: 'text', text: 'bold ' }, { kind: 'i', children: [{ kind: 'text', text: 'both' }] }] },
    { kind: 'text', text: ' here' },
  ]);
  assert.deepEqual(parseInline('2 * 3 * 4 and snake_case_name'), [{ kind: 'text', text: '2 * 3 * 4 and snake_case_name' }]);
  assert.deepEqual(parseInline('runs _before_ it'), [{ kind: 'text', text: 'runs ' }, { kind: 'i', children: [{ kind: 'text', text: 'before' }] }, { kind: 'text', text: ' it' }]);
});

test('mention tokens pass through inline parsing untouched', () => {
  assert.deepEqual(parseInline('@[Dana Lee|person:u1] said so'), [{ kind: 'text', text: '@[Dana Lee|person:u1] said so' }]);
});

test('plain: a one-liner with no markup', () => {
  assert.equal(isPlain('hello there'), true);
  assert.equal(isPlain('see `x`'), false);
  assert.equal(isPlain('- a'), false);
});

test('highlight: keywords, calls, strings and comments; unknown languages stay plain', () => {
  const kinds = highlight('await restore("x"); // later', 'ts').filter((t) => t.kind !== 'p').map((t) => `${t.kind}:${t.text}`);
  assert.deepEqual(kinds, ['k:await', 'f:restore', 's:"x"', 'c:// later']);
  assert.deepEqual(highlight('a b', 'haskell'), [{ kind: 'p', text: 'a b' }]);
});
