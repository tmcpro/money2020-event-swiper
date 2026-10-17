/*
 * toast.js - toast notifications + in-app confirm dialog (window.Toast).
 *
 *   Toast.show(message, opts?) -> { dismiss() }
 *     opts.type      'success' | 'error' | 'info' (default) | 'neutral' | 'warning'
 *     opts.duration  ms; default 3500 (5000 with an action, 6000 for errors); 0 = sticky
 *     opts.action    { label, onClick } - clicking dismisses the toast, then calls onClick
 *
 *   Toast.confirm({ title, message, confirmLabel, cancelLabel, destructive }) -> Promise<boolean>
 *     In-app modal (role="alertdialog"). Escape, backdrop click and Cancel resolve false.
 *
 *   Toast.dismissAll()  removes every visible toast (e.g. before a retry).
 *
 * Behaviour:
 * - Toasts render into #toast-root (created on <body> if missing; queued until <body> exists).
 *   At most 3 are visible (the oldest is dismissed); an identical toast already on screen is
 *   refreshed instead of stacked. Timers pause on hover, focus, touch and while the tab is hidden.
 *   Dismiss with the close button, a tap on the toast, a swipe (down or sideways) or Escape
 *   while the toast has focus.
 * - Screen readers: two persistent visually-hidden live regions inside #toast-root
 *   (role="status" polite, role="alert" assertive) announce messages; the visual stack is not a
 *   live region, so buttons are never read out as part of an announcement.
 * - Confirm: focus trap, initial focus on Cancel when destructive (else on the confirm button),
 *   background made inert, focus returned to the opener. While open the dialog matches
 *   [role="alertdialog"]:not([hidden]); the role is removed the moment it closes.
 * - No DOM work at load time; text is always inserted with textContent (never HTML).
 */
(function (root) {
  'use strict';

  if (!root || !root.document) return;

  const doc = root.document;

  const MAX_VISIBLE = 3;
  const DURATION_DEFAULT = 3500;
  const DURATION_ACTION = 5000;
  const DURATION_ERROR = 6000;
  const SWIPE_DISMISS_Y = 32;
  const SWIPE_DISMISS_X = 72;
  const TAP_SLOP = 6;
  const EXIT_FALLBACK_MS = 600;

  const TYPES = ['success', 'error', 'info', 'neutral', 'warning'];

  // Static, data-free SVG markup (safe for innerHTML).
  const ICONS = {
    success: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    info: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 11v6"/><path d="M12 7.25v.01"/></svg>',
    neutral: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 11v6"/><path d="M12 7.25v.01"/></svg>',
    warning: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 7v6"/><path d="M12 16.75v.01"/></svg>',
    error: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 7v6"/><path d="M12 16.75v.01"/></svg>',
    close: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    danger: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M10.3 3.9L2.4 17.6A2 2 0 0 0 4.1 20.6h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4.5"/><path d="M12 17v.01"/></svg>'
  };

  let idCounter = 0;
  const nextId = (prefix) => {
    idCounter += 1;
    return `${prefix}-${idCounter}`;
  };

  const reducedMotion = () => {
    try {
      return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (error) {
      return false;
    }
  };

  // Wait for a CSS transition on `el` to finish (or a fallback timeout; 0ms transitions never fire).
  function afterTransition(el, callback) {
    let done = false;
    let fallback = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (fallback) clearTimeout(fallback);
      el.removeEventListener('transitionend', onEnd);
      callback();
    };
    const onEnd = (event) => {
      if (event.target === el) finish();
    };
    el.addEventListener('transitionend', onEnd);
    let wait = EXIT_FALLBACK_MS;
    try {
      const style = root.getComputedStyle(el);
      const toMs = (v) => (String(v).trim().endsWith('ms') ? parseFloat(v) : parseFloat(v) * 1000) || 0;
      const durations = String(style.transitionDuration || '0s').split(',').map(toMs);
      const delays = String(style.transitionDelay || '0s').split(',').map(toMs);
      const longest = durations.reduce((max, d, i) => Math.max(max, d + (delays[i] || delays[0] || 0)), 0);
      wait = longest + 50;
    } catch (error) {
      // keep fallback
    }
    fallback = setTimeout(finish, wait);
  }

  // Run fn after the browser has painted the initial state (so CSS transitions play). rAF is
  // paused in background tabs, so a timeout guarantees the element still becomes visible.
  const nextFrame = (fn) => {
    let ran = false;
    const once = () => {
      if (ran) return;
      ran = true;
      fn();
    };
    if (typeof root.requestAnimationFrame === 'function') {
      root.requestAnimationFrame(() => root.requestAnimationFrame(once));
    }
    setTimeout(once, 60);
  };

  /* ------------------------------------------------------------------ */
  /* Toast root + live regions                                           */
  /* ------------------------------------------------------------------ */

  let rootEl = null;
  let stackEl = null;
  let politeEl = null;
  let assertiveEl = null;
  let globalListenersBound = false;

  function ensureRoot() {
    if (rootEl && rootEl.isConnected && stackEl && stackEl.isConnected) return rootEl;
    if (!doc.body) return null;

    rootEl = doc.getElementById('toast-root');
    if (!rootEl) {
      rootEl = doc.createElement('div');
      rootEl.id = 'toast-root';
      doc.body.appendChild(rootEl);
    }
    rootEl.classList.add('toast-root');
    // Announcements go through the dedicated child regions below; the stack itself must not be
    // live, otherwise inserting a toast would also read out its buttons.
    rootEl.removeAttribute('aria-live');
    rootEl.removeAttribute('aria-atomic');

    politeEl = rootEl.querySelector('.toast-sr--polite');
    if (!politeEl) {
      politeEl = doc.createElement('div');
      politeEl.className = 'toast-sr toast-sr--polite';
      politeEl.setAttribute('role', 'status');
      politeEl.setAttribute('aria-live', 'polite');
      politeEl.setAttribute('aria-atomic', 'false');
      politeEl.setAttribute('aria-relevant', 'additions');
      rootEl.appendChild(politeEl);
    }
    assertiveEl = rootEl.querySelector('.toast-sr--assertive');
    if (!assertiveEl) {
      assertiveEl = doc.createElement('div');
      assertiveEl.className = 'toast-sr toast-sr--assertive';
      assertiveEl.setAttribute('role', 'alert');
      assertiveEl.setAttribute('aria-live', 'assertive');
      assertiveEl.setAttribute('aria-atomic', 'false');
      assertiveEl.setAttribute('aria-relevant', 'additions');
      rootEl.appendChild(assertiveEl);
    }
    stackEl = rootEl.querySelector('.toast-stack');
    if (!stackEl) {
      stackEl = doc.createElement('div');
      stackEl.className = 'toast-stack';
      rootEl.appendChild(stackEl);
    }

    if (!globalListenersBound) {
      globalListenersBound = true;
      doc.addEventListener('visibilitychange', () => {
        active.forEach((t) => (doc.hidden ? t.pause('hidden') : t.resume('hidden')));
      });
    }
    return rootEl;
  }

  // Each message is appended as its own node (aria-relevant additions) a beat after the region
  // exists, so back-to-back toasts are all read and a repeated message is read again.
  function announce(text, assertive) {
    const region = assertive ? assertiveEl : politeEl;
    if (!region || !text) return;
    setTimeout(() => {
      const line = doc.createElement('p');
      line.textContent = text;
      region.appendChild(line);
      setTimeout(() => {
        if (line.parentNode) line.parentNode.removeChild(line);
      }, 7000);
    }, 100);
  }

  /* ------------------------------------------------------------------ */
  /* Toasts                                                               */
  /* ------------------------------------------------------------------ */

  const active = [];   // visible toast records, oldest first
  const pending = [];  // queued before <body> existed
  let returnFocusEl = null;

  function normalizeOptions(message, opts) {
    const options = opts && typeof opts === 'object' ? opts : {};
    const type = TYPES.indexOf(options.type) !== -1 ? options.type : 'info';
    const action = options.action && options.action.label
      ? { label: String(options.action.label), onClick: options.action.onClick }
      : null;
    let duration;
    if (typeof options.duration === 'number' && isFinite(options.duration) && options.duration >= 0) {
      duration = options.duration;
    } else if (type === 'error') {
      duration = DURATION_ERROR;
    } else if (action) {
      duration = DURATION_ACTION;
    } else {
      duration = DURATION_DEFAULT;
    }
    const text = message == null ? '' : String(message);
    return { text, type, action, duration };
  }

  function createToast(config) {
    const record = {
      config,
      key: `${config.type}\u0000${config.text}\u0000${config.action ? config.action.label : ''}`,
      slot: null,
      el: null,
      timer: null,
      remaining: config.duration,
      startedAt: 0,
      pauses: new Set(),
      closed: false
    };

    const slot = doc.createElement('div');
    slot.className = 'toast-slot';

    const el = doc.createElement('div');
    el.className = `toast toast--${config.type}`;
    el.id = nextId('toast');
    el.setAttribute('role', 'group');
    el.setAttribute('aria-roledescription', 'notification');

    const icon = doc.createElement('span');
    icon.className = 'toast__icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = ICONS[config.type] || ICONS.info;

    const msg = doc.createElement('p');
    msg.className = 'toast__message';
    msg.id = `${el.id}-msg`;
    msg.textContent = config.text;
    el.setAttribute('aria-labelledby', msg.id);

    el.appendChild(icon);
    el.appendChild(msg);

    if (config.action) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'toast__action';
      btn.textContent = config.action.label;
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        const onClick = config.action.onClick;
        dismissRecord(record, 'action');
        if (typeof onClick === 'function') {
          try {
            onClick();
          } catch (error) {
            console.error('Toast action failed:', error);
          }
        }
      });
      el.appendChild(btn);
    }

    const close = doc.createElement('button');
    close.type = 'button';
    close.className = 'toast__close';
    close.setAttribute('aria-label', 'Dismiss notification');
    close.innerHTML = ICONS.close;
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      dismissRecord(record, 'close');
    });
    el.appendChild(close);

    slot.appendChild(el);
    record.slot = slot;
    record.el = el;

    record.startTimer = () => {
      if (record.closed || record.config.duration <= 0 || record.pauses.size > 0) return;
      clearTimeout(record.timer);
      record.startedAt = Date.now();
      record.timer = setTimeout(() => dismissRecord(record, 'timeout'), Math.max(0, record.remaining));
    };
    record.pause = (reason) => {
      if (record.closed) return;
      const wasRunning = record.pauses.size === 0;
      record.pauses.add(reason);
      if (wasRunning && record.timer) {
        clearTimeout(record.timer);
        record.timer = null;
        record.remaining = Math.max(0, record.remaining - (Date.now() - record.startedAt));
      }
    };
    record.resume = (reason) => {
      if (record.closed || !record.pauses.has(reason)) return;
      record.pauses.delete(reason);
      if (record.pauses.size === 0) {
        // Give the reader a moment after they look away / blur.
        record.remaining = Math.max(record.remaining, 1500);
        record.startTimer();
      }
    };
    record.restart = () => {
      record.remaining = record.config.duration;
      clearTimeout(record.timer);
      record.timer = null;
      record.startTimer();
    };

    bindToastInteractions(record);
    return record;
  }

  function bindToastInteractions(record) {
    const el = record.el;

    // Hover pause (mouse only; touch is handled by the pointer drag below).
    el.addEventListener('pointerenter', (event) => {
      if (event.pointerType === 'mouse') record.pause('hover');
    });
    el.addEventListener('pointerleave', (event) => {
      if (event.pointerType === 'mouse') record.resume('hover');
    });

    // Focus pause + remember where focus came from (restored when a focused toast closes).
    el.addEventListener('focusin', (event) => {
      record.pause('focus');
      const from = event.relatedTarget;
      if (from && stackEl && !stackEl.contains(from)) returnFocusEl = from;
    });
    el.addEventListener('focusout', (event) => {
      if (!el.contains(event.relatedTarget)) record.resume('focus');
    });

    el.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        dismissRecord(record, 'escape');
      }
    });

    // Swipe (down or sideways) or tap to dismiss.
    let drag = null;
    el.addEventListener('pointerdown', (event) => {
      if (record.closed || event.button > 0) return;
      if (event.target.closest && event.target.closest('button')) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, dy: 0, moved: false };
      record.pause('pointer');
      try {
        el.setPointerCapture(event.pointerId);
      } catch (error) {
        // ignore
      }
    });
    el.addEventListener('pointermove', (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      drag.dx = event.clientX - drag.x;
      drag.dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(drag.dx, drag.dy) > TAP_SLOP) {
        drag.moved = true;
        el.classList.add('is-dragging');
      }
      if (drag.moved) {
        const ty = Math.max(0, drag.dy);
        const tx = Math.abs(drag.dx) > ty ? drag.dx : 0;
        const fade = Math.max(0.35, 1 - Math.max(Math.abs(tx) / 240, ty / 120));
        el.style.transform = `translate(${tx}px, ${tx ? 0 : ty}px)`;
        el.style.opacity = String(fade);
      }
    });
    const endDrag = (event, cancelled) => {
      if (!drag || event.pointerId !== drag.id) return;
      const { dx, dy, moved } = drag;
      drag = null;
      el.classList.remove('is-dragging');
      record.resume('pointer');
      if (!moved) {
        if (!cancelled) dismissRecord(record, 'tap');
        return;
      }
      const horizontal = Math.abs(dx) > Math.max(0, dy);
      if (!cancelled && horizontal && Math.abs(dx) >= SWIPE_DISMISS_X) {
        dismissRecord(record, 'swipe', dx > 0 ? 'right' : 'left');
      } else if (!cancelled && !horizontal && dy >= SWIPE_DISMISS_Y) {
        dismissRecord(record, 'swipe', 'down');
      } else {
        el.style.transform = '';
        el.style.opacity = '';
      }
    };
    el.addEventListener('pointerup', (event) => endDrag(event, false));
    el.addEventListener('pointercancel', (event) => endDrag(event, true));
  }

  function mountRecord(record) {
    if (!ensureRoot()) return false;

    // Same message already visible: refresh it rather than stacking a duplicate.
    const twin = active.find((t) => !t.closed && t.key === record.key);
    if (twin) {
      twin.restart();
      twin.el.classList.remove('is-bumped');
      // Force reflow so the bump animation can replay.
      void twin.el.offsetWidth;
      twin.el.classList.add('is-bumped');
      announce(record.config.text, record.config.type === 'error');
      record.closed = true;
      record.alias = twin;
      return true;
    }

    while (active.filter((t) => !t.closed).length >= MAX_VISIBLE) {
      const oldest = active.find((t) => !t.closed && !t.el.contains(doc.activeElement))
        || active.find((t) => !t.closed);
      if (!oldest) break;
      dismissRecord(oldest, 'overflow');
    }

    active.push(record);
    stackEl.appendChild(record.slot);
    void record.slot.offsetHeight; // commit the hidden start state so the entrance transitions
    nextFrame(() => {
      if (!record.closed) record.slot.classList.add('is-visible');
    });
    announce(record.config.text, record.config.type === 'error');
    if (doc.hidden) record.pause('hidden');
    record.startTimer();
    return true;
  }

  function dismissRecord(record, reason, direction) {
    if (record.alias) {
      dismissRecord(record.alias, reason, direction);
      return;
    }
    if (record.closed) return;
    record.closed = true;
    clearTimeout(record.timer);
    record.timer = null;

    const pendingIndex = pending.indexOf(record);
    if (pendingIndex !== -1) {
      pending.splice(pendingIndex, 1);
      return;
    }

    const index = active.indexOf(record);
    if (index !== -1) active.splice(index, 1);

    const slot = record.slot;
    const el = record.el;
    const hadFocus = el.contains(doc.activeElement);

    if (!slot.isConnected) return;

    // Collapse the slot's height so the remaining toasts glide into place.
    slot.style.height = `${slot.offsetHeight}px`;
    slot.classList.add('is-leaving');
    if (direction) el.dataset.exit = direction;
    el.style.transform = '';
    el.style.opacity = '';
    void slot.offsetHeight;
    slot.classList.remove('is-visible');
    slot.style.height = '0px';

    if (hadFocus) {
      const next = active.length ? active[active.length - 1].el.querySelector('button') : null;
      const target = next || (returnFocusEl && returnFocusEl.isConnected ? returnFocusEl : null);
      if (target && typeof target.focus === 'function') {
        target.focus({ preventScroll: true });
      } else if (doc.activeElement && typeof doc.activeElement.blur === 'function') {
        doc.activeElement.blur();
      }
    }

    afterTransition(slot, () => {
      if (slot.parentNode) slot.parentNode.removeChild(slot);
    });
  }

  function flushPending() {
    if (!doc.body) return;
    const queued = pending.splice(0, pending.length);
    queued.forEach((record) => {
      if (!record.closed) mountRecord(record);
    });
  }

  function show(message, opts) {
    const config = normalizeOptions(message, opts);
    const record = createToast(config);
    const handle = {
      dismiss() {
        dismissRecord(record, 'api');
      }
    };

    if (!doc.body) {
      pending.push(record);
      if (pending.length === 1) {
        doc.addEventListener('DOMContentLoaded', flushPending, { once: true });
      }
      return handle;
    }

    mountRecord(record);
    return handle;
  }

  function dismissAll() {
    active.slice().forEach((t) => dismissRecord(t, 'api'));
    pending.slice().forEach((t) => dismissRecord(t, 'api'));
  }

  /* ------------------------------------------------------------------ */
  /* Confirm dialog                                                       */
  /* ------------------------------------------------------------------ */

  let currentDialog = null;

  // While the confirm dialog is open, toasts drop beneath its backdrop (they would otherwise cover
  // its buttons on short screens) and are inert along with the rest of the page.
  function setToastsUnderDialog(on) {
    const el = doc.getElementById('toast-root');
    if (!el) return;
    el.classList.toggle('toast-root--under-dialog', on);
  }

  function setBackgroundInert(layer) {
    const changed = [];
    Array.prototype.forEach.call(doc.body.children, (child) => {
      if (child === layer) return;
      if (child.tagName === 'SCRIPT' || child.tagName === 'STYLE' || child.tagName === 'LINK') return;
      if (child.inert || child.hasAttribute('inert')) return;
      child.inert = true;
      if (!('inert' in child)) child.setAttribute('inert', '');
      changed.push(child);
    });
    return () => {
      changed.forEach((child) => {
        child.inert = false;
        child.removeAttribute('inert');
      });
    };
  }

  function focusableIn(container) {
    return Array.prototype.filter.call(
      container.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'),
      (el) => !el.hidden && el.offsetParent !== null
    );
  }

  function confirmDialog(opts) {
    const options = opts && typeof opts === 'object' ? opts : {};

    if (!doc.body) {
      return new Promise((resolve) => {
        doc.addEventListener('DOMContentLoaded', () => {
          confirmDialog(options).then(resolve);
        }, { once: true });
      });
    }

    // Only one confirm at a time: a new request cancels the previous one.
    if (currentDialog) currentDialog.finish(false, true);

    const title = options.title ? String(options.title) : 'Are you sure?';
    const message = options.message ? String(options.message) : '';
    const confirmLabel = options.confirmLabel ? String(options.confirmLabel) : 'Continue';
    const cancelLabel = options.cancelLabel ? String(options.cancelLabel) : 'Cancel';
    const destructive = !!options.destructive;

    const opener = doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : null;

    const layer = doc.createElement('div');
    layer.className = 'confirm-layer';

    const dialog = doc.createElement('div');
    dialog.className = `confirm-dialog${destructive ? ' confirm-dialog--destructive' : ''}`;
    const titleId = nextId('confirm-title');
    const msgId = nextId('confirm-message');
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', titleId);
    if (message) dialog.setAttribute('aria-describedby', msgId);

    if (destructive) {
      const icon = doc.createElement('div');
      icon.className = 'confirm-dialog__icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = ICONS.danger;
      dialog.appendChild(icon);
    }

    const heading = doc.createElement('h2');
    heading.className = 'confirm-dialog__title';
    heading.id = titleId;
    heading.textContent = title;
    dialog.appendChild(heading);

    if (message) {
      const body = doc.createElement('p');
      body.className = 'confirm-dialog__message';
      body.id = msgId;
      body.textContent = message;
      dialog.appendChild(body);
    }

    const actions = doc.createElement('div');
    actions.className = 'confirm-dialog__actions';

    const cancelBtn = doc.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'confirm-btn confirm-btn--secondary';
    cancelBtn.textContent = cancelLabel;

    const confirmBtn = doc.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = `confirm-btn ${destructive ? 'confirm-btn--danger' : 'confirm-btn--primary'}`;
    confirmBtn.textContent = confirmLabel;

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    dialog.appendChild(actions);
    layer.appendChild(dialog);

    return new Promise((resolve) => {
      let settled = false;
      let restoreInert = () => {};
      let pressStartedOnBackdrop = false;

      const onKeydown = (event) => {
        if (event.key === 'Escape' || event.key === 'Esc') {
          event.preventDefault();
          event.stopPropagation();
          finish(false);
          return;
        }
        if (event.key === 'Tab') {
          const items = focusableIn(dialog);
          if (!items.length) {
            event.preventDefault();
            return;
          }
          const first = items[0];
          const last = items[items.length - 1];
          const inside = dialog.contains(doc.activeElement);
          if (event.shiftKey && (doc.activeElement === first || !inside)) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && (doc.activeElement === last || !inside)) {
            event.preventDefault();
            first.focus();
          }
          event.stopPropagation();
          return;
        }
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].indexOf(event.key) !== -1) {
          const items = focusableIn(dialog);
          const i = items.indexOf(doc.activeElement);
          if (items.length) {
            event.preventDefault();
            const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
            const nextIndex = i === -1 ? 0 : (i + (forward ? 1 : -1) + items.length) % items.length;
            items[nextIndex].focus();
          }
        }
        // Keep app-level shortcuts (swipe keys, undo, filters...) from firing under the dialog.
        // Default actions (Enter/Space on a focused button) are unaffected.
        event.stopPropagation();
      };

      const onFocusIn = (event) => {
        if (dialog.contains(event.target)) return;
        (destructive ? cancelBtn : confirmBtn).focus();
      };

      const onPointerDown = (event) => {
        pressStartedOnBackdrop = event.target === layer;
      };
      const onClick = (event) => {
        if (event.target === layer && pressStartedOnBackdrop) finish(false);
        pressStartedOnBackdrop = false;
      };

      function finish(result, immediate) {
        if (settled) return;
        settled = true;
        if (currentDialog && currentDialog.layer === layer) currentDialog = null;

        root.removeEventListener('keydown', onKeydown, true);
        doc.removeEventListener('focusin', onFocusIn, true);
        layer.removeEventListener('pointerdown', onPointerDown);
        layer.removeEventListener('click', onClick);

        // No longer a modal from this instant (app.js checks [role="alertdialog"]:not([hidden])).
        dialog.removeAttribute('role');
        dialog.removeAttribute('aria-modal');
        layer.setAttribute('aria-hidden', 'true');
        layer.classList.add('is-leaving');
        restoreInert();
        setToastsUnderDialog(false);

        if (opener && opener.isConnected && typeof opener.focus === 'function' && !opener.closest('[inert]')) {
          try {
            opener.focus({ preventScroll: true });
          } catch (error) {
            // ignore
          }
        } else if (dialog.contains(doc.activeElement)) {
          doc.activeElement.blur();
        }

        const remove = () => {
          if (layer.parentNode) layer.parentNode.removeChild(layer);
        };
        if (immediate) {
          remove();
        } else {
          layer.classList.remove('is-visible');
          afterTransition(layer, remove);
        }
        resolve(result);
      }

      cancelBtn.addEventListener('click', () => finish(false));
      confirmBtn.addEventListener('click', () => finish(true));
      layer.addEventListener('pointerdown', onPointerDown);
      layer.addEventListener('click', onClick);
      root.addEventListener('keydown', onKeydown, true);
      doc.addEventListener('focusin', onFocusIn, true);

      currentDialog = { layer, finish };

      doc.body.appendChild(layer);
      void layer.offsetWidth; // commit the hidden start state so the entrance transitions
      restoreInert = setBackgroundInert(layer);
      setToastsUnderDialog(true);
      (destructive ? cancelBtn : confirmBtn).focus({ preventScroll: true });
      if (reducedMotion()) {
        layer.classList.add('is-visible');
      } else {
        nextFrame(() => {
          if (!settled) layer.classList.add('is-visible');
        });
      }
    });
  }

  // Create the live regions as soon as the document is parsed (not at script load), so they
  // already exist when the first message arrives; screen readers ignore regions born with content.
  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', () => ensureRoot(), { once: true });
  }

  root.Toast = {
    show,
    confirm: confirmDialog,
    dismissAll
  };
}(typeof window !== 'undefined' ? window : null));
