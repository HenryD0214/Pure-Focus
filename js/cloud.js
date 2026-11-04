/* ═══════════════════════════════════════════════════════════════════════
   cloud.js — optional cloud sync, accounts and friends (owner: W1)
   v2-backend §2–§8, §10.1; SPEC-V2 §8.1 W1·B items 2–3.

   Without a backend the product behaves exactly like v1: no SDK request, no network,
   status 'off'. With one (js/config.js `CLOUD` block = whole site, or the paste in
   Settings › Calendar & Accounts › Sync = this device):
     • Supabase (recommended): supabase-js 2.117.3 UMD (lazy, SRI), PKCE Google redirect,
       email sign-up/in/reset; PostgREST + RPCs (pf_push, pf_fetch, pf_leaderboard, …).
     • Firebase: compat 12.19.0 app + auth (lazy, SRI), Google popup + email; Firestore over
       REST (the same wire format as the Mac).
   Sync = an async port of CloudRef.syncCycle (the normative algorithm) under a Web Lock,
   with the ledger as the offline queue (pfKey('purefocus.cloud.ledger.v1')).
   Dev only: ?cloudMock=1 (Supabase semantics) or ?cloudMock=firebase loads js/cloud-mock.js
   instead of any SDK; &device=b gives the tab its own device id and data namespace.

   Public API (final; v2-backend §10.1 + openSheet):
     init() · config() · isConfigured() · source() · setPaste(text) · clearConfig() · setupCode() · provider()
     isSignedIn() · user() · signInWithGoogle() · signInWithEmail(e, p) · signUp(e, p, name) · resetPassword(e)
     signOut() · idToken() · functionURL(name) · capabilities()
     status() · syncNow() · retryParked() · setSyncLinks(on) · setSyncInsights(on) · prefs()
     deleteCloudData(onProgress?) · disconnect() · on(event, fn)        events: status · user · board · profile
     profile() · updateProfile(patch) · regenerateCode() · addFriend(code) · removeFriend(uid) · friends()
     board(week?, {force}) · cachedBoard() · shareLink() · openSheet(state?)
   Extras (W1 UI): siteError() · pasteCopy(code) · authCopy(err) · updatePassword(p) · deleteAccount() ·
     setupState() · checkSetup() · counts() · currentWeek() · rememberSession() · setRememberSession(on) · isMock()
   Never logs tokens, keys or calendar links. Remote strings reach the DOM only via textContent (cloud-ui/friends).
   ═══════════════════════════════════════════════════════════════════════ */

const Cloud = (() => {
  'use strict';

  const R = () => CloudRef;
  const SDK = {
    supabase: [
      { src: 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/dist/umd/supabase.js',
        integrity: 'sha384-BWcjm9OdFth9TbhCxZPdm+gAOUMAzQy9nmTs12ioXdCcbVnJaPMn+fMUoQCLt60R' },
    ],
    firebase: [
      { src: 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app-compat.js',
        integrity: 'sha384-aUtWR1iCiOCHS8pn1nKNXMZm3I/eDrV63IXWXgE+mHHqJfYTWYV+jGk0sCXz57+U' },
      { src: 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth-compat.js',
        integrity: 'sha384-ZRqyA8Xkw0A6FmVya9A0Werzt9yjKKAp2TCzqVJjHK1O3oyb0z9jMxpkWPVoFtUm' },
    ],
  };
  const DEBOUNCE_MS = 4000, MAX_WAIT_MS = 30000, SESSION_DELAY_MS = 2000, VISIBLE_STALE_MS = 60000, TIMER_MS = 300000;
  const BOARD_STALE_MS = 300000, REPORT_THROTTLE_MS = 60000, CAPS_TTL_MS = 86400000, CAPS_NEGATIVE_TTL_MS = 60000;
  const PREFS_DEFAULT = { syncLinks: true, syncInsights: false };

  const ns = () => { try { return Profile.ns(); } catch (_) { return ''; } };
  const K = {
    config: 'purefocus.cloud.config',
    device: () => 'purefocus.cloud.device' + ns(),
    remember: () => 'purefocus.cloud.remember' + ns(),
    caps: () => 'purefocus.cloud.caps' + ns(),
    schema: () => 'purefocus.cloud.schema' + ns(),
    returnRoute: 'purefocus.cloud.returnRoute',
    ledger: () => pfKey('purefocus.cloud.ledger.v1'),
    prefs: () => pfKey('purefocus.cloud.prefs'),
    board: () => pfKey('purefocus.board.v1'),
    profile: () => pfKey('purefocus.cloud.profile'),
    reported: () => pfKey('purefocus.cloud.reported'),
  };

  // ───────────────────────────── small helpers ─────────────────────────────
  function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function lsSet(k, v) {
    try {
      if (typeof Store !== 'undefined' && Store.safeSet) return Store.safeSet(k, v);
      localStorage.setItem(k, v); return true;
    } catch (_) { return false; }
  }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (_) {} }
  function readJSON(k, dflt) { try { const r = lsGet(k); return r == null ? dflt : JSON.parse(r); } catch (_) { return dflt; } }
  function writeJSON(k, v) { return lsSet(k, JSON.stringify(v)); }

  class CloudError extends Error {
    constructor(code, message, extra) { super(message || code); this.code = code; Object.assign(this, extra || {}); }
  }
  const isNetwork = (e) => !!e && e.code === 'network';

  function hex(bytes) { return Array.from(bytes, (b) => ('0' + b.toString(16)).slice(-2)).join(''); }
  function randomBytes(n) {
    const b = new Uint8Array(n);
    try { crypto.getRandomValues(b); } catch (_) { for (let i = 0; i < n; i++) b[i] = Math.floor(Math.random() * 256); }
    return b;
  }
  function deviceID() {
    let id = lsGet(K.device());
    if (!/^[0-9a-f]{32}$/.test(id || '')) { id = hex(randomBytes(16)); lsSet(K.device(), id); }
    return id;
  }
  function timeZone() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_) { return 'UTC'; } }
  function mockMode() { try { return Profile.mockMode(); } catch (_) { return ''; } }
  /* Where OAuth / email links come back to: this page without auth params or hash. */
  function returnURL() {
    try {
      const u = new URL(location.href);
      ['code', 'error', 'error_description', 'error_code', 'type'].forEach((k) => u.searchParams.delete(k));
      u.hash = '';
      return u.toString();
    } catch (_) { return ''; }
  }

  // ───────────────────────────── events / status ─────────────────────────────
  const listeners = new Map();
  function on(event, fn) {
    if (typeof fn !== 'function') return () => {};
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event).delete(fn);
  }
  function emit(event, payload) {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of Array.from(set)) { try { fn(payload); } catch (err) { console.error('Cloud listener failed', err); } }
  }

  const st = {
    inited: false,
    cfg: null, source: null, siteError: null,
    adapter: null,
    user: null,
    schema: null,           // ready · missingSQL · missingRules · missingDatabase · rejectedKey · unreachable
    profile: null,
    offsetMs: 0,
    recovery: false,        // PASSWORD_RECOVERY return (Supabase)
    status: { state: 'off', lastSyncAt: null, pending: 0, parked: 0, attention: null },
    lastPullMs: null,
  };

  // Attention kinds that need the user (account dot, E19): everything except a passing hiccup.
  const ATTENTION_DOT = new Set(['signIn', 'setupSQL', 'rules', 'database', 'key', 'unreachable', 'storage']);
  function setStatus(patch) {
    const prev = st.status;
    st.status = { ...prev, ...patch };
    if (st.status.state !== 'attention') st.status.attention = null;
    try {
      if (typeof Dots !== 'undefined' && Dots.set) Dots.set('account', st.status.state === 'attention' && ATTENTION_DOT.has(st.status.attention));
    } catch (_) {}
    if (JSON.stringify(prev) !== JSON.stringify(st.status)) emit('status', status());
  }
  function status() { return { ...st.status }; }

  // ───────────────────────────── config ─────────────────────────────
  const MOCK_CFG = {
    supabase: { v: 1, provider: 'supabase', url: 'https://pfmockpfmockpfmockpf.supabase.co', key: 'sb_publishable_pf_mock_dev_only',
      keyKind: 'publishable', projectRef: 'pfmockpfmockpfmockpf' },
    firebase: { v: 1, provider: 'firebase', apiKey: 'AIzaSyPFMOCK-dev-only-000000000000000000', authDomain: 'pf-mock.firebaseapp.com',
      projectId: 'pf-mock', appId: null },
  };

  let warnedSite = false;
  function readConfig() {
    st.cfg = null; st.source = null; st.siteError = null;
    const mm = mockMode();
    if (mm) {
      st.cfg = mm === 'firebase' ? { ...MOCK_CFG.firebase } : { ...MOCK_CFG.supabase };
      st.source = 'site';
      return;
    }
    let site = '';
    try { site = typeof Config !== 'undefined' && Config ? Config.CLOUD : ''; } catch (_) { site = ''; }
    const siteFilled = site && (typeof site === 'object' || String(site).trim());
    if (siteFilled) {
      const r = R().parseCloudPaste(site);
      if (r.ok) { st.cfg = r.config; st.source = 'site'; return; }
      st.siteError = r.error;
      if (!warnedSite) {
        warnedSite = true;
        console.warn('Pure Focus: the CLOUD block in js/config.js isn’t recognised (' + r.error + '). Sync stays off until it is fixed.');
      }
    }
    const dev = readJSON(K.config, null);
    if (dev) {
      const v = R().validateConfig(dev);
      if (v) { st.cfg = v; st.source = 'device'; }
    }
  }
  function config() { return st.cfg ? { ...st.cfg } : null; }
  function isConfigured() { return !!st.cfg; }
  function source() { return st.cfg ? st.source : null; }
  function provider() { return st.cfg ? st.cfg.provider : null; }
  function siteError() { return st.siteError; }
  function isMock() { return !!mockMode(); }

  /* setPaste(text) → {ok, config} | {ok:false, error}. Secret keys are refused and never stored. */
  function setPaste(text) {
    const r = R().parseCloudPaste(text);
    if (!r.ok) return { ok: false, error: r.error };
    if (st.source === 'site') return { ok: false, error: 'site' };
    writeJSON(K.config, r.config);
    restart().catch((err) => console.error('Cloud restart failed', err));
    return { ok: true, config: r.config };
  }
  function clearConfig() {
    if (st.source === 'site') return;
    lsDel(K.config);
    restart().catch((err) => console.error('Cloud restart failed', err));
  }
  function setupCode() { try { return st.cfg && !isMock() ? R().encodeSetupCode(st.cfg) : ''; } catch (_) { return ''; } }
  function functionURL(name) { return st.cfg ? R().functionsBase(st.cfg) + String(name || '') : ''; }
  function projectKey() { return st.cfg ? R().projectKey(st.cfg) : null; }

  // ───────────────────────────── SDK loading (only when configured) ─────────────────────────────
  const loaded = new Map();
  function loadScript(spec) {
    if (loaded.has(spec.src)) return loaded.get(spec.src);
    const p = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = spec.src;
      if (spec.integrity) { s.integrity = spec.integrity; s.crossOrigin = 'anonymous'; }
      s.async = false;
      s.referrerPolicy = 'no-referrer';
      s.onload = () => resolve();
      s.onerror = () => { loaded.delete(spec.src); reject(new CloudError('sdk', 'A sign-in library failed to load')); };
      document.head.appendChild(s);
    });
    loaded.set(spec.src, p);
    return p;
  }
  async function loadSDK() {
    if (isMock()) {
      if (typeof CloudMock === 'undefined') await loadScript({ src: 'js/cloud-mock.js?v=3' });
      return;
    }
    for (const spec of SDK[st.cfg.provider]) await loadScript(spec);
  }

  // ───────────────────────────── HTTP (server clock offset, v2-backend §5.6) ─────────────────────────────
  function httpFetch(url, init) {
    const f = isMock() && typeof CloudMock !== 'undefined' ? CloudMock.fetch : fetch;
    const sent = Date.now();
    return Promise.resolve().then(() => f(url, init)).then((res) => {
      try {
        const d = res.headers && res.headers.get && res.headers.get('date');
        const ms = d ? Date.parse(d) : NaN;
        if (Number.isFinite(ms)) st.offsetMs = R().clockOffset(sent, Date.now(), ms);
      } catch (_) {}
      return res;
    }, (err) => { throw new CloudError('network', (err && err.message) || 'Network error'); });
  }
  const nowMs = () => Date.now() + R().trustedOffset(st.offsetMs || 0);

  // ───────────────────────────── copy (v2-backend §2.1, §3.1) ─────────────────────────────
  const PASTE_COPY = {
    empty: '',
    'secret-key': 'That’s a secret key. Pure Focus only needs the publishable key (Project Settings › API Keys). Delete the secret one from anywhere you pasted it.',
    'missing-url': 'Add your project URL too (it looks like https://abcd….supabase.co).',
    'missing-key': 'Add your publishable key too (it starts with sb_publishable_).',
    'missing-project': 'This Firebase config has no projectId. Copy the whole firebaseConfig block.',
    ambiguous: 'That has both Supabase and Firebase details. Paste just one.',
    'bad-code': 'That setup code is incomplete. Copy it again from your other device.',
    'not-recognized': 'Paste your Supabase URL and publishable key, or your Firebase config.',
    site: 'This site already sets up sync in js/config.js.',
  };
  function pasteCopy(code) { return PASTE_COPY[code] != null ? PASTE_COPY[code] : PASTE_COPY['not-recognized']; }

  function authCopy(err) {
    const code = String((err && (err.code || err.error_code)) || '');
    const msg = String((err && err.message) || '');
    const t = code + ' ' + msg;
    if (/invalid_credentials|INVALID_LOGIN_CREDENTIALS|INVALID_PASSWORD|EMAIL_NOT_FOUND|auth\/(wrong-password|user-not-found|invalid-credential|invalid-login-credentials)|Invalid login credentials/i.test(t)) return 'Email or password is incorrect.';
    if (/email_not_confirmed|Email not confirmed/i.test(t)) return 'Confirm your email first. Check your inbox (and spam).';
    if (/user_already_exists|EMAIL_EXISTS|auth\/email-already-in-use|already registered/i.test(t)) return 'There’s already an account with that email. Sign in instead.';
    if (/over_email_send_rate_limit|over_request_rate_limit|TOO_MANY_ATTEMPTS_TRY_LATER|auth\/too-many-requests/i.test(t)) return 'Too many tries. Wait a few minutes.';
    if (/address not authorized|not authorized/i.test(msg)) return 'This project can only email its owner until custom email is set up. Use Continue with Google instead.';
    if (/auth\/popup-blocked/i.test(code)) return 'Allow pop-ups for this site to sign in with Google.';
    if (/auth\/popup-closed-by-user|auth\/cancelled-popup-request/i.test(code)) return '';
    if (/weak_password|auth\/weak-password|WEAK_PASSWORD/i.test(t)) return 'Use at least 8 characters.';
    if (/auth\/invalid-email|email_address_invalid|validation_failed|invalid email/i.test(t)) return 'Check the email address.';
    if (/recentLogin|requires-recent-login/i.test(t)) return 'Sign in again, then try once more.';
    if (err && (err.status === 0 || code === 'network' || /fetch|network|load failed/i.test(msg))) return 'Can’t reach the sign-in service. Check your connection.';
    return 'That didn’t work. Try again in a moment.';
  }

  function rememberSession() { return lsGet(K.remember()) !== '0'; }
  function setRememberSession(on) { lsSet(K.remember(), on ? '1' : '0'); }

  function normProfile(p) {
    if (!p) return null;
    const pick = (a, b) => (p[a] != null ? p[a] : p[b]);
    return {
      displayName: String(pick('display_name', 'displayName') || 'Focuser').slice(0, 32),
      avatarHue: Math.max(0, Math.min(359, Math.round(Number(pick('avatar_hue', 'avatarHue')) || 0))),
      friendCode: String(pick('friend_code', 'friendCode') || ''),
      lbOptIn: !!pick('lb_opt_in', 'lbOptIn'),
      tz: String(p.tz || 'UTC'),
    };
  }
  function normBoardRow(r) {
    const pick = (a, b) => (r[a] != null ? r[a] : r[b]);
    const lw = pick('last_week_minutes', 'lastWeekMinutes');
    return {
      userId: String(pick('user_id', 'userId')),
      displayName: String(pick('display_name', 'displayName') || 'Friend').slice(0, 32),
      avatarHue: Number(pick('avatar_hue', 'avatarHue')) || 0,
      isMe: !!pick('is_me', 'isMe'),
      minutes: Number(r.minutes) || 0,
      sessions: Number(r.sessions) || 0,
      activeDays: Number(pick('active_days', 'activeDays')) || 0,
      xp: Number(r.xp) || 0,
      lastWeekMinutes: lw == null ? null : Number(lw),
      hiddenFriends: Number(pick('hidden_friends', 'hiddenFriends')) || 0,
    };
  }
  function storeSessions() { try { return Store.sessions() || []; } catch (_) { return []; } }

  // ═════════════════════════════ adapters ═════════════════════════════
  // Interface: init() · currentUser() · onUser(fn) · signInWithGoogle() · signInWithEmail(e,p) · signUp(e,p,name) → {status}
  // · resetPassword(e) · updatePassword(p) · signOut() · idToken() · refresh() → bool · deleteAccount() → bool
  // · pageSize · push(recs) → [{kind,id,status}] · pull(cursorMs, limit) · fetch(keys) · schemaStatus()
  // · ensureProfile(name, tz) · updateProfile(patch) · regenerateCode() · addFriend(code) · removeFriend(uid) · friends()
  // · reportWeek(week, xp, stats, engine, profile) · leaderboard(week) · deleteMyData(onProgress) · ping(name) · serverBoard

  // ───────────── Supabase (supabase-js; the dev mock exposes the same client surface) ─────────────
  function SupabaseAdapter(cfg) {
    let sb = null;
    let userFn = () => {};
    let user = null;
    const storageKey = 'purefocus.cloud.sb.' + cfg.projectRef + ns();
    // "Keep me signed in": localStorage when on (default), else sessionStorage (v2-backend §3.2).
    const storage = {
      getItem(k) { try { const s = sessionStorage.getItem(k); return s != null ? s : localStorage.getItem(k); } catch (_) { return null; } },
      setItem(k, v) {
        try {
          if (rememberSession()) { localStorage.setItem(k, v); sessionStorage.removeItem(k); }
          else { sessionStorage.setItem(k, v); localStorage.removeItem(k); }
        } catch (_) {}
      },
      removeItem(k) { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch (_) {} },
    };

    function mapUser(u) {
      if (!u) return null;
      const md = u.user_metadata || {};
      const g = (u.identities || []).find((i) => i && i.provider === 'google');
      const pic = md.avatar_url || md.picture || null;
      return {
        uid: String(u.id),
        email: u.email || null,
        googleSub: g && g.identity_data && g.identity_data.sub ? String(g.identity_data.sub) : null,
        displayName: md.display_name || md.full_name || md.name || null,
        picture: typeof pic === 'string' && /^https:\/\//i.test(pic) ? pic : null,
      };
    }
    function dataError(res) {
      const e = res && res.error;
      if (!e) return null;
      const status = res.status;
      const code = String(e.code || '');
      const msg = String(e.message || '');
      if (code === 'PGRST202' || code === '42883' || code === '42501' || code === 'PGRST205' || code === '42P01') return new CloudError('setupSQL', msg);
      if (status === 401 || code === 'PGRST301' || code === '28000' || /JWT expired|invalid JWT|not signed in/i.test(msg)) return new CloudError('auth', msg);
      if (!status || status >= 500 || status === 429 || /fetch|network|load failed/i.test(msg)) return new CloudError('network', msg);
      return new CloudError('server', msg, { status });
    }
    async function q(promise) {
      const res = await promise;
      const err = dataError(res);
      if (err) throw err;
      return res.data;
    }
    const rpc = (name, args) => q(sb.rpc(name, args || {}));

    const self = {
      provider: 'supabase',
      pageSize: R().C.PULL_PAGE_SUPABASE,
      serverBoard: true,
      async init() {
        const lib = isMock() ? CloudMock.supabase : (typeof supabase !== 'undefined' ? supabase : null);
        if (!lib || !lib.createClient) throw new CloudError('sdk', 'Supabase library missing');
        sb = lib.createClient(cfg.url, cfg.key, {
          auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey, storage },
          global: { fetch: (u, i) => httpFetch(u, i).catch((e) => { throw new TypeError(e.message); }) },
        });
        sb.auth.onAuthStateChange((event, session) => {
          if (event === 'PASSWORD_RECOVERY') st.recovery = true;
          const next = mapUser(session && session.user);
          const changed = (user && user.uid) !== (next && next.uid);
          user = next;
          if (changed || event === 'PASSWORD_RECOVERY') setTimeout(() => userFn(user, event), 0);
        });
        const { data } = await sb.auth.getSession();
        user = mapUser(data && data.session && data.session.user);
      },
      currentUser() { return user; },
      onUser(fn) { userFn = fn; },
      async signInWithGoogle() {
        try { sessionStorage.setItem(K.returnRoute, location.hash || ''); } catch (_) {}
        const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: returnURL() } });
        if (error) throw error;
        return user;     // the page navigates to Google; a mock signs in at once
      },
      async signInWithEmail(email, password) {
        const { data, error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
        user = mapUser(data && data.user);
        return user;
      },
      async signUp(email, password, name) {
        const { data, error } = await sb.auth.signUp({ email, password, options: { data: { display_name: name || null }, emailRedirectTo: returnURL() } });
        if (error) throw error;
        if (!data || !data.session) return { status: 'confirmEmail' };
        user = mapUser(data.user);
        return { status: 'signedIn' };
      },
      async resetPassword(email) {
        const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: returnURL() });
        if (error) throw error;
      },
      async updatePassword(password) {
        const { error } = await sb.auth.updateUser({ password });
        if (error) throw error;
        st.recovery = false;
      },
      async signOut() { try { await sb.auth.signOut({ scope: 'local' }); } catch (_) {} user = null; },
      async idToken() {
        const { data, error } = await sb.auth.getSession();
        if (error || !data || !data.session) throw new CloudError('auth', 'Signed out');
        return data.session.access_token;
      },
      async refresh() {
        try { const { data, error } = await sb.auth.refreshSession(); return !error && !!(data && data.session); } catch (_) { return false; }
      },
      async deleteAccount() { const ok = await rpc('pf_delete_my_account'); await self.signOut(); return ok === true; },
      async push(records) {
        const rows = await rpc('pf_push', { p_records: records });
        return (rows || []).map((r) => ({ kind: r.kind, id: r.id, status: r.status }));
      },
      async pull(cursorMs, limit) {
        let qb = sb.from('pf_records').select('kind,id,data,updated_at,deleted,device_id,server_updated_at')
          .order('server_updated_at', { ascending: true }).order('kind').order('id').limit(limit);
        if (cursorMs != null) qb = qb.gte('server_updated_at', new Date(cursorMs).toISOString());
        return ((await q(qb)) || []).map(R().sbDecodeRow);
      },
      async fetch(keys) {
        const rows = await rpc('pf_fetch', { p_keys: keys.map((k) => { const [kind, id] = R().splitKey(k); return { kind, id }; }) });
        return (rows || []).map(R().sbDecodeRow);
      },
      /* v2-backend §2.4: POST rpc/pf_schema_version with only the apikey header. */
      async schemaStatus() {
        try {
          const res = await httpFetch(cfg.url + '/rest/v1/rpc/pf_schema_version', {
            method: 'POST', headers: { apikey: cfg.key, 'Content-Type': 'application/json' }, body: '{}' });
          if (res.status === 200) return 'ready';
          if (res.status === 401 || res.status === 403) return 'rejectedKey';
          if (res.status === 404) return 'missingSQL';
          return res.status >= 500 ? 'unreachable' : 'ready';
        } catch (_) { return 'unreachable'; }
      },
      async ensureProfile(name, tz) { return normProfile(((await rpc('pf_ensure_profile', { p_display_name: name, p_tz: tz })) || [])[0]); },
      async updateProfile(p) {
        const rows = await rpc('pf_update_profile', {
          p_display_name: p.displayName != null ? p.displayName : null,
          p_avatar_hue: p.avatarHue != null ? p.avatarHue : null,
          p_lb_opt_in: p.lbOptIn != null ? !!p.lbOptIn : null });
        return normProfile((rows || [])[0]);
      },
      async regenerateCode() { return String(await rpc('pf_regenerate_code')); },
      async addFriend(code) {
        const r = ((await rpc('pf_add_friend', { p_code: code })) || [])[0] || { status: 'no_such_code' };
        return { status: r.status, friend: r.user_id ? { userId: String(r.user_id), displayName: r.display_name, avatarHue: r.avatar_hue } : null };
      },
      async removeFriend(uid) { await rpc('pf_remove_friend', { p_friend: uid }); },
      async friends() {
        return ((await rpc('pf_friends')) || []).map((r) => ({ userId: String(r.user_id), displayName: r.display_name, avatarHue: r.avatar_hue,
          lbOptIn: !!r.lb_opt_in, since: r.since }));
      },
      async reportWeek(week, xp, stats, engine) { await rpc('pf_report_week', { p_week: week, p_xp: Math.max(0, Math.round(xp || 0)), p_engine: engine || 1 }); },
      async leaderboard(week) { return ((await rpc('pf_leaderboard', week ? { p_week: week } : {})) || []).map(normBoardRow); },
      async deleteMyData(onProgress) { if (onProgress) onProgress(0, 1); await rpc('pf_delete_my_data'); if (onProgress) onProgress(1, 1); },
      async ping(name) {
        try {
          const token = await self.idToken();
          const res = await httpFetch(functionURL(name) + '?ping=1', { headers: { Authorization: 'Bearer ' + token, apikey: cfg.key } });
          if (res.status !== 200) return false;
          const j = await res.json().catch(() => null);
          return !!(j && (j.ok === true || j.ai === true));
        } catch (_) { return false; }
      },
      /* Reuses the private supabase client; never exposed directly. */
      async rpc(name, args) { return rpc(name, args || {}); },
      async functionsInvoke(name, body) {
        const { data, error } = await sb.functions.invoke(name, { body });
        return { data, error };
      },
    };
    return self;
  }

  // ───────────── Firebase (compat auth; Firestore over REST, v2-backend §7) ─────────────
  function FirebaseAdapter(cfg) {
    let app = null, auth = null, user = null, userFn = () => {};
    let myProfile = null;
    const P = cfg.projectId;
    const DOCS = 'projects/' + P + '/databases/(default)/documents';
    const API = 'https://firestore.googleapis.com/v1/';
    const BASE = API + DOCS;
    const docName = (path) => DOCS + '/' + path;
    const lib = () => (isMock() ? CloudMock.firebase : (typeof firebase !== 'undefined' ? firebase : null));
    const caps = readJSON(K.caps(), null);
    let serverBoard = !!(caps && caps.projectKey === R().projectKey(cfg) && caps.serverBoard);

    function mapUser(u) {
      if (!u) return null;
      const g = (u.providerData || []).find((p) => p && p.providerId === 'google.com');
      return { uid: String(u.uid), email: u.email || null, googleSub: g && g.uid ? String(g.uid) : null, displayName: u.displayName || null,
        picture: typeof u.photoURL === 'string' && /^https:\/\//i.test(u.photoURL) ? u.photoURL : null };
    }
    async function setPersistence() {
      try { const fb = lib(); await auth.setPersistence(rememberSession() ? fb.auth.Auth.Persistence.LOCAL : fb.auth.Auth.Persistence.SESSION); } catch (_) {}
    }
    async function call(method, url, body) {
      if (!auth || !auth.currentUser) throw new CloudError('auth', 'Signed out');
      let token;
      try { token = await auth.currentUser.getIdToken(); } catch (e) { throw new CloudError(/network/i.test(String(e && e.code)) ? 'network' : 'auth', 'Token refresh failed'); }
      const res = await httpFetch(url, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: body == null ? undefined : JSON.stringify(body) });
      let json = null;
      try { json = await res.json(); } catch (_) { json = null; }
      if (res.status >= 200 && res.status < 300) return json;
      const err = Array.isArray(json) ? (json[0] && json[0].error) : (json && json.error);
      const msg = (err && err.message) || '';
      const statusName = (err && err.status) || '';
      if (res.status === 401) throw new CloudError('auth', msg);
      if (res.status === 403 && /PERMISSION_DENIED/.test(statusName + ' ' + msg)) throw new CloudError('denied', msg, { status: 403 });
      if ((res.status === 404 || res.status === 400) && /database/i.test(msg)) throw new CloudError('database', msg, { status: res.status });
      if (res.status === 404) throw new CloudError('notFound', msg, { status: 404 });
      if (res.status === 400 && /API key not valid/i.test(msg)) throw new CloudError('key', msg, { status: 400 });
      if (res.status >= 500 || res.status === 429) throw new CloudError('network', msg || 'Server busy', { status: res.status });
      throw new CloudError('server', msg, { status: res.status });
    }
    const fv = { s: (v) => ({ stringValue: String(v) }), i: (v) => ({ integerValue: String(Math.round(Number(v) || 0)) }), b: (v) => ({ booleanValue: !!v }) };
    function decodeFields(f) {
      const out = {};
      for (const [k, v] of Object.entries(f || {})) {
        if ('stringValue' in v) out[k] = v.stringValue;
        else if ('integerValue' in v) out[k] = Number(v.integerValue);
        else if ('doubleValue' in v) out[k] = Number(v.doubleValue);
        else if ('booleanValue' in v) out[k] = !!v.booleanValue;
        else if ('timestampValue' in v) out[k] = v.timestampValue;
        else if ('nullValue' in v) out[k] = null;
      }
      return out;
    }
    const reqTime = (path) => ({ fieldPath: path, setToServerValue: 'REQUEST_TIME' });
    async function batchWrite(writes) { const res = await call('POST', BASE + ':batchWrite', { writes }); return (res && res.status) || []; }
    async function getDoc(path) {
      try { const d = await call('GET', API + docName(path)); return d ? decodeFields(d.fields) : null; }
      catch (e) { if (e.code === 'notFound') return null; throw e; }
    }
    async function listDocs(path, pageSize) {
      const out = [];
      let token = '';
      for (let i = 0; i < 50; i++) {
        const r = await call('GET', API + docName(path) + '?pageSize=' + (pageSize || 300) + (token ? '&pageToken=' + encodeURIComponent(token) : ''));
        for (const d of (r && r.documents) || []) out.push({ id: d.name.split('/').pop(), fields: decodeFields(d.fields) });
        token = r && r.nextPageToken;
        if (!token) break;
      }
      return out;
    }
    function profileFields(p) {
      return { displayName: fv.s(p.displayName), avatarHue: fv.i(p.avatarHue), friendCode: fv.s(p.friendCode), lbOptIn: fv.b(p.lbOptIn), tz: fv.s(p.tz) };
    }
    async function loadMine() { if (!myProfile) myProfile = normProfile(await getDoc('users/' + user.uid)); return myProfile; }
    async function createCode(name) {
      for (let i = 0; i < 6; i++) {
        const code = R().friendCodeFromBytes(randomBytes(8));
        const stat = await batchWrite([{ update: { name: docName('codes/' + code), fields: { uid: fv.s(user.uid), displayName: fv.s(name) } },
          updateTransforms: [reqTime('createdAt')], currentDocument: { exists: false } }]);
        if (!stat[0] || !stat[0].code) return code;
      }
      throw new CloudError('server', 'Couldn’t create a friend code');
    }

    const self = {
      provider: 'firebase',
      pageSize: R().C.PULL_PAGE_FIREBASE,
      get serverBoard() { return serverBoard; },
      async init() {
        const fb = lib();
        if (!fb || !fb.initializeApp) throw new CloudError('sdk', 'Firebase library missing');
        const name = 'purefocus' + ns();
        app = (fb.apps || []).find((a) => a && a.name === name) ||
          fb.initializeApp({ apiKey: cfg.apiKey, authDomain: cfg.authDomain, projectId: cfg.projectId, appId: cfg.appId || undefined }, name);
        auth = app.auth();
        await setPersistence();
        await new Promise((resolve) => {
          let first = true;
          auth.onAuthStateChanged((u) => {
            const next = mapUser(u);
            const changed = (user && user.uid) !== (next && next.uid);
            user = next;
            if (first) { first = false; resolve(); return; }
            if (changed) setTimeout(() => userFn(user, 'AUTH'), 0);
          });
        });
      },
      currentUser() { return user; },
      onUser(fn) { userFn = fn; },
      async signInWithGoogle() {
        await setPersistence();
        const cred = await auth.signInWithPopup(new (lib().auth.GoogleAuthProvider)());
        user = mapUser(cred && cred.user);
        return user;
      },
      async signInWithEmail(email, password) { await setPersistence(); const c = await auth.signInWithEmailAndPassword(email, password); user = mapUser(c.user); return user; },
      async signUp(email, password, name) {
        await setPersistence();
        const c = await auth.createUserWithEmailAndPassword(email, password);
        if (name && c.user && c.user.updateProfile) { try { await c.user.updateProfile({ displayName: name }); } catch (_) {} }
        user = mapUser(c.user);
        if (user && name) user.displayName = name;
        return { status: 'signedIn' };
      },
      async resetPassword(email) { await auth.sendPasswordResetEmail(email); },
      async updatePassword(p) { if (auth.currentUser) await auth.currentUser.updatePassword(p); },
      async signOut() { try { await auth.signOut(); } catch (_) {} user = null; myProfile = null; },
      async idToken() { if (!auth || !auth.currentUser) throw new CloudError('auth', 'Signed out'); return auth.currentUser.getIdToken(); },
      async refresh() { try { await auth.currentUser.getIdToken(true); return true; } catch (_) { return false; } },
      async deleteAccount() { if (!auth.currentUser) return false; await auth.currentUser.delete(); user = null; myProfile = null; return true; },
      async push(records) {
        const stats = await batchWrite(records.map((r) => R().fsEncodeWrite(r, P, user.uid)));
        return records.map((r, i) => ({ kind: r.kind, id: r.id, status: R().fsStatus(stats[i]) }));
      },
      async pull(cursorMs, limit) {
        const sq = { from: [{ collectionId: 'records' }], orderBy: [{ field: { fieldPath: 'su' }, direction: 'ASCENDING' }], limit };
        if (cursorMs != null) sq.where = { fieldFilter: { field: { fieldPath: 'su' }, op: 'GREATER_THAN_OR_EQUAL', value: { timestampValue: new Date(cursorMs).toISOString() } } };
        const res = await call('POST', BASE + '/users/' + encodeURIComponent(user.uid) + ':runQuery', { structuredQuery: sq });
        return (res || []).filter((x) => x && x.document).map((x) => R().fsDecodeDoc(x.document));
      },
      async fetch(keys) {
        const res = await call('POST', BASE + ':batchGet', { documents: keys.map((k) => docName('users/' + user.uid + '/records/' + k)) });
        return (res || []).filter((x) => x && x.found).map((x) => R().fsDecodeDoc(x.found));
      },
      /* v2-backend §2.4: after sign-in, GET users/<uid> with the ID token. */
      async schemaStatus() {
        if (!user) return 'ready';
        try { await getDoc('users/' + user.uid); return 'ready'; } catch (e) {
          if (e.code === 'denied') return 'missingRules';
          if (e.code === 'database') return 'missingDatabase';
          if (e.code === 'key') return 'rejectedKey';
          if (e.code === 'network') return 'unreachable';
          return 'ready';
        }
      },
      /* §7.4.1 ensure profile: create codes/{CODE} (precondition: missing), then the profile. */
      async ensureProfile(name, tz) {
        const cur = await getDoc('users/' + user.uid);
        if (cur) {
          myProfile = normProfile(cur);
          if (myProfile.tz !== tz) {
            myProfile.tz = tz;
            await batchWrite([{ update: { name: docName('users/' + user.uid), fields: { tz: fv.s(tz) } }, updateMask: { fieldPaths: ['tz'] },
              updateTransforms: [reqTime('updatedAt')] }]);
          }
          return myProfile;
        }
        const p = { displayName: String(name || 'Focuser').slice(0, 32), avatarHue: 210, friendCode: '', lbOptIn: false, tz };
        p.friendCode = await createCode(p.displayName);
        const stat = await batchWrite([{ update: { name: docName('users/' + user.uid), fields: profileFields(p) },
          updateTransforms: [reqTime('updatedAt'), reqTime('createdAt')], currentDocument: { exists: false } }]);
        if (stat[0] && stat[0].code) { const again = await getDoc('users/' + user.uid); if (again) { myProfile = normProfile(again); return myProfile; } }
        myProfile = p;
        return p;
      },
      async updateProfile(patch) {
        const cur = await loadMine();
        const next = { ...cur };
        const mask = [];
        if (patch.displayName != null && String(patch.displayName).trim()) { next.displayName = String(patch.displayName).trim().slice(0, 32); mask.push('displayName'); }
        if (patch.avatarHue != null) { next.avatarHue = Math.max(0, Math.min(359, Math.round(patch.avatarHue))); mask.push('avatarHue'); }
        if (patch.lbOptIn != null) { next.lbOptIn = !!patch.lbOptIn; mask.push('lbOptIn'); }
        if (mask.length) {
          const all = profileFields(next);
          const fields = {};
          for (const m of mask) fields[m] = all[m];
          await batchWrite([{ update: { name: docName('users/' + user.uid), fields }, updateMask: { fieldPaths: mask }, updateTransforms: [reqTime('updatedAt')] }]);
        }
        myProfile = next;
        return next;
      },
      async regenerateCode() {
        const cur = await loadMine();
        const code = await createCode(cur.displayName);
        await batchWrite([{ update: { name: docName('users/' + user.uid), fields: { friendCode: fv.s(code) } }, updateMask: { fieldPaths: ['friendCode'] },
          updateTransforms: [reqTime('updatedAt')] }]);
        if (cur.friendCode) { try { await batchWrite([{ delete: docName('codes/' + cur.friendCode) }]); } catch (_) {} }
        myProfile = { ...cur, friendCode: code };
        return code;
      },
      /* §7.4.2: get codes/{CODE}, then one batchWrite creating both friend edges (code proof). */
      async addFriend(input) {
        const code = R().normalizeFriendCode(input);
        if (!code) return { status: 'bad_code', friend: null };
        const owner = await getDoc('codes/' + code);
        if (!owner) return { status: 'no_such_code', friend: null };
        if (owner.uid === user.uid) return { status: 'own_code', friend: null };
        const friend = { userId: owner.uid, displayName: owner.displayName, avatarHue: 210 };
        const mine = await listDocs('users/' + user.uid + '/friends', 100);
        if (mine.some((f) => f.id === owner.uid)) return { status: 'already', friend };
        if (mine.length >= R().C.MAX_FRIENDS) return { status: 'too_many_friends', friend: null };
        const me = await loadMine();
        const stat = await batchWrite([
          { update: { name: docName('users/' + user.uid + '/friends/' + owner.uid), fields: { code: fv.s(code), name: fv.s(String(owner.displayName || 'Friend').slice(0, 32)) } },
            updateTransforms: [reqTime('since')], currentDocument: { exists: false } },
          { update: { name: docName('users/' + owner.uid + '/friends/' + user.uid), fields: { code: fv.s(code), name: fv.s(me.displayName) } },
            updateTransforms: [reqTime('since')], currentDocument: { exists: false } }]);
        const failed = stat.filter((s) => s && s.code).length;
        return { status: failed === 2 ? 'already' : 'added', friend };
      },
      async removeFriend(uid) {
        await batchWrite([{ delete: docName('users/' + user.uid + '/friends/' + uid) }, { delete: docName('users/' + uid + '/friends/' + user.uid) }]);
      },
      async friends() {
        return (await listDocs('users/' + user.uid + '/friends', 100)).map((d) => ({ userId: d.id, displayName: d.fields.name || 'Friend', avatarHue: 210,
          lbOptIn: null, since: d.fields.since || null }));
      },
      /* §7.4.5: write users/{me}/weeks/{week} (client-written board), or only weekXP once boardSync runs. */
      async reportWeek(week, xp, stats, engine, profile) {
        const prof = profile || myProfile;
        if (!prof) return;
        if (serverBoard) {
          await batchWrite([{ update: { name: docName('users/' + user.uid + '/weekXP/' + week), fields: { xp: fv.i(Math.max(0, xp || 0)), engine: fv.i(engine || 1) } } }]);
          return;
        }
        const doc = R().firestoreWeekDoc(stats, xp, prof, engine || 1);
        const fields = { week: fv.s(doc.week), minutes: fv.i(doc.minutes), sessions: fv.i(doc.sessions), activeDays: fv.i(doc.activeDays), xp: fv.i(doc.xp),
          optIn: fv.b(doc.optIn), displayName: fv.s(doc.displayName), avatarHue: fv.i(doc.avatarHue), engine: fv.i(doc.engine) };
        const stat = await batchWrite([{ update: { name: docName('users/' + user.uid + '/weeks/' + week), fields }, updateTransforms: [reqTime('su')] }]);
        if (stat[0] && stat[0].code === 7) {
          // PERMISSION_DENIED on our own week doc = the boardSync function is deployed (§8.6): report XP only from now on.
          serverBoard = true;
          writeJSON(K.caps(), { ...(readJSON(K.caps(), {}) || {}), projectKey: R().projectKey(cfg), serverBoard: true });
          await self.reportWeek(week, xp, stats, engine, prof);
        }
      },
      /* §7.4.4: list friends, batchGet their week docs (+ last week), rank locally. */
      async leaderboard(week) {
        const me = await loadMine();
        const lastWeek = R().addDays(week, -7);
        const meDoc = await getDoc('users/' + user.uid + '/weeks/' + week);
        const meLast = await getDoc('users/' + user.uid + '/weeks/' + lastWeek);
        const local = R().weekStats(storeSessions(), week, { nowMs: Date.now() });
        const rows = [normBoardRow({ userId: user.uid, displayName: me.displayName, avatarHue: me.avatarHue, isMe: true,
          minutes: meDoc ? meDoc.minutes : local.minutes, sessions: meDoc ? meDoc.sessions : local.sessions,
          activeDays: meDoc ? meDoc.activeDays : local.activeDays, xp: meDoc ? meDoc.xp : R().boardXP(null, local),
          lastWeekMinutes: meLast ? meLast.minutes : null })];
        const fr = await listDocs('users/' + user.uid + '/friends', 100);
        if (!me.lbOptIn) { rows[0].hiddenFriends = fr.length; return rows; }
        const names = [];
        for (const f of fr) names.push(docName('users/' + f.id + '/weeks/' + week), docName('users/' + f.id + '/weeks/' + lastWeek));
        let got = new Map();
        try {
          const res = names.length ? await call('POST', BASE + ':batchGet', { documents: names }) : [];
          for (const x of res || []) { if (x.found) got.set(x.found.name, { found: x.found }); else if (x.missing) got.set(x.missing, { missing: true }); }
        } catch (e) {
          if (e.code !== 'denied') throw e;
          // A friend who doesn't compete has a doc we may not read: that fails a batchGet as a whole.
          const one = async (n) => {
            try { return [n, { found: await call('GET', API + n) }]; }
            catch (err) { return [n, err.code === 'notFound' ? { missing: true } : { denied: true }]; }
          };
          got = new Map(await Promise.all(names.map(one)));
        }
        let hidden = 0;
        for (const f of fr) {
          const cur = got.get(docName('users/' + f.id + '/weeks/' + week));
          const last = got.get(docName('users/' + f.id + '/weeks/' + lastWeek));
          const d = cur && cur.found ? decodeFields(cur.found.fields) : null;
          if (!cur || cur.denied || (d && d.optIn !== true)) { hidden++; continue; }
          if (!d) continue;      // no doc yet this week: shown once they report
          const l = last && last.found ? decodeFields(last.found.fields) : null;
          rows.push(normBoardRow({ userId: f.id, displayName: d.displayName || f.fields.name, avatarHue: d.avatarHue, isMe: false,
            minutes: d.minutes, sessions: d.sessions, activeDays: d.activeDays, xp: d.xp, lastWeekMinutes: l ? l.minutes : null }));
        }
        for (const r of rows) r.hiddenFriends = hidden;
        return rows;
      },
      /* §7.5: records, weeks, both friend edges, the code, the profile (progress callback). */
      async deleteMyData(onProgress) {
        const recs = [];
        for (let cursor = null, i = 0; i < 1000; i++) {
          const page = await self.pull(cursor, 500);
          for (const r of page) recs.push(r.kind + ':' + r.id);
          if (page.length < 500) break;
          cursor = page[page.length - 1].su;
        }
        const weeks = await listDocs('users/' + user.uid + '/weeks', 300).catch(() => []);
        const fr = await listDocs('users/' + user.uid + '/friends', 100).catch(() => []);
        const keys = Array.from(new Set(recs));
        const total = keys.length + weeks.length + fr.length * 2 + 2;
        let done = 0;
        const del = async (names) => {
          for (let i = 0; i < names.length; i += 500) {
            await batchWrite(names.slice(i, i + 500).map((n) => ({ delete: n })));
            done += Math.min(500, names.length - i);
            if (onProgress) onProgress(done, total);
          }
        };
        await del(keys.map((k) => docName('users/' + user.uid + '/records/' + k)));
        await del(weeks.map((w) => docName('users/' + user.uid + '/weeks/' + w.id)));
        await del(fr.flatMap((f) => [docName('users/' + user.uid + '/friends/' + f.id), docName('users/' + f.id + '/friends/' + user.uid)]));
        let me = null;
        try { me = await loadMine(); } catch (_) { me = null; }
        await del([me && me.friendCode ? docName('codes/' + me.friendCode) : null, docName('users/' + user.uid)].filter(Boolean));
        myProfile = null;
      },
      async ping(name) {
        try {
          const token = await self.idToken();
          const res = await httpFetch(functionURL(name) + '?ping=1', { headers: { Authorization: 'Bearer ' + token } });
          if (res.status !== 200) return false;
          const j = await res.json().catch(() => null);
          return !!(j && (j.ok === true || j.ai === true));
        } catch (_) { return false; }
      },
    };
    return self;
  }

  // ═════════════════════════════ sync engine ═════════════════════════════
  // An async port of CloudRef.syncCycle (v2-backend §5.2): the same steps and ledger calls;
  // remote changes are collected and handed to store.applyCloud once per phase (one persist,
  // one 'remote' event), then settled against what the store holds afterwards.

  function prefs() {
    const p = readJSON(K.prefs(), null);
    return { ...PREFS_DEFAULT, ...(p && typeof p === 'object' ? p : {}) };
  }
  function setPref(k, v) {
    writeJSON(K.prefs(), { ...prefs(), [k]: !!v });
    if (canSync()) schedule(0, false);
  }
  function setSyncLinks(on) { setPref('syncLinks', on); }
  function setSyncInsights(on) { setPref('syncInsights', on); }

  /* cycleCore(L, store, backend, opts) — store: {cloudSnapshot, applyCloud, cloudDedupe};
     backend: async {push, pull, fetch, pageSize}; opts: {supportedKinds, wireOpts, now(), saveLedger(L)}. */
  async function cycleCore(L, store, backend, opts) {
    const C = R().C;
    const supported = opts.supportedKinds;
    const wopts = opts.wireOpts || {};
    const now = opts.now || (() => Date.now());
    const save = opts.saveLedger || (() => {});
    const snapLocal = () => store.cloudSnapshot({ syncLinks: supported.includes('feedLink') }).filter((r) => supported.includes(r.kind));
    const wireSnap = () => snapLocal().map((r) => ({ kind: r.kind, id: r.id, data: R().toWire(r.kind, r.data, wopts) }));
    let localMap = new Map();
    const overlay = new Map();
    const rebuild = () => { localMap = new Map(snapLocal().map((r) => [R().recordKey(r.kind, r.id), r.data])); overlay.clear(); };
    const getLocal = (kind, id) => {
      const k = R().recordKey(kind, id);
      if (overlay.has(k)) return overlay.get(k);
      return localMap.has(k) ? localMap.get(k) : null;
    };
    const changes = [], settle = [];
    function applyOne(r) {
      const local = getLocal(r.kind, r.id);
      const res = R().applyRemote(L, r, local == null ? null : R().toWire(r.kind, local, wopts), now(), { knownFields: null });
      const key = R().recordKey(r.kind, r.id);
      let applied;
      if (res.action === 'upsert') { const d = R().fromWire(r.kind, res.data, local, wopts); overlay.set(key, d); changes.push({ kind: r.kind, id: r.id, data: d }); applied = d; }
      else if (res.action === 'delete') { overlay.set(key, null); changes.push({ kind: r.kind, id: r.id, data: null }); }
      settle.push([r.kind, r.id, applied]);
    }
    /* Hand the collected changes to the store (one persist, one 'remote' event), then record the
       hash of what the store now holds. A setting is settled against the value as received, so a
       value the store clamped differs and the next diff pushes the clamped value back (§4.3). */
    function commit() {
      if (changes.length) store.applyCloud(changes.splice(0));
      rebuild();
      for (const [k, id, applied] of settle.splice(0)) {
        const v = k === 'setting' && applied !== undefined ? applied : getLocal(k, id);
        R().settleApplied(L, k, id, v == null ? null : R().toWire(k, v, wopts));
      }
    }
    async function pullFrom(cursor) {
      const out = []; let c = cursor, maxSu = -Infinity;
      const size = backend.pageSize || 500;
      for (let guard = 0; guard < 10000; guard++) {
        const page = await backend.pull(c, size);
        for (const r of page) { out.push(r); maxSu = Math.max(maxSu, r.su); }
        if (page.length < size) break;
        const lastSu = page[page.length - 1].su;
        if (c != null && lastSu === c) break;
        c = lastSu;
      }
      return { records: out, maxSu };
    }
    function applyAll(records) {
      const seen = new Set();
      for (const r of records) {
        const key = R().recordKey(r.kind, r.id);
        if (seen.has(key + '@' + r.su)) continue; seen.add(key + '@' + r.su);
        if (!supported.includes(r.kind)) continue;
        applyOne(r);
      }
    }

    rebuild();
    let pulled, deletedByRescan = 0;
    if (L.phase === 'initial') {
      pulled = await pullFrom(null);
      const remoteEmpty = pulled.records.length === 0;
      if (!remoteEmpty && store.cloudDedupe) { store.cloudDedupe(pulled.records); rebuild(); }
      R().diffLocal(L, wireSnap(), now(), { newStampMs: remoteEmpty ? C.U_INITIAL_MS : C.U_JOIN_MS, supportedKinds: supported });
      applyAll(pulled.records); commit();
      L.phase = 'normal';
    } else {
      const rescan = R().needsRescan(L, now());
      R().diffLocal(L, wireSnap(), now(), { supportedKinds: supported });
      save(L);
      pulled = await pullFrom(rescan ? null : L.cursorMs);
      applyAll(pulled.records); commit();
      if (rescan) {
        const remoteKeys = new Set(pulled.records.map((r) => R().recordKey(r.kind, r.id)));
        const localKeys = wireSnap().map((r) => R().recordKey(r.kind, r.id));
        const del = R().reconcileFull(L, remoteKeys, localKeys).map((key) => { const [k, id] = R().splitKey(key); return { kind: k, id, data: null }; });
        if (del.length) { store.applyCloud(del); deletedByRescan = del.length; rebuild(); }
      }
    }
    L.lastPullMs = now();
    L.cursorMs = R().nextCursor(L.cursorMs, pulled.maxSu);
    R().pruneLedger(L, now());
    R().diffLocal(L, wireSnap(), now(), { supportedKinds: supported });
    save(L);
    let pushedTotal = 0;
    const pushedKinds = new Set();
    const pushedKeys = [];
    const skip = new Set();
    for (let guard = 0; guard < 1000; guard++) {
      const dataByKey = {};
      for (const r of wireSnap()) dataByKey[R().recordKey(r.kind, r.id)] = r.data;
      const batch = R().outbox(L, dataByKey, C.PUSH_BATCH, C.PUSH_MAX_BYTES, skip);
      if (!batch.length) break;
      const results = await backend.push(batch);
      for (const r of results) {
        if ((r.status || (r.applied ? 'applied' : '')) !== 'applied') continue;
        pushedTotal++; pushedKinds.add(r.kind);
        if (pushedKeys.length < 20) pushedKeys.push(r.kind + ':' + r.id);
      }
      const { refetch } = R().settlePush(L, batch, results);
      if (refetch.length) {
        const got = new Map((await backend.fetch(refetch)).map((r) => [R().recordKey(r.kind, r.id), r]));
        for (const key of refetch) {
          const e = L.entries[key], r = got.get(key);
          if (r && e && R().cmpVersion(r.u, r.dev, e.u, e.w) >= 0) applyOne(r);
          else { R().noteRefusal(L, key, r ? r.u : null, now()); skip.add(key); }
        }
        commit();
      }
      save(L);
    }
    // A record whose id can never be stored (e.g. a "/" in it) was parked, never sent; once it is deleted
    // locally its tombstone means nothing to the server, so it leaves the ledger.
    for (const key of Object.keys(L.entries)) {
      const e = L.entries[key];
      if (e.x && e.p) { const [k, id] = R().splitKey(key); if (R().validateWire(k, id, {}) === 'id') delete L.entries[key]; }
    }
    save(L);                                   // outbox() may have parked records even when nothing was sent
    return { pulled: pulled.records.length, pushed: pushedTotal, pushedKinds: Array.from(pushedKinds), pushedKeys, deletedByRescan,
      pending: R().pendingCount(L), parked: R().parkedCount(L) };
  }

  function supportedKinds() {
    return R().C.KINDS.filter((k) => k !== 'templateList');
  }
  function loadLedger() {
    const want = { provider: st.cfg.provider, project: projectKey(), uid: st.user.uid, deviceID: deviceID() };
    const L = readJSON(K.ledger(), null);
    if (L && L.v === 1 && L.provider === want.provider && L.project === want.project && L.uid === want.uid && L.deviceID === want.deviceID && L.entries) return L;
    return R().newLedger(want);
  }
  function saveLedger(L) {
    if (!lsSet(K.ledger(), JSON.stringify(L))) setStatus({ state: 'attention', attention: 'storage' });
  }

  // ── scheduling (v2-backend §5.8) ──
  let timer = null, dueAt = Infinity, hard = false, firstChangeAt = null;
  let running = false, rerun = false, attempt = 0, authRetried = false, offlineCountTimer = null, lastCycle = null;
  function canSync() {
    return !!(st.cfg && st.adapter && st.user && !['missingSQL', 'missingRules', 'missingDatabase', 'rejectedKey'].includes(st.schema));
  }
  function schedule(delay, debounce) {
    if (!canSync()) return;
    const now = Date.now();
    let at = now + Math.max(0, delay);
    if (debounce) {
      if (firstChangeAt == null) firstChangeAt = now;
      at = Math.min(at, firstChangeAt + MAX_WAIT_MS);
      if (timer && hard) at = Math.min(at, dueAt);
    } else if (timer) at = Math.min(at, dueAt);
    const wasHard = !!(timer && hard);
    if (timer) clearTimeout(timer);
    dueAt = at;
    hard = !debounce || wasHard;
    timer = setTimeout(run, Math.max(0, at - now));
  }
  function stopAll() {
    if (timer) clearTimeout(timer);
    timer = null; dueAt = Infinity; firstChangeAt = null; hard = false;
  }
  async function withLock(fn) {
    const locks = typeof navigator !== 'undefined' && navigator.locks;
    if (!locks || !locks.request) return fn();
    let ran = false, out;
    await locks.request('purefocus.cloud.sync' + ns(), { ifAvailable: true }, async (lock) => { if (!lock) return; ran = true; out = await fn(); });
    return ran ? out : { skipped: true };
  }
  let inflight = null;
  /* One cycle at a time. A trigger during a cycle queues exactly one more cycle after it. */
  function run() {
    timer = null; dueAt = Infinity; hard = false; firstChangeAt = null;
    if (!canSync()) return Promise.resolve();
    if (inflight) { rerun = true; return inflight; }
    inflight = runCycle().finally(() => {
      inflight = null;
      if (rerun) { rerun = false; schedule(0, false); }
    });
    return inflight;
  }
  async function runCycle() {
    running = true;
    if (st.status.state !== 'attention' || st.status.attention !== 'storage') setStatus({ state: 'syncing' });
    try {
      const res = await withLock(() => cycleCore(loadLedger(), Store, st.adapter, {
        supportedKinds: supportedKinds(), wireOpts: { syncInsights: prefs().syncInsights }, now: nowMs, saveLedger }));
      attempt = 0; authRetried = false;
      lastCycle = res && !res.skipped ? { ...res, at: Date.now() } : lastCycle;
      if (res && res.skipped) {
        // Another tab of this browser holds the lock and syncs for us.
        const L = loadLedger();
        setStatus({ state: 'upToDate', lastSyncAt: L.lastPullMs || st.status.lastSyncAt, pending: R().pendingCount(L), parked: R().parkedCount(L) });
      } else {
        st.lastPullMs = Date.now();
        const keepStorage = st.status.state === 'attention' && st.status.attention === 'storage';
        setStatus({ state: keepStorage ? 'attention' : 'upToDate', attention: keepStorage ? 'storage' : null,
          lastSyncAt: Date.now(), pending: res.pending, parked: res.parked });
        if (res.pushedKinds.includes('session')) reportWeeks().catch(() => {});
      }
    } catch (err) {
      handleSyncError(err);
    } finally {
      running = false;
    }
  }
  function handleSyncError(err) {
    const code = err && err.code;
    if (code === 'auth') {
      if (!authRetried) {
        authRetried = true;
        Promise.resolve(st.adapter && st.adapter.refresh()).then((ok) => {
          if (ok) schedule(0, false); else setStatus({ state: 'attention', attention: 'signIn' });
        });
        return;
      }
      setStatus({ state: 'attention', attention: 'signIn' });
      return;
    }
    if (code === 'setupSQL') { st.schema = 'missingSQL'; setStatus({ state: 'attention', attention: 'setupSQL' }); return; }
    if (code === 'denied' && st.cfg && st.cfg.provider === 'firebase') { checkSetup().catch(() => {}); return; }
    if (code === 'database') { st.schema = 'missingDatabase'; setStatus({ state: 'attention', attention: 'database' }); return; }
    if (code === 'key') { st.schema = 'rejectedKey'; setStatus({ state: 'attention', attention: 'key' }); return; }
    // Network, 5xx or anything unexpected: keep the queue and back off (2 s × 2ⁿ, ≤ 5 min, ±20 %).
    setStatus({ state: 'offline', pending: countWaiting() });
    attempt++;
    if (!isNetwork(err)) console.warn('Pure Focus sync: a cycle failed (' + (code || 'error') + '); it will retry.');
    setTimeout(() => schedule(0, false), R().backoffMs(Math.min(attempt, 8), Math.random()));
  }
  /* Records waiting to sync: dirty in the ledger plus local edits not stamped yet. */
  function countWaiting() {
    try {
      const L = loadLedger();
      const wopts = { syncInsights: prefs().syncInsights };
      const kinds = supportedKinds();
      let n = R().pendingCount(L);
      for (const r of Store.cloudSnapshot({ syncLinks: kinds.includes('feedLink') })) {
        if (!kinds.includes(r.kind)) continue;
        const e = L.entries[R().recordKey(r.kind, r.id)];
        if (!e) { n++; continue; }
        if (!e.d && e.h !== R().hashData(R().toWire(r.kind, r.data, wopts))) n++;
      }
      return n;
    } catch (_) { return st.status.pending || 0; }
  }

  let triggersBound = false;
  function bindTriggers() {
    if (triggersBound) return;
    triggersBound = true;
    try {
      Store.on('change', (ev) => {
        if (ev === 'remote' || !canSync()) return;
        if (ev === 'sessions') schedule(SESSION_DELAY_MS, false);
        else schedule(DEBOUNCE_MS, true);
        if (st.status.state === 'offline') {
          clearTimeout(offlineCountTimer);
          offlineCountTimer = setTimeout(() => { if (st.status.state === 'offline') setStatus({ pending: countWaiting() }); }, 600);
        }
      });
    } catch (_) {}
    const wake = () => { if (canSync() && (st.lastPullMs == null || Date.now() - st.lastPullMs > VISIBLE_STALE_MS)) schedule(0, false); };
    try {
      document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });
      window.addEventListener('focus', wake);
      window.addEventListener('pageshow', wake);
      window.addEventListener('online', () => { attempt = 0; if (canSync()) schedule(0, false); });
      setInterval(() => { try { if (!document.hidden && canSync()) schedule(0, false); } catch (_) {} }, TIMER_MS);
    } catch (_) {}
  }

  // ═════════════════════════════ lifecycle ═════════════════════════════
  async function init() {
    if (st.inited) return;
    st.inited = true;
    readConfig();
    bindTriggers();
    if (!st.cfg) { setStatus({ state: 'off' }); return; }
    await start();
  }

  async function start() {
    setStatus({ state: 'connecting' });
    try { await loadSDK(); } catch (_) { setStatus({ state: 'attention', attention: 'unreachable' }); return; }
    try {
      st.adapter = st.cfg.provider === 'firebase' ? FirebaseAdapter(st.cfg) : SupabaseAdapter(st.cfg);
      st.adapter.onUser((u, event) => { onAuthChange(u, event).catch((err) => console.error('Cloud auth change failed', err)); });
      await st.adapter.init();
    } catch (err) {
      console.warn('Pure Focus sync: the sign-in library failed to start.');
      st.adapter = null;
      setStatus({ state: 'attention', attention: 'unreachable' });
      return;
    }
    if (isMock() && CloudMock.onServerChange) CloudMock.onServerChange(() => { if (canSync()) schedule(1200, false); });
    if (st.cfg.provider === 'supabase') {
      const cached = readJSON(K.schema(), null);
      if (cached && cached.projectKey === projectKey() && cached.status === 'ready') st.schema = 'ready';
      else {
        st.schema = await st.adapter.schemaStatus();
        if (st.schema === 'ready') writeJSON(K.schema(), { projectKey: projectKey(), status: 'ready' });
      }
    }
    consumeReturn();
    const u = st.adapter.currentUser();
    if (u) await signedIn(u);
    else afterSignedOut();
    if (st.recovery) openSheet('reset');
  }

  async function restart() {
    stopAll();
    if (st.adapter) { try { await st.adapter.signOut(); } catch (_) {} }
    st.adapter = null; st.user = null; st.schema = null; st.profile = null;
    readConfig();
    emit('user', null);
    if (!st.cfg) { setStatus({ state: 'off', pending: 0, parked: 0, lastSyncAt: null }); return; }
    await start();
  }

  /* The OAuth / email-link return (?code=…) is consumed by supabase-js during init; drop the
     auth params and go back to the route saved before the redirect (v2-backend §9.8). */
  function consumeReturn() {
    try {
      const u = new URL(location.href);
      if (!['code', 'error', 'error_description'].some((k) => u.searchParams.has(k))) return;
      ['code', 'error', 'error_description', 'error_code', 'type'].forEach((k) => u.searchParams.delete(k));
      let route = '';
      try { route = sessionStorage.getItem(K.returnRoute) || ''; sessionStorage.removeItem(K.returnRoute); } catch (_) {}
      history.replaceState(null, '', u.pathname + u.search + (route || u.hash || ''));
      if (route) setTimeout(() => window.dispatchEvent(new HashChangeEvent('hashchange')), 0);
    } catch (_) {}
  }

  async function onAuthChange(u, event) {
    if (event === 'PASSWORD_RECOVERY') openSheet('reset');
    if (u && (!st.user || st.user.uid !== u.uid)) await signedIn(u);
    else if (!u && st.user) { st.user = null; stopAll(); afterSignedOut(); emit('user', null); }
  }

  function afterSignedOut() {
    stopAll();
    if (st.schema === 'missingSQL') setStatus({ state: 'attention', attention: 'setupSQL' });
    else if (st.schema === 'rejectedKey') setStatus({ state: 'attention', attention: 'key' });
    else if (st.schema === 'unreachable') setStatus({ state: 'attention', attention: 'unreachable' });
    else {
      const cur = Profile.current();
      // A profile linked to this project but no session (expired or signed out elsewhere) needs the user.
      const linked = cur && cur.cloud && cur.cloud.projectKey === projectKey();
      setStatus(linked ? { state: 'attention', attention: 'signIn' } : { state: 'needsSignIn' });
    }
  }

  /* §3.3 web: pick the profile for this cloud identity, then the guest rule (E27). */
  function linkProfile(u) {
    const pk = projectKey();
    const cloud = { provider: st.cfg.provider, projectKey: pk, uid: u.uid, email: u.email };
    const cur = Profile.current();
    let sub = null;
    if (cur && cur.cloud && cur.cloud.uid === u.uid) sub = cur.sub;
    if (!sub) { const k = Profile.known().find((p) => p.cloud && p.cloud.uid === u.uid && p.cloud.projectKey === pk); if (k) sub = k.sub; }
    if (!sub && u.googleSub && lsGet(Profile.storeKey(u.googleSub)) != null) sub = u.googleSub;
    if (!sub && cur && !cur.cloud) sub = cur.sub;
    if (!sub) sub = 'cloud.' + String(u.uid).replace(/[^A-Za-z0-9._-]/g, '');
    let ask = false;
    if (!cur) {
      try { Store.flush(); } catch (_) {}      // a debounced save must reach storage before the guest check
      const gs = Profile.guestState(sub);
      if (gs === 'ask' || (gs === 'move' && !Profile.moveGuest(sub))) ask = true;   // too big to copy: let them choose
    }
    const name = u.displayName || (cur && cur.name) || (u.email ? u.email.split('@')[0] : null) || 'You';
    Profile.setCurrent({ sub, email: u.email, name, picture: u.picture || null, cloud });
    if (ask) setTimeout(() => openSheet('merge'), 300);
  }

  async function signedIn(u) {
    st.user = u;
    try { linkProfile(u); } catch (err) { console.error('Cloud: profile link failed', err); }
    emit('user', user());
    if (st.cfg.provider === 'firebase') st.schema = await st.adapter.schemaStatus();
    const map = { missingRules: 'rules', missingDatabase: 'database', rejectedKey: 'key', missingSQL: 'setupSQL' };
    if (map[st.schema]) { setStatus({ state: 'attention', attention: map[st.schema] }); return; }
    st.profile = readJSON(K.profile(), null);
    if (st.profile) emit('profile', profile());
    ensureProfile().catch(() => {});
    schedule(0, false);
  }

  async function ensureProfile() {
    if (!canSync()) return null;
    const cur = Profile.current();
    const full = String((st.user && st.user.displayName) || (cur && cur.cloud ? '' : (cur && cur.name)) || '').trim();
    const first = (full.split(/\s+/)[0] || 'Focuser').slice(0, 32);
    const p = await st.adapter.ensureProfile(first, timeZone());
    if (p) { st.profile = p; writeJSON(K.profile(), p); emit('profile', profile()); }
    return p;
  }

  // ═════════════════════════════ auth API ═════════════════════════════
  function requireAdapter() { if (!st.adapter) throw new CloudError('notConfigured', 'Cloud sync is not set up.'); return st.adapter; }
  function isSignedIn() { return !!st.user; }
  function user() {
    return st.user ? { uid: st.user.uid, email: st.user.email, googleSub: st.user.googleSub, displayName: st.user.displayName, picture: st.user.picture || null } : null;
  }
  async function signInWithGoogle() {
    const u = await requireAdapter().signInWithGoogle();
    if (u) await signedIn(u);
    return user();
  }
  async function signInWithEmail(email, password, opts) {
    const a = requireAdapter();
    if (opts && opts.remember != null) setRememberSession(!!opts.remember);
    const u = await a.signInWithEmail(String(email || '').trim(), String(password || ''));
    if (u) await signedIn(u);
    return user();
  }
  async function signUp(email, password, displayName, opts) {
    const a = requireAdapter();
    if (String(password || '').length < 8) throw new CloudError('weak_password', 'Use at least 8 characters.');
    if (opts && opts.remember != null) setRememberSession(!!opts.remember);
    const r = await a.signUp(String(email || '').trim(), String(password), String(displayName || '').trim().slice(0, 32));
    const u = a.currentUser();
    if (r.status === 'signedIn' && u) await signedIn(u);
    return r;
  }
  async function resetPassword(email) { return requireAdapter().resetPassword(String(email || '').trim()); }
  async function updatePassword(p) {
    if (String(p || '').length < 8) throw new CloudError('weak_password', 'Use at least 8 characters.');
    return requireAdapter().updatePassword(String(p));
  }
  /* Web sign-out (§3.3 rule 4): provider sign-out (local scope), back to the guest profile.
     The ledger stays under its profile key, so signing in again resumes. */
  async function signOut() {
    stopAll();
    if (st.adapter) await st.adapter.signOut();
    st.user = null; st.profile = null;
    Profile.setCurrent(null);
    afterSignedOut();
    emit('user', null);
  }
  async function idToken() { return requireAdapter().idToken(); }

  /* ── plan & Stripe functions ────────────────────────────────────────── */
  async function plan() {
    if (!isSignedIn()) return null;
    try {
      const rows = await st.adapter.rpc('pf_my_plan');
      return Array.isArray(rows) && rows.length ? rows[0] : null;
    } catch (_) { return null; }
  }
  async function invokeFn(name, body) {
    if (name !== 'create-checkout' && name !== 'create-portal') {
      return { data: null, error: new CloudError('unknown_plan', 'Unknown plan function'), code: 'unknown_plan' };
    }
    try {
      const { data, error } = await st.adapter.functionsInvoke(name, body || {});
      if (error) {
        let code = 'unknown';
        try { code = (await error.context.json()).error; } catch (_) {}
        return { data: null, error, code };
      }
      return { data, error: null, code: null };
    } catch (err) {
      let code = 'unknown';
      try { code = (await err.context.json()).error; } catch (_) {}
      return { data: null, error: err, code };
    }
  }

  /* capabilities() → {ai, calendarProxy, serverBoard} from `<fn>?ping=1`, cached 24 h per project.
     No network unless configured and signed in. */
  async function capabilities() {
    const none = { ai: false, calendarProxy: false, serverBoard: false };
    if (!st.cfg || !st.adapter || !st.user) return none;
    const pk = projectKey();
    const cached = readJSON(K.caps(), null);
    // A missing function may be deployed later; retry a negative result after a
    // minute instead of leaving the app without calendar links for a day.
    const ttl = cached && cached.calendarProxy ? CAPS_TTL_MS : CAPS_NEGATIVE_TTL_MS;
    if (cached && cached.projectKey === pk && cached.at && Date.now() - cached.at < ttl) {
      return { ai: !!cached.ai, calendarProxy: !!cached.calendarProxy, serverBoard: !!(cached.serverBoard || st.adapter.serverBoard) };
    }
    const [ai, calendarProxy] = await Promise.all([st.adapter.ping('ai'), st.adapter.ping('calendar-proxy')]);
    const out = { ai, calendarProxy, serverBoard: !!st.adapter.serverBoard };
    writeJSON(K.caps(), { ...(cached && cached.projectKey === pk ? cached : {}), projectKey: pk, at: Date.now(), ...out });
    return out;
  }

  // ═════════════════════════════ sync API ═════════════════════════════
  /* "Sync now": waits for a cycle already in flight, then runs a fresh one. */
  function syncNow() {
    if (!canSync()) return Promise.resolve(null);
    const before = inflight ? inflight.catch(() => {}) : Promise.resolve();
    return before.then(() => {
      if (timer) { clearTimeout(timer); timer = null; dueAt = Infinity; }
      rerun = false;
      return inflight || run();
    }).then(() => (inflight ? inflight : null)).then(() => status());
  }
  function retryParked() {
    if (!canSync()) return Promise.resolve(0);
    const L = loadLedger();
    const n = R().unpark(L);
    saveLedger(L);
    setStatus({ parked: 0 });
    return syncNow().then(() => n);
  }
  /* Which Sync sheet state fits now (v2-backend §9.2): A connect · A2 setup needed · B sign in · C signed in. */
  function setupState() {
    if (!st.cfg) return 'A';
    if (st.status.state === 'attention' && ['setupSQL', 'rules', 'database'].includes(st.status.attention)) return 'A2';
    if (!st.user) return 'B';
    return 'C';
  }
  async function checkSetup() {
    if (!st.adapter) return null;
    lsDel(K.schema());
    st.schema = await st.adapter.schemaStatus();
    const map = { missingSQL: 'setupSQL', missingRules: 'rules', missingDatabase: 'database', rejectedKey: 'key', unreachable: 'unreachable' };
    if (map[st.schema]) setStatus({ state: 'attention', attention: map[st.schema] });
    else {
      if (st.cfg.provider === 'supabase') writeJSON(K.schema(), { projectKey: projectKey(), status: 'ready' });
      if (st.user) { setStatus({ state: 'syncing' }); ensureProfile().catch(() => {}); schedule(0, false); }
      else afterSignedOut();
    }
    return st.schema;
  }
  function counts() {
    try {
      const c = Store.calendar();
      return { sessions: Store.sessions().length, tasks: Store.tasks().length, blocks: Store.blocks().filter((b) => !b.source || b.source === 'local').length,
        calendars: (c.feeds || []).filter((f) => /^(google|icsurl):/i.test(f.id)).length, courses: Store.courses().length };
    } catch (_) { return { sessions: 0, tasks: 0, blocks: 0, calendars: 0, courses: 0 }; }
  }

  /* Disconnect (§9.2 More): stop syncing here. Data stays on this device and in the cloud. */
  async function disconnect() {
    stopAll();
    if (st.adapter) { try { await st.adapter.signOut(); } catch (_) {} }
    lsDel(K.ledger()); lsDel(K.schema());
    const cur = Profile.current();
    if (cur && cur.cloud) Profile.setCurrent({ ...cur, cloud: null });
    if (st.source === 'device') lsDel(K.config);
    st.adapter = null; st.user = null; st.profile = null; st.schema = null;
    readConfig();
    emit('user', null);
    if (st.cfg) await start(); else setStatus({ state: 'off', pending: 0, parked: 0, lastSyncAt: null });
  }

  /* Delete my cloud data (§9.2, P1): erases everything this user owns in the project, then stops
     syncing on this device (otherwise the next cycle would upload it all again). Local data stays
     visible here; signing in again starts a fresh upload, which is then the user's choice. */
  async function deleteCloudData(onProgress) {
    const a = requireAdapter();
    if (!st.user) throw new CloudError('auth', 'Signed out');
    stopAll();
    await a.deleteMyData(onProgress);
    lsDel(K.ledger()); lsDel(K.board()); lsDel(K.profile()); lsDel(K.reported());
    try { await a.signOut(); } catch (_) {}
    const cur = Profile.current();
    if (cur && cur.cloud) Profile.setCurrent({ ...cur, cloud: null });
    st.user = null; st.profile = null;
    setStatus({ state: 'needsSignIn', lastSyncAt: null, pending: 0, parked: 0 });
    emit('user', null); emit('profile', null); emit('board', null);
    return true;
  }
  /* Delete the account too: Supabase pf_delete_my_account (false → remove it in the dashboard);
     Firebase erases the data, then user.delete(). Local data stays on this device. */
  async function deleteAccount(onProgress) {
    const a = requireAdapter();
    stopAll();
    if (st.cfg.provider === 'firebase') await a.deleteMyData(onProgress);
    let removed = false;
    try { removed = await a.deleteAccount(); } catch (err) {
      if (/requires-recent-login/.test(String(err && err.code))) throw new CloudError('recentLogin', 'Sign in again, then delete the account.');
      throw err;
    }
    lsDel(K.ledger()); lsDel(K.board()); lsDel(K.profile()); lsDel(K.reported());
    const cur = Profile.current();
    if (cur && cur.cloud) Profile.setCurrent({ ...cur, cloud: null });
    st.user = null; st.profile = null;
    afterSignedOut();
    emit('user', null); emit('profile', null); emit('board', null);
    return removed;
  }

  // ═════════════════════════════ friends & board (v2-backend §8) ═════════════════════════════
  function profile() { return st.profile ? { ...st.profile } : null; }
  async function updateProfile(patch) {
    const p = await requireAdapter().updateProfile(patch || {});
    if (p) { st.profile = p; writeJSON(K.profile(), p); emit('profile', profile()); }
    if (patch && (patch.lbOptIn != null || patch.displayName != null)) {
      lsDel(K.board()); emit('board', null);
      reportWeeks(true).catch(() => {});
    }
    return profile();
  }
  async function regenerateCode() {
    const code = await requireAdapter().regenerateCode();
    if (st.profile) { st.profile = { ...st.profile, friendCode: code }; writeJSON(K.profile(), st.profile); emit('profile', profile()); }
    return code;
  }
  async function addFriend(code) {
    const norm = R().normalizeFriendCode(code);
    if (!norm) return { status: 'bad_code', friend: null };
    if (st.profile && st.profile.friendCode === norm) return { status: 'own_code', friend: null };
    const r = await requireAdapter().addFriend(norm);
    if (r.status === 'added') { lsDel(K.board()); emit('board', null); }
    return r;
  }
  async function removeFriend(uid) { await requireAdapter().removeFriend(uid); lsDel(K.board()); emit('board', null); }
  async function friends() { if (!st.user || !st.adapter) return []; return st.adapter.friends(); }

  function currentWeek() { return R().mondayKey(R().dayKey(new Date())); }
  function cachedBoard() {
    const c = readJSON(K.board(), null);
    return c && Array.isArray(c.rows) ? c : null;
  }
  /* board(week?, {force}) → rows (stale-while-revalidate: at most once per 5 min). Caches
     {week, fetchedAt, rows, lastWeek:{week, rows}|null}; on Mondays also last week's board. */
  let boardInflight = null;
  async function board(week, opts) {
    const cached = cachedBoard();
    if (!canSync()) return cached ? cached.rows : [];
    const wk = week || currentWeek();
    const force = !!(opts && opts.force);
    if (wk !== currentWeek()) {
      // Another week (See all › Last week): served from the Monday cache when it matches, never cached over this week.
      if (!force && cached && cached.lastWeek && cached.lastWeek.week === wk) return cached.lastWeek.rows;
      return st.adapter.leaderboard(wk);
    }
    if (!force && cached && cached.week === wk && Date.now() - cached.fetchedAt < BOARD_STALE_MS) return cached.rows;
    if (boardInflight) return boardInflight;
    boardInflight = (async () => {
      try {
        const rows = await st.adapter.leaderboard(wk);
        const lw = R().addDays(wk, -7);
        let lastWeek = cached && cached.lastWeek && cached.lastWeek.week === lw ? cached.lastWeek : null;
        if (new Date().getDay() === 1 && !lastWeek && st.profile && st.profile.lbOptIn) {
          try { lastWeek = { week: lw, rows: await st.adapter.leaderboard(lw) }; } catch (_) { lastWeek = null; }
        }
        const out = { week: wk, fetchedAt: Date.now(), rows, lastWeek };
        writeJSON(K.board(), out);
        emit('board', out);
        return rows;
      } finally { boardInflight = null; }
    })();
    return boardInflight;
  }
  function shareLink() {
    const p = st.profile;
    if (!p || !p.friendCode) return '';
    let base = '';
    try { base = location.origin + location.pathname.replace(/[^/]*$/, '') + 'app.html'; } catch (_) {}
    return base + '#friend/' + R().formatFriendCode(p.friendCode);
  }

  /* After a cycle that pushed sessions: report this week's (and until Wednesday last week's)
     engine XP — Supabase pf_report_week, Firestore the week doc. Throttled 60 s, only when changed. */
  async function reportWeeks(force) {
    if (!canSync() || !st.profile) return;
    const rep = readJSON(K.reported(), {}) || {};
    if (!force && rep.at && Date.now() - rep.at < REPORT_THROTTLE_MS) return;
    let eng = null;
    try { eng = typeof Rewards !== 'undefined' && Rewards.state ? Rewards.state() : null; } catch (_) { eng = null; }
    if (!eng || !eng.days) {
      try { eng = Engagement.compute({ sessions: Store.sessions(), tasks: Store.tasks(), now: new Date(), dailyGoalMinutes: Store.settings().dailyGoalMinutes }); } catch (_) { eng = null; }
    }
    const weeks = [currentWeek()];
    const dow = new Date().getDay();
    if (dow >= 1 && dow <= 3) weeks.push(R().addDays(weeks[0], -7));
    const sent = { ...(rep.sent || {}) };
    for (const wk of weeks) {
      const xp = eng ? R().engineWeekXP(eng, wk) : 0;
      const stats = R().weekStats(storeSessions(), wk, { nowMs: Date.now() });
      const sig = [xp, stats.minutes, stats.sessions, st.profile.lbOptIn ? 1 : 0, st.profile.displayName, st.profile.avatarHue].join('|');
      if (!force && sent[wk] === sig) continue;
      await st.adapter.reportWeek(wk, xp, stats, 1, st.profile);
      sent[wk] = sig;
    }
    for (const k of Object.keys(sent)) if (k < R().addDays(weeks[0], -14)) delete sent[k];
    writeJSON(K.reported(), { at: Date.now(), sent });
  }

  function openSheet(state) {
    try { if (typeof CloudUI !== 'undefined' && CloudUI.openSheet) CloudUI.openSheet(state); } catch (err) { console.error(err); }
  }

  return {
    init,
    config, isConfigured, source, setPaste, clearConfig, setupCode, provider, siteError, pasteCopy, isMock,
    isSignedIn, user, signInWithGoogle, signInWithEmail, signUp, resetPassword, updatePassword, signOut, idToken, plan, invokeFn, functionURL, capabilities,
    status, syncNow, retryParked, setSyncLinks, setSyncInsights, prefs, deleteCloudData, deleteAccount, disconnect,
    on,
    profile, updateProfile, regenerateCode, addFriend, removeFriend, friends, board, cachedBoard, shareLink, currentWeek,
    openSheet, setupState, checkSetup, counts, authCopy, rememberSession, setRememberSession,
    _engine: { cycleCore, CloudError },
    _debug: () => ({ lastCycle, schema: st.schema, canSync: canSync(), ledgerKey: st.user ? K.ledger() : null }),
  };
})();
