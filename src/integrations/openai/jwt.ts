import { createPublicKey, verify, type JsonWebKeyInput } from 'node:crypto';

/**
 * Validates an OpenID Connect ID token: RS256 signature against the issuer's JWKS, issuer, audience,
 * expiry and nonce. Returns its claims. No other algorithm is accepted, so an unsigned or HMAC token
 * can't pass.
 */

export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nonce?: string;
  email?: string;
  name?: string;
  [claim: string]: unknown;
}

export type Jwks = { keys: (JsonWebKeyInput['key'] & { kid?: string; alg?: string; use?: string })[] };

const CLOCK_SKEW_S = 120;

const b64json = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

export async function validateIdToken(
  token: string,
  expected: { issuer: string; audience: string; nonce: string },
  jwks: (refresh: boolean) => Promise<Jwks>,
  now = Date.now(),
): Promise<IdTokenClaims> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('The ID token is malformed.');
  const [headerPart, payloadPart, signaturePart] = parts;
  const header = b64json(headerPart) as { alg?: string; kid?: string };
  if (header.alg !== 'RS256') throw new Error(`The ID token is signed with ${header.alg ?? 'nothing'}, not RS256.`);

  // A key we don't have may be newly rotated in: fetch the set again once.
  let key = (await jwks(false)).keys.find((k) => k.kid === header.kid);
  key ??= (await jwks(true)).keys.find((k) => k.kid === header.kid);
  if (!key) throw new Error('The ID token is signed with a key OpenAI does not publish.');
  const signed = verify('sha256', Buffer.from(`${headerPart}.${payloadPart}`), createPublicKey({ key, format: 'jwk' }), Buffer.from(signaturePart, 'base64url'));
  if (!signed) throw new Error('The ID token signature is invalid.');

  const claims = b64json(payloadPart) as IdTokenClaims;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== expected.issuer) throw new Error('The ID token is from the wrong issuer.');
  if (!audiences.includes(expected.audience)) throw new Error('The ID token was issued for another client.');
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < now / 1000) throw new Error('The ID token has expired.');
  if (claims.nonce !== expected.nonce) throw new Error('The ID token nonce does not match this sign-in.');
  if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('The ID token has no subject.');
  return claims;
}
