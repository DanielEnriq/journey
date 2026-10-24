import { existsSync } from 'node:fs';
import { join } from 'node:path';

const envPath = join(import.meta.dirname, '..', '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} — copy .env.example to .env and fill it in`);
  return value;
}

export const config = {
  // Getters so a missing .env surfaces when auth runs (and exits cleanly), not at import time.
  google: {
    get clientId() {
      return required('GOOGLE_CLIENT_ID');
    },
    // Desktop OAuth clients have a "secret" that Google documents as non-confidential; PKCE is the real protection.
    get clientSecret() {
      return required('GOOGLE_CLIENT_SECRET');
    },
    scopes: ['openid', 'email', 'profile'],
  },
  // Optional until the call feature is wired in; src/voice/elevenlabs.ts checks at use time.
  elevenlabs: {
    apiKey: process.env.ELEVENLABS_API_KEY,
    agentId: process.env.ELEVENLABS_AGENT_ID,
  },
};
