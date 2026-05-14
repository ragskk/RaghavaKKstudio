// POST /api/gate
//
// Verifies a submitted password against the SITE_PASSWORD env var on
// Vercel. On match, issues an HttpOnly cookie whose value is the
// sha256 hex digest of SITE_PASSWORD. The middleware re-derives that
// digest on every request and compares — no session storage anywhere.
//
// Constant-time comparison guards against timing attacks. Open redirect
// is blocked by requiring `from` to be a relative path starting with `/`.

import crypto from 'node:crypto';

const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function safeFrom(raw) {
  if (typeof raw !== 'string') return '/';
  if (!raw.startsWith('/')) return '/';
  if (raw.startsWith('//')) return '/'; // protocol-relative
  return raw;
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 4096) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'POST');
    res.end('Method Not Allowed');
    return;
  }

  const expected = process.env.SITE_PASSWORD || '';
  if (!expected) {
    res.statusCode = 503;
    res.end('Gate not configured.');
    return;
  }

  let raw = '';
  try {
    raw = await readBody(req);
  } catch {
    res.statusCode = 400;
    res.end('Bad request.');
    return;
  }

  const params = new URLSearchParams(raw);
  const submitted = params.get('password') || '';
  const from = safeFrom(params.get('from'));

  // Constant-time compare. Both buffers must be same length to call
  // timingSafeEqual without throwing, so we pad the submitted value to
  // the expected length first (then still require equal lengths to
  // count as a match).
  const a = Buffer.from(submitted);
  const b = Buffer.from(expected);
  let ok = false;
  if (a.length === b.length) {
    ok = crypto.timingSafeEqual(a, b);
  } else {
    // Run the compare anyway to keep the timing roughly even.
    const pad = Buffer.alloc(b.length);
    crypto.timingSafeEqual(pad, b);
    ok = false;
  }

  if (!ok) {
    res.statusCode = 302;
    const back = new URL('/gate', 'http://placeholder');
    back.searchParams.set('error', '1');
    back.searchParams.set('from', from);
    res.setHeader('Location', back.pathname + back.search);
    res.end();
    return;
  }

  const token = crypto.createHash('sha256').update(expected).digest('hex');

  res.statusCode = 302;
  res.setHeader(
    'Set-Cookie',
    `site_auth=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`,
  );
  res.setHeader('Location', from);
  res.end();
}
