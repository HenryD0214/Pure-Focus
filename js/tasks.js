/* ═══════════════════════════════════════════════════════════════════════
   tasks.js — the Today's Tasks card (owner: WT; USER-HOTFIX-2 H15)

   One obvious flow: type in "Add a task", press Enter. Optional Due date and
   Estimate chips sit right in the field (small menus, never modals).
   Rows: a big checkbox · the title · at most two chips (due, scheduled time)
   · progress beads · on hover: Schedule, ▶ Focus, ⋯ More. Clicking a row puts
   that task on the timer; double-click (or F2, or ⋯ › Rename) renames it.
   Rows reorder by dragging anywhere on them (touch: hold, then drag).
   Sections: Today (due today, scheduled today, everything without a later date)
   · Upcoming (collapsed count) · Completed (collapsed count). Overdue tasks aren't
   shown here (TaskSync.sectionOf → 'pastdue'); an empty list says "Nothing due".
   The older features (subtasks, categories, focus spots, templates,
   estimates) live behind ⋯ More and the "Task details" sheet.

   Calendar sync (scheduled chips, completion → blocks, renames) is the link
   model in js/tasksync.js (TaskSync). Until app.html carries the
   <script>/<link> tags, init() injects js/tasksync.js and css/tasks.css once.

   Public API: Tasks.init() · render() · openSheet(task) · closeSheet() · isReady()
   Safety: every user / imported string goes through textContent; innerHTML
   only receives the static icons below.
   ═══════════════════════════════════════════════════════════════════════ */

const Tasks = (() => {
  const ASSET_VERSION = '11041001';
  const UI_KEY = 'purefocus.tasks.ui';

  // Static icon markup only — never interpolate data into these strings.
  const ICONS = {
    grip: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="6" cy="4" r="1.2" fill="currentColor"/><circle cx="10" cy="4" r="1.2" fill="currentColor"/><circle cx="6" cy="8" r="1.2" fill="currentColor"/><circle cx="10" cy="8" r="1.2" fill="currentColor"/><circle cx="6" cy="12" r="1.2" fill="currentColor"/><circle cx="10" cy="12" r="1.2" fill="currentColor"/></svg>',
    check: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.2 10.4 8.6 13.8 14.8 6.8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    play: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6.5 4.6v10.8a.8.8 0 0 0 1.2.7l8.6-5.4a.8.8 0 0 0 0-1.4L7.7 3.9a.8.8 0 0 0-1.2.7Z" fill="currentColor"/></svg>',
    more: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="4.8" cy="10" r="1.6" fill="currentColor"/><circle cx="10" cy="10" r="1.6" fill="currentColor"/><circle cx="15.2" cy="10" r="1.6" fill="currentColor"/></svg>',
    cal: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="4.2" width="14" height="12.6" rx="3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3.2 8.2h13.6M7 2.8v2.6M13 2.8v2.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    clock: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="6.8" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 6.4V10l2.4 1.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    plus: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4.5v11M4.5 10h11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    chev: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 4.5 13 10l-5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    tomato: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="11" r="6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 5V3.4M7.6 5.4 10 6.6l2.4-1.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    tag: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.4 10.1V4.6c0-.7.5-1.2 1.2-1.2h5.5l6.5 6.5a1.2 1.2 0 0 1 0 1.7l-4.9 4.9a1.2 1.2 0 0 1-1.7 0Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="7.1" cy="7.1" r="1.3" fill="currentColor"/></svg>',
    pin: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 17.4s5.4-4.9 5.4-9.2a5.4 5.4 0 1 0-10.8 0c0 4.3 5.4 9.2 5.4 9.2Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="10" cy="8.2" r="2" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    trash: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.4 4.6h9.2M6.4 4.6V3.4h3.2v1.2M4.6 4.6l.6 8h5.6l.6-8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  let ready = false;
  let editingId = null;
  let editingSubtasks = [];
  let inlineEditing = false;
  let renderPending = false;
  let menu = null;                      // {el, anchor, cleanup}
  const expanded = new Set();           // task ids whose subtasks are open
  const draft = { due: null, estimate: 1, category: null, locations: [] };
  const SORTS = [
    { id: 'manual', label: 'Manual', hint: 'your order' },
    { id: 'due', label: 'Due date', hint: 'soonest first' },
    { id: 'type', label: 'Type of work', hint: 'A–Z' },
    { id: 'title', label: 'Title', hint: 'A–Z' },
  ];
  let ui = { upcomingOpen: false, pastdueOpen: true, completedOpen: null, sort: 'manual' };

  const $ = (sel) => document.querySelector(sel);
  const TS = () => (typeof TaskSync !== 'undefined' ? TaskSync : null);
  const lower = (x) => String(x == null ? '' : x).toLowerCase();
  const sameID = (a, b) => a != null && b != null && lower(a) === lower(b);
  const pad = (n) => String(n).padStart(2, '0');
  const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayKey = () => dayKey(new Date());
  const addDays = (d, n) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() + n); return x; };

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'html') el.innerHTML = v;            // static ICONS only
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    return el;
  }
  const icon = (name, cls = 'tk-ic') => h('span', { class: cls, html: ICONS[name], 'aria-hidden': 'true' });

  function loadUI() {
    try {
      const raw = localStorage.getItem(UI_KEY);
      if (raw) ui = { ...ui, ...JSON.parse(raw) };
    } catch (_) {}
    if (!SORTS.some((s) => s.id === ui.sort)) ui.sort = 'manual';
  }
  function saveUI() { try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch (_) {} }

  /* A task's pomodoros follow its time on the calendar until you set them yourself: blocks for the
     task (or, for a "PUREFOCUS:" event, the event) adding up to 50 minutes = 2 × 25-minute pomodoros.
     estimateSet marks a number you picked; it's never overwritten. */
  let estTimer = 0;
  function syncEstimatesSoon() { clearTimeout(estTimer); estTimer = setTimeout(syncEstimates, 250); }
  function syncEstimates() {
    const focus = pomo().focus;
    const mins = new Map();
    for (const b of Store.blocks()) {
      if (!b || !b.taskID || b.allDay) continue;
      const m = (Date.parse(b.end) - Date.parse(b.start)) / 60000;
      if (m > 0) mins.set(lower(b.taskID), (mins.get(lower(b.taskID)) || 0) + m);
    }
    const changes = [];
    for (const t of Store.tasks()) {
      if (t.isDone || t.estimateSet) continue;
      const m = mins.get(lower(t.id)) || (Number(t.eventMinutes) > 0 ? Number(t.eventMinutes) : 0);
      if (!m) continue;
      const n = Math.min(12, Math.max(1, Math.round(m / focus)));
      if (n !== t.estimate) changes.push([t.id, n]);
    }
    if (changes.length) Store.bulk(() => { for (const [id, n] of changes) Store.updateTask(id, { estimate: n }); });
  }

  function pomo() {
    const s = Store.settings();
    return { focus: Number(s.focusMinutes) || 25, short: Number(s.shortBreakMinutes) || 5,
      long: Number(s.longBreakMinutes) || 15, interval: Math.max(1, Number(s.longBreakInterval) || 4) };
  }
  function fmtMinutes(m) {
    m = Math.round(m);
    if (m < 60) return `${m}m`;
    return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`;
  }
  const timeFmt = (() => { try { return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }); } catch (_) { return null; } })();
  const wdFmt = (() => { try { return new Intl.DateTimeFormat(undefined, { weekday: 'short' }); } catch (_) { return null; } })();
  const mdFmt = (() => { try { return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }); } catch (_) { return null; } })();

  function shortDay(key) {
    const d = new Date(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10));
    const diff = Math.round((d - addDays(new Date(), 0)) / 86400000);
    if (diff === 0) return 'today';
    if (diff === 1) return 'tomorrow';
    if (diff > 1 && diff < 7 && wdFmt) return wdFmt.format(d);
    return mdFmt ? mdFmt.format(d) : key;
  }

  function locationsOf(t) {
    if (!t) return [];
    const list = Array.isArray(t.locations) && t.locations.length ? t.locations : (t.location ? [t.location] : []);
    const out = [];
    for (const raw of list) {
      const s = String(raw == null ? '' : raw).trim();
      if (s && !out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
    }
    return out;
  }

  function completedLabel(t) {
    const ms = Date.parse(t.completedAt || '');
    if (!Number.isFinite(ms)) return 'Completed';
    const d = new Date(ms);
    const diff = Math.round((addDays(new Date(), 0) - addDays(d, 0)) / 86400000);
    if (diff === 0) return 'Done today';
    if (diff === 1) return 'Done yesterday';
    if (diff > 1 && diff < 7 && wdFmt) return `Done ${wdFmt.format(d)}`;
    const day = mdFmt ? mdFmt.format(d) : dayKey(d);
    return `Done ${day}${d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : ''}`;
  }

  function completedAtMs(t) {
    const ms = Date.parse(t.completedAt || '');
    if (Number.isFinite(ms)) return ms;
    const due = Date.parse(t.dueDate || '');
    return Number.isFinite(due) ? due : 0;
  }

  /* Canvas course names carry the section and teacher: "US History - 3 Smock, April" → "US History". */
  function shortCourse(name) {
    const s = String(name || '').trim();
    const m = /^(.+?)\s+[-–]\s+(?:\d+\b|[A-Z][\w'’.-]*,\s)/.exec(s);
    return m ? m[1] : s;
  }

  // ── fallbacks while js/tasksync.js loads ──

  function sectionOf(t) {
    const ts = TS();
    if (ts) return ts.sectionOf(t);
    if (t.isDone) return 'done';
    if (t.dueDate && t.dueDate < todayKey()) return 'pastdue';
    return t.dueDate && t.dueDate > todayKey() ? 'upcoming' : 'today';
  }
  function dueLabel(t) {
    const ts = TS();
    if (ts) return ts.dueLabel(t);
    if (!t.dueDate) return null;
    const over = t.dueDate < todayKey() && !t.isDone;
    return { text: over ? 'Overdue' : `Due ${shortDay(t.dueDate)}`, title: `Due ${t.dueDate}`, overdue: over, today: t.dueDate === todayKey() };
  }
  function complete(t) {
    const ts = TS();
    if (ts) ts.complete(t.id, { done: !t.isDone });
    else Store.toggleTaskDone(t.id);
  }
  function removeTask(t) {
    const ts = TS();
    if (ts) ts.remove(t.id);
    else if (window.confirm(`Delete “${t.title}”?`)) Store.deleteTask(t.id);
  }
  function startTask(t) {
    const ts = TS();
    if (ts) { ts.start(t.id); return; }
    if (typeof Timer !== 'undefined' && Timer.startFocus) Timer.startFocus({ taskID: t.id, force: false });
    else Store.setActiveTask(t.id);
  }

  // ───────────────────────────  shell (one-time re-arrangement of the card)  ───────────────────────────

  function ensureAssets() {
    if (!document.querySelector('link[href*="css/tasks.css"]')) {
      document.head.appendChild(h('link', { rel: 'stylesheet', href: `css/tasks.css?v=${ASSET_VERSION}` }));
    }
    if (typeof TaskSync === 'undefined' && !document.querySelector('script[src*="js/tasksync.js"]')) {
      const s = h('script', { src: `js/tasksync.js?v=${ASSET_VERSION}` });
      s.async = false;
      document.body.appendChild(s);
    }
  }

  let els = {};

  function ensureShell() {
    const card = $('.tasks-card');
    if (!card) return false;
    card.classList.add('tk-card');
    const header = card.querySelector('.card-header');
    const form = $('#add-task-form');
    const body = $('#tasks-body');
    const templates = $('#templates');

    // Header: a labelled Sort button and a labelled Templates button instead of mystery icons.
    const tplBtn = $('#templates-toggle');
    if (tplBtn && !tplBtn.classList.contains('tk-head-btn')) {
      tplBtn.className = 'tk-head-btn';
      tplBtn.textContent = 'Templates';
      tplBtn.title = 'Reusable tasks you add often — click one to fill the field';
      tplBtn.setAttribute('aria-label', 'Task templates');
    }
    let sortBtn = $('#tasks-sort');
    if (!sortBtn && header) {
      sortBtn = h('button', { class: 'tk-head-btn tk-sort-btn', id: 'tasks-sort', type: 'button',
        title: `Sort tasks — now: ${sortLabel()}`, 'aria-label': `Sort tasks. Now: ${sortLabel()}`,
        'aria-haspopup': 'menu', 'aria-expanded': 'false' }, 'Sort');
      sortBtn.addEventListener('click', () => sortMenu(sortBtn));
      // Put Sort right beside the Focus Guard chip in the tasks header.
      const guardRoot = $('#guard-chip-root');
      const chips = guardRoot && guardRoot.parentElement;
      if (chips && chips.classList.contains('tasks-head-chips')) chips.insertBefore(sortBtn, guardRoot.nextSibling);
      else if (tplBtn && tplBtn.parentNode === header) header.insertBefore(sortBtn, tplBtn);
      else header.appendChild(sortBtn);
    }
    els.sortBtn = sortBtn;

    // The add field moves to the top: header → (templates) → add → list.
    card.querySelectorAll(':scope > .card-divider').forEach((d) => d.remove());
    if (form) {
      form.classList.add('tk-add');
      const anchorAfter = templates && templates.parentNode === card ? templates : header;
      if (anchorAfter && anchorAfter.nextSibling !== form) card.insertBefore(form, anchorAfter.nextSibling);
      const old = $('#add-options');
      if (old) old.remove();
      const input = $('#add-task-input');
      if (input) {
        input.placeholder = 'Add a task — press Enter';
        input.setAttribute('aria-label', 'Add a task: type a title and press Enter');
      }
      if (!form.querySelector('.tk-add-chips')) {
        const chips = h('div', { class: 'tk-add-chips' });
        els.addDue = h('button', { class: 'tk-chip tk-chip-btn tk-add-due', type: 'button', 'aria-haspopup': 'menu',
          onclick: (ev) => { ev.preventDefault(); dueMenu(els.addDue, draft.due, (k) => { draft.due = k; renderDraft(); $('#add-task-input').focus(); }); } });
        els.addEst = h('button', { class: 'tk-chip tk-chip-btn tk-add-est', type: 'button', 'aria-haspopup': 'menu',
          onclick: (ev) => { ev.preventDefault(); estMenu(els.addEst, draft.estimate, (n) => { draft.estimate = n; renderDraft(); $('#add-task-input').focus(); }); } });
        // what kind of work and where: the two the Reports break your focus down by
        els.addType = h('button', { class: 'tk-chip tk-chip-btn tk-add-type', type: 'button', 'aria-haspopup': 'menu',
          onclick: (ev) => { ev.preventDefault(); typeMenu(els.addType, draft.category, (c) => { draft.category = c; renderDraft(); $('#add-task-input').focus(); }); } });
        els.addPlace = h('button', { class: 'tk-chip tk-chip-btn tk-add-place', type: 'button', 'aria-haspopup': 'menu',
          onclick: (ev) => { ev.preventDefault(); placeMenu(els.addPlace, draft.locations, (locs) => { draft.locations = locs; renderDraft(); $('#add-task-input').focus(); }); } });
        chips.append(els.addType, els.addPlace, els.addDue, els.addEst);
        // Templates fill this field, so their button lives with the field's other options
        if (tplBtn) { tplBtn.type = 'button'; tplBtn.classList.add('tk-chip', 'tk-chip-btn', 'tk-add-tpl'); chips.append(tplBtn); }
        const submit = form.querySelector('button[type="submit"]');
        form.insertBefore(chips, submit || null);
        if (submit) {
          submit.className = 'btn btn-glass tk-add-btn add-task-btn';
          submit.textContent = 'Add';
          submit.title = 'Add the task (Enter)';
          submit.setAttribute('aria-label', 'Add task');
        }
      } else {
        els.addDue = form.querySelector('.tk-add-due');
        els.addEst = form.querySelector('.tk-add-est');
        els.addType = form.querySelector('.tk-add-type');
        els.addPlace = form.querySelector('.tk-add-place');
      }
    }

    // Body: Today list · Upcoming · Completed · one-line empty state.
    if (body && !body.querySelector('#tk-upcoming')) {
      const empty = $('#tasks-empty');
      if (empty) {
        empty.className = 'tk-empty';
        empty.textContent = '';
        empty.appendChild(h('p', { class: 'tk-empty-line', id: 'tk-empty-line' }));
      }
      const mkSection = (id, label, tip) => {
        const list = h('ul', { class: 'task-list tk-list', id: `${id}-list` });
        const toggle = h('button', { class: 'tk-sec-toggle', type: 'button', 'aria-expanded': 'false', 'aria-controls': `${id}-list`, title: tip },
          icon('chev', 'tk-sec-chev'), h('span', { class: 'tk-sec-label', text: label }), h('span', { class: 'count-badge tk-sec-count' }));
        const sec = h('section', { class: 'tk-section', id, 'aria-label': label }, toggle, list);
        return { sec, list, toggle };
      };
      const up = mkSection('tk-upcoming', 'Upcoming', 'Tasks due or scheduled on a later day');
      const past = mkSection('tk-pastdue', 'Past due', 'Open tasks whose due date has passed — reschedule, finish or delete them');
      const done = mkSection('tk-done', 'Completed', 'Finished tasks — tick one again to bring it back');
      up.toggle.addEventListener('click', () => { ui.upcomingOpen = !ui.upcomingOpen; saveUI(); render(); });
      past.toggle.addEventListener('click', () => { ui.pastdueOpen = !ui.pastdueOpen; saveUI(); render(); });
      done.toggle.addEventListener('click', () => { ui.completedOpen = !completedOpen(); saveUI(); render(); });
      body.append(up.sec, past.sec, done.sec);
    }
    els.card = card;
    els.list = $('#task-list');
    if (els.list) els.list.classList.add('tk-list');
    return true;
  }

  const completedOpen = () => (ui.completedOpen == null ? !!Store.settings().showCompletedTasks : !!ui.completedOpen);

  function renderDraft() {
    if (!els.addDue) return;
    els.addDue.textContent = '';
    els.addDue.append(icon('cal'), h('span', { text: draft.due ? `Due ${shortDay(draft.due)}` : 'Due date' }));
    els.addDue.classList.toggle('is-set', !!draft.due);
    els.addDue.title = draft.due ? 'Change the due date — tasks with a due date also show on your calendar' : 'Optional: when it’s due. It also shows on your calendar';
    els.addDue.setAttribute('aria-label', draft.due ? `Due ${shortDay(draft.due)}. Change due date` : 'Set a due date (optional)');
    els.addEst.textContent = '';
    const n = draft.estimate;
    els.addEst.append(icon('tomato'), h('span', { text: `${n} pomodoro${n === 1 ? '' : 's'}` }));
    els.addEst.classList.toggle('is-set', n !== 1);
    els.addEst.title = `Estimate: ${n} × ${pomo().focus}-minute focus session${n === 1 ? '' : 's'}`;
    els.addEst.setAttribute('aria-label', `Estimate ${n} pomodoro${n === 1 ? '' : 's'}. Change estimate`);
    if (els.addType) {
      const c = draft.category;
      els.addType.textContent = '';
      els.addType.append(c ? typeDot(c) : icon('tag'), h('span', { text: c || 'Type of work' }));
      els.addType.classList.toggle('is-set', !!c);
      els.addType.title = c ? 'Change the type of work' : 'Optional: what kind of work this is — Work, Study, Chores or your own';
      els.addType.setAttribute('aria-label', c ? `Type of work: ${c}. Change it` : 'Set the type of work (optional)');
    }
    if (els.addPlace) {
      const locs = draft.locations;
      const l = locs.length ? locs.join(' · ') : '';
      els.addPlace.textContent = '';
      els.addPlace.append(icon('pin'), h('span', { text: l || 'Location' }));
      els.addPlace.classList.toggle('is-set', locs.length > 0);
      els.addPlace.title = locs.length ? 'Change where you’ll do it (pick any number of places)' : 'Optional: where you’ll do it — home, school, the library… (pick any number)';
      els.addPlace.setAttribute('aria-label', locs.length ? `Locations: ${l}. Change them` : 'Set the locations (optional)');
    }
    // the field's options show while you add a task (styles: .tk-add.is-open)
    syncAddOpen();
  }

  function syncAddOpen() {
    const form = $('#add-task-form');
    const input = $('#add-task-input');
    if (!form || !input) return;
    const tplOpen = !!($('#templates') && !$('#templates').hidden);
    form.classList.toggle('is-open', !!input.value.trim() || !!draft.due || draft.estimate !== 1 || !!draft.category || draft.locations.length > 0 || tplOpen);
  }

  // ───────────────────────────  rendering  ───────────────────────────

  function render() {
    if (!ready) return;
    if (inlineEditing) { renderPending = true; return; }
    renderPending = false;
    const all = Store.tasks();
    const today = [], upcoming = [], pastdue = [], done = [];
    for (const t of all) {
      const s = sectionOf(t);
      (s === 'done' ? done : s === 'pastdue' ? pastdue : s === 'upcoming' ? upcoming : today).push(t);
    }
    // Overdue tasks are now visible in Past due, so the current task can stay current even
    // after its due date passes — the timer never switches tasks behind your back.
    // Manual keeps the order you drag into; every other sort is a view over the same data.
    const ordered = (list) => sortTasks(list);
    const todayView = ordered(today);
    const upcomingView = ordered(upcoming);
    const pastView = ordered(pastdue);
    // Completed history is complete and newest-first — never capped. Older records without a
    // completion stamp fall back to their due date so they still sit in a sensible place.
    const doneView = done.slice().sort((a, b) => completedAtMs(b) - completedAtMs(a) ||
      String(a.title).localeCompare(String(b.title), undefined, { sensitivity: 'base' }));

    const list = els.list;
    list.textContent = '';
    todayView.forEach((t) => list.appendChild(renderRow(t, 'today')));
    list.hidden = !todayView.length;

    const empty = $('#tasks-empty');
    const line = $('#tk-empty-line');
    if (empty && line) {
      empty.hidden = todayView.length > 0;
      line.textContent = !all.length
        ? 'Type a task above and press Enter. Give it a due date and it shows on your calendar too.'
        : (pastdue.length && !today.length ? 'Nothing due today — past-due tasks are below.' : 'Nothing due');
    }

    renderSection('tk-upcoming', upcomingView, ui.upcomingOpen, 'upcoming');
    renderSection('tk-pastdue', pastView, ui.pastdueOpen, 'pastdue');
    renderSection('tk-done', doneView, completedOpen(), 'done', done.length);

    renderHeader(today);
    renderSort();
    renderTemplates();
    renderCategoryOptions();
    renderDraft();
  }

  function sortKey(t) {
    const ts = TS();
    const nb = ts ? ts.nextBlock(t.id) : null;
    const a = t.dueDate || '9999';
    const b = nb ? ts.dayKey(new Date(nb.start)) : '9999';
    return a < b ? a : b;
  }

  function sortTasks(list) {
    const arr = list.slice();
    const byTitle = (a, b) => String(a.title || '').localeCompare(String(b.title || ''), undefined, { sensitivity: 'base' });
    if (ui.sort === 'due') arr.sort((a, b) => sortKey(a).localeCompare(sortKey(b)) || byTitle(a, b));
    else if (ui.sort === 'type') arr.sort((a, b) =>
      String(a.category || '\uffff').localeCompare(String(b.category || '\uffff'), undefined, { sensitivity: 'base' }) || byTitle(a, b));
    else if (ui.sort === 'title') arr.sort(byTitle);
    return arr;
  }

  function sortLabel() {
    const s = SORTS.find((x) => x.id === ui.sort);
    return s ? s.label : 'Manual';
  }

  function sortMenu(anchor) {
    openMenu(anchor, [
      { heading: 'Sort tasks' },
      ...SORTS.map((s) => ({
        label: s.label, hint: s.id === ui.sort ? 'now' : s.hint, checked: ui.sort === s.id, pick: true,
        run: () => { ui.sort = s.id; saveUI(); render(); },
      })),
    ], { label: 'Sort tasks', width: 236 });
  }

  function renderSection(id, tasks, open, kind, total = tasks.length) {
    const sec = document.getElementById(id);
    if (!sec) return;
    sec.hidden = total === 0;
    const toggle = sec.querySelector('.tk-sec-toggle');
    const list = sec.querySelector('.tk-list');
    toggle.setAttribute('aria-expanded', String(!!open));
    sec.classList.toggle('is-open', !!open);
    sec.querySelector('.tk-sec-count').textContent = String(total);
    list.textContent = '';
    list.hidden = !open;
    if (open) tasks.forEach((t) => list.appendChild(renderRow(t, kind)));
  }

  function renderHeader(today) {
    const open = today.filter((t) => !t.isDone);
    const badge = $('#open-count');
    if (badge) {
      badge.textContent = String(open.length);
      badge.hidden = open.length === 0;
      badge.title = `${open.length} open task${open.length === 1 ? '' : 's'} for today`;
    }
    const label = $('#tasks-estimate');
    if (!label) return;
    const s = pomo();
    const n = open.reduce((sum, t) => sum + Math.max(0, (t.estimate || 1) - (t.completedPomodoros || 0)), 0);
    if (n > 0) {
      const mins = n * s.focus + Math.max(0, n - 1) * s.short + Math.floor(Math.max(0, n - 1) / s.interval) * Math.max(0, s.long - s.short);
      const end = new Date(Date.now() + mins * 60000);
      const sameDay = dayKey(end) === todayKey();
      label.textContent = `≈ ${fmtMinutes(mins)}${sameDay && timeFmt ? ` · done by ${timeFmt.format(end)}` : ''}`;
      label.title = `${n} pomodoro${n === 1 ? '' : 's'} left today (${s.focus}-minute focus sessions plus breaks)`;
      label.hidden = false;
    } else {
      label.hidden = true;
    }
  }

  function renderSort() {
    const b = els.sortBtn;
    if (!b) return;
    b.classList.toggle('is-set', ui.sort !== 'manual');
    b.title = `Sort tasks — now: ${sortLabel()}`;
    b.setAttribute('aria-label', `Sort tasks. Now: ${sortLabel()}`);
  }

  function renderRow(task, kind) {
    const ts = TS();
    const active = Store.activeTask();
    const isActive = !!(active && sameID(active.id, task.id));
    const li = h('li', { class: 'task-row tk-row', dataset: { id: task.id, kind } });
    if (task.isDone) li.classList.add('is-done');
    if (isActive) { li.classList.add('is-active'); li.setAttribute('aria-current', 'true'); }

    // grip: a visual cue — the whole row drags (press and move; on touch, hold then move).
    // Dragging only changes the list in Manual; in another sort it would look like nothing happened.
    if (!task.isDone && kind === 'today' && ui.sort === 'manual') {
      li.classList.add('is-sortable');
      li.appendChild(h('span', { class: 'drag-handle tk-grip', title: 'Drag to reorder (or Alt + ↑ / ↓)', 'aria-hidden': 'true', html: ICONS.grip }));
    }

    // the big checkbox
    const check = h('button', {
      class: 'tk-check', type: 'button', role: 'checkbox', 'aria-checked': String(!!task.isDone),
      'aria-label': task.isDone ? `Mark “${task.title}” as not done` : `Mark “${task.title}” as done`,
      title: task.isDone ? 'Mark as not done' : 'Mark as done', html: ICONS.check,
    });
    check.addEventListener('click', (ev) => {
      if (ev.detail > 1 || li.classList.contains('is-completing')) return;   // a double-click would land on the next row
      if (task.isDone) { complete(task); return; }
      // Show the tick for a beat so the click visibly lands, then move the row to Completed.
      li.classList.add('is-completing');
      check.setAttribute('aria-checked', 'true');
      const calm = Store.settings().reduceMotion || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
      setTimeout(() => complete(task), calm ? 0 : 320);
    });
    check.addEventListener('keydown', (ev) => onRowKey(ev, task));
    li.appendChild(check);

    // main column
    const main = h('div', { class: 'tk-main' });
    const line1 = h('div', { class: 'tk-line1' });
    const title = h('span', { class: 'tk-title task-title', text: task.title, tabindex: '0', role: 'button',
      title: task.isDone ? task.title : (isActive ? 'You’re focusing on this · double-click to rename' : 'Click to focus on this · double-click to rename'),
      'aria-label': task.isDone ? task.title : `${task.title}. ${isActive ? 'In focus' : 'Focus on this task'}; F2 renames` });
    if (!task.isDone) {
      title.addEventListener('dblclick', (ev) => { ev.preventDefault(); beginRename(task, title); });
      title.addEventListener('keydown', (ev) => {
        if (ev.key === 'F2') { ev.preventDefault(); beginRename(task, title); }
        else if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); focusTask(task); }
        else onRowKey(ev, task);
      });
    }
    line1.appendChild(title);

    // ≤ 2 chips: completed · due · scheduled (· course when there is room)
    const chips = h('span', { class: 'tk-chips' });
    if (task.isDone) {
      const when = task.completedAt && Number.isFinite(Date.parse(task.completedAt))
        ? new Date(task.completedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
        : null;
      chips.appendChild(h('span', { class: 'tk-chip tk-chip-done', title: when ? `Completed ${when}` : 'Completed' },
        icon('check'), h('span', { text: completedLabel(task) })));
    }
    const due = dueLabel(task);
    if (due) {
      const c = h('button', { class: 'tk-chip tk-chip-btn tk-chip-due' + (due.overdue ? ' is-overdue' : due.today ? ' is-today' : ''), type: 'button',
        title: `${due.title} — click to change`, 'aria-haspopup': 'menu' }, icon('cal'), h('span', { text: due.text }));
      c.addEventListener('click', () => dueMenu(c, task.dueDate, (k) => Store.updateTask(task.id, { dueDate: k, dueAt: null })));
      chips.appendChild(c);
    }
    const nb = ts && !task.isDone ? ts.nextBlock(task.id) : null;
    if (nb) {
      const now = Date.now();
      const live = !nb.allDay && new Date(nb.start).getTime() <= now && new Date(nb.end).getTime() > now;
      const c = h('button', { class: 'tk-chip tk-chip-btn tk-chip-slot' + (live ? ' is-live' : ''), type: 'button',
        title: 'Scheduled on your calendar — click to see it' }, icon('clock'), h('span', { text: ts.slotLabel(nb) }));
      c.addEventListener('click', () => ts.openOnCalendar(ts.dayKey(new Date(nb.start))));
      chips.appendChild(c);
    }
    // type of work · locations. Imported tasks (Canvas, Google…) arrive without them, so their chip
    // always shows and names what's missing ("● Study · ＋ Location"); your own tasks show it once set.
    const imported = !!task.externalSource && task.externalSource !== 'local';
    const places = locationsOf(task);
    const placeText = places.length ? places.join(' · ') : '';
    if (!task.isDone && chips.childElementCount < 3 && (task.category || places.length || imported)) {
      const missing = !task.category || !places.length;
      const c = h('button', { class: 'tk-chip tk-chip-btn tk-chip-meta' + (missing ? ' is-missing' : ''),
        type: 'button', 'aria-haspopup': 'menu',
        title: missing ? 'Pick the type of work and where you’ll do it — Reports and your focus fingerprint use them' : 'Change the type of work or locations',
        'aria-label': `${task.category || 'No type'}, ${placeText || 'no location'}. Set type of work and locations` },
      task.category ? typeDot(task.category) : icon('tag'),
      h('span', { class: task.category ? '' : 'tk-meta-add', text: task.category || '＋ Type' }),
      h('span', { class: 'tk-meta-sep', 'aria-hidden': 'true', text: '·' }),
      h('span', { class: places.length ? '' : 'tk-meta-add', text: placeText || '＋ Location' }));
      c.addEventListener('click', () => metaMenu(c, task));
      chips.appendChild(c);
    }
    if (chips.childElementCount < 2 && task.course) {
      chips.appendChild(h('span', { class: 'tk-chip tk-chip-course', title: `${task.course}${task.externalSource ? ` · from ${sourceName(task)}` : ''}` },
        h('span', { text: shortCourse(task.course) })));
    }
    if (chips.childElementCount) line1.appendChild(chips);

    // pomodoro progress sits at the end of the title line (no second line just for it): "◷ 1/3"
    // and it's a button: click to say how many pomodoros the task needs
    const est = task.estimate || 1, got = task.completedPomodoros || 0;
    if (!task.isDone) {
      const pb = h('button', { class: 'tk-pomos tk-pomos-btn' + (got > 0 ? ' has-progress' : ''), type: 'button', 'aria-haspopup': 'menu',
        title: `${got} of ${est} pomodoro${est === 1 ? '' : 's'} done — click to change how many it needs`,
        'aria-label': `${got} of ${est} pomodoros done. Change how many this task needs` }, icon('tomato'), h('span', { text: `${got}/${est}` }));
      pb.addEventListener('click', (ev) => { ev.stopPropagation(); estMenu(pb, est, (n) => Store.updateTask(task.id, { estimate: n, estimateSet: true })); });
      line1.appendChild(pb);
    }
    main.appendChild(line1);

    // subtasks toggle + list (only when there are subtasks)
    const subs = Array.isArray(task.subtasks) ? task.subtasks : [];
    if (!task.isDone && subs.length) {
      const line2 = h('div', { class: 'tk-line2' });
      const doneSubs = subs.filter((s) => s.isDone).length;
      const open = expanded.has(task.id);
      const tg = h('button', { class: 'tk-subs-toggle', type: 'button', 'aria-expanded': String(open),
        title: open ? 'Hide subtasks' : 'Show subtasks' }, icon('chev', 'tk-subs-chev'), h('span', { text: `${doneSubs}/${subs.length} subtasks` }));
      tg.addEventListener('click', () => { if (open) expanded.delete(task.id); else expanded.add(task.id); render(); });
      line2.appendChild(tg);
      main.appendChild(line2);
      if (open) {
        const ul = h('ul', { class: 'subtask-list tk-subs' });
        for (const sub of subs) {
          const row = h('li', { class: 'subtask-row' + (sub.isDone ? ' is-done' : '') });
          row.appendChild(h('button', { class: 'subtask-check', type: 'button', role: 'checkbox', 'aria-checked': String(!!sub.isDone),
            'aria-label': `${sub.isDone ? 'Uncheck' : 'Check'} subtask ${sub.title}`, onclick: () => Store.toggleSubtask(task.id, sub.id) }));
          row.appendChild(h('span', { class: 'subtask-text', text: sub.title }));
          ul.appendChild(row);
        }
        main.appendChild(ul);
      }
    }
    li.appendChild(main);

    // actions (hover / focus on mouse; always on touch)
    const actions = h('div', { class: 'task-actions tk-actions' });
    if (!task.isDone) {
      if (ts && !nb) {
        actions.appendChild(h('button', { class: 'tk-act tk-act-text', type: 'button', title: 'Put this in your next free time on the calendar',
          'aria-label': `Schedule “${task.title}” in your next free time`, onclick: () => ts.schedule(task.id) }, icon('cal'), h('span', { class: 'tk-act-label', text: 'Schedule' })));
      }
      actions.appendChild(h('button', { class: 'tk-act tk-act-play', type: 'button', title: 'Start a focus session on this task',
        'aria-label': `Start focus on “${task.title}”`, html: ICONS.play, onclick: () => startTask(task) }));
    }
    const moreBtn = h('button', { class: 'tk-act', type: 'button', title: 'More: rename, due date, estimate, subtasks, delete',
      'aria-label': `More options for “${task.title}”`, 'aria-haspopup': 'menu', html: ICONS.more });
    moreBtn.addEventListener('click', () => moreMenu(task, moreBtn));
    actions.appendChild(moreBtn);
    li.appendChild(actions);

    // a click anywhere else on an open task's row puts it on the timer
    if (!task.isDone) {
      li.addEventListener('click', (ev) => {
        if (Date.now() < suppressClickUntil || inlineEditing) return;
        if (ev.target.closest('button, input, a, select, textarea, .tk-subs')) return;
        if (ev.detail > 1) return;                       // the second click of a rename double-click
        focusTask(task);
      });
      if (kind === 'today') li.addEventListener('pointerdown', (ev) => onRowPointerDown(ev, li, task));
    }
    return li;
  }

  /* Puts a task on the timer: the ring shows it and the running (or next) session counts for it. */
  function focusTask(task) {
    const t = Store.tasks().find((x) => sameID(x.id, task.id));
    if (!t || t.isDone) return;
    const active = Store.activeTask();
    if (!(active && sameID(active.id, t.id))) {
      Store.setActiveTask(t.id);
      if (typeof Timer !== 'undefined' && Timer.refreshActiveTask) Timer.refreshActiveTask();
    }
    const ringTask = document.getElementById('ring-task');
    if (ringTask) { ringTask.classList.remove('is-pulse'); void ringTask.offsetWidth; ringTask.classList.add('is-pulse'); }
    const ring = document.querySelector('#view-focus .ring-wrap');
    const r = ring ? ring.getBoundingClientRect() : null;
    if (r && (r.bottom < 40 || r.top > window.innerHeight - 40)) {
      toast(`Focusing on “${t.title.length > 40 ? t.title.slice(0, 39) + '…' : t.title}”`);
    }
  }

  // ── drag to reorder: press anywhere on a row and move it (touch: hold for a moment first).
  //    The other rows slide out of the way; letting go drops it there. Esc cancels. ──

  let rowDrag = null;
  let suppressClickUntil = 0;
  const HOLD_MS = 220;

  function onRowPointerDown(ev, li, task) {
    if (rowDrag || inlineEditing || ev.button !== 0 || !ev.isPrimary) return;
    if (ev.target.closest('button, input, a, select, textarea, .tk-subs')) return;
    const list = li.parentNode;
    if (!list || list.querySelectorAll(':scope > .tk-row.is-sortable').length < 2) return;
    const fromGrip = !!ev.target.closest('.tk-grip');
    rowDrag = { li, task, list, x0: ev.clientX, y0: ev.clientY, t0: ev.timeStamp, pointerId: ev.pointerId, started: false,
      hold: ev.pointerType !== 'mouse' && !fromGrip, timer: 0, ready: ev.pointerType === 'mouse' || fromGrip };
    if (rowDrag.hold) {
      rowDrag.timer = setTimeout(() => { if (rowDrag && !rowDrag.started) { rowDrag.ready = true; li.classList.add('is-armed'); } }, HOLD_MS);
    }
    document.addEventListener('pointermove', onRowDragMove);
    document.addEventListener('pointerup', onRowDragUp);
    document.addEventListener('pointercancel', onRowDragCancel);
    document.addEventListener('keydown', onRowDragKey, true);
  }

  function beginRowDrag() {
    const d = rowDrag;
    d.started = true;
    d.rows = Array.from(d.list.querySelectorAll(':scope > .tk-row'));
    d.index = d.rows.indexOf(d.li);
    const listTop = d.list.getBoundingClientRect().top;
    d.boxes = d.rows.map((r) => { const b = r.getBoundingClientRect(); return { top: b.top - listTop, h: b.height }; });
    const me = d.boxes[d.index];
    d.grab = d.y0 - (listTop + me.top);
    d.step = me.h + (parseFloat(getComputedStyle(d.list).rowGap) || 6);
    d.slot = d.index;
    d.li.classList.remove('is-armed');
    d.li.classList.add('is-lifted');
    d.list.classList.add('is-reordering');
    document.body.classList.add('tk-reordering');
    try { if (d.hold && navigator.vibrate) navigator.vibrate(8); } catch (_) {}
    closeMenu();
  }

  function onRowDragMove(ev) {
    const d = rowDrag;
    if (!d || ev.pointerId !== d.pointerId) return;
    if (!d.started) {
      const dist = Math.hypot(ev.clientX - d.x0, ev.clientY - d.y0);
      if (d.hold) {
        // timed by the events themselves, so a busy page can't turn a quick swipe into a drag
        if (ev.timeStamp - d.t0 < HOLD_MS) { if (dist > 8) endRowDrag(false); return; }   // a scroll
        d.ready = true;
      }
      if (dist < 4) return;
      beginRowDrag();
    }
    ev.preventDefault();
    const listRect = d.list.getBoundingClientRect();
    const top = Math.max(-d.boxes[d.index].h / 2, Math.min(ev.clientY - listRect.top - d.grab, listRect.height - d.boxes[d.index].h / 2));
    d.li.style.transform = `translateY(${Math.round(top - d.boxes[d.index].top)}px)`;
    const centre = top + d.boxes[d.index].h / 2;
    let slot = 0;
    d.boxes.forEach((b, i) => { if (i !== d.index && centre > b.top + b.h / 2) slot++; });
    if (slot !== d.slot) {
      d.slot = slot;
      d.rows.forEach((r, i) => {
        if (i === d.index) return;
        let off = 0;
        if (d.index < slot && i > d.index && i <= slot) off = -d.step;
        else if (d.index > slot && i >= slot && i < d.index) off = d.step;
        r.style.transform = off ? `translateY(${off}px)` : '';
      });
    }
    // held near an edge: the list scrolls (when it overflows), else the page does
    const box = d.list.closest('.tasks-body');
    if (box && box.scrollHeight > box.clientHeight + 1) {
      const br = box.getBoundingClientRect();
      if (ev.clientY < br.top + 24 && box.scrollTop > 0) box.scrollTop -= 8;
      else if (ev.clientY > br.bottom - 24 && box.scrollTop < box.scrollHeight - box.clientHeight) box.scrollTop += 8;
    }
    const barH = (document.querySelector('.topbar') || { offsetHeight: 0 }).offsetHeight;
    if (ev.clientY < barH + 28) window.scrollBy(0, -8);
    else if (ev.clientY > window.innerHeight - 28) window.scrollBy(0, 8);
  }

  function onRowDragUp(ev) {
    const d = rowDrag;
    if (!d || ev.pointerId !== d.pointerId) return;
    endRowDrag(d.started);
  }
  function onRowDragCancel() { endRowDrag(false); }
  function onRowDragKey(ev) {
    if (ev.key === 'Escape' && rowDrag) { ev.preventDefault(); ev.stopPropagation(); endRowDrag(false); }
  }

  /* Ends the gesture; commit = drop the row in its slot (with a short slide into place). */
  function endRowDrag(commit) {
    const d = rowDrag;
    if (!d) return;
    rowDrag = null;
    clearTimeout(d.timer);
    document.removeEventListener('pointermove', onRowDragMove);
    document.removeEventListener('pointerup', onRowDragUp);
    document.removeEventListener('pointercancel', onRowDragCancel);
    document.removeEventListener('keydown', onRowDragKey, true);
    d.li.classList.remove('is-armed');
    if (!d.started) return;
    suppressClickUntil = Date.now() + 350;
    document.body.classList.remove('tk-reordering');
    const target = commit && d.slot !== d.index ? d.rows[d.slot] : null;
    // remember where every row is drawn now, so the re-render can slide from there
    const from = new Map(d.rows.map((r) => [r.dataset.id, r.getBoundingClientRect().top]));
    d.rows.forEach((r) => { r.style.transform = ''; });
    d.li.classList.remove('is-lifted');
    d.list.classList.remove('is-reordering');
    if (target) moveTask(d.task.id, target.dataset.id);
    slideFrom(from, d.task.id);
  }

  /* FLIP: rows start where they were drawn and glide to their new places. */
  function slideFrom(from, liftedId) {
    const calm = Store.settings().reduceMotion || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
    if (calm || !els.list) return;
    const rows = Array.from(els.list.querySelectorAll(':scope > .tk-row'));
    for (const r of rows) {
      const y = from.get(r.dataset.id);
      if (y == null) continue;
      const dy = y - r.getBoundingClientRect().top;
      if (Math.abs(dy) < 1) continue;
      r.style.transition = 'none';
      r.style.transform = `translateY(${dy}px)`;
      if (sameID(r.dataset.id, liftedId)) r.classList.add('is-dropping');
    }
    requestAnimationFrame(() => requestAnimationFrame(() => {
      for (const r of rows) {
        if (!r.style.transform) continue;
        r.style.transition = '';
        r.style.transform = '';
        setTimeout(() => r.classList.remove('is-dropping'), 260);
      }
    }));
  }

  // Touch: once a row is lifted the page must not scroll under the finger.
  document.addEventListener('touchmove', (ev) => { if (rowDrag && (rowDrag.started || rowDrag.ready)) ev.preventDefault(); }, { passive: false });

  function sourceName(t) {
    const m = { canvas: 'Canvas', blackbaud: 'Blackbaud', googleTasks: 'Google Tasks', ics: 'your calendar', calendar: 'your calendar' };
    return m[t.externalSource] || 'a calendar';
  }

  /* Canvas's feed hands out calendar links; open the assignment page instead when we can. */
  function externalURL(t) {
    if (!t || !t.url) return '';
    try {
      if (t.externalSource === 'canvas' && typeof Assignments !== 'undefined' && Assignments.canvasURL) {
        const m = /:a(\d{1,15})$/i.exec(String(t.externalID || ''));
        return Assignments.canvasURL(t.url, m ? m[1] : null) || t.url;
      }
    } catch (_) { /* keep the stored link */ }
    return t.url;
  }

  function moveTask(fromId, toId) {
    const vis = Store.visibleTasks();
    const from = vis.findIndex((t) => sameID(t.id, fromId));
    const to = vis.findIndex((t) => sameID(t.id, toId));
    if (from < 0 || to < 0 || from === to) return;
    Store.reorderTasks(from, to);
  }

  function onRowKey(ev, task) {
    if (!ev.altKey || (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown')) return;
    if (ui.sort !== 'manual') return;   // reordering is a Manual-sort action
    ev.preventDefault();
    const rows = Array.from(els.list.querySelectorAll(':scope > .tk-row'));
    const i = rows.findIndex((r) => sameID(r.dataset.id, task.id));
    const j = ev.key === 'ArrowUp' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= rows.length) return;
    moveTask(task.id, rows[j].dataset.id);
    setTimeout(() => {
      const row = els.list.querySelector(`.tk-row[data-id="${CSS.escape(task.id)}"] .tk-check`);
      if (row) row.focus();
    }, 0);
  }

  // ── inline rename ──

  function beginRename(task, span) {
    if (inlineEditing) return;
    inlineEditing = true;
    const input = h('input', { class: 'tk-title-input', type: 'text', maxlength: '120', 'aria-label': 'Task title' });
    input.value = task.title;
    span.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      inlineEditing = false;
      const v = input.value.trim();
      if (save && v && v !== task.title) Store.updateTask(task.id, { title: v });
      render();
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
      else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
  }

  // ───────────────────────────  small menus (no modals)  ───────────────────────────

  function closeMenu(refocus) {
    if (!menu) return;
    const m = menu;
    menu = null;
    m.cleanup();
    m.el.remove();
    if (m.anchor) m.anchor.setAttribute('aria-expanded', 'false');
    if (refocus && m.anchor && document.body.contains(m.anchor)) m.anchor.focus();
  }

  /* items: [{label, hint, icon, run, danger, checked, sep, heading, node}] */
  function openMenu(anchor, items, { label = 'Options', width = 236 } = {}) {
    const same = menu && menu.anchor === anchor;
    closeMenu();
    if (same) return;
    const el = h('div', { class: 'tk-menu', role: 'menu', 'aria-label': label });
    el.style.width = `${width}px`;
    for (const it of items) {
      if (!it) continue;
      if (it.sep) { el.appendChild(h('div', { class: 'tk-menu-sep', role: 'separator' })); continue; }
      if (it.heading) { el.appendChild(h('div', { class: 'tk-menu-head', text: it.heading })); continue; }
      if (it.node) { el.appendChild(it.node); continue; }
      // a coloured dot stays put when its item is picked; the tick moves to the end instead
      const mark = it.dot ? h('span', { class: 'tk-menu-mark' }, typeDot(it.label, it.dot))
        : h('span', { class: 'tk-menu-mark', html: it.checked ? ICONS.check : (it.icon ? ICONS[it.icon] : '') });
      const b = h('button', { class: 'tk-menu-item' + (it.danger ? ' is-danger' : '') + (it.checked ? ' is-checked' : ''), type: 'button', role: 'menuitem',
        'aria-checked': it.checked != null && (it.dot || it.pick) ? String(!!it.checked) : null },
        mark,
        h('span', { class: 'tk-menu-label', text: it.label }),
        it.hint ? h('span', { class: 'tk-menu-hint', text: it.hint }) : null,
        it.dot && it.checked ? h('span', { class: 'tk-menu-tick', html: ICONS.check, 'aria-hidden': 'true' }) : null);
      b.addEventListener('click', () => { closeMenu(!it.keepFocus); it.run && it.run(); });
      el.appendChild(b);
    }
    document.body.appendChild(el);
    const r = anchor.getBoundingClientRect();
    const mh = el.offsetHeight, mw = el.offsetWidth;
    let top = r.bottom + 6;
    // opening upward from the add field's chips, clear the whole field so the title you typed stays in view
    const field = anchor.closest('.tk-add');
    if (top + mh > window.innerHeight - 8) top = Math.max(8, (field ? field.getBoundingClientRect().top : r.top) - mh - 6);
    let left = Math.min(Math.max(8, r.right - mw), window.innerWidth - mw - 8);
    if (r.left + mw <= window.innerWidth - 8 && r.left >= 8 && anchor.closest('.tk-add')) left = r.left;
    el.style.top = `${Math.round(top)}px`;
    el.style.left = `${Math.round(left)}px`;
    anchor.setAttribute('aria-expanded', 'true');

    const focusables = () => Array.from(el.querySelectorAll('.tk-menu-item, input'));
    const onKey = (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeMenu(true); return; }
      const stepper = /^(number|date)$/.test(document.activeElement.type);   // arrows change the value in these
      if ((ev.key === 'ArrowDown' || ev.key === 'ArrowUp') && !stepper) {
        const f = focusables();
        if (!f.length) return;
        ev.preventDefault();
        const i = f.indexOf(document.activeElement);
        const j = ev.key === 'ArrowDown' ? (i + 1) % f.length : (i - 1 + f.length) % f.length;
        f[j].focus();
      }
      if (ev.key === 'Tab') { ev.preventDefault(); closeMenu(true); }
    };
    const onDown = (ev) => { if (!el.contains(ev.target) && !anchor.contains(ev.target)) closeMenu(); };
    const onScroll = (ev) => { if (ev.target === window || !el.contains(ev.target)) closeMenu(); };
    el.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('resize', onScroll);
    document.addEventListener('scroll', onScroll, true);
    menu = { el, anchor, cleanup: () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('resize', onScroll);
      document.removeEventListener('scroll', onScroll, true);
    } };
    const first = el.querySelector('.tk-menu-item');
    if (first) first.focus({ preventScroll: true });
  }

  function nextWeekday(target) {   // 0 = Sunday … 6 = Saturday; always a later day
    const d = addDays(new Date(), 1);
    while (d.getDay() !== target) d.setDate(d.getDate() + 1);
    return d;
  }

  function dueMenu(anchor, current, onPick) {
    const t0 = addDays(new Date(), 0);
    const opts = [
      { label: 'Today', key: dayKey(t0), hint: wdFmt ? wdFmt.format(t0) : '' },
      { label: 'Tomorrow', key: dayKey(addDays(t0, 1)), hint: wdFmt ? wdFmt.format(addDays(t0, 1)) : '' },
      { label: 'This weekend', key: dayKey(t0.getDay() === 6 ? t0 : nextWeekday(6)), hint: 'Sat' },
      { label: 'Next week', key: dayKey(nextWeekday(1)), hint: mdFmt ? mdFmt.format(nextWeekday(1)) : 'Mon' },
    ];
    const picker = h('input', { class: 'tk-menu-date', type: 'date', 'aria-label': 'Pick a due date', min: dayKey(t0) });
    if (current) picker.value = current;
    // Chrome fires 'change' on every digit of a typed year (2 → year 0002), so a typed date waits for
    // Enter or leaving the field; the calendar popup fires it once, with the date you chose.
    let typed = false;
    const commit = () => {
      const v = picker.value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || v < picker.min) return;
      typed = false;
      closeMenu(true);
      onPick(v);
    };
    picker.addEventListener('change', () => { if (!typed) commit(); });
    picker.addEventListener('blur', () => { if (typed) commit(); });
    picker.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
      else if (ev.key === 'Escape') typed = false;
      else if (/^[0-9]$/.test(ev.key) || ev.key === 'ArrowUp' || ev.key === 'ArrowDown') typed = true;
    });
    const pickRow = h('label', { class: 'tk-menu-pick' }, h('span', { class: 'tk-menu-mark', html: ICONS.cal }), h('span', { class: 'tk-menu-label', text: 'Pick a date' }), picker);
    openMenu(anchor, [
      { heading: 'Due date' },
      ...opts.map((o) => ({ label: o.label, hint: o.hint, checked: current === o.key, run: () => onPick(o.key) })),
      { node: pickRow },
      current ? { sep: true } : null,
      current ? { label: 'No due date', icon: 'trash', run: () => onPick(null) } : null,
    ], { label: 'Due date' });
  }

  // ── type of work · location ──
  const PLACE_IDEAS = ['Home', 'School', 'Library', 'Café'];
  function typeDot(name, color) {
    return h('span', { class: 'tk-dot', 'aria-hidden': 'true', style: `background:${color || Store.categoryColor(name)}` });
  }
  // a field at the end of a list: type a new one, Enter adds and picks it
  function newEntry(placeholder, label, onSubmit) {
    const input = h('input', { class: 'tk-menu-new', type: 'text', placeholder, 'aria-label': label, maxlength: '40', autocomplete: 'off' });
    input.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      const v = input.value.trim();
      if (!v) return;
      closeMenu(true);
      onSubmit(v);
    });
    return h('label', { class: 'tk-menu-pick tk-menu-newrow' }, h('span', { class: 'tk-menu-mark', html: ICONS.plus }), input);
  }
  function typeItems(current, onPick) {
    const items = [{ heading: 'Type of work' }];
    for (const c of Store.categories()) items.push({ label: c, dot: Store.categoryColor(c), checked: current === c, run: () => onPick(c) });
    items.push({ node: newEntry('New type…', 'Add your own type of work', (v) => onPick(Store.addCategory(v))) });
    if (current) items.push({ label: 'No type', icon: 'trash', run: () => onPick(null) });
    return items;
  }
  function placeList(values) {
    const places = [];
    const add = (p) => {
      const s = String(p == null ? '' : p).trim();
      if (s && !places.some((x) => x.toLowerCase() === s.toLowerCase())) places.push(s);
    };
    for (const p of [...values, ...Store.locations(), ...PLACE_IDEAS]) add(p);
    return places;
  }

  /* One place in the multi-select menu: a real checkbox-role button that keeps the menu
     open, so choosing Library and Home takes two taps, not two visits. */
  function placeChoice(label, checked, onToggle) {
    const mark = h('span', { class: 'tk-menu-mark', html: ICONS.pin });
    const tick = h('span', { class: 'tk-menu-tick', html: checked ? ICONS.check : '', 'aria-hidden': 'true' });
    const b = h('button', { class: 'tk-menu-item' + (checked ? ' is-checked' : ''), type: 'button',
      role: 'menuitemcheckbox', 'aria-checked': String(checked) }, mark, h('span', { class: 'tk-menu-label', text: label }), tick);
    b.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const on = !b.classList.contains('is-checked');
      b.classList.toggle('is-checked', on);
      b.setAttribute('aria-checked', String(on));
      tick.innerHTML = on ? ICONS.check : '';
      onToggle(on);
    });
    return { node: b };
  }

  function placeMenu(anchor, values, onPick) {
    let current = locationsOf({ locations: values });
    const has = (p) => current.some((x) => x.toLowerCase() === p.toLowerCase());
    const items = [{ heading: 'Locations — pick any' }];
    for (const p of placeList(current)) {
      items.push(placeChoice(p, has(p), (on) => {
        current = on ? current.concat(p).slice(0, 6) : current.filter((x) => x.toLowerCase() !== p.toLowerCase());
        onPick(current.slice());
      }));
    }
    items.push({ node: newEntry('Somewhere else…', 'Add another place', (v) => {
      if (!has(v)) current = current.concat(v).slice(0, 6);
      onPick(current.slice());
    }) });
    if (current.length) {
      items.push({ sep: true }, { label: 'Clear locations', icon: 'trash', run: () => { current = []; onPick([]); } });
    }
    items.push({ sep: true }, { label: 'Done', keepFocus: false, run: () => {} });
    openMenu(anchor, items, { label: 'Locations', width: 236 });
  }

  function typeMenu(anchor, current, onPick) {
    openMenu(anchor, typeItems(current, onPick), { label: 'Type of work', width: 220 });
  }
  // A course's type of work and location: picked once, it fills that course's other open tasks that
  // have none, and new assignments from the course arrive with it (js/assignments.js reads it).
  const COURSE_KEY = 'purefocus.courseDefaults';
  function courseOf(t) { return String(t.courseKey || t.course || '').trim().toLowerCase(); }
  function setForCourse(task, field, value) {
    const key = courseOf(task);
    if (!key || !value || (Array.isArray(value) && !value.length)) return 0;
    try {
      const all = JSON.parse(localStorage.getItem(COURSE_KEY) || '{}') || {};
      all[key] = { ...(all[key] || {}), [field]: value };
      localStorage.setItem(COURSE_KEY, JSON.stringify(all));
    } catch (_) { /* not remembered in private mode */ }
    let n = 0;
    Store.bulk(() => {
      for (const t of Store.tasks()) {
        if (t.isDone || sameID(t.id, task.id) || courseOf(t) !== key) continue;
        const filled = field === 'locations' ? locationsOf(t).length > 0 : !!t[field];
        if (filled) continue;
        Store.updateTask(t.id, { [field]: value });
        n++;
      }
    });
    return n;
  }
  function metaMenu(anchor, task) {
    const course = task.course ? shortCourse(task.course) : '';
    const pick = (field, value) => {
      Store.updateTask(task.id, { [field]: value });
      const n = setForCourse(task, field, value);
      if (n) toast(`Also set for ${n} other ${course} task${n === 1 ? '' : 's'} — and new ones from ${course}`);
    };
    let places = locationsOf(task);
    const has = (p) => places.some((x) => x.toLowerCase() === p.toLowerCase());
    const items = [
      ...typeItems(task.category, (c) => pick('category', c)),
      { sep: true },
      { heading: 'Locations — pick any' },
    ];
    for (const p of placeList(places)) {
      items.push(placeChoice(p, has(p), (on) => {
        places = on ? places.concat(p).slice(0, 6) : places.filter((x) => x.toLowerCase() !== p.toLowerCase());
        Store.updateTask(task.id, { locations: places });
        if (on) {
          const n = setForCourse(task, 'locations', places);
          if (n) toast(`Also set for ${n} other ${course} task${n === 1 ? '' : 's'} — and new ones from ${course}`);
        }
      }));
    }
    items.push({ node: newEntry('Somewhere else…', 'Add another place', (v) => {
      if (!has(v)) places = places.concat(v).slice(0, 6);
      Store.updateTask(task.id, { locations: places });
    }) });
    if (places.length) items.push({ sep: true }, { label: 'Clear locations', icon: 'trash', run: () => {
      places = [];
      Store.updateTask(task.id, { locations: [] });
    } });
    openMenu(anchor, items, { label: 'Type of work and locations', width: 260 });
  }

  function estMenu(anchor, current, onPick) {
    const s = pomo();
    const items = [{ heading: 'How many focus sessions?' }];
    for (const n of [1, 2, 3, 4, 6, 8]) {
      const mins = n * s.focus;
      items.push({ label: `${n} pomodoro${n === 1 ? '' : 's'}`, hint: `≈ ${fmtMinutes(mins)}`, checked: current === n, run: () => onPick(n) });
    }
    // any other number, 1–12
    const custom = h('input', { class: 'tk-menu-new tk-menu-num', type: 'number', min: '1', max: '12', step: '1', inputmode: 'numeric',
      placeholder: 'Other…', 'aria-label': 'Another number of pomodoros (1–12)' });
    if (![1, 2, 3, 4, 6, 8].includes(current)) custom.value = String(current);
    custom.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      const n = Math.round(Number(custom.value));
      if (!(n >= 1 && n <= 12)) { custom.select(); return; }
      closeMenu(true);
      onPick(n);
    });
    items.push({ node: h('label', { class: 'tk-menu-pick tk-menu-newrow' }, h('span', { class: 'tk-menu-mark', html: ICONS.plus }), custom,
      h('span', { class: 'tk-menu-hint', text: 'Enter' })) });
    openMenu(anchor, items, { label: 'Estimate', width: 220 });
  }

  function moreMenu(task, anchor) {
    const t = Store.tasks().find((x) => sameID(x.id, task.id));
    if (!t) return;
    const ts = TS();
    const nb = ts && !t.isDone ? ts.nextBlock(t.id) : null;
    const active = Store.activeTask();
    const items = [];
    if (t.isDone) {
      items.push({ label: 'Mark as not done', icon: 'check', run: () => complete(t) });
    } else {
      items.push({ label: 'Start focus on this', icon: 'play', run: () => startTask(t) });
      if (!(active && sameID(active.id, t.id))) items.push({ label: 'Focus on this', hint: 'doesn’t start', icon: 'clock', run: () => focusTask(t) });
      items.push({ label: 'Rename', hint: 'F2', icon: 'more', run: () => {
        const span = els.card && els.card.querySelector(`.tk-row[data-id="${CSS.escape(t.id)}"] .tk-title`);
        if (span) beginRename(t, span);
      } });
      items.push({ sep: true });
      if (ts) {
        if (nb) items.push({ label: 'See it on the calendar', icon: 'cal', run: () => ts.openOnCalendar(t.id) });
        items.push({ label: nb ? 'Schedule more time' : 'Schedule in next free time', icon: 'clock', run: () => ts.schedule(t.id) });
      }
      items.push({ label: t.dueDate ? 'Change due date…' : 'Add a due date…', icon: 'cal', keepFocus: true,
        run: () => setTimeout(() => dueMenu(anchor, t.dueDate, (k) => Store.updateTask(t.id, { dueDate: k, dueAt: null })), 0) });
      items.push({ label: 'Estimate…', hint: `${t.estimate} pomodoro${t.estimate === 1 ? '' : 's'}`, icon: 'tomato', keepFocus: true,
        run: () => setTimeout(() => estMenu(anchor, t.estimate, (n) => Store.updateTask(t.id, { estimate: n, estimateSet: true })), 0) });
      items.push({ label: 'Type of work & locations…', hint: [t.category, ...locationsOf(t)].filter(Boolean).join(' · '), icon: 'tag', keepFocus: true,
        run: () => setTimeout(() => metaMenu(anchor, t), 0) });
      items.push({ sep: true });
      items.push({ label: 'Subtasks, notes & details…', icon: 'more', run: () => openSheet(t) });
      items.push({ label: 'Save as template', icon: 'plus', run: () => { Store.addTemplate(t.title, t.estimate); toast('Saved as a template'); } });
    }
    if (t.url) items.push({ label: `Open in ${sourceName(t)}`, hint: '↗', icon: 'chev', run: () => { try { window.open(externalURL(t), '_blank', 'noopener'); } catch (_) {} } });
    items.push({ sep: true });
    items.push({ label: 'Delete', icon: 'trash', danger: true, run: () => removeTask(t) });
    openMenu(anchor, items, { label: `Options for ${t.title}`, width: 260 });
  }

  function toast(msg) {
    const ts = TS();
    if (ts) ts.toast(msg);
    else if (typeof App !== 'undefined') App.toast(msg);
  }

  // ───────────────────────────  templates · categories  ───────────────────────────

  function renderTemplates() {
    const wrap = $('#templates-list');
    if (!wrap) return;
    wrap.textContent = '';
    const tpls = Store.templates();
    if (!tpls.length) {
      wrap.appendChild(h('p', { class: 'muted-note', text: 'No templates yet. Use ⋯ › Save as template on any task.' }));
      return;
    }
    for (const tpl of tpls) {
      const del = h('span', { class: 'tpl-del', text: '×', title: 'Delete template', 'aria-hidden': 'true' });
      const chip = h('button', { class: 'template-chip', type: 'button', title: `Fill the field with “${tpl.title}”` },
        h('span', { text: tpl.title }), h('span', { class: 'tpl-est', text: `· ${tpl.estimate}` }), del);
      chip.addEventListener('click', (e) => {
        if (e.target === del) { e.stopPropagation(); Store.deleteTemplate(tpl.id); return; }
        const input = $('#add-task-input');
        input.value = tpl.title;
        draft.estimate = Math.max(1, Math.min(12, Number(tpl.estimate) || 1));
        renderDraft();
        input.focus();
      });
      wrap.appendChild(chip);
    }
  }

  function renderCategoryOptions() {
    const cats = Store.categories();
    const sel = $('#edit-category');
    if (sel) {
      const previous = sel.value;
      sel.textContent = '';
      sel.appendChild(h('option', { value: '', text: 'None' }));
      for (const c of cats) sel.appendChild(h('option', { value: c, text: c }));
      if (cats.includes(previous)) sel.value = previous;
    }
    const list = $('#location-options-2');
    if (list) {
      list.textContent = '';
      const seen = [];
      for (const loc of [...Store.locations(), ...PLACE_IDEAS]) {
        if (seen.some((x) => x.toLowerCase() === loc.toLowerCase())) continue;
        seen.push(loc);
        list.appendChild(h('option', { value: loc }));
      }
    }
  }

  // ───────────────────────────  details sheet  ───────────────────────────

  function ensureSheetFields() {
    const sheet = $('#task-sheet');
    if (!sheet || $('#edit-due')) return;
    const title = $('#sheet-title');
    if (title) title.textContent = 'Task details';
    // the sheet names them the way the add field does
    const relabel = (id, text) => { const f = $(id); const l = f && f.closest('.field') && f.closest('.field').querySelector('.field-label'); if (l) l.textContent = text; };
    relabel('#edit-category', 'Type of work');
    relabel('#edit-location', 'Locations (separate with commas)');
    const loc = $('#edit-location');
    if (loc) {
      loc.placeholder = 'e.g. Library, Home';
      loc.title = 'Add as many places as you like, separated by commas';
    }
    const est = $('#edit-estimate');
    const estField = est ? est.closest('.field') : null;
    const due = h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Due date (shows on your calendar)' }),
      h('input', { class: 'text-input', id: 'edit-due', type: 'date' }));
    const notes = h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Notes' }),
      h('textarea', { class: 'text-input tk-notes', id: 'edit-notes', rows: '2', maxlength: '2000', placeholder: 'Anything to remember' }));
    if (estField && estField.parentNode) {
      estField.parentNode.insertBefore(due, estField.nextSibling);
      const subs = $('#subtask-editor');
      const subField = subs ? subs.closest('.field') : null;
      if (subField) subField.parentNode.insertBefore(notes, subField.nextSibling);
      else estField.parentNode.appendChild(notes);
    }
  }

  let sheetOpener = null;

  function openSheet(task) {
    closeMenu();
    sheetOpener = document.activeElement;
    ensureSheetFields();
    editingId = task.id;
    editingSubtasks = (task.subtasks || []).map((s) => ({ ...s }));
    $('#edit-title').value = task.title;
    $('#edit-estimate').value = String(task.estimate);
    $('#v-edit-est').textContent = String(task.estimate);
    renderCategoryOptions();
    $('#edit-category').value = task.category || '';
    $('#edit-location').value = locationsOf(task).join(', ');
    if ($('#edit-due')) $('#edit-due').value = task.dueDate || '';
    if ($('#edit-notes')) $('#edit-notes').value = task.notes || '';
    renderSubtaskEditor();
    $('#sheet-backdrop').hidden = false;
    $('#task-sheet').hidden = false;
    setTimeout(() => $('#edit-title').focus(), 30);
  }

  function closeSheet() {
    $('#sheet-backdrop').hidden = true;
    $('#task-sheet').hidden = true;
    editingId = null;
    editingSubtasks = [];
    if (sheetOpener && sheetOpener.isConnected) try { sheetOpener.focus({ preventScroll: true }); } catch (_) {}
    sheetOpener = null;
  }

  function renderSubtaskEditor() {
    const wrap = $('#subtask-editor');
    wrap.textContent = '';
    editingSubtasks.forEach((sub, i) => {
      const input = h('input', { class: 'text-input', type: 'text', maxlength: '120', 'aria-label': `Subtask ${i + 1}` });
      input.value = sub.title;
      input.addEventListener('input', () => { editingSubtasks[i].title = input.value; });
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.metaKey && !ev.ctrlKey) { ev.preventDefault(); $('#subtask-add').click(); } });
      const del = h('button', { class: 'task-act danger', type: 'button', title: 'Remove subtask', 'aria-label': 'Remove subtask', html: ICONS.trash });
      del.addEventListener('click', () => { editingSubtasks.splice(i, 1); renderSubtaskEditor(); });
      wrap.appendChild(h('div', { class: 'subtask-edit-row' }, input, del));
    });
  }

  function saveSheet() {
    if (!editingId) return;
    const title = $('#edit-title').value.trim();
    if (!title) { $('#edit-title').focus(); return; }
    const subtasks = editingSubtasks.map((s) => ({ ...s, title: (s.title || '').trim() })).filter((s) => s.title);
    const est = Number($('#edit-estimate').value);
    const cur = Store.tasks().find((x) => sameID(x.id, editingId));
    const patch = {
      title,
      estimate: est,
      ...(cur && cur.estimate !== est ? { estimateSet: true } : {}),
      category: $('#edit-category').value || null,
      locations: locationsOf({ locations: $('#edit-location').value.split(',') }),
      subtasks,
    };
    const due = $('#edit-due');
    if (due) {
      const v = /^\d{4}-\d{2}-\d{2}$/.test(due.value) ? due.value : null;
      const cur = Store.tasks().find((t) => sameID(t.id, editingId));
      if (cur && (cur.dueDate || null) !== v) { patch.dueDate = v; patch.dueAt = null; }
    }
    const notes = $('#edit-notes');
    if (notes) patch.notes = notes.value.trim() || null;
    if (subtasks.length) expanded.add(editingId);
    Store.updateTask(editingId, patch);
    closeSheet();
  }

  // ───────────────────────────  wiring  ───────────────────────────

  function addFromField() {
    const input = $('#add-task-input');
    const title = input.value.trim();
    if (!title) { input.focus(); return; }
    const task = Store.addTask({ title, estimate: draft.estimate || 1, estimateSet: (draft.estimate || 1) !== 1, dueDate: draft.due || null,
      category: draft.category || null, locations: draft.locations });
    input.value = '';
    const due = draft.due;
    draft.due = null;
    draft.estimate = 1;
    draft.category = null;
    draft.locations = [];
    renderDraft();
    input.focus();
    if (task && due && sectionOf(task) === 'upcoming') {
      ui.upcomingOpen = true;
      saveUI();
      render();
      toast(`Added under Upcoming · due ${shortDay(due)}`);
    }
  }

  function init() {
    loadUI();
    ensureAssets();
    ensureShell();
    ensureSheetFields();

    $('#add-task-form').addEventListener('submit', (e) => {
      e.preventDefault();
      addFromField();
    });
    $('#add-task-input').addEventListener('input', syncAddOpen);
    // Pressing the field's own buttons keeps the typing focus in the field, so its options stay
    // open long enough for the click to land (Safari never focuses a clicked button).
    $('#add-task-form').addEventListener('mousedown', (e) => {
      if (e.target.closest('button') && $('#add-task-form').contains(document.activeElement)) e.preventDefault();
    });

    $('#templates-toggle').addEventListener('click', () => {
      const panel = $('#templates');
      const open = panel.hidden;
      panel.hidden = !open;
      $('#templates-toggle').setAttribute('aria-expanded', String(open));
      syncAddOpen();
    });

    const tplAdd = $('#templates-add');
    if (tplAdd) {
      tplAdd.textContent = '+ Save what’s in the field as a template';
      tplAdd.addEventListener('click', () => {
        const input = $('#add-task-input');
        const title = input.value.trim();
        if (!title) { toast('Type a task name in the field first'); input.focus(); return; }
        Store.addTemplate(title, draft.estimate || 1);
        toast('Template saved');
      });
    }

    $('#sheet-close').addEventListener('click', closeSheet);
    $('#task-sheet').addEventListener('keydown', (e) => {     // Tab stays inside the sheet
      if (e.key !== 'Tab') return;
      const sheet = e.currentTarget;
      const f = Array.from(sheet.querySelectorAll('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])'))
        .filter((n) => !n.disabled && n.offsetParent !== null);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      // Safari skips buttons on Tab unless told otherwise, so its last stop isn't always the list's last
      setTimeout(() => { if (!sheet.hidden && !sheet.contains(document.activeElement)) f[0].focus(); }, 0);
    });
    $('#sheet-cancel').addEventListener('click', closeSheet);
    $('#sheet-backdrop').addEventListener('click', closeSheet);
    $('#sheet-save').addEventListener('click', saveSheet);
    $('#edit-estimate').addEventListener('input', (e) => { $('#v-edit-est').textContent = e.target.value; });
    $('#subtask-add').addEventListener('click', () => {
      editingSubtasks.push({ id: Store.uid(), title: '', isDone: false });
      renderSubtaskEditor();
      const inputs = $('#subtask-editor').querySelectorAll('.text-input');
      if (inputs.length) inputs[inputs.length - 1].focus();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('#task-sheet').hidden) closeSheet();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !$('#task-sheet').hidden) { e.preventDefault(); saveSheet(); }
    });

    // Scheduled chips are derived from blocks: re-render when they change, and every minute ("Now · until …").
    Store.on('blocks', () => { render(); syncEstimatesSoon(); });
    Store.on('change', (k) => { if (k === 'tasks' || k === 'bulk' || k === 'remote' || k === 'settings') syncEstimatesSoon(); });
    // Imported tasks used to arrive guessing 2–4 pomodoros: the ones you haven't started or set go to 1
    // (or to their time on the calendar).
    try {
      Store.migrate('2026-10-29-imported-estimates', () => {
        for (const t of Store.tasks()) {
          if (t.isDone || !t.externalSource || t.externalSource === 'local' || t.estimateSet || (t.completedPomodoros || 0) > 0) continue;
          if (t.estimate !== 1) Store.updateTask(t.id, { estimate: 1 });
        }
      });
    } catch (_) { /* tried again next load */ }
    syncEstimatesSoon();
    Store.on('calendar', () => render());
    setInterval(() => { if (!document.hidden) render(); }, 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });

    ready = true;
    if (typeof TaskSync !== 'undefined') TaskSync.init();
    render();
  }

  return { init, render: () => render(), openSheet, closeSheet, closeMenu: () => closeMenu(), isReady: () => ready };
})();
