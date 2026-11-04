/* ═══════════════════════════════════════════════════════════════════════
   guard.js — Focus Guard (owner: W4; v2-guard §3–§7, SPEC-V2 §8.4)

   Opt-in, focus-only, aggregate-only. While a focus session runs and the
   user has turned Guard on, a 1 Hz sampler classifies each second as
   on · idle · distract · away (InsightsCore.guardStep, the shared reducer)
   and keeps only totals. Nothing samples or nudges outside a running focus
   session, and Guard is off for every install.

   Web signals (v2-guard §3.3): page-level input (no input while the page is
   visible and focused), Page Visibility + window blur ("away", which is NOT
   drift: the student may be writing in Google Docs), and — P1 — the Idle
   Detection API and the "Pure Focus Blocker" extension.

   Public API (v2-guard §8.2; SPEC-V2 §4.8):
     Guard.init()                 Timer.on(…) lifecycle + Timer.addSessionExtra(() => ({drift}))
     Guard.onTimer({type, runID}) 'start' | 'pause' | 'resume' | 'stop' | 'log' | 'discard'
     Guard.snapshot()             → DriftStats | null   (v2-guard §2.3)
     Guard.liveRatio()            → 0…1 | null (this session so far)
     Guard.respond(kind)          'back' | 'offline' | 'snooze' | 'pause'
     Guard.blocker                {present, version, state}
     Guard.sendFocus() · Guard.sendStop()
     Guard.titleCue()             → "• Still with it? · 14:02" while a check-in is up, else null
   ═══════════════════════════════════════════════════════════════════════ */

const Guard = (() => {
  'use strict';

  const RUN_KEY = 'purefocus.running.guard';   // {runID, acc, savedAt}; restored with the timer
  const SAVE_EVERY_MS = 5000;
  const GAP_SKIP_SEC = 900;                     // a laptop asleep with the tab open: not classified
  const NUDGE_HIDE_MS = 20000;
  const IDLE_TITLES = ['Still with it?', 'Quick check-in', 'Drifted for a moment?'];
  const DISTRACT_TITLES = ['Still with it?', 'Quick check-in', 'Back to it?'];

  /* The environment the sampler reads. Tests swap parts of it (Guard._debug.setEnv)
     to drive the reducer with a fake clock; production never changes it. */
  const realEnv = {
    now: () => performance.now(),
    timer: () => Timer.state(),
    hidden: () => !!document.hidden,
    focused: () => { try { return document.hasFocus(); } catch (_) { return true; } },
  };
  let env = { ...realEnv };

  const blocker = { present: false, version: null, state: 'absent' };

  // ── run state ──
  let acc = null;              // InsightsCore guard accumulator for the current focus run
  let accRunID = null;
  let sampling = false;
  let intervalID = null;
  let ticks = 0;               // interval ticks (test hook: stays 0 while not focusing)
  let lastTickAt = 0;
  let lastSaveAt = 0;
  let lastInputAt = 0;
  let lastMove = null;
  let away = false;            // page hidden or blurred
  let awaySince = null;        // env.now() when the current away episode began
  let awayCounted = false;     // the episode already counted as a switch (≥ 5 s)
  let extFront = { key: null, name: null };   // the extension's "front" message (P1)
  let sysIdleSince = null;     // Idle Detection API (P1)
  let screenLocked = false;

  // ── UI state ──
  let nudge = null;            // {kind, title, el, hideTimer, …}
  let savedTitle = null;

  const IC = () => InsightsCore;
  const settings = () => Store.settings();
  function safe(fn, what) { try { return fn(); } catch (err) { console.error('Guard: ' + what + ' failed', err); return undefined; } }

  // ═════════════════════════════  sampler  ═════════════════════════════

  function reducerSettings(s) {
    return { guardIdleSeconds: s.guardIdleSeconds, guardNudge: !!s.guardNudge, guardNudgeAfter: s.guardNudgeAfter,
      guardAutoPause: !!(s.guardAutoPause && s.guardIdle), guardAutoPauseAfter: s.guardAutoPauseAfter };
  }

  function idleAPIActive() { return sysIdle.active; }

  function activeSignals() {
    const s = settings();
    const sig = ['visibility'];
    if (s.guardIdle) sig.push('input');
    if (s.guardIdle && idleAPIActive()) sig.push('idleAPI');
    if (blocker.present) {
      sig.push('ext');
      if (s.blockEnabled) sig.push('block');
    }
    return sig.sort();
  }

  /* One sample at time `at` (env.now() units, ms); `t`/`remaining` are the
     timer's seconds at that moment. */
  function sampleAt(at, t, remaining, s) {
    let idleSec = null;
    if (s.guardIdle) {
      if (idleAPIActive()) idleSec = sysIdleSince != null && at >= sysIdleSince ? (at - sysIdleSince) / 1000 : 0;
      else if (!away) idleSec = Math.max(0, (at - lastInputAt) / 1000);
    }
    let switched = false;
    if (away && awaySince != null && !awayCounted && at - awaySince >= IC().C.SWITCH_MIN_SEC * 1000) {
      switched = true;
      awayCounted = true;
    }
    const distractKey = blocker.present && extFront.key ? extFront.key : null;
    return { t, dt: 1, remaining, idleSec, locked: idleAPIActive() && screenLocked, distractKey,
      distractName: distractKey ? extFront.name : null, away, switched };
  }

  /* Classifies the time since the last tick. Throttled hidden tabs tick late, so a
     long gap is fed as one-second samples with the state held since then (state
     changes flush a tick first, so "held" is exact); gaps over 900 s are skipped. */
  function tick() {
    if (!sampling || !acc) return;
    const now = env.now();
    const dt = (now - lastTickAt) / 1000;
    lastTickAt = now;
    if (!(dt > 0) || dt > GAP_SKIP_SEC) return;
    const st = env.timer();
    if (st.mode !== 'focus' || !st.running) return;
    const s = settings();
    const rs = reducerSettings(s);
    const n = dt > 1.5 ? Math.floor(dt) : 1;
    const step = dt / n;
    for (let i = 0; i < n; i++) {
      const back = (n - 1 - i) * step;              // seconds before now
      const remaining = st.remaining + back;
      if (remaining <= 0) continue;                 // the run already ended (hidden tab; it completes on return)
      const x = sampleAt(now - back * 1000, Math.max(0, st.activeElapsed - back), remaining, s);
      x.dt = step;
      const r = IC().guardStep(acc, x, rs);
      for (const a of r.actions) {
        if (a.startsWith('nudge:')) showNudge(a.slice(6));
        else if (a.startsWith('autoPause:')) { autoPause(Number(a.slice(10)) || 0); return; }
      }
    }
    if (nudge && (env.hidden() || !env.focused())) setTitleCue();
    if (now - lastSaveAt >= SAVE_EVERY_MS) persist();
  }

  function startSampling() {
    if (sampling) return;
    sampling = true;
    const now = env.now();
    lastTickAt = now;
    lastSaveAt = now;
    lastInputAt = now;                      // pressing Start is input
    away = env.hidden() || !env.focused();
    awaySince = away ? now : null;
    awayCounted = false;
    addInputListeners();
    sysIdle.start();
    intervalID = setInterval(() => { ticks++; safe(tick, 'tick'); }, 1000);
  }

  function stopSampling() {
    if (!sampling) return;
    safe(tick, 'final tick');               // classify up to this moment
    stopSamplingQuiet();
    persist();
  }

  function stopSamplingQuiet() {
    if (!sampling) return;
    sampling = false;
    clearInterval(intervalID);
    intervalID = null;
    removeInputListeners();
    sysIdle.stop();
  }

  // ── input + visibility listeners ──

  const LISTEN = { capture: true, passive: true };
  function onInput() { lastInputAt = env.now(); }
  function onMove(e) {
    const x = e.clientX, y = e.clientY;
    if (lastMove && Math.abs(x - lastMove.x) < 4 && Math.abs(y - lastMove.y) < 4) return;
    lastMove = { x, y };
    lastInputAt = env.now();
  }
  function addInputListeners() {
    for (const t of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.addEventListener(t, onInput, LISTEN);
    window.addEventListener('pointermove', onMove, LISTEN);
  }
  function removeInputListeners() {
    for (const t of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.removeEventListener(t, onInput, LISTEN);
    window.removeEventListener('pointermove', onMove, LISTEN);
  }

  /* Page Visibility and window focus. The sampler state only changes while sampling;
     the title cue and the nudge's 20 s clock also follow visibility. */
  function onVisibility() {
    const nowAway = env.hidden() || !env.focused();
    if (sampling) {
      safe(tick, 'flush');                  // the time so far belongs to the previous state
      if (nowAway && !away) { awaySince = env.now(); awayCounted = false; }
      if (!nowAway && away) { awaySince = null; awayCounted = false; lastInputAt = env.now(); }   // coming back is activity
      away = nowAway;
    }
    if (!nowAway) {
      restoreTitle();
      if (nudge && !nudge.hideTimer && nudge.kind !== 'autoPause') armNudgeHide();
      if (nudge && nudge.kind === 'autoPause') renderNudgeBody();
    }
  }

  // ═════════════════════════  lifecycle  ═════════════════════════

  function newAcc(runID) {
    acc = IC().guardInit(activeSignals());
    accRunID = runID || null;
  }

  function persist() {
    if (!acc) return;
    try { localStorage.setItem(RUN_KEY, JSON.stringify({ runID: accRunID, acc, savedAt: Date.now() })); } catch (_) {}
    lastSaveAt = env.now();
  }

  function restore(runID) {
    try {
      const saved = JSON.parse(localStorage.getItem(RUN_KEY) || 'null');
      if (saved && saved.acc && runID && saved.runID === runID && saved.acc.v === 1) {
        acc = saved.acc;
        accRunID = runID;
        return true;
      }
    } catch (_) {}
    return false;
  }

  function clearSaved() { try { localStorage.removeItem(RUN_KEY); } catch (_) {} }

  function discard() {
    stopSamplingQuiet();
    acc = null;
    accRunID = null;
    clearSaved();
    hideNudge();
  }

  /* Start or stop sampling to match the timer and the master switch. */
  function reconcile() {
    const st = env.timer();
    if (!settings().guardEnabled) {
      if (acc || sampling) discard();      // turning Guard off drops this session's record
    } else if (st.mode === 'focus' && st.running) {
      if (!acc || (st.runID && accRunID !== st.runID)) {
        if (!restore(st.runID)) newAcc(st.runID);
      }
      startSampling();
    } else if (sampling) {
      stopSampling();
    }
    renderChip();
    sendBlockerState();
  }

  function onTimer({ type, runID, mode, session } = {}) {
    const m = mode || env.timer().mode;
    switch (type) {
      case 'start':
        clearZoneStat();
        hideNudge();
        if (acc && accRunID !== runID) discard();
        if (m === 'focus' && settings().guardEnabled) { newAcc(runID); startSampling(); }
        break;
      case 'resume':
        hideNudge();
        if (m !== 'focus' || !settings().guardEnabled) break;
        if (!acc || accRunID !== runID) { if (!restore(runID)) newAcc(runID); }
        startSampling();
        break;
      case 'pause':
        stopSampling();
        break;
      case 'stop':
        stopSampling();
        if (nudge && nudge.kind !== 'autoPause') hideNudge();
        break;
      case 'log':
        if (m !== 'focus') break;
        acc = null;
        accRunID = null;
        clearSaved();
        hideNudge();
        renderZoneStat(session);
        break;
      case 'discard':
        if (m === 'focus' || acc) discard();
        break;
      default:
        break;
    }
    renderChip();
    sendBlockerState(type);
  }

  /* The session's drift record (v2-guard §2.3), or null when Guard didn't watch it. */
  function snapshot() {
    mergeExtStats();
    if (!acc) return null;
    const d = IC().guardSnapshot(acc);
    d.signals = d.signals.slice().sort();
    return d;
  }

  function liveRatio() {
    if (!acc || acc.activeSec < 60) return null;
    return IC().guardSnapshot(acc).focusRatio;
  }

  // ═════════════════════════  nudges  ═════════════════════════

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svg(viewBox, paths, cls) {
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', viewBox);
    s.setAttribute('aria-hidden', 'true');
    if (cls) s.setAttribute('class', cls);
    for (const p of paths) {
      const n = document.createElementNS(SVG_NS, p.tag || 'path');
      for (const [k, v] of Object.entries(p)) if (k !== 'tag') n.setAttribute(k, v);
      s.appendChild(n);
    }
    return s;
  }
  function h(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  const STROKE = { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  const HAND = [{ d: 'M8 11.2V5.6a1.3 1.3 0 0 1 2.6 0v4.6M10.6 9.6V4.2a1.3 1.3 0 0 1 2.6 0v5.4M13.2 9.8V5.4a1.3 1.3 0 0 1 2.6 0v5.4M15.8 10.4V8.2a1.3 1.3 0 0 1 2.6 0v5.2c0 3.7-2.7 6.6-6.2 6.6-2.3 0-3.9-1-5.2-2.9L4.6 13.4a1.3 1.3 0 0 1 2.1-1.5L8 13.6', ...STROKE },
    { d: 'M3.6 6.6c.3-1.4 1-2.5 2.1-3.3M19.6 3.6c.9.7 1.5 1.6 1.8 2.7', ...STROKE }];

  function minutesLeft() { return Math.max(1, Math.ceil((env.timer().remaining || 0) / 60)); }
  function clockLeft() {
    const s = Math.max(0, Math.ceil(env.timer().remaining || 0));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }

  function layer() { return document.getElementById('nudge-layer'); }

  function topOffset() {
    const bar = document.querySelector('.topbar');
    const b = bar ? bar.getBoundingClientRect().bottom : 60;
    return Math.round(Math.max(12, b + 12));
  }

  function nudgeButton(label, primary, fn, tip) {
    const b = h('button', 'nudge-btn' + (primary ? ' is-primary' : ''), label);
    b.type = 'button';
    if (tip) b.title = tip;
    b.addEventListener('click', () => safe(fn, 'nudge button'));
    return b;
  }

  function buildNudge(kind, title, body, buttons) {
    const el = h('div', 'nudge');
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.dataset.kind = kind;
    el.style.top = topOffset() + 'px';
    const head = h('div', 'nudge-head');
    head.appendChild(svg('0 0 24 24', HAND, 'nudge-glyph'));
    head.appendChild(h('p', 'nudge-title', title));
    const close = h('button', 'nudge-close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss');
    close.title = 'Dismiss';
    close.appendChild(svg('0 0 12 12', [{ d: 'M3 3l6 6M9 3 3 9', ...STROKE }]));
    close.addEventListener('click', () => (kind === 'autoPause' ? hideNudge() : respond('back')));
    head.appendChild(close);
    el.appendChild(head);
    el.appendChild(h('p', 'nudge-body', body));
    const row = h('div', 'nudge-actions');
    buttons.forEach((b) => row.appendChild(b));
    el.appendChild(row);
    return el;
  }

  function showNudge(kind) {
    if (!acc) return;
    const i = Math.max(0, acc.nudges - 1) % 3;
    const title = (kind === 'distract' ? DISTRACT_TITLES : IDLE_TITLES)[i];
    const why = kind === 'distract' ? 'You’ve been on a site from your list.' : 'No activity on this page for a few minutes.';
    const body = why + ' ' + minutesLeft() + ' min left in this session.';
    const buttons = kind === 'distract'
      ? [nudgeButton('Back to focus', true, () => { respond('back'); try { App.showView('focus'); } catch (_) {} }),
        nudgeButton('Need 5 min', false, () => respond('snooze')),
        nudgeButton('Pause timer', false, () => respond('pause'))]
      : [nudgeButton("I'm back", true, () => respond('back')),
        nudgeButton('Working on paper', false, () => respond('offline'), 'I’m working away from the screen — don’t check in again this session'),
        nudgeButton('Pause timer', false, () => respond('pause'))];
    mountNudge({ kind, title, el: buildNudge(kind, title, body, buttons) });
    chime();
    if (env.hidden() || !env.focused()) setTitleCue();
  }

  function mountNudge(n) {
    hideNudge(true);
    const host = layer();
    if (!host) return;
    nudge = { ...n, hideTimer: null };
    host.appendChild(n.el);
    if (n.kind !== 'autoPause' && !env.hidden()) armNudgeHide();
    document.addEventListener('keydown', onNudgeKey);
  }

  /* 20 s on screen counts as no response (the 20 s start once the page is visible). */
  function armNudgeHide() {
    if (!nudge) return;
    clearTimeout(nudge.hideTimer);
    nudge.hideTimer = setTimeout(() => hideNudge(), NUDGE_HIDE_MS);
  }

  function hideNudge(instant) {
    document.removeEventListener('keydown', onNudgeKey);
    restoreTitle();
    if (!nudge) return;
    const n = nudge;
    nudge = null;
    clearTimeout(n.hideTimer);
    if (instant || !n.el.isConnected) { n.el.remove(); return; }
    n.el.classList.add('is-leaving');
    setTimeout(() => n.el.remove(), 200);
  }

  function onNudgeKey(e) {
    if (e.key !== 'Escape' || !nudge) return;
    if (nudge.kind === 'autoPause') hideNudge();
    else respond('back');
  }

  function chime() {
    if (!settings().guardNudgeSound) return;
    safe(() => {
      if (typeof Audio === 'undefined' || (Audio.isEnabled && !Audio.isEnabled())) return;
      if (Audio.duck) Audio.duck('nudge');
      if (Audio.playShot) Audio.playShot('fx_nudge');
    }, 'chime');
  }

  /* respond('back' | 'offline' | 'snooze' | 'pause') — the check-in's answers. */
  function respond(kind) {
    const t = env.timer().activeElapsed || 0;
    if (acc && ['back', 'offline', 'snooze', 'pause'].includes(kind)) IC().guardRespond(acc, kind, t);
    hideNudge();
    if (kind === 'offline') safe(() => App.toast('Got it. Idle check-ins are off for this session.'), 'toast');
    if (kind === 'pause') safe(() => Timer.pause(), 'pause');
    persist();
  }

  // ── auto-pause ──

  function autoPause(rewind) {
    const pausedAt = Date.now();
    safe(() => Timer.pause({ rewind }), 'auto-pause');
    const buttons = [nudgeButton('Resume', true, () => { hideNudge(); Timer.start(); }),
      nudgeButton('End session', false, () => { hideNudge(); Timer.skip(); })];
    const title = 'Paused while you were away';
    mountNudge({ kind: 'autoPause', title, rewind, pausedAt,
      el: buildNudge('autoPause', title, autoPauseBody(rewind, pausedAt), buttons) });
    if (env.hidden() || !env.focused()) setTitleCue();
  }

  function autoPauseBody(rewind, pausedAt) {
    const n = Math.max(1, Math.round((rewind + (Date.now() - pausedAt) / 1000) / 60));
    return `We stopped the clock ${n} min ago, so those minutes don't count. Ready when you are.`;
  }

  function renderNudgeBody() {
    if (!nudge || nudge.kind !== 'autoPause') return;
    const b = nudge.el.querySelector('.nudge-body');
    if (b) b.textContent = autoPauseBody(nudge.rewind, nudge.pausedAt);
  }

  // ── title cue (hidden page) ──

  function titleCue() { return nudge ? '• ' + nudge.title + ' · ' + clockLeft() : null; }
  function setTitleCue() {
    if (!nudge) return;
    if (savedTitle == null) savedTitle = document.title;
    document.title = titleCue();
  }
  function restoreTitle() {
    if (savedTitle == null) return;
    document.title = savedTitle;
    savedTitle = null;
  }

  // ── end-of-session stat (positive only, v2-guard §4.5) ──

  function zoneRoot() { return document.getElementById('rating-extra-root'); }

  function clearZoneStat() {
    const root = zoneRoot();
    const el = root && root.querySelector('.guard-zone-stat');
    if (el) { el.remove(); safe(() => Timer.render(), 'render'); }
  }

  function zoneStatText(d) {
    if (!d || !(Number(d.focusRatio) >= 0.8) || !(Number(d.activeSec) >= 300)) return null;
    let t = 'In the zone ' + Math.round(d.focusRatio * 100) + ' %';
    if (d.nudges > 0) t += ' · ' + d.nudges + (d.nudges === 1 ? ' nudge' : ' nudges');
    if (d.nudgeReturns >= 1) t += ' · came right back';
    return t;
  }

  function renderZoneStat(session) {
    const root = zoneRoot();
    if (!root) return;
    const old = root.querySelector('.guard-zone-stat');
    if (old) old.remove();
    const text = zoneStatText(session && session.drift);
    if (!text) return;
    const p = h('p', 'guard-zone-stat');
    p.appendChild(svg('0 0 16 16', [{ d: 'M8 1.8l1.5 3.9 3.9 1.5-3.9 1.5L8 12.6 6.5 8.7 2.6 7.2l3.9-1.5L8 1.8Z', fill: 'currentColor' }]));
    p.appendChild(h('span', null, text));
    root.prepend(p);
  }

  // ═════════════════════════  shield chip + popover (v2-guard §7.1)  ═════════════════════════

  const SHIELD = 'M12 2.8 4.8 5.6v5.6c0 4.5 3 8.3 7.2 9.9 4.2-1.6 7.2-5.4 7.2-9.9V5.6L12 2.8Z';
  const CHIP_ICONS = {
    off: [{ d: SHIELD, ...STROKE, 'stroke-width': '1.8' }],
    on: [{ d: SHIELD, ...STROKE, 'stroke-width': '1.8' }, { d: 'M12 2.8v18.3c-4.2-1.6-7.2-5.4-7.2-9.9V5.6L12 2.8Z', fill: 'currentColor' }],
    block: [{ d: SHIELD + 'M12 8.6a1.9 1.9 0 0 0-.95 3.55V15h1.9v-2.85A1.9 1.9 0 0 0 12 8.6Z', fill: 'currentColor', 'fill-rule': 'evenodd' }],
  };
  let chipEl = null;
  let pop = null;              // {el, onDoc, onKey}

  const isChromium = () => /Chrome\/|Chromium\/|Edg\//.test(navigator.userAgent || '') && !/Firefox\//.test(navigator.userAgent || '');
  const webItems = (list) => (list || []).filter((it) => it && (it.kind === 'domain' || it.kind === 'url'));
  const blockedItems = () => webItems(settings().guardList).filter((it) => it.block !== false);
  function countLabel(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  function chipState() {
    const s = settings();
    if (!s.guardEnabled) return 'off';
    if (s.blockEnabled && blocker.present && blockedItems().length) return 'block';
    return 'on';
  }

  function chipLabel(state) {
    if (state === 'off') return 'Focus Guard: off';
    if (state === 'block') return 'Focus Guard: on, blocking ' + countLabel(blockedItems().length, 'item', 'items');
    return 'Focus Guard: on';
  }
  /* The visible chip text (H5: no mystery buttons) and the longer hover tooltip. */
  function chipText(state) { return state === 'off' ? 'Focus Guard: Off' : 'Focus Guard: On'; }
  function chipTip(state) {
    if (state === 'off') return 'Focus Guard is off. Click to see what it does and turn it on.';
    if (state === 'block') return 'Focus Guard is on: it checks in if you drift during focus and blocks ' + countLabel(blockedItems().length, 'site', 'sites') + '. Click to change.';
    return 'Focus Guard is on: it gently checks in if you drift away during a focus session. Click to change.';
  }

  function renderChip() {
    const root = document.getElementById('guard-chip-root');
    if (!root) return;
    if (!chipEl || !chipEl.isConnected) {
      root.textContent = '';
      chipEl = h('button', 'guard-chip');
      chipEl.id = 'guard-chip';
      chipEl.type = 'button';
      chipEl.setAttribute('aria-haspopup', 'dialog');
      chipEl.setAttribute('aria-expanded', 'false');
      chipEl.addEventListener('click', (e) => { e.stopPropagation(); pop ? closePopover() : openPopover(); });
      root.appendChild(chipEl);
    }
    const state = chipState();
    if (chipEl.dataset.state !== state) {
      chipEl.dataset.state = state;
      chipEl.textContent = '';
      chipEl.appendChild(svg('0 0 24 24', CHIP_ICONS[state]));
      chipEl.appendChild(h('span', 'guard-chip-label', chipText(state)));
    }
    const label = chipLabel(state);
    chipEl.setAttribute('aria-label', label);
    chipEl.title = chipTip(state);
    if (pop) renderPopover();
  }

  function openPopover() {
    if (pop || !chipEl) return;
    const el = h('div', 'guard-pop');
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Focus Guard');
    document.body.appendChild(el);
    const onDoc = (e) => { if (!el.contains(e.target) && e.target !== chipEl && !chipEl.contains(e.target)) closePopover(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePopover(true); } };
    const onResize = () => placePopover();
    pop = { el, onDoc, onKey, onResize };
    renderPopover();
    document.addEventListener('pointerdown', onDoc, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    chipEl.setAttribute('aria-expanded', 'true');
    const first = el.querySelector('input, button');
    if (first) try { first.focus({ preventScroll: true }); } catch (_) {}
  }

  function closePopover(refocus) {
    if (!pop) return;
    const p = pop;
    pop = null;
    document.removeEventListener('pointerdown', p.onDoc, true);
    document.removeEventListener('keydown', p.onKey);
    window.removeEventListener('resize', p.onResize);
    p.el.remove();
    if (chipEl) {
      chipEl.setAttribute('aria-expanded', 'false');
      if (refocus) try { chipEl.focus({ preventScroll: true }); } catch (_) {}
    }
  }

  /* Above the chip (it sits low on the stage), clamped 16 px inside the viewport. */
  function placePopover() {
    if (!pop || !chipEl) return;
    const r = chipEl.getBoundingClientRect();
    const w = pop.el.offsetWidth, ht = pop.el.offsetHeight;
    const left = Math.min(window.innerWidth - 16 - w, Math.max(16, r.left + r.width / 2 - w / 2));
    let top = r.top - 10 - ht;
    if (top < 16) top = Math.min(window.innerHeight - 16 - ht, r.bottom + 10);
    pop.el.style.left = Math.round(left) + 'px';
    pop.el.style.top = Math.round(Math.max(16, top)) + 'px';
  }

  function switchInput(checked, label, onChange) {
    const wrapEl = h('label', 'toggle guard-switch');
    const input = h('input');
    input.type = 'checkbox';
    input.checked = !!checked;
    input.setAttribute('aria-label', label);
    input.addEventListener('change', () => safe(() => onChange(input.checked), 'switch'));
    wrapEl.append(input, h('span', 'switch'));
    return { el: wrapEl, input };
  }

  function chevron() { return svg('0 0 16 16', [{ d: 'M6 3.5 10.5 8 6 12.5', ...STROKE }], 'guard-chevron'); }

  function nudgeSummary(s) {
    if (!s.guardNudge && !s.guardAutoPause) return 'Off — no check-ins';
    const parts = [];
    if (s.guardNudge) parts.push('After ' + Math.round((s.guardIdleSeconds + s.guardNudgeAfter) / 60) + ' min with no activity here');
    if (s.guardAutoPause) parts.push('pauses if you leave');
    return parts.join(' · ');
  }

  function blockerStatusText() {
    if (blocker.present) return 'Extension connected ✓';
    return isChromium() ? 'Needs the free Pure Focus Blocker extension' : 'Not available in this browser — needs Chrome, Edge, Brave or Arc';
  }

  /* Plain-language "what it does" (shown while Guard is off, i.e. the first time). */
  function explainer() {
    const box = h('div', 'gp-explain');
    box.appendChild(h('p', 'gp-caption', 'Helps you stay on task while a focus session runs:'));
    const ul = h('ul', 'gp-points');
    for (const line of [
      'If this page sees no activity for a few minutes, it asks “Still with it?”',
      'It can pause the timer while you’re away, so away time doesn’t count.',
      'It can block sites you choose (Chrome, Edge, Brave or Arc).',
    ]) ul.appendChild(h('li', null, line));
    box.appendChild(ul);
    box.appendChild(h('p', 'gp-privacy', 'Off outside focus sessions. It keeps only totals — never what you look at.'));
    return box;
  }

  // Rebuilding a list under a keyboard user mustn't lose their place.
  function keepFocus(root, rebuild) {
    const items = () => Array.from(root.querySelectorAll('button, input'));
    const at = items().indexOf(document.activeElement);
    rebuild();
    if (at < 0) return;
    const now = items();
    const f = now[Math.min(at, now.length - 1)];
    if (f) f.focus({ preventScroll: true });
  }

  function renderPopover() { keepFocus(pop, fillPopover); }

  function fillPopover() {
    if (!pop) return;
    const s = settings();
    const el = pop.el;
    el.textContent = '';
    const head = h('div', 'gp-head');
    head.appendChild(svg('0 0 24 24', CHIP_ICONS[s.guardEnabled ? 'on' : 'off'], 'gp-glyph'));
    const ht = h('span', 'gp-head-text');
    ht.append(h('span', 'gp-title', 'Focus Guard'), h('span', 'gp-state', s.guardEnabled ? 'On' : 'Off'));
    head.appendChild(ht);
    head.appendChild(switchInput(s.guardEnabled, 'Focus Guard', (on) => setEnabled(on)).el);
    el.appendChild(head);
    if (!s.guardEnabled) {
      el.appendChild(explainer());
      const on = h('button', 'btn btn-primary gp-turn-on', 'Turn on Focus Guard');
      on.type = 'button';
      on.addEventListener('click', () => setEnabled(true));
      el.appendChild(on);
    } else {
      const drift = h('button', 'gp-row gp-row--btn');
      drift.type = 'button';
      drift.title = 'Change when check-ins happen (Settings › Focus Guard)';
      const dt = h('span', 'gp-row-text');
      dt.append(h('span', 'gp-row-title', 'Gentle check-ins'), h('span', 'gp-row-sub', nudgeSummary(s)));
      drift.append(dt, chevron());
      drift.addEventListener('click', () => { closePopover(); Settings.open('guard'); });
      el.appendChild(drift);

      const canBlock = blocker.present;
      const blk = h('div', 'gp-row' + (canBlock ? '' : ' is-unavailable'));
      const bt = h('span', 'gp-row-text');
      bt.appendChild(h('span', 'gp-row-title', 'Block sites during focus'));
      if (canBlock) {
        const edit = h('button', 'gp-link', countLabel(webItems(s.guardList).length, 'site', 'sites') + ' · Edit list…');
        edit.type = 'button';
        edit.addEventListener('click', () => { closePopover(); openListSheet(chipEl); });
        bt.appendChild(edit);
      } else {
        bt.appendChild(h('span', 'gp-row-sub', blockerStatusText()));
        const how = h('button', 'gp-link', isChromium() ? 'Get the extension' : 'How it works');
        how.type = 'button';
        how.addEventListener('click', () => { closePopover(); openExtensionGuide(chipEl); });
        bt.appendChild(how);
      }
      const sw = switchInput(canBlock && s.blockEnabled, 'Block sites during focus', (on) => Store.setSetting('blockEnabled', on));
      if (!canBlock) { sw.input.disabled = true; sw.el.title = 'Needs the browser extension'; }
      blk.append(bt, sw.el);
      el.appendChild(blk);

      const ratio = liveRatio();
      if (ratio != null && ratio >= 0.8) el.appendChild(h('p', 'gp-live', 'In the zone ' + Math.round(ratio * 100) + ' % this session'));
    }
    const foot = h('div', 'gp-foot');
    const more = h('button', 'gp-link', 'All Focus Guard settings…');
    more.type = 'button';
    more.addEventListener('click', () => { closePopover(); Settings.open('guard'); });
    foot.appendChild(more);
    el.appendChild(foot);
    placePopover();
  }

  function setEnabled(on) {
    if (on) markCoachDone();
    Store.setSetting('guardEnabled', !!on);
  }

  // ═════════════════════════  Settings › Focus Guard (v2-guard §7.2)  ═════════════════════════

  let section = null;          // {el, refs, sync}

  function prefRow(title, hint, control, cls) {
    const row = h('div', 'pref-row guard-pref' + (cls ? ' ' + cls : ''));
    const text = h('div', 'pref-text');
    const t = h('span', 'pref-title', title);
    text.appendChild(t);
    const hintEl = hint != null ? h('span', 'pref-hint', hint) : null;
    if (hintEl) text.appendChild(hintEl);
    row.appendChild(text);
    if (control) row.appendChild(control);
    return { row, title: t, hint: hintEl };
  }

  function segmented(label, options, get, set) {
    const seg = h('div', 'segmented guard-seg');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', label);
    seg.style.setProperty('--seg-n', String(options.length));
    const buttons = options.map(([value, text]) => {
      const b = h('button', 'seg-btn', text);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.value = String(value);
      b.addEventListener('click', () => set(value));
      seg.appendChild(b);
      return b;
    });
    const sync = () => {
      const cur = String(get());
      buttons.forEach((b) => { const on = b.dataset.value === cur; b.classList.toggle('is-active', on); b.setAttribute('aria-checked', String(on)); });
    };
    sync();
    return { el: seg, sync };
  }

  function renderSection(host) {
    host.textContent = '';
    const s0 = settings();
    const card = h('div', 'glass card settings-card guard-card');
    const refs = {};
    const syncs = [];

    // 1 · hero
    const heroSw = switchInput(s0.guardEnabled, 'Focus Guard', (on) => setEnabled(on));
    heroSw.input.id = 'gs-enabled';
    const hero = h('div', 'pref-row guard-hero');
    const heroIcon = h('span', 'guard-hero-icon');
    heroIcon.appendChild(svg('0 0 24 24', CHIP_ICONS.on));
    const heroText = h('div', 'pref-text');
    heroText.append(h('span', 'guard-hero-title', 'Focus Guard'),
      h('span', 'pref-hint', 'While a focus session runs, it gently checks in if you stop using this page — and can pause the timer or block sites. Off the rest of the time.'));
    hero.append(heroIcon, heroText, heroSw.el);
    card.appendChild(hero);
    syncs.push(() => { heroSw.input.checked = !!settings().guardEnabled; });

    // 2–6 · collapse while off
    const collapse = h('div', 'guard-collapse');
    const inner = h('div', 'guard-collapse-inner settings-rows');
    collapse.appendChild(inner);

    const nudgeSw = switchInput(s0.guardNudge, 'Gentle check-ins when I drift', (on) => Store.setSetting('guardNudge', on));
    const r2 = prefRow('Gentle check-ins when I drift', '', nudgeSw.el);
    inner.appendChild(r2.row);
    syncs.push(() => {
      const s = settings();
      nudgeSw.input.checked = !!s.guardNudge;
      let t = 'After ' + Math.round((s.guardIdleSeconds + s.guardNudgeAfter) / 60) + ' min with no activity on this page';
      if (blocker.present) t += ' or ' + Math.round(s.guardNudgeAfter / 60) + ' min on a listed site';
      r2.hint.textContent = t + ' · at most 2 per session';
    });

    const apSw = switchInput(s0.guardAutoPause, "Pause the timer if I'm away", (on) => Store.setSetting('guardAutoPause', on));
    inner.appendChild(prefRow("Pause the timer if I'm away", "Away minutes won't count toward the session.", apSw.el).row);
    syncs.push(() => { apSw.input.checked = !!settings().guardAutoPause; });

    const blkSw = switchInput(s0.blockEnabled, 'Block listed sites during focus', (on) => Store.setSetting('blockEnabled', on));
    const r4 = prefRow('Block listed sites during focus', '', blkSw.el);
    inner.appendChild(r4.row);
    syncs.push(() => {
      blkSw.input.checked = !!settings().blockEnabled;
      r4.hint.textContent = blocker.present ? 'Only while a session runs. Pausing opens them again.' : (isChromium() ? 'Needs the free Pure Focus Blocker extension (see Browser blocker below).' : 'Not available in this browser — needs Chrome, Edge, Brave or Arc with the Pure Focus Blocker extension.');
    });

    const listBtn = h('button', 'pref-row guard-link-row');
    listBtn.type = 'button';
    listBtn.id = 'gs-list';
    const lt = h('span', 'pref-text');
    const listCount = h('span', 'pref-hint');
    lt.append(h('span', 'pref-title', 'Distraction list'), listCount);
    const listTail = h('span', 'guard-row-tail');
    listTail.appendChild(chevron());
    listBtn.append(lt, listTail);
    listBtn.addEventListener('click', () => openListSheet(listBtn));
    inner.appendChild(listBtn);
    syncs.push(() => {
      const n = webItems(settings().guardList).length;
      listCount.textContent = n ? countLabel(n, 'site or link', 'sites and links') : 'Add the sites that pull you away';
    });

    const extStatus = h('span', 'pref-hint');
    const extRow = prefRow('Browser blocker', null, null);
    extRow.row.querySelector('.pref-text').appendChild(extStatus);
    const getExt = h('button', 'btn btn-glass btn-sm', isChromium() ? 'Get the extension' : 'How it works');
    getExt.type = 'button';
    getExt.addEventListener('click', () => openExtensionGuide(getExt));
    extRow.row.appendChild(getExt);
    inner.appendChild(extRow.row);
    syncs.push(() => { extStatus.textContent = blockerStatusText(); getExt.hidden = blocker.present; });

    card.appendChild(collapse);

    // More Focus Guard options (T2)
    const more = h('details', 'settings-more guard-more');
    const sum = h('summary', null, 'More Focus Guard options');
    more.appendChild(sum);
    const mb = h('div', 'settings-more-body');
    const MIN4 = [[60, '1 min'], [120, '2 min'], [180, '3 min'], [300, '5 min']];
    const segAfter = segmented('Then check in after', MIN4, () => settings().guardNudgeAfter, (v) => Store.setSetting('guardNudgeAfter', v));
    const segIdle = segmented('Count me idle after', MIN4, () => settings().guardIdleSeconds, (v) => Store.setSetting('guardIdleSeconds', v));
    mb.appendChild(prefRow('Count me idle after', 'With no key press, click or scroll on this page', segIdle.el).row);
    mb.appendChild(prefRow('Then check in after', 'More minutes of being idle (or on a listed site)', segAfter.el).row);
    const segPause = segmented('Pause after', [[180, '3 min'], [300, '5 min'], [600, '10 min']], () => settings().guardAutoPauseAfter,
      (v) => Store.setSetting('guardAutoPauseAfter', v));
    mb.appendChild(prefRow('Pause the timer after', 'Of being away, if “Pause the timer if I’m away” is on', segPause.el).row);
    syncs.push(segAfter.sync, segIdle.sync, segPause.sync);

    const chimeSw = switchInput(s0.guardNudgeSound, 'Soft chime', (on) => Store.setSetting('guardNudgeSound', on));
    mb.appendChild(prefRow('Soft chime', 'A quiet two-note cue with each check-in', chimeSw.el).row);
    syncs.push(() => { chimeSw.input.checked = !!settings().guardNudgeSound; });
    refs.moreBody = mb;

    const stepper = h('div', 'guard-stepper');
    const minus = h('button', 'icon-btn small', '−');
    minus.type = 'button';
    minus.setAttribute('aria-label', 'Fewer passes');
    const out = h('output', 'guard-stepper-value');
    const plus = h('button', 'icon-btn small', '+');
    plus.type = 'button';
    plus.setAttribute('aria-label', 'More passes');
    minus.addEventListener('click', () => Store.setSetting('blockPasses', settings().blockPasses - 1));
    plus.addEventListener('click', () => Store.setSetting('blockPasses', settings().blockPasses + 1));
    stepper.append(minus, out, plus);
    mb.appendChild(prefRow('Passes per session', 'How many times you can open a blocked site for 5 min', stepper).row);
    syncs.push(() => { const n = settings().blockPasses; out.textContent = String(n); minus.disabled = n <= 0; plus.disabled = n >= 5; });

    const brkSw = switchInput(s0.blockDuringBreaks, 'Also during breaks', (on) => Store.setSetting('blockDuringBreaks', on));
    mb.appendChild(prefRow('Also block during breaks', null, brkSw.el).row);
    syncs.push(() => { brkSw.input.checked = !!settings().blockDuringBreaks; });

    const segAsk = segmented('Ask what helped after a session', [['every', 'Every'], ['daily', 'Daily'], ['off', 'Off']],
      () => settings().factorsPrompt, (v) => Store.setSetting('factorsPrompt', v));
    const askRow = prefRow('Ask what helped after a session', 'A few optional chips after you rate — they feed Insights', segAsk.el);
    askRow.row.id = 'gs-factors';
    mb.appendChild(askRow.row);
    syncs.push(segAsk.sync);

    const how = h('details', 'guard-how');
    how.appendChild(h('summary', null, 'How blocking works'));
    const howList = h('ul', 'guard-how-list');
    for (const line of [
      "A website can't block other tabs or sites — the browser doesn't allow it. That's why the Pure Focus Blocker extension exists (Chrome, Edge, Brave, Arc).",
      'With the extension, listed sites are blocked only while a focus session runs. Pausing opens them again, and blocked tabs reopen by themselves when the session ends.',
      'Only whole pages are blocked, so lectures embedded in Canvas or Blackbaud keep playing.',
      "Safari: the Pure Focus Mac app can swap the front tab for its block page. Firefox isn't supported yet.",
      "System-wide blocking without an extension would need Apple's Screen Time API or a network filter, which this app can't use.",
    ]) howList.appendChild(h('li', null, line));
    how.appendChild(howList);
    mb.appendChild(how);
    more.appendChild(mb);
    card.appendChild(more);

    host.appendChild(card);
    host.appendChild(h('p', 'guard-privacy', 'Everything stays on this device. Pure Focus saves only per-session totals (like “3 min idle”), never what you type, window titles or your browsing history. With cloud sync, those totals go to your own account only.'));

    const sync = () => {
      const on = !!settings().guardEnabled;
      card.classList.toggle('is-off', !on);
      if (on) inner.removeAttribute('inert'); else inner.setAttribute('inert', '');
      more.hidden = !on;
      syncs.forEach((f) => safe(f, 'section sync'));
    };
    sync();
    section = { el: host, sync };
  }

  // ═════════════════════════  distraction list sheet  ═════════════════════════

  const SUGGESTED = ['youtube.com', 'tiktok.com', 'instagram.com', 'reddit.com', 'x.com', 'facebook.com', 'netflix.com',
    'twitch.tv', 'discord.com', 'snapchat.com', 'pinterest.com', 'roblox.com'];
  const GLOBE = [{ tag: 'circle', cx: '8', cy: '8', r: '6.2', ...STROKE, 'stroke-width': '1.3' },
    { d: 'M1.8 8h12.4M8 1.8c1.8 1.7 2.6 3.8 2.6 6.2S9.8 12.5 8 14.2C6.2 12.5 5.4 10.4 5.4 8S6.2 3.5 8 1.8Z', ...STROKE, 'stroke-width': '1.3' }];
  const LINK = [{ d: 'M6.6 9.4 9.4 6.6M7.2 4.6l1-1a2.7 2.7 0 0 1 3.8 3.8l-1 1M8.8 11.4l-1 1a2.7 2.7 0 0 1-3.8-3.8l1-1', ...STROKE, 'stroke-width': '1.4' }];

  function protectedHost(host) {
    const own = String(location.hostname || '').toLowerCase().replace(/^www\./, '');
    return !!host && (host === own || ['localhost', '127.0.0.1'].includes(host));
  }

  function addItem(entry) {
    const list = (settings().guardList || []).slice();
    if (list.some((it) => String(it.id).toLowerCase() === entry.key.toLowerCase())) return false;
    list.push({ id: entry.key, kind: entry.kind, value: entry.value, name: entry.value, block: true, addedAt: new Date().toISOString() });
    Store.setSetting('guardList', list);
    return true;
  }

  function updateItems(fn) {
    const list = (settings().guardList || []).map((it) => ({ ...it }));   // app items ride along untouched
    fn(list);
    Store.setSetting('guardList', list);
  }

  let sheet = null;            // {backdrop, el, opener, render, onKey}

  function closeSheet() {
    if (!sheet) return;
    const sh = sheet;
    sheet = null;
    document.removeEventListener('keydown', sh.onKey, true);
    sh.backdrop.remove();
    sh.el.remove();
    if (sh.opener && sh.opener.isConnected) try { sh.opener.focus({ preventScroll: true }); } catch (_) {}
  }

  function openSheetShell(title, opener, cls) {
    closeSheet();
    closePopover();
    const backdrop = h('div', 'sheet-backdrop guard-backdrop');
    const el = h('div', 'sheet guard-sheet' + (cls ? ' ' + cls : ''));
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', title);
    const header = h('header', 'sheet-header');
    header.appendChild(h('h2', null, title));
    const x = h('button', 'icon-btn small guard-sheet-close');
    x.type = 'button';
    x.setAttribute('aria-label', 'Close');
    x.appendChild(svg('0 0 12 12', [{ d: 'M3 3l6 6M9 3 3 9', ...STROKE }]));
    x.addEventListener('click', closeSheet);
    header.appendChild(x);
    const body = h('div', 'sheet-body');
    const footer = h('footer', 'sheet-footer');
    const done = h('button', 'btn btn-primary', 'Done');
    done.type = 'button';
    done.addEventListener('click', closeSheet);
    footer.appendChild(done);
    el.append(header, body, footer);
    backdrop.addEventListener('click', closeSheet);
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closeSheet(); return; }
      if (e.key === 'Tab') {                 // keep focus inside the sheet
        const f = Array.from(el.querySelectorAll('button, input, [tabindex]:not([tabindex="-1"])')).filter((n) => !n.disabled && n.offsetParent !== null);
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    document.body.append(backdrop, el);
    sheet = { backdrop, el, body, opener: opener || document.activeElement, onKey, render: null };
    return sheet;
  }

  function openListSheet(opener) {
    const sh = openSheetShell('Distraction list', opener, 'guard-list-sheet');
    const body = sh.body;
    body.appendChild(h('p', 'guard-sheet-lede', 'Sites and links that pull you away. Pure Focus notices them during focus and, with the blocker, keeps them closed until the session ends.'));

    const form = h('form', 'guard-add');
    form.setAttribute('novalidate', '');
    const input = h('input', 'text-input');
    input.type = 'text';
    input.placeholder = 'Website or link, like youtube.com';
    input.setAttribute('aria-label', 'Website or link');
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('autocapitalize', 'off');
    const addBtn = h('button', 'btn btn-glass btn-sm', 'Add');
    addBtn.type = 'submit';
    form.append(input, addBtn);
    const msg = h('p', 'guard-add-msg');
    msg.setAttribute('aria-live', 'polite');
    const confirmRow = h('div', 'guard-confirm');
    confirmRow.hidden = true;
    body.append(form, msg, confirmRow);

    const listEl = h('ul', 'guard-items');
    listEl.setAttribute('aria-label', 'Your distraction list');
    body.appendChild(listEl);
    const sugWrap = h('div', 'guard-suggest');
    body.appendChild(sugWrap);

    let pending = null;
    const validate = () => {
      const raw = input.value.trim();
      confirmRow.hidden = true;
      pending = null;
      if (!raw) { msg.textContent = ''; msg.className = 'guard-add-msg'; return null; }
      const e = GuardRules.normaliseEntry(raw);
      msg.className = 'guard-add-msg';
      if (!e) { msg.textContent = 'Enter a site like youtube.com or a link like reddit.com/r/all.'; msg.classList.add('is-error'); return null; }
      const host = e.kind === 'domain' ? e.value : e.value.slice(0, e.value.indexOf('/'));
      if (protectedHost(host)) { msg.textContent = "That's Pure Focus itself, so it can't go on the list."; msg.classList.add('is-error'); return null; }
      if ((settings().guardList || []).some((it) => String(it.id).toLowerCase() === e.key)) { msg.textContent = 'Already on your list.'; return null; }
      msg.textContent = e.kind === 'domain' ? 'Website · ' + e.value : 'Link · ' + e.value;
      return e;
    };
    input.addEventListener('input', validate);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const e = validate();
      if (!e) return;
      if (GuardRules.schoolHint(e)) {
        pending = e;
        confirmRow.textContent = '';
        confirmRow.appendChild(h('span', null, 'This looks like a school site. Block it anyway?'));
        const yes = h('button', 'btn btn-glass btn-sm', 'Block');
        yes.type = 'button';
        yes.addEventListener('click', () => { if (pending) { addItem(pending); input.value = ''; validate(); render(); input.focus(); } });
        const no = h('button', 'link-btn', 'Cancel');
        no.type = 'button';
        no.addEventListener('click', () => { confirmRow.hidden = true; pending = null; input.focus(); });
        confirmRow.append(yes, no);
        confirmRow.hidden = false;
        yes.focus();
        return;
      }
      addItem(e);
      input.value = '';
      validate();
      render();
    });

    function render() { keepFocus(listEl, fillList); }

    function fillList() {
      const items = webItems(settings().guardList);
      listEl.textContent = '';
      if (!items.length) {
        const empty = h('li', 'guard-empty', 'Nothing listed yet. Add a site above or pick a suggestion.');
        listEl.appendChild(empty);
      }
      for (const it of items) {
        const li = h('li', 'guard-item');
        const ic = h('span', 'guard-item-icon');
        ic.appendChild(svg('0 0 16 16', it.kind === 'url' ? LINK : GLOBE));
        const text = h('span', 'guard-item-text');
        text.append(h('span', 'guard-item-name', it.name || it.value), h('span', 'guard-item-kind', it.kind === 'url' ? 'Link' : 'Website'));
        const sw = switchInput(it.block !== false, 'Block ' + (it.name || it.value), (on) =>
          updateItems((list) => { const x = list.find((y) => y.id === it.id); if (x) x.block = on; }));
        sw.el.classList.add('guard-item-block');
        sw.el.title = it.block !== false ? 'Blocked during focus' : 'Watch only';
        const rm = h('button', 'icon-btn small guard-item-remove');
        rm.type = 'button';
        rm.setAttribute('aria-label', 'Remove ' + (it.name || it.value));
        rm.title = 'Remove';
        rm.appendChild(svg('0 0 12 12', [{ d: 'M3 3l6 6M9 3 3 9', ...STROKE }]));
        rm.addEventListener('click', () => { updateItems((list) => { const i = list.findIndex((y) => y.id === it.id); if (i >= 0) list.splice(i, 1); }); render(); input.focus(); });
        li.append(ic, text, sw.el, rm);
        listEl.appendChild(li);
      }
      if (items.length) {
        const cap = h('li', 'guard-items-cap', 'Switch off “Block” to only notice a site, never block it.');
        listEl.appendChild(cap);
      }
      sugWrap.textContent = '';
      const have = new Set(items.map((it) => String(it.id).toLowerCase()));
      const sug = SUGGESTED.filter((d) => !have.has('domain:' + d));
      if (sug.length) {
        sugWrap.appendChild(h('p', 'guard-suggest-title', 'Suggestions'));
        const chips = h('div', 'guard-chips');
        for (const d of sug) {
          const c = h('button', 'guard-sugg', '+ ' + d);
          c.type = 'button';
          c.setAttribute('aria-label', 'Add ' + d);
          c.addEventListener('click', () => { addItem(GuardRules.normaliseEntry(d)); render(); });
          chips.appendChild(c);
        }
        sugWrap.appendChild(chips);
      }
    }
    sh.render = render;
    render();
    setTimeout(() => { try { input.focus({ preventScroll: true }); } catch (_) {} }, 0);
  }

  function openExtensionGuide(opener) {
    const sh = openSheetShell('Pure Focus Blocker', opener, 'guard-ext-sheet');
    const b = sh.body;
    b.appendChild(h('p', 'guard-sheet-lede', 'A small browser extension that keeps the sites on your list closed while a focus session runs — and reopens them when it ends. It stores nothing about your browsing.'));
    const steps = h('ol', 'guard-steps');
    for (const line of [
      'Open Chrome, Edge, Brave or Arc and go to chrome://extensions.',
      'Turn on Developer mode (top right).',
      'Click “Load unpacked” and choose the extension/pure-focus-blocker folder inside your Pure Focus web folder.',
      'Come back here: this row will say “Extension connected ✓”.',
    ]) steps.appendChild(h('li', null, line));
    b.appendChild(steps);
    b.appendChild(h('p', 'guard-sheet-note', isChromium()
      ? 'If you move the folder later, load it again from the new place.'
      : "This browser can't run the extension. Safari users can use the Pure Focus Mac app, which blocks sites in Safari."));
  }

  // ═════════════════════════  focus-factor check-in (v2-guard §6.6)  ═════════════════════════

  const ASK_KEY = 'purefocus.factors.asked';   // day key of the last "daily" check-in
  const NOTES = [['notes.handwritten', 'Handwritten'], ['notes.typed', 'Typed'], ['notes.flashcards', 'Flashcards'], ['notes.practice', 'Practice problems']];
  const DAY_CHIPS = [['slept', 'Slept well'], ['caffeine', 'Caffeine'], ['exercise', 'Exercised']];
  const EVERY_CHIPS = [['phoneAway', 'Phone away'], ['quiet', 'Quiet space'], ['plan', 'Clear plan'], ['friends', 'With friends'], ['water', 'Water'], ['breaks', 'Took breaks']];
  const MORE_CHIPS = [['library', 'At the library'], ['home', 'At home'], ['comfortable', 'Comfortable setup'], ['meal', 'Good meal'],
    ['deadline', 'A deadline'], ['studyBuddy', 'Study buddy'], ['morning', 'Morning'], ['evening', 'Evening']];
  // Keep in step with Store.FACTOR_IDS and InsightsCore.FACTORS (display order).
  const FACTOR_ORDER = ['phoneAway', 'quiet', 'plan', 'friends', 'water', 'breaks',
    'notes.handwritten', 'notes.typed', 'notes.flashcards', 'notes.practice',
    'slept', 'caffeine', 'exercise', 'library', 'home', 'comfortable', 'meal', 'deadline', 'studyBuddy', 'morning', 'evening'];
  const CHECK = [{ d: 'M2.5 6.4 5 8.8 9.6 3.6', ...STROKE, 'stroke-width': '1.8' }];
  let checkin = null;          // {el, sessionID, selected: Set, none, timer, menu}

  function localDay(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function askedDay() { try { return localStorage.getItem(ASK_KEY); } catch (_) { return null; } }
  function setAskedDay(k) { try { localStorage.setItem(ASK_KEY, k); } catch (_) {} }
  const sameID = (a, b) => a != null && b != null && String(a).toLowerCase() === String(b).toLowerCase();

  function onRated(p) {
    clearZoneStat();
    if (!p || p.skipped || p.rating == null) return;
    safe(() => maybeCheckIn(p.sessionID), 'check-in');
  }

  /* After a rating on a qualified focus session: every · once a day (default) · off. */
  function maybeCheckIn(id) {
    const mode = settings().factorsPrompt;
    if (mode === 'off') return false;
    const s = Store.sessions().find((x) => sameID(x.id, id));
    if (!s || s.mode !== 'focus' || s.factors != null) return false;
    if (!IC().derive(s).qualified) return false;
    const today = localDay(new Date());
    if (mode === 'daily' && askedDay() === today) return false;
    const day = localDay(new Date(s.start));
    const first = !Store.sessions().some((x) => x !== s && x.factors != null && localDay(new Date(x.start)) === day);
    setAskedDay(today);
    showCheckIn(s.id, first);
    return true;
  }

  function factorsValue() {
    if (!checkin) return null;
    if (checkin.none) return [];
    const ids = FACTOR_ORDER.filter((f) => checkin.selected.has(f));
    return ids.length ? ids : null;
  }

  function saveFactors() {
    if (!checkin) return;
    Store.setSessionFactors(checkin.sessionID, factorsValue());
  }

  // The chips stay until you press Done or start your next focus session — no countdown (each tap
  // is saved as you go). Only "None of these" closes them by itself, after a beat.
  function armCheckinClose() {
    if (!checkin) return;
    clearTimeout(checkin.timer);
  }

  function closeCheckIn() {
    if (!checkin) return;
    const c = checkin;
    checkin = null;
    clearTimeout(c.timer);
    closeNotesMenu(c);
    c.el.remove();
    safe(() => Timer.render(), 'render');
  }

  function chipButton(label, pressed) {
    const b = h('button', 'fc-chip');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(!!pressed));
    const check = svg('0 0 12 12', CHECK, 'fc-check');
    const text = h('span', 'fc-label', label);
    b.append(check, text);
    return b;
  }

  function showCheckIn(sessionID, firstOfDay) {
    closeCheckIn();
    const root = zoneRoot();
    if (!root) return;
    const el = h('div', 'factor-checkin');
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', 'Optional focus factors');
    el.title = 'Tap anything that was true for this session. Reports › Insights uses it to show what helps you focus.';
    el.appendChild(h('p', 'fc-title', 'What went well this session? Tap any (optional)'));
    const row = h('div', 'fc-row');
    const chips = h('div', 'fc-chips');
    row.appendChild(chips);
    const done = h('button', 'link-btn fc-done', 'Done');
    done.type = 'button';
    done.title = 'Close — your choices are already saved';
    done.addEventListener('click', () => closeCheckIn());
    row.appendChild(done);
    el.appendChild(row);
    checkin = { el, sessionID, selected: new Set(), none: false, timer: null, menu: null, chips: {} };

    const sync = () => {
      if (!checkin) return;
      for (const [id, b] of Object.entries(checkin.chips)) {
        let on;
        if (id === 'none') on = checkin.none;
        else if (id === 'notes') {
          const pick = NOTES.find(([n]) => checkin.selected.has(n));
          on = !!pick;
          b.querySelector('.fc-label').textContent = pick ? 'Notes: ' + pick[1] : 'How I took notes';
        } else if (id === 'more') {
          const n = MORE_CHIPS.filter(([f]) => checkin.selected.has(f)).length;
          on = n > 0;
          b.querySelector('.fc-label').textContent = n ? `More options (${n})` : 'More options';
        } else on = checkin.selected.has(id);
        b.setAttribute('aria-pressed', String(on));
      }
    };
    const touch = () => { sync(); saveFactors(); armCheckinClose(); };

    const list = (firstOfDay ? DAY_CHIPS : []).concat(EVERY_CHIPS);
    for (const [id, label] of list) {
      const b = chipButton(label, false);
      b.dataset.factor = id;
      b.addEventListener('click', () => {
        if (!checkin) return;
        checkin.none = false;
        if (checkin.selected.has(id)) checkin.selected.delete(id); else checkin.selected.add(id);
        touch();
      });
      checkin.chips[id] = b;
      chips.appendChild(b);
    }
    const notes = chipButton('How I took notes', false);
    notes.dataset.factor = 'notes';
    notes.title = 'Pick one: handwritten, typed, flashcards or practice problems';
    notes.setAttribute('aria-haspopup', 'menu');
    notes.setAttribute('aria-expanded', 'false');
    const caret = svg('0 0 12 12', [{ d: 'M3.5 4.8 6 7.3l2.5-2.5', ...STROKE }], 'fc-caret');
    notes.appendChild(caret);
    notes.addEventListener('click', (e) => { e.stopPropagation(); openNotesMenu(notes, touch); });
    checkin.chips.notes = notes;
    chips.appendChild(notes);
    const more = chipButton('More options', false);
    more.dataset.factor = 'more';
    more.title = 'More things that can help — pick any';
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    more.appendChild(svg('0 0 12 12', [{ d: 'M3.5 4.8 6 7.3l2.5-2.5', ...STROKE }], 'fc-caret'));
    more.addEventListener('click', (e) => { e.stopPropagation(); openMoreMenu(more, touch); });
    checkin.chips.more = more;
    chips.appendChild(more);
    const none = chipButton('None of these', false);
    none.dataset.factor = 'none';
    none.title = 'Nothing special this time';
    none.addEventListener('click', () => {
      if (!checkin) return;
      checkin.none = !checkin.none;
      if (checkin.none) checkin.selected.clear();
      touch();
      if (checkin && checkin.none) { clearTimeout(checkin.timer); checkin.timer = setTimeout(() => closeCheckIn(), 700); }
    });
    checkin.chips.none = none;
    chips.appendChild(none);

    root.appendChild(el);
    safe(() => Timer.render(), 'render');
    armCheckinClose();
  }

  function openNotesMenu(anchor, touch) {
    if (!checkin) return;
    if (checkin.menu) { closeNotesMenu(checkin); return; }
    const menu = h('div', 'fc-menu');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Notes');
    const items = NOTES.map(([id, label]) => {
      const it = h('button', 'fc-menu-item');
      it.type = 'button';
      it.setAttribute('role', 'menuitemradio');
      it.setAttribute('aria-checked', String(checkin.selected.has(id)));
      it.dataset.factor = id;
      it.append(svg('0 0 12 12', CHECK, 'fc-check'), h('span', null, label));
      it.addEventListener('click', () => {
        if (!checkin) return;
        const had = checkin.selected.has(id);
        NOTES.forEach(([n]) => checkin.selected.delete(n));   // single choice
        if (!had) checkin.selected.add(id);
        checkin.none = false;
        closeNotesMenu(checkin);
        touch();
      });
      menu.appendChild(it);
      return it;
    });
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    const w = menu.offsetWidth, ht = menu.offsetHeight;
    menu.style.left = Math.round(Math.min(window.innerWidth - 12 - w, Math.max(12, r.left + r.width / 2 - w / 2))) + 'px';
    const above = r.top - 8 - ht;
    menu.style.top = Math.round(above >= 12 ? above : r.bottom + 8) + 'px';
    const onDoc = (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) closeNotesMenu(checkin); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeNotesMenu(checkin); try { anchor.focus(); } catch (_) {} } };
    document.addEventListener('pointerdown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
    checkin.menu = { menu, onDoc, onKey, anchor };
    anchor.setAttribute('aria-expanded', 'true');
    armCheckinClose();
    try { items[0].focus({ preventScroll: true }); } catch (_) {}
  }

  /* "More options" — the extra factors, kept open while you tick several. */
  function openMoreMenu(anchor, touch) {
    if (!checkin) return;
    if (checkin.menu) { closeNotesMenu(checkin); return; }
    const menu = h('div', 'fc-menu fc-menu-more');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'More things that helped');
    const head = h('p', 'fc-menu-head', 'More things that helped');
    menu.appendChild(head);
    for (const [id, label] of MORE_CHIPS) {
      const it = h('button', 'fc-menu-item');
      it.type = 'button';
      it.setAttribute('role', 'menuitemcheckbox');
      it.setAttribute('aria-checked', String(checkin.selected.has(id)));
      it.dataset.factor = id;
      it.append(svg('0 0 12 12', CHECK, 'fc-check'), h('span', null, label));
      it.addEventListener('click', () => {
        if (!checkin) return;
        const had = checkin.selected.has(id);
        if (had) checkin.selected.delete(id); else checkin.selected.add(id);
        checkin.none = false;
        it.setAttribute('aria-checked', String(!had));
        touch();
      });
      menu.appendChild(it);
    }
    const done = h('button', 'fc-menu-done', 'Done');
    done.type = 'button';
    done.addEventListener('click', () => closeNotesMenu(checkin));
    menu.appendChild(done);
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    const w = menu.offsetWidth, ht = menu.offsetHeight;
    menu.style.left = Math.round(Math.min(window.innerWidth - 12 - w, Math.max(12, r.left + r.width / 2 - w / 2))) + 'px';
    const above = r.top - 8 - ht;
    menu.style.top = Math.round(above >= 12 ? above : Math.max(12, window.innerHeight - 12 - ht)) + 'px';
    const onDoc = (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) closeNotesMenu(checkin); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeNotesMenu(checkin); try { anchor.focus(); } catch (_) {} } };
    document.addEventListener('pointerdown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
    checkin.menu = { menu, onDoc, onKey, anchor };
    anchor.setAttribute('aria-expanded', 'true');
    armCheckinClose();
    try { menu.querySelector('.fc-menu-item').focus({ preventScroll: true }); } catch (_) {}
  }

  function closeNotesMenu(c) {
    if (!c || !c.menu) return;
    const m = c.menu;
    c.menu = null;
    document.removeEventListener('pointerdown', m.onDoc, true);
    document.removeEventListener('keydown', m.onKey, true);
    m.menu.remove();
    m.anchor.setAttribute('aria-expanded', 'false');
  }

  // ═════════════════════════  discovery (v2-guard §7.3)  ═════════════════════════

  const COACH_KEY = 'purefocus.guard.coach.v1';
  function coachDone() { try { return !!localStorage.getItem(COACH_KEY); } catch (_) { return true; } }
  function markCoachDone() { try { localStorage.setItem(COACH_KEY, '1'); } catch (_) {} }

  /* H5: a coach mark never sits over another popup. True while any sheet, dialog,
     menu or popover (other than a coach mark) is on screen. */
  const POPUP_SEL = '[aria-modal="true"], [role="dialog"]:not(.coach-mark), [role="menu"], [role="listbox"], .guard-pop, .nudge, .factor-checkin, .popover, [popover]';
  function popupOpen() {
    for (const n of document.querySelectorAll(POPUP_SEL)) {
      if (n.classList.contains('is-leaving') || n.closest('[hidden], [inert]')) continue;
      const r = n.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && getComputedStyle(n).visibility !== 'hidden') return true;
    }
    const rating = document.getElementById('rating');
    return !!(rating && !rating.hidden);   // the rating / check-in zone is busy too
  }

  let coachWatch = null;
  function watchCoach() {
    if (coachWatch || typeof MutationObserver === 'undefined') return;
    const stop = () => { if (coachWatch) { coachWatch.disconnect(); coachWatch = null; } };
    coachWatch = new MutationObserver(() => {
      const mark = document.querySelector('.coach-mark:not(.is-leaving)');
      if (!mark) { stop(); return; }
      if (popupOpen()) { stop(); try { CoachMarks.dismiss(); } catch (_) {} }
    });
    coachWatch.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'aria-modal', 'open', 'class'] });
    setTimeout(stop, 120000);
  }

  let coachRetry = null;
  function maybeOfferCoach(attempt) {
    if (coachDone() || typeof CoachMarks === 'undefined') return;
    if (settings().guardEnabled) { markCoachDone(); return; }
    if (env.timer().running) return;
    const done = IC().prepare(Store.sessions()).filter((d) => d.completed).length;
    if (done < 3) return;
    const chip = document.getElementById('guard-chip');
    if (!chip || !chip.getClientRects().length || popupOpen()) {   // wait until nothing else is open
      const n = (attempt || 0) + 1;
      clearTimeout(coachRetry);
      if (n <= 20) coachRetry = setTimeout(() => safe(() => maybeOfferCoach(n), 'coach mark'), 6000);
      return;
    }
    const shown = CoachMarks.offer({
      id: 'guard',
      anchor: '#guard-chip',
      text: 'This is Focus Guard. Turn it on and it will gently check in if you drift away during a focus session. It keeps only totals, never what you look at.',
      primary: { label: 'Turn it on', action: () => { markCoachDone(); setEnabled(true); openPopover(); } },
      secondary: { label: 'Not now', action: () => markCoachDone() },
    });
    if (shown) { markCoachDone(); watchCoach(); }
  }

  // ═════════════════════════  extension bridge (P1)  ═════════════════════════

  /* v2-guard §5.3.4. The "Pure Focus Blocker" content script (bridge.js) marks the page with
     data-pf-blocker and relays window messages {pf:'app'|'ext', v:1, type, …} to its service worker.
     Only our own window/origin is trusted; the app never sends anything but the list and the clock. */
  const BEAT_MS = 60000;
  let beat = null;
  let extRunStats = null;      // {runID, hits, escapes} from the extension's 'state' messages
  function postExt(msg) {
    try { window.postMessage(Object.assign({ pf: 'app', v: 1 }, msg), location.origin); } catch (_) {}
  }
  function blockingWanted() {
    const s = settings(), st = env.timer();
    return !!(s.guardEnabled && s.blockEnabled && st.mode === 'focus' && st.running);
  }
  function themeColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n, d) => (cs.getPropertyValue(n) || '').trim() || d;
    return { accent: v('--accent', '#FF6B35'), focus: v('--focus-tint', '#E8482B') };
  }
  function sendFocus() {
    if (!blocker.present || !blockingWanted()) return;
    const st = Timer.state();
    const list = blockedItems().slice(0, 500).map((it) => ({ kind: it.kind, value: String(it.value).slice(0, 253) }));
    postExt({ type: 'focus', runID: st.runID || null, endsAt: new Date(Date.now() + Math.max(0, st.remaining || 0) * 1000).toISOString(),
      list, passes: settings().blockPasses, theme: themeColors() });
  }
  function sendStop() {
    if (!blocker.present) return;
    postExt({ type: 'stop', runID: (Timer.state() || {}).runID || null });
  }
  function sendBlockerState() {
    if (!blocker.present) return;
    if (blockingWanted()) {
      sendFocus();
      if (!beat) beat = setInterval(() => safe(sendFocus, 'focus beat'), BEAT_MS);
    } else {
      if (beat) { clearInterval(beat); beat = null; }
      sendStop();
    }
  }
  function mergeExtStats() {
    if (!acc || !extRunStats || !accRunID || extRunStats.runID !== accRunID) return;
    acc.blockedHits = Math.max(acc.blockedHits || 0, extRunStats.hits || 0);
    acc.escapes = Math.max(acc.escapes || 0, extRunStats.escapes || 0);
  }
  function onExtMessage(e) {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d.pf !== 'ext' || d.v !== 1 || typeof d.type !== 'string') return;
    if (d.type === 'hello') {
      const was = blocker.present;
      blocker.present = true;
      blocker.version = typeof d.version === 'string' ? d.version.slice(0, 20) : blocker.version;
      if (blocker.state === 'absent') blocker.state = 'idle';
      if (!was) { renderChip(); if (section) safe(section.sync, 'section sync'); sendBlockerState(); }
    } else if (d.type === 'state') {
      blocker.state = d.active ? 'active' : 'idle';
      if (typeof d.runID === 'string') extRunStats = { runID: d.runID, hits: Number(d.hits) || 0, escapes: Number(d.escapes) || 0 };
      mergeExtStats();
      if (pop) renderPopover();
    } else if (d.type === 'front') {
      const key = typeof d.key === 'string' && /^(domain|url):[\x21-\x7e]{1,260}$/.test(d.key) ? d.key : null;
      extFront = { key, name: key ? key.replace(/^(domain|url):/, '') : null };
    }
  }
  function initBridge() {
    const mark = document.documentElement.dataset.pfBlocker;
    if (mark) { blocker.present = true; blocker.version = String(mark).slice(0, 20); blocker.state = 'idle'; }
    window.addEventListener('message', (e) => safe(() => onExtMessage(e), 'extension message'));
    postExt({ type: 'hello' });
  }

  // ═════════════════════════  Idle Detection API (P1)  ═════════════════════════

  const sysIdle = { active: false, start() {}, stop() {} };

  // ═════════════════════════  init  ═════════════════════════

  let inited = false;
  function init() {
    if (inited) return;
    inited = true;
    for (const type of ['start', 'resume', 'pause', 'stop', 'log', 'discard']) {
      Timer.on(type, (p) => safe(() => onTimer({ ...(p || {}), type }), type));
    }
    Timer.on('rated', (p) => onRated(p));
    // a break starting on its own (Start breaks automatically) must not sweep the chips away
    Timer.on('start', (p) => { if (!p || p.mode === 'focus') closeCheckIn(); });
    Timer.addSessionExtra((ctx) => {
      if (!ctx || ctx.mode !== 'focus' || !acc) return null;
      if (ctx.runID && accRunID && ctx.runID !== accRunID) return null;
      return { drift: snapshot() };
    });
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onVisibility);
    window.addEventListener('focus', onVisibility);
    Store.on('settings', () => {
      safe(reconcile, 'settings');
      if (section) safe(section.sync, 'section sync');
      if (sheet && sheet.render) safe(sheet.render, 'sheet');
    });
    Store.on('change', (kind) => {          // a cloud pull, a reset or a bulk edit may change the settings too
      if (kind === 'remote' || kind === 'reset' || kind === 'bulk') { safe(reconcile, 'reconcile'); if (section) safe(section.sync, 'section sync'); }
    });
    if (typeof Profile !== 'undefined' && Profile.on) Profile.on('change', () => discard());
    Timer.on('complete', (p) => { if (p && p.mode === 'focus') setTimeout(() => safe(maybeOfferCoach, 'coach mark'), 1500); });
    if (typeof Settings !== 'undefined' && Settings.registerSection) {
      Settings.registerSection({ id: 'guard', title: 'Focus Guard', order: 5, render: (el) => safe(() => renderSection(el), 'section') });
    }
    safe(initBridge, 'extension bridge');
    renderChip();
    setTimeout(() => safe(maybeOfferCoach, 'coach mark'), 4000);
  }

  // ── test hooks (in-page selftest only) ──
  const _debug = {
    setEnv(partial) { env = { ...env, ...(partial || {}) }; },
    resetEnv() { env = { ...realEnv }; },
    tick() { tick(); },
    ticks: () => ticks,
    sampling: () => sampling,
    intervalActive: () => intervalID != null,
    acc: () => acc,
    runID: () => accRunID,
    nudge: () => (nudge ? { kind: nudge.kind, title: nudge.title } : null),
    input() { onInput(); },
    visibility() { onVisibility(); },
    setFront(key, name) { extFront = { key: key || null, name: name || null }; },
    forget() { stopSamplingQuiet(); acc = null; accRunID = null; },   // simulates a page reload
    openPopover() { openPopover(); },
    closePopover() { closePopover(); },
    openListSheet() { openListSheet(null); },
    closeSheet() { closeSheet(); },
    offerCoach() { maybeOfferCoach(); },
    popupOpen: () => popupOpen(),
    popupWhich: () => Array.from(document.querySelectorAll(POPUP_SEL)).filter((n) => n.getBoundingClientRect().width > 0).map((n) => n.tagName + '.' + n.className + '#' + n.id),
    onRated(p) { onRated(p); },
    checkIn(id) { return maybeCheckIn(id); },
    checkinTimeout() { closeCheckIn(); },
    checkin: () => (checkin ? { sessionID: checkin.sessionID, value: factorsValue() } : null),
  };

  return { init, onTimer, snapshot, liveRatio, respond, blocker, sendFocus, sendStop, titleCue, closePopover: () => closePopover(), _debug };
})();
