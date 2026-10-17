// Cloudflare Pages Function: proxies the Money20/20 USA agenda API, which sends no CORS headers.
const UPSTREAM = 'https://us.money2020.com/api/schedule?siteName=money2020-us&search=&agendaType=default';

export async function onRequestGet() {
  const upstream = await fetch(UPSTREAM, {
    headers: { Accept: 'application/json' },
    cf: { cacheTtl: 900, cacheEverything: true }
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300'
    }
  });
}
