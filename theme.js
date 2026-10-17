/*
 * theme.js - light / dark theme for M2020 Events.
 *
 * Classic script, no dependencies, safe under file://. Load it synchronously in <head>, before the
 * stylesheets: it runs before the first paint, so the right palette is on <html> before anything is drawn
 * (no flash of the wrong theme).
 *
 * Preference ("mode"): 'auto' (follow the device, default) | 'dark' | 'light', saved in localStorage under
 * 'event-swiper-theme'. The applied theme ("resolved") is always 'dark' or 'light' and is written to
 * <html data-theme="...">; styles.css defines both palettes. <meta name="color-scheme"> and
 * <meta name="theme-color"> are kept in step (theme-color is read from --color-bg so it always matches the header).
 *
 *   window.M2020Theme.get()       -> 'auto' | 'dark' | 'light'   the saved preference
 *   window.M2020Theme.resolved()  -> 'dark' | 'light'            what is applied right now
 *   window.M2020Theme.set(mode)   -> void                        save, apply and notify (invalid modes are ignored)
 *
 * Event: window 'm2020:themechange', detail { mode, resolved }, fired whenever the preference or the applied theme
 * changes: set(), the device switching while mode is 'auto', or another tab changing the preference.
 *
 * UI: once the DOM is ready, #theme-toggle (More menu) is wired up: each click cycles Auto -> Dark -> Light -> Auto,
 * the label reads "Theme: Auto (Dark)" / "Theme: Dark" / "Theme: Light" and the icon follows. The menu stays open.
 */
(function (root) {
  'use strict';

  var STORAGE_KEY = 'event-swiper-theme';
  var MODES = ['auto', 'dark', 'light'];
  var NAMES = { auto: 'Auto', dark: 'Dark', light: 'Light' };
  var ICONS = { auto: 'i-contrast', dark: 'i-moon', light: 'i-sun' };
  // Only used if --color-bg can't be read from the stylesheet (keep in step with styles.css).
  var FALLBACK_BG = { dark: '#09090B', light: '#F4F4F6' };

  var doc = root.document;
  if (!doc || !doc.documentElement) return;
  var html = doc.documentElement;

  var mode = readStored();
  var applied = '';       // theme currently on <html>
  var appliedMode = '';   // mode the last apply() ran with
  var announceTimer = 0;
  var toggle = null;

  // ---- storage (every access guarded: private windows, blocked cookies and file:// can throw) ----
  function readStored() {
    try {
      var value = root.localStorage.getItem(STORAGE_KEY);
      return MODES.indexOf(value) >= 0 ? value : 'auto';
    } catch (error) {
      return 'auto';
    }
  }

  function writeStored(value) {
    try {
      root.localStorage.setItem(STORAGE_KEY, value);
    } catch (error) {
      // The choice still applies for this page view.
    }
  }

  // ---- resolving ----
  function systemTheme() {
    try {
      if (root.matchMedia) {
        if (root.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
        if (root.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
      }
    } catch (error) {
      // fall through
    }
    return 'dark';   // the app's default look when the device says nothing
  }

  function resolve(value) {
    return value === 'auto' ? systemTheme() : value;
  }

  // ---- <meta> upkeep ----
  function metaFor(name) {
    var meta = doc.querySelector('meta[name="' + name + '"]');
    if (!meta && doc.head) {
      meta = doc.createElement('meta');
      meta.setAttribute('name', name);
      doc.head.appendChild(meta);
    }
    return meta;
  }

  function canvasColor(theme) {
    try {
      var value = String(root.getComputedStyle(html).getPropertyValue('--color-bg') || '').trim();
      if (/^#[0-9a-f]{3,8}$/i.test(value)) return value;
    } catch (error) {
      // fall through
    }
    return FALLBACK_BG[theme];
  }

  function syncMeta(theme) {
    var scheme = metaFor('color-scheme');
    if (scheme) scheme.setAttribute('content', theme);
    var color = metaFor('theme-color');
    if (color) color.setAttribute('content', canvasColor(theme));
  }

  // ---- toggle button (More menu) ----
  function labelText() {
    return mode === 'auto'
      ? 'Theme: Auto (' + NAMES[resolve('auto')] + ')'
      : 'Theme: ' + NAMES[mode];
  }

  function syncToggle() {
    if (!toggle) return;
    var text = labelText();
    var node = null;
    for (var i = toggle.childNodes.length - 1; i >= 0; i -= 1) {
      var child = toggle.childNodes[i];
      if (child.nodeType === 3 && child.nodeValue.replace(/\s+/g, '') !== '') {
        node = child;
        break;
      }
    }
    if (node) {
      node.nodeValue = text;
    } else {
      toggle.appendChild(doc.createTextNode(text));
    }
    var use = toggle.querySelector('use');
    if (use) use.setAttribute('href', '#' + ICONS[mode]);
  }

  function announce(text) {
    var region = doc.getElementById('sr-status');
    if (!region) return;
    root.clearTimeout(announceTimer);
    region.textContent = '';
    announceTimer = root.setTimeout(function () {
      region.textContent = text;
    }, 80);
  }

  // ---- apply + notify ----
  function notify() {
    var detail = { mode: mode, resolved: applied };
    try {
      root.dispatchEvent(new root.CustomEvent('m2020:themechange', { detail: detail }));
    } catch (error) {
      // CustomEvent constructor missing (very old browsers): nothing to notify.
    }
  }

  function apply() {
    var theme = resolve(mode);
    var changed = theme !== applied || mode !== appliedMode;
    var first = applied === '';
    html.setAttribute('data-theme', theme);
    applied = theme;
    appliedMode = mode;
    syncMeta(theme);
    syncToggle();
    if (changed && !first) notify();
  }

  function set(next) {
    if (MODES.indexOf(next) < 0) return;
    mode = next;
    writeStored(next);
    apply();
  }

  function cycle() {
    set(MODES[(MODES.indexOf(mode) + 1) % MODES.length]);
    announce(labelText());
  }

  // ---- wiring ----
  function onReady() {
    // The stylesheets have loaded by now: take theme-color from the real --color-bg token.
    syncMeta(applied);
    toggle = doc.getElementById('theme-toggle');
    if (!toggle) return;
    toggle.addEventListener('click', cycle);
    syncToggle();
  }

  // The device switched between light and dark: only matters while following it.
  function onSystemChange() {
    if (mode === 'auto') apply();
  }

  try {
    var query = root.matchMedia ? root.matchMedia('(prefers-color-scheme: dark)') : null;
    if (query) {
      if (query.addEventListener) query.addEventListener('change', onSystemChange);
      else if (query.addListener) query.addListener(onSystemChange);
    }
  } catch (error) {
    // no live updates; the theme is still correct at load
  }

  // Another tab changed the preference.
  root.addEventListener('storage', function (event) {
    if (event.key !== null && event.key !== STORAGE_KEY) return;
    var stored = readStored();
    if (stored === mode) return;
    mode = stored;
    apply();
  });

  root.M2020Theme = {
    get: function () { return mode; },
    resolved: function () { return applied || resolve(mode); },
    set: set
  };

  apply();

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', onReady);
  } else {
    onReady();
  }
}(window));
