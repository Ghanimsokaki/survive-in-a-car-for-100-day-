// Tiny Supabase stand-in: GoTrue-ish auth + a PostgREST-ish REST surface.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const users = new Map();
const byEmail = new Map();
const sessions = new Map();
const tables = { profiles: [], friendships: [], presence: [] };

const json = (res, code, body) => {
  res.writeHead(code, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization,apikey,content-type,prefer',
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  });
  res.end(JSON.stringify(body));
};

function splitTop(s) {
  const out = []; let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function parseCond(str) {
  str = str.trim();
  if (str.startsWith('and(')) {
    const parts = splitTop(str.slice(4, -1)).map(parseCond);
    return (row) => parts.every((f) => f(row));
  }
  if (str.startsWith('or(')) {
    const parts = splitTop(str.slice(3, -1)).map(parseCond);
    return (row) => parts.some((f) => f(row));
  }
  const m = str.match(/^([a-z_]+)\.(eq|neq|in|gt|lt)\.(.*)$/i);
  if (!m) return () => true;
  const [, field, op, raw] = m;
  if (op === 'eq') return (row) => String(row[field]) === raw;
  if (op === 'neq') return (row) => String(row[field]) !== raw;
  if (op === 'gt') return (row) => Number(row[field]) > Number(raw);
  if (op === 'lt') return (row) => Number(row[field]) < Number(raw);
  if (op === 'in') {
    const vals = raw.replace(/^\(|\)$/g, '').split(',').map((v) => v.trim().replace(/^"|"$/g, ''));
    return (row) => vals.includes(String(row[field]));
  }
  return () => true;
}

function matchRow(row, params) {
  for (const [key, val] of params) {
    if (['select', 'on_conflict', 'order', 'limit', 'columns'].includes(key)) continue;
    if (key === 'or') { if (!parseCond(`or(${String(val).replace(/^\(|\)$/g, '')})`)(row)) return false; continue; }
    if (key === 'and') { if (!parseCond(`and(${String(val).replace(/^\(|\)$/g, '')})`)(row)) return false; continue; }
    if (!String(val).includes('.')) {
      if (String(row[key]) !== String(val)) return false;
      continue;
    }
    if (!parseCond(`${key}.${val}`)(row)) return false;
  }
  return true;
}

function authUser(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const uid = sessions.get(token);
  return uid ? users.get(uid) : null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let raw = '';
  for await (const chunk of req) raw += chunk;
  let body = {};
  if (raw) { try { body = JSON.parse(raw); } catch { body = {}; } }

  if (req.method === 'OPTIONS') return json(res, 204, {});

  if (url.pathname === '/auth/v1/signup' && req.method === 'POST') {
    const email = String(body.email || '').toLowerCase();
    if (byEmail.has(email)) return json(res, 422, { msg: 'User already registered', error_code: 'user_already_exists' });
    if (String(body.password || '').length < 6) return json(res, 422, { msg: 'Password should be at least 6 characters.' });
    const id = randomUUID();
    const user = { id, email, password: body.password, raw_user_meta_data: body.data || {} };
    users.set(id, user); byEmail.set(email, id);
    tables.profiles.push({
      id,
      username: String(body.data?.username || 'survivor').toLowerCase(),
      display_name: body.data?.display_name || body.data?.username || 'SURVIVOR',
      body_color: '#ffb347', car_color: '#d24a2b', best_day: 0,
      created_at: new Date().toISOString(),
    });
    const access_token = `mock.${id}.${Math.random().toString(36).slice(2)}`;
    sessions.set(access_token, id);
    return json(res, 200, {
      access_token, refresh_token: `refresh-${id}`, expires_in: 3600, token_type: 'bearer',
      user: { id, email, user_metadata: user.raw_user_meta_data },
    });
  }

  if (url.pathname === '/auth/v1/token' && req.method === 'POST') {
    const grant = url.searchParams.get('grant_type');
    if (grant === 'password') {
      const id = byEmail.get(String(body.email || '').toLowerCase());
      const u = id && users.get(id);
      if (!u || u.password !== body.password) return json(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
      const token = `mock.${id}.${Math.random().toString(36).slice(2)}`;
      sessions.set(token, id);
      return json(res, 200, { access_token: token, refresh_token: `refresh-${id}`, expires_in: 3600, user: { id, email: u.email, user_metadata: u.raw_user_meta_data } });
    }
    if (grant === 'refresh_token') {
      const id = String(body.refresh_token || '').replace('refresh-', '');
      if (!users.has(id)) return json(res, 400, { error: 'invalid_grant' });
      const token = `mock.${id}.${Math.random().toString(36).slice(2)}`;
      sessions.set(token, id);
      return json(res, 200, { access_token: token, refresh_token: `refresh-${id}`, expires_in: 3600, user: { id } });
    }
    return json(res, 400, { msg: 'bad grant' });
  }

  if (url.pathname === '/auth/v1/user' && req.method === 'GET') {
    const u = authUser(req);
    if (!u) return json(res, 401, { msg: 'no session' });
    return json(res, 200, { id: u.id, email: u.email, user_metadata: u.raw_user_meta_data });
  }

  if (url.pathname === '/auth/v1/logout') {
    sessions.delete((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    res.writeHead(204, { 'access-control-allow-origin': '*' });
    return res.end();
  }

  if (url.pathname.startsWith('/rest/v1/rpc/')) {
    const fn = url.pathname.split('/').pop();
    const me = authUser(req);
    if (!me) return json(res, 401, { msg: 'not signed in' });
    if (fn === 'add_friend') {
      const target = tables.profiles.find((p) => p.username === String(body.target_username || '').toLowerCase());
      if (!target) return json(res, 400, { msg: 'no_such_user' });
      if (target.id === me.id) return json(res, 400, { msg: 'cannot_add_self' });
      const has = (a, b) => tables.friendships.some((f) => f.user_id === a && f.friend_id === b);
      if (!has(me.id, target.id)) tables.friendships.push({ user_id: me.id, friend_id: target.id, created_at: new Date().toISOString() });
      if (!has(target.id, me.id)) tables.friendships.push({ user_id: target.id, friend_id: me.id, created_at: new Date().toISOString() });
      return json(res, 200, [{ id: target.id, username: target.username, display_name: target.display_name }]);
    }
    if (fn === 'remove_friend') {
      const t = body.target_id;
      tables.friendships = tables.friendships.filter((f) => !((f.user_id === me.id && f.friend_id === t) || (f.user_id === t && f.friend_id === me.id)));
      return json(res, 200, null);
    }
    return json(res, 404, { msg: 'unknown function' });
  }

  if (url.pathname.startsWith('/rest/v1/')) {
    const table = url.pathname.split('/').pop();
    const me = authUser(req);
    if (!me) return json(res, 401, { msg: 'JWT required' });
    if (!tables[table]) return json(res, 404, { msg: 'no such table' });
    const params = [...url.searchParams.entries()];

    if (req.method === 'GET') return json(res, 200, tables[table].filter((r) => matchRow(r, params)));

    if (req.method === 'POST') {
      const rows = Array.isArray(body) ? body : [body];
      const onConflict = url.searchParams.get('on_conflict');
      const out = [];
      for (const row of rows) {
        if (table === 'friendships' && row.user_id !== me.id) return json(res, 403, { msg: 'row-level security' });
        if (table === 'presence' && row.user_id !== me.id) return json(res, 403, { msg: 'row-level security' });
        if (table === 'profiles' && row.id !== me.id) return json(res, 403, { msg: 'row-level security' });
        if (process.env.MOCK_TRACE) {
          const who = (() => { try { return me.email; } catch { return '?'; } })();
          console.log(`[mock] ${req.method} ${table} as=${who} row=${JSON.stringify(row).slice(0, 160)}`);
        }
        const keys = onConflict ? onConflict.split(',') : [table === 'presence' ? 'user_id' : 'id'];
        const existing = tables[table].find((r) => keys.every((k) => r[k] === row[k]));
        if (existing) { Object.assign(existing, row); out.push(existing); continue; }
        tables[table].push(row); out.push(row);
      }
      return json(res, 201, out);
    }

    if (req.method === 'PATCH') {
      const rows = tables[table].filter((r) => matchRow(r, params));
      rows.forEach((r) => Object.assign(r, body));
      return json(res, 200, rows);
    }

    if (req.method === 'DELETE') {
      const removed = tables[table].filter((r) => matchRow(r, params));
      tables[table] = tables[table].filter((r) => !matchRow(r, params));
      return json(res, 200, removed);
    }
  }

  json(res, 404, { msg: `no route ${url.pathname}` });
});

const port = Number(process.env.MOCK_PORT || 54321);
server.listen(port, '127.0.0.1', () => console.log('mock supabase on', port));

export { tables, users };
