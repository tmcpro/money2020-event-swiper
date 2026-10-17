// Cloudflare Pages Function: the subscribable .ics feed of a person's saved sessions.
//
//   GET /api/calendar/<ids>.ics      (canonical; built by M2020Calendar.feedUrl, routed via ./calendar/[feed].js)
//   GET /api/calendar?ids=<ids>      (legacy / manual form; also accepts ?s=<ids>)
//
// <ids> = M2020Calendar.encodeIds(eventIds). Unknown ids are ignored (a session removed upstream simply
// disappears from the feed), but a link where no id matches answers 404; at most M2020Calendar.MAX_IDS ids.
// Google ("add by URL"), Outlook ("add from web") and Apple (webcal://) fetch this URL from their own servers.
//
// core.js / venues.js / calendar.js are UMD (CommonJS branch); esbuild (wrangler) bundles them via these default
// imports, which resolve to each file's module.exports.
import Core from '../../core.js';
import Calendar from '../../calendar.js';

const UPSTREAM = 'https://us.money2020.com/api/schedule?siteName=money2020-us&search=&agendaType=default';
const UPSTREAM_TIMEOUT_MS = 8000;
const MEMO_TTL_MS = 10 * 60 * 1000;

// Per-isolate memo of the mapped schedule (best effort; isolates are short-lived).
let memo = null;

function textResponse(status, message, extra) {
  return new Response(`${message}\n`, {
    status,
    headers: Object.assign({
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }, extra || {})
  });
}

async function fetchUpstream() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(UPSTREAM, {
      headers: { Accept: 'application/json' },
      cf: { cacheTtl: 900, cacheEverything: true },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`Upstream HTTP ${res.status}`);
    const sessions = Core.mapSchedule(await res.json());
    // A 200 with an empty list (upstream glitch) must not wipe everyone's subscribed calendars: throw so the
    // bundled snapshot is served instead and only memoised for a minute.
    if (!sessions.length) throw new Error('Upstream returned no events');
    return sessions;
  } finally {
    clearTimeout(timer);
  }
}

// Bundled snapshot: events-data.js is `window.M2020_SCHEDULE_SNAPSHOT = {...};` (see scripts/update-snapshot.sh).
async function fetchSnapshot(context) {
  const assets = context.env && context.env.ASSETS;
  if (!assets || typeof assets.fetch !== 'function') throw new Error('No ASSETS binding');
  const res = await assets.fetch(new URL('/events-data.js', context.request.url));
  if (!res.ok) throw new Error(`Snapshot HTTP ${res.status}`);
  const text = await res.text();
  const start = text.indexOf('{', text.indexOf('M2020_SCHEDULE_SNAPSHOT'));
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Snapshot format not recognised');
  const sessions = Core.mapSchedule(JSON.parse(text.slice(start, end + 1)));
  if (!sessions.length) throw new Error('Snapshot has no events');
  return sessions;
}

async function loadSessions(context) {
  if (memo && Date.now() - memo.at < MEMO_TTL_MS) return memo;
  try {
    memo = { at: Date.now(), source: 'live', sessions: await fetchUpstream() };
    return memo;
  } catch (liveError) {
    console.warn('calendar feed: upstream failed, using snapshot', String(liveError && liveError.message));
    const sessions = await fetchSnapshot(context);
    // Do not memoise the fallback for long: retry the live schedule on the next request after 1 minute.
    memo = { at: Date.now() - MEMO_TTL_MS + 60 * 1000, source: 'snapshot', sessions };
    return memo;
  }
}

function idsFrom(context) {
  const url = new URL(context.request.url);
  const feed = context.params && context.params.feed;
  // Path form is always "<ids>.ics" (M2020Calendar.feedUrl); anything else (/api/calendar/robots.txt) is not a feed.
  if (typeof feed === 'string' && feed) return /\.ics$/i.test(feed) ? Calendar.decodeIds(feed) : [];
  return Calendar.decodeIds(url.searchParams.get('ids') || url.searchParams.get('s') || '');
}

export async function handleFeed(context) {
  const ids = idsFrom(context);
  if (!ids.length) {
    return textResponse(400, 'Missing or invalid session list. Open https://m2020.pages.dev and use "Add to calendar".');
  }

  let data;
  try {
    data = await loadSessions(context);
  } catch (error) {
    console.error('calendar feed: no schedule available', String(error && error.message));
    return textResponse(502, 'The schedule is temporarily unavailable. Please try again in a few minutes.', {
      'Retry-After': '300'
    });
  }

  const wanted = new Set(ids);
  const selected = data.sessions.filter((s) => wanted.has(s.eventId));
  // Ids that decode but match nothing are a mistyped/truncated link (e.g. /api/calendar/foo.ics): fail visibly
  // instead of letting Google/Outlook add an empty calendar. Partial matches still get 200.
  if (!selected.length) {
    return textResponse(404, 'No matching sessions in this link. Open https://m2020.pages.dev and use "Add to calendar" again.', {
      'X-M2020-Source': data.source,
      'X-M2020-Events': '0'
    });
  }
  const ics = Calendar.buildIcs(selected, { calName: Calendar.CALENDAR_NAME, refreshHours: 6 });
  const isHead = context.request.method === 'HEAD';

  return new Response(isHead ? null : ics, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="money2020-picks.ics"',
      // Calendar servers poll this URL; a short shared cache keeps the upstream load low while staying fresh.
      'Cache-Control': data.source === 'live' ? 'public, max-age=900, s-maxage=900' : 'public, max-age=60',
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
      'X-M2020-Source': data.source,
      'X-M2020-Events': String(selected.length)
    }
  });
}

export const onRequestGet = handleFeed;
export const onRequestHead = handleFeed;
