/* Pure Focus Blocker — service worker (Manifest V3 module; v2-guard §5.3).
   Blocks the user's own list only while a Pure Focus session runs (web app via bridge.js,
   Mac app via its local status server). Fail-open: no live source → every managed rule removed.
   Stores only the list, the clock and per-session counts — never browsing history. */
import { GuardRules } from './rules.js';

const R = GuardRules;
const MAC_PORTS = [47615, 47616, 47617, 47618, 47619];
const PASS_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const BLOCK_PAGE = chrome.runtime.getURL('blocked.html');

// ── state (chrome.storage.local "pf"), updated one change at a time ──
function fresh() {
  return { v: 1, sources: {}, escapes: {}, passesUsed: {}, stats: {}, origins: [], macPort: null, macFails: 0, wasActive: false, webTabs: [], front: null };
}
async function load() {
  const o = await chrome.storage.local.get('pf');
  const st = Object.assign(fresh(), o && o.pf && o.pf.v === 1 ? o.pf : {});
  return st;
}
let chain = Promise.resolve();
function update(fn) {
  const run = chain.then(async () => {
    const st = await load();
    const out = await fn(st);
    await chrome.storage.local.set({ pf: st });
    return out;
  });
  chain = run.catch(() => {});
  return run;
}

const sessionKey = (name, src) => name + ':' + (src && src.runID ? src.runID : 'run');
function liveSources(st, now) {
  return Object.keys(st.sources).filter((k) => { const s = st.sources[k]; return s && s.focusing && Date.parse(s.endsAt) > now; });
}
function passesLeft(st, now) {
  let left = 0;
  for (const k of liveSources(st, now)) {
    const s = st.sources[k];
    left = Math.max(left, Math.max(0, (Number(s.passes) || 0) - (st.passesUsed[sessionKey(k, s)] || 0)));
  }
  return left;
}
function bump(st, now, field, n) {
  for (const k of liveSources(st, now)) {
    const key = sessionKey(k, st.sources[k]);
    const o = st.stats[key] || (st.stats[key] = { hits: 0, escapes: 0, at: now });
    o[field] = (o[field] || 0) + (n || 1);
    o.at = now;
  }
}
function prune(st, now) {
  for (const k of Object.keys(st.stats)) if (now - (st.stats[k].at || 0) > DAY_MS) delete st.stats[k];
  const live = new Set(liveSources(st, now).map((k) => sessionKey(k, st.sources[k])));
  for (const k of Object.keys(st.passesUsed)) if (!st.stats[k] && !live.has(k)) delete st.passesUsed[k];
  for (const d of Object.keys(st.escapes)) if (!(st.escapes[d] > now)) delete st.escapes[d];
}
function hostKey(entry) { return entry.kind === 'domain' ? entry.value : entry.value.slice(0, entry.value.indexOf('/')); }
function blockURL(entry, url) {
  return BLOCK_PAGE + '#' + encodeURIComponent(JSON.stringify({ d: hostKey(entry), u: url, k: entry.key }));
}

// ── the network guarantee + tab sweep ──
async function apply(st) {
  const now = Date.now();
  prune(st, now);
  const m = R.merge(st.sources, now);
  const desired = m.active ? R.buildRules(m.entries, st.escapes, now) : [];
  const installed = await chrome.declarativeNetRequest.getDynamicRules();
  const diff = R.diffRules(installed, desired);
  if (!m.active) {   // fail-open cleanup: every managed id goes
    diff.removeRuleIds = installed.filter((r) => r.id >= R.ID.MIN_MANAGED).map((r) => r.id);
    diff.addRules = [];
  }
  if (diff.removeRuleIds.length || diff.addRules.length) await chrome.declarativeNetRequest.updateDynamicRules(diff);
  const becameActive = m.active && !st.wasActive;
  st.wasActive = m.active;
  st.merged = m;
  if (m.active) chrome.alarms.create('pf-end', { when: Date.parse(m.endsAt) + 60000 });
  else chrome.alarms.clear('pf-end');
  if (becameActive) await sweep(st, m.entries);
  return m;
}
async function sweep(st, entries) {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (!t.url || t.audible || t.url.startsWith(BLOCK_PAGE)) continue;
    const e = R.matches(t.url, entries);
    if (!e || st.escapes[hostKey(e)] > Date.now()) continue;
    try { await chrome.tabs.update(t.id, { url: blockURL(e, t.url) }); bump(st, Date.now(), 'hits'); } catch (_) {}
  }
}

// ── friendly page on navigation (DNR is the guarantee; this shows a kind page instead of an error) ──
async function onNav(details) {
  if (details.frameId !== 0 || !/^https?:/i.test(details.url)) return;
  await update(async (st) => {
    const m = R.merge(st.sources, Date.now());
    if (!m.active) return;
    const e = R.matches(details.url, m.entries);
    if (!e || st.escapes[hostKey(e)] > Date.now()) return;
    try { await chrome.tabs.update(details.tabId, { url: blockURL(e, details.url) }); bump(st, Date.now(), 'hits'); } catch (_) {}
  });
  broadcast();
}
chrome.webNavigation.onBeforeNavigate.addListener((d) => { onNav(d); });
chrome.webNavigation.onHistoryStateUpdated.addListener((d) => { onNav(d); });
chrome.webNavigation.onErrorOccurred.addListener((d) => { if (d.error === 'net::ERR_BLOCKED_BY_CLIENT') onNav(d); });

// ── the web app: state + front-tab key (feeds Focus Guard's "on a listed site") ──
async function stateMsg(st) {
  const now = Date.now();
  const web = st.sources.web;
  const stats = web ? st.stats[sessionKey('web', web)] || {} : {};
  const m = R.merge(st.sources, now);
  return { type: 'state', active: m.active, sources: liveSources(st, now), endsAt: m.endsAt,
    runID: web ? web.runID || null : null, hits: stats.hits || 0, escapes: stats.escapes || 0,
    passesUsed: web ? st.passesUsed[sessionKey('web', web)] || 0 : 0 };
}
async function broadcast() {
  const st = await load();
  const msg = await stateMsg(st);
  for (const id of st.webTabs) chrome.tabs.sendMessage(id, { to: 'app', msg }).catch(() => {});
}
async function reportFront() {
  const st = await load();
  const web = st.sources.web;
  if (!web || !web.focusing || !st.webTabs.length) return;
  let key = null;
  try {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const m = R.merge(st.sources, Date.now());
    const e = t && t.url ? R.matches(t.url, m.entries) : null;
    key = e ? e.key : null;
  } catch (_) {}
  if (key === st.front) return;
  await update((s) => { s.front = key; });
  for (const id of st.webTabs) chrome.tabs.sendMessage(id, { to: 'app', msg: { type: 'front', key } }).catch(() => {});
}
chrome.tabs.onActivated.addListener(() => { reportFront(); });
chrome.windows.onFocusChanged.addListener(() => { reportFront(); });
chrome.webNavigation.onCommitted.addListener((d) => { if (d.frameId === 0) reportFront(); });

// ── the Mac app (poll its local status server; fail open after 2 misses) ──
async function fetchStatus(port) {
  const r = await fetch('http://127.0.0.1:' + port + '/v1/status', { cache: 'no-store', signal: AbortSignal.timeout(800) });
  if (!r.ok) throw new Error('status ' + r.status);
  return r.json();
}
async function pollMac() {
  const st = await load();
  const order = st.macPort ? [st.macPort] : [];
  if (!st.macPort || st.macFails >= 2) for (const p of MAC_PORTS) if (!order.includes(p)) order.push(p);
  let got = null, port = null;
  for (const p of order) { try { got = await fetchStatus(p); port = p; break; } catch (_) {} }
  await update(async (s) => {
    if (got) {
      s.macPort = port; s.macFails = 0;
      s.sources.mac = { focusing: !!got.focusing, endsAt: got.endsAt || null, runID: got.runID || null, list: Array.isArray(got.list) ? got.list.slice(0, 500) : [],
        passes: Number(got.passes) || 0, port, at: new Date().toISOString() };
    } else {
      s.macFails = (s.macFails || 0) + 1;
      if (s.macFails >= 2 && s.sources.mac) { s.sources.mac.focusing = false; s.sources.mac.at = new Date().toISOString(); }
    }
    await apply(s);
  });
  broadcast();
}

// ── messages: bridge (web app), block page, popup ──
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  (async () => {
    if (!m || typeof m !== 'object') return null;
    if (m.from === 'bridge' && sender.tab && m.msg) {
      const d = m.msg;
      const tabId = sender.tab.id;
      await update(async (st) => {
        if (!st.webTabs.includes(tabId)) st.webTabs = st.webTabs.concat(tabId).slice(-8);
        if (d.origin && !st.origins.includes(d.origin)) st.origins = st.origins.concat(d.origin).slice(-8);
        if (d.type === 'focus') {
          st.sources.web = { focusing: true, endsAt: d.endsAt, runID: d.runID, list: d.list || [], passes: d.passes, theme: d.theme || {},
            origin: d.origin, at: new Date().toISOString() };
        } else if (d.type === 'stop') {
          if (st.sources.web) { st.sources.web.focusing = false; st.sources.web.at = new Date().toISOString(); }
        }
        await apply(st);
      });
      const st = await load();
      if (d.type !== 'hello') broadcast();
      return stateMsg(st);
    }
    if (m.from === 'blocked') {
      if (m.type === 'info') {
        const st = await load();
        const now = Date.now();
        const live = liveSources(st, now);
        const theme = (st.sources.web && st.sources.web.focusing && st.sources.web.theme) || {};
        return { active: R.merge(st.sources, now).active, endsAt: R.merge(st.sources, now).endsAt, passesLeft: passesLeft(st, now),
          macOnly: live.length === 1 && live[0] === 'mac', theme };
      }
      if (m.type === 'pass' && typeof m.d === 'string') {
        const ok = await update(async (st) => {
          const now = Date.now();
          if (passesLeft(st, now) <= 0) return false;
          for (const k of liveSources(st, now)) { const key = sessionKey(k, st.sources[k]); st.passesUsed[key] = (st.passesUsed[key] || 0) + 1; }
          st.escapes[m.d.slice(0, 253)] = now + PASS_MS;
          bump(st, now, 'escapes');
          chrome.alarms.create('pf-pass-' + m.d.slice(0, 200), { when: now + PASS_MS + 500 });
          await apply(st);
          return true;
        });
        broadcast();
        return { ok };
      }
      if (m.type === 'close' && sender.tab) { try { await chrome.tabs.remove(sender.tab.id); } catch (_) {} return { ok: true }; }
    }
    if (m.from === 'popup') {
      if (m.type === 'poll') await pollMac();
      const st = await load();
      const now = Date.now();
      const merged = R.merge(st.sources, now);
      return { active: merged.active, endsAt: merged.endsAt, entries: merged.entries, passesLeft: passesLeft(st, now),
        mac: st.sources.mac ? { found: st.macFails < 2 && !!st.macPort, port: st.macPort } : { found: false },
        web: st.sources.web ? { origin: st.sources.web.origin || null, seen: true } : { seen: st.origins.length > 0, origin: st.origins[st.origins.length - 1] || null } };
    }
    return null;
  })().then(reply, () => reply(null));
  return true;   // async reply
});

chrome.tabs.onRemoved.addListener((id) => { update((st) => { st.webTabs = st.webTabs.filter((x) => x !== id); }); });

// ── lifecycle: re-apply on every wake (fail-open after a crash or a closed tab) ──
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'pf-poll') pollMac();
  else update((st) => apply(st)).then(broadcast);
});
function boot() {
  chrome.alarms.create('pf-poll', { periodInMinutes: 0.5 });
  update((st) => apply(st)).then(broadcast).catch(() => {});
}
chrome.runtime.onStartup.addListener(boot);
chrome.runtime.onInstalled.addListener(boot);
boot();
