/* ═══════════════════════════════════════════════════════════════════════
   feeds.js — calendar sources: links (ICS/webcal through serve.py or the cloud
   proxy), .ics files, the imported-event cache and the refresh scheduler (owner: W2)
   v2-calendar §3.1, §3.7, §4.4–§4.5, §5.4, §6.2, §8.3; SPEC §1.2.3–§1.2.4, §1.2.8.

   Storage (all per profile through pfKey):
     purefocus.calcache.v1   {events:[CalendarBlock], fetched:{feedID:[[fromISO,toISO,fetchedAtISO]]}}
                             disposable; dropped first on QuotaExceededError
     purefocus.feedurls.v1   {feedID: url}  — bearer secrets: never exported, logged or shown unmasked
   Feed records live in Store.calendar().feeds (user data, synced as `feed`).

   const Feeds = {
     init()                       starts the refresh scheduler
     proxyMode()                  → Promise<'local'|'cloud'|'none'>  (/__pf/health → Cloud calendar-proxy → none)
     fetchICS(url, etag?)         → Promise<{status: 200|304, text?, etag?}>  (throws {code, status?, message})
     subscribe(raw, {name})       → Promise<{feed, events, assignments, already, homeworkLike}>
     importFiles(files)           → Promise<{feeds, events, assignments, results:[…], errors:[…]}>
     refresh(id?, {force})        → Promise<void>
     remove(id) · update(id, patch) · list() → [CalendarFeed] · get(id)
     status()                     → {mode, refreshing:[id], errors:{id: message}, lastSyncAt, state:'ok'|'stale'|'error'|'idle'}
     // shared by the calendar (W2) and google.js
     events()                     → cached imported CalendarBlocks (all feeds; callers filter visibility)
     replaceEvents(feedID, list, {from, to}?) · dropEvents(feedID)
     upsertFeed(feed)             → feed (creates or merges by id)
     normalizeColor(hex)          → '#rrggbb' (CalCore when ready; same OKLab rule otherwise)
     nextColor()                  → the next unused SERIES colour, normalised
     normalizeURL(raw)            → 'https://…' | null   (serve.py normalize_url rule)
     errorCopy(err)               → user-facing sentence (v2-calendar §4.4)
     providerLabel(p) · urlMask(url)
     openAddSheet(opts?)          → the Add calendar sheet (item 5)
   }
   Bus events (Store.emit): 'calcache' · 'assignments' (Assignments) · 'feeds:status'.
   ═══════════════════════════════════════════════════════════════════════ */

const Feeds = (() => {
  'use strict';

  const K_CACHE = 'purefocus.calcache.v1';
  const K_URLS = 'purefocus.feedurls.v1';
  const FILE_MAX = 5 * 1024 * 1024;
  const WINDOW_BACK = 14, WINDOW_AHEAD = 120;            // web parse window (localStorage budget)
  const BACKOFF = [5, 15, 60];                            // minutes
  const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
  const PROVIDER_LABEL = {
    canvas: 'Canvas', blackbaud: 'Blackbaud', google: 'Google Calendar', icloud: 'iCloud', apple: 'Apple Calendar',
    outlook: 'Outlook', samsung: 'Samsung Calendar', ics: 'Calendar',
  };
  const DEFAULT_REFRESH = { canvas: 60, blackbaud: 60 };   // others LIVE_MINUTES: a calendar you edit should show up soon
  const LIVE_MINUTES = 2;
  const HIDDEN_MINUTES = 15;       // a tab you're not looking at checks less often
  const RETURN_SECONDS = 20;       // coming back to the tab checks right away, this often at most

  const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
  const lower = (s) => String(s == null ? '' : s).toLowerCase();
  const key = (base) => (typeof pfKey === 'function' ? pfKey(base) : base);
  const nowISO = () => new Date().toISOString();

  function safeSet(k, v) {
    try {
      if (typeof Store !== 'undefined' && Store.safeSet) return Store.safeSet(k, v);
      localStorage.setItem(k, v);
      return true;
    } catch (_) { return false; }
  }
  function emit(ev) { try { Store.emit(ev); } catch (_) { /* no bus */ } }
  function toast(msg, variant) { try { App.toast(msg, variant); } catch (_) { /* no toast host */ } }
  function announce(msg) {
    try {
      const r = document.getElementById('live-region') || document.getElementById('toast-stack');
      if (r && r.id === 'live-region') r.textContent = msg;
    } catch (_) { /* no DOM */ }
  }

  function fnv(str) {
    if (typeof ICS !== 'undefined' && ICS.fnv1a) return ICS.fnv1a(str);
    let h = 0x811c9dc5;
    const s = String(str);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  }

  // ───────────────────────── colours (SPEC §1.6.4) ─────────────────────────

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(String(hex || '').trim());
    if (!m) return null;
    let h = m[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const toLin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const fromLin = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
  function oklab([r, g, b]) {
    const R = toLin(r), G = toLin(g), B = toLin(b);
    const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
    const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
    const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
    return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
  }
  function linFromOklab(L, a, b) {
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
    return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
  }
  /* OKLab: L clamped to [0.60, 0.72], chroma ≤ 0.16, hue kept, then pulled into sRGB. */
  function normalizeColor(hex) {
    try { if (typeof CalCore !== 'undefined' && CalCore.ready && CalCore.normalizeColor) { const c = CalCore.normalizeColor(hex); if (c) return c; } } catch (_) {}
    const rgb = hexToRgb(hex);
    if (!rgb) return null;
    const [L0, a0, b0] = oklab(rgb);
    const L = Math.min(0.72, Math.max(0.60, L0));
    let C = Math.min(0.16, Math.hypot(a0, b0));
    const hue = Math.atan2(b0, a0);
    let lin = linFromOklab(L, C * Math.cos(hue), C * Math.sin(hue));
    for (let i = 0; i < 24 && lin.some((v) => v < -1e-4 || v > 1 + 1e-4); i++) {
      C *= 0.9;
      lin = linFromOklab(L, C * Math.cos(hue), C * Math.sin(hue));
    }
    return '#' + lin.map((v) => Math.round(Math.min(1, Math.max(0, fromLin(Math.min(1, Math.max(0, v))))) * 255).toString(16).padStart(2, '0')).join('');
  }

  function nextColor() {
    const used = new Set(list().flatMap((f) => [lower(f.colorHex), lower(f.userColorHex)]));
    const norm = SERIES.map((c) => normalizeColor(c) || c);
    return norm.find((c) => !used.has(lower(c))) || norm[list().length % norm.length];
  }

  // ───────────────────────── URLs (serve.py normalize_url) ─────────────────────────

  function normalizeURL(raw) {
    let s = String(raw || '').trim();
    if (!s || s.length > 2048 || /[\r\n\t\x00 ]/.test(s)) return null;
    const low = s.toLowerCase();
    for (const p of ['webcals://', 'webcal://', 'http://']) {
      if (low.startsWith(p)) { s = 'https://' + s.slice(p.length); break; }
    }
    const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#.*)?$/i.exec(s);
    if (!m || m[1].toLowerCase() !== 'https') return null;
    const netloc = m[2];
    if (netloc.includes('@')) return null;
    const hp = /^(\[[^\]]+\]|[^:]+)(?::(\d*))?$/.exec(netloc);
    if (!hp) return null;
    const host = hp[1].replace(/\.+$/, '').toLowerCase();
    if (!host) return null;
    if (hp[2] !== undefined && hp[2] !== '' && Number(hp[2]) !== 443) return null;
    const path = m[3] || '/';
    return 'https://' + host + path + (m[4] ? '?' + m[4] : '');
  }

  /* Why normalizeURL refused a link, for a specific message (QA): this computer /
     a private network → blocked_host, a non-standard port → bad_port, else bad_url. */
  function urlProblem(raw) {
    const m = /^(?:webcals?|https?):\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)(?::(\d+))?/i.exec(String(raw || '').trim());
    if (!m) return 'bad_url';
    const host = m[1].replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase();
    if (/^(localhost|.*\.localhost|.*\.local|0\.0\.0\.0|::1?|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|f[cd][0-9a-f]*:.*|fe80:.*)$/.test(host)) return 'blocked_host';
    if (m[2] && Number(m[2]) !== 443) return 'bad_port';
    return 'bad_url';
  }

  function hostOf(url) { const m = /^https:\/\/([^/?#]+)/i.exec(url || ''); return m ? m[1].toLowerCase() : ''; }

  /* Display-only mask: host + "/…/" + the last path segment shortened; never the query. */
  function urlMask(url) {
    const n = normalizeURL(url);
    if (!n) return '';
    const host = hostOf(n);
    const path = n.slice(8 + host.length).split('?')[0];
    const segs = path.split('/').filter(Boolean);
    let last = segs.length ? decodeSafe(segs[segs.length - 1]) : '';
    if (last.length > 14) last = last.slice(0, 5) + '…' + last.slice(-8);
    return segs.length > 1 ? `${host}/…/${last}` : (last ? `${host}/${last}` : host);
  }
  function decodeSafe(s) { try { return decodeURIComponent(s); } catch (_) { return s; } }

  function readUrls() {
    try { const o = JSON.parse(localStorage.getItem(key(K_URLS)) || '{}'); return isObj(o) ? o : {}; } catch (_) { return {}; }
  }
  function writeUrls(o) { safeSet(key(K_URLS), JSON.stringify(o)); }
  function urlFor(id) { const u = readUrls()[id]; return typeof u === 'string' ? u : null; }
  function setUrl(id, url) { const o = readUrls(); o[id] = url; writeUrls(o); }
  function dropUrl(id) { const o = readUrls(); if (id in o) { delete o[id]; writeUrls(o); } }

  // ───────────────────────── the imported-event cache ─────────────────────────

  let cache = null;
  let cacheLoadedKey = null;

  function loadCache() {
    const k = key(K_CACHE);
    if (cache && cacheLoadedKey === k) return cache;
    let parsed = null;
    try { parsed = JSON.parse(localStorage.getItem(k) || 'null'); } catch (_) { parsed = null; }
    cache = {
      events: isObj(parsed) && Array.isArray(parsed.events) ? parsed.events.filter((e) => isObj(e) && typeof e.id === 'string' && e.start && e.end) : [],
      fetched: isObj(parsed) && isObj(parsed.fetched) ? parsed.fetched : {},
    };
    cacheLoadedKey = k;
    return cache;
  }
  function saveCache() { return safeSet(key(K_CACHE), JSON.stringify(cache)); }

  function events() { return loadCache().events; }

  /* Compact cache record → full read-only CalendarBlock fields used by the calendar. */
  function toBlock(e, feed) {
    return {
      id: String(e.id), title: String(e.title || '').slice(0, 200) || '(No title)',
      start: e.start, end: e.end, allDay: !!e.allDay, startDay: e.startDay || null, endDay: e.endDay || null,
      kind: 'event', taskID: null, category: null, colorHex: e.colorHex || null,
      notes: e.notes ? String(e.notes).slice(0, 6000) : null, location: e.location ? String(e.location).slice(0, 200) : null,
      attachments: Array.isArray(e.attachments) ? e.attachments : [], conference: e.conference || null,
      source: e.source === 'google' ? 'google' : 'ics', externalID: e.externalID || null,
      calendarID: feed ? feed.id : (e.calendarID || null), calendarName: feed ? feed.name : (e.calendarName || null),
      eventType: e.eventType || null, readOnly: true, isBusy: e.isBusy !== false,
      htmlLink: typeof e.htmlLink === 'string' && /^https:\/\//i.test(e.htmlLink) ? e.htmlLink : null,
      icalUID: e.icalUID || null, recurring: !!e.recurring, course: e.course || null,
      pomodoros: 0, plannedFocusMinutes: 0, autoPlanned: false, hidden: false,
      createdAt: e.updatedAt || nowISO(), plannedAt: e.updatedAt || nowISO(), updatedAt: e.updatedAt || nowISO(),
    };
  }

  /* Replace one feed's cached events: all of them, or only those intersecting [from, to). */
  function replaceEvents(feedID, list, range = null) {
    const c = loadCache();
    const from = range && range.from ? new Date(range.from).getTime() : null;
    const to = range && range.to ? new Date(range.to).getTime() : null;
    const inRange = (e) => {
      if (from == null || to == null) return true;
      const s = Date.parse(e.start), en = Date.parse(e.end);
      return s < to && Math.max(en, s + 1) > from;
    };
    const seen = new Set();
    const incoming = [];
    for (const e of list || []) {
      if (!e || !e.id || seen.has(e.id)) continue;
      seen.add(e.id);
      incoming.push({ ...e, calendarID: feedID });
    }
    c.events = c.events.filter((e) => !(e.calendarID === feedID && inRange(e)) && !seen.has(e.id)).concat(incoming);
    const stamp = [range && range.from ? new Date(range.from).toISOString() : null, range && range.to ? new Date(range.to).toISOString() : null, nowISO()];
    c.fetched[feedID] = [stamp];
    const ok = saveCache();
    emit('calcache');
    return ok;
  }

  function dropEvents(feedID) {
    const c = loadCache();
    const before = c.events.length;
    c.events = c.events.filter((e) => e.calendarID !== feedID);
    delete c.fetched[feedID];
    saveCache();
    if (c.events.length !== before) emit('calcache');
  }

  // ───────────────────────── feed records ─────────────────────────

  function list() { try { return Store.calendar().feeds.slice(); } catch (_) { return []; } }
  function get(id) { return list().find((f) => lower(f.id) === lower(id)) || null; }

  function baseFeed(f) {
    return {
      id: f.id, source: f.source || 'ics', name: String(f.name || 'Calendar').slice(0, 80), colorHex: f.colorHex || nextColor(),
      isVisible: f.isVisible !== false, isSynced: f.isSynced !== false, isPrimary: !!f.isPrimary, accessRole: f.accessRole || null,
      hasURL: !!f.hasURL, etag: f.etag || null, lastSyncedAt: f.lastSyncedAt || null, lastError: f.lastError || null,
      provider: f.provider || 'ics', groupKey: f.groupKey || null, blocksTime: f.blocksTime !== false,
      itemRole: ['auto', 'events', 'dueDates'].includes(f.itemRole) ? f.itemRole : 'auto',
      displayName: f.displayName || null, userColorHex: f.userColorHex || null,
      refreshMinutes: Number.isFinite(f.refreshMinutes) ? f.refreshMinutes : null, urlMask: f.urlMask || null, canvasHost: f.canvasHost || null,
    };
  }

  function upsertFeed(f) {
    if (!f || !f.id || typeof Store === 'undefined') return null;
    const feeds = list();
    const i = feeds.findIndex((x) => lower(x.id) === lower(f.id));
    const next = i >= 0 ? { ...feeds[i], ...f } : baseFeed(f);
    if (i >= 0) feeds[i] = next; else feeds.push(next);
    Store.updateCalendar({ feeds });
    return next;
  }

  const EDITABLE = ['isVisible', 'isSynced', 'displayName', 'userColorHex', 'blocksTime', 'itemRole', 'refreshMinutes',
    'groupKey', 'name', 'colorHex', 'lastError', 'lastSyncedAt', 'etag', 'provider'];

  function update(id, patch) {
    const f = get(id);
    if (!f || !isObj(patch)) return null;
    const clean = {};
    for (const k of EDITABLE) if (k in patch) clean[k] = patch[k];
    if ('displayName' in clean) clean.displayName = String(clean.displayName || '').trim().slice(0, 80) || null;
    if ('userColorHex' in clean) clean.userColorHex = clean.userColorHex ? normalizeColor(clean.userColorHex) : null;
    if ('itemRole' in clean && !['auto', 'events', 'dueDates'].includes(clean.itemRole)) delete clean.itemRole;
    const roleChanged = 'itemRole' in clean && clean.itemRole !== f.itemRole;
    const next = upsertFeed({ ...f, ...clean, id: f.id });
    if (roleChanged) resplit(next);
    return next;
  }

  /* Removes the feed, its events, its assignments and its link (tasks the user already has stay). */
  function remove(id) {
    const f = get(id);
    if (!f) return false;
    Store.updateCalendar({ feeds: list().filter((x) => lower(x.id) !== lower(id)) });
    dropEvents(f.id);
    try { Assignments.dropFeed(f.id); } catch (_) {}
    dropUrl(f.id);
    backoff.delete(f.id);
    emit('feeds:status');
    announce(`${f.displayName || f.name} removed`);
    return true;
  }

  // ───────────────────────── ICS → events + assignments (§6.2) ─────────────────────────

  const pad = (n) => String(n).padStart(2, '0');
  const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  function windowRange() {
    const t = new Date(); t.setHours(0, 0, 0, 0);
    const from = new Date(t); from.setDate(from.getDate() - WINDOW_BACK);
    const to = new Date(t); to.setDate(to.getDate() + WINDOW_AHEAD + 1);
    return { from, to };
  }

  /* parsed = ICS.parse output; feed = record. → {events:[cache records], assignments:[Assignment]} */
  function split(parsed, feed) {
    const host = feed.canvasHost || hostOf(urlFor(feed.id) || '');
    const fctx = { id: feed.id, provider: feed.provider, host, itemRole: feed.itemRole || 'auto' };
    const evs = [];
    const asg = [];
    for (const e of parsed || []) {
      const s = new Date(e.start);
      // a "PUREFOCUS:" event is always an event (js/calendar-tasks.js makes its task), even in a due-dates feed
      const own = typeof CalendarTasks !== 'undefined' && CalendarTasks.matches(e.title);
      const a = !own && typeof Assignments !== 'undefined' ? Assignments.fromICS({
        uid: e.uid, summary: e.title, url: e.url, description: e.notes, allDay: e.allDay, startDay: e.startDay,
        startISO: e.allDay ? null : s.toISOString(), startDayLocal: dayKey(s), startMinutes: s.getHours() * 60 + s.getMinutes(),
        recurring: !!e.recurring,
      }, fctx) : null;
      // what a due date doesn't need, kept so "These are events" gives the event back as it was
      if (a) { asg.push({ ...a, uid: e.uid || null, eventEnd: e.end || null, location: e.location || null, recurring: !!e.recurring }); continue; }
      // Canvas titles carry " [COURSE]": show the plain title and keep the course apart.
      const [plain, course] = feed.provider === 'canvas' && typeof Assignments !== 'undefined' ? Assignments.splitCourse(e.title) : [e.title, null];
      evs.push({
        id: e.id, title: plain, course: course || null, start: e.start, end: e.end, allDay: !!e.allDay, startDay: e.startDay || null, endDay: e.endDay || null,
        source: 'ics', notes: e.notes ? String(e.notes).slice(0, 6000) : null, location: e.location || null, isBusy: e.isBusy !== false,
        attachments: Array.isArray(e.attachments) && e.attachments.length ? e.attachments : undefined, conference: e.conference || undefined,
        htmlLink: typeof e.url === 'string' && /^https:\/\//i.test(e.url) ? e.url : null,
        icalUID: e.uid || null, externalID: e.uid || null, recurring: !!e.recurring, updatedAt: nowISO(),
      });
    }
    return { events: evs, assignments: asg };
  }

  /* A Blackbaud-like feed whose items are mostly all-day homework (v2-calendar §5.4). */
  function looksLikeHomework(parsed) {
    const items = parsed || [];
    if (items.length < 3) return false;
    const allDay = items.filter((e) => e.allDay).length / items.length;
    const hw = items.filter((e) => /\b(homework|hw|assignment|due|quiz|test|essay|worksheet|project|read|reading|lab)\b/i.test(e.title || '')).length / items.length;
    return allDay >= 0.6 && hw >= 0.3;
  }

  function apply(feed, parsed, { full = true } = {}) {
    const { events: evs, assignments: asg } = split(parsed, feed);
    replaceEvents(feed.id, evs);
    const { from, to } = windowRange();
    try { Assignments.replaceFeed(feed.id, asg, { full, from: dayKey(from), to: dayKey(to) }); Assignments.refreshPromotions(); } catch (_) { /* no assignments module */ }
    return { events: evs.length, assignments: asg.length };
  }

  /* itemRole changed: link feeds refetch; file feeds re-derive from the caches. */
  function resplit(feed) {
    if (feed.hasURL && urlFor(feed.id)) { refresh(feed.id, { force: true, noEtag: true }); return; }
    const evs = events().filter((e) => e.calendarID === feed.id);
    let asg = [];
    try { asg = Assignments.list({ includeDismissed: true }).filter((a) => a.feedID === feed.id); } catch (_) {}
    const parsed = evs.map((e) => ({ id: e.id, uid: e.icalUID, title: e.title, url: e.htmlLink, notes: e.notes, allDay: e.allDay,
      startDay: e.startDay, endDay: e.endDay, start: e.start, end: e.end, location: e.location, isBusy: e.isBusy, recurring: e.recurring,
      attachments: e.attachments, conference: e.conference }))
      .concat(asg.map((a) => {
        const start = a.due || (a.dueDay ? new Date(+a.dueDay.slice(0, 4), +a.dueDay.slice(5, 7) - 1, +a.dueDay.slice(8, 10)).toISOString() : null);
        if (!start) return null;
        const allDay = !a.due;
        const uid = a.uid || (String(a.id).startsWith(feed.id + ':') ? String(a.id).slice(feed.id.length + 1) : a.id);
        let endDay = null;
        if (allDay) { const d = new Date(start); d.setDate(d.getDate() + 1); endDay = dayKey(d); }
        return { id: `${feed.id}:${uid}:${(a.dueDay || '').replace(/-/g, '')}`, uid, title: a.course ? `${a.title} [${a.course}]` : a.title,
          url: a.url, notes: a.description, allDay, startDay: allDay ? a.dueDay : null, endDay, location: a.location || null, recurring: !!a.recurring,
          start, end: a.eventEnd || (allDay ? new Date(new Date(start).getTime() + 86400000).toISOString() : start), isBusy: !allDay };
      }).filter(Boolean));
    apply(feed, parsed, { full: false });
  }

  // ───────────────────────── files ─────────────────────────

  function fileBase(name) {
    return String(name || 'calendar').replace(/\.(ics|ical|icalendar|ifb)$/i, '').trim().slice(0, 80) || 'Imported calendar';
  }

  /* Each file → one feed `ics:<fnv1a32hex(lower(trim(X-WR-CALNAME ?? fileName)))>`; re-importing the
     same calendar replaces its events. ≤ 5 MB each; parse window today −14 … +120 days. */
  async function importFiles(files) {
    const out = { feeds: 0, events: 0, assignments: 0, results: [], errors: [] };
    if (typeof ICS === 'undefined') { out.errors.push({ name: '', message: 'The calendar reader didn’t load.' }); return out; }
    for (const f of Array.from(files || [])) {
      const name = fileBase(f && f.name);
      if (!f || f.size > FILE_MAX) { out.errors.push({ name, message: `${name} is over 5 MB. Export a shorter range.` }); continue; }
      let text;
      try { text = await f.text(); } catch (_) { out.errors.push({ name, message: `Couldn’t read ${name}.` }); continue; }
      if (!/^﻿?\s*BEGIN:VCALENDAR/i.test(String(text).slice(0, 2048))) {
        out.errors.push({ name, message: `${name} isn’t an .ics calendar file.` });
        continue;
      }
      const { from, to } = windowRange();
      let parsed;
      try {
        const probe = ICS.parseRaw(text, { from, to });
        const calName = String(probe.name || name).trim().slice(0, 80) || name;
        const id = 'ics:' + fnv(calName.toLowerCase());
        parsed = ICS.parse(text, { from, to, calendarName: calName, feedID: id });
        parsed.feedID = id;
      } catch (_) { out.errors.push({ name, message: `Couldn’t read ${name}. Is it an .ics calendar file?` }); continue; }
      const existing = get(parsed.feedID);
      const provider = (typeof Assignments !== 'undefined' ? Assignments.detectProvider(null, parsed.prodid) : 'ics');
      const feed = upsertFeed(existing ? { id: existing.id, lastSyncedAt: nowISO(), lastError: null } : {
        id: parsed.feedID, source: 'ics', name: parsed.calendarName, provider, groupKey: 'files',
        colorHex: normalizeColor(parsed.color) || nextColor(), itemRole: provider === 'canvas' ? 'auto' : 'events',
        lastSyncedAt: nowISO(),
      });
      const n = apply(feed, parsed);
      out.feeds++;
      out.events += n.events;
      out.assignments += n.assignments;
      out.results.push({ feed, name: feed.name, events: n.events, assignments: n.assignments, isNew: !existing, homeworkLike: provider === 'blackbaud' && looksLikeHomework(parsed) });
    }
    if (out.results.length) announce(out.results.map((r) => `${r.name} added, ${r.events} events`).join('. '));
    return out;
  }

  // ───────────────────────── the proxy (serve.py or the cloud function) ─────────────────────────

  let mode = null;
  let modeCheckedAt = 0;

  function cloudReady() {
    try { return typeof Cloud !== 'undefined' && Cloud.isConfigured() && Cloud.isSignedIn(); } catch (_) { return false; }
  }

  async function proxyMode() {
    if (mode === 'local' || mode === 'cloud') return mode;
    if (mode === 'none' && Date.now() - modeCheckedAt < 60000) return mode;
    modeCheckedAt = Date.now();
    try {
      const r = await fetch('/__pf/health', { headers: { 'X-PF-Proxy': '1' }, cache: 'no-store' });
      if (r.ok && (await r.json()).app === 'purefocus') return (mode = 'local');
    } catch (_) { /* a static host */ }
    if (cloudReady()) {
      try {
        const caps = await Cloud.capabilities();
        if (caps && caps.calendarProxy && Cloud.functionURL('calendar-proxy')) return (mode = 'cloud');
      } catch (_) { /* not deployed */ }
    }
    return (mode = 'none');
  }
  function knownMode() { return mode; }

  async function fetchICS(url, etag) {
    const m = await proxyMode();
    if (m === 'none') throw { code: 'no_proxy' };
    const headers = { 'X-PF-Proxy': '1' };
    if (etag) headers['X-PF-If-None-Match'] = etag;
    let base = '/__pf/proxy';
    if (m === 'cloud') {
      base = Cloud.functionURL('calendar-proxy');
      headers.Authorization = 'Bearer ' + (await Cloud.idToken());
      try { const cfg = Cloud.config(); if (cfg && cfg.key) headers.apikey = cfg.key; } catch (_) {}
    }
    let r;
    try {
      if (m === 'cloud') {
        // POST keeps the secret feed URL out of the request line (and logs).
        headers['Content-Type'] = 'application/json';
        r = await fetch(base, { method: 'POST', headers, body: JSON.stringify({ url, etag: etag || null }), cache: 'no-store' });
      } else {
        r = await fetch(`${base}?url=${encodeURIComponent(url)}`, { headers, cache: 'no-store' });
      }
    } catch (_) {
      if (m === 'local') mode = null;          // the helper may have stopped; look again next time
      throw { code: navigator.onLine === false ? 'offline' : 'connect_failed' };
    }
    if (r.status === 304) return { status: 304, etag: etag || null };
    if (!r.ok) {
      let e = {};
      try { e = await r.json(); } catch (_) { /* not JSON */ }
      throw { code: e.error || 'upstream', status: e.upstreamStatus || r.status, message: e.message };
    }
    return { status: 200, text: await r.text(), etag: r.headers.get('X-PF-ETag') || null };
  }

  const COPY = {
    bad_url: 'That doesn’t look like a calendar link. Copy the iCal/ICS link.',
    bad_host: 'That doesn’t look like a calendar link. Copy the iCal/ICS link.',
    blocked_host: 'Links to this computer or a private network can’t be added.',
    bad_port: 'Links with a port number (like :8080) can’t be added. Download the .ics file and use Import a .ics file instead.',
    dns_failed: 'Couldn’t reach that calendar. Check the link or your connection.',
    connect_failed: 'Couldn’t reach that calendar. Check the link or your connection.',
    bad_upstream: 'Couldn’t reach that calendar. Check the link or your connection.',
    too_many_redirects: 'Couldn’t reach that calendar. Check the link or your connection.',
    offline: 'You’re offline. We’ll try again when you’re back.',
    tls_error: 'Couldn’t make a secure connection to that calendar.',
    timeout: 'That calendar took too long to answer. We’ll try again later.',
    too_large: 'That calendar is too large (over 10 MB). Export a shorter range.',
    not_calendar: 'That link opened a web page, not a calendar. Use the iCal/ICS link.',
    rate_limited: 'Too many refreshes. Try again in a minute.',
    canvas_not_linked: 'Canvas details need your access token again.',
    canvas_unauthorized: 'Canvas details need your access token again.',
    no_proxy: 'Calendar links aren’t available right now. Import the .ics file instead.',
  };
  function errorCopy(err) {
    const e = err || {};
    if (e.code === 'upstream_status') {
      return [401, 403, 404, 410].includes(Number(e.status))
        ? 'This calendar link no longer works. It may have been reset. Copy a fresh link.'
        : `The calendar server had a problem (HTTP ${Number(e.status) || '?'}). We’ll retry.`;
    }
    return COPY[e.code] || 'Something went wrong. Try again in a moment.';
  }

  // ───────────────────────── subscribe ─────────────────────────

  function providerLabel(p) { return PROVIDER_LABEL[p] || PROVIDER_LABEL.ics; }
  function defaultGroup(provider) { return provider === 'canvas' || provider === 'blackbaud' ? 'school' : 'links'; }
  function defaultRole(provider) { return provider === 'canvas' || provider === 'blackbaud' ? 'auto' : 'events'; }
  function refreshMinutesOf(f) { return Number.isFinite(f.refreshMinutes) && f.refreshMinutes > 0 ? f.refreshMinutes : (DEFAULT_REFRESH[f.provider] || LIVE_MINUTES); }

  function parseText(text, feedID, name) {
    const { from, to } = windowRange();
    return ICS.parse(text, { from, to, calendarName: name || 'Calendar', feedID });
  }

  async function subscribe(raw, { name = null } = {}) {
    const url = normalizeURL(raw);
    if (!url) throw { code: urlProblem(raw) };
    const id = 'icsurl:' + fnv(url);
    const existing = get(id);
    if (existing && urlFor(id)) return { feed: existing, already: true, events: 0, assignments: 0 };
    if (existing) {                       // "Add it again": this device lost the link, the calendar keeps its settings
      setUrl(id, url);
      update(id, { lastError: null });
      await refresh(id, { force: true, noEtag: true });
      return { feed: get(id), already: false, events: events().filter((e) => e.calendarID === id).length, assignments: 0 };
    }
    const res = await fetchICS(url);
    if (res.status !== 200 || !res.text) throw { code: 'not_calendar' };
    if (!/^﻿?\s*BEGIN:VCALENDAR/i.test(res.text.slice(0, 2048))) throw { code: 'not_calendar' };
    let parsed;
    try { parsed = parseText(res.text, id, name); } catch (_) { throw { code: 'not_calendar' }; }
    const provider = Assignments.detectProvider(url, parsed.prodid);
    const label = providerLabel(provider);
    const feedName = String(name || (parsed.namedInFile ? parsed.calendarName : '') || label).trim().slice(0, 80) || label;
    setUrl(id, url);
    const feed = upsertFeed({
      id, source: 'ics', name: feedName, provider, groupKey: defaultGroup(provider), hasURL: true,
      colorHex: nextColor(), itemRole: defaultRole(provider), etag: res.etag, lastSyncedAt: nowISO(), lastError: null,
      urlMask: urlMask(url), canvasHost: provider === 'canvas' ? hostOf(url) : null,
    });
    const n = apply(feed, parsed);
    parsedOn.set(id, dayKey(new Date()));
    emit('feeds:status');
    announce(`${feedName} added, ${n.events} events${n.assignments ? `, ${n.assignments} assignments` : ''}`);
    return { feed, already: false, events: n.events, assignments: n.assignments,
      homeworkLike: provider === 'blackbaud' && looksLikeHomework(parsed) };
  }

  // ───────────────────────── refresh scheduler ─────────────────────────

  const backoff = new Map();      // feedID → {fails, until}
  const running = new Set();
  let queue = Promise.resolve();
  let lastTick = 0;

  const checkedAt = new Map();      // feedID → when it was last asked (lastSyncedAt is only saved now and then)
  const lastText = new Map();       // feedID → fingerprint of the last calendar text
  const parsedOn = new Map();       // feedID → the day it was last parsed: the window moves even when the text doesn't
  function isDue(f, now = Date.now(), minAgeMs = null) {
    if (!f.hasURL || f.isSynced === false) return false;
    const b = backoff.get(f.id);
    if (b && b.until > now) return false;
    const last = Math.max(f.lastSyncedAt ? Date.parse(f.lastSyncedAt) : 0, checkedAt.get(f.id) || 0);
    if (!last) return true;
    const hiddenTab = typeof document !== 'undefined' && document.hidden;
    const wait = minAgeMs != null ? minAgeMs : Math.max(refreshMinutesOf(f), hiddenTab ? HIDDEN_MINUTES : 0) * 60000;
    return now - last >= wait;
  }

  async function refreshOne(f, { noEtag = false, quiet = false } = {}) {
    const url = urlFor(f.id);
    if (!url) { update(f.id, { lastError: 'This calendar link is missing on this device. Add it again.' }); return; }
    if (running.has(f.id)) return;
    running.add(f.id);
    checkedAt.set(f.id, Date.now());
    if (!quiet) emit('feeds:status');
    try {
      const hasCached = events().some((e) => e.calendarID === f.id)
        || (typeof Assignments !== 'undefined' && Assignments.list({ includeDismissed: true }).some((a) => a.feedID === f.id));
      const today = dayKey(new Date());
      const fresh = !noEtag && parsedOn.get(f.id) === today;   // otherwise it's read again, changed or not
      let res = await fetchICS(url, !fresh || !hasCached ? null : f.etag);
      if (res.status === 304 && !hasCached) res = await fetchICS(url, null);
      if (!get(f.id)) return null;           // removed while it was loading
      backoff.delete(f.id);
      // Unchanged: some calendars never say so with an ETag, and Google re-stamps every DTSTAMP on
      // each fetch, so the text is compared without those lines. Saved only now and then, so a check
      // every couple of minutes doesn't rewrite your data each time.
      const sig = res.status === 304 ? null : fnv(String(res.text || '').replace(/^DTSTAMP[^\n]*\n/gm, ''));
      if (res.status === 304 || (hasCached && fresh && sig === lastText.get(f.id))) {
        const age = Date.now() - (f.lastSyncedAt ? Date.parse(f.lastSyncedAt) : 0);
        if (f.lastError || age > 10 * 60000) update(f.id, { lastSyncedAt: nowISO(), lastError: null });
        return;
      }
      if (!/^﻿?\s*BEGIN:VCALENDAR/i.test(String(res.text || '').slice(0, 2048))) throw { code: 'not_calendar' };
      const parsed = parseText(res.text, f.id, f.name);
      const n = apply(get(f.id), parsed);
      lastText.set(f.id, sig);
      parsedOn.set(f.id, today);
      update(f.id, { etag: res.etag, lastSyncedAt: nowISO(), lastError: null });
      return n;
    } catch (err) {
      const prev = backoff.get(f.id);
      const fails = prev ? prev.fails + 1 : 1;
      backoff.set(f.id, { fails, until: Date.now() + BACKOFF[Math.min(BACKOFF.length - 1, fails - 1)] * 60000 });
      if (get(f.id)) update(f.id, { lastError: errorCopy(err) });
      return null;
    } finally {
      running.delete(f.id);
      if (!quiet) emit('feeds:status');
    }
  }

  /* refresh(id) refreshes that feed now; refresh() refreshes every due link feed (force: all),
     two at a time. Errors stay on the feed (lastError) and back off 5 → 15 → 60 min. */
  function refresh(id, { force = false, noEtag = false, minAgeMs = null, quiet = false } = {}) {
    const job = async () => {
      const targets = id ? [get(id)].filter((f) => f && f.hasURL) : list().filter((f) => f.hasURL && (force || isDue(f, Date.now(), minAgeMs)));
      if (!targets.length) return;
      if ((await proxyMode()) === 'none') {
        for (const f of targets) if (force || id) update(f.id, { lastError: errorCopy({ code: 'no_proxy' }) });
        return;
      }
      const pending = targets.slice();
      const worker = async () => { while (pending.length) await refreshOne(pending.shift(), { noEtag, quiet }); };
      await Promise.all([worker(), worker()]);
    };
    queue = queue.then(job, job);
    return queue;
  }

  function status() {
    const feeds = list().filter((f) => f.hasURL || f.source === 'google');
    const errors = {};
    for (const f of feeds) if (f.lastError) errors[f.id] = f.lastError;
    const stamps = feeds.map((f) => (f.lastSyncedAt ? Date.parse(f.lastSyncedAt) : 0)).filter(Boolean);
    const lastSyncAt = stamps.length ? new Date(Math.max(...stamps)).toISOString() : null;
    const oldest = stamps.length ? Math.min(...stamps) : 0;
    let state = 'idle';
    if (feeds.length) {
      if (Object.keys(errors).length) state = 'error';
      else if (mode === 'none' && feeds.some((f) => f.hasURL)) state = 'stale';
      else if (oldest && Date.now() - oldest > 12 * 3600000) state = 'stale';
      else state = 'ok';
    }
    return { mode: mode || 'unknown', refreshing: Array.from(running), errors, lastSyncAt, state, linked: feeds.length };
  }

  // Background checks are quiet: nothing on screen moves unless the calendar really changed.
  function tick(minAgeMs = null) {
    lastTick = Date.now();
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    if (list().some((f) => f.hasURL)) refresh(null, { minAgeMs, quiet: true });
  }

  let inited = false;
  function init() {
    if (inited) return;
    inited = true;
    loadCache();
    try {
      Store.on('change', (kind) => {
        if (kind === 'reset' || kind === 'remote') {
          cache = null;
          // drop cached events of feeds that no longer exist (reset, another device removed it)
          const ids = new Set(list().map((f) => f.id));
          const c = loadCache();
          const before = c.events.length;
          c.events = c.events.filter((e) => ids.has(e.calendarID));
          if (c.events.length !== before) saveCache();
          emit('calcache');
        }
      });
    } catch (_) { /* no store */ }
    const idle = (fn) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 6000 }) : setTimeout(fn, 0));
    setTimeout(() => idle(tick), 3000);
    setInterval(() => tick(), 30000);
    try {
      window.addEventListener('online', () => { mode = mode === 'none' ? null : mode; tick(); });
      // back from Google Calendar in another tab or app: look now
      const back = () => { if (!document.hidden) tick(RETURN_SECONDS * 1000); };
      document.addEventListener('visibilitychange', back);
      window.addEventListener('focus', back);
    } catch (_) { /* no DOM */ }
  }

  // ───────────────────────── the Add calendar sheet (v2-calendar §8.3, SPEC-V2 §5.5) ─────────────────────────
  //  Paste field with a live provider pill → 8 tiles → tile pages (≤ 4 steps) → result.
  //  Honest paths: Canvas/Blackbaud/Outlook/iCloud/Google-secret links need the helper (serve.py) or the
  //  cloud proxy; .ics files always work; Samsung goes through Google; Apple on the web = public link or file.

  const SVG = {
    chev: '<svg viewBox="0 0 20 20"><path d="M7.5 5l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    x: '<svg viewBox="0 0 20 20"><path d="m5.5 5.5 9 9m0-9-9 9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    back: '<svg viewBox="0 0 20 20"><path d="M12.5 4.5 7 10l5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    cap: '<svg viewBox="0 0 24 24"><path d="M2.5 9.5 12 5l9.5 4.5L12 14 2.5 9.5Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M6.5 11.4v4.3c0 1.2 2.5 2.8 5.5 2.8s5.5-1.6 5.5-2.8v-4.3M21.5 9.5v5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    columns: '<svg viewBox="0 0 24 24"><path d="M3.5 9 12 4l8.5 5M4.5 9.5h15M6 10v7M10 10v7M14 10v7M18 10v7M3.5 19.5h17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    cal: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15" rx="3.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3.7 9.8h16.6M8.3 3.3v3.2M15.7 3.3v3.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M8 13.5h2.5M13.5 13.5H16M8 16.5h2.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    cloud: '<svg viewBox="0 0 24 24"><path d="M7.2 18.5h9.9a4 4 0 0 0 .6-7.95 5.6 5.6 0 0 0-10.6-1A4.5 4.5 0 0 0 7.2 18.5Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    envelope: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5.5" width="17" height="13" rx="3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m4.5 7.5 7.5 5.5 7.5-5.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    phone: '<svg viewBox="0 0 24 24"><rect x="6.5" y="2.8" width="11" height="18.4" rx="2.8" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10.5 18h3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    link: '<svg viewBox="0 0 24 24"><path d="M10.3 13.7a3.6 3.6 0 0 0 5.1 0l3-3a3.6 3.6 0 0 0-5.1-5.1l-1 1M13.7 10.3a3.6 3.6 0 0 0-5.1 0l-3 3a3.6 3.6 0 0 0 5.1 5.1l1-1" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    doc: '<svg viewBox="0 0 24 24"><path d="M6.8 3.3h6.8l4.6 4.6v11.2a1.8 1.8 0 0 1-1.8 1.8H6.8A1.8 1.8 0 0 1 5 19.1V5.1a1.8 1.8 0 0 1 1.8-1.8Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M13.2 3.6v4.6h4.6M8.5 13h7M8.5 16.5h4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    check: '<svg viewBox="0 0 20 20"><path d="M4.5 10.5 8.5 14.5 15.5 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    sparkle: '<svg viewBox="0 0 20 20"><path d="M10 2.8c.5 3.6 1.6 4.7 5.2 5.2-3.6.5-4.7 1.6-5.2 5.2-.5-3.6-1.6-4.7-5.2-5.2 3.6-.5 4.7-1.6 5.2-5.2Z" fill="currentColor"/></svg>',
    info: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 9v4.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="10" cy="6.4" r="1.05" fill="currentColor"/></svg>',
    copy: '<svg viewBox="0 0 20 20"><rect x="7" y="7" width="9.5" height="9.5" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M13 7V5.2A1.7 1.7 0 0 0 11.3 3.5H5.2A1.7 1.7 0 0 0 3.5 5.2v6.1A1.7 1.7 0 0 0 5.2 13H7" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  };

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'dataset') Object.assign(n.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (v === true) n.setAttribute(k, '');
      else n.setAttribute(k, String(v));
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) n.appendChild(typeof kid === 'object' ? kid : document.createTextNode(String(kid)));
    return n;
  }
  function svg(name, cls) {
    const t = document.createElement('template');
    t.innerHTML = SVG[name];                      // static markup only
    const s = t.content.firstElementChild;
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('class', 'pfa-i' + (cls ? ' ' + cls : ''));
    return s;
  }

  const TILES = [
    { id: 'canvas', name: 'Canvas', sub: 'Classes & assignments', icon: 'cap' },
    { id: 'blackbaud', name: 'Blackbaud', sub: 'School events', icon: 'columns' },
    { id: 'google', name: 'Google', sub: 'Calendar & Tasks', icon: 'cal' },
    { id: 'apple', name: 'Apple / iCloud', sub: 'Public link or file', icon: 'cloud' },
    { id: 'outlook', name: 'Outlook', sub: 'Publish link', icon: 'envelope' },
    { id: 'samsung', name: 'Samsung', sub: 'Through Google', icon: 'phone' },
    { id: 'link', name: 'Other link', sub: 'Any iCal link', icon: 'link' },
    { id: 'file', name: '.ics file', sub: 'From any calendar app', icon: 'doc' },
  ];

  const PAGES = {
    canvas: {
      title: 'Canvas', lead: 'Your classes, plus every assignment with its due date.',
      steps: ['In Canvas, open Calendar.', 'In the right sidebar, click Calendar Feed.', 'Copy the link it shows.', 'Paste it here.'],
      note: 'The feed covers all your courses, 30 days back to a year ahead. Changes in Canvas show up within about an hour.',
      placeholder: 'https://yourschool.instructure.com/feeds/calendars/user_…ics',
    },
    blackbaud: {
      title: 'Blackbaud', lead: 'School events from myschoolapp — and homework, if your school includes it.',
      steps: ['In myschoolapp, open Calendar.', 'Click the feed (RSS) icon at the top right.', 'Choose your calendars, click Subscribe and copy the iCal link.', 'Paste it here.'],
      note: 'No feed icon? Your school has turned calendar feeds off. Ask your school’s tech office, or add events from Google instead. Blackbaud updates feeds about once an hour.',
      placeholder: 'webcal://yourschool.myschoolapp.com/…',
    },
    outlook: {
      title: 'Outlook', lead: 'An Outlook or Microsoft 365 calendar, through its published link.',
      steps: ['In Outlook on the web, open Settings › Calendar › Shared calendars.', 'Under “Publish a calendar”, pick the calendar and “Can view all details”, then Publish.', 'Copy the ICS link.', 'Paste it here.'],
      note: 'Classic desktop Outlook can’t publish, and some school accounts turn publishing off.',
      placeholder: 'https://outlook.office365.com/owa/calendar/…/calendar.ics',
    },
    link: {
      title: 'Other link', lead: 'Any calendar that gives you an iCal, ICS or webcal link.',
      steps: ['Find the calendar’s “subscribe”, “iCal” or “ICS” link.', 'Copy it.', 'Paste it here.'],
      note: 'Links stay in this browser and are never shared or exported.',
      placeholder: 'webcal://… or https://….ics',
    },
  };

  /* "Where do I find my link?" — one folded entry per source (USER-HOTFIX-1 H7). */
  const GUIDES = [
    { id: 'google', name: 'Google Calendar', sub: 'Secret address in iCal format', icon: 'cal',
      steps: ['On a computer, open calendar.google.com and click the gear › Settings.', 'On the left, under “Settings for my calendars”, click your calendar.', 'Scroll to “Integrate calendar” and copy “Secret address in iCal format”.', 'Paste it above and click Add.'],
      note: 'Keep this address private: anyone with it can see that calendar. Some school accounts hide it.', warn: true },
    { id: 'apple', name: 'Apple / iCloud', sub: 'Public Calendar link', icon: 'cloud',
      steps: ['On iCloud.com (or Calendar on iPhone/Mac), open the calendar’s share settings.', 'Turn on “Public Calendar”.', 'Copy the link (it starts with webcal://).', 'Paste it above and click Add.'],
      note: 'A public calendar can be read by anyone who has the link. Prefer a file? On a Mac: Calendar › File › Export, then use “Import a .ics file”.' },
    { id: 'outlook', name: 'Outlook / Microsoft 365', sub: 'Publish calendar → ICS', icon: 'envelope',
      steps: ['In Outlook on the web, open Settings › Calendar › Shared calendars.', 'Under “Publish a calendar”, pick the calendar and “Can view all details”, then Publish.', 'Copy the ICS link.', 'Paste it above and click Add.'],
      note: 'Some work and school accounts turn publishing off.' },
    { id: 'canvas', name: 'Canvas', sub: 'Calendar Feed', icon: 'cap',
      steps: ['In Canvas, open Calendar.', 'In the right-hand sidebar, click “Calendar Feed”.', 'Copy the link it shows.', 'Paste it above and click Add.'],
      note: 'You get your classes plus every assignment with its due date; assignments can go straight onto Today’s Tasks.' },
    { id: 'blackbaud', name: 'Blackbaud (myschoolapp)', sub: 'Subscribe', icon: 'columns',
      steps: ['In myschoolapp, open Calendar.', 'Click the feed icon at the top right, choose your calendars, then click Subscribe.', 'Copy the iCal link.', 'Paste it above and click Add.'],
      note: 'No feed icon? Your school has turned calendar feeds off — ask the school’s tech office.' },
    { id: 'samsung', name: 'Samsung Calendar', sub: 'Sync through Google, or export a file', icon: 'phone',
      steps: ['Samsung Calendar has no shareable link.', 'Easiest: in Samsung Calendar › Settings › Manage calendars, add your Google account and save events to it — then use the Google steps above.', 'Or export the calendar as a .ics file and use “Import a .ics file” below.'] },
    { id: 'other', name: 'Any other calendar', sub: 'iCal / ICS / webcal link', icon: 'link',
      steps: ['Look for “Subscribe”, “iCal”, “ICS” or “webcal” in the calendar’s settings or share menu.', 'Copy that link.', 'Paste it above and click Add.'] },
  ];

  let sheet = null;          // {root, back, page, prevFocus, mode}

  function closeAddSheet() {
    if (!sheet) return;
    const s = sheet;
    sheet = null;
    document.removeEventListener('keydown', s.onKey, true);
    s.root.remove();
    s.back.remove();
    try { if (s.prevFocus && s.prevFocus.isConnected) s.prevFocus.focus(); } catch (_) {}
  }

  function openAddSheet(opts = {}) {
    if (typeof document === 'undefined') return;
    closeAddSheet();
    const back = el('div', { class: 'pfa-back', onclick: () => closeAddSheet() });
    const root = el('div', { class: 'pfa-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'pfa-title' });
    const onKey = (ev) => {
      if (!sheet) return;
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); if (sheet.page !== 'home' && sheet.page !== 'result') show('home'); else closeAddSheet(); return; }
      if (ev.key === 'Tab') {                      // keep focus inside the sheet
        const f = Array.from(root.querySelectorAll('button, input, a[href], [tabindex="0"]')).filter((x) => !x.disabled && x.offsetParent !== null);
        if (!f.length) return;
        const i = f.indexOf(document.activeElement);
        if (ev.shiftKey && (i <= 0)) { ev.preventDefault(); f[f.length - 1].focus(); }
        else if (!ev.shiftKey && i === f.length - 1) { ev.preventDefault(); f[0].focus(); }
      }
    };
    root.addEventListener('dragover', (ev) => { if (ev.dataTransfer && Array.from(ev.dataTransfer.types || []).includes('Files')) { ev.preventDefault(); root.classList.add('is-drop'); } });
    root.addEventListener('dragleave', (ev) => { if (ev.target === root) root.classList.remove('is-drop'); });
    root.addEventListener('drop', (ev) => {
      root.classList.remove('is-drop');
      const files = ev.dataTransfer ? Array.from(ev.dataTransfer.files || []) : [];
      if (!files.length) return;
      ev.preventDefault();
      addFiles(files);
    });
    sheet = { root, back, page: 'home', prevFocus: document.activeElement, onKey, mode: mode || null };
    document.body.appendChild(back);
    document.body.appendChild(root);
    document.addEventListener('keydown', onKey, true);
    show(opts.tile && (PAGES[opts.tile] || ['google', 'apple', 'samsung', 'file'].includes(opts.tile)) ? opts.tile : 'home');
    proxyMode().then((m) => {
      if (!sheet) return;
      const was = sheet.mode;
      sheet.mode = m;
      if (m === 'none' && was !== 'none' && sheet.page !== 'result') show(sheet.page, { keepInput: true });
    });
  }

  function head(title, { backTo = null } = {}) {
    return el('div', { class: 'pfa-head' },
      backTo ? el('button', { class: 'pfa-icon-btn', type: 'button', 'aria-label': 'Back', onclick: () => show(backTo) }, svg('back')) : null,
      el('h2', { class: 'pfa-title', id: 'pfa-title', text: title }),
      el('button', { class: 'pfa-icon-btn pfa-close', type: 'button', 'aria-label': 'Close', onclick: () => closeAddSheet() }, svg('x')));
  }

  function noHelper() {
    return el('div', { class: 'pfa-notice', role: 'note' },
      el('p', { class: 'pfa-notice-p' }, 'Calendar links aren’t available right now. You can import a .ics file instead.'),
      el('div', { class: 'pfa-row' },
        el('button', { class: 'btn btn-sm', type: 'button', onclick: () => pickFiles() }, svg('doc'), 'Choose file')));
  }

  /* The link field: live provider pill, Enter = Add, inline error. */
  function linkField({ placeholder = 'Paste a calendar link', autofocus = false, label = 'Add calendar', expect = null } = {}) {
    const input = el('input', { class: 'pfa-input', type: 'url', inputmode: 'url', autocomplete: 'off', spellcheck: 'false', placeholder,
      'aria-label': 'Calendar link', 'aria-describedby': 'pfa-help' });
    const pill = el('span', { class: 'pfa-pill', hidden: true });
    const err = el('p', { class: 'pfa-error', role: 'alert', hidden: true });
    const btn = el('button', { class: 'btn btn-primary pfa-add', type: 'submit' }, label);
    const update = () => {
      const v = input.value.trim();
      const n = normalizeURL(v);
      err.hidden = true;
      input.removeAttribute('aria-invalid');
      if (!n) { pill.hidden = true; return; }
      const p = Assignments.detectProvider(n);
      pill.textContent = p === 'ics' ? 'Calendar link' : (p === 'google' ? 'Google' : providerLabel(p));
      pill.hidden = false;
    };
    input.addEventListener('input', update);
    const form = el('form', { class: 'pfa-field', onsubmit: async (ev) => {
      ev.preventDefault();
      const v = input.value.trim();
      if (!v) { input.focus(); return; }
      btn.disabled = true;
      btn.classList.add('is-busy');
      btn.textContent = 'Adding…';
      try {
        const r = await subscribe(v);
        if (r.already) {
          closeAddSheet();
          toast(`“${r.feed.displayName || r.feed.name}” is already added`);
          try { if (typeof CalendarView !== 'undefined' && CalendarView.revealFeed) CalendarView.revealFeed(r.feed.id); } catch (_) {}
          return;
        }
        showResult(r);
      } catch (e) {
        err.textContent = errorCopy(e && e.code ? e : { code: 'connect_failed' });
        err.hidden = false;
        input.setAttribute('aria-invalid', 'true');
        if (e && e.code === 'no_proxy' && sheet) { sheet.mode = 'none'; show(sheet.page, { keepInput: true }); }
      } finally {
        btn.disabled = false;
        btn.classList.remove('is-busy');
        btn.textContent = label;
      }
    } },
    el('div', { class: 'pfa-input-wrap' }, input, pill), btn);
    if (expect) form.dataset.expect = expect;
    if (autofocus) setTimeout(() => { try { input.focus({ preventScroll: true }); } catch (_) {} }, 30);
    return { form, input, err };
  }

  function steps(list) {
    return el('ol', { class: 'pfa-steps' }, list.map((s, i) => el('li', null, el('span', { class: 'pfa-step-n', text: String(i + 1) }), el('span', { text: s }))));
  }

  let lastInput = '';

  function show(page, { keepInput = false } = {}) {
    if (!sheet) return;
    const root = sheet.root;
    const prevVal = keepInput ? (root.querySelector('.pfa-input') || {}).value || lastInput : '';
    lastInput = prevVal;
    sheet.page = page;
    root.textContent = '';
    root.dataset.page = page;
    const linksOk = sheet.mode !== 'none';
    const body = el('div', { class: 'pfa-body' });
    if (page === 'home') {
      // H7: one obvious path — paste a link. Help per source is folded away below it;
      // Google sign-in and .ics files are the secondary options.
      root.appendChild(head('Add a calendar'));
      body.appendChild(el('p', { class: 'pfa-lead', text: 'Paste the link of a calendar you use (school, Google, iCloud, Outlook…). Its events show up here and stay up to date.' }));
      // Keep the field visible even when no proxy is available: the steps below
      // still say "paste it above", and the notice explains how to enable it.
      if (!linksOk) body.appendChild(noHelper());
      {
        const f = linkField({ autofocus: true, placeholder: 'https://… or webcal://…' });
        body.appendChild(el('label', { class: 'pfa-label', for: 'pfa-link', text: 'Paste a calendar link (https:// or webcal://)' }));
        f.input.id = 'pfa-link';
        body.appendChild(f.form);
        body.appendChild(f.err);
        if (prevVal) { f.input.value = prevVal; f.input.dispatchEvent(new Event('input')); }
      }
      body.appendChild(el('h3', { class: 'pfa-overline', id: 'pfa-help', text: 'Where do I find my link?' }));
      const guides = el('div', { class: 'pfa-guides' });
      for (const g of GUIDES) {
        const d = el('details', { class: 'pfa-src', dataset: { src: g.id } },
          el('summary', { class: 'pfa-src-sum' },
            el('span', { class: 'pfa-src-ic' }, svg(g.icon)),
            el('span', { class: 'pfa-src-name', text: g.name }),
            el('span', { class: 'pfa-src-sub', text: g.sub }),
            svg('chev', 'pfa-src-chev')),
          el('div', { class: 'pfa-src-body' },
            steps(g.steps),
            g.note ? el('p', { class: 'pfa-note' + (g.warn ? ' is-warn' : '') }, svg('info'), el('span', { text: g.note })) : null,
            g.action ? el('div', { class: 'pfa-row' }, el('button', { class: 'btn btn-sm', type: 'button', onclick: g.action.run }, svg(g.action.icon), g.action.label)) : null));
        d.addEventListener('toggle', () => { if (d.open) guides.querySelectorAll('details[open]').forEach((o) => { if (o !== d) o.open = false; }); });
        guides.appendChild(d);
      }
      body.appendChild(guides);
      body.appendChild(el('h3', { class: 'pfa-overline', text: 'Other ways to add' }));
      const other = el('div', { class: 'pfa-row pfa-other' });
      let gConfigured = false;
      try { gConfigured = typeof GoogleSync !== 'undefined' && GoogleSync.isConfigured(); } catch (_) {}
      if (gConfigured) other.appendChild(el('button', { class: 'btn btn-sm', type: 'button', title: 'Sign in with Google to import Google Calendar and Tasks', onclick: () => show('google') }, svg('cal'), 'Sign in with Google'));
      other.appendChild(el('button', { class: 'btn btn-sm', type: 'button', title: 'Import a calendar file (.ics) exported from any calendar app', onclick: () => pickFiles() }, svg('doc'), 'Import a .ics file'));
      body.appendChild(other);
      body.appendChild(el('p', { class: 'pfa-foot', text: 'Added calendars are read-only. Links stay in this browser and are never shared.' }));
    } else if (PAGES[page]) {
      const P = PAGES[page];
      root.appendChild(head(P.title, { backTo: 'home' }));
      body.appendChild(el('p', { class: 'pfa-lead', text: P.lead }));
      body.appendChild(steps(P.steps));
      if (!linksOk) body.appendChild(noHelper());
      {
        const f = linkField({ placeholder: P.placeholder, autofocus: true, expect: page });
        body.appendChild(f.form);
        body.appendChild(f.err);
        if (prevVal) { f.input.value = prevVal; f.input.dispatchEvent(new Event('input')); }
      }
      body.appendChild(el('p', { class: 'pfa-note', id: 'pfa-help' }, svg('info'), el('span', { text: P.note })));
    } else if (page === 'google') {
      root.appendChild(head('Google', { backTo: 'home' }));
      body.appendChild(el('p', { class: 'pfa-lead', text: 'Google Calendar events, and Google Tasks with due dates.' }));
      body.appendChild(googleState());
      body.appendChild(el('h3', { class: 'pfa-overline', text: 'Or paste your secret iCal address' }));
      body.appendChild(steps(['On a computer, open Google Calendar › Settings.', 'Under “Settings for my calendars”, pick the calendar › Integrate calendar.', 'Copy “Secret address in iCal format”.', 'Paste it here.']));
      if (!linksOk) body.appendChild(noHelper());
      {
        const f = linkField({ placeholder: 'https://calendar.google.com/calendar/ical/…/basic.ics', expect: 'google' });
        body.appendChild(f.form); body.appendChild(f.err);
      }
      body.appendChild(el('p', { class: 'pfa-note', id: 'pfa-help' }, svg('info'), el('span', { text: 'Keep the secret address private: anyone with it can see that calendar. School accounts may hide it.' })));
    } else if (page === 'apple') {
      root.appendChild(head('Apple / iCloud', { backTo: 'home' }));
      body.appendChild(el('p', { class: 'pfa-lead', text: 'Browsers can’t read Apple Calendar directly. Use a public iCloud link, or export a file.' }));
      body.appendChild(el('h3', { class: 'pfa-overline', text: 'A public iCloud calendar' }));
      body.appendChild(steps(['On iCloud.com, open Calendar.', 'Click the share icon next to a calendar and turn on Public Calendar.', 'Copy the link (it starts with webcal://).', 'Paste it here.']));
      if (!linksOk) body.appendChild(noHelper());
      {
        const f = linkField({ placeholder: 'webcal://p…-caldav.icloud.com/published/2/…', expect: 'icloud' });
        body.appendChild(f.form); body.appendChild(f.err);
      }
      body.appendChild(el('p', { class: 'pfa-note is-warn' }, svg('info'), el('span', { text: 'A public calendar can be read by anyone who has the link.' })));
      body.appendChild(el('h3', { class: 'pfa-overline', text: 'Or a file from Calendar on a Mac' }));
      body.appendChild(el('div', { class: 'pfa-row' },
        el('span', { class: 'pfa-muted', text: 'Calendar › File › Export › Export…, then choose the file.' }),
        el('button', { class: 'btn btn-sm', type: 'button', onclick: () => pickFiles() }, svg('doc'), 'Choose file')));
      body.appendChild(el('p', { class: 'pfa-note', id: 'pfa-help' }, svg('info'), el('span', { text: 'The Pure Focus Mac app reads Apple Calendar directly, with no link needed.' })));
    } else if (page === 'samsung') {
      root.appendChild(head('Samsung', { backTo: 'home' }));
      body.appendChild(el('p', { class: 'pfa-lead', text: 'Samsung Calendar doesn’t share a link with other apps. Add your Google account in Samsung Calendar and keep events in a Google calendar; Pure Focus then sees them through Google.' }));
      body.appendChild(steps(['On your phone, open Samsung Calendar › Settings › Manage calendars › Add account › Google.', 'When you add events, save them to your Google calendar.', 'Then connect Google here.']));
      body.appendChild(el('div', { class: 'pfa-row' }, el('button', { class: 'btn btn-primary', type: 'button', onclick: () => show('google') }, 'Connect Google')));
    }
    root.appendChild(body);
  }

  function googleState() {
    const box = el('div', { class: 'pfa-google' });
    let configured = false, user = null;
    try { configured = typeof GoogleSync !== 'undefined' && GoogleSync.isConfigured(); user = configured ? GoogleSync.user() : null; } catch (_) {}
    if (!configured) {
      box.appendChild(el('p', { class: 'pfa-muted', text: 'Google sign-in isn’t set up on this site yet, so use the secret address below.' }));
    } else if (!user) {
      const b = el('button', { class: 'btn btn-primary', type: 'button', onclick: () => { closeAddSheet(); try { GoogleSync.signIn(); } catch (_) {} } }, 'Sign in with Google');
      box.appendChild(el('div', { class: 'pfa-row' }, b, el('span', { class: 'pfa-muted', text: 'Read-only. Pure Focus never changes your Google data.' })));
    } else {
      box.appendChild(el('p', { class: 'pfa-muted', text: `Signed in as ${user.email || user.name}` }));
      box.appendChild(el('div', { class: 'pfa-row' },
        el('button', { class: 'btn btn-primary', type: 'button', onclick: () => { closeAddSheet(); GoogleSync.importCalendar(); } }, 'Import Google Calendar'),
        el('button', { class: 'btn', type: 'button', onclick: () => { closeAddSheet(); GoogleSync.importTasks(); } }, 'Import Google Tasks')));
    }
    return box;
  }

  function pickFiles() {
    const input = el('input', { type: 'file', accept: '.ics,.ical,.icalendar,text/calendar', multiple: true, hidden: true });
    input.addEventListener('change', () => { const files = Array.from(input.files || []); input.remove(); if (files.length) addFiles(files); });
    document.body.appendChild(input);
    input.click();
  }

  async function addFiles(files) {
    const res = await importFiles(files);
    if (!sheet) {
      for (const e of res.errors) toast(e.message);
      if (res.results.length) toast(`Added ${res.results.map((r) => `“${r.name}”`).join(', ')}`, 'success');
      return;
    }
    if (!res.results.length) {
      show('home');
      const msg = (res.errors[0] && res.errors[0].message) || 'No events found in that file.';
      sheet.root.querySelector('.pfa-body').prepend(el('p', { class: 'pfa-error', role: 'alert', text: msg }));
      return;
    }
    const r = res.results[0];
    showResult({ feed: r.feed, events: res.events, assignments: res.assignments, homeworkLike: r.homeworkLike, files: res.results.length });
  }

  function showResult(r) {
    if (!sheet) return;
    const root = sheet.root;
    sheet.page = 'result';
    root.textContent = '';
    root.dataset.page = 'result';
    const f = r.feed;
    const name = f.displayName || f.name;
    root.appendChild(head('Calendar added'));
    const body = el('div', { class: 'pfa-body pfa-result' });
    const parts = [`${r.events} event${r.events === 1 ? '' : 's'}`];
    if (r.assignments) parts.push(`${r.assignments} assignment${r.assignments === 1 ? '' : 's'}`);
    body.appendChild(el('div', { class: 'pfa-done' },
      (() => { const ic = el('span', { class: 'pfa-done-ic' }, svg('check')); ic.style.setProperty('--ev', f.userColorHex || f.colorHex || 'var(--focus-tint)'); return ic; })(),
      el('div', null,
        el('p', { class: 'pfa-done-title', text: r.files > 1 ? `Added ${r.files} calendars` : `Added “${name}”` }),
        el('p', { class: 'pfa-muted', text: parts.join(' · ') }))));
    const school = f.provider === 'canvas' || f.provider === 'blackbaud' || r.assignments > 0;
    if (school) {
      const p = Store.calendar().prefs;
      const sw = el('input', { type: 'checkbox', role: 'switch', class: 'pfa-switch' });
      sw.checked = p.promoteAssignments !== false;
      sw.addEventListener('change', () => { Store.updateCalendar({ prefs: { promoteAssignments: sw.checked } }); if (sw.checked) try { Assignments.refreshPromotions(); } catch (_) {} });
      body.appendChild(el('label', { class: 'pfa-toggle' }, sw,
        el('span', { text: `Put assignments due in the next ${p.assignmentHorizonDays || 2} days on Today’s Tasks` })));
    }
    if (r.homeworkLike) {
      const q = el('div', { class: 'pfa-question' },
        el('p', { class: 'pfa-q-title', text: 'Are these due dates (homework) or events?' }),
        el('p', { class: 'pfa-muted', text: 'Due dates show as chips and can go on Today’s Tasks; events block time on your calendar.' }));
      const pick = (role) => { update(f.id, { itemRole: role }); q.replaceWith(el('p', { class: 'pfa-muted', text: role === 'dueDates' ? 'Got it — treated as due dates.' : 'Got it — treated as events.' })); };
      q.appendChild(el('div', { class: 'pfa-row' },
        el('button', { class: 'btn btn-sm', type: 'button', onclick: () => pick('dueDates') }, 'Due dates'),
        el('button', { class: 'btn btn-sm', type: 'button', onclick: () => pick('events') }, 'Events')));
      body.appendChild(q);
    }
    const actions = el('div', { class: 'pfa-actions' });
    if (r.assignments >= 3 && typeof Coach !== 'undefined' && Coach.run) {
      actions.appendChild(el('button', { class: 'btn', type: 'button', onclick: () => {
        closeAddSheet();
        try { if (typeof App !== 'undefined') App.showView('calendar'); Coach.run('week'); } catch (_) {}
      } }, svg('sparkle'), 'Plan the next 7 days'));
    }
    actions.appendChild(el('button', { class: 'btn btn-primary', type: 'button', onclick: () => closeAddSheet() }, 'Done'));
    body.appendChild(actions);
    root.appendChild(body);
    const done = actions.querySelector('.btn-primary');
    if (done) setTimeout(() => done.focus(), 30);
    announce(`${name} added, ${parts.join(', ')}`);
  }

  return {
    init, proxyMode, knownMode, fetchICS, subscribe, importFiles, refresh, remove, update, list, get, status,
    events, toBlock, replaceEvents, dropEvents, upsertFeed, normalizeColor, nextColor, normalizeURL, urlMask,
    errorCopy, providerLabel, refreshMinutesOf, openAddSheet, closeAddSheet, hasURL: (id) => !!urlFor(id),
    _split: split, _looksLikeHomework: looksLikeHomework,
  };
})();
