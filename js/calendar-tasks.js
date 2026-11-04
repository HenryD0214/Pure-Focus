/* ═══════════════════════════════════════════════════════════════════════
   calendar-tasks.js — "PUREFOCUS:" events become tasks

   Put "PUREFOCUS:" at the start of an event's title in any calendar Pure Focus shows (Google,
   a calendar link, or the Pure Focus calendar itself) and it lands on Today's Tasks like a Canvas
   assignment: the rest of the title is the task, due the day of the event, its description as
   the task's notes, its location as the task's location, and as many pomodoros as the event is
   long (a 50-minute event = 2 × 25 minutes; all-day = 1) until you set a number yourself.
   Matching is forgiving: "PUREFOCUS:", "PureFocus:", "Pure Focus:".

   · The description can set the task's type of work and location: "Type: Study", "Location: Library".
     Any capitals, spacing, bold or bullets, on one line or several, in any order, with the value
     on the same line or the next (parseFields). What it says wins over the event's own location
     and leaves the task's notes; change it there and the open task follows, but a type or location
     you pick by hand stays until the description changes.
   · Events from today to two weeks ahead are picked up; past ones are left alone. Whatever day
     the event is on, its task sits in Today's Tasks (TaskSync.sectionOf), not in Upcoming.
   · Changing the event (title, day, length, description) updates its open task; what you changed
     on the task yourself stays until that same thing changes on the event.
   · Delete the task and it stays deleted — the event is remembered (per profile) — until you
     press "Add to Today's Tasks" on the event.
   · The calendar shows the event itself, so the task gets no separate "due" chip there.

   Public API: CalendarTasks.init(), sync(), matches(title), taskFor(event), add(event),
               parseFields(text) → {type, location, rest}
   ═══════════════════════════════════════════════════════════════════════ */

const CalendarTasks = (() => {
  'use strict';

  const PREFIX = /^\s*pure\s*focus\s*[:：]\s*/i;
  const MAP_BASE = 'purefocus.calendarTasks.v1';   // event key → {taskId, at}
  const AHEAD_DAYS = 14;

  const lower = (x) => String(x == null ? '' : x).toLowerCase();
  function mapKey() { try { if (typeof Profile !== 'undefined' && Profile.key) return Profile.key(MAP_BASE); } catch (_) {} return MAP_BASE; }
  function loadMap() { try { const o = JSON.parse(localStorage.getItem(mapKey()) || '{}'); return o && typeof o === 'object' ? o : {}; } catch (_) { return {}; } }
  function saveMap(m) { try { localStorage.setItem(mapKey(), JSON.stringify(m)); } catch (_) { /* private mode: may re-add */ } }

  function matches(title) { return PREFIX.test(String(title || '')); }
  function dayKey(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

  // An event's description as plain text for the task's notes (the calendar shows it formatted).
  // Feeds sometimes escape their HTML twice, so a second pass catches what the first one revealed.
  function plainText(raw) {
    let t = String(raw || '');
    for (let i = 0; i < 2 && /<\/?[a-z][^>]*>|&[a-z#0-9]+;/i.test(t); i++) t = fromHtml(t);
    return t.trim();
  }
  function fromHtml(t) {
    try {
      const doc = new DOMParser().parseFromString(t, 'text/html');
      doc.querySelectorAll('br').forEach((n) => n.replaceWith('\n'));
      doc.querySelectorAll('ul, ol').forEach((n) => n.before('\n'));
      doc.querySelectorAll('li').forEach((n) => n.prepend('• '));
      doc.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6, tr').forEach((n) => n.append('\n'));
      doc.querySelectorAll('a[href]').forEach((a) => {
        const href = a.getAttribute('href') || '';
        if (/^https?:\/\//i.test(href) && !a.textContent.includes(href)) a.append(` (${href})`);
      });
      return (doc.body.textContent || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    } catch (_) { return t.replace(/<(br|\/p|\/div|\/li)\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, ' ').trim(); }
  }

  // ── "Type: Study  Location: Library" in the description ──
  // A field is a name, then a separator (: = -> or a spaced dash), then a value that runs to the next
  // field, the end of the line, or ; | • — or starts on the next line when the name stands alone.
  const FIELD = /(^|[^\p{L}\p{N}?&/#=])(type of work|work type|task type|type|category|location|place|focus spot)\s*(?:[:=]+|[-=]+>|→|\s[-–—]+|[-–—]+(?=\s))[ \t]*/giu;
  const fieldOf = (name) => (/^(location|place|focus spot)$/i.test(name.replace(/\s+/g, ' ')) ? 'location' : 'type');
  // what formatting leaves behind: invisible characters, odd spaces, full-width colons, markdown
  function tidy(text) {
    return String(text || '').normalize('NFKC')
      .replace(/\\n/g, '\n').replace(/\\([,;])/g, '$1')
      .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, '')
      .replace(/\r\n?|[\u2028\u2029\u0085\v\f]/g, '\n')
      .replace(/[*`~]+/g, '').replace(/(^|[\s(\[])_+|_+(?=[\s:)\].,;]|$)/gm, '$1')
      .replace(/[^\S\n]+/g, ' ');
  }
  function cleanValue(v, field) {
    let s = String(v || '').split(/[;|•]/)[0];
    if (field === 'type') s = s.split(',')[0];       // a type is one label; a place may have a comma
    s = s.replace(/^[\s"'“”‘’([{<]+/, '').replace(/[\s"'“”‘’()\[\]{}<>.,:-]+$/, '').replace(/\s+(and|&|\+)$/i, '').trim();
    return /^(none|n\/a|na|tbd|-+)$/i.test(s) ? '' : s;
  }
  function parseFields(raw) {
    const text = tidy(plainText(raw));
    const hits = [];
    FIELD.lastIndex = 0;
    for (let m; (m = FIELD.exec(text));) {
      const start = m.index + m[1].length;
      hits.push({ start, valueAt: m.index + m[0].length, field: fieldOf(m[2]) });
      if (FIELD.lastIndex === m.index) FIELD.lastIndex++;
    }
    const best = { type: null, location: null };
    hits.forEach((h, i) => {
      const limit = i + 1 < hits.length ? hits[i + 1].start : text.length;
      const after = text.slice(h.valueAt, limit);
      // the value is on this line, or on the next one if nothing follows the name
      const lead = /^\s*/.exec(after)[0].length;
      const stop = after.indexOf('\n', lead);
      const line = stop < 0 ? after.slice(lead) : after.slice(lead, stop);
      const value = cleanValue(line, h.field);
      if (!value) return;
      const lineStart = text.lastIndexOf('\n', h.start - 1) + 1;
      const own = /^[\s\-–—•·>#\d.)(\[]*$/.test(text.slice(lineStart, h.start));
      const cur = best[h.field];
      if (!cur || (own && !cur.own)) best[h.field] = { value: value.slice(0, 60), own, from: h.start, to: h.valueAt + lead + line.length };
    });
    // the task's notes are the description without its fields
    let rest = text;
    for (const f of [best.type, best.location].filter(Boolean).sort((a, b) => b.from - a.from)) rest = `${rest.slice(0, f.from)}\u0000${rest.slice(f.to)}`;
    // a line that held only fields goes; blank lines you wrote stay
    rest = rest.split('\n').filter((l) => !l.includes('\u0000') || !/^[\s\u0000\-–—•·,;|&()[\]]*$/.test(l))
      .map((l) => l.replace(/\u0000/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return { type: best.type ? best.type.value : null, location: best.location ? best.location.value : null, rest };
  }
  // "study" → the existing "Study"; a new type is added to your list
  function typeName(v) {
    if (!v) return null;
    try { return Store.addCategory(v.charAt(0).toUpperCase() + v.slice(1)); } catch (_) { return v; }
  }
  // "library" → the "Library" you've used before; "cafe" → "Café"
  function placeName(v) {
    if (!v) return null;
    const plain = (x) => x.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    let known = [];
    try { known = Store.locations(); } catch (_) { /* none */ }
    return [...known, 'Home', 'School', 'Library', 'Café'].find((p) => plain(p) === plain(v)) || v;
  }

  // a short place name (an address or a meeting link isn't a "focus spot")
  function placeOf(loc) {
    const s = String(loc || '').trim();
    if (!s || /^https?:\/\//i.test(s) || s.length > 40) return null;
    return s;
  }

  function focusMinutes() { try { return Number(Store.settings().focusMinutes) || 25; } catch (_) { return 25; } }
  function pomodorosFor(minutes) { return minutes > 0 ? Math.min(12, Math.max(1, Math.round(minutes / focusMinutes()))) : 1; }

  // One event, one task: the same event in two calendars (Google + its link) shares a key.
  function keyOf(e) {
    if (e.source === 'local') return `local:${e.id}`;
    return `${e.icalUID || e.externalID || e.id}@${e.allDay && e.startDay ? e.startDay : dayKey(new Date(e.start))}`;
  }
  function fieldsOf(e) {
    const allDay = !!e.allDay;
    const meta = parseFields(e.notes);
    return {
      type: meta.type, location: meta.location,
      title: String(e.title).replace(PREFIX, '').trim().slice(0, 120) || 'Untitled',
      day: allDay && e.startDay ? e.startDay : dayKey(new Date(e.start)),
      minutes: allDay ? 0 : Math.max(0, Math.round((Date.parse(e.end) - Date.parse(e.start)) / 60000)),
      notes: meta.rest.slice(0, 2000) || null,
      url: typeof e.htmlLink === 'string' && /^https:\/\//i.test(e.htmlLink) ? e.htmlLink : null,
    };
  }
  // the event as last read: the task only follows what changed since
  const seenOf = (f) => ({ title: f.title, day: f.day, notes: f.notes, url: f.url });
  function create(e, key, map, dueDate) {
    const f = fieldsOf(e);
    const t = Store.addTask({
      title: f.title, estimate: pomodorosFor(f.minutes), dueDate: dueDate || f.day, notes: f.notes, url: f.url,
      category: typeName(f.type), location: placeName(f.location) || placeOf(e.location), eventMinutes: f.minutes || null,
      externalSource: 'calendar', externalID: key,
    }, { append: true });
    if (t) map[key] = { taskId: t.id, at: new Date().toISOString(), type: f.type, location: f.location, seen: seenOf(f) };
    return t;
  }
  // the task of an event, if it has one
  function taskFor(e) {
    const rec = loadMap()[keyOf(e)];
    return rec ? Store.tasks().find((t) => lower(t.id) === lower(rec.taskId)) || null : null;
  }
  // "Add to Today's Tasks" on the event: a past event, or one whose task you deleted
  function add(e) {
    const map = loadMap();
    const today = dayKey(new Date());
    const day = fieldsOf(e).day;
    const t = create(e, keyOf(e), map, day < today ? today : day);
    saveMap(map);
    return t;
  }

  // Every "PUREFOCUS:" event from today to two weeks ahead, from the imported calendars and Pure Focus's own.
  function candidates() {
    const out = [];
    const t0 = new Date(); t0.setHours(0, 0, 0, 0);
    const from = t0.getTime(), to = from + (AHEAD_DAYS + 1) * 86400000;
    const consider = (e) => {
      if (!e || !matches(e.title)) return;
      if (e.source !== 'local') {                 // a hidden calendar adds nothing, nor one that's gone
        const feed = Feeds.get ? Feeds.get(e.calendarID) : null;
        if (Feeds.get && (!feed || feed.isVisible === false)) return;
      }
      const s = Date.parse(e.start), en = Date.parse(e.end);
      if (!Number.isFinite(s) || s >= to || Math.max(en || s, s + 1) <= from) return;
      out.push(e);
    };
    try {
      if (typeof Feeds !== 'undefined' && Feeds.events) {
        for (const e of Feeds.events()) consider(e);
      }
    } catch (_) { /* no feeds */ }
    try { for (const b of Store.blocks()) if (!b.taskID) consider({ ...b, source: 'local' }); } catch (_) { /* no blocks */ }
    return out;
  }

  // The key holds the event's day, so a moved event comes back under a new key. Its record moves with
  // it — same task, or still deleted — from the nearest day nothing is using any more.
  function movedRecord(key, map, inUse, today) {
    if (key.startsWith('local:')) return null;
    const uid = key.slice(0, key.lastIndexOf('@'));
    const old = Object.keys(map).filter((k) => k.slice(0, k.lastIndexOf('@')) === uid && !inUse.has(k) && k.slice(k.lastIndexOf('@') + 1) >= today).sort()[0];
    if (!old) return null;
    map[key] = map[old];
    delete map[old];
    return map[key];
  }

  let running = false;
  function sync() {
    if (running || typeof Store === 'undefined') return 0;
    running = true;
    let created = 0;
    try {
      const map = loadMap();
      const tasks = Store.tasks();
      const byId = new Map(tasks.map((t) => [lower(t.id), t]));
      const today = dayKey(new Date());
      const events = candidates();
      const inUse = new Set(events.map(keyOf));
      Store.bulk(() => {
        for (const e of events) {
          const key = keyOf(e);
          const f = fieldsOf(e);
          const { title, day, minutes, notes, url, type, location } = f;
          const due = day < today ? today : day;  // a multi-day event already under way: earlier would hide it
          const rec = map[key] || movedRecord(key, map, inUse, today);
          const existing = rec ? byId.get(lower(rec.taskId)) : null;
          if (existing) {
            if (existing.isDone) continue;
            const seen = rec.seen || seenOf(f);   // tasks from before this was kept: yours stand
            const patch = {};
            if (title !== seen.title) patch.title = title;
            if (day !== seen.day || (existing.dueDate && existing.dueDate < today)) { if (existing.dueDate !== due) patch.dueDate = due; }
            if (notes !== seen.notes) patch.notes = notes;
            if (url !== seen.url) patch.url = url;
            if (existing.externalID !== key) patch.externalID = key;
            rec.seen = seenOf(f);
            if ((existing.eventMinutes || 0) !== minutes) patch.eventMinutes = minutes || null;
            if (!existing.estimateSet && minutes && existing.estimate !== pomodorosFor(minutes)) patch.estimate = pomodorosFor(minutes);
            // the description decides when it changes; until then a pick you made by hand stands
            if (type && lower(type) !== lower(rec.type)) { patch.category = typeName(type); rec.type = type; }
            if (location && lower(location) !== lower(rec.location)) { patch.location = placeName(location); rec.location = location; }
            if (Object.keys(patch).length) Store.updateTask(existing.id, patch);
            continue;
          }
          if (rec) continue;                      // you deleted its task: leave it deleted
          if (create(e, key, map, due)) created++;
        }
      });
      saveMap(map);
      if (created) {
        try { App.toast(`Added ${created} task${created === 1 ? '' : 's'} from your calendar (“PUREFOCUS:” events)`, 'success'); } catch (_) {}
      }
    } catch (err) {
      console.error('CalendarTasks.sync failed', err);
    } finally {
      running = false;
    }
    return created;
  }

  let timer = 0;
  function soon() { clearTimeout(timer); timer = setTimeout(sync, 400); }

  function init() {
    try {
      Store.on('calcache', soon);                 // a calendar link or Google refreshed
      Store.on('blocks', soon);                   // the Pure Focus calendar changed
      // everything was cleared: events added back are new, not tasks you deleted
      Store.on('change', (kind) => { if (kind === 'reset' && !Store.tasks().length) saveMap({}); });
    } catch (_) {}
    document.addEventListener('visibilitychange', () => { if (!document.hidden) soon(); });
    soon();
  }

  return { init, sync, matches, taskFor, add, parseFields, _plainText: plainText };
})();
