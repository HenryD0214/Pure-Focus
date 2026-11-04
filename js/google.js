/* google.js — Google sign-in (identity only) and read-only Calendar / Tasks
   import through Google Identity Services (GIS).

   Storage (localStorage, never tokens):
     purefocus.google.profile     {sub, email, name, picture}
     purefocus.google.taskIds     [googleTaskId, …]  (import de-duplication)
     purefocus.google.lastImport  {calendar:{at,count,calendars}, tasks:{at,count,skipped,lists}}
     purefocus.googleClientId     optional override; config.js wins when non-empty
   The OAuth access token lives in memory only and dies with the page.

   Every profile / API string reaches the DOM through textContent or
   attributes; nothing here uses innerHTML. */
const GoogleSync = (() => {
  'use strict';

  const GIS_SRC = 'https://accounts.google.com/gsi/client';
  const CONSOLE_URL = 'https://console.cloud.google.com/apis/credentials';
  const SCOPE_CAL = 'https://www.googleapis.com/auth/calendar.readonly';
  const SCOPE_TASKS = 'https://www.googleapis.com/auth/tasks.readonly';
  const CAL_API = 'https://www.googleapis.com/calendar/v3';
  const TASKS_API = 'https://tasks.googleapis.com/tasks/v1';
  const BIRTHDAYS_CAL = '#contacts@group.v.calendar.google.com';
  const DESKTOP_ID_PREFIX = '1040267118580-aal9';
  const MAX_PAGES = 20;
  const MAX_SUBTASKS = 8;

  const K_PROFILE = 'purefocus.google.profile';
  const K_TASK_IDS = 'purefocus.google.taskIds';
  const K_LAST = 'purefocus.google.lastImport';
  const K_CID_OVERRIDE = 'purefocus.googleClientId';

  const state = {
    cid: '',
    configured: false,
    desktopId: false,
    gisReady: false,
    gisFailed: false,
    profile: null,
    busy: { calendar: false, tasks: false },
  };
  let token = null;          // { value, expiresAt, calendar, tasks } — memory only
  let tokenClient = null;
  let pending = null;        // { resolve, reject } for the in-flight token request
  let gisPromise = null;
  let pop = null;            // the open popover / menu

  // ───────────────────────────── storage ─────────────────────────────

  function readJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (_) { return fallback; }
  }
  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (_) { return false; }
  }
  function removeKey(key) { try { localStorage.removeItem(key); } catch (_) {} }

  function resolveClientId() {
    const fromConfig = (typeof Config !== 'undefined' && Config && Config.GOOGLE_WEB_CLIENT_ID) || '';
    let override = '';
    try { override = localStorage.getItem(K_CID_OVERRIDE) || ''; } catch (_) {}
    return String(fromConfig || override).trim();
  }

  function cleanProfile(p) {
    if (!p || typeof p !== 'object' || typeof p.sub !== 'string' || !p.sub) return null;
    const str = (v) => (typeof v === 'string' && v ? v : null);
    const picture = str(p.picture);
    return {
      sub: p.sub,
      email: str(p.email),
      name: str(p.name) || str(p.email) || 'Google user',
      picture: picture && /^https:\/\//i.test(picture) ? picture : null,
    };
  }

  // ───────────────────────────── JWT (tested snippet) ─────────────────────────────

  function decodeJwtPayload(jwt) {
    const part = String(jwt).split('.')[1] || '';
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  function profileFromCredential(jwt, clientId, now = Date.now()) {
    const c = decodeJwtPayload(jwt);
    const okIss = c.iss === 'accounts.google.com' || c.iss === 'https://accounts.google.com';
    if (!okIss || c.aud !== clientId || !c.sub) throw new Error('bad-token');
    if (typeof c.exp !== 'number' || c.exp * 1000 < now - 5 * 60 * 1000) throw new Error('expired-token');
    return cleanProfile({
      sub: c.sub, email: c.email || null,
      name: c.name || c.given_name || c.email || 'Google user', picture: c.picture || null,
    });
  }

  // ───────────────────────────── mapping ─────────────────────────────

  function localDayFromYMD(s) { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); }

  function calendarName(cal) { return cal.summaryOverride || cal.summary || cal.id || 'Google Calendar'; }

  /** Google Calendar event → the cache record CalendarView.addExternal takes (SPEC §3.5):
      id `google:<calId>:<eventId>`, feed `google:<calId>`, isBusy from transparency,
      iCalUID kept for dedupe (V14), description as plain text. */
  function mapEvent(ev, cal) {
    if (!ev || !ev.id || !ev.start || !ev.end) return null;
    if (ev.status === 'cancelled' || ev.eventType === 'workingLocation') return null;
    if ((ev.attendees || []).some((a) => a && a.self && a.responseStatus === 'declined')) return null;
    const allDay = !!ev.start.date;
    // All-day dates are local calendar days; never `new Date('YYYY-MM-DD')` (that parses as UTC).
    const start = allDay ? localDayFromYMD(ev.start.date) : new Date(ev.start.dateTime);
    const end = allDay ? localDayFromYMD(ev.end.date || ev.start.date) : new Date(ev.end.dateTime || ev.start.dateTime);
    if (isNaN(start) || isNaN(end)) return null;
    // the description keeps its formatting (bold, lists, links); the calendar draws it safely
    const notes = String(ev.description || '').trim().slice(0, 6000);
    const entry = ev.conferenceData && Array.isArray(ev.conferenceData.entryPoints)
      ? ev.conferenceData.entryPoints.find((x) => x && x.entryPointType === 'video' && /^https:\/\//i.test(x.uri || '')) : null;
    const conference = (typeof ev.hangoutLink === 'string' && /^https:\/\//i.test(ev.hangoutLink) ? ev.hangoutLink : null) || (entry ? entry.uri : null);
    const attachments = (Array.isArray(ev.attachments) ? ev.attachments : [])
      .filter((a) => a && /^https:\/\//i.test(a.fileUrl || '')).slice(0, 10).map((a) => ({ url: a.fileUrl, name: typeof a.title === 'string' ? a.title.slice(0, 120) : null }));
    return {
      id: `google:${cal.id}:${ev.id}`,
      title: typeof ev.summary === 'string' && ev.summary.trim()
        ? ev.summary.trim().slice(0, 200)
        : (cal.accessRole === 'freeBusyReader' ? 'Busy' : '(No title)'),
      start: start.toISOString(),
      end: end.toISOString(),            // exclusive
      allDay,
      startDay: allDay ? ev.start.date.slice(0, 10) : null,
      endDay: allDay ? (ev.end.date || ev.start.date).slice(0, 10) : null,
      source: 'google',
      calendarId: cal.id,
      calendarName: calendarName(cal),
      color: cal.backgroundColor || null,
      location: typeof ev.location === 'string' ? ev.location.slice(0, 200) : null,
      notes: notes || null,
      conference, attachments,
      htmlLink: typeof ev.htmlLink === 'string' && /^https:\/\//i.test(ev.htmlLink) ? ev.htmlLink : null,
      isBusy: ev.transparency !== 'transparent',
      eventType: typeof ev.eventType === 'string' ? ev.eventType : null,
      icalUID: typeof ev.iCalUID === 'string' ? ev.iCalUID : null,
      externalID: ev.id,
      readOnly: true,
    };
  }

  function isSelectedCalendar(cal) {
    return !!cal && !!cal.id && cal.selected === true && cal.hidden !== true && cal.id !== BIRTHDAYS_CAL;
  }

  // ───────────────────────────── GIS ─────────────────────────────

  function gis() { return (window.google && window.google.accounts) || null; }

  function loadGis() {
    if (gisPromise) return gisPromise;
    gisPromise = new Promise((resolve, reject) => {
      if (gis() && gis().id && gis().oauth2) { resolve(); return; }
      const s = document.createElement('script');
      s.src = GIS_SRC;
      s.async = true;
      s.defer = true;
      s.onload = () => (gis() ? resolve() : reject(new Error('gis-missing')));
      s.onerror = () => reject(new Error('gis-load-failed'));
      document.head.appendChild(s);
    }).then(() => {
      const g = gis();
      g.id.initialize({
        client_id: state.cid,
        callback: onCredential,
        auto_select: false,
        cancel_on_tap_outside: true,
        context: 'signin',
        ux_mode: 'popup',
      });
      tokenClient = g.oauth2.initTokenClient({
        client_id: state.cid,
        scope: `${SCOPE_CAL} ${SCOPE_TASKS}`,
        include_granted_scopes: true,
        prompt: '',
        callback: (r) => settle(r && r.error ? 'reject' : 'resolve', r),
        error_callback: (e) => settle('reject', e),
      });
      state.gisReady = true;
      state.gisFailed = false;
      renderAll();
    }, (err) => {
      state.gisFailed = true;
      gisPromise = null;
      renderAll();
      throw err;
    });
    gisPromise.catch(() => {});
    return gisPromise;
  }

  function settle(kind, value) {
    const p = pending;
    pending = null;
    if (p) p[kind](value);
  }

  function gisTheme() {
    return document.documentElement.dataset.theme === 'light' ? 'outline' : 'filled_black';
  }

  /** Render the official GIS button into `slot` once it has a size. */
  function mountGisButton(slot, width) {
    const draw = () => {
      const g = gis();
      if (!state.gisReady || !g || !slot.isConnected) return;
      slot.textContent = '';
      try {
        g.id.renderButton(slot, {
          type: 'standard', theme: gisTheme(), size: 'large', shape: 'pill',
          text: 'continue_with', logo_alignment: 'left', width: String(width),
        });
      } catch (_) {}
    };
    if (!state.gisReady) {
      slot.appendChild(h('span', { class: 'gs-gis-wait' }, state.gisFailed
        ? 'Couldn’t reach Google. Check your connection and reload.'
        : 'Loading Google sign-in…'));
      return;
    }
    if (slot.getBoundingClientRect().width > 0 || typeof ResizeObserver !== 'function') { draw(); return; }
    // Hidden (e.g. Settings not open yet): draw when it first becomes visible.
    const ro = new ResizeObserver(() => {
      if (!slot.isConnected) { ro.disconnect(); return; }
      if (slot.getBoundingClientRect().width > 0) { ro.disconnect(); draw(); }
    });
    ro.observe(slot);
  }

  function onCredential(response) {
    let profile = null;
    try { profile = profileFromCredential(response && response.credential, state.cid); } catch (_) {}
    if (!profile) { toast('Google sign-in failed. Please try again.'); return; }
    state.profile = profile;
    writeJSON(K_PROFILE, profile);   // the profile only; the ID token is dropped here
    closePopover();
    renderAll();
    toast(`Signed in as ${profile.email || profile.name}`, 'success');
  }

  // ───────────────────────────── access token + REST ─────────────────────────────

  class GoogleError extends Error {
    constructor(code, status = 0, apiName = '') { super(code); this.code = code; this.status = status; this.api = apiName; }
  }

  /** Must be called synchronously from a click handler (pop-up blockers). */
  function ensureToken(need) {
    if (token && Date.now() < token.expiresAt && token[need]) return Promise.resolve(token);
    const g = gis();
    if (!state.gisReady || !tokenClient || !g) {
      loadGis();
      return Promise.reject(new GoogleError('gis-not-ready'));
    }
    if (pending) settle('reject', { type: 'superseded' });
    return new Promise((resolve, reject) => {
      pending = { resolve, reject };       // the executor runs synchronously, so the pop-up is allowed
      const hint = state.profile && state.profile.email ? { login_hint: state.profile.email } : {};
      tokenClient.requestAccessToken(hint);
    }).then((r) => {
      token = {
        value: r.access_token,
        expiresAt: Date.now() + (Number(r.expires_in || 3600) - 60) * 1000,
        calendar: !!g.oauth2.hasGrantedAllScopes(r, SCOPE_CAL),
        tasks: !!g.oauth2.hasGrantedAllScopes(r, SCOPE_TASKS),
      };
      if (!token[need]) throw new GoogleError('scope-missing', 0, need);
      return token;
    }, (e) => {
      throw new GoogleError((e && (e.type || e.error)) || 'unknown');
    });
  }

  async function api(url, apiName) {
    let res;
    try {
      res = await fetch(url, { headers: { Authorization: 'Bearer ' + token.value, Accept: 'application/json' } });
    } catch (_) {
      throw new GoogleError('network', 0, apiName);
    }
    if (res.ok) return res.json();
    let reason = '';
    try {
      const e = ((await res.json()) || {}).error || {};
      reason = (e.errors && e.errors[0] && e.errors[0].reason) ||
        (e.details || []).map((d) => d && d.reason).find(Boolean) || e.status || '';
    } catch (_) {}
    if (res.status === 401) { token = null; throw new GoogleError('expired', 401, apiName); }
    if (res.status === 403 && /accessNotConfigured|SERVICE_DISABLED/i.test(reason)) throw new GoogleError('api-disabled', 403, apiName);
    if (res.status === 403 && /insufficient|PERMISSION/i.test(reason)) { token = null; throw new GoogleError('scope-missing', 403, apiName); }
    if (res.status === 429 || res.status >= 500) throw new GoogleError('busy', res.status, apiName);
    throw new GoogleError('http', res.status, apiName);
  }

  async function pagedItems(baseUrl, apiName) {
    const items = [];
    let pageToken = '';
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = new URL(baseUrl);
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const j = await api(url.toString(), apiName);
      if (j && Array.isArray(j.items)) items.push(...j.items);
      pageToken = (j && j.nextPageToken) || '';
      if (!pageToken) break;
    }
    return items;
  }

  function describeError(err, what) {
    const code = err && err.code;
    const apiName = what === 'tasks' ? 'Tasks' : 'Calendar';
    switch (code) {
      case 'popup_closed': case 'superseded': return null;      // the user closed it; stay quiet
      case 'popup_failed_to_open': return 'Allow pop-ups for this site, then try again.';
      case 'access_denied': return 'This Google account isn’t on Pure Focus’s test-user list.';
      case 'scope-missing': return `Google ${apiName} access wasn’t granted. Try again and tick the ${apiName} box.`;
      case 'expired': return 'Google access expired. Click Import to reconnect.';
      case 'api-disabled': return `Turn on the Google ${apiName} API in Google Cloud Console.`;
      case 'busy': return 'Google is busy right now. Try again in a minute.';
      case 'network': return 'Couldn’t reach Google. Check your connection.';
      case 'gis-not-ready': return 'Google is still loading. Try again in a moment.';
      default: return `Google ${apiName} import failed. Please try again.`;
    }
  }

  // ───────────────────────────── imports ─────────────────────────────

  function recordImport(kind, data) {
    const last = readJSON(K_LAST, {}) || {};
    last[kind] = Object.assign({ at: new Date().toISOString() }, data);
    writeJSON(K_LAST, last);
  }

  function beginImport(kind) {
    if (!state.configured) { toast('Google sign-in isn’t set up for this site yet.'); return false; }
    if (state.busy[kind]) return false;
    closePopover();
    state.busy[kind] = true;
    renderAll();
    return true;
  }

  function endImport(kind) { state.busy[kind] = false; renderAll(); }

  function failImport(kind) {
    return (err) => { const msg = describeError(err, kind); if (msg) toast(msg); return null; };
  }

  /** Call from a click handler: it may open Google's consent pop-up. */
  function importCalendar() {
    if (!beginImport('calendar')) return Promise.resolve(null);
    return ensureToken('calendar')
      .then(fetchCalendarEvents)
      .then(({ events, calendars, cals }) => {
        if (typeof CalendarView === 'undefined' || !CalendarView || typeof CalendarView.addExternal !== 'function') {
          toast('The calendar isn’t ready yet. Try again in a moment.');
          return null;
        }
        saveCalendarFeeds(cals);           // first: it knows which calendars start unticked
        CalendarView.addExternal(events, 'google');
        recordImport('calendar', { count: events.length, calendars });
        toast(events.length
          ? `Imported ${plural(events.length, 'event')} from ${plural(calendars, 'calendar')}`
          : `No events in the next 60 days across ${plural(calendars, 'calendar')}`, 'success');
        return { events: events.length, calendars };
      })
      .catch(failImport('calendar'))
      .finally(() => endImport('calendar'));
  }

  /* While a sign-in token is valid, Google events follow by themselves: every 2 minutes and when you
     come back to the tab, with nothing on screen moving unless something changed. Google only hands
     out tokens from a click (they last about an hour, and a reload drops them), so when there's
     none this stops and the Calendar's sync dot says so; its ↻ button gets a new one. */
  let liveSig = '';
  let liveAt = 0;
  function calendarLive() { return !!(token && Date.now() < token.expiresAt && token.calendar); }
  function refreshCalendarQuietly() {
    if (!calendarLive() || state.busy.calendar || document.hidden) return;
    if (typeof Feeds === 'undefined' || !Feeds.list().some((f) => f.source === 'google')) return;
    if (Date.now() - liveAt < 20000) return;
    liveAt = Date.now();
    fetchCalendarEvents().then((res) => {
      // only the calendars still listed: one you stopped syncing stays gone until you import again
      const kept = new Set(Feeds.list().filter((f) => f.source === 'google').map((f) => f.id));
      const cals = res.cals.filter((c) => kept.has('google:' + c.id));
      const events = res.events.filter((e) => kept.has('google:' + String(e.calendarID || e.calendarId || 'primary').replace(/^google:/, '')));
      const sig = JSON.stringify(events);
      if (sig === liveSig) return;
      liveSig = sig;
      saveCalendarFeeds(cals);
      CalendarView.addExternal(events, 'google');
    }).catch(() => { /* the next check tries again; a lost token shows on the sync dot */ });
  }

  async function fetchCalendarEvents() {
    const listUrl = new URL(`${CAL_API}/users/me/calendarList`);
    listUrl.searchParams.set('minAccessRole', 'reader');
    listUrl.searchParams.set('maxResults', '250');
    const all = (await pagedItems(listUrl.toString(), 'calendar')).filter((c) => c && c.id);
    // Every calendar becomes a feed row (Google-style checkbox); hidden/unselected ones start unticked
    // and the birthdays calendar is hidden and never blocks time (SPEC §3.5, V5).
    const cals = all.filter((c) => c.hidden !== true);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const from = new Date(today); from.setDate(from.getDate() - 7);
    const to = new Date(today); to.setDate(to.getDate() + 61);    // through the end of day +60
    let tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) {}

    const seen = new Set();
    const events = [];
    for (const cal of cals) {
      const url = new URL(`${CAL_API}/calendars/${encodeURIComponent(cal.id)}/events`);
      url.searchParams.set('singleEvents', 'true');
      url.searchParams.set('orderBy', 'startTime');
      url.searchParams.set('timeMin', from.toISOString());
      url.searchParams.set('timeMax', to.toISOString());
      url.searchParams.set('maxResults', '250');
      url.searchParams.set('showDeleted', 'false');
      if (tz) url.searchParams.set('timeZone', tz);
      for (const ev of await pagedItems(url.toString(), 'calendar')) {
        const mapped = mapEvent(ev, cal);
        if (!mapped || seen.has(mapped.id)) continue;   // the same invite can sit in two calendars
        seen.add(mapped.id);
        events.push(mapped);
      }
    }
    events.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    return { events, calendars: cals.length, cals };
  }

  /** Google calendars → CalendarFeed rows (`google:<calId>`, group `google:<email>`). */
  function saveCalendarFeeds(cals) {
    if (typeof Feeds === 'undefined' || !Feeds.upsertFeed || !Array.isArray(cals)) return;
    const email = state.profile && state.profile.email;
    for (const cal of cals) {
      const id = 'google:' + cal.id;
      const birthdays = cal.id === BIRTHDAYS_CAL;
      const holidays = /#holiday@group\.v\.calendar\.google\.com$/i.test(cal.id);
      const existing = Feeds.get(id);
      const patch = {
        id, source: 'google', provider: 'google', name: calendarName(cal).slice(0, 80),
        isPrimary: !!cal.primary, accessRole: cal.accessRole || null, groupKey: email ? 'google:' + email : 'google',
        lastSyncedAt: new Date().toISOString(), lastError: null,
      };
      if (!existing) {
        Object.assign(patch, {
          colorHex: Feeds.normalizeColor(cal.backgroundColor) || Feeds.nextColor(), itemRole: 'events',
          isVisible: isSelectedCalendar(cal) && !birthdays, blocksTime: !birthdays && !holidays,
        });
      }
      Feeds.upsertFeed(patch);
    }
  }

  /** Call from a click handler: it may open Google's consent pop-up. */
  function importTasks() {
    if (!beginImport('tasks')) return Promise.resolve(null);
    return ensureToken('tasks')
      .then(fetchGoogleTasks)
      .then(({ lists, tasks }) => {
        if (typeof Store === 'undefined' || !Store || typeof Store.addTask !== 'function') {
          toast('Tasks aren’t available on this page.');
          return null;
        }
        const r = upsertGoogleTasks(tasks);
        recordImport('tasks', { count: r.added, skipped: r.skipped, lists });
        if (r.added || r.updated || r.completed) {
          const bits = [];
          if (r.added) bits.push(`${plural(r.added, 'new task')}`);
          if (r.updated) bits.push(`${r.updated} updated`);
          if (r.completed) bits.push(`${r.completed} done`);
          toast(`Google Tasks · ${bits.join(' · ')}`, 'success');
        } else {
          toast('Google Tasks are up to date');
        }
        return r;
      })
      .catch(failImport('tasks'))
      .finally(() => endImport('tasks'));
  }

  async function fetchGoogleTasks() {
    const listsUrl = new URL(`${TASKS_API}/users/@me/lists`);
    listsUrl.searchParams.set('maxResults', '1000');
    const lists = await pagedItems(listsUrl.toString(), 'tasks');
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const out = [];
    for (const list of lists) {
      if (!list || !list.id) continue;
      const url = new URL(`${TASKS_API}/lists/${encodeURIComponent(list.id)}/tasks`);
      url.searchParams.set('showCompleted', 'true');
      url.searchParams.set('showHidden', 'true');
      url.searchParams.set('completedMin', since);
      url.searchParams.set('maxResults', '100');
      const items = await pagedItems(url.toString(), 'tasks');
      items.sort((a, b) => String(a.position || '').localeCompare(String(b.position || '')));
      out.push({ list, items });
    }
    return { lists: lists.length, tasks: out };
  }

  const lowerId = (x) => String(x == null ? '' : x).toLowerCase();

  function taskIdFor(googleId) {
    try { if (typeof CloudRef !== 'undefined' && CloudRef.externalTaskID) return CloudRef.externalTaskID('googleTasks', googleId); } catch (_) {}
    return null;
  }

  /** SPEC §3.5 upsert by externalSource 'googleTasks' + externalID, as ONE store write:
      new top-level tasks are appended (deterministic id, E23); existing ones take title/notes/dueDate
      when Google's `updated` is newer; Google "completed" marks done and nothing un-completes;
      children become subtasks (≤ 8, overflow → top-level); tasks gone from a fully fetched list
      keep their local copy and are detached. */
  function upsertGoogleTasks(perList) {
    const legacy = new Set((readJSON(K_TASK_IDS, []) || []).filter((x) => typeof x === 'string'));
    const result = { added: 0, updated: 0, completed: 0, removed: 0, skipped: 0 };
    Store.bulk(() => {
      for (const { list, items } of perList) {
        const live = items.filter((t) => t && typeof t.id === 'string' && t.id && !t.deleted);
        const ids = new Set(live.map((t) => t.id));
        const byExt = new Map();
        for (const t of Store.tasks()) if (t.externalSource === 'googleTasks' && t.externalID) byExt.set(lowerId(t.externalID), t);
        const parents = new Map();
        const roots = [];
        for (const t of live) {
          if (t.parent && ids.has(t.parent)) {
            const kids = parents.get(t.parent) || [];
            if (kids.length < MAX_SUBTASKS) { kids.push(t); parents.set(t.parent, kids); continue; }
          }
          roots.push(t);
        }
        for (const g of roots) {
          const title = String(g.title || '').trim().slice(0, 500);
          if (!title) continue;
          const due = typeof g.due === 'string' ? g.due.slice(0, 10) : null;
          const notes = typeof g.notes === 'string' && g.notes ? g.notes.slice(0, 2000) : null;
          const done = g.status === 'completed';
          const kids = (parents.get(g.id) || []).map((c) => ({ title: String(c.title || '').trim().slice(0, 500), isDone: c.status === 'completed', externalID: c.id })).filter((c) => c.title);
          const cur = byExt.get(lowerId(g.id));
          if (!cur) {
            if (legacy.has(g.id) || done) { result.skipped += 1; continue; }   // v1 already imported it / finished work stays out
            const fields = { title, estimate: 1, notes, dueDate: due, isDone: false, externalSource: 'googleTasks', externalID: g.id,
              externalListID: list.id, externalUpdatedAt: g.updated || null, subtasks: kids };
            const id = taskIdFor(g.id);
            if (id && !Store.tasks().some((t) => lowerId(t.id) === lowerId(id))) fields.id = id;
            if (Store.addTask(fields, { append: true })) result.added += 1;
            continue;
          }
          const newer = g.updated && (!cur.externalUpdatedAt || Date.parse(g.updated) > Date.parse(cur.externalUpdatedAt));
          if (newer) {
            const patch = { title, notes, dueDate: due, externalUpdatedAt: g.updated, externalListID: list.id };
            const known = new Map((cur.subtasks || []).filter((x) => x.externalID).map((x) => [lowerId(x.externalID), x]));
            const local = (cur.subtasks || []).filter((x) => !x.externalID);
            if (kids.length || known.size) {
              patch.subtasks = kids.map((k) => { const old = known.get(lowerId(k.externalID)); return old ? { ...old, title: k.title, isDone: old.isDone || k.isDone } : k; })
                .concat(local).slice(0, MAX_SUBTASKS);
            }
            Store.updateTask(cur.id, patch);
            result.updated += 1;
          }
          // Unchecking an imported task by hand suppresses feed-driven completion until it is
          // completed locally again; dates and titles still follow the list.
          if (done && !cur.isDone && !cur.externalDoneSuppressed) { Store.toggleTaskDone(cur.id); result.completed += 1; }
        }
        // Gone from this fully fetched list (or deleted upstream): only tasks not done locally.
        const present = new Set(live.map((t) => lowerId(t.id)));
        for (const t of Store.tasks().slice()) {
          if (t.externalSource !== 'googleTasks' || t.isDone || t.externalListID !== list.id) continue;
          if (present.has(lowerId(t.externalID))) continue;
          // A task that left the list keeps its title, date and focus history: detach it and let
          // the user decide. Deleting it here is how imported work used to disappear.
          Store.updateTask(t.id, { externalSource: null, externalID: null, externalListID: null,
            externalUpdatedAt: null, externalDoneSuppressed: false });
          result.removed += 1;
        }
      }
    });
    return result;
  }

  // ───────────────────────────── public: identity ─────────────────────────────

  function user() { return state.configured && state.profile ? Object.assign({}, state.profile) : null; }
  function isConfigured() { return state.configured; }

  /** SPEC-V2 §8.1 A.6: with a cloud backend configured, "Sign in" opens the cloud sheet (W1·B). */
  function cloudSignIn() {
    try {
      if (typeof Cloud !== 'undefined' && Cloud && Cloud.isConfigured && Cloud.isConfigured()) { Cloud.openSheet(); return true; }
    } catch (err) { console.error('Cloud sign-in failed to open', err); }
    return false;
  }

  /** Opens the sign-in popover (GIS button) or, when not configured, the setup popover. */
  function signIn(anchor) {
    if (cloudSignIn()) return;
    const a = anchor || document.querySelector('#account-root .gs-avatar-btn') ||
      document.querySelector('#settings-account-root .gs-signin');
    if (!a || (pop && pop.anchor === a)) return;
    openPopover(a, 'dialog', state.configured ? buildSignInPopover : buildSetupPopover);
  }

  function signOut() {
    const g = gis();
    try { if (g && g.id) g.id.disableAutoSelect(); } catch (_) {}
    if (pending) settle('reject', { type: 'superseded' });
    token = null;
    state.profile = null;
    removeKey(K_PROFILE);
    try {
      if (typeof CalendarView !== 'undefined' && CalendarView && typeof CalendarView.addExternal === 'function') {
        CalendarView.addExternal([], 'google', { signOut: true });     // drop the imported Google events from view
      }
    } catch (_) {}
    closePopover();
    renderAll();
    toast('Signed out of Google');
  }

  // ───────────────────────────── DOM helpers ─────────────────────────────

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'on') { for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn); }
        else if (k === 'class') el.className = v;
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return el;
  }

  const ICONS = {
    user: [['circle', { cx: 10, cy: 7.2, r: 3.2 }], ['path', { d: 'M3.8 16.6c.9-3 3.4-4.6 6.2-4.6s5.3 1.6 6.2 4.6' }]],
    calendar: [['rect', { x: 3, y: 4.5, width: 14, height: 12, rx: 2.6 }], ['path', { d: 'M3 8.5h14M7 2.8v3M13 2.8v3' }]],
    tasks: [['path', { d: 'M3.5 6l1.6 1.6L8 4.7M3.5 12.5l1.6 1.6L8 11.2M10.5 6.2h6M10.5 12.7h6' }]],
    signout: [['path', { d: 'M8 3.5H5.2A1.7 1.7 0 0 0 3.5 5.2v9.6a1.7 1.7 0 0 0 1.7 1.7H8M12.5 6.5 16 10l-3.5 3.5M16 10H8' }]],
    external: [['path', { d: 'M11.5 3.5h5v5M16.5 3.5 9.5 10.5M14.5 11.5v3.3a1.7 1.7 0 0 1-1.7 1.7H5.2a1.7 1.7 0 0 1-1.7-1.7V7.2a1.7 1.7 0 0 1 1.7-1.7h3.3' }]],
    key: [['circle', { cx: 6.8, cy: 13.2, r: 3.3 }], ['path', { d: 'M9.2 10.8 16 4M13.5 6.5l2 2M11.6 8.4l1.6 1.6' }]],
    lock: [['rect', { x: 4, y: 9, width: 12, height: 8, rx: 2.2 }], ['path', { d: 'M6.8 9V6.6a3.2 3.2 0 0 1 6.4 0V9' }]],
    sun: [['circle', { cx: 10, cy: 10, r: 3.4 }], ['path', { d: 'M10 2.6v1.6M10 15.8v1.6M2.6 10h1.6M15.8 10h1.6M4.8 4.8l1.1 1.1M14.1 14.1l1.1 1.1M4.8 15.2l1.1-1.1M14.1 5.9l1.1-1.1' }]],
    moon: [['path', { d: 'M15.8 12.2A6.4 6.4 0 0 1 7.8 4.2a6.4 6.4 0 1 0 8 8Z' }]],
    gear: [['path', { d: 'M3.5 6.5h7M14.5 6.5h2M3.5 13.5h2M9.5 13.5h7' }], ['circle', { cx: 12.5, cy: 6.5, r: 2 }], ['circle', { cx: 7.5, cy: 13.5, r: 2 }]],
    sync: [['path', { d: 'M15.6 8.2A5.8 5.8 0 0 0 4.9 6.6M4.4 11.8a5.8 5.8 0 0 0 10.7 1.6M4.6 3.6v3.2h3.2M15.4 16.4v-3.2h-3.2' }]],
  };
  function icon(name, cls = 'gs-icon') {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    const attrs = { viewBox: '0 0 20 20', class: cls, 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor',
      'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
    for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
    for (const [tag, a] of ICONS[name] || []) {
      const node = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(a)) node.setAttribute(k, String(v));
      svg.appendChild(node);
    }
    return svg;
  }

  function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

  function toast(msg, variant) {
    if (typeof App !== 'undefined' && App && typeof App.toast === 'function') App.toast(msg, variant);
  }

  function initials(p) {
    const src = (p.name && p.name !== 'Google user' ? p.name : (p.email || '?')).trim();
    const words = src.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
    const picks = words.length > 1 ? [words[0], words[words.length - 1]] : [words[0] || '?'];
    return picks.map((w) => Array.from(w)[0] || '').join('').toUpperCase() || '?';
  }

  function hueIndex(s) {
    let x = 0x811c9dc5;
    for (let i = 0; i < s.length; i += 1) { x ^= s.charCodeAt(i); x = Math.imul(x, 0x01000193) >>> 0; }
    return (x % 8) + 1;
  }

  function avatar(p, size) {
    const wrap = h('span', { class: `gs-avatar gs-avatar--${size}`, 'aria-hidden': 'true' });
    wrap.style.setProperty('--gs-av', `var(--series-${hueIndex(p.sub)})`);
    wrap.appendChild(h('span', { class: 'gs-avatar-initials' }, initials(p)));
    if (p.picture) {
      const img = h('img', { alt: '', referrerpolicy: 'no-referrer', decoding: 'async', draggable: 'false' });
      img.addEventListener('load', () => wrap.classList.add('has-photo'));
      img.addEventListener('error', () => { img.remove(); wrap.classList.remove('has-photo'); });
      img.src = p.picture;
      wrap.appendChild(img);
    }
    return wrap;
  }

  function fmtWhen(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const mins = Math.round((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins} min ago`;
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (new Date().toDateString() === d.toDateString()) return `Today at ${time}`;
    return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${time}`;
  }

  // ───────────────────────────── popover ─────────────────────────────

  function openPopover(anchor, role, build) {
    closePopover();
    const el = h('div', { class: `gs-pop gs-pop--${role}`, role, tabindex: '-1' });
    const afterMount = build(el);
    if (role === 'dialog') {
      const label = el.querySelector('.gs-pop-title');
      if (label) { label.id = 'gs-pop-title'; el.setAttribute('aria-labelledby', 'gs-pop-title'); }
    } else {
      el.setAttribute('aria-label', 'Account menu');
    }
    document.body.appendChild(el);
    pop = { el, anchor, role };
    anchor.setAttribute('aria-expanded', 'true');
    position();                          // reads layout, so the closed state is committed…
    el.classList.add('is-open');         // …and this transitions in
    if (typeof afterMount === 'function') afterMount();
    document.addEventListener('pointerdown', onDocPointer, true);
    document.addEventListener('keydown', onDocKey, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', position, true);
    const first = role === 'menu' ? el.querySelector('[role="menuitem"]:not([disabled])') : null;
    (first || el).focus({ preventScroll: true });
  }

  function closePopover(returnFocus) {
    if (!pop) return;
    const { el, anchor } = pop;
    pop = null;
    document.removeEventListener('pointerdown', onDocPointer, true);
    document.removeEventListener('keydown', onDocKey, true);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('scroll', position, true);
    if (anchor && anchor.isConnected) {
      anchor.setAttribute('aria-expanded', 'false');
      if (returnFocus === true) anchor.focus({ preventScroll: true });
    }
    el.remove();
  }

  function onResize() { closePopover(); }

  function position() {
    if (!pop) return;
    const { el, anchor } = pop;
    if (!anchor.isConnected) { closePopover(); return; }
    const r = anchor.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const w = el.offsetWidth;
    const ht = el.offsetHeight;
    const gap = 10;
    let left = r.right - w;                               // right-aligned to the anchor…
    if (left < 12) left = r.left;                         // …or left-aligned when that clips
    left = Math.max(12, Math.min(left, vw - w - 12));
    let top = r.bottom + gap;
    let side = 'below';
    if (top + ht > vh - 12 && r.top - gap - ht > 12) { top = r.top - gap - ht; side = 'above'; }
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    el.dataset.side = side;
    el.style.setProperty('--gs-origin-x', `${Math.round(Math.min(Math.max(r.left + r.width / 2 - left, 16), w - 16))}px`);
  }

  function onDocPointer(e) {
    if (!pop || pop.el.contains(e.target) || pop.anchor.contains(e.target)) return;
    closePopover();
  }

  function onDocKey(e) {
    if (!pop) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePopover(true); return; }
    if (pop.role !== 'menu') return;
    if (e.key === 'Tab') { closePopover(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const items = Array.from(pop.el.querySelectorAll('[role="menuitem"]:not([disabled])'));
    if (!items.length) return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement);
    const n = items.length;
    const next = e.key === 'ArrowDown' ? (i + 1) % n : e.key === 'ArrowUp' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : n - 1;
    items[next].focus();
  }

  function togglePopover(anchor, role, build) {
    if (pop && pop.anchor === anchor) { closePopover(); return; }
    openPopover(anchor, role, build);
  }

  // ── popover contents ──

  function setupSteps() {
    const origin = location.origin && location.origin !== 'null' ? location.origin : 'this site’s address';
    const steps = [
      ['In Google Cloud Console, open ', h('b', null, 'APIs & Services › Credentials'), '.'],
      ['Create an ', h('b', null, 'OAuth client ID'), ' of type ', h('b', null, 'Web application'), '.'],
      ['Add ', h('code', null, origin), ' to Authorized JavaScript origins.'],
      ['Paste the client ID into ', h('code', null, 'js/config.js'), ' and reload.'],
    ];
    return h('ol', { class: 'gs-steps' }, steps.map((parts, i) =>
      h('li', null, h('span', { class: 'gs-step-n', 'aria-hidden': 'true' }, String(i + 1)), h('span', null, ...parts))));
  }

  function buildSetupPopover(el) {
    el.classList.add('gs-pop--setup');
    el.append(
      h('div', { class: 'gs-pop-head' },
        h('span', { class: 'gs-pop-badge' }, icon('key')),
        h('div', null,
          h('h3', { class: 'gs-pop-title' }, 'Google sign-in isn’t set up yet'),
          h('p', { class: 'gs-pop-sub' }, state.desktopId
            ? 'That client ID belongs to the Mac app’s Desktop client. Create a Web application client for the site instead.'
            : 'Sign-in will be enabled once the site owner adds a Google Web client ID.'))),
      setupSteps(),
      h('div', { class: 'gs-pop-foot' },
        h('a', { class: 'btn btn-sm gs-console-link', href: CONSOLE_URL, target: '_blank', rel: 'noopener noreferrer' },
          'Open Credentials', icon('external')),
        h('span', { class: 'gs-pop-note' }, 'No client secret needed.')),
    );
  }

  function buildSignInPopover(el) {
    const slot = h('div', { class: 'gs-gis-slot' });
    el.append(
      h('div', { class: 'gs-pop-head' },
        h('span', { class: 'gs-pop-badge' }, icon('user')),
        h('div', null,
          h('h3', { class: 'gs-pop-title' }, 'Sign in to Pure Focus'),
          h('p', { class: 'gs-pop-sub' }, 'Use your Google account to import your calendar and tasks.'))),
      slot,
      privacyLine(),
    );
    // Draw once the popover is in the DOM, so GIS can measure the slot.
    return () => { mountGisButton(slot, 292); position(); };
  }

  function privacyLine() {
    return h('p', { class: 'gs-privacy' }, icon('lock', 'gs-icon gs-icon--sm'),
      h('span', null, 'Read-only. Pure Focus reads your calendars and tasks to show them here. Nothing leaves this browser.'));
  }

  /* The top-bar account menu (USER-HOTFIX-1 H1/H3; W6 owns it this run). One avatar is the only
     trailing control in the top bar, signed in or not. Menu: who you are · sign in / sync ·
     one-click Light mode / Dark mode · Settings · (Google imports + Sign out when signed in). */
  function cloudState() {
    try {
      if (typeof Cloud === 'undefined' || !Cloud || !Cloud.isConfigured || !Cloud.isConfigured()) return { configured: false, user: null };
      return { configured: true, user: Cloud.isSignedIn() ? (Cloud.user() || {}) : null };
    } catch (_) { return { configured: false, user: null }; }
  }
  // the person's choice — not the dark look the Focus page borrows over a dark scene
  function currentScheme() { const r = document.documentElement; return (r.dataset.schemePref || r.dataset.theme) === 'light' ? 'light' : 'dark'; }
  function toggleScheme() {
    const next = currentScheme() === 'light' ? 'dark' : 'light';
    try {
      Store.setSetting('colorScheme', next);
      if (typeof Settings !== 'undefined' && Settings && typeof Settings.applyTheme === 'function') Settings.applyTheme();
      else document.documentElement.dataset.theme = next;
    } catch (_) { document.documentElement.dataset.theme = next; }
    toast(next === 'light' ? 'Light mode on' : 'Dark mode on');
  }

  function buildAccountMenu(el) {
    const p = state.profile;
    const cs = cloudState();
    el.classList.add('gs-pop--account');
    const item = (iconName, label, onClick, opts = {}) => h('button', {
      type: 'button', role: 'menuitem', class: 'gs-menu-item' + (opts.danger ? ' is-danger' : ''),
      disabled: !!opts.busy, 'aria-busy': opts.busy ? 'true' : null, title: opts.title || null,
      on: { click: (e) => { if (opts.keepOpen !== true && !opts.busy) closePopover(true); onClick(e); } },
    }, icon(iconName), h('span', { class: 'gs-menu-label' }, label),
    opts.hint ? h('span', { class: 'gs-menu-hint' }, opts.hint) : null,
    opts.busy ? h('span', { class: 'gs-spinner', 'aria-hidden': 'true' }) : null);
    const sep = () => h('div', { class: 'gs-menu-sep', role: 'separator' });

    // who you are
    let head;
    if (p) {
      head = h('div', { class: 'gs-menu-head' }, avatar(p, 'md'),
        h('div', { class: 'gs-id' }, h('span', { class: 'gs-id-name' }, p.name), p.email ? h('span', { class: 'gs-id-email' }, p.email) : null));
    } else if (cs.user) {
      const name = cs.user.displayName || cs.user.email || 'Signed in';
      head = h('div', { class: 'gs-menu-head' }, avatar({ sub: cs.user.uid || name, name, email: cs.user.email || '' }, 'md'),
        h('div', { class: 'gs-id' }, h('span', { class: 'gs-id-name' }, name), cs.user.email ? h('span', { class: 'gs-id-email' }, cs.user.email) : null));
    } else {
      head = h('div', { class: 'gs-menu-head' }, h('span', { class: 'gs-avatar gs-avatar--md gs-avatar--guest', 'aria-hidden': 'true' }, icon('user')),
        h('div', { class: 'gs-id' }, h('span', { class: 'gs-id-name' }, 'Not signed in'),
          h('span', { class: 'gs-id-email' }, 'Everything is saved in this browser.')));
    }
    const rows = [head, sep()];

    // sign in / sync
    if (cs.configured) {
      rows.push(item('sync', cs.user ? 'Sync & account…' : 'Sign in to sync…', () => { try { Cloud.openSheet(); } catch (_) {} }));
    } else if (!p && state.configured) {
      rows.push(item('user', 'Sign in with Google…', () => {
        const a = document.querySelector('#account-root .gs-avatar-btn');
        if (a) setTimeout(() => openPopover(a, 'dialog', buildSignInPopover), 0);
      }, { keepOpen: true }));
    }
    if (p) {
      rows.push(
        item('calendar', state.busy.calendar ? 'Importing calendar…' : 'Import Google Calendar', () => importCalendar(), { busy: state.busy.calendar }),
        item('tasks', state.busy.tasks ? 'Importing tasks…' : 'Import Google Tasks', () => importTasks(), { busy: state.busy.tasks }));
    }

    // appearance + settings
    const light = currentScheme() === 'light';
    rows.push(
      item(light ? 'moon' : 'sun', light ? 'Dark mode' : 'Light mode', () => toggleScheme(),
        { title: light ? 'Switch to the dark look' : 'Switch to the light look' }),
      item('gear', 'Settings', () => { try { App.showView('settings'); window.scrollTo({ top: 0 }); } catch (_) {} }));
    if (!cs.configured && !state.configured && !p) {
      rows.push(item('calendar', 'Connect a calendar…', () => {
        try { if (typeof Settings !== 'undefined' && Settings.open) Settings.open('calendar'); else App.showView('settings'); } catch (_) {}
      }, { title: 'Settings › Calendar & Accounts' }));
    }
    if (p) rows.push(sep(), item('signout', 'Sign out of Google', () => signOut(), { danger: true }));
    el.append(...rows);
  }

  // ───────────────────────────── renderers ─────────────────────────────

  function signInButton(extraClass) {
    const btn = h('button', {
      type: 'button', class: `gs-signin ${extraClass}`, 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
      title: extraClass === 'gs-signin--topbar' ? 'Account · Sign in with Google' : null,
    }, h('span', { class: 'gs-signin-icon' }, icon('user')), h('span', { class: 'gs-signin-label' }, 'Sign in with Google'));
    btn.addEventListener('click', () => {
      if (cloudSignIn()) return;
      togglePopover(btn, 'dialog', state.configured ? buildSignInPopover : buildSetupPopover);
    });
    return btn;
  }

  function renderTopbar() {
    const root = document.getElementById('account-root');
    if (!root) return;
    const hadFocus = root.contains(document.activeElement);
    if (pop && root.contains(pop.anchor)) closePopover();
    root.textContent = '';
    root.classList.add('gs-account');
    const p = user();
    const cs = cloudState();
    const busy = !!p && (state.busy.calendar || state.busy.tasks);
    // In the sidebar the avatar sits on a row with who you are: name, then email / "Not signed in".
    let face, label, name, sub;
    if (p) { face = avatar(p, 'sm'); label = `Account menu — ${p.email || p.name}`; name = p.name || p.email; sub = p.email && p.email !== name ? p.email : 'Google account'; }
    else if (cs.user) {
      name = cs.user.displayName || cs.user.email || 'Signed in';
      sub = cs.user.email && cs.user.email !== name ? cs.user.email : 'Syncing';
      face = avatar({ sub: cs.user.uid || name, name, email: cs.user.email || '' }, 'sm'); label = `Account menu — ${name}`;
    } else {
      face = h('span', { class: 'gs-avatar gs-avatar--sm gs-avatar--guest', 'aria-hidden': 'true' }, icon('user')); label = 'Account menu — sign in, light or dark mode, settings';
      name = 'Guest'; sub = 'Not signed in';
    }
    const more = h('span', { class: 'gs-acct-more', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'));
    const anchor = h('button', {
      type: 'button', class: 'gs-avatar-btn' + (busy ? ' is-busy' : '') + (p || cs.user ? '' : ' is-guest'),
      'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': label,
      title: p || cs.user ? label.replace('Account menu — ', 'Account: ') : 'Account · sign in, light/dark mode, settings',
    }, face, h('span', { class: 'gs-acct-text' }, h('span', { class: 'gs-acct-name' }, name), h('span', { class: 'gs-acct-sub' }, sub)), more);
    anchor.addEventListener('click', () => togglePopover(anchor, 'menu', buildAccountMenu));
    root.appendChild(anchor);
    if (hadFocus) anchor.focus({ preventScroll: true });
  }

  function statusPill(kind, text) {
    return h('span', { class: `gs-status gs-status--${kind}` }, h('span', { class: 'gs-status-dot', 'aria-hidden': 'true' }), text);
  }

  function importButtons(enabled) {
    const btn = (kind, iconName, label, fn) => h('button', {
      type: 'button', class: 'btn btn-sm gs-import-btn', disabled: !enabled || state.busy[kind],
      'aria-busy': state.busy[kind] ? 'true' : null, on: { click: fn },
    }, state.busy[kind] ? h('span', { class: 'gs-spinner', 'aria-hidden': 'true' }) : icon(iconName),
    state.busy[kind] ? 'Importing…' : label);
    return h('div', { class: 'gs-actions' },
      btn('calendar', 'calendar', 'Import Google Calendar', () => importCalendar()),
      btn('tasks', 'tasks', 'Import Google Tasks', () => importTasks()));
  }

  function lastImportRows() {
    const last = readJSON(K_LAST, {}) || {};
    const row = (label, rec, unit) => h('div', { class: 'gs-last-row' },
      h('dt', null, label),
      h('dd', null, rec && rec.at ? `${fmtWhen(rec.at)} · ${plural(Number(rec.count) || 0, unit)}` : 'Never'));
    return h('dl', { class: 'gs-last' },
      row('Last calendar import', last.calendar, 'event'),
      row('Last tasks import', last.tasks, 'new task'));
  }

  function renderSettings() {
    const root = document.getElementById('settings-account-root');
    if (!root) return;
    if (pop && root.contains(pop.anchor)) closePopover();
    root.textContent = '';
    const p = user();
    const card = h('section', { class: 'glass card gs-card', 'aria-labelledby': 'gs-card-title' });
    card.appendChild(h('div', { class: 'card-header' },
      h('span', { class: 'card-icon' }, icon('user')),
      h('h2', { class: 'card-title', id: 'gs-card-title' }, 'Account & Google'),
      h('span', { class: 'header-spacer' }),
      !state.configured ? statusPill('off', 'Not set up') : p ? statusPill('on', 'Signed in') : statusPill('idle', 'Signed out')));

    const body = h('div', { class: 'gs-card-body' });
    if (!state.configured) {
      body.append(
        h('div', { class: 'gs-card-row' },
          h('div', { class: 'gs-card-copy' },
            h('p', { class: 'gs-card-lead' }, 'Google Calendar: paste its secret iCal link with Calendars › Add a calendar (Google sign-in isn’t set up on this site).'),
            h('p', { class: 'gs-card-muted' }, state.desktopId
              ? 'The configured client ID is the Mac app’s Desktop client. The website needs a Web application client.'
              : 'Once the site owner adds a Google Web client ID, you can sign in and import Google Calendar and Google Tasks. Everything else works without it.')),
          signInButton('gs-signin--card')),
        importButtons(false));
    } else if (!p) {
      const slot = h('div', { class: 'gs-gis-slot gs-gis-slot--card' });
      body.append(
        h('div', { class: 'gs-card-row' },
          h('div', { class: 'gs-card-copy' },
            h('p', { class: 'gs-card-lead' }, 'Sign in to import from Google'),
            h('p', { class: 'gs-card-muted' }, 'Bring your Google Calendar events and open Google Tasks into Pure Focus. Access is read-only.')),
          slot),
        importButtons(false),
        privacyLine());
      mountGisButton(slot, 260);
    } else {
      body.append(
        h('div', { class: 'gs-card-row' },
          h('div', { class: 'gs-identity' },
            avatar(p, 'lg'),
            h('div', { class: 'gs-id' },
              h('span', { class: 'gs-card-lead' }, p.name),
              p.email ? h('span', { class: 'gs-card-muted' }, p.email) : null)),
          h('button', { type: 'button', class: 'btn btn-sm gs-signout-btn', on: { click: () => signOut() } },
            icon('signout'), 'Sign out')),
        importButtons(true),
        lastImportRows(),
        privacyLine());
    }
    card.appendChild(body);
    root.appendChild(card);
  }

  function renderAll() {
    document.documentElement.dataset.google = state.configured ? 'on' : 'off';
    renderTopbar();
    renderSettings();
  }

  // ───────────────────────────── init ─────────────────────────────

  let initialized = false;
  function init() {
    if (initialized) return;
    initialized = true;
    state.cid = resolveClientId();
    state.desktopId = state.cid.startsWith(DESKTOP_ID_PREFIX);
    state.configured = /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(state.cid) && !state.desktopId;
    state.profile = cleanProfile(readJSON(K_PROFILE, null));
    renderAll();
    try { if (typeof Cloud !== 'undefined' && Cloud && typeof Cloud.on === 'function') { Cloud.on('user', renderTopbar); Cloud.on('profile', renderTopbar); } } catch (_) { /* cloud is optional */ }
    if (state.configured) loadGis();     // inject on page load so later clicks can open pop-ups
    // Re-theme the GIS button when the colour scheme changes.
    new MutationObserver(() => { if (state.configured && state.gisReady && !state.profile) renderSettings(); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    // Keep "x min ago" honest while the page stays open.
    setInterval(() => { if (state.profile && !pop) renderSettings(); }, 60000);
    setInterval(refreshCalendarQuietly, 120000);
    document.addEventListener('visibilitychange', refreshCalendarQuietly);
    window.addEventListener('focus', refreshCalendarQuietly);
  }

  return { init, isConfigured, user, signIn, signOut, importCalendar, importTasks, calendarLive,
    _mapEvent: mapEvent, _upsertGoogleTasks: upsertGoogleTasks };
})();
