// Edge Middleware — password gate for the public studio site.
//
// Gates every request behind a single shared password held in the
// SITE_PASSWORD env var on Vercel. On success the browser receives an
// HttpOnly cookie (`site_auth`) whose value is sha256(SITE_PASSWORD).
// Middleware recomputes that hash and compares — no session store.
//
// To rotate the password: change SITE_PASSWORD in Vercel → redeploy.
// All existing cookies will invalidate automatically.
//
// To disable the gate entirely: unset SITE_PASSWORD (or set it empty).
// Middleware fails open in that case so the site never bricks itself.

export const config = {
  // Match everything; exclusions are handled in code below for portability
  // (negative lookaheads in matcher aren't reliable on non-Next Vercel projects).
  matcher: '/:path*',
};

const EXEMPT_EXACT = new Set([
  '/gate',
  '/gate.html',
  '/favicon.ico',
  '/robots.txt',
  '/llms.txt',
  '/sitemap.xml',
]);

const EXEMPT_PREFIXES = ['/api/gate', '/api/logout', '/_vercel', '/_next'];

async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function readCookie(header, name) {
  if (!header) return '';
  const parts = header.split(/;\s*/);
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    if (p.slice(0, eq) === name) return p.slice(eq + 1);
  }
  return '';
}

export default async function middleware(request) {
  const url = new URL(request.url);
  const path = url.pathname;

  // Exempt paths — gate page, gate endpoints, infra, a few asset routes.
  if (EXEMPT_EXACT.has(path)) return;
  for (const prefix of EXEMPT_PREFIXES) {
    if (path.startsWith(prefix)) return;
  }

  // Fail open if SITE_PASSWORD isn't configured yet — first deploy
  // safety so we don't lock ourselves out before setting the env var.
  const expected = process.env.SITE_PASSWORD || '';
  if (!expected) return;

  const cookieHeader = request.headers.get('cookie');
  const token = readCookie(cookieHeader, 'site_auth');
  const expectedHash = await sha256Hex(expected);

  if (token && token === expectedHash) return;

  // Not authenticated → redirect to gate, preserving the original target.
  // Use /gate (cleanUrls form) so we don't bounce through a 308 on /gate.html.
  const gateUrl = new URL('/gate', request.url);
  gateUrl.searchParams.set('from', path + url.search);
  return Response.redirect(gateUrl.toString(), 302);
}
