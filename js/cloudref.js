/* ═══════════════════════════════════════════════════════════════════════
   v2-backend-reference.js — Pure Focus cloud sync + leaderboard reference
   CLOUD_VERSION 1. Pure and DOM-free (runs in JavaScriptCore):
     TZ=America/Los_Angeles jsc engagement-reference.js v2-backend-reference.js v2-backend-reference.test.js
   Web:  WEB/js/cloudref.js is a VERBATIM copy of this file (global `CloudRef`).
   Mac:  Core/Cloud/CloudCore.swift is a 1:1 port, checked against
         v2-backend-vectors.json (written by the test with --write-vectors).
   Contents
     1. constants
     2. hashing, canonical JSON, id normalisation, record keys,
        wire projection (toWire / fromWire), unknown fields (xf), validation
     3. ledger: diffLocal / applyRemote / outbox / settlePush / refusals /
        cursor / prune / rescan
     4. merges: ack join, session rating fill
     5. cloud paste parser + setup code (pfcloud1.)
     6. friend codes
     7. leaderboard week stats (mirror of SQL pf_week_stats), XP ceiling,
        engine week XP, ranking, Firestore week document
     8. self-competition ("you vs last week")
     9. misc: backoff, minutes formatting, clock offset, server-time parsing,
        Supabase row / Firestore document codecs
    10. MemoryBackend + syncCycle (the canonical algorithm; used by tests)
   ═══════════════════════════════════════════════════════════════════════ */

const CloudRef = (() => {
  'use strict';

  // ── 1. constants (changing any of these after release is a protocol change: bump CLOUD_VERSION) ──
  const C = Object.freeze({
    CLOUD_VERSION: 1,
    KINDS: Object.freeze(['task', 'session', 'block', 'feed', 'feedLink', 'taskList', 'template', 'templateList',
      'category', 'setting', 'calPrefs', 'ack', 'course', 'dismissal']),
    // Per-key prefs and singletons: a build that lacks one simply doesn't know it, so absence never deletes.
    NEVER_TOMBSTONED: Object.freeze(['setting', 'calPrefs', 'ack']),
    // Device-local fields: never sent; kept from the local copy when a remote version is applied.
    LOCAL_FIELDS: Object.freeze({ feed: Object.freeze(['etag', 'lastSyncedAt', 'lastError']), taskList: Object.freeze(['lastSyncedAt']) }),
    // Private fields: treated like LOCAL_FIELDS unless the user turns on "Sync focus insights" (opts.syncInsights).
    PRIVATE_FIELDS: Object.freeze({ session: Object.freeze(['factors', 'drift.top']) }),
    U_INITIAL_MS: 946684800000,     // 2000-01-01T00:00:00.000Z: first upload into an EMPTY cloud
    U_JOIN_MS: 946684799999,        // 1 ms earlier: a JOINING device's pre-existing records (cloud wins)
    SKEW_MS: 300000,                // server clamps (Supabase) / refuses (Firestore) updatedAt > now + 5 min
    PULL_OVERLAP_MS: 120000,        // each pull re-reads the last 2 min (late commits)
    PUSH_BATCH: 500,                // Firestore batchWrite limit; Supabase pf_push limit
    PUSH_MAX_BYTES: 1000000,        // and at most ~1 MB of record JSON per push call
    PULL_PAGE_SUPABASE: 1000,       // PostgREST max_rows default
    PULL_PAGE_FIREBASE: 500,
    MAX_DATA_BYTES: 262144,         // UTF-8 bytes of one record's JSON (server: pg_column_size / j.size())
    MAX_REFUSALS: 3,                // refused 3 cycles in a row -> parked until the user taps Retry or edits it
    TOMBSTONE_TTL_MS: 15552000000,  // 180 d: optional server purge and the ledger prune
    RESCAN_AFTER_MS: 12960000000,   // 150 d without a successful pull -> full pull + reconcile
    CLOCK_TRUST_MS: 120000,         // apply a measured server clock offset only when |offset| > 2 min
    DAY_CAP_CM: 48000,              // 8 h/day counted (= the engine's XP band end)
    BAND_FULL_CM: 30000,
    WALL_SLACK_CM: 100,             // credited <= wall-clock length + 1 min
    OVERLAP_TOL_MS: 60000,
    FUTURE_TOL_MS: 300000,
    RECEIPT_MAX_DAYS: 8,            // Supabase only (server receive time)
    DAY_BONUS_CEIL: 1560,           // goal 960 + quests 300 + plan 300
    WEEK_DOC_SLACK: 10950,          // Firestore rule: xp <= 30*minutes + 180*sessions + 10950 (>= every ceiling)
    MAX_FRIENDS: 50,
    CODE_ALPHABET: '0123456789ABCDEFGHJKMNPQRSTVWXYZ',
    SYNCED_SETTINGS: Object.freeze(['focusMinutes', 'shortBreakMinutes', 'longBreakMinutes', 'longBreakInterval',
      'autoStartBreaks', 'autoStartFocus', 'tickingEnabled', 'dailyGoalMinutes', 'showCompletedTasks',
      'themeID', 'engagementMode', 'celebrations', 'celebrationSounds', 'switchToBreakSound',
      'selectedAlarm', 'selectedAmbience', 'selectedMusic', 'alarmVolume', 'ambienceVolume', 'musicVolume', 'tickVolume',
      'musicNormalize', 'musicCrossfade',
      'sceneID', 'sceneDim', 'sceneQuality',
      'colorScheme', 'auroraIntensity',
      'reduceMotion',
      // v2-guard: synced settings (guardIdleAPI/guardNotify are device capabilities but still sync preferences)
      'guardEnabled', 'guardIdle', 'guardIdleSeconds', 'guardNudge', 'guardNudgeAfter', 'guardNudgeSound',
      'guardIdleAPI', 'guardNotify',
      'guardAutoPause', 'guardAutoPauseAfter', 'guardList', 'blockEnabled', 'blockPasses', 'blockDuringBreaks',
      'factorsPrompt', 'insightsHidden',
      // v2-ai: synced preferences
      'coachTier', 'coachRealisticDays', 'coachSendEventTitles',
      'coachEnabled', 'coachConnection', 'coachMonthlyBudgetUSD']),
    CAL_PREF_KEYS: Object.freeze(['weekStartsOn', 'showWeekends', 'planDayStart', 'planDayEnd', 'eventBuffer',
      'maxPlannedFocus', 'showPlanPanel', 'blockReminders', 'reminderLead',
      'promoteAssignments', 'assignmentHorizonDays', 'planRangeDays', 'showNextEventInUpNext', 'weekPlan',
      'showLocalBlocks', 'showDueTasks', 'showSessionTraces', 'assignmentDone']),
  });
  const NO_TOMB = new Set(C.NEVER_TOMBSTONED);

  // ── 2. hashing / canonical JSON / ids ──
  function utf8(str) {
    const out = [];
    for (const ch of String(str)) {
      const c = ch.codePointAt(0);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }
  function utf8Length(str) {
    let n = 0;
    for (const ch of String(str)) { const c = ch.codePointAt(0); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; }
    return n;
  }
  function fnv1a32(str) {
    let h = 0x811c9dc5;
    const b = utf8(str);
    for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
  }
  function hex8(n) { return ('00000000' + (n >>> 0).toString(16)).slice(-8); }

  /** JSON with object keys sorted (code-unit order), no whitespace, undefined dropped. Hashing only. */
  function stableStringify(v) {
    if (v === null || typeof v !== 'object') return v === undefined ? 'null' : JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined ? 'null' : stableStringify(x))).join(',') + ']';
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }
  /** Per-device change detector. Never compared across devices (Swift may use its own sorted-keys encoding). */
  function hashData(data) { const s = stableStringify(data); return hex8(fnv1a32(s)) + '.' + s.length.toString(36); }

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  /** Lower-case a value only when it is a UUID (Swift writes upper-case UUIDs). Other ids (Google calendar ids,
      template slugs) keep their case inside the payload; record KEYS are always lower-cased (recordKey). */
  const lowerUUID = (x) => (typeof x === 'string' && UUID_RE.test(x) ? x.toLowerCase() : x);
  function normalizeIds(kind, data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
    const d = JSON.parse(JSON.stringify(data));
    if ('id' in d) d.id = lowerUUID(d.id);
    for (const f of ['taskID', 'courseID', 'blockID']) if (d[f] != null) d[f] = lowerUUID(d[f]);
    if (kind === 'task' && Array.isArray(d.subtasks)) for (const s of d.subtasks) if (s && 'id' in s) s.id = lowerUUID(s.id);
    if (kind === 'templateList' && Array.isArray(d.tasks)) for (const t of d.tasks) if (t && 'id' in t) t.id = lowerUUID(t.id);
    if (kind === 'course' && Array.isArray(d.assessments)) {
      for (const a of d.assessments) {
        if (!a) continue;
        if ('id' in a) a.id = lowerUUID(a.id);
        if (Array.isArray(a.taskIDs)) a.taskIDs = a.taskIDs.map(lowerUUID);
      }
    }
    return d;
  }
  /** Record id for an entity of a kind. */
  function recordId(kind, entity) {
    switch (kind) {
      case 'category': return 'c' + hex8(fnv1a32(String(entity.name || '').trim().toLowerCase()));
      case 'setting': return String(entity.key);
      case 'calPrefs': case 'ack': return 'main';
      case 'dismissal': { const l = String(entity.id).toLowerCase(); return 'd' + hex8(fnv1a32(l)) + hex8(fnv1a32('pf-dismiss:' + l)); }
      default: return String(entity.id).toLowerCase();     // feedLink: the feed id
    }
  }
  function recordKey(kind, id) { return kind + ':' + String(id).toLowerCase(); }
  /** Deterministic lower-case UUID (version nibble 5, RFC variant) from a key: 4 salted FNV-1a hashes.
      Imported tasks use stableUUID(externalSource + ':' + lower(externalID)) so two devices importing the
      same Google task / Canvas assignment create the SAME task id (no duplicates after sync). */
  function stableUUID(key) {
    const k = String(key);
    let h = '';
    for (let i = 1; i <= 4; i++) h += hex8(fnv1a32('pf-uuid-' + i + ':' + k));
    const v = (parseInt(h[16], 16) & 3) | 8;
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-5' + h.slice(13, 16) + '-' + v.toString(16) + h.slice(17, 20) + '-' + h.slice(20, 32);
  }
  function externalTaskID(source, externalID) { return stableUUID(String(source) + ':' + String(externalID).toLowerCase()); }
  /** Join-time remap for tasks imported on two devices BEFORE they linked (random ids, same external item):
      returns [{from: localId, to: remoteId}]. The platform re-points sessions/blocks taskID from->to and deletes
      the local duplicate before diffLocal stamps the snapshot. */
  function externalTaskRemap(localTasks, remoteRecords) {
    const ext = (t) => (t && t.externalSource && t.externalID ? String(t.externalSource) + ':' + String(t.externalID).toLowerCase() : null);
    const remote = new Map();
    for (const r of remoteRecords) if (r.kind === 'task' && !r.deleted) { const k = ext(r.data); if (k && !remote.has(k)) remote.set(k, String(r.id).toLowerCase()); }
    const out = [];
    for (const t of localTasks) { const k = ext(t); const to = k && remote.get(k); if (to && to !== String(t.id).toLowerCase()) out.push({ from: String(t.id).toLowerCase(), to }); }
    return out;
  }
  function splitKey(key) { const i = key.indexOf(':'); return [key.slice(0, i), key.slice(i + 1)]; }
  function isValidRecordId(id) { return typeof id === 'string' && id.length >= 1 && id.length <= 200 && id === id.toLowerCase() && id.indexOf('/') < 0; }

  // ── wire projection ──
  function pathGet(obj, path) { let o = obj; for (const p of path.split('.')) { if (!o || typeof o !== 'object') return undefined; o = o[p]; } return o; }
  function pathDelete(obj, path) {
    const parts = path.split('.'); let o = obj;
    for (let i = 0; i < parts.length - 1; i++) { if (!o || typeof o !== 'object') return; o = o[parts[i]]; }
    if (o && typeof o === 'object') delete o[parts[parts.length - 1]];
  }
  function pathSet(obj, path, v) {
    const parts = path.split('.'); let o = obj;
    for (let i = 0; i < parts.length - 1; i++) { if (!o[parts[i]] || typeof o[parts[i]] !== 'object') return; o = o[parts[i]]; }
    o[parts[parts.length - 1]] = v;
  }
  function localPaths(kind, opts) {
    const out = (C.LOCAL_FIELDS[kind] || []).slice();
    if (!(opts && opts.syncInsights)) for (const p of C.PRIVATE_FIELDS[kind] || []) out.push(p);
    return out;
  }
  /** Local record -> wire payload (UUIDs lower-cased; device-local and private fields removed). Hash THIS. */
  function toWire(kind, data, opts) {
    const d = normalizeIds(kind, data);
    if (!d || typeof d !== 'object' || Array.isArray(d)) return d;
    for (const p of localPaths(kind, opts)) pathDelete(d, p);
    return d;
  }
  /** Wire payload -> what the store saves: this device's local-only fields survive when the remote lacks them. */
  function fromWire(kind, remote, local, opts) {
    if (!remote || typeof remote !== 'object' || !local || typeof local !== 'object') return remote;
    const d = JSON.parse(JSON.stringify(remote));
    for (const p of localPaths(kind, opts)) {
      const lv = pathGet(local, p);
      if (lv !== undefined && pathGet(d, p) === undefined) pathSet(d, p, JSON.parse(JSON.stringify(lv)));
    }
    return d;
  }
  /** Top-level fields of a remote payload that this build does not model (knownFields: Set, or null = keeps all). */
  function unknownFields(data, knownFields) {
    if (!knownFields || !data || typeof data !== 'object') return null;
    let xf = null;
    for (const k of Object.keys(data)) if (!knownFields.has(k)) (xf || (xf = {}))[k] = data[k];
    return xf;
  }
  /** Client mirror of the server checks (pf_push 'invalid' / Firestore validRecord). null = ok. */
  function validateWire(kind, id, data) {
    if (!/^[a-z][A-Za-z]{1,31}$/.test(String(kind))) return 'kind';
    if (!isValidRecordId(String(id).toLowerCase())) return 'id';
    if (!data || typeof data !== 'object' || Array.isArray(data)) return 'shape';
    if (utf8Length(JSON.stringify(data)) > C.MAX_DATA_BYTES) return 'size';
    return null;
  }

  /** Version order: (updatedAt ms, deviceID). Returns -1, 0, 1. */
  function cmpVersion(aMs, aDev, bMs, bDev) {
    if (aMs !== bMs) return aMs > bMs ? 1 : -1;
    const a = String(aDev || ''), b = String(bDev || '');
    return a === b ? 0 : (a > b ? 1 : -1);
  }
  function isoMs(iso) { const t = Date.parse(iso); return Number.isFinite(t) ? t : NaN; }
  function msIso(ms) { return new Date(ms).toISOString(); }

  // ── 3. ledger ──
  // ledger = { v, provider, project, uid, deviceID, phase:'initial'|'normal', cursorMs:null|number, lastPullMs:null|number,
  //            entries: { key: { u:ms, h:hash|''|null, d:0|1 dirty, x:0|1 tombstone, w:writerDeviceID,
  //                              xf?:{unknown remote fields}, r?:refusals, p?:1 parked } } }
  function newLedger({ provider, project, uid, deviceID }) {
    return { v: 1, provider, project, uid, deviceID, phase: 'initial', cursorMs: null, lastPullMs: null, entries: {} };
  }

  /** Stamp local changes. snapshot = [{kind, id, data: WIRE data}] for every SUPPORTED kind. */
  function diffLocal(L, snapshot, nowMs, opts = {}) {
    const supported = new Set(opts.supportedKinds || C.KINDS);
    const stampNew = opts.newStampMs != null ? opts.newStampMs : null;
    const seen = new Set();
    let dirty = 0, tomb = 0;
    for (const r of snapshot) {
      if (!supported.has(r.kind)) continue;
      const key = recordKey(r.kind, r.id);
      if (seen.has(key)) continue;
      seen.add(key);
      const h = hashData(r.data);
      const e = L.entries[key];
      if (!e) { L.entries[key] = { u: stampNew != null ? stampNew : nowMs, h, d: 1, x: 0, w: L.deviceID }; dirty++; continue; }
      if (e.x || e.h !== h) {
        e.u = Math.max(nowMs, e.u + 1); e.h = h; e.d = 1; e.x = 0; e.w = L.deviceID; delete e.p; delete e.r; dirty++;
      }
    }
    for (const key of Object.keys(L.entries)) {
      const e0 = L.entries[key];
      // clock correction: a stamp far ahead of the (offset-corrected) clock would be refused by Firestore forever
      if (e0.d && e0.u > nowMs + C.SKEW_MS) e0.u = nowMs;
      if (seen.has(key)) continue;
      const [kind] = splitKey(key);
      if (!supported.has(kind) || NO_TOMB.has(kind)) continue;   // never tombstone what this build doesn't model
      const e = L.entries[key];
      if (e.x) continue;
      e.u = Math.max(nowMs, e.u + 1); e.h = ''; e.d = 1; e.x = 1; e.w = L.deviceID; delete e.xf; delete e.p; delete e.r; tomb++;
    }
    return { dirty, tombstoned: tomb };
  }

  /** Decide what to do with one pulled record. rec = {kind,id,data,u,deleted,dev}; localData = local WIRE data or null.
      opts.knownFields = {kind: Set} (Mac) or null (web keeps unknown fields itself).
      Returns {action:'skip'|'upsert'|'delete', data?, dirtyAfter}. Mutates L.entries[key] (h is settled by the caller). */
  function applyRemote(L, rec, localData, nowMs, opts = {}) {
    const key = recordKey(rec.kind, rec.id);
    const e = L.entries[key];
    const remoteData = rec.deleted ? null : normalizeIds(rec.kind, rec.data);
    const known = opts.knownFields ? opts.knownFields[rec.kind] || null : null;
    const xf = rec.deleted ? null : unknownFields(remoteData, known);
    const entry = (o) => { if (xf) o.xf = xf; return o; };

    if (rec.kind === 'ack') {                      // join, never LWW
      if (rec.deleted) return { action: 'skip', dirtyAfter: !!(e && e.d) };
      const merged = mergeAck(localData, remoteData);
      const localChanges = !localData || hashData(merged) !== hashData(localData);
      const remoteBehind = hashData(merged) !== hashData(remoteData);
      const ver = cmpVersion(rec.u, rec.dev, e ? e.u : -Infinity, e ? e.w : '');
      if (remoteBehind) L.entries[key] = { u: Math.max(nowMs, rec.u + 1, e ? e.u + 1 : 0), h: null, d: 1, x: 0, w: L.deviceID };
      else if (ver > 0 || !e) L.entries[key] = { u: rec.u, h: null, d: 0, x: 0, w: rec.dev };
      else if (ver === 0) e.d = 0;
      return localChanges ? { action: 'upsert', data: merged, dirtyAfter: remoteBehind } : { action: 'skip', dirtyAfter: !!L.entries[key].d };
    }

    if (e) {
      const ver = cmpVersion(rec.u, rec.dev, e.u, e.w);
      if (ver < 0) return { action: 'skip', dirtyAfter: !!e.d };
      if (ver === 0) { e.d = 0; delete e.r; delete e.p; return { action: 'skip', dirtyAfter: false }; }
    }
    // remote wins
    if (rec.kind === 'session' && !rec.deleted && localData && localData.focusRating != null && remoteData.focusRating == null) {
      const merged = Object.assign({}, remoteData, { focusRating: localData.focusRating });
      L.entries[key] = entry({ u: Math.max(nowMs, rec.u + 1), h: null, d: 1, x: 0, w: L.deviceID });
      return { action: 'upsert', data: merged, dirtyAfter: true };
    }
    L.entries[key] = entry({ u: rec.u, h: rec.deleted ? '' : null, d: 0, x: rec.deleted ? 1 : 0, w: rec.dev });
    if (rec.deleted) return { action: localData ? 'delete' : 'skip', dirtyAfter: false };
    return { action: 'upsert', data: remoteData, dirtyAfter: false };
  }
  /** After the store applied an upsert, record the hash of the WIRE data as the store now holds it. */
  function settleApplied(L, kind, id, storedWire) {
    const e = L.entries[recordKey(kind, id)];
    if (e && e.h === null) e.h = storedWire == null ? '' : hashData(storedWire);
  }

  /** Records to push (dirty, not parked, not in `skip`), at most `limit` records and ~`maxBytes` of JSON.
      dataByKey maps key -> current local WIRE data. Invalid records are parked here and never sent. */
  function outbox(L, dataByKey, limit = C.PUSH_BATCH, maxBytes = C.PUSH_MAX_BYTES, skip = null) {
    const out = [];
    let bytes = 0;
    for (const key of Object.keys(L.entries).sort()) {
      const e = L.entries[key];
      if (!e.d || e.p || (skip && skip.has(key))) continue;
      const [kind, id] = splitKey(key);
      if (!e.x && !(key in dataByKey)) continue;           // vanished between diff and push: next diff tombstones it
      const data = e.x ? {} : Object.assign({}, e.xf || {}, normalizeIds(kind, dataByKey[key]));
      if (validateWire(kind, id, data)) { e.d = 0; e.p = 1; continue; }
      const size = utf8Length(JSON.stringify(data)) + 120;
      if (out.length && bytes + size > maxBytes) break;
      bytes += size;
      out.push({ kind, id, data, updatedAt: msIso(e.u), deleted: !!e.x, deviceID: L.deviceID, schema: C.CLOUD_VERSION });
      if (out.length >= limit) break;
    }
    return out;
  }
  /** results = [{kind,id,status:'applied'|'stale'|'invalid'|'denied'}] (or legacy {applied:boolean}).
      Returns {refetch:[keys]} — fetch those and call resolveRefetch. */
  function settlePush(L, sent, results) {
    const refetch = [];
    const byKey = new Map(results.map((r) => [recordKey(r.kind, r.id), r]));
    for (const s of sent) {
      const key = recordKey(s.kind, s.id);
      const r = byKey.get(key);
      const e = L.entries[key];
      if (!r || !e) continue;
      const status = r.status || (r.applied ? 'applied' : 'stale');
      if (status === 'applied') { if (e.u === isoMs(s.updatedAt)) { e.d = 0; delete e.r; } }
      else if (status === 'invalid') { e.d = 0; e.p = 1; }
      else { e.d = 0; refetch.push(key); }
    }
    return { refetch };
  }
  /** For a refused key whose fetched server copy is missing or not newer: count a refusal and re-stamp above the
      server copy (fixes clock-ahead refusals once the caller passes a corrected now). Parks after MAX_REFUSALS. */
  function noteRefusal(L, key, remoteU, nowMs) {
    const e = L.entries[key];
    if (!e) return;
    e.r = (e.r || 0) + 1;
    if (e.r >= C.MAX_REFUSALS) { e.d = 0; e.p = 1; return; }
    e.d = 1; e.u = Math.max(nowMs, (remoteU == null ? 0 : remoteU) + 1);
  }
  /** "Retry" in Sync details: unpark everything. */
  function unpark(L) { let n = 0; for (const k of Object.keys(L.entries)) { const e = L.entries[k]; if (e.p) { delete e.p; delete e.r; e.d = 1; n++; } } return n; }
  function parkedCount(L) { let n = 0; for (const k of Object.keys(L.entries)) if (L.entries[k].p) n++; return n; }
  function pendingCount(L) { let n = 0; for (const k of Object.keys(L.entries)) { const e = L.entries[k]; if (e.d && !e.p) n++; } return n; }
  function nextCursor(oldCursorMs, maxServerMs) {
    if (!Number.isFinite(maxServerMs)) return oldCursorMs;
    const c = maxServerMs - C.PULL_OVERLAP_MS;
    return oldCursorMs == null ? c : Math.max(oldCursorMs, c);
  }
  /** Drop clean tombstones older than the server TTL. */
  function pruneLedger(L, nowMs) {
    let n = 0;
    for (const k of Object.keys(L.entries)) { const e = L.entries[k]; if (e.x && !e.d && e.u < nowMs - C.TOMBSTONE_TTL_MS) { delete L.entries[k]; n++; } }
    return n;
  }
  function needsRescan(L, nowMs) { return L.phase === 'normal' && L.lastPullMs != null && nowMs - L.lastPullMs > C.RESCAN_AFTER_MS; }
  /** After a COMPLETE full pull: local records that synced before but are gone from the server (their tombstone was
      purged while this device was away) are deleted locally. Dirty, parked and never-tombstoned kinds are kept. */
  function reconcileFull(L, remoteKeys, localKeys) {
    const del = [];
    for (const key of localKeys) {
      const e = L.entries[key];
      const [kind] = splitKey(key);
      if (!e || e.d || e.p || e.x || NO_TOMB.has(kind) || remoteKeys.has(key)) continue;
      del.push(key); delete L.entries[key];
    }
    return del;
  }

  // ── 4. merges ──
  /** Engagement ack join (commutative, idempotent): max level, union achievements, latest day keys. */
  function mergeAck(a, b) {
    if (!a) return b ? JSON.parse(JSON.stringify(b)) : null;
    if (!b) return JSON.parse(JSON.stringify(a));
    const maxDay = (x, y) => (x == null ? (y == null ? null : y) : (y == null ? x : (x > y ? x : y)));
    const ach = Array.from(new Set([].concat(a.achievements || [], b.achievements || []))).sort();
    const out = { v: 1, level: Math.max(a.level || 0, b.level || 0), achievements: ach };
    for (const k of ['streakMilestoneDay', 'goalDay', 'sweepDay', 'restNoticeDay', 'pbDay', 'welcomeDay']) out[k] = maxDay(a[k], b[k]);
    return out;
  }

  // ── base64url (no atob in jsc) ──
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  function b64urlEncode(str) {
    const b = utf8(str); let out = '';
    for (let i = 0; i < b.length; i += 3) {
      const n = (b[i] << 16) | ((b[i + 1] || 0) << 8) | (b[i + 2] || 0);
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : '') + (i + 2 < b.length ? B64[n & 63] : '');
    }
    return out;
  }
  function b64urlDecode(s) {
    const clean = String(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const bytes = []; let buf = 0, bits = 0;
    for (const ch of clean) {
      const v = B64.indexOf(ch); if (v < 0) throw new Error('b64');
      buf = (buf << 6) | v; bits += 6;
      if (bits >= 8) { bits -= 8; bytes.push((buf >> bits) & 255); }
    }
    let out = '', i = 0;                       // utf-8 decode
    while (i < bytes.length) {
      const c = bytes[i++];
      if (c < 0x80) out += String.fromCharCode(c);
      else if (c < 0xe0) out += String.fromCharCode(((c & 31) << 6) | (bytes[i++] & 63));
      else if (c < 0xf0) out += String.fromCharCode(((c & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63));
      else { const cp = ((c & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63); out += String.fromCodePoint(cp); }
    }
    return out;
  }
  function jwtPayload(jwt) { try { return JSON.parse(b64urlDecode(String(jwt).split('.')[1] || '')); } catch (_) { return null; } }

  // ── 5. cloud paste parser ──
  // Accepts: a Supabase URL + key (publishable or legacy anon JWT), an anon JWT alone (its `ref` gives the URL),
  // a Supabase dashboard link + key, a Firebase config object (JS snippet or JSON), or a pfcloud1. setup code.
  function parseCloudPaste(text) {
    if (text && typeof text === 'object') { const v = validateConfig(Object.assign({ v: 1 }, text)); return v ? { ok: true, config: v } : { ok: false, error: 'not-recognized' }; }
    const s = String(text == null ? '' : text).trim();
    if (!s) return { ok: false, error: 'empty' };
    if (/^pfcloud1\./.test(s)) {
      try { const cfg = JSON.parse(b64urlDecode(s.slice(9))); const v = validateConfig(cfg); return v ? { ok: true, config: v } : { ok: false, error: 'bad-code' }; }
      catch (_) { return { ok: false, error: 'bad-code' }; }
    }
    if (/sb_secret_[A-Za-z0-9_-]+/.test(s)) return { ok: false, error: 'secret-key' };
    const jwts = s.match(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) || [];
    let anon = null, anonRef = null;
    for (const j of jwts) {
      const p = jwtPayload(j);
      if (!p) continue;
      if (p.role === 'service_role' || p.role === 'supabase_admin') return { ok: false, error: 'secret-key' };
      if (p.role === 'anon' && !anon) { anon = j; anonRef = typeof p.ref === 'string' ? p.ref : null; }
    }
    const pub = (s.match(/sb_publishable_[A-Za-z0-9_-]+/) || [])[0] || null;
    let url = null;
    const host = s.match(/https:\/\/([a-z0-9]{20})\.supabase\.co(?![a-z0-9.-])/i);
    if (host) url = 'https://' + host[1].toLowerCase() + '.supabase.co';
    if (!url) { const dash = s.match(/supabase\.com\/dashboard\/project\/([a-z0-9]{20})/i); if (dash) url = 'https://' + dash[1].toLowerCase() + '.supabase.co'; }
    if (!url && anonRef && /^[a-z0-9]{20}$/.test(anonRef)) url = 'https://' + anonRef + '.supabase.co';

    const fbKey = (s.match(/AIza[0-9A-Za-z_-]{35}/) || [])[0] || null;
    const field = (name, re) => { const m = s.match(new RegExp('["\']?' + name + '["\']?\\s*[:=]\\s*["\'](' + re + ')["\']')); return m ? m[1] : null; };
    const projectId = field('projectId', '[a-z0-9][a-z0-9-]{3,38}[a-z0-9]');
    const isSupabase = !!(url || pub || anon), isFirebase = !!fbKey;
    if (isSupabase && isFirebase) return { ok: false, error: 'ambiguous' };
    if (isSupabase) {
      if (!url) return { ok: false, error: 'missing-url' };
      if (!pub && !anon) return { ok: false, error: 'missing-key' };
      const ref = url.slice(8, 28);
      return { ok: true, config: { v: 1, provider: 'supabase', url, key: pub || anon, keyKind: pub ? 'publishable' : 'legacy-anon', projectRef: ref } };
    }
    if (isFirebase) {
      if (!projectId) return { ok: false, error: 'missing-project' };
      const authDomain = field('authDomain', '[A-Za-z0-9.-]+') || (projectId + '.firebaseapp.com');
      const appId = field('appId', '1:[0-9]+:web:[0-9a-f]+');
      return { ok: true, config: { v: 1, provider: 'firebase', apiKey: fbKey, authDomain, projectId, appId: appId || null } };
    }
    return { ok: false, error: 'not-recognized' };
  }
  /** Canonical config. Optional `functionsBase` (https, trailing slash added) overrides the default functions URL. */
  function validateConfig(c) {
    if (!c || c.v !== 1) return null;
    let fb = null;
    if (typeof c.functionsBase === 'string' && /^https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9._~\/-]*)?$/.test(c.functionsBase)) fb = c.functionsBase.replace(/\/?$/, '/');
    const key = c.key || c.anonKey;               // `anonKey` = the v2-calendar.md draft name
    if (c.provider === 'supabase' && /^https:\/\/[a-z0-9-.]+$/.test(c.url || '') && /^(sb_publishable_|eyJ)/.test(key || '')) {
      if (/^eyJ/.test(key)) { const p = jwtPayload(key); if (!p || p.role !== 'anon') return null; }
      const out = { v: 1, provider: 'supabase', url: c.url, key, keyKind: /^sb_publishable_/.test(key) ? 'publishable' : 'legacy-anon', projectRef: c.projectRef || c.url.slice(8).split('.')[0] };
      if (fb) out.functionsBase = fb;
      return out;
    }
    if (c.provider === 'firebase' && /^AIza[0-9A-Za-z_-]{35}$/.test(c.apiKey || '') && /^[a-z0-9-]{5,40}$/.test(c.projectId || '')) {
      const out = { v: 1, provider: 'firebase', apiKey: c.apiKey, authDomain: c.authDomain || (c.projectId + '.firebaseapp.com'), projectId: c.projectId, appId: c.appId || null };
      if (fb) out.functionsBase = fb;
      return out;
    }
    return null;
  }
  function encodeSetupCode(cfg) { const v = validateConfig(cfg); if (!v) throw new Error('bad-config'); return 'pfcloud1.' + b64urlEncode(JSON.stringify(v)); }
  /** Stable id of the configured project (ledger + local cache keys). */
  function projectKey(cfg) { return cfg.provider === 'supabase' ? 'sb:' + cfg.projectRef : 'fb:' + cfg.projectId; }
  /** Base URL of deployed functions (trailing slash). */
  function functionsBase(cfg) {
    if (cfg.functionsBase) return cfg.functionsBase;
    return cfg.provider === 'supabase' ? cfg.url + '/functions/v1/' : 'https://us-central1-' + cfg.projectId + '.cloudfunctions.net/';
  }

  // ── 6. friend codes (Crockford base32, 8 chars = 40 bits) ──
  function friendCodeFromBytes(bytes) { let s = ''; for (let i = 0; i < 8; i++) s += C.CODE_ALPHABET[(bytes[i] & 255) % 32]; return s; }
  function normalizeFriendCode(input) {
    let s = String(input == null ? '' : input).trim();
    const link = s.match(/#friend\/([0-9A-Za-z-]+)/); if (link) s = link[1];
    s = s.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
    return /^[0-9A-HJKMNP-TV-Z]{8}$/.test(s) ? s : null;
  }
  function formatFriendCode(code) { return code.slice(0, 4) + '-' + code.slice(4); }

  // ── 7. leaderboard stats (mirror of SQL pf_week_stats; LOCAL time zone of the runtime) ──
  const pad2 = (n) => (n < 10 ? '0' : '') + n;
  function dayKey(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function keyToDate(k) { return new Date(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10)); }
  function addDays(k, n) { const d = keyToDate(k); d.setDate(d.getDate() + n); return dayKey(d); }
  /** ISO week: Monday. (The engine's Sunday weekStartKey is for achievements; the board resets Monday 00:00 local.) */
  function mondayKey(k) { const d = keyToDate(k); return addDays(k, -((d.getDay() + 6) % 7)); }

  function sessionFact(s, nowMs) {
    if (!s || s.mode !== 'focus' || s.id == null) return null;
    const startMs = Date.parse(s.start), endMs = Date.parse(s.end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
    if (nowMs != null && endMs > nowMs + C.FUTURE_TOL_MS) return null;
    let sched = Number(s.scheduledMinutes); if (!(sched > 0)) sched = 25; sched = Math.min(Math.max(sched, 1), 180);
    const rawCm = Math.floor(Math.max(0, Number(s.minutes) || 0) * 100 + 0.5);
    let cm = Math.min(rawCm, Math.floor((sched + 15) * 100 + 0.5));
    cm = Math.min(cm, Math.floor((endMs - startMs) / 600 + 0.5) + C.WALL_SLACK_CM);
    const thr = Math.floor(Math.max(5, Math.min(10, 0.8 * sched)) * 100 + 0.5);
    return { idLower: String(s.id).toLowerCase(), startMs, endMs, day: dayKey(new Date(startMs)), cm, qualified: cm >= thr };
  }
  function baseXPForDayCm(cm) { return Math.floor(Math.min(cm, C.BAND_FULL_CM) / 10) + Math.floor(Math.max(Math.min(cm, C.DAY_CAP_CM) - C.BAND_FULL_CM, 0) / 20); }
  function xpCeilingDay(cm, q) { return cm > 0 ? 3 * baseXPForDayCm(cm) + 180 * q + C.DAY_BONUS_CEIL : 0; }

  /** opts: {nowMs, cutoffMs (only sessions ending at or before it; self-competition)}. */
  function weekStats(sessions, weekKey, opts = {}) {
    const lo = addDays(weekKey, -1), hi = addDays(weekKey, 7), last = addDays(weekKey, 6);
    const uniq = new Map();
    for (const s of sessions || []) { const f = sessionFact(s, opts.nowMs); if (f && !uniq.has(f.idLower)) uniq.set(f.idLower, f); }
    const cands = Array.from(uniq.values())
      .filter((f) => f.day >= lo && f.day <= hi && (opts.cutoffMs == null || f.endMs <= opts.cutoffMs))
      .sort((a, b) => a.startMs - b.startMs || (a.idLower < b.idLower ? -1 : a.idLower > b.idLower ? 1 : 0));
    let prevEnd = null;
    const byDay = {};
    for (const f of cands) {
      const ok = prevEnd === null || f.startMs >= prevEnd - C.OVERLAP_TOL_MS;
      prevEnd = prevEnd === null ? f.endMs : Math.max(prevEnd, f.endMs);
      if (!ok || f.day < weekKey || f.day > last) continue;
      const d = byDay[f.day] || (byDay[f.day] = { cm: 0, q: 0 });
      d.cm += f.cm; if (f.qualified) d.q++;
    }
    let totalCm = 0, sessionsN = 0, activeDays = 0, baseXP = 0, ceiling = 0;
    for (const k of Object.keys(byDay).sort()) {
      const d = byDay[k]; d.cm = Math.min(d.cm, C.DAY_CAP_CM);
      totalCm += d.cm; sessionsN += d.q; if (d.q > 0) activeDays++;
      baseXP += baseXPForDayCm(d.cm); ceiling += xpCeilingDay(d.cm, d.q);
    }
    return { week: weekKey, minutes: Math.floor(totalCm / 100), sessions: sessionsN, activeDays, baseXP, xpCeiling: ceiling, byDay };
  }
  /** Engine week XP (what the client reports): Σ over the 7 days of session XP + goal bonus + quest XP (+ plan XP when §1.3.7 ships). */
  function engineWeekXP(state, weekKey) {
    let xp = 0;
    for (let i = 0; i < 7; i++) {
      const k = addDays(weekKey, i), d = state.days[k], q = state.quests[k];
      if (d) xp += (d.sessionXP || 0) + (d.goalBonus || 0) + (d.planXP || 0);
      if (q) xp += q.earned || 0;
    }
    return xp;
  }
  /** Displayed XP on the board. */
  function boardXP(reported, stats) { return Math.min(reported == null ? stats.baseXP : Math.max(0, Math.floor(reported)), stats.xpCeiling); }
  /** Firestore rule bound for a client-written week document (always >= the ceiling of the same stats). */
  function weekDocXPBound(minutes, sessions) { return 30 * minutes + 180 * sessions + C.WEEK_DOC_SLACK; }
  /** The users/{uid}/weeks/{week} document a Firebase client writes (su is the REQUEST_TIME transform). */
  function firestoreWeekDoc(stats, reportedXP, profile, engineVersion) {
    return { week: stats.week, minutes: stats.minutes, sessions: stats.sessions, activeDays: stats.activeDays,
      xp: boardXP(reportedXP, stats), optIn: !!profile.lbOptIn, displayName: profile.displayName,
      avatarHue: profile.avatarHue, engine: engineVersion };
  }
  /** Competition ranking (1,2,2,4) by metric desc; ties ordered by displayName then userId (code-unit order). */
  function rankRows(rows, metric) {
    const sorted = rows.slice().sort((a, b) => (b[metric] - a[metric]) ||
      (a.displayName < b.displayName ? -1 : a.displayName > b.displayName ? 1 : 0) ||
      (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
    return sorted.map((r) => Object.assign({}, r, { rank: 1 + sorted.filter((x) => x[metric] > r[metric]).length }));
  }
  /** The rows the compact Friends card shows: you plus up to 2 above and 2 below (5 rows max). */
  function windowRows(ranked, meId) {
    const i = ranked.findIndex((r) => r.userId === meId);
    if (i < 0) return ranked.slice(0, 5);
    let lo = Math.max(0, i - 2), hi = Math.min(ranked.length, lo + 5);
    lo = Math.max(0, hi - 5);
    return ranked.slice(lo, hi);
  }
  /** "Passed <name>" line: friends you overtook with the latest session (before -> after ranks, same metric). */
  function passedFriends(before, after, meId) {
    const rb = new Map(before.map((r) => [r.userId, r.rank]));
    const meB = rb.get(meId), meA = (after.find((r) => r.userId === meId) || {}).rank;
    if (meB == null || meA == null || meA >= meB) return [];
    // strictly ahead of you before, strictly behind you now; never reports anyone passing you
    return after.filter((r) => r.userId !== meId && rb.has(r.userId) && rb.get(r.userId) < meB && r.rank > meA).map((r) => r.displayName);
  }

  // ── 8. self-competition ──
  function fmtMinutes(m) { m = Math.max(0, Math.round(m)); if (m < 60) return m + ' min'; const h = Math.floor(m / 60), r = m % 60; return h + 'h' + (r ? ' ' + r + 'm' : ''); }
  /** "You vs last week": this week so far vs last week up to the same weekday + wall-clock time. */
  function selfCompare(sessions, now, opts = {}) {
    const focusMinutes = opts.focusMinutes || 25;
    const nowMs = now.getTime();
    const wk = mondayKey(dayKey(now)), lwk = addDays(wk, -7);
    const nowLW = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7, now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());
    const thisW = weekStats(sessions, wk, { nowMs, cutoffMs: nowMs });
    const lastSame = weekStats(sessions, lwk, { nowMs, cutoffMs: nowLW.getTime() });
    const lastFull = weekStats(sessions, lwk, { nowMs });
    const startMs = keyToDate(wk).getTime();
    let firstKey = null;
    for (const s of sessions || []) { const f = sessionFact(s, nowMs); if (f && f.startMs < startMs && (firstKey === null || f.day < firstKey)) firstKey = f.day; }
    const delta = thisW.minutes - lastSame.minutes;
    let status, copy;
    if (firstKey === null) { status = 'first'; copy = 'Your first week here. Every session sets the pace for next week.'; }
    else if (Math.abs(delta) < 5) { status = 'even'; copy = "Right on last week's pace."; }
    else if (delta > 0) { status = 'ahead'; copy = fmtMinutes(delta) + " ahead of last week's pace."; }
    else { status = 'behind'; copy = 'Last week by now: ' + fmtMinutes(lastSame.minutes) + '. One ' + focusMinutes + '-minute session ' + (-delta <= focusMinutes ? 'closes the gap.' : 'gets you closer.'); }
    let bestWeek = false;
    if (firstKey !== null) {
      let prev = 0, maxPrev = 0;
      for (let k = mondayKey(firstKey); k < wk; k = addDays(k, 7)) { const st = weekStats(sessions, k, { nowMs }); if (st.minutes > 0) prev++; maxPrev = Math.max(maxPrev, st.minutes); }
      bestWeek = prev >= 2 && thisW.minutes > maxPrev;
    }
    return { week: wk, thisWeek: thisW, lastWeekSoFar: lastSame, lastWeek: lastFull, deltaMinutes: delta, status, copy, bestWeek };
  }

  // ── 9. misc ──
  function backoffMs(attempt, rand) { return Math.round(Math.min(300000, 2000 * Math.pow(2, Math.max(0, attempt))) * (0.8 + 0.4 * rand)); }
  /** Server clock offset from an HTTP `Date` header (1 s resolution): server − local midpoint. */
  function clockOffset(sentMs, receivedMs, serverDateMs) { return Math.round(serverDateMs + 500 - (sentMs + receivedMs) / 2); }
  /** Offset actually applied to stamps: ignore anything within CLOCK_TRUST_MS (header resolution, latency). */
  function trustedOffset(offsetMs) { return Math.abs(offsetMs) > C.CLOCK_TRUST_MS ? offsetMs : 0; }
  /** RFC 3339 with 0–9 fraction digits and Z or ±hh:mm -> epoch ms (fraction truncated to ms; Swift/JSC safe). */
  function parseServerTime(s) {
    const m = String(s).match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)$/);
    if (!m) return NaN;
    let tz = m[4]; if (/^[+-]\d{2}$/.test(tz)) tz += ':00'; else if (/^[+-]\d{4}$/.test(tz)) tz = tz.slice(0, 3) + ':' + tz.slice(3);
    const frac = ((m[3] || '') + '000').slice(0, 3);
    return Date.parse(m[1] + 'T' + m[2] + '.' + frac + tz);
  }
  /** PostgREST pf_records row -> pulled record. */
  function sbDecodeRow(row) {
    return { kind: row.kind, id: row.id, data: row.data || {}, u: parseServerTime(row.updated_at), deleted: !!row.deleted,
      dev: row.device_id, su: parseServerTime(row.server_updated_at) };
  }
  /** Wire record -> Firestore REST Write (batchWrite). Resource names are NOT percent-encoded inside JSON bodies. */
  function fsEncodeWrite(rec, projectId, uid) {
    const name = 'projects/' + projectId + '/databases/(default)/documents/users/' + uid + '/records/' + rec.kind + ':' + rec.id;
    return {
      update: { name, fields: {
        k: { stringValue: rec.kind }, id: { stringValue: rec.id }, j: { stringValue: JSON.stringify(rec.data) },
        u: { integerValue: String(isoMs(rec.updatedAt)) }, del: { booleanValue: !!rec.deleted },
        dev: { stringValue: rec.deviceID }, v: { integerValue: String(rec.schema || C.CLOUD_VERSION) } } },
      updateTransforms: [{ fieldPath: 'su', setToServerValue: 'REQUEST_TIME' }],
    };
  }
  /** Firestore REST Document -> pulled record. */
  function fsDecodeDoc(doc) {
    const f = doc.fields || {};
    let data = {};
    try { data = JSON.parse((f.j && f.j.stringValue) || '{}'); } catch (_) { data = {}; }
    return { kind: f.k && f.k.stringValue, id: f.id && f.id.stringValue, data, u: Number(f.u && f.u.integerValue),
      deleted: !!(f.del && f.del.booleanValue), dev: f.dev && f.dev.stringValue, su: parseServerTime(f.su && f.su.timestampValue) };
  }
  /** batchWrite status[i] -> push status. 0 OK; 7 PERMISSION_DENIED (stale OR invalid: resolved by refetch). */
  function fsStatus(st) { const code = st && st.code ? st.code : 0; return code === 0 ? 'applied' : 'denied'; }

  // ── 10. MemoryBackend + syncCycle ──
  /** In-memory server. mode 'supabase' = pf_push semantics (clamp future, stale/invalid statuses);
      mode 'firestore' = rules semantics (refuse future > SKEW, every refusal is 'denied'). */
  function MemoryBackend(mode = 'supabase') {
    let clock = 1000000;                // server ms, strictly increasing
    const rows = new Map();             // key -> {kind,id,data,u,deleted,dev,su}
    let offline = false, serverNow = null;
    return {
      mode, rows,
      setOffline(v) { offline = !!v; },
      setServerNow(ms) { serverNow = ms; },   // tests: a server clock that differs from the device clock
      push(records, deviceNowMs) {
        if (offline) throw new Error('offline');
        const nowMs = serverNow != null ? serverNow : deviceNowMs;
        if (records.length > C.PUSH_BATCH) throw new Error('bad batch');
        return records.map((r) => {
          const id = String(r.id).toLowerCase(), key = recordKey(r.kind, id);
          const bad = validateWire(r.kind, id, r.data);
          if (bad) return { kind: r.kind, id, status: mode === 'firestore' ? 'denied' : 'invalid' };
          let u = isoMs(r.updatedAt);
          if (u > nowMs + C.SKEW_MS) { if (mode === 'firestore') return { kind: r.kind, id, status: 'denied' }; u = nowMs + C.SKEW_MS; }
          const cur = rows.get(key);
          if (cur && cmpVersion(u, r.deviceID, cur.u, cur.dev) <= 0) return { kind: r.kind, id, status: mode === 'firestore' ? 'denied' : 'stale' };
          clock = Math.max(clock + 1, nowMs);
          rows.set(key, { kind: r.kind, id, data: r.deleted ? {} : r.data, u, deleted: !!r.deleted, dev: r.deviceID, su: clock });
          return { kind: r.kind, id, status: 'applied' };
        });
      },
      pull(cursorMs, limit) {
        if (offline) throw new Error('offline');
        const list = Array.from(rows.values()).filter((r) => cursorMs == null || r.su >= cursorMs)
          .sort((a, b) => a.su - b.su || (a.kind + ':' + a.id < b.kind + ':' + b.id ? -1 : 1)).slice(0, limit);
        return list.map((r) => Object.assign({}, r));
      },
      fetch(keys) { if (offline) throw new Error('offline'); return keys.map((k) => rows.get(k)).filter(Boolean).map((r) => Object.assign({}, r)); },
      purgeTombstones(olderThanSu) { for (const [k, r] of Array.from(rows)) if (r.deleted && r.su < olderThanSu) rows.delete(k); },
      now() { return clock; },
    };
  }

  /** dev = {ledger, snapshot():[{kind,id,data}] (LOCAL data), get(kind,id):LOCAL data|null, apply(kind,id,data|null),
             supportedKinds, wireOpts?:{syncInsights}, knownFields?:{kind:Set}, dedupeOnJoin?(remoteRecords)} */
  function syncCycle(dev, backend, nowMs) {
    const L = dev.ledger;
    const supported = dev.supportedKinds || C.KINDS;
    const wopts = dev.wireOpts || {};
    const pageSize = 50;                 // small in tests to exercise paging
    const wireSnap = () => dev.snapshot().filter((r) => supported.includes(r.kind)).map((r) => ({ kind: r.kind, id: r.id, data: toWire(r.kind, r.data, wopts) }));
    const localWire = (k, id) => { const v = dev.get(k, id); return v == null ? null : toWire(k, v, wopts); };
    function pullFrom(cursor) {
      const out = []; let c = cursor, maxSu = -Infinity;
      for (let guard = 0; guard < 10000; guard++) {
        const page = backend.pull(c, pageSize);
        for (const r of page) { out.push(r); maxSu = Math.max(maxSu, r.su); }
        if (page.length < pageSize) break;
        const lastSu = page[page.length - 1].su;
        if (c != null && lastSu === c) break;     // all rows share one timestamp (cannot happen with clock_timestamp)
        c = lastSu;
      }
      return { records: out, maxSu };
    }
    function applyOne(r) {
      const local = dev.get(r.kind, r.id);
      const res = applyRemote(L, r, local == null ? null : toWire(r.kind, local, wopts), nowMs, { knownFields: dev.knownFields });
      if (res.action === 'upsert') dev.apply(r.kind, r.id, fromWire(r.kind, res.data, local, wopts));
      else if (res.action === 'delete') dev.apply(r.kind, r.id, null);
      settleApplied(L, r.kind, r.id, localWire(r.kind, r.id));
    }
    function applyAll(records) {
      const seen = new Set();
      for (const r of records) {
        const key = recordKey(r.kind, r.id);
        if (seen.has(key + '@' + r.su)) continue; seen.add(key + '@' + r.su);
        if (!supported.includes(r.kind)) continue;
        applyOne(r);
      }
    }
    let pulled, deletedByRescan = 0;
    if (L.phase === 'initial') {
      pulled = pullFrom(null);
      const remoteEmpty = pulled.records.length === 0;
      if (!remoteEmpty && dev.dedupeOnJoin) dev.dedupeOnJoin(pulled.records);
      diffLocal(L, wireSnap(), nowMs, { newStampMs: remoteEmpty ? C.U_INITIAL_MS : C.U_JOIN_MS, supportedKinds: supported });
      applyAll(pulled.records);
      L.phase = 'normal';
    } else {
      const rescan = needsRescan(L, nowMs);
      diffLocal(L, wireSnap(), nowMs, { supportedKinds: supported });
      pulled = pullFrom(rescan ? null : L.cursorMs);
      applyAll(pulled.records);
      if (rescan) {
        const remoteKeys = new Set(pulled.records.map((r) => recordKey(r.kind, r.id)));
        const localKeys = wireSnap().map((r) => recordKey(r.kind, r.id));
        for (const key of reconcileFull(L, remoteKeys, localKeys)) { const [k, id] = splitKey(key); dev.apply(k, id, null); deletedByRescan++; }
      }
    }
    L.lastPullMs = nowMs;
    L.cursorMs = nextCursor(L.cursorMs, pulled.maxSu);
    pruneLedger(L, nowMs);
    // a merge (ack join / rating fill) may have produced new local data: re-stamp hashes
    diffLocal(L, wireSnap(), nowMs, { supportedKinds: supported });
    let pushedTotal = 0;
    const skip = new Set();              // refused this cycle: retried next cycle, not in a loop
    for (let guard = 0; guard < 1000; guard++) {
      const dataByKey = {};
      for (const r of wireSnap()) dataByKey[recordKey(r.kind, r.id)] = r.data;
      const batch = outbox(L, dataByKey, C.PUSH_BATCH, C.PUSH_MAX_BYTES, skip);
      if (!batch.length) break;
      const results = backend.push(batch, nowMs);
      pushedTotal += results.filter((r) => (r.status || (r.applied ? 'applied' : '')) === 'applied').length;
      const { refetch } = settlePush(L, batch, results);
      if (refetch.length) {
        const got = new Map(backend.fetch(refetch).map((r) => [recordKey(r.kind, r.id), r]));
        for (const key of refetch) {
          const e = L.entries[key], r = got.get(key);
          if (r && e && cmpVersion(r.u, r.dev, e.u, e.w) >= 0) applyOne(r);
          else { noteRefusal(L, key, r ? r.u : null, nowMs); skip.add(key); }
        }
      }
    }
    return { pulled: pulled.records.length, pushed: pushedTotal, deletedByRescan, pending: pendingCount(L), parked: parkedCount(L) };
  }

  return {
    C, fnv1a32, hex8, utf8Length, stableStringify, hashData, normalizeIds, recordId, recordKey, splitKey, isValidRecordId,
    stableUUID, externalTaskID, externalTaskRemap,
    toWire, fromWire, unknownFields, validateWire, cmpVersion,
    newLedger, diffLocal, applyRemote, settleApplied, outbox, settlePush, noteRefusal, unpark, parkedCount, pendingCount,
    nextCursor, pruneLedger, needsRescan, reconcileFull, mergeAck,
    b64urlEncode, b64urlDecode, jwtPayload, parseCloudPaste, validateConfig, encodeSetupCode, projectKey, functionsBase,
    friendCodeFromBytes, normalizeFriendCode, formatFriendCode,
    dayKey, addDays, mondayKey, sessionFact, baseXPForDayCm, xpCeilingDay, weekStats, engineWeekXP, boardXP,
    weekDocXPBound, firestoreWeekDoc, rankRows, windowRows, passedFriends,
    fmtMinutes, selfCompare, backoffMs, clockOffset, trustedOffset, parseServerTime, sbDecodeRow, fsEncodeWrite, fsDecodeDoc, fsStatus,
    MemoryBackend, syncCycle,
  };
})();
