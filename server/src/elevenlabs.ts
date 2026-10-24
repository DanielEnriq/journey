// Short-lived (15 min) WebSocket URL for the private ElevenLabs agent, so the API key stays on the server.
// Any signed-in user may ask; nothing in the app starts a conversation yet.

import { env } from './http.js';

export function isElevenLabsConfigured(): boolean {
  return Boolean(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_AGENT_ID);
}

export async function signedUrl(): Promise<string> {
  const agentId = encodeURIComponent(env('ELEVENLABS_AGENT_ID'));
  const res = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${agentId}`, {
    headers: { 'xi-api-key': env('ELEVENLABS_API_KEY') },
  });
  if (!res.ok) throw new Error(`ElevenLabs get-signed-url failed: ${res.status} ${await res.text()}`);
  const { signed_url } = (await res.json()) as { signed_url: string };
  return signed_url;
}
