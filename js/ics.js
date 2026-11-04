/* ═══════════════════════════════════════════════════════════════════════
   ics.js — a small RFC 5545 reader (VEVENTs only, no dependencies)
   Ported from the tested reference implementation:
   - line unfolding, quoted params, text unescaping
   - DATE (all-day), UTC (Z), TZID (IANA, Windows names, /prefix/ paths),
     floating times (→ X-WR-TIMEZONE, else the device time zone)
   - DTEND or DURATION (or the RFC defaults when both are missing)
   - RRULE: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY with INTERVAL, COUNT, UNTIL, WKST,
     BYDAY (plain weekdays; MONTHLY and YEARLY with BYMONTH also 2TU, -1FR),
     BYMONTHDAY (MONTHLY and YEARLY may count from the end: -1), BYSETPOS,
     BYMONTH (YEARLY); RDATE, EXDATE; RECURRENCE-ID overrides; STATUS:CANCELLED dropped.
     Anything else → first instance only, flagged `unexpanded`.

   Public API
     ICS.parse(text, opts?) → normalized calendar events, ready for
       CalendarView.addExternal(events, 'ics'):
       [{ id, uid, title, start (ISO), end (ISO), allDay, startDay, endDay,
          source: 'ics', calendarName, color, readOnly: true, taskId: null,
          notes, location, url, recurring, isBusy }]
       The array also carries `.calendarName` and `.timeZone`.
       opts: { from: Date, to: Date, calendarName, color, feedID }   (feedID → ids `<feedID>:<UID>:<startKey>`)
       The array also carries `.prodid` (PRODID), `.color` and `.namedInFile` (X-WR-CALNAME present).
       Each event carries `canvasAssignment` (the Canvas assignment id or null; v2-calendar §6.2).
       (default window: 60 days back → 400 days ahead, for RRULE expansion)
     ICS.parseRaw(text, { from, to }) → { name, timeZone, color, events } with
       Date objects (the reference shape).
   ═══════════════════════════════════════════════════════════════════════ */

const ICS = (() => {
  const WIN_TZ = {
    'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago',
    'Mountain Standard Time': 'America/Denver', 'US Mountain Standard Time': 'America/Phoenix',
    'Pacific Standard Time': 'America/Los_Angeles', 'Alaskan Standard Time': 'America/Anchorage',
    'Hawaiian Standard Time': 'Pacific/Honolulu', 'Atlantic Standard Time': 'America/Halifax',
    'GMT Standard Time': 'Europe/London', 'W. Europe Standard Time': 'Europe/Berlin',
    'Romance Standard Time': 'Europe/Paris', 'Central Europe Standard Time': 'Europe/Budapest',
    'E. Europe Standard Time': 'Europe/Bucharest', 'India Standard Time': 'Asia/Kolkata',
    'China Standard Time': 'Asia/Shanghai', 'Tokyo Standard Time': 'Asia/Tokyo',
    'AUS Eastern Standard Time': 'Australia/Sydney', 'UTC': 'UTC',
  };
  const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  const MAX_ITER = 5000;
  const SKIP_MARGIN = 60;   // days kept before the window: a long instance can reach into it
  const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
  const pad = (n) => String(n).padStart(2, '0');
  const dayKey = (w) => `${w.y}-${pad(w.mo)}-${pad(w.d)}`;
  const wallNum = (w) => ((((w.y * 100 + w.mo) * 100 + w.d) * 100 + (w.h || 0)) * 100 + (w.mi || 0)) * 100 + (w.s || 0);

  // ── time zones ──
  const fmtCache = new Map();
  function validTz(tz) {
    if (!tz) return null;
    if (fmtCache.has(tz)) return tz;
    try {
      fmtCache.set(tz, new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }));
      return tz;
    } catch (_) { return null; }
  }
  function cleanTz(raw) {
    if (!raw) return null;
    const t = String(raw).replace(/^"|"$/g, '').trim();
    if (WIN_TZ[t]) return validTz(WIN_TZ[t]);
    if (validTz(t)) return t;
    const segs = t.split('/').filter(Boolean);           // e.g. /mozilla.org/20050126_1/America/New_York
    for (let n = Math.min(3, segs.length); n >= 2; n--) {
      const cand = segs.slice(-n).join('/');
      if (validTz(cand)) return cand;
    }
    return null;                                          // unknown → caller falls back to device time
  }
  function offsetMinutes(date, tz) {
    const p = {};
    for (const x of fmtCache.get(tz).formatToParts(date)) p[x.type] = x.value;
    return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - date.getTime()) / 60000);
  }
  // Wall-clock time in `tz` → absolute Date. Two passes settle DST transitions.
  function zoned(w, tz) {
    const guess = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
    let t = guess - offsetMinutes(new Date(guess), tz) * 60000;
    t = guess - offsetMinutes(new Date(t), tz) * 60000;
    return new Date(t);
  }
  function toDate(w) {
    if (w.allDay) return new Date(w.y, w.mo - 1, w.d);  // local midnight of that calendar day
    if (w.tz === 'UTC') return new Date(Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s));
    if (w.tz && validTz(w.tz)) return zoned(w, w.tz);
    return new Date(w.y, w.mo - 1, w.d, w.h, w.mi, w.s); // floating → device time zone
  }

  // ── lexical layer ──
  const unfold = (text) => text.replace(/\r?\n[ \t]/g, '');
  function parseLine(line) {
    let inQ = false, i = 0;
    for (; i < line.length; i++) {
      const c = line[i];
      if (c === '"') inQ = !inQ;
      else if (c === ':' && !inQ) break;
    }
    const head = line.slice(0, i);
    const value = line.slice(i + 1);
    const parts = head.match(/(?:[^;"]|"[^"]*")+/g) || [''];
    const params = {};
    for (const kv of parts.slice(1)) {
      const j = kv.indexOf('=');
      if (j > 0) params[kv.slice(0, j).toUpperCase()] = kv.slice(j + 1).replace(/^"|"$/g, '');
    }
    return { name: parts[0].toUpperCase(), params, value };
  }
  const unescapeText = (s) => (s || '').replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));

  function parseWhen(value, params, calTz) {
    const v = (value || '').trim();
    let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
    if (m || (params && params.VALUE === 'DATE')) {
      m = m || /^(\d{4})(\d{2})(\d{2})/.exec(v);
      return m ? { allDay: true, y: +m[1], mo: +m[2], d: +m[3], h: 0, mi: 0, s: 0 } : null;
    }
    m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
    if (!m) return null;
    const tz = m[7] === 'Z' ? 'UTC' : (cleanTz(params && params.TZID) || cleanTz(calTz));
    return { allDay: false, y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6], tz };
  }
  function parseDuration(v) {
    const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec((v || '').trim());
    if (!m) return null;
    const sign = m[1] === '-' ? -1 : 1;
    return {
      days: sign * ((+m[2] || 0) * 7 + (+m[3] || 0)),
      ms: sign * (((+m[4] || 0) * 3600 + (+m[5] || 0) * 60 + (+m[6] || 0)) * 1000),
    };
  }

  // ── wall-clock arithmetic (no time zone involved) ──
  function addDays(w, n) {
    const t = new Date(Date.UTC(w.y, w.mo - 1, w.d + n));
    return { ...w, y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
  }
  const weekday = (w) => new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay();
  const daysInMonth = (y, mo) => new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const daysBetween = (a, b) => Math.round((Date.UTC(b.y, b.mo - 1, b.d) - Date.UTC(a.y, a.mo - 1, a.d)) / 86400000);
  const instanceKey = (w) => (w.allDay ? dayKey(w) : String(toDate(w).getTime()));

  // The days of one month a MONTHLY or YEARLY rule lands on, in order. BYDAY and BYMONTHDAY narrow
  // each other ("Friday the 13th"), and BYSETPOS then picks from what's left ("the last weekday").
  function monthDays(y, mo, { s0, byNth, byMonthDay, bySetPos }) {
    const len = daysInMonth(y, mo);
    const dated = byMonthDay ? byMonthDay.map((n) => (n > 0 ? n : len + n + 1)) : null;
    let days;
    if (byNth) {
      days = [];
      for (const { wd, nth } of byNth) {
        const all = [];
        for (let d = 1 + ((wd - weekday({ y, mo, d: 1 }) + 7) % 7); d <= len; d += 7) all.push(d);
        if (!nth) days.push(...all);
        else if (all[nth > 0 ? nth - 1 : all.length + nth]) days.push(all[nth > 0 ? nth - 1 : all.length + nth]);
      }
      if (dated) days = days.filter((d) => dated.includes(d));
    } else {
      days = dated || [s0.d];
    }
    days = [...new Set(days)].filter((d) => d >= 1 && d <= len).sort((a, b) => a - b);  // RFC 5545: invalid dates are skipped
    if (!bySetPos) return days;
    const picked = bySetPos.map((p) => days[p > 0 ? p - 1 : days.length + p]).filter(Boolean);
    return [...new Set(picked)].sort((a, b) => a - b);
  }

  // ── RRULE (minimal) ──
  function expand(ev, from, to) {
    const r = {};
    for (const kv of ev.rrule.split(';')) {
      const j = kv.indexOf('=');
      if (j > 0) r[kv.slice(0, j).toUpperCase()] = kv.slice(j + 1);
    }
    const freq = r.FREQ;
    const inMonth = freq === 'MONTHLY' || freq === 'YEARLY';
    const manyMonths = freq === 'YEARLY' && r.BYMONTH && r.BYMONTH.includes(',');
    const unsupported = !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)
      || ['BYWEEKNO', 'BYYEARDAY', 'BYHOUR', 'BYMINUTE', 'BYSECOND'].some((k) => r[k])
      || (r.BYSETPOS && (!inMonth || manyMonths))         // across months it would need the whole year's set
      || (r.BYDAY && /\d/.test(r.BYDAY) && !inMonth)
      || (r.BYDAY && freq === 'YEARLY' && !r.BYMONTH)      // "the 20th Monday of the year"
      || (r.BYMONTHDAY && /-/.test(r.BYMONTHDAY) && !inMonth)
      || (r.BYMONTH && freq !== 'YEARLY');
    if (unsupported) return null;

    const s0 = ev.startW;
    const interval = Math.max(1, parseInt(r.INTERVAL || '1', 10) || 1);
    const count = r.COUNT ? parseInt(r.COUNT, 10) : Infinity;
    let until = r.UNTIL ? parseWhen(r.UNTIL, {}, null) : null;
    if (until && !until.allDay && !until.tz) until = { ...until, tz: s0.tz };   // floating UNTIL = DTSTART's zone
    const untilTime = until && !until.allDay ? toDate(until).getTime() : null;
    const byNth = r.BYDAY ? r.BYDAY.split(',').map((d) => {
      const m = /^([+-]?\d+)?([A-Z]{2})$/.exec(d.trim().toUpperCase());
      return m ? { wd: DAYS.indexOf(m[2]), nth: m[1] ? parseInt(m[1], 10) : 0 } : { wd: -1, nth: 0 };
    }).filter((x) => x.wd >= 0) : null;
    const byDay = byNth ? byNth.map((x) => x.wd) : null;
    const nonZero = (list) => list.map(Number).filter((n) => Number.isInteger(n) && n !== 0);
    const byMonthDay = r.BYMONTHDAY ? nonZero(r.BYMONTHDAY.split(',')) : null;
    const bySetPos = r.BYSETPOS ? nonZero(r.BYSETPOS.split(',')) : null;
    const byMonth = r.BYMONTH ? r.BYMONTH.split(',').map(Number).filter((n) => n >= 1 && n <= 12).sort((a, b) => a - b) : null;

    const out = [];
    let n = 0;
    let done = false;
    const startNum = wallNum(s0);
    const toTime = to.getTime();
    function emit(w) {                                   // false → stop generating
      if (wallNum(w) < startNum) return true;            // candidates before DTSTART are not instances
      if (n >= count) return false;
      const t = toDate(w).getTime();
      if (until && (until.allDay ? dayKey(w) > dayKey(until) : t > untilTime)) return false;
      n++;
      if (t >= toTime) return false;
      out.push(w);                                       // EXDATE / overrides filtered by the caller
      return true;
    }

    if (freq === 'DAILY') {
      // a daily event from years ago: walk up to the window without building dates, but COUNT sees every day
      const toWindow = daysBetween(s0, { y: from.getUTCFullYear(), mo: from.getUTCMonth() + 1, d: from.getUTCDate() }) - SKIP_MARGIN;
      const skip = Math.max(0, Math.floor(toWindow / interval));
      if (!byDay) n = skip;
      else for (let i = 0; i < skip; i++) if (byDay.includes(weekday(addDays(s0, i * interval)))) n++;
      for (let i = skip; i < skip + MAX_ITER && !done; i++) {
        const w = addDays(s0, i * interval);
        if (byDay && !byDay.includes(weekday(w))) continue;
        if (!emit(w)) done = true;
      }
    } else if (freq === 'WEEKLY') {
      const wkst = Math.max(0, DAYS.indexOf(String(r.WKST || 'MO').trim().toUpperCase()));
      const fromWkst = (d) => (d - wkst + 7) % 7;
      const days = (byDay && byDay.length ? byDay : [weekday(s0)]).map(fromWkst).sort((a, b) => a - b);
      const weekStart = addDays(s0, -fromWkst(weekday(s0)));
      for (let k = 0; k < MAX_ITER && !done; k += interval) {
        for (const off of days) {
          if (!emit(addDays(weekStart, k * 7 + off))) { done = true; break; }
        }
      }
    } else {
      const months = freq === 'YEARLY' ? (byMonth || [s0.mo]) : null;
      for (let k = 0; k < MAX_ITER && !done; k += interval) {
        const slots = [];
        if (freq === 'MONTHLY') {
          const idx = s0.mo - 1 + k;
          slots.push({ y: s0.y + Math.floor(idx / 12), mo: (idx % 12) + 1 });
        } else {
          for (const mo of months) slots.push({ y: s0.y + k, mo });
        }
        for (const slot of slots) {
          for (const d of monthDays(slot.y, slot.mo, { s0, byNth, byMonthDay, bySetPos })) {
            if (!emit({ ...s0, y: slot.y, mo: slot.mo, d })) { done = true; break; }
          }
          if (done) break;
        }
      }
    }
    return out;
  }

  // ── document layer ──
  function parseRaw(text, { from, to }) {
    const lines = unfold(String(text || '').replace(/^﻿/, '')).split(/\r?\n/);
    const cal = { name: null, timeZone: null, color: null, prodid: null };
    const raw = [];
    let cur = null;
    let depth = 0;                                      // >0 while inside VALARM etc. within a VEVENT
    for (const line of lines) {
      if (!line) continue;
      const p = parseLine(line);
      if (p.name === 'BEGIN') {
        if (p.value.toUpperCase() === 'VEVENT' && !cur) { cur = { props: {}, exdates: [], rdates: [], attach: [] }; depth = 0; }
        else if (cur) depth++;
        continue;
      }
      if (p.name === 'END') {
        if (cur && depth > 0) depth--;
        else if (cur && p.value.toUpperCase() === 'VEVENT') { raw.push(cur); cur = null; }
        continue;
      }
      if (!cur) {
        if (p.name === 'X-WR-CALNAME') cal.name = unescapeText(p.value);
        if (p.name === 'X-WR-TIMEZONE') cal.timeZone = cleanTz(p.value);
        if (p.name === 'X-APPLE-CALENDAR-COLOR' || p.name === 'COLOR') cal.color = p.value.trim();
        if (p.name === 'PRODID') cal.prodid = p.value.trim().slice(0, 200);
        continue;
      }
      if (depth > 0) continue;                          // ignore VALARM properties
      if (p.name === 'EXDATE') cur.exdates.push(p);
      else if (p.name === 'RDATE') cur.rdates.push(p);
      else if (p.name === 'ATTACH') cur.attach.push(p);      // every attachment, not just the first
      else if (!cur.props[p.name]) cur.props[p.name] = p;
    }

    const fromTime = from.getTime();
    const toTime = to.getTime();
    const overrides = new Map();                        // uid → Map(instanceKey → VEVENT)
    const masters = [];
    for (const r of raw) {
      const uid = r.props.UID ? r.props.UID.value : null;
      if (r.props['RECURRENCE-ID'] && uid) {
        const rid = parseWhen(r.props['RECURRENCE-ID'].value, r.props['RECURRENCE-ID'].params, cal.timeZone);
        if (rid) {
          if (!overrides.has(uid)) overrides.set(uid, new Map());
          overrides.get(uid).set(instanceKey(rid), r);
        }
      } else {
        masters.push(r);
      }
    }

    const events = [];
    function build(r, startW, recurring, unexpanded) {
      const P = r.props;
      const status = P.STATUS ? P.STATUS.value.toUpperCase() : 'CONFIRMED';
      if (status === 'CANCELLED') return;
      const s0 = parseWhen(P.DTSTART.value, P.DTSTART.params, cal.timeZone);
      const e0 = P.DTEND ? parseWhen(P.DTEND.value, P.DTEND.params, cal.timeZone) : null;
      const dur = P.DURATION ? parseDuration(P.DURATION.value) : null;
      const start = toDate(startW);
      let end;
      let endW = null;
      if (startW.allDay) {
        const span = e0 ? Math.max(1, daysBetween(s0, e0)) : (dur ? Math.max(1, dur.days) : 1);
        endW = addDays(startW, span);
        end = toDate(endW);
      } else if (e0) {
        end = new Date(start.getTime() + Math.max(0, toDate(e0).getTime() - toDate(s0).getTime()));
      } else if (dur) {
        end = new Date(start.getTime() + dur.days * 86400000 + dur.ms);
      } else {
        end = start;                                     // RFC default for DATE-TIME without DTEND/DURATION
      }
      const endCmp = end.getTime() === start.getTime() ? end.getTime() + 1 : end.getTime();
      if (!(start.getTime() < toTime && endCmp > fromTime)) return;
      events.push({
        uid: P.UID ? P.UID.value : null,
        title: unescapeText(P.SUMMARY && P.SUMMARY.value) || '(No title)',
        notes: unescapeText(P.DESCRIPTION && P.DESCRIPTION.value) || null,
        location: unescapeText(P.LOCATION && P.LOCATION.value) || null,
        url: P.URL ? P.URL.value : null,
        // attachments (links to files) and the video-meeting link, when the calendar includes them
        attachments: (r.attach || []).map((a) => ({ url: String(a.value || '').trim(), name: (a.params && (a.params.FILENAME || a.params['X-FILENAME'] || a.params['X-LABEL'])) || null }))
          .filter((a) => /^https:\/\//i.test(a.url)).slice(0, 10),
        conference: ['X-GOOGLE-CONFERENCE', 'X-MICROSOFT-ONLINEMEETINGURL', 'X-MICROSOFT-SKYPETEAMSMEETINGURL']
          .map((k) => (P[k] ? String(P[k].value || '').trim() : '')).find((u) => /^https:\/\//i.test(u)) || null,
        status: status.toLowerCase(),
        transparent: !!(P.TRANSP && P.TRANSP.value.trim().toUpperCase() === 'TRANSPARENT'),
        allDay: !!startW.allDay,
        start, end,
        startDay: startW.allDay ? dayKey(startW) : null,
        endDay: endW ? dayKey(endW) : null,
        recurring, unexpanded,
      });
    }

    for (const r of masters) {
      if (!r.props.DTSTART) continue;
      const startW = parseWhen(r.props.DTSTART.value, r.props.DTSTART.params, cal.timeZone);
      if (!startW) continue;
      const uid = r.props.UID ? r.props.UID.value : null;
      if (!r.props.RRULE && !r.rdates.length) { build(r, startW, false, false); continue; }
      const instances = r.props.RRULE ? expand({ startW, rrule: r.props.RRULE.value }, from, to) : [startW];
      if (!instances) { build(r, startW, true, true); continue; }
      // RDATE: dates the series adds by hand (a period, start/end, counts from its start)
      const have = new Set(r.rdates.length ? instances.map(instanceKey) : []);
      for (const p of r.rdates) {
        for (const v of p.value.split(',')) {
          const w = parseWhen(v.split('/')[0], p.params, cal.timeZone);
          if (!w) continue;
          const at = w.allDay === startW.allDay ? w : { ...w, allDay: startW.allDay };
          if (!have.has(instanceKey(at))) { have.add(instanceKey(at)); instances.push(at); }
        }
      }
      const ex = new Set();
      for (const p of r.exdates) {
        for (const v of p.value.split(',')) {
          const w = parseWhen(v, p.params, cal.timeZone);
          if (w) ex.add(instanceKey(w.allDay === startW.allDay ? w : { ...w, allDay: startW.allDay }));
        }
      }
      const ov = (uid && overrides.get(uid)) || new Map();
      for (const w of instances) {
        const key = instanceKey(w);
        if (ex.has(key) || ov.has(key)) continue;
        build(r, w, true, false);
      }
    }
    for (const map of overrides.values()) {
      for (const r of map.values()) {
        if (!r.props.DTSTART) continue;
        const w = parseWhen(r.props.DTSTART.value, r.props.DTSTART.params, cal.timeZone);
        if (w) build(r, w, true, false);
      }
    }
    events.sort((a, b) => a.start - b.start);
    return { name: cal.name, timeZone: cal.timeZone, color: cal.color, prodid: cal.prodid, events };
  }

  // ── normalization for CalendarView ──

  // FNV-1a, 32-bit, as hex: stable ids for a calendar file's feed.
  function fnv1a(str) {
    let h = 0x811c9dc5;
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  function startKey(ev) {
    if (ev.allDay) return ev.startDay.replace(/-/g, '');
    const d = ev.start;
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  }

  // Canvas items that are assignments (v2-calendar §6.2): UID event-(sub-|abstract-)assignment-<id>,
  // or a URL with #assignment_<id>, #sub_assignment_<id> or /assignments/<id>. Calendar events
  // (event-calendar-event-<id>) stay events. Same regexes as Assignments.canvasAssignmentID.
  const UID_ASSIGN = /^event-(assignment|sub-assignment|abstract-assignment)-(\d{1,15})$/i;
  const URL_ASSIGN = /(?:#(?:assignment|sub_assignment)_(\d{1,15})\b|\/assignments\/(\d{1,15})\b)/i;
  function canvasAssignmentID(uid, url) {
    if (uid) { const m = UID_ASSIGN.exec(String(uid).trim()); if (m) return m[2]; }
    if (url) { const m = URL_ASSIGN.exec(String(url)); if (m) return m[1] || m[2]; }
    return null;
  }

  function cleanColor(c) {
    const m = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(String(c || '').trim());
    return m ? `#${m[1].toLowerCase()}` : null;
  }

  function parse(text, opts = {}) {
    const now = Date.now();
    const from = opts.from instanceof Date ? opts.from : new Date(now - 60 * 86400000);
    const to = opts.to instanceof Date ? opts.to : new Date(now + 400 * 86400000);
    const raw = parseRaw(text, { from, to });
    const calendarName = String(raw.name || opts.calendarName || 'Imported calendar').trim().slice(0, 80) || 'Imported calendar';
    const feed = opts.feedID ? String(opts.feedID) : `ics:${fnv1a(calendarName.toLowerCase())}`;
    const color = cleanColor(opts.color) || cleanColor(raw.color)
      || SERIES[parseInt(fnv1a(calendarName.toLowerCase()), 16) % SERIES.length];
    const seen = new Set();
    const out = [];
    for (const ev of raw.events) {
      const uid = ev.uid || fnv1a(`${ev.title}|${ev.start.getTime()}`);
      let id = `${feed}:${uid}:${startKey(ev)}`;
      if (seen.has(id)) id += `:${out.length}`;
      seen.add(id);
      out.push({
        id,
        uid: ev.uid,
        title: ev.title.slice(0, 200),
        start: ev.start.toISOString(),
        end: ev.end.toISOString(),
        allDay: ev.allDay,
        startDay: ev.startDay,
        endDay: ev.endDay,
        source: 'ics',
        calendarID: feed,
        calendarName,
        color,
        readOnly: true,
        taskId: null,
        notes: ev.notes ? ev.notes.slice(0, 6000) : null,
        location: ev.location,
        url: ev.url,
        attachments: ev.attachments,
        conference: ev.conference,
        recurring: ev.recurring,
        isBusy: !ev.transparent,
        canvasAssignment: canvasAssignmentID(ev.uid, ev.url),
      });
    }
    out.calendarName = calendarName;
    out.namedInFile = !!raw.name;
    out.timeZone = raw.timeZone;
    out.prodid = raw.prodid;
    out.color = cleanColor(raw.color);
    return out;
  }

  return { parse, parseRaw, parseWhen, toDate, cleanTz, unescapeText, fnv1a, canvasAssignmentID };
})();
