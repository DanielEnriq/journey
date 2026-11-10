import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { VIEW_SCHEMA } from '../../shared/system/model.js';
import { createSystemService, type SystemEngine } from '../service.js';
import { createSystemServer, listen } from './index.js';
import type { Server } from 'node:http';

// The dev server on an ephemeral port: the page, the JSON routes, and what it refuses.

let server: Server;
let base: string;
const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

const engine = { fixtures: () => [{ id: 'fixture:x', label: 'Fixture X' }], fixture: () => null } as unknown as SystemEngine;

before(async () => {
  const repo = tmp('vowe-repo-');
  writeFileSync(join(repo, 'a.ts'), 'one\ntwo\nthree\n');
  const site = tmp('vowe-dist-');
  mkdirSync(join(site, 'renderer', 'vendor'), { recursive: true });
  mkdirSync(join(site, 'shared'));
  mkdirSync(join(site, 'main'));
  writeFileSync(join(site, 'renderer', 'system.html'), '<!doctype html><title>System</title>');
  writeFileSync(join(site, 'renderer', 'vendor', 'preact.js'), 'export {}');
  writeFileSync(join(site, 'shared', 'model.js'), 'export {}');
  writeFileSync(join(site, 'main', 'index.js'), 'secret');
  writeFileSync(join(tmp('vowe-out-'), 'secret.txt'), 'no');
  const service = createSystemService({ home: tmp('vowe-home-'), repos: [repo], engine, recordTraces: false });
  server = createSystemServer({ service, distDir: site });
  base = `http://127.0.0.1:${await listen(server, 0)}`;
});
after(() => { server.close(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function call(path: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; type: string; text: string }>((ok, fail) => {
    const req = request(`${base}${path}`, { method: init.method ?? 'GET', headers: init.headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => ok({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), text }));
    });
    req.on('error', fail);
    req.end(init.body);
  });
}
const api = async (method: string, args: unknown[]) => {
  const r = await call(`/api/${method}`, { method: 'POST', body: JSON.stringify(args), headers: { 'content-type': 'application/json' } });
  return { status: r.status, body: JSON.parse(r.text) as { result?: any; error?: string } };
};

describe('system dev server', () => {
  test('serves the renderer and shared modules, nothing else', async () => {
    const root = await call('/');
    assert.equal(root.status, 302);
    const page = await call('/renderer/system.html');
    assert.equal(page.status, 200);
    assert.match(page.type, /text\/html/);
    assert.match(page.text, /System/);
    assert.match((await call('/renderer/vendor/preact.js')).type, /javascript/);
    assert.match((await call('/shared/model.js')).type, /javascript/);
    assert.equal((await call('/main/index.js')).status, 404, 'main/ is not served');
    assert.equal((await call('/nope.js')).status, 404);
    assert.notEqual((await call('/../secret.txt')).status, 200);
    assert.equal((await call('/%2e%2e/secret.txt')).status, 404, 'normalised to /secret.txt, which the site lacks');
    assert.equal((await call('/renderer/%2e%2e%2f%2e%2e%2fsecret.txt')).status, 403);
  });

  test('answers SystemApi methods as JSON', async () => {
    const repos = await api('repos', []);
    assert.equal(repos.status, 200);
    assert.equal(repos.body.result.length, 1);
    const id = repos.body.result[0].id;
    const ex = await api('source', [id, 'a.ts', 2, 2, 1]);
    assert.deepEqual(ex.body.result.lines, ['one', 'two', 'three']);
    assert.deepEqual((await api('fixtures', [])).body.result, [{ id: 'fixture:x', label: 'Fixture X' }]);

    const view = { request: { schema: VIEW_SCHEMA, id: 'v1', title: 'T', question: 'Q', lens: 'organization', focus: [], source: { kind: 'manual', id: 'me', name: 'Me' } }, state: null, savedAt: '2026-11-10T00:00:00Z' };
    assert.equal((await api('saveView', [id, view])).status, 200);
    assert.equal((await api('views', [id])).body.result[0].request.id, 'v1');
  });

  test('says what went wrong, with a fitting status', async () => {
    const id = (await api('repos', [])).body.result[0].id;
    const outside = await api('source', [id, '../secret.txt', 1, 1]);
    assert.equal(outside.status, 403);
    assert.match(outside.body.error!, /outside the repository/);
    assert.equal((await api('source', [id, 'nope.ts', 1, 1])).status, 404);
    assert.equal((await api('open', ['no-such-repo'])).status, 404);
    assert.equal((await api('fixture', ['nope'])).status, 404);
    assert.equal((await api('addRepo', ['/'])).status, 404, 'dev-only methods are off unless enabled');
    assert.equal((await api('constructor', [])).status, 404);
    assert.equal((await call('/api/repos')).status, 405);
    assert.equal((await call('/api/repos', { method: 'POST', body: '[]', headers: { 'content-type': 'text/plain' } })).status, 415, 'no form posts');
    assert.equal((await call('/api/repos', { method: 'POST', body: '{', headers: { 'content-type': 'application/json' } })).status, 400);
    assert.equal((await call('/api/repos', { method: 'POST', body: '[]', headers: { 'content-type': 'application/json', origin: 'https://evil.example' } })).status, 403);
    assert.equal((await call('/', { headers: { host: 'evil.example' } })).status, 421, 'DNS rebinding refused');
  });
});
