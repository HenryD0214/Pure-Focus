/* ═══════════════════════════════════════════════════════════════════════
   insights.js — Reports › Insights v2 (owner: W4; v2-guard §6.2–§6.5, SPEC-V2 §8.4 item 5)

   Every number comes from InsightsCore (the shared, tested reference); this file only
   gathers the inputs, words the results in plain language (USER-HOTFIX-1 H4: each card
   says what it measures) and draws them with Charts.

   const Insights = {
     init()                       Reports.registerTab({id: 'insights', title: 'Insights', order: 2, render})
     render(el, period)           the Insights tab
     topEffectSentence(period)    → string | null  (Overview insight card)
     bestHoursRow(period)         → Node | null    (Overview "Best hours" 1 × 24 heat)
   }
   ═══════════════════════════════════════════════════════════════════════ */

const Insights = (() => {
  'use strict';

  const MORE_KEY = 'purefocus.insights.more';
  const UNLOCK_KEY = 'purefocus.insights.unlocked';
  const LOCKED_OPEN_KEY = 'purefocus.insights.lockedOpen';
  const VISIBLE_BUDGET = 6;
  // 'planVsFocus' (Plan vs reality) and its 'startDelay' chart are left out: the app no longer talks about planning your day.
  // 'kpis' (×1 estimates, real breaks…), 'estimates' and 'byCourse' (a mix of courses, categories and
  // "No task") were noise; Breakdown shows where the time went. The fingerprint and "What works for
  // you" answer the real question: when, where, with what music and on what kind of work you focus best.
  const ORDER = ['fingerprint', 'works', 'bestWindows', 'helps', 'ratingTrend', 'deepWork', 'breaks', 'zone', 'distractions'];
  const NAMES = {
    fingerprint: 'Your focus fingerprint', works: 'What works for you', kpis: 'Key numbers', planVsFocus: 'Plan vs reality', startDelay: 'Start delay',
    bestWindows: 'When you focus best', byCourse: 'What you work on', helps: 'What helps you focus', estimates: 'Estimates',
    zone: 'In the zone', distractions: 'Distractions', breaks: 'Breaks', deepWork: 'Deep work', ratingTrend: 'Focus rating',
  };
  /* H4: one plain sentence per card — what it measures. */
  const WHAT = {
    fingerprint: 'When, where, with what music and on what kind of work your sessions go best — from your ratings over the last 8 weeks.',
    works: 'Your average session rating (1–10) for each time of day, place, music and type of work. Longer bars = sessions you rated higher.',
    kpis: 'The headline numbers for this period. Hover one to see exactly how it’s worked out.',
    planVsFocus: 'Of the focus time you planned on the Calendar, how much you actually did — day by day.',
    startDelay: 'How long after a calendar block’s start time you actually began.',
    bestWindows: 'Darker squares = more focus in that hour. Outlined = the hours your sessions go best (higher ratings, finished more often).',
    byCourse: 'Where your focus time went in this period.',
    helps: 'Compares your session ratings (1–10) with and without each thing. Clear differences are shown first.',
    estimates: 'How many pomodoros finished tasks really took, compared with your estimate. ×1.0 = spot on, ×1.5 = took half again as long.',
    zone: 'The share of each day’s focus time you were active on this page. Only sessions with Focus Guard on.',
    distractions: 'Sites from your distraction list you spent time on during focus.',
    breaks: 'How often you took a real break (3 minutes or more) between two focus sessions on the same day.',
    deepWork: 'Long stretches of focus: 50+ minutes with only short gaps.',
    ratingTrend: 'Your average focus rating (1–10) per day.',
  };

  const FACTOR_LABEL = {
    phoneAway: 'Phone away', slept: 'Slept well', caffeine: 'Caffeine', exercise: 'Exercised', friends: 'With friends',
    'notes.handwritten': 'Handwritten notes', 'notes.typed': 'Typed notes', 'notes.flashcards': 'Flashcards', 'notes.practice': 'Practice problems',
    quiet: 'Quiet space', library: 'At the library', home: 'At home', comfortable: 'Comfortable setup',
    water: 'Water', meal: 'Good meal', breaks: 'Took breaks', plan: 'Clear plan', deadline: 'A deadline',
    studyBuddy: 'Study buddy', morning: 'Morning', evening: 'Evening',
  };
  const FACTOR_PHRASE = {
    phoneAway: 'with your phone away', slept: 'after a good night’s sleep', caffeine: 'with caffeine', exercise: 'on days you exercise',
    friends: 'when you study with friends', 'notes.handwritten': 'when you take handwritten notes', 'notes.typed': 'when you type your notes',
    'notes.flashcards': 'with flashcards', 'notes.practice': 'when you do practice problems',
    quiet: 'in a quiet space', library: 'at the library', home: 'at home', comfortable: 'with a comfortable setup',
    water: 'when you’re hydrated', meal: 'after a good meal', breaks: 'when you take breaks', plan: 'with a clear plan',
    deadline: 'when a deadline is close', studyBuddy: 'when you study with a buddy', morning: 'in the morning', evening: 'in the evening',
  };
  const SOURCE_LABEL = { local: 'Pure Focus', googleTasks: 'Google Tasks', canvas: 'Canvas', blackbaud: 'Blackbaud', ics: 'Calendar file',
    appleReminders: 'Apple Reminders', none: 'No task' };
  const PLAN_SOURCE_LABEL = { coach: 'Coach', basic: 'Plan my week', manual: 'Your own' };

  const IC = () => InsightsCore;
  const safe = (fn, fallback) => { try { return fn(); } catch (err) { console.error('Insights:', err); return fallback; } };

  // ═════════════════════════  small helpers  ═════════════════════════

  function h(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }
  const pct = (x) => Math.round(x * 100) + ' %';
  const one = (x) => (Math.round(x * 10) / 10).toFixed(1).replace(/\.0$/, '');
  function fmtMin(m) {
    m = Math.round(m || 0);
    if (m < 60) return m + ' min';
    const hh = Math.floor(m / 60), mm = m % 60;
    return mm ? `${hh} h ${mm} m` : `${hh} h`;
  }
  function hourText(hh) { const x = ((hh % 24) + 24) % 24; return (x % 12 === 0 ? 12 : x % 12); }
  function ampm(hh) { const x = ((hh % 24) + 24) % 24; return x < 12 ? 'AM' : 'PM'; }
  function hourRange(a, z) {
    return ampm(a) === ampm(z) ? `${hourText(a)}–${hourText(z)} ${ampm(z)}` : `${hourText(a)} ${ampm(a)}–${hourText(z)} ${ampm(z)}`;
  }
  const WEEKDAY_LONG = () => Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 7 + i).toLocaleDateString([], { weekday: 'long' }));
  const WEEKDAY_SHORT = () => Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 7 + i).toLocaleDateString([], { weekday: 'short' }));
  const periodWord = (p) => (p === 'day' ? 'today' : p === 'month' ? 'this month' : 'this week');
  function keyToDate(k) { return new Date(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10)); }
  function weekStart() {
    try {
      const cal = Store.calendar && Store.calendar();
      const p = cal && cal.prefs && cal.prefs.weekStartsOn;
      if (Number.isInteger(p) && p >= 0 && p <= 6) return p;
    } catch (_) {}
    const w = Store.settings().weekStartsOn;
    if (Number.isInteger(w) && w >= 0 && w <= 6) return w;
    return 0;
  }

  /* The selected period: the same windows as Reports (today · last 7 days · last 30 days),
     and the previous window of equal length for deltas. */
  function range(period) {
    const now = Date.now();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const days = period === 'day' ? 1 : period === 'month' ? 30 : 7;
    start.setDate(start.getDate() - (days - 1));
    const prevStart = new Date(start);
    prevStart.setDate(prevStart.getDate() - days);
    return { from: start.getTime(), to: now, prevFrom: prevStart.getTime(), prevTo: start.getTime() - 1, days, now };
  }

  function coursesMap() {
    const out = {};
    for (const c of safe(() => Store.courses(), []) || []) if (c && c.id) out[String(c.id).toLowerCase()] = c.code || c.name;
    return out;
  }
  function localFocusBlocks() {
    return (safe(() => Store.blocks(), []) || []).filter((b) => b && !b.readOnly && (b.source == null || b.source === 'local') &&
      (b.kind === 'focus' || (b.kind == null && b.taskID)) && Number(b.pomodoros) >= 1);
  }
  function dayKey(ms) { const d = new Date(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

  function genreTitle(id) {
    const g = safe(() => (typeof Audio !== 'undefined' && Audio.genres ? Audio.genres() : []), []) || [];
    const hit = Array.isArray(g) ? g.find((x) => x && (x.id === id || x.genre === id)) : null;
    return (hit && (hit.title || hit.name)) || id;
  }
  function ambienceName(id) {
    const a = (Store.AMBIENCES || []).find((x) => x.id === id);
    return a ? a.name : id;
  }
  function sceneName(id) {
    const s = safe(() => (typeof Scenes !== 'undefined' && Scenes.list ? Scenes.list() : []), []) || [];
    const hit = s.find((x) => x.id === id);
    return hit ? hit.title : id;
  }
  const titleCase = (s) => String(s).replace(/\b\w/g, (c) => c.toUpperCase());

  function effectLabel(e) {
    if (e.factor) return FACTOR_LABEL[e.factor] || e.factor;
    const v = e.value;
    switch (e.dim) {
      case 'ambience': return v === 'none' ? 'No background sound' : ambienceName(v) + ' sound';
      case 'music': return v === 'none' ? 'No music' : genreTitle(v) + ' music';
      case 'scene': return 'Background: ' + sceneName(v);
      case 'location': return 'At ' + titleCase(v);
      case 'length': return v === 'upTo25' ? 'Sessions of 25 min or less' : v === '26to45' ? '30–45 min sessions' : 'Longer sessions';
      case 'timeOfDay': return titleCase(v);
      case 'planned': return v === 'planned' ? 'Sessions in a calendar block' : 'Sessions outside a calendar block';
      case 'blocker': return v === 'on' ? 'Site blocker on' : 'Site blocker off';
      default: return String(v);
    }
  }
  function effectPhrase(e) {
    if (e.factor) return FACTOR_PHRASE[e.factor] || ('with ' + (FACTOR_LABEL[e.factor] || e.factor).toLowerCase());
    const v = e.value;
    switch (e.dim) {
      case 'ambience': return v === 'none' ? 'without a background sound' : `with ${ambienceName(v)} ambience`;
      case 'music': return v === 'none' ? 'without music' : `with ${genreTitle(v)}`;
      case 'scene': return `with the ${sceneName(v)} scene`;
      case 'location': return `at ${titleCase(v)}`;
      case 'length': return v === 'upTo25' ? 'in sessions of 25 minutes or less' : v === '26to45' ? 'in 30–45-minute sessions' : 'in longer sessions';
      case 'timeOfDay': return `in the ${v}`;
      case 'planned': return v === 'planned' ? 'when the session was in a calendar block' : 'when it wasn’t in a calendar block';
      case 'blocker': return v === 'on' ? 'with the blocker on' : 'with the blocker off';
      default: return '';
    }
  }

  // ═════════════════════════  compute  ═════════════════════════

  function planStats(blocks, score, ds, from, to, now) {
    const days = new Map();
    const touch = (k) => { if (!days.has(k)) days.set(k, { key: k, plannedMinutes: 0, keptMinutes: 0, focusedMinutes: 0, blocks: 0, done: 0, missed: 0 }); return days.get(k); };
    let finished = 0;
    for (const b of blocks) {
      const st = Date.parse(b.start), en = Date.parse(b.end);
      if (!(st >= from && st <= to) || st > now) continue;
      const d = touch(dayKey(st));
      const r = (score.blocks || {})[b.id] || {};
      const planned = Math.max(0, Number(b.plannedFocusMinutes) || 0);
      d.plannedMinutes += planned;
      d.keptMinutes += Math.min(1, Math.max(0, Number(r.progress) || 0)) * planned;
      d.blocks++;
      if (r.status === 'done') d.done++;
      if (r.status === 'missed') d.missed++;
      if (en <= now) finished++;
    }
    for (const s of ds) if (s.startMs >= from && s.startMs <= to) touch(s.key).focusedMinutes += s.cm / 100;
    return { days, finished };
  }

  function compute(period) {
    const ic = IC();
    const r = range(period);
    const sessions = Store.sessions(), tasks = Store.tasks();
    const courses = coursesMap();
    const blocks = localFocusBlocks();
    const score = safe(() => CalCore.planScore(sessions, blocks, r.now), null) || { blocks: {}, sessionBlock: {} };
    const statuses = {};
    for (const [id, s] of Object.entries(score.blocks || {})) statuses[id] = { matchedSessionIDs: s.matched, progress: s.progress, status: s.status };
    const ds = ic.prepare(sessions);
    const inP = ds.filter((d) => d.startMs >= r.from && d.startMs <= r.to);
    const onPlanIDs = new Set(Object.keys(score.sessionBlock || {}).map((x) => x.toLowerCase()));

    const ps = planStats(blocks, score, ds, r.from, r.to, r.now);
    const plan = ic.planAdherence([...ps.days.values()]);
    const prevPs = planStats(blocks, score, ds, r.prevFrom, r.prevTo, r.now);
    const prevPlan = ic.planAdherence([...prevPs.days.values()]);
    const latency = ic.startLatency(blocks.filter((b) => { const st = Date.parse(b.start); return st >= r.from && st <= r.to; }), statuses, sessions, r.now);
    const head = ic.headStart(tasks, sessions, r.now);
    const lead = ic.planningLead(blocks, r.from, r.to);
    const bySrc = ic.planBySource(blocks, statuses, r.from, r.to, r.now);
    const windows = ic.bestWindows(sessions, r.now);
    const work = ic.byCourse(sessions, tasks, r.from, r.to, courses);
    const factors = ic.factorEffects(sessions, r.now);
    const methods = ic.methodEffects(sessions, r.now, { genreOf: (x) => x, onPlanIDs });
    const est = ic.estimateAccuracy(tasks, sessions, r.from, r.to, courses);
    const drift = ic.driftSummary(sessions, r.from, r.to);
    const prevDrift = ic.driftSummary(sessions, r.prevFrom, r.prevTo);
    const breaks = ic.breakCompliance(sessions, r.from, r.to);
    const prevBreaks = ic.breakCompliance(sessions, r.prevFrom, r.prevTo);
    const deep = ic.deepWork(sessions, r.from, r.to, r.now);
    const top = ic.topEffect(factors.effects.concat(methods));
    const recent = ds.filter((d) => d.startMs >= r.now - 56 * 86400000).length;
    const ratedInP = inP.filter((d) => d.rating != null).length;
    return { period, r, plan, prevPlan, finishedBlocks: ps.finished, planDays: ps.days, latency, head, lead, bySrc, windows, work,
      factors, methods, est, drift, prevDrift, breaks, prevBreaks, deep, top, recent, inP, ratedInP };
  }

  /* Which cards have enough data, and — for the locked row — what it takes to unlock them. */
  function unlockState(c) {
    const helpsRows = c.factors.effects.filter((e) => e.status !== 'needMore').length + c.methods.filter((e) => e.status === 'clear' || e.status === 'hint').length;
    const needs = c.factors.effects.filter((e) => e.status === 'needMore').map((e) => e.need).filter((n) => n > 0);
    const needCheckins = needs.length ? Math.min(...needs) : 0;
    const u = {
      fingerprint: true,
      works: focusPool(c.r.now - 56 * 86400000, c.r.now).some((x) => x.focusRating != null),
      kpis: kpiTiles(c).length > 0,
      planVsFocus: c.finishedBlocks >= 3,
      startDelay: c.latency.n >= 3,
      bestWindows: c.windows.mode !== 'none',
      byCourse: c.work.byCourse.length >= 2 || c.work.bySource.length >= 2,
      helps: helpsRows > 0,
      estimates: c.est.n >= 3,
      zone: c.drift.guarded >= 3,
      distractions: c.drift.guarded >= 1 && c.drift.top.length > 0,
      breaks: c.breaks.pairs >= 3,
      deepWork: !!(c.deep.longestRun && c.deep.longestRun.minutes >= 25),
      ratingTrend: c.ratedInP > 0,
    };
    const hint = {
      works: 'rate a session when it ends',
      kpis: 'focus a few sessions',
      planVsFocus: 'plan 3 focus blocks on the Calendar and do them',
      bestWindows: 'focus at your usual times for about 2 weeks',
      byCourse: 'focus on tasks from 2 different courses or lists',
      helps: needCheckins > 0 ? `rate ${needCheckins} more session${needCheckins === 1 ? '' : 's'} and tap “What helped?”` : 'rate your sessions and tap “What helped?” afterwards',
      estimates: 'finish 3 tasks that had an estimate',
      zone: 'turn on Focus Guard for 3 sessions',
      distractions: 'turn on Focus Guard with the browser extension',
      breaks: 'do 2 sessions in a row with a break between, a few times',
      deepWork: 'focus for 25+ minutes in one stretch',
      ratingTrend: 'rate a session',
    };
    return { u, hint };
  }

  // ═════════════════════════  KPI tiles  ═════════════════════════

  function delta(cur, prev, unit, word) {
    if (cur == null || prev == null) return null;
    const d = cur - prev;
    if (Math.abs(d) < 0.005) return null;
    return { text: `${d > 0 ? '▲' : '▼'} ${unit(Math.abs(d))} vs last ${word}`, better: d > 0 };
  }

  function kpiTiles(c) {
    const tiles = [];
    const word = c.period === 'day' ? 'day' : c.period === 'month' ? 'month' : 'week';
    if (c.latency.n >= 1 && c.latency.median != null) {
      tiles.push({ label: 'Start delay', value: c.latency.median <= 5 ? 'On time' : Math.round(c.latency.median) + ' min',
        caption: 'after a calendar block starts (typical)', tip: 'The middle value of how many minutes after a block’s start time you started focusing.' });
    }
    if (c.est.n >= 1 && c.est.medianRatio != null) {
      tiles.push({ label: 'Estimates', value: '×' + one(c.est.medianRatio), caption: 'of your estimate (×1 = spot on)',
        tip: 'Pomodoros a finished task really took ÷ the pomodoros you estimated (typical task).' });
    }
    if (c.drift.guarded >= 1 && c.drift.totals.focusRatio != null) {
      tiles.push({ label: 'In the zone', value: pct(c.drift.totals.focusRatio), caption: 'of focus time you were active',
        delta: delta(c.drift.totals.focusRatio, c.prevDrift.totals.focusRatio, (x) => Math.round(x * 100) + ' pts', word),
        tip: 'Focus Guard sessions only: the share of focus time that wasn’t idle or on a listed site.' });
    }
    if (c.breaks.pairs >= 1) {
      tiles.push({ label: 'Real breaks', value: `${c.breaks.taken} of ${c.breaks.pairs}`, caption: 'between sessions',
        delta: delta(c.breaks.compliance, c.prevBreaks.compliance, (x) => Math.round(x * 100) + ' pts', word),
        tip: 'Two focus sessions on the same day count as a pair; a gap of 3 minutes or more between them is a real break.' });
    }
    if (c.deep.longestRun && c.deep.longestRun.minutes >= 25) {
      tiles.push({ label: 'Longest stretch', value: fmtMin(c.deep.longestRun.minutes),
        caption: keyToDate(c.deep.longestRun.day).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }),
        tip: 'The most focus minutes in one stretch of back-to-back sessions (gaps of 20 minutes or less).' });
    }
    return tiles.slice(0, 6);
  }

  // ═════════════════════════  card shells  ═════════════════════════

  let tableSeq = 0;
  const TABLE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3" width="11" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M2.5 6.6h11M2.5 9.8h11M6.4 6.6V13" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
  function card(id, title, opts) {
    const o = opts || {};
    const el = h('section', 'glass card ins-card');
    el.dataset.card = id;
    const head = h('div', 'card-header ins-head');
    const tt = h('div', 'ins-titles');
    tt.appendChild(h('h2', 'card-title', title));
    if (WHAT[id]) tt.appendChild(h('p', 'ins-what', WHAT[id]));
    head.appendChild(tt);
    const tail = h('div', 'ins-head-tail');
    head.appendChild(tail);
    el.appendChild(head);
    const body = h('div', 'ins-body');
    el.appendChild(body);
    let tableEl = null;
    if (o.table) {
      const btn = h('button', 'table-toggle');
      btn.type = 'button';
      btn.title = 'Table view';
      btn.setAttribute('aria-label', 'Show ' + title + ' as a table');
      btn.setAttribute('aria-expanded', 'false');
      btn.innerHTML = TABLE_ICON;
      tail.appendChild(btn);
      tableEl = h('div', 'table-view');
      tableEl.id = 'ins-table-' + (++tableSeq);
      tableEl.hidden = true;
      btn.addEventListener('click', () => {
        const open = tableEl.hidden;
        tableEl.hidden = !open;
        btn.setAttribute('aria-expanded', String(open));
        btn.title = open ? 'Hide table' : 'Table view';
        btn.classList.toggle('is-on', open);
      });
      el.appendChild(tableEl);
    }
    return { el, body, tail, tableEl };
  }
  /* Charts need their laid-out width, so cards queue their first draw and render() runs the
     queue once the cards are in the page (a ResizeObserver redraws on later size changes). */
  let pendingDraws = [];
  function queueDraw(box, run) {
    pendingDraws.push(() => { if (box.isConnected) run(); });
    if (typeof Charts.observe === 'function') Charts.observe(box, run);
  }
  function flushDraws() {
    const list = pendingDraws;
    pendingDraws = [];
    list.forEach((f) => safe(f));
  }
  function chartBox(parent, draw) {
    const box = h('div', 'chart-wrap');
    parent.appendChild(box);
    queueDraw(box, () => safe(() => draw(box)));
    return box;
  }

  // ═════════════════════════  cards  ═════════════════════════

  // ═════════════════════════  dimensions: time · place · music · type  ═════════════════════════
  /* Focus sessions grouped four ways. Each group: {key, label, n, minutes, rated, avg, finished}.
     Sessions with nothing set (no location, no type) form their own "not set" group, so the totals
     always add up — but they never win "best". Used by the fingerprint, "What works for you" and
     Reports › Breakdown (Insights.dimensions). */
  const DIMS = [
    { id: 'time', label: 'Time of day', unset: null },
    { id: 'place', label: 'Place', unset: 'No place set' },
    { id: 'music', label: 'Music', unset: 'No music' },
    { id: 'type', label: 'Type of work', unset: 'No type set' },
  ];
  const DAYPARTS = [['Morning', 5, 12], ['Afternoon', 12, 17], ['Evening', 17, 21], ['Night', 21, 29]];
  function daypart(ms) {
    const hr = new Date(ms).getHours(), x = hr < 5 ? hr + 24 : hr;
    const p = DAYPARTS.find(([, a, z]) => x >= a && x < z) || DAYPARTS[3];
    return p[0];
  }
  function daypartRange(name) {
    const p = DAYPARTS.find(([n]) => n === name);
    return p ? hourRange(p[1] % 24, p[2] % 24) : '';
  }
  function sessionPlaces(s) {
    const list = Array.isArray(s.locations) && s.locations.length ? s.locations : (s.location ? [s.location] : []);
    const out = [];
    for (const raw of list) {
      const v = String(raw == null ? '' : raw).trim();
      if (v && !out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
    }
    return out;
  }
  function dimKey(dim, s) {
    if (dim === 'time') return daypart(Date.parse(s.start));
    if (dim === 'place') { const places = sessionPlaces(s); return places.length ? places : null; }
    if (dim === 'music') return s.music ? String(s.music) : null;
    return s.category ? String(s.category) : null;
  }
  function dimLabel(dim, key) {
    if (key == null) return (DIMS.find((d) => d.id === dim) || {}).unset || '—';
    return dim === 'music' ? genreTitle(key) : key;
  }
  // a run counts as finished when it ran its whole length (not cut short with Skip)
  function finishedRun(s) {
    const sched = Number(s.scheduledMinutes);
    return !s.skipped && (!(sched > 0) || Number(s.minutes) >= sched * 0.9);
  }
  function focusPool(fromMs, toMs) {
    const ic = IC();
    return Store.sessions().filter((s) => {
      if (s.mode !== 'focus') return false;
      const t = Date.parse(s.start);
      if (!(t >= fromMs && t <= toMs)) return false;
      return Number(s.minutes) >= 1 && safe(() => ic.derive(s).qualified, true);
    });
  }
  function dimensions(sessions, dim) {
    const m = new Map();
    for (const s of sessions) {
      const raw = dimKey(dim, s);
      const keys = Array.isArray(raw) ? raw : [raw];
      const share = (Number(s.minutes) || 0) / Math.max(1, keys.length);
      for (const key of keys) {
        const g = m.get(key) || { key, label: dimLabel(dim, key), n: 0, minutes: 0, ratings: [], finished: 0 };
        g.n++;
        g.minutes += share;
        if (s.focusRating != null && s.focusRating !== '') g.ratings.push(Number(s.focusRating));
        if (finishedRun(s)) g.finished++;
        m.set(key, g);
      }
    }
    return [...m.values()].map((g) => ({ key: g.key, label: g.label, n: g.n, minutes: g.minutes, rated: g.ratings.length,
      avg: g.ratings.length ? g.ratings.reduce((a, b) => a + b, 0) / g.ratings.length : null, finished: g.finished }))
      .sort((a, b) => (a.key == null) - (b.key == null) || b.minutes - a.minutes);
  }
  /* The best value of one dimension: the highest average rating among values with 2+ rated sessions,
     when there are at least two such values to compare; otherwise where most of your focus went. */
  function bestOf(sessions, dim) {
    const groups = dimensions(sessions, dim);
    const named = groups.filter((g) => g.key != null);
    const unset = groups.find((g) => g.key == null);
    const comparable = named.filter((g) => g.rated >= 2);
    if (comparable.length >= 2) {
      const best = comparable.slice().sort((a, b) => b.avg - a.avg || b.n - a.n)[0];
      const hasKey = (s) => {
        const k = dimKey(dim, s);
        return (Array.isArray(k) ? k : [k]).includes(best.key);
      };
      const others = sessions.filter((s) => !hasKey(s) && s.focusRating != null);
      const otherAvg = others.length ? others.reduce((t, s) => t + Number(s.focusRating), 0) / others.length : null;
      return { kind: 'best', g: best, otherAvg, groups, unset };
    }
    if (named.length) return { kind: 'most', g: named.slice().sort((a, b) => b.minutes - a.minutes)[0], groups, unset };
    return { kind: 'none', groups, unset };
  }

  const FP_HINT = {
    time: 'Focus at a few different times of day and rate the sessions.',
    place: 'Add a location to your tasks (the “＋ Location” chip) — earlier sessions on those tasks count too.',
    music: 'Play music during some sessions (and not others) and rate them.',
    type: 'Give your tasks a type of work (Study, Work…) — earlier sessions on those tasks count too.',
  };
  const FP_ICON = {
    time: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="6.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 6.4V10l2.4 1.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    place: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 17.4s5.4-4.9 5.4-9.2a5.4 5.4 0 1 0-10.8 0c0 4.3 5.4 9.2 5.4 9.2Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="10" cy="8.2" r="2" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    music: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8 14.6V5.2l8-1.6v9.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6" cy="14.8" r="2" fill="currentColor"/><circle cx="14" cy="13" r="2" fill="currentColor"/></svg>',
    type: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.4 10.1V4.6c0-.7.5-1.2 1.2-1.2h5.5l6.5 6.5a1.2 1.2 0 0 1 0 1.7l-4.9 4.9a1.2 1.2 0 0 1-1.7 0Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="7.1" cy="7.1" r="1.3" fill="currentColor"/></svg>',
  };

  function fingerprintSentences(c) {
    const out = [];
    const w = c.windows;
    if (w.mode === 'weekday' && w.windows[0]) {
      const x = w.windows[0];
      out.push(['You focus best on ', WEEKDAY_LONG()[x.weekday] + 's, ' + hourRange(x.startHour, x.endHour), '.']);
    } else if (w.mode === 'daily' && w.windows[0]) {
      const x = w.windows[0];
      out.push(['You focus best around ', hourRange(x.startHour, x.endHour), '.']);
    }
    if (c.top) out.push(['Your sessions rate ', one(c.top.diff) + ' points', ' higher ' + effectPhrase(c.top) + '.']);
    const dw = c.deep;
    if (dw.deepBlocks > 0 && dw.longestRun) out.push([`Your longest deep run ${periodWord(c.period)}: `, fmtMin(dw.longestRun.minutes), '.']);
    else if (c.breaks.compliance != null && c.breaks.compliance >= 0.7 && c.breaks.ratingAfterBreak != null && c.breaks.ratingBackToBack != null &&
      c.breaks.ratingAfterBreak - c.breaks.ratingBackToBack >= 0.3) {
      out.push(['Real breaks help: you rate ', one(c.breaks.ratingAfterBreak - c.breaks.ratingBackToBack) + ' points', ' higher after one.']);
    }
    return out.slice(0, 3);
  }

  /* The fingerprint: four tiles — best time of day, place, music, type of work. Each says what won
     and by how much (or, without enough ratings yet, where most of your focus went), and an empty
     one says exactly what to do to fill it. Then up to two plain sentences (a factor that helps,
     your longest deep run). */
  function renderFingerprint(c) {
    const k = card('fingerprint', NAMES.fingerprint);
    k.el.classList.add('ins-fingerprint');
    const pool = focusPool(c.r.now - 56 * 86400000, c.r.now);
    if (pool.length < 3) {
      k.body.appendChild(h('p', 'ins-fp-line', `Your fingerprint fills in after a few sessions — ${3 - pool.length} to go. Rate each one when it ends.`));
      return k.el;
    }
    const grid = h('div', 'ins-fp-grid');
    for (const d of DIMS) {
      const b = bestOf(pool, d.id);
      const tile = h('div', 'ins-fp-tile' + (b.kind === 'none' ? ' is-empty' : ''));
      const ic = h('span', 'ins-fp-ic');
      ic.innerHTML = FP_ICON[d.id];
      const head = h('div', 'ins-fp-head');
      head.append(ic, h('span', 'ins-fp-k', b.kind === 'most' ? `${d.label} · most focus` : `Best ${d.label.toLowerCase()}`));
      tile.appendChild(head);
      if (b.kind === 'none') {
        tile.appendChild(h('p', 'ins-fp-v ins-fp-muted', 'Not enough yet'));
        tile.appendChild(h('p', 'ins-fp-sub', FP_HINT[d.id]));
      } else {
        const g = b.g;
        const name = d.id === 'time' ? `${g.label} · ${daypartRange(g.key)}` : g.label;
        tile.appendChild(h('p', 'ins-fp-v', name));
        let sub;
        if (b.kind === 'best') {
          sub = `Rated ${one(g.avg)} on average` + (b.otherAvg != null ? ` vs ${one(b.otherAvg)} otherwise` : '') + ` · ${g.n} session${g.n === 1 ? '' : 's'}`;
        } else {
          sub = `${fmtMin(g.minutes)} over ${g.n} session${g.n === 1 ? '' : 's'}` + (g.avg != null ? ` · rated ${one(g.avg)}` : '') + ' — rate more sessions to compare';
        }
        tile.appendChild(h('p', 'ins-fp-sub', sub));
        const unsetShare = b.unset ? b.unset.n / pool.length : 0;
        if (d.id !== 'time' && unsetShare >= 0.4) tile.appendChild(h('p', 'ins-fp-note', `${Math.round(unsetShare * 100)}% of sessions have none set. ${FP_HINT[d.id]}`));
      }
      grid.appendChild(tile);
    }
    k.body.appendChild(grid);
    const extra = fingerprintSentences(c).filter((x) => !/focus best/.test(x[0]));
    for (const [a, bb, z] of extra.slice(0, 2)) {
      const p = h('p', 'ins-fp-line');
      p.append(document.createTextNode(a), h('strong', null, bb), document.createTextNode(z));
      k.body.appendChild(p);
    }
    const rated = pool.filter((s) => s.focusRating != null).length;
    k.body.appendChild(h('p', 'ins-caption', `Based on your last 8 weeks · ${pool.length} sessions · ${rated} rated`));
    return k.el;
  }

  /* What works for you: average rating per time of day / place / music / type of work. */
  let worksDim = 'time';
  function renderWorks(c) {
    const k = card('works', NAMES.works, { table: true });
    const pool = focusPool(c.r.now - 56 * 86400000, c.r.now);
    const seg = h('div', 'segmented ins-seg');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', 'Compare by');
    const box = h('div', 'chart-wrap');
    const cap = h('p', 'ins-caption');
    const draw = () => {
      const groups = dimensions(pool, worksDim).filter((g) => g.rated > 0);
      const data = groups.map((g) => ({
        label: worksDim === 'time' ? g.label : g.label,
        sublabel: `${g.rated} rated`,
        value: g.avg,
        color: g.key == null ? 'var(--text-muted)' : worksDim === 'type' ? safe(() => Store.categoryColor(g.key), 'var(--chart-1)') : 'var(--chart-1)',
      }));
      if (!data.length) { box.textContent = ''; box.appendChild(Charts.emptyNote('Rate your sessions when they end and this fills in.')); }
      else Charts.hbars(box, { data, valueFormat: (v) => one(v), ariaLabel: 'Average session rating by ' + worksDim });
      Charts.table(k.tableEl, [{ label: (DIMS.find((d) => d.id === worksDim) || {}).label || '' }, { label: 'Avg rating' }, { label: 'Rated' }, { label: 'Sessions' }, { label: 'Focus' }, { label: 'Finished' }],
        dimensions(pool, worksDim).map((g) => [g.label, g.avg == null ? '—' : one(g.avg), String(g.rated), String(g.n), fmtMin(g.minutes), `${g.finished}/${g.n}`]));
      const b = bestOf(pool, worksDim);
      const few = groups.some((g) => g.rated < 3);
      cap.textContent = (b.kind === 'best' ? `Your best: ${b.g.label} (${one(b.g.avg)}). ` : '') + (few ? 'Bars with only 1–2 rated sessions are a rough guide.' : '');
    };
    for (const d of DIMS) {
      const b = h('button', 'seg-btn', d.label);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(worksDim === d.id));
      b.classList.toggle('is-active', worksDim === d.id);
      b.addEventListener('click', () => { worksDim = d.id; seg.querySelectorAll('.seg-btn').forEach((x) => { x.setAttribute('aria-checked', String(x === b)); x.classList.toggle('is-active', x === b); }); safe(draw); });
      seg.appendChild(b);
    }
    k.body.append(seg, box, cap);
    queueDraw(box, () => safe(draw));
    return k.el;
  }

  function renderKpis(c) {
    const tiles = kpiTiles(c);
    const k = card('kpis', NAMES.kpis);
    const grid = h('div', 'kpi-row ins-kpis');
    for (const t of tiles) {
      const tile = h('div', 'kpi ins-kpi');
      tile.title = t.tip;
      tile.tabIndex = 0;
      tile.setAttribute('aria-label', `${t.label}: ${t.value}, ${t.caption}. ${t.tip}`);
      tile.appendChild(h('span', 'kpi-label', t.label));
      tile.appendChild(h('span', 'kpi-value', t.value));
      tile.appendChild(h('span', 'kpi-sub', t.caption));
      if (t.delta) tile.appendChild(h('span', 'ins-delta' + (t.delta.better ? ' is-better' : ''), t.delta.text));
      grid.appendChild(tile);
    }
    k.body.appendChild(grid);
    return k.el;
  }

  function renderPlan(c, hidden) {
    const k = card('planVsFocus', NAMES.planVsFocus, { table: true });
    const dayList = [];
    const r = c.r;
    for (let i = 0; i < r.days; i++) {
      const d = new Date(r.from); d.setDate(d.getDate() + i);
      const st = c.planDays.get(dayKey(d.getTime())) || { plannedMinutes: 0, keptMinutes: 0, focusedMinutes: 0 };
      dayList.push({ label: r.days > 7 ? String(d.getDate()) : d.toLocaleDateString([], { weekday: 'short' }),
        tipHeading: d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }),
        planned: st.plannedMinutes, kept: st.keptMinutes, unplanned: Math.max(0, st.focusedMinutes - st.keptMinutes) });
    }
    if (c.period === 'day') {
      const stats = h('div', 'ins-inline-stats');
      for (const [v, l] of [[fmtMin(c.plan.plannedMinutes), 'planned'], [fmtMin(c.plan.keptMinutes), 'kept to plan'], [fmtMin(c.plan.unplannedMinutes), 'unplanned focus']]) {
        const s = h('div', 'ins-stat'); s.append(h('span', 'ins-stat-value', v), h('span', 'ins-stat-label', l)); stats.appendChild(s);
      }
      k.body.appendChild(stats);
    } else {
      chartBox(k.body, (box) => Charts.planColumns(box, { days: dayList }));
    }
    Charts.table(k.tableEl, [{ label: 'Day' }, { label: 'Planned' }, { label: 'Kept to plan' }, { label: 'Unplanned focus' }],
      dayList.map((d) => [d.tipHeading, fmtMin(d.planned), fmtMin(d.kept), fmtMin(d.unplanned)]));
    if (c.lead.n >= 3 && c.lead.medianHours != null) {
      const mh = c.lead.medianHours;
      const ahead = mh < 1 ? 'less than an hour' : mh < 36 ? `about ${Math.round(mh)} h` : `about ${Math.round(mh / 24)} days`;
      k.body.appendChild(h('p', 'ins-caption', `You usually plan ${ahead} ahead · ${pct(c.lead.autoPlannedShare || 0)} placed by Plan my week`));
    }
    const groups = c.bySrc.filter((g) => g.blocks >= 3 && g.keptShare != null);
    if (groups.length >= 2) {
      k.body.appendChild(h('p', 'ins-caption', 'Plans kept: ' + groups.slice().sort((a, b) => b.keptShare - a.keptShare)
        .map((g) => `${PLAN_SOURCE_LABEL[g.key]} ${pct(g.keptShare)}`).join(' · ')));
    }
    if (!hidden.has('startDelay') && c.latency.n >= 3) {
      const sd = h('div', 'ins-sub');
      sd.appendChild(h('p', 'ins-overline', 'Start delay'));
      sd.appendChild(h('p', 'ins-what', WHAT.startDelay));
      const b = c.latency.buckets;
      const box = h('div', 'ins-ob');
      sd.appendChild(box);
      Charts.ordinalBar(box, { ariaLabel: 'When you started your planned blocks', countLabel: (v) => String(v),
        segments: [
          { label: 'On time', value: b.onTime, color: 'var(--ramp-5)' },
          { label: '5–15 min late', value: b.d5_15, color: 'var(--ramp-4)' },
          { label: '15–30 min late', value: b.d15_30, color: 'var(--ramp-3)' },
          { label: 'Over 30 min late', value: b.d30p, color: 'var(--ramp-2)' },
          { label: 'Not started', value: b.notStarted, color: 'var(--fill-inset, rgba(127,127,127,.18))' },
        ] });
      if (c.head.n >= 3 && c.head.medianDays != null) {
        const p = h('p', 'ins-caption');
        const days = c.head.medianDays;
        p.append(document.createTextNode('Head start: you begin assignments '),
          h('strong', null, days <= 0 ? 'on the day they’re due' : `${one(days)} day${days === 1 ? '' : 's'} before they’re due`),
          document.createTextNode(c.head.lastMinuteShare ? ` · ${pct(c.head.lastMinuteShare)} start on the due day.` : '.'));
        sd.appendChild(p);
      }
      k.body.appendChild(sd);
    }
    return k.el;
  }

  function renderBestWindows(c) {
    const k = card('bestWindows', NAMES.bestWindows, { table: true });
    const ws = weekStart();
    const order = Array.from({ length: 7 }, (_, i) => (ws + i) % 7);
    const short = WEEKDAY_SHORT();
    const grid = order.map((wd) => c.windows.grid[wd]);
    const steps = order.map((wd) => c.windows.steps[wd]);
    const marks = c.windows.windows.map((w, i) => (w.weekday == null
      ? { row: 0, rows: 7, from: w.startHour, to: w.endHour, n: i + 1 }
      : { row: order.indexOf(w.weekday), from: w.startHour, to: w.endHour, n: i + 1 }));
    chartBox(k.body, (box) => Charts.heatmap(box, { grid, steps, rowLabels: order.map((wd) => short[wd]), marks,
      ariaLabel: 'Focus minutes by weekday and hour over the last 8 weeks',
      cellLabel: (r, a, z, v) => `${short[order[r]]} ${hourRange(a, z)} · ${fmtMin(v)} over 8 weeks` }));
    if (c.windows.windows.length) {
      const chips = h('div', 'ins-chips');
      c.windows.windows.forEach((w, i) => {
        const chip = h('span', 'ins-chip', `${'①②③'[i]} ${w.weekday == null ? 'Every day' : short[w.weekday]} ${hourRange(w.startHour, w.endHour)}`);
        chip.title = `${Math.round(w.minutes)} min over ${w.sessions} sessions in the last 8 weeks`;
        chips.appendChild(chip);
      });
      k.body.appendChild(chips);
    }
    k.body.appendChild(h('p', 'ins-caption', 'Based on your last 8 weeks'));
    const rows = [];
    order.forEach((wd) => c.windows.grid[wd].forEach((v, hh) => { if (v > 0) rows.push([short[wd], hourRange(hh, hh + 1), fmtMin(v)]); }));
    Charts.table(k.tableEl, [{ label: 'Day' }, { label: 'Hour' }, { label: 'Focus (8 weeks)' }], rows);
    return k.el;
  }

  let workMode = 'course';
  function renderByCourse(c) {
    const k = card('byCourse', NAMES.byCourse, { table: true });
    const seg = h('div', 'segmented ins-seg');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', 'Group by');
    const box = h('div', 'chart-wrap');
    const cap = h('p', 'ins-caption');
    const draw = () => {
      const list = workMode === 'source' ? c.work.bySource : c.work.byCourse;
      const label = (key) => (workMode === 'source' ? SOURCE_LABEL[key] || key : key);
      const top = list.slice(0, 7), rest = list.slice(7);
      const data = top.map((x) => ({ label: label(x.key), value: x.minutes,
        color: workMode === 'source' || x.key === 'No task' || x.key === 'Uncategorised' ? 'var(--chart-1)' : safe(() => Store.categoryColor(x.key), 'var(--chart-1)') }));
      if (rest.length) data.push({ label: 'Other', value: rest.reduce((t, x) => t + x.minutes, 0), color: 'var(--text-muted)' });
      Charts.hbars(box, { data, valueFormat: (v) => fmtMin(v), ariaLabel: 'Focus minutes by ' + workMode });
      Charts.table(k.tableEl, [{ label: workMode === 'source' ? 'From' : 'Course' }, { label: 'Focus' }, { label: 'Sessions' }, { label: 'Avg rating' }],
        list.map((x) => [label(x.key), fmtMin(x.minutes), String(x.sessions), x.avgRating == null ? '—' : x.avgRating.toFixed(1)]));
      const rated = list.filter((x) => x.avgRating != null).slice(0, 3);
      cap.textContent = rated.length ? 'Average rating: ' + rated.map((x) => `${label(x.key)} ${x.avgRating.toFixed(1)}`).join(' · ') : '';
    };
    for (const [id, l] of [['course', 'Course'], ['source', 'Source']]) {
      const b = h('button', 'seg-btn', l);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(workMode === id));
      b.classList.toggle('is-active', workMode === id);
      b.title = id === 'course' ? 'Group by course or category' : 'Group by where the task came from (Canvas, Google Tasks…)';
      b.addEventListener('click', () => { workMode = id; seg.querySelectorAll('.seg-btn').forEach((x) => { x.setAttribute('aria-checked', String(x === b)); x.classList.toggle('is-active', x === b); }); safe(draw); });
      seg.appendChild(b);
    }
    k.body.append(seg, box, cap);
    queueDraw(box, () => safe(draw));
    return k.el;
  }

  let helpsAll = false;
  function renderHelps(c) {
    const k = card('helps', NAMES.helps, { table: true });
    const all = c.factors.effects.map((e) => ({ e, group: 'Outside the app' })).concat(c.methods.map((e) => ({ e, group: 'In the app' })));
    const strong = all.filter((x) => x.e.status === 'clear' || x.e.status === 'hint').slice(0, 6);
    const shown = helpsAll ? all : strong;
    const list = h('div', 'ins-helps');
    list.setAttribute('role', 'list');
    for (const g of ['Outside the app', 'In the app']) {
      const items = shown.filter((x) => x.group === g);
      if (!items.length) continue;
      list.appendChild(h('p', 'ins-overline ins-helps-group', g));
      for (const { e } of items) {
        const row = h('div', 'ins-help-row');
        row.setAttribute('role', 'listitem');
        row.appendChild(h('span', 'ins-help-name', effectLabel(e)));
        row.appendChild(h('span', 'ins-help-cmp', e.status === 'needMore' ? '' : `${e.mean.toFixed(1)} vs ${e.meanOthers.toFixed(1)}`));
        if (e.status === 'needMore') {
          row.appendChild(h('span', 'ins-help-need', `needs ${e.need} more rated session${e.need === 1 ? '' : 's'}`));
          row.title = 'Not enough rated sessions on both sides yet to compare.';
        } else {
          const bar = h('span', 'ins-help-bar');
          Charts.diverging(bar, { value: e.diff || 0, scale: 3, width: 96, ariaLabel: `${e.diff > 0 ? '+' : ''}${one(e.diff || 0)} points` });
          row.appendChild(bar);
          row.appendChild(h('span', 'ins-help-diff', `${e.diff > 0 ? '+' : e.diff < 0 ? '−' : ''}${one(Math.abs(e.diff || 0))}`));
          const glyph = h('span', 'ins-help-conf', e.status === 'clear' ? '●' : e.status === 'hint' ? '◐' : '○');
          glyph.title = e.status === 'clear' ? 'Clear difference' : e.status === 'hint' ? 'Possible difference — more sessions will tell' : 'No real difference';
          row.appendChild(glyph);
          row.title = `Rated ${e.mean.toFixed(1)} on ${e.n} session${e.n === 1 ? '' : 's'} with it vs ${e.meanOthers.toFixed(1)} on ${e.nOthers} without.`;
        }
        list.appendChild(row);
      }
    }
    if (!list.children.length) list.appendChild(h('p', 'ins-caption', 'No clear differences yet. “Show all” lists everything being compared.'));
    k.body.appendChild(list);
    k.body.appendChild(h('p', 'ins-caption', 'Columns: rating with vs without · difference in rating points · ● clear difference, ◐ possible'));
    const foot = h('div', 'ins-foot');
    foot.appendChild(h('span', 'ins-caption', 'Patterns from your own sessions, not proof.'));
    const more = h('button', 'link-btn', helpsAll ? 'Show fewer' : 'Show all');
    more.type = 'button';
    more.addEventListener('click', () => { helpsAll = !helpsAll; rerender(); });
    const set = h('button', 'link-btn', 'Check-in settings');
    set.type = 'button';
    set.title = 'Settings › Focus Guard › “Ask what helped after a session”';
    set.addEventListener('click', () => safe(() => { App.showView('settings'); Settings.open('guard'); }));
    foot.append(more, set);
    k.body.appendChild(foot);
    Charts.table(k.tableEl, [{ label: 'What' }, { label: 'Sessions (with vs without)' }, { label: 'Rating (with vs without)' }, { label: 'Difference' }],
      all.map(({ e }) => [effectLabel(e), `${e.n} vs ${e.nOthers}`, e.mean == null ? '—' : `${e.mean.toFixed(1)} vs ${e.meanOthers.toFixed(1)}`,
        e.status === 'needMore' ? `needs ${e.need} more` : `${e.diff > 0 ? '+' : ''}${one(e.diff)} (${e.status === 'none' ? 'no real difference' : e.status === 'clear' ? 'clear' : 'possible'})`]));
    return k.el;
  }

  function renderEstimates(c) {
    const k = card('estimates', NAMES.estimates, { table: true });
    const rows = c.est.byCourse.filter((x) => x.medianRatio != null).slice(0, 8).map((x) => ({ label: x.key, value: x.medianRatio }));
    chartBox(k.body, (box) => Charts.dotPlot(box, { rows, ariaLabel: 'Real time vs estimate, by course' }));
    const sug = c.est.byCourse.find((x) => x.suggestMultiplier);
    k.body.appendChild(h('p', 'ins-caption', sug ? `${sug.key} tasks take about ${one(sug.suggestMultiplier)}× your estimate.`
      : `${c.est.onTheMoney} of ${c.est.n} finished tasks took exactly what you estimated.`));
    Charts.table(k.tableEl, [{ label: 'Course' }, { label: 'Tasks' }, { label: 'Real ÷ estimate' }],
      c.est.byCourse.map((x) => [x.key, String(x.n), '×' + one(x.medianRatio)]));
    return k.el;
  }

  function renderZone(c) {
    const k = card('zone', NAMES.zone, { table: true });
    const data = c.drift.days.map((d) => ({ label: keyToDate(d.key).toLocaleDateString([], { month: 'short', day: 'numeric' }),
      value: d.focusRatio == null ? null : d.focusRatio * 100, tipLabel: 'in the zone' }));
    chartBox(k.body, (box) => Charts.line(box, { data, color: 'var(--chart-1)', min: 0, max: 100, area: true, height: 160, ticks: [0, 50, 100], tickFormat: (v) => v + '%',
      valueFormat: (v) => Math.round(v) + ' %', ariaLabel: 'Share of focus time in the zone, by day' }));
    const t = c.drift.totals;
    k.body.appendChild(h('p', 'ins-caption', `Idle ${fmtMin(t.idleSec / 60)} · On listed sites ${fmtMin(t.distractSec / 60)} · Away from the page ${fmtMin(t.awaySec / 60)}`));
    Charts.table(k.tableEl, [{ label: 'Day' }, { label: 'In the zone' }], data.map((d) => [d.label, d.value == null ? '—' : Math.round(d.value) + ' %']));
    return k.el;
  }

  function renderDistractions(c) {
    const k = card('distractions', NAMES.distractions);
    const list = h('div', 'ins-dist');
    const max = Math.max(1, ...c.drift.top.map((x) => x.sec));
    for (const x of c.drift.top) {
      const row = h('div', 'ins-dist-row');
      const bar = h('span', 'ins-dist-bar');
      bar.style.width = Math.max(4, Math.round(120 * x.sec / max)) + 'px';
      row.append(h('span', 'ins-dist-name', x.name), bar, h('span', 'ins-dist-min', fmtMin(x.sec / 60)));
      list.appendChild(row);
    }
    k.body.appendChild(list);
    k.body.appendChild(h('p', 'ins-caption', 'Only items on your distraction list are named.'));
    const t = c.drift.totals;
    if (t.nudges) k.body.appendChild(h('p', 'ins-caption', `Check-ins ${t.nudges} · came back within a minute ${t.nudgeReturns}×`));
    return k.el;
  }

  function renderBreaks(c) {
    const k = card('breaks', NAMES.breaks);
    const b = c.breaks;
    const top = h('div', 'ins-meter-row');
    top.append(h('span', 'ins-stat-value', `${b.taken} of ${b.pairs}`), h('span', 'ins-stat-label', 'times you took a real break'));
    k.body.appendChild(top);
    Charts.meter(k.body, { value: b.compliance || 0, label: `Real breaks: ${pct(b.compliance || 0)}` });
    if (b.ratingAfterBreak != null && b.ratingBackToBack != null) {
      k.body.appendChild(h('p', 'ins-caption', `Rated ${b.ratingAfterBreak.toFixed(1)} after a real break vs ${b.ratingBackToBack.toFixed(1)} back-to-back`));
    }
    if (b.overlong > 0) k.body.appendChild(h('p', 'ins-caption', `${b.overlong} break${b.overlong === 1 ? '' : 's'} ran long (more than 1.5× its set length)`));
    return k.el;
  }

  function renderDeep(c) {
    const k = card('deepWork', NAMES.deepWork);
    const d = c.deep;
    const stats = h('div', 'ins-inline-stats');
    const add = (v, l) => { const s = h('div', 'ins-stat'); s.append(h('span', 'ins-stat-value', v), h('span', 'ins-stat-label', l)); stats.appendChild(s); };
    if (d.longestRun) add(fmtMin(d.longestRun.minutes), 'longest stretch · ' + keyToDate(d.longestRun.day).toLocaleDateString([], { weekday: 'short' }));
    add(String(d.deepBlocks), d.deepBlocks === 1 ? 'deep block (50+ min)' : 'deep blocks (50+ min)');
    add(String(d.currentDeepDays), `deep days in a row · best ${d.bestDeepDays}`);
    k.body.appendChild(stats);
    return k.el;
  }

  /* The existing Focus rating card (reports.js keeps drawing it by id); Insights only places it. */
  function ratingCard() {
    const chart = document.getElementById('rating-chart');
    const cardEl = chart && chart.closest('.card');
    if (!cardEl) return null;
    cardEl.hidden = true;                      // shown only where Insights places it
    delete cardEl.dataset.replaced;
    cardEl.dataset.card = 'ratingTrend';
    cardEl.classList.add('ins-card');
    if (!cardEl.querySelector('.ins-what')) {
      const title = cardEl.querySelector('.card-title');
      if (title) {
        const wrap = h('div', 'ins-titles');
        title.replaceWith(wrap);
        wrap.append(title, h('p', 'ins-what', WHAT.ratingTrend));
      }
    }
    return cardEl;
  }

  // ═════════════════════════  Customize  ═════════════════════════

  let custom = null;
  function closeCustomize() {
    if (!custom) return;
    document.removeEventListener('pointerdown', custom.onDoc, true);
    document.removeEventListener('keydown', custom.onKey, true);
    custom.el.remove();
    if (custom.btn) custom.btn.setAttribute('aria-expanded', 'false');
    custom = null;
  }
  function openCustomize(btn) {
    if (custom) { closeCustomize(); return; }
    const el = h('div', 'ins-custom');
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Choose which insights to show');
    el.appendChild(h('p', 'ins-custom-title', 'Show these insights'));
    const hidden = new Set(Store.settings().insightsHidden || []);
    for (const id of ORDER) {
      const row = h('label', 'ins-custom-row');
      const cb = h('input');
      cb.type = 'checkbox';
      cb.checked = !hidden.has(id);
      cb.addEventListener('change', () => {
        const cur = new Set(Store.settings().insightsHidden || []);
        if (cb.checked) cur.delete(id); else cur.add(id);
        Store.setSetting('insightsHidden', ORDER.filter((x) => cur.has(x)));
      });
      row.append(cb, h('span', null, id === 'startDelay' ? 'Start delay (inside Plan vs reality)' : NAMES[id]));
      el.appendChild(row);
    }
    const reset = h('button', 'link-btn', 'Reset to default');
    reset.type = 'button';
    reset.addEventListener('click', () => { el.querySelectorAll('input').forEach((i) => { i.checked = true; }); Store.setSetting('insightsHidden', []); });
    el.appendChild(reset);
    document.body.appendChild(el);
    const r = btn.getBoundingClientRect();
    const w = el.offsetWidth, ht = el.offsetHeight;
    el.style.left = Math.round(Math.max(12, Math.min(window.innerWidth - 12 - w, r.right - w))) + 'px';
    el.style.top = Math.round(r.bottom + 8 + ht > window.innerHeight - 12 ? Math.max(12, r.top - 8 - ht) : r.bottom + 8) + 'px';
    const onDoc = (e) => { if (!el.contains(e.target) && !(custom && custom.btn && custom.btn.contains(e.target))) closeCustomize(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); const b = custom && custom.btn; closeCustomize(); try { if (b) b.focus(); } catch (_) {} } };
    document.addEventListener('pointerdown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
    custom = { el, btn, onDoc, onKey };
    btn.setAttribute('aria-expanded', 'true');
    const first = el.querySelector('input');
    if (first) try { first.focus({ preventScroll: true }); } catch (_) {}
  }

  // ═════════════════════════  the tab  ═════════════════════════

  let lastHost = null, lastPeriod = 'week';
  function rerender() {
    if (!lastHost || !lastHost.isConnected) return;
    const y = window.scrollY;
    render(lastHost, lastPeriod, true);
    window.scrollTo(0, y);
  }

  function render(el, period, keepCustom) {
    if (!el) return;
    lastHost = el;
    lastPeriod = period || 'week';
    el.textContent = '';
    el.classList.add('ins-root');
    el.classList.remove('pf-view-locked');

    // Insights (including the Focus Fingerprint) are Focus Pro. Wait for Plan to load,
    // then show a single lock card — never flash it at a premium user.
    if (typeof PremiumGate !== 'undefined' && PremiumGate.isLocked()) {
      el.dataset.pfTitle = 'Insights are Focus Pro';
      el.dataset.pfDesc = 'See your patterns, ratings and Focus Fingerprint.';
      const pad = document.createElement('div');
      pad.style.minHeight = '260px';
      el.appendChild(pad);
      PremiumGate.lockView(el, { title: 'Insights are Focus Pro', desc: 'See your patterns, ratings and Focus Fingerprint.' });
      return;
    }

    if (!keepCustom) closeCustomize();
    const rating = ratingCard();
    const c = safe(() => compute(lastPeriod), null);
    if (!c) { el.appendChild(h('p', 'muted-note', 'Insights couldn’t be worked out right now.')); return; }
    const { u, hint } = unlockState(c);
    noteUnlocks(u, true);
    safe(() => Dots.set('reports', false));

    const head = h('div', 'ins-intro');
    head.appendChild(h('p', 'ins-intro-text', 'Patterns in how you focus. Each card says what it measures — tap or hover a number for details.'));
    const cz = h('button', 'link-btn ins-customize', 'Customize');
    cz.type = 'button';
    cz.title = 'Choose which insight cards to show';
    cz.setAttribute('aria-haspopup', 'dialog');
    cz.setAttribute('aria-expanded', custom ? 'true' : 'false');
    cz.addEventListener('click', (e) => { e.stopPropagation(); openCustomize(cz); });
    if (custom) custom.btn = cz;
    head.appendChild(cz);
    el.appendChild(head);

    const hidden = new Set(Store.settings().insightsHidden || []);
    const builders = {
      fingerprint: () => renderFingerprint(c), works: () => renderWorks(c), kpis: () => renderKpis(c), planVsFocus: () => renderPlan(c, hidden),
      bestWindows: () => renderBestWindows(c), byCourse: () => renderByCourse(c), helps: () => renderHelps(c),
      estimates: () => renderEstimates(c), zone: () => renderZone(c), distractions: () => renderDistractions(c),
      breaks: () => renderBreaks(c), deepWork: () => renderDeep(c),
      ratingTrend: () => { if (rating) rating.hidden = false; return rating; },
    };
    const ready = ORDER.filter((id) => id !== 'startDelay' && u[id] && !hidden.has(id) && builders[id]);
    const visible = ready.slice(0, VISIBLE_BUDGET), more = ready.slice(VISIBLE_BUDGET);
    pendingDraws = [];
    const col = h('div', 'ins-col');
    for (const id of visible) {
      const n = safe(builders[id], null);
      if (n) col.appendChild(n);
    }
    el.appendChild(col);

    if (more.length) {
      let open = lsGet(MORE_KEY) === '1';
      const btn = h('button', 'ins-more-btn');
      btn.type = 'button';
      btn.setAttribute('aria-expanded', String(open));
      btn.append(h('span', null, `More insights (${more.length})`), h('span', 'ins-chev', '▾'));
      const grid = h('div', 'ins-more-grid');
      grid.hidden = !open;
      const fill = () => { if (!grid.children.length) for (const id of more) { const n = safe(builders[id], null); if (n) grid.appendChild(n); } };
      if (open) fill();
      btn.addEventListener('click', () => {
        open = !open;
        lsSet(MORE_KEY, open ? '1' : '0');
        btn.setAttribute('aria-expanded', String(open));
        grid.hidden = !open;
        if (open) { fill(); flushDraws(); }
      });
      el.append(btn, grid);
    }
    if (rating && !el.contains(rating)) el.appendChild(rating);
    flushDraws();   // parked (hidden) until placed, so reports.js can still draw into it

    const locked = ORDER.filter((id) => id !== 'startDelay' && !u[id] && hint[id] && !hidden.has(id));
    if (locked.length) {
      let open = lsGet(LOCKED_OPEN_KEY) === '1';
      const btn = h('button', 'ins-locked-btn');
      btn.type = 'button';
      btn.setAttribute('aria-expanded', String(open));
      btn.append(h('span', null, `${locked.length} more insight${locked.length === 1 ? '' : 's'} unlock as you focus`), h('span', 'ins-chev', '▸'));
      const ul = h('ul', 'ins-locked-list');
      ul.hidden = !open;
      for (const id of locked) {
        const li = h('li');
        li.append(h('strong', null, NAMES[id]), document.createTextNode(' — ' + hint[id]));
        ul.appendChild(li);
      }
      btn.addEventListener('click', () => { open = !open; lsSet(LOCKED_OPEN_KEY, open ? '1' : '0'); btn.setAttribute('aria-expanded', String(open)); ul.hidden = !open; });
      el.append(btn, ul);
    }
  }

  // ═════════════════════════  unlock dot (E19)  ═════════════════════════

  function noteUnlocks(u, viewing) {
    const now = ORDER.filter((id) => id !== 'startDelay' && id !== 'fingerprint' && u[id]);
    let seen = null;
    try { const raw = lsGet(UNLOCK_KEY); seen = raw ? JSON.parse(raw) : null; } catch (_) { seen = null; }
    if (!Array.isArray(seen)) { lsSet(UNLOCK_KEY, JSON.stringify(now)); return false; }    // first run: remember silently
    const fresh = now.filter((id) => !seen.includes(id));
    if (!fresh.length) return false;
    lsSet(UNLOCK_KEY, JSON.stringify(Array.from(new Set(seen.concat(now)))));
    if (!viewing) safe(() => Dots.set('reports', true));
    return true;
  }
  let unlockTimer = null;
  function checkUnlocks() {
    clearTimeout(unlockTimer);
    unlockTimer = setTimeout(() => safe(() => {
      const rv = document.getElementById('view-reports');
      const viewing = !!(rv && !rv.hidden && rv.offsetParent !== null);   // already on Reports: no dot
      noteUnlocks(unlockState(compute('month')).u, viewing);
    }), 1500);
  }

  // ═════════════════════════  Overview exports  ═════════════════════════

  function topEffectSentence(period) {   // eslint-disable-line no-unused-vars
    return safe(() => {
      const now = Date.now();
      const s = Store.sessions();
      const f = IC().factorEffects(s, now);
      const score = safe(() => CalCore.planScore(s, localFocusBlocks(), now), null) || { sessionBlock: {} };
      const onPlanIDs = new Set(Object.keys(score.sessionBlock || {}).map((x) => x.toLowerCase()));
      const top = IC().topEffect(f.effects.concat(IC().methodEffects(s, now, { genreOf: (x) => x, onPlanIDs })));
      return top ? `You rate sessions ${one(top.diff)} points higher ${effectPhrase(top)}.` : null;
    }, null);
  }

  function hourMinutes(period) {
    const r = range(period || 'week');
    const mins = new Array(24).fill(0);
    for (const d of IC().prepare(Store.sessions())) {
      if (d.startMs < r.from || d.startMs > r.to) continue;
      const total = d.cm / 100, span = d.endMs - d.startMs;
      if (span <= 0) { mins[new Date(d.startMs).getHours()] += total; continue; }
      let t = d.startMs;
      while (t < d.endMs) {
        const hs = new Date(t); hs.setMinutes(0, 0, 0);
        const next = new Date(hs.getTime()); next.setHours(hs.getHours() + 1);
        const end = Math.min(next.getTime(), d.endMs);
        mins[new Date(t).getHours()] += total * (end - t) / span;
        t = end;
      }
    }
    return mins;
  }

  function bestHoursRow(period) {
    return safe(() => {
      const mins = hourMinutes(period);
      if (!mins.some((v) => v > 0)) return null;
      const wrap = h('div', 'ins-besthours');
      const box = h('div', 'ins-besthours-chart');
      wrap.appendChild(box);
      wrap.appendChild(h('p', 'ins-caption', 'Darker = more minutes focused in that hour of the day.'));
      const draw = () => safe(() => Charts.heatmap(box, { grid: [mins], rowLabels: [''], compactBelow: 420, maxCell: 30,
        ariaLabel: 'Focus minutes by hour of the day', cellLabel: (_, a, z, v) => `${hourRange(a, z)} · ${fmtMin(v)}` }));
      if (Charts.observe) Charts.observe(box, draw);
      requestAnimationFrame(() => { if (box.isConnected) draw(); });
      return wrap;
    }, null);
  }

  // ═════════════════════════  init  ═════════════════════════

  let inited = false;
  function init() {
    if (inited) return;
    inited = true;
    if (typeof Reports !== 'undefined' && Reports.registerTab) {
      Reports.registerTab({ id: 'insights', title: 'Insights', order: 2, render: (el, period) => render(el, period) });
    }
    Store.on('change', (kind) => { if (['sessions', 'tasks', 'blocks', 'remote', 'bulk', 'reset'].includes(kind)) checkUnlocks(); });
    Store.on('settings', () => {
      if (lastHost && lastHost.isConnected && !lastHost.closest('[hidden]')) rerender();
    });
    if (typeof Plan !== 'undefined' && Plan.onChange) {
      Plan.onChange(() => { if (lastHost && lastHost.isConnected && !lastHost.closest('[hidden]')) rerender(); });
    }
    checkUnlocks();
  }

  const _debug = { compute, unlockState, kpiTiles, fingerprintSentences, effectLabel, effectPhrase, hourRange, hourMinutes, noteUnlocks };
  return { init, render, topEffectSentence, bestHoursRow, dimensions: (sessions, dim) => dimensions(sessions, dim), dimLabel, finishedRun, _debug };
})();
