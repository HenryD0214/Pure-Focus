/* ═══════════════════════════════════════════════════════════════════════
   cloud-mock.js — DEV ONLY in-page cloud backend (owner: W1; SPEC-V2 §8.1 W1·B item 1)
   Loaded by Cloud.init() only when the page URL has ?cloudMock=1 (Supabase semantics) or
   ?cloudMock=firebase (Firestore REST semantics). Never loaded otherwise; never touches the network.

   • The "server" lives in localStorage['purefocus.cloud.mock'] (shared by every tab of this origin),
     ported from the reference test's in-memory server (CloudRef.MemoryBackend) and the SQL file:
     pf_push LWW on (updated_at, device_id) with a +5 min clamp, tombstones, unique server stamps,
     invalid rows reported (never abort), pf_fetch, profiles + friend codes, reciprocal opt-in
     leaderboard computed from synced sessions (CloudRef.weekStats + the 8-day receipt window),
     pf_report_week, add/remove friend (rate limit 20/h), delete my data / account.
   • ?device=b gives a tab its own device id and data namespace (Profile.ns()), so two tabs act as two
     devices against one server. A write in one tab nudges the other tab's sync (storage event).
   • Offline: navigator.onLine === false or CloudMock.setOffline(true) → every call fails like a network error.

   API: CloudMock.supabase.createClient(url, key, opts) — the supabase-js subset Cloud uses
        CloudMock.firebase — the compat app/auth subset Cloud uses (Firestore goes through CloudMock.fetch)
        CloudMock.fetch(url, init) → Promise<Response>  (schema probe, function pings, Firestore REST)
        CloudMock.onServerChange(fn) · setOffline(bool) · reset() · dump() · options {confirmEmail, google}
   ═══════════════════════════════════════════════════════════════════════ */

const CloudMock = (() => {
  'use strict';

  const KEY = 'purefocus.cloud.mock';            // auth + Supabase tables
  const FS_KEY = 'purefocus.cloud.mock.fs';       // Firestore documents (separate, so the two mocks never overwrite each other)
  const R = () => CloudRef;
  const options = { confirmEmail: false, google: { email: 'alex.rivera@example.com', name: 'Alex Rivera', sub: 'mock-google-1' }, functions: false };
  let offlineFlag = false;
  const changeFns = new Set();

  // ───────────────────────────── server state ─────────────────────────────
  function fresh() {
    return { v: 1, clock: 0, users: {}, tokens: {}, refresh: {}, records: {}, profiles: {}, friends: [], received: {}, reports: {}, hits: {}, fs: {} };
  }
  function load() {
    let s = fresh();
    try { const x = JSON.parse(localStorage.getItem(KEY) || 'null'); if (x && x.v === 1) s = Object.assign(fresh(), x); } catch (_) {}
    try { const f = JSON.parse(localStorage.getItem(FS_KEY) || 'null'); s.fs = f && typeof f === 'object' ? f : {}; } catch (_) { s.fs = {}; }
    return s;
  }
  function save(s) {
    const { fs, ...rest } = s;
    try {
      const a = JSON.stringify(rest), b = JSON.stringify(fs || {});
      if (localStorage.getItem(KEY) !== a) localStorage.setItem(KEY, a);
      if (localStorage.getItem(FS_KEY) !== b) localStorage.setItem(FS_KEY, b);
    } catch (err) { console.warn('CloudMock: state too large', err); }
  }
  function tx(fn) { const s = load(); const out = fn(s); save(s); return out; }
  function tick(s) { s.clock = Math.max(s.clock + 1, Date.now()); return s.clock; }
  const iso = (ms) => new Date(ms).toISOString();
  const offline = () => offlineFlag || (typeof navigator !== 'undefined' && navigator.onLine === false);
  const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
  function rid(n) { const b = new Uint8Array(n); crypto.getRandomValues(b); return Array.from(b, (x) => ('0' + x.toString(16)).slice(-2)).join(''); }
  function uuid() { const h = rid(16); return h.slice(0, 8) + '-' + h.slice(8, 12) + '-4' + h.slice(13, 16) + '-a' + h.slice(17, 20) + '-' + h.slice(20, 32); }
  const pwHash = (pw) => R().hex8(R().fnv1a32('pf-mock:' + String(pw)));
  const delay = (v) => new Promise((res) => setTimeout(() => res(v), 30 + Math.random() * 40));

  try {
    window.addEventListener('storage', (ev) => {
      if (ev.key !== KEY && ev.key !== FS_KEY) return;
      for (const fn of Array.from(changeFns)) { try { fn(); } catch (_) {} }
    });
  } catch (_) {}

  // ───────────────────────────── auth core ─────────────────────────────
  function sbUser(u) {
    return {
      id: u.id, email: u.email, aud: 'authenticated', role: 'authenticated',
      user_metadata: { display_name: u.displayName || null, full_name: u.google ? u.displayName : undefined, avatar_url: null },
      identities: [{ provider: u.google ? 'google' : 'email', identity_data: { sub: u.google ? u.googleSub : u.id, email: u.email } }],
    };
  }
  function issue(s, uid) {
    const access = 'mock.' + rid(12), refresh = 'mockr.' + rid(12);
    s.tokens[access] = { uid, exp: Date.now() + 3600 * 1000 };
    s.refresh[refresh] = uid;
    return { access_token: access, refresh_token: refresh, token_type: 'bearer', expires_in: 3600,
      expires_at: Math.floor((Date.now() + 3600 * 1000) / 1000), user: sbUser(s.users[uid]) };
  }
  function authUid(s, token) {
    const t = token && s.tokens[token];
    if (!t || !s.users[t.uid] || t.exp < Date.now()) return null;
    return t.uid;
  }
  function findByEmail(s, email) {
    const e = String(email || '').trim().toLowerCase();
    return Object.values(s.users).find((u) => u.email.toLowerCase() === e) || null;
  }
  function netErr() { const e = new Error('Load failed'); e.name = 'AuthRetryableFetchError'; e.status = 0; return e; }
  function authErr(code, message, status) { const e = new Error(message); e.name = 'AuthApiError'; e.code = code; e.status = status || 400; return e; }

  // ───────────────────────────── Supabase RPC + table semantics ─────────────────────────────
  const KIND_RE = /^[a-z][A-Za-z]{1,31}$/;
  function sessionFactsOf(s, uid) {
    const rec = s.records[uid] || {};
    const rcv = s.received[uid] || {};
    const out = [];
    for (const r of Object.values(rec)) {
      if (r.kind !== 'session' || r.deleted || !r.data || r.data.mode !== 'focus') continue;
      const end = Date.parse(r.data.end);
      const got = rcv[r.id];
      if (got != null && Number.isFinite(end) && got > end + R().C.RECEIPT_MAX_DAYS * 86400000) continue;   // late backfill ignored
      out.push(r.data);
    }
    return out;
  }
  function weekStatsFor(s, uid, week) { return R().weekStats(sessionFactsOf(s, uid), week, { nowMs: Date.now() }); }
  function profileRow(p) { return clone(p); }
  function newCode(s) {
    for (let i = 0; i < 20; i++) {
      const b = new Uint8Array(8); crypto.getRandomValues(b);
      const code = R().friendCodeFromBytes(b);
      if (!Object.values(s.profiles).some((p) => p.friend_code === code)) return code;
    }
    throw new Error('code space');
  }
  const RPC = {
    pf_schema_version: () => 1,
    pf_push(s, uid, a) {
      const recs = a.p_records;
      if (!Array.isArray(recs) || recs.length > 500) throw Object.assign(new Error('bad batch'), { code: '22023' });
      const now = Date.now();
      const table = s.records[uid] || (s.records[uid] = {});
      const out = [];
      const incoming = new Map();
      for (const x of recs) {
        const id = String(x.id == null ? '' : x.id).toLowerCase();
        const u = Date.parse(x.updatedAt);
        const data = x.data == null ? {} : x.data;
        const ok = KIND_RE.test(String(x.kind)) && id.length >= 1 && id.length <= 200 && id.indexOf('/') < 0 && Number.isFinite(u) &&
          typeof x.deviceID === 'string' && x.deviceID.length >= 1 && x.deviceID.length <= 64 &&
          data && typeof data === 'object' && !Array.isArray(data) && R().utf8Length(JSON.stringify(data)) <= R().C.MAX_DATA_BYTES;
        if (!ok) { out.push({ kind: x.kind, id, status: 'invalid', server_updated_at: null }); continue; }
        const k = x.kind + ':' + id;
        const cand = { kind: x.kind, id, data, u, deleted: !!x.deleted, dev: x.deviceID };
        const prev = incoming.get(k);
        if (!prev || R().cmpVersion(cand.u, cand.dev, prev.u, prev.dev) > 0) incoming.set(k, cand);
        out.push({ kind: x.kind, id, status: '?', server_updated_at: null, _k: k });
      }
      const applied = new Map();
      for (const [k, c] of incoming) {
        const cur = table[k];
        let u = Math.min(c.u, now + R().C.SKEW_MS);
        if (cur && R().cmpVersion(u, c.dev, cur.u, cur.dev) <= 0) continue;
        const su = tick(s);
        table[k] = { kind: c.kind, id: c.id, data: c.deleted ? {} : c.data, u, deleted: c.deleted, dev: c.dev, su };
        applied.set(k, su);
        if (c.kind === 'session') {
          const rc = s.received[uid] || (s.received[uid] = {});
          if (c.deleted || !c.data || c.data.mode !== 'focus') delete rc[c.id];
          else if (rc[c.id] == null) rc[c.id] = Date.now();
        }
      }
      return out.map((o) => {
        if (o.status !== '?') return o;
        const su = applied.get(o._k);
        return { kind: o.kind, id: o.id, status: su != null ? 'applied' : 'stale', server_updated_at: su != null ? iso(su) : null };
      });
    },
    pf_fetch(s, uid, a) {
      const table = s.records[uid] || {};
      return (Array.isArray(a.p_keys) ? a.p_keys : []).slice(0, 500)
        .map((k) => table[k.kind + ':' + String(k.id).toLowerCase()]).filter(Boolean).map(sbRow);
    },
    pf_ensure_profile(s, uid, a) {
      let p = s.profiles[uid];
      const tz = typeof a.p_tz === 'string' && a.p_tz ? a.p_tz : 'UTC';
      if (!p) {
        const name = String(a.p_display_name || '').trim().slice(0, 32) || 'Focuser';
        p = s.profiles[uid] = { user_id: uid, display_name: name, avatar_hue: 210, friend_code: newCode(s), lb_opt_in: false, tz,
          created_at: iso(Date.now()), updated_at: iso(Date.now()) };
      } else if (p.tz !== tz) { p.tz = tz; p.updated_at = iso(Date.now()); }
      return [profileRow(p)];
    },
    pf_update_profile(s, uid, a) {
      const p = s.profiles[uid];
      if (!p) return [];
      const name = a.p_display_name == null ? '' : String(a.p_display_name).trim().slice(0, 32);
      if (name) p.display_name = name;
      if (a.p_avatar_hue != null) p.avatar_hue = Math.min(359, Math.max(0, Math.round(a.p_avatar_hue)));
      if (a.p_lb_opt_in != null) p.lb_opt_in = !!a.p_lb_opt_in;
      p.updated_at = iso(Date.now());
      return [profileRow(p)];
    },
    pf_regenerate_code(s, uid) { const p = s.profiles[uid]; p.friend_code = newCode(s); return p.friend_code; },
    pf_add_friend(s, uid, a) {
      const none = (status) => [{ status, user_id: null, display_name: null, avatar_hue: null }];
      const hits = (s.hits[uid] || []).filter((t) => t > Date.now() - 3600 * 1000);
      if (hits.length >= 20) { s.hits[uid] = hits; return none('rate_limited'); }
      hits.push(Date.now()); s.hits[uid] = hits;
      const code = String(a.p_code || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase().replace(/I/g, '1').replace(/L/g, '1').replace(/O/g, '0');
      if (!/^[0-9A-HJKMNP-TV-Z]{8}$/.test(code)) return none('bad_code');
      const f = Object.values(s.profiles).find((p) => p.friend_code === code);
      if (!f) return none('no_such_code');
      if (f.user_id === uid) return none('own_code');
      const has = s.friends.some((e) => e[0] === uid && e[1] === f.user_id);
      if (!has && s.friends.filter((e) => e[0] === uid).length >= 50) return none('too_many_friends');
      if (!has) { s.friends.push([uid, f.user_id, iso(Date.now())], [f.user_id, uid, iso(Date.now())]); }
      return [{ status: has ? 'already' : 'added', user_id: f.user_id, display_name: f.display_name, avatar_hue: f.avatar_hue }];
    },
    pf_friends(s, uid) {
      return s.friends.filter((e) => e[0] === uid && s.profiles[e[1]]).map((e) => {
        const p = s.profiles[e[1]];
        return { user_id: p.user_id, display_name: p.display_name, avatar_hue: p.avatar_hue, lb_opt_in: p.lb_opt_in, since: e[2] };
      }).sort((x, y) => (x.display_name < y.display_name ? -1 : 1));
    },
    pf_remove_friend(s, uid, a) { s.friends = s.friends.filter((e) => !((e[0] === uid && e[1] === a.p_friend) || (e[0] === a.p_friend && e[1] === uid))); return null; },
    pf_report_week(s, uid, a) {
      const wk = String(a.p_week || '');
      const d = R().dayKey(new Date());
      if (!/^\d{4}-\d{2}-\d{2}$/.test(wk) || R().mondayKey(wk) !== wk || wk > R().addDays(d, 1) || wk < R().addDays(d, -21)) {
        throw Object.assign(new Error('bad_week'), { code: 'P0001' });
      }
      (s.reports[uid] || (s.reports[uid] = {}))[wk] = { xp: Math.min(1000000, Math.max(0, Math.round(a.p_xp || 0))), engine: a.p_engine || 1 };
      return null;
    },
    pf_leaderboard(s, uid, a) {
      const me = s.profiles[uid];
      const opt = !!(me && me.lb_opt_in);
      const week = a.p_week || R().mondayKey(R().dayKey(new Date()));
      const mine = s.friends.filter((e) => e[0] === uid).map((e) => s.profiles[e[1]]).filter(Boolean);
      const hidden = mine.filter((p) => !p.lb_opt_in || !opt).length;
      const members = [uid].concat(opt ? mine.filter((p) => p.lb_opt_in).map((p) => p.user_id) : []);
      return members.filter((m) => s.profiles[m]).map((m) => {
        const p = s.profiles[m];
        const w = weekStatsFor(s, m, week), lw = weekStatsFor(s, m, R().addDays(week, -7));
        const rep = s.reports[m] && s.reports[m][week];
        return { user_id: m, display_name: p.display_name, avatar_hue: p.avatar_hue, is_me: m === uid, week_start: week,
          minutes: w.minutes, sessions: w.sessions, active_days: w.activeDays, xp: Math.min(rep ? rep.xp : w.baseXP, w.xpCeiling),
          xp_ceiling: w.xpCeiling, last_week_minutes: lw.minutes, hidden_friends: hidden };
      }).sort((x, y) => (y.minutes - x.minutes) || (x.display_name < y.display_name ? -1 : 1));
    },
    pf_delete_my_data(s, uid) {
      delete s.records[uid]; delete s.received[uid]; delete s.reports[uid]; delete s.hits[uid]; delete s.profiles[uid];
      s.friends = s.friends.filter((e) => e[0] !== uid && e[1] !== uid);
      return null;
    },
    pf_delete_my_account(s, uid) {
      RPC.pf_delete_my_data(s, uid);
      delete s.users[uid];
      for (const [t, v] of Object.entries(s.tokens)) if (v.uid === uid) delete s.tokens[t];
      return true;
    },
  };
  function sbRow(r) {
    return { kind: r.kind, id: r.id, data: clone(r.data), updated_at: iso(r.u), deleted: r.deleted, device_id: r.dev, schema: 1, server_updated_at: iso(r.su) };
  }
  function pgErr(status, code, message) { return { data: null, error: { message, code, details: '', hint: '' }, status, statusText: '' }; }
  const NET = () => ({ data: null, error: { message: 'TypeError: Load failed', details: '', hint: '', code: '' }, status: 0, statusText: '' });

  // ───────────────────────────── supabase-js surface ─────────────────────────────
  function createClient(url, key, opts) {
    const a = (opts && opts.auth) || {};
    const storageKey = a.storageKey || 'sb-mock-auth-token';
    const storage = a.storage || localStorage;
    const listeners = new Set();
    const readSession = () => { try { return JSON.parse(storage.getItem(storageKey) || 'null'); } catch (_) { return null; } };
    const writeSession = (sess) => { if (sess) storage.setItem(storageKey, JSON.stringify(sess)); else storage.removeItem(storageKey); };
    const fire = (event, sess) => { for (const fn of Array.from(listeners)) setTimeout(() => fn(event, sess), 0); };

    async function getSession() {
      if (offline()) { const sess = readSession(); return { data: { session: sess }, error: null }; }
      let sess = readSession();
      if (!sess) return { data: { session: null }, error: null };
      const s = load();
      if (!s.users[(s.tokens[sess.access_token] || {}).uid] && !s.refresh[sess.refresh_token]) { writeSession(null); return { data: { session: null }, error: null }; }
      if (!authUid(s, sess.access_token) || sess.expires_at * 1000 < Date.now() + 60000) {
        const uid = s.refresh[sess.refresh_token];
        if (!uid || !s.users[uid]) { writeSession(null); fire('SIGNED_OUT', null); return { data: { session: null }, error: null }; }
        delete s.refresh[sess.refresh_token];
        sess = issue(s, uid); save(s); writeSession(sess); fire('TOKEN_REFRESHED', sess);
      }
      return { data: { session: sess }, error: null };
    }
    function token() { const sess = readSession(); return sess ? sess.access_token : null; }

    const auth = {
      getSession,
      onAuthStateChange(fn) {
        listeners.add(fn);
        setTimeout(() => fn('INITIAL_SESSION', readSession()), 0);
        return { data: { subscription: { unsubscribe: () => listeners.delete(fn) } } };
      },
      async signInWithPassword({ email, password }) {
        await delay();
        if (offline()) return { data: { user: null, session: null }, error: netErr() };
        return tx((s) => {
          const u = findByEmail(s, email);
          if (!u || u.pw !== pwHash(password)) return { data: { user: null, session: null }, error: authErr('invalid_credentials', 'Invalid login credentials') };
          if (!u.confirmed) return { data: { user: null, session: null }, error: authErr('email_not_confirmed', 'Email not confirmed') };
          const sess = issue(s, u.id);
          writeSession(sess); fire('SIGNED_IN', sess);
          return { data: { user: sess.user, session: sess }, error: null };
        });
      },
      async signUp({ email, password, options: o }) {
        await delay();
        if (offline()) return { data: { user: null, session: null }, error: netErr() };
        return tx((s) => {
          if (findByEmail(s, email)) return { data: { user: null, session: null }, error: authErr('user_already_exists', 'User already registered', 422) };
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email || ''))) return { data: { user: null, session: null }, error: authErr('email_address_invalid', 'Unable to validate email address: invalid format') };
          if (String(password || '').length < 6) return { data: { user: null, session: null }, error: authErr('weak_password', 'Password should be at least 6 characters.', 422) };
          const id = uuid();
          s.users[id] = { id, email: String(email).trim(), pw: pwHash(password), displayName: (o && o.data && o.data.display_name) || null, confirmed: !options.confirmEmail, createdAt: iso(Date.now()) };
          if (options.confirmEmail) return { data: { user: sbUser(s.users[id]), session: null }, error: null };
          const sess = issue(s, id);
          writeSession(sess); fire('SIGNED_IN', sess);
          return { data: { user: sess.user, session: sess }, error: null };
        });
      },
      async signInWithOAuth() {
        await delay();
        if (offline()) return { data: {}, error: netErr() };
        // The mock has no Google page: it signs straight in as options.google (same account in every tab).
        return tx((s) => {
          const g = options.google;
          let u = Object.values(s.users).find((x) => x.google && x.googleSub === g.sub);
          if (!u) { const id = uuid(); u = s.users[id] = { id, email: g.email, pw: null, displayName: g.name, google: true, googleSub: g.sub, confirmed: true, createdAt: iso(Date.now()) }; }
          const sess = issue(s, u.id);
          writeSession(sess); fire('SIGNED_IN', sess);
          return { data: { provider: 'google', url: null }, error: null };
        });
      },
      async resetPasswordForEmail() { await delay(); return offline() ? { data: null, error: netErr() } : { data: {}, error: null }; },
      async updateUser({ password }) {
        await delay();
        return tx((s) => {
          const uid = authUid(s, token());
          if (!uid) return { data: { user: null }, error: authErr('not_authenticated', 'Auth session missing!', 401) };
          if (password) s.users[uid].pw = pwHash(password);
          fire('USER_UPDATED', readSession());
          return { data: { user: sbUser(s.users[uid]) }, error: null };
        });
      },
      async signOut() { writeSession(null); fire('SIGNED_OUT', null); return { error: null }; },
      async refreshSession() {
        if (offline()) return { data: { session: null }, error: netErr() };
        const sess = readSession();
        return tx((s) => {
          const uid = sess && s.refresh[sess.refresh_token];
          if (!uid || !s.users[uid]) return { data: { session: null }, error: authErr('refresh_token_not_found', 'Invalid Refresh Token', 400) };
          delete s.refresh[sess.refresh_token];
          const next = issue(s, uid); writeSession(next); fire('TOKEN_REFRESHED', next);
          return { data: { session: next }, error: null };
        });
      },
    };

    function call(name, args) {
      return delay().then(() => {
        if (offline()) return NET();
        if (name === 'pf_schema_version') return { data: 1, error: null, status: 200 };
        const s = load();
        const uid = authUid(s, token());
        if (!uid) return pgErr(401, 'PGRST301', 'JWT expired');
        if (!RPC[name]) return pgErr(404, 'PGRST202', 'Could not find the function public.' + name);
        try {
          const data = RPC[name](s, uid, args || {});
          save(s);
          return { data: clone(data), error: null, status: 200 };
        } catch (err) { return pgErr(400, err.code || 'P0001', err.message); }
      });
    }

    function from(table) {
      const qs = { gte: null, limit: 1000 };
      const builder = {
        select() { return builder; },
        order() { return builder; },
        limit(n) { qs.limit = n; return builder; },
        gte(col, v) { if (col === 'server_updated_at') qs.gte = Date.parse(v); return builder; },
        then(resolve, reject) {
          return delay().then(() => {
            if (offline()) return NET();
            if (table !== 'pf_records') return pgErr(404, '42P01', 'relation does not exist');
            const s = load();
            const uid = authUid(s, token());
            if (!uid) return pgErr(401, 'PGRST301', 'JWT expired');
            const rows = Object.values(s.records[uid] || {}).filter((r) => qs.gte == null || r.su >= qs.gte)
              .sort((x, y) => x.su - y.su || (x.kind < y.kind ? -1 : x.kind > y.kind ? 1 : x.id < y.id ? -1 : 1)).slice(0, qs.limit).map(sbRow);
            return { data: rows, error: null, status: 200 };
          }).then(resolve, reject);
        },
      };
      return builder;
    }

    return { auth, rpc: call, from };
  }

  // ───────────────────────────── fetch (probes, pings, Firestore REST) ─────────────────────────────
  function respond(status, body) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { 'Content-Type': 'application/json', Date: new Date().toUTCString() } });
  }
  async function mockFetch(url, init) {
    await delay();
    if (offline()) throw new TypeError('Load failed');
    const u = new URL(url, location.href);
    if (/\/rest\/v1\/rpc\/pf_schema_version$/.test(u.pathname)) return respond(200, '1');
    if (/\/functions\/v1\/|cloudfunctions\.net\//.test(u.href)) return options.functions ? respond(200, { ok: true }) : respond(404, { error: 'not deployed' });
    if (u.hostname === 'firestore.googleapis.com' && typeof FirestoreMock !== 'undefined') return FirestoreMock.handle(u, init || {});
    return respond(404, { error: 'mock: unknown endpoint' });
  }

  // ───────────────────────────── Firestore + Firebase Auth (compat) ─────────────────────────────
  // Documents live in s.fs[path] = {fields, createTime, updateTime}; the rules of backend/firestore.rules
  // are mirrored for what the client does (validRecord + newer, validWeek + 20 s, friend code proof, codes).
  const FirestoreMock = (() => {
    const PFX = /^\/v1\/projects\/([^/]+)\/databases\/\(default\)\/documents/;
    const val = (v) => {
      if (!v) return undefined;
      if ('stringValue' in v) return v.stringValue;
      if ('integerValue' in v) return Number(v.integerValue);
      if ('doubleValue' in v) return Number(v.doubleValue);
      if ('booleanValue' in v) return !!v.booleanValue;
      if ('timestampValue' in v) return Date.parse(v.timestampValue);
      if ('nullValue' in v) return null;
      return undefined;
    };
    const plain = (fields) => { const o = {}; for (const [k, v] of Object.entries(fields || {})) o[k] = val(v); return o; };
    function tokenUid(s, init) {
      const h = (init.headers && (init.headers.Authorization || init.headers.authorization)) || '';
      const t = h.replace(/^Bearer\s+/i, '');
      const x = s.fbTokens && s.fbTokens[t];
      return x && s.users[x] ? x : null;
    }
    function relPath(name) { const i = name.indexOf('/documents/'); return i >= 0 ? name.slice(i + '/documents/'.length) : name; }
    const myOptIn = (s, me) => { const d = s.fs['users/' + me]; return !!(d && plain(d.fields).lbOptIn === true); };
    const isFriendOf = (s, uid, me) => !!s.fs['users/' + uid + '/friends/' + me];
    function canGet(s, me, path) {
      const p = path.split('/');
      if (p[0] === 'codes') return !!me;
      if (p[0] !== 'users') return false;
      const owner = p[1];
      if (owner === me) return true;
      if (p[2] === 'weeks' && p.length === 4) {
        const d = s.fs[path];
        return (!d || plain(d.fields).optIn === true) && isFriendOf(s, owner, me) && myOptIn(s, me);
      }
      return false;
    }
    function docOut(s, path) {
      const d = s.fs[path];
      const pid = 'pf-mock';
      return d ? { name: 'projects/' + pid + '/databases/(default)/documents/' + path, fields: clone(d.fields), createTime: d.createTime, updateTime: d.updateTime } : null;
    }
    function checkWrite(s, me, path, next, prev, nowMs) {
      const p = path.split('/');
      const d = next ? plain(next) : null;
      if (p[0] === 'codes' && p.length === 2) {
        if (!next) return !!(prev && plain(prev.fields).uid === me);
        if (prev) return false;
        return /^[0-9A-HJKMNP-TV-Z]{8}$/.test(p[1]) && d.uid === me && typeof d.displayName === 'string' && d.displayName.length >= 1 && d.displayName.length <= 32;
      }
      if (p[0] !== 'users') return false;
      const owner = p[1];
      if (p.length === 2) {
        if (owner !== me) return false;
        if (!next) return true;
        return Object.keys(d).every((k) => ['displayName', 'avatarHue', 'friendCode', 'lbOptIn', 'tz', 'createdAt', 'updatedAt'].includes(k)) &&
          typeof d.displayName === 'string' && d.displayName.length >= 1 && d.displayName.length <= 32 && /^[0-9A-HJKMNP-TV-Z]{8}$/.test(d.friendCode || '') &&
          typeof d.lbOptIn === 'boolean' && d.updatedAt === nowMs;
      }
      if (p[2] === 'records') {
        if (owner !== me) return false;
        if (!next) return true;
        const ok = d.k && KIND_RE.test(d.k) && typeof d.id === 'string' && d.id.length >= 1 && d.id.length <= 200 && d.id === d.id.toLowerCase() &&
          d.id.indexOf('/') < 0 && p[3] === d.k + ':' + d.id && typeof d.j === 'string' && d.j.length <= 262144 && Number.isFinite(d.u) &&
          d.u <= nowMs + 300000 && typeof d.del === 'boolean' && /^[0-9a-f]{32}$/.test(d.dev || '') && d.su === nowMs;
        if (!ok) return false;
        if (prev) { const o = plain(prev.fields); return d.u > o.u || (d.u === o.u && d.dev > o.dev); }
        return true;
      }
      if (p[2] === 'friends') {
        const fid = p[3];
        if (!next) return owner === me || fid === me;
        if (prev || owner === fid || typeof d.code !== 'string') return false;
        const code = s.fs['codes/' + d.code];
        const codeOwner = code ? plain(code.fields).uid : null;
        return d.since === nowMs && ((owner === me && codeOwner === fid) || (fid === me && codeOwner === owner));
      }
      if (p[2] === 'weeks') {
        if (owner !== me) return false;
        if (!next) return true;
        if (prev && !(nowMs > plain(prev.fields).su + 20000)) return false;
        return d.week === p[3] && d.minutes <= 3360 && d.sessions <= 300 && d.activeDays <= 7 && d.xp <= 30 * d.minutes + 180 * d.sessions + 10950 && d.su === nowMs;
      }
      if (p[2] === 'weekXP') return false;     // only once boardSync is deployed (not in the mock)
      return false;
    }
    function batchWrite(s, me, body) {
      const results = [], status = [];
      for (const w of body.writes || []) {
        const nowMs = tick(s);
        const ts = iso(nowMs);
        const path = relPath(w.delete || (w.update && w.update.name) || '');
        const prev = s.fs[path] || null;
        if (w.currentDocument && w.currentDocument.exists === false && prev) { status.push({ code: 6, message: 'ALREADY_EXISTS' }); results.push({}); continue; }
        if (w.delete) {
          if (!checkWrite(s, me, path, null, prev, nowMs)) { status.push({ code: 7, message: 'PERMISSION_DENIED' }); results.push({}); continue; }
          delete s.fs[path]; status.push({ code: 0 }); results.push({ updateTime: ts }); continue;
        }
        let fields = clone(w.update.fields || {});
        if (w.updateMask && prev) fields = Object.assign(clone(prev.fields), Object.fromEntries((w.updateMask.fieldPaths || []).map((f) => [f, fields[f]])));
        for (const t of w.updateTransforms || []) if (t.setToServerValue === 'REQUEST_TIME') fields[t.fieldPath] = { timestampValue: ts };
        if (!checkWrite(s, me, path, fields, prev, nowMs)) { status.push({ code: 7, message: 'PERMISSION_DENIED' }); results.push({}); continue; }
        s.fs[path] = { fields, createTime: prev ? prev.createTime : ts, updateTime: ts };
        status.push({ code: 0 }); results.push({ updateTime: ts });
      }
      return { writeResults: results, status };
    }
    function handle(u, init) {
      const s = load();
      const me = tokenUid(s, init);
      if (!me) return respond(401, { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } });
      const m = u.pathname.match(PFX);
      if (!m) return respond(404, { error: { code: 404, message: 'not found', status: 'NOT_FOUND' } });
      const rest = decodeURIComponent(u.pathname.slice(m[0].length));
      const body = init.body ? JSON.parse(init.body) : {};
      const denied = () => respond(403, { error: { code: 403, message: 'Missing or insufficient permissions.', status: 'PERMISSION_DENIED' } });
      if (rest === ':batchWrite') { const out = batchWrite(s, me, body); save(s); return respond(200, out); }
      if (rest === ':batchGet') {
        const out = [];
        for (const n of body.documents || []) {
          const path = relPath(n);
          if (!canGet(s, me, path)) return denied();
          const d = docOut(s, path);
          out.push(d ? { found: d, readTime: iso(Date.now()) } : { missing: n, readTime: iso(Date.now()) });
        }
        return respond(200, out);
      }
      const rq = rest.match(/^\/users\/([^/]+):runQuery$/);
      if (rq) {
        if (rq[1] !== me) return denied();
        const sq = body.structuredQuery || {};
        const lo = sq.where ? Date.parse(sq.where.fieldFilter.value.timestampValue) : null;
        const pre = 'users/' + me + '/records/';
        const docs = Object.keys(s.fs).filter((p) => p.startsWith(pre)).map((p) => ({ p, su: Date.parse(s.fs[p].fields.su.timestampValue) }))
          .filter((x) => lo == null || x.su >= lo).sort((a, b) => a.su - b.su || (a.p < b.p ? -1 : 1)).slice(0, sq.limit || 500);
        return respond(200, docs.length ? docs.map((x) => ({ document: docOut(s, x.p), readTime: iso(Date.now()) })) : [{ readTime: iso(Date.now()) }]);
      }
      const path = rest.replace(/^\//, '');
      if ((init.method || 'GET') === 'GET') {
        const segs = path.split('/');
        if (segs.length % 2 === 1) {     // a collection: list
          if (!(segs[0] === 'users' && segs[1] === me)) return denied();
          const pre = path + '/';
          const docs = Object.keys(s.fs).filter((p) => p.startsWith(pre) && p.slice(pre.length).indexOf('/') < 0).sort().map((p) => docOut(s, p));
          return respond(200, docs.length ? { documents: docs } : {});
        }
        if (!canGet(s, me, path)) return denied();
        const d = docOut(s, path);
        return d ? respond(200, d) : respond(404, { error: { code: 404, message: 'Document "' + path + '" not found.', status: 'NOT_FOUND' } });
      }
      return respond(400, { error: { code: 400, message: 'mock: unsupported', status: 'INVALID_ARGUMENT' } });
    }
    return { handle };
  })();

  const firebase = (() => {
    const apps = [];
    function fbErr(code, message) { const e = new Error(message || code); e.code = code; return e; }
    function makeAuth(appName) {
      const key = 'purefocus.cloud.fbmock.' + appName;
      let persistence = 'local';
      const listeners = new Set();
      const read = () => { try { return JSON.parse(sessionStorage.getItem(key) || localStorage.getItem(key) || 'null'); } catch (_) { return null; } };
      const write = (v) => {
        try {
          localStorage.removeItem(key); sessionStorage.removeItem(key);
          if (v) (persistence === 'session' ? sessionStorage : localStorage).setItem(key, JSON.stringify(v));
        } catch (_) {}
      };
      function userObj(sess) {
        if (!sess) return null;
        const s = load();
        const u = s.users[sess.uid];
        if (!u) return null;
        return {
          uid: u.id, email: u.email, displayName: u.displayName || null, photoURL: null,
          providerData: [u.google ? { providerId: 'google.com', uid: u.googleSub } : { providerId: 'password', uid: u.email }],
          async getIdToken() {
            if (offline()) throw fbErr('auth/network-request-failed');
            return tx((st) => { st.fbTokens = st.fbTokens || {}; const live = Object.keys(st.fbTokens).find((t) => st.fbTokens[t] === u.id); if (live) return live; const t = 'fbmock.' + rid(12); st.fbTokens[t] = u.id; return t; });
          },
          async updateProfile(p) { tx((st) => { if (st.users[u.id] && p.displayName) st.users[u.id].displayName = p.displayName; }); },
          async updatePassword(pw) { tx((st) => { st.users[u.id].pw = pwHash(pw); }); },
          async delete() { tx((st) => { delete st.users[u.id]; }); write(null); emit(); },
        };
      }
      let current = null;
      const emit = () => { current = userObj(read()); for (const fn of Array.from(listeners)) setTimeout(() => fn(current), 0); };
      const auth = {
        get currentUser() { return current; },
        async setPersistence(p) { persistence = p === 'session' ? 'session' : 'local'; },
        onAuthStateChanged(fn) { listeners.add(fn); current = userObj(read()); setTimeout(() => fn(current), 0); return () => listeners.delete(fn); },
        async signInWithEmailAndPassword(email, password) {
          await delay();
          if (offline()) throw fbErr('auth/network-request-failed');
          const s = load();
          const u = findByEmail(s, email);
          if (!u || u.pw !== pwHash(password)) throw fbErr('auth/invalid-credential', 'INVALID_LOGIN_CREDENTIALS');
          write({ uid: u.id }); emit();
          return { user: current };
        },
        async createUserWithEmailAndPassword(email, password) {
          await delay();
          if (offline()) throw fbErr('auth/network-request-failed');
          const id = tx((s) => {
            if (findByEmail(s, email)) return null;
            const nid = 'fb' + rid(10);
            s.users[nid] = { id: nid, email: String(email).trim(), pw: pwHash(password), displayName: null, confirmed: true, createdAt: iso(Date.now()) };
            return nid;
          });
          if (!id) throw fbErr('auth/email-already-in-use', 'EMAIL_EXISTS');
          if (String(password).length < 6) throw fbErr('auth/weak-password');
          write({ uid: id }); emit();
          return { user: current };
        },
        async signInWithPopup() {
          await delay();
          if (offline()) throw fbErr('auth/network-request-failed');
          const g = options.google;
          const id = tx((s) => {
            let u = Object.values(s.users).find((x) => x.google && x.googleSub === g.sub);
            if (!u) { const nid = 'fb' + rid(10); u = s.users[nid] = { id: nid, email: g.email, pw: null, displayName: g.name, google: true, googleSub: g.sub, confirmed: true }; }
            return u.id;
          });
          write({ uid: id }); emit();
          return { user: current };
        },
        async sendPasswordResetEmail() { await delay(); if (offline()) throw fbErr('auth/network-request-failed'); },
        async signOut() { write(null); emit(); },
      };
      return auth;
    }
    function GoogleAuthProvider() {}
    const authNS = { GoogleAuthProvider, Auth: { Persistence: { LOCAL: 'local', SESSION: 'session' } } };
    return {
      apps,
      auth: authNS,
      initializeApp(cfg, name) {
        const app = { name: name || '[DEFAULT]', options: cfg };
        let a = null;
        app.auth = () => (a || (a = makeAuth(app.name)));
        apps.push(app);
        return app;
      },
    };
  })();

  return {
    supabase: { createClient },
    firebase,
    fetch: mockFetch,
    options,
    onServerChange(fn) { if (typeof fn === 'function') changeFns.add(fn); return () => changeFns.delete(fn); },
    setOffline(v) { offlineFlag = !!v; },
    reset() { try { localStorage.removeItem(KEY); localStorage.removeItem(FS_KEY); } catch (_) {} },
    dump() { return load(); },
  };
})();
