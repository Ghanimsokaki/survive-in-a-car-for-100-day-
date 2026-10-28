/**
 * Owner-only admin API.
 *
 *   GET  /api/admin?action=verify            → am I the owner?
 *   GET  /api/admin?action=bans              → ban list (RLS-protected table)
 *   POST /api/admin?action=ban   {username,reason}
 *   POST /api/admin?action=unban {username}
 *
 * Every call is checked against Supabase auth using the caller's own access
 * token, so a tampered client cannot grant itself admin rights.
 */
import { bearerToken, handleAdminRequest } from '../lib/admin-auth.mjs';

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body || '{}'); } catch { return {}; } }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

export default async function handler(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers?.host || 'localhost'}`);
  const action = (url.searchParams.get('action') || 'verify').toLowerCase();
  const token = bearerToken(req);

  let body = {};
  if (req.method === 'POST') {
    try { body = await readBody(req); } catch { body = {}; }
  }

  const out = await handleAdminRequest({
    method: req.method || 'GET',
    token,
    action,
    body,
    env: process.env,
  });

  res.statusCode = out.status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store, max-age=0');
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'authorization, apikey, content-type');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
  res.end(JSON.stringify(out.body));
}
