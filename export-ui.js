/*
 * export-ui.js - "Add to calendar" dialog (window.ExportUI). Owner: calendar agent.
 *
 *   ExportUI.init({ root, getSelected, toast })   root = #export-root, getSelected() -> Session[] (sorted copy),
 *                                                 toast = window.Toast. Registers backdrop-click + Escape close.
 *   ExportUI.open()                                renders + shows #export-overlay (info toast instead if nothing saved)
 *   ExportUI.close()                               hides #export-overlay, returns focus to the opener
 *
 * One tap adds ALL saved sessions: every option points at one .ics feed (functions/api/calendar) whose URL
 * carries the saved session ids (M2020Calendar.feedUrl). Google = "add by URL" (cid=webcal://...), Outlook =
 * "add from web" (work/school + personal), Apple = webcal://. "Download .ics" is the offline fallback.
 * Mobile: bottom sheet. >= 900px: centred 520px dialog (export.css). All data is escaped before innerHTML.
 * Phones (coarse pointer, < 900px): Google only adds calendars by URL in a computer browser, so its row copies
 * the link instead of opening Google, and the accent "primary" row is Apple Calendar (iOS) or Outlook (others).
 * Preferred calendar: onboarding stores localStorage 'event-swiper-prefs'.calendar ('google' | 'outlookWork' |
 * 'outlookPersonal' | 'apple' | 'file'). When set, that row is listed first, gets the accent treatment and a
 * "Your calendar" badge ('file' puts the .ics download first instead). Phones keep Google's copy-link row either way.
 */
(function (root) {
  'use strict';

  const DESKTOP_QUERY = '(min-width: 900px)';
  const CLOSE_MS = 500; // matches the shared .overlay hide convention (--duration-slow)
  const PREFS_KEY = 'event-swiper-prefs';
  const PREFERRED_KEYS = ['google', 'outlookWork', 'outlookPersonal', 'apple', 'file'];

  let rootEl = null;
  let getSelected = () => [];
  let toast = null;
  let opener = null;
  let inerted = [];
  let current = null; // { sessions, exportable, links }
  let closeTimer = null;

  // ---------- helpers ----------

  function esc(value) {
    if (root.M2020Core && typeof root.M2020Core.escapeHtml === 'function') return root.M2020Core.escapeHtml(value);
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function plural(n, one, many) {
    return `${n} ${n === 1 ? one : (many || `${one}s`)}`;
  }

  function notify(message, type, extra) {
    const t = toast || root.Toast;
    if (t && typeof t.show === 'function') {
      t.show(message, Object.assign({ type: type || 'info' }, extra || {}));
    }
  }

  function overlayEl() {
    return document.getElementById('export-overlay');
  }

  function isOpen() {
    const overlay = overlayEl();
    return !!overlay && overlay.classList.contains('visible');
  }

  function isPhone() {
    try {
      return root.matchMedia('(pointer: coarse)').matches && !root.matchMedia(DESKTOP_QUERY).matches;
    } catch (error) {
      return false;
    }
  }

  // 'ios' | 'android' | 'other'. iPadOS reports a Mac user agent, so a touch-capable "Macintosh" counts as iOS.
  function platform() {
    const nav = root.navigator || {};
    const ua = String(nav.userAgent || '');
    if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && Number(nav.maxTouchPoints) > 1)) return 'ios';
    if (/Android/i.test(ua)) return 'android';
    return 'other';
  }

  // The row that works natively on this device gets the accent icon (.export-option--primary). Google only adds
  // calendars by URL in a computer browser, so on phones the hero is Apple Calendar (iOS) or Outlook (others).
  function primaryKey(phone) {
    if (!phone) return 'google';
    return platform() === 'ios' ? 'apple' : 'outlookWork';
  }

  // The calendar the person picked during onboarding ('' when none or storage is unavailable).
  function preferredCalendar() {
    try {
      const raw = root.localStorage.getItem(PREFS_KEY);
      const prefs = raw ? JSON.parse(raw) : null;
      const key = prefs && typeof prefs.calendar === 'string' ? prefs.calendar : '';
      return PREFERRED_KEYS.indexOf(key) !== -1 ? key : '';
    } catch (error) {
      return '';
    }
  }

  // Calendar servers (Google, Microsoft, Apple) fetch the feed themselves, so it must live on a public origin.
  // file://, localhost and private hosts use the production app (https://m2020.pages.dev).
  function feedOrigin() {
    const loc = root.location || {};
    const host = String(loc.hostname || '');
    const isHttp = /^https?:$/.test(loc.protocol || '');
    const isLocal = !host || host === 'localhost' || /\.localhost$|\.local$|\.test$/.test(host) ||
      /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0$|\[?::1\]?$)/.test(host);
    return isHttp && !isLocal ? loc.origin : '';
  }

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }

  function downloadText(filename, text, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function copyText(text) {
    if (root.navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function' &&
        root.isSecureContext) {
      return navigator.clipboard.writeText(text).then(() => true, () => legacyCopy(text));
    }
    return Promise.resolve(legacyCopy(text));
  }

  function legacyCopy(text) {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.focus({ preventScroll: true });
    area.select();
    area.setSelectionRange(0, text.length);
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (error) {
      ok = false;
    }
    document.body.removeChild(area);
    return ok;
  }

  // ---------- data ----------

  function collect() {
    const Cal = root.M2020Calendar;
    const sessions = (getSelected() || []).filter(Boolean);
    const exportable = Cal ? sessions.filter((s) => Cal.isExportable(s)) : [];
    const ids = exportable.map((s) => s.eventId);
    const name = (Cal && Cal.CALENDAR_NAME) || 'Money20/20 picks';
    const origin = feedOrigin();
    const feed = Cal && ids.length ? Cal.feedUrl(origin, ids) : '';
    const links = feed ? {
      feed,
      google: Cal.googleSubscribeUrl(feed),
      outlookWork: Cal.outlookSubscribeUrl(feed, name, { work: true }),
      outlookPersonal: Cal.outlookSubscribeUrl(feed, name, { work: false }),
      apple: Cal.webcalUrl(feed)
    } : null;
    return { sessions, exportable, links, name, usesProduction: !origin };
  }

  // ---------- markup ----------

  const ICON_CAL = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">' +
    '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
    '<path d="M3.5 10h17M8 3v4M16 3v4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
    '<path d="M8.5 14.5l2.2 2.2 4.3-4.4" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_EXT = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">' +
    '<path d="M14 4h6v6M20 4l-9 9M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" ' +
    'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_COPY = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">' +
    '<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
    '<path d="M15.5 8.5V6A2 2 0 0 0 13.5 4H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round"/></svg>';
  const ICON_CLOSE = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">' +
    '<path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  const ICON_DOWNLOAD = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">' +
    '<path d="M12 4v11M7 10.5l5 5 5-5M5 19.5h14" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const OPTIONS = [
    { key: 'google', label: 'Google Calendar', sub: 'Personal or Google Workspace', app: 'Google Calendar', newTab: true },
    { key: 'outlookWork', label: 'Outlook — work or school', sub: 'Microsoft 365', app: 'Outlook', newTab: true },
    { key: 'outlookPersonal', label: 'Outlook.com — personal', sub: 'Outlook.com, Hotmail, Live', app: 'Outlook.com', newTab: true },
    { key: 'apple', label: 'Apple Calendar', sub: 'iPhone, iPad, Mac', app: 'Apple Calendar', newTab: false }
  ];

  const GOOGLE_PHONE_SUB = 'Open it on a computer: Google can’t add calendars from a phone';

  function optionRow(opt, links, ctx) {
    const href = links[opt.key];
    const target = opt.newTab ? ' target="_blank" rel="noopener noreferrer"' : '';
    const subId = `export-sub-${opt.key}`;
    const isPreferred = ctx.preferred === opt.key;
    const cls = `export-option${ctx.primary === opt.key ? ' export-option--primary' : ''}${isPreferred ? ' export-option--preferred' : ''}`;
    const badge = isPreferred ? ' <span class="export-option__badge">Your calendar</span>' : '';
    if (ctx.phone && opt.key === 'google') {
      // On a phone Google Calendar opens without adding anything, so the row's main action is copying the link.
      return `
      <li class="${cls} export-option--copyonly">
        <button type="button" class="export-option__link" data-export-copy="${esc(opt.key)}"
                aria-describedby="${subId}">
          <span class="export-option__icon">${ICON_CAL}</span>
          <span class="export-option__text">
            <span class="export-option__label">Copy ${esc(opt.label)} link${badge}</span>
            <span class="export-option__sub" id="${subId}">${esc(GOOGLE_PHONE_SUB)}</span>
          </span>
          <span class="export-option__go">${ICON_COPY}</span>
        </button>
      </li>`;
    }
    return `
      <li class="${cls}">
        <a class="export-option__link" href="${esc(href)}"${target} data-export-open="${esc(opt.key)}"
           aria-describedby="${subId}">
          <span class="export-option__icon">${ICON_CAL}</span>
          <span class="export-option__text">
            <span class="export-option__label">${esc(opt.label)}${badge}</span>
            <span class="export-option__sub" id="${subId}">${esc(opt.sub)}</span>
          </span>
          <span class="export-option__go">${ICON_EXT}</span>
        </a>
        <button type="button" class="export-option__copy" data-export-copy="${esc(opt.key)}"
                aria-label="Copy ${esc(opt.label)} link">${ICON_COPY}</button>
      </li>`;
  }

  function render() {
    if (!rootEl) return;
    current = collect();
    const n = current.exportable.length;
    const left = current.sessions.length - n;
    const links = current.links;
    const phone = isPhone();
    const nText = plural(n, 'session');
    // Preferred calendar (onboarding): that row first and accent-styled; 'file' leads with the .ics download.
    const preferred = preferredCalendar();
    const fileFirst = preferred === 'file';
    const ctx = {
      phone,
      preferred,
      primary: preferred ? (fileFirst ? '' : preferred) : primaryKey(phone)
    };
    const ordered = OPTIONS.slice().sort((a, b) => (b.key === preferred ? 1 : 0) - (a.key === preferred ? 1 : 0));
    const onetapTitle = n === 1 ? 'One tap adds it' : `One tap adds all ${esc(n)}`;

    const subscribe = links ? `
      <section class="export-section" aria-labelledby="export-onetap">
        <h3 class="export-eyebrow" id="export-onetap">${fileFirst ? `Or ${onetapTitle.charAt(0).toLowerCase()}${onetapTitle.slice(1)}` : onetapTitle}</h3>
        <ul class="export-options" role="list">
          ${ordered.map((opt) => optionRow(opt, links, ctx)).join('')}
        </ul>
        <button type="button" class="export-textbtn" data-export-copy="feed">Copy feed link for another calendar app</button>
        <div class="export-manual" data-export-manual hidden>
          <label class="export-manual__label" for="export-manual-input">Copy this link</label>
          <input class="export-manual__input" id="export-manual-input" type="text" readonly spellcheck="false"
                 autocomplete="off" value="">
        </div>
        ${current.usesProduction ? `
          <p class="export-fineprint">Calendar links use the online version at m2020.pages.dev.</p>` : ''}
      </section>

      <section class="export-section export-tips" aria-labelledby="export-tips-title">
        <h3 class="export-eyebrow" id="export-tips-title">Good to know</h3>
        <ul class="export-bullets">
          <li>Your picks arrive as their own <strong>“${esc(current.name)}”</strong> calendar: color it, hide it, or delete it in one step.</li>
          <li>Signed in to more than one Google account? Switch to your <strong>work account first</strong>. Google adds the calendar to whichever account is active.</li>
          <li>Google can take a few minutes to show the new calendar. Outlook and Apple are usually immediate.</li>
          <li>The calendar holds what’s saved right now. Save more later? Come back, add it again, then delete the older “${esc(current.name)}” calendar.</li>
        </ul>
      </section>` : '';

    const download = `
        <section class="export-section export-download${fileFirst ? ' export-download--first' : ''}" aria-labelledby="export-download-title">
          <h3 class="export-eyebrow" id="export-download-title">${links ? (fileFirst ? 'Your file' : 'Or import a file') : 'Import a file'}</h3>
          <button type="button" class="export-download-btn export-secondary${fileFirst ? ' export-download-btn--preferred' : ''}" data-export-download>
            ${ICON_DOWNLOAD}<span>Download .ics file</span>
          </button>
          <p class="export-help">Importing by hand? Create a separate <strong>“Money20/20”</strong> calendar first and
            import into it, so everything stays color-coded and removable together. Also the way to go if your
            company doesn’t allow adding calendars by URL.</p>
          <details class="export-steps">
            <summary>How to import, step by step</summary>
            <dl>
              <dt>Google Calendar (on a computer)</dt>
              <dd>Settings → Add calendar → Create new calendar, name it “Money20/20”. Then Settings → Import &amp; export → choose the file and the “Money20/20” calendar → Import.</dd>
              <dt>Outlook</dt>
              <dd>Calendar → Add calendar → Create blank calendar “Money20/20”. Then Add calendar → Upload from file → choose the file and that calendar → Import.</dd>
              <dt>Apple Calendar</dt>
              <dd>iPhone or iPad: open the downloaded file → Add All → pick the “Money20/20” calendar. Mac: File → New Calendar, then File → Import.</dd>
            </dl>
          </details>
        </section>`;

    rootEl.innerHTML = `
      <div class="export-handle" aria-hidden="true"></div>
      <header class="export-header">
        <div class="export-header__text">
          <h2 id="export-title" class="export-title">Add to calendar</h2>
          <p class="export-subtitle" id="export-subtitle">${esc(nText)} · shown as free, so they won’t block your work calendar${
            left > 0 ? ` · ${esc(plural(left, 'session'))} without a time left out` : ''}</p>
        </div>
        <button type="button" class="export-close" data-export-close aria-label="Close">${ICON_CLOSE}</button>
      </header>
      <div class="export-body">
        ${fileFirst ? download + subscribe : subscribe + download}
        <p class="export-privacy">To build the feed, the IDs of your saved sessions are sent to m2020.pages.dev. Nothing else leaves your device.</p>
      </div>
    `;
  }

  // ---------- actions ----------

  function handleOpenLink(key) {
    const opt = OPTIONS.find((o) => o.key === key);
    if (!opt) return;
    notify(`Opening ${opt.app}…`, 'info', { duration: 2500 });
  }

  function handleCopy(key) {
    if (!current || !current.links) return;
    const url = key === 'feed' ? current.links.feed : current.links[key];
    if (!url) return;
    const opt = OPTIONS.find((o) => o.key === key);
    const what = opt ? `${opt.label} link` : 'Feed link';
    const googleOnPhone = key === 'google' && isPhone();
    copyText(url).then((ok) => {
      if (ok) {
        hideManual();
        if (googleOnPhone) {
          notify('Google link copied. Open it on a computer, or turn on Desktop site and try again.', 'success',
            { duration: 6000 });
        } else {
          notify(`${what} copied`, 'success');
        }
      } else {
        showManual(url, what);
        notify(googleOnPhone
          ? 'Couldn’t copy automatically. The link is selected below: copy it and open it on a computer.'
          : 'Couldn’t copy automatically. The link is selected below: copy it from there.', 'info');
      }
    });
  }

  // Fallback when the clipboard is unavailable (no permission, embedded browsers): show the link selected.
  function showManual(url, what) {
    const box = rootEl && rootEl.querySelector('[data-export-manual]');
    if (!box) return;
    const input = box.querySelector('input');
    const label = box.querySelector('label');
    if (label) label.textContent = `${what}: copy it from here`;
    input.value = url;
    box.hidden = false;
    input.focus({ preventScroll: false });
    input.select();
    try {
      input.setSelectionRange(0, url.length);
    } catch (error) {
      // some input types do not support selection ranges
    }
  }

  function hideManual() {
    const box = rootEl && rootEl.querySelector('[data-export-manual]');
    if (box) box.hidden = true;
  }

  function handleDownload() {
    const Cal = root.M2020Calendar;
    const data = collect();
    if (!Cal || !data.exportable.length) {
      notify('None of your saved sessions has a time yet, so there is nothing to add.', 'error');
      return;
    }
    try {
      const ics = Cal.buildIcs(data.exportable, {});
      downloadText(`money2020-picks-${stamp()}.ics`, ics, 'text/calendar;charset=utf-8');
    } catch (error) {
      console.error('ExportUI: download failed', error);
      notify('Couldn’t create the calendar file. Please try again.', 'error');
      return;
    }
    notify(`Downloaded ${plural(data.exportable.length, 'session')} (.ics)`, 'success');
    close();
  }

  function onRootClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const closeBtn = target.closest('[data-export-close]');
    if (closeBtn) {
      close();
      return;
    }
    const openLink = target.closest('[data-export-open]');
    if (openLink) {
      handleOpenLink(openLink.getAttribute('data-export-open'));
      return;
    }
    const copyBtn = target.closest('[data-export-copy]');
    if (copyBtn) {
      handleCopy(copyBtn.getAttribute('data-export-copy'));
      return;
    }
    if (target.closest('[data-export-download]')) handleDownload();
  }

  // ---------- focus management ----------

  function focusables() {
    if (!rootEl) return [];
    return Array.from(rootEl.querySelectorAll(
      'a[href], button:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'
    )).filter((el) => el.offsetParent !== null || el === document.activeElement);
  }

  function trapTab(event) {
    const items = focusables();
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !rootEl.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !rootEl.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  function setBackgroundInert(on) {
    const overlay = overlayEl();
    if (on) {
      inerted = [];
      Array.from(document.body.children).forEach((el) => {
        if (el === overlay || el.id === 'toast-root' || el.tagName === 'SCRIPT' ||
            el.getAttribute('role') === 'alertdialog' || el.hasAttribute('inert')) return;
        if (el.querySelector && el.querySelector('[role="alertdialog"]')) return;
        el.setAttribute('inert', '');
        inerted.push(el);
      });
    } else {
      inerted.forEach((el) => el.removeAttribute('inert'));
      inerted = [];
    }
  }

  // ---------- open / close ----------

  function open() {
    const Cal = root.M2020Calendar;
    const sessions = (getSelected() || []).filter(Boolean);
    if (!sessions.length) {
      notify('Save a session first', 'info');
      return;
    }
    if (!Cal) {
      notify('Calendar export failed to load. Please reload the page.', 'error');
      return;
    }
    if (!sessions.some((s) => Cal.isExportable(s))) {
      notify('None of your saved sessions has a time yet, so there is nothing to add.', 'error');
      return;
    }
    const overlay = overlayEl();
    if (!overlay || !rootEl) return;
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
    const wasOpen = isOpen();
    if (!wasOpen) opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    render();
    rootEl.setAttribute('aria-describedby', 'export-subtitle');
    overlay.style.display = 'flex';
    if (!wasOpen) setBackgroundInert(true);
    // Force a reflow so the enter transition starts from the hidden state. Unlike requestAnimationFrame this
    // also works when the page is in a background tab (rAF is paused there and the dialog would never show).
    void overlay.offsetWidth;
    overlay.classList.add('visible');
    const firstOption = rootEl.querySelector('.export-option__link, .export-download-btn');
    const closeBtn = rootEl.querySelector('[data-export-close]');
    const target = root.matchMedia && root.matchMedia(DESKTOP_QUERY).matches ? (firstOption || closeBtn) : closeBtn;
    if (target) target.focus({ preventScroll: true });
  }

  function close() {
    const overlay = overlayEl();
    if (!overlay || !isOpen()) return;
    overlay.classList.remove('visible');
    setBackgroundInert(false);
    const back = opener;
    opener = null;
    if (back && document.contains(back) && typeof back.focus === 'function') {
      back.focus({ preventScroll: true });
    }
    closeTimer = setTimeout(() => {
      closeTimer = null;
      if (!overlay.classList.contains('visible')) overlay.style.display = 'none';
    }, CLOSE_MS);
  }

  function init(opts) {
    const options = opts || {};
    rootEl = options.root || document.getElementById('export-root');
    if (typeof options.getSelected === 'function') getSelected = options.getSelected;
    toast = options.toast || root.Toast || null;
    if (rootEl) {
      rootEl.classList.add('export-sheet');
      rootEl.addEventListener('click', onRootClick);
    }
    const overlay = overlayEl();
    if (overlay) {
      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) close();
      });
    }
    // Each module closes its own overlay on Escape (app.js only handles #selected-overlay / #about-overlay).
    // Capture phase on window + stopPropagation: when this dialog sits on top of the Saved sheet, Escape closes
    // only this dialog, not the sheet underneath too.
    root.addEventListener('keydown', (event) => {
      if (!isOpen()) return;
      // A confirm dialog on top owns Escape/Tab.
      if (document.querySelector('[role="alertdialog"]:not([hidden])')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (event.key === 'Tab') {
        trapTab(event);
      }
    }, true);
  }

  root.ExportUI = {
    init,
    open,
    close
  };
}(window));
