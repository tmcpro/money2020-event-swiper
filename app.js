/*
 * app.js - M2020 Events shell: data loading, deck + swipe physics, keyboard, saved list, menu/about,
 * deck states, first-run hint, modal/focus management for every .overlay.
 * Depends on (loaded first, see index.html): core.js (M2020Core), venues.js (M2020Venues), calendar.js,
 * toast.js (Toast), filters.js (Filters), export-ui.js (ExportUI). See CONTRACTS.md.
 */

const Core = window.M2020Core;
const CONF = Core.CONFERENCE;

// --- Storage keys ---
const STORAGE_KEY = 'event-swiper-selected';            // Session[] saved (swiped right)
const PROCESSED_IDS_KEY = 'event-swiper-processed-ids';  // string[] eventIds swiped (left or right)
const SESSIONS_CACHE_KEY = 'event-swiper-sessions-v2';   // { v, fetchedAt, source, sessions: Session[] }
const HINT_KEY = 'event-swiper-hint-dismissed';          // '1' once the first-run hint was dismissed
const SESSIONS_CACHE_VERSION = 2;
// Keys from the previous deploy (old mapped shape, no tags). Removed on startup so they are refetched.
const LEGACY_KEYS = ['event-swiper-events-cache', 'event-swiper-data-timestamp', 'event-swiper-current-index'];

// Money20/20 USA 2026 agenda. The upstream API (us.money2020.com/api/schedule) sends no CORS
// headers, so the deployed site proxies it via functions/api/schedule.js. When that proxy is
// unavailable (e.g. opening index.html directly), lazily load the bundled events-data.js snapshot.
const SCHEDULE_API = '/api/schedule';
const SNAPSHOT_SRC = 'events-data.js';
const FETCH_TIMEOUT_MS = 10000;
const LIVE_CACHE_MAX_AGE_MS = 4 * 24 * 60 * 60 * 1000;   // live data: refetch after 4 days
const SNAPSHOT_CACHE_MAX_AGE_MS = 60 * 60 * 1000;        // snapshot data: retry live after 1 hour
const REVALIDATE_AFTER_MS = 30 * 60 * 1000;              // cached data older than this is refetched in the background

// --- Swipe physics ---
const SWIPE_MIN_PX = 96;          // threshold = max(96px, 28% of card width)
const SWIPE_RATIO = 0.28;
const FLING_VELOCITY = 0.6;       // px/ms
const FLING_MIN_PX = 24;
const AXIS_LOCK_PX = 10;
const CLICK_SLOP_PX = 6;
const EXIT_MS = 320;
const EXIT_REDUCED_MS = 160;
const CARD_MS = 280;
const OVERLAY_HIDE_MS = 500;      // overlay convention (CONTRACTS.md)
const TOPIC_TAG_LIMIT = 4;
const THIN = ' ';

// Overlay id -> header button that opened it (focus fallback when the opener is gone).
const OVERLAY_OPENERS = {
  'filters-overlay': 'open-filters',
  'selected-overlay': 'view-selected',
  'export-overlay': 'view-selected',
  'about-overlay': 'more-btn',
  'more-overlay': 'more-btn'
};

const $ = (id) => document.getElementById(id);
const esc = Core.escapeHtml;

const mql = (query) => (window.matchMedia ? window.matchMedia(query) : { matches: false });
const reducedMotionQuery = mql('(prefers-reduced-motion: reduce)');
const sheetLayoutQuery = mql('(max-width: 899px)');

// --- DOM ---
const appEl = $('app');
const container = $('card-container');
const deckStateEl = $('no-more');
const statusRow = $('status-row');
const statusLoadingEl = statusRow.querySelector('.status-loading');
const remainingCountEl = $('remaining-count');
const remainingLabelEl = $('remaining-label');
const statusSavedEl = $('status-saved');
const statusSavedCountEl = $('status-saved-count');
const progressEl = $('progress');
const progressFill = $('progress-fill');
const selectedCountEl = $('selected-count');
const viewSelectedBtn = $('view-selected');
const filtersBtn = $('open-filters');
const moreBtn = $('more-btn');
const actionBar = $('action-bar');
const btnDislike = $('btn-dislike');
const btnLike = $('btn-like');
const undoBtn = $('undo-btn');
const hintEl = $('hint-strip');
const srStatus = $('sr-status');
const savedOverlay = $('selected-overlay');
const savedBody = $('overlay-body');
const savedTitle = $('saved-title');
const savedFooter = $('saved-footer');
const savedExportLabel = $('saved-export-label');
const aboutOverlay = $('about-overlay');
const moreOverlay = $('more-overlay');
const APP_OVERLAYS = [moreOverlay, aboutOverlay, savedOverlay];

// --- State ---
let allSessions = [];      // every Session, sorted (Core.compareSessions)
let deck = [];             // unprocessed sessions passing Filters.apply; deck[0] is the visible card
let matchCount = 0;        // sessions passing the filters (processed or not)
let dataSource = '';       // 'live' | 'snapshot'
let loadError = false;     // nothing could be loaded at all
let isLoading = false;
let renderedSession = null; // Session object the top card in the DOM was built from
let dataFetchedAt = 0;      // when the data on screen was fetched (ms)
let revalidating = false;   // silent background refetch in flight

let selectedEvents = loadStoredSelections();
let processedIds = loadProcessedIds();

let lastAction = null;          // { type: 'like'|'skip', dir: 'left'|'right', session } for undo
let actionInProgress = false;   // card exit animation running
let pendingRebuild = false;     // filters/data changed during an exit animation
let deckStateKey = '';
let lastSavedCount = selectedEvents.length;
let hintVisible = false;
let nudgeDone = false;
let gesture = null;             // active card drag
let suppressClickUntil = 0;
let lastAppFocus = null;        // last focused element inside #app (focus returns here when overlays close)
let refocusAfterLoad = false;   // the focused "Try again" button vanished while loading

// --- Small helpers ---
function idOf(session) {
  return String(session.eventId);
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function prefersReducedMotion() {
  return !!reducedMotionQuery.matches;
}

function icon(name, cls) {
  return `<svg class="icon${cls ? ` ${cls}` : ''}" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`;
}

function readFlag(key) {
  try {
    return localStorage.getItem(key) === '1';
  } catch (error) {
    return false;
  }
}

function writeFlag(key) {
  try {
    localStorage.setItem(key, '1');
  } catch (error) {
    // Non-fatal
  }
}

let announceTimer = 0;
function announce(message) {
  if (!srStatus) return;
  clearTimeout(announceTimer);
  srStatus.textContent = '';
  announceTimer = setTimeout(() => {
    srStatus.textContent = message;
  }, 80);
}

function pulse(el) {
  if (!el || prefersReducedMotion()) return;
  el.classList.remove('is-pulsing');
  void el.offsetWidth;
  el.classList.add('is-pulsing');
}

[btnLike, btnDislike, undoBtn, selectedCountEl].forEach((el) => {
  if (el) el.addEventListener('animationend', () => el.classList.remove('is-pulsing'));
});

// --- Module accessors (degrade gracefully if a module failed to load) ---
function toast(message, opts) {
  if (window.Toast && typeof window.Toast.show === 'function') {
    try {
      return window.Toast.show(message, opts || {});
    } catch (error) {
      console.warn('Toast failed:', error);
    }
  }
  announce(message);
  return { dismiss() {} };
}

function confirmAction(opts) {
  if (window.Toast && typeof window.Toast.confirm === 'function') {
    return window.Toast.confirm(opts);
  }
  // Fallback only when toast.js failed to load.
  return Promise.resolve(window.confirm([opts.title, opts.message].filter(Boolean).join('\n\n')));
}

function applyFilters(sessions) {
  if (window.Filters && typeof window.Filters.apply === 'function') {
    try {
      return window.Filters.apply(sessions);
    } catch (error) {
      console.warn('Filters.apply failed; showing all sessions.', error);
    }
  }
  return sessions.slice();
}

function filtersActive() {
  try {
    return !!(window.Filters && typeof window.Filters.isActive === 'function' && window.Filters.isActive());
  } catch (error) {
    return false;
  }
}

function activeFilterCount() {
  if (!window.Filters) return 0;
  if (typeof window.Filters.activeCount === 'function') {
    try {
      return window.Filters.activeCount();
    } catch (error) {
      return 0;
    }
  }
  if (typeof window.Filters.getState !== 'function') return 0;
  try {
    const state = window.Filters.getState() || {};
    let n = state.q && String(state.q).trim() ? 1 : 0;
    ['days', 'venues', 'types', 'themes', 'tags'].forEach((key) => {
      if (Array.isArray(state[key]) && state[key].length) n += 1;
    });
    return n;
  } catch (error) {
    return 0;
  }
}

// --- Persistence ---
function removeLegacyKeys() {
  LEGACY_KEYS.forEach((key) => {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      // Non-fatal
    }
  });
}

function loadStoredSelections() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    const parsed = stored ? JSON.parse(stored) : [];
    return Array.isArray(parsed) ? parsed.filter((s) => s && s.eventId !== undefined && s.eventId !== null) : [];
  } catch (error) {
    console.warn('Failed to parse stored selections, clearing them.', error);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (e) {
      // Non-fatal
    }
    return [];
  }
}

function saveSelections() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(selectedEvents));
  } catch (error) {
    console.warn('Unable to persist selections.', error);
  }
}

function loadProcessedIds() {
  try {
    const raw = localStorage.getItem(PROCESSED_IDS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set((Array.isArray(arr) ? arr : []).map(String));
  } catch (error) {
    console.warn('Failed to load processed IDs.', error);
    return new Set();
  }
}

function saveProcessedIds() {
  try {
    localStorage.setItem(PROCESSED_IDS_KEY, JSON.stringify(Array.from(processedIds)));
  } catch (error) {
    console.warn('Unable to save processed IDs.', error);
  }
}

function loadSessionsCache() {
  try {
    const raw = localStorage.getItem(SESSIONS_CACHE_KEY);
    if (!raw) return null;
    const cache = JSON.parse(raw);
    if (!cache || cache.v !== SESSIONS_CACHE_VERSION || !Array.isArray(cache.sessions)) return null;
    if (!cache.sessions.length) return null; // an empty schedule is never worth keeping
    if (!cache.sessions.every(Core.isSession)) return null;
    return cache;
  } catch (error) {
    console.warn('Failed to load cached sessions:', error);
    return null;
  }
}

function saveSessionsCache(sessions, source) {
  if (!sessions || !sessions.length) return;
  try {
    localStorage.setItem(SESSIONS_CACHE_KEY, JSON.stringify({
      v: SESSIONS_CACHE_VERSION,
      fetchedAt: Date.now(),
      source,
      sessions
    }));
  } catch (error) {
    console.warn('Unable to cache sessions:', error);
  }
}

function isCacheFresh(cache) {
  if (!cache || typeof cache.fetchedAt !== 'number') return false;
  const age = Date.now() - cache.fetchedAt;
  const maxAge = cache.source === 'live' ? LIVE_CACHE_MAX_AGE_MS : SNAPSHOT_CACHE_MAX_AGE_MS;
  return age >= 0 && age < maxAge;
}

// --- Data fetching ---
async function fetchJson(url) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS) : null;
  try {
    const response = await fetch(url, controller ? { signal: controller.signal } : undefined);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return await response.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

let snapshotPromise = null;

function loadSnapshot() {
  if (window.M2020_SCHEDULE_SNAPSHOT) return Promise.resolve(window.M2020_SCHEDULE_SNAPSHOT);
  if (snapshotPromise) return snapshotPromise;
  snapshotPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SNAPSHOT_SRC;
    script.async = true;
    script.addEventListener('load', () => {
      if (window.M2020_SCHEDULE_SNAPSHOT) {
        resolve(window.M2020_SCHEDULE_SNAPSHOT);
      } else {
        reject(new Error('Snapshot loaded but contained no schedule.'));
      }
    });
    script.addEventListener('error', () => reject(new Error('Unable to load the bundled schedule snapshot.')));
    document.head.appendChild(script);
  }).catch((error) => {
    snapshotPromise = null;
    throw error;
  });
  return snapshotPromise;
}

// -> { sessions: Session[], source: 'live'|'snapshot' }
// An empty schedule counts as a failure (the upstream API answering 200 {events: []} must not wipe the deck).
async function fetchLiveSessions() {
  const sessions = Core.mapSchedule(await fetchJson(SCHEDULE_API));
  if (!sessions.length) throw new Error('Live schedule is empty.');
  return sessions;
}

async function fetchSessions() {
  try {
    return { sessions: await fetchLiveSessions(), source: 'live' };
  } catch (liveError) {
    console.warn('Live schedule unavailable, using bundled snapshot.', liveError.message || liveError);
    const sessions = Core.mapSchedule(await loadSnapshot());
    if (!sessions.length) throw new Error('Bundled schedule is empty.');
    return { sessions, source: 'snapshot' };
  }
}

function canReachApi() {
  return location.protocol === 'http:' || location.protocol === 'https:';
}

// Keep the instant cached render but refresh the data quietly when it is getting old (the conference
// runs for days and rooms/times change). No skeleton, no toast; the visible card only re-renders if
// its own details changed.
async function revalidateInBackground() {
  if (revalidating || isLoading || !canReachApi()) return;
  if (dataFetchedAt && Date.now() - dataFetchedAt < REVALIDATE_AFTER_MS) return;
  revalidating = true;
  dataFetchedAt = Date.now(); // throttle: at most one attempt per REVALIDATE_AFTER_MS, even on failure
  try {
    const sessions = await fetchLiveSessions();
    if (isLoading) return; // a foreground load started meanwhile and wins
    saveSessionsCache(sessions, 'live');
    setSessions(sessions, 'live', false);
  } catch (error) {
    console.warn('Background schedule refresh failed.', error.message || error);
  } finally {
    revalidating = false;
  }
}

// --- Deck management ---

// A saved session from this year's conference (not, say, a pick left over from the 2025 edition).
function isThisConference(saved) {
  const day = Core.normalizeDateIso(saved && (saved.dateIso || saved.rawDateIso));
  return CONF.days.indexOf(day) !== -1;
}

// Re-hydrate saved selections from fresh sessions (same eventIds). Saved sessions missing from the
// fresh data are dropped when the data is live; with the snapshot (which may simply be older) they are
// kept, but only when they belong to this year's conference days.
function rehydrateSelections() {
  if (!allSessions.length) return; // nothing loaded: leave the saved list untouched
  const byId = new Map(allSessions.map((s) => [idOf(s), s]));
  const next = [];
  const seen = new Set();
  selectedEvents.forEach((saved) => {
    const key = String(saved.eventId);
    if (seen.has(key)) return;
    const fresh = byId.get(key);
    if (fresh) {
      next.push(fresh);
      seen.add(key);
    } else if (dataSource !== 'live' && isThisConference(saved)) {
      next.push(saved);
      seen.add(key);
    }
  });
  selectedEvents = next;
  saveSelections();
}

function rebuildDeck() {
  const matching = applyFilters(allSessions);
  matchCount = matching.length;
  deck = matching.filter((s) => !processedIds.has(idOf(s)));
}

function setSessions(sessions, source, force) {
  allSessions = sessions;
  dataSource = source;
  rehydrateSelections();
  if (window.Filters && typeof window.Filters.setSessions === 'function') {
    try {
      window.Filters.setSessions(allSessions);
    } catch (error) {
      console.warn('Filters.setSessions failed.', error);
    }
  }
  if (actionInProgress) {
    pendingRebuild = true;
    return;
  }
  rebuildDeck();
  renderDeck(!!force);
}

function renderDeck(force) {
  const active = document.activeElement;
  const focusOnActions = active === btnLike || active === btnDislike;
  updateCounter();
  showCurrentCard(force);
  updateButtonStates();
  updateUndoButton();
  renderDeckState(focusOnActions);
  if (refocusAfterLoad && !isLoading) {
    // "Try again" was focused when it disappeared: continue from the deck's primary action.
    refocusAfterLoad = false;
    const target = isFocusable(btnLike) ? btnLike : deckStateEl.querySelector('button');
    if (target) target.focus({ preventScroll: true });
  }
  refreshFilterCounts();
}

// filters.js shows "N match" (unprocessed matches) in the strip; tell it the deck moved.
function refreshFilterCounts() {
  if (!window.Filters || typeof window.Filters.refresh !== 'function' || !filtersActive()) return;
  try {
    window.Filters.refresh();
  } catch (error) {
    console.warn('Filters.refresh failed.', error);
  }
}

let filterAnnounceTimer = 0;
function handleFiltersChanged() {
  if (actionInProgress) {
    pendingRebuild = true;
    return;
  }
  rebuildDeck();
  renderDeck(false);
  clearTimeout(filterAnnounceTimer);
  // The open filter sheet announces its own match count; don't say it twice.
  if (window.Filters && typeof window.Filters.isOpen === 'function' && window.Filters.isOpen()) return;
  filterAnnounceTimer = setTimeout(() => {
    const n = deck.length;
    announce(filtersActive() ? `${n} ${n === 1 ? 'session matches' : 'sessions match'}` : `${plural(n, 'session')} left`);
  }, 800);
}

function getSortedSelections() {
  return selectedEvents.slice().sort(Core.compareSessions);
}

function isSaved(key) {
  return selectedEvents.some((s) => idOf(s) === key);
}

// --- Counters, progress, buttons ---
function updateButtonStates() {
  const enabled = deck.length > 0 && !isLoading;
  btnDislike.disabled = !enabled;
  btnLike.disabled = !enabled;
  ['refresh', 'about-refresh'].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = isLoading;
  });
}

function updateUndoButton() {
  const enabled = !!lastAction && !actionInProgress && !isLoading;
  undoBtn.setAttribute('aria-disabled', enabled ? 'false' : 'true');
  undoBtn.setAttribute('aria-label', enabled ? (lastAction.type === 'like' ? 'Undo save' : 'Undo skip') : 'Undo');
}

function updateCounter() {
  const saved = selectedEvents.length;
  const active = filtersActive();

  // Without data the counts are meaningless: show what is going on instead.
  statusRow.classList.toggle('is-loading', !allSessions.length);
  if (statusLoadingEl) statusLoadingEl.textContent = isLoading || !loadError ? 'Loading sessions…' : 'Schedule unavailable';
  statusRow.classList.toggle('has-filters', active);
  remainingCountEl.textContent = String(deck.length);
  remainingLabelEl.textContent = active ? 'match' : 'left';
  statusSavedCountEl.textContent = String(saved);
  statusSavedEl.hidden = active;

  selectedCountEl.textContent = String(saved);
  selectedCountEl.hidden = saved === 0;
  viewSelectedBtn.setAttribute('aria-label', `Saved sessions, ${saved}`);
  if (saved > lastSavedCount) pulse(selectedCountEl);
  lastSavedCount = saved;

  // filters.js owns the badge (.filters-badge); keep the button state in sync either way.
  const count = activeFilterCount();
  // Visual state only: the button opens a dialog, so it is not a toggle (no aria-pressed).
  filtersBtn.dataset.active = active ? 'true' : 'false';
  filtersBtn.setAttribute('aria-label', count ? `Filters, ${count} active` : 'Filters');

  const total = Math.max(matchCount, deck.length);
  const done = Math.max(0, total - deck.length);
  progressFill.style.transform = `scaleX(${total ? done / total : 0})`;
  progressEl.setAttribute('aria-valuemax', String(total));
  progressEl.setAttribute('aria-valuenow', String(done));
  progressEl.setAttribute('aria-valuetext', `${done} of ${total} reviewed`);
}

function setLoading(on) {
  isLoading = on;
  const showSkeleton = on && !allSessions.length;
  container.classList.toggle('loading', showSkeleton);
  container.setAttribute('aria-busy', on ? 'true' : 'false');
  if (showSkeleton) {
    if (deckStateEl.contains(document.activeElement)) refocusAfterLoad = true;
    deckStateKey = '';
    deckStateEl.hidden = true;
    actionBar.classList.remove('is-done');
  }
  updateCounter();
  updateButtonStates();
  updateUndoButton();
}

// --- Loading ---
async function loadEvents(mode = 'initial') {
  if (isLoading) return;
  const cache = loadSessionsCache();
  if (mode === 'initial' && cache && isCacheFresh(cache)) {
    setLoading(false);
    dataFetchedAt = cache.fetchedAt;
    setSessions(cache.sessions, cache.source, true);
    revalidateInBackground();
    return;
  }

  const hadData = allSessions.length > 0;
  loadError = false;
  setLoading(true);

  try {
    const { sessions, source } = await fetchSessions();
    saveSessionsCache(sessions, source);
    dataFetchedAt = Date.now();
    setLoading(false);
    setSessions(sessions, source, !hadData);
    if (source === 'snapshot') {
      toast('Showing a saved copy of the schedule', { type: 'info' });
    } else if (mode !== 'initial') {
      toast('Schedule updated', { type: 'success' });
    }
  } catch (error) {
    console.error('Failed to load sessions:', error);
    setLoading(false);
    if (hadData) {
      renderDeck(false);
      toast('Couldn’t refresh the schedule. Check your connection and try again.', { type: 'error' });
    } else if (cache && cache.sessions.length) {
      dataFetchedAt = cache.fetchedAt;
      setSessions(cache.sessions, cache.source, true);
      toast('Showing a saved copy of the schedule', { type: 'info' });
    } else {
      loadError = true;
      setSessions([], '', true);
      toast('Couldn’t load the schedule. Check your connection and try again.', { type: 'error' });
    }
  }
}

// --- Formatting ---
function clock(hhmm, withPeriod) {
  if (!/^\d{4}$/.test(hhmm || '')) return '';
  const h = parseInt(hhmm.slice(0, 2), 10);
  const m = hhmm.slice(2);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return withPeriod ? `${h12}:${m} ${h >= 12 ? 'PM' : 'AM'}` : `${h12}:${m}`;
}

// "9:00 – 9:25 AM PT" / "11:30 AM – 12:30 PM PT"
function timeRange(session) {
  const start = session.startTime;
  const end = session.endTime;
  if (!clock(start)) return 'Time TBA';
  if (!clock(end) || end === start) return `${clock(start, true)} PT`;
  const samePeriod = end > start && (start >= '1200') === (end >= '1200');
  return `${samePeriod ? clock(start) : clock(start, true)}${THIN}–${THIN}${clock(end, true)} PT`;
}

function durationLabel(session) {
  const minutes = Core.durationMinutes(session);
  if (!minutes) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

// --- Day identity: every conference day has its own colour (SUN / MON / TUE / WED), so the day of a
// session is recognisable at a glance. The key is computed from the date (never hard-coded) and goes on
// data-day; the palette and the rules live in the "Day identity" block of filters.css (tokens: styles.css).
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// "2026-10-18" -> Date at UTC midnight (null when the date is missing or invalid)
function dayDate(dateIso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(Core.normalizeDateIso(dateIso));
  if (!m) return null;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

// "2026-10-18" -> 'sun' ('' when the date is unknown)
function dayKey(dateIso) {
  const dt = dayDate(dateIso);
  return dt ? DAY_KEYS[dt.getUTCDay()] : '';
}

// "Oct 18"
function dayMonthDay(dateIso) {
  const short = Core.formatDateShort(Core.normalizeDateIso(dateIso)); // "Sun, Oct 18"
  return short ? short.replace(/^[^,]*,\s*/, '') : '';
}

// "Sunday, October 18" (what screen readers get instead of the abbreviations)
let dayLongFormat = null;
function dayLongLabel(dateIso) {
  const dt = dayDate(dateIso);
  if (!dt) return '';
  try {
    if (!dayLongFormat) {
      dayLongFormat = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
    }
    return dayLongFormat.format(dt);
  } catch (error) {
    return Core.formatDateLong(Core.normalizeDateIso(dateIso));
  }
}

// ` data-day="sun"` (or '' for an unknown date: the CSS then falls back to neutral colours)
function dayAttr(dateIso) {
  const key = dayKey(dateIso);
  return key ? ` data-day="${key}"` : '';
}

// The day badge: a solid pill in the day's colour, "SUN" big and heavy + "Oct 18" lighter. The text always
// names the day (colour is a second channel, never the only one); size is '' (card) or 'lg' (saved banner).
function dayBadgeHtml(dateIso, size) {
  const cls = `day-badge${size ? ` day-badge--${size}` : ''}`;
  const key = dayKey(dateIso);
  if (!key) return `<span class="${cls} day-badge--tba"><span class="day-badge__date">Date TBA</span></span>`;
  return `<span class="${cls}" data-day="${key}">` +
    `<span class="day-badge__dow" aria-hidden="true">${esc(Core.weekdayShort(Core.normalizeDateIso(dateIso)))}</span>` +
    `<span class="day-badge__date" aria-hidden="true">${esc(dayMonthDay(dateIso))}</span>` +
    `<span class="sr-only">${esc(dayLongLabel(dateIso))}</span>` +
    '</span>';
}

function formatLabel(eventType) {
  return Core.formatShort(eventType);
}

function safeHttpUrl(url) {
  return typeof url === 'string' && /^https:\/\//i.test(url) ? url : '';
}

function venueInfo(session) {
  const V = window.M2020Venues;
  let r = null;
  if (V && typeof V.resolve === 'function') {
    try {
      r = V.resolve(session.venue);
    } catch (error) {
      r = null;
    }
  }
  if (!r) return { room: session.venue || 'Venue TBA', area: '', detail: '', mapUrl: '' };
  const building = String(r.building || '').replace(/^The\s+/i, '');
  const level = String(r.level || '').replace(/\s*\(.*\)\s*$/, '');
  const room = r.room || session.venue || 'Venue TBA';
  // Drop an area the room name already says ("MoneyPot Stage" + "MoneyPot"), as calendar.js does.
  const area = r.area && room.toLowerCase().indexOf(r.area.toLowerCase()) === -1 ? r.area : '';
  const parts = [];
  if (area) parts.push(area);
  if (r.offsite) {
    parts.push(building ? `${building} · off-site` : 'Off-site');
  } else if (building) {
    parts.push(level ? `${building}, ${level}` : building);
  }
  return { room, area, detail: parts.join(' · '), mapUrl: safeHttpUrl(r.mapUrl) };
}

function descriptionParagraphs(html) {
  const text = Core.htmlToText(html || '');
  if (!text) return [];
  return text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
}

const NAME_SUFFIXES = /^(jr|sr|ii|iii|iv|phd|mba|cfa|cpa|esq)\.?$/i;
function initials(name) {
  const parts = String(name || '').replace(/[^\p{L}\p{N}\s'-]/gu, ' ').trim().split(/\s+/)
    .filter((p) => p && !NAME_SUFFIXES.test(p));
  if (!parts.length) return '?';
  const first = Array.from(parts[0])[0] || '';
  const last = parts.length > 1 ? Array.from(parts[parts.length - 1])[0] || '' : '';
  return (first + last).toUpperCase();
}

function avatarHue(name) {
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h % 6;
}

function showDayPhrase() {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  if (today === Core.addDaysIso(CONF.startDate, -1)) return 'tomorrow';
  if (today >= CONF.startDate && today <= CONF.endDate) return 'today';
  return 'at the show';
}

// --- Card rendering ---
function topicsHtml(session) {
  const themes = session.themes || session.topics || [];
  const themeSet = new Set(themes);
  const tags = (session.tags || []).filter((t) => !themeSet.has(t));
  if (!themes.length && !tags.length) return '';
  const extra = tags.length - TOPIC_TAG_LIMIT;
  const chips = []
    .concat(themes.map((t) => `<li class="chip chip--theme">${esc(t)}</li>`))
    .concat(tags.map((t, i) => `<li class="chip"${i >= TOPIC_TAG_LIMIT ? ' hidden data-extra-tag' : ''}>${esc(t)}</li>`));
  if (extra > 0) {
    chips.push(`<li><button type="button" class="chip chip--more" data-app-action="more-tags" aria-label="Show ${extra} more ${extra === 1 ? 'topic' : 'topics'}">+${extra}</button></li>`);
  }
  return `
    <section class="card-section">
      <h3 class="eyebrow">Topics</h3>
      <ul class="chips">${chips.join('')}</ul>
    </section>`;
}

function speakersHtml(session) {
  const speakers = (session.speakers || []).filter((sp) => sp && sp.name);
  if (!speakers.length) return '';
  const rows = speakers.map((sp) => {
    const role = [sp.jobTitle, sp.company].filter(Boolean).join(', ');
    const type = sp.type && sp.type !== 'Speaker' ? sp.type : '';
    return `
      <li class="speaker">
        <span class="avatar avatar--${avatarHue(sp.name)}" aria-hidden="true">${esc(initials(sp.name))}</span>
        <div class="speaker-text">
          <p class="speaker-name">${esc(sp.name)}${type ? `<span class="speaker-type">${esc(type)}</span>` : ''}</p>
          ${role ? `<p class="speaker-role">${esc(role)}</p>` : ''}
        </div>
      </li>`;
  }).join('');
  return `
    <section class="card-section">
      <h3 class="eyebrow">${speakers.length === 1 ? 'Speaker' : 'Speakers'}</h3>
      <ul class="speakers">${rows}</ul>
    </section>`;
}

function cardHtml(session, isPeek) {
  const v = venueInfo(session);
  const format = formatLabel(session.eventType);
  const duration = durationLabel(session);
  const paragraphs = descriptionParagraphs(session.description);
  const desc = paragraphs.length
    ? `<div class="card-desc">${paragraphs.map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('')}</div>`
    : '';
  const mapLink = v.mapUrl ? `
        <a class="map-link" href="${esc(v.mapUrl)}" target="_blank" rel="noopener noreferrer" draggable="false"
           aria-label="Floor map for ${esc(v.room)} (opens in a new tab)">${icon('map')}<span>Map</span></a>` : '';
  return `
    <div class="card-day-bar" aria-hidden="true"></div>
    <div class="card-stamp card-stamp--save" aria-hidden="true">Save</div>
    <div class="card-stamp card-stamp--skip" aria-hidden="true">Skip</div>
    <div class="card-scroll">
    <div class="card-head">
      <div class="card-eyebrow">
        ${dayBadgeHtml(session.dateIso)}
        ${format ? `<span class="chip chip--format">${esc(format)}</span>` : ''}
      </div>
      <h2 class="card-title"${isPeek ? '' : ` id="card-title-${esc(idOf(session))}"`}>${esc(session.title)}</h2>
      <div class="card-meta">
        <div class="card-row">
          ${icon('clock')}
          <p class="card-when"><span class="tnum">${esc(timeRange(session))}</span>${duration ? `<span class="muted"> · ${esc(duration)}</span>` : ''}</p>
        </div>
        <div class="card-row card-row--where">
          ${icon('pin')}
          <div class="card-where">
            <p class="where-room">${esc(v.room)}</p>
            ${v.detail ? `<p class="where-detail">${esc(v.detail)}</p>` : ''}
          </div>${mapLink}
        </div>
      </div>
    </div>
    <div class="card-body"${isPeek ? '' : ' tabindex="0" role="region" aria-label="Session details"'}>
      ${desc}
      ${topicsHtml(session)}
      ${speakersHtml(session)}
    </div>
    </div>
    <button type="button" class="card-more" data-app-action="scroll-card" tabindex="-1" aria-hidden="true"><span class="card-more__dot">${icon('chevron-down')}</span></button>`;
}

function buildCard(session, isPeek) {
  const card = document.createElement('article');
  card.className = isPeek ? 'session-card session-card--peek' : 'card session-card';
  card.dataset.eventId = idOf(session);
  const day = dayKey(session.dateIso);
  if (day) card.dataset.day = day;
  if (isPeek) {
    card.setAttribute('aria-hidden', 'true');
    card.inert = true;
  } else {
    card.setAttribute('role', 'group');
    card.setAttribute('aria-roledescription', 'session');
    card.setAttribute('aria-labelledby', `card-title-${idOf(session)}`);
  }
  card.innerHTML = cardHtml(session, isPeek);
  card.m2020Session = session;
  return card;
}

// Normally only .card-body scrolls under a pinned header. On short viewports (landscape phones, 200%
// zoom) styles.css turns .card-scroll (otherwise display: contents) into the scroller so the header
// scrolls away with the body. Whichever element actually overflows gets .has-more (fade mask).
function cardScrollers(card) {
  return card ? Array.from(card.querySelectorAll('.card-scroll, .card-body')) : [];
}

function activeScroller(card) {
  const list = cardScrollers(card);
  return list.find((el) => el.scrollHeight - el.clientHeight > 4) || list[list.length - 1] || null;
}

function updateScrollFade(card) {
  if (!card) return;
  let any = false;
  cardScrollers(card).forEach((el) => {
    const more = el.scrollHeight - el.clientHeight - el.scrollTop > 4;
    el.classList.toggle('has-more', more);
    if (more) any = true;
  });
  card.classList.toggle('has-more', any);
}

function scrollCard(button) {
  const scroller = activeScroller(button.closest('.session-card'));
  if (!scroller) return;
  scroller.scrollBy({ top: Math.round(scroller.clientHeight * 0.8), behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}

function topCard() {
  return container.querySelector('.card');
}

function peekCard() {
  return container.querySelector('.session-card--peek');
}

// Same session with identical details (a data refresh creates new objects even when nothing changed).
function sameSession(a, b) {
  if (a === b) return true;
  if (!a || !b || a.eventId !== b.eventId) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch (error) {
    return false;
  }
}

function showCurrentCard(force) {
  const top = deck[0] || null;
  const next = deck[1] || null;
  const existing = topCard();

  if (!force && top && existing && sameSession(renderedSession, top)) {
    renderedSession = top;
    existing.m2020Session = top;
    syncPeek(next);
    return;
  }

  // Re-rendering the card in place (e.g. its room changed on refresh): keep keyboard focus and scroll.
  const sameCard = !!(existing && top && existing.dataset.eventId === idOf(top));
  const keepScroll = sameCard ? cardScrollers(existing).map((el) => el.scrollTop) : [];
  const hadFocus = sameCard && existing.contains(document.activeElement);
  if (sameCard) cancelGesture();

  container.querySelectorAll('.session-card').forEach((el) => el.remove());
  renderedSession = null;
  if (!top) return;

  const card = buildCard(top, false);
  container.appendChild(card);
  renderedSession = top;
  attachCardHandlers(card);
  const body = card.querySelector('.card-body');
  cardScrollers(card).forEach((el, i) => {
    if (keepScroll[i]) el.scrollTop = keepScroll[i];
  });
  if (hadFocus && body) body.focus({ preventScroll: true });
  updateScrollFade(card);
  syncPeek(next);
  if (!sameCard) maybeNudge(card);
}

function syncPeek(next) {
  const existing = peekCard();
  if (existing && next && sameSession(existing.m2020Session, next) && !existing.classList.contains('is-promoting')) {
    existing.m2020Session = next;
    return;
  }
  if (existing) existing.remove();
  if (!next) return;
  const peek = buildCard(next, true);
  container.appendChild(peek);
  updateScrollFade(peek);
}

function attachCardHandlers(card) {
  card.addEventListener('pointerdown', onCardPointerDown);
  card.addEventListener('click', onCardClickCapture, true);
  let queued = false;
  const onScroll = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      updateScrollFade(card);
    });
  };
  cardScrollers(card).forEach((el) => el.addEventListener('scroll', onScroll, { passive: true }));
}

function onCardClickCapture(event) {
  if (performance.now() < suppressClickUntil) {
    event.preventDefault();
    event.stopPropagation();
  }
}

function expandTags(button) {
  const list = button.closest('.chips');
  if (!list) return;
  list.querySelectorAll('[data-extra-tag]').forEach((li) => {
    li.hidden = false;
    li.removeAttribute('data-extra-tag');
  });
  const item = button.closest('li');
  const body = button.closest('.card-body');
  const card = button.closest('.session-card');
  if (item) item.remove();
  if (body) body.focus({ preventScroll: true });
  updateScrollFade(card);
}

// --- Deck states (end of deck, zero results, load error) ---
function hiddenByFilters() {
  let unprocessed = 0;
  allSessions.forEach((s) => {
    if (!processedIds.has(idOf(s))) unprocessed += 1;
  });
  return Math.max(0, unprocessed - deck.length);
}

function deckStateKind() {
  if (deck.length) return '';
  if (isLoading && !allSessions.length) return '';
  if (!allSessions.length) return 'error';
  const active = filtersActive();
  if (active && matchCount === 0) return 'zero';
  if (active && hiddenByFilters() > 0) return 'done-filtered';
  return 'done';
}

function deckStateHtml(kind) {
  const n = selectedEvents.length;
  const addBtn = n
    ? `<button type="button" class="ui-btn ui-btn--primary ui-btn--block" id="export-end" data-app-action="export">${icon('calendar')}Add ${n} to calendar</button>`
    : '';
  const state = (iconName, tone, title, body, actions) => `
    <div class="deck-state__inner">
      <div class="deck-state__icon${tone ? ` deck-state__icon--${tone}` : ''}">${icon(iconName)}</div>
      <h2 class="deck-state__title">${title}</h2>
      <p class="deck-state__body">${body}</p>
      <div class="deck-state__actions">${actions}</div>
    </div>`;

  if (kind === 'error') {
    return state('cloud-off', 'danger', 'Couldn’t load the schedule', 'Check your connection and try again.',
      '<button type="button" class="ui-btn ui-btn--primary ui-btn--block" data-app-action="retry">Try again</button>');
  }
  if (kind === 'zero') {
    return state('search', '', 'No sessions match', 'Try fewer filters or a different search.',
      '<button type="button" class="ui-btn ui-btn--primary ui-btn--block" data-app-action="clear-filters">Clear all filters</button>' +
      '<button type="button" class="ui-btn ui-btn--secondary ui-btn--block" data-app-action="edit-filters">Edit filters</button>');
  }
  if (kind === 'done-filtered') {
    const hidden = hiddenByFilters();
    return state('check-circle', 'like', 'No more matches',
      `You’ve seen all ${plural(matchCount, 'session')} that match. ${hidden} more ${hidden === 1 ? 'is' : 'are'} hidden by your filters.`,
      addBtn +
      '<button type="button" class="ui-btn ui-btn--secondary ui-btn--block" data-app-action="clear-filters">Clear filters</button>' +
      '<button type="button" class="ui-btn ui-btn--text ui-btn--block" data-app-action="edit-filters">Edit filters</button>');
  }
  if (!n) {
    return state('check-circle', 'like', 'That’s every session', 'Nothing saved this time. Start over to take another pass.',
      '<button type="button" class="ui-btn ui-btn--primary ui-btn--block" data-app-action="reset">Start over</button>');
  }
  return state('check-circle', 'like', 'That’s every session',
    `You saved ${n}. Add them to your calendar so they’re with you ${showDayPhrase()}.`,
    addBtn +
    '<button type="button" class="ui-btn ui-btn--secondary ui-btn--block" data-app-action="saved">Review saved</button>' +
    '<button type="button" class="ui-btn ui-btn--text ui-btn--block" data-app-action="reset">Start over</button>');
}

function renderDeckState(focusOnActions) {
  const kind = deckStateKind();
  const key = kind ? [kind, selectedEvents.length, matchCount, kind === 'done-filtered' ? hiddenByFilters() : 0].join('|') : '';
  actionBar.classList.toggle('is-done', !!kind);
  if (key === deckStateKey) return;
  const wasShowing = !!deckStateKey;
  deckStateKey = key;
  if (!kind) {
    const hadFocus = deckStateEl.contains(document.activeElement);
    deckStateEl.hidden = true;
    deckStateEl.innerHTML = '';
    // Keyboard users land on the primary action of the deck that just came back.
    if (hadFocus && isFocusable(btnLike)) btnLike.focus({ preventScroll: true });
    return;
  }
  const hadFocus = deckStateEl.contains(document.activeElement);
  deckStateEl.innerHTML = deckStateHtml(kind);
  deckStateEl.hidden = false;
  if (!wasShowing && kind !== 'error') announce(kind === 'zero' ? 'No sessions match your filters' : 'No more sessions');
  if (hadFocus || focusOnActions) {
    const first = deckStateEl.querySelector('button');
    if (first) first.focus({ preventScroll: true });
  }
}

// --- First-run hint + nudge ---
function initHint() {
  if (readFlag(HINT_KEY) || processedIds.size > 0) return;
  hintVisible = true;
  hintEl.hidden = false;
  updateToastOffset();
}

function dismissHint() {
  if (!hintVisible) return;
  hintVisible = false;
  writeFlag(HINT_KEY);
  if (prefersReducedMotion()) {
    hintEl.hidden = true;
    updateToastOffset();
    return;
  }
  hintEl.classList.add('is-leaving');
  setTimeout(() => {
    hintEl.hidden = true;
    hintEl.classList.remove('is-leaving');
    updateToastOffset();
  }, 200);
}

function maybeNudge(card) {
  if (nudgeDone || !hintVisible || processedIds.size > 0 || prefersReducedMotion()) return;
  nudgeDone = true;
  card.addEventListener('animationend', (event) => {
    if (event.animationName === 'card-nudge') card.classList.remove('is-nudging');
  });
  setTimeout(() => {
    if (card.isConnected && !gesture && !actionInProgress) card.classList.add('is-nudging');
  }, 700);
}

// --- Swipe gestures (pointer events) ---
function swipeThreshold(width) {
  return Math.max(SWIPE_MIN_PX, width * SWIPE_RATIO);
}

function onCardPointerDown(event) {
  if (gesture || isLoading || actionInProgress) return;
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  const card = event.currentTarget;
  card.classList.remove('is-nudging');
  gesture = {
    id: event.pointerId,
    card,
    peek: peekCard(),
    x0: event.clientX,
    y0: event.clientY,
    dx: 0,
    dy: 0,
    axis: null,
    moved: false,
    raf: 0,
    threshold: swipeThreshold(card.offsetWidth || 320),
    samples: [{ x: event.clientX, t: performance.now() }]
  };
  window.addEventListener('pointermove', onCardPointerMove, { passive: false });
  window.addEventListener('pointerup', onCardPointerUp);
  window.addEventListener('pointercancel', onCardPointerCancel);
}

function endGestureListeners() {
  window.removeEventListener('pointermove', onCardPointerMove);
  window.removeEventListener('pointerup', onCardPointerUp);
  window.removeEventListener('pointercancel', onCardPointerCancel);
}

// Abandon the drag in flight (a button/key decision or a re-render took over). Returns the gesture.
function cancelGesture() {
  const g = gesture;
  if (!g) return null;
  endGestureListeners();
  gesture = null;
  if (g.raf) cancelAnimationFrame(g.raf);
  try {
    if (g.card.hasPointerCapture && g.card.hasPointerCapture(g.id)) g.card.releasePointerCapture(g.id);
  } catch (error) {
    // Non-fatal
  }
  if (g.moved) suppressClickUntil = performance.now() + 350;
  g.card.classList.remove('is-dragging');
  return g;
}

function onCardPointerMove(event) {
  const g = gesture;
  if (!g || event.pointerId !== g.id) return;
  const dx = event.clientX - g.x0;
  const dy = event.clientY - g.y0;
  if (Math.abs(dx) >= CLICK_SLOP_PX || Math.abs(dy) >= CLICK_SLOP_PX) g.moved = true;

  if (!g.axis) {
    if (Math.abs(dx) < AXIS_LOCK_PX && Math.abs(dy) < AXIS_LOCK_PX) return;
    g.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    if (g.axis === 'y') {
      // Vertical: let the card body scroll natively.
      endGestureListeners();
      gesture = null;
      if (g.moved) suppressClickUntil = performance.now() + 350;
      return;
    }
    try {
      g.card.setPointerCapture(g.id);
    } catch (error) {
      // Non-fatal
    }
    g.card.classList.remove('is-settling');
    g.card.classList.add('is-dragging');
    if (g.peek) g.peek.style.transition = 'none';
  }

  event.preventDefault();
  g.dx = dx;
  g.dy = dy;
  const now = performance.now();
  g.samples.push({ x: event.clientX, t: now });
  while (g.samples.length > 2 && now - g.samples[0].t > 100) g.samples.shift();
  if (!g.raf) {
    g.raf = requestAnimationFrame(() => {
      g.raf = 0;
      applyDrag(g);
    });
  }
}

function applyDrag(g) {
  const rotation = clamp(g.dx / 18, -14, 14);
  g.card.style.transform = `translate3d(${g.dx}px, ${g.dy * 0.15}px, 0) rotate(${rotation}deg)`;
  const p = Math.min(1, Math.abs(g.dx) / g.threshold);
  g.card.style.setProperty('--save-o', g.dx > 0 ? p.toFixed(3) : '0');
  g.card.style.setProperty('--skip-o', g.dx < 0 ? p.toFixed(3) : '0');
  if (g.peek) {
    g.peek.style.transform = `translateY(${(10 - 10 * p).toFixed(2)}px) scale(${(0.96 + 0.04 * p).toFixed(4)})`;
    g.peek.style.opacity = (0.85 + 0.15 * p).toFixed(3);
  }
}

// px/ms over the last ~100ms before release (holding still before letting go means no fling).
function releaseVelocity(g) {
  const now = performance.now();
  const s = g.samples.concat([{ x: g.x0 + g.dx, t: now }]).filter((p) => now - p.t <= 100);
  if (s.length < 2) return 0;
  const first = s[0];
  const last = s[s.length - 1];
  const dt = last.t - first.t;
  return dt > 0 ? (last.x - first.x) / dt : 0;
}

function onCardPointerUp(event) {
  const g = gesture;
  if (!g || event.pointerId !== g.id) return;
  endGestureListeners();
  gesture = null;
  if (g.raf) cancelAnimationFrame(g.raf);
  if (g.moved) suppressClickUntil = performance.now() + 350;
  if (g.axis !== 'x') return;
  // The card may have been decided or replaced while the pointer was down: never act on another card.
  if (!g.card.isConnected || g.card !== topCard()) return;

  applyDrag(g);
  g.card.classList.remove('is-dragging');
  const velocity = releaseVelocity(g);
  let direction = 0;
  if (Math.abs(g.dx) >= g.threshold) {
    direction = Math.sign(g.dx);
  } else if (Math.abs(velocity) > FLING_VELOCITY && Math.abs(g.dx) > FLING_MIN_PX && Math.sign(velocity) === Math.sign(g.dx)) {
    direction = Math.sign(velocity);
  }

  if (direction > 0) {
    decide('right', { fromDrag: true, dy: g.dy * 0.15 });
  } else if (direction < 0) {
    decide('left', { fromDrag: true, dy: g.dy * 0.15 });
  } else {
    snapBack(g);
  }
}

function onCardPointerCancel(event) {
  const g = gesture;
  if (!g || event.pointerId !== g.id) return;
  endGestureListeners();
  gesture = null;
  if (g.raf) cancelAnimationFrame(g.raf);
  if (g.axis === 'x' && g.card.isConnected && g.card === topCard()) snapBack(g);
}

function snapBack(g) {
  const card = g.card;
  card.classList.remove('is-dragging');
  card.classList.add('is-settling');
  card.style.transform = '';
  card.style.setProperty('--save-o', '0');
  card.style.setProperty('--skip-o', '0');
  if (g.peek) {
    g.peek.style.transition = '';
    g.peek.style.transform = '';
    g.peek.style.opacity = '';
  }
  setTimeout(() => card.classList.remove('is-settling'), CARD_MS + 20);
}

// --- Decisions ---
function decide(direction, opts) {
  const options = opts || {};
  if (actionInProgress || isLoading) return;
  const session = deck[0];
  if (!session) return;
  // A button or key decided while a finger/mouse is still dragging this card: the drag is over.
  if (!options.fromDrag) cancelGesture();
  const card = topCard();
  actionInProgress = true;
  const key = idOf(session);

  if (direction === 'right') {
    if (!isSaved(key)) {
      selectedEvents.push(session);
      saveSelections();
      lastAction = { type: 'like', dir: 'right', session };
    } else {
      lastAction = { type: 'skip', dir: 'right', session };
    }
    announce(`Saved: ${session.title}`);
  } else {
    lastAction = { type: 'skip', dir: 'left', session };
    announce(`Skipped: ${session.title}`);
  }
  processedIds.add(key);
  saveProcessedIds();
  deck = deck.filter((s) => idOf(s) !== key);

  if (!options.fromDrag) pulse(direction === 'right' ? btnLike : btnDislike);
  dismissHint();
  updateCounter();
  updateUndoButton();
  refreshFilterCounts();
  animateCardExit(direction, card, options.dy || 0);
}

function animateCardExit(direction, card, dy) {
  const sign = direction === 'right' ? 1 : -1;
  const reduced = prefersReducedMotion();
  const duration = reduced ? EXIT_REDUCED_MS : EXIT_MS;
  const finish = () => {
    actionInProgress = false;
    if (pendingRebuild) {
      pendingRebuild = false;
      rebuildDeck();
    }
    renderDeck(true);
  };

  if (!card || !card.isConnected) {
    finish();
    return;
  }

  card.classList.remove('is-dragging', 'is-settling', 'is-nudging');
  card.classList.add('is-leaving');
  card.style.pointerEvents = 'none';
  card.style.setProperty(sign > 0 ? '--save-o' : '--skip-o', '1');
  card.style.setProperty(sign > 0 ? '--skip-o' : '--save-o', '0');
  if (reduced) {
    card.style.transition = `opacity ${duration}ms linear, transform ${duration}ms linear`;
    card.style.transform = `translate3d(${sign * 12}px, 0, 0)`;
    card.style.opacity = '0';
  } else {
    card.style.transition = `transform ${duration}ms var(--ease-in), opacity ${duration}ms var(--ease-in)`;
    card.style.transform = `translate3d(${sign * 120}vw, ${dy}px, 0) rotate(${sign * 24}deg)`;
  }

  const peek = peekCard();
  if (peek) {
    peek.style.transition = '';
    peek.style.transform = '';
    peek.style.opacity = '';
    peek.classList.add('is-promoting');
  }
  setTimeout(finish, duration);
}

function flyIn(card, direction) {
  if (!card) return;
  const sign = direction === 'right' ? 1 : -1;
  if (prefersReducedMotion()) {
    card.style.transition = 'none';
    card.style.opacity = '0';
    void card.offsetWidth;
    card.style.transition = `opacity ${EXIT_REDUCED_MS}ms linear`;
    card.style.opacity = '';
  } else {
    card.style.transition = 'none';
    card.style.transform = `translate3d(${sign * 110}vw, 0, 0) rotate(${sign * 20}deg)`;
    void card.offsetWidth;
    card.style.transition = `transform ${EXIT_MS}ms var(--ease-out)`;
    card.style.transform = '';
  }
  setTimeout(() => {
    if (card.isConnected) card.style.transition = '';
  }, EXIT_MS + 40);
}

function performUndo() {
  if (!lastAction || actionInProgress || isLoading) return;
  const { type, dir, session } = lastAction;
  const key = idOf(session);

  if (type === 'like') {
    selectedEvents = selectedEvents.filter((e) => idOf(e) !== key);
    saveSelections();
  }
  processedIds.delete(key);
  saveProcessedIds();

  // Put the undone card back on top, even if the current filters would exclude it.
  deck = [session].concat(deck.filter((s) => idOf(s) !== key));
  lastAction = null;
  renderDeck(true);
  flyIn(topCard(), dir);
  pulse(undoBtn);
  announce(`Undone. ${session.title} is back on top.`);
}

// --- Toasts stay clear of whatever sits at the bottom (dock, or the saved sheet's footer) ---
// toast.css reads --toast-offset (distance above the bottom safe area).
const safeProbe = $('safe-probe');
let toastOffset = '';
function updateToastOffset() {
  const safe = safeProbe ? safeProbe.getBoundingClientRect().height : 0;
  let height = 0;
  if (isOverlayOpen(savedOverlay) && !savedFooter.hidden) {
    // The footer is pinned to the bottom of the sheet (measured without the slide-in transform).
    height = savedFooter.offsetHeight;
  } else if (!document.querySelector('.overlay.visible')) {
    const edge = hintVisible && !hintEl.hidden ? hintEl : actionBar;
    const top = edge.getBoundingClientRect().top;
    if (top > 0) height = window.innerHeight - top;
  }
  if (!height) return;
  const value = `${Math.max(0, Math.round(height - safe + 12))}px`;
  if (value !== toastOffset) {
    toastOffset = value;
    document.documentElement.style.setProperty('--toast-offset', value);
  }
}

// --- Overlay helpers (my overlays: saved, about, more) ---
const showTokens = new WeakMap();

function showOverlay(overlay) {
  if (!overlay) return;
  showTokens.set(overlay, {});
  overlay.style.display = 'flex';
  // Force a style flush so the enter transition starts from the hidden state. Unlike requestAnimationFrame
  // this also works while rAF is paused (background tabs, some in-app browsers). Same as export-ui.js.
  void overlay.offsetWidth;
  overlay.classList.add('visible');
}

function hideOverlay(overlay) {
  if (!overlay) return;
  showTokens.delete(overlay);
  overlay.classList.remove('visible');
  setTimeout(() => {
    if (!overlay.classList.contains('visible') && !showTokens.has(overlay)) overlay.style.display = 'none';
  }, OVERLAY_HIDE_MS);
}

function isOverlayOpen(overlay) {
  return !!overlay && (overlay.classList.contains('visible') || showTokens.has(overlay));
}

function closeAppOverlays() {
  APP_OVERLAYS.forEach((overlay) => {
    if (isOverlayOpen(overlay)) hideOverlay(overlay);
  });
}

APP_OVERLAYS.forEach((overlay) => {
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) hideOverlay(overlay);
  });
});

function anyOverlayOpen() {
  return !!document.querySelector('.overlay.visible, [role="alertdialog"]:not([hidden])') ||
    APP_OVERLAYS.some((o) => showTokens.has(o));
}

// --- Saved list ---
function savedRowHtml(session) {
  const key = idOf(session);
  const v = venueInfo(session);
  const where = [v.room, v.area].filter(Boolean).join(' · ');
  const start = clock(session.startTime, true) || 'Time TBA';
  const end = session.endTime && session.endTime !== session.startTime ? clock(session.endTime, true) : '';
  return `
    <li class="saved-row" data-id="${esc(key)}"${dayAttr(session.dateIso)}>
      <p class="saved-time">${esc(start)}${end ? `<span class="saved-time-end">– ${esc(end)}</span>` : ''}</p>
      <div class="saved-main">
        <p class="saved-title">${esc(session.title)}</p>
        ${where ? `<p class="saved-where">${esc(where)}</p>` : ''}
      </div>
      <button type="button" class="icon-btn saved-remove" data-app-action="remove-saved" data-id="${esc(key)}"
              aria-label="Remove ${esc(session.title)} from saved" title="Remove">${icon('trash')}</button>
    </li>`;
}

function updateSavedChrome() {
  const n = selectedEvents.length;
  savedTitle.textContent = n ? `Saved · ${n}` : 'Saved';
  savedFooter.hidden = n === 0;
  savedExportLabel.textContent = `Add ${n} to calendar`;
  updateToastOffset();
}

function renderSaved() {
  updateSavedChrome();
  const list = getSortedSelections();
  if (!list.length) {
    savedBody.innerHTML = `
      <div class="sheet-empty">
        <div class="deck-state__icon">${icon('bookmark')}</div>
        <h3>Nothing saved yet</h3>
        <p>Swipe right on the sessions you want to attend.</p>
        <button type="button" class="ui-btn ui-btn--primary" data-app-action="close-saved">Back to swiping</button>
      </div>`;
    return;
  }
  const groups = [];
  let current = null;
  list.forEach((s) => {
    const key = s.dateIso || 'tba';
    if (!current || current.key !== key) {
      current = { key, dateIso: s.dateIso || '', items: [] };
      groups.push(current);
    }
    current.items.push(s);
  });
  // Each day opens with a sticky banner in that day's colour (same badge as on the cards); every row carries
  // the day's colour as a marker too. The heading reads "Sunday, October 18, 3 sessions".
  savedBody.innerHTML = `
    <ul class="saved-list">
      ${groups.map((g) => `
        <li class="saved-day"${dayAttr(g.dateIso)}>
          <h3 class="saved-day-head">
            <span class="day-banner">
              ${dayBadgeHtml(g.dateIso, 'lg')}
              <span class="day-banner__count"><span class="sr-only">, </span>${esc(plural(g.items.length, 'session'))}</span>
            </span>
          </h3>
          <ul class="saved-rows">${g.items.map(savedRowHtml).join('')}</ul>
        </li>`).join('')}
    </ul>`;
}

function openSaved() {
  closeAppOverlays();
  renderSaved();
  showOverlay(savedOverlay);
  // After showOverlay: a scroller that is still display:none keeps its old offset, so the sheet would
  // reopen halfway down the list (and under a stuck day banner).
  savedBody.scrollTop = 0;
}

function removeSaved(key, button) {
  const idx = selectedEvents.findIndex((s) => idOf(s) === key);
  if (idx === -1) return;
  const session = selectedEvents[idx];
  const row = button ? button.closest('.saved-row') : null;
  const rows = Array.from(savedBody.querySelectorAll('.saved-row'));
  const rowIdx = rows.indexOf(row);
  const neighbour = rows[rowIdx + 1] || rows[rowIdx - 1] || null;
  const neighbourId = neighbour ? neighbour.dataset.id : null;

  selectedEvents.splice(idx, 1);
  saveSelections();
  processedIds.delete(key);
  saveProcessedIds();
  if (lastAction && idOf(lastAction.session) === key) lastAction = null;
  // The session goes back to the front of the remaining deck.
  if (actionInProgress) {
    pendingRebuild = true;
  } else {
    deck = [session].concat(deck.filter((s) => idOf(s) !== key));
    renderDeck(false);
  }
  updateSavedChrome();

  const rerender = () => {
    renderSaved();
    const next = neighbourId ? savedBody.querySelector(`.saved-remove[data-id="${CSS.escape(neighbourId)}"]`) : null;
    const fallback = savedBody.querySelector('.sheet-empty button') || $('close-overlay');
    const target = next || fallback;
    if (target && savedOverlay.contains(document.activeElement || null)) target.focus({ preventScroll: true });
    else if (target && (!document.activeElement || document.activeElement === document.body)) target.focus({ preventScroll: true });
  };
  if (row && !prefersReducedMotion()) {
    row.style.height = `${row.offsetHeight}px`;
    void row.offsetHeight;
    row.classList.add('is-removing');
    row.style.height = '0px';
    setTimeout(rerender, 220);
  } else {
    rerender();
  }

  toast('Removed from saved', {
    type: 'neutral',
    duration: 5000,
    action: { label: 'Undo', onClick: () => restoreSaved(session) }
  });
}

function restoreSaved(session) {
  const key = idOf(session);
  if (!isSaved(key)) {
    selectedEvents.push(session);
    saveSelections();
  }
  processedIds.add(key);
  saveProcessedIds();
  if (actionInProgress) {
    pendingRebuild = true;
  } else {
    deck = deck.filter((s) => idOf(s) !== key);
    renderDeck(false);
  }
  if (isOverlayOpen(savedOverlay)) {
    renderSaved();
    const active = document.activeElement;
    if (!active || active === document.body) {
      const btn = savedBody.querySelector(`.saved-remove[data-id="${CSS.escape(key)}"]`);
      if (btn) btn.focus({ preventScroll: true });
    }
  }
  announce(`${session.title} is saved again`);
}

// --- Menu, about, export, filters, reset, refresh ---
function openMore() {
  closeAppOverlays();
  showOverlay(moreOverlay);
}

function openAbout() {
  closeAppOverlays();
  showOverlay(aboutOverlay);
}

function openExport() {
  if (!selectedEvents.length) {
    closeAppOverlays();
    toast('Save a session first', { type: 'info' });
    return;
  }
  closeAppOverlays();
  if (window.ExportUI && typeof window.ExportUI.open === 'function') {
    window.ExportUI.open();
  } else {
    toast('Calendar export isn’t available right now. Reload the page and try again.', { type: 'error' });
  }
}

function openFilters() {
  closeAppOverlays();
  if (window.Filters && typeof window.Filters.open === 'function') {
    window.Filters.open();
  } else {
    toast('Filters aren’t available right now. Reload the page and try again.', { type: 'error' });
  }
}

function clearFilters() {
  if (window.Filters && typeof window.Filters.reset === 'function') window.Filters.reset();
}

function refreshSchedule() {
  closeAppOverlays();
  if (!isLoading) loadEvents('refresh');
}

async function startOver(trigger) {
  if (trigger && appEl.contains(trigger)) {
    lastAppFocus = trigger;
  } else {
    lastAppFocus = moreBtn;
  }
  closeAppOverlays();
  const n = selectedEvents.length;
  let what = 'your saved sessions';
  if (n === 1) what = 'your 1 saved session';
  if (n > 1) what = `your ${n} saved sessions`;
  const confirmed = await confirmAction({
    title: 'Start over?',
    message: `This clears ${what} and your place in the deck. It can’t be undone.`,
    confirmLabel: 'Start over',
    cancelLabel: 'Cancel',
    destructive: true
  });
  if (!confirmed) return;

  selectedEvents = [];
  saveSelections();
  processedIds = new Set();
  saveProcessedIds();
  lastAction = null;
  if (actionInProgress) {
    pendingRebuild = true;
  } else {
    rebuildDeck();
    renderDeck(true);
  }
  if (!lastAppFocus || !lastAppFocus.isConnected) lastAppFocus = moreBtn;
  toast('Everything cleared', { type: 'success' });
}

// --- Click delegation for [data-app-action] (namespaced so feature modules can't collide) ---
document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target.closest('[data-app-action]') : null;
  if (!target) return;
  if (target.getAttribute('aria-disabled') === 'true') return;
  const action = target.getAttribute('data-app-action');
  switch (action) {
    case 'saved': openSaved(); break;
    case 'close-saved': hideOverlay(savedOverlay); break;
    case 'more': openMore(); break;
    case 'close-more': hideOverlay(moreOverlay); break;
    case 'about': openAbout(); break;
    case 'close-about': hideOverlay(aboutOverlay); break;
    case 'export': openExport(); break;
    case 'refresh': refreshSchedule(); break;
    case 'reset': startOver(target); break;
    case 'retry': loadEvents('retry'); break;
    case 'clear-filters': clearFilters(); break;
    case 'edit-filters': openFilters(); break;
    case 'dismiss-hint': dismissHint(); break;
    case 'undo': performUndo(); break;
    case 'more-tags': expandTags(target); break;
    case 'scroll-card': scrollCard(target); break;
    case 'remove-saved': removeSaved(target.getAttribute('data-id'), target); break;
    default: break;
  }
});

btnDislike.addEventListener('click', () => decide('left'));
btnLike.addEventListener('click', () => decide('right'));
filtersBtn.addEventListener('click', openFilters);

// --- Keyboard ---
function isTypingTarget(el) {
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (document.querySelector('[role="alertdialog"]:not([hidden])')) return;
    const open = APP_OVERLAYS.find((o) => isOverlayOpen(o));
    if (open) hideOverlay(open);
    return;
  }

  // Arrow keys move between items of the More menu.
  if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && moreOverlay.classList.contains('visible')) {
    const items = Array.from(moreOverlay.querySelectorAll('.menu-item')).filter(isFocusable);
    if (items.length) {
      event.preventDefault();
      const i = items.indexOf(document.activeElement);
      const next = event.key === 'ArrowDown' ? (i + 1) % items.length : (i <= 0 ? items.length - 1 : i - 1);
      items[next].focus();
    }
    return;
  }

  if (event.defaultPrevented || isTypingTarget(event.target) || anyOverlayOpen()) return;
  const mod = event.metaKey || event.ctrlKey;

  if (mod && !event.altKey && !event.shiftKey && (event.key === 'z' || event.key === 'Z')) {
    event.preventDefault();
    performUndo();
    return;
  }
  if (mod || event.altKey) return;

  switch (event.key) {
    case 'ArrowLeft':
      if (event.repeat || !deck.length || isLoading) return;
      event.preventDefault();
      decide('left');
      break;
    case 'ArrowRight':
      if (event.repeat || !deck.length || isLoading) return;
      event.preventDefault();
      decide('right');
      break;
    case 'z':
    case 'Z':
    case 'Backspace':
      if (event.repeat) return;
      event.preventDefault();
      performUndo();
      break;
    case 'f':
    case 'F':
      event.preventDefault();
      lastAppFocus = filtersBtn;
      openFilters();
      break;
    case 's':
    case 'S':
      event.preventDefault();
      lastAppFocus = viewSelectedBtn;
      openSaved();
      break;
    default:
      break;
  }
});

// --- Modal state: inert background + focus in/out for every .overlay (incl. filters/export) ---
let modalOpen = false;
let openOverlayList = [];
let lastClosedOverlay = null;
let modalSyncQueued = false;

appEl.addEventListener('focusin', (event) => {
  lastAppFocus = event.target;
});

function isFocusable(el) {
  return !!el && el.isConnected && !el.disabled && !el.closest('[hidden], [inert]') && el.getClientRects().length > 0;
}

function focusIntoOverlay(overlay) {
  setTimeout(() => {
    if (!overlay.classList.contains('visible')) return;
    const active = document.activeElement;
    if (active && overlay.contains(active)) return;
    const content = overlay.querySelector('.overlay-content') || overlay;
    const candidates = Array.from(content.querySelectorAll(
      '[autofocus], .close-btn, button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
    )).filter(isFocusable);
    const preferred = candidates.find((el) => el.hasAttribute('autofocus')) ||
      candidates.find((el) => el.classList.contains('close-btn')) ||
      candidates[0];
    if (preferred) {
      preferred.focus({ preventScroll: true });
    } else {
      if (!content.hasAttribute('tabindex')) content.setAttribute('tabindex', '-1');
      content.focus({ preventScroll: true });
    }
  }, 60);
}

function restoreFocus() {
  const active = document.activeElement;
  if (active && active.closest && active.closest('#toast-root')) return;
  const lost = !active || active === document.body || active === document.documentElement || !appEl.contains(active);
  if (!lost) return;
  const fallbackId = lastClosedOverlay ? OVERLAY_OPENERS[lastClosedOverlay.id] : null;
  const target = [lastAppFocus, fallbackId ? $(fallbackId) : null, btnLike, moreBtn].find(isFocusable);
  if (target) target.focus({ preventScroll: true });
}

function syncModalState() {
  const visible = Array.from(document.querySelectorAll('.overlay.visible'));
  const alertOpen = !!document.querySelector('[role="alertdialog"]:not([hidden])');
  const nowOpen = visible.length > 0 || alertOpen;

  visible.forEach((overlay) => {
    if (openOverlayList.indexOf(overlay) === -1) focusIntoOverlay(overlay);
  });
  openOverlayList.forEach((overlay) => {
    if (visible.indexOf(overlay) === -1) lastClosedOverlay = overlay;
  });
  openOverlayList = visible;

  if (appEl.hasAttribute('inert') !== nowOpen) appEl.toggleAttribute('inert', nowOpen);
  if (modalOpen && !nowOpen) restoreFocus();
  modalOpen = nowOpen;
  updateToastOffset();
}

function scheduleModalSync() {
  if (modalSyncQueued) return;
  modalSyncQueued = true;
  // Next frame, or after 100 ms when rAF is paused (background tab), whichever comes first.
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    modalSyncQueued = false;
    syncModalState();
  };
  requestAnimationFrame(run);
  setTimeout(run, 100);
}

if (typeof MutationObserver === 'function') {
  new MutationObserver(scheduleModalSync).observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'hidden', 'inert']
  });
}

// --- Drag a sheet's handle/header down to close it (sheet layout, any .overlay) ---
let sheetDrag = null;

function requestOverlayClose(overlay) {
  if (APP_OVERLAYS.indexOf(overlay) !== -1) {
    hideOverlay(overlay);
  } else {
    // Feature modules close on a backdrop click (CONTRACTS.md), so simulate one.
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }
}

function onSheetMove(event) {
  const s = sheetDrag;
  if (!s || event.pointerId !== s.id) return;
  const dy = Math.max(0, event.clientY - s.y0);
  if (!s.started) {
    if (dy < CLICK_SLOP_PX) return;
    s.started = true;
    s.content.style.transition = 'none';
  }
  event.preventDefault();
  s.dy = dy;
  const now = performance.now();
  s.samples.push({ y: event.clientY, t: now });
  while (s.samples.length > 2 && now - s.samples[0].t > 100) s.samples.shift();
  s.content.style.transform = `translateY(${dy}px)`;
}

function onSheetEnd(event) {
  const s = sheetDrag;
  if (!s || event.pointerId !== s.id) return;
  sheetDrag = null;
  window.removeEventListener('pointermove', onSheetMove);
  window.removeEventListener('pointerup', onSheetEnd);
  window.removeEventListener('pointercancel', onSheetEnd);
  if (!s.started) return;
  const first = s.samples[0];
  const last = s.samples[s.samples.length - 1];
  const velocity = last && first && last.t > first.t ? (last.y - first.y) / (last.t - first.t) : 0;
  const shouldClose = event.type === 'pointerup' &&
    (s.dy > Math.min(120, s.height * 0.25) || (velocity > 0.5 && s.dy > 24));
  s.content.style.transition = '';
  if (shouldClose) {
    s.content.style.transform = 'translateY(100%)';
    requestOverlayClose(s.overlay);
    setTimeout(() => {
      s.content.style.transform = '';
    }, OVERLAY_HIDE_MS + 40);
  } else {
    s.content.style.transform = '';
  }
}

document.addEventListener('pointerdown', (event) => {
  if (sheetDrag || !sheetLayoutQuery.matches) return;
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const content = target.closest('.overlay.visible > .overlay-content');
  if (!content || content.querySelector('[data-drag]')) return; // modules with their own drag (filters.js)
  if (target.closest('button, a, input, select, textarea, label, summary, [role="checkbox"], [role="button"], [contenteditable="true"]')) return;
  const rect = content.getBoundingClientRect();
  const inGrip = event.clientY - rect.top <= 28 || !!target.closest('.overlay-header');
  if (!inGrip) return;
  sheetDrag = {
    id: event.pointerId,
    content,
    overlay: content.parentElement,
    y0: event.clientY,
    dy: 0,
    height: rect.height,
    started: false,
    samples: [{ y: event.clientY, t: performance.now() }]
  };
  window.addEventListener('pointermove', onSheetMove, { passive: false });
  window.addEventListener('pointerup', onSheetEnd);
  window.addEventListener('pointercancel', onSheetEnd);
}, true);

// --- Resize: keep the scroll fade honest ---
let resizeQueued = false;
window.addEventListener('resize', () => {
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => {
    resizeQueued = false;
    container.querySelectorAll('.session-card').forEach(updateScrollFade);
    updateToastOffset();
  });
});

// --- Boot ---
removeLegacyKeys();

if (window.Filters && typeof window.Filters.init === 'function') {
  try {
    window.Filters.init({
      root: $('filters-root'),
      summaryRoot: $('filter-summary-root'),
      onChange: handleFiltersChanged,
      getProcessedIds: () => processedIds
    });
  } catch (error) {
    console.error('Filters failed to start.', error);
  }
}

if (window.ExportUI && typeof window.ExportUI.init === 'function') {
  try {
    window.ExportUI.init({
      root: $('export-root'),
      getSelected: getSortedSelections,
      toast: window.Toast
    });
  } catch (error) {
    console.error('Calendar export failed to start.', error);
  }
}

initHint();

// A phone tab left open for days: refresh quietly when the attendee comes back to it.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && allSessions.length) revalidateInBackground();
});
updateSavedChrome();
updateToastOffset();
loadEvents();
