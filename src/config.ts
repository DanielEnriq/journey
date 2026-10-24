import { existsSync } from 'node:fs';
import { join } from 'node:path';

const envPath = join(import.meta.dirname, '..', '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} — copy .env.example to .env and fill it in`);
  return value;
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
function effort(value: string | undefined): (typeof EFFORTS)[number] {
  return EFFORTS.find((e) => e === value) ?? 'medium';
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
  // Optional until the call feature is wired in; src/integrations/elevenlabs checks at use time.
  elevenlabs: {
    apiKey: process.env.ELEVENLABS_API_KEY,
    agentId: process.env.ELEVENLABS_AGENT_ID,
  },
  // Vowe's agent (src/assistant). Preferred: the person's ChatGPT plan through Sign in with ChatGPT
  // (integrations/openai/chatgpt.ts). Fallbacks, used only when chosen or when no plan is signed in:
  // OPENAI_API_KEY, then ANTHROPIC_API_KEY (or an `ant auth login` profile).
  agent: {
    /**
     * `auto` (default): the ChatGPT plan when signed in with plan usage granted, else an API key.
     * Or pin one: `chatgpt`, `openai`, `anthropic`.
     */
    provider: (['auto', 'chatgpt', 'openai', 'anthropic'] as const).find((p) => p === process.env.VOWE_AGENT_PROVIDER) ?? 'auto',
    /** A ChatGPT-plan model slug; empty picks the first one GET /v1/models lists for the account. */
    chatgptModel: process.env.VOWE_CHATGPT_MODEL || '',
    openaiModel: process.env.VOWE_OPENAI_MODEL || 'gpt-6.1-sol',
    anthropicModel: process.env.VOWE_AGENT_MODEL || 'claude-opus-5-5',
    effort: effort(process.env.VOWE_AGENT_EFFORT),
    /** Retry a request the model's safeguards decline on Anthropic's recommended fallback model. */
    fallbacks: process.env.VOWE_AGENT_FALLBACKS !== 'off',
  },
  // Sign in with ChatGPT plan usage. OpenAI documents it for open-source, locally hosted apps; paid or
  // remotely hosted apps go through OpenAI's interest form. Off until whoever ships this build confirms
  // it qualifies (see src/assistant/INTEGRATION.md → Eligibility).
  chatgpt: {
    enabled: process.env.VOWE_CHATGPT_PLAN === 'on',
    /** The agent name the person sees on OpenAI's consent screen at first registration. */
    agentName: 'Vowe',
  },
  // Optional: the Vowe cloud API (server/), which holds the LiveKit and ElevenLabs secrets. Without it,
  // call tokens come from the Supabase Edge Function and ElevenLabs uses the local key above.
  api: {
    url: process.env.VOWE_API_URL?.replace(/\/+$/, ''),
  },
  // Optional: without it the app runs local-only. src/integrations/supabase checks at use time.
  supabase: {
    url: process.env.SUPABASE_URL,
    publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY,
  },
};
