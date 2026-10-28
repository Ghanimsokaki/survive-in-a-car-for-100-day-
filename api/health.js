export default function handler(req, res) {
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify({ ok: true, mode: 'vercel-serverless', poll: true, ts: Date.now() }));
}
