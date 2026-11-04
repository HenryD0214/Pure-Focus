/* ═══════════════════════════════════════════════════════════════════════
   calendar-core.js — CAL v1 + planRange (PLAN_VERSION 2), pure: no DOM, no Store (owner: W3)

   A port of calref.py (CAL_VERSION 1, SPEC §1.4) and planref.py › plan_range
   (v2-ai §5.3). Integer maths only; every tie is broken explicitly so the
   results are identical to the references (calendar-vectors.json,
   v2-planner-vectors.json; jsc: TOOLS/tests/w3-calcore.test.js and
   w3-planner.test.js). All times are LOCAL wall-clock minutes from the day's
   midnight unless stated; day keys are local 'YYYY-MM-DD' strings.

   const CalCore = {
     C, KIND_RULES, ready: true,
     focusSpan(n, s) · blockMinutes(n, s) · capacity(m, s)   s = {focus, short, long, interval}
     ceilTo(x, q) · floorTo(x, q)
     layoutDay(items) → {id: {top, height, col, cols, span}}
     layoutAllDay(items, ndays, maxLanes = 2) → {placements, laneCount, overflowCollapsed}
     autoPlan(input) → {windows, blocks, unfit, budgetPomodorosLeft, reason?}
     derivePlanSessions(sessions) → [PlanSession {id, start, end, taskID, qualified, cm, fat}]
     planScore(sessions, blocks, now) → {blocks, onPlanXP, planXPByDay, planXPTotal, sessionBlock}
     unscheduled(tasks, blocks, now) → [{taskID, remaining, covered, unscheduled}]
     upNext({blocks, statuses, events, now, plan}) → UpNextState
     categoryColor(name, scheme) → '#rrggbb' | null
     normalizeColor(hex) → '#RRGGBB' | null
     planRange(input) → {version: 2, blocks, unfit, perDay, warnings, reason?}   (v2-ai §5.1)
     dayKey(date) · addDays(dayKey, n) · daysBetween(a, b) · weekday(dayKey) · fnv1a32(s)   helpers
   }
   ═══════════════════════════════════════════════════════════════════════ */

const CalCore = (() => {
  'use strict';
  const C = Object.freeze({
    CAL_VERSION: 1, PLAN_VERSION: 2, HORIZON_MAX_DAYS: 14, PROBE_NEED: 999, MAX_PARTS: 6,
    SNAP: 15, MIN_BLOCK: 15, MIN_VISUAL: 20, AUTO_LEAD: 5, PLAN_LEAD: 5, MATCH_PAD: 10, MATCH_FRAC: 0.5, DONE_FRAC: 0.8,
    ON_PLAN_XP: 30, BLOCK_DONE_XP: 60, PLAN_DAY_CAP: 300,
  });

  // unit: pomodoros per allocation step · maxPerDay: per item per day · spaced: prefer separate days ·
  // hardBefore: days before the due day that are the last allowed day · buffer: finish-early days
  const KIND_RULES = Object.freeze({
    exam:       Object.freeze({ unit: 1, maxPerDay: 2, spaced: true,  hardBefore: 1, buffer: 0 }),
    quiz:       Object.freeze({ unit: 1, maxPerDay: 2, spaced: true,  hardBefore: 1, buffer: 0 }),
    reading:    Object.freeze({ unit: 1, maxPerDay: 2, spaced: true,  hardBefore: 0, buffer: 1 }),
    practice:   Object.freeze({ unit: 1, maxPerDay: 2, spaced: true,  hardBefore: 0, buffer: 1 }),
    assignment: Object.freeze({ unit: 2, maxPerDay: 4, spaced: false, hardBefore: 0, buffer: 1 }),
    paper:      Object.freeze({ unit: 2, maxPerDay: 4, spaced: false, hardBefore: 0, buffer: 1 }),
    project:    Object.freeze({ unit: 2, maxPerDay: 4, spaced: false, hardBefore: 0, buffer: 1 }),
    lab:        Object.freeze({ unit: 2, maxPerDay: 4, spaced: false, hardBefore: 0, buffer: 1 }),
    other:      Object.freeze({ unit: 1, maxPerDay: 4, spaced: false, hardBefore: 0, buffer: 1 }),
  });
  const DAY_KEYS = ['dayStart', 'dayEnd', 'maxPlannedFocus'];

  // ───────────────────────── small helpers ─────────────────────────
  const int = (v) => { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? n : 0; };
  const has = (o, k) => o != null && o[k] !== undefined && o[k] !== null;
  function cmp(a, b) {                       // tuple comparison, element by element
    for (let i = 0; i < a.length; i++) {
      if (a[i] < b[i]) return -1;
      if (a[i] > b[i]) return 1;
    }
    return 0;
  }
  function argmin(list, keyFn) {             // first element with the smallest key (Python min(key=))
    let best = null, bestKey = null;
    for (const x of list) {
      const k = keyFn(x);
      if (best === null || cmp(k, bestKey) < 0) { best = x; bestKey = k; }
    }
    return best;
  }
  const pad2 = (n) => String(n).padStart(2, '0');
  function dayKey(d) {
    const x = d instanceof Date ? d : new Date(d);
    return x.getFullYear() + '-' + pad2(x.getMonth() + 1) + '-' + pad2(x.getDate());
  }
  function parseDay(k) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(k || ''));
    return m ? [+m[1], +m[2], +m[3]] : null;
  }
  function addDays(k, n) {
    const p = parseDay(k);
    if (!p) return null;
    return dayKey(new Date(p[0], p[1] - 1, p[2] + n));
  }
  function daysBetween(a, b) {               // b − a in whole days (DST-safe)
    const x = parseDay(a), y = parseDay(b);
    if (!x || !y) return 0;
    return Math.round((Date.UTC(y[0], y[1] - 1, y[2]) - Date.UTC(x[0], x[1] - 1, x[2])) / 86400000);
  }
  function weekday(k) {                      // 0 = Sunday … 6 = Saturday
    const p = parseDay(k);
    return p ? new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay() : 0;
  }
  function toMs(v) {
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'number') return v;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : NaN;
  }

  function ceilTo(x, q) { return (Math.ceil(x / q) * q) || 0; }
  function floorTo(x, q) { return (Math.floor(x / q) * q) || 0; }

  // ───────────────────────── durations (SPEC §1.4.2) ─────────────────────────
  function rhythm(s) {
    return { F: int(s && s.focus), S: int(s && s.short), L: int(s && s.long), I: Math.max(1, int(s && s.interval)) };
  }
  function span(n, F, S, L, I) {
    if (n <= 0) return 0;
    let t = n * F;
    for (let k = 1; k < n; k++) t += (k % I === 0 ? L : S);
    return t;
  }
  function focusSpan(n, s) { const r = rhythm(s); return span(n, r.F, r.S, r.L, r.I); }
  function bm(n, F, S, L, I) { return Math.max(C.MIN_BLOCK, ceilTo(span(n, F, S, L, I), C.SNAP)); }
  function blockMinutes(n, s) { const r = rhythm(s); return bm(n, r.F, r.S, r.L, r.I); }
  function capacity(m, s) {
    const r = rhythm(s);
    if (!(r.F > 0)) return 0;
    let n = 0;
    while (n < 10000 && span(n + 1, r.F, r.S, r.L, r.I) <= m) n++;
    return n;
  }

  // ───────────────────────── timed layout (one day column) ─────────────────────────
  function layoutDay(items) {
    const evs = (items || []).map((it) => {
      const top = Math.max(0, Math.min(it.start, 1439));
      const bottom = Math.min(1440, Math.max(it.end, top + C.MIN_VISUAL));
      return { id: String(it.id), top, bottom, rank: it.rank || 0 };
    });
    evs.sort((a, b) => cmp([a.top, -(a.bottom - a.top), a.rank, a.id], [b.top, -(b.bottom - b.top), b.rank, b.id]));
    const out = {};
    function flush(cluster) {
      const cols = [];
      for (const e of cluster) {
        let placed = false;
        for (let ci = 0; ci < cols.length; ci++) {
          const col = cols[ci];
          if (col[col.length - 1].bottom <= e.top) { col.push(e); e.col = ci; placed = true; break; }
        }
        if (!placed) { cols.push([e]); e.col = cols.length - 1; }
      }
      const n = cols.length;
      for (const e of cluster) {
        let sp = 1;
        for (let c = e.col + 1; c < n; c++) {
          if (cols[c].some((o) => o.top < e.bottom && e.top < o.bottom)) break;
          sp++;
        }
        out[e.id] = { top: e.top, height: e.bottom - e.top, col: e.col, cols: n, span: sp };
      }
    }
    let cluster = [], clusterEnd = -1;
    for (const e of evs) {
      if (cluster.length && e.top >= clusterEnd) { flush(cluster); cluster = []; clusterEnd = -1; }
      cluster.push(e);
      clusterEnd = Math.max(clusterEnd, e.bottom);
    }
    if (cluster.length) flush(cluster);
    return out;
  }

  // ───────────────────────── all-day lanes ─────────────────────────
  function layoutAllDay(items, ndays, maxLanes = 2) {
    const its = [];
    for (const it of items || []) {
      const s = Math.max(0, it.startIdx), e = Math.min(ndays, it.endIdx);
      if (e > s) its.push({ ...it, id: String(it.id), s, e });
    }
    const tkey = (x) => [x.s, -(x.e - x.s), x.kind || 0, String(x.title || '').toLowerCase(), x.id];
    its.sort((a, b) => cmp(tkey(a), tkey(b)));
    const lanes = [], out = {};
    for (const it of its) {
      let li = lanes.findIndex((last) => last <= it.s);
      if (li >= 0) lanes[li] = it.e;
      else { lanes.push(it.e); li = lanes.length - 1; }
      out[it.id] = { lane: li, startIdx: it.s, endIdx: it.e };
    }
    const overflow = new Array(Math.max(0, ndays)).fill(0);
    for (const it of its) {
      if (out[it.id].lane >= maxLanes) for (let d = it.s; d < it.e; d++) overflow[d] += 1;
    }
    return { placements: out, laneCount: lanes.length, overflowCollapsed: overflow };
  }

  // ───────────────────────── auto-plan (one day; SPEC §1.4.4) ─────────────────────────
  function priorityKey(t, day, d7) {
    const due = t.due || null;
    let g;
    if (due && due <= day) g = 0;
    else if (t.active) g = 1;
    else if (due && due <= d7) g = 2;
    else g = 3;
    return [g, g === 0 || g === 2 ? due : '', int(t.listIndex)];
  }

  function autoPlan(inp) {
    const st = inp.settings || {};
    const { F, S, L, I } = rhythm(st);
    if (inp.dayRelation === 'past') return { windows: [], blocks: [], unfit: [], budgetPomodorosLeft: 0, reason: 'past' };
    if (!(F > 0)) return { windows: [], blocks: [], unfit: [], budgetPomodorosLeft: 0, reason: 'settings' };
    const isToday = inp.dayRelation === 'today';
    const now = int(inp.nowMinutes);
    let ws = int(st.dayStart);
    if (isToday) ws = Math.max(ws, ceilTo(now + C.AUTO_LEAD, C.SNAP));
    const we = int(st.dayEnd);
    const one = bm(1, F, S, L, I);
    const buffer = int(st.buffer);

    const busy = [];
    for (const e of inp.events || []) {
      const isBusy = e.isBusy === undefined ? true : e.isBusy;   // calref: e.get("isBusy", True)
      if (isBusy) busy.push([e.start - buffer, e.end + buffer]);
    }
    for (const b of inp.blocks || []) {
      let padding = 0;
      if (b.pomodoros >= 1) {
        const slack = (b.end - b.start) - span(b.pomodoros, F, S, L, I);
        padding = Math.max(0, S - slack);
      }
      busy.push([b.start, b.end + padding]);
    }
    busy.sort((a, b) => cmp(a, b));
    const merged = [];
    for (const [a, b] of busy) {
      if (merged.length && a <= merged[merged.length - 1][1]) merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], b);
      else merged.push([a, b]);
    }

    const free = [];
    let cur = ws;
    for (const [a, b] of merged) {
      if (cur >= we) break;
      if (b <= cur) continue;
      if (a > cur) {
        const fa = ceilTo(cur, C.SNAP), fb = floorTo(Math.min(a, we), C.SNAP);
        if (fb - fa >= one) free.push([fa, fb]);
      }
      cur = Math.max(cur, b);
    }
    if (cur < we) {
      const fa = ceilTo(cur, C.SNAP), fb = floorTo(we, C.SNAP);
      if (fb - fa >= one) free.push([fa, fb]);
    }

    const day = inp.day;
    const d7 = addDays(day, 7) || '';
    const sorted = (inp.tasks || []).slice().sort((a, b) => cmp(priorityKey(a, day, d7), priorityKey(b, day, d7)));
    const queue = [];
    for (const t of sorted) {
      const need = Math.max(0, int(t.remaining) - int(t.covered));
      if (!t.isDone && need > 0) queue.push({ taskID: t.id, title: t.title, need });
    }

    const budget = int(st.maxPlannedFocus) - int(inp.focusedTodayMinutes) - int(inp.plannedRemainingTodayMinutes);
    let budgetPoms = Math.max(0, Math.floor(budget / F));
    let rh = isToday ? (int(inp.completedPomodorosToday) % I) : 0;

    const out = [];
    for (const [fa, fb] of free) {
      let cursor = fa;
      while (queue.length && budgetPoms > 0) {
        const q = queue[0];
        let k = Math.min(q.need, I - rh, budgetPoms);
        while (k > 0 && cursor + bm(k, F, S, L, I) > fb) k -= 1;
        if (k === 0) break;
        const length = bm(k, F, S, L, I);
        out.push({ taskID: q.taskID, title: q.title, start: cursor, end: cursor + length, pomodoros: k, plannedFocusMinutes: k * F });
        q.need -= k;
        budgetPoms -= k;
        rh = (rh + k) % I;
        const gap = rh === 0 ? L : S;
        const slack = length - span(k, F, S, L, I);
        cursor = ceilTo(cursor + length + Math.max(0, gap - slack), C.SNAP);
        if (q.need === 0) queue.shift();
      }
      if (!queue.length || budgetPoms <= 0) break;
    }
    const unfit = queue.map((q) => ({ taskID: q.taskID, need: q.need }));
    return { windows: free, blocks: out, unfit, budgetPomodorosLeft: budgetPoms };
  }

  // ───────────────────────── session derivation, plan score (SPEC §1.4.4) ─────────────────────────
  /* derivePlanSessions(sessions): the engine's qualification + the day's fatigue band (calref.derive).
     Accepts Store sessions ({id, start, end, minutes, scheduledMinutes, mode, taskID, focusRating}) and
     the vector shape ({…, sched}). Break sessions are skipped; duplicate ids keep the rated copy. */
  function derivePlanSessions(sessions) {
    const uniq = new Map();
    for (const s of sessions || []) {
      if (!s || s.id == null) continue;
      const mode = s.mode == null ? 'focus' : s.mode;
      if (mode !== 'focus') continue;
      const k = String(s.id).toLowerCase();
      const prev = uniq.get(k);
      if (!prev) uniq.set(k, s);
      else if (prev.focusRating == null && s.focusRating != null) uniq.set(k, s);
    }
    const out = [];
    const byDay = new Map();
    for (const s of uniq.values()) {
      let sched = Number(s.sched != null ? s.sched : s.scheduledMinutes);
      if (!(sched > 0)) sched = 25;
      sched = Math.min(Math.max(sched, 1), 180);
      const raw = Math.floor(Math.max(0, Number(s.minutes) || 0) * 100 + 0.5);
      const cm = Math.min(raw, Math.floor((sched + 15) * 100 + 0.5));
      const thr = Math.floor(Math.max(5, Math.min(10, 0.8 * sched)) * 100 + 0.5);
      const start = toMs(s.start), end = toMs(s.end);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      const d = { id: String(s.id), start, end, taskID: s.taskID == null ? null : String(s.taskID), qualified: cm >= thr, cm, fat: 100 };
      const key = dayKey(new Date(start));
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(d);
      out.push(d);
    }
    for (const ss of byDay.values()) {
      let before = 0;
      ss.slice().sort((a, b) => cmp([a.start, a.end, a.id.toLowerCase()], [b.start, b.end, b.id.toLowerCase()])).forEach((d) => {
        d.fat = before < 30000 ? 100 : (before < 48000 ? 50 : 0);
        before += d.cm;
      });
    }
    return out;
  }

  /* planScore(sessions, blocks, now): sessions from derivePlanSessions (raw sessions are derived here);
     blocks = local timed focus blocks {id, start, end, taskID, pomodoros, plannedFocusMinutes, plannedAt}
     (ISO strings, Dates or ms; hidden blocks included). Result per calref.plan_score. */
  function planScore(sessions, blocks, now) {
    const list = sessions || [];
    const ses = list.length && !('cm' in list[0]) ? derivePlanSessions(list) : list;
    const nowMs = toMs(now);
    const pad = C.MATCH_PAD * 60000, lead = C.PLAN_LEAD * 60000;
    const bl = [];
    for (const b of blocks || []) {
      const start = toMs(b.start), end = toMs(b.end), plannedAt = toMs(b.plannedAt != null ? b.plannedAt : b.start);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      const tid = b.taskID != null ? b.taskID : b.taskId;
      bl.push({ id: String(b.id), start, end, taskID: tid ? String(tid) : null, pomodoros: int(b.pomodoros),
        plannedFocusMinutes: int(b.plannedFocusMinutes), plannedAt: Number.isFinite(plannedAt) ? plannedAt : start });
    }
    const assigned = new Map(bl.map((b) => [b.id, []]));
    const sessionBlock = {};
    const ordered = ses.slice().sort((a, b) => cmp([a.start, a.id.toLowerCase()], [b.start, b.id.toLowerCase()]));
    for (const s of ordered) {
      if (!s.qualified) continue;
      const spanMin = (s.end - s.start) / 60000;
      let best = null, bestKey = null;
      for (const b of bl) {
        if (b.pomodoros < 1) continue;
        if (b.taskID && (!s.taskID || s.taskID.toLowerCase() !== b.taskID.toLowerCase())) continue;
        const lo = b.start - pad, hi = b.end + pad;
        const ov = Math.max(0, (Math.min(hi, s.end) - Math.max(lo, s.start)) / 60000);
        const ok = spanMin > 0 ? ov >= C.MATCH_FRAC * spanMin : (lo <= s.start && s.start <= hi);
        if (!ok) continue;
        const key = [-ov, b.start, b.id.toLowerCase()];
        if (best === null || cmp(key, bestKey) < 0) { best = b; bestKey = key; }
      }
      if (best) { assigned.get(best.id).push(s); sessionBlock[s.id] = best.id; }
    }
    const resBlocks = {}, resSessions = {}, dayXP = {};
    for (const b of bl) {
      const ss = assigned.get(b.id);
      const eligible = b.plannedAt <= b.start - lead;
      const onPlan = [];
      for (const s of ss) if (onPlan.length < b.pomodoros && b.plannedAt <= s.start - lead) onPlan.push(s);
      const matchedMin = ss.reduce((t, s) => t + s.cm, 0) / 100;
      const onPlanMin = onPlan.reduce((t, s) => t + s.cm, 0) / 100;
      const pf = Math.max(1, b.plannedFocusMinutes);
      const progress = Math.min(1, matchedMin / pf);
      let status;
      if (progress >= C.DONE_FRAC) status = 'done';
      else if (nowMs < b.start) status = 'upcoming';
      else if (nowMs < b.end) status = 'active';
      else status = progress > 0 ? 'partial' : 'missed';
      const doneBonus = eligible && onPlanMin / pf >= C.DONE_FRAC ? C.BLOCK_DONE_XP : 0;
      resBlocks[b.id] = { matched: ss.map((s) => s.id), onPlan: onPlan.map((s) => s.id), progress: Math.round(progress * 1e4) / 1e4,
        status, eligible, doneBonus };
      const bday = dayKey(new Date(b.start));
      dayXP[bday] = (dayXP[bday] || 0) + doneBonus;
      for (const s of onPlan) {
        const xp = Math.floor(C.ON_PLAN_XP * s.fat / 100);
        resSessions[s.id] = xp;
        const sday = dayKey(new Date(s.start));
        dayXP[sday] = (dayXP[sday] || 0) + xp;
      }
    }
    const capped = {};
    let total = 0;
    for (const [d, v] of Object.entries(dayXP)) { capped[d] = Math.min(C.PLAN_DAY_CAP, v); total += capped[d]; }
    return { blocks: resBlocks, onPlanXP: resSessions, planXPByDay: capped, planXPTotal: total, sessionBlock };
  }

  // ───────────────────────── unscheduled work (SPEC §1.4.3) ─────────────────────────
  const blockTaskID = (b) => { const t = b.taskID != null ? b.taskID : b.taskId; return t ? String(t).toLowerCase() : null; };
  const isLocalFocus = (b) => !!b && !b.readOnly && (b.source == null || b.source === 'local') &&
    (b.kind === 'focus' || (b.kind == null && !!blockTaskID(b)));

  function unscheduled(tasks, blocks, now) {
    const nowMs = toMs(now == null ? Date.now() : now);
    const covered = new Map();
    for (const b of blocks || []) {
      if (!isLocalFocus(b) || b.hidden || !(toMs(b.end) > nowMs)) continue;
      const t = blockTaskID(b);
      if (t) covered.set(t, (covered.get(t) || 0) + int(b.pomodoros));
    }
    return (tasks || []).map((t) => {
      const remaining = Math.max(0, int(t.estimate) - int(t.completedPomodoros));
      const c = covered.get(String(t.id).toLowerCase()) || 0;
      return { taskID: t.id, remaining, covered: c, unscheduled: t.isDone ? 0 : Math.max(0, remaining - c) };
    });
  }

  // ───────────────────────── Up next (SPEC §1.4.5) ─────────────────────────
  function upNext({ blocks, statuses, events, now, plan } = {}) {
    const nowMs = toMs(now == null ? Date.now() : now);
    const today = dayKey(new Date(nowMs));
    const st = statuses || {};
    const todays = (blocks || []).filter((b) => isLocalFocus(b) && !b.hidden && !b.allDay && dayKey(new Date(toMs(b.start))) === today)
      .sort((a, b) => cmp([toMs(a.start), String(a.id)], [toMs(b.start), String(b.id)]));
    if (!todays.length) return { kind: 'noPlan' };
    const status = (b) => { const s = st[b.id]; return s ? (s.status || s.kind || null) : null; };
    if (plan && plan.blockID) {
      const b = todays.find((x) => String(x.id).toLowerCase() === String(plan.blockID).toLowerCase());
      if (b) return { kind: 'focusing', block: b, index: plan.index, total: plan.total };
    }
    const cur = todays.find((b) => toMs(b.start) <= nowMs && nowMs < toMs(b.end) && status(b) !== 'done');
    if (cur) return { kind: 'now', block: cur, minutesLeft: Math.max(1, Math.ceil((toMs(cur.end) - nowMs) / 60000)) };
    const next = todays.find((b) => toMs(b.start) > nowMs);
    if (next) {
      const bs = toMs(next.start), horizon = toMs(next.end) + 3 * 3600000;
      const then = (events || []).filter((e) => e && e.isBusy !== false && !e.allDay && toMs(e.start) >= bs && toMs(e.start) < horizon)
        .sort((a, b) => cmp([toMs(a.start), String(a.id)], [toMs(b.start), String(b.id)]))[0] || null;
      return { kind: 'next', block: next, startsInMinutes: Math.max(0, Math.ceil((bs - nowMs) / 60000)), then };
    }
    const done = todays.filter((b) => status(b) === 'done').length;
    if (done === todays.length) return { kind: 'allDone', done, total: todays.length };
    const missed = todays.filter((b) => status(b) === 'missed' || status(b) === 'partial').length;
    return { kind: 'missed', count: Math.max(1, missed) };
  }

  // ───────────────────────── colours (SPEC §1.6.3–§1.6.4) ─────────────────────────
  const SERIES_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
  const SERIES_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
  const BUILT_IN = { work: '#4da8da', study: '#9b7ede', chores: '#5ab552' };
  function fnv1a32(str) {
    let h = 0x811c9dc5;
    const bytes = unescape(encodeURIComponent(String(str)));   // UTF-8
    for (let i = 0; i < bytes.length; i++) { h ^= bytes.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
  }
  function categoryColor(name, scheme) {
    const n = typeof name === 'string' ? name.trim() : '';
    if (!n) return null;
    const key = n.toLowerCase();
    if (BUILT_IN[key]) return BUILT_IN[key];
    const series = scheme === 'light' ? SERIES_LIGHT : SERIES_DARK;
    return series[fnv1a32('pf-cat-v1:' + key) % 8];
  }
  function parseHex(hex) {
    let s = String(hex == null ? '' : hex).trim();
    if (s[0] === '#') s = s.slice(1);
    if (/^[0-9a-f]{3}$/i.test(s)) s = s.split('').map((c) => c + c).join('');
    if (/^[0-9a-f]{8}$/i.test(s)) s = s.slice(0, 6);
    if (!/^[0-9a-f]{6}$/i.test(s)) return null;
    const v = parseInt(s, 16);
    return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
  }
  function normalizeColor(hex) {
    const rgb = parseHex(hex);
    if (!rgb) return null;
    const lin = (x) => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
    const [r, g, b] = rgb.map(lin);
    const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    let L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
    let A = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
    let B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_;
    L = Math.min(0.72, Math.max(0.60, L));
    const chroma = Math.sqrt(A * A + B * B);
    if (chroma > 0.16) { A *= 0.16 / chroma; B *= 0.16 / chroma; }
    const l2 = L + 0.3963377774 * A + 0.2158037573 * B;
    const m2 = L - 0.1055613458 * A - 0.0638541728 * B;
    const s2 = L - 0.0894841775 * A - 1.2914855480 * B;
    const l3 = l2 * l2 * l2, m3 = m2 * m2 * m2, s3 = s2 * s2 * s2;
    const out = [
      4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
      -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
      -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3,
    ].map((x) => {
      const c = Math.min(1, Math.max(0, x));
      const gma = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
      return Math.round(Math.min(1, Math.max(0, gma)) * 255).toString(16).toUpperCase().padStart(2, '0');
    });
    return '#' + out.join('');
  }

  // ───────────────────────── planRange (PLAN_VERSION 2; v2-ai §5.3 = planref.plan_range) ─────────────────────────
  const itemKey = (it) => [String(it.id), it.part ? String(it.part) : ''];
  const kStr = (k) => k[0] + '\u0001' + k[1];
  const tidOf = (k) => k[0] + (k[1] ? '#' + k[1] : '');

  function rangeDays(inp) {
    const st = inp.settings || {};
    const out = [];
    for (const d of inp.days || []) {
      if (d.dayRelation === 'past') continue;
      const s = { ...st };
      for (const k of DAY_KEYS) if (has(d, k)) s[k] = d[k];
      out.push({ d, s });
    }
    return out;
  }

  function dayInput(d, s, tasks) {
    const base = {};
    for (const [k, v] of Object.entries(d)) if (!DAY_KEYS.includes(k) && k !== 'off') base[k] = v;
    return { ...base, settings: s, tasks };
  }

  function capacities(rdays) {
    return rdays.map(({ d, s }) => {
      if (d.off) return 0;
      const probe = [{ id: '~probe', title: '', listIndex: 0, remaining: C.PROBE_NEED, covered: 0 }];
      return autoPlan(dayInput(d, s, probe)).blocks.reduce((t, b) => t + b.pomodoros, 0);
    });
  }

  function windows(inp, rdays) {
    const n = rdays.length;
    const st = inp.settings || {};
    const d0 = rdays[0].d.day;
    const capItemDay = int(inp.perItemDayCap) || int(st.interval);
    const idx = (day) => daysBetween(d0, day);
    const dayEnd = {};
    for (const { d, s } of rdays) dayEnd[d.day] = s.dayEnd;
    const wins = [], early = [];
    for (const it of inp.items || []) {
      const need = Math.max(0, int(it.remaining) - int(it.covered));
      if (it.isDone || need <= 0) continue;
      const kind = it.kind || 'other';
      const rule = KIND_RULES[kind] || KIND_RULES.other;
      const s = it.unlockDay ? Math.max(0, idx(it.unlockDay)) : 0;
      const flags = new Set();
      const due = it.due || null;
      if (s > n - 1) continue;                                       // unlocks after this range: not demand here
      let trueHard = null, hard, target;
      if (!due) {
        hard = target = n - 1;
      } else {
        const di = idx(due);
        if (di < 0) {
          flags.add('overdue');
          hard = n - 1; target = s;
        } else {
          const hb0 = has(it, 'hardBefore') ? int(it.hardBefore) : rule.hardBefore;
          const de = Object.prototype.hasOwnProperty.call(dayEnd, due) ? dayEnd[due] : st.dayEnd;
          const during = has(it, 'dueMinutes') && it.dueMinutes < de;
          const hb = during ? Math.max(hb0, 1) : hb0;
          trueHard = di - hb;
          if (trueHard < s) {
            if (during && di === 0 && hb0 === 0 && s === 0) {
              flags.add('dueToday');                                 // due later today: plan before the due time
              trueHard = 0;
            } else {
              early.push({ taskID: it.id, part: it.part === undefined ? null : it.part, need, reason: 'dueTooSoon' });
              continue;
            }
          }
          const buf = has(it, 'bufferDays') ? int(it.bufferDays) : rule.buffer;
          hard = Math.min(trueHard, n - 1);
          target = Math.max(s, Math.min(trueHard - buf, hard));
        }
      }
      const mpd = int(it.maxPerDay) || (flags.has('overdue') ? capItemDay : Math.min(rule.maxPerDay, capItemDay));
      wins.push({ it, key: itemKey(it), need, kind, rule, s, hard, target, trueHard, flags, due, maxPerDay: mpd });
    }
    const wkey = (w) => [w.flags.has('overdue') ? -1 : w.target, w.hard, w.it.active ? 0 : 1, -int(w.it.weight),
      int(w.it.listIndex), w.key[0], w.key[1]];
    wins.sort((a, b) => cmp(wkey(a), wkey(b)));
    return { wins, early };
  }

  function reasonOf(w, n) {
    if (w.flags.has('dueToday')) return 'dueTooSoon';
    if (w.due && !w.flags.has('overdue') && w.trueHard !== null && w.trueHard <= n - 1) return 'noTimeBeforeDue';
    return 'rangeFull';
  }

  function allocate(wins, caps) {
    const n = caps.length;
    const load = new Array(n).fill(0);
    const alloc = Array.from({ length: n }, () => new Map());   // per day: kStr → {key, p}
    const unfit = [], warnings = [];
    for (const w of wins) {
      const { key, rule, maxPerDay: mpd } = w;
      if (w.flags.has('overdue')) warnings.push({ taskID: key[0], part: key[1] || null, kind: 'overdue' });
      const per = new Array(n).fill(0);
      let remaining = w.need;
      let usedPass2 = false;
      for (const pas of [1, 2]) {
        const lo = w.s, hi = pas === 1 ? w.target : w.hard;
        while (remaining > 0) {
          let u = Math.min(rule.unit, remaining);
          const candsFor = (uu) => {
            const out = [];
            for (let d = lo; d <= hi; d++) if (caps[d] - load[d] >= uu && per[d] + uu <= mpd) out.push(d);
            return out;
          };
          let cands = candsFor(u);
          if (!cands.length && u > 1) { u = 1; cands = candsFor(u); }
          if (!cands.length) break;
          const fill = (d) => Math.floor(((load[d] + u) * 1000) / caps[d]);
          let keyFn;
          if (rule.spaced) {
            const sumPer = per.reduce((t, x) => t + x, 0);
            const anchor = sumPer === 0 && pas === 1 && !!w.due && !w.flags.has('overdue') && !w.flags.has('dueToday');
            if (anchor) keyFn = (d) => [d === hi ? 0 : 1, fill(d), -d];                    // the last allowed day
            else {
              keyFn = (d) => [per[d] > 0 ? 1 : 0,                                          // new days first
                (d > 0 && per[d - 1] > 0 ? 1 : 0) + (d + 1 < n && per[d + 1] > 0 ? 1 : 0), fill(d), d];
            }
          } else keyFn = (d) => [fill(d), d];                                              // level the load
          const d = argmin(cands, keyFn);
          per[d] += u;
          load[d] += u;
          remaining -= u;
          if (pas === 2) usedPass2 = true;
        }
        if (remaining === 0) break;
      }
      const ks = kStr(key);
      for (let d = 0; d < n; d++) {
        if (!per[d]) continue;
        const cur = alloc[d].get(ks);
        alloc[d].set(ks, { key, p: (cur ? cur.p : 0) + per[d] });
      }
      if (usedPass2 && !w.flags.has('overdue') && !w.flags.has('dueToday')) warnings.push({ taskID: key[0], part: key[1] || null, kind: 'noBuffer' });
      if (remaining > 0) unfit.push({ taskID: key[0], part: key[1] || null, need: remaining, reason: reasonOf(w, n) });
    }
    return { alloc, load, unfit, warnings };
  }

  function pack(rdays, wins, alloc, caps, load, unfit) {
    const n = rdays.length;
    const rank = new Map(wins.map((w, i) => [kStr(w.key), i]));
    const winfo = new Map(wins.map((w) => [kStr(w.key), w]));
    const blocks = [];
    for (let d = 0; d < n; d++) {
      const dd = rdays[d].d, s = rdays[d].s;
      const entries = Array.from(alloc[d].values()).filter((e) => e.p > 0)
        .sort((a, b) => rank.get(kStr(a.key)) - rank.get(kStr(b.key)));
      if (!entries.length) continue;
      const tasks = entries.map((e, i) => {
        const it = winfo.get(kStr(e.key)).it;
        return { id: tidOf(e.key), title: String(it.title || '') + (e.key[1] ? ' · ' + e.key[1] : ''), listIndex: i, remaining: e.p, covered: 0 };
      });
      const r = autoPlan(dayInput(dd, s, tasks));
      const byTid = new Map(entries.map((e) => [tidOf(e.key), e.key]));
      const placed = new Map();
      for (const b of r.blocks) {
        const k = byTid.get(b.taskID);
        const w = winfo.get(kStr(k));
        if (w.flags.has('dueToday') && d === 0 && b.end > w.it.dueMinutes) continue;   // would end after the due time
        blocks.push({ day: dd.day, taskID: k[0], part: k[1] || null, title: b.title, start: b.start, end: b.end,
          pomodoros: b.pomodoros, plannedFocusMinutes: b.plannedFocusMinutes });
        placed.set(kStr(k), (placed.get(kStr(k)) || 0) + b.pomodoros);
      }
      for (const e of entries) {
        const ks = kStr(e.key);
        let left = e.p - (placed.get(ks) || 0);
        if (left <= 0) continue;
        load[d] -= left;
        const w = winfo.get(ks);
        for (let d2 = d + 1; d2 <= w.hard; d2++) {
          if (left <= 0) break;
          const curE = alloc[d2].get(ks);
          const cur = curE ? curE.p : 0;
          const room = Math.min(caps[d2] - load[d2], w.maxPerDay - cur);
          if (room > 0) {
            const mv = Math.min(room, left);
            alloc[d2].set(ks, { key: e.key, p: cur + mv });
            load[d2] += mv;
            left -= mv;
          }
        }
        if (left > 0) unfit.push({ taskID: e.key[0], part: e.key[1] || null, need: left, reason: reasonOf(w, n) });
      }
    }
    return blocks;
  }

  function mergeUnfit(unfit) {
    const merged = new Map();
    for (const u of unfit) {
      const k = [String(u.taskID), u.part || '', u.reason].join('\u0001');
      if (merged.has(k)) merged.get(k).need += u.need;
      else merged.set(k, { ...u });
    }
    return Array.from(merged.values()).sort((a, b) => cmp([String(a.taskID), a.part || '', a.reason], [String(b.taskID), b.part || '', b.reason]));
  }

  function planRange(inp) {
    const days = (inp && inp.days) || [];
    if (!days.length || days.length > C.HORIZON_MAX_DAYS) throw new RangeError('days must hold 1..14 consecutive days');
    for (let i = 1; i < days.length; i++) {
      if (daysBetween(days[i - 1].day, days[i].day) !== 1) throw new RangeError('days must be consecutive');
    }
    const rdays = rangeDays(inp);
    if (!rdays.length) return { version: C.PLAN_VERSION, blocks: [], unfit: [], perDay: [], warnings: [], reason: 'past' };
    const caps = capacities(rdays);
    const { wins, early } = windows(inp, rdays);
    const { alloc, load, unfit, warnings } = allocate(wins, caps);
    const unfitAll = early.concat(unfit);
    const blocks = pack(rdays, wins, alloc, caps, load, unfitAll);    // appends packing leftovers
    const perDay = rdays.map(({ d }, i) => ({ day: d.day, capacity: caps[i],
      planned: blocks.reduce((t, b) => t + (b.day === d.day ? b.pomodoros : 0), 0) }));
    return { version: C.PLAN_VERSION, blocks, unfit: mergeUnfit(unfitAll), perDay, warnings };
  }

  return {
    C, KIND_RULES, ready: true,
    focusSpan, blockMinutes, capacity, ceilTo, floorTo, layoutDay, layoutAllDay, autoPlan, derivePlanSessions,
    planScore, unscheduled, upNext, categoryColor, normalizeColor, planRange,
    dayKey, addDays, daysBetween, weekday, fnv1a32,
  };
})();
