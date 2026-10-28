/**
 * Exposes the public Supabase credentials to the browser.
 * Only the anon key is ever sent — it is designed to be public and is
 * constrained by row level security policies in supabase/schema.sql.
 */
export default function handler(req, res) {
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify({
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
    mode: 'vercel-serverless',
  }));
}
