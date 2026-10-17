/*
 * core.js - shared data layer for M2020 Event Swiper (Money20/20 USA 2026).
 *
 * UMD: module.exports in Node / Pages Functions (bundled by esbuild), window.M2020Core in the browser.
 * Classic script, no dependencies, no DOM access, safe under file:// and in Cloudflare Workers.
 *
 * Session shape returned by mapScheduleEvent():
 *   {
 *     eventId: number,        // upstream eventId (unique, stable)
 *     title: string,
 *     description: string,    // raw upstream HTML (multiple <p>); use htmlToText() for plain text
 *     date: string,           // "Sunday 18 October"
 *     dateIso: string,        // "2026-10-18" ('' if unparseable)
 *     rawDateIso: string,     // upstream value, e.g. "20261018"
 *     startTime: string,      // "HHmm", local America/Los_Angeles ('' if unparseable)
 *     endTime: string,        // "HHmm", local America/Los_Angeles ('' if unparseable); < startTime means past
 *                             // midnight (the upstream 12-hour end typo is corrected, see effectiveEndTime)
 *     venue: string,          // raw upstream venue string ('Venue TBA' when missing)
 *     eventType: string,      // e.g. "Panel Discussion" ('' when missing)
 *     track: '',              // legacy, always ''
 *     themes: string[],       // eventThemes[].eventTheme
 *     topics: string[],       // same values as themes (legacy compat)
 *     tags: string[],         // eventTags[].eventTag (topic tags)
 *     speakers: [{ name, jobTitle, company, image, type }],
 *     titleSlug: string
 *   }
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  } else {
    root.M2020Core = api;
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TIMEZONE = 'America/Los_Angeles';

  const CONFERENCE = Object.freeze({
    name: 'Money20/20 USA 2026',
    shortName: 'Money20/20',
    calendarName: 'Money20/20',
    startDate: '2026-10-18',
    endDate: '2026-10-21',
    days: Object.freeze(['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21']),
    city: 'Las Vegas, NV',
    venueName: 'The Venetian Expo',
    timezone: TIMEZONE,
    utcOffset: '-07:00',
    tzAbbr: 'PDT',
    websiteUrl: 'https://us.money2020.com',
    agendaUrl: 'https://us.money2020.com/agenda',
    appUrl: 'https://m2020.pages.dev',
    appName: 'M2020 Events'
  });

  const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
    'September', 'October', 'November', 'December'];
  const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // "20261018" | "2026-10-18" | "2026-10-18T00:00:00" | "10/18/2026" -> "2026-10-18" ('' if unknown)
  function normalizeDateIso(value) {
    if (value === null || value === undefined) return '';
    const raw = String(value).trim();
    if (!raw) return '';

    const datePart = raw.includes('T') ? raw.split('T')[0] : raw;

    if (/^\d{8}$/.test(datePart)) {
      return `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)}`;
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
      return datePart;
    }

    if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(datePart)) {
      const [month, day, year] = datePart.split('/');
      return `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }

    return '';
  }

  // "1430" | "930" | "14:30" | "143000" -> "HHmm" ('' if unknown)
  function normalizeTime(value) {
    if (value === null || value === undefined) return '';
    const digits = String(value).replace(/\D/g, '');
    if (digits.length === 4) return digits;
    if (digits.length === 3) return `0${digits}`;
    if (digits.length === 6) return digits.slice(0, 4);
    return '';
  }

  function parseIso(dateIso) {
    const [y, m, d] = String(dateIso || '').split('-').map((s) => parseInt(s, 10));
    if (!y || !m || !d) return null;
    return new Date(Date.UTC(y, m - 1, d));
  }

  // "2026-10-18" -> "Sunday 18 October" ('' if invalid)
  function formatDateLong(dateIso) {
    const dt = parseIso(dateIso);
    if (!dt) return '';
    return `${WEEKDAYS_LONG[dt.getUTCDay()]} ${dt.getUTCDate()} ${MONTHS_LONG[dt.getUTCMonth()]}`;
  }

  // "2026-10-18" -> "Sun, Oct 18" ('' if invalid)
  function formatDateShort(dateIso) {
    const dt = parseIso(dateIso);
    if (!dt) return '';
    return `${WEEKDAYS_SHORT[dt.getUTCDay()]}, ${MONTHS_SHORT[dt.getUTCMonth()]} ${dt.getUTCDate()}`;
  }

  // "2026-10-18" -> "Sun" ('' if invalid)
  function weekdayShort(dateIso) {
    const dt = parseIso(dateIso);
    return dt ? WEEKDAYS_SHORT[dt.getUTCDay()] : '';
  }

  // ("2026-10-31", 1) -> "2026-11-01"
  function addDaysIso(dateStr, days) {
    const dt = parseIso(dateStr);
    if (!dt) return dateStr;
    dt.setUTCDate(dt.getUTCDate() + days);
    const yyyy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(dt.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  // "1430" -> "2:30PM" (input returned unchanged when not HHmm)
  function formatTime(time) {
    if (!time || time.length !== 4) return time || '';
    const hours = parseInt(time.slice(0, 2), 10);
    const minutes = time.slice(2);
    const period = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 === 0 ? 12 : hours % 12;
    return `${displayHours}:${minutes}${period}`;
  }

  // Session -> "Oct 18 @ 4:00PM - 5:00PM" (legacy card format)
  function formatSessionWhen(session) {
    const dt = parseIso(session && session.dateIso);
    const datePart = dt ? `${MONTHS_SHORT[dt.getUTCMonth()]} ${dt.getUTCDate()}` : 'Date TBA';
    return `${datePart} @ ${formatTime(session && session.startTime)} - ${formatTime(session && session.endTime)}`;
  }

  function hhmmToMinutes(hhmm) {
    return parseInt(hhmm.slice(0, 2), 10) * 60 + parseInt(hhmm.slice(2), 10);
  }

  // End time with one upstream data fix applied. An end before the start normally means "past midnight".
  // Exception: the feed sometimes writes a just-after-noon end in 12-hour form (e.g. 1230 -> 0040 for a
  // 10-minute pitch). When the end is before noon and adding 12 h lands at most 4 h after the start, the
  // 12-hour reading is used instead of a 12-hour session. Returns 'HHmm' or '' (same rule as calendar.js).
  function effectiveEndTime(startTime, endTime) {
    const s = normalizeTime(startTime);
    const e = normalizeTime(endTime);
    if (!s || !e) return e;
    const sm = hhmmToMinutes(s);
    const em = hhmmToMinutes(e);
    if (em < sm && em < 720 && em + 720 > sm && em + 720 - sm <= 240) {
      const fixed = em + 720;
      return `${String(Math.floor(fixed / 60)).padStart(2, '0')}${String(fixed % 60).padStart(2, '0')}`;
    }
    return e;
  }

  // Duration in minutes (handles end past midnight and the 12-hour end typo); 0 when unknown.
  function durationMinutes(session) {
    const s = normalizeTime(session && session.startTime);
    const e = effectiveEndTime(s, session && session.endTime);
    if (!s || !e) return 0;
    const sm = hhmmToMinutes(s);
    let em = hhmmToMinutes(e);
    if (em < sm) em += 24 * 60;
    return em - sm;
  }

  const NAMED_ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
    lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', bull: '•',
    trade: '™', reg: '®', copy: '©', eacute: 'é'
  };

  function decodeEntities(text) {
    return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
      if (code[0] === '#') {
        const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : match;
      }
      const named = NAMED_ENTITIES[code.toLowerCase()];
      return named === undefined ? match : named;
    });
  }

  // HTML -> plain text without the DOM. Paragraphs/blocks become blank-line separated,
  // <br> becomes a newline, list items become "- item", entities decoded, whitespace tidied.
  function htmlToText(html) {
    if (!html) return '';
    let text = String(html)
      .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\s*li(\s[^>]*)?>/gi, '\n- ')
      .replace(/<\s*\/\s*li\s*>/gi, '')
      .replace(/<\s*\/\s*(p|div|h[1-6]|ul|ol|blockquote|section|article|tr)\s*>/gi, '\n\n')
      .replace(/<\s*(p|div|h[1-6]|ul|ol|blockquote|section|article|tr)(\s[^>]*)?>/gi, '\n\n')
      .replace(/<[^>]*>/g, '');
    text = decodeEntities(text)
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t ]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return text;
  }

  // Escape for safe innerHTML / attribute insertion.
  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function uniqueStrings(list) {
    const seen = new Set();
    const out = [];
    (list || []).forEach((v) => {
      const s = typeof v === 'string' ? v.trim() : '';
      if (s && !seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    });
    return out;
  }

  // Raw upstream event -> Session (see header). Returns null when eventId is not a finite number.
  function mapScheduleEvent(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const eventId = Number(raw.eventId);
    if (!Number.isFinite(eventId)) return null;

    const dateIso = normalizeDateIso(raw.dateIso);
    const startTime = normalizeTime(raw.startTime);
    const themes = uniqueStrings((raw.eventThemes || []).map((t) => t && t.eventTheme));
    const tags = uniqueStrings((raw.eventTags || []).map((t) => t && t.eventTag));

    const speakers = (raw.speakerData || []).map((sd) => {
      const sp = (sd && sd.speaker) || {};
      return {
        name: (sp.fullName || '').trim(),
        jobTitle: (sp.jobTitle || '').trim(),
        company: (sp.company || '').trim(),
        image: sp.imageSrc || '',
        type: (sd && sd.speakerType && sd.speakerType.speakerType) || ''
      };
    }).filter((s) => s.name);

    return {
      eventId,
      title: (raw.title || '').trim() || 'Untitled Event',
      description: raw.description || '',
      date: formatDateLong(dateIso) || 'Date TBA',
      dateIso,
      rawDateIso: raw.dateIso === null || raw.dateIso === undefined ? '' : String(raw.dateIso),
      startTime,
      endTime: effectiveEndTime(startTime, raw.endTime),
      venue: ((raw.eventLocation && raw.eventLocation.venue) || '').trim() || 'Venue TBA',
      eventType: ((raw.eventType && raw.eventType.eventType) || '').trim(),
      track: '',
      themes,
      topics: themes.slice(),
      tags,
      speakers,
      titleSlug: raw.titleSlug || ''
    };
  }

  // Sort comparator: dateIso, then startTime, then endTime, then title, then eventId.
  function compareSessions(a, b) {
    const ad = a.dateIso || '9999';
    const bd = b.dateIso || '9999';
    if (ad !== bd) return ad < bd ? -1 : 1;
    const as = a.startTime || '9999';
    const bs = b.startTime || '9999';
    if (as !== bs) return as < bs ? -1 : 1;
    const ae = a.endTime || '9999';
    const be = b.endTime || '9999';
    if (ae !== be) return ae < be ? -1 : 1;
    const t = String(a.title).localeCompare(String(b.title));
    if (t !== 0) return t;
    return a.eventId - b.eventId;
  }

  // Upstream payload {events:[...]} -> sorted, de-duplicated Session[]. Throws on invalid payload.
  function mapSchedule(payload) {
    if (!payload || !Array.isArray(payload.events)) {
      throw new Error('Invalid schedule payload received.');
    }
    const seen = new Set();
    const sessions = [];
    payload.events.forEach((raw) => {
      const s = mapScheduleEvent(raw);
      if (s && !seen.has(s.eventId)) {
        seen.add(s.eventId);
        sessions.push(s);
      }
    });
    sessions.sort(compareSessions);
    return sessions;
  }

  // True when value looks like a current-shape Session (used to validate caches).
  function isSession(value) {
    return !!value && typeof value === 'object' && typeof value.eventId === 'number' &&
      typeof value.title === 'string' && Array.isArray(value.tags) && Array.isArray(value.themes) &&
      Array.isArray(value.speakers);
  }

  // Lower-cased haystack for text search over title, speakers (name/company/jobTitle), type, venue.
  // Short session-type names (card eyebrow in app.js, active-filter chips in filters.js).
  const FORMAT_SHORT = Object.freeze({
    'Panel Discussion': 'Panel',
    'Fireside Chat': 'Fireside',
    'Startup Pitch': 'Startup pitch',
    'Product Pitch': 'Product pitch',
    'Content / Awards': 'Awards',
    'Welcome Address': 'Welcome address',
    'Meet & Greet': 'Meet & greet'
  });

  function formatShort(eventType) {
    if (!eventType) return '';
    return Object.prototype.hasOwnProperty.call(FORMAT_SHORT, eventType) ? FORMAT_SHORT[eventType] : eventType;
  }

  function searchText(session) {
    if (!session) return '';
    const parts = [session.title, session.eventType, session.venue];
    (session.speakers || []).forEach((sp) => {
      parts.push(sp.name, sp.company, sp.jobTitle);
    });
    return parts.filter(Boolean).join(' • ').toLowerCase();
  }

  return {
    TIMEZONE,
    CONFERENCE,
    normalizeDateIso,
    normalizeTime,
    formatDateLong,
    formatDateShort,
    weekdayShort,
    addDaysIso,
    formatTime,
    formatSessionWhen,
    effectiveEndTime,
    durationMinutes,
    decodeEntities,
    htmlToText,
    escapeHtml,
    mapScheduleEvent,
    mapSchedule,
    compareSessions,
    isSession,
    searchText,
    formatShort
  };
}));
