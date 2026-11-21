import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

/** Lazily creates the single Supabase client. Only the public anon key is ever used here. */
export function getSupabase(): SupabaseClient {
  if (client) return client;
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (!url) throw new Error('Missing environment variable VITE_SUPABASE_URL (see .env.example)');
  if (!anonKey) throw new Error('Missing environment variable VITE_SUPABASE_ANON_KEY (see .env.example)');
  client = createClient(url, anonKey);
  return client;
}
