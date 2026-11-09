/* ═══════════════════════════════════════════════════════════════════════
   calendar.js — the Calendar tab (owner: W2)
   Day / Week / Month / Agenda over the user's local blocks (Store.blocks(),
   SPEC §1.2.3 CalendarBlock) and read-only imported events (Feeds cache,
   pfKey('purefocus.calcache.v1')), plus due chips for assignments and dated tasks.

   Model rules (SPEC §1.2.3 invariants, enforced in commitBlocks):
     • end > start, ≥ 15 min, timed blocks never cross local midnight;
     • the past is editable like the future (round 4): blocks can be added, moved, resized
       and deleted on any day;
     • kind 'focus' ⇔ taskID; pomodoros = capacity(length), plannedFocusMinutes = pomodoros × focus;
     • isTask: the block IS its task (Google Tasks style) — it carries a checkbox, and ticking it
       keeps the block, shown checked off; courseID tags a block with a course (and its colour);
     • plannedAt is stamped on start/end changes only.
   Every edit is one Store.setBlocks write and one step on the shared 50-step undo
   stack (⌘Z / ⇧⌘Z, Ctrl elsewhere), with 8 s Undo toasts for the bigger moves.

   Public API
     CalendarView.init() · render() · isActive()
     CalendarView.events()                       → v1-shaped copies (old callers; Google calendarID unprefixed)
     CalendarView.addExternal(list, source, {calendarID}?) → count (google.js; replaces that source/feed)
     CalendarView.importFiles(files) · pickFiles()
     CalendarView.undo() · redo() · confirmSwitch(title, minutes) → Promise<bool>
     + the SPEC-V2 §4.8 hooks: planSlot · previewRoot · setPreview · onGhostToggle · pushUndo ·
       registerSidebarSection · setTodayLineProvider · visibleRange · goTo

   Safety: every user or imported string goes through textContent / attribute
   setters; innerHTML only ever receives the static SVG icons defined below.
   ═══════════════════════════════════════════════════════════════════════ */

const CalendarView = (() => {
  const SNAP = 15;
  const SNAP_MS = SNAP * 60000;
  const DAY_MS = 86400000;
  const AGENDA_DAYS = 30;
  const VIEWS = [
    { id: 'day', label: 'Day', key: 'D' },
    { id: 'week', label: 'Week', key: 'W' },
    { id: 'month', label: 'Month', key: 'M' },
    { id: 'agenda', label: 'Agenda', key: 'A' },
  ];
  const SOURCE_LABEL = { local: 'Pure Focus', google: 'Google Calendar', ics: 'Calendar file' };
  const UNDO_TOAST_MS = 8000;

  // Static icon markup only — never interpolate data into these strings.
  const ICONS = {
    chevL: '<svg viewBox="0 0 20 20"><path d="M12.5 4.5 7 10l5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    chevR: '<svg viewBox="0 0 20 20"><path d="M7.5 4.5 13 10l-5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    chevD: '<svg viewBox="0 0 20 20"><path d="m5.5 8 4.5 4.5L14.5 8" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    plus: '<svg viewBox="0 0 20 20"><path d="M10 4.5v11M4.5 10h11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    download: '<svg viewBox="0 0 20 20"><path d="M10 3.5v9m0 0-3.5-3.5M10 12.5l3.5-3.5M4 14.5v1A1.5 1.5 0 0 0 5.5 17h9a1.5 1.5 0 0 0 1.5-1.5v-1" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    cloud: '<svg viewBox="0 0 20 20"><path d="M6 15.5h8.2a3.3 3.3 0 0 0 .5-6.56A4.6 4.6 0 0 0 5.9 8.1 3.7 3.7 0 0 0 6 15.5Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    tasks: '<svg viewBox="0 0 20 20"><rect x="3.5" y="3.5" width="13" height="13" rx="3.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m7 10.2 2.1 2.1L13.2 8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    file: '<svg viewBox="0 0 20 20"><path d="M5.5 2.8h5.7l3.8 3.8v9.1a1.5 1.5 0 0 1-1.5 1.5h-8a1.5 1.5 0 0 1-1.5-1.5V4.3a1.5 1.5 0 0 1 1.5-1.5Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M11 3v3.8h3.8M7 11h6M7 14h4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    calendar: '<svg viewBox="0 0 20 20"><rect x="3" y="4.2" width="14" height="12.6" rx="3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3.2 8.2h13.6M7 2.8v2.6M13 2.8v2.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    trash: '<svg viewBox="0 0 20 20"><path d="M4 6h12M8 6V4.5h4V6m-6.5 0 .7 9.6A1.5 1.5 0 0 0 7.7 17h4.6a1.5 1.5 0 0 0 1.5-1.4L14.5 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    eyeOff: '<svg viewBox="0 0 20 20"><path d="M3 3.5 17 16.5M8.2 5.3A7.6 7.6 0 0 1 10 5.1c4 0 6.6 3.6 7.2 4.9-.3.7-1.1 1.9-2.3 3M5.4 6.9C4 8 3.1 9.3 2.8 10c.6 1.3 3.2 4.9 7.2 4.9 1 0 1.9-.2 2.7-.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    play: '<svg viewBox="0 0 20 20"><path d="M6.5 4.6v10.8a.8.8 0 0 0 1.2.7l8.6-5.4a.8.8 0 0 0 0-1.4L7.7 3.9a.8.8 0 0 0-1.2.7Z" fill="currentColor"/></svg>',
    clock: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="6.8" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 6.4V10l2.4 1.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    link: '<svg viewBox="0 0 20 20"><path d="M3.8 5.5h1.8M3.8 10h1.8M3.8 14.5h1.8M8.5 5.5h7.7M8.5 10h7.7M8.5 14.5h5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    notes: '<svg viewBox="0 0 20 20"><path d="M4 5.5h12M4 10h12M4 14.5h7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    video: '<svg viewBox="0 0 20 20"><rect x="2.8" y="5.4" width="10.4" height="9.2" rx="2.4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m13.2 8.6 4-2.4v7.6l-4-2.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    clip: '<svg viewBox="0 0 20 20"><path d="m15.6 9.4-5.8 5.8a3.4 3.4 0 0 1-4.8-4.8l6.1-6.1a2.3 2.3 0 0 1 3.2 3.2l-6 6a1.1 1.1 0 0 1-1.6-1.6l5.4-5.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    x: '<svg viewBox="0 0 20 20"><path d="m5.5 5.5 9 9m0-9-9 9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    sparkle: '<svg viewBox="0 0 20 20"><path d="M10 2.8c.5 3.6 1.6 4.7 5.2 5.2-3.6.5-4.7 1.6-5.2 5.2-.5-3.6-1.6-4.7-5.2-5.2 3.6-.5 4.7-1.6 5.2-5.2Z" fill="currentColor"/><path d="M15.2 12.6c.25 1.5.7 1.95 2.2 2.2-1.5.25-1.95.7-2.2 2.2-.25-1.5-.7-1.95-2.2-2.2 1.5-.25 1.95-.7 2.2-2.2Z" fill="currentColor"/></svg>',
    grip: '<svg viewBox="0 0 20 20"><g fill="currentColor"><circle cx="7.5" cy="5.5" r="1.3"/><circle cx="12.5" cy="5.5" r="1.3"/><circle cx="7.5" cy="10" r="1.3"/><circle cx="12.5" cy="10" r="1.3"/><circle cx="7.5" cy="14.5" r="1.3"/><circle cx="12.5" cy="14.5" r="1.3"/></g></svg>',
    lock: '<svg viewBox="0 0 20 20"><rect x="4.5" y="9" width="11" height="8" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M7 9V6.8a3 3 0 0 1 6 0V9" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    pin: '<svg viewBox="0 0 20 20"><path d="M10 17.2s5.2-4.6 5.2-8.8a5.2 5.2 0 0 0-10.4 0c0 4.2 5.2 8.8 5.2 8.8Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="10" cy="8.4" r="1.8" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
    inbox: '<svg viewBox="0 0 20 20"><path d="M3.5 11.2 5.6 4.6A1.5 1.5 0 0 1 7 3.6h6a1.5 1.5 0 0 1 1.4 1l2.1 6.6v3.7a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M3.8 11.2h3.6l1 2h3.2l1-2h3.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    info: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 9v4.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="10" cy="6.4" r="1.05" fill="currentColor"/></svg>',
    cap: '<svg viewBox="0 0 20 20"><path d="M2.5 8 10 4.5 17.5 8 10 11.5 2.5 8Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M5.5 9.6v3.6c0 1 2 2.3 4.5 2.3s4.5-1.3 4.5-2.3V9.6M17.5 8v4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    out: '<svg viewBox="0 0 20 20"><path d="M11.5 3.5h5v5M16.3 3.7 9.5 10.5M14.5 12v3a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 15V7A1.5 1.5 0 0 1 5 5.5h3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    check: '<svg viewBox="0 0 20 20"><path d="M4.5 10.5 8.5 14.5 15.5 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    // ☰ like Google Calendar's — the app's own sidebar button (a panel icon) can sit right beside it
    sidebar: '<svg viewBox="0 0 20 20"><path d="M3.6 5.6h12.8M3.6 10h12.8M3.6 14.4h12.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    refresh: '<svg viewBox="0 0 20 20"><path d="M15.6 8.2A6 6 0 0 0 4.7 6.6M4.4 11.8a6 6 0 0 0 10.9 1.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M15.8 4.2v4.2h-4.2M4.2 15.8v-4.2h4.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    more: '<svg viewBox="0 0 20 20"><g fill="currentColor"><circle cx="5" cy="10" r="1.5"/><circle cx="10" cy="10" r="1.5"/><circle cx="15" cy="10" r="1.5"/></g></svg>',
    warn: '<svg viewBox="0 0 20 20"><path d="M10 3.5 17.5 16.5h-15L10 3.5Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M10 8.3v3.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="10" cy="14.1" r="1" fill="currentColor"/></svg>',
    free: '<svg viewBox="0 0 20 20"><rect x="3.5" y="4.5" width="13" height="11" rx="2.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2.4 2"/></svg>',
    dropin: '<svg viewBox="0 0 20 20"><path d="M10 3.5v8.5m0 0-3.2-3.2M10 12l3.2-3.2M4.5 16h11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  let HOUR_PX = 56;
  let MIN_PX = HOUR_PX / 60;
  let anchor = startOfDay(new Date());
  let root = null;
  const ui = {};
  let pop = null;           // { el, id, isNew, anchor, session }
  let menu = null;          // open dropdown
  let drag = null;          // active pointer gesture
  let scrollMem = null;     // last time-grid scrollTop
  let scrollToNow = false;
  let suppressCreate = false;
  let sideRebuilding = false;
  let allDayExpanded = false;
  let lastPointer = { x: 0, y: 0 };
  let lastDay = dayKey(new Date());
  let resizeRaf = 0;
  let renderQueued = false;
  let lastOpenRefresh = 0;

  // ───────────────────────────  DOM helpers  ───────────────────────────

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
    t.innerHTML = ICONS[name] || ICONS.info;   // static markup from ICONS only
    const svg = t.content.firstElementChild;
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'cal-i' + (cls ? ' ' + cls : ''));
    return svg;
  }

  const srcIcon = (e) => (e.source !== 'local' ? icon(e.source === 'google' ? 'cloud' : 'file', 'cal-src') : null);
  const toast = (msg, variant) => { if (typeof App !== 'undefined' && App.toast) App.toast(msg, variant); };

  // ───────────────────────────  dates  ───────────────────────────

  function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }
  function localeWeekStart() {
    try {
      const loc = new Intl.Locale(navigator.language || 'en-US');
      const wi = loc.weekInfo || (typeof loc.getWeekInfo === 'function' ? loc.getWeekInfo() : null);
      if (wi && wi.firstDay) return wi.firstDay % 7;
    } catch (_) { /* fallback */ }
    return 0;
  }
  function weekStart() {
    const w = prefs().weekStartsOn;
    return Number.isInteger(w) && w >= 0 && w <= 6 ? w : localeWeekStart();
  }
  function startOfWeek(d) {
    const x = startOfDay(d);
    return addDays(x, -((x.getDay() - weekStart() + 7) % 7));
  }
  function minuteOfDay(d) { return d.getHours() * 60 + d.getMinutes(); }
  function dateAt(day, minutes) {
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes);
  }
  function dayIndex(from, d) { return Math.round((startOfDay(d) - startOfDay(from)) / DAY_MS); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function dayKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function parseDayKey(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  }
  function hhmm(d) { return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
  function ceilSnap(ms) { return Math.ceil(ms / SNAP_MS) * SNAP_MS; }
  function floorSnap(ms) { return Math.floor(ms / SNAP_MS) * SNAP_MS; }
  function snapMin(m) { return Math.round(m / SNAP) * SNAP; }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function fmt(opts) { try { return new Intl.DateTimeFormat(undefined, opts); } catch (_) { return new Intl.DateTimeFormat('en-US', opts); } }
  const F = {
    time: fmt({ hour: 'numeric', minute: '2-digit' }),
    hour: fmt({ hour: 'numeric' }),
    dow: fmt({ weekday: 'short' }),
    dowLong: fmt({ weekday: 'long' }),
    monthYear: fmt({ month: 'long', year: 'numeric' }),
    monthShort: fmt({ month: 'short' }),
    md: fmt({ month: 'short', day: 'numeric' }),
    mdy: fmt({ month: 'short', day: 'numeric', year: 'numeric' }),
    full: fmt({ weekday: 'long', month: 'long', day: 'numeric' }),
    medium: fmt({ weekday: 'short', month: 'short', day: 'numeric' }),
  };

  /* The now tag in the hour gutter: the clock without AM/PM so it fits (the hour labels carry it). */
  function nowLabel(d) { return F.time.format(d).replace(/\s?[AaPp]\.?\s?[Mm]\.?$/, '').trim(); }
  function shortTime(d) { return d.getMinutes() === 0 ? F.hour.format(d) : F.time.format(d); }
  function timeRange(a, b) {
    try { if (F.time.formatRange) return F.time.formatRange(a, b); } catch (_) { /* fall through */ }
    return `${F.time.format(a)} – ${F.time.format(b)}`;
  }
  function fmtDur(min) {
    const hh = Math.floor(min / 60), mm = Math.round(min % 60);
    if (!hh) return `${mm}m`;
    return mm ? `${hh}h ${mm}m` : `${hh}h`;
  }
  function tzLabel() {
    try {
      const p = fmt({ timeZoneName: 'short' }).formatToParts(new Date()).find((x) => x.type === 'timeZoneName');
      return p ? p.value : '';
    } catch (_) { return ''; }
  }
  function isoWeek(d) {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return Math.ceil(((t - y0) / DAY_MS + 1) / 7);
  }
  // "11:59p" style for due chips
  function dueClock(min) {
    if (min == null) return '';
    const d = dateAt(new Date(2000, 0, 1), min);
    const hr = d.getHours() % 12 || 12;
    return `${hr}${d.getMinutes() ? ':' + pad(d.getMinutes()) : ''}${d.getHours() < 12 ? 'a' : 'p'}`;
  }

  // ───────────────────────────  durations (SPEC §1.4.2; CalCore when ready)  ───────────────────────────

  function pomoSettings() {
    const s = Store.settings();
    return { focus: Number(s.focusMinutes) || 25, short: Number(s.shortBreakMinutes) || 5,
      long: Number(s.longBreakMinutes) || 15, interval: Math.max(1, Number(s.longBreakInterval) || 4) };
  }
  const core = () => (typeof CalCore !== 'undefined' && CalCore.ready ? CalCore : null);
  function focusSpan(n, s = pomoSettings()) {
    if (core()) return CalCore.focusSpan(n, s);
    if (n <= 0) return 0;
    let m = n * s.focus;
    for (let k = 1; k < n; k++) m += k % s.interval === 0 ? s.long : s.short;
    return m;
  }
  function blockMinutes(n, s = pomoSettings()) {
    if (core()) return CalCore.blockMinutes(n, s);
    return Math.max(15, Math.ceil(focusSpan(n, s) / SNAP) * SNAP);
  }
  function capacity(minutes, s = pomoSettings()) {
    if (core()) return CalCore.capacity(minutes, s);
    let n = 0;
    while (n < 48 && focusSpan(n + 1, s) <= minutes) n++;
    return n;
  }

  // ───────────────────────────  model  ───────────────────────────

  const prefs = () => Store.calendar().prefs;
  function setPrefs(patch) { Store.updateCalendar({ prefs: patch }); }
  const feeds = () => Store.calendar().feeds;
  function feedMap() { const m = new Map(); for (const f of feeds()) m.set(f.id, f); return m; }
  /* A calendar's colour: the one you picked for it, else one from the current theme (and light/dark),
     so calendars you never recoloured match the look you chose and follow it when you switch. */
  const feedColor = (f) => (f ? themed(f.userColorHex) || themeColorOf(f) || f.colorHex : null) || null;

  /* The theme's colours for everything on the calendar. Each theme is built on three colours — the
     focus tint (My blocks use it) and aurora B and C. The palette stays inside the arc of the colour
     wheel those three span, widened a little, so an orange theme gets corals, ambers and roses, never a
     stray blue; the theme's own strength decides how vivid they are (Graphite stays muted). Within
     the arc, colours differ in lightness and strength as well as hue: each next one is the candidate
     farthest from every colour already taken, so neighbours stay easy to tell apart.
     Memoised per theme + scheme. */
  let themePal = null;
  function themePalette() {
    const rootEl = document.documentElement;
    const key = `${rootEl.dataset.pfTheme || ''}|${rootEl.dataset.theme || ''}`;
    if (themePal && themePal.key === key) return themePal.list;
    const list = [];
    try {
      const all = (typeof PF_THEMES !== 'undefined' && PF_THEMES && PF_THEMES.themes) || [];
      const t = all.find((x) => x.id === rootEl.dataset.pfTheme) || all.find((x) => x.id === PF_THEMES.default) || all[0];
      if (t) {
        const light = rootEl.dataset.theme === 'light';
        const g = ((light ? t.light : t.dark) || {}).graphic || {};
        const lch = (hex) => { const v = toOklab(hex); return v ? { L: v[0], C: Math.hypot(v[1], v[2]), h: Math.atan2(v[2], v[1]) } : null; };
        const focus = lch(g.focus || t.focus);
        const aurora = [lch(t.auroraB), lch(t.auroraC)].filter(Boolean);
        const anchors = (focus ? [focus] : []).concat(aurora);
        const TAU = 2 * Math.PI;
        const norm = (x) => ((x % TAU) + TAU) % TAU;
        // the arc holding all three: the wheel minus its widest empty gap
        const hs = anchors.map((x) => norm(x.h)).sort((a, b) => a - b);
        let from = hs[0], span = 0, widest = -1;
        hs.forEach((h, i) => {
          const next = i + 1 < hs.length ? hs[i + 1] : hs[0] + TAU;
          if (next - h > widest) { widest = next - h; from = next; span = TAU - (next - h); }
        });
        const MIN_ARC = 120 * Math.PI / 180;
        const pad = Math.max(24 * Math.PI / 180, (MIN_ARC - span) / 2);
        from -= pad; span += 2 * pad;
        // as vivid as the theme itself, on one shared range of lightness that reads on this scheme
        const C = Math.min(0.15, Math.max(0.05, Math.max(...anchors.map((x) => x.C)) * 0.72));
        const L = light ? 0.58 : 0.74;
        const lab = (l, c, h) => [l, c * Math.cos(h), c * Math.sin(h)];
        const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
        const taken = focus ? [lab(L, C, focus.h)] : [];
        const take = (v) => { taken.push(v); list.push(fromOklab(v)); };
        for (const x of aurora) {                        // the aurora's own colours first, if they stand apart
          const v = lab(L, C, x.h);
          if (!taken.some((u) => dist(u, v) < 0.05)) take(v);
        }
        const cands = [];
        for (let i = 0; i <= 12; i++) {
          for (const dl of [0, 0.09, -0.09]) for (const k of [1, 0.72]) cands.push(lab(L + dl, C * k, from + (span * i) / 12));
        }
        while (list.length < 8) {
          let best = cands[0], bestD = -1;
          for (const v of cands) {
            const d = Math.min(...taken.map((u) => dist(u, v)));
            if (d > bestD) { bestD = d; best = v; }
          }
          take(best);
        }
      }
    } catch (_) { /* no theme data: the stored colours are used */ }
    themePal = { key, list };
    return list;
  }
  /* The eight colour choices are slots, not fixed colours: a swatch you picked, for a calendar, block
     or course, is that slot's colour in whichever theme is on. Any other colour stays exactly as set. */
  function themed(hex) {
    const pal = themePalette();
    if (!hex || !pal.length) return hex || null;
    const v = String(hex).toLowerCase();
    const i = SWATCHES.findIndex((c) => c === v || (typeof Feeds !== 'undefined' && lowerHex(Feeds.normalizeColor(c)) === v));
    return i < 0 ? hex : pal[i % pal.length];
  }
  function lowerHex(x) { return String(x || '').toLowerCase(); }
  /* Types of work and courses take palette colours too, counted from the far end so the first ones
     don't land on the same colours as your first calendars. */
  function fromEnd(i) { const pal = themePalette(); return pal.length && i >= 0 ? pal[pal.length - 1 - (i % pal.length)] : null; }
  function catColor(name) {
    const cats = (() => { try { return Store.categories(); } catch (_) { return []; } })();
    return fromEnd(cats.findIndex((c) => lowerHex(c) === lowerHex(name))) || Store.categoryColor(name);
  }
  /* Calendars without a colour of their own share the palette in the order they were added. */
  function themeColorOf(f) {
    const pal = themePalette();
    if (!pal.length) return null;
    const i = feeds().filter((x) => !x.userColorHex).findIndex((x) => x.id === f.id);
    if (i < 0) return null;
    // skipping the colours other calendars were given by hand, so no two calendars match
    const claimed = new Set(feeds().filter((x) => x.userColorHex).map((x) => lowerHex(themed(x.userColorHex))));
    const free = pal.filter((c) => !claimed.has(lowerHex(c)));
    const from = free.length ? free : pal;
    return from[i % from.length];
  }
  function toOklab(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    const lin = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    const l = Math.cbrt(0.4122214708 * lin[0] + 0.5363325363 * lin[1] + 0.0514459929 * lin[2]);
    const mm = Math.cbrt(0.2119034982 * lin[0] + 0.6806995451 * lin[1] + 0.1073969566 * lin[2]);
    const sx = Math.cbrt(0.0883024619 * lin[0] + 0.2817188376 * lin[1] + 0.6299787005 * lin[2]);
    return [0.2104542553 * l + 0.7936177850 * mm - 0.0040720468 * sx, 1.9779984951 * l - 2.4285922050 * mm + 0.4505937099 * sx, 0.0259040371 * l + 0.7827717662 * mm - 0.8086757660 * sx];
  }
  function fromOklab([L, a, b]) {
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, sx = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
    const lin = [4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * sx, -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * sx, -0.0041960863 * l - 0.7034186147 * mm + 1.7076147010 * sx];
    return '#' + lin.map((v) => { v = Math.min(1, Math.max(0, v)); v = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055; return Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0'); }).join('');
  }
  const labDist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  const feedName = (f) => (f && (f.displayName || f.name)) || '';
  const clone = (b) => JSON.parse(JSON.stringify(b));
  const lowerEq = (a, b) => a != null && b != null && String(a).toLowerCase() === String(b).toLowerCase();

  function localBlocks() { return Store.blocks().filter((b) => !b.hidden); }

  const isSchoolFeed = (f) => !!f && (f.provider === 'canvas' || f.provider === 'blackbaud');

  /* Canvas assignments that a school calendar you've added holds (dismissed ones too): their numbers,
     and "title|due time" keys for copies that carry a different ID. Copies of them in other calendars
     follow the Canvas checkbox instead of their own — shown as Canvas due chips when it's on, gone when off. */
  const plainTitle = (t) => {
    const [plain] = typeof Assignments !== 'undefined' && Assignments.splitCourse ? Assignments.splitCourse(String(t || '')) : [String(t || '')];
    return String(plain).trim().toLowerCase().replace(/\s+/g, ' ');
  };
  function shownAssignmentNumbers(fm) {
    const out = new Set();
    out.keys2 = new Set();
    if (typeof Assignments === 'undefined' || !Assignments.list) return out;
    for (const a of Assignments.list({ includeDismissed: true })) {
      if (!isSchoolFeed(fm.get(a.feedID))) continue;
      const m = /:a(\d+)$/.exec(String(a.id));
      if (m) out.add(m[1]);
      if (a.due) out.keys2.add(`${plainTitle(a.title)}|${Date.parse(a.due)}`);
    }
    return out;
  }

  /* Imported events from visible feeds (read-only CalendarBlocks). */
  function importedEvents() {
    if (typeof Feeds === 'undefined' || !Feeds.events) return [];
    const fm = feedMap();
    const out = [];
    const dueNums = shownAssignmentNumbers(fm);
    for (const raw of Feeds.events()) {
      const f = fm.get(raw.calendarID);
      if (!f || f.isVisible === false) continue;
      const b = Feeds.toBlock(raw, f);
      const school = isSchoolFeed(f);
      // a copy of a Canvas assignment in another calendar (the Canvas feed subscribed inside Google):
      // its due chip already shows it, in the Canvas colour
      if (!school && dueNums.size && b.icalUID && Assignments.canvasAssignmentID) {
        const n = Assignments.canvasAssignmentID(b.icalUID, raw.url || null);
        if (n && dueNums.has(String(n))) continue;
      }
      // …or the same assignment under another ID (a school calendar that copies Canvas): same title, same time
      if (!school && dueNums.keys2.size && !b.allDay && dueNums.keys2.has(`${plainTitle(b.title)}|${Date.parse(b.start)}`)) continue;
      b.sourceKind = school ? 'school' : b.source === 'google' ? 'google' : String(b.calendarID || '').startsWith('apple:') ? 'apple'
        : String(b.calendarID || '').startsWith('icsurl:') ? 'icsurl' : 'ics';
      b.calendarName = feedName(f);
      out.push(b);
    }
    // The same event from two visible sources is drawn once (V14): school (Canvas…) > Google > Apple > link > file.
    if (out.length > 1 && typeof Assignments !== 'undefined' && Assignments.dedupe) return Assignments.dedupe(out);
    return out;
  }

  function displayItems() {
    const list = prefs().showLocalBlocks === false ? [] : localBlocks();
    return list.concat(importedEvents());
  }

  let itemsMemo = null;
  function items() {
    if (!itemsMemo) itemsMemo = displayItems();
    return itemsMemo;
  }
  function invalidate() { itemsMemo = null; }

  function findEvent(id) {
    return items().find((e) => e.id === id) || Store.blocks().find((b) => b.id === id) || null;
  }
  const findLocal = (id) => Store.blocks().find((b) => b.id === id) || null;
  const taskById = (id) => (id ? Store.tasks().find((t) => lowerEq(t.id, id)) || null : null);

  function allDayRange(e) {
    const s = parseDayKey(e.startDay) || startOfDay(new Date(e.start));
    let en = parseDayKey(e.endDay);
    if (!en) { const end = new Date(e.end); en = startOfDay(end); if (end > en) en = addDays(en, 1); }
    if (en <= s) en = addDays(s, 1);
    return [s, en];
  }

  // Imported timed events lasting ≥ 24 h are drawn in the all-day row (SPEC §3.5).
  function isAllDayish(e) {
    if (e.allDay) return true;
    return e.readOnly && (new Date(e.end) - new Date(e.start)) >= DAY_MS;
  }

  function overlaps(e, from, to) {
    if (e.allDay) { const [s, en] = allDayRange(e); return s < to && en > from; }
    const s = new Date(e.start), en = new Date(e.end);
    if (+s === +en) return s >= from && s < to;
    return s < to && en > from;
  }

  function byStart(a, b) {
    if (!!a.allDay !== !!b.allDay) return a.allDay ? -1 : 1;
    return new Date(a.start) - new Date(b.start) || new Date(b.end) - new Date(a.end);
  }

  function colorOf(e) {
    if (e.source && e.source !== 'local') {
      const f = feedMap().get(e.calendarID);
      return feedColor(f) || e.colorHex || 'var(--text-muted)';
    }
    if (e.colorHex) return themed(e.colorHex);
    const course = courseOf(e);
    if (course) return courseHex(course) || 'var(--focus-tint)';
    const t = taskById(e.taskID);
    const cat = (t && t.category) || e.category;
    if (cat) return catColor(cat);
    return 'var(--focus-tint)';
  }

  function titleOf(e) {
    const t = taskById(e.taskID);
    if (t && e.source === 'local') return t.title;
    if (e.title && e.title.trim()) return e.title;
    return e.source === 'local' ? 'Untitled block' : '(No title)';
  }

  function calNameOf(e) {
    if (e.source === 'local') return 'Pure Focus';
    const f = feedMap().get(e.calendarID);
    return feedName(f) || e.calendarName || SOURCE_LABEL[e.source] || '';
  }

  function openTask(e) {
    const t = taskById(e && e.taskID);
    return t && !t.isDone ? t : null;
  }

  /* Courses (courses.js owns them): a block — or its task — names one by courseID. */
  function courseList() { try { return Store.courses().filter((c) => !c.archived); } catch (_) { return []; } }
  function courseById(id) { if (!id) return null; try { return Store.courses().find((c) => lowerEq(c.id, id)) || null; } catch (_) { return null; } }
  function courseLabel(c) {
    if (!c) return '';
    try { if (typeof Courses !== 'undefined' && Courses.label) return Courses.label(c); } catch (_) { /* fall through */ }
    return String(c.code || c.name || 'Course');
  }
  function courseHex(c) {
    if (!c) return null;
    if (c.colorHex) return themed(c.colorHex);
    return fromEnd(courseList().findIndex((x) => lowerEq(x.id, c.id)) + 3) || null;
  }
  function courseOf(e) {
    if (!e || e.source !== 'local') return null;
    return courseById(e.courseID) || courseById((taskById(e.taskID) || {}).courseID);
  }

  /* The checkbox on a task block (or in its popover): ticks the task off everywhere. The ticked
     block stays (checked); the task's other future focus blocks clear as usual, with Undo. */
  function setTaskDone(taskID, done, blockID) {
    const t = taskById(taskID);
    if (!t || !!t.isDone === !!done) return;
    if (typeof TaskSync !== 'undefined' && TaskSync.complete) TaskSync.complete(t.id, { done: !!done, keep: blockID || null });
    else Store.toggleTaskDone(t.id);
    invalidate();
    render();
    if (pop) positionPop();
  }

  /* The task a running focus session belongs to (null when no focus session runs). */
  function focusingTaskID() {
    try {
      if (typeof Timer === 'undefined' || !Timer.state) return null;
      const s = Timer.state();
      return s && s.running && s.mode === 'focus' && s.taskID ? s.taskID : null;
    } catch (_) { return null; }
  }
  function isFocusingTask(taskID) {
    const id = focusingTaskID();
    return !!id && taskID != null && lowerEq(id, taskID);
  }
  function focusBtnLabel(taskID, fallback) {
    return isFocusingTask(taskID) ? 'Focusing on this' : (fallback || 'Start focus');
  }

  /* Canvas assignments can be ticked here without becoming a task. An explicit tick (or
     untick) is remembered in the synced calendar prefs, so a feed refresh cannot undo it. */
  function assignmentOverride(id) {
    const m = prefs().assignmentDone;
    if (!m || typeof m !== 'object') return null;
    const k = String(id || '').toLowerCase();
    return Object.prototype.hasOwnProperty.call(m, k) ? !!m[k] : null;
  }
  function isAssignmentDone(a) {
    if (!a) return false;
    const o = assignmentOverride(a.id);
    return o === null ? a.submitted === true : o;
  }
  function setAssignmentDone(a, done) {
    if (!a || !a.id) return;
    const cur = prefs().assignmentDone || {};
    const next = { ...cur, [String(a.id).toLowerCase()]: !!done };
    // keep the synced record small: drop the oldest keys beyond 500
    const keys = Object.keys(next);
    if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete next[k];
    Store.updateCalendar({ prefs: { assignmentDone: next } });
    invalidate();
    render();
    if (pop) positionPop();
  }
  /* The checkbox that belongs to a due item: a linked task toggles the task itself,
     an unpromoted assignment uses the synced override. */
  function dueCheck(d, cls) {
    if (d.task) return taskCheck(d.task, null, cls);
    if (!d.assignment) return null;
    const done = isAssignmentDone(d.assignment);
    const tick = (ev) => { ev.stopPropagation(); ev.preventDefault(); setAssignmentDone(d.assignment, !done); };
    const el = h('span', {
      class: 'cal-ev-check ' + cls, role: 'checkbox', 'aria-checked': String(done),
      'aria-label': done ? `Mark “${d.assignment.title}” as not done` : `Mark “${d.assignment.title}” done`,
      title: done ? 'Done — click to undo' : 'Mark done', onclick: tick,
    }, icon('check'));
    el.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    return el;
  }

  const nowMs = () => Date.now();
  const isPastBlock = (b) => new Date(b.end).getTime() <= nowMs();
  const isActiveBlock = (b) => { const n = nowMs(); return new Date(b.start).getTime() < n && new Date(b.end).getTime() > n; };

  // ───────────────────────────  local blocks: create / edit / undo  ───────────────────────────

  function makeBlock({ title = '', start, end, allDay = false, taskID = null }) {
    const now = new Date().toISOString();
    const s = new Date(start), en = new Date(end);
    const t = taskById(taskID);
    const b = {
      id: Store.uid(), title: String(title || (t ? t.title : '')).slice(0, 120),
      start: s.toISOString(), end: en.toISOString(), allDay: !!allDay, startDay: null, endDay: null,
      kind: taskID ? 'focus' : 'event', taskID: taskID || null, category: t ? t.category || null : null,
      colorHex: null, notes: null, location: null, source: 'local', externalID: null, calendarID: null, calendarName: null,
      eventType: null, readOnly: false, isBusy: true, htmlLink: null, pomodoros: 0, plannedFocusMinutes: 0,
      autoPlanned: false, hidden: false, createdAt: now, plannedAt: now, updatedAt: now,
    };
    if (allDay) { b.startDay = dayKey(startOfDay(s)); b.endDay = dayKey(startOfDay(en) > startOfDay(s) ? startOfDay(en) : addDays(startOfDay(s), 1)); }
    return derive(b);
  }

  /* Keeps kind / pomodoros / plannedFocusMinutes consistent (invariants 5–6). */
  function derive(b) {
    const s = pomoSettings();
    if (b.taskID) {
      b.kind = 'focus';
      const len = Math.round((new Date(b.end) - new Date(b.start)) / 60000);
      b.pomodoros = b.allDay ? 0 : capacity(len, s);
      b.plannedFocusMinutes = b.pomodoros * s.focus;
    } else {
      b.kind = 'event';
      b.pomodoros = 0;
      b.plannedFocusMinutes = 0;
    }
    return b;
  }

  /* Validates one change against SPEC §1.2.3. Returns an error sentence or null; may fix up `next`. */
  function validate(prev, next) {
    if (!next) return null;                              // delete: any block, past or future
    const s = new Date(next.start).getTime(), e = new Date(next.end).getTime();
    if (!(e > s)) return 'A block needs an end after its start.';
    if (!next.allDay) {
      if (e - s < 15 * 60000) return 'Blocks are at least 15 minutes long.';
      const midnight = addDays(startOfDay(new Date(s)), 1).getTime();
      if (e > midnight) next.end = new Date(midnight).toISOString();
    }
    let rederive = !prev;
    if (prev) {
      const ps = new Date(prev.start).getTime(), pe = new Date(prev.end).getTime();
      const timeChanged = ps !== s || pe !== new Date(next.end).getTime() || !!prev.allDay !== !!next.allDay;
      if (timeChanged) {
        next.plannedAt = new Date().toISOString();
        rederive = true;
      }
      if (!lowerEq(prev.taskID, next.taskID) || (!prev.taskID && next.taskID)) rederive = true;
      next.updatedAt = new Date().toISOString();
    }
    if (rederive) derive(next);
    else if (next.kind === 'focus' && !next.allDay) {             // keep the planner's count, clamped (invariant 6)
      const cap = capacity(Math.round((new Date(next.end) - new Date(next.start)) / 60000));
      if ((next.pomodoros || 0) > cap) { next.pomodoros = cap; next.plannedFocusMinutes = cap * pomoSettings().focus; }
    }
    return null;
  }

  /* One Store write + one undo step. mutate(list) edits a cloned list in place (or returns
     false to cancel). Returns the undo step (null when nothing changed or invalid). */
  function commitBlocks(label, mutate, { undoToast = false, silent = false } = {}) {
    const before = Store.blocks().map(clone);
    const list = before.map(clone);
    if (mutate(list) === false) return null;
    const bm = new Map(before.map((b) => [b.id, b]));
    const am = new Map(list.map((b) => [b.id, b]));
    for (const [id, a] of am) {
      const b = bm.get(id) || null;
      if (b && JSON.stringify(b) === JSON.stringify(a)) continue;   // untouched
      const err = validate(b, a);
      if (err) { if (!silent) toast(err); return null; }
    }
    for (const [id, b] of bm) {
      if (!am.has(id)) { const err = validate(b, null); if (err) { if (!silent) toast(err); return null; } }
    }
    const step = diffStep(label, before, list);
    if (!step) return null;
    Store.setBlocks(list);
    invalidate();
    pushUndo(step);
    if (undoToast) undoToastFor(step, label);
    return step;
  }

  function diffStep(label, before, after) {
    const bm = new Map(before.map((b) => [b.id, b]));
    const am = new Map(after.map((b) => [b.id, b]));
    const changes = [];
    for (const [id, b] of bm) {
      const a = am.get(id);
      if (!a) changes.push({ id, from: b, to: null });
      else if (JSON.stringify(a) !== JSON.stringify(b)) changes.push({ id, from: b, to: clone(a) });
    }
    for (const [id, a] of am) if (!bm.has(id)) changes.push({ id, from: null, to: clone(a) });
    if (!changes.length) return null;
    const applyDir = (dir) => {
      const list = Store.blocks().map(clone);
      for (const c of changes) {
        const target = dir === 'undo' ? c.from : c.to;
        const i = list.findIndex((b) => b.id === c.id);
        if (target == null) { if (i >= 0) list.splice(i, 1); } else if (i >= 0) list[i] = clone(target); else list.push(clone(target));
      }
      Store.setBlocks(list);
      invalidate();
    };
    return { label, undo: () => applyDir('undo'), redo: () => applyDir('redo'), changes };
  }

  function undo() {
    const step = v2.undo.pop();
    if (!step) { toast('Nothing to undo'); return false; }
    closePopover();
    try { step.undo(); } catch (err) { console.error('Undo failed', err); }
    v2.redo.push(step);
    toast(step.label ? `Undid ${step.label.charAt(0).toLowerCase()}${step.label.slice(1)}` : 'Undone');
    render();
    return true;
  }

  function redo() {
    const step = v2.redo.pop();
    if (!step) return false;
    closePopover();
    try { (step.redo || (() => {}))(); } catch (err) { console.error('Redo failed', err); }
    v2.undo.push(step);
    render();
    return true;
  }

  /* 8 s toast with an Undo button (SPEC §2.8.1). */
  function undoToastFor(step, label) {
    const stack = document.getElementById('toast-stack');
    if (!stack) return;
    const node = h('div', { class: 'toast cal-undo-toast', role: 'status' },
      h('span', { text: label }),
      h('button', {
        class: 'cal-undo-btn', type: 'button',
        onclick: () => {
          const i = v2.undo.indexOf(step);
          if (i >= 0) {
            v2.undo.splice(i, 1);
            try { step.undo(); } catch (err) { console.error('Undo failed', err); }
            if (i === v2.undo.length) v2.redo.push(step);
            closePopover();
            render();
          }
          leave();
        },
      }, 'Undo'));
    let gone = false;
    const leave = () => { if (gone) return; gone = true; node.classList.add('is-leaving'); setTimeout(() => node.remove(), 320); };
    stack.appendChild(node);
    setTimeout(leave, UNDO_TOAST_MS);
  }

  // ───────────────────────────  view state  ───────────────────────────

  let mode = 'wide';              // 'wide' ≥ 1000 · 'drawer' 700–999 · 'compact' < 700 (card width)
  let sideOpen = false;           // the drawer / bottom sheet (not 'wide')
  const isNarrow = () => mode === 'compact';
  const isVisible = () => !!(root && !root.hidden && root.classList.contains('is-active'));

  function savedView() { const v = prefs().lastView; return VIEWS.some((x) => x.id === v) ? v : 'week'; }

  function currentView() {
    const v = savedView();
    if (isNarrow() && (v === 'week' || v === 'month')) return 'day';
    return v;
  }

  function setView(v) {
    if (isNarrow() && (v === 'week' || v === 'month')) return;
    closePopover();
    if (prefs().lastView !== v) setPrefs({ lastView: v });
    render();
  }

  /* "From today": Week shows today + the next 6 days and Month the next 5 weeks, both starting on
     today's weekday, instead of the calendar week / month. Saved in prefs.fromToday. */
  const fromToday = () => prefs().fromToday === true;
  const ROLL_WEEKS = 5;
  function rollStart() { return startOfDay(anchor); }

  function toggleFromToday() {
    const on = !fromToday();
    anchor = startOfDay(new Date());
    scrollToNow = true;
    closePopover();
    setPrefs({ fromToday: on });
    render();
  }

  function shift(dir) {
    const v = currentView();
    if (v === 'day') anchor = addDays(anchor, dir);
    else if (v === 'week') anchor = addDays(anchor, 7 * dir);
    else if (v === 'month' && fromToday()) anchor = addDays(anchor, ROLL_WEEKS * 7 * dir);
    else if (v === 'month') {
      anchor = new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1);
      const today = new Date();
      if (anchor.getFullYear() === today.getFullYear() && anchor.getMonth() === today.getMonth()) anchor = startOfDay(today);
    } else anchor = addDays(anchor, AGENDA_DAYS * dir);
    closePopover();
    render();
  }

  function goToday() {
    anchor = startOfDay(new Date());
    scrollToNow = true;
    closePopover();
    render();
  }

  function weekDays() {
    const s = fromToday() ? startOfDay(anchor) : startOfWeek(anchor);
    const all = Array.from({ length: 7 }, (_, i) => addDays(s, i));
    if (prefs().showWeekends === false) return all.filter((d) => d.getDay() !== 0 && d.getDay() !== 6);
    return all;
  }

  function inView(d) {
    const v = currentView();
    const day = startOfDay(d);
    if (v === 'day') return sameDay(anchor, day);
    if (v === 'week') return weekDays().some((x) => sameDay(x, day));
    if (v === 'month' && fromToday()) return day >= rollStart() && day < addDays(rollStart(), ROLL_WEEKS * 7);
    if (v === 'month') return anchor.getMonth() === day.getMonth() && anchor.getFullYear() === day.getFullYear();
    return day >= anchor && day < addDays(anchor, AGENDA_DAYS);
  }

  function zoom(dir, centerY) {
    const cur = clamp(Number(prefs().hourHeight) || 56, 40, 112);
    const next = clamp(cur + dir * 8, 40, 112);
    if (next === cur) return;
    const sc = ui.scroll;
    let minuteAtCenter = null;
    if (sc) {
      const y = centerY != null ? centerY - sc.getBoundingClientRect().top : sc.clientHeight / 2;
      const topH = (sc.querySelector('.cal-tg-top') || { offsetHeight: 0 }).offsetHeight;
      minuteAtCenter = (sc.scrollTop + y - topH) / MIN_PX;
      scrollMem = null;
      zoomTarget = { minute: minuteAtCenter, y };
    }
    setPrefs({ hourHeight: next });
  }
  let zoomTarget = null;

  /* Zoomed out (the calendar's own zoom below the default, or the browser zoomed out) the grid
     drops its half-hour lines and keeps only the hours, so a dense grid doesn't look gritty. */
  function applyGridDensity() {
    if (!root) return;
    let pageZoom = 1;
    try { if (window.outerWidth && window.innerWidth) pageZoom = Math.min(1, window.outerWidth / window.innerWidth); } catch (_) {}
    root.classList.toggle('is-hourly', HOUR_PX * pageZoom < 54);
  }

  // ───────────────────────────  shell  ───────────────────────────
  //  .cal-wrap (one glass card; container `cal`)
  //    header.cal-header 52: [☰] ‹ Today › · range title · [Day|Week|Month|Agenda] · flex · [✦ Plan ▾] (planSlot) · [＋]
  //    .cal-body: aside.cal-side 256 (inline ≥ 1000 · drawer 700–999 · bottom sheet < 700) + .cal-stage (grid + preview bar)

  function buildShell() {
    root.textContent = '';
    ui.menuBtn = h('button', { class: 'icon-btn cal-hbtn cal-menu-btn', type: 'button', 'aria-label': 'Show the month and calendars panel', title: 'Month, calendars and tasks panel (S)',
      'aria-expanded': 'false', 'aria-keyshortcuts': 'S', onclick: () => toggleSide() }, icon('sidebar'));
    ui.prev = h('button', { class: 'icon-btn cal-hbtn', type: 'button', 'aria-label': 'Previous period', title: 'Previous period (P or ←)',
      'aria-keyshortcuts': 'P ArrowLeft', onclick: () => shift(-1) }, icon('chevL'));
    ui.next = h('button', { class: 'icon-btn cal-hbtn', type: 'button', 'aria-label': 'Next period', title: 'Next period (N or →)',
      'aria-keyshortcuts': 'N ArrowRight', onclick: () => shift(1) }, icon('chevR'));
    ui.today = h('button', { class: 'btn btn-sm cal-today', type: 'button', title: 'Today (T)', 'aria-keyshortcuts': 'T', onclick: goToday }, 'Today');
    ui.fromToday = h('button', { class: 'cal-from-today', type: 'button', 'aria-pressed': 'false', onclick: () => toggleFromToday() },
      icon('refresh', 'cal-from-ic'), h('span', { text: 'From today' }));
    ui.title = h('h1', { class: 'cal-title', 'aria-live': 'polite' });
    ui.sub = h('span', { class: 'cal-sub' });
    ui.seg = h('div', { class: 'segmented cal-seg', role: 'tablist', 'aria-label': 'Calendar view' },
      VIEWS.map((v) => h('button', {
        class: 'seg-btn', type: 'button', role: 'tab', dataset: { v: v.id }, title: `${v.label} (${String(v.key).toUpperCase()})`,
        'aria-keyshortcuts': String(v.key).toUpperCase(),
        onclick: () => setView(v.id),
      }, v.label)));
    ui.newBtn = h('button', { class: 'btn btn-sm cal-new', type: 'button', 'aria-label': 'New block', title: 'New block (B) — or click or drag on the calendar',
      'aria-keyshortcuts': 'B', onclick: () => newEventNow() }, icon('plus'), h('span', { class: 'cal-new-label', text: 'New' }));
    ui.header = h('header', { class: 'cal-header' },
      ui.menuBtn,
      h('div', { class: 'cal-nav' }, ui.prev, ui.today, ui.next),
      h('div', { class: 'cal-titles' }, ui.title, ui.sub),
      ui.fromToday,
      h('div', { class: 'cal-spacer' }),
      ui.seg,
      h('div', { class: 'cal-actions' }, planSlot(), ui.newBtn));

    ui.side = h('aside', { class: 'cal-side', 'aria-label': 'Calendars' });
    ui.side.addEventListener('pointerdown', onTrayPointerDown);
    ui.side.addEventListener('keydown', onSideKey);
    ui.main = h('section', { class: 'cal-main', 'aria-label': 'Calendar' });
    ui.main.addEventListener('dragover', onMainDragOver);
    ui.main.addEventListener('dragleave', onMainDragLeave);
    ui.main.addEventListener('drop', onMainDrop);
    ui.stage = h('div', { class: 'cal-stage' }, ui.main, previewRoot());
    ui.scrim = h('div', { class: 'cal-scrim', 'aria-hidden': 'true', onclick: () => setSideOpen(false) });
    ui.body = h('div', { class: 'cal-body' }, ui.side, ui.stage, ui.scrim);
    ui.file = h('input', { type: 'file', accept: '.ics,.ical,.icalendar,text/calendar', multiple: true, hidden: true, class: 'cal-file', 'aria-hidden': 'true', tabindex: '-1' });
    ui.file.addEventListener('change', () => {
      const files = Array.from(ui.file.files || []);
      ui.file.value = '';
      if (files.length) importFiles(files);
    });
    ui.wrap = h('div', { class: 'cal-wrap glass' }, ui.header, ui.body, ui.file);
    root.appendChild(ui.wrap);
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => {
        const m = computeMode();
        if (m !== mode) { mode = m; sideOpen = false; applyMode(); if (isVisible() && !drag) { closePopover(); render(); } }
      }).observe(root);
    }
  }

  function computeMode() {
    const w = (ui.wrap && ui.wrap.clientWidth) || (root && root.clientWidth) || window.innerWidth;
    return w >= 1000 ? 'wide' : w >= 700 ? 'drawer' : 'compact';
  }

  function sideShown() { return mode === 'wide' ? prefs().showPlanPanel !== false : sideOpen; }

  function applyMode() {
    if (!ui.wrap) return;
    ui.wrap.dataset.mode = mode;
    const shown = sideShown();
    ui.body.classList.toggle('side-open', shown);
    ui.body.classList.toggle('side-hidden', !shown);
    ui.menuBtn.setAttribute('aria-expanded', String(shown));
    ui.menuBtn.setAttribute('aria-label', shown ? 'Hide the month and calendars panel' : 'Show the month and calendars panel');
    ui.side.inert = !shown;
  }

  function setSideOpen(open) {
    if (mode === 'wide') { if ((prefs().showPlanPanel !== false) !== open) setPrefs({ showPlanPanel: open }); }
    else sideOpen = open;
    applyMode();
    if (mode === 'wide') scheduleRender();          // the grid width changes
    else if (open) { const f = ui.side.querySelector('button, [tabindex="0"]'); if (f) f.focus({ preventScroll: true }); }
  }
  function toggleSide() { setSideOpen(!sideShown()); }

  function fitHeight() {
    if (!ui.wrap) return;
    const top = ui.wrap.getBoundingClientRect().top + window.scrollY;
    const pb = parseFloat(getComputedStyle(root).paddingBottom);
    const padB = Number.isFinite(pb) ? pb : 22;     // 0 when the calendar fills the page
    const minH = mode === 'compact' ? 460 : 560;
    ui.wrap.style.height = `${Math.max(minH, window.innerHeight - top - padB)}px`;
  }

  // ───────────────────────────  render  ───────────────────────────

  function render() {
    if (!root || !ui.wrap) return;
    if (!isVisible() || drag) return;
    const m = computeMode();
    if (m !== mode) { mode = m; sideOpen = false; }
    applyMode();
    if (Date.now() - lastOpenRefresh > 60000) {           // opening the Calendar refreshes due feeds (v2-calendar §4.5)
      lastOpenRefresh = Date.now();
      try { if (typeof Feeds !== 'undefined' && Feeds.refresh) Feeds.refresh(); } catch (_) { /* offline */ }
    }
    invalidate();
    HOUR_PX = clamp(Number(prefs().hourHeight) || 56, 40, 112);
    MIN_PX = HOUR_PX / 60;
    root.style.setProperty('--cal-hour', `${HOUR_PX}px`);
    applyGridDensity();
    const v = currentView();
    const narrow = isNarrow();

    ui.seg.querySelectorAll('.seg-btn').forEach((b) => {
      const active = b.dataset.v === v;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-selected', String(active));
      b.hidden = narrow && (b.dataset.v === 'week' || b.dataset.v === 'month');
    });
    renderTitle(v);
    const roll = fromToday();
    ui.fromToday.hidden = v !== 'week' && v !== 'month';
    ui.fromToday.setAttribute('aria-pressed', String(roll));
    ui.fromToday.classList.toggle('is-on', roll);
    ui.fromToday.title = roll
      ? `On: ${v === 'month' ? 'the next five weeks' : 'the next seven days'}, starting today. Click for whole ${v === 'month' ? 'months' : 'weeks'}`
      : `Start the ${v === 'month' ? 'month' : 'week'} view at today instead of ${v === 'month' ? 'the 1st' : 'Sunday or Monday'}`;

    const sc = ui.main.querySelector('.cal-scroll');
    if (sc) scrollMem = sc.scrollTop;
    ui.main.dataset.view = v;
    ui.main.textContent = '';
    ui.grid = null;
    ui.scroll = null;
    fitHeight();

    if (v === 'day') renderTimeGrid([anchor]);
    else if (v === 'week') renderTimeGrid(weekDays());
    else if (v === 'month') renderMonth();
    else renderAgenda();

    renderSide();

    if (pop && pop.id) {
      if (!findEvent(pop.id) && !String(pop.id).startsWith('due:')) closePopover();
      else markActive(pop.id);
    }
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    const run = () => { if (!renderQueued) return; renderQueued = false; if (isVisible() && !pop && !drag) render(); };
    requestAnimationFrame(run);
    setTimeout(run, 120);                 // rAF is paused in background tabs and offscreen views
  }

  function renderTitle(v) {
    const today = startOfDay(new Date());
    let title = '', sub = '';
    const withYear = (d) => (d.getFullYear() !== today.getFullYear());
    if (v === 'day') {
      title = isNarrow() ? F.medium.format(anchor) : F.full.format(anchor) + (withYear(anchor) ? `, ${anchor.getFullYear()}` : '');
      sub = sameDay(anchor, today) ? 'Today' : relDay(anchor);
    } else if (v === 'week') {
      const days = weekDays();
      title = rangeLabel(days[0], days[days.length - 1]);
    } else if (v === 'month' && fromToday()) {
      title = rangeLabel(rollStart(), addDays(rollStart(), ROLL_WEEKS * 7 - 1));
    } else if (v === 'month') {
      title = F.monthYear.format(anchor);
    } else {
      title = rangeLabel(anchor, addDays(anchor, AGENDA_DAYS - 1));
    }
    ui.title.textContent = title;
    ui.sub.textContent = sub;
    ui.sub.hidden = !sub || isNarrow();
  }

  // "Oct 18 – 24, 2026" (one month) · "Oct 28 – Nov 3, 2026" · "Dec 28, 2026 – Jan 3, 2027"
  function rangeLabel(a, b) {
    try { if (F.mdy.formatRange) return F.mdy.formatRange(a, b); } catch (_) { /* fall through */ }
    return `${F.md.format(a)} – ${F.md.format(b)}, ${b.getFullYear()}`;
  }

  function relDay(d) {
    const n = dayIndex(new Date(), d);
    if (n === 1) return 'Tomorrow';
    if (n === -1) return 'Yesterday';
    return n > 0 ? `In ${n} days` : `${-n} days ago`;
  }

  // ── due chips (assignments + dated tasks) ──

  function dueItems(from, to) {
    const out = [];
    const fromK = dayKey(from), toK = dayKey(addDays(to, -1));
    const fm = feedMap();
    const linked = new Map();
    for (const t of Store.tasks()) {
      if (typeof Assignments !== 'undefined' && Assignments.isAssignmentTask(t)) linked.set(String(t.externalID).toLowerCase(), t);
    }
    const shownAssign = new Set();
    // assignments that only exist in calendars you've unchecked: their tasks leave the calendar too
    const hiddenAssign = new Set();
    if (typeof Assignments !== 'undefined') {
      const vis = new Set(), all = new Set();
      for (const a of Assignments.list({ includeDismissed: true })) {
        const id = String(a.id).toLowerCase(), f = fm.get(a.feedID);
        all.add(id);
        if (!f || f.isVisible !== false) vis.add(id);
      }
      for (const id of all) if (!vis.has(id)) hiddenAssign.add(id);
    }
    if (typeof Assignments !== 'undefined') {
      for (const a of Assignments.list({ from: fromK, to: toK })) {
        const f = fm.get(a.feedID);
        if (f && f.isVisible === false) continue;
        const task = linked.get(String(a.id).toLowerCase()) || null;
        shownAssign.add(String(a.id).toLowerCase());
        out.push({ kind: 'due', id: 'due:' + a.id, day: a.dueDay, minutes: a.dueMinutes, title: a.title, course: a.course,
          color: feedColor(f) || 'var(--text-secondary)', assignment: a, task, done: task ? !!task.isDone : isAssignmentDone(a) });
      }
    }
    if (prefs().showDueTasks !== false) {
      for (const t of Store.tasks()) {
        if (!t.dueDate || t.dueDate < fromK || t.dueDate > toK) continue;
        if (t.externalID && shownAssign.has(String(t.externalID).toLowerCase())) continue;
        if (t.externalID && hiddenAssign.has(String(t.externalID).toLowerCase())) continue;
        if (t.externalSource === 'calendar') continue;    // a "PUREFOCUS:" event: the event itself is on the calendar
        out.push({ kind: 'due', id: 'due:task:' + t.id, day: t.dueDate, minutes: null, title: t.title, course: t.course || null,
          color: t.category ? catColor(t.category) : 'var(--text-secondary)', assignment: null, task: t, done: !!t.isDone });
      }
    }
    out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0) || ((a.minutes ?? 1440) - (b.minutes ?? 1440)) || (a.title < b.title ? -1 : 1));
    return out;
  }

  function findDue(id) {
    const s = String(id || '');
    if (!s.startsWith('due:')) return null;
    const anyDay = dueItems(addDays(new Date(), -400), addDays(new Date(), 400));
    return anyDay.find((d) => d.id === s) || null;
  }

  function dueChip(d, extraCls) {
    const label = d.minutes != null ? dueClock(d.minutes) : 'Due';
    const open = (ev) => { ev.stopPropagation(); openPopover(d.id, ev.currentTarget); };
    const check = dueCheck(d, 'cal-due-check');
    return h('div', {
      class: 'cal-due' + (d.done ? ' is-done' : '') + (check ? ' has-check' : '') + (extraCls ? ' ' + extraCls : ''), role: 'button', tabindex: '0',
      dataset: { id: d.id }, vars: { '--ev': d.color },
      title: `${d.title}${d.course ? ' · ' + d.course : ''} · due ${d.minutes != null ? dueClock(d.minutes) : 'today'}`,
      'aria-label': `${d.title}, due ${F.medium.format(parseDayKey(d.day))}${d.minutes != null ? ' ' + F.time.format(dateAt(parseDayKey(d.day), d.minutes)) : ''}${d.done ? ', done' : ''}`,
      onclick: open,
      onkeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(ev); } },
    },
    check || h('span', { class: 'cal-due-mark' }, d.done ? icon('check') : null),
    h('span', { class: 'cal-due-time', text: label }),
    h('span', { class: 'cal-due-name', text: d.title }));
  }

  /* A due date with a time, in the time grid: the due chip, laid out like a short block. */
  const DUE_MIN = 24;
  function dueGridEl(s, colW) {
    const el = dueChip(s.e, 'cal-due--grid');
    const reserve = s.reserve || 0, ind = (s.indent || 0) * 12;
    el.style.top = `${s.a * MIN_PX}px`;
    el.style.height = `${Math.max(18, DUE_MIN * MIN_PX - 2)}px`;
    const lf = s.lf != null ? s.lf : s.col / s.ncols, wf = s.wf != null ? s.wf : s.span / s.ncols;
    const tf = s.tf != null ? s.tf : wf;
    el.style.left = `calc((100% - ${reserve}px) * ${lf} + ${2 + ind}px)`;
    el.style.width = `calc((100% - ${reserve}px) * ${wf} - ${5 + ind}px)`;
    if (s.z) el.style.zIndex = String(s.z);
    if ((colW - reserve) * tf < 90) el.classList.add('is-slim');
    if (tf < wf - 0.001) el.style.paddingRight = `${Math.round((colW - reserve) * (wf - tf)) + 6}px`;   // text stops where the covering block starts
    return el;
  }

  // ── time grid (day / week) ──

  function renderTimeGrid(days) {
    const n = days.length;
    const now = new Date();
    const today = startOfDay(now);
    const from = days[0], to = addDays(days[n - 1], 1);
    const cols = `var(--cal-gutter) repeat(${n}, minmax(0, 1fr))`;

    const head = h('div', { class: 'cal-tg-head' });
    head.style.gridTemplateColumns = cols;
    head.appendChild(h('div', { class: 'cal-tz', text: tzLabel() }));
    for (const d of days) {
      const cls = 'cal-dayhead' + (sameDay(d, today) ? ' is-today' : '') + (d < today ? ' is-past' : '');
      head.appendChild(h('button', {
        class: cls, type: 'button', title: n > 1 ? `Open ${F.full.format(d)}` : F.full.format(d),
        onclick: () => { if (n > 1) { anchor = d; setView('day'); } },
      }, h('span', { class: 'cal-dow', text: F.dow.format(d) }), h('span', { class: 'cal-dnum', text: String(d.getDate()) })));
    }

    const top = h('div', { class: 'cal-tg-top' }, head, buildAllDay(days, cols));

    const grid = h('div', { class: 'cal-tg-grid' });
    grid.style.gridTemplateColumns = cols;
    grid.style.height = `${24 * HOUR_PX}px`;
    const gutter = h('div', { class: 'cal-hours', 'aria-hidden': 'true' });
    for (let hr = 1; hr < 24; hr++) {
      const lbl = h('span', { class: 'cal-hour', text: F.hour.format(new Date(2000, 0, 1, hr)) });
      lbl.style.top = `${hr * HOUR_PX}px`;
      gutter.appendChild(lbl);
    }
    grid.appendChild(gutter);

    const timed = items().filter((e) => !isAllDayish(e) && overlaps(e, from, to));
    const gutterW = parseFloat(getComputedStyle(root).getPropertyValue('--cal-gutter')) || 58;
    const colW = Math.max(60, ((ui.main.clientWidth || 900) - gutterW) / n);
    const marks = currentAndNext(now);
    // due items with a time (a Canvas assignment due 11:59 PM…) sit in the grid at that time;
    // only date-only ones go to the all-day row
    const timedDues = dueItems(from, to).filter((x) => x.minutes != null);
    days.forEach((d) => {
      const col = h('div', {
        class: 'cal-col' + (sameDay(d, today) ? ' is-today' : '') + (d < today ? ' is-past' : ''),
        dataset: { day: dayKey(d) },
      });
      const segs = segmentsFor(timed, d);
      const k = dayKey(d);
      for (const x of timedDues) {
        if (x.day !== k) continue;
        const a = Math.max(0, Math.min(x.minutes, 1440 - DUE_MIN));   // a 11:59 PM due date still fits above midnight
        segs.push({ e: x, day: d, a, b: a + DUE_MIN, due: true });
      }
      segs.sort((x, y) => x.a - y.a || (y.b - y.a) - (x.b - x.a));
      const strips = layout(segs, colW);
      for (const s of segs) if (!s.hidden) col.appendChild(s.due ? dueGridEl(s, colW) : blockEl(s, now, colW, marks));
      for (const g of strips) col.appendChild(moreStripEl(g, d));
      grid.appendChild(col);
    });

    if (now >= from && now < to) {
      const y = `${minuteOfDay(now) * MIN_PX}px`;
      const line = h('div', { class: 'cal-now', 'aria-hidden': 'true' });
      line.style.top = y;
      grid.appendChild(line);
      gutter.querySelectorAll('.cal-hour').forEach((lb) => { lb.classList.toggle('is-near-now', Math.abs(parseFloat(lb.style.top) - minuteOfDay(now) * MIN_PX) < 14); });
      const tag = h('span', { class: 'cal-now-time', text: nowLabel(now), title: `Now · ${F.time.format(now)}` });
      tag.style.top = y;
      gutter.appendChild(tag);
      const col = grid.querySelector('.cal-col.is-today');
      if (col) {
        const bar = h('div', { class: 'cal-now-bar', 'aria-hidden': 'true' });
        bar.style.top = y;
        col.appendChild(bar);
      }
    }

    grid.addEventListener('pointerdown', onGridPointerDown);
    grid.addEventListener('keydown', onBlockKey);

    const scroll = h('div', { class: 'cal-scroll' }, top, grid);
    scroll.addEventListener('scroll', () => { if (pop) positionPop(); }, { passive: true });
    scroll.addEventListener('wheel', (ev) => {
      if (!ev.ctrlKey) return;                         // trackpad pinch arrives as ctrl+wheel
      ev.preventDefault();
      zoom(ev.deltaY < 0 ? 1 : -1, ev.clientY);
    }, { passive: false });
    ui.main.appendChild(h('div', { class: 'cal-tg' + (n === 1 ? ' is-day' : '') }, scroll));
    ui.grid = grid;
    ui.scroll = scroll;

    if (zoomTarget) {
      const topH = top.offsetHeight;
      scroll.scrollTop = Math.max(0, zoomTarget.minute * MIN_PX + topH - zoomTarget.y);
      zoomTarget = null;
    } else if (scrollToNow) {
      scrollToNow = false;
      const target = (now >= from && now < to) ? minuteOfDay(now) * MIN_PX - scroll.clientHeight * 0.3 : 7.75 * HOUR_PX;
      scroll.scrollTop = Math.max(0, target);
    } else if (scrollMem == null) {
      scroll.scrollTop = 7.75 * HOUR_PX;
    } else {
      scroll.scrollTop = scrollMem;
    }
    scrollMem = scroll.scrollTop;
  }

  function buildAllDay(days, cols) {
    const n = days.length;
    const from = days[0], to = addDays(days[n - 1], 1);
    const dayIdx = (d) => days.findIndex((x) => sameDay(x, d));
    const segs = items().filter((e) => isAllDayish(e) && overlaps(e, from, to)).map((e) => {
      const [s, en] = e.allDay ? allDayRange(e) : [startOfDay(new Date(e.start)), addDays(startOfDay(new Date(new Date(e.end) - 1)), 1)];
      let a = Math.max(0, dayIndex(from, s)), b = Math.min(n, dayIndex(from, en));
      if (n < 7 || days.length !== dayIndex(from, to)) {   // weekends hidden: map onto shown columns
        const ai = days.findIndex((x) => x >= startOfDay(s > from ? s : from));
        let bi = days.length;
        for (let i = days.length - 1; i >= 0; i--) if (days[i] < en) { bi = i + 1; break; }
        a = Math.max(0, ai); b = Math.min(n, bi);
      }
      return { e, a, b, contL: s < from, contR: en > to };
    }).filter((s) => s.b > s.a);
    for (const d of dueItems(from, to)) {
      if (d.minutes != null) continue;          // timed due dates are drawn in the grid at their time
      const i = dayIdx(parseDayKey(d.day));
      if (i >= 0) segs.push({ e: d, a: i, b: i + 1, due: true });
    }
    // Due dates (Canvas assignments, tasks) take the top lanes, so a stack of all-day events
    // from other calendars can never fold them into "+N more"; then longer spans first.
    segs.sort((x, y) => (x.due ? 0 : 1) - (y.due ? 0 : 1) || x.a - y.a || (y.b - y.a) - (x.b - x.a));
    const lanes = [];                    // lanes[l][day] = taken
    for (const s of segs) {
      let l = lanes.findIndex((row) => { for (let i = s.a; i < s.b; i++) if (row[i]) return false; return true; });
      if (l === -1) { l = lanes.length; lanes.push(new Array(n).fill(false)); }
      for (let i = s.a; i < s.b; i++) lanes[l][i] = true;
      s.lane = l;
    }
    const MAX = 3;
    const total = lanes.length;
    const collapse = !allDayExpanded && total > MAX;
    const shown = collapse ? MAX - 1 : total;
    const rows = Math.max(1, collapse ? MAX : total);

    const wrap = h('div', { class: 'cal-tg-allday' });
    wrap.style.gridTemplateColumns = cols;
    wrap.style.gridTemplateRows = `repeat(${rows}, 22px)`;
    const label = h('div', { class: 'cal-allday-label' }, h('span', { text: 'all-day' }));
    label.style.gridColumn = '1';
    label.style.gridRow = '1 / -1';
    if (total > MAX) {
      label.appendChild(h('button', {
        class: 'cal-allday-toggle', type: 'button', 'aria-label': allDayExpanded ? 'Show fewer all-day items' : 'Show all all-day items',
        onclick: () => { allDayExpanded = !allDayExpanded; render(); },
      }, icon(allDayExpanded ? 'chevD' : 'chevR')));
    }
    wrap.appendChild(label);
    const today = startOfDay(new Date());
    days.forEach((d, i) => {
      const cell = h('div', { class: 'cal-allday-cell', dataset: { day: dayKey(d) }, title: 'Double-click to add an all-day block' });
      cell.style.gridColumn = String(i + 2);
      cell.style.gridRow = '1 / -1';
      cell.addEventListener('dblclick', () => createAndEdit({ start: d, end: addDays(d, 1), allDay: true }));
      wrap.appendChild(cell);
    });
    const hidden = new Array(n).fill(0);
    for (const s of segs) {
      if (s.lane >= shown) { for (let i = s.a; i < s.b; i++) hidden[i]++; continue; }
      let pill;
      if (s.due) {
        pill = dueChip(s.e, 'cal-due--lane');
      } else {
        const e = s.e;
        const t = e.source === 'local' ? taskById(e.taskID) : null;
        pill = h('button', {
          class: 'cal-adpill' + (e.readOnly ? ' is-readonly' : '') + (s.contL ? ' cont-l' : '') + (s.contR ? ' cont-r' : '') + (e.isBusy === false ? ' is-free' : '')
            + (t ? ' has-check' : '') + (t && t.isDone ? ' is-done' : ''),
          type: 'button', dataset: { id: e.id }, vars: { '--ev': colorOf(e) }, title: titleOf(e),
          onclick: (ev) => openPopover(e.id, ev.currentTarget),
        }, t ? taskCheck(t, e.id, 'cal-adcheck') : null, srcIcon(e), h('span', { class: 'cal-adpill-name', text: titleOf(e) }));
      }
      pill.style.gridColumn = `${s.a + 2} / ${s.b + 2}`;
      pill.style.gridRow = String(s.lane + 1);
      wrap.appendChild(pill);
    }
    if (collapse) {
      hidden.forEach((count, i) => {
        if (!count) return;
        const more = h('button', {
          class: 'cal-admore', type: 'button',
          onclick: () => { allDayExpanded = true; render(); },
        }, `+${count} more`);
        more.style.gridColumn = String(i + 2);
        more.style.gridRow = String(MAX);
        wrap.appendChild(more);
      });
    }
    return wrap;
  }

  function segmentsFor(list, day) {
    const next = addDays(day, 1);
    const out = [];
    for (const e of list) {
      if (!overlaps(e, day, next)) continue;
      const s = new Date(e.start), en = new Date(e.end);
      const a = s < day ? 0 : minuteOfDay(s);
      let b = en >= next ? 1440 : minuteOfDay(en);
      if (b <= a) b = Math.min(1440, a + SNAP);
      out.push({ e, day, a, b, contTop: s < day, contBottom: en > next });
    }
    out.sort((x, y) => x.a - y.a || (y.b - y.a) - (x.b - x.a));
    return out;
  }

  // Overlapping blocks are laid out like Google Calendar, always at their real times: each
  // column's block starts at its column and reaches ~1.7 columns wide, sliding under the next
  // column's block, which lies on top with a cut-out edge; the right-most block runs to the
  // edge. Titles are fitted to the part of the card that stays visible. A block that starts a
  // title line or more after another nests inside it, slightly indented. Only when the columns
  // would get too narrow to read (5+ at once in a week column) does the group keep as many
  // columns as fit and fold the rest into a slim "+N" strip that lists everything at that time.
  // Sets s.lf / s.wf / s.tf (left, width, visible-text width as fractions of the column) and
  // returns the strips: [{ a, b, hidden: [seg], all: [seg] }].
  function layout(segs, colW) {
    const MIN_VIS = 23;
    const titleMin = Math.ceil(25 / MIN_PX);   // one title line incl. padding
    const TAIL = 15;
    const width = colW || 200;
    const MORE_W = width < 110 ? 18 : 24;     // the "+N" strip, incl. its gap
    for (const s of segs) { s.vt = s.a; s.vb = Math.max(s.b, s.a + MIN_VIS); s.indent = 0; s.z = 0; s.hidden = false; s.reserve = 0; }

    const columns = (cluster) => {
      const cols = [];
      for (const s of cluster) {
        let c = cols.findIndex((list) => list.every((o) => o.vb <= s.a));
        if (c === -1) {
          c = cols.findIndex((list) => { const run = list.filter((o) => o.vb > s.a); return run.every((o) => s.a - o.a >= titleMin && o.b - s.a >= 0); });
          if (c >= 0) s.indent = Math.min(3, Math.max(...cols[c].filter((o) => o.vb > s.a).map((o) => o.indent)) + 1);
        }
        if (c === -1) { c = cols.length; cols.push([]); }
        cols[c].push(s);
        s.col = c;
      }
      const n = cols.length;
      cluster.forEach((s, i) => {
        s.ncols = n;
        s.span = 1;
        let over = false;
        for (let c = s.col + 1; c < n; c++) {
          const hits = cluster.filter((o) => o !== s && o.col === c && o.a < s.vb && o.vb > s.a);
          // a block may lie over the tail of an earlier block whose title it leaves visible
          if (hits.some((o) => !(s.a - o.a >= titleMin && o.vb - s.a <= TAIL))) break;
          if (hits.length) over = true;
          s.span++;
        }
        s.span0 = s.span;
        if (s.indent || over) s.z = 3 + Math.min(i, 6);
      });
    };
    const SPREAD = 1.7;                       // a covered block reaches this many columns wide
    const TEXT_ROWS = Math.ceil(40 / MIN_PX);  // the title + time lines, in minutes
    const place = (cluster) => {
      const n = cluster[0].ncols;
      // the first column gets a little more room: its block's title is the one a later block covers
      const w = (c) => (c === 0 && n > 1 ? 1.5 : 1);
      let total = 0; const at = [];
      for (let c = 0; c < n; c++) { at.push(total); total += w(c); }
      for (const s of cluster) {
        if (s.hidden) continue;
        s.lf = at[s.col] / total;
        let share = 0;
        for (let c = s.col; c < Math.min(n, s.col + s.span); c++) share += w(c);
        s.wf = n === 1 || s.col + s.span >= n ? 1 - s.lf : Math.min(1 - s.lf, (share / total) * SPREAD);
      }
      for (const s of cluster) {
        if (s.hidden) continue;
        // later columns lie on top; the text stops where one of them covers the title lines
        if (n > 1) s.z = Math.max(s.z, 3 + Math.min(8, s.col * 2 + (s.indent ? 1 : 0)));
        const over = cluster.filter((o) => o !== s && !o.hidden && o.col > s.col && o.lf < s.lf + s.wf && o.vb > s.vt && o.vt < s.vt + TEXT_ROWS);
        s.tf = over.length ? Math.max(0.05, Math.min(...over.map((o) => o.lf)) - s.lf) : s.wf;
        s.coverEnd = over.length ? Math.max(...over.map((o) => o.vb)) : null;   // minutes
      }
    };
    // every block keeps at least a short word's room for its title
    const readable = (cluster) => cluster.every((s) => s.hidden || (width - s.reserve) * s.tf - 5 - s.indent * 12 >= 40);
    // keep the first k columns (as many as stay readable, at least one); fold the rest
    const collapse = (cluster) => {
      const n = cluster[0].ncols;
      for (let k = n - 1; k >= 1; k--) {
        for (const s of cluster) { s.hidden = s.col >= k; s.ncols = k; s.span = Math.min(s.span0, Math.max(1, k - s.col)); s.reserve = MORE_W; }
        place(cluster);
        if (readable(cluster)) break;
      }
    };

    const strips = [];
    let i = 0;
    while (i < segs.length) {
      let j = i + 1, end = segs[i].vb;
      while (j < segs.length && segs[j].a < end) { end = Math.max(end, segs[j].vb); j++; }
      const cluster = segs.slice(i, j);
      columns(cluster);
      place(cluster);
      if (cluster.length > 1 && !readable(cluster)) collapse(cluster);
      // folded blocks that overlap each other share one strip
      const hidden = cluster.filter((s) => s.hidden).sort((x, y) => x.a - y.a);
      for (const s of hidden) {
        const last = strips[strips.length - 1];
        if (last && last.cluster === cluster && s.a < last.b) { last.hidden.push(s); last.b = Math.max(last.b, s.vb); }
        else strips.push({ cluster, a: s.a, b: s.vb, hidden: [s] });
      }
      // a block that a later one covers soon after it starts shows just its title line
      for (const s of cluster) {
        if (s.hidden) continue;
        const over = cluster.filter((o) => o !== s && !o.hidden && o.z > s.z && o.vt > s.vt && o.vt < s.vb && o.lf <= s.lf + 0.001 && o.lf + o.wf > s.lf);
        s.coverAt = over.length ? Math.min(...over.map((o) => o.vt)) : null;
      }
      i = j;
    }
    // each strip lists every block at its time, shown or folded, in start order
    for (const g of strips) {
      g.all = g.cluster.filter((s) => s.a < g.b && s.vb > g.a).sort((x, y) => x.a - y.a || (y.b - y.a) - (x.b - x.a));
      g.width = MORE_W;
      delete g.cluster;
    }
    return strips;
  }

  /* The "+N" strip beside a crowded group: shows how many more blocks share that time
     and opens the list of all of them. */
  function moreStripEl(g, day) {
    const n = g.hidden.length;
    const names = g.hidden.map((s) => titleOf(s.e));
    const el = h('button', {
      class: 'cal-ev-more', type: 'button',
      dataset: { ids: g.hidden.map((s) => s.e.id).join(' ') },
      'aria-label': `${n} more at this time: ${names.join(', ')}. Show all ${g.all.length}`,
      title: `${n} more: ${names.join(', ')}`,
      onclick: (ev) => { ev.stopPropagation(); openStack(g, day, ev.currentTarget); },
    }, h('span', { class: 'cal-ev-more-n', text: `+${n}` }),
    // one dot per folded block, in its colour, so the strip hints at what's behind it
    h('span', { class: 'cal-ev-more-dots', 'aria-hidden': 'true' },
      g.hidden.slice(0, 5).map((x) => h('span', { class: 'cal-ev-more-dot', vars: { '--ev': x.due ? x.e.color : colorOf(x.e) } }))));
    el.style.top = `${g.a * MIN_PX}px`;
    el.style.height = `${Math.max(22, (g.b - g.a) * MIN_PX - 2)}px`;
    el.style.width = `${g.width - 4}px`;
    return el;
  }

  /* The list of every block at one crowded time: tick tasks, open any one to edit it. */
  function openStack(g, day, anchorEl) {
    closeMenu();
    if (pop) { const prev = pop; pop = null; prev.el.remove(); markActive(null); finalizeClosed(prev, false); }
    const from = dateAt(day, Math.min(...g.all.map((s) => (s.due ? s.e.minutes : s.a)))), to = dateAt(day, Math.max(...g.all.map((s) => (s.due ? Math.min(1440, s.e.minutes + 1) : s.b))));
    const rows = g.all.map((s) => {
      if (s.due) {
        const d = s.e;
        return h('button', {
          class: 'cal-stack-row' + (d.done ? ' is-done' : ''), type: 'button', dataset: { id: d.id }, vars: { '--ev': d.color },
          onclick: (ev) => { ev.stopPropagation(); openPopover(d.id, anchorEl); },
        },
        d.task ? taskCheck(d.task, null, 'cal-stack-check') : h('span', { class: 'cal-stack-bar is-due', 'aria-hidden': 'true' }),
        h('span', { class: 'cal-stack-text' },
          h('span', { class: 'cal-stack-title', text: d.title }),
          h('span', { class: 'cal-stack-meta', text: `Due ${F.time.format(dateAt(day, d.minutes))}${d.course ? ` · ${d.course}` : ''}` })),
        icon('chevR'));
      }
      const e = s.e;
      const t = e.source === 'local' ? taskById(e.taskID) : null;
      const course = courseOf(e);
      const start = new Date(e.start), end = new Date(e.end);
      const meta = timeRange(start, end) + (course ? ` · ${courseLabel(course)}` : '') + (e.readOnly ? ` · ${calNameOf(e)}` : '');
      return h('button', {
        class: 'cal-stack-row' + (t && t.isDone ? ' is-done' : '') + (e.readOnly ? ' is-readonly' : ''),
        type: 'button', dataset: { id: e.id }, vars: { '--ev': colorOf(e) },
        onclick: (ev) => { ev.stopPropagation(); openPopover(e.id, anchorEl); },
      },
      t ? taskCheck(t, e.id, 'cal-stack-check') : h('span', { class: 'cal-stack-bar', 'aria-hidden': 'true' }),
      h('span', { class: 'cal-stack-text' },
        h('span', { class: 'cal-stack-title', text: titleOf(e) }),
        h('span', { class: 'cal-stack-meta', text: meta })),
      icon('chevR'));
    });
    const el = h('div', { class: 'cal-pop cal-stack', role: 'dialog', 'aria-label': `${g.all.length} events at this time` },
      h('div', { class: 'cal-stack-head' },
        h('div', { class: 'cal-stack-h' },
          h('h3', { class: 'cal-pop-heading', text: `${g.all.length} events at this time` }),
          h('span', { class: 'cal-stack-sub', text: `${F.medium.format(day)} · ${timeRange(from, to)}` })),
        h('button', { class: 'icon-btn small cal-pop-close', type: 'button', 'aria-label': 'Close', onclick: () => closePopover() }, icon('x'))),
      h('div', { class: 'cal-stack-list' }, rows),
      currentView() === 'day' ? null : h('div', { class: 'cal-stack-foot' },
        h('button', { class: 'cal-link', type: 'button', onclick: () => { anchor = startOfDay(day); setView('day'); } }, 'See them side by side in Day view')));
    pop = { el, id: null, isNew: false, anchor: anchorEl, session: null };
    document.body.appendChild(el);
    positionPop();
    const first = el.querySelector('.cal-stack-row');
    if (first) first.focus({ preventScroll: true });
  }

  /* Fits a title into `lines` lines of `w` px, breaking only between words; what
     doesn't fit ends in "…" after a whole word. A single word wider than the line
     is the one case left to CSS. */
  function fitTitle(title, w, lines, px) {
    const words = String(title).trim().split(/\s+/).filter(Boolean);
    if (!words.length) return { text: String(title), cut: false };
    const W = (t) => measureText(t, px, 700);
    const out = [];
    let line = '';
    let k = 0;
    for (; k < words.length; k++) {
      const next = line ? `${line} ${words[k]}` : words[k];
      if (W(next) <= w) { line = next; continue; }
      if (!line) { line = words[k]; k++; }
      out.push(line);
      line = '';
      if (out.length === lines) break;
      k--;
    }
    if (line && out.length < lines) { out.push(line); k = words.length; }
    if (k >= words.length) return { text: words.join(' '), cut: false };
    // ran out of lines: end the last line on a whole word + …
    let last = out[out.length - 1].split(' ');
    while (last.length > 1 && W(`${last.join(' ')}…`) > w) last.pop();
    out[out.length - 1] = `${last.join(' ')}…`;
    return { text: out.join(' '), cut: true };
  }

  /* The current block and the next upcoming local focus block today (▶ shows at rest only there). */
  function currentAndNext(now) {
    const today = startOfDay(now), tomorrow = addDays(today, 1);
    const list = localBlocks().filter((b) => b.taskID && !b.allDay && new Date(b.start) < tomorrow && new Date(b.end) > today)
      .sort((a, b) => new Date(a.start) - new Date(b.start));
    const cur = list.find((b) => new Date(b.start) <= now && new Date(b.end) > now);
    const next = list.find((b) => new Date(b.start) > now);
    return { current: cur ? cur.id : null, next: next ? next.id : null };
  }

  function blockEl(s, now, colW = 200, marks = {}) {
    const e = s.e;
    const task = openTask(e);
    const linkedTask = e.source === 'local' ? taskById(e.taskID) : null;   // open or done: it gets a checkbox
    const course = courseOf(e);
    const title = titleOf(e);
    const start = new Date(e.start), end = new Date(e.end);
    const vt = s.vt != null ? s.vt : s.a;
    const vb = s.vb != null ? Math.max(s.b, s.vb) : s.b;
    const dur = s.b - s.a;            // real length (labels)
    const vdur = vb - vt;             // drawn length (layout)
    const cls = ['cal-ev', 'is-fitted'];
    if (e.readOnly) cls.push('is-readonly');
    if (e.readOnly && e.isBusy === false) cls.push('is-free');
    if (end <= now) cls.push('is-past');
    if (vdur < 45) cls.push('is-compact');
    if (vdur <= 20) cls.push('is-tiny');
    const reserve = s.reserve || 0;     // room kept for a "+N" strip on the right
    const lf = s.lf != null ? s.lf : s.col / s.ncols, wf = s.wf != null ? s.wf : s.span / s.ncols;
    let tf = s.tf != null ? s.tf : wf;    // the part of the card a later block doesn't cover
    // a short block lying over just the title line (a due chip…): only the title narrows,
    // the time and the rest of the card keep the full width, like Google Calendar
    const vt0 = s.vt != null ? s.vt : s.a;
    const titleOnly = tf < wf - 0.001 && s.coverEnd != null && (s.coverEnd - vt0) * MIN_PX <= 34;
    const coveredPx = Math.round((colW - reserve) * (wf - tf));
    // the title's room beside the covering block: from the card's left padding to a small gap before it
    const narrowW = (colW - reserve) * tf - (2 + (s.indent || 0) * 12) - 12 - 6;
    if (titleOnly) tf = wf;
    const boxW = (colW - reserve) * tf - 5 - (s.indent || 0) * 12;
    const slim = boxW + 5 < 96;
    if (slim) cls.push('is-slim');
    if (vdur < 90) cls.push('is-short');
    if (vdur < 70) cls.push('is-brief');
    if (task && !slim && end > now && !(tf < wf - 0.001) && !titleOnly) cls.push('has-play');
    if (e.id === marks.current) cls.push('is-current');
    if (e.id === marks.next) cls.push('is-next');
    if (linkedTask && linkedTask.isDone) cls.push('is-done');
    if (linkedTask) cls.push('has-check');
    if (s.contTop) cls.push('cont-top');
    if (s.contBottom) cls.push('cont-bottom');
    const el = h('div', {
      class: cls.join(' '), dataset: { id: e.id }, role: 'button', tabindex: '0',
      'aria-label': `${title}, ${timeRange(start, end)}${course ? `, ${courseLabel(course)}` : ''}${linkedTask && linkedTask.isDone ? ', done' : ''}${e.readOnly ? ', read-only' : ''}`,
      title: `${title}\n${timeRange(start, end)}${course ? ` · ${courseLabel(course)}` : ''}${e.readOnly ? `\n${calNameOf(e)}` : ''}`,
      vars: { '--ev': colorOf(e) },
    });
    el.style.top = `${vt * MIN_PX}px`;
    const boxH = Math.max(18, vdur * MIN_PX - 2);
    el.style.height = `${boxH}px`;
    const ind = (s.indent || 0) * 12;
    el.style.left = `calc((100% - ${reserve}px) * ${lf} + ${2 + ind}px)`;
    el.style.width = `calc((100% - ${reserve}px) * ${wf} - ${5 + ind}px)`;
    if (ind) el.classList.add('is-stacked');
    if (tf < wf - 0.001) { el.classList.add('is-covered'); el.style.paddingRight = `${Math.round((colW - reserve) * (wf - tf)) + 6}px`; }
    if (s.z) el.style.zIndex = String(s.z);
    if (vt !== s.a) el.classList.add('is-nudged');

    // H6: never break inside a word. The title is fitted in JS (canvas-measured)
    // to the lines the block has room for, ending on a whole word + "…"; the
    // time line falls back range → start time → hidden.
    const play = task && !slim && end > now && !(tf < wf - 0.001) && !titleOnly;   // no ▶ under a covering block
    const focusing = !!(task && isFocusingTask(task.id));
    const tpx = slim ? 10 : (vdur < 45 ? 10.5 : 11);
    let fpx = slim || vdur <= 20 ? 11 : 12;
    const visH = s.coverAt != null ? Math.min(boxH, (s.coverAt - vt) * MIN_PX) : boxH;
    const showTask = task && dur >= 75 && !slim && s.coverAt == null;
    const chkW = linkedTask ? (slim ? 15 : 18) : 0;                // the task checkbox before the title
    const baseW = boxW - (slim ? 13 : 20) - (play ? 24 : 0) - chkW - 4;   // padding + 1 px borders + slack
    let timeText = '';
    let fit, oneline;
    const fitAt = (textW) => {
      timeText = dur < 45 || vt !== s.a ? shortTime(start) : timeRange(start, end);
      if (timeText !== shortTime(start) && measureText(timeText, tpx, 500) > textW) timeText = shortTime(start);
      if (measureText(timeText, tpx, 500) > textW) timeText = '';
      const lineH = Math.round(fpx * 1.25);
      if (vdur < 45 || visH < 34) {
        // one row: title, then the start time if both fit
        oneline = true;
        const full = measureText(title, fpx, 700);
        if (timeText && full + 6 + measureText(timeText, tpx, 500) > textW) timeText = '';
        if (vdur >= 45) cls.push('is-rowtop');   // a tall block covered soon: time sits beside the title
        return fitTitle(title, Math.max(20, textW - (timeText ? measureText(timeText, tpx, 500) + 6 : 0)), 1, fpx);
      }
      const max = slim ? 3 : 2;
      const room = visH - 9 - (timeText ? 14 : 0) - (showTask ? 16 : 0);
      let lines = Math.max(1, Math.min(max, Math.floor(room / lineH)));
      let f = fitTitle(title, textW, lines, fpx);
      if (f.cut && timeText && lines < max && Math.floor((room + 14) / lineH) > lines) {
        // a narrow block: spend the time line on the title instead
        timeText = '';
        lines = Math.max(1, Math.min(max, Math.floor((visH - 9 - (showTask ? 16 : 0)) / lineH)));
        f = fitTitle(title, textW, lines, fpx);
      }
      oneline = lines === 1;
      return f;
    };
    // the source icon gives way when the title would otherwise be cut; a first word
    // that still can't fit drops to 11 px before CSS has to clip it
    let icon16 = !slim && !titleOnly && srcIcon(e) ? 16 : 0;
    fit = fitAt(baseW - icon16);
    if (fit.cut && icon16) { icon16 = 0; fit = fitAt(baseW); }
    const firstWord = String(title).trim().split(/\s+/)[0] || '';
    if (fpx > 11 && measureText(firstWord, fpx, 700) > baseW - icon16) { fpx = 11; cls.push('is-smalltext'); fit = fitAt(baseW - icon16); }
    // beside a covering block the title runs on under it and fades out at the edge (like Google Calendar)
    if (titleOnly) fit = { text: String(title).trim(), cut: measureText(String(title).trim(), fpx, 700) > narrowW - chkW };
    if (oneline) cls.push('is-oneline');
    // the course rides on the time line when it fits: "9:00 – 10:00 AM · BIO 101"
    if (course && timeText && !oneline) {
      const withCourse = `${timeText} · ${courseLabel(course)}`;
      if (measureText(withCourse, tpx, 500) <= baseW - icon16 + chkW) timeText = withCourse;
    }
    el.className = cls.join(' ') + (ind ? ' is-stacked' : '') + (vt !== s.a ? ' is-nudged' : '');
    const check = linkedTask ? h('button', {
      class: 'cal-ev-check', type: 'button', role: 'checkbox', 'aria-checked': String(!!linkedTask.isDone),
      'aria-label': linkedTask.isDone ? `Mark “${linkedTask.title}” as not done` : `Mark “${linkedTask.title}” done`,
      title: linkedTask.isDone ? 'Done — click to undo' : 'Mark done',
      onclick: (ev) => { ev.stopPropagation(); setTaskDone(linkedTask.id, !linkedTask.isDone, e.id); },
    }, icon('check')) : null;
    const titleEl = h('div', { class: 'cal-ev-title' }, check, icon16 ? srcIcon(e) : null, h('span', { class: 'cal-ev-name', text: fit.text }));
    if (titleOnly) { titleEl.style.paddingRight = `${coveredPx}px`; el.classList.add('is-title-covered'); if (fit.cut) el.classList.add('is-title-fade'); }
    el.appendChild(titleEl);
    if (timeText) el.appendChild(h('div', { class: 'cal-ev-time', text: timeText }));
    if (showTask) {
      el.appendChild(h('div', { class: 'cal-ev-task' }, icon('link'), h('span', { text: `${task.completedPomodoros || 0}/${task.estimate} pomodoros` })));
    }
    if (play) {
      el.appendChild(h('button', {
        class: 'cal-ev-play' + (focusing ? ' is-focusing' : ''), type: 'button',
        'aria-label': focusing ? `You are already focusing on ${task.title}` : `Start focus on ${task.title}`,
        title: focusing ? 'You are already focusing on this' : 'Start focus',
        disabled: focusing,
        onclick: (ev) => { ev.stopPropagation(); if (!focusing) startFocus(task.id, e); },
      }, icon(focusing ? 'check' : 'play')));
    }
    if (!e.readOnly && !s.contBottom) el.appendChild(h('div', { class: 'cal-ev-resize', 'aria-hidden': 'true' }));
    return el;
  }

  /* Text width in px for a system-font string (canvas; cached context). */
  let measureCtx = null, measureFamily = null;
  function measureText(text, px, weight) {
    if (measureCtx === null) {
      try {
        measureCtx = document.createElement('canvas').getContext('2d') || false;
        measureFamily = getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif';
      } catch (_) { measureCtx = false; }
    }
    if (!measureCtx) return String(text).length * px * 0.62;
    measureCtx.font = `${weight || 400} ${px}px ${measureFamily}`;
    return measureCtx.measureText(String(text)).width;
  }

  function cssEsc(s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'); }

  function markActive(id) {
    if (!ui.main) return;
    ui.main.querySelectorAll('.is-active-ev').forEach((x) => x.classList.remove('is-active-ev'));
    if (id) ui.main.querySelectorAll(`[data-id="${cssEsc(id)}"]`).forEach((x) => x.classList.add('is-active-ev'));
  }

  function updateNow() {
    if (!isVisible() || drag) return;
    if (dayKey(new Date()) !== lastDay) { lastDay = dayKey(new Date()); if (!pop) render(); return; }
    if (!ui.grid) return;
    const now = new Date();
    const y = `${minuteOfDay(now) * MIN_PX}px`;
    ui.grid.querySelectorAll('.cal-now, .cal-now-bar, .cal-now-time').forEach((x) => { x.style.top = y; });
    const t = ui.grid.querySelector('.cal-now-time');
    if (t) t.textContent = nowLabel(now);
    ui.grid.querySelectorAll('.cal-hour').forEach((lb) => { lb.classList.toggle('is-near-now', Math.abs(parseFloat(lb.style.top) - minuteOfDay(now) * MIN_PX) < 14); });
  }

  // ── month ──

  function renderMonth() {
    const roll = fromToday();
    const y = anchor.getFullYear(), m = roll ? -1 : anchor.getMonth();   // rolling: no "other month" days
    const first = new Date(y, anchor.getMonth(), 1);
    const last = new Date(y, anchor.getMonth() + 1, 0);
    const gridStart = roll ? rollStart() : startOfWeek(first);
    const weeks = roll ? ROLL_WEEKS : Math.ceil((dayIndex(gridStart, last) + 1) / 7);
    const today = startOfDay(new Date());

    const head = h('div', { class: 'cal-month-head' });
    for (let i = 0; i < 7; i++) head.appendChild(h('div', { class: 'cal-month-dow', text: F.dow.format(addDays(gridStart, i)) }));

    const grid = h('div', { class: 'cal-month-grid' });
    grid.style.gridTemplateRows = `repeat(${weeks}, minmax(0, 1fr))`;
    ui.main.appendChild(h('div', { class: 'cal-month' }, head, grid));

    const avail = ui.main.clientHeight - head.offsetHeight;
    const rowH = avail > 120 ? avail / weeks : 120;
    const cap = Math.max(1, Math.floor((rowH - 32) / 21));

    const rangeEnd = addDays(gridStart, weeks * 7);
    const inRange = items().filter((e) => overlaps(e, gridStart, rangeEnd));
    const dues = dueItems(gridStart, rangeEnd);

    for (let i = 0; i < weeks * 7; i++) {
      const d = addDays(gridStart, i);
      const next = addDays(d, 1);
      const dk = dayKey(d);
      const dayEvents = inRange.filter((e) => overlaps(e, d, next)).sort(byStart);
      const dayDues = dues.filter((x) => x.day === dk);
      const cls = 'cal-mcell' + (m >= 0 && d.getMonth() !== m ? ' is-other' : '') + (sameDay(d, today) ? ' is-today' : '') + (d < today ? ' is-past' : '');
      const label = d.getDate() === 1 || (roll && i === 0) ? `${F.monthShort.format(d)} ${d.getDate()}` : String(d.getDate());
      const cell = h('div', { class: cls, dataset: { day: dk } },
        h('div', { class: 'cal-mtop' }, h('button', {
          class: 'cal-mday', type: 'button', title: `Open ${F.full.format(d)}`, 'aria-label': F.full.format(d),
          onclick: () => { anchor = d; setView('day'); },
        }, label)));
      const all = dayDues.map((x) => ({ due: x })).concat(dayEvents.map((e) => ({ e })));
      const show = all.length <= cap ? all.length : cap - 1;
      for (const it of all.slice(0, show)) cell.appendChild(it.due ? dueChip(it.due, 'cal-due--month') : monthPill(it.e));
      if (all.length > show) {
        cell.appendChild(h('button', {
          class: 'cal-more', type: 'button', onclick: () => { anchor = d; setView('day'); },
        }, `+${all.length - show} more`));
      }
      cell.title = `Click to add a block on ${F.full.format(d)}`;
      cell.addEventListener('click', (ev) => {
        if (ev.target.closest('.cal-mpill, .cal-mday, .cal-more, .cal-due, .pf-ghost')) return;
        if (previewing()) return;
        if (suppressCreate) { suppressCreate = false; return; }
        const startMin = sameDay(d, today) ? Math.max(9 * 60, Math.ceil((minuteOfDay(new Date()) + 1) / 15) * 15) : 9 * 60;
        if (startMin + 60 > 1440) { toast('There’s no time left today for a new block.'); return; }
        createAndEdit({ start: dateAt(d, startMin), end: dateAt(d, startMin + 60) });
      });
      grid.appendChild(cell);
    }
  }

  /* A small checkbox for task items inside pills and rows (which are buttons themselves). */
  function taskCheck(t, blockID, cls) {
    const tick = (ev) => { ev.stopPropagation(); ev.preventDefault(); setTaskDone(t.id, !t.isDone, blockID); };
    const el = h('span', {
      class: 'cal-ev-check ' + cls, role: 'checkbox', 'aria-checked': String(!!t.isDone),
      'aria-label': t.isDone ? `Mark “${t.title}” as not done` : `Mark “${t.title}” done`, title: t.isDone ? 'Done — click to undo' : 'Mark done',
      onclick: tick,
    }, icon('check'));
    el.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    return el;
  }

  function monthPill(e) {
    const start = new Date(e.start);
    const t = e.source === 'local' ? taskById(e.taskID) : null;
    return h('button', {
      class: 'cal-mpill' + (e.allDay ? ' is-allday' : '') + (e.readOnly ? ' is-readonly' : '') + (new Date(e.end) < new Date() ? ' is-past' : '')
        + (t ? ' has-check' : '') + (t && t.isDone ? ' is-done' : ''),
      type: 'button', dataset: { id: e.id }, vars: { '--ev': colorOf(e) }, title: titleOf(e),
      onclick: (ev) => { ev.stopPropagation(); openPopover(e.id, ev.currentTarget); },
    },
    t ? taskCheck(t, e.id, 'cal-mcheck') : e.allDay ? null : h('span', { class: 'cal-mdot' }),
    e.allDay ? null : h('span', { class: 'cal-mtime', text: shortTime(start) }),
    h('span', { class: 'cal-mtitle', text: titleOf(e) }),
    srcIcon(e));
  }

  // ── agenda ──

  function renderAgenda() {
    const list = h('div', { class: 'cal-agenda' });
    const today = startOfDay(new Date());
    const now = new Date();
    const end = addDays(anchor, AGENDA_DAYS);
    const inRange = items().filter((e) => overlaps(e, anchor, end));
    const dues = dueItems(anchor, end);
    let any = false;
    for (let i = 0; i < AGENDA_DAYS; i++) {
      const d = addDays(anchor, i);
      const next = addDays(d, 1);
      const isToday = sameDay(d, today);
      const dayEvents = inRange.filter((e) => overlaps(e, d, next)).sort(byStart);
      const dayDues = dues.filter((x) => x.day === dayKey(d));
      if (!dayEvents.length && !dayDues.length && !isToday) continue;
      any = any || dayEvents.length > 0 || dayDues.length > 0;
      const n = dayIndex(today, d);
      const dow = isToday ? 'Today' : n === 1 ? 'Tomorrow' : F.dowLong.format(d);
      const itemsEl = h('div', { class: 'cal-ag-items' });
      if (!dayEvents.length && !dayDues.length) itemsEl.appendChild(h('div', { class: 'cal-ag-none', text: 'Nothing scheduled.' }));
      for (const x of dayDues) itemsEl.appendChild(agendaDueRow(x));
      for (const e of dayEvents) itemsEl.appendChild(agendaRow(e, now));
      list.appendChild(h('section', { class: 'cal-ag-day' + (isToday ? ' is-today' : '') },
        h('div', { class: 'cal-ag-date' },
          h('span', { class: 'cal-ag-num', text: String(d.getDate()) }),
          h('span', { class: 'cal-ag-dlabel' },
            h('span', { class: 'cal-ag-dow', text: dow }),
            h('span', { class: 'cal-ag-md', text: d.getFullYear() === today.getFullYear() ? F.monthShort.format(d) : `${F.monthShort.format(d)} ${d.getFullYear()}` }))),
        itemsEl));
    }
    if (!any) {
      list.appendChild(h('div', { class: 'cal-empty' },
        h('span', { class: 'cal-empty-icon' }, icon('calendar')),
        h('h3', { text: 'Nothing on the horizon' }),
        h('p', { text: `No events in the next ${AGENDA_DAYS} days. Drop a task onto the calendar, or add a calendar to see your classes here.` }),
        h('div', { class: 'cal-empty-actions' },
          h('button', { class: 'btn btn-sm', type: 'button', onclick: () => openAdd() }, icon('plus'), 'Add a calendar'))));
    }
    ui.main.appendChild(h('div', { class: 'cal-agenda-scroll' }, list));
  }

  function agendaDueRow(d) {
    const row = h('div', {
      class: 'cal-ag-row is-due' + (d.done ? ' is-past is-done' : ''), role: 'button', tabindex: '0', dataset: { id: d.id }, vars: { '--ev': d.color },
    },
    h('span', { class: 'cal-ag-time', text: d.minutes != null ? `Due ${F.time.format(dateAt(parseDayKey(d.day), d.minutes))}` : 'Due' }),
    h('span', { class: 'cal-ag-bar' }),
    h('span', { class: 'cal-ag-main' },
      h('span', { class: 'cal-ag-title' }, dueCheck(d, 'cal-agcheck'), h('span', { class: 'cal-ag-name', text: d.title })),
      d.course ? h('span', { class: 'cal-ag-meta', text: d.course }) : null));
    row.addEventListener('click', () => openPopover(d.id, row));
    row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); openPopover(d.id, row); } });
    return row;
  }

  function agendaRow(e, now) {
    const start = new Date(e.start), end = new Date(e.end);
    const task = openTask(e);
    const linkedTask = e.source === 'local' ? taskById(e.taskID) : null;
    const course = courseOf(e);
    const meta = [];
    if (course) meta.push(courseLabel(course));
    if (e.source !== 'local') meta.push(calNameOf(e));
    if (e.location) meta.push(e.location);
    if (task) meta.push(`${task.completedPomodoros || 0}/${task.estimate} pomodoros`);
    const row = h('div', {
      class: 'cal-ag-row' + (end < now ? ' is-past' : '') + (e.readOnly ? ' is-readonly' : '') + (linkedTask && linkedTask.isDone ? ' is-done' : ''),
      role: 'button', tabindex: '0', dataset: { id: e.id }, vars: { '--ev': colorOf(e) },
    },
    h('span', { class: 'cal-ag-time', text: e.allDay ? 'All day' : timeRange(start, end) }),
    h('span', { class: 'cal-ag-bar' }),
    h('span', { class: 'cal-ag-main' },
      h('span', { class: 'cal-ag-title' }, linkedTask ? taskCheck(linkedTask, e.id, 'cal-agcheck') : null, srcIcon(e), h('span', { class: 'cal-ag-name', text: titleOf(e) })),
      meta.length ? h('span', { class: 'cal-ag-meta', text: meta.join(' · ') }) : null),
    task && end > now ? (() => {
      const focusing = isFocusingTask(task.id);
      return h('button', {
        class: 'btn btn-sm cal-ag-play' + (focusing ? ' is-focusing' : ''), type: 'button',
        'aria-label': focusing ? `You are already focusing on ${task.title}` : `Start focus on ${task.title}`,
        title: focusing ? 'You are already focusing on this' : 'Start focus',
        disabled: focusing,
        onclick: (ev) => { ev.stopPropagation(); if (!focusing) startFocus(task.id, e); },
      }, icon(focusing ? 'check' : 'play'), focusing ? 'Focusing' : 'Start');
    })() : null);
    row.addEventListener('click', () => openPopover(e.id, row));
    row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); openPopover(e.id, row); } });
    return row;
  }

  // ── tray (Unscheduled) ──

  /* CAL v1 unscheduled (SPEC §1.4.3): remaining − pomodoros of future, non-hidden local focus blocks. */
  function unscheduledTasks() {
    const now = new Date();
    // a calendar task (the block IS the task) always has its time, past or future
    const onCal = new Set(Store.blocks().filter((b) => b.isTask && b.taskID && !b.hidden).map((b) => String(b.taskID).toLowerCase()));
    if (core()) {
      const rows = CalCore.unscheduled(Store.tasks(), Store.blocks(), now);
      const by = new Map(rows.map((r) => [String(r.taskID).toLowerCase(), r]));
      return Store.tasks().filter((t) => { const k = String(t.id).toLowerCase(); const r = by.get(k); return r && r.unscheduled > 0 && !onCal.has(k); })
        .map((t) => ({ task: t, n: by.get(String(t.id).toLowerCase()).unscheduled }));
    }
    const covered = new Map();
    for (const b of Store.blocks()) {
      if (b.hidden || !b.taskID || b.kind !== 'focus' || new Date(b.end) <= now) continue;
      const k = String(b.taskID).toLowerCase();
      covered.set(k, (covered.get(k) || 0) + (b.pomodoros || 0));
    }
    const out = [];
    for (const t of Store.tasks()) {
      if (t.isDone || onCal.has(String(t.id).toLowerCase())) continue;
      const n = Math.max(0, (t.estimate - (t.completedPomodoros || 0)) - (covered.get(String(t.id).toLowerCase()) || 0));
      if (n > 0) out.push({ task: t, n });
    }
    return out;
  }

  // ───────────────────────────  sidebar (v2-calendar §8.2)  ───────────────────────────

  let miniMonth = null;        // first day of the month the mini-month shows (null: follow the view)
  let solo = null;             // {key, prev: {visibility snapshot}} for ⌥-click "show only this"
  let renaming = null;         // feed id being renamed inline

  function collapsedSections() { return prefs().collapsedSections || []; }
  function collapsedGroups() { return prefs().collapsedGroups || []; }
  function toggleIn(list, key) { return list.includes(key) ? list.filter((x) => x !== key) : list.concat([key]); }

  function sideSection(id, title, { right = null, count = null } = {}) {
    const collapsed = collapsedSections().includes(id);
    const body = h('div', { class: 'cal-sec-body', id: `cal-sec-${id}` });
    body.hidden = collapsed;
    const head = h('div', { class: 'cal-sec-head' },
      h('button', {
        class: 'cal-sec-toggle', type: 'button', 'aria-expanded': String(!collapsed), 'aria-controls': `cal-sec-${id}`,
        dataset: { nav: '1' },
        onclick: () => setPrefs({ collapsedSections: toggleIn(collapsedSections(), id) }),
      }, icon('chevR', 'cal-sec-chev'), h('span', { class: 'cal-sec-title', text: title }),
      count != null && count > 0 ? h('span', { class: 'cal-sec-count', text: String(count) }) : null),
      right ? h('div', { class: 'cal-sec-right' }, right) : null);
    return { el: h('section', { class: 'cal-sec' + (collapsed ? ' is-collapsed' : ''), dataset: { sec: id } }, head, body), body };
  }

  function renderSide() {
    if (!ui.side) return;
    const focusKey = document.activeElement && ui.side.contains(document.activeElement) ? navKeyOf(document.activeElement) : null;
    const st = ui.side.scrollTop;
    // a refresh in the background must not take what you're typing, or the keyboard with it
    const typed = ['.cal-quick-add', '.cal-row-rename'].map((sel) => {
      const el = ui.side.querySelector(sel);
      return el && { sel, value: el.value, focused: el === document.activeElement, from: el.selectionStart, to: el.selectionEnd };
    }).filter(Boolean);
    sideRebuilding = true;
    ui.side.textContent = '';
    sideRebuilding = false;
    ui.side.appendChild(h('div', { class: 'cal-sheet-grip', 'aria-hidden': 'true' }));
    ui.side.appendChild(renderMini());
    ui.side.appendChild(renderCalendars());
    const extra = Array.from(v2.sidebar.values()).sort((a, b) => (a.order || 0) - (b.order || 0));
    for (const spec of extra) {
      try {
        if (typeof spec.when === 'function' && !spec.when()) continue;
        const right = h('div', { class: 'cal-sec-actions' });
        if (typeof spec.renderHeader === 'function') spec.renderHeader(right);
        const { el, body } = sideSection(spec.id, spec.title || spec.id, { right: right.childElementCount ? right : null });
        if (typeof spec.render === 'function' && !body.hidden) spec.render(body);
        ui.side.appendChild(el);
      } catch (err) { console.error(`Sidebar section ${spec.id} failed`, err); }
    }
    ui.side.appendChild(renderUnscheduled());
    ui.side.appendChild(h('p', { class: 'cal-side-foot', text: privacyLine() }));
    ui.side.scrollTop = st;
    if (focusKey) {
      const f = ui.side.querySelector(`[data-nav-key="${cssEsc(focusKey)}"]`);
      if (f) f.focus({ preventScroll: true });
    }
    for (const t of typed) {
      const el = ui.side.querySelector(t.sel);
      if (!el) continue;
      el.value = t.value;
      if (t.focused) { el.focus({ preventScroll: true }); el.setSelectionRange(t.from, t.to); }
    }
  }

  function navKeyOf(el) { const n = el.closest && el.closest('[data-nav-key]'); return n ? n.dataset.navKey : null; }

  function privacyLine() {
    const m = typeof Feeds !== 'undefined' && Feeds.knownMode ? Feeds.knownMode() : null;
    if (m === 'cloud') return 'Read-only. Links are stored with your account.';
    if (m === 'local') return 'Read-only. Links stay on this computer.';
    return 'Read-only. Your calendars stay in this browser.';
  }

  // ── mini-month ──

  function renderMini() {
    const base = miniMonth || new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const today = startOfDay(new Date());
    const gridStart = startOfWeek(base);
    const gridEnd = addDays(gridStart, 42);
    const vr = visibleRange();
    const marks = dayMarks(gridStart, gridEnd);
    const head = h('div', { class: 'cal-mini-head' },
      h('span', { class: 'cal-mini-title', text: F.monthYear.format(base) }),
      h('button', { class: 'icon-btn cal-mini-nav', type: 'button', 'aria-label': 'Previous month', title: 'Previous month', onclick: () => { miniMonth = new Date(base.getFullYear(), base.getMonth() - 1, 1); renderSide(); } }, icon('chevL')),
      h('button', { class: 'icon-btn cal-mini-nav', type: 'button', 'aria-label': 'Next month', title: 'Next month', onclick: () => { miniMonth = new Date(base.getFullYear(), base.getMonth() + 1, 1); renderSide(); } }, icon('chevR')));
    const grid = h('div', { class: 'cal-mini-grid', role: 'grid', 'aria-label': F.monthYear.format(base) });
    const dowFmt = fmt({ weekday: 'narrow' });
    for (let i = 0; i < 7; i++) grid.appendChild(h('span', { class: 'cal-mini-dow', 'aria-hidden': 'true', text: dowFmt.format(addDays(gridStart, i)) }));
    for (let i = 0; i < 42; i++) {
      const d = addDays(gridStart, i);
      const k = dayKey(d);
      const inRange = k >= vr.from && k <= vr.to;
      const col = i % 7;
      const prevIn = col > 0 && dayKey(addDays(d, -1)) >= vr.from && dayKey(addDays(d, -1)) <= vr.to;
      const nextIn = col < 6 && dayKey(addDays(d, 1)) >= vr.from && dayKey(addDays(d, 1)) <= vr.to;
      const m = marks.get(k);
      const cls = ['cal-mini-day'];
      if (d.getMonth() !== base.getMonth()) cls.push('is-other');
      if (sameDay(d, today)) cls.push('is-today');
      if (inRange && vr.view !== 'agenda') { cls.push('in-range'); if (!prevIn) cls.push('range-start'); if (!nextIn) cls.push('range-end'); }
      grid.appendChild(h('button', {
        class: cls.join(' '), type: 'button', role: 'gridcell', 'aria-label': F.full.format(d) + (m ? `, ${m.label}` : ''),
        'aria-current': sameDay(d, today) ? 'date' : null,
        onclick: () => { miniMonth = null; goTo(d); if (mode !== 'wide') setSideOpen(false); },
      }, h('span', { class: 'cal-mini-num', text: String(d.getDate()) }), m ? h('span', { class: `cal-mini-dot is-${m.kind}` }) : null));
    }
    return h('section', { class: 'cal-sec cal-mini' }, head, grid);
  }

  function dayMarks(from, to) {
    const out = new Map();
    const set = (k, kind, label) => {
      const rank = { local: 3, due: 2, event: 1 };
      const cur = out.get(k);
      if (!cur || rank[kind] > rank[cur.kind]) out.set(k, { kind, label });
    };
    for (const e of items()) {
      if (!overlaps(e, from, to)) continue;
      const d0 = startOfDay(new Date(e.start));
      set(dayKey(d0 < from ? from : d0), e.source === 'local' ? 'local' : 'event', e.source === 'local' ? 'focus blocks' : 'events');
    }
    for (const d of dueItems(from, to)) set(d.day, 'due', 'due work');
    return out;
  }

  // ── Today ──

  // ── Calendars ──

  const GROUP_ORDER = (k) => (k === 'pure' ? 0 : k === 'school' ? 1 : k.startsWith('google') ? 2 : k.startsWith('apple') ? 3 : k === 'links' ? 4 : k === 'files' ? 5 : 6);
  function groupOf(f) {
    if (f.groupKey) return f.groupKey;
    if (f.source === 'google') return 'google';
    if (f.provider === 'canvas' || f.provider === 'blackbaud') return 'school';
    return f.hasURL ? 'links' : 'files';
  }
  function groupName(k) {
    if (k === 'pure') return 'Pure Focus';
    if (k === 'school') return 'School';
    if (k === 'links') return 'Links';
    if (k === 'files') return 'Files';
    if (k === 'google') return 'Google';
    if (k.startsWith('google:')) return `Google · ${k.slice(7)}`;
    if (k.startsWith('apple:')) return `Apple · ${k.slice(6)}`;
    return k;
  }

  function autoCollapse(groups) {
    // With more than 6 feeds, groups start collapsed except Pure Focus and School (once per group, per device).
    if (feeds().length <= 6) return;
    let seen = [];
    try { seen = JSON.parse(localStorage.getItem('purefocus.cal.autocollapsed') || '[]') || []; } catch (_) { seen = []; }
    const fresh = groups.filter((g) => g !== 'pure' && g !== 'school' && !seen.includes(g));
    if (!fresh.length) return;
    try { localStorage.setItem('purefocus.cal.autocollapsed', JSON.stringify(seen.concat(fresh))); } catch (_) { /* per-device convenience */ }
    const cg = collapsedGroups();
    const add = fresh.filter((g) => !cg.includes(g));
    if (add.length) setPrefs({ collapsedGroups: cg.concat(add) });
  }

  function syncStatus() {
    if (typeof Feeds === 'undefined') return null;
    const s = Feeds.status();
    if (!s.linked) return null;
    const ago = s.lastSyncAt ? relTime(new Date(s.lastSyncAt)) : null;
    if (s.refreshing.length) return { kind: 'busy', tip: 'Syncing…' };
    if (s.state === 'error') return { kind: 'error', tip: 'A calendar needs attention' };
    if (s.state === 'stale') return { kind: 'stale', tip: Feeds.knownMode && Feeds.knownMode() === 'none' ? 'Calendar links need the Pure Focus helper (python3 serve.py)' : (ago ? `Last synced ${ago}` : 'Not synced yet') };
    // Google's sign-in needs a click to renew, so say when its events have stopped following
    try {
      if (feeds().some((f) => f.source === 'google' && f.isVisible !== false) && typeof GoogleSync !== 'undefined' && GoogleSync.user && GoogleSync.user() && !GoogleSync.calendarLive()) {
        return { kind: 'stale', tip: 'Google sync is paused — press ↻ to reconnect' };
      }
    } catch (_) { /* no Google */ }
    return { kind: 'ok', tip: ago ? `Synced ${ago}` : 'Synced' };
  }

  function relTime(d) {
    const m = Math.round((Date.now() - d.getTime()) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const hh = Math.round(m / 60);
    if (hh < 24) return `${hh} h ago`;
    return F.md.format(d);
  }

  function renderCalendars() {
    const list = feeds();
    const p = prefs();
    const st = syncStatus();
    const right = h('div', { class: 'cal-sec-actions' },
      st ? h('span', { class: `cal-sync-dot is-${st.kind}`, title: st.tip, role: 'img', 'aria-label': st.tip }) : null,
      list.some((f) => f.hasURL || f.source === 'google') ? h('button', {
        class: 'icon-btn cal-mini-btn', type: 'button', title: 'Refresh calendars', 'aria-label': 'Refresh calendars',
        onclick: () => refreshAll(),
      }, icon('refresh')) : null,
      h('button', { class: 'icon-btn cal-mini-btn', type: 'button', title: 'Add a calendar', 'aria-label': 'Add a calendar', onclick: () => openAdd() }, icon('plus')));
    const { el, body } = sideSection('calendars', 'Calendars', { right });
    const groups = new Map([['pure', []]]);
    for (const f of list) { const g = groupOf(f); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(f); }
    const keys = Array.from(groups.keys()).sort((a, b) => GROUP_ORDER(a) - GROUP_ORDER(b) || (a < b ? -1 : 1));
    autoCollapse(keys);
    const cg = collapsedGroups();
    for (const g of keys) {
      const rows = g === 'pure'
        ? [
          { key: 'local', name: 'My blocks', color: 'var(--focus-tint)', on: p.showLocalBlocks !== false },
          { key: 'due', name: 'Tasks due', color: 'var(--text-secondary)', on: p.showDueTasks !== false },
        ]
        : groups.get(g).map((f) => ({ key: f.id, feed: f, name: feedName(f), color: feedColor(f) || 'var(--text-muted)', on: f.isVisible !== false }));
      const collapsed = cg.includes(g);
      const grp = h('div', { class: 'cal-group' + (collapsed ? ' is-collapsed' : ''), role: 'group', 'aria-label': groupName(g) });
      grp.appendChild(h('button', {
        class: 'cal-group-head', type: 'button', 'aria-expanded': String(!collapsed), dataset: { nav: '1', navKey: 'g:' + g, group: g },
        onclick: () => setPrefs({ collapsedGroups: toggleIn(collapsedGroups(), g) }),
      }, icon('chevR', 'cal-group-chev'), h('span', { class: 'cal-group-name', text: groupName(g) }),
      collapsed ? h('span', { class: 'cal-group-count', text: `(${rows.length})` }) : null));
      if (!collapsed) for (const r of rows) grp.appendChild(calRow(r, g));
      body.appendChild(grp);
    }
    if (!list.length) {
      body.appendChild(h('button', { class: 'cal-add-row', type: 'button', dataset: { nav: '1', navKey: 'add' }, onclick: () => openAdd() },
        icon('plus'), h('span', { text: 'Add Canvas, Google, school or any calendar' })));
    }
    return el;
  }

  function calRow(r, group) {
    const f = r.feed || null;
    const glyphs = [];
    if (f && f.hasURL) glyphs.push(h('span', { class: 'cal-row-glyph', title: 'Calendar link · refreshes on its own' }, icon('refresh')));
    if (f && f.accessRole === 'freeBusyReader') glyphs.push(h('span', { class: 'cal-row-glyph', title: 'Free/busy only' }, icon('lock')));
    if (f && f.blocksTime === false) glyphs.push(h('span', { class: 'cal-row-glyph is-free', title: 'Doesn’t block your time' }, icon('free')));
    if (f && f.lastError) glyphs.push(h('span', { class: 'cal-row-glyph is-warn', title: f.lastError }, icon('warn')));
    const label = `${r.name}, ${r.on ? 'visible' : 'hidden'}, ${group === 'pure' ? 'Pure Focus' : groupName(group)} calendar`;
    // while renaming it's a plain row: a click in the field shouldn't also tick the calendar
    const main = h(renaming === r.key && f ? 'div' : 'button', renaming === r.key && f ? { class: 'cal-row-main' } : {
      class: 'cal-row-main', type: 'button', role: 'checkbox', 'aria-checked': String(r.on), 'aria-label': label,
      title: f && f.provider === 'blackbaud' ? 'Blackbaud updates feeds about once an hour.' : (f && f.lastError ? f.lastError : null),
      dataset: { nav: '1', navKey: 'r:' + r.key },
      onclick: (ev) => { if (ev.altKey) soloToggle(r.key); else toggleRow(r.key); },
    },
    h('span', { class: 'cal-check', 'aria-hidden': 'true' }, icon('check')),
    renaming === r.key ? null : h('span', { class: 'cal-row-name', text: r.name }),
    glyphs);
    const row = h('div', { class: 'cal-row' + (r.on ? ' is-on' : ''), vars: { '--ev': r.color }, dataset: { row: r.key } }, main);
    if (renaming === r.key && f) {
      const input = h('input', { class: 'cal-row-rename', type: 'text', value: feedName(f), maxlength: '80', 'aria-label': `Rename ${f.name}` });
      const finish = (save) => {
        if (renaming !== r.key) return;
        renaming = null;
        if (save) Feeds.update(f.id, { displayName: input.value.trim() && input.value.trim() !== f.name ? input.value.trim() : null });
        renderSide();
      };
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); finish(true); } if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finish(false); } });
      input.addEventListener('blur', () => { if (!sideRebuilding && input.isConnected) finish(true); });
      main.insertBefore(input, main.children[1] || null);
      setTimeout(() => { if (document.activeElement !== input) { input.focus(); input.select(); } }, 0);
    }
    row.appendChild(h('button', {
      class: 'cal-row-more', type: 'button', 'aria-label': `${r.name} options`, title: 'Options', 'aria-haspopup': 'menu',
      onclick: (ev) => { ev.stopPropagation(); openRowMenu(r, ev.currentTarget); },
    }, icon('more')));
    return row;
  }

  function visibilitySnapshot() {
    const p = prefs();
    const snap = { local: p.showLocalBlocks !== false, due: p.showDueTasks !== false };
    for (const f of feeds()) snap[f.id] = f.isVisible !== false;
    return snap;
  }

  function applyVisibility(snap) {
    const next = feeds().map((f) => (f.id in snap ? { ...f, isVisible: !!snap[f.id] } : f));
    Store.updateCalendar({ feeds: next, prefs: { showLocalBlocks: !!snap.local, showDueTasks: !!snap.due } });
  }

  function toggleRow(key) {
    solo = null;
    if (key === 'local') setPrefs({ showLocalBlocks: prefs().showLocalBlocks === false });
    else if (key === 'due') setPrefs({ showDueTasks: prefs().showDueTasks === false });
    else { const f = feeds().find((x) => x.id === key); if (f) Feeds.update(key, { isVisible: f.isVisible === false }); }
  }

  /* ⌥-click / "Show only this": everything else hides; doing it again restores the previous set. */
  function soloToggle(key) {
    if (solo && solo.key === key) { const prev = solo.prev; solo = null; applyVisibility(prev); return; }
    const prev = solo ? solo.prev : visibilitySnapshot();
    const snap = {};
    for (const k of Object.keys(prev)) snap[k] = k === key;
    solo = { key, prev };
    applyVisibility(snap);
  }

  function refreshAll() {
    if (typeof Feeds !== 'undefined') Feeds.refresh(null, { force: true });
    try {
      if (feeds().some((f) => f.source === 'google') && typeof GoogleSync !== 'undefined' && GoogleSync.isConfigured() && GoogleSync.user()) GoogleSync.importCalendar();
    } catch (_) { /* Google needs a sign-in click */ }
    renderSide();
  }

  const SWATCHES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
  const swatchName = (c) => { const i = SWATCHES.indexOf(String(c || '').toLowerCase()); return i < 0 ? 'Custom colour' : `Theme colour ${i + 1}`; };

  function openRowMenu(r, anchorEl) {
    closeMenu();
    closePopover();
    const f = r.feed || null;
    const item = (label, fn, { checked = null, danger = false } = {}) => h('button', {
      class: 'cal-rm-item' + (danger ? ' is-danger' : ''), type: 'button', role: checked == null ? 'menuitem' : 'menuitemcheckbox',
      'aria-checked': checked == null ? null : String(!!checked),
      onclick: (ev) => { ev.stopPropagation(); closeMenu(); fn(); },
    }, h('span', { class: 'cal-rm-check', 'aria-hidden': 'true' }, checked ? icon('check') : null), h('span', { text: label }));
    const kids = [item('Show only this', () => soloToggle(r.key))];
    if (f) {
      const sw = h('div', { class: 'cal-rm-swatches', role: 'group', 'aria-label': 'Colour' },
        SWATCHES.map((c) => {
          const norm = Feeds.normalizeColor(c) || c;
          const on = (f.userColorHex || '').toLowerCase() === norm.toLowerCase();
          return h('button', { class: 'cal-rm-swatch' + (on ? ' is-on' : ''), type: 'button', vars: { '--sw': themed(c) }, title: swatchName(c), 'aria-label': swatchName(c), 'aria-pressed': String(on),
            onclick: (ev) => { ev.stopPropagation(); closeMenu(); Feeds.update(f.id, { userColorHex: norm }); } });
        }),
        h('button', { class: 'cal-rm-default' + (f.userColorHex ? '' : ' is-on'), type: 'button', title: 'Use a colour from your theme — it changes when you switch themes', 'aria-pressed': String(!f.userColorHex), onclick: (ev) => { ev.stopPropagation(); closeMenu(); Feeds.update(f.id, { userColorHex: null }); } }, 'Theme'));
      kids.push(h('div', { class: 'cal-rm-label', text: 'Colour' }), sw);
      kids.push(item('Rename', () => { renaming = r.key; renderSide(); }));
      kids.push(item('Doesn’t block my time', () => Feeds.update(f.id, { blocksTime: f.blocksTime === false }), { checked: f.blocksTime === false }));
      if (f.source !== 'google') {
        kids.push(item('These are due dates', () => {
          const next = f.itemRole === 'dueDates' ? (f.provider === 'canvas' || f.provider === 'blackbaud' ? 'auto' : 'events') : 'dueDates';
          Feeds.update(f.id, { itemRole: next });
          toast(next === 'dueDates' ? `“${feedName(f)}” items now count as due dates` : `“${feedName(f)}” items are events again`);
        }, { checked: f.itemRole === 'dueDates' }));
      }
      if (f.hasURL) kids.push(item('Refresh now', () => { Feeds.refresh(f.id, { force: true }); renderSide(); }));
      kids.push(h('div', { class: 'cal-menu-sep' }));
      kids.push(item(f.source === 'google' ? 'Stop syncing' : 'Remove', () => removeFeed(f), { danger: true }));
    }
    menu = h('div', { class: 'cal-menu cal-rowmenu', role: 'menu', 'aria-label': `${r.name} options` }, kids);
    document.body.appendChild(menu);
    const rect = anchorEl.getBoundingClientRect();
    const w = menu.offsetWidth, hh = menu.offsetHeight;
    let left = rect.right + 6, top = rect.top - 6;
    if (left + w > window.innerWidth - 12) left = rect.left - w - 6;
    if (left < 12) left = clamp(rect.left, 12, window.innerWidth - w - 12);
    top = clamp(top, 12, Math.max(12, window.innerHeight - hh - 12));
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    menu.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
      ev.preventDefault();
      const itemsEl = Array.from(menu.querySelectorAll('button'));
      const i = itemsEl.indexOf(document.activeElement);
      itemsEl[(i + (ev.key === 'ArrowDown' ? 1 : -1) + itemsEl.length) % itemsEl.length].focus();
    });
    const first = menu.querySelector('button');
    if (first) first.focus({ preventScroll: true });
  }

  async function removeFeed(f) {
    const google = f.source === 'google';
    const ok = await confirmDialog({
      title: google ? `Stop syncing “${feedName(f)}”?` : `Remove “${feedName(f)}”?`,
      body: google ? 'Its events leave Pure Focus. Import from Google again to bring them back.'
        : `Its events${f.provider === 'canvas' || f.itemRole === 'dueDates' ? ' and due dates' : ''} leave Pure Focus. Tasks you already have stay.`,
      ok: google ? 'Stop syncing' : 'Remove', danger: true,
    });
    if (!ok) return;
    Feeds.remove(f.id);
    toast(`Removed “${feedName(f)}”`);
  }

  function onSideKey(ev) {
    const t = ev.target;
    if (!t || !t.dataset) return;
    if (t.classList.contains('cal-row-rename')) return;
    const navs = Array.from(ui.side.querySelectorAll('[data-nav]')).filter((x) => x.offsetParent !== null);
    const i = navs.indexOf(t);
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      if (i < 0) return;
      ev.preventDefault();
      const n = navs[clamp(i + (ev.key === 'ArrowDown' ? 1 : -1), 0, navs.length - 1)];
      if (n) n.focus();
      return;
    }
    if (t.classList.contains('cal-group-head') && (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft')) {
      ev.preventDefault();
      const g = t.dataset.group;
      const collapsed = collapsedGroups().includes(g);
      if ((ev.key === 'ArrowRight' && collapsed) || (ev.key === 'ArrowLeft' && !collapsed)) setPrefs({ collapsedGroups: toggleIn(collapsedGroups(), g) });
      return;
    }
    if (t.classList.contains('cal-row-main')) {
      if (ev.key === 'ArrowLeft') {
        ev.preventDefault();
        const grp = t.closest('.cal-group');
        const head = grp && grp.querySelector('.cal-group-head');
        if (head) { setPrefs({ collapsedGroups: toggleIn(collapsedGroups().filter((x) => x !== head.dataset.group), head.dataset.group) }); }
        return;
      }
      if (ev.key === ' ' && ev.altKey) { ev.preventDefault(); soloToggle(t.dataset.navKey.slice(2)); }
    }
  }

  // ── Unscheduled (the old right tray, now in the sidebar) ──

  function renderUnscheduled() {
    const rows = unscheduledTasks();
    const s = pomoSettings();
    const { el, body } = sideSection('unscheduled', 'Unscheduled', { count: rows.length });
    const list = h('div', { class: 'cal-tray-list', role: 'list' });
    for (const { task: t, n } of rows) {
      const left = Math.max(0, t.estimate - (t.completedPomodoros || 0));
      const meta = [];
      if (t.course) meta.push(h('span', { class: 'cal-chip-course', vars: { '--ev': courseColor(t) } }, h('span', { class: 'cal-chip-dot' }), h('span', { text: t.course.slice(0, 12) })));
      meta.push(h('span', { class: 'cal-task-pips', title: `${n} of ${left} not scheduled yet` },
        Array.from({ length: Math.min(left, 8) }, (_, i) => h('span', { class: 'cal-pip' + (i < left - n ? ' is-covered' : '') })),
        h('span', { class: 'cal-pip-text', text: `${n} of ${left}` })));
      if (t.dueDate) meta.push(h('span', { class: 'cal-task-due' + (t.dueDate < dayKey(new Date()) ? ' is-overdue' : ''), text: dueLabel(t.dueDate) }));
      list.appendChild(h('div', {
        class: 'cal-task', role: 'listitem', dataset: { id: t.id }, vars: { '--ev': t.category ? catColor(t.category) : 'var(--focus-tint)' },
        title: `Drag onto the calendar · ${fmtDur(blockMinutes(Math.min(n, s.interval), s))}`,
      },
      h('span', { class: 'cal-task-grip' }, icon('grip')),
      h('span', { class: 'cal-task-main' },
        h('span', { class: 'cal-task-title', text: t.title }),
        h('span', { class: 'cal-task-meta' }, meta)),
      h('button', {
        class: 'icon-btn cal-mini-btn cal-task-add', type: 'button', title: 'Schedule next free slot',
        'aria-label': `Schedule ${t.title} in the next free slot`, onclick: () => scheduleNext(t, n),
      }, icon('dropin'))));
    }
    if (!rows.length) {
      const anyOpen = Store.tasks().some((t) => !t.isDone);
      list.appendChild(h('div', { class: 'cal-tray-empty', text: anyOpen ? 'Every open task has a time.' : 'No open tasks yet.' }));
    } else if (rows.length <= 3 && !Store.blocks().length) {
      list.appendChild(h('p', { class: 'cal-tray-sub', text: 'Drag a task onto the calendar, or use ⤓ for the next free slot.' }));
    }
    body.appendChild(list);
    const input = h('input', { class: 'cal-quick-add', type: 'text', placeholder: 'Add a task…', maxlength: '120', 'aria-label': 'Add a task' });
    input.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      const title = input.value.trim();
      if (!title) return;
      input.value = '';
      Store.addTask({ title });
      setTimeout(() => { const i2 = ui.side.querySelector('.cal-quick-add'); if (i2) i2.focus(); }, 30);
    });
    body.appendChild(input);
    return el;
  }

  function courseColor(t) {
    if (t.externalID && typeof Assignments !== 'undefined') {
      const a = Assignments.get(t.externalID);
      const f = a && feedMap().get(a.feedID);
      if (f) return feedColor(f);
    }
    return (t.courseKey && fromEnd([...lowerHex(t.courseKey)].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) >>> 0, 7))) || 'var(--text-secondary)';
  }

  function dueLabel(day) {
    const d = parseDayKey(day);
    if (!d) return '';
    const n = dayIndex(new Date(), d);
    if (n < 0) return 'Overdue';
    if (n === 0) return 'Due today';
    if (n === 1) return 'Due tomorrow';
    if (n < 7) return `Due ${F.dow.format(d)}`;
    return `Due ${F.md.format(d)}`;
  }

  // ───────────────────────────  scheduling  ───────────────────────────

  /* Busy minutes on `day` for planning: visible-or-not feeds that block time (V5) ± buffer,
     plus local blocks. */
  function busyOn(day) {
    const from = startOfDay(day), to = addDays(from, 1);
    const p = prefs();
    const buf = Number(p.eventBuffer) || 0;
    const fm = feedMap();
    const events = [];
    if (typeof Feeds !== 'undefined') {
      for (const raw of Feeds.events()) {
        const f = fm.get(raw.calendarID);
        if (!f || f.blocksTime === false || raw.allDay || raw.isBusy === false) continue;
        const s = new Date(raw.start), e = new Date(raw.end);
        if (!(s < to && e > from) || e - s >= DAY_MS) continue;
        events.push({ id: raw.id, start: Math.max(0, Math.round((s - from) / 60000)), end: Math.min(1440, Math.round((e - from) / 60000)), isBusy: true });
      }
    }
    const blocks = localBlocks().filter((b) => !b.allDay && new Date(b.start) < to && new Date(b.end) > from).map((b) => ({
      id: b.id, taskID: b.taskID, start: Math.max(0, Math.round((new Date(b.start) - from) / 60000)),
      end: Math.min(1440, Math.round((new Date(b.end) - from) / 60000)), pomodoros: b.pomodoros || 0,
    }));
    return { events, blocks, buf };
  }

  function planInput(day, tasks) {
    const s = pomoSettings();
    const p = prefs();
    const today = startOfDay(new Date());
    const rel = sameDay(day, today) ? 'today' : day < today ? 'past' : 'future';
    const { events, blocks } = busyOn(day);
    let focused = 0, completed = 0, plannedRemaining = 0;
    if (rel === 'today') {
      const dk = dayKey(day);
      for (const x of Store.sessions()) {
        if (x.mode !== 'focus' || !x.end || dayKey(new Date(x.end)) !== dk) continue;
        focused += Number(x.actualMinutes ?? x.minutes ?? 0) || 0;
        completed += 1;
      }
      const now = new Date();
      for (const b of localBlocks()) if (b.taskID && new Date(b.start) >= now && sameDay(new Date(b.start), day)) plannedRemaining += b.plannedFocusMinutes || 0;
    } else {
      for (const b of localBlocks()) if (b.taskID && sameDay(new Date(b.start), day)) plannedRemaining += b.plannedFocusMinutes || 0;
    }
    return {
      day: dayKey(day), dayRelation: rel, nowMinutes: rel === 'today' ? minuteOfDay(new Date()) : 0,
      settings: { ...s, dayStart: p.planDayStart, dayEnd: p.planDayEnd, buffer: Number(p.eventBuffer) || 0, maxPlannedFocus: p.maxPlannedFocus },
      events, blocks, tasks, focusedTodayMinutes: Math.round(focused), completedPomodorosToday: completed,
      plannedRemainingTodayMinutes: plannedRemaining,
    };
  }

  /* Without CalCore: the first free 15-minute slot inside the planning hours (busy ± buffer). */
  function fallbackSlot(day, minutes) {
    const p = prefs();
    const today = startOfDay(new Date());
    const { events, blocks, buf } = busyOn(day);
    let lo = p.planDayStart;
    if (sameDay(day, today)) lo = Math.max(lo, Math.ceil((minuteOfDay(new Date()) + 5) / SNAP) * SNAP);
    const hi = p.planDayEnd;
    const busy = events.map((e) => [e.start - buf, e.end + buf]).concat(blocks.map((b) => [b.start, b.end])).sort((a, b) => a[0] - b[0]);
    let t = Math.ceil(lo / SNAP) * SNAP;
    for (const [a, b] of busy) {
      if (b <= t) continue;
      if (a >= t + minutes) break;
      t = Math.ceil(Math.max(t, b) / SNAP) * SNAP;
    }
    return t + minutes <= hi ? t : null;
  }

  function slotsFor(day, task, n) {
    const s = pomoSettings();
    if (core()) {
      const res = CalCore.autoPlan(planInput(day, [{ id: task.id, title: task.title, listIndex: 0, remaining: n, covered: 0, due: task.dueDate || undefined, active: false }]));
      return (res.blocks || []).map((b) => ({ start: b.start, end: b.end, pomodoros: b.pomodoros }));
    }
    const k = Math.min(n, s.interval);
    const len = blockMinutes(k, s);
    const at = fallbackSlot(day, len);
    return at == null ? [] : [{ start: at, end: at + len, pomodoros: k }];
  }

  /* ⤓ "Schedule next free slot": autoPlan for today, then the following days (≤ 14). */
  function scheduleNext(task, n, { show = true } = {}) {
    const today = startOfDay(new Date());
    const need = n || Math.max(1, task.estimate - (task.completedPomodoros || 0));
    for (let i = 0; i < 14; i++) {
      const day = addDays(today, i);
      const slots = slotsFor(day, task, need);
      if (!slots.length) continue;
      const created = slots.map((x) => makeBlock({ title: task.title, start: dateAt(day, x.start), end: dateAt(day, x.end), taskID: task.id }));
      const step = commitBlocks('Schedule task', (list) => { list.push(...created); });
      if (!step) return null;
      const first = created[0];
      if (show && isVisible()) reveal(new Date(first.start)); else { invalidate(); scheduleRender(); }
      undoToastFor(step, `Scheduled “${task.title}” · ${i === 0 ? 'Today' : F.medium.format(new Date(first.start))}, ${timeRange(new Date(first.start), new Date(created[created.length - 1].end))}`);
      return created;
    }
    toast('No free time in the next two weeks.');
    return null;
  }

  /* H16 — CalendarView.scheduleTask(taskID, {n, start}) → [blocks] | null.
     Without `start`: the next free slot(s) (the ⤓ rule). With `start` (a drop on the grid):
     one linked focus block of up to `interval` pomodoros starting there. Undo + toast either way;
     the view only jumps when the calendar is on screen. */
  function scheduleTask(taskID, opts = {}) {
    const t = taskById(taskID);
    if (!t) return null;
    if (t.isDone) { toast('That task is already done'); return null; }
    const s = pomoSettings();
    const left = Math.max(1, (t.estimate || 1) - (t.completedPomodoros || 0));
    const n = Math.max(1, Math.min(Number(opts.n) || left, 99));
    if (!opts.start) return scheduleNext(t, n);
    let start = new Date(opts.start);
    if (Number.isNaN(+start)) return null;
    start = new Date(Math.round(+start / SNAP_MS) * SNAP_MS);
    const k = Math.min(n, s.interval);
    const end = new Date(Math.min(+start + blockMinutes(k, s) * 60000, +addDays(startOfDay(start), 1)));
    const b = makeBlock({ title: t.title, start, end, taskID: t.id });
    const step = commitBlocks('Schedule task', (list) => { list.push(b); });
    if (!step) return null;
    invalidate();
    render();
    const dn = dayIndex(new Date(), start);
    undoToastFor(step, `Scheduled “${t.title}” · ${dn === 0 ? 'Today' : dn === 1 ? 'Tomorrow' : F.medium.format(start)}, ${timeRange(start, end)}`);
    return [b];
  }

  // Bring a date into view (and the time grid to that time), then render.
  function reveal(d) {
    if (!inView(d)) anchor = startOfDay(d);
    const v = currentView();
    if (v === 'day' || v === 'week') scrollMem = Math.max(0, minuteOfDay(d) * MIN_PX - 90);
    render();
  }

  function newEventNow() {
    const v = currentView();
    const today = startOfDay(new Date());
    let day = anchor;
    if (v === 'week') day = weekDays().find((x) => sameDay(x, today)) || weekDays()[0];
    else if (v === 'agenda' || (v === 'month' && inView(today))) day = today;
    if (day < today) day = today;
    let start = sameDay(day, today) ? new Date(ceilSnap(Date.now())) : dateAt(day, 9 * 60);
    const lim = addDays(startOfDay(start), 1);
    let end = new Date(Math.min(+start + 60 * 60000, +lim));
    if (+end - +start < 30 * 60000) {
      day = addDays(today, 1);
      start = dateAt(day, 9 * 60);
      end = dateAt(day, 10 * 60);
    }
    const b = createAndEdit({ start, end }, { reveal: true, anchorEl: ui.newBtn });
    return b;
  }

  function createAndEdit(spec, { reveal: rv = false, anchorEl = null } = {}) {
    const b = makeBlock(spec);
    const step = commitBlocks('Add block', (list) => { list.push(b); });
    if (!step) return null;
    if (rv) reveal(new Date(b.start)); else render();
    openPopover(b.id, anchorFor(b.id) ? null : anchorEl, { isNew: true, step });
    return b;
  }

  /* Start focus from a block (SPEC §1.4.6) with the switch confirmation. */
  async function startFocus(taskID, block) {
    const t = taskById(taskID);
    if (!t || t.isDone) { toast('That task is already done'); return; }
    if (block && new Date(block.end).getTime() <= Date.now()) { toast('That block is over.'); return; }
    closePopover();
    let plan = null;
    if (block && block.source === 'local') {
      const day = startOfDay(new Date(block.start));
      const same = localBlocks().filter((b) => b.taskID && lowerEq(b.taskID, block.taskID) && sameDay(new Date(b.start), day))
        .sort((a, b) => new Date(a.start) - new Date(b.start));
      plan = { blockID: block.id, title: titleOf(block), index: Math.max(1, same.findIndex((b) => b.id === block.id) + 1), total: Math.max(1, same.length), end: block.end };
    }
    if (typeof Timer === 'undefined' || !Timer.startFocus) { Store.setActiveTask(t.id); App.showView('focus'); return; }
    let r = Timer.startFocus({ taskID: t.id, plan, force: false });
    if (r && r.status === 'needsConfirmation') {
      const ok = await confirmSwitch(t.title, r.currentMinutes);
      if (!ok) return;
      r = Timer.startFocus({ taskID: t.id, plan, force: true });
    }
    if (r && r.status === 'unavailable') toast('That block can’t start a focus session.');
    else if (r && r.status === 'alreadyFocusing') { toast('You’re already focusing on this', 'success'); App.showView('focus'); }
  }

  /* A small glass confirmation dialog → Promise<bool>. */
  function confirmDialog({ title, body, ok = 'OK', cancel = 'Cancel', danger = false }) {
    return new Promise((resolve) => {
      const prevFocus = document.activeElement;
      const close = (v) => { back.remove(); dlg.remove(); document.removeEventListener('keydown', onKey2, true); try { prevFocus && prevFocus.focus(); } catch (_) {} resolve(v); };
      const onKey2 = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(false); } };
      const back = h('div', { class: 'cal-confirm-back', onclick: () => close(false) });
      const okBtn = h('button', { class: 'btn btn-sm ' + (danger ? 'cal-btn-danger' : 'btn-primary'), type: 'button', onclick: () => close(true) }, ok);
      const dlg = h('div', { class: 'cal-confirm', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title },
        h('h3', { class: 'cal-confirm-title', text: title }),
        body ? h('p', { class: 'cal-confirm-body', text: body }) : null,
        h('div', { class: 'cal-confirm-actions' },
          h('button', { class: 'btn btn-sm', type: 'button', onclick: () => close(false) }, cancel), okBtn));
      document.body.appendChild(back);
      document.body.appendChild(dlg);
      document.addEventListener('keydown', onKey2, true);
      okBtn.focus();
    });
  }

  function confirmSwitch(title, minutes) {
    return confirmDialog({ title: `Switch to “${title}”?`, body: `Your current session (${Math.max(0, Math.round(minutes || 0))} min) will be logged.`, ok: 'Switch', cancel: 'Keep going' });
  }

  /* Deletes a block (past or future) with an Undo toast. A calendar task is one item with its
     task: deleting it deletes the task too (TaskSync's toast brings both back). */
  function deleteEvent(id) {
    const e = findLocal(id);
    if (!e) return;
    if (pop && pop.id === id) { pop.el.remove(); pop = null; markActive(null); }
    if (e.isTask && taskById(e.taskID) && typeof TaskSync !== 'undefined' && TaskSync.remove) {
      TaskSync.remove(e.taskID);
      invalidate();
      if (findLocal(id)) commitBlocks('Delete block', (list) => { const i = list.findIndex((b) => b.id === id); if (i >= 0) list.splice(i, 1); });
      render();
      return;
    }
    const step = commitBlocks('Delete block', (list) => { const i = list.findIndex((b) => b.id === id); if (i >= 0) list.splice(i, 1); });
    render();
    if (step) undoToastFor(step, `Deleted “${titleOf(e).slice(0, 40)}”`);
  }

  // ───────────────────────────  pointer gestures  ───────────────────────────

  // ── H16: drop a task (HTML5 drag from Today's Tasks, type TASK_DRAG) onto the grid or a month day ──
  const TASK_DRAG = 'application/x-purefocus-task';
  let dropGhost = null;
  function hasTaskDrag(ev) {
    const t = ev.dataTransfer && ev.dataTransfer.types;
    return !!t && Array.from(t).includes(TASK_DRAG);
  }
  function clearDropGhost() {
    if (dropGhost) dropGhost.remove();
    dropGhost = null;
    if (ui.main) ui.main.querySelectorAll('.is-drop-target').forEach((x) => x.classList.remove('is-drop-target'));
  }
  // the 15-min slot under the pointer (2:05 → 2:00)
  function dropMinute(col, y) { return Math.floor(minuteAt(col, y) / SNAP) * SNAP; }
  function onMainDragOver(ev) {
    if (!hasTaskDrag(ev) || previewing()) return;
    const col = ev.target.closest && ev.target.closest('.cal-col');
    const cell = !col && ev.target.closest && ev.target.closest('.cal-mcell');
    if (!col && !cell) return;
    ev.preventDefault();
    try { ev.dataTransfer.dropEffect = 'copy'; } catch (_) {}
    if (cell) {
      if (!cell.classList.contains('is-drop-target')) { clearDropGhost(); cell.classList.add('is-drop-target'); }
      return;
    }
    const day = colDay(col);
    const len = blockMinutes(1);
    const a = clamp(dropMinute(col, ev.clientY), 0, 1440 - SNAP);
    if (!dropGhost) {
      dropGhost = h('div', { class: 'cal-ev is-ghost is-drop-ghost', 'aria-hidden': 'true' },
        h('div', { class: 'cal-ev-title' }, h('span', { class: 'cal-ev-name', text: 'Drop to schedule' })),
        h('div', { class: 'cal-ev-time' }));
    }
    if (dropGhost.parentNode !== col) col.appendChild(dropGhost);
    dropGhost.style.top = `${a * MIN_PX}px`;
    dropGhost.style.height = `${Math.max(18, len * MIN_PX - 2)}px`;
    dropGhost.style.left = '2px';
    dropGhost.style.width = 'calc(100% - 5px)';
    dropGhost.querySelector('.cal-ev-time').textContent = shortTime(dateAt(day, a));
  }
  function onMainDragLeave(ev) {
    if (!ui.main || (ev.relatedTarget && ui.main.contains(ev.relatedTarget))) return;
    clearDropGhost();
  }
  function onMainDrop(ev) {
    if (!hasTaskDrag(ev)) return;
    const col = ev.target.closest && ev.target.closest('.cal-col');
    const cell = !col && ev.target.closest && ev.target.closest('.cal-mcell');
    clearDropGhost();
    if (!col && !cell) return;
    ev.preventDefault();
    let id = '';
    try { id = ev.dataTransfer.getData(TASK_DRAG) || ev.dataTransfer.getData('text/plain'); } catch (_) {}
    const t = taskById(String(id || '').trim());
    if (!t) return;
    if (col) { scheduleTask(t.id, { start: dateAt(colDay(col), dropMinute(col, ev.clientY)) }); return; }
    const day = parseDayKey(cell.dataset.day);
    if (!day) return;
    if (day < startOfDay(new Date())) { scheduleTask(t.id, { start: dateAt(day, 9 * 60), n: 1 }); return; }
    const slots = slotsFor(day, t, Math.max(1, (t.estimate || 1) - (t.completedPomodoros || 0)));
    if (!slots.length) { toast(`No free time on ${F.medium.format(day)}`); return; }
    scheduleTask(t.id, { start: dateAt(day, slots[0].start), n: slots[0].pomodoros || 1 });
  }
  /* Spring-load: hovering a dragged task over the Calendar tab opens the calendar. */
  function installSpringLoad() {
    let timer = null;
    const tabOf = (ev) => ev.target && ev.target.closest && ev.target.closest('[data-view="calendar"]');
    document.addEventListener('dragover', (ev) => {
      if (!hasTaskDrag(ev) || !tabOf(ev)) { if (timer && !tabOf(ev)) { clearTimeout(timer); timer = null; } return; }
      ev.preventDefault();
      if (!timer && !isVisible()) timer = setTimeout(() => { timer = null; try { App.showView('calendar'); } catch (_) {} }, 450);
    });
    document.addEventListener('dragend', () => { if (timer) clearTimeout(timer); timer = null; clearDropGhost(); });
    document.addEventListener('drop', () => { if (timer) clearTimeout(timer); timer = null; });
  }

  function colAt(x) {
    if (!ui.grid) return null;
    const cols = Array.from(ui.grid.querySelectorAll('.cal-col'));
    if (!cols.length) return null;
    let best = cols[0], bestD = Infinity;
    for (const c of cols) {
      const r = c.getBoundingClientRect();
      if (x >= r.left && x < r.right) return c;
      const dd = Math.min(Math.abs(x - r.left), Math.abs(x - r.right));
      if (dd < bestD) { bestD = dd; best = c; }
    }
    return best;
  }

  function minuteAt(col, y) {
    const r = col.getBoundingClientRect();
    return clamp((y - r.top) / MIN_PX, 0, 1440);
  }

  function colDay(col) { return parseDayKey(col.dataset.day); }

  function showGhost(col, a, b, title, color, timeText) {
    if (!drag.ghost) {
      drag.ghost = h('div', { class: 'cal-ev is-ghost', 'aria-hidden': 'true' },
        h('div', { class: 'cal-ev-title' }, h('span', { class: 'cal-ev-name' })),
        h('div', { class: 'cal-ev-time' }));
    }
    const g = drag.ghost;
    if (g.parentNode !== col) col.appendChild(g);
    const day = colDay(col);
    const bb = Math.min(1440, b);
    g.style.setProperty('--ev', color || 'var(--focus-tint)');
    g.style.top = `${a * MIN_PX}px`;
    g.style.height = `${Math.max(18, (bb - a) * MIN_PX - 2)}px`;
    g.style.left = '2px';
    g.style.width = 'calc(100% - 5px)';
    g.classList.toggle('is-compact', bb - a < 45);
    g.querySelector('.cal-ev-name').textContent = title;
    g.querySelector('.cal-ev-time').textContent = timeText || timeRange(dateAt(day, a), dateAt(day, b));
  }

  function hideGhost() { if (drag && drag.ghost) drag.ghost.remove(); }

  function beginDrag(state, ev) {
    drag = { ...state, x0: ev.clientX, y0: ev.clientY, moved: false, pointerId: ev.pointerId };
    document.addEventListener('pointermove', onDragMove);
    document.addEventListener('pointerup', onDragEnd);
    document.addEventListener('pointercancel', cancelDrag);
  }

  function endDragListeners() {
    document.removeEventListener('pointermove', onDragMove);
    document.removeEventListener('pointerup', onDragEnd);
    document.removeEventListener('pointercancel', cancelDrag);
    document.body.classList.remove('cal-dragging');
  }

  function cleanupDrag(d) {
    if (d.ghost) d.ghost.remove();
    if (d.block) d.block.classList.remove('is-lifted');
    if (d.chip) d.chip.remove();
    if (d.item) d.item.classList.remove('is-dragging');
    if (d.dropCell) d.dropCell.classList.remove('is-drop');
  }

  function cancelDrag() {
    if (!drag) return;
    const d = drag;
    drag = null;
    endDragListeners();
    cleanupDrag(d);
    if (d.moved) render();                   // a swipe that became a scroll keeps its scroller
  }

  function previewing() { return !!v2.preview; }

  function onGridPointerDown(ev) {
    lastPointer = { x: ev.clientX, y: ev.clientY };
    if (ev.button !== 0 || drag) return;
    if (ev.target.closest('.cal-ev-play, .cal-ev-check, .cal-ev-more, .cal-due') || ev.target.closest('.pf-ghost')) return;
    const col = ev.target.closest('.cal-col');
    if (!col) return;
    const block = ev.target.closest('.cal-ev');
    if (block && !block.classList.contains('is-ghost')) {
      const e = findEvent(block.dataset.id);
      if (!e) return;
      if (ev.pointerType !== 'touch') ev.preventDefault();
      const locked = e.readOnly || previewing();
      if (locked || ev.pointerType === 'touch') { beginDrag({ kind: 'click', id: e.id }, ev); return; }
      const day = colDay(col);
      if (ev.target.closest('.cal-ev-resize')) {
        beginDrag({ kind: 'resize', id: e.id, block, col, day }, ev);
      } else {
        const pointerMs = +dateAt(day, minuteAt(col, ev.clientY));
        const offsetMin = (pointerMs - +new Date(e.start)) / 60000;
        const durMin = (new Date(e.end) - new Date(e.start)) / 60000;
        beginDrag({ kind: 'move', id: e.id, block, offsetMin, durMin }, ev);
      }
      return;
    }
    if (previewing()) return;
    if (suppressCreate) { suppressCreate = false; return; }
    const a0 = Math.floor(minuteAt(col, ev.clientY) / SNAP) * SNAP;
    if (ev.pointerType === 'touch') { beginDrag({ kind: 'tap', col, a0 }, ev); return; }
    ev.preventDefault();
    beginDrag({ kind: 'create', col, a0 }, ev);
  }

  function onTrayPointerDown(ev) {
    if (ev.button !== 0 || drag || ev.pointerType === 'touch' || previewing()) return;
    if (ev.target.closest('button')) return;
    const item = ev.target.closest('.cal-task');
    if (!item) return;
    const task = taskById(item.dataset.id);
    if (!task) return;
    ev.preventDefault();
    const row = unscheduledTasks().find((r) => r.task.id === task.id);
    const s = pomoSettings();
    const n = Math.min(row ? row.n : 1, s.interval);
    beginDrag({ kind: 'tray', task, item, dur: blockMinutes(n, s) }, ev);
  }

  function autoScroll(y) {
    if (!ui.scroll) return;
    const r = ui.scroll.getBoundingClientRect();
    const topH = (ui.scroll.querySelector('.cal-tg-top') || { offsetHeight: 0 }).offsetHeight;
    if (y < r.top + topH + 28 && y > r.top - 40) ui.scroll.scrollTop -= 14;
    else if (y > r.bottom - 28 && y < r.bottom + 40) ui.scroll.scrollTop += 14;
  }

  function onDragMove(ev) {
    if (!drag || ev.pointerId !== drag.pointerId) return;
    lastPointer = { x: ev.clientX, y: ev.clientY };
    if (!drag.moved) {
      if (Math.hypot(ev.clientX - drag.x0, ev.clientY - drag.y0) < 4) return;
      drag.moved = true;
      if (drag.kind === 'click' || drag.kind === 'tap') { drag.kind = 'none'; return; }
      document.body.classList.add('cal-dragging');
      if (drag.block) drag.block.classList.add('is-lifted');
      if (drag.kind === 'tray') {
        drag.chip = h('div', { class: 'cal-drag-chip', vars: { '--ev': drag.task.category ? catColor(drag.task.category) : 'var(--focus-tint)' } },
          h('span', { class: 'cal-drag-title', text: drag.task.title }),
          h('span', { class: 'cal-drag-dur', text: fmtDur(drag.dur) }));
        document.body.appendChild(drag.chip);
        drag.item.classList.add('is-dragging');
      }
    }
    if (drag.kind === 'none') return;
    autoScroll(ev.clientY);

    if (drag.kind === 'create') {
      const cur = snapMin(minuteAt(drag.col, ev.clientY));
      let a, b;
      if (cur > drag.a0) { a = drag.a0; b = cur; } else { a = cur; b = drag.a0 + SNAP; }
      if (b - a < SNAP) b = a + SNAP;
      drag.a = a; drag.b = Math.min(1440, b);
      showGhost(drag.col, drag.a, drag.b, 'New block', 'var(--focus-tint)');
    } else if (drag.kind === 'move') {
      const e = findEvent(drag.id);
      const col = colAt(ev.clientX);
      if (!e || !col) return;
      const m = clamp(snapMin(minuteAt(col, ev.clientY) - drag.offsetMin), 0, 1440 - SNAP);
      drag.col = col; drag.a = m;
      const day = colDay(col);
      showGhost(col, m, m + Math.max(SNAP, drag.durMin), titleOf(e), colorOf(e),
        timeRange(dateAt(day, m), new Date(+dateAt(day, m) + drag.durMin * 60000)));
    } else if (drag.kind === 'resize') {
      const e = findEvent(drag.id);
      if (!e) return;
      const startMs = +new Date(e.start);
      const segA = startMs < +drag.day ? 0 : minuteOfDay(new Date(e.start));
      const minEnd = Math.max(segA + SNAP, Math.ceil((startMs + SNAP_MS - +drag.day) / 60000));
      const b = clamp(snapMin(minuteAt(drag.col, ev.clientY)), minEnd, 1440);
      drag.b = b;
      showGhost(drag.col, segA, b, titleOf(e), colorOf(e), timeRange(new Date(e.start), dateAt(drag.day, b)));
    } else if (drag.kind === 'tray') {
      drag.chip.style.transform = `translate(${ev.clientX + 14}px, ${ev.clientY + 12}px)`;
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const col = under && under.closest('#view-calendar .cal-col');
      const cell = under && under.closest('#view-calendar .cal-mcell');
      if (drag.dropCell && drag.dropCell !== cell) { drag.dropCell.classList.remove('is-drop'); drag.dropCell = null; }
      drag.col = null;
      if (col) {
        const m = clamp(snapMin(minuteAt(col, ev.clientY) - SNAP), 0, Math.max(0, 1440 - drag.dur));
        drag.col = col; drag.a = m;
        showGhost(col, m, m + drag.dur, drag.task.title, drag.task.category ? catColor(drag.task.category) : 'var(--focus-tint)');
        drag.chip.classList.add('is-over');
      } else {
        hideGhost();
        drag.chip.classList.toggle('is-over', !!cell);
        if (cell) { cell.classList.add('is-drop'); drag.dropCell = cell; }
      }
    }
  }

  function onDragEnd(ev) {
    if (!drag || ev.pointerId !== drag.pointerId) return;
    const d = drag;
    drag = null;
    endDragListeners();
    cleanupDrag(d);
    lastPointer = { x: ev.clientX, y: ev.clientY };

    if (d.kind === 'none') return;
    if (d.kind === 'click') { openPopover(d.id, null); return; }
    if (d.kind === 'tap' || (d.kind === 'create' && !d.moved)) {
      const day = colDay(d.col);
      let a = d.kind === 'tap' ? clamp(Math.floor(d.a0 / 30) * 30, 0, 1440 - 60) : clamp(d.a0, 0, 1440 - 60);
      if (sameDay(day, new Date())) {
        const floor = Math.floor(minuteOfDay(new Date()) / SNAP) * SNAP;
        if (a < floor && d.a0 >= floor - SNAP) a = floor;   // a click in the current slot starts now
      }
      createAndEdit({ start: dateAt(day, a), end: dateAt(day, Math.min(1440, a + 60)) });
      return;
    }
    if (d.kind === 'create') {
      createAndEdit({ start: dateAt(colDay(d.col), d.a), end: dateAt(colDay(d.col), d.b) });
      return;
    }
    if (d.kind === 'move' || d.kind === 'resize') {
      const e = findLocal(d.id);
      if (!d.moved) { openPopover(d.id, null); return; }
      if (e && d.kind === 'move' && d.col) {
        const ms = +new Date(e.end) - +new Date(e.start);
        const start = dateAt(colDay(d.col), d.a);
        commitBlocks('Move block', (list) => {
          const b = list.find((x) => x.id === d.id);
          if (!b) return false;
          b.start = start.toISOString();
          b.end = new Date(+start + ms).toISOString();
        });
      } else if (e && d.kind === 'resize' && d.b != null) {
        commitBlocks('Resize block', (list) => {
          const b = list.find((x) => x.id === d.id);
          if (!b) return false;
          b.end = dateAt(d.day, d.b).toISOString();
        });
      }
      render();
      return;
    }
    if (d.kind === 'tray' && d.moved) {
      const t = d.task;
      let start = null;
      if (d.col) start = dateAt(colDay(d.col), d.a);
      else if (d.dropCell) {
        const day = parseDayKey(d.dropCell.dataset.day);
        const today = startOfDay(new Date());
        if (day && day >= today) {
          const slots = slotsFor(day, t, Math.max(1, capacity(d.dur)));
          if (slots.length) start = dateAt(day, slots[0].start);
        } else if (day) start = dateAt(day, 9 * 60);
      }
      if (start) {
        const end = new Date(+start + d.dur * 60000);
        const b = makeBlock({ title: t.title, start, end, taskID: t.id });
        const step = commitBlocks('Schedule task', (list) => { list.push(b); });
        if (step) undoToastFor(step, `Scheduled “${t.title}” · ${F.medium.format(start)}, ${timeRange(start, new Date(b.end))}`);
      }
    }
    render();
  }

  function onBlockKey(ev) {
    const block = ev.target.closest && ev.target.closest('.cal-ev');
    if (!block) return;
    const e = findEvent(block.dataset.id);
    if (!e) return;
    if (ev.key === 'Enter' && !ev.target.closest('.cal-ev-check, .cal-ev-play')) { ev.preventDefault(); openPopover(e.id, block); }
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && !e.readOnly && !previewing()) { ev.preventDefault(); deleteEvent(e.id); }
  }

  // ───────────────────────────  popovers  ───────────────────────────

  function anchorFor(id) {
    if (!ui.main || !id) return null;
    const q = cssEsc(id);
    return ui.main.querySelector(`.cal-ev[data-id="${q}"], .cal-adpill[data-id="${q}"], .cal-mpill[data-id="${q}"], .cal-ag-row[data-id="${q}"], .cal-due[data-id="${q}"]`)
      || ui.main.querySelector(`.cal-ev-more[data-ids~="${q}"]`);     // folded into a "+N" strip
  }

  function openPopover(id, anchorEl, opts = {}) {
    closeMenu();
    if (pop) { const prev = pop; pop = null; prev.el.remove(); finalizeClosed(prev, prev.id !== id); }
    let el;
    let session = null;
    if (String(id).startsWith('due:')) {
      const d = findDue(id);
      if (!d) return;
      el = buildDueDetails(d);
    } else {
      const e = findEvent(id);
      if (!e) return;
      if (e.readOnly) el = buildDetails(e);
      else {
        session = { before: clone(e), step: opts.step || null };
        el = buildEditor(e, session);
      }
    }
    const keepAnchor = anchorEl && anchorEl.isConnected && !(ui.main && ui.main.contains(anchorEl));
    pop = { el, id, isNew: !!opts.isNew, anchor: keepAnchor ? anchorEl : null, session };
    document.body.appendChild(el);
    positionPop();
    markActive(id);
    const focusEl = opts.isNew ? el.querySelector('.cal-pop-title') : el.querySelector('.cal-pop-close');
    if (focusEl) focusEl.focus({ preventScroll: true });
  }

  function openNotice(el, anchorEl) {
    closeMenu();
    closePopover();
    pop = { el, id: null, isNew: false, anchor: anchorEl || null, below: true };
    document.body.appendChild(el);
    positionPop();
    const f = el.querySelector('.btn-primary');
    if (f) f.focus({ preventScroll: true });
  }

  function positionPop() {
    if (!pop) return;
    const el = pop.el;
    const narrow = window.innerWidth < 700;
    el.classList.toggle('is-sheet', narrow);
    if (narrow) { el.style.left = ''; el.style.top = ''; return; }
    const target = (pop.id && anchorFor(pop.id)) || pop.anchor;
    let rect = target && target.isConnected ? target.getBoundingClientRect()
      : { left: lastPointer.x, right: lastPointer.x, top: lastPointer.y, bottom: lastPointer.y, width: 0 };
    if (rect.width > 340) {
      const y = clamp(lastPointer.y, rect.top, rect.bottom);
      rect = { left: lastPointer.x, right: lastPointer.x, top: y - 30, bottom: y, width: 0 };
    }
    const w = el.offsetWidth, hgt = el.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    if (pop.below) {
      el.style.left = `${Math.round(clamp(rect.right - w, 12, vw - w - 12))}px`;
      el.style.top = `${Math.round(clamp(rect.bottom + 8, 12, Math.max(12, vh - hgt - 12)))}px`;
      return;
    }
    let left = rect.right + 10;
    let top = rect.top;
    if (left + w > vw - 12) left = rect.left - w - 10;
    if (left < 12) {
      left = clamp(rect.left + rect.width / 2 - w / 2, 12, vw - w - 12);
      top = rect.bottom + 8;
      if (top + hgt > vh - 12) top = rect.top - hgt - 8;
    }
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(clamp(top, 12, Math.max(12, vh - hgt - 12)))}px`;
  }

  function closePopover(discard = false) {
    if (!pop) return;
    const prev = pop;
    pop = null;
    prev.el.remove();
    markActive(null);
    finalizeClosed(prev, discard);
    render();
  }

  /* Ends an editor session: a cancelled, still-empty new block is removed (its "Add block"
     step disappears too); otherwise the live edits fold into ONE undo step. */
  function finalizeClosed(prev, discard) {
    if (!prev.session) return;
    const id = prev.id;
    const cur = findLocal(id);
    if (prev.isNew) {
      const empty = cur && !String(cur.title || '').trim() && !cur.taskID && !cur.notes;
      if (discard && empty) {
        const list = Store.blocks().map(clone).filter((b) => b.id !== id);
        Store.setBlocks(list);
        invalidate();
        const i = v2.undo.indexOf(prev.session.step);
        if (i >= 0) v2.undo.splice(i, 1);
        return;
      }
      // fold the edits into the creation step: redo recreates the edited block
      const step = prev.session.step;
      if (step && cur) { for (const c of step.changes) if (c.id === id) c.to = clone(cur); }
      return;
    }
    if (!cur) return;
    const before = prev.session.before;
    if (JSON.stringify(before) === JSON.stringify(cur)) return;
    const step = diffStep('Edit block', [before], [clone(cur)]);
    if (step) pushUndo(step);
  }

  function popHead(color, titleNode) {
    return h('div', { class: 'cal-pop-head' },
      h('span', { class: 'cal-pop-dot', vars: { '--ev': color } }),
      titleNode,
      h('button', { class: 'icon-btn small cal-pop-close', type: 'button', 'aria-label': 'Close', onclick: () => closePopover() }, icon('x')));
  }

  /* Live edits write straight to the store (no undo per keystroke); the session folds them. */
  function liveEdit(id, fn, { rerender = true } = {}) {
    const list = Store.blocks().map(clone);
    const b = list.find((x) => x.id === id);
    if (!b) return null;
    const prev = clone(b);
    fn(b);
    const err = validate(prev, b);
    if (err) { toast(err); return null; }
    Store.setBlocks(list);
    invalidate();
    if (rerender) { render(); positionPop(); }
    return b;
  }

  function buildEditor(e, session) {
    const id = e.id;
    const cur = () => findLocal(id) || e;
    const linked = () => taskById(cur().taskID);
    const stamp = () => new Date().toISOString();

    const titleIn = h('input', {
      class: 'cal-pop-title', type: 'text', maxlength: '120', 'aria-label': 'Title',
      placeholder: linked() ? linked().title : 'Add title', value: e.title, autocomplete: 'off',
    });
    let titleSync = 0;
    titleIn.addEventListener('input', () => {
      liveEdit(id, (b) => { b.title = titleIn.value.slice(0, 120); b.updatedAt = stamp(); });
      // A task made from this block keeps its name (TaskSync handles blocks titled like their task).
      clearTimeout(titleSync);
      titleSync = setTimeout(() => {
        const t = linked(), v = titleIn.value.trim().slice(0, 120);
        if (t && cur().ownsTask && v && t.title !== v) Store.updateTask(t.id, { title: v });
      }, 300);
    });
    titleIn.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); closePopover(); } });

    // ── when ──
    const s0 = new Date(e.start), e0 = new Date(e.end);
    const dateIn = h('input', { class: 'text-input cal-pop-date', type: 'date', 'aria-label': 'Date', value: dayKey(s0) });
    const startIn = h('input', { class: 'text-input cal-pop-time', type: 'time', step: '900', 'aria-label': 'Start time', value: hhmm(s0) });
    const endIn = h('input', { class: 'text-input cal-pop-time', type: 'time', step: '900', 'aria-label': 'End time', value: hhmm(e0) });
    const allDayIn = h('input', { type: 'checkbox' });
    allDayIn.checked = !!e.allDay;
    const durLbl = h('span', { class: 'cal-pop-dur' });
    const times = h('div', { class: 'cal-pop-line cal-pop-times' }, startIn, h('span', { class: 'cal-pop-dash', text: '–' }), endIn, durLbl);
    times.hidden = !!e.allDay;
    const showDur = () => {
      const b = cur();
      const len = Math.round((new Date(b.end) - new Date(b.start)) / 60000);
      const cap = b.taskID && !b.allDay ? capacity(len) : 0;
      durLbl.textContent = b.allDay ? '' : `${fmtDur(len)}${b.taskID && cap ? ` · ${cap} pomodoro${cap === 1 ? '' : 's'}` : ''}`;
    };

    const parseT = (v) => { const m = /^(\d{1,2}):(\d{2})/.exec(v || ''); return m ? +m[1] * 60 + +m[2] : null; };
    const applyTime = (changed) => {
      const before = findLocal(id);
      if (!before) return;
      const day = parseDayKey(dateIn.value) || startOfDay(new Date(before.start));
      const updated = liveEdit(id, (b) => {
        if (allDayIn.checked) {
          const span = b.allDay ? Math.max(1, dayIndex(...allDayRange(b))) : 1;
          b.allDay = true;
          b.start = day.toISOString();
          b.end = addDays(day, span).toISOString();
          b.startDay = dayKey(day);
          b.endDay = dayKey(addDays(day, span));
        } else {
          const wasAllDay = b.allDay;
          const prevDur = wasAllDay ? 60 : Math.max(SNAP, Math.round((new Date(b.end) - new Date(b.start)) / 60000));
          b.allDay = false;
          b.startDay = null;
          b.endDay = null;
          let sm = parseT(startIn.value);
          if (sm == null || wasAllDay) sm = wasAllDay ? 9 * 60 : minuteOfDay(new Date(b.start));
          const start = dateAt(day, sm);
          let end;
          if (changed === 'end') {
            let em = parseT(endIn.value);
            if (em == null) em = sm + prevDur;
            end = em === 0 ? addDays(day, 1) : dateAt(day, em);
          } else {
            end = new Date(Math.min(+start + prevDur * 60000, +addDays(day, 1)));
          }
          b.start = start.toISOString();
          b.end = end.toISOString();
          scrollMem = Math.max(0, sm * MIN_PX - 90);
        }
      }, { rerender: false });
      const now = cur();
      dateIn.value = dayKey(new Date(now.start));
      startIn.value = hhmm(new Date(now.start));
      endIn.value = hhmm(new Date(now.end));
      allDayIn.checked = !!now.allDay;
      times.hidden = !!now.allDay;
      if (updated && !inView(new Date(updated.start))) anchor = startOfDay(new Date(updated.start));
      refresh();
      render();
      positionPop();
    };
    dateIn.addEventListener('change', () => applyTime('date'));
    startIn.addEventListener('change', () => applyTime('start'));
    endIn.addEventListener('change', () => applyTime('end'));
    allDayIn.addEventListener('change', () => applyTime('allday'));

    const head = popHead(colorOf(e), titleIn);
    const paintDot = () => head.querySelector('.cal-pop-dot').style.setProperty('--ev', colorOf(cur()));

    // ── Event | Task: a task has a checkbox here and on the calendar, and shows in Today's Tasks ──
    const typeSeg = h('div', { class: 'segmented cal-pop-type', role: 'radiogroup', 'aria-label': 'Event or task' });
    const drawType = () => {
      typeSeg.textContent = '';
      const isTask = !!cur().taskID;
      for (const [k, label, tip] of [['event', 'Event', 'Just a time on your calendar'],
        ['task', 'Task', 'Gets a checkbox, and shows in Today’s Tasks on the Focus page']]) {
        const on = (k === 'task') === isTask;
        typeSeg.appendChild(h('button', {
          class: 'seg-btn' + (on ? ' is-active' : ''), type: 'button', role: 'radio', 'aria-checked': String(on), title: tip,
          onclick: () => { if (on) return; if (k === 'task') makeTask(); else makeEvent(); },
        }, icon(k === 'task' ? 'tasks' : 'calendar'), h('span', { text: label })));
      }
    };
    const makeTask = () => {
      const b = cur();
      if (b.taskID) return;
      const title = String(titleIn.value || b.title || '').trim().slice(0, 120) || 'Untitled task';
      const c = courseById(b.courseID);
      const len = Math.round((new Date(b.end) - new Date(b.start)) / 60000);
      const t = Store.addTask({ title, estimate: b.allDay ? 1 : Math.max(1, capacity(len)),
        courseID: c ? c.id : null, course: c ? courseLabel(c).slice(0, 40) : null });
      if (!t) return;
      liveEdit(id, (x) => { x.taskID = t.id; x.isTask = true; x.ownsTask = true; x.category = null; x.updatedAt = stamp(); });
      const day = startOfDay(new Date(b.start));
      toast(day > startOfDay(new Date())
        ? `Added to Today’s Tasks · under Upcoming until ${F.medium.format(day)}`
        : 'Added to Today’s Tasks on the Focus page', 'success');
      refresh();
    };
    const makeEvent = () => {
      const t = linked();
      const own = !!(t && cur().ownsTask);
      liveEdit(id, (x) => {
        if (t && !String(x.title || '').trim()) x.title = t.title.slice(0, 120);
        x.taskID = null; x.isTask = false; x.ownsTask = false; x.category = null; x.updatedAt = stamp();
      });
      // a task that existed only for this block goes with it
      if (own && !Store.blocks().some((x) => x.taskID && lowerEq(x.taskID, t.id))) Store.deleteTask(t.id);
      titleIn.value = cur().title || '';
      refresh();
    };

    // the linked task: done ✓, progress, due, and which task it is
    const taskCard = h('div', { class: 'cal-pop-taskcard' });
    const drawTaskCard = () => {
      taskCard.textContent = '';
      const t = linked();
      taskCard.hidden = !t;
      const row = taskCard.closest('.cal-pop-taskrow');
      if (row) row.hidden = !t;
      if (!t) return;
      const cb = h('input', { type: 'checkbox', class: 'cal-pop-taskdone', 'aria-label': `Mark “${t.title}” done` });
      cb.checked = !!t.isDone;
      cb.addEventListener('change', () => { setTaskDone(t.id, cb.checked, id); refresh(); });
      const meta = [`${t.completedPomodoros || 0} of ${t.estimate || 1} pomodoro${(t.estimate || 1) === 1 ? '' : 's'} done`];
      if (t.dueDate) meta.push(dueLabel(t.dueDate));
      if (!t.isDone) meta.push('in Today’s Tasks');
      taskCard.appendChild(h('label', { class: 'cal-pop-taskline', title: t.isDone ? 'Mark as not done' : 'Mark the task done' },
        cb, h('span', { class: 'cal-pop-taskname' + (t.isDone ? ' is-done' : ''), text: t.title })));
      taskCard.appendChild(h('div', { class: 'cal-pop-taskmeta', text: meta.join(' · ') }));
      const others = Store.tasks().filter((x) => (!x.isDone || lowerEq(x.id, t.id)));
      if (others.length > 1) {
        const sel = h('select', { class: 'select cal-pop-task', 'aria-label': 'Which task this is' },
          others.map((x) => h('option', { value: x.id }, x.isDone ? `${x.title} (done)` : x.title)));
        sel.value = t.id;
        sel.addEventListener('change', () => {
          const prev = linked();
          const own = !!(prev && cur().ownsTask);
          liveEdit(id, (b) => {
            b.taskID = sel.value || null;
            b.isTask = !!b.taskID; b.ownsTask = false;
            const nt = taskById(b.taskID);
            b.category = nt ? nt.category || null : null;
            b.updatedAt = stamp();
          });
          if (own && prev && !Store.blocks().some((x) => x.taskID && lowerEq(x.taskID, prev.id))) Store.deleteTask(prev.id);
          refresh();
        });
        taskCard.appendChild(h('label', { class: 'cal-pop-relink' }, h('span', { class: 'cal-pop-label', text: 'Same task as' }), sel));
      }
    };

    // ── course ──
    const courseRow = h('div', { class: 'cal-pop-courses', role: 'radiogroup', 'aria-label': 'Course' });
    const setCourse = (c) => {
      liveEdit(id, (x) => { x.courseID = c ? c.id : null; x.updatedAt = stamp(); });
      const t = linked();
      if (t && (cur().ownsTask || !t.courseID || !c)) {
        Store.updateTask(t.id, { courseID: c ? c.id : null, course: c ? courseLabel(c).slice(0, 40) : null });
      }
      refresh();
    };
    const drawCourses = () => {
      courseRow.textContent = '';
      const b = cur();
      const chip = (c) => {
        const on = c ? lowerEq(b.courseID, c.id) : !b.courseID;
        return h('button', {
          class: 'cal-course-chip' + (on ? ' is-on' : '') + (c ? '' : ' is-none'), type: 'button', role: 'radio', 'aria-checked': String(on),
          vars: c ? { '--ev': courseHex(c) } : null, title: c ? (c.name || courseLabel(c)) : 'No course',
          onclick: () => setCourse(c),
        }, c ? h('span', { class: 'cal-course-dot' }) : null, h('span', { class: 'cal-course-name', text: c ? courseLabel(c) : 'None' }));
      };
      courseRow.appendChild(chip(null));
      for (const c of courseList()) courseRow.appendChild(chip(c));
      const input = h('input', { class: 'cal-course-new', type: 'text', maxlength: '40', placeholder: 'Course name, then Enter', 'aria-label': 'New course name' });
      const add = h('button', { class: 'cal-course-chip is-add', type: 'button', title: 'Add a course',
        onclick: () => { add.replaceWith(input); input.focus(); positionPop(); } }, icon('plus'), h('span', { text: 'New course' }));
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          const name = input.value.trim().slice(0, 40);
          if (!name) return;
          // a colour no other course uses yet, so each class reads apart on the calendar
          const used = new Set(courseList().map((x) => String(courseHex(x) || '').toLowerCase()));
          const colorHex = SWATCHES.find((x) => !used.has(lowerHex(themed(x)))) || null;
          const c = Store.upsertCourse(typeof Courses !== 'undefined' && Courses.newCourse ? Courses.newCourse({ name, colorHex }) : { id: Store.uid(), name, code: '', colorHex });
          if (c) setCourse(c);
        } else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); drawCourses(); }
      });
      input.addEventListener('blur', () => setTimeout(() => { if (input.isConnected && !input.value.trim()) drawCourses(); }, 150));
      courseRow.appendChild(add);
    };

    // ── colour: automatic (course, then task) or one of 8 ──
    const swatchRow = h('div', { class: 'cal-pop-swatches', role: 'radiogroup', 'aria-label': 'Colour' });
    const drawSwatches = () => {
      swatchRow.textContent = '';
      const b = cur();
      for (const c of [null].concat(SWATCHES)) {
        const on = (b.colorHex || null) === c;
        const sw = h('button', {
          class: 'cal-swatch' + (c ? '' : ' is-auto') + (on ? ' is-on' : ''), type: 'button', role: 'radio', 'aria-checked': on ? 'true' : 'false',
          title: c ? swatchName(c) : 'Automatic (the course or task colour)', 'aria-label': c ? swatchName(c) : 'Automatic colour',
          vars: { '--sw': c ? themed(c) : colorOf(Object.assign({}, b, { colorHex: null })) },
          onclick: () => { liveEdit(id, (x) => { x.colorHex = c; x.updatedAt = stamp(); }); refresh(); },
        });
        if (on) sw.appendChild(icon('check'));
        swatchRow.appendChild(sw);
      }
    };

    const notes = h('textarea', { class: 'text-input cal-pop-notes', rows: '2', maxlength: '2000', placeholder: 'Add notes', 'aria-label': 'Notes' });
    notes.value = e.notes || '';
    notes.addEventListener('input', () => { liveEdit(id, (b) => { b.notes = notes.value.slice(0, 2000) || null; b.updatedAt = stamp(); }, { rerender: false }); });

    const startBtn = h('button', { class: 'btn btn-sm btn-primary cal-pop-start', type: 'button',
      onclick: () => { const b = findLocal(id); if (b && !isFocusingTask(b.taskID)) startFocus(b.taskID, b); } }, icon('play'), 'Start focus');

    function refresh() {
      const b = cur();
      const t = linked();
      titleIn.placeholder = t ? t.title : 'Add title';
      startBtn.hidden = !openTask(b) || isPastBlock(b);
      const focusing = !!(t && isFocusingTask(t.id));
      startBtn.disabled = focusing;
      startBtn.classList.toggle('is-focusing', focusing);
      startBtn.title = focusing ? 'You are already focusing on this' : '';
      startBtn.setAttribute('aria-label', focusing ? `You are already focusing on ${t.title}` : 'Start focus');
      if (startBtn.lastChild && startBtn.lastChild.nodeType === 3) startBtn.lastChild.textContent = focusing ? 'Focusing on this' : 'Start focus';
      paintDot();
      showDur();
      drawType();
      drawTaskCard();
      drawCourses();
      drawSwatches();
      positionPop();
    }

    const kids = [
      head,
      h('div', { class: 'cal-pop-row cal-pop-typerow' }, typeSeg),
      h('div', { class: 'cal-pop-row', title: 'When' }, icon('clock', 'cal-pop-ic'),
        h('div', { class: 'cal-pop-when' },
          h('div', { class: 'cal-pop-line' }, dateIn,
            h('label', { class: 'cal-pop-allday' }, allDayIn, h('span', { text: 'All day' }))),
          times)),
      h('div', { class: 'cal-pop-row cal-pop-taskrow' }, icon('tasks', 'cal-pop-ic'), taskCard),
      h('div', { class: 'cal-pop-row' }, icon('cap', 'cal-pop-ic'),
        h('div', { class: 'cal-pop-taskbox' }, h('span', { class: 'cal-pop-label', text: 'Course' }), courseRow)),
      h('div', { class: 'cal-pop-row cal-pop-colorrow' }, h('span', { class: 'cal-pop-ic cal-pop-ic-dot', 'aria-hidden': 'true' }),
        h('div', { class: 'cal-pop-taskbox' }, h('span', { class: 'cal-pop-label', text: 'Colour' }), swatchRow)),
    ];
    if (e.taskID && !linked()) kids.push(h('div', { class: 'cal-pop-row cal-pop-hint' }, icon('info', 'cal-pop-ic'), h('span', { class: 'cal-pop-muted', text: 'Task deleted' })));
    if (e.planWhy) kids.push(h('div', { class: 'cal-pop-row cal-pop-why' }, icon('sparkle', 'cal-pop-ic'), h('span', { class: 'cal-pop-text', text: `Why now? ${e.planWhy}` })));
    kids.push(h('div', { class: 'cal-pop-row' }, icon('notes', 'cal-pop-ic'), notes));
    kids.push(h('div', { class: 'cal-pop-foot' },
      h('button', { class: 'btn btn-sm cal-pop-del', type: 'button', onclick: () => deleteEvent(id), title: 'Delete (or press Delete)' }, icon('trash'), 'Delete'),
      h('span', { class: 'cal-spacer' }),
      startBtn,
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => closePopover() }, 'Done')));
    const el = h('div', { class: 'cal-pop', role: 'dialog', 'aria-label': 'Edit block' }, kids);
    // the first draw runs before the popover is in the page (positionPop is a no-op until then)
    const t0 = linked();
    titleIn.placeholder = t0 ? t0.title : 'Add title';
    startBtn.hidden = !openTask(e) || isPastBlock(e);
    showDur(); drawType(); drawTaskCard(); drawCourses(); drawSwatches();
    return el;
  }

  function buildDetails(e) {
    const start = new Date(e.start), end = new Date(e.end);
    let when;
    if (e.allDay) {
      const [s, en] = allDayRange(e);
      const lastD = addDays(en, -1);
      when = sameDay(s, lastD) ? `${F.full.format(s)} · All day` : `${F.medium.format(s)} – ${F.medium.format(lastD)} · All day`;
    } else if (sameDay(start, end) || (+end === +startOfDay(end) && dayIndex(start, end) === 1)) {
      when = `${F.full.format(start)} · ${timeRange(start, end)}`;
    } else {
      when = `${F.medium.format(start)}, ${F.time.format(start)} – ${F.medium.format(end)}, ${F.time.format(end)}`;
    }
    const f = feedMap().get(e.calendarID);
    const srcName = e.source === 'google' ? 'Google Calendar' : (f && f.hasURL ? Feeds.providerLabel(f.provider) : 'Calendar file');
    const name = calNameOf(e);
    const kids = [
      popHead(colorOf(e), h('h3', { class: 'cal-pop-heading', text: titleOf(e) })),
      h('div', { class: 'cal-pop-row' }, icon('clock', 'cal-pop-ic'), h('span', { class: 'cal-pop-text', text: when })),
      h('div', { class: 'cal-pop-row' }, icon(e.source === 'google' ? 'cloud' : 'file', 'cal-pop-ic'),
        h('span', { class: 'cal-pop-text' },
          h('span', { class: 'cal-pop-strong', text: name || srcName }),
          name && name !== srcName ? h('span', { class: 'cal-pop-muted', text: ` · ${srcName}` }) : null)),
    ];
    if (e.isBusy === false || (f && f.blocksTime === false)) {
      kids.push(h('div', { class: 'cal-pop-row' }, icon('info', 'cal-pop-ic'), h('span', { class: 'cal-pop-muted', text: 'Free time · doesn’t block your time' })));
    }
    if (e.course) kids.push(h('div', { class: 'cal-pop-row' }, icon('cap', 'cal-pop-ic'), h('span', { class: 'cal-pop-text', text: e.course })));
    if (Array.isArray(e.alsoIn) && e.alsoIn.length) {
      kids.push(h('div', { class: 'cal-pop-row' }, icon('calendar', 'cal-pop-ic'), h('span', { class: 'cal-pop-muted', text: `Also in: ${e.alsoIn.join(' · ')}` })));
    }
    if (e.location) kids.push(h('div', { class: 'cal-pop-row' }, icon('pin', 'cal-pop-ic'), h('span', { class: 'cal-pop-text', text: e.location })));
    // a "PUREFOCUS:" event says what became of its task
    if (typeof CalendarTasks !== 'undefined' && CalendarTasks.matches(e.title)) {
      const t = CalendarTasks.taskFor(e);
      const row = h('div', { class: 'cal-pop-row cal-pop-pftask' }, icon('check', 'cal-pop-ic'));
      if (t && t.isDone) row.appendChild(h('span', { class: 'cal-pop-muted', text: 'Task done' }));
      else if (t) {
        const focusing = isFocusingTask(t.id);
        row.appendChild(h('span', { class: 'cal-pop-text', text: focusing ? 'You are focusing on this' : 'On Today’s Tasks' }));
        row.appendChild(h('span', { class: 'cal-spacer' }));
        row.appendChild(h('button', {
          class: 'btn btn-sm btn-primary' + (focusing ? ' is-focusing' : ''), type: 'button', disabled: focusing,
          title: focusing ? 'You are already focusing on this' : 'Start focus',
          onclick: () => { if (!focusing) startFocus(t.id, null); },
        }, icon(focusing ? 'check' : 'play'), focusing ? 'Focusing on this' : 'Start focus'));
      } else {
        row.appendChild(h('button', { class: 'btn btn-sm btn-primary', type: 'button',
          onclick: () => { const n = CalendarTasks.add(e); closePopover(); if (n) toast(`Added “${n.title}” to Today’s Tasks`, 'success'); } }, icon('plus'), 'Add to Today’s Tasks'));
      }
      kids.push(row);
    }
    kids.push(...extrasRows(e, e.notes));
    if (e.notes) kids.push(h('div', { class: 'cal-pop-row' }, icon('notes', 'cal-pop-ic'), richDescription(e.notes)));
    if (e.htmlLink) {
      kids.push(h('div', { class: 'cal-pop-row' }, icon('out', 'cal-pop-ic'),
        h('a', { class: 'cal-pop-link', href: e.htmlLink, target: '_blank', rel: 'noopener noreferrer', text: e.source === 'google' ? 'Open in Google Calendar' : 'Open link' })));
    }
    kids.push(h('div', { class: 'cal-pop-foot is-ro' }, icon('lock', 'cal-pop-ic'),
      h('span', { text: 'Read-only · change it in the original calendar' })));
    return h('div', { class: 'cal-pop is-readonly', role: 'dialog', 'aria-label': titleOf(e) }, kids);
  }

  function sourceName(a) {
    if (!a) return 'Pure Focus';
    if (a.source === 'canvas') return 'Canvas';
    if (a.source === 'blackbaud') return 'Blackbaud';
    const f = feedMap().get(a.feedID);
    return feedName(f) || 'your calendar';
  }

  /* Canvas feed links point at the calendar; send people to the assignment page instead. */
  function externalUrlOf(a, t) {
    const raw = (a && a.url) || (t && t.url) || '';
    if (!raw) return '';
    try {
      if (typeof Assignments !== 'undefined' && Assignments.canvasURL) {
        const m = /:a(\d{1,15})$/i.exec(String((t && t.externalID) || (a && a.id) || ''));
        return Assignments.canvasURL(raw, m ? m[1] : null) || raw;
      }
    } catch (_) { /* keep the stored link */ }
    return raw;
  }

  // ── descriptions: formatted text, drawn safely ──
  // Calendars send descriptions as plain text or as HTML (bold, paragraphs, lists, links). HTML is
  // read with DOMParser and rebuilt from a short list of harmless tags — nothing from the feed is
  // ever inserted as markup, scripts and styles never run, and links only go to http(s)/mailto.
  const MEET_RE = /https:\/\/(?:[\w-]+\.)*(?:meet\.google\.com|zoom\.us|teams\.microsoft\.com|teams\.live\.com|webex\.com|whereby\.com|gotomeeting\.com|meet\.jit\.si)\/[^\s<>"')\]]*/i;
  const URL_RE = /(https?:\/\/[^\s<>"')\]]+|www\.[^\s<>"')\]]+\.[a-z]{2,}[^\s<>"')\]]*)/gi;
  function cleanDescription(text) {
    return String(text || '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 6000);
  }
  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
  function decodeEntities(t) { return t.replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_, k) => ENTITIES[k]); }
  function looksHtml(t) { return /<\/?(p|br|b|strong|i|em|u|ul|ol|li|a|div|span|h[1-6]|table|font)\b[^>]*>/i.test(t); }
  function safeHref(u) {
    const v = String(u || '').trim();
    if (/^https?:\/\//i.test(v) || /^mailto:/i.test(v)) return v;
    if (/^www\./i.test(v)) return 'https://' + v;
    return null;
  }
  function linkEl(href, label) {
    const a = document.createElement('a');
    a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.className = 'cal-pop-link';
    const t = String(label || href);
    a.textContent = t.length > 60 && t === href ? t.slice(0, 57) + '…' : t;
    return a;
  }
  // text with its web addresses made clickable
  function appendLinked(dst, text) {
    let last = 0, m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(text))) {
      if (m.index > last) dst.appendChild(document.createTextNode(text.slice(last, m.index)));
      const href = safeHref(m[0]);
      dst.appendChild(href ? linkEl(href, m[0]) : document.createTextNode(m[0]));
      last = m.index + m[0].length;
    }
    if (last < text.length) dst.appendChild(document.createTextNode(text.slice(last)));
  }
  const BLOCK_TAGS = { P: 'p', DIV: 'p', UL: 'ul', OL: 'ol', LI: 'li', BLOCKQUOTE: 'blockquote', H1: 'h4', H2: 'h4', H3: 'h4', H4: 'h4', H5: 'h4', H6: 'h4', TR: 'p' };
  const INLINE_TAGS = { B: 'strong', STRONG: 'strong', I: 'em', EM: 'em', U: 'u', CODE: 'code', S: 's', STRIKE: 's', SUB: 'sub', SUP: 'sup' };
  const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'TEMPLATE', 'HEAD', 'TITLE', 'META', 'LINK', 'NOSCRIPT', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA']);
  function richDescription(raw) {
    const box = h('div', { class: 'cal-pop-notes-ro cal-rich' });
    const text = cleanDescription(raw);
    if (!looksHtml(text)) { box.classList.add('is-plain'); appendLinked(box, decodeEntities(text)); return box; }
    let doc = null;
    try { doc = new DOMParser().parseFromString(text, 'text/html'); } catch (_) { doc = null; }
    if (!doc || !doc.body) { box.classList.add('is-plain'); appendLinked(box, text.replace(/<[^>]*>/g, '')); return box; }
    const walk = (src, dst, depth) => {
      if (depth > 12) return;
      for (const n of src.childNodes) {
        if (n.nodeType === 3) { if (n.nodeValue) appendLinked(dst, n.nodeValue); continue; }
        if (n.nodeType !== 1) continue;
        const tag = n.tagName;
        if (DROP_TAGS.has(tag)) continue;
        if (tag === 'BR') { dst.appendChild(document.createElement('br')); continue; }
        if (tag === 'IMG') continue;
        if (tag === 'A') {
          const href = safeHref(n.getAttribute('href'));
          if (href) { const a = linkEl(href, ''); a.textContent = ''; walk(n, a, depth + 1); if (!a.textContent.trim()) a.textContent = href; dst.appendChild(a); }
          else walk(n, dst, depth + 1);
          continue;
        }
        const t = BLOCK_TAGS[tag] || INLINE_TAGS[tag];
        if (t) {
          const el = document.createElement(t);
          walk(n, el, depth + 1);
          if (el.textContent.trim() || el.querySelector('br')) dst.appendChild(el);
        } else walk(n, dst, depth + 1);
      }
    };
    walk(doc.body, box, 0);
    return box;
  }
  // "Join meeting" (from the calendar's own meeting link, the location or the description) and
  // the event's attachments, as rows above the description
  function extrasRows(e, desc) {
    const rows = [];
    const plain = String(desc || '').replace(/<[^>]*>/g, ' ');
    const meet = (e && e.conference) || ((e && e.location ? String(e.location) : '').match(MEET_RE) || [])[0] || (plain.match(MEET_RE) || [])[0] || null;
    if (meet && safeHref(meet)) {
      const host = (/^https:\/\/(?:[\w-]+\.)*([\w-]+)\.(?:com|us|si)/i.exec(meet) || [])[1] || '';
      const name = /meet\.google/i.test(meet) ? 'Google Meet' : /zoom/i.test(meet) ? 'Zoom' : /teams/i.test(meet) ? 'Microsoft Teams' : host;
      const btn = linkEl(safeHref(meet), `Join ${name ? name : 'meeting'}`);
      btn.className = 'btn btn-sm btn-primary cal-pop-join';
      rows.push(h('div', { class: 'cal-pop-row' }, icon('video', 'cal-pop-ic'), btn));
    }
    const files = (e && Array.isArray(e.attachments) ? e.attachments : []).filter((f) => f && safeHref(f.url));
    if (files.length) {
      const list = h('div', { class: 'cal-pop-files' });
      for (const f of files) {
        let file = String(f.url).split(/[?#]/)[0].split('/').pop() || '';
        try { file = decodeURIComponent(file); } catch (_) { /* keep it as written */ }
        const label = f.name || file || 'Attachment';
        list.appendChild(linkEl(safeHref(f.url), label));
      }
      rows.push(h('div', { class: 'cal-pop-row' }, icon('clip', 'cal-pop-ic'), list));
    }
    return rows;
  }

  function buildDueDetails(d) {
    const day = parseDayKey(d.day);
    const when = d.minutes != null ? `Due ${F.full.format(day)} · ${F.time.format(dateAt(day, d.minutes))}` : `Due ${F.full.format(day)}`;
    const a = d.assignment;
    const kids = [
      popHead(d.color, h('h3', { class: 'cal-pop-heading', text: d.title })),
      h('div', { class: 'cal-pop-row' }, icon('clock', 'cal-pop-ic'), h('span', { class: 'cal-pop-text', text: when })),
    ];
    const doneCheck = dueCheck(d, 'cal-pop-duecheck');
    if (doneCheck) {
      const label = d.done ? (a && a.submitted && assignmentOverride(a.id) === null ? 'Submitted' : 'Done') : 'Mark done';
      const row = h('div', { class: 'cal-pop-row cal-pop-done' }, doneCheck, h('span', { class: 'cal-pop-muted', text: label }));
      kids.push(row);
    }
    if (d.course) kids.push(h('div', { class: 'cal-pop-row' }, icon('cap', 'cal-pop-ic'), h('span', { class: 'cal-pop-text', text: d.course })));
    if (a) kids.push(h('div', { class: 'cal-pop-row' }, icon('file', 'cal-pop-ic'), h('span', { class: 'cal-pop-muted', text: `From ${sourceName(a)}` })));
    // the assignment's description, as Canvas writes it in the calendar feed (links open in a new tab)
    const desc = (a && a.description) || (d.task && d.task.notes) || '';
    kids.push(...extrasRows(a || {}, desc));
    if (desc.trim()) kids.push(h('div', { class: 'cal-pop-row' }, icon('notes', 'cal-pop-ic'), richDescription(desc)));
    const url = externalUrlOf(a, d.task);
    if (url && /^https:\/\//i.test(url)) {
      kids.push(h('div', { class: 'cal-pop-row' }, icon('out', 'cal-pop-ic'),
        h('a', { class: 'cal-pop-link', href: url, target: '_blank', rel: 'noopener noreferrer', text: `Open in ${a ? sourceName(a) : 'browser'}` })));
    }
    const foot = h('div', { class: 'cal-pop-foot' });
    if (d.done) {
      foot.appendChild(h('span', { class: 'cal-pop-muted', text: a && a.submitted ? 'Submitted' : 'Done' }));
    } else if (d.task) {
      const focusing = isFocusingTask(d.task.id);
      foot.appendChild(h('span', { class: 'cal-pop-muted', text: focusing ? 'You are focusing on this' : 'On Today’s Tasks' }));
      foot.appendChild(h('span', { class: 'cal-spacer' }));
      foot.appendChild(h('button', {
        class: 'btn btn-sm btn-primary' + (focusing ? ' is-focusing' : ''), type: 'button', disabled: focusing,
        title: focusing ? 'You are already focusing on this' : 'Start focus',
        onclick: () => { if (!focusing) startFocus(d.task.id, null); },
      }, icon(focusing ? 'check' : 'play'), focusing ? 'Focusing on this' : 'Start focus'));
    } else if (a) {
      foot.appendChild(h('span', { class: 'cal-spacer' }));
      foot.appendChild(h('button', {
        class: 'btn btn-sm btn-primary', type: 'button',
        onclick: () => { const ids = Assignments.promote([a.id]); closePopover(); if (ids.length) toast(`Added “${a.title}” to Today’s Tasks`, 'success'); },
      }, icon('plus'), 'Add to Today’s Tasks'));
    }
    kids.push(foot);
    return h('div', { class: 'cal-pop is-readonly is-due', role: 'dialog', 'aria-label': d.title }, kids);
  }

  // Closing on an outside press never re-renders here, so the element being
  // pressed (a tray button, a "+N more" link…) still receives its click.
  function onDocPointerDown(ev) {
    suppressCreate = false;
    const t = ev.target;
    if (menu && !menu.contains(t)) closeMenu();
    if (pop && !pop.el.contains(t)) {
      if (t.closest && t.closest('.cal-confirm, .cal-confirm-back, .toast')) return;
      const onEvent = t.closest && t.closest('#view-calendar [data-id], #view-calendar .cal-ev-more');
      if (!onEvent && t.closest && t.closest('#view-calendar .cal-col, #view-calendar .cal-mcell')) suppressCreate = true;
      const prev = pop;
      pop = null;
      prev.el.remove();
      markActive(null);
      // a new block you left empty goes, like Escape, unless you pressed on the block itself
      const own = t.closest && t.closest('#view-calendar [data-id]');
      finalizeClosed(prev, !(own && own.dataset.id === prev.id));
      if (prev.isNew) scheduleRender();
    }
  }

  // ───────────────────────────  import  ───────────────────────────

  function closeMenu() {
    if (!menu) return;
    menu.remove();
    menu = null;
  }

  function pickFiles() {
    closeMenu();
    if (ui.file) ui.file.click();
  }

  function openAdd() {
    if (typeof Feeds !== 'undefined' && Feeds.openAddSheet) Feeds.openAddSheet();
    else pickFiles();
  }

  /* Show a feed's row: open the sidebar, expand its group, focus the checkbox ("Already added"). */
  function revealFeed(id) {
    const f = feeds().find((x) => x.id === id);
    if (!f) return;
    try { App.showView('calendar'); } catch (_) {}
    const g = groupOf(f);
    if (collapsedGroups().includes(g)) setPrefs({ collapsedGroups: collapsedGroups().filter((x) => x !== g) });
    if (collapsedSections().includes('calendars')) setPrefs({ collapsedSections: collapsedSections().filter((x) => x !== 'calendars') });
    if (!sideShown()) setSideOpen(true);
    render();
    const row = ui.side && ui.side.querySelector(`.cal-row[data-row="${cssEsc(id)}"]`);
    if (row) {
      row.classList.add('is-flash');
      setTimeout(() => row.classList.remove('is-flash'), 1600);
      const b = row.querySelector('.cal-row-main');
      if (b) b.focus({ preventScroll: false });
    }
  }

  function googleReady() {
    return typeof GoogleSync !== 'undefined' && !!GoogleSync && typeof GoogleSync.isConfigured === 'function' && !!GoogleSync.isConfigured();
  }

  async function importGoogle(kind, anchorEl) {
    const fnName = kind === 'tasks' ? 'importTasks' : 'importCalendar';
    if (!googleReady() || typeof GoogleSync[fnName] !== 'function') { showSetupNotice(anchorEl); return; }
    try { await GoogleSync[fnName](); } catch (err) {
      const msg = err && err.message ? String(err.message).slice(0, 80) : 'please try again';
      toast(`Google import didn’t finish — ${msg}`);
    }
  }

  function showSetupNotice(anchorEl) {
    const el = h('div', { class: 'cal-pop cal-notice', role: 'dialog', 'aria-label': 'Google import setup' },
      h('div', { class: 'cal-notice-top' },
        h('span', { class: 'cal-notice-ic' }, icon('cloud')),
        h('h3', { class: 'cal-pop-heading', text: 'Google import isn’t set up yet' }),
        h('button', { class: 'icon-btn small cal-pop-close', type: 'button', 'aria-label': 'Close', onclick: () => closePopover() }, icon('x'))),
      h('p', { class: 'cal-notice-p', text: 'Connecting Google needs a one-time setup by the site owner. Until then, add your Google calendar with its secret iCal link, or import an .ics file.' }),
      h('p', { class: 'cal-notice-hint', text: 'In Google Calendar: Settings → your calendar → Integrate calendar → Secret address in iCal format.' }),
      h('div', { class: 'cal-pop-foot' },
        h('span', { class: 'cal-spacer' }),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => closePopover() }, 'Not now'),
        h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => { closePopover(); pickFiles(); } }, icon('file'), 'Import .ics file')));
    openNotice(el, anchorEl && anchorEl.isConnected ? anchorEl : ui.newBtn);
  }

  async function importFiles(files) {
    if (typeof Feeds === 'undefined' || !Feeds.importFiles) { toast('The calendar reader didn’t load'); return null; }
    const res = await Feeds.importFiles(files);
    for (const e of res.errors) toast(e.message);
    if (res.results.length) {
      const r = res.results;
      const evs = r.reduce((n, x) => n + x.events, 0), asg = r.reduce((n, x) => n + x.assignments, 0);
      toast(`Added ${r.map((x) => `“${x.name}”`).join(', ')} · ${evs} event${evs === 1 ? '' : 's'}${asg ? ` · ${asg} assignment${asg === 1 ? '' : 's'}` : ''}`, 'success');
    }
    render();
    renderSettings();
    return res;
  }

  /* google.js (and old callers) hand over Google events in the v1 shape: {id:'g:…', calendarId,
     calendarName, color, start, end, allDay, startDay, endDay, location, url, …}. They become
     feeds `google:<calId>` + cached CalendarBlocks `google:<calId>:<eventId>`. An empty list
     clears every Google feed (sign-out). */
  function addExternal(list, source, opts) {
    if (typeof Feeds === 'undefined') return 0;
    const src = source === 'google' || source === 'ics' ? source : null;
    if (!src) return 0;
    const arr = Array.isArray(list) ? list : [];
    const only = opts && opts.calendarID ? String(opts.calendarID) : null;
    if (src === 'ics') {
      const fid = only || (arr[0] && (arr[0].calendarID || arr[0].calendarId)) || null;
      if (!fid) return 0;
      const id = fid.startsWith('ics:') || fid.startsWith('icsurl:') ? fid : 'ics:' + (typeof ICS !== 'undefined' ? ICS.fnv1a(String(fid).toLowerCase()) : fid);
      if (!Feeds.get(id)) Feeds.upsertFeed({ id, source: 'ics', name: (arr[0] && arr[0].calendarName) || 'Calendar', provider: 'ics', groupKey: 'files', itemRole: 'events', lastSyncedAt: new Date().toISOString() });
      Feeds.replaceEvents(id, arr.map((e) => toCacheRecord(e, id)).filter(Boolean));
      invalidate(); scheduleRender();
      return arr.length;
    }
    const groups = new Map();
    for (const e of arr) {
      const raw = String(e.calendarID || e.calendarId || 'primary').replace(/^google:/, '');
      const fid = 'google:' + raw;
      if (!groups.has(fid)) groups.set(fid, { name: e.calendarName || 'Google Calendar', color: e.color || e.colorHex || null, events: [] });
      groups.get(fid).events.push(e);
    }
    let email = null;
    try { const u = GoogleSync.user && GoogleSync.user(); email = u && u.email; } catch (_) {}
    const targets = only ? ['google:' + only.replace(/^google:/, '')] : Feeds.list().filter((f) => f.source === 'google').map((f) => f.id);
    let n = 0;
    for (const [fid, g] of groups) {
      const existing = Feeds.get(fid);
      if (!existing) {
        Feeds.upsertFeed({ id: fid, source: 'google', name: g.name, provider: 'google', groupKey: email ? 'google:' + email : 'google',
          colorHex: Feeds.normalizeColor(g.color) || Feeds.nextColor(), itemRole: 'events', lastSyncedAt: new Date().toISOString(),
          isVisible: !/#contacts@group\.v\.calendar\.google\.com$/i.test(fid), blocksTime: !/#contacts@group|#holiday@group/i.test(fid) });
      } else {
        Feeds.update(fid, { lastSyncedAt: new Date().toISOString(), lastError: null });
      }
      const recs = g.events.map((e) => toCacheRecord(e, fid)).filter(Boolean);
      n += recs.length;
      Feeds.replaceEvents(fid, recs);
    }
    for (const fid of targets) {
      if (groups.has(fid)) continue;
      if (opts && opts.signOut) Feeds.remove(fid);     // the Google feeds go too
      else Feeds.replaceEvents(fid, []);               // nothing coming up: it keeps its name, colour and tick
    }
    invalidate();
    scheduleRender();
    renderSettings();
    return n;
  }

  function toCacheRecord(e, fid) {
    if (!e || !e.start) return null;
    const start = new Date(e.start), end = new Date(e.end != null ? e.end : e.start);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
    let id = String(e.id || '');
    const prefix = fid + ':';
    if (!id.startsWith(prefix)) id = prefix + id.replace(/^(g|google|ics):/, '');
    return {
      id, title: String(e.title || '(No title)').slice(0, 200), start: start.toISOString(), end: (end >= start ? end : start).toISOString(),
      allDay: !!e.allDay, startDay: e.startDay || null, endDay: e.endDay || null, source: fid.startsWith('google:') ? 'google' : 'ics',
      notes: e.notes ? String(e.notes).slice(0, 6000) : null, location: e.location ? String(e.location).slice(0, 200) : null,
      attachments: Array.isArray(e.attachments) && e.attachments.length ? e.attachments.slice(0, 10) : undefined, conference: e.conference || undefined,
      isBusy: e.isBusy !== false, eventType: e.eventType || null,
      htmlLink: typeof (e.htmlLink || e.url) === 'string' && /^https:\/\//i.test(e.htmlLink || e.url) ? (e.htmlLink || e.url) : null,
      icalUID: e.icalUID || e.iCalUID || e.uid || null, externalID: e.externalID || e.externalId || null, updatedAt: new Date().toISOString(),
    };
  }

  /* v1-shaped copies for old callers (selftest): Google calendarID is the raw Google id. */
  function events() {
    const out = Store.blocks().map((b) => ({ id: b.id, title: b.title, start: b.start, end: b.end, allDay: !!b.allDay, startDay: b.startDay, endDay: b.endDay,
      source: 'local', calendarName: null, calendarID: null, color: b.colorHex || null, readOnly: false, taskId: b.taskID || null, notes: b.notes || null }));
    if (typeof Feeds !== 'undefined') {
      const fm = feedMap();
      for (const e of Feeds.events()) {
        const f = fm.get(e.calendarID);
        out.push({ id: e.id, title: e.title, start: e.start, end: e.end, allDay: !!e.allDay, startDay: e.startDay, endDay: e.endDay,
          source: e.source === 'google' ? 'google' : 'ics', calendarName: feedName(f) || null,
          calendarID: e.source === 'google' ? String(e.calendarID || '').replace(/^google:/, '') : e.calendarID,
          color: feedColor(f), readOnly: true, taskId: null, notes: e.notes || null, isBusy: e.isBusy !== false });
      }
    }
    return out;
  }

  // ───────────────────────────  settings card  ───────────────────────────

  let settingsTimer = 0;
  function renderSettingsSoon() { clearTimeout(settingsTimer); settingsTimer = setTimeout(renderSettings, 60); }

  function renderSettings() {
    const host = document.getElementById('settings-calendar-root');
    if (!host) return;
    host.textContent = '';
    const list = typeof Feeds !== 'undefined' ? Feeds.list() : [];
    const ws = weekStart();
    const weekSeg = h('div', { class: 'segmented cal-weekstart', role: 'radiogroup', 'aria-label': 'Week starts on' },
      [['Sun', 0], ['Mon', 1]].map(([label, v]) => h('button', {
        class: 'seg-btn' + (ws === v ? ' is-active' : ''), type: 'button', role: 'radio',
        'aria-checked': String(ws === v),
        onclick: () => { setPrefs({ weekStartsOn: v }); renderSettings(); render(); },
      }, label)));

    const counts = new Map();
    if (typeof Feeds !== 'undefined') for (const e of Feeds.events()) counts.set(e.calendarID, (counts.get(e.calendarID) || 0) + 1);
    const feedList = h('div', { class: 'cal-set-feeds' });
    if (!list.length) feedList.appendChild(h('div', { class: 'cal-set-empty', text: 'No calendars added yet.' }));
    for (const f of list) {
      const c = counts.get(f.id) || 0;
      const kind = f.source === 'google' ? 'Google' : f.hasURL ? Feeds.providerLabel(f.provider) + ' link' : '.ics file';
      feedList.appendChild(h('div', { class: 'cal-set-feed' },
        h('span', { class: 'cal-set-dot', vars: { '--ev': feedColor(f) || 'var(--text-muted)' } }),
        h('span', { class: 'cal-set-name', text: feedName(f) }),
        h('span', { class: 'cal-set-meta', text: `${c} event${c === 1 ? '' : 's'} · ${kind}` }),
        h('button', {
          class: 'icon-btn small', type: 'button', 'aria-label': `Remove ${feedName(f)}`, title: 'Remove this calendar',
          onclick: () => { removeFeed(f).then(() => { renderSettings(); if (isVisible()) render(); }); },
        }, icon('x'))));
    }

    host.appendChild(h('div', { class: 'glass card cal-settings' },
      h('div', { class: 'card-header' },
        h('span', { class: 'card-icon' }, icon('calendar')),
        h('h2', { class: 'card-title', text: 'Calendars' })),
      h('p', { class: 'cal-set-sub', text: 'Bring in classes and events from other calendars. Imported events are read-only and stay in this browser.' }),
      h('div', { class: 'cal-set-actions' },
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => openAdd() }, icon('plus'), 'Add a calendar'),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: pickFiles }, icon('file'), 'Import .ics file')),
      feedList,
      h('div', { class: 'cal-set-foot' },
        h('span', { class: 'cal-set-label', text: 'Week starts on' }),
        weekSeg)));
  }

  // ───────────────────────────  keyboard / lifecycle  ───────────────────────────

  const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');

  function onKey(ev) {
    if (ev.key === 'Escape') {
      if (drag) { cancelDrag(); return; }
      if (pop) { closePopover(true); return; }
      if (menu) { closeMenu(); return; }
      if (mode !== 'wide' && sideOpen) setSideOpen(false);
      return;
    }
    if (!isVisible()) return;
    const tag = (ev.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || ev.target.isContentEditable;
    const mod = isMac() ? ev.metaKey : ev.ctrlKey;
    if (mod && !ev.altKey && (ev.key === 'z' || ev.key === 'Z') && !typing) {
      ev.preventDefault();
      if (ev.shiftKey) redo(); else undo();
      return;
    }
    if (mod && !ev.altKey && (ev.key === 'y' || ev.key === 'Y') && !isMac() && !typing) { ev.preventDefault(); redo(); return; }
    // Delete / Backspace removes the block whose popover is open (the one you clicked)
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && !typing && !mod && !ev.altKey && !ev.defaultPrevented
      && pop && pop.id && !previewing() && findLocal(pop.id)) {
      ev.preventDefault();
      deleteEvent(pop.id);
      return;
    }
    if (ev.metaKey || ev.ctrlKey || ev.altKey || typing || ev.defaultPrevented) return;
    const sheet = document.getElementById('task-sheet');
    if ((sheet && !sheet.hidden) || pop || menu || document.querySelector('.pfa-sheet, .pf-sheet, .cal-confirm')) return;
    const k = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
    switch (k) {
      case 't': goToday(); break;
      case 'p': case 'ArrowLeft': shift(-1); break;
      case 'n': case 'ArrowRight': shift(1); break;
      case 'd': setView('day'); break;
      case 'w': setView('week'); break;
      case 'm': setView('month'); break;
      case 'a': setView('agenda'); break;
      case 'b': if (!previewing()) newEventNow(); break;
      case 's': toggleSide(); break;
      case '+': case '=': zoom(1); break;
      case '-': case '_': zoom(-1); break;
      default: return;
    }
    ev.preventDefault();
  }

  function onResize() {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      closeMenu();
      if (isVisible() && !drag && !pop) render();
      positionPop();
    });
  }

  function init() {
    root = document.getElementById('view-calendar');
    const p = prefs();
    if (VIEWS.some((v) => v.id === p.lastView)) { /* the saved view is read on render */ }
    if (root) buildShell();
    renderSettings();
    Store.on('change', (event) => {
      invalidate();
      if (['tasks', 'settings', 'reset', 'blocks', 'calendar', 'bulk', 'remote', 'sessions'].includes(event) && isVisible() && !pop) scheduleRender();
      if (event === 'calendar' || event === 'reset' || event === 'remote' || event === 'bulk') renderSettings();
    });
    // event counts in Settings › Calendars follow the cache (a new or refreshed feed)
    Store.on('calcache', () => { invalidate(); if (isVisible() && !pop) scheduleRender(); renderSettingsSoon(); });
    Store.on('assignments', () => { if (isVisible() && !pop) scheduleRender(); });
    // a new theme or light/dark: calendars without their own colour take the new theme's colours
    try {
      new MutationObserver(() => { invalidate(); if (isVisible() && !pop && !drag) scheduleRender(); renderSettingsSoon(); })
        .observe(document.documentElement, { attributes: true, attributeFilter: ['data-pf-theme', 'data-theme'] });
    } catch (_) { /* no observer: the next render picks the colours up */ }
    window.addEventListener('resize', applyGridDensity, { passive: true });   // browser zoom fires resize
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDocPointerDown, true);
    installSpringLoad();
    window.addEventListener('resize', onResize);
    // Other tabs writing the same profile store reload through Store (W1·B); the cache reloads here.
    window.addEventListener('storage', (ev) => {
      if (ev.key && /purefocus\.calcache\.v1/.test(ev.key)) { invalidate(); scheduleRender(); renderSettingsSoon(); }
    });
    root && root.addEventListener('dragover', (ev) => { if (ev.dataTransfer && Array.from(ev.dataTransfer.types || []).includes('Files')) ev.preventDefault(); });
    root && root.addEventListener('drop', (ev) => {
      const files = ev.dataTransfer ? Array.from(ev.dataTransfer.files || []).filter((f) => /\.(ics|ical|icalendar)$/i.test(f.name) || f.type === 'text/calendar') : [];
      if (!files.length) return;
      ev.preventDefault();
      importFiles(files);
    });
    setInterval(updateNow, 30000);
    render();
  }

  // ───────────────────────────  v2 hooks (SPEC-V2 §4.3/§4.8)  ───────────────────────────
  //   planSlot()     → element for the ✦ Plan split button (W3 fills; W2 places it in the header)
  //   previewRoot()  → element for the plan preview bar (W3 fills; W2 places it under the grid)
  //   setPreview(p)  → show a PlanPreview's ghosts (null clears); grid editing pauses meanwhile
  //   onGhostToggle(fn) → unsubscribe; fn(key) when a ghost is clicked / Space-toggled
  //   pushUndo({label, undo, redo}) → adds a step to the shared 50-step undo stack
  //   registerSidebarSection({id, title, order, render(el)}) → unregister (Courses, …)
  //   setTodayLineProvider(fn) → fn() returns the optional coach line for the Today section
  //   visibleRange() → {from, to, view}: inclusive local day keys of the current view
  //   goTo(day)      → show the day (a 'YYYY-MM-DD' key or a Date) in the current view
  const v2 = { planSlot: null, previewRoot: null, preview: null, ghostListeners: new Set(), undo: [], redo: [],
    sidebar: new Map(), todayLine: null };

  function makeSlot(cls) { const el = document.createElement('div'); el.className = cls; return el; }
  function planSlot() { return v2.planSlot || (v2.planSlot = makeSlot('cal-plan-slot')); }
  function previewRoot() { return v2.previewRoot || (v2.previewRoot = makeSlot('cal-preview-root')); }
  function setPreview(p) { v2.preview = p && typeof p === 'object' ? p : null; }
  function onGhostToggle(fn) {
    if (typeof fn !== 'function') return () => {};
    v2.ghostListeners.add(fn);
    return () => v2.ghostListeners.delete(fn);
  }
  function pushUndo(step) {
    if (!step || typeof step.undo !== 'function') return;
    v2.undo.push(Object.assign(step, { label: String(step.label || ''), redo: typeof step.redo === 'function' ? step.redo : null }));
    if (v2.undo.length > 50) v2.undo.shift();
    v2.redo.length = 0;
  }
  function registerSidebarSection(spec) {
    if (!spec || typeof spec.id !== 'string' || !spec.id) return () => {};
    const entry = { ...spec };
    v2.sidebar.set(spec.id, entry);
    return () => { if (v2.sidebar.get(spec.id) === entry) v2.sidebar.delete(spec.id); };
  }
  function setTodayLineProvider(fn) { v2.todayLine = typeof fn === 'function' ? fn : null; }
  function visibleRange() {
    const v = currentView();
    let from, to;
    if (v === 'day') { from = startOfDay(anchor); to = from; }
    else if (v === 'week') { const d = weekDays(); from = d[0]; to = d[d.length - 1]; }
    else if (v === 'month' && fromToday()) { from = rollStart(); to = addDays(from, ROLL_WEEKS * 7 - 1); }
    else if (v === 'month') { from = new Date(anchor.getFullYear(), anchor.getMonth(), 1); to = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0); }
    else { from = startOfDay(anchor); to = addDays(from, AGENDA_DAYS - 1); }
    return { from: dayKey(from), to: dayKey(to), view: v };
  }
  function goTo(day) {
    let d = null;
    if (day instanceof Date) d = day;
    else if (typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)) d = new Date(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10));
    if (!d || Number.isNaN(d.getTime())) return false;
    anchor = startOfDay(d);
    closePopover();
    render();
    return true;
  }

  return {
    _themePalette: themePalette,
    init, render, isActive: isVisible, events, addExternal, importFiles, pickFiles, undo, redo, confirmSwitch, revealFeed, courseHex,
    scheduleTask, planSlot, previewRoot, setPreview, onGhostToggle, pushUndo, registerSidebarSection, setTodayLineProvider, visibleRange, goTo,
    _v2: v2,
  };
})();
