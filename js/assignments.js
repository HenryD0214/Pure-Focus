/* ═══════════════════════════════════════════════════════════════════════
   assignments.js — due work from Canvas / Blackbaud / ICS → Today's Tasks (owner: W2)
   v2-calendar §3.3, §3.5, §3.6, §6.2–§6.4; SPEC-V2 §5.4 (V4: events never become
   tasks; due work does).

   Pure functions are exact ports of $SPEC/v2-calendar-ref.py and reproduce every
   case in v2-calendar-vectors.json (TOOLS/tests/w2-assignments.test.js, jsc).

   Cache (disposable, never synced, dropped 2nd on quota):
     pfKey('purefocus.assignments.v1') = {v:1, items:[Assignment], fetched:{feedID: iso},
                                           promoted:{assignmentID(lower): taskID}}

   const Assignments = {
     // pure (vectors)
     detectProvider(url?, prodid?)             → 'google'|'apple'|'icloud'|'canvas'|'blackbaud'|'outlook'|'samsung'|'ics'
     fromICS(event, feed)                      → Assignment | null
     promotions(assignments, tasks, dismissed, prefs, today, factors = null) → [actions, in order]
     estimatePomodoros(assignment, factor = 1, hint?) → Int 1…12
     courseFactor(samples)                     → Double (1 = no learning yet)
     dedupe(events)                            → events (winners, with alsoIn)
     splitCourse(summary)                      → [title, course|null]
     canvasAssignmentID(uid, url)              → String | null
     // cache + actions
     init()
     list({from, to, includeDismissed})        → [Assignment] (feeds that still exist)
     get(id)                                   → Assignment | null
     promote(ids)                              → [taskID]  (wraps its writes in Store.bulk)
     dismiss(id) · unpromote(ids) · courseKeys() → [String] · refreshPromotions() → actions applied
     replaceFeed(feedID, items, {full})        → used by Feeds after a fetch (D21 for vanished items)
     dropFeed(feedID)
     comingUp(days = 7)                        → unpromoted, undismissed, unsubmitted, due within N days
     isAssignmentTask(task)                    → bool (externalSource canvas|blackbaud|ics)
   }
   Events on the Store bus: 'assignments' (cache changed).
   ═══════════════════════════════════════════════════════════════════════ */

const Assignments = (() => {
  'use strict';

  const K_CACHE = 'purefocus.assignments.v1';
  const SOURCES = ['canvas', 'blackbaud', 'ics'];

  // ───────────────────────── pure: provider detection (§3.5) ─────────────────────────

  function detectProvider(url, prodid) {
    let host = '', path = '';
    if (url) {
      const m = /^(?:webcals?|https?):\/\/([^/?#:]+)(?::\d+)?([^?#]*)/i.exec(String(url).trim());
      if (m) { host = m[1].toLowerCase().replace(/\.+$/, ''); path = m[2]; }
    }
    if (host) {
      if (host.endsWith('.instructure.com') || /^\/feeds\/calendars\/(user|course|group)_/.test(path)) return 'canvas';
      if (host.endsWith('.myschoolapp.com') || host.includes('blackbaud')) return 'blackbaud';
      if (host === 'calendar.google.com' || host === 'www.google.com') return 'google';
      if (host.endsWith('.icloud.com')) return 'icloud';
      if (host.startsWith('outlook.') || host.endsWith('.outlook.com') || host.endsWith('office365.com') || host.endsWith('.live.com')) return 'outlook';
    }
    const p = String(prodid || '').toLowerCase();
    for (const [needle, prov] of [['instructure', 'canvas'], ['canvas', 'canvas'], ['blackbaud', 'blackbaud'],
      ['google', 'google'], ['apple', 'apple'], ['microsoft', 'outlook'], ['samsung', 'samsung']]) {
      if (p.includes(needle)) return prov;
    }
    return 'ics';
  }

  // ───────────────────────── pure: Canvas ICS → Assignment (§6.2) ─────────────────────────

  const COURSE_SUFFIX = /^([\s\S]*\S)\s+\[([^[\]]{1,80})\]\s*$/;
  const UID_ASSIGN = /^event-(assignment|sub-assignment|abstract-assignment)-(\d{1,15})$/i;
  const URL_ASSIGN = /(?:#(?:assignment|sub_assignment)_(\d{1,15})\b|\/assignments\/(\d{1,15})\b)/i;

  // Python str.strip() equivalent for the characters calendars use.
  const pyStrip = (s) => String(s == null ? '' : s).replace(/^\s+|\s+$/g, '');

  function splitCourse(summary) {
    const s = pyStrip(summary);
    const m = COURSE_SUFFIX.exec(s);
    if (m) return [pyStrip(m[1]), pyStrip(m[2])];
    return [s || '(No title)', null];
  }

  function canvasAssignmentID(uid, url) {
    if (uid) {
      const m = UID_ASSIGN.exec(pyStrip(uid));
      if (m) return m[2];
    }
    if (url) {
      const m = URL_ASSIGN.exec(String(url));
      if (m) return m[1] || m[2];
    }
    return null;
  }

  function classifyKind(title) {
    const t = String(title || '').toLowerCase();
    if (/\b(midterm|final exam|exam|test)\b/.test(t)) return 'exam';
    if (/\bquiz\b/.test(t)) return 'quiz';
    if (/\b(discussion|reply|respond|post)\b/.test(t)) return 'discussion';
    return 'assignment';
  }

  /* ev: {uid, summary, url, description, allDay, startDay, startISO, startDayLocal, startMinutes}
     feed: {id, provider, host, itemRole}. Returns an Assignment (the reference fields) or null (= an event). */
  function fromICS(ev, feed) {
    const e = ev || {};
    const f = feed || {};
    const provider = f.provider;
    const role = f.itemRole || 'auto';
    const [title, course] = splitCourse(e.summary || '');
    const aid = provider === 'canvas' ? canvasAssignmentID(e.uid, e.url) : null;
    if (role === 'events') return null;
    if (aid == null && role !== 'dueDates') return null;
    let id;
    if (provider === 'canvas' && aid != null) id = `canvas:${f.host}:a${aid}`;
    else id = `${f.id}:${e.uid || e.summary}`;
    if (e.recurring && !(provider === 'canvas' && aid != null)) id += `@${(e.allDay ? e.startDay : e.startDayLocal) ?? ''}`;   // each date of a series is its own due date
    const courseKey = course ? 'code:' + course.toLowerCase() : null;
    const allDay = !!e.allDay;
    const url = String(e.url || '').toLowerCase().startsWith('https://') ? e.url : null;
    return {
      id,
      source: provider === 'canvas' || provider === 'blackbaud' ? provider : 'ics',
      feedID: f.id,
      course,
      courseKey,
      title: title.slice(0, 120),
      due: allDay ? null : (e.startISO ?? null),
      dueDay: (allDay ? e.startDay : e.startDayLocal) ?? null,
      dueMinutes: allDay ? null : (e.startMinutes ?? null),
      points: null,
      url,
      kind: classifyKind(title),
      submitted: null,
      unlockDay: null,
      description: String(e.description || '').slice(0, 2000) || null,
    };
  }

  // ───────────────────────── pure: estimates (§6.4) ─────────────────────────

  function baseEstimate(a) {
    const kind = a.kind, pts = a.points, t = String(a.title || '').toLowerCase();
    let n;
    if (kind === 'exam') n = 4;
    else if (kind === 'quiz') n = 2;
    else if (kind === 'discussion') n = 1;
    else if (pts == null) n = 2;
    else if (pts <= 10) n = 1;
    else if (pts <= 30) n = 2;
    else if (pts <= 100) n = 3;
    else n = 4;
    if (/\b(essay|paper|report|project|lab report|research)\b/.test(t)) n = Math.max(n, 4);
    else if (/\b(read|reading|chapter|ch\.)\b/.test(t)) n = Math.max(n, 2);
    return n;
  }

  /* samples = [[estimate, actualPomodoros]] for the last ≤ 10 DONE assignment tasks of a course
     (most recent first). Needs ≥ 3 samples; median ratio clamped to [0.5, 2.5]; else 1.0. */
  function courseFactor(samples) {
    const rs = (Array.isArray(samples) ? samples : []).slice(0, 10)
      .filter((s) => Array.isArray(s) && s[0] > 0 && s[1] > 0)
      .map((s) => s[1] / s[0])
      .sort((a, b) => a - b);
    if (rs.length < 3) return 1.0;
    const mid = Math.floor(rs.length / 2);
    const med = rs.length % 2 ? rs[mid] : (rs[mid - 1] + rs[mid]) / 2;
    return Math.min(2.5, Math.max(0.5, med));
  }

  // Python round() (banker's rounding) for the AI hint path.
  function pyRound(x) {
    const f = Math.floor(x), d = x - f;
    if (Math.abs(d - 0.5) < 1e-12) return f % 2 === 0 ? f : f + 1;
    return Math.round(x);
  }

  function estimatePomodoros(a, factor = 1, hint = null) {
    if (hint && hint.estimatePomodoros && (hint.confidence || 0) >= 0.6) {
      return Math.min(12, Math.max(1, pyRound(hint.estimatePomodoros)));
    }
    const f = Number.isFinite(factor) ? factor : 1;
    return Math.min(12, Math.max(1, Math.floor(baseEstimate(a || {}) * f + 0.5)));
  }

  // ───────────────────────── pure: promotion (§6.3) ─────────────────────────

  function addDays(day, n) {
    const [y, m, d] = String(day).split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d + n));
    return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
  }

  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

  /* tasks: [{id, externalID, isDone, dueDate, title}]; prefs: {promoteAssignments, assignmentHorizonDays}. */
  function promotions(assignments, tasks, dismissed, prefs, today, factors = null) {
    const fac = factors || {};
    const byExt = new Map();
    for (const t of tasks || []) if (t && t.externalID) byExt.set(String(t.externalID).toLowerCase(), t);
    const dis = new Set((dismissed || []).map((d) => String(d).toLowerCase()));
    const p = prefs || {};
    const horizon = addDays(today, p.assignmentHorizonDays ?? 2);
    const floor = today;                    // already overdue: not turned into a new task (Today's Tasks hides overdue)
    const sorted = (assignments || []).slice().sort((x, y) =>
      cmp(x.dueDay || '9999-12-31', y.dueDay || '9999-12-31') || ((x.dueMinutes || 1440) - (y.dueMinutes || 1440)) || cmp(x.id, y.id));
    const out = [];
    const creating = new Set();             // the same assignment in two feeds makes one task
    for (const a of sorted) {
      const t = byExt.get(String(a.id).toLowerCase());
      if (t) {
        // `externalDoneSuppressed` is set when you uncheck an imported task by hand:
        // its feed stays linked for dates and titles, but never re-ticks it.
        if (a.submitted === true && !t.isDone && !t.externalDoneSuppressed) out.push({ action: 'complete', assignmentID: a.id, taskID: t.id });
        else if ((t.dueDate ?? null) !== (a.dueDay ?? null) || t.title !== a.title) {
          out.push({ action: 'update', assignmentID: a.id, taskID: t.id, dueDate: a.dueDay ?? null, title: a.title });
        }
        continue;
      }
      if (dis.has(String(a.id).toLowerCase()) || !(p.promoteAssignments ?? true)) continue;
      if (a.submitted === true || !a.dueDay) continue;
      if (floor <= a.dueDay && a.dueDay <= horizon && !creating.has(String(a.id).toLowerCase())) {
        creating.add(String(a.id).toLowerCase());
        const f = Object.prototype.hasOwnProperty.call(fac, a.courseKey) ? fac[a.courseKey] : 1.0;
        out.push({ action: 'create', assignmentID: a.id, title: a.title, dueDate: a.dueDay,
          estimate: estimatePomodoros(a, f), course: a.course ?? null });
      }
    }
    return out;
  }

  // ───────────────────────── pure: duplicates across sources (§3.6) ─────────────────────────

  // A school feed (Canvas, Blackbaud) is the event's home, so its copy wins over the same event
  // subscribed inside Google or Apple: the user sees it in the school calendar's colour, under its toggle.
  const SOURCE_RANK = { school: 0, google: 1, apple: 2, icsurl: 3, ics: 4 };

  function dedupeKey(e) {
    const uid = pyStrip(e.icalUID || '').toLowerCase();
    if (uid) return 'uid:' + uid + '|' + e.start;
    const title = pyStrip(e.title || '').toLowerCase().replace(/\s+/g, ' ');
    return 't:' + title + '|' + e.start + '|' + e.end + '|' + (e.allDay ? 'a' : 't');
  }

  function rankOf(e) { const r = SOURCE_RANK[e.sourceKind || 'ics']; return r == null ? 9 : r; }

  /* Keeps one event per key (callers pass VISIBLE feeds only), by SOURCE_RANK then feed id; the
     others are named in the winner's alsoIn. Never persisted. */
  function dedupe(events) {
    const list = (Array.isArray(events) ? events : []).slice()
      .sort((a, b) => (rankOf(a) - rankOf(b)) || cmp(a.calendarID || '', b.calendarID || '') || cmp(a.id, b.id));
    const best = new Map();
    for (const e of list) {
      const k = dedupeKey(e);
      const w = best.get(k);
      if (w) (w.alsoIn = w.alsoIn || []).push(e.calendarName || e.calendarID);
      else best.set(k, { ...e });
    }
    return Array.from(best.values()).sort((a, b) => cmp(a.start, b.start) || cmp(a.id, b.id));
  }

  // ───────────────────────── cache ─────────────────────────

  let cache = null;
  let loadedKey = null;
  const heldToasts = [];

  const key = () => (typeof pfKey === 'function' ? pfKey(K_CACHE) : K_CACHE);
  const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
  const lower = (s) => String(s == null ? '' : s).toLowerCase();

  function load() {
    const k = key();
    if (cache && loadedKey === k) return cache;
    let parsed = null;
    try { parsed = JSON.parse(localStorage.getItem(k) || 'null'); } catch (_) { parsed = null; }
    cache = {
      v: 1,
      items: isObj(parsed) && Array.isArray(parsed.items) ? parsed.items.filter((a) => isObj(a) && typeof a.id === 'string') : [],
      fetched: isObj(parsed) && isObj(parsed.fetched) ? parsed.fetched : {},
      promoted: isObj(parsed) && isObj(parsed.promoted) ? parsed.promoted : {},
    };
    loadedKey = k;
    return cache;
  }

  function save() {
    const json = JSON.stringify(cache);
    try {
      if (typeof Store !== 'undefined' && Store.safeSet) return Store.safeSet(key(), json);
      localStorage.setItem(key(), json);
      return true;
    } catch (_) { return false; }
  }

  function announce() { try { Store.emit('assignments'); } catch (_) { /* no bus */ } }

  function feedIDs() {
    try { return new Set(Store.calendar().feeds.map((f) => f.id)); } catch (_) { return new Set(); }
  }

  function dismissedSet() {
    try { return new Set(Store.calendar().dismissedAssignments.map(lower)); } catch (_) { return new Set(); }
  }

  function list({ from = null, to = null, includeDismissed = false } = {}) {
    const c = load();
    const ids = feedIDs();
    const dis = includeDismissed ? null : dismissedSet();
    return c.items.filter((a) => (!a.feedID || ids.has(a.feedID))
      && (!dis || !dis.has(lower(a.id)))
      && (!from || (a.dueDay && a.dueDay >= from))
      && (!to || (a.dueDay && a.dueDay <= to)));
  }

  function get(id) { return load().items.find((a) => lower(a.id) === lower(id)) || null; }

  function courseKeys() {
    return Array.from(new Set(list({ includeDismissed: true }).map((a) => a.courseKey).filter(Boolean))).sort();
  }

  function isAssignmentTask(t) { return !!(t && SOURCES.includes(t.externalSource) && t.externalID); }

  function linkedTask(aid) {
    try { return Store.tasks().find((t) => isAssignmentTask(t) && lower(t.externalID) === lower(aid)) || null; } catch (_) { return null; }
  }

  /* Replace one feed's assignments after a successful fetch. With {full: true} an assignment
     that vanished from the feed follows SPEC D21 for its linked open task: deleted when no
     session references it and nothing was focused on it, otherwise detached. {from, to} is the
     range of days the feed was read for: an item outside it has only aged out, not been removed. */
  function replaceFeed(feedID, items, { full = true, from = null, to = null } = {}) {
    const c = load();
    const now = new Date().toISOString();
    const prev = c.items.filter((a) => a.feedID === feedID);
    const prevById = new Map(prev.map((a) => [lower(a.id), a]));
    const seen = new Set();
    const next = [];
    for (const a of items || []) {
      if (!a || !a.id || seen.has(lower(a.id))) continue;
      seen.add(lower(a.id));
      const old = prevById.get(lower(a.id));
      const merged = { ...a, updatedAt: now };
      // REST-only fields survive an ICS refresh (v2-calendar §5.3: REST wins for these).
      if (old) for (const k of ['points', 'submitted', 'unlockDay']) if (old[k] != null && merged[k] == null) merged[k] = old[k];
      next.push(merged);
    }
    const inRange = (a) => !a.dueDay || ((!from || a.dueDay >= from) && (!to || a.dueDay <= to));
    const vanished = full ? prev.filter((a) => !seen.has(lower(a.id)) && inRange(a)) : [];
    c.items = c.items.filter((a) => a.feedID !== feedID).concat(next);
    c.fetched[feedID] = now;
    save();
    if (vanished.length) detachVanished(vanished);
    announce();
    return next.length;
  }

  function dropFeed(feedID) {
    const c = load();
    const before = c.items.length;
    c.items = c.items.filter((a) => a.feedID !== feedID);
    delete c.fetched[feedID];
    save();
    if (c.items.length !== before) announce();
  }

  /* An assignment left the feed (a teacher removed it, or the course ended). Never delete
     the user's task: detach the external link and keep the title, due date, notes and any
     focus history. The task then behaves like one you typed yourself and stays in Completed
     or Past due until you finish or remove it. */
  function detachVanished(vanished) {
    if (typeof Store === 'undefined') return;
    Store.bulk(() => {
      for (const a of vanished) {
        const aid = lower(a.id);
        const t = linkedTask(aid);
        delete load().promoted[aid];
        if (!t) continue;
        Store.updateTask(t.id, { externalSource: null, externalID: null, externalListID: null, externalUpdatedAt: null });
      }
    });
    save();
  }

  // ───────────────────────── learning (§6.4) ─────────────────────────

  function factors() {
    if (typeof Store === 'undefined') return {};
    const tasks = Store.tasks().filter((t) => t.isDone && isAssignmentTask(t) && t.courseKey);
    if (!tasks.length) return {};
    const actual = new Map();
    const last = new Map();
    for (const s of Store.sessions()) {
      if (s.mode !== 'focus' || !s.taskID) continue;
      const k = lower(s.taskID);
      actual.set(k, (actual.get(k) || 0) + 1);
      if (!last.has(k) || s.end > last.get(k)) last.set(k, s.end);
    }
    const byCourse = new Map();
    for (const t of tasks) {
      if (!byCourse.has(t.courseKey)) byCourse.set(t.courseKey, []);
      byCourse.get(t.courseKey).push({ est: t.estimate, n: actual.get(lower(t.id)) || 0, at: last.get(lower(t.id)) || t.createdAt || '' });
    }
    const out = {};
    for (const [ck, rows] of byCourse) {
      rows.sort((a, b) => cmp(b.at, a.at));
      const f = courseFactor(rows.map((r) => [r.est, r.n]));
      if (f !== 1) out[ck] = f;
    }
    return out;
  }

  // ───────────────────────── promotion (apply) ─────────────────────────

  function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function studyCategory() {
    try { return Store.categories().includes('Study') ? 'Study' : null; } catch (_) { return null; }
  }

  function taskIDFor(a) {
    try { if (typeof CloudRef !== 'undefined' && CloudRef.externalTaskID) return CloudRef.externalTaskID(a.source, a.id); } catch (_) {}
    return null;
  }

  // what you picked for this course before (js/tasks.js: type of work and location per course)
  function courseDefaults(a) {
    try {
      const all = JSON.parse(localStorage.getItem('purefocus.courseDefaults') || '{}') || {};
      return all[String(a.courseKey || a.course || '').trim().toLowerCase()] || {};
    } catch (_) { return {}; }
  }

  function createTask(a, estimate) {
    const id = taskIDFor(a);
    const def = courseDefaults(a);
    const defLocations = Array.isArray(def.locations) ? def.locations : (def.location ? [def.location] : []);
    const fields = {
      // 1 pomodoro to start (you change it on the task's ◷ chip; time on the calendar adjusts it) —
      // the points/keyword guess (estimatePomodoros) stays for planning, not for the task
      title: a.title, estimate: 1, category: def.category || studyCategory(), locations: defLocations,
      dueDate: a.dueDay || null, dueAt: a.due || null, course: a.course || null, courseKey: a.courseKey || null,
      points: a.points ?? null, url: a.url || null, externalSource: a.source, externalID: a.id,
      notes: a.description || null,     // the description travels with the task (its details sheet shows it)
    };
    if (id && !Store.tasks().some((t) => lower(t.id) === lower(id))) fields.id = id;
    const t = Store.addTask(fields, { append: true });
    if (t) load().promoted[lower(a.id)] = t.id;
    return t;
  }

  /* Promote these assignments now (＋ "Add to Today's Tasks", a kept plan). Returns the task
     ids (an existing linked task is returned as it is). One store write. */
  function promote(ids) {
    const out = [];
    if (typeof Store === 'undefined') return out;
    const fac = factors();
    Store.bulk(() => {
      for (const id of ids || []) {
        const a = get(id);
        if (!a) continue;
        const linked = linkedTask(a.id);
        if (linked) { out.push(linked.id); continue; }
        const dis = Store.calendar().dismissedAssignments || [];
        if (dis.some((d) => lower(d) === lower(a.id))) {
          Store.updateCalendar({ dismissedAssignments: dis.filter((d) => lower(d) !== lower(a.id)) });
        }
        const t = createTask(a, estimatePomodoros(a, fac[a.courseKey] ?? 1));
        if (t) out.push(t.id);
      }
    });
    save();
    return out;
  }

  /* Forget these promotions WITHOUT dismissing: Coach's Undo of a kept plan deletes the tasks it
     promoted, and the assignments must come back as they were (W3 request #44(5)). */
  function unpromote(ids) {
    const c = load();
    let n = 0;
    for (const id of ids || []) { const k = lower(id); if (k in c.promoted) { delete c.promoted[k]; n++; } }
    if (n) save();
    return n;
  }

  /* Deleting an auto-created task dismisses its assignment for good (v2-calendar §6.3). */
  function dismiss(id) {
    if (!id || typeof Store === 'undefined') return;
    delete load().promoted[lower(id)];
    save();
    const cur = Store.calendar().dismissedAssignments || [];
    if (cur.some((d) => lower(d) === lower(id))) return;
    Store.updateCalendar({ dismissedAssignments: cur.concat([lower(id)]) });
  }

  function focusing() {
    try { const s = Timer.state(); return !!(s && s.running && s.mode === 'focus'); } catch (_) { return false; }
  }

  function flushToasts() {
    if (focusing()) return;
    while (heldToasts.length) {
      const msg = heldToasts.shift();
      try { App.toast(msg, 'success'); } catch (_) { /* no toast host */ }
    }
  }

  function toastLater(msg) { heldToasts.push(msg); setTimeout(flushToasts, 0); }

  /* Runs §6.3 over the cache and applies the actions as ONE store write. Promoted tasks that
     were deleted elsewhere count as dismissed. Returns the applied actions. */
  function refreshPromotions() {
    if (typeof Store === 'undefined') return [];
    const c = load();
    const items = list();
    if (!items.length && !Object.keys(c.promoted).length) return [];
    const tasks = Store.tasks();
    const present = new Set(tasks.map((t) => lower(t.id)));
    const gone = Object.entries(c.promoted).filter(([, tid]) => !present.has(lower(tid))).map(([aid]) => aid);
    const prefs = Store.calendar().prefs;
    const fac = factors();
    let actions = [];
    Store.bulk(() => {
      for (const aid of gone) dismiss(aid);
      const linked = tasks.filter(isAssignmentTask).map((t) => ({ id: t.id, externalID: t.externalID, isDone: t.isDone,
        dueDate: t.dueDate, title: t.title, externalDoneSuppressed: !!t.externalDoneSuppressed }));
      actions = promotions(items, linked, Store.calendar().dismissedAssignments, prefs, todayKey(), fac);
      for (const act of actions) {
        const a = get(act.assignmentID);
        if (!a) continue;
        if (act.action === 'create') { if (feedVisible(a.feedID)) createTask(a, act.estimate); }    // a hidden calendar adds nothing
        else if (act.action === 'update') Store.updateTask(act.taskID, { title: act.title, dueDate: act.dueDate, dueAt: a.due || null });
        else if (act.action === 'complete') {
          const t = Store.tasks().find((x) => x.id === act.taskID);
          if (t && !t.isDone) {
            Store.toggleTaskDone(t.id);   // never un-completes: only reached when not done
            toastLater(`${a.course ? a.course + ' · ' : ''}${a.title} is marked submitted ✓`);
          }
        }
      }
    });
    save();
    return actions;
  }

  function feedVisible(id) {
    try { const f = Store.calendar().feeds.find((x) => x.id === id); return !f || f.isVisible !== false; } catch (_) { return true; }
  }

  /* Unpromoted, undismissed, unsubmitted assignments due from today through today + days − 1
     (the "N more due this week ›" row). */
  function comingUp(days = 7) {
    const today = todayKey();
    const end = addDays(today, Math.max(1, days) - 1);
    const linked = new Set();
    try { for (const t of Store.tasks()) if (isAssignmentTask(t)) linked.add(lower(t.externalID)); } catch (_) {}
    return list({ from: today, to: end })
      .filter((a) => !linked.has(lower(a.id)) && a.submitted !== true && feedVisible(a.feedID))
      .sort((x, y) => cmp(x.dueDay, y.dueDay) || ((x.dueMinutes ?? 1440) - (y.dueMinutes ?? 1440)) || cmp(x.id, y.id));
  }

  let lastDay = null;
  let inited = false;
  let prefSig = '';
  function sigOf() { try { const p = Store.calendar().prefs; return `${p.promoteAssignments}|${p.assignmentHorizonDays}`; } catch (_) { return ''; } }

  function init() {
    if (inited) return;
    inited = true;
    lastDay = todayKey();
    try {
      if (typeof Timer !== 'undefined' && Timer.on) {
        for (const ev of ['stop', 'complete', 'discard', 'pause', 'log']) Timer.on(ev, () => setTimeout(flushToasts, 400));
      }
    } catch (_) { /* timer hooks unavailable */ }
    prefSig = sigOf();
    try {
      Store.on('change', (kind) => {
        if (kind === 'reset' || kind === 'remote') {
          cache = null;
          // everything was cleared: what's added back is new, not something you deleted
          if (kind === 'reset' && !Store.tasks().length && Object.keys(load().promoted).length) { load().promoted = {}; save(); }
          announce();
        }
        // turning promotion back on, or a longer horizon, applies at once
        const s = sigOf();
        if (s !== prefSig) { prefSig = s; if (load().items.length) setTimeout(refreshPromotions, 0); }
      });
    } catch (_) { /* no store */ }
    // Day change: re-run the horizon (and the overdue floor).
    setInterval(() => {
      const d = todayKey();
      if (d !== lastDay) { lastDay = d; refreshPromotions(); announce(); }
    }, 60000);
    if (load().items.length) refreshPromotions();
  }

  return {
    detectProvider, fromICS, promotions, estimatePomodoros, courseFactor, dedupe, splitCourse, canvasAssignmentID,
    classifyKind, dedupeKey,
    init, list, get, promote, unpromote, dismiss, courseKeys, refreshPromotions, replaceFeed, dropFeed, comingUp,
    isAssignmentTask, factors,
  };
})();
