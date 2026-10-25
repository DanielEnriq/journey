import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { can, initialsFromEmail, inviteTokenIn, isEmail, joinNames, until } from './model.js';

// What the membership screens decide on their own. The database and the token services enforce the
// same rules (src/integrations/supabase/invitations.test.ts, server/src/livekit.test.ts).

describe('membership permissions', () => {
  it('lets only owners manage access, and keeps viewers to listening and commenting', () => {
    assert.equal(can('owner', 'invite'), true);
    assert.equal(can('member', 'invite'), false);
    assert.equal(can('member', 'talk'), true);
    assert.equal(can('viewer', 'talk'), false);
    assert.equal(can('viewer', 'sign_decision'), false);
    assert.equal(can('viewer', 'comment'), true);
    assert.equal(can('viewer', 'join_call'), true);
    assert.equal(can(undefined, 'comment'), false);
  });
});

describe('inviteTokenIn', () => {
  const token = 'AbCdEfGhIjKlMnOpQrStUv';
  it('finds the token in a link, a sentence, or alone', () => {
    assert.equal(inviteTokenIn(`vowe://join/${token}`), token);
    assert.equal(inviteTokenIn(`Join us: vowe://join/${token} (expires Friday)`), token);
    assert.equal(inviteTokenIn(`  ${token}\n`), token);
  });
  it('refuses anything else', () => {
    assert.equal(inviteTokenIn('vowe://join/short'), null);
    assert.equal(inviteTokenIn(`vowe://join/${token}x`), null);
    assert.equal(inviteTokenIn('https://example.com'), null);
  });
});

describe('membership formatting', () => {
  it('checks addresses and names people', () => {
    assert.equal(isEmail('ana@acme.com'), true);
    assert.equal(isEmail('ana@acme'), false);
    assert.equal(initialsFromEmail('ana.lopez@acme.com'), 'AL');
    assert.equal(joinNames(['Ana', 'Ben', 'Cy']), 'Ana, Ben and Cy');
  });
  it('says when something expires', () => {
    const now = Date.UTC(2026, 9, 24);
    assert.equal(until(now + 7 * 86_400_000, now), 'in 7 days');
    assert.equal(until(now - 1, now), 'expired');
  });
});
