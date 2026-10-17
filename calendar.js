/*
 * calendar.js - iCalendar (.ics) builder + subscription links for M2020 Event Swiper.
 *
 * UMD: module.exports in Node / Pages Functions (bundled by esbuild), window.M2020Calendar in the browser.
 * Depends on core.js (M2020Core) and venues.js (M2020Venues). In the browser both must be loaded first;
 * venues are looked up lazily so a missing venues.js degrades to "room, The Venetian Expo, address".
 * No DOM access anywhere (must run inside a Cloudflare Worker).
 *
 * API (see CONTRACTS.md for full semantics)
 *   buildIcs(sessions, opts?) -> string           RFC 5545 VCALENDAR, CRLF line endings, folded at 75 octets
 *   describe(session) -> string                   plain-text DESCRIPTION body (unescaped, real newlines)
 *   locationFor(session) -> string                one-line LOCATION (unescaped)
 *   whenText(session) -> string                   "Sun, Oct 18 · 9:00–9:25 AM PT (25 min)"
 *   isExportable(session) -> boolean              true when the session has a parseable date + start time
 *   encodeIds(ids) -> string                      compact URL-safe encoding of eventIds
 *   decodeIds(str) -> number[]                    inverse of encodeIds; sorted, unique; [] on garbage
 *   feedUrl(origin, ids) -> string                https URL of the .ics feed served by functions/api/calendar
 *   googleSubscribeUrl(feedUrl) -> string         Google Calendar "add by URL" link
 *   outlookSubscribeUrl(feedUrl, name, {work}) -> string   Outlook "add from web" deep link
 *   webcalUrl(feedUrl) -> string                  webcal:// version of the feed (Apple Calendar)
 *
 * DESCRIPTION FORMAT - why plain text (research notes, 2026-10-17)
 *   - RFC 5545 DESCRIPTION is TEXT. Google Calendar shows it as text, keeps line breaks and auto-links bare
 *     URLs; its event popup shows only the first lines, so the essentials (where / floor map / when / format)
 *     come first. Google does not use X-ALT-DESC.
 *   - Outlook (desktop, web, mobile) shows DESCRIPTION as plain text and prints HTML tags literally; only
 *     classic Outlook for Windows reads the Microsoft extension X-ALT-DESC;FMTTYPE=text/html.
 *     Sources: Microsoft [MS-OXCICAL] (X-ALT-DESC), developer reports that HTML tags show up verbatim in
 *     Outlook appointments, https://icalendar.readthedocs.io (TEXT escaping), RFC 5545 section 3.3.11.
 *   - Apple Calendar shows DESCRIPTION as plain text (Notes) and ignores X-ALT-DESC.
 *   => One well-structured plain-text body renders the same in all three; no X-ALT-DESC (a second, HTML copy
 *      would only show in classic Outlook and could drift from the plain text). Section labels are short
 *      UPPERCASE words (no Markdown, no HTML, no emoji: emoji render inconsistently in Outlook desktop and the
 *      design direction keeps the ICS emoji-free). Bullets "•", separators "·" and the "─" rule are plain
 *      Unicode that all three clients render with system fonts. URLs stand alone (no trailing punctuation) so
 *      every client auto-links them.
 *
 * SUBSCRIBE LINKS (research notes, 2026-10-17; formats are undocumented, community-verified)
 *   - Google: https://calendar.google.com/calendar/render?cid=<encodeURIComponent(webcal://host/path)>.
 *     Google wants the webcal:// form in cid (an https:// value is treated as a calendar id and fails); it then
 *     fetches the feed over http and follows the 301 to https (m2020.pages.dev redirects http -> https).
 *     Google only lets people add a calendar by URL in a computer web browser (support.google.com/calendar/
 *     answer/37100: "To subscribe to a new calendar, you must use a computer web browser"); export-ui.js
 *     explains this on phones. Google polls subscribed feeds roughly once a day, so the feed is a snapshot.
 *   - Outlook: https://outlook.live.com/calendar/0/addfromweb?url=<https feed>&name=<name> (personal) and
 *     https://outlook.office.com/calendar/0/addfromweb?url=...&name=... (Microsoft 365 work/school). Outlook
 *     on the web needs the https:// form (webcal:// does not reach it).
 *   - Apple: webcal://host/path opens the Calendar subscribe sheet on iPhone, iPad and Mac.
 *   - The feed path ends in ".ics" (/api/calendar/<ids>.ics): some clients only accept URLs that look like an
 *     .ics file, and a path avoids "?" being mangled when the URL is nested inside cid=/url= parameters.
 */
(function (root, factory) {
  if (typeof module === 'object' && module && module.exports) {
    module.exports = factory(require('./core.js'), require('./venues.js'));
  } else {
    root.M2020Calendar = factory(root.M2020Core, null, root);
  }
}(typeof self !== 'undefined' ? self : this, function (Core, VenuesDep, globalRoot) {
  'use strict';

  const TZID = Core.TIMEZONE;
  const CONF = Core.CONFERENCE;
  const UID_DOMAIN = 'money2020-event-swiper'; // keep: users already imported files with these UIDs
  const MAX_IDS = 400;
  const FEED_PATH = '/api/calendar';
  const CALENDAR_NAME = 'Money20/20 picks';
  const CALENDAR_DESC = `Sessions saved in ${CONF.appName} (unofficial) for ${CONF.name}, ${CONF.city}. ` +
    'Times are Pacific Time. Shown as free so they do not block your calendar.';
  const PRODID = '-//M2020 Event Swiper//Money20/20 USA 2026//EN';
  const RULE = '────────────────────';
  const NDASH = '–';

  function venues() {
    if (VenuesDep) return VenuesDep;
    if (globalRoot && globalRoot.M2020Venues) return globalRoot.M2020Venues;
    return null;
  }

  function resolveVenue(name) {
    const V = venues();
    if (V && typeof V.resolve === 'function') {
      try {
        return V.resolve(name);
      } catch (error) {
        return null;
      }
    }
    return null;
  }

  // ---------- iCalendar text helpers ----------

  // RFC 5545 3.3.11 TEXT: escape backslash first, then ; and , ; newlines become \n.
  // Control characters other than newline/tab are not allowed in TEXT and are dropped.
  function escapeText(text) {
    if (text === null || text === undefined) return '';
    return String(text)
      .replace(/\r\n|\r/g, '\n')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\n/g, '\\n');
  }

  function utf8Length(ch) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) return 1;
    if (cp < 0x800) return 2;
    if (cp < 0x10000) return 3;
    return 4;
  }

  // Fold a content line so no physical line exceeds 75 octets (RFC 5545 3.1). Iterates by code point, so a
  // multi-byte UTF-8 character or a surrogate pair is never split. Continuation lines start with one space,
  // which counts toward their 75 octets.
  function foldLine(line) {
    const out = [];
    let current = '';
    let octets = 0;
    for (const ch of String(line)) {
      const len = utf8Length(ch);
      if (octets + len > 75) {
        out.push(current);
        current = ' ';
        octets = 1;
      }
      current += ch;
      octets += len;
    }
    out.push(current);
    return out.join('\r\n');
  }

  function formatLocalDateTime(dateIso, time) {
    const d = Core.normalizeDateIso(dateIso);
    const t = Core.normalizeTime(time);
    if (!d || !t) return '';
    return `${d.replace(/-/g, '')}T${t}00`;
  }

  function formatUtcStamp(date) {
    return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  }

  // America/Los_Angeles since 2007: PDT from the 2nd Sunday of March, PST from the 1st Sunday of November.
  const VTIMEZONE = [
    'BEGIN:VTIMEZONE',
    `TZID:${TZID}`,
    `X-LIC-LOCATION:${TZID}`,
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:-0800',
    'TZOFFSETTO:-0700',
    'TZNAME:PDT',
    'DTSTART:20070311T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:-0700',
    'TZOFFSETTO:-0800',
    'TZNAME:PST',
    'DTSTART:20071104T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
    'END:STANDARD',
    'END:VTIMEZONE'
  ];

  // ---------- Time helpers ----------

  function toMinutes(hhmm) {
    return parseInt(hhmm.slice(0, 2), 10) * 60 + parseInt(hhmm.slice(2), 10);
  }

  function fromMinutes(total) {
    const m = ((total % 1440) + 1440) % 1440;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}${String(m % 60).padStart(2, '0')}`;
  }

  // Normalised start/end for a session: { dateIso, start, endDateIso, end, minutes }.
  // end < start normally means "past midnight" (rolls to the next day). Exception: the upstream feed sometimes
  // writes a just-after-noon end in 12-hour form (e.g. 1230 -> 0040 for a 10-minute pitch); when adding 12 h
  // gives an end at most 4 h after the start, that reading is used instead of a 12-hour session.
  function timing(session) {
    const dateIso = (session && (session.dateIso || Core.normalizeDateIso(session.rawDateIso))) || '';
    const start = Core.normalizeTime(session && session.startTime);
    let end = Core.normalizeTime(session && session.endTime);
    let endDateIso = dateIso;
    let minutes = 0;
    if (start && end) {
      const s = toMinutes(start);
      let e = toMinutes(end);
      if (e < s) {
        if (e < 720 && e + 720 > s && e + 720 - s <= 240) {
          e += 720;
          end = fromMinutes(e);
        } else {
          e += 1440;
          endDateIso = Core.addDaysIso(dateIso, 1);
        }
      }
      minutes = e - s;
    }
    if (!end) end = start;
    return { dateIso, start, endDateIso, end, minutes };
  }

  function clock(hhmm) {
    const h = parseInt(hhmm.slice(0, 2), 10);
    return { text: `${h % 12 === 0 ? 12 : h % 12}:${hhmm.slice(2)}`, period: h >= 12 ? 'PM' : 'AM' };
  }

  // "9:00–9:25 AM", "11:30 AM–12:15 PM"
  function timeRange(start, end) {
    const a = clock(start);
    if (!end || end === start) return `${a.text} ${a.period}`;
    const b = clock(end);
    if (a.period === b.period) return `${a.text}${NDASH}${b.text} ${b.period}`;
    return `${a.text} ${a.period}${NDASH}${b.text} ${b.period}`;
  }

  // 25 -> "25 min", 60 -> "1 h", 90 -> "1 h 30 min"
  function durationLabel(minutes) {
    if (!minutes || minutes <= 0) return '';
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (!h) return `${m} min`;
    return m ? `${h} h ${m} min` : `${h} h`;
  }

  // "Sun, Oct 18 · 9:00–9:25 AM PT (25 min)"
  function whenText(session) {
    const t = timing(session);
    const day = Core.formatDateShort(t.dateIso) || 'Date TBA';
    if (!t.start) return `${day} · Time TBA`;
    const notes = [durationLabel(t.minutes)];
    if (t.endDateIso && t.endDateIso !== t.dateIso) notes.push('ends next day');
    const extra = notes.filter(Boolean).join(', ');
    return `${day} · ${timeRange(t.start, t.end)} PT${extra ? ` (${extra})` : ''}`;
  }

  // ---------- Session -> text ----------

  // "Galileo 1001-1003 (Intelligence Summit), The Venetian Expo, 201 Sands Ave, Las Vegas, NV 89169"
  // Off-site venues carry their own building + street address (e.g. Caesars Palace for OMNIA).
  function locationFor(session) {
    const venueName = ((session && session.venue) || '').trim();
    const v = resolveVenue(venueName);
    if (v && v.address) {
      const room = v.room || venueName;
      const area = areaFor(v, room);
      const place = room ? (area ? `${room} (${area})` : room) : area;
      return [place, v.address].filter(Boolean).join(', ');
    }
    return [venueName, 'The Venetian Expo, 201 Sands Ave, Las Vegas, NV 89169'].filter(Boolean).join(', ');
  }

  // Area label unless the room name already says it ("MoneyPot Stage" + "MoneyPot" -> no area).
  function areaFor(v, room) {
    const area = (v && v.area) || '';
    if (!area) return '';
    return String(room || '').toLowerCase().indexOf(area.toLowerCase()) === -1 ? area : '';
  }

  function streetOf(v) {
    // ADDRESSES start with the building name; strip it to get the street part.
    if (!v || !v.address) return '';
    const prefix = `${v.building}, `;
    return v.address.indexOf(prefix) === 0 ? v.address.slice(prefix.length) : v.address;
  }

  function whereLines(session) {
    const venueName = ((session && session.venue) || '').trim();
    const v = resolveVenue(venueName);
    if (!v) {
      return [venueName || 'Venue TBA', 'The Venetian Expo · 201 Sands Ave, Las Vegas, NV 89169'];
    }
    const lines = [];
    const room = v.room || venueName || 'Venue TBA';
    const area = areaFor(v, room);
    lines.push(area ? `${room} · ${area}` : room);
    const building = v.offsite ? `${v.building} (off-site)` : [v.building, shortLevel(v.level)].filter(Boolean).join(', ');
    lines.push([building, streetOf(v)].filter(Boolean).join(' · '));
    if (v.note) lines.push(v.note);
    if (v.mapUrl) {
      const isDirections = /google\.|goo\.gl/i.test(v.mapUrl);
      lines.push(`${isDirections ? 'Directions' : 'Floor map'}: ${v.mapUrl}`);
    }
    return lines;
  }

  function shortLevel(level) {
    const m = /^(Level\s+\S+)/i.exec(level || '');
    return m ? m[1] : (level || '');
  }

  const ROLE_ORDER = ['keynote', 'speaker', 'moderator'];
  const ROLE_PLURAL = { keynote: 'KEYNOTES', speaker: 'SPEAKERS', moderator: 'MODERATORS' };

  function speakerSections(speakers) {
    const groups = [];
    const byKey = {};
    (speakers || []).forEach((sp) => {
      if (!sp || !sp.name) return;
      const role = String(sp.type || '').trim() || 'Speaker';
      const key = role.toLowerCase();
      if (!byKey[key]) {
        byKey[key] = { key, role, people: [] };
        groups.push(byKey[key]);
      }
      // " · " (not ",") between title and company: 153 of 706 job titles contain commas ("SVP, Head of ...").
      const detail = [sp.jobTitle, sp.company].map((x) => String(x || '').trim()).filter(Boolean).join(' · ');
      byKey[key].people.push(`• ${sp.name}${detail ? ` — ${detail}` : ''}`);
    });
    const rank = (g) => {
      const i = ROLE_ORDER.indexOf(g.key);
      return i === -1 ? ROLE_ORDER.length : i;
    };
    return groups
      .map((g, i) => ({ g, i }))
      .sort((a, b) => (rank(a.g) - rank(b.g)) || (a.i - b.i))
      .map(({ g }) => {
        const many = g.people.length > 1;
        const label = ROLE_PLURAL[g.key]
          ? (many ? ROLE_PLURAL[g.key] : g.key.toUpperCase())
          : g.role.toUpperCase();
        return [label].concat(g.people);
      });
  }

  function aboutText(html) {
    return Core.htmlToText(html)
      .split('\n')
      .map((line) => line.replace(/^- /, '• ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // Plain-text DESCRIPTION, designed for Google Calendar's event view (see header notes).
  function describe(session) {
    if (!session) return '';
    const blocks = [];

    blocks.push(['WHERE'].concat(whereLines(session)).join('\n'));
    blocks.push(['WHEN', whenText(session)].join('\n'));
    const themes = (session.themes || []).filter(Boolean);
    // One line: "Panel Discussion · Brave New World: Setting Guardrails" (a second line read like a subtitle).
    const format = [session.eventType || ''].concat(themes).filter(Boolean).join(' · ');
    if (format) blocks.push(['FORMAT', format].join('\n'));

    const body = [];
    const about = aboutText(session.description);
    if (about) body.push(`ABOUT\n${about}`);
    speakerSections(session.speakers).forEach((section) => body.push(section.join('\n')));
    const tags = (session.tags || []).filter(Boolean);
    if (tags.length) body.push(['TOPICS', tags.join(' · ')].join('\n'));

    // The rule separates the at-a-glance callout from the details; skipped when there are no details.
    if (body.length) blocks.push(RULE, ...body);
    blocks.push(`Saved with ${CONF.appName} (unofficial) · ${CONF.appUrl}`);
    return blocks.join('\n\n');
  }

  function isExportable(session) {
    if (!session) return false;
    const t = timing(session);
    return !!formatLocalDateTime(t.dateIso, t.start);
  }

  function buildEvent(session, stamp) {
    const t = timing(session);
    const start = formatLocalDateTime(t.dateIso, t.start);
    if (!start) return null;
    const end = formatLocalDateTime(t.endDateIso, t.end) || start;

    const v = resolveVenue(session.venue);
    const categories = [session.eventType].concat(session.themes || [])
      .filter(Boolean)
      .map(escapeText)
      .join(',');
    const lines = [
      'BEGIN:VEVENT',
      `UID:${session.eventId}@${UID_DOMAIN}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;TZID=${TZID}:${start}`,
      `DTEND;TZID=${TZID}:${end}`,
      `SUMMARY:${escapeText(session.title)}`,
      `LOCATION:${escapeText(locationFor(session))}`,
      `DESCRIPTION:${escapeText(describe(session))}`
    ];
    if (v && v.mapUrl) lines.push(`URL:${v.mapUrl}`);
    if (categories) lines.push(`CATEGORIES:${categories}`);
    lines.push('STATUS:TENTATIVE');
    lines.push('TRANSP:TRANSPARENT');
    lines.push('X-MICROSOFT-CDO-BUSYSTATUS:FREE');
    lines.push('END:VEVENT');
    return lines;
  }

  // opts: { calName?: string, dtstamp?: Date, refreshHours?: number }
  // No VALARM on purpose (product requirement: no reminders).
  function buildIcs(sessions, opts) {
    const options = opts || {};
    const calName = options.calName || CALENDAR_NAME;
    const stamp = formatUtcStamp(options.dtstamp instanceof Date && !isNaN(options.dtstamp) ? options.dtstamp : new Date());

    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      `PRODID:${PRODID}`,
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      `X-WR-CALNAME:${escapeText(calName)}`,
      `NAME:${escapeText(calName)}`,
      `X-WR-CALDESC:${escapeText(CALENDAR_DESC)}`,
      `X-WR-TIMEZONE:${TZID}`
    ];
    const hours = Number(options.refreshHours);
    if (Number.isFinite(hours) && hours > 0) {
      const h = Math.max(1, Math.round(hours));
      lines.push(`REFRESH-INTERVAL;VALUE=DURATION:PT${h}H`);
      lines.push(`X-PUBLISHED-TTL:PT${h}H`);
    }
    lines.push(...VTIMEZONE);

    const seen = new Set();
    (sessions || []).filter(Boolean).slice().sort(Core.compareSessions).forEach((session) => {
      if (seen.has(session.eventId)) return;
      const ev = buildEvent(session, stamp);
      if (ev) {
        seen.add(session.eventId);
        lines.push(...ev);
      }
    });

    lines.push('END:VCALENDAR');
    return lines.map(foldLine).join('\r\n') + '\r\n';
  }

  // ---------- ID encoding ----------
  // Sorted unique positive integers -> first id in base36, then base36 deltas, joined by '.'.
  // e.g. [75828, 76465, 77140] -> "1mic.hp.ir". All 311 sessions encode to ~656 chars.

  function cleanIds(ids) {
    const set = new Set();
    (Array.isArray(ids) ? ids : []).forEach((id) => {
      const n = typeof id === 'string' && /^\s*\d+\s*$/.test(id) ? Number(id) : (typeof id === 'number' ? id : NaN);
      if (Number.isSafeInteger(n) && n > 0) set.add(n);
    });
    return Array.from(set).sort((a, b) => a - b).slice(0, MAX_IDS);
  }

  function encodeIds(ids) {
    const sorted = cleanIds(ids);
    let prev = 0;
    return sorted.map((n) => {
      const part = (n - prev).toString(36);
      prev = n;
      return part;
    }).join('.');
  }

  // Accepts the encodeIds() string, optionally with a trailing ".ics" (feed path form). [] on any garbage.
  function decodeIds(str) {
    if (typeof str !== 'string') return [];
    let value = str.trim();
    if (/\.ics$/i.test(value)) value = value.slice(0, -4);
    // One ".ics" suffix only: "1n01.ics.ics" must not decode "ics" as a base36 delta.
    if (!value || value.length > 4000 || /\.ics$/i.test(value)) return [];
    const parts = value.split('.');
    if (parts.length > MAX_IDS) return [];
    const out = [];
    let acc = 0;
    for (const part of parts) {
      if (!/^[0-9a-z]{1,8}$/.test(part)) return [];
      const delta = parseInt(part, 36);
      if (!Number.isSafeInteger(delta) || delta <= 0) return [];
      acc += delta;
      if (!Number.isSafeInteger(acc)) return [];
      out.push(acc);
    }
    return cleanIds(out);
  }

  // ---------- Links ----------

  function feedBase(origin) {
    const value = String(origin || '');
    return /^https?:\/\/[^/]+/i.test(value) ? value.replace(/\/+$/, '') : CONF.appUrl;
  }

  // https://m2020.pages.dev/api/calendar/1mic.hp.ir.ics ('' when no valid ids)
  function feedUrl(origin, ids) {
    const encoded = encodeIds(ids);
    if (!encoded) return '';
    return `${feedBase(origin)}${FEED_PATH}/${encoded}.ics`;
  }

  function webcalUrl(url) {
    return String(url || '').replace(/^https?:\/\//i, 'webcal://');
  }

  function googleSubscribeUrl(url) {
    return `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcalUrl(url))}`;
  }

  function outlookSubscribeUrl(url, name, opts) {
    const host = opts && opts.work ? 'https://outlook.office.com' : 'https://outlook.live.com';
    const https = String(url || '').replace(/^webcal:\/\//i, 'https://');
    const calName = name || CALENDAR_NAME;
    return `${host}/calendar/0/addfromweb?url=${encodeURIComponent(https)}&name=${encodeURIComponent(calName)}`;
  }

  return {
    TZID,
    FEED_PATH,
    MAX_IDS,
    CALENDAR_NAME,
    UID_DOMAIN,
    buildIcs,
    describe,
    locationFor,
    whenText,
    timing,
    isExportable,
    escapeText,
    foldLine,
    encodeIds,
    decodeIds,
    feedUrl,
    googleSubscribeUrl,
    outlookSubscribeUrl,
    webcalUrl
  };
}));
