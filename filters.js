/*
 * filters.js - pre-swipe filters (window.Filters). Owner: filters agent. See CONTRACTS.md section 10.
 *
 *   Filters.init({ root, summaryRoot, onChange, getProcessedIds? })
 *       root = #filters-root, summaryRoot = #filter-summary-root, onChange(stateCopy) after every change.
 *       getProcessedIds (optional) -> Set|string[] of swiped eventIds; used for the "remaining" counts.
 *       Without it, filters.js reads app.js's localStorage key 'event-swiper-processed-ids' (read-only).
 *   Filters.setSessions(allSessions)   full Session[] (unfiltered) for facets/counts; never calls onChange
 *   Filters.apply(sessions) -> Session[]  matching sessions, order preserved, never mutates input
 *   Filters.getState() -> { q, days, venues, types, themes, tags }  (a copy)
 *   Filters.isActive() -> boolean
 *   Filters.open() / Filters.close()   show/hide #filters-overlay (bottom sheet on mobile, side panel on desktop)
 *   Filters.reset()                    clears all filters, persists, re-renders, calls onChange
 *   Filters.refresh()                  (extension) recompute remaining counts after swipes/undo/reset
 *   Filters.activeCount() -> number    (extension) number of active facets (search counts as one)
 *
 * Semantics: AND across facets, OR within a facet. The search query is split on whitespace and every
 * word must appear (case- and accent-insensitive) in the session's title, speaker names, companies,
 * job titles, format or venue (M2020Core.searchText).
 * Persistence: localStorage 'event-swiper-filters' = JSON of the state (sanitised on load; options that
 * no longer exist in the schedule are dropped when sessions arrive).
 */
(function (root) {
  'use strict';

  const STORAGE_KEY = 'event-swiper-filters';
  const PROCESSED_IDS_KEY = 'event-swiper-processed-ids'; // owned by app.js; read-only here
  const FACETS = ['days', 'venues', 'types', 'themes', 'tags'];
  const SEARCH_DEBOUNCE_MS = 150;
  const ANNOUNCE_DELAY_MS = 600;
  const TOPICS_COLLAPSED = 12;
  const SUMMARY_MAX_CHIPS = 10; // hard cap; below it the strip collapses on measured overflow
  const SUMMARY_MORE_RESERVE = 96; // px kept free for the "+N more" chip when picking how many chips fit
  const MAX_VALUES_PER_FACET = 200;
  const MAX_QUERY_LENGTH = 200;
  const DRAG_CLOSE_PX = 110;
  const DRAG_CLOSE_VELOCITY = 0.5; // px per ms

  const FACET_LABELS = {
    days: 'Day',
    venues: 'Stage',
    types: 'Session type',
    themes: 'Theme',
    tags: 'Topic'
  };

  const ICONS = {
    search: '<svg class="fp-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M20 20l-3.5-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    close: '<svg class="fp-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    remove: '<svg class="fs-x" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false"><path d="M7 7l10 10M17 7L7 17" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
    check: '<svg class="fp-check-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    chevron: '<svg class="fp-chevron" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };

  // ---- module state -------------------------------------------------------------------------------
  let rootEl = null;
  let summaryEl = null;
  let onChangeCb = null;
  let getProcessedIdsCb = null;
  let allSessions = [];
  let model = emptyModel();
  let state = emptyState();
  let initialized = false;

  let isOpen = false;
  let hideTimer = null;
  let searchTimer = null;
  let announceTimer = null;
  let openerEl = null;
  let inertedEls = [];
  let topicsExpanded = false;
  let topicQuery = '';
  let drag = null;
  let lastSummaryWidth = -1;

  const hayCache = typeof WeakMap === 'function' ? new WeakMap() : null;

  // ---- helpers ------------------------------------------------------------------------------------
  function core() {
    return root.M2020Core || null;
  }

  function venuesApi() {
    return root.M2020Venues || null;
  }

  function escapeHtml(value) {
    const c = core();
    if (c && typeof c.escapeHtml === 'function') return c.escapeHtml(value);
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fold(value) {
    let s = String(value === null || value === undefined ? '' : value);
    if (typeof s.normalize === 'function') s = s.normalize('NFD');
    return s
      .replace(/[̀-ͯ]/g, '')
      .replace(/[‘’ʼ]/g, "'")
      .replace(/[“”]/g, '"')
      .toLowerCase();
  }

  function queryWords(q) {
    return fold(q).split(/\s+/).filter(Boolean);
  }

  function plural(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
  }

  function idOf(session) {
    return session && session.eventId !== undefined && session.eventId !== null ? String(session.eventId) : '';
  }

  function sessionValues(session, facet) {
    if (!session) return [];
    switch (facet) {
      case 'days': return [session.dateIso || ''];
      case 'venues': return [session.venue || ''];
      case 'types': return [session.eventType || ''];
      case 'themes': return Array.isArray(session.themes) ? session.themes : [];
      case 'tags': return Array.isArray(session.tags) ? session.tags : [];
      default: return [];
    }
  }

  function haystack(session) {
    if (hayCache && session && typeof session === 'object') {
      const cached = hayCache.get(session);
      if (cached !== undefined) return cached;
    }
    const c = core();
    let raw;
    if (c && typeof c.searchText === 'function') {
      raw = c.searchText(session);
    } else {
      const parts = [session.title, session.eventType, session.venue];
      (session.speakers || []).forEach((sp) => {
        if (sp) parts.push(sp.name, sp.company, sp.jobTitle);
      });
      raw = parts.filter(Boolean).join(' • ');
    }
    const hay = fold(raw);
    if (hayCache && session && typeof session === 'object') hayCache.set(session, hay);
    return hay;
  }

  function durationMs(token, fallback) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
      if (!v) return fallback;
      const n = parseFloat(v);
      if (!isFinite(n)) return fallback;
      return /ms$/.test(v) ? n : n * 1000;
    } catch (error) {
      return fallback;
    }
  }

  function matchesMedia(query) {
    try {
      return !!(root.matchMedia && root.matchMedia(query).matches);
    } catch (error) {
      return false;
    }
  }

  function isSheetLayout() {
    return !matchesMedia('(min-width: 900px)');
  }

  // ---- state + persistence ------------------------------------------------------------------------
  function emptyState() {
    return { q: '', days: [], venues: [], types: [], themes: [], tags: [] };
  }

  function sanitize(raw) {
    const s = emptyState();
    if (!raw || typeof raw !== 'object') return s;
    s.q = typeof raw.q === 'string' ? raw.q.slice(0, MAX_QUERY_LENGTH) : '';
    FACETS.forEach((k) => {
      if (!Array.isArray(raw[k])) return;
      const seen = new Set();
      raw[k].forEach((v) => {
        if (typeof v !== 'string' || !v || seen.has(v) || seen.size >= MAX_VALUES_PER_FACET) return;
        seen.add(v);
      });
      s[k] = Array.from(seen);
    });
    return s;
  }

  function load() {
    try {
      const raw = root.localStorage.getItem(STORAGE_KEY);
      return sanitize(raw ? JSON.parse(raw) : null);
    } catch (error) {
      return emptyState();
    }
  }

  function save() {
    try {
      root.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
      // Non-fatal: private mode / quota.
    }
  }

  function copyState() {
    return {
      q: state.q,
      days: state.days.slice(),
      venues: state.venues.slice(),
      types: state.types.slice(),
      themes: state.themes.slice(),
      tags: state.tags.slice()
    };
  }

  function isActive() {
    return !!state.q.trim() || FACETS.some((k) => state[k].length > 0);
  }

  function activeCount() {
    return (state.q.trim() ? 1 : 0) + FACETS.filter((k) => state[k].length > 0).length;
  }

  // ---- matching -----------------------------------------------------------------------------------
  // Returns a predicate for `st`, ignoring facet `except` (used for per-option facet counts).
  function compile(st, except) {
    const sets = {};
    FACETS.forEach((k) => {
      if (k !== except && st[k].length) sets[k] = new Set(st[k]);
    });
    const keys = Object.keys(sets);
    const words = except === 'q' ? [] : queryWords(st.q);
    return function (session) {
      if (!session) return false;
      for (let i = 0; i < keys.length; i += 1) {
        const set = sets[keys[i]];
        const vals = sessionValues(session, keys[i]);
        let hit = false;
        for (let j = 0; j < vals.length; j += 1) {
          if (set.has(vals[j])) { hit = true; break; }
        }
        if (!hit) return false;
      }
      if (words.length) {
        const hay = haystack(session);
        for (let w = 0; w < words.length; w += 1) {
          if (hay.indexOf(words[w]) === -1) return false;
        }
      }
      return true;
    };
  }

  function apply(sessions) {
    const list = Array.isArray(sessions) ? sessions : [];
    if (!isActive()) return list.slice();
    return list.filter(compile(state, null));
  }

  // ---- processed ids (for "remaining" counts) -----------------------------------------------------
  function processedSet() {
    if (typeof getProcessedIdsCb === 'function') {
      try {
        const v = getProcessedIdsCb();
        if (v instanceof Set) return new Set(Array.from(v, String));
        if (Array.isArray(v)) return new Set(v.map(String));
      } catch (error) {
        // fall through to storage
      }
    }
    try {
      const raw = root.localStorage.getItem(PROCESSED_IDS_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return new Set((Array.isArray(arr) ? arr : []).map(String));
    } catch (error) {
      return new Set();
    }
  }

  // ---- facet model (options + labels) -------------------------------------------------------------
  function emptyModel() {
    return { options: { days: [], venues: [], types: [], themes: [], tags: [] }, venueGroups: [], index: {} };
  }

  function dayLabel(iso) {
    const c = core();
    const wd = c && typeof c.weekdayShort === 'function' ? c.weekdayShort(iso) : '';
    const day = /^\d{4}-\d{2}-(\d{2})$/.test(iso) ? String(Number(iso.slice(8))) : '';
    if (wd && day) return `${wd} ${day}`;
    return iso || 'Date TBA';
  }

  function dayLongLabel(iso) {
    const c = core();
    const s = c && typeof c.formatDateShort === 'function' ? c.formatDateShort(iso) : '';
    return s || dayLabel(iso);
  }

  function venueChipLabel(venue) {
    const V = venuesApi();
    if (!V || typeof V.resolve !== 'function') return venue;
    let r = null;
    try {
      r = V.resolve(venue);
    } catch (error) {
      r = null;
    }
    if (!r || !r.known) return venue;
    if (r.group === 'summits' && r.area) return r.area.replace(/,\s*powered by.*$/i, '').trim() || venue;
    return r.room || venue;
  }

  function buildVenueGroups(venueOptions) {
    const V = venuesApi();
    const byValue = {};
    venueOptions.forEach((o) => { byValue[o.value] = o; });

    if (!V || typeof V.groups !== 'function') {
      return [{ id: 'all', label: 'Stages & rooms', options: venueOptions.slice().sort((a, b) => a.label.localeCompare(b.label)) }];
    }

    let defs = [];
    try {
      defs = V.groups() || [];
    } catch (error) {
      defs = [];
    }
    const placed = new Set();
    const groups = defs.map((g) => {
      const opts = [];
      (g.venues || []).forEach((name) => {
        if (byValue[name] && !placed.has(name)) {
          opts.push(byValue[name]);
          placed.add(name);
        }
      });
      return { id: g.id, label: g.label, options: opts };
    });

    // Venues in the data that venues.js lists under another spelling or not at all.
    venueOptions.forEach((o) => {
      if (placed.has(o.value)) return;
      let gid = 'other';
      try {
        gid = typeof V.groupOf === 'function' ? (V.groupOf(o.value) || 'other') : 'other';
      } catch (error) {
        gid = 'other';
      }
      let g = groups.find((x) => x.id === gid);
      if (!g) {
        g = { id: 'other', label: 'Other', options: [] };
        groups.push(g);
      }
      g.options.push(o);
      placed.add(o.value);
    });

    const result = groups.filter((g) => g.options.length);
    // Make chip labels unique inside a group (fall back to the raw venue string).
    result.forEach((g) => {
      const counts = {};
      g.options.forEach((o) => { counts[o.label] = (counts[o.label] || 0) + 1; });
      g.options.forEach((o) => {
        if (counts[o.label] > 1) o.label = o.value;
      });
    });
    return result;
  }

  function buildModel(sessions) {
    const totals = { days: {}, venues: {}, types: {}, themes: {}, tags: {} };
    sessions.forEach((s) => {
      FACETS.forEach((f) => {
        const seen = new Set();
        sessionValues(s, f).forEach((v) => {
          if (typeof v !== 'string' || !v || seen.has(v)) return;
          seen.add(v);
          totals[f][v] = (totals[f][v] || 0) + 1;
        });
      });
    });

    const m = emptyModel();
    const byCount = (a, b) => (b.total - a.total) || a.label.localeCompare(b.label);
    const make = (facet, label) => Object.keys(totals[facet]).map((v) => ({ facet, value: v, label: label(v), total: totals[facet][v] }));

    m.options.days = make('days', dayLabel).sort((a, b) => a.value.localeCompare(b.value));
    m.options.types = make('types', (v) => v).sort(byCount);
    m.options.themes = make('themes', (v) => v).sort(byCount);
    m.options.tags = make('tags', (v) => v).sort(byCount);
    const venueOpts = make('venues', venueChipLabel);
    m.venueGroups = buildVenueGroups(venueOpts);
    m.options.venues = [];
    m.venueGroups.forEach((g) => g.options.forEach((o) => m.options.venues.push(o)));

    FACETS.forEach((f) => {
      m.index[f] = {};
      m.options[f].forEach((o, i) => {
        o.idx = i;
        m.index[f][o.value] = o;
      });
    });
    return m;
  }

  function optionLabel(facet, value) {
    const o = model.index[facet] && model.index[facet][value];
    if (o) return o.label;
    if (facet === 'days') return dayLabel(value);
    if (facet === 'venues') return venueChipLabel(value);
    return value;
  }

  // Drop persisted values that no longer exist in the schedule. Returns true when state changed.
  function pruneState() {
    if (!allSessions.length) return false;
    let changedAny = false;
    FACETS.forEach((f) => {
      const next = state[f].filter((v) => !!model.index[f][v]);
      if (next.length !== state[f].length) {
        state[f] = next;
        changedAny = true;
      }
    });
    return changedAny;
  }

  // ---- counts -------------------------------------------------------------------------------------
  // Facet counts are computed over the sessions the user has not swiped yet (the remaining deck),
  // each option counted with every OTHER facet (and the search) applied.
  function computeCounts() {
    const processed = processedSet();
    const remaining = allSessions.filter((s) => !processed.has(idOf(s)));
    const allSwiped = allSessions.length > 0 && remaining.length === 0;
    const base = allSwiped ? allSessions : remaining;

    const counts = {};
    FACETS.forEach((f) => {
      const map = {};
      const pred = compile(state, f);
      base.forEach((s) => {
        if (!pred(s)) return;
        const seen = new Set();
        sessionValues(s, f).forEach((v) => {
          if (seen.has(v)) return;
          seen.add(v);
          map[v] = (map[v] || 0) + 1;
        });
      });
      counts[f] = map;
    });

    const full = compile(state, null);
    const matchRemaining = remaining.filter(full).length;
    const matchAll = isActive() ? allSessions.filter(full).length : allSessions.length;
    const matchNoQuery = state.q.trim() ? remaining.filter(compile(state, 'q')).length : matchRemaining;
    return {
      matchNoQuery,
      counts,
      matchRemaining,
      matchAll,
      remainingTotal: remaining.length,
      total: allSessions.length,
      allSwiped
    };
  }

  // ---- open-filters button badge ------------------------------------------------------------------
  function updateOpenButton() {
    const btn = document.getElementById('open-filters');
    if (!btn) return;
    const n = activeCount();
    let badge = btn.querySelector('.filters-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'filters-badge';
      badge.setAttribute('aria-hidden', 'true');
      btn.appendChild(badge);
    }
    badge.textContent = n ? String(n) : '';
    badge.hidden = n === 0;
    // Not a toggle: no aria-pressed (it opens a dialog). data-active is the styling hook.
    btn.setAttribute('aria-label', n ? `Filters, ${n} active` : 'Filters');
    btn.removeAttribute('aria-pressed');
    btn.setAttribute('data-active', n ? 'true' : 'false'); // same values app.js uses (styles.css .hdr-btn[data-active="true"])
    btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  }

  // ---- summary strip (#filter-summary-root) -------------------------------------------------------
  function summaryItems() {
    const items = [];
    const q = state.q.trim();
    if (q) items.push({ facet: 'q', value: q, label: `“${q}”`, kind: 'Search' });
    FACETS.forEach((f) => {
      const idx = model.index[f] || {};
      const vals = state[f].slice().sort((a, b) => (idx[a] ? idx[a].idx : 9999) - (idx[b] ? idx[b].idx : 9999));
      vals.forEach((v) => {
        const label = optionLabel(f, v);
        const c = core();
        const short = f === 'types' && c && c.formatShort ? c.formatShort(v) : label;
        items.push({ facet: f, value: v, label, short, kind: FACET_LABELS[f] });
      });
    });
    return items;
  }

  // Renders the strip with every chip; if the chips overflow the row (almost always on a phone with 2+
  // filters) it re-renders with only the chips that fully fit plus a "+N more" chip that opens the sheet,
  // so a chip's remove (x) is never half-hidden behind the edge fade.
  function renderSummary(focusIndex) {
    if (!summaryEl) return;
    if (!isActive()) {
      const hadFocus = summaryEl.contains(document.activeElement);
      summaryEl.innerHTML = '';
      summaryEl.hidden = true;
      if (hadFocus) focusOpenButton();
      return;
    }
    const info = computeCounts();
    const items = summaryItems();
    let fit = items.length > SUMMARY_MAX_CHIPS ? 1 : items.length;
    writeSummary(info, items, fit);

    if (fit > 1) {
      const sc = summaryEl.querySelector('.fs-scroll');
      if (sc && sc.clientWidth > 0 && sc.scrollWidth > sc.clientWidth + 1) {
        // Largest prefix of chips that leaves room for the "+N more" chip, then confirm by measuring.
        const chips = summaryEl.querySelectorAll('[data-fs-remove]');
        const left = sc.getBoundingClientRect().left - sc.scrollLeft;
        const avail = sc.clientWidth - SUMMARY_MORE_RESERVE;
        fit = 1;
        for (let i = 1; i < chips.length; i += 1) {
          if (chips[i].getBoundingClientRect().right - left <= avail) fit = i + 1;
          else break;
        }
        fit = Math.min(fit, items.length - 1);
        writeSummary(info, items, fit);
        let guard = 0;
        while (fit > 1 && guard < 10) {
          const s2 = summaryEl.querySelector('.fs-scroll');
          if (!s2 || s2.scrollWidth <= s2.clientWidth + 1) break;
          fit -= 1;
          guard += 1;
          writeSummary(info, items, fit);
        }
      }
    }
    lastSummaryWidth = summaryEl.clientWidth;

    if (typeof focusIndex === 'number') {
      const btns = summaryEl.querySelectorAll('[data-fs-remove], .fs-more');
      const target = btns[Math.min(focusIndex, btns.length - 1)] || summaryEl.querySelector('[data-fs-clear]');
      if (target) target.focus({ preventScroll: true });
    }
  }

  function writeSummary(info, items, fit) {
    const collapsed = fit < items.length;
    const shown = items.slice(0, fit);
    // "0 left" (not "No matches") when sessions match but every one of them has been swiped already.
    const allSeen = !info.matchRemaining && info.matchAll > 0;
    let countText = 'Filtered';
    let countLabel = 'Filters active';
    if (allSessions.length) {
      if (info.matchRemaining) {
        countText = `${info.matchRemaining} match`;
        countLabel = `${plural(info.matchRemaining, 'session')} match`;
      } else if (allSeen) {
        countText = '0 left';
        countLabel = `All ${plural(info.matchAll, 'matching session')} reviewed`;
      } else {
        countText = 'No matches';
        countLabel = 'No sessions match';
      }
    }

    const chips = shown.map((it, i) => `
      <button type="button" class="fs-chip" data-fs-remove="${i}" title="${escapeHtml(`${it.kind}: ${it.label}`)}"
        aria-label="${escapeHtml(`Remove filter ${it.kind}: ${it.label}`)}">
        <span class="fs-chip-label">${escapeHtml(it.short || it.label)}</span>${ICONS.remove}
      </button>`).join('');
    const hiddenCount = items.length - shown.length;
    const more = collapsed
      ? `<button type="button" class="fs-chip fs-more" data-fs-open title="${escapeHtml(items.slice(fit).map((it) => it.label).join(', '))}"
        aria-label="${escapeHtml(`${plural(hiddenCount, 'more filter')}, edit filters`)}">+${hiddenCount} more</button>`
      : '';

    summaryEl.hidden = false;
    summaryEl.setAttribute('role', 'region');
    summaryEl.setAttribute('aria-label', 'Active filters');
    summaryEl.innerHTML = `
      <button type="button" class="fs-count${info.matchRemaining || allSeen ? '' : ' is-zero'}" data-fs-open
        aria-label="${escapeHtml(`${countLabel}. Edit filters`)}">${escapeHtml(countText)}</button>
      <div class="fs-scroll"><div class="fs-chips">${chips}${more}</div></div>
      <button type="button" class="fs-clear" data-fs-clear>Clear all</button>
    `;
    summaryEl._fsItems = shown;
    updateStripFade();
  }

  // Re-measure the strip when its width changes (rotation, window resize, the app hiding its own
  // count once filters are active).
  function handleSummaryResize() {
    if (!summaryEl || summaryEl.hidden) return;
    const w = summaryEl.clientWidth;
    if (w === lastSummaryWidth) {
      updateStripFade();
      return;
    }
    renderSummaryPreservingFocus();
  }

  // Edge fades only where chips are actually cut off.
  function updateStripFade() {
    const sc = summaryEl && summaryEl.querySelector('.fs-scroll');
    if (!sc) return;
    const max = sc.scrollWidth - sc.clientWidth;
    sc.classList.toggle('fade-l', max > 1 && sc.scrollLeft > 1);
    sc.classList.toggle('fade-r', max > 1 && sc.scrollLeft < max - 1);
  }

  function handleSummaryClick(event) {
    const t = event.target.closest('button');
    if (!t || !summaryEl.contains(t)) return;
    if (t.hasAttribute('data-fs-clear')) {
      reset();
      return;
    }
    if (t.hasAttribute('data-fs-open')) {
      open();
      return;
    }
    if (t.hasAttribute('data-fs-remove')) {
      const i = Number(t.getAttribute('data-fs-remove'));
      const it = (summaryEl._fsItems || [])[i];
      if (!it) return;
      if (it.facet === 'q') {
        clearSearchTimer();
        state.q = '';
      } else {
        state[it.facet] = state[it.facet].filter((v) => v !== it.value);
      }
      changed({ summaryFocus: i });
    }
  }

  function focusOpenButton() {
    const btn = document.getElementById('open-filters');
    if (btn) btn.focus({ preventScroll: true });
  }

  // ---- panel rendering ----------------------------------------------------------------------------
  function chipHtml(o, extraClass) {
    return `<button type="button" class="fp-chip${extraClass ? ' ' + extraClass : ''}" role="checkbox" aria-checked="false"
      data-facet="${o.facet}" data-idx="${o.idx}"${o.label !== o.value ? ` title="${escapeHtml(o.value)}"` : ''}>
      <span class="fp-chip-label">${escapeHtml(o.label)}</span><span class="fp-count" aria-hidden="true">${o.total}</span>
    </button>`;
  }

  function dayChipHtml(o) {
    return `<button type="button" class="fp-day" role="checkbox" aria-checked="false" data-facet="days" data-idx="${o.idx}">
      <span class="fp-day-label">${escapeHtml(o.label)}</span><span class="fp-count" aria-hidden="true">${o.total}</span>
    </button>`;
  }

  function rowHtml(o) {
    return `<button type="button" class="fp-row" role="checkbox" aria-checked="false" data-facet="${o.facet}" data-idx="${o.idx}">
      <span class="fp-box" aria-hidden="true">${ICONS.check}</span>
      <span class="fp-row-label">${escapeHtml(o.label)}</span><span class="fp-count" aria-hidden="true">${o.total}</span>
    </button>`;
  }

  function sectionHead(facet, id, title) {
    return `<div class="fp-section-head">
      <h3 class="fp-section-title" id="${id}">${escapeHtml(title)}<span class="fp-selected-count" data-selected-count="${facet}"></span></h3>
      <button type="button" class="fp-link" data-action="clear-facet" data-facet-clear="${facet}" hidden
        aria-label="${escapeHtml(`Clear ${title.toLowerCase()} filters`)}">Clear</button>
    </div>`;
  }

  function topicsListHtml() {
    const opts = model.options.tags;
    let list;
    if (topicsExpanded) {
      const words = queryWords(topicQuery);
      list = words.length ? opts.filter((o) => words.every((w) => fold(o.label).indexOf(w) !== -1)) : opts;
    } else {
      const selected = new Set(state.tags);
      list = opts.filter((o, i) => i < TOPICS_COLLAPSED || selected.has(o.value));
    }
    if (!list.length) return `<p class="fp-hint">No topics match “${escapeHtml(topicQuery.trim())}”.</p>`;
    return list.map((o) => chipHtml(o)).join('');
  }

  function topicsToggleHtml() {
    const n = model.options.tags.length;
    if (n <= TOPICS_COLLAPSED) return '';
    return `<button type="button" class="fp-link fp-more" data-action="toggle-topics" aria-expanded="${topicsExpanded ? 'true' : 'false'}"
      aria-controls="fp-topics-list">${topicsExpanded ? 'Show fewer' : `Show all ${n}`}${ICONS.chevron}</button>`;
  }

  function topicFinderHtml() {
    if (!topicsExpanded) return '';
    return `<div class="fp-finder">
      <label class="fp-sr" for="fp-topic-q">Find a topic</label>
      <input id="fp-topic-q" class="fp-finder-input" type="search" placeholder="Find a topic" autocomplete="off"
        autocapitalize="off" spellcheck="false" enterkeyhint="done" value="${escapeHtml(topicQuery)}">
    </div>`;
  }

  function renderPanel() {
    if (!rootEl) return;
    const hasData = allSessions.length > 0;
    const venueGroups = model.venueGroups.map((g) => `
      <div class="fp-group">
        <h4 class="fp-eyebrow" id="fp-vg-${escapeHtml(g.id)}">${escapeHtml(g.label)}</h4>
        <div class="fp-chips" role="group" aria-labelledby="fp-vg-${escapeHtml(g.id)}">${g.options.map((o) => chipHtml(o)).join('')}</div>
      </div>`).join('');

    const body = hasData ? `
      <p class="fp-hint fp-intro" data-intro></p>

      <section class="fp-section" aria-labelledby="fp-h-days">
        ${sectionHead('days', 'fp-h-days', 'Day')}
        <div class="fp-days" role="group" aria-labelledby="fp-h-days">${model.options.days.map(dayChipHtml).join('')}</div>
      </section>

      <section class="fp-section" aria-labelledby="fp-h-venues">
        ${sectionHead('venues', 'fp-h-venues', 'Stage')}
        ${venueGroups}
      </section>

      <section class="fp-section" aria-labelledby="fp-h-types">
        ${sectionHead('types', 'fp-h-types', 'Session type')}
        <div class="fp-chips" role="group" aria-labelledby="fp-h-types">${model.options.types.map((o) => chipHtml(o)).join('')}</div>
      </section>

      <section class="fp-section" aria-labelledby="fp-h-themes">
        ${sectionHead('themes', 'fp-h-themes', 'Theme')}
        <div class="fp-rows" role="group" aria-labelledby="fp-h-themes">${model.options.themes.map(rowHtml).join('')}</div>
      </section>

      ${model.options.tags.length ? `
      <section class="fp-section" aria-labelledby="fp-h-tags">
        ${sectionHead('tags', 'fp-h-tags', 'Topic')}
        <div data-topic-finder>${topicFinderHtml()}</div>
        <div class="fp-chips" id="fp-topics-list" role="group" aria-labelledby="fp-h-tags" data-topics>${topicsListHtml()}</div>
        <div data-topics-toggle>${topicsToggleHtml()}</div>
      </section>` : ''}
    ` : '<p class="fp-hint fp-loading">Loading sessions…</p>';

    rootEl.innerHTML = `
      <div class="fp-grabber" data-drag aria-hidden="true"><span class="fp-handle"></span></div>
      <div class="fp-header" data-drag>
        <h2 class="fp-title" id="filters-title">Filters</h2>
        <button type="button" class="fp-link fp-reset" data-action="reset">Reset</button>
        <button type="button" class="fp-close" data-action="close" aria-label="Close filters">${ICONS.close}</button>
      </div>
      <div class="fp-search">
        <span class="fp-search-icon">${ICONS.search}</span>
        <label class="fp-sr" for="filters-q">Search titles, speakers, companies</label>
        <input id="filters-q" class="fp-search-input" type="search" placeholder="Search titles, speakers, companies"
          autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="search"
          maxlength="${MAX_QUERY_LENGTH}" value="${escapeHtml(state.q)}">
        <button type="button" class="fp-search-clear" data-action="clear-q" aria-label="Clear search" hidden>${ICONS.close}</button>
      </div>
      <div class="fp-body" data-scroll>${body}</div>
      <div class="fp-footer">
        <p class="fp-empty" data-empty hidden></p>
        <button type="button" class="fp-primary" data-action="done">Show sessions</button>
      </div>
      <p class="fp-sr" role="status" aria-live="polite" aria-atomic="true" data-live></p>
    `;
    syncPanel();
  }

  function syncPanel() {
    if (!rootEl || !rootEl.firstElementChild) return;
    const info = computeCounts();

    rootEl.querySelectorAll('[data-facet][data-idx]').forEach((el) => {
      const facet = el.getAttribute('data-facet');
      const o = model.options[facet] && model.options[facet][Number(el.getAttribute('data-idx'))];
      if (!o) return;
      const checked = state[facet].indexOf(o.value) !== -1;
      const n = info.counts[facet][o.value] || 0;
      el.setAttribute('aria-checked', checked ? 'true' : 'false');
      const zero = n === 0 && !checked;
      if (zero) el.setAttribute('aria-disabled', 'true');
      else el.removeAttribute('aria-disabled');
      const countEl = el.querySelector('.fp-count');
      if (countEl) countEl.textContent = String(n);
      const name = facet === 'days' ? dayLongLabel(o.value) : o.value;
      el.setAttribute('aria-label', `${name}, ${plural(n, 'session')}`);
    });
    syncRovingTabindex();

    FACETS.forEach((f) => {
      const btn = rootEl.querySelector(`[data-facet-clear="${f}"]`);
      if (btn) btn.hidden = state[f].length === 0;
      const sc = rootEl.querySelector(`[data-selected-count="${f}"]`);
      if (sc) sc.textContent = state[f].length ? ` · ${state[f].length}` : '';
    });

    const resetBtn = rootEl.querySelector('[data-action="reset"]');
    if (resetBtn) resetBtn.disabled = !isActive();

    const input = rootEl.querySelector('#filters-q');
    const clearQ = rootEl.querySelector('[data-action="clear-q"]');
    if (clearQ && input) clearQ.hidden = !input.value;

    const intro = rootEl.querySelector('[data-intro]');
    if (intro) {
      if (info.allSwiped) {
        intro.textContent = `You’ve swiped all ${info.total} sessions. Counts include everything.`;
      } else if (info.remainingTotal === info.total) {
        intro.textContent = 'Narrow the deck before you swipe. Pick as many as you like; counts update as you go.';
      } else {
        intro.textContent = `Counts show the ${plural(info.remainingTotal, 'session')} you haven’t swiped yet.`;
      }
    }

    const primary = rootEl.querySelector('[data-action="done"]');
    const empty = rootEl.querySelector('[data-empty]');
    if (primary && empty) {
      const n = info.matchRemaining;
      primary.classList.remove('is-clear', 'is-clear-q');
      if (!allSessions.length) {
        primary.textContent = 'Done';
        empty.hidden = true;
      } else if (n > 0) {
        primary.textContent = `Show ${plural(n, 'session')}`;
        empty.hidden = true;
      } else if (state.q.trim() && info.matchNoQuery > 0) {
        primary.textContent = 'Clear search';
        primary.classList.add('is-clear-q');
        empty.hidden = false;
        const facetsOn = FACETS.some((k) => state[k].length > 0);
        const without = info.matchNoQuery === 1 ? '1 session matches' : `${info.matchNoQuery} sessions match`;
        empty.textContent = facetsOn
          ? `Nothing matches \u201c${state.q.trim()}\u201d with these filters. ${without} without the search.`
          : `No sessions match \u201c${state.q.trim()}\u201d. Try a speaker, company or a shorter word.`;
      } else if (isActive()) {
        primary.textContent = 'Clear all filters';
        primary.classList.add('is-clear');
        empty.hidden = false;
        empty.textContent = info.matchAll > 0
          ? `You’ve already swiped all ${plural(info.matchAll, 'matching session')}. Remove a filter to see more.`
          : 'No sessions match. Remove a filter or try a different search.';
      } else {
        primary.textContent = 'Done';
        empty.hidden = false;
        empty.textContent = 'You’ve swiped every session.';
      }
    }
    return info;
  }

  // Roving tabindex: each facet section (Day, Stage, Session type, Theme, Topic) is ONE tab stop;
  // Arrow/Home/End move through all of its options (across the Stage sub-groups too; handlePanelKeydown),
  // Space/Enter toggle. The stop is the option last focused in that section, else the first checked one,
  // else the first. Cuts the sheet from ~60 tab stops to ~12.
  function rovingScope(el) {
    return el.closest('.fp-section') || el.closest('[role="group"]');
  }

  function groupOptions(group) {
    return Array.prototype.slice.call(group.querySelectorAll('[data-facet][data-idx]'));
  }

  function setRovingStop(group, target) {
    groupOptions(group).forEach((el) => el.setAttribute('tabindex', el === target ? '0' : '-1'));
  }

  function syncRovingTabindex() {
    if (!rootEl) return;
    rootEl.querySelectorAll('.fp-section').forEach((group) => {
      const items = groupOptions(group);
      if (!items.length) return;
      const active = document.activeElement;
      let stop = items.indexOf(active) !== -1 ? active : null;
      if (!stop) stop = items.find((el) => el.getAttribute('tabindex') === '0') || null;
      if (!stop) stop = items.find((el) => el.getAttribute('aria-checked') === 'true') || items[0];
      setRovingStop(group, stop);
    });
  }

  function handlePanelFocusIn(event) {
    const t = event.target;
    if (!t || !t.hasAttribute || !t.hasAttribute('data-facet') || !t.hasAttribute('data-idx')) return;
    const group = rovingScope(t);
    if (group && t.getAttribute('tabindex') !== '0') setRovingStop(group, t);
  }

  function announceCount() {
    if (!isOpen || !rootEl) return;
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => {
      const live = rootEl.querySelector('[data-live]');
      if (!live || !isOpen) return;
      const info = computeCounts();
      live.textContent = info.matchRemaining ? `${plural(info.matchRemaining, 'session')} match` : 'No sessions match';
    }, ANNOUNCE_DELAY_MS);
  }

  function rerenderTopics() {
    if (!rootEl) return;
    const list = rootEl.querySelector('[data-topics]');
    const toggle = rootEl.querySelector('[data-topics-toggle]');
    const finder = rootEl.querySelector('[data-topic-finder]');
    if (list) list.innerHTML = topicsListHtml();
    if (toggle) toggle.innerHTML = topicsToggleHtml();
    if (finder) finder.innerHTML = topicFinderHtml();
    syncPanel();
  }

  function rerenderTopicList() {
    const list = rootEl && rootEl.querySelector('[data-topics]');
    if (list) list.innerHTML = topicsListHtml();
    syncPanel();
  }

  // ---- change pipeline ----------------------------------------------------------------------------
  function changed(opts) {
    const o = opts || {};
    save();
    renderSummary(o.summaryFocus);
    updateOpenButton();
    if (isOpen) {
      syncPanel();
      announceCount();
    }
    if (typeof onChangeCb === 'function') {
      try {
        onChangeCb(copyState());
      } catch (error) {
        console.warn('Filters onChange handler failed.', error);
      }
    }
  }

  function clearSearchTimer() {
    if (searchTimer) {
      clearTimeout(searchTimer);
      searchTimer = null;
    }
  }

  function commitSearch(value) {
    clearSearchTimer();
    const next = String(value || '').slice(0, MAX_QUERY_LENGTH);
    if (next === state.q) return;
    state.q = next;
    changed();
  }

  function flushSearch() {
    if (!searchTimer || !rootEl) return;
    const input = rootEl.querySelector('#filters-q');
    commitSearch(input ? input.value : state.q);
  }

  function toggleOption(facet, value) {
    const arr = state[facet];
    const i = arr.indexOf(value);
    if (i === -1) arr.push(value);
    else arr.splice(i, 1);
    changed();
  }

  function reset() {
    clearSearchTimer();
    state = emptyState();
    topicQuery = '';
    if (isOpen && rootEl) {
      const input = rootEl.querySelector('#filters-q');
      if (input) input.value = '';
      if (topicsExpanded) rerenderTopics();
    }
    changed();
  }

  // ---- panel events -------------------------------------------------------------------------------
  function handlePanelClick(event) {
    const btn = event.target.closest('button');
    if (!btn || !rootEl.contains(btn)) return;

    if (btn.hasAttribute('data-facet') && btn.hasAttribute('data-idx')) {
      const facet = btn.getAttribute('data-facet');
      const o = model.options[facet] && model.options[facet][Number(btn.getAttribute('data-idx'))];
      if (!o) return;
      if (btn.getAttribute('aria-disabled') === 'true') return;
      flushSearch();
      toggleOption(facet, o.value);
      return;
    }

    const action = btn.getAttribute('data-action');
    switch (action) {
      case 'close':
        close();
        break;
      case 'done':
        if (btn.classList.contains('is-clear-q')) {
          const input = rootEl.querySelector('#filters-q');
          if (input) input.value = '';
          commitSearch('');
          syncPanel();
          btn.focus({ preventScroll: true });
        } else if (btn.classList.contains('is-clear')) {
          reset();
          const first = rootEl.querySelector('#filters-q');
          if (first && !isSheetLayout()) first.focus({ preventScroll: true });
          else btn.focus({ preventScroll: true });
        } else {
          close();
        }
        break;
      case 'reset':
        reset();
        {
          const input = rootEl.querySelector('#filters-q');
          if (input) input.focus({ preventScroll: true });
        }
        break;
      case 'clear-q': {
        const input = rootEl.querySelector('#filters-q');
        if (input) {
          input.value = '';
          input.focus({ preventScroll: true });
        }
        commitSearch('');
        syncPanel();
        break;
      }
      case 'clear-facet': {
        const f = btn.getAttribute('data-facet-clear');
        if (FACETS.indexOf(f) === -1) return;
        flushSearch();
        state[f] = [];
        changed();
        const head = rootEl.querySelector(`#fp-h-${f}`);
        const firstOpt = rootEl.querySelector(`[data-facet="${f}"]`);
        if (firstOpt) firstOpt.focus({ preventScroll: true });
        else if (head) head.focus({ preventScroll: true });
        break;
      }
      case 'toggle-topics':
        topicsExpanded = !topicsExpanded;
        if (!topicsExpanded) topicQuery = '';
        rerenderTopics();
        {
          const next = topicsExpanded
            ? rootEl.querySelector('#fp-topic-q')
            : rootEl.querySelector('[data-action="toggle-topics"]');
          if (next && (topicsExpanded ? !isSheetLayout() : true)) next.focus({ preventScroll: true });
          else {
            const t = rootEl.querySelector('[data-action="toggle-topics"]');
            if (t) t.focus({ preventScroll: true });
          }
        }
        break;
      default:
        break;
    }
  }

  function handlePanelInput(event) {
    const t = event.target;
    if (!t || !t.id) return;
    if (t.id === 'filters-q') {
      const clearQ = rootEl.querySelector('[data-action="clear-q"]');
      if (clearQ) clearQ.hidden = !t.value;
      clearSearchTimer();
      const value = t.value;
      searchTimer = setTimeout(() => commitSearch(value), SEARCH_DEBOUNCE_MS);
    } else if (t.id === 'fp-topic-q') {
      topicQuery = t.value;
      rerenderTopicList();
    }
  }

  function handlePanelKeydown(event) {
    const t = event.target;
    if (event.key === 'Enter' && t && (t.id === 'filters-q' || t.id === 'fp-topic-q')) {
      event.preventDefault();
      if (t.id === 'filters-q') commitSearch(t.value);
      if (isSheetLayout()) t.blur();
      return;
    }
    // Arrow keys move between the options of one facet section (chips / day buttons / theme rows);
    // the section is a single tab stop (roving tabindex, see syncRovingTabindex).
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].indexOf(event.key) !== -1 &&
        t && t.hasAttribute && t.hasAttribute('data-facet') && !event.altKey && !event.ctrlKey && !event.metaKey) {
      const group = rovingScope(t);
      if (!group) return;
      const items = groupOptions(group);
      const i = items.indexOf(t);
      if (i === -1) return;
      let next = i;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = Math.max(0, i - 1);
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = Math.min(items.length - 1, i + 1);
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = items.length - 1;
      event.preventDefault();
      event.stopPropagation();
      if (items[next]) items[next].focus();
    }
  }

  function focusables() {
    if (!rootEl) return [];
    const sel = 'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
    return Array.prototype.slice.call(rootEl.querySelectorAll(sel))
      .filter((el) => !el.hidden && el.tabIndex >= 0 && el.getClientRects().length > 0);
  }

  function handleDocumentKeydown(event) {
    if (!isOpen) return;
    if (document.querySelector('[role="alertdialog"]:not([hidden])')) return; // a confirm dialog sits on top
    if (event.key === 'Escape') {
      const t = event.target;
      if (t && t.id === 'fp-topic-q' && t.value) {
        event.preventDefault();
        t.value = '';
        topicQuery = '';
        rerenderTopicList();
        return;
      }
      if (t && t.id === 'filters-q' && t.value) {
        event.preventDefault();
        t.value = '';
        commitSearch('');
        syncPanel();
        return;
      }
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'Tab') {
      const list = focusables();
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement;
      if (!rootEl.contains(active)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (active === first || active === rootEl)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  // ---- drag-to-close (sheet layout only) ----------------------------------------------------------
  function handlePointerDown(event) {
    if (!isOpen || !isSheetLayout()) return;
    if (event.button !== undefined && event.button !== 0) return;
    const zone = event.target.closest('[data-drag]');
    if (!zone || event.target.closest('button, input, a')) return;
    drag = { id: event.pointerId, startY: event.clientY, lastY: event.clientY, lastT: performance.now(), v: 0, dy: 0 };
    try {
      zone.setPointerCapture(event.pointerId);
    } catch (error) {
      // ignore
    }
    rootEl.classList.add('is-dragging');
  }

  function handlePointerMove(event) {
    if (!drag || event.pointerId !== drag.id) return;
    const now = performance.now();
    const dy = Math.max(0, event.clientY - drag.startY);
    const dt = Math.max(1, now - drag.lastT);
    drag.v = (event.clientY - drag.lastY) / dt;
    drag.lastY = event.clientY;
    drag.lastT = now;
    drag.dy = dy;
    rootEl.style.transform = `translateY(${dy}px)`;
    event.preventDefault();
  }

  function handlePointerUp(event) {
    if (!drag || event.pointerId !== drag.id) return;
    const shouldClose = drag.dy > DRAG_CLOSE_PX || (drag.dy > 24 && drag.v > DRAG_CLOSE_VELOCITY);
    drag = null;
    rootEl.classList.remove('is-dragging');
    rootEl.style.transform = '';
    if (shouldClose) close();
  }

  // ---- open / close -------------------------------------------------------------------------------
  function overlayEl() {
    return document.getElementById('filters-overlay');
  }

  function setBackgroundInert(on) {
    if (on) {
      const overlay = overlayEl();
      inertedEls = [];
      Array.prototype.forEach.call(document.body.children, (el) => {
        if (el === overlay || el.id === 'toast-root' || el.tagName === 'SCRIPT') return;
        if (el.hasAttribute('inert')) return;
        if (el.getAttribute('role') === 'alertdialog') return;
        el.setAttribute('inert', '');
        inertedEls.push(el);
      });
    } else {
      inertedEls.forEach((el) => el.removeAttribute('inert'));
      inertedEls = [];
    }
  }

  function open() {
    const overlay = overlayEl();
    if (!overlay || !rootEl) return;
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    const wasOpen = isOpen;
    if (!wasOpen) {
      const active = document.activeElement;
      openerEl = active && active !== document.body && !rootEl.contains(active) ? active : null;
      topicsExpanded = false;
      topicQuery = '';
    }
    isOpen = true;
    renderPanel();
    const body = rootEl.querySelector('[data-scroll]');
    if (body && !wasOpen) body.scrollTop = 0;
    rootEl.style.transform = '';
    rootEl.setAttribute('tabindex', '-1');

    overlay.style.display = 'flex';
    document.documentElement.classList.add('filters-scroll-lock');
    setBackgroundInert(true);
    updateOpenButton();

    // Force a style flush so the slide-in starts from the hidden state, then reveal. Unlike rAF this also
    // works while rAF is paused (background tabs, some in-app browsers). Same as app.js / export-ui.js.
    void overlay.offsetWidth;
    overlay.classList.add('visible');

    // Desktop with a mouse/trackpad: focus search. Touch/mobile: focus the dialog itself so the
    // on-screen keyboard does not cover the sheet.
    const input = rootEl.querySelector('#filters-q');
    if (!isSheetLayout() && matchesMedia('(pointer: fine)') && input) {
      input.focus({ preventScroll: true });
      try {
        input.setSelectionRange(input.value.length, input.value.length);
      } catch (error) {
        // ignore
      }
    } else {
      rootEl.focus({ preventScroll: true });
    }
  }

  function close() {
    const overlay = overlayEl();
    if (!overlay || !isOpen) return;
    flushSearch();
    isOpen = false;
    drag = null;
    clearTimeout(announceTimer);
    if (rootEl) {
      rootEl.classList.remove('is-dragging');
      rootEl.style.transform = '';
    }
    overlay.classList.remove('visible');
    setBackgroundInert(false);
    document.documentElement.classList.remove('filters-scroll-lock');
    updateOpenButton();

    const target = openerEl && document.contains(openerEl) && !openerEl.disabled ? openerEl : document.getElementById('open-filters');
    openerEl = null;
    if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });

    hideTimer = setTimeout(() => {
      hideTimer = null;
      if (!overlay.classList.contains('visible')) overlay.style.display = 'none';
    }, durationMs('--duration-slow', 500));
  }

  // ---- public: data + refresh ---------------------------------------------------------------------
  function setSessions(sessions) {
    allSessions = Array.isArray(sessions) ? sessions.filter((s) => s && typeof s === 'object') : [];
    model = buildModel(allSessions);
    if (pruneState()) save();
    renderSummary();
    updateOpenButton();
    if (isOpen && rootEl) {
      const body = rootEl.querySelector('[data-scroll]');
      const scroll = body ? body.scrollTop : 0;
      const hadSearchFocus = document.activeElement && document.activeElement.id === 'filters-q';
      renderPanel();
      const nb = rootEl.querySelector('[data-scroll]');
      if (nb) nb.scrollTop = scroll;
      if (hadSearchFocus) {
        const input = rootEl.querySelector('#filters-q');
        if (input) input.focus({ preventScroll: true });
      } else if (!rootEl.contains(document.activeElement)) {
        rootEl.focus({ preventScroll: true });
      }
    }
  }

  function refresh() {
    renderSummaryPreservingFocus();
    if (isOpen) syncPanel();
  }

  function renderSummaryPreservingFocus() {
    if (!summaryEl) return;
    const active = document.activeElement;
    let idx = null;
    if (active && summaryEl.contains(active)) {
      const btns = Array.prototype.slice.call(summaryEl.querySelectorAll('button'));
      idx = btns.indexOf(active);
    }
    renderSummary();
    if (idx !== null && idx !== -1) {
      const btns = summaryEl.querySelectorAll('button');
      if (btns[idx]) btns[idx].focus({ preventScroll: true });
    }
  }

  // Fallback so the "N match" count stays right after swipes even if app.js never calls refresh():
  // app.js rewrites #remaining-count after every deck change.
  function observeDeckCounter() {
    const counter = document.getElementById('remaining-count');
    if (!counter || typeof MutationObserver !== 'function') return;
    let scheduled = false;
    const mo = new MutationObserver(() => {
      if (scheduled || !isActive()) return;
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        renderSummaryPreservingFocus();
      }, 0);
    });
    mo.observe(counter, { childList: true, characterData: true, subtree: true });
  }

  function init(opts) {
    const options = opts || {};
    rootEl = options.root || document.getElementById('filters-root');
    summaryEl = options.summaryRoot || document.getElementById('filter-summary-root');
    onChangeCb = typeof options.onChange === 'function' ? options.onChange : null;
    getProcessedIdsCb = typeof options.getProcessedIds === 'function' ? options.getProcessedIds : null;
    state = load();

    if (initialized) {
      renderSummary();
      updateOpenButton();
      return;
    }
    initialized = true;

    if (rootEl) {
      rootEl.classList.add('filters-panel');
      if (!rootEl.getAttribute('role')) rootEl.setAttribute('role', 'dialog');
      rootEl.setAttribute('aria-modal', 'true');
      rootEl.setAttribute('aria-labelledby', 'filters-title');
      rootEl.addEventListener('click', handlePanelClick);
      rootEl.addEventListener('input', handlePanelInput);
      rootEl.addEventListener('keydown', handlePanelKeydown);
      rootEl.addEventListener('focusin', handlePanelFocusIn);
      rootEl.addEventListener('pointerdown', handlePointerDown);
      rootEl.addEventListener('pointermove', handlePointerMove);
      rootEl.addEventListener('pointerup', handlePointerUp);
      rootEl.addEventListener('pointercancel', handlePointerUp);
    }
    if (summaryEl) {
      summaryEl.classList.add('filters-summary');
      summaryEl.addEventListener('click', handleSummaryClick);
      summaryEl.addEventListener('scroll', updateStripFade, true);
      if (typeof root.ResizeObserver === 'function') {
        new root.ResizeObserver(handleSummaryResize).observe(summaryEl);
      } else {
        root.addEventListener('resize', handleSummaryResize);
      }
    }
    const overlay = overlayEl();
    if (overlay) {
      overlay.classList.add('filters-overlay');
      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) close();
      });
    }
    // Each module closes its own overlay on Escape (app.js only handles #selected-overlay / #about-overlay).
    document.addEventListener('keydown', handleDocumentKeydown);
    observeDeckCounter();
    renderSummary();
    updateOpenButton();
  }

  root.Filters = {
    STORAGE_KEY,
    init,
    setSessions,
    apply,
    getState: copyState,
    isActive,
    activeCount,
    open,
    close,
    reset,
    refresh,
    isOpen: () => isOpen
  };
}(typeof window !== 'undefined' ? window : this));
