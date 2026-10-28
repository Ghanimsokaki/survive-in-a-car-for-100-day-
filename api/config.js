/**
 * Exposes the public Supabase credentials (and a diagnostic of which env vars
 * were found) to the browser.
 *
 * Reads every common variable spelling — SUPABASE_URL, NEXT_PUBLIC_SUPABASE_URL,
 * VITE_SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_PUBLISHABLE_KEY, … — so a
 * Vercel/Supabase integration that named them differently still works.
 *
 * Only the anon / publishable key is ever returned; it is designed to be public
 * and is constrained by the row-level-security policies in supabase/schema.sql.
 * A service_role / secret key is refused outright.
 */
import { publicConfig } from '../lib/supabase-env.mjs';

export default function handler(req, res) {
  const body = publicConfig(process.env, 'vercel-serverless');
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store, max-age=0');
  res.setHeader('access-control-allow-origin', '*');
  res.end(JSON.stringify(body));
}
