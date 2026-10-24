import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { IncomingMessage } from 'node:http';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

/** The caller, and a Supabase client scoped to them so RLS answers every query as them. */
export interface Caller {
  userId: string;
  supabase: SupabaseClient;
}

export async function authenticate(req: IncomingMessage): Promise<Caller> {
  const authorization = req.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) throw new HttpError(401, 'Not signed in');
  const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_PUBLISHABLE_KEY'), {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new HttpError(401, 'Not signed in');
  return { userId: data.user.id, supabase };
}
