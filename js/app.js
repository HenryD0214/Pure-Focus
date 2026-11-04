/* ═══════════════════════════════════════════════════════════════════════
   app.js — bootstrap
   Wires the views together and keeps them in sync with the store.
   ═══════════════════════════════════════════════════════════════════════ */

/* ── Global nudge dots (SPEC-V2 E19, §4.8) ──
   Dots.set(kind, on): kind 'account' (sync needs action) | 'reports' (an Insights
   card unlocked). At most one global dot: account > reports. The winner is written
   to document.documentElement.dataset.dot ('account' | 'reports' | ''); W6 styles it.
   Dots.current() → the shown kind or ''. Call from init code (app.js loads last). */
const Dots = (() => {
  const PRIORITY = ['account', 'reports'];
  const active = new Set();
  function set(kind, on) {
    if (!PRIORITY.includes(kind)) return;
    if (on) active.add(kind); else active.delete(kind);
    document.documentElement.dataset.dot = PRIORITY.find((k) => active.has(k)) || '';
  }
  function current() { return document.documentElement.dataset.dot || ''; }
  return { set, current };
})();

/* ── Coach marks (SPEC-V2 §4.8, §5.1) ──
   CoachMarks.offer({id, anchor, text, primary, secondary}) → true when it shows now.
   anchor: Element or selector. primary/secondary: a label string or {label, action}
   (also accepted: title/text for the label, onClick/run for the action); secondary
   defaults to "Not now". At most ONE coach mark per launch, never while focus runs, and each id shows once per device (purefocus.coachmarks.v2). An offer that
   can't show yet is kept and tried again when focus ends (if none has shown this launch).
   CoachMarks.pending() lists offers; CoachMarks.dismiss() closes the visible one. */
const CoachMarks = (() => {
  const KEY = 'purefocus.coachmarks.v2';
  const offers = [];
  let shownThisLaunch = false;
  let current = null;   // {spec, el, anchor, cleanup}

  function seen() {
    try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; }
  }
  function markSeen(id) {
    try { const list = seen(); if (!list.includes(id)) { list.push(id); localStorage.setItem(KEY, JSON.stringify(list.slice(-100))); } } catch (_) { /* harmless */ }
  }
  function focusRunning() {
    try { return typeof Timer !== 'undefined' && Timer.isRunning() && Timer.mode() === 'focus'; } catch (_) { return false; }
  }
  // Never over a popup (W1 #70 / W4): a modal sheet, dialog, menu or popover that is visible.
  function popupOpen() {
    // A celebration (XP capsule, toast, level-up banner) counts as a popup too: one thing at a time.
    try { if (typeof Rewards !== 'undefined' && Rewards.celebrating && Rewards.celebrating()) return true; } catch (_) { /* optional */ }
    const sel = '[aria-modal="true"], [role="dialog"], [role="menu"], .gs-pop, .pf-hud-pop, .pf-explain-backdrop, .celebrate-toast:not(.is-leaving), .celebrate-banner, .celebrate-chip';
    return Array.from(document.querySelectorAll(sel)).some((n) =>
      !n.classList.contains('coach-mark') && !n.closest('.coach-mark') && !n.hidden && n.getClientRects().length > 0 &&
      getComputedStyle(n).visibility !== 'hidden');
  }
  function unmarkSeen(id) {
    try { localStorage.setItem(KEY, JSON.stringify(seen().filter((x) => x !== id))); } catch (_) { /* harmless */ }
  }
  let retryTimer = null;
  function retryLater() { clearTimeout(retryTimer); retryTimer = setTimeout(retry, 2000); }

  function anchorOf(a) {
    if (a instanceof Element) return a;
    if (typeof a === 'string') { try { return document.querySelector(a); } catch (_) { return null; } }
    return null;
  }
  function actionOf(x, fallbackLabel) {
    if (!x && !fallbackLabel) return null;
    if (typeof x === 'string') return { label: x, run: null };
    const o = x || {};
    return { label: String(o.label || o.title || o.text || fallbackLabel || 'OK'), run: o.action || o.onClick || o.run || null };
  }

  function place() {
    if (!current) return;
    const a = current.anchor;
    if (!a || !a.isConnected || !a.getClientRects().length) { close(false); return; }
    const r = a.getBoundingClientRect();
    const el = current.el;
    const w = el.offsetWidth, hgt = el.offsetHeight, m = 12;
    const below = r.bottom + 12 + hgt <= innerHeight - m || r.top - 12 - hgt < m;
    const top = below ? r.bottom + 12 : r.top - 12 - hgt;
    const cx = r.left + r.width / 2;
    const left = Math.max(m, Math.min(innerWidth - m - w, cx - w / 2));
    el.style.top = `${Math.round(top)}px`;
    el.style.left = `${Math.round(left)}px`;
    el.dataset.side = below ? 'below' : 'above';
    el.style.setProperty('--arrow-x', `${Math.round(Math.max(18, Math.min(w - 18, cx - left)))}px`);
  }

  function close(refocus) {
    if (!current) return;
    const c = current;
    current = null;
    c.cleanup();
    c.el.classList.add('is-leaving');
    setTimeout(() => c.el.remove(), 180);
    if (refocus && c.anchor && c.anchor.focus) try { c.anchor.focus({ preventScroll: true }); } catch (_) {}
  }

  function show(spec) {
    const anchor = anchorOf(spec.anchor);
    if (!anchor || !anchor.getClientRects().length) return false;
    const el = document.createElement('div');
    el.className = 'coach-mark';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-label', 'Tip');
    const text = document.createElement('p');
    text.className = 'coach-mark-text';
    text.textContent = String(spec.text || '');
    const row = document.createElement('div');
    row.className = 'coach-mark-actions';
    const prim = actionOf(spec.primary, null);
    const sec = actionOf(spec.secondary, 'Not now');
    for (const [act, cls] of [[sec, 'coach-mark-btn'], [prim, 'coach-mark-btn is-main']]) {
      if (!act) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.textContent = act.label;
      b.addEventListener('click', () => { close(true); if (typeof act.run === 'function') { try { act.run(); } catch (err) { console.error(err); } } });
      row.appendChild(b);
    }
    el.append(text, row);
    document.body.appendChild(el);
    const onKey = (e) => { if (e.key === 'Escape' && current && current.el === el) { e.preventDefault(); close(true); } };
    const onMove = () => place();
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    // A popup opening over the tip hides it; the tip comes back once the popup is gone.
    const watch = setInterval(() => {
      if (current && current.el === el && popupOpen()) { unmarkSeen(spec.id); shownThisLaunch = false; close(false); retryLater(); }
    }, 700);
    current = { spec, el, anchor, cleanup: () => {
      clearInterval(watch);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    } };
    place();
    shownThisLaunch = true;
    markSeen(spec.id);
    return true;
  }

  function tryShow(spec) {
    if (shownThisLaunch || current || focusRunning()) return false;
    if (seen().includes(spec.id)) return false;
    if (popupOpen()) { retryLater(); return false; }
    return show(spec);
  }

  function offer(spec) {
    if (!spec || typeof spec.id !== 'string' || !spec.id) return false;
    if (seen().includes(spec.id)) return false;
    if (!offers.some((o) => o.id === spec.id)) offers.push({ ...spec, offeredAt: Date.now() });
    return tryShow(spec);
  }

  function retry() {
    if (shownThisLaunch || current) return;
    const next = offers.find((o) => !seen().includes(o.id));
    if (next) tryShow(next);
  }

  function init() {
    try {
      // Never during focus: a mark that is up closes when focus starts; pending ones try again after.
      ['start', 'resume'].forEach((ev) => Timer.on(ev, () => { if (focusRunning()) close(false); }));
      ['stop', 'pause', 'complete'].forEach((ev) => Timer.on(ev, () => setTimeout(retry, 1500)));
    } catch (_) { /* the timer is optional here */ }
  }

  function pending() { return offers.slice(); }
  // Something more important (a celebration) is about to show: step aside now, come back later.
  function yieldNow() {
    if (!current) return;
    const id = current.spec.id;
    unmarkSeen(id); shownThisLaunch = false; close(false); retryLater();
  }
  return { offer, pending, dismiss: () => close(false), yieldNow, current: () => (current ? current.spec.id : null), init };
})();

/* ── Quiet mode (SPEC-V2 §5.1, v2-themes §2.4) ──
   While a focus run is live: body.is-quiet (HUD/trailing controls step back, row actions,
   quick-add and count badges hide). After 3 s without pointer movement: body.is-idle (the
   chrome fades to 40 %). One pointermove listener, throttled to 4 Hz. Keyboard focus in the
   sidebar or the corner buttons brings it back. Quiet.isQuiet() lets other modules hold non-essential UI. */
const Quiet = (() => {
  const IDLE_MS = 3000;
  let quiet = false;
  let idleTimer = 0;
  let lastMove = 0;
  function wake() {
    document.body.classList.remove('is-idle');
    clearTimeout(idleTimer);
    if (quiet) idleTimer = setTimeout(() => { if (quiet) document.body.classList.add('is-idle'); }, IDLE_MS);
  }
  function sync() {
    let on = false;
    try { on = Timer.isRunning() && Timer.mode() === 'focus'; } catch (_) { on = false; }
    if (on === quiet) return;
    quiet = on;
    document.body.classList.toggle('is-quiet', on);
    if (on) wake(); else { clearTimeout(idleTimer); document.body.classList.remove('is-idle'); }
  }
  function init() {
    document.addEventListener('pointermove', () => {
      const now = Date.now();
      if (now - lastMove < 250) return;
      lastMove = now;
      if (quiet) wake();
    }, { passive: true });
    document.addEventListener('pointerdown', () => { if (quiet) wake(); }, { passive: true });
    document.addEventListener('focusin', (e) => {
      if (quiet && e.target instanceof Element && e.target.closest('.sidebar, .focus-corner, #player-pill-root, #guard-chip-root')) wake();
    });
    sync();   // Timer.render() calls Quiet.sync() after every state change
  }
  return { init, sync, isQuiet: () => quiet };
})();

const App = (() => {
  const $ = (sel) => document.querySelector(sel);

  /* Starts a v2 module if it is loaded (stubs first, owners fill them in). A failing
     module never stops the app (SPEC-V2 V3). */
  function startModule(name, get, method = 'init') {
    try {
      const m = get();
      if (!m || typeof m[method] !== 'function') return;
      const r = m[method]();
      if (r && typeof r.catch === 'function') r.catch((err) => console.error(`${name}.${method} failed`, err));
    } catch (err) {
      console.error(`${name}.${method} failed`, err);
    }
  }
  let currentView = 'focus';

  // ── view switching ──

  // The tab title belongs to the section on show, so switching views (or leaving
  // the Calendar) always updates it instead of leaving the last one behind.
  const TITLES = {
    focus: 'Pure Focus — Pomodoro Timer',
    calendar: 'Calendar · Pure Focus',
    reports: 'Reports · Pure Focus',
    settings: 'Settings · Pure Focus',
  };
  function syncTitle(name) {
    document.title = TITLES[name] || TITLES.focus;
  }

  function showView(name) {
    currentView = name;
    document.querySelectorAll('.view').forEach((v) => {
      const active = v.id === `view-${name}`;
      v.classList.toggle('is-active', active);
      v.hidden = !active;
    });
    document.querySelectorAll('.tab').forEach((t) => {
      const active = t.dataset.view === name;
      t.classList.toggle('is-active', active);
      if (active) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
    });
    document.documentElement.dataset.view = name;
    if (typeof Shell !== 'undefined') Shell.onView(name);
    syncTitle(name);
    if (name === 'reports') Reports.render();
    if (name === 'calendar') CalendarView.render();
    if (name === 'settings') {
      Settings.renderGenres();
      Settings.renderNowPlayingBar();
      if (Settings.onShow) Settings.onShow();
    }
  }

  // ── toasts ──

  function toast(message, variant = '') {
    const stack = $('#toast-stack');
    const node = document.createElement('div');
    node.className = 'toast' + (variant ? ` toast--${variant}` : '');
    if (variant === 'success') {
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 20 20');
      icon.setAttribute('class', 'toast-icon');
      icon.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M4.5 10.5 8.5 14.5 15.5 6');
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '2.2');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      icon.appendChild(path);
      node.appendChild(icon);
    }
    const label = document.createElement('span');
    label.textContent = message;
    node.appendChild(label);
    stack.appendChild(node);
    setTimeout(() => {
      node.classList.add('is-leaving');
      setTimeout(() => node.remove(), 320);
    }, 2400);
  }

  // ── streak chip ──

  // The old topbar chip is superseded by the rewards HUD (rewards.css hides
  // #streak-chip). Kept as a harmless no-op-safe call for older callers: it
  // only fills the chip when it is still in the page, and never throws.
  function renderStreakChip() {
    const chip = $('#streak-chip');
    if (!chip) return;
    if (typeof Rewards !== 'undefined') { chip.hidden = true; return; }
    let streak = 0;
    try { streak = Reports.currentStreak(); } catch (_) { streak = 0; }
    const count = $('#streak-count');
    if (count) count.textContent = String(streak);
    chip.hidden = !(streak > 0);
  }

  // ── sound (global mute) ──

  // The on/off switch lives in the Ambience popover (js/scenes.js), not in the
  // top bar. These helpers are the single source of truth for it: they drive
  // Audio, persist the choice and announce it so every switch stays in sync.
  function isSoundOn() {
    try { return localStorage.getItem('purefocus.sound') !== 'off'; } catch (_) { return true; }
  }

  function setSound(on) {
    const next = !!on;
    Audio.setEnabled(next);
    try { localStorage.setItem('purefocus.sound', next ? 'on' : 'off'); } catch (_) {}
    document.querySelectorAll('[data-sound-toggle]').forEach((el) => {
      if ('checked' in el) el.checked = next;
      else el.setAttribute('aria-pressed', String(next));
    });
    document.body.classList.toggle('sound-off', !next);
    document.dispatchEvent(new CustomEvent('sound:change', { detail: { on: next } }));
  }

  function initSound() {
    setSound(isSoundOn());
    // A legacy #sound-toggle button, if a page still has one, keeps working.
    const btn = $('#sound-toggle');
    if (btn) {
      btn.setAttribute('data-sound-toggle', '');
      btn.setAttribute('aria-pressed', String(isSoundOn()));
      btn.addEventListener('click', () => setSound(!isSoundOn()));
    }
    // M mutes / unmutes from anywhere the key isn't already taken (typing,
    // focused controls, the Calendar's own D/W/M/A view keys).
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'm' && e.key !== 'M') return;
      if (e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target instanceof Element ? e.target : null;
      if (t && (t.isContentEditable || t.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'))) return;
      if (currentView === 'calendar') return;
      e.preventDefault();
      setSound(!isSoundOn());
      toast(isSoundOn() ? 'Sound on' : 'Sound off');
    });
  }

  // ── init ──

  async function init() {
    Settings.applyTheme();
    try { Store.migrate('2026-10-29-session-accuracy', () => Store.repairSessionData()); } catch (err) { console.error(err); }

    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        if (!tab.dataset.view) return;   // e.g. the Focus Pro button opens a popup, not a view
        showView(tab.dataset.view);
      });
    });

    initSound();

    startModule('Cloud', () => (typeof Cloud !== 'undefined' ? Cloud : null));
    Tasks.init();
    startModule('Guard', () => (typeof Guard !== 'undefined' ? Guard : null));   // before Timer.init: hears the restored run
    Timer.init();
    Quiet.init();
    CoachMarks.init();
    Reports.init();
    Settings.init();
    Scenes.init();
    startModule('Player', () => (typeof Player !== 'undefined' ? Player : null));
    Rewards.init();
    startModule('Friends', () => (typeof Friends !== 'undefined' ? Friends : null));
    startModule('CloudUI', () => (typeof CloudUI !== 'undefined' ? CloudUI : null));
    startModule('Insights', () => (typeof Insights !== 'undefined' ? Insights : null));
    GoogleSync.init();
    startModule('CalendarMigrate', () => (typeof CalendarMigrate !== 'undefined' ? CalendarMigrate : null), 'run');
    CalendarView.init();
    startModule('Feeds', () => (typeof Feeds !== 'undefined' ? Feeds : null));
    startModule('Assignments', () => (typeof Assignments !== 'undefined' ? Assignments : null));
    startModule('Courses', () => (typeof Courses !== 'undefined' ? Courses : null));
    startModule('Coach', () => (typeof Coach !== 'undefined' ? Coach : null));
    startModule('CalendarTasks', () => (typeof CalendarTasks !== 'undefined' ? CalendarTasks : null));

    // Load the music catalogue, then build the genre list.
    await Audio.loadCatalogue();
    Settings.renderGenres();

    // React to store changes.
    Store.on('change', (event) => {
      // 'bulk' (Store.bulk across kinds), 'remote' (cloud) and 'reset' may touch everything.
      const all = event === 'bulk' || event === 'remote' || event === 'reset';
      if (event === 'tasks' || all) {
        Tasks.render();
        Timer.refreshActiveTask();
      }
      if (event === 'sessions' || all) {
        renderStreakChip();
        if (currentView === 'reports') Reports.render();
      }
      if (event === 'settings' || all) {
        Settings.syncControls();
      }
    });

    // Music state changes refresh the now-playing bar.
    Store.on('music', () => {
      Timer.render();
      Settings.renderNowPlayingBar();
      Settings.renderGenres();
      Settings.renderMiniPlayer();
    });

    // Fine-grained playback progress (seek bar, elapsed / duration).
    Store.on('music:progress', (info) => {
      Timer.renderNowPlayingProgress(info);
      Settings.renderMiniPlayerProgress();
    });

    // Saving failed (storage full), or the saved data couldn't be read: neither may pass silently.
    let warnedAt = 0;
    const warnStorage = () => {
      if (Date.now() - warnedAt < 120000) return;
      warnedAt = Date.now();
      toast("Your browser's storage is full, so new changes aren't being saved. Export a CSV from Settings to keep them.", 'error');
    };
    Store.on('attention', (what) => { if (what) warnStorage(); });
    if (Store.storageAttention()) warnStorage();
    if (Store.unreadable()) toast("Your saved data couldn't be read, so Pure Focus started fresh. A copy was kept in this browser.", 'error');

    // A finished focus session. The rewards layer owns the celebration (XP
    // chip, goal ring, level-ups), so this only adds a short plain toast when
    // that layer won't acknowledge the session itself: Rewards missing, or set
    // to Calm / Off, or celebrations switched off.
    Store.on('focus:completed', (info) => {
      const s = Store.settings();
      const rewardsCelebrates = typeof Rewards !== 'undefined' &&
        (s.engagementMode || 'full') === 'full' && s.celebrations !== 'off';
      if (rewardsCelebrates) return;
      const n = info && info.pomodoros ? info.pomodoros : 0;
      toast(n > 0 ? `Focus complete · ${n} today` : 'Focus complete', 'success');
    });

    // A low-frequency heartbeat keeps the seek bar moving even if the audio
    // element is throttled, and clears the art equaliser when playback stops.
    setInterval(() => {
      if (Audio.currentTrack()) {
        Timer.renderNowPlayingProgress();
        Settings.renderMiniPlayerProgress();
      }
    }, 500);

    renderStreakChip();
    Timer.render();

    // Deep links (app.html#calendar, and legacy index.html#reports links that
    // the homepage forwards here) open that tab; #signin opens the account menu.
    const route = () => {
      const h = (location.hash || '').slice(1);
      if (['focus', 'calendar', 'reports', 'settings'].includes(h)) showView(h);
      else if (h === 'signin' && typeof GoogleSync !== 'undefined' && GoogleSync.signIn) {
        try { GoogleSync.signIn(); } catch (_) { /* sign-in needs a configured client */ }
      }
    };
    route();
    window.addEventListener('hashchange', route);

    // New installs start dark (v2-themes T8); Appearance › Auto follows the OS.

    // Give the browser a nudge that audio is allowed after the first gesture.
    const unlock = () => {
      document.removeEventListener('pointerdown', unlock);
      document.removeEventListener('keydown', unlock);
    };
    document.addEventListener('pointerdown', unlock, { once: true });
    document.addEventListener('keydown', unlock, { once: true });

    window.addEventListener('beforeunload', () => Timer.saveRunningState());

    console.info('Pure Focus ready.');
  }

  return { init, showView, toast, renderStreakChip, isSoundOn, setSound };
})();

document.addEventListener('DOMContentLoaded', () => {
  App.init().catch((err) => {
    console.error(err);
    App.toast('Something went wrong while starting up');
  });
});
