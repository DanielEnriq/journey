import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { listenForAuthRedirect, RedirectAbandoned } from './loopback.js';

// The loopback that receives Supabase-brokered redirects (GitHub sign-in, linking). browse() in
// supabase/github-mock.ts plays the browser end to end; these pin the listener's own rules.

describe('auth redirect listener', () => {
  it('answers only its own state path, and resolves with the code', async () => {
    const listener = await listenForAuthRedirect('s1', { provider: 'GitHub' });
    assert.match(listener.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback\/s1$/);
    const other = await fetch(listener.redirectUri.replace(/s1$/, 'someone-else') + '?code=stolen');
    assert.equal(other.status, 404);
    const res = await fetch(`${listener.redirectUri}?code=abc`);
    assert.equal(res.status, 200);
    assert.equal((await listener.params).get('code'), 'abc');
  });

  it('hands a fragment back as a query, since browsers keep fragments to themselves', async () => {
    const listener = await listenForAuthRedirect('s2', { provider: 'GitHub' });
    const page = await fetch(listener.redirectUri);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /data-vowe-handoff[\s\S]*location\.hash/);
    const res = await fetch(`${listener.redirectUri}?error=server_error&error_code=identity_already_exists`);
    assert.equal(res.status, 400);
    assert.equal((await listener.params).get('error_code'), 'identity_already_exists');
  });

  it('stops on cancel, and the port stops answering', async () => {
    const controller = new AbortController();
    const listener = await listenForAuthRedirect('s3', { provider: 'GitHub', signal: controller.signal });
    controller.abort();
    await assert.rejects(listener.params, (err: unknown) => err instanceof RedirectAbandoned && err.reason === 'cancelled');
    await assert.rejects(fetch(`${listener.redirectUri}?code=late`));
  });

  it('gives up after its timeout', async () => {
    const listener = await listenForAuthRedirect('s4', { provider: 'GitHub', timeoutMs: 20 });
    await assert.rejects(listener.params, (err: unknown) => err instanceof RedirectAbandoned && err.reason === 'timed-out');
  });

  it('is cancelled from the start by a signal that already fired', async () => {
    const controller = new AbortController();
    controller.abort();
    const listener = await listenForAuthRedirect('s5', { provider: 'GitHub', signal: controller.signal });
    await assert.rejects(listener.params, (err: unknown) => err instanceof RedirectAbandoned && err.reason === 'cancelled');
  });
});
