/* ═══════════════════════════════════════════════════════════════════════
   csv.js — CSV v2 export / import (SPEC-V2 §4.5; SPEC §1.2.9; v2-guard §2.5)
   Created by W1·A; owner W4. DOM-free except download().

   33 positional columns, the first 27 identical on both platforms:
     record,id,title,estimate,completed,is_done,created_at,location,category,
     scheduled_minutes,actual_minutes,mode,start,end,rating,ambience,alarm,
     task_id,task_title,music,goal_minutes,due_date,focus_ratio,idle_sec,
     distract_sec,switch_count,factors,skipped,estimate_set,event_minutes,
     completed_at,notes,subtasks
   20 goal_minutes (sessions) · 21 due_date (tasks) · 22–25 the session's
   drift totals (focus_ratio 3 decimals) · 26 factors joined with ';', the
   literal 'none' for [] and empty for null · 27 'true' on a run cut short
   · 28–32 tasks: picked-by-hand estimate, event length, when it was done,
   notes, subtasks as JSON. A file with 27 columns imports the same as ever.

   Parsing is positional and tolerant: a missing trailing column is empty,
   unknown record kinds and extra columns are ignored, instants are accepted
   with or without fractional seconds, ids match case-insensitively, a
   due date Excel rewrote (10/25/2026) still counts, and a row with no id
   gets one from its content, so a second import doesn't double it. A quote
   opens a quoted cell only at the start of the cell.
   Import MERGES by id: an existing record wins, except that an imported
   rating fills a null rating. Not in CSV: blocks, calendar, courses,
   assignments, the v2 task fields, settings.

   Public API (final):
     Csv.HEADER, Csv.COLUMNS
     Csv.export()            → CSV text of every task and session
     Csv.parse(text)         → {tasks: [task], sessions: [session]}  (pure)
     Csv.importText(text)    → merges into Store in one write →
                               {tasks: added, sessions: added, ratings: filled}
     Csv.download(filename?) → saves Csv.export() as a file (browser only)
   ═══════════════════════════════════════════════════════════════════════ */

const Csv = (() => {
  'use strict';

  const COLUMNS = Object.freeze(['record', 'id', 'title', 'estimate', 'completed', 'is_done', 'created_at', 'location', 'category',
    'scheduled_minutes', 'actual_minutes', 'mode', 'start', 'end', 'rating', 'ambience', 'alarm', 'task_id', 'task_title', 'music',
    'goal_minutes', 'due_date', 'focus_ratio', 'idle_sec', 'distract_sec', 'switch_count', 'factors',
    'skipped', 'estimate_set', 'event_minutes', 'completed_at', 'notes', 'subtasks']);
  const HEADER = COLUMNS.join(',');
  const N = COLUMNS.length;   // 33
  const MAX_MINUTES = 24 * 60;  // imported minutes are clamped to one day (Mac parity)
  const MODES = ['focus', 'shortBreak', 'longBreak'];
  const FACTORS = ['phoneAway', 'friends', 'notes.handwritten', 'notes.typed', 'notes.flashcards', 'notes.practice',
    'slept', 'caffeine', 'exercise'];

  // ── writing ──

  function escape(v) {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function num4(v) { const n = Number(v); return v == null || !Number.isFinite(n) ? '' : n.toFixed(4); }
  function int(v) { const n = Number(v); return v == null || v === '' || !Number.isFinite(n) ? '' : String(Math.round(n)); }

  function factorsCell(f) {
    if (!Array.isArray(f)) return '';
    return f.length ? f.join(';') : 'none';
  }

  function row(cols) {
    const out = cols.slice(0, N);
    while (out.length < N) out.push('');
    return out.map(escape).join(',');
  }

  function taskRow(t) {
    const c = new Array(N).fill('');
    c[0] = 'task'; c[1] = t.id; c[2] = t.title; c[3] = int(t.estimate); c[4] = int(t.completedPomodoros || 0);
    c[5] = t.isDone ? 'true' : 'false'; c[6] = t.createdAt || ''; c[7] = t.location || ''; c[8] = t.category || '';
    c[21] = t.dueDate || '';
    c[28] = t.estimateSet ? 'true' : ''; c[29] = int(t.eventMinutes); c[30] = t.completedAt || ''; c[31] = t.notes || '';
    if (Array.isArray(t.subtasks) && t.subtasks.length) c[32] = JSON.stringify(t.subtasks.map((x) => ({ title: x.title, isDone: !!x.isDone })));
    return row(c);
  }

  function sessionRow(s) {
    const c = new Array(N).fill('');
    c[0] = 'session'; c[1] = s.id; c[7] = s.location || ''; c[8] = s.category || '';
    c[9] = num4(s.scheduledMinutes); c[10] = num4(s.minutes); c[11] = s.mode || ''; c[12] = s.start || ''; c[13] = s.end || '';
    c[14] = s.focusRating != null ? String(s.focusRating) : ''; c[15] = s.ambience || ''; c[16] = s.alarm || '';
    c[17] = s.taskID || ''; c[18] = s.taskTitle || ''; c[19] = s.music || ''; c[20] = int(s.goalMinutes);
    const d = s.drift;
    if (d && typeof d === 'object') {
      const r = Number(d.focusRatio);
      c[22] = Number.isFinite(r) ? r.toFixed(3) : '';
      c[23] = int(d.idleSec || 0); c[24] = int(d.distractSec || 0); c[25] = int(d.switchCount || 0);
    }
    c[26] = factorsCell(s.factors);
    c[27] = s.skipped ? 'true' : '';
    return row(c);
  }

  function exportCSV() {
    const rows = [HEADER];
    for (const t of Store.tasks()) rows.push(taskRow(t));
    for (const s of Store.sessions()) rows.push(sessionRow(s));
    return rows.join('\n');
  }

  // ── reading ──

  /* Splits into rows on \n, \r or \r\n outside quotes (quotes are kept for parseLine). */
  function splitLines(text) {
    const lines = [];
    let cur = '';
    let inQuotes = false;
    let cellStart = true;     // a stray " inside a cell (a 5" disk) is just a character
    const s = String(text || '').replace(/^﻿/, '');
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inQuotes) {
        cur += ch;
        if (ch === '"') {
          if (s[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
        }
      } else if (ch === '"' && cellStart) { inQuotes = true; cellStart = false; cur += ch; }
      else if (ch === '\n' || ch === '\r') {
        lines.push(cur); cur = ''; cellStart = true;
        if (ch === '\r' && s[i + 1] === '\n') i++;
      } else {
        cur += ch;
        cellStart = ch === ',' || (cellStart && (ch === ' ' || ch === '\t'));
      }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  function parseLine(line) {
    const cols = [];
    let c = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"') {
          if (line[i + 1] === '"') { c += '"'; i++; } else q = false;
        } else c += ch;
      } else if (ch === '"' && !c.trim()) { c = ''; q = true; }
      else if (ch === ',') { cols.push(c); c = ''; }
      else c += ch;
    }
    cols.push(c);
    return cols;
  }

  const cell = (cols, i) => (i < cols.length ? String(cols[i]).trim() : '');
  const instant = (s) => (s && Number.isFinite(Date.parse(s)) ? new Date(Date.parse(s)).toISOString() : null);
  const isDayKey = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  // Excel rewrites dates in the computer's own format: month first unless that can't be a month.
  function dueKey(s) {
    if (isDayKey(s)) return s;
    const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
    if (!m) return null;
    const [a, b, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const [mo, d] = a > 12 ? [b, a] : [a, b];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${y < 100 ? 2000 + y : y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  function rowID(prefix, text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return `${prefix}-${(h >>> 0).toString(16)}`;
  }
  function parseSubtasks(s) {
    if (!s) return [];
    try {
      const list = JSON.parse(s);
      return Array.isArray(list) ? list.filter((x) => x && typeof x.title === 'string').map((x) => ({ id: Store.uid(), title: x.title, isDone: !!x.isDone })) : [];
    } catch (_) { return []; }
  }
  function numOrNull(s) { if (s === '') return null; const n = Number(s); return Number.isFinite(n) ? n : null; }
  function intOrNull(s) { const n = numOrNull(s); return n == null ? null : Math.round(n); }

  function parseFactors(s) {
    if (s === '') return null;
    if (s.toLowerCase() === 'none') return [];
    const ids = s.split(';').map((x) => x.trim());
    return FACTORS.filter((id) => ids.includes(id));
  }

  function parse(text) {
    const tasks = [];
    const sessions = [];
    const lines = splitLines(text);
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      const cols = parseLine(line);
      const kind = cell(cols, 0).toLowerCase();
      if (i === 0 && kind === 'record') return;   // header
      if (kind === 'task') {
        const title = cell(cols, 2);
        if (!title) return;
        const estimate = Math.min(12, Math.max(1, Math.round(Number(cell(cols, 3))) || 1));
        const due = cell(cols, 21);
        const task = {
          id: cell(cols, 1) || rowID('csv', `${title}|${cell(cols, 6)}`),
          title,
          estimate,
          completedPomodoros: Math.min(99, Math.max(0, Math.round(Number(cell(cols, 4))) || 0)),
          isDone: cell(cols, 5).toLowerCase() === 'true',
          createdAt: instant(cell(cols, 6)) || new Date().toISOString(),
          location: cell(cols, 7) || null,
          category: cell(cols, 8) || null,
          subtasks: parseSubtasks(cell(cols, 32)),
          dueDate: dueKey(due),
        };
        if (cell(cols, 28).toLowerCase() === 'true') task.estimateSet = true;
        const evMin = intOrNull(cell(cols, 29));
        if (evMin != null && evMin > 0) task.eventMinutes = evMin;
        const doneAt = instant(cell(cols, 30));
        if (doneAt) task.completedAt = doneAt;
        if (cell(cols, 31)) task.notes = cell(cols, 31);
        tasks.push(task);
      } else if (kind === 'session') {
        const start = instant(cell(cols, 12));
        const end = instant(cell(cols, 13));
        const mode = cell(cols, 11);
        if (!start || !end || !MODES.includes(mode)) return;
        const span = Math.max(0, (Date.parse(end) - Date.parse(start)) / 60000);
        let minutes = numOrNull(cell(cols, 10));
        if (minutes == null) minutes = span;
        minutes = Math.max(0.1, Math.min(MAX_MINUTES, Math.max(0, minutes)));
        const sched = numOrNull(cell(cols, 9));
        const rating = intOrNull(cell(cols, 14));
        const session = {
          id: cell(cols, 1) || rowID('csv', `${start}|${end}|${mode}`),
          start,
          end,
          minutes,
          scheduledMinutes: sched == null ? null : Math.min(MAX_MINUTES, Math.max(0, sched)),
          mode,
          taskID: cell(cols, 17) || null,
          taskTitle: cell(cols, 18) || null,
          focusRating: rating != null && rating >= 1 && rating <= 10 ? rating : null,
          location: cell(cols, 7) || null,
          category: cell(cols, 8) || null,
          ambience: cell(cols, 15) || null,
          alarm: cell(cols, 16) || null,
          music: cell(cols, 19) || null,
          drift: null,
          factors: parseFactors(cell(cols, 26)),
        };
        const goal = intOrNull(cell(cols, 20));
        if (goal != null) session.goalMinutes = goal;
        if (cell(cols, 27).toLowerCase() === 'true') session.skipped = true;
        const ratio = numOrNull(cell(cols, 22));
        if (ratio != null) {
          session.drift = {
            v: 1, signals: ['import'], activeSec: Math.round(minutes * 60),
            idleSec: Math.max(0, intOrNull(cell(cols, 23)) || 0),
            distractSec: Math.max(0, intOrNull(cell(cols, 24)) || 0),
            awaySec: 0,
            switchCount: Math.max(0, intOrNull(cell(cols, 25)) || 0),
            distractCount: 0, nudges: 0, nudgeReturns: 0, autoPaused: 0, blockedHits: 0, escapes: 0, offline: false,
            top: [],
            focusRatio: Math.min(1, Math.max(0, Math.round(ratio * 1000) / 1000)),
          };
        }
        sessions.push(session);
      }
    });
    return { tasks, sessions };
  }

  /* Merge by id (case-insensitive): existing records win; an imported rating
     fills a null rating. Duplicates inside the file keep the first. One Store
     write ('reset'); the active task is kept. */
  function importText(text) {
    const parsed = parse(text);
    const lower = (id) => String(id).toLowerCase();
    const taskIDs = new Set(Store.tasks().map((t) => lower(t.id)));
    const sessionByID = new Map(Store.sessions().map((s) => [lower(s.id), s]));
    const newTasks = [];
    const newSessions = [];
    let ratings = 0;
    for (const t of parsed.tasks) {
      if (taskIDs.has(lower(t.id))) continue;
      taskIDs.add(lower(t.id));
      newTasks.push(t);
    }
    for (const s of parsed.sessions) {
      const have = sessionByID.get(lower(s.id));
      if (have) {
        if (have.focusRating == null && s.focusRating != null) { have.focusRating = s.focusRating; ratings++; }
        continue;
      }
      sessionByID.set(lower(s.id), s);
      newSessions.push(s);
    }
    if (newTasks.length || newSessions.length || ratings) {
      const current = Store.exportData();
      Store.importData({ tasks: [...current.tasks, ...newTasks], sessions: [...current.sessions, ...newSessions] }, { keepActive: true });
    }
    return { tasks: newTasks.length, sessions: newSessions.length, ratings };
  }

  function download(filename) {
    const blob = new Blob([exportCSV()], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const d = new Date();
    a.download = filename || `pure-focus-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return { HEADER, COLUMNS, export: exportCSV, parse, importText, download };
})();
