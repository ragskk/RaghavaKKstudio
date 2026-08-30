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

  // --- Calling All Gods (calling4): public standalone page, ungated ---
  // The page itself plus the exact static assets it loads. Everything else
  // on the site stays behind SITE_PASSWORD. Keep this list in sync with the
  // asset references in calling4.html. (calling2/calling3 removed 2026-08-20;
  // archived in not-used/archive-removed-pages-2026-08-20/.)
  '/calling4',
  '/calling4.html',
  '/protect.css',
  '/protect.js',
  '/css/book-modal.css',
  '/js/book-modal.js',
  '/images/Raghava KK Logo-02.png',
  '/images/bio/liberty-guernica.jpg',
  '/images/bio/portrait.jpg',
  '/books/art books/Calling All Gods_Artist Book.pdf',  // no-JS book-link fallback
]);

const EXEMPT_PREFIXES = [
  '/api/gate',
  '/api/logout',
  '/_vercel',
  '/_next',

  // --- Calling All Gods (calling4) asset directories ---
  '/js/vendor/',        // model-viewer (+ any bundled decoders)
  '/toys/3d/',          // pantheon GLB figures
  '/images/books/',     // art-zine shelf covers
  '/images/spreads/',   // popup book-reader spreads
  '/images/hero/',      // hero carousel (photos + film)
  '/images/details/',   // painting detail crops
];

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

  // Decode percent-encoding so exemptions match paths with spaces
  // (e.g. "/images/two paintings together.png").
  let decodedPath = path;
  try {
    decodedPath = decodeURIComponent(path);
  } catch {
    // Malformed encoding — fall back to the raw path.
  }

  // Exempt paths — gate page, gate endpoints, infra, the public calling4
  // page and its assets.
  if (EXEMPT_EXACT.has(decodedPath)) return;
  for (const prefix of EXEMPT_PREFIXES) {
    if (decodedPath.startsWith(prefix)) return;
  }

  // Fail open if SITE_PASSWORD isn't configured yet — first deploy
  // safety so we don't lock ourselves out before setting the env var.
  const expected = process.env.SITE_PASSWORD || '';
  if (!expected) return;

  const cookieHeader = request.headers.get('cookie');
  const token = readCookie(cookieHeader, 'site_auth');
  const expectedHash = await sha256Hex(expected);

  if (token && token === expectedHash) return;

  // Share-link bypass: /any/path?password=<phrase> → set the auth cookie and
  // redirect to the same URL with the param stripped, so the phrase never
  // lingers in the address bar or in referrers. Replaces the old client-side
  // ?password= share links (retired 2026-08-30).
  const shared = url.searchParams.get('password');
  if (shared !== null) {
    if (shared === expected) {
      url.searchParams.delete('password');
      const clean = url.pathname + (url.search || '');
      return new Response(null, {
        status: 302,
        headers: {
          Location: clean,
          'Set-Cookie': `site_auth=${expectedHash}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}`,
          'Cache-Control': 'no-store',
        },
      });
    }
    // Wrong phrase in the link: fall through to the gate.
  }

  // Not authenticated → redirect to gate, preserving the original target.
  // Use /gate (cleanUrls form) so we don't bounce through a 308 on /gate.html.
  const gateUrl = new URL('/gate', request.url);
  gateUrl.searchParams.set('from', path + url.search);
  return Response.redirect(gateUrl.toString(), 302);
}
