/* ═══════════════════════════════════════════════════════════════════════
   study-plan.js — the Basic study strategy, Coach hints, materialisation,
   course linking and the study profile (owner: W3). Pure: no DOM, no Store.

   Ports planref.py › study_items / apply_hints (v2-ai §5.6, §6.4; vectors in
   v2-planner-vectors.json, jsc: TOOLS/tests/w3-planner.test.js) and the
   pseudo-code of v2-ai §3.6 (linking), §3.7 (materialisation), §4.1–§4.3
   (planning inputs) and §4.5 (study profile). Uses CalCore (calendar-core.js,
   loaded first) for KIND_RULES, day maths and the CAL v1 helpers; it never
   carries a private copy of them.

   const StudyPlan = {
     items(input)                                → planRange items (study_items)
     applyHints(studyInput, planDays, settings, hints)
                                                 → {study, days, whyByTask, dropped}   (apply_hints)
     materialize(course, assessment, opts?)      → [task fields] for an eligible assessment (§3.7), else []
     linkCourses(courses, assignments, opts?)    → [{kind:'suggest'|'key'|'link', …}]       (§3.6)
     profile(sessions, blocks, opts?)            → study profile (§4.5) | null
     prepare(snapshot)                           → {settings, days, study, virtual, range} (§4.1–§4.4)
     kindFromTitle(title) · courseFactor(samples) · split(total, weights)   helpers
   }
   ═══════════════════════════════════════════════════════════════════════ */

const StudyPlan = (() => {
  'use strict';
  const MAX_PARTS = 6;
  const TYPE_TO_KIND = {
    exam: 'exam', quiz: 'quiz', assignment: 'assignment', paper: 'paper', project: 'project', lab: 'lab', reading: 'reading',
    presentation: 'project', participation: 'other', other: 'other', discussion: 'assignment',
  };
  const TITLE_RULES = [   // first match wins; whole words
    ['exam', ['final', 'midterm', 'exam', 'test']], ['quiz', ['quiz']],
    ['paper', ['essay', 'paper', 'draft', 'thesis']], ['project', ['project', 'presentation']],
    ['lab', ['lab']], ['reading', ['read', 'reading', 'chapter', 'ch']],
    ['practice', ['flashcards', 'practice', 'review', 'drill']],
    ['assignment', ['problem set', 'pset', 'homework', 'hw', 'worksheet', 'assignment']],
  ];
  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  const KR = () => CalCore.KIND_RULES;
  const addDays = (k, n) => CalCore.addDays(k, n);
  const int = (v) => { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? n : 0; };
  const has = (o, k) => o != null && o[k] !== undefined && o[k] !== null;
  const cut = (s, n) => { const a = Array.from(String(s == null ? '' : s)); return a.length > n ? a.slice(0, n).join('') : a.join(''); };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const roundHalfUp = (x) => Math.floor(x + 0.5);
  function cmp(a, b) {
    for (let i = 0; i < a.length; i++) { if (a[i] < b[i]) return -1; if (a[i] > b[i]) return 1; }
    return 0;
  }
  const dropNull = (o) => { const out = {}; for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined) out[k] = v; return out; };

  function kindFromTitle(title) {
    const t = ' ' + String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ') + ' ';
    for (const [kind, words] of TITLE_RULES) for (const w of words) if (t.includes(' ' + w + ' ')) return kind;
    return 'other';
  }

  /* Largest-remainder split of `total` by weights; ties go to the earlier index (planref._split). */
  function split(total, weights) {
    let w = weights.slice();
    let sw = w.reduce((t, x) => t + x, 0);
    if (sw <= 0) { w = w.map(() => 1); sw = w.length; }
    const raw = w.map((x) => total * x / sw);
    const base = raw.map((x) => Math.floor(x));
    const rest = total - base.reduce((t, x) => t + x, 0);
    const order = raw.map((_, i) => i).sort((i, j) => cmp([-(raw[i] - base[i]), i], [-(raw[j] - base[j]), j]));
    for (const i of order.slice(0, Math.max(0, rest))) base[i] += 1;
    return base;
  }

  // ───────────────────────── study_items (v2-ai §5.6) ─────────────────────────
  function partsToItems(base, parts, done) {
    const out = [];
    let prev = null;
    for (const p of parts) {
      const take = Math.min(done, p.pomodoros);
      done -= take;
      const rem = p.pomodoros - take;
      if (rem <= 0) continue;
      let unlock = p.unlockDay || null;
      if (prev !== null) {
        if (!unlock) unlock = prev.due === undefined ? null : prev.due;
        else if (prev.unlockDay && unlock < prev.unlockDay) unlock = prev.unlockDay;
      } else if (!unlock) {
        unlock = base.unlockDay === undefined ? null : base.unlockDay;
      }
      let it = { ...base, part: cut(p.label, 40), remaining: rem, covered: 0, due: has(p, 'due') ? p.due : null,
        dueMinutes: has(p, 'dueMinutes') ? p.dueMinutes : null, unlockDay: unlock };
      if (p.doBy) { it.hardBefore = 0; it.bufferDays = 0; it.dueMinutes = null; }
      it = dropNull(it);
      out.push(it);
      prev = it;
    }
    return out;
  }

  function items(inp) {
    const today = inp.today;
    const courses = new Map(), byKey = new Map(), assess = new Map();
    for (const c of inp.courses || []) {
      courses.set(c.id, c);
      for (const k of c.courseKeys || []) byKey.set(String(k).toLowerCase(), c);
    }
    for (const a of inp.assessments || []) assess.set(a.id, a);
    const out = [];
    const tasks = (inp.tasks || []).slice().sort((x, y) => cmp([int(x.listIndex), String(x.id)], [int(y.listIndex), String(y.id)]));
    for (const t of tasks) {
      if (t.isDone) continue;
      const a = assess.get(t.assessmentID || '') || null;
      let c = courses.get(t.courseID || '') || byKey.get(String(t.courseKey || '').toLowerCase()) || null;
      if (a && !c) c = courses.get(a.courseID || '') || null;
      const kind = t.kind || (a ? (TYPE_TO_KIND[a.type] || 'other') : kindFromTitle(t.title));
      const est = int(t.estimate);
      const doneP = int(t.completedPomodoros) + int(t.covered);
      const need = Math.max(0, est - doneP);
      if (need <= 0) continue;
      let due = t.dueDate || null, dueMin = has(t, 'dueMinutes') ? t.dueMinutes : null;
      const base = { id: t.id, title: t.title, listIndex: t.listIndex, kind, remaining: Math.max(0, est - int(t.completedPomodoros)),
        covered: int(t.covered) };
      if (t.active) base.active = true;
      if (a && has(a, 'weightPercent') && a.weightPercent >= 0) base.weight = roundHalfUp(a.weightPercent);
      // reading before the next class meeting
      if (!due && kind === 'reading' && c && c.readBeforeClass && (c.meetingTimes || []).length) {
        for (let k = 1; k < 15; k++) {
          const day = addDays(today, k);
          const wd = CalCore.weekday(day);
          const ms = c.meetingTimes.filter((m) => m.weekday === wd).map((m) => m.start).sort((x, y) => x - y);
          const inTerm = (!c.termStart || day >= c.termStart) && (!c.termEnd || day <= c.termEnd);
          if (ms.length && inTerm) { due = day; dueMin = ms[0]; break; }
        }
      }
      if (due) {
        base.due = due;
        if (dueMin !== null && dueMin !== undefined) base.dueMinutes = dueMin;
      }
      if ((kind === 'exam' || kind === 'quiz') && due) {
        const prep = (c ? int(c.examPrepDays) : 0) || (kind === 'exam' ? 7 : 3);
        base.unlockDay = addDays(due, -prep);
      }
      const steps = a ? (a.steps || []) : [];
      const lead = due ? CalCore.daysBetween(today, due) : 0;
      if ((t.parts || []).length) {                              // Coach parts: absolute days, already validated
        const parts = t.parts.map((p, i) => {
          const doBy = p.doBy || due;
          return { label: p.label, pomodoros: p.pomodoros, due: doBy, dueMinutes: doBy === due ? dueMin : null,
            unlockDay: p.earliest || (i === 0 ? (base.unlockDay || null) : null), doBy: !!p.doBy && p.doBy !== due, i };
        });
        parts.sort((x, y) => cmp([x.due || '9999-12-31', x.i], [y.due || '9999-12-31', y.i]));
        out.push(...partsToItems(base, parts, doneP));
      } else if (steps.length && due) {
        const ordered = steps.map((s, i) => ({ s, i })).sort((x, y) => cmp([x.s.doByOffsetDays == null ? 0 : x.s.doByOffsetDays, x.i],
          [y.s.doByOffsetDays == null ? 0 : y.s.doByOffsetDays, y.i])).slice(0, MAX_PARTS).map((x) => x.s);
        const weights = ordered.map((s) => Math.max(1, roundHalfUp((Number(s.estHours) || 0) * 4)));
        const sizes = split(est, weights);
        const parts = [];
        ordered.forEach((s, i) => {
          const size = sizes[i];
          if (size <= 0) return;
          const off = Math.min(0, int(s.doByOffsetDays));
          const unl = int(s.unlockOffsetDays);
          parts.push({ label: s.title, pomodoros: size, due: addDays(due, off), dueMinutes: off === 0 ? dueMin : null,
            unlockDay: unl < 0 ? addDays(due, unl) : null, doBy: off < 0 });
        });
        out.push(...partsToItems(base, parts, doneP));
      } else if ((kind === 'paper' || kind === 'project') && due && est >= 6 && need >= 3 && lead >= 4) {
        const r1 = 2 + Math.max(1, Math.floor((Math.min(lead, 14) - 2) / 2));
        const o = Math.max(1, roundHalfUp(est * 0.25));
        const rv = Math.max(1, roundHalfUp(est * 0.25));
        const parts = [
          { label: 'Outline', pomodoros: o, due: addDays(due, -r1), doBy: true },
          { label: 'Draft', pomodoros: est - o - rv, due: addDays(due, -2), doBy: true },
          { label: 'Revise', pomodoros: rv, due: addDays(due, -1), doBy: true },
        ];
        out.push(...partsToItems(base, parts, doneP));
      } else {
        out.push(base);
      }
    }
    return out;
  }

  // ───────────────────────── Coach hints (v2-ai §6.4 = planref.apply_hints) ─────────────────────────
  function hardDay(t, kind, dayEnd) {
    const due = t.dueDate;
    if (!due) return null;
    let hb = (KR()[kind] || KR().other).hardBefore;
    if (has(t, 'dueMinutes') && t.dueMinutes < dayEnd) hb = Math.max(hb, 1);
    return addDays(due, -hb);
  }

  function cleanParts(t, kind, est, raw, dayEnd, lastDay, dropped) {
    const tid = t.id;
    const ps = [];
    for (const p of raw.slice(0, MAX_PARTS)) {
      if (int(p.pomodoros) < 1) { dropped.push({ taskID: tid, part: cut(p.label || '', 40), why: 'noPomodoros' }); continue; }
      ps.push(p);
    }
    if (raw.length > MAX_PARTS) dropped.push({ taskID: tid, why: 'tooManyParts' });
    const hard = hardDay(t, kind, dayEnd);
    const out = [];
    for (const p of ps) {
      let doBy = p.doBy || '', earliest = p.earliest || '';
      if (doBy && !DAY_RE.test(doBy)) doBy = '';
      if (earliest && !DAY_RE.test(earliest)) earliest = '';
      if (hard && doBy && doBy > hard) doBy = hard;
      if (earliest && doBy && earliest > doBy) earliest = '';
      if (earliest && earliest > lastDay) { dropped.push({ taskID: tid, part: cut(p.label || '', 40), why: 'outsideRange' }); continue; }
      out.push({ label: cut(String(p.label || '').trim() || 'Part', 40), pomodoros: int(p.pomodoros), earliest, doBy });
    }
    if (!out.length) return [];
    const sizes = split(est, out.map((q) => q.pomodoros));
    out.forEach((q, i) => { q.pomodoros = sizes[i]; });
    return out.filter((q) => q.pomodoros > 0);
  }

  function applyHints(studyInput, planDays, settings, hints) {
    const si = clone(studyInput);
    const days = clone(planDays);
    const h0 = hints && typeof hints === 'object' ? hints : {};
    const dayKeys = days.map((d) => d.day);
    const lastDay = dayKeys[dayKeys.length - 1];
    const tasks = new Map(si.tasks.map((t) => [t.id, t]));
    const assess = new Map((si.assessments || []).map((a) => [a.id, a]));
    const why = {}, dropped = [];
    for (const h of Array.isArray(h0.tasks) ? h0.tasks : []) {
      const t = tasks.get(h.taskID);
      if (!t || t.isDone) { dropped.push({ taskID: h.taskID === undefined ? null : h.taskID, why: 'unknown' }); continue; }
      const a = assess.get(t.assessmentID || '') || null;
      const kind = t.kind || (a ? (TYPE_TO_KIND[a.type] || 'other') : kindFromTitle(t.title));
      const done = int(t.completedPomodoros);
      const est = int(h.estimate);
      if (est >= 1) t.estimate = Math.max(Math.min(done + 1, 12), Math.min(est, 12));   // SPEC: estimate is 1…12
      if (Array.isArray(h.parts) && h.parts.length) {
        const parts = cleanParts(t, kind, int(t.estimate), h.parts, settings.dayEnd, lastDay, dropped);
        if (parts.length) t.parts = parts;
      }
      if (h.why) why[t.id] = cut(h.why, 140);
    }
    (Array.isArray(h0.newTasks) ? h0.newTasks : []).forEach((h, i) => {
      if (i >= 5) { dropped.push({ taskID: h.taskID === undefined ? null : h.taskID, why: 'tooManyNewTasks' }); return; }
      let due = h.dueDate || null;
      if (due && !DAY_RE.test(due)) due = null;
      const kind = Object.prototype.hasOwnProperty.call(KR(), h.kind) ? h.kind : 'other';
      const t = { id: h.taskID, title: cut(h.title || 'New task', 120), listIndex: 10000 + i,
        estimate: Math.max(1, Math.min(int(h.estimate || 1), 12)), completedPomodoros: 0, covered: 0, kind };
      if (due) t.dueDate = due;
      if (Array.isArray(h.parts) && h.parts.length) {
        const parts = cleanParts(t, kind, t.estimate, h.parts, settings.dayEnd, lastDay, dropped);
        if (parts.length) t.parts = parts;
      }
      si.tasks.push(t);
      if (h.why) why[t.id] = cut(h.why, 140);
    });
    for (const h of Array.isArray(h0.days) ? h0.days : []) {
      const day = h.day === undefined ? null : h.day, mp = h.maxPomodoros;
      if (!dayKeys.includes(day) || typeof mp !== 'number' || !Number.isInteger(mp) || mp < 0) { dropped.push({ day, why: 'day' }); continue; }
      const d = days[dayKeys.indexOf(day)];
      if (mp === 0) d.off = true;
      else d.maxPlannedFocus = Math.min(has(d, 'maxPlannedFocus') ? d.maxPlannedFocus : settings.maxPlannedFocus, mp * settings.focus);
    }
    return { study: si, days, whyByTask: why, dropped };
  }

  // ───────────────────────── materialisation (v2-ai §3.7) ─────────────────────────
  const DEFAULT_HOURS = { exam: 4, quiz: 1, assignment: 1.5, paper: 5, project: 8, lab: 2, reading: 1, presentation: 3, participation: 0, other: 1 };
  function leadDays(type, course) {
    const prep = int(course && course.strategy && course.strategy.examPrepDays);
    if (type === 'exam') return Math.max(7, prep) + 3;
    return { quiz: 4, paper: 14, project: 21 }[type] || 7;
  }
  const courseLabel = (c) => (c && (String(c.code || '').trim() || String(c.name || '').trim())) || '';
  /* eligible(course, a, {today, rangeEnd, assignmentIDs}) */
  function eligible(course, a, opts = {}) {
    if (!a || a.status && a.status !== 'upcoming') return false;
    if (a.type === 'participation' || (a.taskIDs || []).length) return false;
    if (a.externalID && opts.assignmentIDs && opts.assignmentIDs.has(String(a.externalID).toLowerCase())) return false;
    if (!a.due || !DAY_RE.test(a.due)) return false;
    if (opts.today && a.due < opts.today) return false;
    if (opts.rangeEnd && addDays(a.due, -leadDays(a.type, course)) > opts.rangeEnd) return false;
    return true;
  }
  /* materialize(course, assessment, {today, rangeEnd, focusMinutes, ratio, assignmentIDs, force}) →
     [{title, estimate, category, dueDate, dueMinutes, courseID, assessmentID, notes, kind}] ([] when not eligible;
     `force` skips the date window, for the Course sheet's "Add to tasks"). */
  function materialize(course, a, opts = {}) {
    if (!course || !a) return [];
    if (!opts.force && !eligible(course, a, opts)) return [];
    if (opts.force && (a.type === 'participation' || (a.taskIDs || []).length)) return [];
    const focus = int(opts.focusMinutes) || 25;
    const ratio = Number(opts.ratio) > 0 ? Number(opts.ratio) : 1;
    const hours = (Number(a.estHours) > 0 ? Number(a.estHours) : (DEFAULT_HOURS[a.type] != null ? DEFAULT_HOURS[a.type] : 1)) * ratio;
    const n = Math.max(1, Math.ceil(hours * 60 / focus - 1e-9));
    const label = courseLabel(course);
    const title = cut((label ? label + ' · ' : '') + String(a.title || 'Assessment'), 120);
    const common = {
      category: label || null, dueDate: a.due || null, dueMinutes: has(a, 'dueTime') ? a.dueTime : null,
      courseID: course.id, assessmentID: a.id, notes: a.prep ? cut(a.prep, 2000) : null, kind: TYPE_TO_KIND[a.type] || 'other',
    };
    if (n <= 12) return [{ ...common, title, estimate: n }];
    const k = Math.ceil(n / 12);
    const baseEst = Math.floor(n / k), extra = n % k;
    const out = [];
    for (let i = 0; i < k; i++) out.push({ ...common, title: cut(title + ` (part ${i + 1}/${k})`, 120), estimate: baseEst + (i < extra ? 1 : 0) });
    return out;
  }

  // ───────────────────────── course suggestions and linking (v2-ai §3.6) ─────────────────────────
  const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'for', 'on', 'in', 'to']);
  const normTitle = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const alnum = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  function titleScore(a, b) {
    const na = normTitle(a), nb = normTitle(b);
    if (!na || !nb) return 0;
    if (na.includes(nb) || nb.includes(na)) return 1;
    const ta = new Set(na.split(' ').filter((w) => w && !STOP.has(w))), tb = new Set(nb.split(' ').filter((w) => w && !STOP.has(w)));
    if (!ta.size || !tb.size) return 0;
    let inter = 0;
    for (const w of ta) if (tb.has(w)) inter++;
    return inter / (ta.size + tb.size - inter);
  }
  /* linkCourses(courses, assignments, {dismissedCourseKeys, providerOf(a)}) → actions, in order:
       {kind:'suggest', courseKey, name, code, provider, count}     a feed course key no course owns (not dismissed)
       {kind:'key', courseID, courseKey}                              auto-attach "code:<lower>" keys (step 2)
       {kind:'link', courseID, assessmentID, assignmentID, feedDue, syllabusDue, score}   (steps 3–4) */
  function linkCourses(courses, assignments, opts = {}) {
    const out = [];
    const list = (assignments || []).filter((a) => a && a.courseKey);
    const owned = new Set();
    for (const c of courses || []) for (const k of c.courseKeys || []) owned.add(String(k).toLowerCase());
    const dismissed = new Set((opts.dismissedCourseKeys || []).map((k) => String(k).toLowerCase()));
    const dismissedA = new Set((opts.dismissedAssignments || []).map((k) => String(k).toLowerCase()));
    const live = list.filter((a) => !dismissedA.has(String(a.id).toLowerCase()));
    // 2. auto-attach code keys (so suggestions don't repeat a course that already exists)
    const keysInUse = new Set(live.map((a) => String(a.courseKey).toLowerCase()));
    for (const c of courses || []) {
      if (c.archived || !String(c.code || '').trim()) continue;
      const have = new Set((c.courseKeys || []).map((k) => String(k).toLowerCase()));
      const want = alnum(c.code);
      // "code:<lower(code)>" / "code:<alnum(code)>", and any ICS code key that differs only in punctuation
      const matches = Array.from(keysInUse).filter((k) => k.startsWith('code:') && alnum(k.slice(5)) === want).sort();
      for (const k of matches) {
        if (!have.has(k)) { out.push({ kind: 'key', courseID: c.id, courseKey: k }); have.add(k); owned.add(k); }
      }
    }
    // 1. suggestions
    const groups = new Map();
    for (const a of live) {
      const k = String(a.courseKey).toLowerCase();
      if (owned.has(k) || dismissed.has(k)) continue;
      if (!groups.has(k)) groups.set(k, { kind: 'suggest', courseKey: k, name: a.course || a.courseKey, code: cut(a.course || '', 24),
        provider: (opts.providerOf ? opts.providerOf(a) : a.source) || 'ics', count: 0 });
      groups.get(k).count++;
    }
    out.push(...Array.from(groups.values()).sort((x, y) => cmp([x.provider, x.code.toLowerCase(), x.courseKey], [y.provider, y.code.toLowerCase(), y.courseKey])));
    // 3. link assessments to assignments
    const used = new Set();
    for (const c of courses || []) for (const a of c.assessments || []) if (a.externalID) used.add(String(a.externalID).toLowerCase());
    for (const c of courses || []) {
      if (c.archived) continue;
      const keys = new Set((c.courseKeys || []).map((k) => String(k).toLowerCase()));
      for (const o of out) if (o.kind === 'key' && o.courseID === c.id) keys.add(o.courseKey);
      const cands = live.filter((a) => keys.has(String(a.courseKey).toLowerCase()));
      for (const asmt of c.assessments || []) {
        if (asmt.externalID || (asmt.status && asmt.status !== 'upcoming')) continue;
        let best = null, bestKey = null;
        for (const a of cands) {
          const aid = String(a.id).toLowerCase();
          if (used.has(aid)) continue;
          const dd = asmt.due && a.dueDay ? Math.abs(CalCore.daysBetween(asmt.due, a.dueDay)) : 0;
          if (asmt.due && a.dueDay && dd > 2) continue;
          const sc = titleScore(asmt.title, a.title);
          if (sc < 0.5) continue;
          const key = [-sc, dd, aid];
          if (!best || cmp(key, bestKey) < 0) { best = a; bestKey = key; }
        }
        if (best) {
          used.add(String(best.id).toLowerCase());
          out.push({ kind: 'link', courseID: c.id, assessmentID: asmt.id, assignmentID: best.id, feedDue: best.dueDay || null,
            syllabusDue: asmt.due || null, score: -bestKey[0] });
        }
      }
    }
    return out;
  }

  // ───────────────────────── study profile (v2-ai §4.5) ─────────────────────────
  function courseFactor(samples) {   // = v2-calendar course_factor: samples [[estimate, actual]] most recent first
    const rs = (samples || []).slice(0, 10).filter(([e, a]) => e > 0 && a > 0).map(([e, a]) => a / e).sort((x, y) => x - y);
    if (rs.length < 3) return 1;
    const mid = Math.floor(rs.length / 2);
    const med = rs.length % 2 ? rs[mid] : (rs[mid - 1] + rs[mid]) / 2;
    return Math.min(2.5, Math.max(0.5, med));
  }
  const hhmm = (h) => String(h).padStart(2, '0') + ':00';
  /* profile(sessions, blocks, {now, tasks, maxPlannedFocus}) → {days, activeDays, avgFocusMinutes, p75FocusMinutes,
     bestHours, planKeptPercent, estimateRatio, realisticCap} */
  function profile(sessions, blocks, opts = {}) {
    const now = opts.now ? new Date(opts.now) : new Date();
    const today = CalCore.dayKey(now);
    const from = addDays(today, -28);
    const ses = CalCore.derivePlanSessions(sessions || []).filter((s) => {
      const k = CalCore.dayKey(new Date(s.start));
      return k >= from && k < today;
    });
    const perDay = new Map();
    const hours = new Array(24).fill(0);
    let qualifiedCount = 0;
    for (const s of ses) {
      if (!s.qualified) continue;
      qualifiedCount++;
      const k = CalCore.dayKey(new Date(s.start));
      perDay.set(k, (perDay.get(k) || 0) + s.cm / 100);
      hours[new Date(s.start).getHours()] += s.cm / 100;
    }
    const mins = Array.from(perDay.values()).sort((a, b) => a - b);
    const activeDays = mins.length;
    const avg = activeDays ? Math.round(mins.reduce((t, x) => t + x, 0) / activeDays) : 0;
    const p75 = activeDays ? Math.round(mins[Math.max(0, Math.ceil(0.75 * activeDays) - 1)]) : 0;
    let bestHours = [];
    if (qualifiedCount >= 8) {
      const win = (h) => hours[h] + hours[h + 1] + hours[h + 2];
      let b1 = 0;
      for (let h = 1; h <= 21; h++) if (win(h) > win(b1)) b1 = h;
      if (win(b1) > 0) {
        bestHours.push(hhmm(b1) + '-' + hhmm(b1 + 3));
        let b2 = -1;
        for (let h = 0; h <= 21; h++) {
          if (h + 3 > b1 && h < b1 + 3) continue;
          if (b2 < 0 || win(h) > win(b2)) b2 = h;
        }
        if (b2 >= 0 && win(b2) > 0) bestHours.push(hhmm(b2) + '-' + hhmm(b2 + 3));
      }
    }
    const nowMs = now.getTime();
    const local = (blocks || []).filter((b) => b && (b.kind === 'focus') && Number(b.pomodoros) >= 1 && Date.parse(b.end) <= nowMs &&
      CalCore.dayKey(new Date(b.start)) >= from);
    let planKeptPercent = null;
    if (local.length) {
      const ps = CalCore.planScore(sessions || [], local, now);
      let planned = 0, kept = 0;
      for (const b of local) { planned += Number(b.plannedFocusMinutes) || 0; kept += (ps.blocks[b.id] ? ps.blocks[b.id].progress : 0) * (Number(b.plannedFocusMinutes) || 0); }
      if (planned >= 120) planKeptPercent = Math.round(100 * kept / planned);
    }
    const estimateRatio = {};
    const groups = new Map();
    for (const t of (opts.tasks || []).filter((x) => x && x.isDone)) {
      const key = t.courseKey || (t.courseID ? 'course:' + t.courseID : null) || t.category;
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    for (const [key, list] of groups) {
      const recent = list.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      const f = courseFactor(recent.map((t) => [Number(t.estimate) || 0, Number(t.completedPomodoros) || 0]));
      if (f !== 1) estimateRatio[key] = Math.round(f * 100) / 100;
    }
    const maxPF = int(opts.maxPlannedFocus) || 300;
    const realisticCap = activeDays >= 5 ? Math.min(maxPF, Math.max(60, CalCore.ceilTo(p75 * 1.25, 15))) : maxPF;
    return { days: 28, activeDays, avgFocusMinutes: avg, p75FocusMinutes: p75, bestHours, planKeptPercent, estimateRatio, realisticCap };
  }

  // ───────────────────────── planning inputs from app data (v2-ai §4.1–§4.4) ─────────────────────────
  const minutesOf = (d) => d.getHours() * 60 + d.getMinutes();
  function dayBounds(k) { const [y, m, d] = k.split('-').map(Number); return [new Date(y, m - 1, d).getTime(), new Date(y, m - 1, d + 1).getTime()]; }
  /* Clips an instant range to one local day → [start, end] wall-clock minutes, or null. */
  function clipToDay(startMs, endMs, k) {
    const [d0, d1] = dayBounds(k);
    if (!(endMs > d0 && startMs < d1)) return null;
    const s = startMs <= d0 ? 0 : minutesOf(new Date(startMs));
    const e = endMs >= d1 ? 1440 : minutesOf(new Date(endMs));
    return e > s ? [s, e] : null;
  }
  const isLocalFocus = (b) => b && !b.readOnly && b.kind === 'focus' && !b.hidden;

  /* prepare(snapshot) builds the planRange + study_items input from plain app data.
     snapshot = {now, from, to, settings, prefs, tasks, activeTaskID, blocks (local), events (imported timed items:
       {id, start, end, isBusy, allDay}; already visible/blocksTime-filtered and deduped), courses, assignments
       (unpromoted, not dismissed, not submitted), focusedTodayMinutes, completedPomodorosToday, estimateFor(a),
       ratioFor(course), realisticCap?}
     → {settings, days, study, virtual: {id: {type:'assignment'|'assessment', …}}, range: [from, to]} */
  function prepare(snap) {
    const now = new Date(snap.now || Date.now());
    const nowMs = now.getTime();
    const today = CalCore.dayKey(now);
    const st = snap.settings || {};
    const prefs = snap.prefs || {};
    const focus = int(st.focusMinutes) || 25;
    const settings = { focus, short: int(st.shortBreakMinutes) || 5, long: int(st.longBreakMinutes) || 15,
      interval: Math.max(1, int(st.longBreakInterval) || 4), dayStart: int(has(prefs, 'planDayStart') ? prefs.planDayStart : 480),
      dayEnd: int(has(prefs, 'planDayEnd') ? prefs.planDayEnd : 1320), buffer: int(has(prefs, 'eventBuffer') ? prefs.eventBuffer : 5),
      maxPlannedFocus: int(has(prefs, 'maxPlannedFocus') ? prefs.maxPlannedFocus : 300) };
    let from = snap.from || today, to = snap.to || from;
    if (CalCore.daysBetween(from, to) > 13) to = addDays(from, 13);
    if (to < from) to = from;
    const keys = [];
    for (let k = from; k <= to; k = addDays(k, 1)) keys.push(k);
    const week = Array.isArray(prefs.weekPlan) ? prefs.weekPlan : [];
    const local = (snap.blocks || []).filter((b) => b && !b.readOnly && !b.hidden && !b.allDay);
    const events = (snap.events || []).filter((e) => e && !e.allDay && e.isBusy !== false);
    const courses = (snap.courses || []).filter((c) => c && !c.archived);
    const days = keys.map((k) => {
      const rel = k < today ? 'past' : (k === today ? 'today' : 'future');
      const evs = [];
      for (const e of events) {
        const r = clipToDay(Date.parse(e.start), Date.parse(e.end), k);
        if (r) evs.push({ id: String(e.id), start: r[0], end: r[1], isBusy: true });
      }
      // course meeting times as busy time (§4.3)
      const wd = CalCore.weekday(k);
      for (const c of courses) {
        if (c.meetingsBlockTime === false) continue;
        if ((c.termStart && k < c.termStart) || (c.termEnd && k > c.termEnd)) continue;
        for (const m of c.meetingTimes || []) {
          if (m.weekday !== wd || !(m.end > m.start)) continue;
          const len = m.end - m.start;
          const dup = evs.some((e) => Math.min(e.end, m.end) - Math.max(e.start, m.start) >= 0.5 * len);
          if (!dup) evs.push({ id: `course:${c.id}:${wd}:${m.start}`, start: m.start, end: m.end, isBusy: true });
        }
      }
      const dayBlocks = [];
      let plannedRemaining = 0;
      for (const b of local) {
        const r = clipToDay(Date.parse(b.start), Date.parse(b.end), k);
        if (!r) continue;
        const poms = b.kind === 'focus' ? int(b.pomodoros) : 0;
        dayBlocks.push({ id: String(b.id), taskID: b.taskID || null, start: r[0], end: r[1], pomodoros: poms });
        if (b.kind === 'focus' && Date.parse(b.end) > nowMs) plannedRemaining += int(b.plannedFocusMinutes);
      }
      const d = { day: k, dayRelation: rel, nowMinutes: rel === 'today' ? minutesOf(now) : 0, events: evs, blocks: dayBlocks,
        focusedTodayMinutes: rel === 'today' ? int(snap.focusedTodayMinutes) : 0,
        completedPomodorosToday: rel === 'today' ? int(snap.completedPomodorosToday) : 0,
        plannedRemainingTodayMinutes: plannedRemaining };
      const wp = week.find((x) => x && x.weekday === wd);
      if (wp) {
        if (wp.off) d.off = true;
        if (Number.isFinite(wp.start)) d.dayStart = wp.start;
        if (Number.isFinite(wp.end)) d.dayEnd = wp.end;
        if (Number.isFinite(wp.maxFocus)) d.maxPlannedFocus = wp.maxFocus;
      }
      if (snap.realisticCap && rel !== 'past') d.maxPlannedFocus = Math.min(has(d, 'maxPlannedFocus') ? d.maxPlannedFocus : settings.maxPlannedFocus, snap.realisticCap);
      return d;
    });

    // work items (§4.1)
    const rangeEnd = keys[keys.length - 1];
    const studyTasks = [];
    const virtual = {};
    const allTasks = snap.tasks || [];
    allTasks.forEach((t, i) => {
      if (!t || t.isDone) return;
      let covered = 0;
      for (const b of snap.blocks || []) {
        if (isLocalFocus(b) && b.taskID && String(b.taskID).toLowerCase() === String(t.id).toLowerCase() && Date.parse(b.end) > nowMs) covered += int(b.pomodoros);
      }
      let dueMinutes = null;
      if (t.dueAt && t.dueDate) {
        const da = new Date(t.dueAt);
        if (!Number.isNaN(da.getTime()) && CalCore.dayKey(da) === t.dueDate) dueMinutes = minutesOf(da);
      }
      const x = { id: t.id, title: t.title, listIndex: i, estimate: int(t.estimate), completedPomodoros: int(t.completedPomodoros), covered };
      if (t.dueDate) x.dueDate = t.dueDate;
      if (dueMinutes !== null) x.dueMinutes = dueMinutes;
      if (snap.activeTaskID && String(snap.activeTaskID).toLowerCase() === String(t.id).toLowerCase()) x.active = true;
      if (t.courseID) x.courseID = t.courseID;
      if (t.courseKey) x.courseKey = t.courseKey;
      if (t.assessmentID) x.assessmentID = t.assessmentID;
      if (Array.isArray(t.planParts) && t.planParts.length) x.parts = t.planParts.map((p) => ({ label: p.label, pomodoros: p.pomodoros, earliest: p.earliest || '', doBy: p.doBy || '' }));
      studyTasks.push(x);
    });
    const virtualRows = [];
    const lo = addDays(today, -7), hi = addDays(rangeEnd, 7);
    const assessByExt = new Map();
    for (const c of courses) for (const a of c.assessments || []) if (a.externalID) assessByExt.set(String(a.externalID).toLowerCase(), { c, a });
    for (const a of snap.assignments || []) {
      if (!a || !a.dueDay || a.submitted === true || a.dueDay < lo || a.dueDay > hi) continue;
      const linked = assessByExt.get(String(a.id).toLowerCase()) || null;
      let estimate = snap.estimateFor ? int(snap.estimateFor(a)) : 2;
      if (linked && Number(linked.a.estHours) > 0) estimate = Math.max(1, Math.ceil(Number(linked.a.estHours) * 60 / focus - 1e-9));
      estimate = Math.min(12, Math.max(1, estimate || 1));
      const row = { id: 'assignment:' + a.id, title: cut((a.course ? a.course + ' · ' : '') + (a.title || 'Assignment'), 120), estimate,
        completedPomodoros: 0, covered: 0, dueDate: a.dueDay };
      if (has(a, 'dueMinutes')) row.dueMinutes = a.dueMinutes;
      if (a.courseKey) row.courseKey = a.courseKey;
      if (linked) { row.courseID = linked.c.id; row.assessmentID = linked.a.id; }
      else if (a.kind === 'exam' || a.kind === 'quiz') row.kind = a.kind;
      virtualRows.push({ row, v: { type: 'assignment', assignmentID: a.id, assignment: a } });
    }
    const assignmentIDs = new Set((snap.allAssignmentIDs || (snap.assignments || []).map((a) => a.id)).map((x) => String(x).toLowerCase()));
    for (const c of courses) {
      for (const a of c.assessments || []) {
        const fields = materialize(c, a, { today, rangeEnd, focusMinutes: focus, ratio: snap.ratioFor ? snap.ratioFor(c) : 1, assignmentIDs });
        fields.forEach((f, j) => {
          const id = 'assessment:' + a.id + (fields.length > 1 ? ':' + (j + 1) : '');
          const row = { id, title: f.title, estimate: f.estimate, completedPomodoros: 0, covered: 0, courseID: c.id, assessmentID: a.id, kind: f.kind };
          if (f.dueDate) row.dueDate = f.dueDate;
          if (f.dueMinutes !== null && f.dueMinutes !== undefined) row.dueMinutes = f.dueMinutes;
          virtualRows.push({ row, v: { type: 'assessment', courseID: c.id, assessmentID: a.id, fields: f } });
        });
      }
    }
    virtualRows.sort((x, y) => cmp([x.row.dueDate || '9999-12-31', has(x.row, 'dueMinutes') ? x.row.dueMinutes : 1440, x.row.id],
      [y.row.dueDate || '9999-12-31', has(y.row, 'dueMinutes') ? y.row.dueMinutes : 1440, y.row.id]));
    virtualRows.forEach(({ row, v }, i) => { row.listIndex = 10000 + i; studyTasks.push(row); virtual[row.id] = v; });

    const study = {
      today,
      tasks: studyTasks,
      courses: courses.map((c) => ({ id: c.id, courseKeys: (c.courseKeys || []).map((k) => String(k).toLowerCase()),
        examPrepDays: int(c.strategy && c.strategy.examPrepDays), readBeforeClass: !!(c.strategy && c.strategy.readBeforeClass),
        meetingTimes: (c.meetingTimes || []).map((m) => ({ weekday: m.weekday, start: m.start, end: m.end })),
        termStart: c.termStart || null, termEnd: c.termEnd || null })),
      assessments: courses.flatMap((c) => (c.assessments || []).map((a) => ({ id: a.id, courseID: c.id, type: a.type || 'other',
        due: a.due || null, weightPercent: has(a, 'weightPercent') ? a.weightPercent : null, steps: (a.steps || []).map((s) => ({ ...s })) }))),
    };
    return { settings, days, study, virtual, range: [from, to] };
  }

  return { items, applyHints, materialize, linkCourses, profile, prepare, kindFromTitle, courseFactor, split, eligible, titleScore };
})();
