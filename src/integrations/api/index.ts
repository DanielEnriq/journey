import { config } from '../../config.js';
import { getCloud } from '../supabase/index.js';

/**
 * The Vowe cloud API (server/, hosted on DigitalOcean): server-side integrations whose secrets
 * must not ship with the app. Requests carry the caller's Supabase session, which the API checks.
 */

export function isApiConfigured(): boolean {
  return Boolean(config.api.url);
}

function baseUrl(): string {
  if (!config.api.url) throw new Error('Vowe API not configured — set VOWE_API_URL in .env');
  return config.api.url;
}

/** GET /health: which integrations the API has credentials for. Needs no session. */
export async function getApiHealth(): Promise<{ livekit: boolean; elevenlabs: boolean }> {
  const res = await fetch(`${baseUrl()}/health`);
  if (!res.ok) throw new Error(`Vowe API health check failed: ${res.status}`);
  return (await res.json()) as { livekit: boolean; elevenlabs: boolean };
}

/** POSTs as the signed-in cloud user; the API explains refusals as { error }. */
export async function postApi<T>(path: string, body: object = {}): Promise<T> {
  const { data } = await (await getCloud()).auth.getSession();
  const res = await fetch(`${baseUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session!.access_token}` },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as (T & { error?: unknown }) | null;
  if (!res.ok) throw new Error(typeof json?.error === 'string' ? json.error : `${path} failed: ${res.status}`);
  if (!json) throw new Error(`${path} returned no JSON`);
  return json;
}
