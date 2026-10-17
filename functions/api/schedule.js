// Cloudflare Pages Function: proxies the Money20/20 USA agenda API, which sends no CORS headers.
// On upstream failure it answers 502 quickly; app.js then falls back to the bundled events-data.js snapshot.
const UPSTREAM = 'https://us.money2020.com/api/schedule?siteName=money2020-us&search=&agendaType=default';
const UPSTREAM_TIMEOUT_MS = 8000;

export async function onRequestGet() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstream = await fetch(UPSTREAM, {
      headers: { Accept: 'application/json' },
      cf: { cacheTtl: 900, cacheEverything: true },
      signal: controller.signal
    });
    if (!upstream.ok) throw new Error(`Upstream HTTP ${upstream.status}`);
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=300'
      }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: 'Schedule temporarily unavailable.' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  } finally {
    clearTimeout(timer);
  }
}
