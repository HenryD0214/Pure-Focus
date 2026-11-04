/* ═══════════════════════════════════════════════════════════════════════
   v2-guard-blocker-rules-reference.js — guard-list normalisation, matching and
   declarativeNetRequest rule building (BLOCKER_RULES_VERSION 1).
   Pure; runs in jsc. Copy verbatim to:
     WEB/extension/pure-focus-blocker/rules.js   (extension; also `export`-free global)
     WEB/js/guard-rules.js                        (web Settings: normalise + validate input)
   Mac ports normaliseEntry/matches to Core/GuardRules.swift (same vectors).
   Normative text: v2-guard.md §2.3 and §5.3.
   ═══════════════════════════════════════════════════════════════════════ */

const GuardRules = (() => {
  const ID = Object.freeze({ DOMAINS: 1000, URL_FIRST: 1001, URL_LAST: 1999, ESCAPE_FIRST: 5000, ESCAPE_LAST: 5099, MIN_MANAGED: 1000 });
  const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
  const SEP_RE = /[A-Za-z0-9_\-.%]/;            // NOT a separator in DNR `^` terms
  // Never block these (the product itself and the OS shell). Domains that need a warning instead:
  const SCHOOL_HINTS = ['instructure.com', 'myschoolapp.com', 'blackbaud.com', 'docs.google.com', 'drive.google.com',
    'classroom.google.com', 'zoom.us'];

  /* Accepts "YouTube.com", "https://www.reddit.com/r/all?x=1", "m.tiktok.com/", "x.com/home".
     Returns {kind:'domain'|'url', value, key} or null. Hosts must already be ASCII (platforms punycode first). */
  function normaliseEntry(input) {
    let s = String(input == null ? '' : input).trim();
    if (!s || s.length > 2048) return null;
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');         // scheme
    s = s.replace(/^[^/@]*@/, '');                            // userinfo
    const cut = s.search(/[?#]/); if (cut >= 0) s = s.slice(0, cut);
    const slash = s.indexOf('/');
    let host = (slash >= 0 ? s.slice(0, slash) : s).toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
    let path = slash >= 0 ? s.slice(slash) : '';
    if (host.startsWith('www.')) host = host.slice(4);
    if (!HOST_RE.test(host)) return null;
    path = path.replace(/\/+$/, '');
    if (!path) return { kind: 'domain', value: host, key: 'domain:' + host };
    if (!/^\/[\x21-\x7e]*$/.test(path)) return null;          // ASCII, no spaces (percent-encode first)
    return { kind: 'url', value: host + path, key: 'url:' + host + path };
  }

  function hostOf(url) {
    const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]*@)?([^/:?#]+)(?::\d+)?([^?#]*)/i.exec(String(url || ''));
    if (!m) return null;
    let host = m[1].toLowerCase().replace(/\.$/, '');
    return { host, path: m[2] || '/' };
  }

  /* First matching entry or null. Domain entries match the host and its subdomains (like DNR requestDomains);
     url entries match host-or-subdomain + path prefix ending at a separator (like DNR "||host/path^"). */
  function matches(url, entries) {
    const u = hostOf(url);
    if (!u || !/^https?:/i.test(String(url))) return null;
    for (const e of entries || []) {
      if (e.kind === 'domain') {
        if (u.host === e.value || u.host.endsWith('.' + e.value)) return e;
      } else if (e.kind === 'url') {
        const i = e.value.indexOf('/'), h = e.value.slice(0, i), p = e.value.slice(i);
        if (!(u.host === h || u.host.endsWith('.' + h))) continue;
        if (!u.path.startsWith(p)) continue;
        const next = u.path.charAt(p.length);
        if (p.endsWith('/') || next === '' || !SEP_RE.test(next)) return e;
      }
    }
    return null;
  }

  function schoolHint(entry) {
    if (!entry) return false;
    const host = entry.kind === 'domain' ? entry.value : entry.value.slice(0, entry.value.indexOf('/'));
    return SCHOOL_HINTS.some((d) => host === d || host.endsWith('.' + d) || d.endsWith('.' + host));
  }

  /* entries: normalised list (block === true items only). escapes: {domain: untilMs}. Returns DNR rules sorted by id.
     Only main_frame is blocked, so lectures embedded in Canvas/Blackbaud pages keep working. */
  function buildRules(entries, escapes, nowMs) {
    const rules = [];
    const domains = [...new Set((entries || []).filter((e) => e.kind === 'domain').map((e) => e.value))].sort();
    if (domains.length) rules.push({ id: ID.DOMAINS, priority: 1, action: { type: 'block' },
      condition: { requestDomains: domains, resourceTypes: ['main_frame'] } });
    const urls = [...new Set((entries || []).filter((e) => e.kind === 'url').map((e) => e.value))].sort()
      .slice(0, ID.URL_LAST - ID.URL_FIRST + 1);
    urls.forEach((v, i) => rules.push({ id: ID.URL_FIRST + i, priority: 1, action: { type: 'block' },
      condition: { urlFilter: '||' + v + (v.endsWith('/') ? '' : '^'), resourceTypes: ['main_frame'] } }));
    const live = Object.keys(escapes || {}).filter((d) => escapes[d] > nowMs).sort().slice(0, ID.ESCAPE_LAST - ID.ESCAPE_FIRST + 1);
    live.forEach((d, i) => rules.push({ id: ID.ESCAPE_FIRST + i, priority: 2, action: { type: 'allow' },
      condition: { requestDomains: [d], resourceTypes: ['main_frame'] } }));
    return rules;
  }

  /* Minimal update: ids to remove + rules to add, given the currently installed dynamic rules. */
  function diffRules(installed, desired) {
    const cur = new Map((installed || []).filter((r) => r.id >= ID.MIN_MANAGED).map((r) => [r.id, JSON.stringify(r)]));
    const want = new Map(desired.map((r) => [r.id, JSON.stringify(r)]));
    const removeRuleIds = [], addRules = [];
    for (const [id, js] of cur) if (want.get(id) !== js) removeRuleIds.push(id);
    for (const r of desired) if (cur.get(r.id) !== want.get(r.id)) addRules.push(r);
    return { removeRuleIds: removeRuleIds.sort((a, b) => a - b), addRules };
  }

  /* Merge sources ({web:{focusing,endsAt,list}, mac:{…}}) → {active, endsAt, entries}. Fail-open: a source counts
     only while focusing && endsAt > now. */
  function merge(sources, nowMs) {
    let active = false, endsAt = 0; const seen = new Map();
    for (const k of Object.keys(sources || {}).sort()) {
      const s = sources[k];
      if (!s || !s.focusing || !(Date.parse(s.endsAt) > nowMs)) continue;
      active = true; endsAt = Math.max(endsAt, Date.parse(s.endsAt));
      for (const raw of s.list || []) {
        const e = typeof raw === 'string' ? normaliseEntry(raw) : raw && normaliseEntry(raw.kind === 'url' || raw.kind === 'domain' ? raw.value : '');
        if (e && !seen.has(e.key)) seen.set(e.key, e);
      }
    }
    return { active, endsAt: active ? new Date(endsAt).toISOString() : null,
      entries: [...seen.values()].sort((a, b) => (a.key < b.key ? -1 : 1)) };
  }

  return { ID, SCHOOL_HINTS, normaliseEntry, hostOf, matches, schoolHint, buildRules, diffRules, merge };
})();
