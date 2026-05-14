// GET/POST /api/logout — clears the site_auth cookie and bounces to /gate.html.

export default function handler(req, res) {
  res.statusCode = 302;
  res.setHeader(
    'Set-Cookie',
    'site_auth=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
  );
  res.setHeader('Location', '/gate');
  res.end();
}
