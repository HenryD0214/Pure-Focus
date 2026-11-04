/* ═══════════════════════════════════════════════════════════════════════
   profile.js — per-user storage keys (SPEC §1.2.8, SPEC-V2 E27, v2-backend §3.3)
   Owner: W1. Loaded after config.js/themes.js and BEFORE store.js.

   Public API (final):
     Profile.key(base)      → storage key for the current profile:
                              guest → base;  signed in → base + '.u.' + sub
     Profile.dataKey()      → Profile.key('purefocus.v1') (the Store's data key)
     Profile.current()      → {sub, email, name, picture, signedInAt, cloud} | null (guest)
     Profile.on('change', fn) → unsubscribe; fn(current) after the profile switches
     Profile.setCurrent(p)  → switch profile (null = guest); persists it in `purefocus.auth`
                              and returns true when the profile changed. The guest-move rule
                              (E27) is applied by the caller (Cloud) through guestState() /
                              moveGuest() / guestRaw() / clearGuest() around the switch.
   Extra helpers (W1-internal, used by cloud.js / store.js):
     Profile.known()        → [{sub, email, name, cloud, guest}] profiles this browser has used
     Profile.storeKey(sub)  → the data key of profile `sub` (null = guest)
     Profile.guestState(sub)→ 'none' (no guest data) | 'move' (target store empty) | 'ask' (both have data)
                              | 'kept' (the user already answered for this profile)
     Profile.moveGuest(sub) → moves every per-profile key of the guest into `sub` (target empty)
     Profile.guestRaw()     → {store, ack} raw JSON strings of the guest (for a merge)
     Profile.clearGuest()   → removes the guest's per-profile keys (after a merge)
     Profile.rememberGuestChoice(sub, choice)  'merged' | 'separate'
     Profile.ns()           → '' or '.dev-<id>' (dev mock only: ?cloudMock=1&device=b gives this
                              tab its own device namespace, so two tabs act as two devices)
     Profile.isMock()       → true when the page runs with ?cloudMock=…
   Global helper: pfKey(base) === Profile.key(base).

   Every localStorage access is wrapped in try/catch (private mode, quota).
   ═══════════════════════════════════════════════════════════════════════ */

const Profile = (() => {
  'use strict';

  // ── dev mock namespace (never active without ?cloudMock=…) ──
  let MOCK = '';
  let NS = '';
  try {
    const q = new URLSearchParams((typeof location !== 'undefined' && location.search) || '');
    MOCK = (q.get('cloudMock') || '').replace(/[^a-z0-9]/gi, '').slice(0, 16);
    const dev = MOCK ? (q.get('device') || '').replace(/[^a-z0-9]/gi, '').slice(0, 12).toLowerCase() : '';
    NS = dev ? '.dev-' + dev : '';
  } catch (_) { MOCK = ''; NS = ''; }

  const AUTH_KEY = 'purefocus.auth' + NS;
  const KNOWN_KEY = 'purefocus.profiles' + NS;
  // Per-profile keys (base names) that move with the guest's data. The ledger, board and cloud
  // prefs belong to a signed-in profile only, so they never move.
  const MOVABLE = ['purefocus.v1', 'purefocus.ack', 'purefocus.calcache.v1', 'purefocus.assignments.v1',
    'purefocus.feedurls.v1', 'purefocus.aiusage.v1', 'purefocus.ai.key'];

  const listeners = new Set();

  function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (_) { return false; } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (_) {} }
  function readJSON(k, dflt) { try { const r = lsGet(k); return r == null ? dflt : JSON.parse(r); } catch (_) { return dflt; } }

  function cleanSub(sub) {
    return String(sub || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 128);
  }
  const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max || 200) : null);

  function cleanCloud(c) {
    if (!c || typeof c !== 'object') return null;
    const provider = c.provider === 'supabase' || c.provider === 'firebase' ? c.provider : null;
    const uid = str(c.uid, 128);
    if (!provider || !uid) return null;
    return { provider, projectKey: str(c.projectKey, 120), uid, email: str(c.email, 200) };
  }

  function cleanProfile(p) {
    if (!p || typeof p !== 'object') return null;
    const sub = cleanSub(p.sub);
    if (!sub) return null;
    const picture = str(p.picture, 1000);
    return {
      sub,
      email: str(p.email, 200),
      name: str(p.name, 80) || str(p.email, 200) || 'You',
      picture: picture && /^https:\/\//i.test(picture) ? picture : null,
      signedInAt: str(p.signedInAt, 40) || new Date().toISOString(),
      cloud: cleanCloud(p.cloud),
    };
  }

  let current = cleanProfile(readJSON(AUTH_KEY, null));

  function keyFor(base, sub) {
    const s = cleanSub(sub);
    return String(base || '') + NS + (s ? '.u.' + s : '');
  }
  function key(base) { return keyFor(base, current && current.sub); }
  function dataKey() { return key('purefocus.v1'); }
  function storeKey(sub) { return keyFor('purefocus.v1', sub); }

  function getCurrent() { return current ? { ...current, cloud: current.cloud ? { ...current.cloud } : null } : null; }

  function on(event, fn) {
    if (event !== 'change' || typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function emitChange() {
    for (const fn of Array.from(listeners)) {
      try { fn(getCurrent()); } catch (err) { console.error('Profile listener failed', err); }
    }
  }

  // ── known profiles (this browser) ──
  function known() {
    const list = readJSON(KNOWN_KEY, []);
    return Array.isArray(list) ? list.filter((x) => x && typeof x.sub === 'string') : [];
  }
  function remember(p, patch) {
    const all = known();
    const prev = all.find((x) => x.sub === p.sub) || {};
    const list = all.filter((x) => x.sub !== p.sub);
    list.unshift({ ...prev, sub: p.sub, email: p.email, name: p.name, cloud: p.cloud, ...(patch || {}) });
    lsSet(KNOWN_KEY, JSON.stringify(list.slice(0, 20)));
  }
  function rememberGuestChoice(sub, choice) {
    const p = known().find((x) => x.sub === cleanSub(sub));
    if (p) remember(p, { guest: choice === 'merged' ? 'merged' : 'separate' });
  }

  /* setCurrent(p) — p = {sub, email, name, picture, cloud} or null (guest). Persists the
     choice in `purefocus.auth` and tells listeners (Store reloads from the new dataKey()).
     Returns true when the active profile changed. */
  function setCurrent(p) {
    const next = p == null ? null : cleanProfile(p);
    if (p != null && !next) return false;
    const changed = (current ? current.sub : null) !== (next ? next.sub : null);
    current = next;
    if (next) { lsSet(AUTH_KEY, JSON.stringify(next)); remember(next); } else lsDel(AUTH_KEY);
    if (changed) emitChange();
    return changed;
  }

  // ── guest data (E27 / v2-backend §3.3) ──
  function storeHasData(raw) {
    if (!raw) return false;
    try {
      const d = JSON.parse(raw);
      if (!d || typeof d !== 'object') return false;
      const n = (a) => (Array.isArray(a) ? a.length : 0);
      return n(d.tasks) + n(d.sessions) + n(d.blocks) + n(d.courses) > 0;
    } catch (_) { return false; }
  }
  function guestState(sub) {
    if (!storeHasData(lsGet(storeKey(null)))) return 'none';
    if (!storeHasData(lsGet(storeKey(sub)))) return 'move';
    const p = known().find((x) => x.sub === cleanSub(sub));
    return p && p.guest ? 'kept' : 'ask';
  }
  /* Moves the guest's per-profile keys into `sub`: the store always (the target store is
     empty when this runs), other keys only where the target has none yet. */
  function moveGuest(sub) {
    const s = cleanSub(sub);
    if (!s) return false;
    for (const base of MOVABLE) {
      const from = keyFor(base, null), to = keyFor(base, s);
      const v = lsGet(from);
      if (v == null) continue;
      if ((base === 'purefocus.v1' || lsGet(to) == null) && !lsSet(to, v)) return false;
      lsDel(from);
    }
    return true;
  }
  function guestRaw() { return { store: lsGet(keyFor('purefocus.v1', null)), ack: lsGet(keyFor('purefocus.ack', null)) }; }
  function clearGuest() { for (const base of MOVABLE) lsDel(keyFor(base, null)); }

  return {
    key, dataKey, current: getCurrent, on, setCurrent,
    known, storeKey, guestState, moveGuest, guestRaw, clearGuest, rememberGuestChoice,
    ns: () => NS, isMock: () => !!MOCK, mockMode: () => MOCK,
    _emitChange: emitChange,
  };
})();

const pfKey = Profile.key;
