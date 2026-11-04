/* ═══════════════════════════════════════════════════════════════════════
   calendar-migrate.js — move the v1 calendar storage into the Store (owner: W2)
   v2-calendar §3.7, run once per profile through Store.migrate('calendar-v2', …).
   app.js calls CalendarMigrate.run() before CalendarView.init().

   v1 kept everything in the GLOBAL key 'purefocus.calendar.v1' (its own shape
   {id,title,start,end,allDay,source,calendarName,calendarID,color,readOnly,taskId,notes})
   and UI prefs in 'purefocus.calendar.prefs' ({view, weekStart}).

   1. local items → SPEC CalendarBlocks in Store.blocks() (merged by id, so a retry is harmless);
   2. imported .ics items → one CalendarFeed per calendar + their events in the calcache;
      Google items are dropped (the next Google import fetches them again);
   3. view → prefs.lastView, weekStart → prefs.weekStartsOn; the legacy keys are removed only
      after the store write landed — otherwise they stay and the migration retries next load.

   const CalendarMigrate = { run() → bool (true when it migrated now), _map(list, settings) }
   ═══════════════════════════════════════════════════════════════════════ */

const CalendarMigrate = (() => {
  'use strict';

  const LEGACY = 'purefocus.calendar.v1';
  const LEGACY_PREFS = 'purefocus.calendar.prefs';
  const VIEWS = ['day', 'week', 'month', 'agenda'];

  const read = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
  const pad = (n) => String(n).padStart(2, '0');
  const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const isDayKey = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const hex6 = (c) => { const m = /^#([0-9a-f]{6})$/i.exec(String(c || '').trim()); return m ? '#' + m[1].toLowerCase() : null; };

  function focusSpan(n, s) {
    let m = n * s.focus;
    for (let k = 1; k < n; k++) m += k % s.interval === 0 ? s.long : s.short;
    return n > 0 ? m : 0;
  }
  function capacity(minutes, s) {
    let n = 0;
    while (n < 48 && focusSpan(n + 1, s) <= minutes) n++;
    return n;
  }

  function parseList(raw) {
    try {
      const p = JSON.parse(raw || '[]');
      return Array.isArray(p) ? p : (isObj(p) && Array.isArray(p.events) ? p.events : []);
    } catch (_) { return []; }
  }

  /* Pure mapping: legacy list → {blocks, groups:[{feed, events}]}; settings = Store settings. */
  function map(list, settings, now = new Date().toISOString()) {
    const s = { focus: Number(settings.focusMinutes) || 25, short: Number(settings.shortBreakMinutes) || 5,
      long: Number(settings.longBreakMinutes) || 15, interval: Math.max(1, Number(settings.longBreakInterval) || 4) };
    const blocks = [];
    const groups = new Map();
    const seen = new Set();
    for (const e of list) {
      if (!isObj(e) || !e.id || seen.has(String(e.id))) continue;
      const start = new Date(e.start), end = new Date(e.end != null ? e.end : e.start);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
      seen.add(String(e.id));
      const source = ['local', 'google', 'ics'].includes(e.source) ? e.source : 'local';
      const allDay = !!e.allDay;
      const startDay = allDay ? (isDayKey(e.startDay) ? e.startDay : dayKey(start)) : null;
      let endDay = null;
      if (allDay) {
        if (isDayKey(e.endDay) && e.endDay > startDay) endDay = e.endDay;
        else { const d = new Date(start); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 1); endDay = dayKey(d); }
      }
      if (source === 'local') {
        const taskID = e.taskId || e.taskID || null;
        const kind = taskID ? 'focus' : 'event';
        const len = Math.max(0, Math.round((end - start) / 60000));
        const pomodoros = kind === 'focus' && !allDay ? capacity(len, s) : 0;
        blocks.push({
          id: String(e.id), title: String(e.title || '').slice(0, 120),
          start: start.toISOString(), end: (end > start ? end : new Date(start.getTime() + 15 * 60000)).toISOString(),
          allDay, startDay, endDay, kind, taskID: taskID ? String(taskID) : null, category: null,
          colorHex: hex6(e.color), notes: e.notes ? String(e.notes).slice(0, 2000) : null, location: e.location ? String(e.location).slice(0, 200) : null,
          source: 'local', externalID: null, calendarID: null, calendarName: null, eventType: null,
          readOnly: false, isBusy: true, htmlLink: null,
          pomodoros, plannedFocusMinutes: pomodoros * s.focus, autoPlanned: false, hidden: false,
          createdAt: now, plannedAt: now, updatedAt: now,
        });
      } else if (source === 'ics') {
        const name = String(e.calendarName || 'Imported calendar').trim().slice(0, 80) || 'Imported calendar';
        const fid = /^ics:[0-9a-f]{8}$/i.test(String(e.calendarID || '')) ? String(e.calendarID).toLowerCase()
          : 'ics:' + (typeof ICS !== 'undefined' ? ICS.fnv1a(name.toLowerCase()) : '00000000');
        if (!groups.has(fid)) groups.set(fid, { feed: { id: fid, name, color: e.color }, events: [] });
        groups.get(fid).events.push({
          id: String(e.id).startsWith(fid + ':') ? String(e.id) : `${fid}:${String(e.id).replace(/^ics:/, '')}`,
          title: String(e.title || '(No title)').slice(0, 200), start: start.toISOString(), end: end.toISOString(),
          allDay, startDay, endDay, source: 'ics', notes: e.notes ? String(e.notes).slice(0, 2000) : null,
          location: e.location ? String(e.location).slice(0, 200) : null, isBusy: e.isBusy !== false,
          htmlLink: typeof e.url === 'string' && /^https:\/\//i.test(e.url) ? e.url : null,
          icalUID: e.uid || null, externalID: e.uid || null, updatedAt: now,
        });
      }
      // google → dropped (refetched by the next import)
    }
    return { blocks, groups: Array.from(groups.values()) };
  }

  function run() {
    if (typeof Store === 'undefined' || !Store.migrate) return false;
    const rawEvents = read(LEGACY);
    const rawPrefs = read(LEGACY_PREFS);
    let groups = [];
    const ran = Store.migrate('calendar-v2', () => {
      if (rawEvents == null && rawPrefs == null) return;           // a fresh install: nothing to move
      const { blocks, groups: g } = map(parseList(rawEvents), Store.settings());
      groups = g;
      if (blocks.length) {
        const have = new Set(Store.blocks().map((b) => String(b.id).toLowerCase()));
        Store.setBlocks(Store.blocks().concat(blocks.filter((b) => !have.has(b.id.toLowerCase()))));
      }
      const patch = {};
      if (g.length) {
        const feeds = Store.calendar().feeds.slice();
        const ids = new Set(feeds.map((f) => f.id));
        const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
        for (const { feed } of g) {
          if (ids.has(feed.id)) continue;
          const norm = (c) => (typeof Feeds !== 'undefined' && Feeds.normalizeColor ? Feeds.normalizeColor(c) : hex6(c));
          const colorHex = norm(feed.color) || norm(SERIES[feeds.length % SERIES.length]) || SERIES[0];
          feeds.push({
            id: feed.id, source: 'ics', name: feed.name, colorHex, isVisible: true, isSynced: true, isPrimary: false,
            accessRole: null, hasURL: false, etag: null, lastSyncedAt: new Date().toISOString(), lastError: null,
            provider: 'ics', groupKey: 'files', blocksTime: true, itemRole: 'events',
          });
          ids.add(feed.id);
        }
        patch.feeds = feeds;
      }
      let p = {};
      try { p = JSON.parse(rawPrefs || '{}') || {}; } catch (_) { p = {}; }
      const prefs = {};
      if (VIEWS.includes(p.view)) prefs.lastView = p.view;
      if (Number.isInteger(p.weekStart) && p.weekStart >= 0 && p.weekStart <= 6) prefs.weekStartsOn = p.weekStart;
      if (Object.keys(prefs).length) patch.prefs = prefs;
      if (Object.keys(patch).length) Store.updateCalendar(patch);
    });
    if (!ran) return false;
    // The cache is disposable: its write may fail without blocking the migration.
    if (typeof Feeds !== 'undefined' && Feeds.replaceEvents) {
      for (const g of groups) { try { Feeds.replaceEvents(g.feed.id, g.events); } catch (_) { /* quota */ } }
    }
    Store.flush();
    let landed = false;
    try {
      const k = typeof Profile !== 'undefined' ? Profile.dataKey() : 'purefocus.v1';
      const stored = JSON.parse(localStorage.getItem(k) || 'null');
      landed = !!(stored && stored.migrations && Object.prototype.hasOwnProperty.call(stored.migrations, 'calendar-v2'));
    } catch (_) { landed = false; }
    if (landed) {
      try { localStorage.removeItem(LEGACY); localStorage.removeItem(LEGACY_PREFS); } catch (_) { /* keep them */ }
    }
    return true;
  }

  return { run, _map: map };
})();
