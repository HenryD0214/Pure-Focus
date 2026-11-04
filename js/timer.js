/* ═══════════════════════════════════════════════════════════════════════
   timer.js — the Pomodoro engine
   Matches the app's behaviour: long break every Nth pomodoro, skipped
   sessions still count, auto-start options, and a focus rating prompt.

   v2 hooks (SPEC-V2 §4.8; added by W1·A):
     Timer.on(evt, fn) → unsubscribe. fn(payload) with payload.runID:
       start   a fresh run starts            {mode, runID}
       resume  a paused run continues         {mode, runID}
       pause   the clock pauses               {mode, runID, rewind}
       stop    the clock stops for good       {mode, runID, reason: complete|skip|reset|switch|startFocus}
       log     a session was logged           {mode, runID, session}
       discard a run ended without a log      {mode, runID, reason}
       complete natural completion            {mode, runID, session|null}
       rated   the rating was answered        {sessionID, rating|null, skipped}
       mode    the mode changed               {mode, from}
       tick    once per whole second running  {mode, runID, remaining, activeElapsed}
     Timer.addSessionExtra(fn) → unsubscribe; fn({mode, runID, task}) returns
       fields merged into the focus session before Store.logSession (drift,
       music, …; core fields can't be overridden).
     Timer.state() → {mode, running, remaining, total, activeElapsed, sessionStart,
       endAt, runID, plan, taskID, todayPomodoros}
     Timer.pause({rewind}) — pause, then move `rewind` seconds of active time
       back onto the clock (Guard auto-pause, v2-guard §3.4).
     Timer.startFocus({taskID, plan, force}) → {status: 'started' |
       'alreadyFocusing' | 'needsConfirmation' | 'unavailable', currentMinutes?}
       (SPEC §1.4.6). Timer.planContext() → PlanContext | null.
     #rating-extra-root (inside #rating) stays visible after the rating while it
       holds content (the factor check-in); call Timer.render() after changing it.
   purefocus.running also keeps activeElapsed, plan, runID and savedAt.
   ═══════════════════════════════════════════════════════════════════════ */

const Timer = (() => {
  const RING_CIRCUMFERENCE = 2 * Math.PI * 120;   // r=120 in the SVG viewBox

  // Calm copy inside the ring when no task line shows (v2-themes W17, §2.5).
  const RING_COPY = {
    focus: 'Ready when you are',
    focusRunning: 'Focusing',
    shortBreak: 'Short break · breathe out',
    longBreak: 'Long break · step away',
    paused: 'Paused — take your time',
  };
  const HINT_KEY = 'purefocus.hint.space';   // "Space to start" shows for the first 3 sessions (W4)

  let mode = 'focus';
  let remaining = 25 * 60;      // seconds left in the current run
  let total = 25 * 60;          // seconds the current run started with
  let endAt = null;             // wall-clock ms when the run ends
  let running = false;
  let sessionStart = null;      // Date the current run began
  let activeElapsed = 0;        // seconds actually spent running
  let lastAccrual = null;
  let todayPomodoros = 0;
  let pendingRatingSessionID = null;
  let rafId = null;
  let lastWholeSecond = -1;
  let runID = null;             // one id per focus/break run (kept across pauses)
  let plan = null;              // PlanContext {blockID, title, index, total, end} | null (display only)
  let planTaskID = null;        // the task the plan was started for
  let ringJump = true;          // next render sets the arc without its 1 s transition
  let endTimer = 0;             // a plain timeout for endAt: rAF stops in hidden tabs (v2-themes §11.15)
  let runTaskID = null;         // the task that was active when the run started
  let finishingLate = false;    // this run ran out while the tab was closed: log it, no alarm, no auto-start
  let wroteRun = false;         // this tab owns the saved 'purefocus.running' key
  let countDay = null;          // the day todayPomodoros belongs to

  // ── v2 hooks ──

  const hookListeners = new Map();
  const sessionExtras = [];
  const EVENTS = ['start', 'pause', 'resume', 'stop', 'log', 'discard', 'complete', 'rated', 'mode', 'tick'];

  function on(evt, fn) {
    if (!EVENTS.includes(evt) || typeof fn !== 'function') return () => {};
    if (!hookListeners.has(evt)) hookListeners.set(evt, new Set());
    hookListeners.get(evt).add(fn);
    return () => hookListeners.get(evt).delete(fn);
  }

  function fire(evt, payload) {
    const set = hookListeners.get(evt);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try { fn(payload); } catch (err) { console.error('Timer.on(' + evt + ') listener failed', err); }
    }
  }

  function addSessionExtra(fn) {
    if (typeof fn !== 'function') return () => {};
    sessionExtras.push(fn);
    return () => { const i = sessionExtras.indexOf(fn); if (i >= 0) sessionExtras.splice(i, 1); };
  }

  const CORE_FIELDS = ['start', 'end', 'mode', 'task', 'minutes', 'scheduledMinutes'];
  function collectExtras(ctx) {
    const out = {};
    for (const fn of sessionExtras) {
      try {
        const x = fn(ctx);
        if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) if (!CORE_FIELDS.includes(k)) out[k] = v;
      } catch (err) { console.error('Timer session extra failed', err); }
    }
    return out;
  }

  function newRunID() {
    try { return Store.uid(); } catch (_) { return String(Date.now()); }
  }

  function setMode(m) {
    if (m === mode) return;
    const from = mode;
    mode = m;
    if (from === 'focus') clearPlan();
    fire('mode', { mode, from });
  }

  function clearPlan() { plan = null; planTaskID = null; }

  // A run that ends without a log (reset, mode switch, startFocus under 60 s).
  function discardRun(reason) {
    if (sessionStart === null && !runID) return;
    fire('discard', { mode, runID, reason });
    if (mode === 'focus') clearPlan();
  }

  const $ = (sel) => document.querySelector(sel);

  // ── duration helpers ──

  function durationFor(m) {
    const s = Store.settings();
    if (m === 'focus') return s.focusMinutes * 60;
    if (m === 'shortBreak') return s.shortBreakMinutes * 60;
    return s.longBreakMinutes * 60;
  }

  function modeTint(m) {
    const theme = Store.theme();
    if (m === 'focus') return theme.focus;
    if (m === 'shortBreak') return theme.break;
    return theme.longBreak;
  }

  function modeDef(m) { return Store.MODES[m]; }

  // ── lifecycle ──

  function start() {
    if (running) return;
    running = true;
    endAt = Date.now() + remaining * 1000;
    const fresh = sessionStart === null;
    if (fresh) {
      sessionStart = new Date(Date.now() - Math.max(0, total - remaining) * 1000);
      activeElapsed = 0;
      runID = newRunID();
      const t = Store.activeTask();
      runTaskID = t ? t.id : null;
    } else if (!runID) {
      runID = newRunID();
    }
    lastAccrual = Date.now();
    ringJump = true;
    if (fresh && mode === 'focus') bumpSpaceHint();
    fire(fresh ? 'start' : 'resume', { mode, runID });
    document.body.classList.add('timer-running');
    Audio.startTicking();
    if (mode === 'focus') {
      Audio.startAmbience();
      Audio.playMusic(null);
    }
    loop();
    render();
  }

  /* pause() — or pause({rewind}): after pausing, move `rewind` seconds of
     active time back onto the clock (clamped to the time actually run). */
  function pause(opts) {
    if (!running) return;
    accrue();
    running = false;
    if (endAt) remaining = Math.max(0, (endAt - Date.now()) / 1000);
    endAt = null;
    let rewind = 0;
    const r = opts && typeof opts === 'object' ? Number(opts.rewind) : 0;
    if (Number.isFinite(r) && r > 0) {
      rewind = Math.min(r, activeElapsed);
      activeElapsed = Math.max(0, activeElapsed - rewind);
      remaining = Math.max(0, Math.min(total, remaining + rewind));
    }
    document.body.classList.remove('timer-running');
    Audio.stopTicking();
    Audio.pauseAmbience();
    Audio.pauseMusic();
    cancelAnimationFrame(rafId); clearTimeout(endTimer);
    ringJump = true;
    fire('pause', { mode, runID, rewind });
    render();
  }

  function accrue() {
    if (lastAccrual) activeElapsed += (Date.now() - lastAccrual) / 1000;
    lastAccrual = null;
  }

  function toggle() { running ? pause() : start(); }

  function reset() {
    ringJump = true;
    const wasRunning = running;
    if (wasRunning) fire('stop', { mode, runID, reason: 'reset' });
    discardRun('reset');
    runID = null;
    running = false;
    cancelAnimationFrame(rafId); clearTimeout(endTimer);
    document.body.classList.remove('timer-running');
    Audio.stopTicking();
    Audio.pauseAmbience();
    Audio.pauseMusic();
    total = durationFor(mode);
    remaining = total;
    endAt = null;
    sessionStart = null;
    activeElapsed = 0;
    lastAccrual = null;
    render();
  }

  function skip() {
    ringJump = true;
    const wasFocus = mode === 'focus';
    if (running) {
      accrue();
      fire('stop', { mode, runID, reason: 'skip' });
    }
    running = false;
    cancelAnimationFrame(rafId); clearTimeout(endTimer);
    document.body.classList.remove('timer-running');
    Audio.stopTicking();
    Audio.pauseAmbience();
    Audio.pauseMusic();

    if (wasFocus) {
      // Skip before a minute of focus: nothing to record
      if (sessionStart !== null && activeElapsed >= 60) logFocusSession(true);
      else { discardRun('skip'); sessionStart = null; activeElapsed = 0; lastAccrual = null; }
      advanceFromFocus(true);
    } else {
      discardRun('skip');
      runID = null;
      setMode('focus');
      todayPomodoros = todayPomodoros % Store.settings().longBreakInterval;
      total = durationFor('focus');
      remaining = total;
      sessionStart = null;
      activeElapsed = 0;
      lastAccrual = null;
    }
    render();
  }

  function switchMode(m) {
    if (m === mode) return;
    ringJump = true;
    if (running) { accrue(); fire('stop', { mode, runID, reason: 'switch' }); }
    // Leaving a focus run keeps the time you did focus, the same as Skip
    if (mode === 'focus' && sessionStart !== null && activeElapsed >= 60) logFocusSession(true);
    else discardRun('switch');
    runID = null;
    running = false;
    cancelAnimationFrame(rafId); clearTimeout(endTimer);
    document.body.classList.remove('timer-running');
    Audio.stopTicking();
    Audio.pauseAmbience();
    Audio.pauseMusic();
    setMode(m);
    if (m === 'focus') {
      todayPomodoros = todayPomodoros % Store.settings().longBreakInterval;
    }
    total = durationFor(m);
    remaining = total;
    endAt = null;
    sessionStart = null;
    activeElapsed = 0;
    lastAccrual = null;
    render();
  }

  // Settings changed a length: an idle timer shows it now, a run in progress keeps its own.
  function syncDuration() {
    if (running || sessionStart !== null) return;
    ringJump = true;
    total = durationFor(mode);
    remaining = total;
    render();
  }

  function addMinute() {
    ringJump = true;
    remaining += 60;
    total += 60;
    if (running && endAt) { endAt += 60000; loop(); }
    render();
  }

  // ── completion ──

  function loop() {
    cancelAnimationFrame(rafId); clearTimeout(endTimer);
    rafId = requestAnimationFrame(() => {
      if (!running) return;
      tick();
      loop();
    });
    // A background tab gets no animation frames, so the run also ends on a timeout
    // (one unchained timer, not intensively throttled) within ~1 s of endAt.
    if (running && endAt) endTimer = setTimeout(() => { if (running) { tick(); if (running) loop(); } }, Math.max(0, endAt - Date.now()) + 40);
  }

  function tick() {
    if (!running || !endAt) return;
    const left = (endAt - Date.now()) / 1000;
    if (left <= 0) {
      remaining = 0;
      complete();
      return;
    }
    const whole = Math.ceil(left);
    remaining = left;
    // The arc moves with a 1 s linear transition (v2-themes §7.2), so the view only
    // needs to change once per whole second; the rAF loop just watches the clock.
    if (whole !== lastWholeSecond) {
      lastWholeSecond = whole;
      fire('tick', { mode, runID, remaining: left, activeElapsed: activeElapsed + (lastAccrual ? (Date.now() - lastAccrual) / 1000 : 0) });
      render();
    }
  }

  // How a run is recorded: focus time is the time the timer actually ran — never more than the run's
  // length (a run that ends while the tab sleeps finishes late, but the sleep isn't focus), and it
  // ends when the timer reached zero, not when the page woke up to notice.
  function runEnd(finished) {
    const now = Date.now();
    return finished && endAt && endAt < now ? endAt : now;
  }
  function runMinutes() { return Math.max(0.1, Math.min(activeElapsed, total) / 60); }

  // skipped: a focus run cut short with Skip. It is kept (marked skipped) when it ran a minute or
  // more, so the time you did focus still counts, but it never counts as a finished pomodoro.
  function logFocusSession(skipped) {
    const task = runTask();
    const s = Store.settings();
    const end = runEnd(!skipped);
    const minutes = runMinutes();
    const scheduledMinutes = total / 60;
    // Extras know the run's actual length, so a music extra can require that music played
    // for the majority of the session rather than a few seconds.
    const extras = collectExtras({ mode: 'focus', runID, task, skipped: !!skipped, minutes, scheduledMinutes });
    const session = Store.logSession({
      ambience: s.selectedAmbience === 'none' ? null : s.selectedAmbience,
      alarm: s.selectedAlarm,
      ...extras,
      start: sessionStart ? sessionStart.getTime() : Date.now(),
      end,
      mode: 'focus',
      task,
      scheduledMinutes,
      minutes,
      ...(skipped ? { skipped: true } : {}),
    });
    pendingRatingSessionID = session.id;
    if (!skipped) {
      if (task) Store.incrementPomodoro(task.id);
      rollDay();
      if (dayKey(new Date(end)) === countDay) { todayPomodoros += 1; saveTodayCount(); }
    }
    fire('log', { mode: 'focus', runID, session });
    clearPlan();
    sessionStart = null;
    activeElapsed = 0;
    lastAccrual = null;
    return session;
  }

  // Who the run was for: marking a task done mid-run moves the active task along, but the time
  // was spent on the one you finished.
  function runTask() {
    const was = runTaskID ? Store.tasks().find((t) => t.id === runTaskID) : null;
    if (was && was.isDone) return was;
    return Store.activeTask() || was || null;
  }

  // Two tabs can end up holding one run: only the first to finish it logs it.
  function claimRun(id) {
    try {
      if (id && localStorage.getItem('purefocus.doneRun') === id) return false;
      if (id) localStorage.setItem('purefocus.doneRun', id);
    } catch (_) {}
    return true;
  }

  function advanceFromFocus(skipped) {
    const s = Store.settings();
    const justFinished = todayPomodoros;
    // a skipped run isn't a finished pomodoro, so it never earns the long break
    const nextIsLong = !skipped && justFinished > 0 && justFinished % s.longBreakInterval === 0;
    runID = null;
    setMode(nextIsLong ? 'longBreak' : 'shortBreak');
    total = durationFor(mode);
    remaining = total;
    sessionStart = null;
    activeElapsed = 0;
    lastAccrual = null;
    if (s.autoStartBreaks && !finishingLate) {
      setTimeout(() => { if (!running) start(); }, 300);
    }
  }

  function complete() {
    ringJump = true;
    const wasFocus = mode === 'focus';
    if (running) accrue();
    if (running) fire('stop', { mode, runID, reason: 'complete' });
    running = false;
    cancelAnimationFrame(rafId); clearTimeout(endTimer);
    document.body.classList.remove('timer-running');
    Audio.stopTicking();
    Audio.pauseAmbience();
    Audio.pauseMusic();

    const first = claimRun(runID);
    if (wasFocus) {
      const doneRun = runID;
      if (first) {
        const session = logFocusSession(false);
        if (!finishingLate) Audio.playAlarm();
        fire('complete', { mode: 'focus', runID: doneRun, session });
      } else {
        clearPlan();
      }
      advanceFromFocus();
      if (first) Store.emit('focus:completed', { pomodoros: finishedToday() });
    } else {
      let session = null;
      if (first && sessionStart !== null) {
        session = Store.logSession({
          start: sessionStart.getTime(),
          end: runEnd(true),
          mode,
          scheduledMinutes: total / 60,
          minutes: runMinutes(),
        });
        fire('log', { mode, runID, session });
      }
      fire('complete', { mode, runID, session });
      runID = null;
      setMode('focus');
      todayPomodoros = todayPomodoros % Store.settings().longBreakInterval;
      total = durationFor('focus');
      remaining = total;
      sessionStart = null;
      activeElapsed = 0;
      lastAccrual = null;
      if (Store.settings().autoStartFocus && !finishingLate) {
        setTimeout(() => { if (!running) start(); }, 300);
      }
    }
    finishingLate = false;
    render();
  }

  // ── rating ──

  function ratePendingSession(rating) {
    if (!pendingRatingSessionID) return;
    const id = pendingRatingSessionID;
    Store.rateSession(id, rating);
    pendingRatingSessionID = null;
    render();
    fire('rated', { sessionID: id, rating, skipped: false });
  }

  function dismissPendingRating() {
    const id = pendingRatingSessionID;
    pendingRatingSessionID = null;
    render();
    if (id) fire('rated', { sessionID: id, rating: null, skipped: true });
  }

  // ── rendering ──

  function fmtTime(secs) {
    const s = Math.max(0, Math.ceil(secs));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  }

  function render() {

    // styles.css maps body[data-mode] to --tint / --tint-text / --btn-bg (v2-themes §8.1.4);
    // nothing mode-coloured is written inline on :root any more.
    if (document.body.dataset.mode !== mode) document.body.dataset.mode = mode;

    // Mode buttons
    document.querySelectorAll('.mode-btn').forEach((btn) => {
      const active = btn.dataset.mode === mode;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', String(active));
      btn.style.setProperty('--mode-tint', modeTint(btn.dataset.mode));
    });

    // Ring: progress comes from the clock; a jump (start, pause, reset, mode switch,
    // +1 min) sets the arc without the 1 s transition for one frame.
    const ring = $('#ring-progress');
    const progress = total > 0 ? Math.min(1, Math.max(0, 1 - remaining / total)) : 0;
    if (ringJump) {
      ringJump = false;
      ring.style.transition = 'none';
      requestAnimationFrame(() => requestAnimationFrame(() => { ring.style.transition = ''; }));
    }
    ring.style.strokeDasharray = String(RING_CIRCUMFERENCE);
    ring.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - progress));
    // A round line-cap still paints a dot at zero length — hide it.
    ring.style.opacity = progress <= 0 ? '0' : '1';

    $('#ring-time').textContent = fmtTime(remaining);
    const paused = !running && sessionStart !== null;
    const stage = document.querySelector('.timer-card');
    if (stage) {
      stage.classList.toggle('is-paused', paused);
      stage.classList.toggle('is-running', running);
    }

    // The task line lives inside the ring (focus only); otherwise one calm sentence.
    const task = Store.activeTask();
    const taskBtn = $('#ring-task');
    const showTask = !!(task && mode === 'focus' && !task.isDone);
    if (taskBtn) {
      taskBtn.hidden = !showTask;
      if (showTask) {
        $('#ring-task-title').textContent = task.title;
        taskBtn.title = `${task.title} — ${task.completedPomodoros} of ${task.estimate} pomodoro${task.estimate === 1 ? '' : 's'} done. Click to switch or finish it.`;
      }
    }
    const msg = $('#ring-message');
    const copy = paused ? RING_COPY.paused
      : mode === 'focus' ? (showTask ? '' : (running ? RING_COPY.focusRunning : RING_COPY.focus))
      : RING_COPY[mode];
    msg.textContent = copy || '';
    msg.hidden = !copy;

    const hint = $('#kbd-hint');
    const hintLabel = $('#kbd-hint-label');
    if (hintLabel) hintLabel.textContent = 'to start';
    if (hint) hint.hidden = running || paused || !!pendingRatingSessionID || spaceHintCount() >= 3;

    // Play button: Start · Pause · Resume · Start break
    $('#btn-play-label').textContent = running ? 'Pause' : paused ? 'Resume' : (mode === 'focus' ? 'Start' : 'Start break');

    // Beads (interval dots) — rebuilt only when the count changes
    const interval = Math.max(1, Store.settings().longBreakInterval);
    const done = todayPomodoros % interval;
    const dots = $('#interval-dots');
    if (dots.dataset.sig !== `${interval}:${done}`) {
      dots.dataset.sig = `${interval}:${done}`;
      dots.textContent = '';
      for (let i = 0; i < interval; i++) {
        const dot = document.createElement('span');
        dot.className = 'interval-dot';
        if (i < done) dot.classList.add('is-done');
        dots.appendChild(dot);
      }
      dots.setAttribute('aria-label', `${done} of ${interval} pomodoros toward a long break`);
    }

    // "ends 3:47 PM" while a focus run is live
    const finishEl = $('#est-finish');
    if (running && mode === 'focus' && endAt) {
      finishEl.hidden = false;
      $('#est-finish-time').textContent = new Date(endAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    } else {
      finishEl.hidden = true;
    }

    renderRating();
    renderNowPlaying();
    if (typeof Quiet !== 'undefined' && Quiet && Quiet.sync) Quiet.sync();
  }

  // ── "Space to start" hint: the first 3 sessions only (v2-themes W4) ──
  function spaceHintCount() {
    try { return Number(localStorage.getItem(HINT_KEY)) || 0; } catch (_) { return 3; }
  }
  function bumpSpaceHint() {
    try { const n = spaceHintCount(); if (n < 3) localStorage.setItem(HINT_KEY, String(n + 1)); } catch (_) { /* harmless */ }
  }

  // ── the task line's ⌄ menu: choose what this session is for ──
  let taskMenu = null;
  function closeTaskMenu(refocus) {
    if (!taskMenu) return;
    taskMenu.remove();
    taskMenu = null;
    const btn = $('#ring-task');
    if (btn) { btn.setAttribute('aria-expanded', 'false'); if (refocus) btn.focus(); }
    document.removeEventListener('pointerdown', onMenuOutside, true);
    document.removeEventListener('keydown', onMenuKey, true);
  }
  function onMenuOutside(e) {
    if (taskMenu && !taskMenu.contains(e.target) && !e.target.closest('#ring-task')) closeTaskMenu(false);
  }
  function onMenuKey(e) {
    if (!taskMenu) return;
    const items = Array.from(taskMenu.querySelectorAll('[role="menuitemradio"]'));
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeTaskMenu(true); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
      if (n) n.focus();
    } else if (e.key === 'Tab') closeTaskMenu(false);
  }
  function openTaskMenu() {
    if (taskMenu) { closeTaskMenu(true); return; }
    const btn = $('#ring-task');
    const wrapEl = document.querySelector('.ring-wrap');
    if (!btn || !wrapEl) return;
    const active = Store.activeTask();
    const list = Store.tasks().filter((t) => !t.isDone).slice(0, 8);
    taskMenu = document.createElement('div');
    taskMenu.className = 'ring-task-menu';
    taskMenu.setAttribute('role', 'menu');
    taskMenu.setAttribute('aria-label', 'Focus on');
    const head = document.createElement('div');
    head.className = 'ring-task-menu-head';
    head.textContent = 'Focus on';
    taskMenu.appendChild(head);
    for (const t of list) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'ring-task-item';
      item.setAttribute('role', 'menuitemradio');
      const on = !!(active && active.id === t.id);
      item.setAttribute('aria-checked', String(on));
      const title = document.createElement('span');
      title.className = 'ring-task-item-title';
      title.textContent = t.title;
      const count = document.createElement('span');
      count.className = 'ring-task-item-count';
      count.textContent = `${t.completedPomodoros}/${t.estimate}`;
      item.append(title, count);
      item.addEventListener('click', () => { Store.setActiveTask(t.id); closeTaskMenu(true); render(); });
      taskMenu.appendChild(item);
    }
    wrapEl.appendChild(taskMenu);
    btn.setAttribute('aria-expanded', 'true');
    const first = taskMenu.querySelector('[aria-checked="true"]') || taskMenu.querySelector('[role="menuitemradio"]');
    if (first) first.focus();
    document.addEventListener('pointerdown', onMenuOutside, true);
    document.addEventListener('keydown', onMenuKey, true);
  }

  function renderRating() {
    const panel = $('#rating');
    const extra = $('#rating-extra-root');
    const places = $('#rating-places');
    const extraOnly = !pendingRatingSessionID && !!(extra && extra.childElementCount);
    panel.classList.toggle('is-extra-only', extraOnly);
    for (const el of panel.children) if (el !== extra) el.hidden = extraOnly;
    if (!pendingRatingSessionID) {
      if (places) { places.hidden = true; places.textContent = ''; }
      panel.hidden = !extraOnly;
      return;
    }
    panel.hidden = false;
    const dots = $('#rating-dots');
    dots.textContent = '';
    for (let i = 1; i <= 10; i++) {
      const b = document.createElement('button');
      b.className = 'rating-dot';
      b.type = 'button';
      b.textContent = String(i);
      b.dataset.rating = String(i);
      b.setAttribute('aria-label', `Rate this session ${i} out of 10`);
      b.addEventListener('click', () => ratePendingSession(i));
      dots.appendChild(b);
    }
    renderRatingPlaces();
  }

  /* "Where did you focus?" — several places per session. Shown with the rating so the
     session you just finished can be tagged without opening the task later. */
  const RATING_PLACE_IDEAS = ['Home', 'School', 'Library', 'Café'];
  function renderRatingPlaces() {
    const box = document.getElementById('rating-places');
    if (!box) return;
    const id = pendingRatingSessionID;
    const session = id ? Store.sessions().find((s) => String(s.id).toLowerCase() === String(id).toLowerCase()) : null;
    if (!session) { box.hidden = true; box.textContent = ''; return; }
    const current = (Array.isArray(session.locations) && session.locations.length ? session.locations : (session.location ? [session.location] : [])).slice();
    const seen = [];
    const add = (p) => {
      const s = String(p == null ? '' : p).trim();
      if (s && !seen.some((x) => x.toLowerCase() === s.toLowerCase())) seen.push(s);
    };
    current.forEach(add);
    Store.locations().forEach(add);
    RATING_PLACE_IDEAS.forEach(add);

    box.textContent = '';
    const title = document.createElement('p');
    title.className = 'rating-places-title';
    title.textContent = 'Where did you focus?';
    const hint = document.createElement('span');
    hint.textContent = 'pick any · optional';
    title.appendChild(hint);
    box.appendChild(title);
    const chips = document.createElement('div');
    chips.className = 'rating-place-chips';
    for (const p of seen) {
      const b = document.createElement('button');
      b.className = 'fc-chip';
      b.type = 'button';
      b.setAttribute('aria-pressed', String(current.some((x) => x.toLowerCase() === p.toLowerCase())));
      b.textContent = p;
      b.addEventListener('click', () => {
        const on = b.getAttribute('aria-pressed') !== 'true';
        const next = on ? current.concat(p) : current.filter((x) => x.toLowerCase() !== p.toLowerCase());
        Store.updateSessionLocations(session.id, next);
        renderRatingPlaces();
      });
      chips.appendChild(b);
    }
    const input = document.createElement('input');
    input.className = 'rating-place-new';
    input.type = 'text';
    input.maxLength = 60;
    input.placeholder = 'Add a place…';
    input.setAttribute('aria-label', 'Add another place for this session');
    input.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      const v = input.value.trim();
      if (!v) return;
      Store.updateSessionLocations(session.id, current.concat(v));
      renderRatingPlaces();
      const next = document.querySelector('#rating-places .rating-place-new');
      if (next) next.focus();
    });
    chips.appendChild(input);
    box.appendChild(chips);
    box.hidden = false;
  }

  function renderNowPlaying() {
    const bar = $('#now-playing');
    const track = Audio.currentTrack();
    if (!track) {
      bar.hidden = true;
      document.body.classList.remove('music-playing');
      return;
    }
    bar.hidden = false;
    $('#np-title').textContent = track.title;
    $('#np-meta').textContent = track.artist ? `${track.artist} · ${track.genre}` : track.genre;
    $('#np-play').setAttribute('aria-pressed', String(Audio.isMusicPlaying()));
    document.body.classList.toggle('music-playing', Audio.isMusicPlaying());
    renderNowPlayingProgress();
  }

  function fmtClock(s) {
    s = Math.max(0, Math.floor(s || 0));
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  /* Driven both by the music state events and by a low-frequency poll while
     a track plays — audio `timeupdate` fires a few times a second, but the
     poll keeps the bar honest through seeks and tab throttling. */
  function renderNowPlayingProgress(info) {
    if (!Audio.currentTrack()) return;
    const elapsed = info ? info.elapsed : Audio.musicElapsed();
    const duration = info ? info.duration : Audio.musicDuration();
    const progress = duration > 0 ? Math.min(1, elapsed / duration) : 0;

    $('#np-elapsed').textContent = fmtClock(elapsed);
    $('#np-duration').textContent = fmtClock(duration);

    const seek = $('#np-seek');
    const pct = progress * 100;
    $('#np-seek-fill').style.width = `${pct}%`;
    $('#np-seek-thumb').style.left = `${pct}%`;
    seek.setAttribute('aria-valuenow', String(Math.round(pct)));
    seek.setAttribute('aria-valuetext', `${fmtClock(elapsed)} of ${fmtClock(duration)}`);
    document.body.classList.toggle('music-playing', Audio.isMusicPlaying());
    $('#np-play').setAttribute('aria-pressed', String(Audio.isMusicPlaying()));
  }

  function refreshNowPlaying() { renderNowPlaying(); }

  function refreshActiveTask() {
    if (plan && planTaskID) {
      const t = Store.activeTask();
      if (!t || String(t.id).toLowerCase() !== String(planTaskID).toLowerCase()) clearPlan();
    }
    render();
  }

  // ── start focus from a block / Up next (SPEC §1.4.6) ──

  function minutesRun() {
    const live = running && lastAccrual ? (Date.now() - lastAccrual) / 1000 : 0;
    return Math.floor((activeElapsed + live) / 60);
  }

  function startFocus({ taskID = null, plan: planCtx = null, force = false } = {}) {
    const lower = (x) => String(x).toLowerCase();
    if (planCtx && planCtx.end && new Date(planCtx.end).getTime() <= Date.now()) return { status: 'unavailable' };
    let task = null;
    if (taskID != null) {
      task = Store.tasks().find((t) => lower(t.id) === lower(taskID)) || null;
      if (!task || task.isDone) return { status: 'unavailable' };
    }
    const active = Store.activeTask();
    const sameTask = task ? !!(active && lower(active.id) === lower(task.id)) : true;
    if (running && mode === 'focus' && sameTask) {
      if (planCtx) { plan = { ...planCtx }; planTaskID = task ? task.id : null; }
      showFocus();
      render();
      return { status: 'alreadyFocusing' };
    }
    if (!running && mode === 'focus' && sessionStart !== null && sameTask && !force) {
      if (planCtx) { plan = { ...planCtx }; planTaskID = task ? task.id : null; }
      start();
      showFocus();
      return { status: 'alreadyFocusing' };
    }
    const inProgress = sessionStart !== null && (running || activeElapsed > 0);
    if (inProgress && !force) return { status: 'needsConfirmation', currentMinutes: minutesRun() };

    // Log the current run under the skip rule (§1.7.1): focus ≥ 60 s is logged; anything else is discarded.
    if (running) { accrue(); fire('stop', { mode, runID, reason: 'startFocus' }); }
    running = false;
    cancelAnimationFrame(rafId); clearTimeout(endTimer);
    document.body.classList.remove('timer-running');
    Audio.stopTicking();
    Audio.pauseAmbience();
    Audio.pauseMusic();
    if (inProgress && mode === 'focus' && activeElapsed >= 60) logFocusSession(true);
    else if (sessionStart !== null) discardRun('startFocus');
    runID = null;
    if (task) Store.setActiveTask(task.id);
    setMode('focus');
    todayPomodoros = todayPomodoros % Math.max(1, Store.settings().longBreakInterval);
    total = durationFor('focus');
    remaining = total;
    endAt = null;
    sessionStart = null;
    activeElapsed = 0;
    lastAccrual = null;
    plan = planCtx ? { ...planCtx } : null;
    planTaskID = plan && task ? task.id : null;
    start();
    showFocus();
    return { status: 'started' };
  }

  function showFocus() {
    try { if (typeof App !== 'undefined' && App.showView) App.showView('focus'); } catch (_) {}
  }

  function state() {
    const live = running && lastAccrual ? (Date.now() - lastAccrual) / 1000 : 0;
    const t = Store.activeTask();
    return {
      mode, running,
      remaining: running && endAt ? Math.max(0, (endAt - Date.now()) / 1000) : remaining,
      total,
      activeElapsed: activeElapsed + live,
      sessionStart: sessionStart ? sessionStart.toISOString() : null,
      endAt: running ? endAt : null,
      runID,
      plan: plan ? { ...plan } : null,
      taskID: t ? t.id : null,
      todayPomodoros,
    };
  }

  // ── persistence of today's pomodoro count ──

  function dayKey(d) { return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }
  function todayKey() { return dayKey(new Date()); }

  // The beads count this cycle; this is the real number finished today.
  function finishedToday() {
    const k = todayKey();
    return Store.sessions().filter((s) => s.mode === 'focus' && !s.skipped && dayKey(new Date(s.end || s.start)) === k).length;
  }

  // A tab left open overnight starts the new day at zero.
  function rollDay() {
    const k = todayKey();
    if (k === countDay) return;
    countDay = k;
    todayPomodoros = 0;
    render();
  }

  function restoreTodayCount() {
    const key = `purefocus.pomos.${todayKey()}`;
    countDay = todayKey();
    try {
      todayPomodoros = Number(localStorage.getItem(key) || 0);
    } catch (_) { todayPomodoros = 0; }
  }

  function saveTodayCount() {
    const key = `purefocus.pomos.${todayKey()}`;
    try { localStorage.setItem(key, String(todayPomodoros)); } catch (_) {}
  }

  Store.on('change', (event) => {
    if (event === 'reset' && !Store.sessions().length) todayPomodoros = 0;   // Reset all data
    if (event === 'sessions' || event === 'bulk' || event === 'remote' || event === 'reset') saveTodayCount();
  });

  // ── init ──

  function init() {
    restoreTodayCount();
    total = durationFor(mode);
    remaining = total;

    $('#btn-play').addEventListener('click', toggle);
    $('#btn-reset').addEventListener('click', reset);
    $('#btn-skip').addEventListener('click', skip);

    document.querySelectorAll('.mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => switchMode(btn.dataset.mode));
    });

    $('#rating-skip').addEventListener('click', dismissPendingRating);
    const taskBtn = $('#ring-task');
    if (taskBtn) taskBtn.addEventListener('click', openTaskMenu);

    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Space' && e.key !== ' ') return;
      if (!spaceTogglesTimer(e)) return;
      e.preventDefault();
      toggle();
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      rollDay();
      if (running) { tick(); if (running) loop(); }
    });

    // Restore a run that was in progress when the tab closed. Saving starts only now, so a slow
    // load can't wipe the saved run before it's been read.
    restoreRunningState();
    setInterval(() => { rollDay(); saveRunningState(); }, 1000);
    window.addEventListener('pagehide', () => saveRunningState(true));
    render();
  }

  /* Space is the start/pause shortcut, but only where it can't mean anything
     else: never while typing, never on a focused control (Space already
     presses buttons, ticks checkboxes and opens menus), never under an open
     dialog or menu, and not on the Calendar, Reports or Settings views, where
     the timer is out of sight. */
  function spaceTogglesTimer(e) {
    if (e.defaultPrevented || e.repeat || e.isComposing) return false;
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
    const t = e.target instanceof Element ? e.target : null;
    if (t) {
      if (t.isContentEditable) return false;
      if (t.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return false;
      if (t.closest('button, a[href], summary, [role="button"], [role="tab"], [role="radio"], [role="checkbox"], [role="switch"], [role="menuitem"], [role="option"], [role="slider"]')) return false;
      if (t.closest('[role="dialog"], [role="menu"], [role="listbox"]')) return false;
    }
    const sheet = $('#task-sheet');
    if (sheet && !sheet.hidden) return false;
    for (const id of ['view-calendar', 'view-reports', 'view-settings']) {
      const view = document.getElementById(id);
      if (view && !view.hidden && view.classList.contains('is-active')) return false;
    }
    return true;
  }

  // One id per tab that survives a reload of that tab, so a reload finds its own run.
  const TAB_ID = (() => {
    const fresh = Math.random().toString(36).slice(2);
    try {
      const had = sessionStorage.getItem('purefocus.tab');
      if (had) return had;
      sessionStorage.setItem('purefocus.tab', fresh);
    } catch (_) {}
    return fresh;
  })();
  const OWNER_FRESH_MS = 2500;   // a tab still saving this recently is alive, and the run is its own
  const LATE_FINISH_MS = 1200;   // after boot: the session hooks (music, place, drift) are in by then

  function restoreRunningState() {
    try {
      const raw = localStorage.getItem('purefocus.running');
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (!saved || !saved.mode) { localStorage.removeItem('purefocus.running'); return; }
      if (saved.tab && saved.tab !== TAB_ID && !saved.released && Date.now() - (saved.savedAt || 0) < OWNER_FRESH_MS) return;
      wroteRun = true;
      mode = saved.mode;
      if (saved.idle) {                                  // waiting on a break you haven't started
        total = durationFor(mode);
        remaining = total;
        return;
      }
      total = saved.total || durationFor(mode);
      sessionStart = saved.sessionStart ? new Date(saved.sessionStart) : new Date();
      runID = typeof saved.runID === 'string' && saved.runID ? saved.runID : null;
      plan = saved.plan && typeof saved.plan === 'object' ? saved.plan : null;
      planTaskID = plan ? (saved.planTaskID || null) : null;
      runTaskID = saved.runTaskID || null;
      if (saved.paused) {
        remaining = Math.max(0, Math.min(total, Number(saved.remaining) || 0));
        activeElapsed = Number.isFinite(saved.activeElapsed) ? Math.min(total, saved.activeElapsed) : Math.max(0, total - remaining);
        return;
      }
      if (!saved.endAt) { sessionStart = null; remaining = total; return; }
      if (saved.endAt <= Date.now()) {                   // it ran out while the tab was closed
        endAt = saved.endAt;
        remaining = 0;
        activeElapsed = total;
        running = true;
        finishingLate = true;
        setTimeout(() => { if (running && finishingLate) complete(); }, LATE_FINISH_MS);
        return;
      }
      remaining = (saved.endAt - Date.now()) / 1000;
      // The run kept going while the tab was closed (the clock is wall-time based).
      const away = saved.savedAt ? Math.max(0, (Date.now() - saved.savedAt) / 1000) : 0;
      activeElapsed = Number.isFinite(saved.activeElapsed) ? Math.min(total, saved.activeElapsed + away) : Math.max(0, total - remaining);
      start();
    } catch (_) {}
  }

  function saveRunningState(released) {
    try {
      const base = { mode, tab: TAB_ID, savedAt: Date.now(), ...(released === true ? { released: true } : {}) };
      let rec = null;
      if (sessionStart !== null && (endAt || !running)) {
        rec = { ...base, total, endAt: running ? endAt : null, paused: !running, remaining, sessionStart: sessionStart.toISOString(),
          activeElapsed: activeElapsed + (running && lastAccrual ? (Date.now() - lastAccrual) / 1000 : 0),
          plan, planTaskID, runID, runTaskID };
      } else if (mode !== 'focus') {
        rec = { ...base, idle: true };
      }
      if (rec) {
        localStorage.setItem('purefocus.running', JSON.stringify(rec));
        wroteRun = true;
      } else if (wroteRun) {
        localStorage.removeItem('purefocus.running');
        wroteRun = false;
      }
    } catch (_) {}
  }

  return {
    init, render, start, pause, toggle, reset, skip, switchMode, addMinute, syncDuration,
    on, addSessionExtra, state, startFocus, planContext: () => (plan ? { ...plan } : null),
    ratePendingSession, dismissPendingRating, refreshActiveTask,
    renderNowPlaying, refreshNowPlaying, renderNowPlayingProgress,
    remaining: () => remaining,
    mode: () => mode,
    isRunning: () => running,
    total: () => total,
    todayPomodoros: () => todayPomodoros,
    modeTint,
    saveRunningState,
  };
})();
