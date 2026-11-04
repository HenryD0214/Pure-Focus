/* ═══════════════════════════════════════════════════════════════════════
   v2-guard-insights-reference.js — Pure Focus Focus Guard + Insights v2
   Reference implementation (GUARD_VERSION 1 · INSIGHTS_VERSION 1).

   Pure functions, no DOM, no Store. Runs in jsc after engagement-reference.js:
     TZ=America/Los_Angeles $JSC engagement-reference.js v2-guard-insights-reference.js \
         v2-guard-insights-reference.test.js
   Web: copy verbatim to WEB/js/insights-core.js (global `InsightsCore`).
   Mac: port 1:1 to Core/Insights.swift (`enum Insights`) and Core/FocusGuardMath.swift.
   Normative text: v2-guard.md §3 (guardStep) and §6 (Insights).
   ═══════════════════════════════════════════════════════════════════════ */

const InsightsCore = (() => {
  const E = Engagement;            // engagement-reference.js (C, dayKey, addDays)
  const EC = E.C;

  const C = Object.freeze({
    VERSION: 1,
    // session quality Q (0…1)
    Q_W_RATING: 0.5, Q_W_COMPLETE: 0.3, Q_W_FOCUS: 0.2,
    // best focus windows
    WIN_DAYS: 56, WIN_WIDTH_H: 2, WIN_MIN_MIN: 75, WIN_MIN_SESSIONS: 3, WIN_MIN_WEEKS: 2,
    WIN_SHRINK_MIN: 60, WIN_TOP: 3, WIN_MIN_LIFT: 0.005,
    // start latency
    ON_TIME_MIN: 5, LAT_B1: 15, LAT_B2: 30,
    // head start before due dates
    EARLY_DAYS: 2,
    // estimates
    EST_MIN_N: 3, EST_SUGGEST_DELTA: 0.2,
    // breaks (same gap rule as the engine combo)
    BREAK_MIN_GAP: EC.COMBO_MIN_GAP, BREAK_MAX_GAP: EC.COMBO_MAX_GAP, OVERLONG_FACTOR: 1.5,
    // deep work
    DEEP_GAP_MIN: 20, DEEP_MIN_MIN: 50, DEEP_MIN_RATIO: 0.8,
    // effects (factors + in-app methods)
    EFFECT_DAYS: 90, EFFECT_MIN_EACH: 5, EFFECT_MIN_DIFF: 0.5, T_CLEAR: 2.0, T_HINT: 1.2,
    // guard
    NUDGE_MIN_ELAPSED: 60, NUDGE_MIN_REMAINING: 60, NUDGE_MAX: 2, NUDGE_GAP: 300, RETURN_WINDOW: 60,
    SWITCH_MIN_SEC: 5,  /* platform-side debounce: a web hidden/blur episode counts as a switch once it lasts 5 s */ TOP_N: 3,
  });

  const FACTORS = Object.freeze(['phoneAway', 'slept', 'caffeine', 'exercise', 'friends',
    'notes.handwritten', 'notes.typed', 'notes.flashcards', 'notes.practice',
    'quiet', 'library', 'home', 'comfortable', 'water', 'meal', 'breaks', 'plan', 'deadline', 'studyBuddy', 'morning', 'evening']);

  // ── helpers ──
  const r1 = (x) => Math.round(x * 10) / 10;
  const r2 = (x) => Math.round(x * 100) / 100;
  const r3 = (x) => Math.round(x * 1000) / 1000;
  const r4 = (x) => Math.round(x * 10000) / 10000;
  const toMs = (x) => (typeof x === 'number' ? x : x instanceof Date ? x.getTime() : Date.parse(x));
  const keyOf = (ms) => E.dayKey(new Date(ms));
  function keyToDate(k) { return new Date(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10)); }
  function daysBetween(a, b) { return Math.round((keyToDate(b) - keyToDate(a)) / 86400000); }
  function weekStartKey(k) { return E.addDays(k, -keyToDate(k).getDay()); }
  const lower = (s) => (s == null ? null : String(s).toLowerCase());
  function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
  function median(a) {
    if (!a.length) return null;
    const s = a.slice().sort((x, y) => x - y), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function nearestRank(a, p) {           // p in (0,1]; nearest-rank percentile
    if (!a.length) return null;
    const s = a.slice().sort((x, y) => x - y);
    return s[Math.min(s.length, Math.max(1, Math.ceil(p * s.length))) - 1];
  }
  function variance(a) {                 // sample variance (n − 1)
    if (a.length < 2) return 0;
    const m = mean(a);
    return a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1);
  }

  // ── per-session derivation (identical qualification to the engine) ──
  function derive(s) {
    const startMs = toMs(s.start), endMs = toMs(s.end);
    let sched = Number(s.scheduledMinutes);
    if (!(sched > 0)) sched = EC.DEFAULT_SCHED;
    sched = Math.min(Math.max(sched, 1), EC.SCHED_MAX);
    const rawCm = Math.floor(Math.max(0, Number(s.minutes) || 0) * 100 + 0.5);
    const cm = Math.min(rawCm, Math.floor((sched + EC.CREDIT_SLACK) * 100 + 0.5));
    const thrCm = Math.floor(Math.max(EC.QUALIFY_FLOOR, Math.min(EC.QUALIFY_MIN, EC.QUALIFY_FRACTION * sched)) * 100 + 0.5);
    const qualified = s.mode === 'focus' && cm >= thrCm;
    const completed = qualified && rawCm >= Math.floor(sched * 100 + 0.5) - EC.COMPLETE_TOL_CM;
    const dr = s.drift && typeof s.drift === 'object' ? s.drift : null;
    return {
      id: String(s.id), idLower: String(s.id).toLowerCase(), mode: s.mode,
      startMs, endMs, key: keyOf(startMs), sched, rawCm, cm, qualified, completed,
      minutes: Number(s.minutes) || 0,
      rating: s.focusRating == null || s.focusRating === '' ? null : Number(s.focusRating),
      taskId: lower(s.taskID),
      ambience: s.ambience && s.ambience !== 'none' ? String(s.ambience) : null,
      music: s.music ? String(s.music) : null,
      location: (() => {
        const locs = Array.isArray(s.locations) && s.locations.length ? s.locations : (s.location ? [s.location] : []);
        const first = locs.map((x) => String(x == null ? '' : x).trim()).find(Boolean);
        return first || null;
      })(),
      locations: (() => {
        const locs = Array.isArray(s.locations) && s.locations.length ? s.locations : (s.location ? [s.location] : []);
        const out = [];
        for (const raw of locs) {
          const v = String(raw == null ? '' : raw).trim();
          if (v && !out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
        }
        return out;
      })(),
      sceneID: s.sceneID ? String(s.sceneID) : null,
      factors: Array.isArray(s.factors) ? s.factors.map(String) : null,
      drift: dr,
      focusRatio: dr && Number.isFinite(Number(dr.focusRatio)) ? Number(dr.focusRatio) : null,
      blocker: dr && Array.isArray(dr.signals) ? dr.signals.indexOf('block') >= 0 : null,
    };
  }

  /* Dedupe by lower-cased id (prefer the rated copy), derive, keep qualified focus
     sessions, sort by (start, idLower). `all: true` keeps every mode (breaks too). */
  function prepare(sessions, all) {
    const byId = new Map();
    for (const s of sessions || []) {
      if (!s || s.id == null) continue;
      const k = String(s.id).toLowerCase(), prev = byId.get(k);
      if (!prev || (prev.focusRating == null && s.focusRating != null)) byId.set(k, s);
    }
    const out = [];
    for (const s of byId.values()) {
      const d = derive(s);
      if (!Number.isFinite(d.startMs) || !Number.isFinite(d.endMs)) continue;
      if (all || d.qualified) out.push(d);
    }
    out.sort((a, b) => a.startMs - b.startMs || (a.idLower < b.idLower ? -1 : a.idLower > b.idLower ? 1 : 0));
    return out;
  }

  // ── session quality Q ∈ [0, 1] ──
  function quality(d, meanRating) {
    let w = 0, q = 0;
    const r = d.rating != null ? d.rating : meanRating;
    if (r != null) { w += C.Q_W_RATING; q += C.Q_W_RATING * (Math.min(10, Math.max(1, r)) - 1) / 9; }
    w += C.Q_W_COMPLETE; q += C.Q_W_COMPLETE * (d.completed ? 1 : Math.min(1, d.cm / 100 / d.sched));
    if (d.focusRatio != null) { w += C.Q_W_FOCUS; q += C.Q_W_FOCUS * Math.min(1, Math.max(0, d.focusRatio)); }
    return q / w;
  }

  // ── 1. best focus windows + heatmap ──
  function bestWindows(sessions, nowMs, opts) {
    const o = Object.assign({}, C, opts || {});
    const fromKey = E.addDays(keyOf(nowMs), -(o.WIN_DAYS - 1));
    const ds = prepare(sessions).filter((d) => d.key >= fromKey && d.startMs <= nowMs);
    const rated = ds.filter((d) => d.rating != null).map((d) => d.rating);
    const meanRating = mean(rated);
    const M = [], QM = [], S = [], W = [];
    for (let wd = 0; wd < 7; wd++) { M.push(new Array(24).fill(0)); QM.push(new Array(24).fill(0)); S.push([]); W.push([]);
      for (let h = 0; h < 24; h++) { S[wd].push(new Set()); W[wd].push(new Set()); } }
    let totM = 0, totQM = 0;
    for (const d of ds) {
      const mins = d.cm / 100, q = quality(d, meanRating);
      const span = d.endMs - d.startMs;
      const add = (t, share) => {
        const dt = new Date(t), wd = dt.getDay(), h = dt.getHours();
        M[wd][h] += share; QM[wd][h] += q * share; S[wd][h].add(d.idLower); W[wd][h].add(weekStartKey(keyOf(t)));
        totM += share; totQM += q * share;
      };
      if (span <= 0) { add(d.startMs, mins); continue; }
      let t = d.startMs;
      while (t < d.endMs) {
        const hs = new Date(t); hs.setMinutes(0, 0, 0);
        const next = new Date(hs.getTime()); next.setHours(hs.getHours() + 1);
        const segEnd = Math.min(next.getTime(), d.endMs);
        add(t, mins * (segEnd - t) / span);
        t = segEnd;
      }
    }
    const overall = totM > 0 ? totQM / totM : null;
    const cand = (mode) => {
      const list = [];
      const wds = mode === 'weekday' ? [0, 1, 2, 3, 4, 5, 6] : [null];
      for (const wd of wds) {
        for (let h = 0; h + o.WIN_WIDTH_H <= 24; h++) {
          let m = 0, qm = 0; const ss = new Set(), ww = new Set();
          for (let k = h; k < h + o.WIN_WIDTH_H; k++) {
            for (let x = 0; x < 7; x++) {
              if (wd !== null && x !== wd) continue;
              m += M[x][k]; qm += QM[x][k];
              S[x][k].forEach((v) => ss.add(v)); W[x][k].forEach((v) => ww.add(v));
            }
          }
          if (m < o.WIN_MIN_MIN || ss.size < o.WIN_MIN_SESSIONS || ww.size < o.WIN_MIN_WEEKS) continue;
          const qs = (qm + o.WIN_SHRINK_MIN * overall) / (m + o.WIN_SHRINK_MIN);
          list.push({ weekday: wd, startHour: h, endHour: h + o.WIN_WIDTH_H, minutes: m, sessions: ss.size, quality: qs, lift: qs - overall });
        }
      }
      list.sort((a, b) => b.quality - a.quality || b.minutes - a.minutes ||
        ((a.weekday ?? -1) - (b.weekday ?? -1)) || a.startHour - b.startHour);
      const picked = [];
      for (const c of list) {
        if (c.lift <= o.WIN_MIN_LIFT) continue;
        if (picked.some((p) => p.weekday === c.weekday && c.startHour < p.endHour && p.startHour < c.endHour)) continue;
        picked.push(c);
        if (picked.length >= o.WIN_TOP) break;
      }
      // display span = the occupied hours inside the scoring window (a 9:00–9:50 habit reads "9–10", not "8–10")
      const occupied = (c, h) => [0, 1, 2, 3, 4, 5, 6].some((x) => (c.weekday === null || x === c.weekday) && M[x][h] > 0);
      return picked.map((c) => {
        let a = c.startHour, z = c.endHour;
        while (a < z - 1 && !occupied(c, a)) a++;
        while (z - 1 > a && !occupied(c, z - 1)) z--;
        return { weekday: c.weekday, startHour: a, endHour: z,
          minutes: r1(c.minutes), sessions: c.sessions, quality: r4(c.quality), lift: r4(c.lift) };
      });
    };
    let mode = 'weekday', windows = overall == null ? [] : cand('weekday');
    if (!windows.length && overall != null) { mode = 'daily'; windows = cand('daily'); }
    if (!windows.length) mode = 'none';
    // heatmap steps: 0 = no focus; 1…5 by quintiles (nearest rank) of the non-zero cells → --ramp-1…--ramp-5 (v2-themes T5)
    const nz = [];
    for (let wd = 0; wd < 7; wd++) for (let h = 0; h < 24; h++) if (M[wd][h] > 0) nz.push(M[wd][h]);
    const q = [0.2, 0.4, 0.6, 0.8].map((p) => nearestRank(nz, p));
    const grid = M.map((row) => row.map((v) => r1(v)));
    const steps = M.map((row) => row.map((v) => (v <= 0 ? 0 : 1 + q.filter((x) => v > x).length)));
    return { mode, overall: overall == null ? null : r4(overall), sessions: ds.length, windows, grid, steps };
  }

  // ── 2. start latency (planned start → actual start) ──
  function startLatency(blocks, statuses, sessions, nowMs) {
    const ds = prepare(sessions), byId = new Map(ds.map((d) => [d.idLower, d]));
    const rows = [];
    for (const b of blocks || []) {
      if (b.kind && b.kind !== 'focus') continue;
      if (!(Number(b.pomodoros) >= 1)) continue;
      const bs = toMs(b.start), be = toMs(b.end);
      if (!(be <= nowMs)) continue;                              // finished blocks only (hidden included)
      const st = (statuses || {})[b.id] || {};
      const matched = (st.matchedSessionIDs || []).map((x) => byId.get(String(x).toLowerCase())).filter(Boolean)
        .sort((a, c) => a.startMs - c.startMs);
      let kind = 'notStarted', lat = null;
      if (matched.length) { kind = 'inBlock'; lat = Math.round((matched[0].startMs - bs) / 60000); }
      else if (b.taskID) {
        const tid = lower(b.taskID), k = keyOf(bs);
        const c = ds.find((d) => d.taskId === tid && d.key === k && d.startMs >= bs);
        if (c) { kind = 'later'; lat = Math.round((c.startMs - bs) / 60000); }
      }
      rows.push({ blockID: b.id, kind, latency: lat, delay: lat == null ? null : Math.max(0, lat) });
    }
    const started = rows.filter((r) => r.delay != null).map((r) => r.delay);
    const n = rows.length;
    const b = { onTime: 0, d5_15: 0, d15_30: 0, d30p: 0, notStarted: 0 };
    for (const r of rows) {
      if (r.delay == null) b.notStarted++;
      else if (r.delay <= C.ON_TIME_MIN) b.onTime++;
      else if (r.delay <= C.LAT_B1) b.d5_15++;
      else if (r.delay <= C.LAT_B2) b.d15_30++;
      else b.d30p++;
    }
    return { n, started: started.length, median: started.length ? r1(median(started)) : null,
      p75: nearestRank(started, 0.75), onTimeShare: n ? r3(b.onTime / n) : null, buckets: b, rows };
  }

  // ── 3. head start before due dates (days) ──
  function headStart(tasks, sessions, nowMs) {
    const ds = prepare(sessions), first = new Map();
    for (const d of ds) if (d.taskId && !first.has(d.taskId)) first.set(d.taskId, d);
    const today = keyOf(nowMs), days = []; let notStartedPastDue = 0;
    for (const t of tasks || []) {
      if (!t || !/^\d{4}-\d{2}-\d{2}$/.test(String(t.dueDate || ''))) continue;
      const f = first.get(lower(t.id));
      if (!f) { if (t.dueDate < today && !t.isDone) notStartedPastDue++; continue; }
      days.push(daysBetween(f.key, t.dueDate));
    }
    const n = days.length;
    return { n, medianDays: n ? r1(median(days)) : null,
      earlyShare: n ? r3(days.filter((x) => x >= C.EARLY_DAYS).length / n) : null,
      lastMinuteShare: n ? r3(days.filter((x) => x <= 0).length / n) : null, notStartedPastDue };
  }

  // ── course / source keys ──
  // courses: map lower(course.id) → display (course.code || course.name), from the AI v2 `courses` store.
  // Precedence: AI course record → imported course label (v2-calendar `task.course`) → category → "Uncategorised".
  function courseKey(task, courses) {
    if (task && task.courseID && courses && courses[lower(task.courseID)]) return courses[lower(task.courseID)];
    const imp = task && task.course ? String(task.course).trim() : '';
    if (imp) return imp;
    const c = task && task.category ? String(task.category).trim() : '';
    return c || 'Uncategorised';
  }
  function sourceKey(task) { return (task && task.externalSource) || 'local'; }

  // ── 4. estimate accuracy ──
  function estimateAccuracy(tasks, sessions, fromMs, toMsX, courses) {
    const ds = prepare(sessions), count = new Map(), last = new Map();
    for (const d of ds) if (d.taskId) { count.set(d.taskId, (count.get(d.taskId) || 0) + 1); last.set(d.taskId, d.startMs); }
    const rows = [];
    for (const t of tasks || []) {
      const id = lower(t.id), n = count.get(id) || 0;
      if (!t.isDone || n < 1) continue;
      const at = last.get(id);
      if (at < fromMs || at > toMsX) continue;
      const est = Math.min(12, Math.max(1, Math.round(Number(t.estimate) || 1)));
      rows.push({ taskID: t.id, course: courseKey(t, courses), estimate: est, actual: n, ratio: n / est });
    }
    const groups = new Map();
    for (const r of rows) { if (!groups.has(r.course)) groups.set(r.course, []); groups.get(r.course).push(r.ratio); }
    const byCourse = [...groups.entries()].map(([key, a]) => {
      const m = median(a);
      return { key, n: a.length, medianRatio: r2(m),
        suggestMultiplier: a.length >= C.EST_MIN_N && Math.abs(m - 1) >= C.EST_SUGGEST_DELTA ? r1(m) : null };
    }).sort((x, y) => y.n - x.n || (x.key < y.key ? -1 : 1));
    return { n: rows.length,
      onTheMoney: rows.filter((r) => r.actual === r.estimate).length,
      within1: rows.filter((r) => Math.abs(r.actual - r.estimate) <= 1).length,
      under: rows.filter((r) => r.actual > r.estimate).length,
      over: rows.filter((r) => r.actual < r.estimate).length,
      medianRatio: rows.length ? r2(median(rows.map((r) => r.ratio))) : null, byCourse };
  }

  // ── 5. break compliance ──
  function breakCompliance(sessions, fromMs, toMsX) {
    const all = prepare(sessions, true).filter((d) => d.startMs >= fromMs && d.startMs <= toMsX);
    const q = all.filter((d) => d.qualified);
    let taken = 0, skipped = 0; const after = [], b2b = [];
    for (let i = 1; i < q.length; i++) {
      const a = q[i - 1], c = q[i];
      if (a.key !== c.key) continue;
      const gap = (c.startMs - a.endMs) / 60000;
      if (gap > C.BREAK_MAX_GAP) continue;
      if (gap >= C.BREAK_MIN_GAP) { taken++; if (c.rating != null) after.push(c.rating); }
      else { skipped++; if (c.rating != null) b2b.push(c.rating); }
    }
    const breaks = all.filter((d) => d.mode === 'shortBreak' || d.mode === 'longBreak');
    const overlong = breaks.filter((d) => {
      const sched = Number(d.sched) > 0 ? d.sched : 5;
      return d.minutes > C.OVERLONG_FACTOR * sched;
    }).length;
    const n = taken + skipped;
    const ma = mean(after), mb = mean(b2b);
    return { pairs: n, taken, skipped, compliance: n ? r3(taken / n) : null,
      ratingAfterBreak: ma == null ? null : r2(ma), ratingBackToBack: mb == null ? null : r2(mb),
      breakSessions: breaks.length, overlong };
  }

  // ── 6. deep work ──
  function runsByDay(ds) {
    const out = new Map();
    let cur = null;
    for (const d of ds) {
      if (cur && cur.key === d.key && (d.startMs - cur.endMs) / 60000 <= C.DEEP_GAP_MIN) {
        cur.cm += d.cm; cur.n++; cur.endMs = Math.max(cur.endMs, d.endMs); if (d.focusRatio != null) cur.ratios.push(d.focusRatio);
      } else {
        cur = { key: d.key, startMs: d.startMs, endMs: d.endMs, cm: d.cm, n: 1, ratios: d.focusRatio != null ? [d.focusRatio] : [] };
        if (!out.has(d.key)) out.set(d.key, []);
        out.get(d.key).push(cur);
      }
    }
    for (const list of out.values()) for (const r of list) {
      r.minutes = r.cm / 100; const rm = mean(r.ratios);
      r.deep = r.minutes >= C.DEEP_MIN_MIN && (rm == null || rm >= C.DEEP_MIN_RATIO);
    }
    return out;
  }
  function deepWork(sessions, fromMs, toMsX, nowMs) {
    const ds = prepare(sessions).filter((d) => d.startMs <= nowMs);
    const runs = runsByDay(ds);
    let longest = null, deepBlocks = 0; const deepDays = new Set(), days = [];
    for (const [key, list] of runs) {
      const inP = list.filter((r) => r.startMs >= fromMs && r.startMs <= toMsX);
      if (!inP.length) continue;
      let dayLongest = 0, dayDeep = 0;
      for (const r of inP) {
        if (r.minutes > dayLongest) dayLongest = r.minutes;
        if (r.deep) { dayDeep++; deepBlocks++; deepDays.add(key); }
        if (!longest || r.minutes > longest.minutes) longest = { minutes: r2(r.minutes), day: key, sessions: r.n };
      }
      days.push({ key, longestRun: r2(dayLongest), deepBlocks: dayDeep });
    }
    days.sort((a, b) => (a.key < b.key ? -1 : 1));
    // deep days in a row (all history; today is pending and never breaks the run)
    const allDeep = new Set();
    for (const [key, list] of runs) if (list.some((r) => r.deep)) allDeep.add(key);
    const today = keyOf(nowMs);
    let current = 0, k = allDeep.has(today) ? today : E.addDays(today, -1);
    while (allDeep.has(k)) { current++; k = E.addDays(k, -1); }
    let best = 0, run = 0, prev = null;
    for (const key of [...allDeep].sort()) {
      run = prev && E.addDays(prev, 1) === key ? run + 1 : 1; prev = key; if (run > best) best = run;
    }
    return { longestRun: longest, deepBlocks, deepDays: deepDays.size, currentDeepDays: current, bestDeepDays: best, days };
  }

  // ── 7. drift summary (Focus Guard records) ──
  function driftSummary(sessions, fromMs, toMsX) {
    const ds = prepare(sessions).filter((d) => d.startMs >= fromMs && d.startMs <= toMsX);
    const g = ds.filter((d) => d.drift);
    const keys = ['activeSec', 'idleSec', 'distractSec', 'awaySec', 'switchCount', 'nudges', 'nudgeReturns', 'autoPaused', 'blockedHits', 'escapes'];
    const tot = {}; keys.forEach((k) => (tot[k] = 0));
    const perDay = new Map(), top = new Map();
    for (const d of g) {
      if (!perDay.has(d.key)) { const o = { key: d.key }; keys.forEach((k) => (o[k] = 0)); perDay.set(d.key, o); }
      const day = perDay.get(d.key);
      for (const k of keys) { const v = Math.max(0, Number(d.drift[k]) || 0); tot[k] += v; day[k] += v; }
      for (const t of d.drift.top || []) {
        const cur = top.get(t.key) || { key: t.key, name: t.name || t.key, sec: 0 };
        cur.sec += Math.max(0, Number(t.sec) || 0); top.set(t.key, cur);
      }
    }
    const ratio = (o) => (o.activeSec > 0 ? r3(Math.max(0, 1 - (o.idleSec + o.distractSec) / o.activeSec)) : null);
    const days = [...perDay.values()].sort((a, b) => (a.key < b.key ? -1 : 1)).map((o) => Object.assign(o, { focusRatio: ratio(o) }));
    return { sessions: ds.length, guarded: g.length, coverage: ds.length ? r3(g.length / ds.length) : null,
      totals: Object.assign(tot, { focusRatio: ratio(tot) }), days,
      top: [...top.values()].sort((a, b) => b.sec - a.sec || (a.key < b.key ? -1 : 1)).slice(0, 5) };
  }

  // ── 8. effects: one comparison rule for focus factors and in-app methods ──
  function compareRatings(a, b) {
    const na = a.length, nb = b.length;
    if (na < C.EFFECT_MIN_EACH || nb < C.EFFECT_MIN_EACH) {
      return { n: na, nOthers: nb, status: 'needMore', need: Math.max(0, C.EFFECT_MIN_EACH - na) + Math.max(0, C.EFFECT_MIN_EACH - nb) };
    }
    const ma = mean(a), mb = mean(b), diff = ma - mb;
    const se = Math.sqrt(variance(a) / na + variance(b) / nb);
    const t = se > 0 ? diff / se : diff === 0 ? 0 : (diff > 0 ? 99 : -99);
    const ad = Math.abs(diff), at = Math.abs(t);
    const status = ad >= C.EFFECT_MIN_DIFF && at >= C.T_CLEAR ? 'clear' : ad >= C.EFFECT_MIN_DIFF && at >= C.T_HINT ? 'hint' : 'none';
    return { n: na, nOthers: nb, status, mean: r2(ma), meanOthers: r2(mb), diff: r2(diff), t: r2(t) };
  }
  const RANK = { clear: 0, hint: 1, none: 2, needMore: 3 };
  function sortEffects(list) {
    return list.sort((x, y) => RANK[x.status] - RANK[y.status] || Math.abs(y.diff || 0) - Math.abs(x.diff || 0) || x.order - y.order)
      .map((x) => { delete x.order; return x; });
  }
  function effectBase(sessions, nowMs) {
    const fromKey = E.addDays(keyOf(nowMs), -(C.EFFECT_DAYS - 1));
    return prepare(sessions).filter((d) => d.key >= fromKey && d.startMs <= nowMs && d.rating != null);
  }
  function factorEffects(sessions, nowMs) {
    const base = effectBase(sessions, nowMs).filter((d) => d.factors !== null);
    const out = FACTORS.map((f, i) => {
      const a = [], b = [];
      for (const d of base) (d.factors.indexOf(f) >= 0 ? a : b).push(d.rating);
      return Object.assign({ factor: f, order: i }, compareRatings(a, b));
    });
    return { checkIns: base.length, effects: sortEffects(out) };
  }
  function lengthBucket(sched) { return sched <= 25 ? 'upTo25' : sched <= 45 ? '26to45' : 'over45'; }
  function timeOfDay(ms) { const h = new Date(ms).getHours(); return h >= 5 && h < 12 ? 'morning' : h < 17 && h >= 12 ? 'afternoon' : h >= 17 && h < 21 ? 'evening' : 'night'; }
  const DIMENSIONS = ['ambience', 'music', 'scene', 'location', 'length', 'timeOfDay', 'planned', 'blocker'];
  function methodEffects(sessions, nowMs, ctx) {
    const c = ctx || {};
    const base = effectBase(sessions, nowMs);
    const val = {
      ambience: (d) => d.ambience || 'none',
      music: (d) => (d.music ? (c.genreOf ? c.genreOf(d.music) : d.music) : 'none'),
      scene: (d) => d.sceneID,                                   // null when the session has no sceneID
      location: (d) => (Array.isArray(d.locations) && d.locations.length
        ? d.locations.map((x) => String(x).trim().toLowerCase()).filter(Boolean)
        : (d.location ? [d.location.toLowerCase()] : null)),
      length: (d) => lengthBucket(d.sched),
      timeOfDay: (d) => timeOfDay(d.startMs),
      planned: (d) => (c.onPlanIDs ? (c.onPlanIDs.has(d.idLower) ? 'planned' : 'unplanned') : null),
      blocker: (d) => (d.blocker === null ? null : d.blocker ? 'on' : 'off'),
    };
    const out = []; let order = 0;
    for (const dim of DIMENSIONS) {
      const groups = new Map();
      for (const d of base) {
        const raw = val[dim](d);
        const values = Array.isArray(raw) ? raw : [raw];
        for (const v of values) {
          if (v == null) continue;
          if (!groups.has(v)) groups.set(v, []);
          groups.get(v).push(d.rating);
        }
      }
      if (groups.size < 2) continue;
      for (const v of [...groups.keys()].sort()) {
        const a = groups.get(v), b = [];
        for (const [k, arr] of groups) if (k !== v) b.push(...arr);
        out.push(Object.assign({ dim, value: v, order: order++ }, compareRatings(a, b)));
      }
    }
    return sortEffects(out);
  }

  // ── 9. plan adherence (input = DayPlanStats per day, §1.2.5) ──
  function planAdherence(days) {
    let planned = 0, focused = 0, kept = 0, blocks = 0, done = 0, missed = 0;
    for (const d of days || []) {
      planned += d.plannedMinutes || 0; focused += d.focusedMinutes || 0; kept += d.keptMinutes || 0;
      blocks += d.blocks || 0; done += d.done || 0; missed += d.missed || 0;
    }
    return { plannedMinutes: planned, focusedMinutes: focused, keptMinutes: kept,
      unplannedMinutes: Math.max(0, focused - kept), adherence: planned > 0 ? r3(Math.min(1, kept / planned)) : null,
      blocks, done, missed };
  }

  // ── 9b. planning lead (how far ahead blocks are planned) ──
  function planningLead(blocks, fromMs, toMsX) {
    const leads = []; let sameDay = 0, auto = 0;
    for (const b of blocks || []) {
      if ((b.kind && b.kind !== 'focus') || !(Number(b.pomodoros) >= 1) || b.source && b.source !== 'local') continue;
      const st = toMs(b.start), pa = toMs(b.plannedAt);
      if (!(st >= fromMs && st <= toMsX) || !Number.isFinite(pa)) continue;
      leads.push(Math.max(0, (st - pa) / 3600000));
      if (keyOf(pa) === keyOf(st)) sameDay++;
      if (b.autoPlanned) auto++;
    }
    const n = leads.length;
    return { n, medianHours: n ? r1(median(leads)) : null, sameDayShare: n ? r3(sameDay / n) : null,
      autoPlannedShare: n ? r3(auto / n) : null };
  }

  // ── 9c. plan kept by plan source (manual vs Auto-plan vs AI coach; v2-ai `planSource`) ──
  // Finished local focus blocks (end ≤ now) that start inside [fromMs, toMsX]. Hidden blocks count (SPEC §1.4.4).
  // kept = progress × plannedFocusMinutes, progress from planScore (design-calendar §7.4).
  const PLAN_SOURCES = ['coach', 'basic', 'manual'];
  function planBySource(blocks, statuses, fromMs, toMsX, nowMs) {
    const g = new Map();
    for (const b of blocks || []) {
      if ((b.kind && b.kind !== 'focus') || !(Number(b.pomodoros) >= 1) || (b.source && b.source !== 'local')) continue;
      const st = toMs(b.start), en = toMs(b.end);
      if (!(st >= fromMs && st <= toMsX) || !(en <= nowMs)) continue;
      const key = b.autoPlanned ? (b.planSource === 'coach' ? 'coach' : 'basic') : 'manual';
      const planned = Math.max(0, Number(b.plannedFocusMinutes) || 0);
      const s = (statuses || {})[b.id] || {};
      const prog = Math.min(1, Math.max(0, Number(s.progress) || 0));
      const o = g.get(key) || { key, blocks: 0, done: 0, plannedMinutes: 0, keptMinutes: 0 };
      o.blocks++; o.plannedMinutes += planned; o.keptMinutes += prog * planned;
      if (s.kind === 'done' || s.status === 'done') o.done++;
      g.set(key, o);
    }
    return PLAN_SOURCES.filter((k) => g.has(k)).map((k) => {
      const o = g.get(k);
      return { key: k, blocks: o.blocks, plannedMinutes: Math.round(o.plannedMinutes), keptMinutes: r1(o.keptMinutes),
        keptShare: o.plannedMinutes > 0 ? r3(o.keptMinutes / o.plannedMinutes) : null, doneShare: r3(o.done / o.blocks) };
    });
  }

  // ── 9d. the one sentence (Overview insight card + fingerprint line 2): strongest CLEAR, POSITIVE effect ──
  // effects = factorEffects(...).effects concatenated with methodEffects(...). Ties keep input order (factors first).
  function topEffect(effects) {
    let best = null;
    for (const e of effects || []) {
      if (!e || e.status !== 'clear' || !(e.diff > 0)) continue;
      if (!best || e.diff > best.diff) best = e;
    }
    return best;
  }

  // ── 10. by course / by source ──
  function byCourse(sessions, tasks, fromMs, toMsX, courses) {
    const tmap = new Map((tasks || []).map((t) => [lower(t.id), t]));
    const ds = prepare(sessions).filter((d) => d.startMs >= fromMs && d.startMs <= toMsX);
    const agg = (keyFn) => {
      const m = new Map();
      for (const d of ds) {
        const t = d.taskId ? tmap.get(d.taskId) : null;
        const k = keyFn(t);
        const o = m.get(k) || { key: k, minutes: 0, sessions: 0, ratings: [] };
        o.minutes += d.cm / 100; o.sessions++; if (d.rating != null) o.ratings.push(d.rating); m.set(k, o);
      }
      return [...m.values()].map((o) => ({ key: o.key, minutes: r1(o.minutes), sessions: o.sessions,
        avgRating: o.ratings.length ? r2(mean(o.ratings)) : null }))
        .sort((a, b) => b.minutes - a.minutes || (a.key < b.key ? -1 : 1));
    };
    return { byCourse: agg((t) => (t ? courseKey(t, courses) : 'No task')), bySource: agg((t) => (t ? sourceKey(t) : 'none')) };
  }

  /* ═══ FOCUS GUARD: the per-second drift reducer (shared by Mac and web) ═══
     sample = { t: seconds since the session started (activeElapsed), dt: seconds since the last sample (1 normally),
                remaining: seconds left, idleSec: seconds since last input or null (unknown), locked: bool,
                distractKey: key of the guard-list item in front or null, distractName,
                away: bool (web only: page hidden/blurred, destination unknown), switched: bool (a front change happened) }
     s = settings subset { guardIdleSeconds, guardNudge, guardNudgeAfter, guardAutoPause, guardAutoPauseAfter } */
  function guardInit(signals) {
    return { v: 1, signals: (signals || []).slice().sort(), activeSec: 0, idleSec: 0, distractSec: 0, awaySec: 0,
      switchCount: 0, distractCount: 0, nudges: 0, nudgeReturns: 0, autoPaused: 0, blockedHits: 0, escapes: 0,
      offline: false, topMap: {}, names: {}, run: { kind: 'on', sec: 0 }, lastNudgeAt: null, pendingReturnAt: null,
      snoozeUntil: null };
  }
  function classify(acc, x, s) {
    if (x.locked && !acc.offline) return 'idle';
    if (x.distractKey) return 'distract';
    if (x.idleSec != null && x.idleSec >= s.guardIdleSeconds && !acc.offline) return 'idle';
    if (x.away) return 'away';
    return 'on';
  }
  function guardStep(acc, x, s) {
    const dt = Math.max(0, Math.min(5, Number(x.dt) || 1));      // >5 s gaps (sleep) are not classified
    const actions = [];
    if (dt === 0) return { acc, actions, kind: acc.run.kind };
    const kind = classify(acc, x, s);
    acc.activeSec += dt;
    if (kind === 'idle') acc.idleSec += dt;
    else if (kind === 'distract') { acc.distractSec += dt; acc.topMap[x.distractKey] = (acc.topMap[x.distractKey] || 0) + dt; if (x.distractName) acc.names[x.distractKey] = x.distractName; }
    else if (kind === 'away') acc.awaySec += dt;
    if (x.switched) acc.switchCount++;
    const prevRun = acc.run;
    if (prevRun.kind === kind) acc.run = { kind, sec: prevRun.sec + dt };
    else { acc.run = { kind, sec: dt }; if (kind === 'distract') acc.distractCount++; }
    // a nudge "worked" if the person is back on task within RETURN_WINDOW seconds
    if (acc.pendingReturnAt != null) {
      if (kind === 'on' && x.t - acc.pendingReturnAt <= C.RETURN_WINDOW) { acc.nudgeReturns++; acc.pendingReturnAt = null; }
      else if (x.t - acc.pendingReturnAt > C.RETURN_WINDOW) acc.pendingReturnAt = null;
    }
    const crossed = (thr) => acc.run.sec >= thr && acc.run.sec - dt < thr;
    const snoozed = acc.snoozeUntil != null && x.t < acc.snoozeUntil;
    const eligible = s.guardNudge && !snoozed && x.t >= C.NUDGE_MIN_ELAPSED && x.remaining >= C.NUDGE_MIN_REMAINING &&
      acc.nudges < C.NUDGE_MAX && (acc.lastNudgeAt == null || x.t - acc.lastNudgeAt >= C.NUDGE_GAP);
    if ((kind === 'distract' || kind === 'idle') && eligible && crossed(s.guardNudgeAfter)) {
      acc.nudges++; acc.lastNudgeAt = x.t; acc.pendingReturnAt = x.t; actions.push('nudge:' + kind);
    }
    if (kind === 'idle' && s.guardAutoPause && crossed(s.guardAutoPauseAfter)) {
      const rewind = Math.min(acc.activeSec, acc.run.sec + s.guardIdleSeconds);
      acc.activeSec -= rewind; acc.idleSec = Math.max(0, acc.idleSec - acc.run.sec); acc.autoPaused++;
      acc.run = { kind: 'on', sec: 0 };
      actions.push('autoPause:' + rewind);
    }
    return { acc, actions, kind };
  }
  /* User responses to a nudge card: 'back' | 'offline' (On paper) | 'snooze' (Need 5 min) | 'pause' */
  function guardRespond(acc, response, t) {
    if (response === 'offline') acc.offline = true;
    if (response === 'snooze') acc.snoozeUntil = t + 300;      // escapes count only block-page passes
    acc.run = { kind: acc.run.kind, sec: 0 };
    return acc;
  }
  function guardSnapshot(acc) {
    const top = Object.keys(acc.topMap).map((k) => ({ key: k, name: acc.names[k] || k, sec: Math.round(acc.topMap[k]) }))
      .sort((a, b) => b.sec - a.sec || (a.key < b.key ? -1 : 1)).slice(0, C.TOP_N);
    const R = (x) => Math.round(x);
    const active = R(acc.activeSec);
    return { v: 1, signals: acc.signals, activeSec: active, idleSec: R(acc.idleSec), distractSec: R(acc.distractSec),
      awaySec: R(acc.awaySec), switchCount: acc.switchCount, distractCount: acc.distractCount, nudges: acc.nudges,
      nudgeReturns: acc.nudgeReturns, autoPaused: acc.autoPaused, blockedHits: acc.blockedHits, escapes: acc.escapes,
      offline: acc.offline, top,
      focusRatio: r3(Math.max(0, 1 - (R(acc.idleSec) + R(acc.distractSec)) / Math.max(1, active))) };
  }

  return { C, FACTORS, DIMENSIONS, derive, prepare, quality, bestWindows, startLatency, headStart, estimateAccuracy,
    breakCompliance, deepWork, driftSummary, compareRatings, factorEffects, methodEffects, planAdherence, planningLead,
    planBySource, topEffect, byCourse,
    courseKey, sourceKey, guardInit, guardStep, guardRespond, guardSnapshot };
})();
