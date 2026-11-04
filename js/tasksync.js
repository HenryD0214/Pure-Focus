/* ═══════════════════════════════════════════════════════════════════════
   tasksync.js — the one link model between Today's Tasks and the Calendar
   (owner: WT; USER-HOTFIX-2 H16). Store stays the single source of truth:
   a task ⇄ its focus blocks are linked by block.taskID, nothing is copied.

   What this module guarantees (calendar.js must not duplicate it):
     • task renamed            → linked block titles swap the task-name prefix, keeping " · <step>" (one write)
     • linked block renamed    → the task title follows only when its task-name part changed (debounced)
     • task completed (from anywhere: the list, a block popover, a "submitted"
       assignment)             → its FUTURE linked blocks are removed in one
                                 write, with an Undo toast that restores both
     • task deleted            → same, with Undo
     • block moved / resized / deleted → nothing to do: the task's
       "2:00–2:50 PM" chip is derived live from Store.blocks()

   Public API
     TaskSync.init()                       idempotent; tasks.js calls it
     TaskSync.blocksFor(taskID)            → linked local blocks (not hidden), by start
     TaskSync.nextBlock(taskID)            → the current or next linked block | null
     TaskSync.slotLabel(block)             → "2:00–2:50 PM" · "Now · until 2:50 PM" · "Thu 2:00 PM"
     TaskSync.sectionOf(task)              → 'today' | 'pastdue' | 'upcoming' | 'done' (the current task is always
                                           'today'; 'pastdue' = overdue and not on today's calendar — not shown)
     TaskSync.dueLabel(task)               → {text, title, overdue} | null
     TaskSync.schedule(taskID)             → the first created block | null (CalendarView.scheduleTask when present)
     TaskSync.start(taskID)                → starts focus on the task (switch confirmation, plan context)
     TaskSync.complete(taskID, {toast, keep}) → marks done + removes future focus blocks (never calendar
                                           tasks, nor block `keep`), one Undo toast
     TaskSync.remove(taskID)               → deletes + removes future blocks, one Undo toast
     TaskSync.openOnCalendar(taskID | dayKey)
     TaskSync.toast(message, {undo, action:{label, run}})
     TaskSync.dayKey(date) · TaskSync.DRAG_TYPE

   Safety: titles only ever reach the DOM through textContent.
   ═══════════════════════════════════════════════════════════════════════ */

const TaskSync = (() => {
  const DRAG_TYPE = 'application/x-purefocus-task';
  const SNAP = 15;
  const DAY_MS = 86400000;
  const UNDO_MS = 8000;

  let started = false;
  let taskSnap = new Map();    // lower(id) → {title, isDone}
  let blockSnap = new Map();   // block id → {title, taskID}
  let quiet = 0;               // > 0 while this module writes (listeners ignore their own echo)
  let blockTitleTimer = 0;
  const pendingTitle = new Map();   // lower(taskID) → title (block → task rename)

  const lower = (x) => String(x == null ? '' : x).toLowerCase();
  const sameID = (a, b) => a != null && b != null && lower(a) === lower(b);
  const pad = (n) => String(n).padStart(2, '0');

  function dayKey(d) {
    const x = d instanceof Date ? d : new Date(d);
    return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
  }
  function parseDay(k) {
    if (typeof k !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(k)) return null;
    return new Date(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10));
  }
  function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  const todayKey = () => dayKey(new Date());

  function taskById(id) { return id == null ? null : Store.tasks().find((t) => sameID(t.id, id)) || null; }

  // ───────────────────────────  formatting  ───────────────────────────

  const F = (() => {
    const mk = (o) => { try { return new Intl.DateTimeFormat(undefined, o); } catch (_) { return new Intl.DateTimeFormat('en-US', o); } };
    return {
      time: mk({ hour: 'numeric', minute: '2-digit' }),
      weekday: mk({ weekday: 'short' }),
      weekdayLong: mk({ weekday: 'long' }),
      md: mk({ month: 'short', day: 'numeric' }),
      full: mk({ weekday: 'long', month: 'long', day: 'numeric' }),
    };
  })();

  /* "2:00–2:50 PM" (shared meridiem collapses), else "11:30 AM–12:20 PM". */
  function timeRange(s, e) {
    const a = F.time.format(s), b = F.time.format(e);
    const ma = /\s?([AP]M)$/i.exec(a), mb = /\s?([AP]M)$/i.exec(b);
    if (ma && mb && ma[1].toUpperCase() === mb[1].toUpperCase()) return `${a.slice(0, ma.index)}–${b}`;
    return `${a}–${b}`;
  }

  function dayWord(d) {
    const diff = Math.round((startOfDay(d) - startOfDay(new Date())) / DAY_MS);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    if (diff === -1) return 'Yesterday';
    if (diff > 1 && diff < 7) return F.weekday.format(d);
    return F.md.format(d);
  }

  function slotLabel(b) {
    if (!b) return '';
    const s = new Date(b.start), e = new Date(b.end), now = Date.now();
    if (b.allDay) return dayWord(s);
    if (+s <= now && +e > now) return `Now · until ${F.time.format(e)}`;
    const w = dayWord(s);
    return w === 'Today' ? timeRange(s, e) : `${w} ${F.time.format(s)}`;
  }

  /* {text, title, overdue, today} for a task's due date, or null. */
  function dueLabel(t) {
    if (!t || !t.dueDate) return null;
    const d = parseDay(t.dueDate);
    if (!d) return null;
    const tk = todayKey();
    const at = t.dueAt ? new Date(t.dueAt) : null;
    const timed = at && !Number.isNaN(at.getTime()) && dayKey(at) === t.dueDate && !(at.getHours() === 23 && at.getMinutes() === 59) && !(at.getHours() === 0 && at.getMinutes() === 0);
    const title = `Due ${F.full.format(d)}${timed ? ' at ' + F.time.format(at) : ''}`;
    if (t.dueDate < tk && !t.isDone) {
      const days = Math.round((startOfDay(new Date()) - d) / DAY_MS);
      return { text: days === 1 ? 'Overdue · yesterday' : `Overdue · ${days < 7 ? F.weekday.format(d) : F.md.format(d)}`, title, overdue: true, today: false };
    }
    if (t.dueDate === tk) return { text: timed ? `Due ${F.time.format(at)}` : 'Due today', title, overdue: false, today: true };
    const w = dayWord(d);
    return { text: w === 'Tomorrow' ? 'Due tomorrow' : `Due ${w}`, title, overdue: false, today: false };
  }

  // ───────────────────────────  the link model  ───────────────────────────

  function blocksFor(taskID) {
    if (taskID == null) return [];
    return Store.blocks().filter((b) => !b.hidden && b.taskID && sameID(b.taskID, taskID))
      .sort((a, b) => new Date(a.start) - new Date(b.start));
  }

  function nextBlock(taskID) {
    const now = Date.now();
    return blocksFor(taskID).find((b) => {
      if (b.allDay) return (b.endDay || b.startDay || dayKey(new Date(b.start))) > todayKey() || (b.startDay || dayKey(new Date(b.start))) >= todayKey();
      return new Date(b.end).getTime() > now;
    }) || null;
  }

  function hasBlockToday(taskID) {
    const tk = todayKey();
    return blocksFor(taskID).some((b) => dayKey(new Date(b.start)) === tk);
  }

  /* Today = due today/overdue, scheduled today, or added without a later date.
     Upcoming = due on a later day, or scheduled only on later days. */
  function sectionOf(t) {
    if (!t) return 'today';
    if (t.isDone) return 'done';
    // The task named on the timer ring is what you're working on now: always in Today, never
    // tucked away in the collapsed Upcoming section.
    const tk = todayKey();
    // overdue: not shown in Today's Tasks, unless it's on today's calendar
    if (t.dueDate && t.dueDate < tk && !hasBlockToday(t.id)) return 'pastdue';
    const cur = typeof Store.activeTask === 'function' ? Store.activeTask() : null;
    if (cur && sameID(cur.id, t.id)) return 'today';
    if (t.dueDate && t.dueDate <= tk) return 'today';
    // a "PUREFOCUS:" event asked for this task to be on your list, whatever day the event is
    if (t.externalSource === 'calendar') return 'today';
    if (hasBlockToday(t.id)) return 'today';
    if (t.dueDate && t.dueDate > tk) return 'upcoming';
    const nb = nextBlock(t.id);
    if (nb && dayKey(new Date(nb.start)) > tk) return 'upcoming';
    return 'today';
  }

  /* Future linked blocks: start after now (a running block keeps its history). A calendar task
     (block.isTask — the block IS the task, like Google Tasks on a calendar) stays when its task is
     ticked off, so it shows checked; `keep` names one more block to leave (the one just ticked). */
  function futureBlocks(taskID, { keep = null } = {}) {
    const now = Date.now();
    return blocksFor(taskID).filter((b) => !b.isTask && b.id !== keep
      && (b.allDay ? (b.startDay || dayKey(new Date(b.start))) > todayKey() : new Date(b.start).getTime() > now));
  }
  /* What goes when a task is deleted: its future focus blocks and every one of its calendar-task blocks. */
  function doomedOnDelete(taskID) {
    const ids = new Set(futureBlocks(taskID).map((b) => b.id));
    for (const b of blocksFor(taskID)) if (b.isTask) ids.add(b.id);
    return Array.from(ids);
  }

  function withQuiet(fn) { quiet++; try { return fn(); } finally { quiet--; } }

  function removeBlocks(ids) {
    if (!ids.length) return [];
    const set = new Set(ids);
    const before = Store.blocks().slice();
    const removed = before.filter((b) => set.has(b.id));
    withQuiet(() => Store.setBlocks(before.filter((b) => !set.has(b.id))));
    snapshotBlocks();
    return removed;
  }

  function restoreBlocks(list) {
    if (!list || !list.length) return;
    const have = new Set(Store.blocks().map((b) => b.id));
    const add = list.filter((b) => !have.has(b.id));
    if (!add.length) return;
    withQuiet(() => Store.setBlocks(Store.blocks().concat(add)));
    snapshotBlocks();
  }

  function pushCalendarUndo(label, undo, redo) {
    try { if (typeof CalendarView !== 'undefined' && CalendarView.pushUndo) CalendarView.pushUndo({ label, undo, redo }); } catch (_) {}
  }

  // ───────────────────────────  toasts with Undo  ───────────────────────────

  function toast(message, { undo = null, action = null, variant = '' } = {}) {
    const stack = document.getElementById('toast-stack');
    if (!stack) return null;
    const node = document.createElement('div');
    node.className = 'toast cal-undo-toast tk-toast' + (variant ? ` toast--${variant}` : '');
    node.setAttribute('role', 'status');
    const label = document.createElement('span');
    label.textContent = message;
    node.appendChild(label);
    let gone = false;
    const leave = () => { if (gone) return; gone = true; node.classList.add('is-leaving'); setTimeout(() => node.remove(), 320); };
    const addBtn = (text, run) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cal-undo-btn';
      b.textContent = text;
      b.addEventListener('click', () => { leave(); try { run(); } catch (err) { console.error(err); } });
      node.appendChild(b);
    };
    if (action) addBtn(action.label, action.run);
    if (undo) addBtn('Undo', undo);
    stack.appendChild(node);
    setTimeout(leave, undo || action ? UNDO_MS : 2600);
    return node;
  }

  // ───────────────────────────  complete / delete  ───────────────────────────

  function plural(n, w) { return `${n} ${w}${n === 1 ? '' : 's'}`; }

  /* Marks a task done (or not done). Completing removes its future linked blocks;
     one toast with Undo restores both. */
  function complete(taskID, { done = true, toast: showToast = true, keep = null } = {}) {
    const t = taskById(taskID);
    if (!t || !!t.isDone === !!done) return;
    if (!done) {
      const patch = { completedAt: null };
      // An imported task you uncheck by hand stays unchecked: the school feed must not
      // re-complete it on the next refresh just because it is still marked submitted.
      if (t.externalSource && t.externalSource !== 'local') patch.externalDoneSuppressed = true;
      withQuiet(() => Store.bulk(() => { Store.toggleTaskDone(t.id); Store.updateTask(t.id, patch); }));
      snapshotTasks();
      return;
    }
    const wasActive = !!(Store.activeTask() && sameID(Store.activeTask().id, t.id));
    const planParts = t.planParts || null;
    const removed = withQuiet(() => {
      let r = [];
      Store.bulk(() => {
        Store.toggleTaskDone(t.id);
        Store.updateTask(t.id, { completedAt: new Date().toISOString() });
        r = removeBlocksRaw(futureBlocks(t.id, { keep }).map((b) => b.id));
      });
      return r;
    });
    snapshotTasks(); snapshotBlocks();
    const undo = () => {
      withQuiet(() => Store.bulk(() => {
        const cur = taskById(t.id);
        if (cur && cur.isDone) Store.toggleTaskDone(cur.id);
        Store.updateTask(t.id, planParts ? { completedAt: null, planParts } : { completedAt: null });
        restoreBlocksRaw(removed);
        if (wasActive) Store.setActiveTask(t.id);
      }));
      snapshotTasks(); snapshotBlocks();
    };
    if (removed.length) pushCalendarUndo('Complete task', undo, () => complete(t.id, { toast: false }));
    if (!showToast) return;
    const open = Store.tasks().filter((x) => !x.isDone && sectionOf(x) === 'today').length;
    let msg = open === 0 ? 'Done — that’s everything for today' : `Done · ${open} left today`;
    if (removed.length) msg += ` · ${plural(removed.length, 'planned block')} cleared`;
    toast(msg, { undo });
  }

  // In-bulk variants (no snapshot / quiet handling of their own).
  function removeBlocksRaw(ids) {
    if (!ids.length) return [];
    const set = new Set(ids);
    const before = Store.blocks().slice();
    const removed = before.filter((b) => set.has(b.id));
    Store.setBlocks(before.filter((b) => !set.has(b.id)));
    return removed;
  }
  function restoreBlocksRaw(list) {
    if (!list || !list.length) return;
    const have = new Set(Store.blocks().map((b) => b.id));
    const add = list.filter((b) => !have.has(b.id));
    if (add.length) Store.setBlocks(Store.blocks().concat(add));
  }

  /* Deletes a task (no confirm dialog): its future blocks go too; Undo puts both back in place. */
  function remove(taskID) {
    const t = taskById(taskID);
    if (!t) return;
    const copy = JSON.parse(JSON.stringify(t));
    const visIndex = Store.visibleTasks().findIndex((x) => sameID(x.id, t.id));
    const wasActive = !!(Store.activeTask() && sameID(Store.activeTask().id, t.id));
    const removed = withQuiet(() => {
      let r = [];
      Store.bulk(() => {
        r = removeBlocksRaw(doomedOnDelete(t.id));
        Store.deleteTask(t.id);
      });
      return r;
    });
    snapshotTasks(); snapshotBlocks();
    const undo = () => {
      withQuiet(() => Store.bulk(() => {
        if (!taskById(copy.id)) {
          const { id, title, ...rest } = copy;
          Store.addTask({ ...rest, id, title });
          // addTask puts it on top; move it back to where it was.
          const vis = Store.visibleTasks();
          const from = vis.findIndex((x) => sameID(x.id, id));
          if (from >= 0 && visIndex >= 0 && visIndex !== from) Store.reorderTasks(from, Math.min(visIndex, vis.length - 1));
          if (Array.isArray(copy.subtasks) && copy.subtasks.length) Store.updateTask(id, { subtasks: copy.subtasks });
          if (wasActive) Store.setActiveTask(id);
        }
        restoreBlocksRaw(removed);
      }));
      snapshotTasks(); snapshotBlocks();
    };
    toast(`Deleted “${t.title.length > 40 ? t.title.slice(0, 39) + '…' : t.title}”${removed.length ? ` · ${plural(removed.length, 'block')} cleared` : ''}`, { undo });
  }

  // ───────────────────────────  schedule  ───────────────────────────

  function pomo() {
    const s = Store.settings();
    return { focus: Number(s.focusMinutes) || 25, short: Number(s.shortBreakMinutes) || 5,
      long: Number(s.longBreakMinutes) || 15, interval: Math.max(1, Number(s.longBreakInterval) || 4) };
  }
  const core = () => (typeof CalCore !== 'undefined' && CalCore.ready ? CalCore : null);
  function focusSpan(n, s) {
    if (core()) return CalCore.focusSpan(n, s);
    if (n <= 0) return 0;
    let m = n * s.focus;
    for (let k = 1; k < n; k++) m += k % s.interval === 0 ? s.long : s.short;
    return m;
  }
  function blockMinutes(n, s) {
    if (core()) return CalCore.blockMinutes(n, s);
    return Math.max(15, Math.ceil(focusSpan(n, s) / SNAP) * SNAP);
  }

  /* Minutes of the day that are busy on `day` (local blocks + busy imported events, ± buffer). */
  function busyOn(day) {
    const from = startOfDay(day), to = addDays(from, 1);
    const p = (Store.calendar() && Store.calendar().prefs) || {};
    const buf = Number(p.eventBuffer) || 0;
    const out = [];
    const span = (s, e, pad0) => out.push([Math.max(0, Math.round((s - from) / 60000) - pad0), Math.min(1440, Math.round((e - from) / 60000) + pad0)]);
    for (const b of Store.blocks()) {
      if (b.hidden || b.allDay) continue;
      const s = new Date(b.start), e = new Date(b.end);
      if (s < to && e > from) span(s, e, 0);
    }
    if (typeof Feeds !== 'undefined' && Feeds.events) {
      const fm = new Map((Store.calendar().feeds || []).map((f) => [f.id, f]));
      let evs = [];
      try { evs = Feeds.events() || []; } catch (_) {}
      for (const raw of evs) {
        const f = fm.get(raw.calendarID);
        if (!f || f.blocksTime === false || raw.allDay || raw.isBusy === false) continue;
        const s = new Date(raw.start), e = new Date(raw.end);
        if (!(s < to && e > from) || e - s >= DAY_MS) continue;
        span(s, e, buf);
      }
    }
    return out.sort((a, b) => a[0] - b[0]);
  }

  function freeSlot(day, minutes) {
    const p = (Store.calendar() && Store.calendar().prefs) || {};
    let lo = Number.isFinite(p.planDayStart) ? p.planDayStart : 480;
    const hi = Number.isFinite(p.planDayEnd) ? p.planDayEnd : 1320;
    if (dayKey(day) === todayKey()) {
      const n = new Date();
      lo = Math.max(lo, Math.ceil((n.getHours() * 60 + n.getMinutes() + 5) / SNAP) * SNAP);
    }
    let t = Math.ceil(lo / SNAP) * SNAP;
    for (const [a, b] of busyOn(day)) {
      if (b <= t) continue;
      if (a >= t + minutes) break;
      t = Math.ceil(Math.max(t, b) / SNAP) * SNAP;
    }
    return t + minutes <= hi ? t : null;
  }

  function makeBlock(t, start, end, n, s) {
    const now = new Date().toISOString();
    return {
      id: Store.uid(), title: String(t.title).slice(0, 120),
      start: start.toISOString(), end: end.toISOString(), allDay: false, startDay: null, endDay: null,
      kind: 'focus', taskID: t.id, category: t.category || null,
      colorHex: null, notes: null, location: null, source: 'local', externalID: null, calendarID: null, calendarName: null,
      eventType: null, readOnly: false, isBusy: true, htmlLink: null, pomodoros: n, plannedFocusMinutes: n * s.focus,
      autoPlanned: false, hidden: false, createdAt: now, plannedAt: now, updatedAt: now,
    };
  }

  function remainingPomodoros(t) {
    const left = Math.max(1, (t.estimate || 1) - (t.completedPomodoros || 0));
    const covered = futureBlocks(t.id).reduce((n, b) => n + (b.pomodoros || 0), 0);
    return Math.max(1, left - covered);
  }

  /* Puts the task in the next free time (today first, up to 14 days). Returns the first block or null. */
  function schedule(taskID) {
    const t = taskById(taskID);
    if (!t || t.isDone) return null;
    if (typeof CalendarView !== 'undefined' && typeof CalendarView.scheduleTask === 'function') {
      let res = null;
      try { res = CalendarView.scheduleTask(t.id, { n: remainingPomodoros(t) }); } catch (err) { console.error('scheduleTask failed', err); }
      snapshotBlocks();
      const first = Array.isArray(res) ? res[0] : res;
      return first || null;
    }
    const s = pomo();
    const n = Math.min(remainingPomodoros(t), s.interval);
    const len = blockMinutes(n, s);
    const today = startOfDay(new Date());
    for (let i = 0; i < 14; i++) {
      const day = addDays(today, i);
      const at = freeSlot(day, len);
      if (at == null) continue;
      const start = new Date(day);
      start.setHours(Math.floor(at / 60), at % 60, 0, 0);
      const end = new Date(+start + len * 60000);
      const b = makeBlock(t, start, end, n, s);
      withQuiet(() => Store.setBlocks(Store.blocks().concat([b])));
      snapshotBlocks();
      const undo = () => { removeBlocks([b.id]); };
      pushCalendarUndo('Schedule task', undo, () => restoreBlocks([b]));
      toast(`Scheduled · ${dayWord(start)}, ${timeRange(start, end)}`, {
        undo, action: { label: 'View', run: () => openOnCalendar(dayKey(start)) },
      });
      return b;
    }
    toast('No free time in your planning hours over the next two weeks');
    return null;
  }

  function openOnCalendar(x) {
    let day = null;
    if (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x)) day = x;
    else {
      const t = taskById(x);
      const b = t && nextBlock(t.id);
      day = b ? dayKey(new Date(b.start)) : (t && t.dueDate) || todayKey();
    }
    try { if (typeof App !== 'undefined') App.showView('calendar'); } catch (_) {}
    try { if (typeof CalendarView !== 'undefined' && CalendarView.goTo) CalendarView.goTo(day); } catch (_) {}
  }

  // ───────────────────────────  start focus  ───────────────────────────

  async function start(taskID) {
    const t = taskById(taskID);
    if (!t || t.isDone) return;
    if (typeof Timer === 'undefined' || !Timer.startFocus) { Store.setActiveTask(t.id); return; }
    // A linked block running right now gives the session its plan context ("From your plan").
    let plan = null;
    const now = Date.now();
    const cur = blocksFor(t.id).find((b) => !b.allDay && new Date(b.start).getTime() <= now && new Date(b.end).getTime() > now);
    if (cur) {
      const dk = dayKey(new Date(cur.start));
      const same = blocksFor(t.id).filter((b) => !b.allDay && dayKey(new Date(b.start)) === dk);
      plan = { blockID: cur.id, title: t.title, index: Math.max(1, same.findIndex((b) => b.id === cur.id) + 1), total: Math.max(1, same.length), end: cur.end };
    }
    let r = Timer.startFocus({ taskID: t.id, plan, force: false });
    if (r && r.status === 'needsConfirmation') {
      let ok = true;
      if (typeof CalendarView !== 'undefined' && CalendarView.confirmSwitch) ok = await CalendarView.confirmSwitch(t.title, r.currentMinutes);
      if (!ok) return;
      r = Timer.startFocus({ taskID: t.id, plan, force: true });
    }
    if (r && r.status === 'unavailable') toast('That task can’t start a focus session right now');
  }

  // ───────────────────────────  propagation (Store events)  ───────────────────────────

  function snapshotTasks() {
    taskSnap = new Map(Store.tasks().map((t) => [lower(t.id), { title: t.title, isDone: !!t.isDone }]));
  }
  function snapshotBlocks() {
    blockSnap = new Map(Store.blocks().map((b) => [b.id, { title: b.title, taskID: b.taskID || null }]));
  }

  const SEP = ' \u00b7 ';   // plan blocks are "<task> · <step>" (coach.js apply)

  /* Block title after its task was renamed from → to; null = leave the block alone. */
  function swapPrefix(blockTitle, from, to) {
    const bt = String(blockTitle || '');
    if (bt === from) return to;
    if (from && bt.startsWith(from + SEP)) return to + bt.slice(from.length);
    return null;
  }

  /* The task name implied by a block rename prev → next, or null when only the block's own
     step label changed (or the block carries a custom title of its own). */
  function taskNameFromBlock(taskTitle, prev, next) {
    if (prev === taskTitle) {                       // a whole-task block: its title is the task's
      const i = next.indexOf(SEP);
      return i > 0 && next.slice(0, i).trim() === taskTitle ? null : next;
    }
    if (!prev.startsWith(taskTitle + SEP)) return null;   // custom block title: independent
    const part = prev.slice(taskTitle.length);             // " · Outline"
    if (next.startsWith(taskTitle + SEP)) return null;     // only the step label changed
    if (next.endsWith(part) && next.length > part.length) {
      const name = next.slice(0, next.length - part.length).trim();
      return name || null;                                 // the task-name part was edited
    }
    return null;                                           // mixed edit: keep it on this block only
  }

  function onTasks() {
    if (quiet) { snapshotTasks(); return; }
    const renamed = [];
    const completed = [];
    const deleted = [];
    const seen = new Set();
    for (const t of Store.tasks()) {
      const k = lower(t.id);
      seen.add(k);
      const prev = taskSnap.get(k);
      if (!prev) continue;
      if (prev.title !== t.title) renamed.push({ t, from: prev.title });
      if (!prev.isDone && t.isDone) completed.push(t);
    }
    for (const k of taskSnap.keys()) if (!seen.has(k)) deleted.push(k);
    snapshotTasks();

    // Rename → linked block titles (one write).
    if (renamed.length) {
      // Only the task-name prefix is swapped: "Old · Draft" → "New · Draft" (plan step labels survive);
      // a block the user gave its own title (no old-name prefix) keeps it.
      const byID = new Map(renamed.map((r) => [lower(r.t.id), r]));
      let changed = false;
      const next = Store.blocks().map((b) => {
        const r = b.taskID ? byID.get(lower(b.taskID)) : undefined;
        if (!r) return b;
        const title = swapPrefix(b.title, r.from, r.t.title);
        if (title === null || b.title === title) return b;
        changed = true;
        return { ...b, title: title.slice(0, 120), updatedAt: new Date().toISOString() };
      });
      if (changed) { withQuiet(() => Store.setBlocks(next)); snapshotBlocks(); }
    }

    // Completed / deleted elsewhere → clear their future blocks (Undo restores the blocks).
    const doomed = [];
    for (const t of completed) doomed.push(...futureBlocks(t.id).map((b) => b.id));
    if (deleted.length) {
      const now = Date.now();
      const gone = new Set(deleted);
      for (const b of Store.blocks()) {
        if (b.hidden || !b.taskID || !gone.has(lower(b.taskID))) continue;
        if (b.isTask) { doomed.push(b.id); continue; }
        if (b.allDay ? (b.startDay || dayKey(new Date(b.start))) > todayKey() : new Date(b.start).getTime() > now) doomed.push(b.id);
      }
    }
    if (doomed.length) {
      const removed = removeBlocks(doomed);
      if (removed.length) {
        const undo = () => restoreBlocks(removed);
        pushCalendarUndo('Clear planned blocks', undo, () => removeBlocks(removed.map((b) => b.id)));
        const why = completed.length && !deleted.length ? 'finished' : !completed.length ? 'deleted' : 'finished or deleted';
        toast(`${plural(removed.length, 'planned block')} cleared for ${why} ${completed.length + deleted.length === 1 ? 'task' : 'tasks'}`, { undo });
      }
    }
  }

  function onBlocks() {
    if (quiet) { snapshotBlocks(); return; }
    for (const b of Store.blocks()) {
      const prev = blockSnap.get(b.id);
      if (!prev || !b.taskID) continue;
      if (!sameID(prev.taskID, b.taskID)) continue;          // relinked: the calendar shows the new task's title
      if (prev.title === b.title) continue;
      const title = String(b.title || '').trim();
      if (!title) continue;
      const t = taskById(b.taskID);
      if (!t) continue;
      const name = taskNameFromBlock(t.title, String(prev.title || ''), title);
      if (name && t.title !== name) pendingTitle.set(lower(t.id), name);
    }
    snapshotBlocks();
    if (pendingTitle.size) {
      clearTimeout(blockTitleTimer);
      blockTitleTimer = setTimeout(flushTitles, 400);
    }
  }

  function flushTitles() {
    const items = Array.from(pendingTitle.entries());
    pendingTitle.clear();
    for (const [id, title] of items) {
      const t = taskById(id);
      if (t && t.title !== title) Store.updateTask(t.id, { title });   // onTasks then syncs the other blocks
    }
  }

  function init() {
    if (started) return;
    if (typeof Store === 'undefined') return;
    started = true;
    snapshotTasks();
    snapshotBlocks();
    Store.on('tasks', onTasks);
    Store.on('blocks', onBlocks);
    // Remote / reset / profile switches replace everything: re-baseline, never react.
    for (const ev of ['remote', 'reset']) Store.on(ev, () => { snapshotTasks(); snapshotBlocks(); });
  }

  return {
    DRAG_TYPE, init, blocksFor, nextBlock, slotLabel, sectionOf, dueLabel, schedule, start, complete, remove,
    openOnCalendar, toast, dayKey, timeRange, dayWord,
    _test: { freeSlot, busyOn, remainingPomodoros, futureBlocks, doomedOnDelete },
  };
})();

// Loaded after the app started (tasks.js injected this file): join in now.
try {
  if (typeof Store !== 'undefined' && document.readyState !== 'loading' && typeof Tasks !== 'undefined' && Tasks.isReady && Tasks.isReady()) {
    TaskSync.init();
    Tasks.render();
  }
} catch (err) { console.error('TaskSync late init failed', err); }
