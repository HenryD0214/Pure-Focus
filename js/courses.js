/* ═══════════════════════════════════════════════════════════════════════
   courses.js — Courses: the Calendar sidebar section, the Course sheet, feed
   course suggestions + dismissals, deterministic linking (v2-ai §3.6), the
   ingestion UI (§3, item 6) and the Planner & courses card in Settings ›
   Calendar & Accounts (§8.4) (owner: W3)

   const Courses = {
     init()            registers CalendarView.registerSidebarSection({id:'courses', …}) and the
                       Study coach card (Settings.registerCard('calendar', {id:'coach', …}))
     list()            → [Course] (Store.courses())
     open(id?, tab?)   opens the Course sheet (a new course when id is omitted)
     manage()          the "Courses…" list sheet (suggestions, every course, Add course)
     mountSidebar(el)  renders the Courses sidebar section into el
     visible()         → bool: ≥ 1 course or a Canvas/Blackbaud feed exists (v2-ai §8.2)
     suggestions()     → [{courseKey, name, code, provider, count}]
     relink()          runs §3.6 now (keys, links, promoted-task links, done status); one Store.bulk
     deleteAll()       Delete all course data (courses + task links; tasks stay)
     colorOf(course)   → the course colour (its own, else from the code) · label(course) → code or name
     newCourse(fields) → a blank course object (Store.upsertCourse saves it)
   }
   Imported, AI and user strings render through textContent only; innerHTML is used
   only for the static SVG icons below.
   ═══════════════════════════════════════════════════════════════════════ */

const Courses = (() => {
  'use strict';
  const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
  const TYPES = ['exam', 'quiz', 'assignment', 'paper', 'project', 'lab', 'reading', 'presentation', 'participation', 'other'];
  const TYPE_LABEL = { exam: 'Exam', quiz: 'Quiz', assignment: 'Assignment', paper: 'Paper', project: 'Project', lab: 'Lab', reading: 'Reading',
    presentation: 'Presentation', participation: 'Participation', other: 'Other' };
  const MEET_KINDS = ['lecture', 'lab', 'section', 'seminar', 'other'];
  const PROVIDER = { canvas: 'Canvas', blackbaud: 'Blackbaud', ics: 'your calendars' };
  const EMPTY_KEY = 'purefocus.courses.emptyHint';
  const ICONS = {
    plus: '<svg viewBox="0 0 20 20"><path d="M10 4.5v11M4.5 10h11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    close: '<svg viewBox="0 0 20 20"><path d="m5.5 5.5 9 9m0-9-9 9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    more: '<svg viewBox="0 0 20 20"><g fill="currentColor"><circle cx="5" cy="10" r="1.5"/><circle cx="10" cy="10" r="1.5"/><circle cx="15" cy="10" r="1.5"/></g></svg>',
    chevD: '<svg viewBox="0 0 20 20"><path d="m6 8 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    link: '<svg viewBox="0 0 20 20"><path d="M8.6 11.4a3 3 0 0 0 4.2 0l2.4-2.4a3 3 0 0 0-4.2-4.2l-.9.9M11.4 8.6a3 3 0 0 0-4.2 0L4.8 11a3 3 0 0 0 4.2 4.2l.9-.9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    doc: '<svg viewBox="0 0 20 20"><path d="M5.5 2.8h5.7l3.8 3.8v9.1a1.5 1.5 0 0 1-1.5 1.5h-8a1.5 1.5 0 0 1-1.5-1.5V4.3a1.5 1.5 0 0 1 1.5-1.5Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M11 3v3.8h3.8" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
    trash: '<svg viewBox="0 0 20 20"><path d="M4 6h12M8 6V4.5h4V6m-6.5 0 .7 9.6A1.5 1.5 0 0 0 7.7 17h4.6a1.5 1.5 0 0 0 1.5-1.4L14.5 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    sparkles: '<svg viewBox="0 0 20 20"><path d="M9 2.6c.55 3.9 1.75 5.1 5.65 5.65-3.9.55-5.1 1.75-5.65 5.65-.55-3.9-1.75-5.1-5.65-5.65C7.25 7.7 8.45 6.5 9 2.6Z" fill="currentColor"/><path d="M15.1 12.2c.27 1.62.75 2.1 2.37 2.37-1.62.27-2.1.75-2.37 2.37-.27-1.62-.75-2.1-2.37-2.37 1.62-.27 2.1-.75 2.37-2.37Z" fill="currentColor"/></svg>',
  };

  let inited = false;
  let sidebarEl = null;
  let sheet = null;          // {el, backdrop, draft, isNew, tab, open:Set, ingest}
  let relinkTimer = 0, relinking = false;
  const cardEls = new Set();

  // ───────────────────────── helpers ─────────────────────────
  const lower = (s) => String(s == null ? '' : s).toLowerCase();
  const sameID = (a, b) => a != null && b != null && lower(a) === lower(b);
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const today = () => CalCore.dayKey(new Date());
  const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    let value;
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'value') value = v;
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
    if (value !== undefined) el.value = value;
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
  const F = { dow: fmt({ weekday: 'short' }), md: fmt({ month: 'short', day: 'numeric' }), time: fmt({ hour: 'numeric', minute: '2-digit' }),
    dowLong: fmt({ weekday: 'long' }) };
  const dateOf = (k, min = 0) => { const [y, m, d] = String(k).split('-').map(Number); return new Date(y, m - 1, d, 0, min); };
  const WD = Array.from({ length: 7 }, (_, i) => F.dow.format(new Date(2026, 9, 18 + i)));   // Sun … Sat
  const hhmm = (min) => String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
  const fromHHMM = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '')); return m ? Math.min(1439, +m[1] * 60 + +m[2]) : null; };
  const timeText = (min) => F.time.format(new Date(2026, 0, 1, 0, min));
  function toast(msg, variant) { try { App.toast(msg, variant); } catch (_) { /* no toast host */ } }
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(pfKey(k)); localStorage.setItem(pfKey(k), v); } catch (_) {} return null; }
  const label = (c) => (c && (String(c.code || '').trim() || String(c.name || '').trim())) || 'Course';
  function colorOf(c) {
    try { const hex = CalendarView.courseHex(c); if (hex) return hex; } catch (_) { /* the calendar isn't loaded */ }  // same colour as on the calendar
    if (c && c.colorHex) return c.colorHex;
    const scheme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
    return CalCore.categoryColor(label(c), scheme) || 'var(--accent)';
  }

  // ───────────────────────── model ─────────────────────────
  function newCourse(f = {}) {
    const now = new Date().toISOString();
    return {
      id: Store.uid(), name: '', code: '', term: '', instructor: '', colorHex: null, termStart: null, termEnd: null,
      meetingTimes: [], meetingsBlockTime: true, assessments: [], workload: { hoursPerWeek: 0, text: '' },
      strategy: { summary: '', tips: [], examPrepDays: 0, readBeforeClass: false }, courseKeys: [], sources: [], archived: false,
      createdAt: now, updatedAt: now, ...f,
    };
  }
  function newAssessment(f = {}) {
    return { id: Store.uid(), title: '', type: 'assignment', due: null, dueTime: null, weightPercent: null, estHours: null, topics: [], prep: '',
      steps: [], confidence: 'high', evidence: '', source: 'manual', externalID: null, taskIDs: [], status: 'upcoming', editedAt: null, ...f };
  }
  /* Lenient normaliser for stored / imported courses (decode leniently, v2-ai §2.1). */
  function norm(c) {
    const base = newCourse();
    const out = { ...base, ...c };
    out.name = clip(String(out.name || '').trim(), 80);
    out.code = clip(String(out.code || '').trim(), 24);
    out.term = clip(out.term || '', 40);
    out.instructor = clip(out.instructor || '', 80);
    out.meetingTimes = (Array.isArray(out.meetingTimes) ? out.meetingTimes : []).filter((m) => m && m.end > m.start).slice(0, 12);
    out.assessments = (Array.isArray(out.assessments) ? out.assessments : []).slice(0, 80).map((a) => ({ ...newAssessment(), ...a,
      taskIDs: Array.isArray(a.taskIDs) ? a.taskIDs : [], steps: Array.isArray(a.steps) ? a.steps.slice(0, 6) : [] }));
    out.workload = { ...base.workload, ...(out.workload || {}) };
    out.strategy = { ...base.strategy, ...(out.strategy || {}) };
    out.courseKeys = Array.from(new Set((out.courseKeys || []).map(lower))).slice(0, 8);
    out.sources = (Array.isArray(out.sources) ? out.sources : []).slice(-30);
    return out;
  }
  function list() { try { return Store.courses().slice(); } catch (_) { return []; } }
  function active() { return list().filter((c) => !c.archived); }
  function get(id) { return list().find((c) => sameID(c.id, id)) || null; }

  function assignmentsAll() {
    try { return typeof Assignments !== 'undefined' && Assignments.list ? Assignments.list({ includeDismissed: true }) : []; } catch (_) { return []; }
  }
  /* H14: Courses is always discoverable in the Calendar sidebar (an empty section is one hint + "Add course"). */
  function visible() { return true; }
  function providerOf(a) {
    try { const f = (Store.calendar().feeds || []).find((x) => sameID(x.id, a.feedID)); if (f && f.provider) return f.provider; } catch (_) {}
    return a.source || 'ics';
  }
  function linkActions() {
    const cal = Store.calendar() || {};
    return StudyPlan.linkCourses(list(), assignmentsAll(), { dismissedCourseKeys: cal.dismissedCourseKeys || [],
      dismissedAssignments: cal.dismissedAssignments || [], providerOf });
  }
  function suggestions() { try { return linkActions().filter((a) => a.kind === 'suggest'); } catch (_) { return []; } }

  // ───────────────────────── §3.6 linking (+ §3.7 promoted links, done status) ─────────────────────────
  function relink() {
    if (relinking) return 0;
    relinking = true;
    let writes = 0;
    try {
      const acts = linkActions().filter((a) => a.kind !== 'suggest');
      const byCourse = new Map();
      for (const a of acts) { if (!byCourse.has(a.courseID)) byCourse.set(a.courseID, []); byCourse.get(a.courseID).push(a); }
      const tasks = Store.tasks();
      const updates = [];
      for (const c of list()) {
        const next = clone(c);
        let changed = false;
        for (const a of byCourse.get(c.id) || []) {
          if (a.kind === 'key' && !next.courseKeys.map(lower).includes(lower(a.courseKey))) { next.courseKeys.push(lower(a.courseKey)); changed = true; }
          if (a.kind === 'link') {
            const as = next.assessments.find((x) => sameID(x.id, a.assessmentID));
            if (as && !as.externalID) { as.externalID = a.assignmentID; changed = true; }
          }
        }
        // marking every linked task done sets the assessment done (v2-ai §3.7)
        for (const as of next.assessments) {
          if (as.status !== 'upcoming' || !(as.taskIDs || []).length) continue;
          const linked = as.taskIDs.map((id) => tasks.find((t) => sameID(t.id, id))).filter(Boolean);
          if (linked.length && linked.length === as.taskIDs.length && linked.every((t) => t.isDone)) { as.status = 'done'; changed = true; }
        }
        if (changed) updates.push(next);
      }
      // promoted tasks whose externalID is a linked assessment get courseID/assessmentID once
      const taskLinks = [];
      for (const c of list()) {
        for (const as of c.assessments || []) {
          if (!as.externalID) continue;
          const t = tasks.find((x) => x.externalID && sameID(x.externalID, as.externalID));
          if (t && !t.assessmentID && !t.courseID) taskLinks.push({ id: t.id, courseID: c.id, assessmentID: as.id });
        }
      }
      if (updates.length || taskLinks.length) {
        Store.bulk(() => {
          for (const c of updates) Store.upsertCourse(c);
          for (const l of taskLinks) Store.updateTask(l.id, { courseID: l.courseID, assessmentID: l.assessmentID });
        });
        writes = updates.length + taskLinks.length;
      }
    } catch (err) {
      console.error('Courses.relink failed', err);
    } finally { relinking = false; }
    return writes;
  }
  function scheduleRelink() {
    clearTimeout(relinkTimer);
    relinkTimer = setTimeout(() => { relink(); renderSidebar(); }, 60);
  }

  function addSuggested(rows) {
    const created = [];
    Store.bulk(() => {
      for (const s of rows) {
        const c = Store.upsertCourse(newCourse({ name: clip(s.name || s.code || 'Course', 80), code: clip(s.code || '', 24), courseKeys: [lower(s.courseKey)] }));
        if (c) created.push(c);
      }
    });
    relink();
    toast(`${created.length === 1 ? 'Added 1 course' : `Added ${created.length} courses`}`, 'success');
    renderSidebar();
    return created;
  }
  function dismissSuggestions(rows) {
    const cur = (Store.calendar().dismissedCourseKeys || []).slice();
    for (const s of rows) if (!cur.map(lower).includes(lower(s.courseKey))) cur.push(lower(s.courseKey));
    Store.updateCalendar({ dismissedCourseKeys: cur });
    renderSidebar();
  }

  // ───────────────────────── next assessment chip ─────────────────────────
  function nextDue(c) {
    const t = today();
    const keys = new Set((c.courseKeys || []).map(lower));
    const cands = [];
    for (const a of c.assessments || []) if (a.status === 'upcoming' && a.due && a.due >= t) cands.push({ title: a.title, due: a.due, ext: a.externalID });
    const linked = new Set(cands.map((x) => lower(x.ext)).filter(Boolean));
    for (const a of assignmentsAll()) {
      if (!a.courseKey || !keys.has(lower(a.courseKey)) || a.submitted === true || !a.dueDay || a.dueDay < t || linked.has(lower(a.id))) continue;
      cands.push({ title: a.title, due: a.dueDay });
    }
    cands.sort((x, y) => (x.due < y.due ? -1 : x.due > y.due ? 1 : 0));
    return cands[0] || null;
  }
  function dueWord(k) {
    const t = today();
    if (k === t) return 'Today';
    if (k === CalCore.addDays(t, 1)) return 'Tmrw';
    if (CalCore.daysBetween(t, k) < 7) return F.dow.format(dateOf(k));
    return F.md.format(dateOf(k));
  }

  // ───────────────────────── sidebar section (v2-ai §8.2) ─────────────────────────
  function mountSidebar(el) {
    sidebarEl = el || sidebarEl;
    renderSidebar();
  }
  function renderSidebar() {
    const el = sidebarEl;
    if (!el) return;
    el.textContent = '';
    if (!visible()) return;
    el.classList.add('pf-courses');
    const sugg = suggestions();
    const courses = active();
    for (const c of courses) {
      const nd = nextDue(c);
      const soon = nd && CalCore.daysBetween(today(), nd.due) <= 3;
      const row = h('div', { class: 'pf-course-row', role: 'button', tabindex: '0', 'aria-label': `${label(c)}${nd ? ', next: ' + nd.title + ' ' + dueWord(nd.due) : ''}`,
        onclick: () => open(c.id), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(c.id); } } },
      h('span', { class: 'pf-course-dot', vars: { '--ev': colorOf(c) } }),
      h('span', { class: 'pf-course-name', text: label(c) }),
      nd ? h('span', { class: 'pf-course-next' + (soon ? ' is-soon' : ''), text: `${clip(nd.title, 16)} · ${dueWord(nd.due)}` }) : null,
      h('button', { class: 'pf-course-more', type: 'button', 'aria-label': `More for ${label(c)}`, onclick: (e) => { e.stopPropagation(); rowMenu(c, e.currentTarget); } }, icon('more')));
      dropTarget(row, (files) => open(c.id, 'sources', { files }));
      el.appendChild(row);
    }
    if (sugg.length) {
      const by = new Map();
      for (const s of sugg) { const p = PROVIDER[s.provider] || PROVIDER.ics; by.set(p, (by.get(p) || []).concat([s])); }
      for (const [prov, rows] of by) {
        el.appendChild(h('div', { class: 'pf-course-sugg' },
          h('button', { class: 'pf-link', type: 'button', onclick: () => addSuggested(rows) },
            `${rows.length === 1 ? '1 course' : rows.length + ' courses'} found in ${prov} · Add`),
          h('button', { class: 'pf-x', type: 'button', 'aria-label': 'Dismiss course suggestions', title: 'Dismiss', onclick: () => dismissSuggestions(rows) }, icon('close'))));
      }
    }
    if (!courses.length && !sugg.length && store(EMPTY_KEY) !== '1') {
      el.appendChild(h('div', { class: 'pf-course-empty' },
        h('span', { text: 'Add your classes, then tag calendar events and tasks with them so each class has its own colour.' }),
        h('span', { class: 'pf-course-empty-actions' },
          h('button', { class: 'pf-x', type: 'button', 'aria-label': 'Hide this hint', title: 'Hide this hint', onclick: () => { store(EMPTY_KEY, '1'); renderSidebar(); } }, icon('close')))));
    }
    el.appendChild(h('button', { class: 'pf-course-add', type: 'button', onclick: () => open() }, icon('plus'), 'Add course'));
    dropTarget(el, (files) => open(undefined, 'sources', { files }), true);
  }
  function dropTarget(node, onFiles, isSection) {
    node.addEventListener('dragover', (e) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
      e.preventDefault();
      node.classList.add('is-drop');
    });
    node.addEventListener('dragleave', () => node.classList.remove('is-drop'));
    node.addEventListener('drop', (e) => {
      node.classList.remove('is-drop');
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      if (!files.length) return;
      e.preventDefault();
      if (isSection && e.defaultPrevented && e.target !== node && e.target.closest && e.target.closest('.pf-course-row')) return;
      e.stopPropagation();
      onFiles(files);
    });
  }
  function rowMenu(c, anchor) {
    closeMenus();
    const menu = h('div', { class: 'pf-menu pf-course-menu', role: 'menu' },
      h('button', { class: 'pf-menu-item', type: 'button', role: 'menuitem', onclick: () => { closeMenus(); open(c.id); } },
        h('span', { class: 'pf-menu-check' }), h('span', { class: 'pf-menu-label', text: 'Edit' })),
      h('button', { class: 'pf-menu-item', type: 'button', role: 'menuitem', onclick: () => {
        closeMenus();
        Store.upsertCourse({ ...clone(c), archived: true });
        toast(`Archived ${label(c)}`);
        renderSidebar();
      } }, h('span', { class: 'pf-menu-check' }), h('span', { class: 'pf-menu-label', text: 'Archive' })));
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.width = '180px';
    menu.style.left = Math.max(8, Math.min(window.innerWidth - 188, r.right - 180)) + 'px';
    menu.style.top = (r.bottom + 4) + 'px';
    menu.querySelector('button').focus();
    setTimeout(() => document.addEventListener('pointerdown', outsideMenus, true), 0);
    menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });
  }
  function outsideMenus(e) { if (!e.target.closest || !e.target.closest('.pf-course-menu')) closeMenus(); }
  function closeMenus() {
    document.querySelectorAll('.pf-course-menu').forEach((m) => m.remove());
    document.removeEventListener('pointerdown', outsideMenus, true);
  }

  // ───────────────────────── sheets ─────────────────────────
  function openSheetShell(title, cls) {
    closeSheet();
    const backdrop = h('div', { class: 'pf-sheet-backdrop', onclick: () => closeSheet(true) });
    const el = h('div', { class: 'pf-sheet ' + (cls || ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSheet(true); } });
    document.body.append(backdrop, el);
    sheet = { el, backdrop };
    return sheet;
  }
  function closeSheet(ask) {
    if (!sheet) return;
    if (ask && sheet.dirty && !window.confirm('Discard your changes to this course?')) return;
    try { if (sheet.ingest && sheet.ingest.cancel) sheet.ingest.cancel(); } catch (_) {}
    sheet.el.remove();
    sheet.backdrop.remove();
    sheet = null;
  }

  /* "Courses…": suggestions + every course + Add course. */
  function manage() {
    const s = openSheetShell('Courses', 'pf-sheet-list');
    const body = h('div', { class: 'pf-sheet-body' });
    s.el.append(h('div', { class: 'pf-sheet-head' }, h('h2', { class: 'pf-sheet-title', text: 'Courses' }),
      h('button', { class: 'pf-icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => closeSheet() }, icon('close'))), body);
    const sugg = suggestions();
    if (sugg.length) {
      body.appendChild(h('div', { class: 'pf-callout' },
        h('span', { text: `${sugg.length === 1 ? '1 course' : sugg.length + ' courses'} found in your school calendars: ${sugg.map((x) => x.code || x.name).join(', ')}` }),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { addSuggested(sugg); manage(); } }, 'Add all')));
    }
    const all = list();
    if (!all.length) body.appendChild(h('p', { class: 'pf-muted', text: 'No courses yet. Add one by hand: its name, class times, and each exam or assignment with its due date.' }));
    for (const c of all) {
      body.appendChild(h('button', { class: 'pf-list-row', type: 'button', onclick: () => open(c.id) },
        h('span', { class: 'pf-course-dot', vars: { '--ev': colorOf(c) } }),
        h('span', { class: 'pf-list-main' }, h('span', { class: 'pf-list-title', text: c.name || label(c) }),
          h('span', { class: 'pf-list-sub', text: [c.code, c.term, `${(c.assessments || []).length} graded items`].filter(Boolean).join(' · ') + (c.archived ? ' · archived' : '') }))));
    }
    s.el.appendChild(h('div', { class: 'pf-sheet-foot' }, h('span', { class: 'pf-flex' }),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => open() }, icon('plus'), 'Add course')));
    s.el.querySelector('button').focus();
  }

  /* The Course sheet (v2-ai §8.3). Edits a draft; Save writes once. */
  function open(id, tab, extra = {}) {
    const existing = id ? get(id) : null;
    const draft = norm(existing ? clone(existing) : newCourse());
    const s = openSheetShell(existing ? label(existing) : 'New course', 'pf-course-sheet');
    s.draft = draft;
    s.isNew = !existing;
    s.tab = tab || 'overview';
    if (s.tab === 'sources' && !sourcesTab(draft)) s.tab = 'assessments';
    s.openRows = new Set();
    renderCourseSheet();
    if (extra.files && extra.files.length) {
      if (coachConnected()) startIngest({ files: extra.files });
      else toast('Files aren’t read automatically — type the graded items in under Graded items');
    }
    const nm = s.el.querySelector('.pf-cs-name');
    if (nm && s.isNew) nm.focus();
    return true;
  }
  function markDirty() { if (sheet) sheet.dirty = true; }

  function renderCourseSheet() {
    if (!sheet || !sheet.draft) return;
    const d = sheet.draft;
    const el = sheet.el;
    const scroll = el.querySelector('.pf-sheet-body') ? el.querySelector('.pf-sheet-body').scrollTop : 0;
    el.textContent = '';
    // header
    const swatches = h('div', { class: 'pf-swatches', role: 'radiogroup', 'aria-label': 'Course colour' },
      SERIES.map((hex, i) => h('button', { class: 'pf-swatch' + (lower(d.colorHex) === hex ? ' is-on' : ''), type: 'button', role: 'radio',
        'aria-checked': String(lower(d.colorHex) === hex), 'aria-label': `Colour ${i + 1}`, vars: { '--sw': colorOf({ colorHex: hex }) },
        onclick: () => { d.colorHex = hex; markDirty(); renderCourseSheet(); } })),
      h('button', { class: 'pf-swatch is-auto' + (!d.colorHex ? ' is-on' : ''), type: 'button', role: 'radio', 'aria-checked': String(!d.colorHex),
        title: 'From the course code', 'aria-label': 'Automatic colour', onclick: () => { d.colorHex = null; markDirty(); renderCourseSheet(); } }, 'A'));
    const name = h('input', { class: 'pf-cs-name', type: 'text', maxlength: '80', placeholder: 'Course name', value: d.name, 'aria-label': 'Course name',
      oninput: (e) => { d.name = e.target.value; markDirty(); } });
    const code = h('input', { class: 'pf-cs-small', type: 'text', maxlength: '24', placeholder: 'Code, e.g. BIO 201', value: d.code, 'aria-label': 'Course code',
      oninput: (e) => { d.code = e.target.value; markDirty(); } });
    const term = h('input', { class: 'pf-cs-small', type: 'text', maxlength: '40', placeholder: 'Term, e.g. Fall 2026', value: d.term, 'aria-label': 'Term',
      oninput: (e) => { d.term = e.target.value; markDirty(); } });
    const feeds = (d.courseKeys || []).map((k) => h('span', { class: 'pf-feedchip', text: feedChip(k) }));
    el.appendChild(h('div', { class: 'pf-sheet-head pf-cs-head' },
      h('span', { class: 'pf-cs-dot', vars: { '--ev': colorOf(d) } }),
      h('div', { class: 'pf-cs-titles' }, name, h('div', { class: 'pf-cs-meta' }, code, term), feeds.length ? h('div', { class: 'pf-cs-feeds' }, feeds) : null),
      h('button', { class: 'pf-icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => closeSheet(true) }, icon('close'))));
    swatches.prepend(h('span', { class: 'pf-sw-label', text: 'Colour' }));
    el.appendChild(swatches);
    // tabs
    const tabs = [['overview', 'Overview'], ['assessments', `Graded items${d.assessments.length ? ' (' + d.assessments.length + ')' : ''}`]];
    if (sourcesTab(d)) tabs.push(['sources', 'Syllabus files']);
    if (sheet.tab === 'sources' && !sourcesTab(d)) sheet.tab = 'assessments';
    el.appendChild(h('div', { class: 'pf-tabs', role: 'tablist' }, tabs.map(([k, t]) => h('button', { class: 'pf-tab' + (sheet.tab === k ? ' is-on' : ''), type: 'button',
      role: 'tab', 'aria-selected': String(sheet.tab === k), onclick: () => { sheet.tab = k; renderCourseSheet(); } }, t))));
    const body = h('div', { class: 'pf-sheet-body' });
    if (sheet.ingest && sheet.ingest.review) body.appendChild(renderReview());
    else if (sheet.tab === 'assessments') body.appendChild(renderAssessments(d));
    else if (sheet.tab === 'sources') body.appendChild(renderSources(d));
    else body.appendChild(renderOverview(d));
    el.appendChild(body);
    body.scrollTop = scroll;
    // footer
    const foot = h('div', { class: 'pf-sheet-foot' });
    if (sheet.ingest && sheet.ingest.review) {
      foot.append(h('span', { class: 'pf-flex' }),
        h('button', { class: 'btn', type: 'button', onclick: () => { sheet.ingest = null; renderCourseSheet(); } }, 'Discard'),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => saveReview() }, 'Save course'));
    } else {
      if (!sheet.isNew) foot.appendChild(h('button', { class: 'btn btn-quiet-danger pf-cs-delete', type: 'button', onclick: () => deleteCourse(d) }, icon('trash'), 'Delete'));
      foot.append(h('span', { class: 'pf-flex' }),
        h('button', { class: 'btn', type: 'button', onclick: () => closeSheet(true) }, 'Cancel'),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => save() }, sheet.isNew ? 'Add course' : 'Save'));
    }
    el.appendChild(foot);
  }
  function feedChip(k) {
    const m = /^canvas:([^:]+):c(\d+)$/.exec(k);
    if (m) return `Canvas · course ${m[2]}`;
    if (k.startsWith('code:')) {
      const a = assignmentsAll().find((x) => lower(x.courseKey) === k);
      const p = a ? (PROVIDER[providerOf(a)] || 'Calendar') : 'Calendar';
      return `${p === 'your calendars' ? 'Calendar' : p} · ${(a && a.course) || k.slice(5).toUpperCase()}`;
    }
    return k;
  }

  /* Optional date/time: WebKit paints an empty date/time input with today's value, so empty ones are text
     inputs with a "Not set" placeholder that become date/time pickers on focus. */
  function optInput(type, value, onChange, aria, cls) {
    const el = h('input', { class: 'pf-input' + (cls ? ' ' + cls : ''), type: value ? type : 'text', value: value || '', placeholder: 'Not set', 'aria-label': aria,
      onfocus: (e) => { if (e.target.type !== type) e.target.type = type; },
      onblur: (e) => { if (!e.target.value) e.target.type = 'text'; },
      onchange: (e) => onChange(e.target.value || '') });
    return el;
  }
  function field(labelText, control, hint) {
    return h('label', { class: 'pf-field' }, h('span', { class: 'pf-field-label', text: labelText }), control, hint ? h('span', { class: 'pf-field-hint', text: hint }) : null);
  }
  function renderOverview(d) {
    const box = h('div', { class: 'pf-cs-pane' });
    // meeting times
    const mt = h('div', { class: 'pf-cs-section' }, h('div', { class: 'pf-overline', text: 'Meeting times' }));
    d.meetingTimes.forEach((m, i) => {
      mt.appendChild(h('div', { class: 'pf-meet-row' },
        h('select', { class: 'pf-input pf-w-day', 'aria-label': 'Day', onchange: (e) => { m.weekday = +e.target.value; markDirty(); } },
          WD.map((w, j) => { const o = h('option', { value: String(j), text: w }); if (j === m.weekday) o.selected = true; return o; })),
        h('input', { class: 'pf-input pf-w-time', type: 'time', value: hhmm(m.start), 'aria-label': 'Starts', onchange: (e) => { const v = fromHHMM(e.target.value); if (v != null) { m.start = v; markDirty(); } } }),
        h('span', { class: 'pf-muted', text: '–' }),
        h('input', { class: 'pf-input pf-w-time', type: 'time', value: hhmm(m.end), 'aria-label': 'Ends', onchange: (e) => { const v = fromHHMM(e.target.value); if (v != null) { m.end = v; markDirty(); } } }),
        h('select', { class: 'pf-input pf-w-kind', 'aria-label': 'Kind', onchange: (e) => { m.kind = e.target.value; markDirty(); } },
          MEET_KINDS.map((k) => { const o = h('option', { value: k, text: k[0].toUpperCase() + k.slice(1) }); if (k === m.kind) o.selected = true; return o; })),
        h('input', { class: 'pf-input pf-w-loc', type: 'text', maxlength: '60', placeholder: 'Room', value: m.location || '', 'aria-label': 'Location',
          oninput: (e) => { m.location = e.target.value; markDirty(); } }),
        h('button', { class: 'pf-icon-btn small', type: 'button', 'aria-label': 'Remove meeting time', onclick: () => { d.meetingTimes.splice(i, 1); markDirty(); renderCourseSheet(); } }, icon('close'))));
    });
    if (d.meetingTimes.length < 12) {
      mt.appendChild(h('button', { class: 'pf-link pf-add', type: 'button', onclick: () => {
        const last = d.meetingTimes[d.meetingTimes.length - 1];
        d.meetingTimes.push(last ? { ...last, weekday: (last.weekday + 2) % 7 } : { weekday: 1, start: 540, end: 615, location: '', kind: 'lecture' });
        markDirty(); renderCourseSheet();
      } }, icon('plus'), 'Add a meeting time'));
    }
    mt.appendChild(h('label', { class: 'toggle pf-toggle' }, h('input', { type: 'checkbox', checked: d.meetingsBlockTime !== false,
      onchange: (e) => { d.meetingsBlockTime = e.target.checked; markDirty(); } }), h('span', { class: 'switch' }),
    h('span', { class: 'toggle-text', text: 'Count class time as busy' })));
    if (!d.meetingTimes.length) mt.insertBefore(h('p', { class: 'pf-muted', text: 'When the class meets, e.g. Mon and Wed 9:00–10:15.' }), mt.children[1]);
    box.appendChild(mt);
    // More options (collapsed): term dates, exam review, readings — plus the AI-only notes when a key is set
    const st = d.strategy;
    const aiNotes = coachConnected() || !!(st.summary || (st.tips || []).length || d.workload.hoursPerWeek);
    const moreOpen = !!(d.termStart || d.termEnd || st.examPrepDays || st.readBeforeClass || (sheet && sheet.moreOpen));
    const more = h('details', { class: 'pf-cs-more' }, h('summary', null, 'More options · term dates, exam review, readings'));
    more.open = moreOpen;
    more.addEventListener('toggle', () => { if (sheet) sheet.moreOpen = more.open; });
    more.appendChild(h('div', { class: 'pf-cs-section pf-grid2' },
      field('Term starts', optInput('date', d.termStart, (v) => { d.termStart = /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null; markDirty(); }, 'Term starts')),
      field('Last class', optInput('date', d.termEnd, (v) => { d.termEnd = /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null; markDirty(); }, 'Last class'))));
    more.appendChild(h('div', { class: 'pf-cs-section' },
      h('div', { class: 'pf-grid2' },
        field('Start reviewing for exams', h('input', { class: 'pf-input', type: 'number', min: '0', max: '30', step: '1', placeholder: 'Auto',
          value: st.examPrepDays ? String(st.examPrepDays) : '', 'aria-label': 'Days of review before an exam',
          onchange: (e) => { st.examPrepDays = Math.max(0, Math.min(30, Math.round(+e.target.value || 0))); markDirty(); } }),
        'Days before. Auto = 7 before exams, 3 before quizzes'),
        aiNotes ? field('Workload (hours/week)', h('input', { class: 'pf-input', type: 'number', min: '0', max: '60', step: '0.5', value: String(d.workload.hoursPerWeek || 0),
          onchange: (e) => { d.workload.hoursPerWeek = Math.max(0, Math.min(60, +e.target.value || 0)); markDirty(); } })) : h('span')),
      h('label', { class: 'toggle pf-toggle' }, h('input', { type: 'checkbox', checked: !!st.readBeforeClass, onchange: (e) => { st.readBeforeClass = e.target.checked; markDirty(); } }),
        h('span', { class: 'switch' }), h('span', { class: 'toggle-text', text: 'Readings are due before the next class' }))));
    if (aiNotes) {
      more.appendChild(h('div', { class: 'pf-cs-section' },
        h('div', { class: 'pf-overline', text: 'How this course works' }),
        h('textarea', { class: 'pf-input pf-textarea', rows: '3', maxlength: '600', placeholder: 'e.g. Exams are cumulative; problem sets are due each Friday.',
          'aria-label': 'Study strategy', oninput: (e) => { st.summary = e.target.value; markDirty(); } }, st.summary || ''),
        (st.tips || []).length ? h('ul', { class: 'pf-tips' }, st.tips.map((t) => h('li', { text: t }))) : null));
    }
    box.appendChild(more);
    return box;
  }

  function stepsEditor(a) {
    const box = h('div', { class: 'pf-steps' });
    if ((a.steps || []).length) {
      box.appendChild(h('div', { class: 'pf-step-row pf-step-head', 'aria-hidden': 'true' },
        h('span', { text: 'Step' }), h('span', { text: 'Hours' }), h('span', { text: 'Starts' }), h('span', { text: 'Done by' }), h('span')));
    }
    (a.steps || []).forEach((s, i) => {
      box.appendChild(h('div', { class: 'pf-step-row' },
        h('input', { class: 'pf-input', type: 'text', maxlength: '40', placeholder: 'Step', value: s.title || '', 'aria-label': 'Step',
          oninput: (e) => { s.title = e.target.value; edited(a); } }),
        h('input', { class: 'pf-input', type: 'number', min: '0', max: '80', step: '0.25', value: String(s.estHours || 0), 'aria-label': 'Hours (0 = equal share)',
          onchange: (e) => { s.estHours = Math.max(0, +e.target.value || 0); edited(a); } }),
        h('input', { class: 'pf-input', type: 'number', min: '0', max: '60', step: '1', value: String(-(s.unlockOffsetDays || 0)), 'aria-label': 'Start this many days before the due date (0 = any time)',
          title: 'Days before the due date (0 = any time)', onchange: (e) => { s.unlockOffsetDays = -Math.max(0, Math.min(60, Math.round(+e.target.value || 0))); edited(a); } }),
        h('input', { class: 'pf-input', type: 'number', min: '0', max: '60', step: '1', value: String(-(s.doByOffsetDays || 0)), 'aria-label': 'Done this many days before the due date',
          title: 'Days before the due date (0 = by the due date)', onchange: (e) => { s.doByOffsetDays = -Math.max(0, Math.min(60, Math.round(+e.target.value || 0))); edited(a); } }),
        h('button', { class: 'pf-icon-btn small', type: 'button', 'aria-label': 'Remove step', onclick: () => { a.steps.splice(i, 1); edited(a); renderCourseSheet(); } }, icon('close'))));
    });
    if ((a.steps || []).length) box.appendChild(h('span', { class: 'pf-field-hint', text: '“Starts” and “Done by” count days before the due date (0 = any time / on the due date).' }));
    if ((a.steps || []).length < 6) {
      box.appendChild(h('button', { class: 'pf-link pf-add', type: 'button', onclick: () => {
        a.steps = a.steps || [];
        a.steps.push({ title: '', estHours: 0, unlockOffsetDays: 0, doByOffsetDays: 0 });
        edited(a); renderCourseSheet();
      } }, icon('plus'), 'Add a step'));
    }
    return box;
  }
  function edited(a) { a.editedAt = new Date().toISOString(); markDirty(); }

  function renderAssessments(d) {
    const box = h('div', { class: 'pf-cs-pane' });
    box.appendChild(h('p', { class: 'pf-muted pf-as-hint', text: d.assessments.length
      ? '⋯ › Add to tasks puts an item on Today’s Tasks right away.'
      : 'No graded items yet. Add each exam, essay, lab or quiz with its due date (weight is optional).' }));
    if (d.assessments.length) {
      box.appendChild(h('div', { class: 'pf-as-row pf-as-head', 'aria-hidden': 'true' },
        h('span', { class: 'pf-ah-type', text: 'Type' }), h('span', { class: 'pf-ah-title', text: 'Title' }),
        h('span', { class: 'pf-ah-date', text: 'Due' }), h('span', { class: 'pf-ah-weight', text: 'Weight' })));
    }
    const asg = assignmentsAll();
    const sorted = d.assessments.slice().sort((x, y) => String(x.due || '9999').localeCompare(String(y.due || '9999')));
    for (const a of sorted) {
      const openRow = sheet.openRows.has(a.id);
      const feed = a.externalID ? asg.find((x) => sameID(x.id, a.externalID)) : null;
      const pips = (a.taskIDs || []).map((id) => Store.tasks().find((t) => sameID(t.id, id))).filter(Boolean);
      const low = a.confidence && a.confidence !== 'high';
      const row = h('div', { class: 'pf-as-row' + (low ? ' is-low' : '') + (a.status !== 'upcoming' ? ' is-done' : '') },
        h('button', { class: 'pf-as-expand' + (openRow ? ' is-open' : ''), type: 'button', 'aria-expanded': String(openRow), 'aria-label': 'Show details',
          title: openRow ? 'Hide details' : 'Due time, hours of work and steps',
          onclick: () => { if (openRow) sheet.openRows.delete(a.id); else sheet.openRows.add(a.id); renderCourseSheet(); } }, icon('chevD')),
        h('select', { class: 'pf-input pf-w-type', 'aria-label': 'Type', onchange: (e) => { a.type = e.target.value; edited(a); } },
          TYPES.map((k) => { const o = h('option', { value: k, text: TYPE_LABEL[k] }); if (k === a.type) o.selected = true; return o; })),
        h('input', { class: 'pf-input pf-w-grow', type: 'text', maxlength: '120', placeholder: 'Title', value: a.title || '', 'aria-label': 'Title',
          oninput: (e) => { a.title = e.target.value; edited(a); } }),
        optInput('date', a.due, (v) => { a.due = /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null; edited(a); renderCourseSheet(); }, 'Due', 'pf-w-date'),
        h('label', { class: 'pf-w-weight', title: 'How much of the final grade this is worth (optional)' },
          h('input', { class: 'pf-input', type: 'number', min: '0', max: '100', step: '1', placeholder: '–',
            value: a.weightPercent != null ? String(a.weightPercent) : '', 'aria-label': 'Weight in percent (optional)',
            onchange: (e) => { const v = e.target.value === '' ? null : Math.max(0, Math.min(100, +e.target.value)); a.weightPercent = Number.isFinite(v) ? v : null; edited(a); renderCourseSheet(); } }),
          h('span', { class: 'pf-pct', 'aria-hidden': 'true', text: '%' })),
        h('span', { class: 'pf-as-meta' },
          low ? h('span', { class: 'pf-conf', title: a.evidence ? `Check this one · “${a.evidence}”` : 'Check this one', 'aria-label': 'Check this one' }) : null,
          feed ? h('span', { class: 'pf-linkglyph', title: `Linked to ${feed.title}` }, icon('link')) : null,
          pips.length ? h('span', { class: 'pf-pips', title: `${pips.filter((t) => t.isDone).length} of ${pips.length} tasks done` },
            pips.map((t) => h('span', { class: 'pf-pip' + (t.isDone ? ' is-done' : '') }))) : null),
        h('button', { class: 'pf-icon-btn small pf-as-more', type: 'button', 'aria-label': `More for ${a.title || 'this item'}`, title: 'Add to tasks, mark done, drop or delete',
          onclick: (e) => asMenu(d, a, e.currentTarget) }, icon('more')));
      box.appendChild(row);
      if (feed && feed.dueDay && a.due && feed.dueDay !== a.due) {
        box.appendChild(h('div', { class: 'pf-as-note', text: `${PROVIDER[providerOf(feed)] === 'your calendars' ? 'Your calendar' : (PROVIDER[providerOf(feed)] || 'The feed')} says ${F.md.format(dateOf(feed.dueDay))}; syllabus said ${F.md.format(dateOf(a.due))}` }));
      }
      if (openRow) {
        box.appendChild(h('div', { class: 'pf-as-detail' },
          h('div', { class: 'pf-grid2' },
            field('Due time', optInput('time', a.dueTime != null ? hhmm(a.dueTime) : '', (v) => { a.dueTime = fromHHMM(v); edited(a); }, 'Due time')),
            field('Hours of work', h('input', { class: 'pf-input', type: 'number', min: '0', max: '80', step: '0.25', value: a.estHours != null ? String(a.estHours) : '',
              onchange: (e) => { const v = +e.target.value; a.estHours = v >= 0.25 && v <= 80 ? v : null; edited(a); } }), 'Empty = a sensible default for the type')),
          a.prep || a.topics.length ? h('p', { class: 'pf-muted', text: [a.topics.join(', '), a.prep].filter(Boolean).join(' — ') }) : null,
          h('div', { class: 'pf-overline', text: 'Steps (how the course wants it done)' }),
          stepsEditor(a)));
      }
    }
    box.appendChild(h('button', { class: 'pf-link pf-add', type: 'button', onclick: () => {
      const a = newAssessment({ editedAt: new Date().toISOString() });
      d.assessments.push(a);   // opens collapsed: type, title, due and weight are all most items need (› shows the rest)
      markDirty(); renderCourseSheet();
      const inputs = sheet.el.querySelectorAll('.pf-as-row .pf-w-grow');
      if (inputs.length) inputs[inputs.length - 1].focus();
    } }, icon('plus'), 'Add a graded item'));
    const sum = d.assessments.reduce((t, a) => t + (Number(a.weightPercent) > 0 ? Number(a.weightPercent) : 0), 0);
    if (sum > 110) box.appendChild(h('p', { class: 'pf-note-warn', text: `Weights add up to ${Math.round(sum)} %; check them` }));
    return box;
  }
  function asMenu(d, a, anchor) {
    closeMenus();
    const item = (text, fn, dis) => h('button', { class: 'pf-menu-item', type: 'button', role: 'menuitem', disabled: !!dis, onclick: () => { closeMenus(); fn(); } },
      h('span', { class: 'pf-menu-check' }), h('span', { class: 'pf-menu-label', text }));
    const menu = h('div', { class: 'pf-menu pf-course-menu', role: 'menu' },
      item('Add to tasks', () => addToTasks(d, a), (a.taskIDs || []).length > 0 || !a.title),
      item(a.status === 'done' ? 'Mark upcoming' : 'Mark done', () => { a.status = a.status === 'done' ? 'upcoming' : 'done'; edited(a); renderCourseSheet(); }),
      item(a.status === 'dropped' ? 'Restore' : 'Drop', () => { a.status = a.status === 'dropped' ? 'upcoming' : 'dropped'; edited(a); renderCourseSheet(); }),
      item('Delete', () => { d.assessments = d.assessments.filter((x) => x !== a); markDirty(); renderCourseSheet(); }));
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.width = '180px';
    menu.style.left = Math.max(8, Math.min(window.innerWidth - 188, r.right - 180)) + 'px';
    menu.style.top = Math.min(window.innerHeight - 190, r.bottom + 4) + 'px';
    setTimeout(() => document.addEventListener('pointerdown', outsideMenus, true), 0);
  }
  /* "Add to tasks": materialise now (outside a plan), after saving the course. */
  function addToTasks(d, a) {
    if (!save({ keepOpen: true })) return;
    const c = get(d.id);
    const as = c && c.assessments.find((x) => sameID(x.id, a.id));
    if (!c || !as) return;
    const fields = StudyPlan.materialize(c, as, { force: true, focusMinutes: Store.settings().focusMinutes });
    if (!fields.length) { toast('Give it a title first'); return; }
    const ids = [];
    Store.bulk(() => {
      for (const f of fields) {
        const t = Store.addTask({ title: f.title, estimate: f.estimate, category: f.category, dueDate: f.dueDate,
          dueAt: f.dueDate && f.dueMinutes != null ? dateOf(f.dueDate, f.dueMinutes).toISOString() : null, notes: f.notes,
          courseID: c.id, assessmentID: as.id, course: c.code ? clip(c.code, 40) : null }, { append: true });
        if (t) ids.push(lower(t.id));
      }
      const next = clone(c);
      const na = next.assessments.find((x) => sameID(x.id, as.id));
      na.taskIDs = Array.from(new Set((na.taskIDs || []).concat(ids)));
      Store.upsertCourse(next);
    });
    sheet.draft = norm(clone(get(d.id)));
    sheet.dirty = false;
    renderCourseSheet();
    toast(ids.length === 1 ? 'Added to Today’s Tasks' : `Added ${ids.length} tasks`, 'success');
  }

  function renderSources(d) {
    const box = h('div', { class: 'pf-cs-pane' });
    for (const s of (d.sources || []).slice().reverse()) {
      box.appendChild(h('div', { class: 'pf-src-row' }, icon('doc', 'pf-src-i'),
        h('span', { class: 'pf-list-main' }, h('span', { class: 'pf-list-title', text: s.name }),
          h('span', { class: 'pf-list-sub', text: [s.kind === 'pdf' ? 'PDF' : s.kind === 'image' ? 'Photo' : 'Text', s.pages ? `${s.pages} pages` : null,
            s.addedAt ? `added ${F.md.format(new Date(s.addedAt))}` : null].filter(Boolean).join(' · ') }))));
    }
    const ing = sheet.ingest;
    if (ing && ing.status) {
      box.appendChild(h('div', { class: 'pf-ingest-status' + (ing.error ? ' is-error' : '') },
        ing.error ? null : h('span', { class: 'pf-spinner', 'aria-hidden': 'true' }),
        h('span', { class: 'pf-ingest-text', role: 'status', text: ing.status }),
        ing.confirm ? h('span', { class: 'pf-ingest-actions' }, ing.confirm.map((b) => h('button', { class: 'btn btn-sm' + (b.primary ? ' btn-primary' : ''), type: 'button', onclick: b.onClick }, b.label))) : null,
        ing.cancel && !ing.error && !ing.confirm ? h('button', { class: 'pf-plain', type: 'button', onclick: () => ing.cancel() }, 'Cancel') : null));
    }
    const connected = coachConnected();
    const zone = h('div', { class: 'pf-drop' + (connected ? '' : ' is-off'), tabindex: '0' },
      h('span', { class: 'pf-drop-title', text: connected ? 'Drop syllabi, assignment sheets or photos' : 'Reading files needs the optional AI key (Settings › Calendar & Accounts). You can always add graded items by hand.' }),
      connected ? h('span', { class: 'pf-drop-sub', text: 'PDF, JPEG, PNG, HEIC (Safari) or pasted text · Don’t upload rosters or other students’ work' }) : null,
      h('span', { class: 'pf-drop-actions' },
        connected ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => pickFiles() }, 'Add files') : null,
        connected ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => pasteText() }, 'Paste text') : h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { sheet.tab = 'assessments'; renderCourseSheet(); } }, 'Enter manually')));
    if (connected) {
      zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('is-drop'); });
      zone.addEventListener('dragleave', () => zone.classList.remove('is-drop'));
      zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('is-drop'); const f = Array.from((e.dataTransfer && e.dataTransfer.files) || []); if (f.length) startIngest({ files: f }); });
      zone.addEventListener('paste', (e) => {
        const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
        const files = items.filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
        if (files.length) { e.preventDefault(); startIngest({ files }); return; }
        const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
        if (text && text.trim()) { e.preventDefault(); startIngest({ text }); }
      });
    }
    box.appendChild(zone);
    return box;
  }
  function pickFiles() {
    const input = h('input', { type: 'file', multiple: true, accept: '.pdf,application/pdf,image/*,.heic,.heif' });
    input.addEventListener('change', () => { const f = Array.from(input.files || []); if (f.length) startIngest({ files: f }); });
    input.click();
  }
  function pasteText() {
    if (!sheet) return;
    sheet.ingest = { status: null, pasting: true };
    const ta = h('textarea', { class: 'pf-input pf-textarea', rows: '8', maxlength: '60000', placeholder: 'Paste the syllabus or assignment text', 'aria-label': 'Pasted text' });
    const pane = sheet.el.querySelector('.pf-cs-pane');
    if (!pane) return;
    pane.prepend(h('div', { class: 'pf-paste' }, ta, h('div', { class: 'pf-paste-actions' },
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { sheet.ingest = null; renderCourseSheet(); } }, 'Cancel'),
      h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => { const t = ta.value.trim(); if (t) startIngest({ text: t }); } }, 'Read it'))));
    ta.focus();
  }

  /* Ingestion (v2-ai §3; item 6). Without a connection nothing leaves the device. */
  function coachConnected() { try { return typeof AI !== 'undefined' && AI.hasKey(); } catch (_) { return false; } }
  /* The "Syllabus files" tab exists only with the optional AI key (or when files were read before). */
  function sourcesTab(d) { return coachConnected() || !!(d && (d.sources || []).length) || !!(sheet && sheet.ingest); }
  function startIngest(input) {
    if (!sheet) return;
    if (!coachConnected()) {
      sheet.tab = 'assessments';
      renderCourseSheet();
      toast('Files aren’t read automatically — type the graded items in under Graded items');
      return;
    }
    if (typeof AI !== 'undefined' && AI.ingestFlow) AI.ingestFlow(input, ingestUI());
  }
  /* The surface AI.ingestFlow drives (status lines, cost confirm, review). */
  function ingestUI() {
    return {
      course: () => (sheet ? sheet.draft : null),
      existing: () => list(),
      set(patch) { if (!sheet) return; sheet.ingest = { ...(sheet.ingest || {}), ...patch }; sheet.tab = sheet.ingest.review ? sheet.tab : 'sources'; renderCourseSheet(); },
      clear() { if (!sheet) return; sheet.ingest = null; renderCourseSheet(); },
      alive: () => !!sheet,
    };
  }
  function renderReview() {
    const r = sheet.ingest.review;          // {course, diff:{added, changed:[{title, from, to}], kept}, notes, low, weightWarning}
    const box = h('div', { class: 'pf-cs-pane pf-review' });
    box.appendChild(h('h3', { class: 'pf-review-title', text: 'Check what we found' }));
    box.appendChild(h('p', { class: 'pf-review-sum', text: r.summaryLine }));
    if (r.diffLine) box.appendChild(h('p', { class: 'pf-muted', text: r.diffLine }));
    if (r.weightWarning) box.appendChild(h('p', { class: 'pf-note-warn', text: r.weightWarning }));
    if (r.notes) box.appendChild(h('div', { class: 'pf-callout' }, h('span', { text: r.notes })));
    const c = r.course;
    if ((c.meetingTimes || []).length) {
      box.appendChild(h('div', { class: 'pf-overline', text: 'Meeting times' }));
      box.appendChild(h('div', { class: 'pf-chips' }, c.meetingTimes.map((m) => h('span', { class: 'pf-feedchip', text: `${WD[m.weekday]} ${timeText(m.start)}–${timeText(m.end)} · ${m.kind}${m.location ? ' · ' + m.location : ''}` }))));
    }
    box.appendChild(h('div', { class: 'pf-overline', text: `Graded items (${c.assessments.length})` }));
    for (const a of c.assessments.slice().sort((x, y) => String(x.due || '9999').localeCompare(String(y.due || '9999')))) {
      const low = a.confidence !== 'high';
      box.appendChild(h('div', { class: 'pf-rv-row' + (low ? ' is-low' : '') },
        h('span', { class: 'pf-rv-type', text: TYPE_LABEL[a.type] || 'Other' }),
        h('input', { class: 'pf-input pf-w-grow', type: 'text', maxlength: '120', value: a.title, 'aria-label': 'Title', oninput: (e) => { a.title = e.target.value; a.editedAt = new Date().toISOString(); } }),
        h('input', { class: 'pf-input pf-w-date', type: 'date', value: a.due || '', 'aria-label': 'Due', onchange: (e) => { a.due = e.target.value || null; a.confidence = 'high'; a.editedAt = new Date().toISOString(); renderCourseSheet(); } }),
        h('span', { class: 'pf-rv-w', text: a.weightPercent != null ? `${Math.round(a.weightPercent)} %` : '' }),
        low ? h('span', { class: 'pf-conf', title: a.evidence ? `Check this one · “${a.evidence}”` : 'Check this one' }) : h('span', { class: 'pf-conf-gap' })));
    }
    return box;
  }
  function saveReview() {
    const r = sheet.ingest.review;
    const c = norm(r.course);
    if (!c.name) c.name = c.code || 'Course';
    Store.upsertCourse(c);
    relink();
    sheet.ingest = null;
    sheet.draft = norm(clone(get(c.id) || c));
    sheet.isNew = false;
    sheet.dirty = false;
    sheet.tab = 'assessments';
    renderCourseSheet();
    renderSidebar();
    toast(`Saved ${label(c)} · ${c.assessments.length} graded items`, 'success');
  }

  function save({ keepOpen = false } = {}) {
    if (!sheet || !sheet.draft) return false;
    const d = sheet.draft;
    d.name = String(d.name || '').trim();
    d.code = String(d.code || '').trim();
    if (!d.name && d.code) d.name = d.code;
    if (!d.name) { toast('Give the course a name'); const n = sheet.el.querySelector('.pf-cs-name'); if (n) n.focus(); return false; }
    d.assessments = d.assessments.filter((a) => String(a.title || '').trim()).map((a) => ({ ...a, title: clip(a.title.trim(), 120) }));
    for (const a of d.assessments) a.steps = (a.steps || []).filter((s) => String(s.title || '').trim()).map((s) => ({ ...s, title: clip(s.title.trim(), 40) }));
    const wasNew = sheet.isNew;
    const saved = Store.upsertCourse(norm(d));
    if (!saved) return false;
    relink();
    renderSidebar();
    if (keepOpen) { sheet.isNew = false; sheet.dirty = false; return true; }
    closeSheet();
    toast(wasNew ? `Added ${label(saved)}` : `Saved ${label(saved)}`, 'success');
    return true;
  }
  function deleteCourse(d) {
    if (!window.confirm(`Delete ${label(d)}? Its tasks stay; their link to the course is removed.`)) return;
    Store.bulk(() => {
      for (const t of Store.tasks()) if (sameID(t.courseID, d.id)) Store.updateTask(t.id, { courseID: null, assessmentID: null, planParts: null });
      Store.removeCourse(d.id);
    });
    closeSheet();
    renderSidebar();
    toast('Course deleted');
  }
  /* Settings › Study coach › Delete all course data (v2-ai §11). */
  function deleteAll() {
    const n = list().length;
    Store.bulk(() => {
      for (const t of Store.tasks()) {
        if (t.courseID || t.assessmentID || (t.planParts && t.planParts.length)) Store.updateTask(t.id, { courseID: null, assessmentID: null, planParts: null });
      }
      for (const c of list()) Store.removeCourse(c.id);
    });
    renderSidebar();
    return n;
  }

  // ───────────────── Planner & courses card (Settings › Calendar & Accounts; H14) ─────────────────
  /* Everything works without a key. The AI key is one optional, collapsed row (USER-HOTFIX-2 H14). */
  const PRIVACY = 'Files are read only when you press a button. They are sent to Anthropic to be read and are not kept by Pure Focus. Anthropic deletes API data within 30 days and doesn’t train on it. Your key stays on this device.';
  function renderCard(el) {
    cardEls.add(el);
    const wasOpen = !!el.querySelector('details.pf-ai-optional[open]');
    el.textContent = '';
    el.classList.add('glass', 'card', 'settings-card', 'pf-coach-card');
    el.id = 'pf-coach-card';
    const n = active().length;
    el.append(
      h('div', { class: 'card-header' }, h('h3', { class: 'card-title', text: 'Courses' })),
            h('p', { class: 'pf-muted', text: 'Courses hold your class times, exams and due dates. Add them by hand; Canvas and Blackbaud calendar links suggest them for you.' }),
      h('div', { class: 'pf-card-actions' },
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => manage() }, n ? `Courses (${n})…` : 'Add a course…'),
        h('button', { class: 'btn btn-sm btn-quiet-danger pf-delete-courses', type: 'button', title: 'Removes every course and its graded items; your tasks stay', onclick: confirmDeleteAll }, 'Delete all course data')));
    let hasKey = false;
    try { hasKey = typeof AI !== 'undefined' && AI.hasKey(); } catch (_) {}
    const more = h('details', { class: 'settings-more pf-ai-optional' },
      h('summary', null, hasKey ? 'Optional: AI syllabus reading · on' : 'Optional: add an AI key for syllabus reading'));
    more.open = wasOpen;
    const body = h('div', { class: 'settings-more-body pf-coach-more' });
    if (typeof AI !== 'undefined' && AI.renderKeyPanel) AI.renderKeyPanel(body, { privacy: PRIVACY, rerender: () => refreshCards() });
    else body.appendChild(h('p', { class: 'pf-muted', text: 'Not available in this browser.' }));
    more.appendChild(body);
    el.appendChild(more);
  }
  function confirmDeleteAll() {
    const n = list().length;
    if (!n && !Store.tasks().some((t) => t.courseID || t.assessmentID)) { toast('There’s no course data to delete'); return; }
    if (!window.confirm(`Delete all course data? ${n === 1 ? '1 course' : n + ' courses'} and their graded items are removed. Your tasks stay.`)) return;
    deleteAll();
    toast('Course data deleted');
    refreshCards();
  }
  function refreshCards() { for (const el of cardEls) if (el.isConnected) renderCard(el); }

  // ───────────────────────── init ─────────────────────────
  function init() {
    if (inited) return;
    inited = true;
    try {
      CalendarView.registerSidebarSection({ id: 'courses', title: 'Courses', order: 30, visible, render: mountSidebar,
        action: { label: 'Add course', icon: 'plus', onClick: () => open() } });
    } catch (err) { console.error('Courses: sidebar section', err); }
    try { Settings.registerCard('calendar', { id: 'coach', order: 95, render: renderCard }); } catch (err) { console.error('Courses: coach card', err); }
    try {
      Store.on('assignments', scheduleRelink);
      Store.on('change', (kind) => {
        if (relinking) return;
        if (kind === 'courses' || kind === 'tasks' || kind === 'bulk' || kind === 'remote' || kind === 'reset' || kind === 'calendar') scheduleRelink();
        if (kind === 'settings') refreshCards();
      });
    } catch (_) {}
    scheduleRelink();
  }

  return { init, list, open, manage, mountSidebar, visible, suggestions, relink, deleteAll, refreshCards, colorOf, label, newCourse,
    _newCourse: newCourse, _newAssessment: newAssessment, _norm: norm, _addSuggested: addSuggested, _dismiss: dismissSuggestions, _save: save,
    _sheet: () => sheet, PRIVACY };
})();
