/*
 * onboarding.js - welcome / "how it works" / personalization flow (window.Onboarding). Owner: onboarding agent.
 *
 *   Onboarding.open(opts?)   shows the flow ({ step: 1..3 } optional). Pre-filled from the current filters and
 *                            the saved prefs. Closes the More menu / filter sheet / calendar dialog first.
 *   Onboarding.close()       same as Skip or Escape: closes without touching the filters
 *   Onboarding.isOpen() -> boolean
 *
 * First visit (localStorage 'event-swiper-onboarded' !== '1') opens it automatically once the app has booted.
 * People who already have swiped or saved sessions are not interrupted (they get the flag set silently); the
 * flow stays reachable from More > "Personalize & how it works" (#open-setup).
 *
 * Steps: 1 How it works, 2 Tailor it to you (days, formats, interests, live "Your deck: N sessions"),
 *        3 Calendar + appearance, then "Start swiping".
 * Finish applies the choices with Filters.setState (a facet is left empty when everything or nothing is picked),
 * stores localStorage 'event-swiper-prefs' = { days, themes, tags, types, calendar, version: 1 } (export-ui.js
 * reads .calendar), sets 'event-swiper-onboarded' and 'event-swiper-hint-dismissed', closes and focuses the deck.
 * Skip only sets 'event-swiper-onboarded'.
 *
 * Depends on (all optional, degrades gracefully): Filters (options, countFor, setState, getState, onSessions),
 * M2020Core, M2020Theme (get/set 'auto'|'dark'|'light'). Modal behaviour: the wrapper carries .overlay.visible so
 * app.js makes #app inert and mutes its keyboard shortcuts; this file adds its own focus trap and Escape handling.
 * All data is escaped before innerHTML. Classic script, no build step, works from file://.
 */
(function (root) {
  'use strict';

  const ONBOARDED_KEY = 'event-swiper-onboarded';
  const PREFS_KEY = 'event-swiper-prefs';
  const HINT_KEY = 'event-swiper-hint-dismissed';
  const PROCESSED_KEY = 'event-swiper-processed-ids'; // owned by app.js; read-only here
  const SELECTED_KEY = 'event-swiper-selected';       // owned by app.js; read-only here
  const PREFS_VERSION = 1;
  const STEPS = 3;
  const TOP_TOPICS = 10;
  const EXIT_MS = 260;
  const MENU_CLOSE_WAIT_MS = 170; // app.js restores focus ~1 frame (<= 100 ms) after the menu closes
  const LIVE_DEBOUNCE_MS = 450;
  const FALLBACK_DAYS = ['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21'];

  // Existing session types, grouped for people who think in "panels" and "podcasts", not 15 type names.
  // Types in the schedule that are not listed here land in an extra "Other formats" group.
  const FORMAT_GROUPS = [
    { id: 'talks', label: 'Panels & talks', types: ['Panel Discussion', 'Fireside Chat', 'Presentation', 'Debate', 'Roundtable', 'Welcome Address'] },
    { id: 'pitches', label: 'Pitches & launches', types: ['Startup Pitch', 'Product Pitch', 'Announcement'] },
    { id: 'workshops', label: 'Workshops', types: ['Workshop'] },
    { id: 'podcasts', label: 'Podcasts', types: ['Podcast'] },
    { id: 'social', label: 'Networking & social', types: ['Networking', 'Meetup', 'Meet & Greet', 'Content / Awards'] }
  ];

  // Keys match export-ui.js OPTIONS (+ 'file' for the .ics download).
  const CALENDARS = [
    { key: 'google', label: 'Google Calendar', sub: 'Personal or Google Workspace', phoneSub: 'Copies a link to open on a computer' },
    { key: 'outlookWork', label: 'Outlook (work or school)', sub: 'Microsoft 365' },
    { key: 'outlookPersonal', label: 'Outlook.com (personal)', sub: 'Outlook.com, Hotmail, Live' },
    { key: 'apple', label: 'Apple Calendar', sub: 'iPhone, iPad, Mac' },
    { key: 'file', label: 'I’ll download a file', sub: 'An .ics file works with any calendar app' }
  ];
  const CALENDAR_KEYS = CALENDARS.map((c) => c.key);
  const THEME_MODES = [
    { key: 'auto', label: 'Auto' },
    { key: 'dark', label: 'Dark' },
    { key: 'light', label: 'Light' }
  ];

  // ---------- module state ----------
  let opened = false;
  let mode = 'first';      // 'first' | 'reopen'
  let step = 1;
  let model = null;
  let ui = null;           // { overlay, card, body, foot, top, dots, live, title, opts, lastFocus }
  let liveTimer = 0;
  let exitTimer = 0;

  // ---------- small helpers ----------

  function esc(value) {
    const C = root.M2020Core;
    if (C && typeof C.escapeHtml === 'function') return C.escapeHtml(value);
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function plural(n, one, many) {
    return `${n} ${n === 1 ? one : (many || `${one}s`)}`;
  }

  function matches(query) {
    try {
      return !!(root.matchMedia && root.matchMedia(query).matches);
    } catch (error) {
      return false;
    }
  }

  function reducedMotion() {
    return matches('(prefers-reduced-motion: reduce)');
  }

  // Same rule as export-ui.js: Google only adds calendars by URL in a computer browser.
  function isPhone() {
    return matches('(pointer: coarse)') && !matches('(min-width: 900px)');
  }

  function sameList(a, b) {
    const x = Array.isArray(a) ? a : [];
    const y = Array.isArray(b) ? b : [];
    if (x.length !== y.length) return false;
    const set = new Set(x);
    return y.every((v) => set.has(v));
  }

  // ---------- storage (every access guarded: private mode, sandboxed iframes) ----------

  function lsGet(key) {
    try {
      return root.localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function lsSet(key, value) {
    try {
      root.localStorage.setItem(key, value);
      return true;
    } catch (error) {
      return false;
    }
  }

  function readJson(key) {
    try {
      const raw = lsGet(key);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      return null;
    }
  }

  function isOnboarded() {
    return lsGet(ONBOARDED_KEY) === '1';
  }

  function markOnboarded() {
    lsSet(ONBOARDED_KEY, '1');
  }

  // Swiped or saved something before onboarding existed: not a first-time visitor.
  function hasProgress() {
    const processed = readJson(PROCESSED_KEY);
    const selected = readJson(SELECTED_KEY);
    return (Array.isArray(processed) && processed.length > 0) || (Array.isArray(selected) && selected.length > 0);
  }

  function readPrefs() {
    const out = { days: [], themes: [], tags: [], types: [], calendar: '', version: PREFS_VERSION };
    const p = readJson(PREFS_KEY);
    if (!p || typeof p !== 'object') return out;
    ['days', 'themes', 'tags', 'types'].forEach((k) => {
      if (Array.isArray(p[k])) out[k] = p[k].filter((v) => typeof v === 'string' && v).slice(0, 200);
    });
    if (typeof p.calendar === 'string' && CALENDAR_KEYS.indexOf(p.calendar) !== -1) out.calendar = p.calendar;
    return out;
  }

  function writePrefs(prefs) {
    lsSet(PREFS_KEY, JSON.stringify({
      days: prefs.days || [],
      themes: prefs.themes || [],
      tags: prefs.tags || [],
      types: prefs.types || [],
      calendar: prefs.calendar || '',
      version: PREFS_VERSION
    }));
  }

  // ---------- data access (Filters / Core / Theme) ----------

  function F() {
    return root.Filters && typeof root.Filters === 'object' ? root.Filters : null;
  }

  function emptyOptions() {
    return { loaded: false, total: 0, remaining: 0, days: [], venues: [], types: [], themes: [], tags: [] };
  }

  function readOptions() {
    const f = F();
    if (f && typeof f.options === 'function') {
      try {
        return f.options();
      } catch (error) {
        console.warn('Onboarding: Filters.options failed.', error);
      }
    }
    return emptyOptions();
  }

  function opts() {
    return ui ? ui.opts : emptyOptions();
  }

  function currentFilterState() {
    const f = F();
    if (f && typeof f.getState === 'function') {
      try {
        return f.getState();
      } catch (error) {
        // fall through
      }
    }
    return null;
  }

  function themeApi() {
    const t = root.M2020Theme;
    return t && typeof t.set === 'function' && typeof t.get === 'function' ? t : null;
  }

  function conferenceDays() {
    const C = root.M2020Core;
    const days = C && C.CONFERENCE && Array.isArray(C.CONFERENCE.days) ? C.CONFERENCE.days : null;
    return (days && days.length ? days : FALLBACK_DAYS).slice();
  }

  // "2026-10-18" -> { key: 'sun', dow: 'Sun', num: '18', long: 'Sunday 18 October' }
  function dayInfo(iso) {
    const C = root.M2020Core;
    const dow = C && typeof C.weekdayShort === 'function' ? C.weekdayShort(iso) : '';
    const long = C && typeof C.formatDateLong === 'function' ? C.formatDateLong(iso) : '';
    const m = /^\d{4}-\d{2}-(\d{2})$/.exec(String(iso || ''));
    return { key: dow.toLowerCase(), dow: dow || String(iso), num: m ? String(Number(m[1])) : '', long: long || String(iso) };
  }

  // ---------- icons ----------

  function ico(inner) {
    return `<svg class="ob-ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${inner}</svg>`;
  }

  const ICONS = {
    tune: ico('<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>'),
    swipe: ico('<rect x="7.5" y="4.5" width="9" height="15" rx="2.2"/><path d="M5 9.2L2.6 12 5 14.8M19 9.2l2.4 2.8-2.4 2.8"/>'),
    calendar: ico('<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4M8.6 15.2l2.3 2.3 4.5-4.7"/>'),
    lock: ico('<rect x="5" y="10.5" width="14" height="9.5" rx="2.2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>'),
    check: ico('<path d="M5.5 12.5l4.2 4.2L18.5 8"/>'),
    chevron: ico('<path d="M6 9.5l6 6 6-6"/>')
  };

  // ---------- model (what the person has picked so far) ----------
  //
  // days / groups: null = nothing customised yet = everything selected; otherwise a Set of the selected ones.
  // An empty selection is treated as "no restriction" when applied (same as the filter sheet).

  function buildModel() {
    const prefs = readPrefs();
    const state = currentFilterState();
    const src = state || prefs;
    return {
      days: src.days && src.days.length ? new Set(src.days) : null,
      groups: null,
      groupsReady: false,
      typesTouched: false,
      typesSource: Array.isArray(src.types) ? src.types.slice() : [],
      tags: new Set(src.tags || []),
      themes: new Set(src.themes || []),
      calendar: prefs.calendar,
      topicsExpanded: false
    };
  }

  // Format chips are groups of types, so they can only be resolved once the schedule's types are known.
  function resolveModel() {
    const o = opts();
    if (!model || model.groupsReady || !o.types.length) return;
    model.groupsReady = true;
    if (!model.typesSource.length) {
      model.groups = null;
      return;
    }
    const groups = formatGroups(o);
    model.groups = new Set(groups.filter((g) => g.types.some((t) => model.typesSource.indexOf(t) !== -1)).map((g) => g.id));
  }

  function formatGroups(o) {
    if (!o.types.length) return [];
    const byType = {};
    o.types.forEach((t) => { byType[t.value] = t; });
    const used = new Set();
    const groups = FORMAT_GROUPS.map((def) => {
      const types = def.types.filter((t) => byType[t]);
      types.forEach((t) => used.add(t));
      return { id: def.id, label: def.label, types, count: types.reduce((sum, t) => sum + byType[t].total, 0) };
    }).filter((g) => g.types.length);
    const rest = o.types.filter((t) => !used.has(t.value));
    if (rest.length) {
      groups.push({ id: 'other', label: 'Other formats', types: rest.map((t) => t.value), count: rest.reduce((sum, t) => sum + t.total, 0) });
    }
    return groups;
  }

  function dayList(o) {
    if (o.days.length) return o.days.map((d) => ({ value: d.value, count: d.total }));
    return conferenceDays().map((v) => ({ value: v, count: null }));
  }

  function isSelected(kind, value) {
    if (kind === 'days') return model.days === null || model.days.has(value);
    if (kind === 'groups') return model.groups === null || model.groups.has(value);
    if (kind === 'tags') return model.tags.has(value);
    if (kind === 'themes') return model.themes.has(value);
    return false;
  }

  function toggleSelection(kind, value) {
    if (kind === 'days' && model.days === null) model.days = new Set(dayList(opts()).map((d) => d.value));
    if (kind === 'groups') {
      if (model.groups === null) model.groups = new Set(formatGroups(opts()).map((g) => g.id));
      model.typesTouched = true;
    }
    const set = kind === 'days' ? model.days : (kind === 'groups' ? model.groups : model[kind]);
    if (!set) return false;
    if (set.has(value)) set.delete(value);
    else set.add(value);
    return set.has(value);
  }

  // The facets this model would apply. A facet with everything or nothing picked is [] (no restriction).
  // `types` is only present once the person touched a format chip, so a custom set made in the filter sheet
  // survives a visit to the calendar step.
  function computePartial() {
    const o = opts();
    const partial = {};
    const allDays = dayList(o).map((d) => d.value);
    const days = model.days === null ? [] : allDays.filter((v) => model.days.has(v));
    partial.days = days.length === 0 || days.length === allDays.length ? [] : days;

    if (model.typesTouched) {
      const groups = formatGroups(o);
      const picked = groups.filter((g) => model.groups === null || model.groups.has(g.id));
      partial.types = picked.length === 0 || picked.length === groups.length
        ? []
        : picked.reduce((all, g) => all.concat(g.types), []);
    }

    partial.tags = o.tags.length ? o.tags.map((t) => t.value).filter((v) => model.tags.has(v)) : Array.from(model.tags);
    partial.themes = o.themes.length ? o.themes.map((t) => t.value).filter((v) => model.themes.has(v)) : Array.from(model.themes);
    return partial;
  }

  // Sessions still to swipe if `partial` were applied on top of the filters the person already has (stage, search).
  function deckCount() {
    const o = opts();
    const f = F();
    if (!o.loaded || !f || typeof f.countFor !== 'function') return { n: null, left: false };
    try {
      const base = currentFilterState() || {};
      const merged = Object.assign({}, base, computePartial());
      return { n: f.countFor(merged), left: o.remaining < o.total };
    } catch (error) {
      console.warn('Onboarding: Filters.countFor failed.', error);
      return { n: null, left: false };
    }
  }

  function captionDays() {
    const list = dayList(opts()).map((d) => d.value);
    const picked = model.days === null ? list : list.filter((v) => model.days.has(v));
    if (picked.length === 0 || picked.length === list.length) return `All ${list.length} days`;
    return picked.map((v) => dayInfo(v).dow).join(', ');
  }

  function captionFormats() {
    const groups = formatGroups(opts());
    const picked = groups.filter((g) => model.groups === null || model.groups.has(g.id));
    if (picked.length === 0 || picked.length === groups.length) return 'All formats';
    return `${picked.length} of ${groups.length}`;
  }

  function captionInterests() {
    const n = model.tags.size + model.themes.size;
    return n ? `${n} picked` : 'Optional';
  }

  // ---------- markup ----------

  function chipHtml(kind, value, label, count) {
    const on = isSelected(kind, value);
    return `<button type="button" class="ob-chip" role="checkbox" aria-checked="${on}" data-ob-toggle="${kind}" data-value="${esc(value)}">
      <span class="ob-box" aria-hidden="true">${ICONS.check}</span><span class="ob-chip-label">${esc(label)}</span>${
        count == null ? '' : `<span class="ob-chip-n" aria-hidden="true">${count}</span>`}
    </button>`;
  }

  function step1Html() {
    const o = opts();
    const total = o.loaded ? String(o.total) : '300+';
    const days = o.days.length || conferenceDays().length;
    return `
    <div class="ob-step" data-step="1">
      <p class="ob-eyebrow">How it works</p>
      <h2 class="ob-title" id="ob-title" tabindex="-1">Pick your Money20/20 sessions in minutes</h2>
      <p class="ob-lede">An unofficial helper for Money20/20 USA 2026 · Oct 18–21 · Las Vegas.</p>
      <ol class="ob-loop">
        <li class="ob-loop-item">
          <span class="ob-loop-ico" aria-hidden="true">${ICONS.tune}</span>
          <div class="ob-loop-text">
            <h3>Tune your deck</h3>
            <p>Choose your days, formats and topics so you only see what fits.</p>
          </div>
        </li>
        <li class="ob-loop-item">
          <span class="ob-loop-ico" aria-hidden="true">${ICONS.swipe}</span>
          <div class="ob-loop-text">
            <h3>Swipe</h3>
            <p><strong>Right</strong> to save, <strong>left</strong> to skip. Undo anytime. On a computer, use the arrow keys.</p>
          </div>
        </li>
        <li class="ob-loop-item">
          <span class="ob-loop-ico" aria-hidden="true">${ICONS.calendar}</span>
          <div class="ob-loop-text">
            <h3>Add everything to your calendar</h3>
            <p>One tap adds all your saves. They show as free and tentative in their own “Money20/20” calendar, so they never block a meeting.</p>
          </div>
        </li>
      </ol>
      <ul class="ob-facts" aria-label="What to expect">
        <li><strong>${esc(total)}</strong><span>sessions over ${esc(days)} days</span></li>
        <li><strong>10–30</strong><span>saved by most people</span></li>
        <li><strong>5–10</strong><span>minutes to pick yours</span></li>
      </ul>
      <p class="ob-privacy">${ICONS.lock}<span>Everything stays on this device. Only when you subscribe a calendar are your saved session IDs sent to build the feed.</span></p>
    </div>`;
  }

  function daysSectionHtml(o) {
    const chips = dayList(o).map((d) => {
      const info = dayInfo(d.value);
      const label = `${info.long}${d.count == null ? '' : `, ${plural(d.count, 'session')}`}`;
      return `<button type="button" class="ob-day" role="checkbox" aria-checked="${isSelected('days', d.value)}"
        data-ob-toggle="days" data-value="${esc(d.value)}"${info.key ? ` data-day="${esc(info.key)}"` : ''} aria-label="${esc(label)}">
        <span class="ob-day-dow" aria-hidden="true">${esc(info.dow)}</span>
        <span class="ob-day-num" aria-hidden="true">${esc(info.num)}</span>
        <span class="ob-day-count" aria-hidden="true">${d.count == null ? '&nbsp;' : esc(d.count)}</span>
        <span class="ob-day-check" aria-hidden="true">${ICONS.check}</span>
      </button>`;
    }).join('');
    return `
      <section class="ob-group" aria-labelledby="ob-g-days">
        <div class="ob-group-head">
          <h3 id="ob-g-days">Which days are you attending?</h3>
          <span class="ob-caption" data-ob-caption="days">${esc(captionDays())}</span>
        </div>
        <div class="ob-days" role="group" aria-labelledby="ob-g-days">${chips}</div>
      </section>`;
  }

  function formatsSectionHtml(o) {
    const groups = formatGroups(o);
    const body = groups.length
      ? `<div class="ob-chips" role="group" aria-labelledby="ob-g-formats">${
        groups.map((g) => chipHtml('groups', g.id, g.label, g.count)).join('')}</div>`
      : '<p class="ob-pending">Formats appear once the schedule has loaded.</p>';
    return `
      <section class="ob-group" aria-labelledby="ob-g-formats">
        <div class="ob-group-head">
          <h3 id="ob-g-formats">Which formats interest you?</h3>
          <span class="ob-caption" data-ob-caption="formats">${esc(groups.length ? captionFormats() : '')}</span>
        </div>
        ${body}
      </section>`;
  }

  function interestsInnerHtml(o) {
    if (!o.tags.length && !o.themes.length) return '<p class="ob-pending">Topics appear once the schedule has loaded.</p>';
    const expanded = model.topicsExpanded;
    const tags = o.tags.filter((t, i) => expanded || i < TOP_TOPICS || model.tags.has(t.value));
    let html = `<div class="ob-chips" role="group" aria-labelledby="ob-g-topics">${
      tags.map((t) => chipHtml('tags', t.value, t.label, t.total)).join('')}</div>`;
    if (expanded && o.themes.length) {
      html += `<p class="ob-subhead" id="ob-g-themes">Conference themes</p>
        <div class="ob-chips" role="group" aria-labelledby="ob-g-themes">${
        o.themes.map((t) => chipHtml('themes', t.value, t.label, t.total)).join('')}</div>`;
    }
    if (expanded && o.themes.length) {
      html += `<p class="ob-hint" data-ob-combine${model.tags.size && model.themes.size ? '' : ' hidden'}>Topics and themes combine: a session has to match one of each.</p>`;
    }
    const hiddenTags = o.tags.length - tags.length;
    if (hiddenTags > 0 || o.themes.length) {
      const what = o.themes.length ? `${o.tags.length} topics and ${o.themes.length} themes` : `${o.tags.length} topics`;
      html += `<button type="button" class="ob-link" data-ob-action="more" aria-expanded="${expanded}">${
        expanded ? 'Show fewer' : `Show all ${esc(what)}`}<span class="ob-link-chev" aria-hidden="true">${ICONS.chevron}</span></button>`;
    } else if (expanded) {
      html += '<button type="button" class="ob-link" data-ob-action="more" aria-expanded="true">Show fewer</button>';
    }
    return html;
  }

  function step2Html() {
    const o = opts();
    return `
    <div class="ob-step" data-step="2">
      <p class="ob-eyebrow">Tailor it to you</p>
      <h2 class="ob-title" id="ob-title" tabindex="-1">What do you want to see?</h2>
      <p class="ob-lede">All optional. You can change this any time in Filters.</p>
      ${daysSectionHtml(o)}
      ${formatsSectionHtml(o)}
      <section class="ob-group" aria-labelledby="ob-g-topics">
        <div class="ob-group-head">
          <h3 id="ob-g-topics">What are you into?</h3>
          <span class="ob-caption" data-ob-caption="interests">${esc(captionInterests())}</span>
        </div>
        <div data-ob-interests>${interestsInnerHtml(o)}</div>
      </section>
    </div>`;
  }

  function calendarsHtml() {
    const phone = isPhone();
    return CALENDARS.map((c) => `
        <button type="button" class="ob-cal" aria-pressed="${model.calendar === c.key}" data-ob-cal="${esc(c.key)}">
          <span class="ob-cal-ico" aria-hidden="true">${ICONS.calendar}</span>
          <span class="ob-cal-text">
            <span class="ob-cal-label">${esc(c.label)}</span>
            <span class="ob-cal-sub">${esc(phone && c.phoneSub ? c.phoneSub : c.sub)}</span>
          </span>
          <span class="ob-cal-mark" aria-hidden="true">${ICONS.check}</span>
        </button>`).join('');
  }

  function appearanceHtml(theme) {
    let current = 'auto';
    try {
      current = String(theme.get() || 'auto');
    } catch (error) {
      current = 'auto';
    }
    if (!THEME_MODES.some((m) => m.key === current)) current = 'auto';
    return `
      <section class="ob-group" aria-labelledby="ob-g-theme">
        <div class="ob-group-head"><h3 id="ob-g-theme">Appearance</h3></div>
        <div class="ob-seg" role="radiogroup" aria-labelledby="ob-g-theme">${THEME_MODES.map((m) => `
          <button type="button" class="ob-seg-btn" role="radio" aria-checked="${m.key === current}" tabindex="${m.key === current ? 0 : -1}" data-ob-theme="${m.key}">${esc(m.label)}</button>`).join('')}
        </div>
        <p class="ob-hint">Auto follows your device setting.</p>
      </section>`;
  }

  function step3Html() {
    const theme = themeApi();
    return `
    <div class="ob-step" data-step="3">
      <p class="ob-eyebrow">${theme ? 'Calendar &amp; look' : 'Your calendar'}</p>
      <h2 class="ob-title" id="ob-title" tabindex="-1">Where should your picks go?</h2>
      <p class="ob-lede">Optional. We’ll list your calendar first when you add your picks; every option stays available.</p>
      <section class="ob-group" aria-labelledby="ob-g-cal">
        <div class="ob-group-head"><h3 id="ob-g-cal">Which calendar do you use?</h3></div>
        <div class="ob-cals" role="group" aria-labelledby="ob-g-cal">${calendarsHtml()}</div>
      </section>
      ${theme ? appearanceHtml(theme) : ''}
    </div>`;
  }

  function stepHtml(n) {
    if (n === 1) return step1Html();
    if (n === 2) return step2Html();
    return step3Html();
  }

  function dotsHtml() {
    let html = '';
    for (let i = 1; i <= STEPS; i += 1) {
      html += `<span class="ob-dot${i === step ? ' is-current' : (i < step ? ' is-done' : '')}"></span>`;
    }
    return html;
  }

  function footHtml() {
    const last = step === STEPS;
    return `
      <p class="ob-note" data-ob-note></p>
      <div class="ob-actions">
        <button type="button" class="ob-btn ob-btn--ghost" data-ob-action="back"${step === 1 ? ' hidden' : ''}>Back</button>
        <button type="button" class="ob-btn ob-btn--primary" data-ob-action="${last ? 'finish' : 'next'}" data-ob-cta>${last ? (mode === 'first' ? 'Start swiping' : 'Apply changes') : 'Next'}</button>
      </div>`;
  }

  // ---------- rendering + live updates ----------

  function renderStep(dir, keepFocus) {
    if (!ui) return;
    let refocus = null;
    if (keepFocus && ui.body.contains(document.activeElement)) {
      const a = document.activeElement;
      refocus = {
        toggle: a.getAttribute('data-ob-toggle'),
        value: a.getAttribute('data-value'),
        action: a.getAttribute('data-ob-action'),
        cal: a.getAttribute('data-ob-cal'),
        theme: a.getAttribute('data-ob-theme')
      };
    }
    const scroll = keepFocus ? ui.body.scrollTop : 0;
    ui.body.innerHTML = stepHtml(step);
    ui.title = ui.body.querySelector('#ob-title');
    const stepEl = ui.body.firstElementChild;
    if (dir && stepEl && !reducedMotion()) stepEl.classList.add(dir > 0 ? 'is-fwd' : 'is-back');
    ui.body.scrollTop = scroll;
    if (refocus) {
      let sel = '';
      if (refocus.toggle) sel = `[data-ob-toggle="${refocus.toggle}"][data-value="${cssEscape(refocus.value)}"]`;
      else if (refocus.action) sel = `[data-ob-action="${refocus.action}"]`;
      else if (refocus.cal) sel = `[data-ob-cal="${refocus.cal}"]`;
      else if (refocus.theme) sel = `[data-ob-theme="${refocus.theme}"]`;
      const el = sel ? ui.body.querySelector(sel) : null;
      if (el) el.focus({ preventScroll: true });
    }
    // The focused node (the heading, or a chip that no longer exists) was replaced: keep focus inside the dialog,
    // otherwise app.js's generic overlay logic would drop it on the first button (Skip).
    if (keepFocus && ui.title && !ui.card.contains(document.activeElement)) ui.title.focus({ preventScroll: true });
  }

  function cssEscape(value) {
    return String(value == null ? '' : value).replace(/["\\]/g, '\\$&');
  }

  function renderChrome() {
    if (!ui) return;
    ui.dots.innerHTML = dotsHtml();
    ui.dots.setAttribute('aria-label', `Step ${step} of ${STEPS}`);
    ui.foot.innerHTML = footHtml();
    const skip = ui.top.querySelector('[data-ob-action="skip"]');
    if (skip) skip.textContent = mode === 'first' ? 'Skip' : 'Close';
    updateCount(false);
    syncFootHeight();
  }

  // Toasts sit above everything, so lift them clear of the footer: distance from the bottom of the viewport to the
  // footer's top edge (the card floats above the bottom on wide screens; offsets ignore the enter transform).
  function syncFootHeight() {
    if (!ui) return;
    const top = ui.card.offsetTop + ui.foot.offsetTop;
    document.documentElement.style.setProperty('--ob-toast-bottom', `${Math.max(0, Math.round(root.innerHeight - top))}px`);
  }

  function ctaLabel(c) {
    const base = mode === 'first' ? 'Start swiping' : 'Apply changes';
    return c.n ? `${base} (${plural(c.n, 'session')})` : base;
  }

  // Footer count + final button label + captions. `speak` = announce the count to screen readers.
  function updateCount(speak) {
    if (!ui) return;
    const note = ui.foot.querySelector('[data-ob-note]');
    const cta = ui.foot.querySelector('[data-ob-cta]');
    if (!note) return;
    if (step === 1) {
      note.classList.remove('is-warn');
      note.textContent = 'Change any of this later in More › Personalize.';
      return;
    }
    const c = deckCount();
    let spoken;
    if (c.n === null) {
      note.classList.remove('is-warn');
      note.textContent = 'Loading sessions…';
      spoken = '';
    } else if (c.n === 0) {
      note.classList.add('is-warn');
      note.textContent = 'No sessions match these picks';
      spoken = 'No sessions match these picks';
    } else {
      note.classList.remove('is-warn');
      note.innerHTML = `Your deck: <strong>${c.n}</strong> ${c.n === 1 ? 'session' : 'sessions'}${c.left ? ' left' : ''}`;
      spoken = `Your deck: ${plural(c.n, 'session')}${c.left ? ' left' : ''}`;
    }
    if (cta && step === STEPS) cta.textContent = ctaLabel(c);
    if (speak && spoken) announce(spoken);
  }

  function updateCaptions() {
    if (!ui) return;
    const set = (name, text) => {
      const el = ui.body.querySelector(`[data-ob-caption="${name}"]`);
      if (el) el.textContent = text;
    };
    set('days', captionDays());
    if (formatGroups(opts()).length) set('formats', captionFormats());
    set('interests', captionInterests());
    const combine = ui.body.querySelector('[data-ob-combine]');
    if (combine) combine.hidden = !(model.tags.size && model.themes.size);
  }

  function announce(text) {
    if (!ui) return;
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => {
      if (ui) ui.live.textContent = text;
    }, LIVE_DEBOUNCE_MS);
  }

  function rerenderInterests() {
    const host = ui && ui.body.querySelector('[data-ob-interests]');
    if (!host) return;
    host.innerHTML = interestsInnerHtml(opts());
  }

  // ---------- events ----------

  function go(delta) {
    const next = Math.min(STEPS, Math.max(1, step + delta));
    if (next === step) return;
    step = next;
    renderChrome();
    renderStep(delta);
    if (ui.title) ui.title.focus({ preventScroll: true });
    ui.body.scrollTop = 0;
  }

  function onClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !ui) return;

    const toggle = target.closest('[data-ob-toggle]');
    if (toggle) {
      const kind = toggle.getAttribute('data-ob-toggle');
      const on = toggleSelection(kind, toggle.getAttribute('data-value'));
      toggle.setAttribute('aria-checked', on ? 'true' : 'false');
      updateCaptions();
      updateCount(true);
      return;
    }

    const cal = target.closest('[data-ob-cal]');
    if (cal) {
      const key = cal.getAttribute('data-ob-cal');
      model.calendar = model.calendar === key ? '' : key;
      ui.body.querySelectorAll('[data-ob-cal]').forEach((el) => {
        el.setAttribute('aria-pressed', el.getAttribute('data-ob-cal') === model.calendar ? 'true' : 'false');
      });
      return;
    }

    const themeBtn = target.closest('[data-ob-theme]');
    if (themeBtn) {
      chooseTheme(themeBtn.getAttribute('data-ob-theme'));
      return;
    }

    const actionEl = target.closest('[data-ob-action]');
    if (!actionEl) return;
    switch (actionEl.getAttribute('data-ob-action')) {
      case 'skip': skip(); break;
      case 'back': go(-1); break;
      case 'next': go(1); break;
      case 'finish': finish(); break;
      case 'more':
        model.topicsExpanded = !model.topicsExpanded;
        rerenderInterests();
        {
          const btn = ui.body.querySelector('[data-ob-action="more"]');
          if (btn) btn.focus({ preventScroll: true });
        }
        break;
      default: break;
    }
  }

  // Reflect the saved appearance preference in the Auto / Dark / Light control (roving tabindex on the chosen one).
  function syncThemeControl(fallback) {
    const theme = themeApi();
    if (!ui || !theme) return;
    let applied = fallback || 'auto';
    try {
      applied = String(theme.get() || applied);
    } catch (error) {
      // keep the fallback
    }
    ui.body.querySelectorAll('[data-ob-theme]').forEach((el) => {
      const on = el.getAttribute('data-ob-theme') === applied;
      el.setAttribute('aria-checked', on ? 'true' : 'false');
      el.setAttribute('tabindex', on ? '0' : '-1');
    });
  }

  function chooseTheme(modeKey) {
    const theme = themeApi();
    if (!theme || !THEME_MODES.some((m) => m.key === modeKey)) return;
    try {
      theme.set(modeKey);
    } catch (error) {
      console.warn('Onboarding: theme change failed.', error);
    }
    syncThemeControl(modeKey);
  }

  function onThemeChange() {
    syncThemeControl();
  }

  function focusables() {
    if (!ui) return [];
    const sel = 'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return Array.prototype.slice.call(ui.card.querySelectorAll(sel))
      .filter((el) => el.tabIndex >= 0 && !el.hidden && !el.closest('[hidden]') && el.getClientRects().length > 0);
  }

  function trapTab(event) {
    const list = focusables();
    if (!list.length) {
      event.preventDefault();
      ui.card.focus({ preventScroll: true });
      return;
    }
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement;
    const inside = ui.card.contains(active);
    if (event.shiftKey) {
      if (!inside || active === first || active === ui.card) {
        event.preventDefault();
        last.focus();
      }
    } else if (!inside || active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  // Capture phase on window + stopPropagation: while the flow is open nothing underneath (deck shortcuts, filter
  // sheet, toasts) sees the keyboard. Enter/Space still activate the focused button (default action).
  function onKeydown(event) {
    if (!opened || !ui) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      skip();
      return;
    }
    if (event.key === 'Tab') {
      trapTab(event);
      event.stopPropagation();
      return;
    }
    const t = event.target instanceof Element ? event.target : null;
    if (t && t.matches('.ob-seg-btn') && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].indexOf(event.key) !== -1) {
      const btns = Array.prototype.slice.call(ui.body.querySelectorAll('.ob-seg-btn'));
      const i = btns.indexOf(t);
      let next = i;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (i - 1 + btns.length) % btns.length;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (i + 1) % btns.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = btns.length - 1;
      event.preventDefault();
      if (btns[next]) {
        chooseTheme(btns[next].getAttribute('data-ob-theme'));
        btns[next].focus();
      }
    }
    event.stopPropagation();
  }

  // Something moved focus out (for example app.js restoring it after the More menu closed): bring it back.
  function onFocusIn(event) {
    if (!opened || !ui) return;
    const t = event.target;
    if (ui.card.contains(t)) {
      ui.lastFocus = t;
      return;
    }
    if (t && t.closest && t.closest('#toast-root')) return;
    const back = ui.lastFocus && ui.lastFocus.isConnected && ui.card.contains(ui.lastFocus) ? ui.lastFocus : (ui.title || ui.card);
    back.focus({ preventScroll: true });
  }

  // The schedule arrived (or changed) while the flow is open: fill in counts, formats and topics.
  function onSessions() {
    if (!opened || !ui) return;
    ui.opts = readOptions();
    resolveModel();
    renderStep(0, true);
    updateCount(false);
  }

  // ---------- lifecycle ----------

  function menuOverlay() {
    return document.getElementById('more-overlay');
  }

  function menuIsOpen() {
    const m = menuOverlay();
    return !!m && m.classList.contains('visible');
  }

  function closeOtherDialogs() {
    const f = F();
    try {
      if (f && typeof f.isOpen === 'function' && f.isOpen() && typeof f.close === 'function') f.close();
    } catch (error) {
      // ignore
    }
    try {
      const E = root.ExportUI;
      const ex = document.getElementById('export-overlay');
      if (E && typeof E.close === 'function' && ex && ex.classList.contains('visible')) E.close();
    } catch (error) {
      // ignore
    }
  }

  function buildUi() {
    const host = document.getElementById('onboarding-root') || document.body;
    const overlay = document.createElement('div');
    overlay.className = 'overlay ob-overlay';
    overlay.id = 'ob-overlay';
    overlay.innerHTML = `
      <div class="ob-card" id="ob-card" role="dialog" aria-modal="true" aria-labelledby="ob-title" tabindex="-1">
        <div class="ob-top">
          <div class="ob-dots" role="img" aria-label="Step 1 of ${STEPS}" data-ob-dots></div>
          <button type="button" class="ob-skip" data-ob-action="skip">Skip</button>
        </div>
        <div class="ob-body" data-ob-body></div>
        <div class="ob-foot" data-ob-foot></div>
        <p class="ob-sr" role="status" aria-live="polite" aria-atomic="true" data-ob-live></p>
      </div>`;
    host.appendChild(overlay);
    const card = overlay.querySelector('.ob-card');
    ui = {
      overlay,
      card,
      top: overlay.querySelector('.ob-top'),
      dots: overlay.querySelector('[data-ob-dots]'),
      body: overlay.querySelector('[data-ob-body]'),
      foot: overlay.querySelector('[data-ob-foot]'),
      live: overlay.querySelector('[data-ob-live]'),
      title: null,
      opts: readOptions(),
      lastFocus: null
    };
    card.addEventListener('click', onClick);
  }

  function destroyUi() {
    clearTimeout(liveTimer);
    clearTimeout(exitTimer);
    if (ui && ui.overlay.parentNode) ui.overlay.parentNode.removeChild(ui.overlay);
    ui = null;
    document.documentElement.classList.remove('ob-open');
    document.documentElement.style.removeProperty('--ob-toast-bottom');
  }

  function open(options) {
    if (opened) return;
    const o = options || {};
    try {
      if (!o.waited && menuIsOpen()) {
        const closeBtn = document.querySelector('[data-app-action="close-more"]');
        if (closeBtn) {
          closeBtn.click();
          setTimeout(() => open({ step: o.step, waited: true }), MENU_CLOSE_WAIT_MS);
          return;
        }
      }
      closeOtherDialogs();
      clearTimeout(exitTimer);
      if (ui) destroyUi(); // a previous exit animation is still running
      mode = isOnboarded() ? 'reopen' : 'first';
      step = Math.min(STEPS, Math.max(1, Number(o.step) || 1));
      model = buildModel();
      buildUi();
      resolveModel();
      renderChrome();
      renderStep(0);

      opened = true;
      document.documentElement.classList.add('ob-open');
      ui.overlay.style.display = 'flex';
      void ui.overlay.offsetWidth; // start the enter transition from the hidden state
      ui.overlay.classList.add('visible');
      syncFootHeight();
      window.addEventListener('keydown', onKeydown, true);
      window.addEventListener('resize', syncFootHeight);
      window.addEventListener('m2020:themechange', onThemeChange);
      document.addEventListener('focusin', onFocusIn, true);
      (ui.title || ui.card).focus({ preventScroll: true });
    } catch (error) {
      // Never leave a half-built overlay on top of the app.
      console.error('Onboarding failed to open.', error);
      opened = false;
      window.removeEventListener('keydown', onKeydown, true);
      window.removeEventListener('resize', syncFootHeight);
      window.removeEventListener('m2020:themechange', onThemeChange);
      document.removeEventListener('focusin', onFocusIn, true);
      destroyUi();
    }
  }

  // Common exit: hide, restore the page, then (once app.js has released #app) put focus on the deck.
  function closeDialog(afterApply) {
    if (!opened) return;
    opened = false;
    window.removeEventListener('keydown', onKeydown, true);
    window.removeEventListener('resize', syncFootHeight);
    window.removeEventListener('m2020:themechange', onThemeChange);
    document.removeEventListener('focusin', onFocusIn, true);
    clearTimeout(liveTimer);
    const overlay = ui && ui.overlay;
    if (overlay) overlay.classList.remove('visible');
    document.documentElement.classList.remove('ob-open');
    document.documentElement.style.removeProperty('--ob-toast-bottom');
    exitTimer = setTimeout(() => {
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (ui && ui.overlay === overlay) ui = null;
    }, reducedMotion() ? 0 : EXIT_MS);
    restoreDeck(afterApply);
  }

  function dismissHintStrip() {
    const strip = document.getElementById('hint-strip');
    const btn = document.querySelector('[data-app-action="dismiss-hint"]');
    if (strip && !strip.hidden && btn) btn.click();
  }

  function focusDeck() {
    const like = document.getElementById('btn-like');
    const state = document.getElementById('no-more');
    let target = like && !like.disabled && like.getClientRects().length > 0 ? like : null;
    if (!target && state && !state.hidden) target = state.querySelector('button');
    if (!target) target = document.getElementById('open-filters') || document.getElementById('more-btn');
    if (target) target.focus({ preventScroll: true });
  }

  // app.js un-inerts #app (and restores its own idea of focus) a frame after the overlay hides; wait for that so
  // the final focus move wins and actually lands.
  function restoreDeck(afterApply) {
    let tries = 0;
    const attempt = () => {
      const app = document.getElementById('app');
      if (app && app.hasAttribute('inert') && tries < 25) {
        tries += 1;
        setTimeout(attempt, 40);
        return;
      }
      if (afterApply) dismissHintStrip();
      focusDeck();
    };
    setTimeout(attempt, 0);
  }

  function skip() {
    markOnboarded();
    closeDialog(false);
  }

  function finish() {
    if (!ui || !model) return;
    const partial = computePartial();
    const f = F();
    let applied = null;
    if (f && typeof f.setState === 'function' && typeof f.getState === 'function') {
      try {
        const current = f.getState();
        const changed = Object.keys(partial).some((k) => !sameList(current[k], partial[k]));
        applied = changed ? f.setState(partial) : current;
      } catch (error) {
        console.warn('Onboarding: applying filters failed.', error);
      }
    }
    const result = applied || Object.assign({ days: [], types: [], themes: [], tags: [] }, partial);
    writePrefs({ days: result.days, themes: result.themes, tags: result.tags, types: result.types, calendar: model.calendar });
    markOnboarded();
    lsSet(HINT_KEY, '1'); // the swipe hint is redundant after the walkthrough
    closeDialog(true);
  }

  function onMenuClick(event) {
    if (event) event.preventDefault();
    open();
  }

  function init() {
    const btn = document.getElementById('open-setup');
    if (btn) btn.addEventListener('click', onMenuClick);
    if (!isOnboarded()) {
      if (hasProgress()) {
        markOnboarded();
      } else {
        open();
      }
    }
  }

  // Register for the schedule before app.js runs, so a cached schedule that is set synchronously is not missed.
  (function listenForSessions() {
    const f = F();
    if (f && typeof f.onSessions === 'function') {
      f.onSessions(onSessions);
    } else if (typeof root.addEventListener === 'function') {
      root.addEventListener('m2020:sessions', onSessions);
    }
  }());

  root.Onboarding = {
    open,
    close: () => { if (opened) skip(); },
    isOpen: () => opened
  };

  // Scripts sit at the end of <body>, so DOMContentLoaded fires after app.js has booted (filters initialised).
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}(window));
