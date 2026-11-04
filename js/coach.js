/* ═══════════════════════════════════════════════════════════════════════
   coach.js — ✦ Plan: plan runs, the preview bar, Details, Keep / Undo,
   the weekly ritual dot and plan XP (owner: W3)

   One planner (SPEC-V2 E5): every plan is StudyPlan.prepare → StudyPlan.items →
   CalCore.planRange, shown as a PlanPreview (SPEC-V2 §4.3) through
   CalendarView.setPreview; Coach draws the dashed ghost blocks itself into the
   grid's .cal-col[data-day] / .cal-mcell[data-day] (H14). Keep = one Store.bulk + one
   CalendarView.pushUndo; Discard writes nothing. The AI never places blocks
   (v2-ai C2).

   const Coach = {
     init()                 mounts ✦ Plan into CalendarView.planSlot(), the bar into previewRoot(),
                            Shift+P, Rewards.setPlanProvider
     runRecommended()       → Promise<PlanPreview|null>
     run(kind, opts)        kind: 'today'|'tomorrow'|'week'|'until'|'missed' (opts.day for 'until')
                            → Promise<PlanPreview|null>
     preview()              → PlanPreview | null
     toggle(key)            include / exclude one ghost
     keep()                 → bool  (one Store.bulk + one CalendarView.pushUndo)
     discard()              storage untouched
     isPreviewing()         → bool
     recommended()          → {kind, label, sub, dot}       (v2-calendar §7.2, §8.5)
     planInput()            → Rewards plan input {xpByDay, plannedBlocks, onPlan, clockworkDays} | null
     clearAutoPlanned()     → number of blocks removed (in view, future, no sessions; one undo)
   }
   Safety: every task, course, assignment and AI string goes through textContent.
   innerHTML is used only for the static SVG icons below.
   ═══════════════════════════════════════════════════════════════════════ */

const Coach = (() => {
  'use strict';
  const KEEP_MS = 30 * 60000;          // a preview survives leaving the Calendar this long
  const RECOMPUTE_MS = 15 * 60000;     // returning after this long recomputes it ("Plan refreshed")
  const DOT_KEY = 'purefocus.plan.weekdot';
  const INTRO_KEY = 'purefocus.plan.intro.v2';   // v2: the v1 card was never visible (hidden #task-sheet matched the modal rule)
  const EXPLAIN = 'Fits your tasks and assignments into free time before they’re due — Keep or Discard';
  const BUTTON_TIP = 'Plan my week: fits your tasks and assignments into free time before they’re due. You see a preview first (Shift+P)';
  const ICONS = {
    sparkles: '<svg viewBox="0 0 20 20"><path d="M9 2.6c.55 3.9 1.75 5.1 5.65 5.65-3.9.55-5.1 1.75-5.65 5.65-.55-3.9-1.75-5.1-5.65-5.65C7.25 7.7 8.45 6.5 9 2.6Z" fill="currentColor"/><path d="M15.1 12.2c.27 1.62.75 2.1 2.37 2.37-1.62.27-2.1.75-2.37 2.37-.27-1.62-.75-2.1-2.37-2.37 1.62-.27 2.1-.75 2.37-2.37Z" fill="currentColor"/></svg>',
    caret: '<svg viewBox="0 0 20 20"><path d="m6 8 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    check: '<svg viewBox="0 0 20 20"><path d="m5.2 10.4 3.1 3.1 6.5-6.8" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    close: '<svg viewBox="0 0 20 20"><path d="m5.5 5.5 9 9m0-9-9 9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    chevR: '<svg viewBox="0 0 20 20"><path d="M7.5 4.5 13 10l-5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    warn: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="4" fill="currentColor"/></svg>',
  };

  let inited = false;
  let pv = null;            // {preview, ctx}
  let leftAt = null;        // when the Calendar was hidden with a preview open
  const ui = { slot: null, root: null, btn: null, main: null, caret: null, dot: null, menu: null, bar: null, details: null, undoToast: null, intro: null };
  let planMemo = { sig: '', value: null };

  // ───────────────────────── small helpers ─────────────────────────
  const lower = (s) => String(s == null ? '' : s).toLowerCase();
  const sameID = (a, b) => a != null && b != null && lower(a) === lower(b);
  const int = (v) => { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? n : 0; };
  const has = (o, k) => o != null && o[k] !== undefined && o[k] !== null;
  const today = () => CalCore.dayKey(new Date());
  const minutesNow = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'style') el.setAttribute('style', v);
        else if (k === 'vars') for (const [n, val] of Object.entries(v)) el.style.setProperty(n, val);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, String(v));
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.appendChild(typeof kid === 'object' ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  function icon(name, cls) {
    const t = document.createElement('template');
    t.innerHTML = ICONS[name];            // static markup only
    const svg = t.content.firstElementChild;
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'pf-i' + (cls ? ' ' + cls : ''));
    return svg;
  }
  function fmt(opts) { try { return new Intl.DateTimeFormat(undefined, opts); } catch (_) { return new Intl.DateTimeFormat('en-US', opts); } }
  const F = { time: fmt({ hour: 'numeric', minute: '2-digit' }), dow: fmt({ weekday: 'short' }), md: fmt({ month: 'short', day: 'numeric' }),
    dowLong: fmt({ weekday: 'long' }) };
  const dateOf = (k, min = 0) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d, 0, min); };
  const timeLabel = (k, min) => F.time.format(dateOf(k, min));
  function rangeLabel(k, a, b) {
    try { if (F.time.formatRange) return F.time.formatRange(dateOf(k, a), dateOf(k, b)).replace(/\s*[–-]\s*/, '–'); } catch (_) {}
    return `${timeLabel(k, a)}–${timeLabel(k, b)}`;
  }
  const dowLabel = (k) => F.dow.format(dateOf(k));
  const mdLabel = (k) => F.md.format(dateOf(k));
  function dayWord(k) {
    const t = today();
    if (k === t) return 'today';
    if (k === CalCore.addDays(t, 1)) return 'tomorrow';
    return dowLabel(k);
  }
  function fmtDur(min) {
    const hh = Math.floor(min / 60), mm = Math.round(min % 60);
    if (!hh) return `${mm} m`;
    return mm ? `${hh} h ${mm} m` : `${hh} h`;
  }
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
  function toast(msg, variant) { try { App.toast(msg, variant); } catch (_) { /* no toast host */ } }
  function reduceMotion() {
    try { return document.body.classList.contains('reduce-motion') || matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; }
  }
  function focusing() { try { const s = Timer.state(); return !!(s && s.running && s.mode === 'focus'); } catch (_) { return false; } }
  function calendarVisible() { const v = document.getElementById('view-calendar'); return !!v && !v.hidden; }
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(pfKey(k)); localStorage.setItem(pfKey(k), v); } catch (_) { /* private mode */ } return null; }
  function isoWeek(d) {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return t.getUTCFullYear() + '-W' + Math.ceil(((t - y0) / 86400000 + 1) / 7);
  }

  // ───────────────────────── data gathering ─────────────────────────
  function feedsByID() {
    const m = new Map();
    try { for (const f of Store.calendar().feeds || []) m.set(lower(f.id), f); } catch (_) {}
    return m;
  }
  /* Imported timed events that block time (V5: hidden calendars still block unless "Doesn't block my time"). */
  function busyEvents() {
    const seen = new Set(), out = [];
    const push = (e) => { if (e && e.id != null && !seen.has(lower(e.id))) { seen.add(lower(e.id)); out.push(e); } };
    try { if (typeof Feeds !== 'undefined' && typeof Feeds.events === 'function') (Feeds.events() || []).forEach(push); } catch (_) {}
    try { if (typeof CalendarView !== 'undefined' && CalendarView.events) (CalendarView.events() || []).filter((e) => e.source && e.source !== 'local').forEach(push); } catch (_) {}
    const feeds = feedsByID();
    return out.filter((e) => {
      if (e.allDay || e.isBusy === false) return false;
      const f = e.calendarID ? feeds.get(lower(e.calendarID)) : null;
      return !f || f.blocksTime !== false;
    });
  }
  function assignmentsAll() {
    try { return typeof Assignments !== 'undefined' && Assignments.list ? Assignments.list({ includeDismissed: true }) : []; } catch (_) { return []; }
  }
  /* Unpromoted, undismissed, unsubmitted assignments (v2-ai §4.1). */
  function unpromotedAssignments(all) {
    const linked = new Set(Store.tasks().filter((t) => t.externalID).map((t) => lower(t.externalID)));
    const dis = new Set(((Store.calendar() || {}).dismissedAssignments || []).map(lower));
    return all.filter((a) => a && !linked.has(lower(a.id)) && !dis.has(lower(a.id)) && a.submitted !== true);
  }
  function todayFocus() {
    const t = today();
    let minutes = 0, poms = 0;
    for (const s of CalCore.derivePlanSessions(Store.sessions() || [])) {
      if (!s.qualified || CalCore.dayKey(new Date(s.start)) !== t) continue;
      minutes += s.cm / 100;
      poms++;
    }
    return { minutes: Math.round(minutes), poms };
  }
  function estimateFor(a) {
    try { if (typeof Assignments !== 'undefined' && Assignments.estimatePomodoros) return Assignments.estimatePomodoros(a, 1); } catch (_) {}
    return 2;
  }
  function snapshot(from, to) {
    const all = assignmentsAll();
    const tf = todayFocus();
    return {
      now: new Date(), from, to, settings: Store.settings(), prefs: (Store.calendar() || {}).prefs || {},
      tasks: Store.tasks(), activeTaskID: (Store.activeTask() || {}).id || null, blocks: Store.blocks() || [],
      events: busyEvents(), courses: Store.courses() || [], assignments: unpromotedAssignments(all),
      allAssignmentIDs: all.map((a) => a.id), focusedTodayMinutes: tf.minutes, completedPomodorosToday: tf.poms,
      estimateFor, ratioFor: () => 1,
    };
  }
  function planSettings() {
    const s = Store.settings(), p = (Store.calendar() || {}).prefs || {};
    return { focus: int(s.focusMinutes) || 25, short: int(s.shortBreakMinutes) || 5, long: int(s.longBreakMinutes) || 15,
      interval: Math.max(1, int(s.longBreakInterval) || 4), dayStart: has(p, 'planDayStart') ? p.planDayStart : 480,
      dayEnd: has(p, 'planDayEnd') ? p.planDayEnd : 1320 };
  }
  function weekPlanFor(k) {
    const wp = ((Store.calendar() || {}).prefs || {}).weekPlan || [];
    return wp.find((x) => x && x.weekday === CalCore.weekday(k)) || null;
  }
  /* Planning time remains today when one block still fits before the day's end (v2-ai §4.2). */
  function timeRemainsToday() {
    const s = planSettings();
    const wp = weekPlanFor(today());
    if (wp && wp.off) return false;
    const end = wp && Number.isFinite(wp.end) ? wp.end : s.dayEnd;
    const start = Math.max(wp && Number.isFinite(wp.start) ? wp.start : s.dayStart, CalCore.ceilTo(minutesNow() + CalCore.C.AUTO_LEAD, 15));
    return start + CalCore.blockMinutes(1, s) <= end;
  }
  function rangeDays() { return Math.min(14, Math.max(3, int(((Store.calendar() || {}).prefs || {}).planRangeDays) || 7)); }
  function rangeFor(kind, opts = {}) {
    const t = today(), first = timeRemainsToday() ? t : CalCore.addDays(t, 1);
    switch (kind) {
      case 'today': case 'missed': return { from: first, to: first, shifted: first !== t };
      case 'tomorrow': { const k = CalCore.addDays(t, 1); return { from: k, to: k }; }
      case 'until': {
        let to = opts.day && /^\d{4}-\d{2}-\d{2}$/.test(opts.day) ? opts.day : CalCore.addDays(first, rangeDays() - 1);
        if (to < first) to = first;
        if (CalCore.daysBetween(first, to) > 13) to = CalCore.addDays(first, 13);
        return { from: first, to };
      }
      default: return { from: first, to: CalCore.addDays(first, rangeDays() - 1) };
    }
  }

  // ───────────────────────── plan XP (SPEC §1.3.7; item 3) ─────────────────────────
  function scoredBlocks() {
    return (Store.blocks() || []).filter((b) => b && !b.readOnly && b.kind === 'focus' && !b.allDay && int(b.pomodoros) >= 1);
  }
  function planInput() {
    const blocks = scoredBlocks();
    if (!blocks.length) return null;
    const ss = Store.sessions() || [];
    const last = ss.length ? ss[ss.length - 1] : null;
    const sig = [ss.length, last && last.id, last && last.minutes, today(),
      blocks.map((b) => [b.id, b.start, b.end, b.taskID, b.pomodoros, b.plannedFocusMinutes, b.plannedAt, b.hidden ? 1 : 0].join(',')).join(';')].join('|');
    if (planMemo.sig === sig) return planMemo.value;
    const score = CalCore.planScore(CalCore.derivePlanSessions(ss), blocks, new Date());
    const t = today();
    const days = new Map();
    for (const b of blocks) {
      const st = score.blocks[b.id];
      if (!st || !st.eligible) continue;
      const k = CalCore.dayKey(new Date(b.start));
      if (k >= t) continue;
      const d = days.get(k) || { eligible: 0, done: 0 };
      d.eligible++;
      if (st.status === 'done') d.done++;
      days.set(k, d);
    }
    let onPlan = 0;
    for (const st of Object.values(score.blocks)) onPlan += st.onPlan.length;
    const value = { xpByDay: score.planXPByDay, plannedBlocks: blocks.length, onPlan,
      clockworkDays: Array.from(days.values()).filter((d) => d.eligible >= 3 && d.done === d.eligible).length };
    planMemo = { sig, value };
    return value;
  }

  // ───────────────────────── reasons (v2-ai §7.3 copy) ─────────────────────────
  function reasonFor(item, block) {
    if (!item) return null;
    const t = today();
    if (item.due && item.due < t) return 'Overdue — get it off your plate.';
    if (item.part && item.due && item.hardBefore === 0) {
      return `Finish “${item.part}” by ${F.dowLong.format(dateOf(item.due))}, so the next step has room.`;
    }
    if (item.kind === 'exam' || item.kind === 'quiz') {
      const what = item.kind === 'exam' ? 'exam' : 'quiz';
      if (item.due && CalCore.daysBetween(block.day, item.due) === 1) return `Final review the day before the ${what}.`;
      if (item.due) return `Short, spaced review before ${F.dowLong.format(dateOf(item.due))}’s ${what}.`;
    }
    if (item.due === t && has(item, 'dueMinutes')) return `Due today at ${timeLabel(t, item.dueMinutes)}.`;
    if (item.due) {
      const when = has(item, 'dueMinutes') ? `${dowLabel(item.due)} ${timeLabel(item.due, item.dueMinutes)}` : dowLabel(item.due);
      return CalCore.daysBetween(block.day, item.due) >= 1 ? `Due ${when} — done with a day to spare.` : `Due ${when}.`;
    }
    if (item.active) return 'Your current task.';
    return 'From your task list.';
  }

  // ───────────────────────── building a preview ─────────────────────────
  function taskByID(id) { return Store.tasks().find((t) => sameID(t.id, id)) || null; }
  function courseByID(id) { return (Store.courses() || []).find((c) => sameID(c.id, id)) || null; }
  function scheme() { try { return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'; } catch (_) { return 'dark'; } }
  function colorFor(item) {
    const c = item && item.courseID ? courseByID(item.courseID) : null;
    if (c && c.colorHex) return c.colorHex;
    const t = item ? taskByID(item.id) : null;
    const cat = (t && t.category) || (c && (c.code || c.name)) || null;
    return CalCore.categoryColor(cat, scheme());
  }
  const ghostKey = (b) => `${b.day}|${b.taskID}|${b.part || ''}|${b.start}`;
  const itemKey = (taskID, part) => `${taskID}\u0001${part || ''}`;

  function compute(kind, opts = {}) {
    const range = opts.range || rangeFor(kind, opts);
    const snap = snapshot(range.from, range.to);
    const prep = StudyPlan.prepare(snap);
    let items = StudyPlan.items(prep.study);
    if (kind === 'missed') {
      const ids = new Set(missedBlocks().map((b) => lower(b.taskID)));
      items = items.filter((it) => ids.has(lower(it.id)));
    }
    let plan = CalCore.planRange({ settings: prep.settings, days: prep.days, items });
    /* "Not enough time before <day>" on a near-empty calendar is really the spacing rule (exams, quizzes and
       readings get at most 2 sessions a day). Before blaming time, let those items use up to a full cycle a day. */
    const tight = plan.unfit.filter((u) => u.reason === 'noTimeBeforeDue');
    if (tight.length) {
      const cap = Math.max(2, int(prep.settings.interval) || 4);
      const keys = new Set(tight.map((u) => itemKey(u.taskID, u.part)));
      const relaxed = items.map((it) => (keys.has(itemKey(it.id, it.part)) && !it.maxPerDay ? { ...it, maxPerDay: cap } : it));
      const p2 = CalCore.planRange({ settings: prep.settings, days: prep.days, items: relaxed });
      const short = (pl) => pl.unfit.reduce((t, u) => t + u.need, 0);
      if (short(p2) < short(plan)) { plan = p2; items = relaxed; }
    }
    return { kind, opts, range, prep, items, plan, createdAt: Date.now() };
  }

  function buildPreview(ctx, carry) {
    const { prep, items, plan } = ctx;
    const byKey = new Map(items.map((it) => [itemKey(it.id, it.part), it]));
    const excludedItems = carry && carry.excludedItems ? carry.excludedItems : new Set();
    const ghosts = plan.blocks.map((b) => {
      const it = byKey.get(itemKey(b.taskID, b.part));
      return {
        key: ghostKey(b), kind: 'add', day: b.day, start: b.start, end: b.end, taskID: b.taskID, title: b.title,
        part: b.part || null, pomodoros: b.pomodoros, colorHex: colorFor(it || { id: b.taskID }),
        included: !(excludedItems.has(itemKey(b.taskID, b.part)) || (carry && carry.excludedTasks && carry.excludedTasks.has(b.taskID))),
        why: reasonFor(it, b),
      };
    });
    const ghostTasks = new Set(ghosts.map((g) => g.taskID));
    const newTasks = [];
    for (const [id, v] of Object.entries(prep.virtual)) {
      if (!ghostTasks.has(id)) continue;
      const row = prep.study.tasks.find((t) => t.id === id) || {};
      newTasks.push({ id, type: v.type, title: row.title || '', estimate: row.estimate || 1, dueDate: row.dueDate || null,
        courseID: row.courseID || null, included: !(carry && carry.excludedTasks && carry.excludedTasks.has(id)) });
    }
    const unfit = plan.unfit.map((u) => {
      const it = byKey.get(itemKey(u.taskID, u.part)) || {};
      return { taskID: u.taskID, part: u.part || null, need: u.need, reason: u.reason, title: it.title || '', due: it.due || null,
        dueMinutes: has(it, 'dueMinutes') ? it.dueMinutes : null, anywayDay: anywayDay(ctx, it, u) };
    });
    const perDay = plan.perDay.map((d) => ({ day: d.day, capacity: d.capacity, planned: d.planned, off: !!(prep.days.find((x) => x.day === d.day) || {}).off }));
    const p = {
      id: Store.uid(), createdAt: new Date(ctx.createdAt).toISOString(), range: [ctx.range.from, ctx.range.to], source: 'basic',
      status: 'ready', failure: null, ghosts, newTasks, estimateChanges: [], unfit, perDay, summary: null,
      warnings: plan.warnings.slice(),
    };
    return p;
  }

  /* "Plan anyway on <day>": the last allowed day inside the range (null when none). */
  function anywayDay(ctx, it, u) {
    if (!it || !it.id || u.reason === 'dueTooSoon') return null;
    const days = ctx.prep.days.filter((d) => d.dayRelation !== 'past' && !d.off).map((d) => d.day);
    if (!days.length) return null;
    let last = days[days.length - 1];
    if (it.due) {
      const rule = CalCore.KIND_RULES[it.kind || 'other'] || CalCore.KIND_RULES.other;
      let hb = has(it, 'hardBefore') ? it.hardBefore : rule.hardBefore;
      if (has(it, 'dueMinutes') && it.dueMinutes < ctx.prep.settings.dayEnd) hb = Math.max(hb, 1);
      const hard = CalCore.addDays(it.due, -hb);
      const ok = days.filter((d) => d <= hard && (!it.unlockDay || d >= it.unlockDay));
      if (!ok.length) return null;
      last = ok[ok.length - 1];
    }
    return last;
  }

  // ───────────────────────── run / toggle / discard ─────────────────────────
  function show(ctx, preview) {
    pv = { ctx, preview };
    leftAt = null;
    try { CalendarView.setPreview(preview); } catch (_) {}
    redrawGhosts();
    renderBar();
    if (ui.details) renderDetails();
    revealIfHidden(preview);
    return preview;
  }
  function revealIfHidden(p) {
    try {
      const r = CalendarView.visibleRange();
      const inView = p.ghosts.some((g) => g.day >= r.from && g.day <= r.to);
      if (!inView && p.ghosts.length) CalendarView.goTo(p.ghosts[0].day);
    } catch (_) {}
  }

  function run(kind, opts = {}) {
    try {
      closeMenu();
      const ctx = compute(kind, opts);
      const preview = buildPreview(ctx, opts.carry || null);
      if (!ctx.items.length) {
        toast(kind === 'missed' ? 'Nothing missed to reschedule'
          : 'Nothing to plan yet — add a task with an estimate or due date, or a course with graded items');
        return Promise.resolve(null);
      }
      if (ctx.range.shifted && kind === 'today') toast('Today’s planning hours are over, so this plans tomorrow');
      return Promise.resolve(show(ctx, preview));
    } catch (err) {
      console.error('Coach.run failed', err);
      toast('Couldn’t make a plan right now');
      return Promise.resolve(null);
    }
  }

  function recommended() {
    const t = today();
    const end = CalCore.addDays(t, 6);
    const due = [];
    for (const task of Store.tasks()) {
      if (task.isDone || !task.dueDate || task.dueDate < t || task.dueDate > end) continue;
      due.push({ need: Math.max(0, int(task.estimate) - int(task.completedPomodoros)), id: task.id });
    }
    for (const a of unpromotedAssignments(assignmentsAll())) {
      if (a.dueDay && a.dueDay >= t && a.dueDay <= end) due.push({ need: estimateFor(a), id: null });
    }
    let need = 0, planned = 0;
    const cov = new Map();
    const now = Date.now();
    for (const b of Store.blocks() || []) {
      if (b.kind !== 'focus' || b.hidden || !b.taskID || !(Date.parse(b.end) > now)) continue;
      cov.set(lower(b.taskID), (cov.get(lower(b.taskID)) || 0) + int(b.pomodoros));
    }
    for (const d of due) { need += d.need; if (d.id) planned += Math.min(d.need, cov.get(lower(d.id)) || 0); }
    const weekly = due.length >= 2 && need > 0 && planned / need < 0.5;
    const n = rangeDays();
    if (weekly) return { kind: 'week', label: `Plan the next ${n} days`, sub: `${plural(due.length, 'assignment')} due`, weekly: true, due: due.length };
    if (new Date().getHours() < 18 && timeRemainsToday()) return { kind: 'today', label: 'Plan today', sub: null, weekly: false, due: due.length };
    return { kind: 'tomorrow', label: 'Plan tomorrow', sub: null, weekly: false, due: due.length };
  }
  /* The header button and the sidebar "Plan my week ›" link: always the next N days (H14). */
  function runRecommended() {
    clearDot();
    dismissIntro();
    return run('week');
  }

  function toggle(key) {
    if (!pv) return;
    const g = pv.preview.ghosts.find((x) => x.key === key);
    if (!g) return;
    g.included = !g.included;
    pv.ctx.toggled = true;
    syncNewTasks();
    refresh();
  }
  function setTaskIncluded(taskID, on) {
    if (!pv) return;
    for (const g of pv.preview.ghosts) if (g.taskID === taskID) g.included = on;
    pv.ctx.toggled = true;
    syncNewTasks();
    refresh();
  }
  function syncNewTasks() {
    for (const n of pv.preview.newTasks) n.included = pv.preview.ghosts.some((g) => g.taskID === n.id && g.included);
  }
  function refresh() {
    try { CalendarView.setPreview(pv ? pv.preview : null); } catch (_) {}
    redrawGhosts();
    renderBar();
    if (ui.details) renderDetails();
  }

  function discard() {
    pv = null;
    leftAt = null;
    closeDetails();
    try { CalendarView.setPreview(null); } catch (_) {}
    redrawGhosts();
    renderBar();
  }
  function preview() { return pv ? pv.preview : null; }
  function isPreviewing() { return !!pv; }

  /* Recompute with the same kind/options, carrying the user's exclusions over. */
  function recompute(note) {
    if (!pv) return null;
    const excludedItems = new Set(), excludedTasks = new Set();
    for (const n of pv.preview.newTasks) if (!n.included) excludedTasks.add(n.id);
    const byItem = new Map();
    for (const g of pv.preview.ghosts) {
      const k = itemKey(g.taskID, g.part);
      byItem.set(k, (byItem.get(k) || false) || g.included);
    }
    for (const [k, anyIncluded] of byItem) if (!anyIncluded) excludedItems.add(k);
    const { kind, opts } = pv.ctx;
    const ctx = compute(kind, { ...opts, range: null });
    const p = buildPreview(ctx, { excludedItems, excludedTasks });
    show(ctx, p);
    if (note) toast(note);
    return p;
  }

  // ───────────────────────── Plan anyway / days off ─────────────────────────
  function planAnyway(u) {
    if (!pv || !u.anywayDay) return;
    const { prep, items } = pv.ctx;
    const it = items.find((x) => x.id === u.taskID && (x.part || null) === (u.part || null));
    const d0 = prep.days.find((x) => x.day === u.anywayDay);
    if (!it || !d0) return;
    const d = JSON.parse(JSON.stringify(d0));
    let extra = 0;
    for (const g of pv.preview.ghosts) {
      if (g.day !== d.day || !g.included) continue;
      d.blocks.push({ id: 'ghost:' + g.key, taskID: g.taskID, start: g.start, end: g.end, pomodoros: g.pomodoros });
      extra += g.pomodoros * prep.settings.focus;
    }
    d.plannedRemainingTodayMinutes = int(d.plannedRemainingTodayMinutes) + extra;
    d.maxPlannedFocus = (has(d, 'maxPlannedFocus') ? d.maxPlannedFocus : prep.settings.maxPlannedFocus) + extra + u.need * prep.settings.focus;
    delete d.off;
    const one = { ...it, remaining: u.need, covered: 0, due: d.day, hardBefore: 0, bufferDays: 0 };
    delete one.dueMinutes; delete one.unlockDay;
    const r = CalCore.planRange({ settings: prep.settings, days: [d], items: [one] });
    if (!r.blocks.length) { toast(`No free time on ${dowLabel(d.day)} either`); return; }
    const placed = r.blocks.reduce((t, b) => t + b.pomodoros, 0);
    for (const b of r.blocks) {
      pv.preview.ghosts.push({ key: ghostKey(b), kind: 'add', day: b.day, start: b.start, end: b.end, taskID: b.taskID, title: b.title,
        part: b.part || null, pomodoros: b.pomodoros, colorHex: colorFor(it), included: true, why: `Planned anyway on ${dowLabel(d.day)}.` });
    }
    pv.preview.ghosts.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.start - b.start));
    const row = pv.preview.unfit.find((x) => x.taskID === u.taskID && x.part === u.part && x.reason === u.reason);
    if (row) { row.need -= placed; if (row.need <= 0) pv.preview.unfit.splice(pv.preview.unfit.indexOf(row), 1); }
    const pd = pv.preview.perDay.find((x) => x.day === d.day);
    if (pd) pd.planned += placed;
    syncNewTasks();
    refresh();
  }

  function toggleDayOff(weekday) {
    const prefs = (Store.calendar() || {}).prefs || {};
    const list = (prefs.weekPlan || []).map((x) => ({ ...x }));
    const i = list.findIndex((x) => x && x.weekday === weekday);
    if (i >= 0) {
      list[i].off = !list[i].off;
      if (!list[i].off && !Number.isFinite(list[i].start) && !Number.isFinite(list[i].end) && !Number.isFinite(list[i].maxFocus)) list.splice(i, 1);
    } else list.push({ weekday, off: true });
    list.sort((a, b) => a.weekday - b.weekday);
    Store.updateCalendar({ prefs: { weekPlan: list } });
    recompute(null);
  }

  // ───────────────────────── Keep / Undo (v2-ai §7.4) ─────────────────────────
  function stale() {
    if (!pv) return false;
    const t = today(), now = minutesNow();
    return pv.preview.ghosts.some((g) => g.included && (g.day < t || (g.day === t && g.start < now)));
  }
  const VIRTUAL = /^(assignment|assessment|new):/;
  function dueAtOf(day, minutes) {
    if (!day || minutes == null) return null;
    return dateOf(day, minutes).toISOString();
  }

  function keep() {
    if (!pv) return false;
    if (stale()) recompute(null);
    if (!pv) return false;
    const inc = pv.preview.ghosts.filter((g) => g.included && g.kind === 'add');
    if (!inc.length) return false;
    const payload = { runID: Store.uid(), at: new Date().toISOString(), ghosts: inc.map((g) => ({ ...g })),
      virtual: pv.ctx.prep.virtual, source: pv.preview.source, blockIDs: inc.map(() => Store.uid()) };
    const rec = apply(payload);
    const n = rec.blocks.length;
    const first = inc.slice().sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.start - b.start))[0];
    const label = `Planned ${plural(n, 'block')} · first one ${dayWord(first.day)} at ${timeLabel(first.day, first.start)}`;
    const step = { label, undo: () => revert(rec), redo: () => { const r2 = apply(payload); Object.assign(rec, r2); }, silent: true };
    pv = null;
    leftAt = null;
    closeDetails();
    try { CalendarView.setPreview(null); } catch (_) {}
    redrawGhosts();
    renderBar();
    try { CalendarView.pushUndo(step); } catch (_) {}
    undoToast(label, step);
    return true;
  }

  /* One Store.bulk: promote assignments, materialise assessments, create blocks, link taskIDs. Returns
     what it did, so revert() can put everything back. Redo replays the same payload (same ids). */
  function apply(payload) {
    const rec = { tasks: [], blocks: [], courses: [], assessmentLinks: [], promoted: [] };
    const nowISO = new Date().toISOString();
    Store.bulk(() => {
      const map = new Map();
      const before = new Set(Store.tasks().map((t) => lower(t.id)));
      const needed = Array.from(new Set(payload.ghosts.map((g) => g.taskID).filter((id) => VIRTUAL.test(id))));
      // 1. promote assignments (v2-calendar §6.3; appended)
      const asg = needed.filter((id) => id.startsWith('assignment:')).map((id) => id.slice('assignment:'.length));
      if (asg.length && typeof Assignments !== 'undefined' && Assignments.promote) {
        try { Assignments.promote(asg); } catch (err) { console.error('Coach: promote failed', err); }
        for (const aid of asg) {
          const t = Store.tasks().find((x) => x.externalID && sameID(x.externalID, aid));
          if (!t) continue;
          map.set('assignment:' + aid, t.id);
          if (!before.has(lower(t.id))) { rec.tasks.push(t.id); rec.promoted.push(aid); }
          const v = payload.virtual['assignment:' + aid];
          const link = v && v.assignment ? linkedAssessment(v.assignment.id) : null;
          if (link && !t.assessmentID) {
            rec.assessmentLinks.push({ taskID: t.id, prev: { courseID: t.courseID || null, assessmentID: t.assessmentID || null } });
            Store.updateTask(t.id, { courseID: link.c.id, assessmentID: link.a.id });
          }
        }
      }
      // 2. materialise assessments (v2-ai §3.7)
      const courseAdds = new Map();
      for (const id of needed.filter((x) => x.startsWith('assessment:'))) {
        const v = payload.virtual[id];
        if (!v || !v.fields) continue;
        const f = v.fields;
        const fixedID = payload.taskIDs && payload.taskIDs[id];
        const c = courseByID(f.courseID);
        const t = Store.addTask({ id: fixedID || undefined, title: f.title, estimate: f.estimate, category: f.category, dueDate: f.dueDate,
          dueAt: dueAtOf(f.dueDate, f.dueMinutes), notes: f.notes, courseID: f.courseID, assessmentID: f.assessmentID,
          course: c && c.code ? String(c.code).slice(0, 40) : null }, { append: true });
        if (!t) continue;
        map.set(id, t.id);
        rec.tasks.push(t.id);
        if (!courseAdds.has(f.courseID)) courseAdds.set(f.courseID, []);
        courseAdds.get(f.courseID).push({ assessmentID: f.assessmentID, taskID: lower(t.id) });
      }
      payload.taskIDs = payload.taskIDs || {};
      for (const [vid, tid] of map) payload.taskIDs[vid] = tid;
      // 3. blocks
      const blocks = [];
      payload.ghosts.forEach((g, i) => {
        const taskID = map.get(g.taskID) || (VIRTUAL.test(g.taskID) ? null : g.taskID);
        const task = taskID ? taskByID(taskID) : null;
        if (!task) return;
        const c = task.courseID ? courseByID(task.courseID) : null;
        const s = dateOf(g.day, g.start), e = dateOf(g.day, g.end);
        blocks.push({
          id: payload.blockIDs[i], title: String(task.title + (g.part ? ' · ' + g.part : '')).slice(0, 120),
          start: s.toISOString(), end: e.toISOString(), allDay: false, startDay: null, endDay: null, kind: 'focus',
          taskID: task.id, category: task.category || null, colorHex: (c && c.colorHex) || null, notes: null, location: null,
          source: 'local', externalID: null, calendarID: null, calendarName: null, eventType: null, readOnly: false, isBusy: true,
          htmlLink: null, pomodoros: g.pomodoros, plannedFocusMinutes: g.pomodoros * (int(Store.settings().focusMinutes) || 25),
          autoPlanned: true, hidden: false, createdAt: nowISO, plannedAt: nowISO, updatedAt: nowISO,
          planWhy: g.why ? String(g.why).slice(0, 140) : null, planRunID: payload.runID, planSource: payload.source || 'basic',
        });
      });
      if (blocks.length) Store.setBlocks((Store.blocks() || []).concat(blocks));
      rec.blocks = blocks.map((b) => b.id);
      // 4. assessment.taskIDs
      for (const [cid, adds] of courseAdds) {
        const c = courseByID(cid);
        if (!c) continue;
        rec.courses.push(JSON.parse(JSON.stringify(c)));
        const next = JSON.parse(JSON.stringify(c));
        for (const a of next.assessments || []) {
          const mine = adds.filter((x) => sameID(x.assessmentID, a.id)).map((x) => x.taskID);
          if (mine.length) a.taskIDs = Array.from(new Set((a.taskIDs || []).concat(mine)));
        }
        Store.upsertCourse(next);
      }
    });
    return rec;
  }

  function revert(rec) {
    const blockSet = new Set(rec.blocks.map(lower));
    // forget the promotions first, so the deleted tasks never read as "dismissed by the user"
    if (rec.promoted.length) {
      try { if (typeof Assignments !== 'undefined' && Assignments.unpromote) Assignments.unpromote(rec.promoted); } catch (_) {}
    }
    Store.bulk(() => {
      if (blockSet.size) Store.setBlocks((Store.blocks() || []).filter((b) => !blockSet.has(lower(b.id))));
      for (const l of rec.assessmentLinks) if (!rec.tasks.some((t) => sameID(t, l.taskID))) Store.updateTask(l.taskID, l.prev);
      for (const id of rec.tasks) Store.deleteTask(id);
      for (const c of rec.courses) Store.upsertCourse(c);
    });
  }
  function linkedAssessment(assignmentID) {
    for (const c of Store.courses() || []) for (const a of c.assessments || []) if (a.externalID && sameID(a.externalID, assignmentID)) return { c, a };
    return null;
  }

  function undoToast(label, step) {
    const stack = document.getElementById('toast-stack');
    if (!stack) { toast(label, 'success'); return; }
    if (ui.undoToast) ui.undoToast.remove();
    let done = false;
    const node = h('div', { class: 'toast pf-undo-toast', role: 'status' },
      h('span', { class: 'pf-undo-text', text: label }),
      h('button', { class: 'pf-undo-btn', type: 'button', onclick: () => {
        if (done) return;
        done = true;
        try { step.undo(); } catch (err) { console.error('Coach: undo failed', err); }
        try {
          const st = CalendarView._v2 && CalendarView._v2.undo;
          const i = st ? st.indexOf(step) : -1;
          if (i >= 0) st.splice(i, 1);
          CalendarView.render();
        } catch (_) {}
        node.remove();
        toast('Plan removed');
      } }, 'Undo'));
    stack.appendChild(node);
    ui.undoToast = node;
    setTimeout(() => { node.classList.add('is-leaving'); setTimeout(() => node.remove(), 320); }, 8000);
  }

  // ───────────────────────── missed / clear ─────────────────────────
  function missedBlocks() {
    const now = Date.now(), t = today(), lo = CalCore.addDays(t, -7);
    const blocks = scoredBlocks().filter((b) => !b.hidden && Date.parse(b.end) <= now && CalCore.dayKey(new Date(b.start)) >= lo && b.taskID);
    if (!blocks.length) return [];
    const score = CalCore.planScore(CalCore.derivePlanSessions(Store.sessions() || []), blocks, new Date());
    const open = new Map(Store.tasks().filter((x) => !x.isDone).map((x) => [lower(x.id), x]));
    const unsched = new Map(CalCore.unscheduled(Array.from(open.values()), Store.blocks() || [], new Date()).map((u) => [lower(u.taskID), u.unscheduled]));
    return blocks.filter((b) => {
      const st = score.blocks[b.id];
      return st && (st.status === 'missed' || st.status === 'partial') && (unsched.get(lower(b.taskID)) || 0) > 0;
    });
  }
  function clearable() {
    let r = null;
    try { r = CalendarView.visibleRange(); } catch (_) {}
    const now = Date.now();
    const blocks = (Store.blocks() || []).filter((b) => b && b.autoPlanned && !b.readOnly && Date.parse(b.start) >= now &&
      (!r || (CalCore.dayKey(new Date(b.start)) >= r.from && CalCore.dayKey(new Date(b.start)) <= r.to)));
    if (!blocks.length) return [];
    const matched = new Set(Object.values(CalCore.planScore(CalCore.derivePlanSessions(Store.sessions() || []), blocks, new Date()).sessionBlock).map(lower));
    return blocks.filter((b) => !matched.has(lower(b.id)));
  }
  function clearAutoPlanned() {
    closeMenu();
    const list = clearable();
    if (!list.length) { toast('No auto-planned blocks to clear in view'); return 0; }
    const ids = new Set(list.map((b) => lower(b.id)));
    const before = (Store.blocks() || []).slice();
    Store.setBlocks(before.filter((b) => !ids.has(lower(b.id))));
    const label = `Cleared ${plural(list.length, 'auto-planned block')}`;
    const step = { label, silent: true,
      undo: () => Store.setBlocks(restoreOrder(before, Store.blocks() || [], list)),
      redo: () => Store.setBlocks((Store.blocks() || []).filter((b) => !ids.has(lower(b.id)))) };
    try { CalendarView.pushUndo(step); } catch (_) {}
    undoToast(label, step);
    return list.length;
  }
  /* Puts removed blocks back where they were, keeping any changes made since. */
  function restoreOrder(before, current, removed) {
    const cur = new Map(current.map((b) => [lower(b.id), b]));
    const rem = new Set(removed.map((b) => lower(b.id)));
    const out = [];
    for (const b of before) {
      const k = lower(b.id);
      if (rem.has(k)) out.push(b);
      else if (cur.has(k)) { out.push(cur.get(k)); cur.delete(k); }
    }
    for (const b of cur.values()) out.push(b);
    return out;
  }

  // ───────────────────────── the ✦ Plan split button + menu ─────────────────────────
  function weeklyDotWanted(rec) {
    if (focusing() || !rec.weekly) return false;
    const d = new Date();
    const day = d.getDay();
    if (!((day === 0 && d.getHours() >= 16) || day === 1)) return false;
    return store(DOT_KEY) !== isoWeek(d);
  }
  function clearDot() {
    if (ui.dot && !ui.dot.hidden) store(DOT_KEY, isoWeek(new Date()));
    if (ui.dot) ui.dot.hidden = true;
  }

  function buildButton() {
    const slot = CalendarView.planSlot();
    ui.slot = slot;
    slot.textContent = '';
    ui.main = h('button', { class: 'pf-plan-main', type: 'button', onclick: () => runRecommended(), title: BUTTON_TIP, 'aria-label': 'Plan my week' },
      icon('sparkles', 'pf-plan-spark'), h('span', { class: 'pf-plan-label', text: 'Plan my week' }), h('span', { class: 'pf-plan-label-short', text: 'Plan' }));
    ui.caret = h('button', { class: 'pf-plan-caret', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': 'More planning options',
      title: 'More planning options', onclick: (e) => { e.stopPropagation(); if (ui.menu) closeMenu(); else openMenu(); } }, icon('caret'));
    ui.dot = h('span', { class: 'pf-plan-dot', hidden: true, 'aria-hidden': 'true' });
    ui.btn = h('div', { class: 'pf-plan btn-primary', role: 'group', 'aria-label': 'Plan my week' }, ui.main, h('span', { class: 'pf-plan-hair', 'aria-hidden': 'true' }), ui.caret, ui.dot);
    slot.appendChild(ui.btn);
    updateButton();
  }
  function updateButton() {
    if (!ui.btn) return;
    const rec = recommended();
    ui.main.title = BUTTON_TIP;
    const dot = weeklyDotWanted(rec);
    ui.dot.hidden = !dot;
    if (dot) ui.main.title = `${BUTTON_TIP} · ${rec.sub}`;
  }

  function menuItem(label, sub, onClick, opts = {}) {
    const b = h('button', { class: 'pf-menu-item' + (opts.strong ? ' is-strong' : ''), type: 'button', role: opts.check != null ? 'menuitemcheckbox' : 'menuitem',
      'aria-checked': opts.check != null ? String(!!opts.check) : null, disabled: !!opts.disabled, onclick: (e) => { e.stopPropagation(); onClick(); } },
    h('span', { class: 'pf-menu-check' }, opts.check ? icon('check') : null),
    h('span', { class: 'pf-menu-text' }, h('span', { class: 'pf-menu-label', text: label }), sub ? h('span', { class: 'pf-menu-sub', text: sub }) : null));
    return b;
  }
  function openMenu() {
    closeMenu();
    const n = rangeDays();
    const missed = missedBlocks().length;
    const clear = clearable().length;
    const menu = h('div', { class: 'pf-menu', role: 'menu', 'aria-label': 'Planning options' });
    menu.appendChild(h('div', { class: 'pf-menu-overline', text: 'Make a plan · you see a preview first' }));
    menu.appendChild(menuItem('Plan my week', `The next ${n} days`, () => { clearDot(); dismissIntro(); run('week'); }, { strong: true }));
    menu.appendChild(menuItem('Plan today', null, () => run('today')));
    menu.appendChild(menuItem('Plan tomorrow', null, () => run('tomorrow')));
    const until = h('div', { class: 'pf-menu-until', hidden: true });
    const t = today();
    const date = h('input', { type: 'date', class: 'pf-menu-date', min: CalCore.addDays(t, 1), max: CalCore.addDays(t, 13), value: CalCore.addDays(t, n - 1),
      'aria-label': 'Plan until' });
    until.append(date, h('button', { class: 'btn btn-sm', type: 'button', onclick: (e) => { e.stopPropagation(); run('until', { day: date.value }); } }, 'Plan'));
    menu.appendChild(menuItem('Plan until…', 'Up to 14 days', () => { until.hidden = !until.hidden; if (!until.hidden) date.focus(); }));
    menu.appendChild(until);
    if (missed) menu.appendChild(menuItem(`Reschedule missed (${missed})`, 'Finds new time for blocks you skipped', () => run('missed')));
    menu.appendChild(h('div', { class: 'pf-menu-sep' }));
    menu.appendChild(menuItem('Courses…', 'Classes, exams and due dates the plan follows', () => { closeMenu(); try { Courses.manage ? Courses.manage() : Courses.open(); } catch (_) {} }));
    menu.appendChild(menuItem('Remove planned blocks in view', clear ? `${plural(clear, 'block')} the planner added` : 'None in view', () => clearAutoPlanned(), { disabled: !clear }));
    document.body.appendChild(menu);
    ui.menu = menu;
    ui.caret.setAttribute('aria-expanded', 'true');
    placeMenu();
    const first = menu.querySelector('.pf-menu-item:not([disabled])');
    if (first) first.focus();
    menu.addEventListener('keydown', menuKeys);
    setTimeout(() => document.addEventListener('pointerdown', outsideMenu, true), 0);
  }
  function placeMenu() {
    if (!ui.menu || !ui.btn) return;
    const r = ui.btn.getBoundingClientRect();
    const w = ui.menu.offsetWidth || 240;
    let left = Math.min(window.innerWidth - w - 8, Math.max(8, r.right - w));
    ui.menu.style.left = left + 'px';
    ui.menu.style.top = (r.bottom + 6) + 'px';
  }
  function menuKeys(e) {
    const items = Array.from(ui.menu.querySelectorAll('.pf-menu-item:not([disabled])'));
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(); if (ui.caret) ui.caret.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); (items[i + 1] || items[0]).focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); (items[i - 1] || items[items.length - 1]).focus(); }
  }
  function outsideMenu(e) { if (ui.menu && !ui.menu.contains(e.target) && !(ui.caret && ui.caret.contains(e.target))) closeMenu(); }
  function closeMenu() {
    if (!ui.menu) return;
    ui.menu.remove();
    ui.menu = null;
    if (ui.caret) ui.caret.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outsideMenu, true);
  }

  // ───────────────────────── the preview bar (v2-ai §7.2) ─────────────────────────
  function stats(p) {
    const inc = p.ghosts.filter((g) => g.included);
    const minutes = inc.reduce((t, g) => t + (g.end - g.start), 0);
    const days = new Set(inc.map((g) => g.day));
    const unfitItems = new Set(p.unfit.map((u) => u.taskID + '|' + (u.part || '')));
    return { n: inc.length, total: p.ghosts.length, minutes, days: days.size, unfit: unfitItems.size };
  }
  function outOfView(p) {
    let r = null;
    try { r = CalendarView.visibleRange(); } catch (_) { return null; }
    const out = Array.from(new Set(p.ghosts.filter((g) => g.included && (g.day < r.from || g.day > r.to)).map((g) => g.day))).sort();
    if (!out.length) return null;
    const a = out[0], b = out[out.length - 1];
    const dl = (d) => `${dowLabel(d)} ${dateOf(d).getDate()}`;   // "Sun 25": plain weekdays read as this week's
    return { day: a, label: a === b ? dl(a) : `${dl(a)}–${dl(b)}` };
  }
  function renderBar() {
    const root = ui.root || (ui.root = CalendarView.previewRoot());
    if (!pv) { root.textContent = ''; ui.bar = null; renderIntro(); return; }
    const p = pv.preview;
    const s = stats(p);
    let text, short;
    if (!s.total) text = short = 'Nothing fits in this range';
    else {
      short = `${plural(s.n, 'block')} · ${fmtDur(s.minutes)}`;
      text = `${short} over ${plural(s.days || 1, 'day')}`;
    }
    const away = outOfView(p);
    const refining = p.status === 'refining';
    const explain = refining ? 'Tailoring this to your courses…'
      : p.failure ? 'Basic plan · the AI couldn’t help this time' : EXPLAIN;
    const bar = h('div', { class: 'pf-plan-bar glass' + (refining ? ' is-refining' : '') + (ui.bar ? '' : ' is-entering'), role: 'region', 'aria-label': 'Plan preview' },
      refining ? h('span', { class: 'pf-plan-shimmer', 'aria-hidden': 'true' }) : null,
      h('div', { class: 'pf-plan-bar-explain' }, icon('sparkles', 'pf-plan-bar-spark'),
        h('span', { class: 'pf-plan-bar-caption', title: p.failure || null, text: explain })),
      h('div', { class: 'pf-plan-bar-row' },
        h('span', { class: 'pf-plan-bar-text' },
          h('span', { class: 'pf-plan-bar-main', 'aria-label': text, title: s.total ? 'Dashed blocks on the calendar are the plan. Click one to leave it out.' : null },
            h('span', { class: 'pf-long', text }), h('span', { class: 'pf-short', text: short }))),
        s.unfit ? h('button', { class: 'pf-chip is-warn', type: 'button', title: 'Some work has no free time before it’s due — see what and why',
          onclick: () => openDetails('unfit') }, icon('warn', 'pf-chip-dot'), `${s.unfit} didn’t fit`) : null,
        away ? h('button', { class: 'pf-chip', type: 'button', title: `Show the planned blocks on ${away.label}`,
          onclick: () => { try { CalendarView.goTo(away.day); } catch (_) {} renderBar(); } }, h('span', { class: 'pf-chip-label', text: `More on ${away.label}` }), icon('chevR', 'pf-chip-chev')) : null,
        h('span', { class: 'pf-plan-bar-flex' }),
        refining
          ? h('button', { class: 'pf-plain', type: 'button', title: 'Stop tailoring and keep the basic plan', onclick: () => useBasic() }, 'Use basic')
          : h('button', { class: 'pf-plain', type: 'button', title: 'See every planned block, take days off, and see what didn’t fit',
            'aria-expanded': ui.details ? 'true' : 'false', onclick: () => (ui.details ? closeDetails() : openDetails()) }, 'Details'),
        h('button', { class: 'pf-plain', type: 'button', title: 'Throw this preview away — nothing was saved (Esc)', onclick: () => discardAsk() }, 'Discard'),
        h('button', { class: 'btn btn-primary pf-keep', type: 'button', disabled: !s.n, title: 'Put these blocks on your calendar — you can Undo (Return)', onclick: () => keep() },
          s.n === s.total ? 'Keep plan' : [h('span', { class: 'pf-long', text: `Keep ${s.n} of ${s.total}` }), h('span', { class: 'pf-short', text: `Keep ${s.n}` })])));
    root.textContent = '';
    root.appendChild(bar);
    if (!reduceMotion()) requestAnimationFrame(() => bar.classList.remove('is-entering'));
    else bar.classList.remove('is-entering');
    ui.bar = bar;
  }

  // ───────────────────────── first-use explainer (H14: one small card, once) ─────────────────────────
  function introWanted() {
    if (store(INTRO_KEY) === '1' || pv || focusing()) return false;
    return true;
  }
  function dismissIntro() {
    if (store(INTRO_KEY) !== '1') store(INTRO_KEY, '1');
    if (ui.intro) { ui.intro.remove(); ui.intro = null; }
  }
  function renderIntro() {
    const root = ui.root;
    if (!root) return;
    if (ui.intro && ui.intro.parentNode === root) { if (!introWanted()) dismissIntroNode(); return; }
    if (!introWanted()) return;
    ui.intro = h('div', { class: 'pf-intro glass', role: 'note', 'aria-label': 'How Plan my week works' },
      icon('sparkles', 'pf-intro-spark'),
      h('div', { class: 'pf-intro-text' },
        h('strong', { class: 'pf-intro-title', text: 'Plan my week' }),
        h('span', { text: 'Fits your tasks and assignments into free time before they’re due. You see dashed blocks first — nothing changes until you press Keep, and Undo takes it back.' }),
        h('span', { class: 'pf-intro-tip', text: 'Taking classes? Add them under Courses so exams and readings get planned too.' })),
      h('div', { class: 'pf-intro-actions' },
        h('button', { class: 'pf-plain', type: 'button', title: 'Hide this card for good', onclick: () => dismissIntro() }, 'Got it'),
        h('button', { class: 'btn btn-primary btn-sm pf-intro-try', type: 'button', onclick: () => { dismissIntro(); runRecommended(); } }, 'Try it')));
    root.appendChild(ui.intro);
  }
  function dismissIntroNode() { if (ui.intro) { ui.intro.remove(); ui.intro = null; } }

  // ───────────────────────── ghosts (drawn into the Calendar grid) ─────────────────────────
  /* W2's grid exposes .cal-col[data-day] (24 h tall) and .cal-mcell[data-day]; each render replaces
     those nodes, so a MutationObserver re-applies the ghosts. A per-node signature keeps it idempotent. */
  let ghostVer = 0;
  function redrawGhosts() { ghostVer++; drawGhosts(); }
  function ghostTip(g) {
    return `${g.title}\n${rangeLabel(g.day, g.start, g.end)}${g.why ? '\n' + g.why : ''}\n${g.included ? 'Click to leave this one out' : 'Left out · click to put it back'}`;
  }
  function wireGhost(el, g) {
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    el.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); toggle(g.key); });
    el.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); toggle(g.key); }
    });
    return el;
  }
  function ghostAttrs(g, cls) {
    return { class: cls + (g.included ? '' : ' is-off'), role: 'checkbox', tabindex: '0', 'aria-checked': String(!!g.included),
      'aria-label': `Planned: ${g.title}, ${rangeLabel(g.day, g.start, g.end)}${g.included ? '' : ', left out'}`,
      title: ghostTip(g), dataset: { ghostKey: g.key }, vars: { '--ev': g.colorHex || 'var(--accent)' } };
  }
  function drawGhosts() {
    const view = document.getElementById('view-calendar');
    if (!view) return;
    const p = pv ? pv.preview : null;
    const sig = p ? ghostVer : -1;
    const grid = view.querySelector('.cal-tg-grid');
    const month = grid ? null : view.querySelector('.cal-month-grid');
    const agenda = grid || month ? null : view.querySelector('.cal-agenda');
    const host = grid || month || agenda;
    const stale = view.querySelectorAll('.pf-ghost, .pf-ag-plan');
    if (host && host.__pfGhostSig === sig && (p || !stale.length)) return;
    if (!host && !stale.length) return;
    const focusKey = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.ghostKey : null;
    stale.forEach((n) => n.remove());
    if (host) host.__pfGhostSig = sig;
    if (!p) return;
    let refocus = null;
    if (grid) {
      const minPx = (parseFloat(grid.style.height) || grid.offsetHeight || 1344) / 1440;
      grid.querySelectorAll('.cal-col[data-day]').forEach((col) => {
        for (const g of p.ghosts) {
          if (g.day !== col.dataset.day) continue;
          const el = wireGhost(h('div', ghostAttrs(g, 'pf-ghost'),
            h('span', { class: 'pf-ghost-title', text: g.title }),
            h('span', { class: 'pf-ghost-time', text: g.included ? rangeLabel(g.day, g.start, g.end) : 'Left out' })), g);
          el.style.top = `${g.start * minPx + 1}px`;
          el.style.height = `${Math.max(16, (g.end - g.start) * minPx - 2)}px`;
          if ((g.end - g.start) * minPx < 34) el.classList.add('is-short');
          col.appendChild(el);
          if (focusKey && g.key === focusKey) refocus = el;
        }
      });
    } else if (month) {
      month.querySelectorAll('.cal-mcell[data-day]').forEach((cell) => {
        const gs = p.ghosts.filter((g) => g.day === cell.dataset.day).sort((x, y) => x.start - y.start);
        for (const g of gs) {
          const el = wireGhost(h('div', ghostAttrs(g, 'pf-ghost pf-ghost-pill'),
            h('span', { class: 'pf-ghost-time', text: timeLabel(g.day, g.start) }), h('span', { class: 'pf-ghost-title', text: g.title })), g);
          cell.appendChild(el);
          if (focusKey && g.key === focusKey) refocus = el;
        }
      });
    } else if (agenda && p.ghosts.length) {
      /* Agenda (one of the two phone views): one "Plan preview" list at the top, by day. */
      const sec = h('section', { class: 'pf-ag-plan', 'aria-label': 'Plan preview' },
        h('div', { class: 'pf-ag-plan-head' },
          h('span', { class: 'pf-ag-plan-title', text: 'Plan preview' }),
          h('span', { class: 'pf-ag-plan-sub', text: 'Not saved yet · tap a block to leave it out' })));
      const days = Array.from(new Set(p.ghosts.map((g) => g.day))).sort();
      for (const day of days) {
        const row = h('div', { class: 'pf-ag-plan-day' },
          h('span', { class: 'pf-ag-plan-date', text: `${dowLabel(day)} ${dateOf(day).getDate()}` }));
        const items = h('div', { class: 'pf-ag-plan-items' });
        for (const g of p.ghosts.filter((x) => x.day === day).sort((x, y) => x.start - y.start)) {
          const el = wireGhost(h('div', ghostAttrs(g, 'pf-ghost pf-ghost-pill pf-ghost-row'),
            h('span', { class: 'pf-ghost-time', text: rangeLabel(g.day, g.start, g.end) }), h('span', { class: 'pf-ghost-title', text: g.title })), g);
          items.appendChild(el);
          if (focusKey && g.key === focusKey) refocus = el;
        }
        row.appendChild(items);
        sec.appendChild(row);
      }
      agenda.insertBefore(sec, agenda.firstChild);
    }
    if (refocus) try { refocus.focus({ preventScroll: true }); } catch (_) {}
  }

  function useBasic() { /* P1: the Coach refine is cancelled and the Basic plan stays (item 7) */
    if (!pv) return;
    try { if (typeof AI !== 'undefined') AI.cancel(); } catch (_) {}
    pv.preview.status = 'ready';
    refresh();
  }
  function discardAsk() {
    if (pv && pv.ctx.toggled && !window.confirm('Discard this plan? Your changes to it will be lost.')) return;
    discard();
  }

  // ───────────────────────── Details popover (v2-ai §7.3) ─────────────────────────
  const REASON = {
    noTimeBeforeDue: (u) => (u.due ? `not enough free time before ${dowLabel(u.due)}` : 'not enough free time'),
    rangeFull: () => 'doesn’t fit this range',
    dueTooSoon: () => 'due today — a quick review by hand',
  };
  function openDetails(focus) {
    if (!pv) return;
    ui.details = h('div', { class: 'pf-details', role: 'dialog', 'aria-label': 'Plan details' });
    document.body.appendChild(ui.details);
    renderDetails();
    placeDetails();
    if (focus === 'unfit') { const u = ui.details.querySelector('.pf-d-unfit'); if (u) u.scrollIntoView({ block: 'nearest' }); }
    ui.details.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeDetails(); } });
    setTimeout(() => document.addEventListener('pointerdown', outsideDetails, true), 0);
    renderBar();
  }
  function outsideDetails(e) {
    if (!ui.details) return;
    if (ui.details.contains(e.target) || (ui.bar && ui.bar.contains(e.target))) return;
    if (e.target.closest && e.target.closest('.cal-ghost, [data-ghost-key], .pf-undo-toast')) return;
    closeDetails();
  }
  function closeDetails() {
    if (!ui.details) return;
    ui.details.remove();
    ui.details = null;
    document.removeEventListener('pointerdown', outsideDetails, true);
    if (pv) renderBar();
  }
  function placeDetails() {
    if (!ui.details) return;
    const narrow = window.innerWidth < 700;
    ui.details.classList.toggle('is-sheet', narrow);
    if (narrow) { ui.details.style.left = ''; ui.details.style.bottom = ''; return; }
    const r = ui.bar ? ui.bar.getBoundingClientRect() : { right: window.innerWidth - 16, top: window.innerHeight - 80 };
    const w = 360;
    ui.details.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)) + 'px';
    ui.details.style.bottom = Math.max(8, window.innerHeight - r.top + 8) + 'px';
    ui.details.style.maxHeight = Math.min(560, Math.max(240, r.top - 24)) + 'px';
  }
  function checkbox(on, label, onChange) {
    return h('button', { class: 'pf-check' + (on ? ' is-on' : ''), type: 'button', role: 'checkbox', 'aria-checked': String(!!on), 'aria-label': label,
      onclick: (e) => { e.stopPropagation(); onChange(); } }, on ? icon('check') : null);
  }
  function renderDetails() {
    const el = ui.details;
    if (!el || !pv) return;
    const p = pv.preview;
    const scroll = el.scrollTop;
    el.textContent = '';
    const [a, b] = p.range;
    el.appendChild(h('div', { class: 'pf-d-head' },
      h('h3', { class: 'pf-d-title', text: a === b ? `Plan for ${F.dowLong.format(dateOf(a))}, ${mdLabel(a)}` : `Plan for ${mdLabel(a)} – ${mdLabel(b)}` }),
      p.source === 'coach' ? h('span', { class: 'pf-d-source', text: Store.settings().coachTier === 'economy' ? 'Coach · Economy' : 'Coach · Best' }) : null,
      h('button', { class: 'pf-d-close', type: 'button', 'aria-label': 'Close details', onclick: () => closeDetails() }, icon('close'))));
    if (p.summary) el.appendChild(h('p', { class: 'pf-d-summary', text: p.summary }));
    // Days off
    const wp = ((Store.calendar() || {}).prefs || {}).weekPlan || [];
    const offs = new Set(wp.filter((x) => x && x.off).map((x) => x.weekday));
    const letters = [];
    for (let wd = 0; wd < 7; wd++) {
      const name = fmt({ weekday: 'long' }).format(new Date(2026, 9, 18 + wd));
      letters.push(h('button', { class: 'pf-dayoff' + (offs.has(wd) ? ' is-off' : ''), type: 'button', 'aria-pressed': String(offs.has(wd)),
        title: offs.has(wd) ? `${name}s are off` : `Take ${name}s off`, 'aria-label': `${name} off`, onclick: () => toggleDayOff(wd) }, name.slice(0, 1)));
    }
    el.appendChild(h('div', { class: 'pf-d-row pf-d-daysoff' }, h('span', { class: 'pf-d-label', text: 'Days off' }), h('span', { class: 'pf-dayoffs' }, letters)));
    // Per day
    const list = h('div', { class: 'pf-d-days' });
    for (const d of p.perDay) {
      const gs = p.ghosts.filter((g) => g.day === d.day).sort((x, y) => x.start - y.start);
      const inc = gs.filter((g) => g.included);
      const planned = inc.reduce((t, g) => t + g.pomodoros, 0);
      const mins = inc.reduce((t, g) => t + (g.end - g.start), 0);
      const head = h('div', { class: 'pf-d-dayhead' },
        h('span', { class: 'pf-d-over', text: `${dowLabel(d.day).toUpperCase()} ${dateOf(d.day).getDate()}` +
          (d.off ? ' · day off' : gs.length ? ` · ${plural(inc.length, 'block')} · ${fmtDur(mins)}` : ' · nothing planned') }),
        d.capacity ? h('span', { class: 'pf-d-load', title: `${planned} of the ${plural(d.capacity, 'focus session')} that fit in this day’s free time are planned` },
          h('span', { class: 'pf-d-loadbar' }, h('span', { class: 'pf-d-loadfill', style: `width:${Math.min(100, Math.round(100 * planned / d.capacity))}%` })),
          h('span', { class: 'pf-d-loadnum', text: `${planned} of ${d.capacity} free slots` })) : null);
      const sec = h('div', { class: 'pf-d-day' }, head);
      for (const g of gs) {
        sec.appendChild(h('div', { class: 'pf-d-block' + (g.included ? '' : ' is-off') },
          checkbox(g.included, `${g.title}, ${timeLabel(g.day, g.start)}`, () => toggle(g.key)),
          h('span', { class: 'pf-d-time', text: rangeLabel(g.day, g.start, g.end) }),
          h('span', { class: 'pf-d-bar', vars: { '--ev': g.colorHex || 'var(--accent)' } }),
          h('span', { class: 'pf-d-main' },
            h('span', { class: 'pf-d-name', text: g.title + (g.included ? ` · ${plural(g.pomodoros, 'pomodoro')}` : '') }),
            g.why ? h('span', { class: 'pf-d-why', title: g.why, text: g.why }) : null)));
      }
      list.appendChild(sec);
    }
    el.appendChild(list);
    // New tasks
    if (p.newTasks.length) {
      const sec = h('div', { class: 'pf-d-sec' }, h('div', { class: 'pf-d-over', text: `NEW TASKS (${p.newTasks.length})` }));
      for (const n of p.newTasks) {
        sec.appendChild(h('div', { class: 'pf-d-block' + (n.included ? '' : ' is-off') },
          checkbox(n.included, n.title, () => setTaskIncluded(n.id, !n.included)),
          h('span', { class: 'pf-d-main' },
            h('span', { class: 'pf-d-name', text: n.title }),
            h('span', { class: 'pf-d-why', text: `${plural(n.estimate, 'pomodoro')}${n.dueDate ? ' · due ' + mdLabel(n.dueDate) : ''}` +
              (n.type === 'assignment' ? ' · added to Today’s Tasks when kept' : '') }))));
      }
      el.appendChild(sec);
    }
    // Didn't fit
    if (p.unfit.length) {
      const sec = h('div', { class: 'pf-d-sec pf-d-unfit' }, h('div', { class: 'pf-d-over', text: `DIDN’T FIT (${p.unfit.length})` }));
      for (const u of p.unfit) {
        const r = (REASON[u.reason] || REASON.rangeFull)(u);
        sec.appendChild(h('div', { class: 'pf-d-unfitrow' },
          h('span', { class: 'pf-d-main' },
            h('span', { class: 'pf-d-name', text: (u.title || 'Task') + (u.part ? ' · ' + u.part : '') }),
            h('span', { class: 'pf-d-why', text: `${plural(u.need, 'pomodoro')} left · ${r}` })),
          u.anywayDay ? h('button', { class: 'btn btn-sm pf-anyway', type: 'button', onclick: () => planAnyway(u) }, `Plan anyway on ${dowLabel(u.anywayDay)}`) : null));
      }
      el.appendChild(sec);
    }
    el.scrollTop = scroll;
  }

  // ───────────────────────── lifecycle ─────────────────────────
  function onViewChange() {
    const vis = calendarVisible();
    if (!pv) { if (vis) updateButton(); return; }
    if (!vis) { if (leftAt == null) leftAt = Date.now(); closeMenu(); closeDetails(); return; }
    if (leftAt != null) {
      const away = Date.now() - leftAt;
      leftAt = null;
      if (away > KEEP_MS) discard();
      else if (away > RECOMPUTE_MS) recompute('Plan refreshed');
    }
    updateButton();
  }
  function tick() {
    if (pv && leftAt != null && Date.now() - leftAt > KEEP_MS) discard();
    if (calendarVisible()) updateButton();
  }
  // A sheet/dialog that is actually on screen (app.html always holds the hidden #task-sheet, role=dialog).
  function openDialog() {
    for (const n of document.querySelectorAll('.sheet, .pf-sheet, [role="dialog"], [role="alertdialog"], [aria-modal="true"]')) {
      if (n.classList.contains('pf-details') || n.closest('.cal-preview-root')) continue;
      if (n.hidden || n.closest('[hidden]') || !n.getClientRects().length) continue;
      if (getComputedStyle(n).visibility === 'hidden') continue;
      return true;
    }
    return false;
  }
  function onKey(e) {
    if (!calendarVisible()) return;
    const tgt = e.target;
    const editing = tgt && (tgt.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName));
    if (editing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'P' && e.shiftKey) { e.preventDefault(); runRecommended(); return; }
    if (!pv) return;
    if (openDialog()) return;
    if (e.key === 'Enter' && !(tgt && tgt.closest && tgt.closest('button, a'))) { e.preventDefault(); keep(); }
    else if (e.key === 'Escape' && !ui.menu && !ui.details) { e.preventDefault(); discardAsk(); }
  }

  function plannerOn() {
    try { return !(typeof Config !== 'undefined' && Config.FEATURES && Config.FEATURES.planner === false); } catch (_) { return true; }
  }

  function init() {
    if (inited) return;
    inited = true;
    try { Rewards.setPlanProvider(planInput); } catch (err) { console.error('Coach: plan provider', err); }
    // "Plan my week" is switched off for now (Config.FEATURES.planner): no button, menu, intro or Shift+P.
    if (!plannerOn()) return;
    try {
      buildButton();
      ui.root = CalendarView.previewRoot();
      CalendarView.onGhostToggle((key) => toggle(key));
    } catch (err) { console.error('Coach: plan button', err); }
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', () => { placeMenu(); placeDetails(); });
    const view = document.getElementById('view-calendar');
    if (view && typeof MutationObserver !== 'undefined') {
      new MutationObserver(onViewChange).observe(view, { attributes: true, attributeFilter: ['hidden'] });
      let rangeSig = '';
      new MutationObserver(() => {
        if (!pv && !view.querySelector('.pf-ghost, .pf-ag-plan')) return;
        drawGhosts();
        // the "More on …" chip depends on what the calendar shows: refresh the bar when the range changes
        let r = null;
        try { r = CalendarView.visibleRange(); } catch (_) {}
        const sig = r ? r.from + r.to + r.view : '';
        if (sig !== rangeSig) { rangeSig = sig; if (pv) renderBar(); }
      }).observe(view, { childList: true, subtree: true });
    }
    renderBar();
    try { Store.on('change', () => { if (calendarVisible()) updateButton(); }); } catch (_) {}
    setInterval(tick, 60000);
  }

  return { init, plannerOn, runRecommended, run, preview, toggle, keep, discard, isPreviewing, recommended, planInput, clearAutoPlanned,
    _setTaskIncluded: setTaskIncluded, _planAnyway: planAnyway, _toggleDayOff: toggleDayOff, _recompute: recompute,
    _test: { leftAt: (t) => { leftAt = t; }, onViewChange, weeklyDotWanted, drawGhosts, introKey: INTRO_KEY, renderBar } };
})();
