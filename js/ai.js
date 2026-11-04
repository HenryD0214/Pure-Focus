/* ═══════════════════════════════════════════════════════════════════════
   ai.js — the Study coach's Claude client, the usage ledger, ingestion of
   syllabi / photos / text, and the Study coach card (owner: W3)

   v2-ai §3, §9.2, §10.1, §12 with SPEC-V2 E26. The user's own Anthropic key talks
   to api.anthropic.com straight from this browser through the official SDK
   (@anthropic-ai/sdk 0.131.0, imported lazily on first use; it sends
   anthropic-dangerous-direct-browser-access). The key lives in memory; it is
   written to localStorage[pfKey('purefocus.ai.key')] only with "Remember on this
   device". It is never logged, never sent anywhere else and never synced.

   Requests: model from the contract (best = claude-opus-5-5 default, economy =
   claude-haiku-5-5), the contract prompt as a cached system block, structured
   outputs (output_config.format json_schema) with effort medium (ingest) /
   high (plan), streaming → finalMessage(), no thinking / sampling params / prefill,
   and fallbacks: "default" + anthropic-beta server-side-fallback-2026-07-01 for
   Opus only. stop_reason is checked before the content is read.

   const AI = { setKey(key, remember) · removeKey() · hasKey() · remembered() · maskedKey()
                testKey(key) → Promise<{ok, best?, why?}>
                run(op: 'ingest'|'plan', content, {onProgress}) → Promise<{data, usage, model, stopReason}>
                cancel() · loadContract() → Promise<contract> · PDFJS_URL · SDK_URL
                ingestFlow(input, ui) (Course sheet) · renderCard(el, opts) (Settings card)
                Ingest: {mapCourse, validate, merge, estimate, buildContent, plainText} (pure; jsc-tested) }
   class AIError { code }   codes: noKey busy budget refusal truncated cancelled badKey spendCap rateLimited
                            badRequest upstream offline badJSON unavailable;  AIError.from(e, sdk)
   const Usage = { get() → {month, usd, calls, input, output, cacheRead, cacheWrite} · add(model, usage) · overBudget()
                   costOf(model, usage) · budget() }
   ═══════════════════════════════════════════════════════════════════════ */

class AIError extends Error {
  constructor(code, message) {
    super(message || AIError.MESSAGES[code] || code);
    this.name = 'AIError';
    this.code = code;
  }
  /* Most specific first (v2-ai §10.1). Never includes request content or the key. */
  static from(e, sdk) {
    if (e instanceof AIError) return e;
    const is = (name) => !!(sdk && typeof sdk[name] === 'function' && e instanceof sdk[name]);
    if (is('APIUserAbortError') || (e && e.name === 'AbortError')) return new AIError('cancelled');
    if (is('AuthenticationError')) return new AIError('badKey');
    if (is('PermissionDeniedError')) return new AIError('badKey', 'This key can’t use this model. Try Economy, or check the key’s workspace.');
    if (is('RateLimitError')) {
      const code = e && e.error && e.error.error && e.error.error.details && e.error.error.details.error_code;
      return new AIError(code === 'enforced_spend_limit_reached' ? 'spendCap' : 'rateLimited');
    }
    if (is('BadRequestError')) {
      const msg = String((e && e.error && e.error.error && e.error.error.message) || (e && e.message) || '');
      if (/specified API usage limits/i.test(msg)) return new AIError('spendCap');
      console.warn('Study coach: the request was rejected (400)');   // logged without content
      return new AIError('badRequest');
    }
    if (is('APIConnectionError')) return new AIError('offline');   // before APIError: a subclass in the TS SDK
    if (is('APIError') && Number(e.status) >= 500) return new AIError('upstream');
    if (is('APIError')) return new AIError('upstream');
    if (e instanceof SyntaxError) return new AIError('badJSON');
    return new AIError('upstream');
  }
}
AIError.MESSAGES = {
  noKey: 'Add your Anthropic key in Settings › Calendar & Accounts › Study coach.',
  busy: 'The coach is already working on something.',
  budget: 'Coach paused · budget reached. The basic planner keeps working.',
  refusal: 'Claude couldn’t read these files. Try Economy or enter the course by hand.',
  truncated: 'That was too long to read in one go. Try fewer pages.',
  cancelled: 'Stopped.',
  badKey: 'That key was rejected.',
  spendCap: 'Your Anthropic spend limit was reached. Raise it in the Anthropic Console — the basic planner keeps working.',
  rateLimited: 'Anthropic is busy right now. Try again in a minute.',
  badRequest: 'Claude couldn’t accept this request.',
  upstream: 'Claude had a problem. Try again in a minute.',
  offline: 'You’re offline · basic plan only.',
  badJSON: 'Claude’s answer couldn’t be read. Try again.',
  unavailable: 'The Study coach isn’t available.',
};

/* ── usage ledger (v2-ai §12.3) ── */
const Usage = (() => {
  'use strict';
  // contract.pricing (verified 2026-10-21); replaced by the loaded contract's table.
  let PRICING = {
    'claude-opus-5-5': { in: 4.0, cacheWrite: 5.0, cacheRead: 0.2, out: 20.0 },
    'claude-haiku-5-5': { in: 0.1, cacheWrite: 0.125, cacheRead: 0.01, out: 0.5, longAbove: 100000, longIn: 0.5, longCacheWrite: 0.625, longCacheRead: 0.05, longOut: 2.5 },
  };
  const KEY = 'purefocus.aiusage.v1';
  const k = () => (typeof pfKey === 'function' ? pfKey(KEY) : KEY);
  function month() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
  function fresh() { return { month: month(), usd: 0, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, warned: false }; }
  function read() {
    try {
      const o = JSON.parse(localStorage.getItem(k()) || 'null');
      if (o && o.month === month()) return { ...fresh(), ...o };
    } catch (_) { /* private mode */ }
    return fresh();
  }
  function write(o) { try { localStorage.setItem(k(), JSON.stringify(o)); } catch (_) {} }
  function get() { const o = read(); return { month: o.month, usd: o.usd, calls: o.calls, input: o.input, output: o.output, cacheRead: o.cacheRead, cacheWrite: o.cacheWrite }; }
  function budget() {
    try { const b = Number(Store.settings().coachMonthlyBudgetUSD); return b >= 1 ? Math.min(50, b) : 5; } catch (_) { return 5; }
  }
  function setPricing(p) { if (p && typeof p === 'object') PRICING = p; }
  /* usd = (input × in + cacheWrite × write + cacheRead × read + output × out) / 1e6; Haiku's long row above 100k. */
  function costOf(model, u) {
    const p = PRICING[model] || PRICING['claude-opus-5-5'];
    const input = Number(u && u.input_tokens) || 0, output = Number(u && u.output_tokens) || 0;
    const cr = Number(u && u.cache_read_input_tokens) || 0, cw = Number(u && u.cache_creation_input_tokens) || 0;
    const long = p.longAbove && input + cr + cw > p.longAbove;
    return (input * (long ? p.longIn : p.in) + cw * (long ? p.longCacheWrite : p.cacheWrite) + cr * (long ? p.longCacheRead : p.cacheRead) +
      output * (long ? p.longOut : p.out)) / 1e6;
  }
  function add(model, u) {
    const o = read();
    o.usd += costOf(model, u);
    o.calls += 1;
    o.input += Number(u && u.input_tokens) || 0;
    o.output += Number(u && u.output_tokens) || 0;
    o.cacheRead += Number(u && u.cache_read_input_tokens) || 0;
    o.cacheWrite += Number(u && u.cache_creation_input_tokens) || 0;
    const b = budget();
    if (!o.warned && o.usd >= 0.8 * b) {
      o.warned = true;
      try { App.toast(`You’ve used $${o.usd.toFixed(2)} of your $${b} coach budget this month.`); } catch (_) {}
    }
    write(o);
    try { Store.emit('aiusage'); } catch (_) {}
    return get();
  }
  function overBudget() { return read().usd >= budget(); }
  function reset() { write(fresh()); }
  return { get, add, overBudget, costOf, budget, setPricing, pricing: () => PRICING, reset };
})();

const AI = (() => {
  'use strict';
  const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.131.0/+esm';        // MIT; pinned (v2-ai §14)
  const PDFJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/6.4.299/pdf.min.mjs';  // Apache-2.0; page count / text only
  const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/6.4.299/pdf.worker.min.mjs';
  const CONTRACT_URL = 'assets/ai/ai-contract.json?v=2';
  const CONTRACT_HASH = '5e268957';
  const KEY_STORE = 'purefocus.ai.key';
  const WARN_STORE = 'purefocus.ai.rememberOK';
  let contract = null, contractHash = null, sdk = null, client = null, clientKey = null, memKey = null, inflight = null, pdfjs = null;

  const keyName = () => (typeof pfKey === 'function' ? pfKey(KEY_STORE) : KEY_STORE);
  function fnvBytes(bytes) {
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0; }
    return (h >>> 0).toString(16).padStart(8, '0');
  }
  function utf8(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
    const bin = unescape(encodeURIComponent(s));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // ───────────────────────── contract ─────────────────────────
  async function loadContract() {
    if (contract) return contract;
    const res = await fetch(CONTRACT_URL);
    if (!res.ok) throw new AIError('unavailable');
    const text = await res.text();
    contractHash = fnvBytes(utf8(text));
    if (contractHash !== CONTRACT_HASH) console.warn('Study coach: ai-contract.json does not match the shipped contract');
    contract = JSON.parse(text);
    Usage.setPricing(contract.pricing);
    return contract;
  }

  // ───────────────────────── key (memory first; v2-ai §9.2) ─────────────────────────
  function storedKey() { try { return localStorage.getItem(keyName()); } catch (_) { return null; } }
  function apiKey() { return memKey || storedKey(); }
  function setKey(key, remember) {
    memKey = key ? String(key).trim() : null;
    try {
      if (remember && memKey) localStorage.setItem(keyName(), memKey);
      else localStorage.removeItem(keyName());
    } catch (_) {}
    client = null; clientKey = null;
  }
  function removeKey() { setKey(null, false); }
  function hasKey() { return !!apiKey(); }
  function remembered() { return !!storedKey(); }
  function maskedKey() { const k = apiKey(); return k ? `${k.slice(0, 7)}…${k.slice(-4)}` : ''; }

  // ───────────────────────── SDK (lazy) ─────────────────────────
  async function loadSDK() {
    if (!sdk) {
      try { sdk = await import(SDK_URL); } catch (_) { throw new AIError('offline'); }
    }
    return sdk;
  }
  async function anthropic() {
    const key = apiKey();
    if (!key) throw new AIError('noKey');
    const s = await loadSDK();
    if (!client || clientKey !== key) { client = new s.Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 2 }); clientKey = key; }
    return client;
  }
  /* Models API (no token cost): 200 → works; 401 → rejected; 403/404 on Opus → try Haiku (v2-ai §9.1). */
  async function testKey(key) {
    const k = String(key || apiKey() || '').trim();
    if (!k) return { ok: false, why: 'noKey' };
    let s;
    try { s = await loadSDK(); } catch (_) { return { ok: false, why: 'network' }; }
    const c = new s.Anthropic({ apiKey: k, dangerouslyAllowBrowser: true, maxRetries: 0 });
    const ct = await loadContract().catch(() => null);
    const best = ct ? ct.models.best : 'claude-opus-5-5', economy = ct ? ct.models.economy : 'claude-haiku-5-5';
    try { await c.models.retrieve(best); return { ok: true, best: true }; } catch (e) {
      if (s.AuthenticationError && e instanceof s.AuthenticationError) return { ok: false, why: 'rejected' };
      if ((s.PermissionDeniedError && e instanceof s.PermissionDeniedError) || (s.NotFoundError && e instanceof s.NotFoundError)) {
        try { await c.models.retrieve(economy); return { ok: true, best: false }; } catch (_) { return { ok: false, why: 'noModels' }; }
      }
      return { ok: false, why: 'network' };
    }
  }

  // ───────────────────────── one request (v2-ai §3.2, §6.2, E26) ─────────────────────────
  function buildParams(ct, op, tier, content) {
    const model = ct.models[tier] || ct.models.best;
    const params = {
      model, max_tokens: ct.maxTokens[op],
      system: [{ type: 'text', text: ct.prompts[op], cache_control: { type: 'ephemeral' } }],
      output_config: { effort: ct.effort[op], format: { type: 'json_schema', schema: ct.schemas[op] } },
      messages: [{ role: 'user', content }],
    };
    return { model, params, opus: model === ct.models.best };
  }
  async function run(op, content, { onProgress, tier: forceTier } = {}) {
    if (inflight) throw new AIError('busy');                       // one request at a time
    if (!apiKey()) throw new AIError('noKey');
    if (Usage.overBudget()) throw new AIError('budget');
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new AIError('offline');
    const ctl = new AbortController();
    inflight = ctl;
    let s = null;
    try {
      const ct = await loadContract();
      const tier = forceTier || (Store.settings().coachTier === 'economy' ? 'economy' : 'best');
      const c = await anthropic();
      s = sdk;
      const { model, params, opus } = buildParams(ct, op, tier, content);
      const stream = opus
        ? c.beta.messages.stream({ ...params, betas: [ct.fallbackBeta], fallbacks: 'default' }, { signal: ctl.signal })
        : c.messages.stream(params, { signal: ctl.signal });
      if (onProgress) stream.on('text', (_delta, snapshot) => { try { onProgress(String(snapshot || '').length); } catch (_) {} });
      const msg = await stream.finalMessage();
      Usage.add(msg.model || model, msg.usage);
      if (msg.stop_reason === 'refusal') throw new AIError('refusal');
      if (msg.stop_reason === 'max_tokens') throw new AIError('truncated');
      const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      return { data: JSON.parse(text), usage: msg.usage, model: msg.model || model, stopReason: msg.stop_reason };
    } catch (e) {
      throw AIError.from(e, s || sdk);
    } finally {
      inflight = null;
    }
  }
  function cancel() { if (inflight) inflight.abort(); }
  function busy() { return !!inflight; }

  // ───────────────────────── ingestion: pure parts (v2-ai §3.3–§3.5; jsc-tested) ─────────────────────────
  const Ingest = (() => {
    const TYPES = ['exam', 'quiz', 'assignment', 'paper', 'project', 'lab', 'reading', 'presentation', 'participation', 'other'];
    const KINDS = ['lecture', 'lab', 'section', 'seminar', 'other'];
    const DAY = /^\d{4}-\d{2}-\d{2}$/;
    /* SPEC §1.1 external text: strip tags, decode the five entities, trim, clamp. */
    function plainText(s, max) {
      const t = String(s == null ? '' : s).replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
      const a = Array.from(t);
      return a.length > max ? a.slice(0, max).join('') : t;
    }
    const hm = (s) => { const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s || '')); return m ? +m[1] * 60 + +m[2] : null; };
    function realDay(s) {
      if (!DAY.test(String(s || ''))) return null;
      const [y, m, d] = s.split('-').map(Number);
      const dt = new Date(y, m - 1, d);
      return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? s : null;
    }
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const alnum = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const uidOf = (uid) => (typeof uid === 'function' ? uid() : Math.random().toString(36).slice(2));

    /* §3.3 step 3: one raw course from the ingest schema → a Course (new ids; not stored). */
    function mapCourse(raw, { uid, source = 'syllabus' } = {}) {
      const r = raw || {};
      const meetings = (Array.isArray(r.meetingTimes) ? r.meetingTimes : []).map((m) => ({
        weekday: Number.isInteger(m && m.weekday) && m.weekday >= 0 && m.weekday <= 6 ? m.weekday : null,
        start: hm(m && m.start), end: hm(m && m.end), location: plainText(m && m.location, 60), kind: KINDS.includes(m && m.kind) ? m.kind : 'lecture',
      })).filter((m) => m.weekday !== null && m.start !== null && m.end !== null && m.end > m.start).slice(0, 12);
      const assessments = (Array.isArray(r.assessments) ? r.assessments : []).map((a) => {
        const steps = (Array.isArray(a && a.steps) ? a.steps : []).slice(0, 6).map((s) => {
          let unlock = Math.max(-60, Math.min(0, Math.trunc(Number(s && s.unlockOffsetDays) || 0)));
          const doBy = Math.max(-60, Math.min(0, Math.trunc(Number(s && s.doByOffsetDays) || 0)));
          if (unlock < 0 && unlock > doBy) unlock = 0;   // an unlock after the do-by day is dropped (§3.4)
          return { title: plainText(s && s.title, 40), estHours: Number(s && s.estHours) > 0 ? Math.min(80, Number(s.estHours)) : 0,
            unlockOffsetDays: unlock, doByOffsetDays: doBy };
        }).filter((s) => s.title);
        const w = Number(a && a.weightPercent);
        const est = Number(a && a.estHours);
        return {
          id: uidOf(uid), title: plainText(a && a.title, 120), type: TYPES.includes(a && a.type) ? a.type : 'other',
          due: (a && a.due) || null, dueTime: hm(a && a.dueTime),
          weightPercent: Number.isFinite(w) && w >= 0 && w <= 100 ? w : null,
          estHours: Number.isFinite(est) && est >= 0.25 && est <= 80 ? est : null,
          topics: (Array.isArray(a && a.topics) ? a.topics : []).map((t) => plainText(t, 60)).filter(Boolean).slice(0, 8),
          prep: plainText(a && a.prep, 300), steps, confidence: ['high', 'medium', 'low'].includes(a && a.confidence) ? a.confidence : 'medium',
          evidence: plainText(a && a.evidence, 200), source, externalID: null, taskIDs: [], status: 'upcoming', editedAt: null,
        };
      }).filter((a) => a.title).slice(0, 80);
      const now = new Date().toISOString();
      return {
        id: uidOf(uid), name: plainText(r.name, 80), code: plainText(r.code, 24), term: plainText(r.term, 40), instructor: plainText(r.instructor, 80),
        colorHex: null, termStart: realDay(r.termStart), termEnd: realDay(r.termEnd), meetingTimes: meetings, meetingsBlockTime: true, assessments,
        workload: { hoursPerWeek: Number(r.workloadHoursPerWeek) > 0 ? Math.min(80, Number(r.workloadHoursPerWeek)) : 0, text: plainText(r.workloadText, 300) },
        strategy: { summary: plainText(r.strategySummary, 600), tips: (Array.isArray(r.strategyTips) ? r.strategyTips : []).map((t) => plainText(t, 140)).filter(Boolean).slice(0, 6),
          examPrepDays: Number.isInteger(r.examPrepDays) && r.examPrepDays > 0 ? Math.min(30, r.examPrepDays) : 0, readBeforeClass: r.readBeforeClass === true },
        courseKeys: [], sources: [], archived: false, createdAt: now, updatedAt: now,
      };
    }

    /* §3.4: ranges the schema can't express. Returns {course, weightSum, weightWarning}. */
    function validate(c) {
      const lo = c.termStart ? CalCore.addDays(c.termStart, -14) : null;
      const hi = c.termEnd ? CalCore.addDays(c.termEnd, 30) : null;
      for (const a of c.assessments) {
        if (a.due) {
          const real = realDay(a.due);
          if (!real) { a.due = null; a.confidence = 'low'; }
          else if ((lo && a.due < lo) || (hi && a.due > hi)) a.confidence = 'low';
        }
      }
      const seen = new Map();
      c.assessments = c.assessments.filter((a) => {
        const k = norm(a.title) + '|' + (a.due || '');
        if (seen.has(k)) {
          const prev = seen.get(k);
          for (const f of ['dueTime', 'weightPercent', 'estHours']) if (prev[f] == null && a[f] != null) prev[f] = a[f];
          if (!prev.steps.length && a.steps.length) prev.steps = a.steps;
          return false;
        }
        seen.set(k, a);
        return true;
      });
      const weightSum = c.assessments.reduce((t, a) => t + (a.weightPercent > 0 ? a.weightPercent : 0), 0);
      return { course: c, weightSum, weightWarning: weightSum > 110 ? `Weights add up to ${Math.round(weightSum)} %; check them` : null };
    }

    /* §3.5: merge an incoming course into an existing one. Returns {course, added, changed:[{title, from, to}], kept}. */
    function merge(existing, incoming, { replaceStrategy = false } = {}) {
      const base = existing ? JSON.parse(JSON.stringify(existing)) : null;
      if (!base || (!base.name && !(base.assessments || []).length)) {
        const out = { ...incoming };
        if (base) { out.id = base.id; out.colorHex = base.colorHex || null; out.courseKeys = base.courseKeys || []; out.createdAt = base.createdAt || out.createdAt;
          out.sources = (base.sources || []).concat(incoming.sources || []); if (!out.code && base.code) out.code = base.code; if (!out.name && base.name) out.name = base.name; }
        return { course: out, added: out.assessments.length, changed: [], kept: 0 };
      }
      const c = base;
      if (!c.name) c.name = incoming.name;
      if (!c.code) c.code = incoming.code;
      for (const f of ['term', 'instructor', 'termStart', 'termEnd']) if (!c[f] && incoming[f]) c[f] = incoming[f];
      const key = (m) => `${m.weekday}|${m.start}|${m.end}`;
      const have = new Set((c.meetingTimes || []).map(key));
      for (const m of incoming.meetingTimes || []) if (!have.has(key(m)) && c.meetingTimes.length < 12) { c.meetingTimes.push(m); have.add(key(m)); }
      if (replaceStrategy || !(c.strategy && c.strategy.summary)) c.strategy = { ...incoming.strategy };
      if (replaceStrategy || !(c.workload && (c.workload.hoursPerWeek || c.workload.text))) c.workload = { ...incoming.workload };
      let added = 0, kept = 0;
      const changed = [];
      for (const a of incoming.assessments) {
        const nt = norm(a.title);
        let m = c.assessments.find((x) => norm(x.title) === nt && (x.due || '') === (a.due || ''));
        if (!m) m = c.assessments.find((x) => norm(x.title) === nt && (!x.due || !a.due));
        if (!m) m = c.assessments.find((x) => norm(x.title) === nt);
        if (!m) { c.assessments.push(a); added++; continue; }
        if (m.editedAt) { kept++; continue; }
        for (const f of ['dueTime', 'weightPercent', 'estHours']) if (m[f] == null && a[f] != null) m[f] = a[f];
        for (const f of ['prep', 'evidence']) if (!m[f] && a[f]) m[f] = a[f];
        if (!(m.topics || []).length && a.topics.length) m.topics = a.topics;
        if (!(m.steps || []).length && a.steps.length) m.steps = a.steps;
        if (a.due && m.due && a.due !== m.due) { changed.push({ title: m.title, from: m.due, to: a.due }); m.due = a.due; }
        else if (!m.due && a.due) m.due = a.due;
        if (a.confidence !== 'high') m.confidence = a.confidence;
        kept++;
      }
      c.sources = (c.sources || []).concat(incoming.sources || []).slice(-30);
      return { course: c, added, changed, kept };
    }

    /* §3.1 cost estimate: tokens ≈ Σ pdfPages × 3,900 + Σ images ⌈w/28⌉·⌈h/28⌉ + textChars / 4 + 1,200; output ≈ 6,000. */
    function estimate(items) {
      let input = 1200, pages = 0;
      for (const it of items) {
        if (it.kind === 'pdf') { input += (it.pages || 1) * 3900; pages += it.pages || 1; }
        else if (it.kind === 'image') input += Math.ceil((it.w || 2000) / 28) * Math.ceil((it.h || 1500) / 28);
        else input += Math.ceil((it.chars || 0) / 4);
      }
      const out = 6000;
      const usd = (model) => Usage.costOf(model, { input_tokens: input, output_tokens: out });
      return { input, output: out, pages, best: usd('claude-opus-5-5'), economy: usd('claude-haiku-5-5') };
    }

    /* §3.2 user content: each document labelled before it, then the context JSON. */
    function buildContent(items, ctx) {
      const content = [];
      let d = 0, im = 0;
      for (const it of items) {
        if (it.kind === 'image') {
          content.push({ type: 'text', text: `Image ${++im}: ${it.name} (photo)` });
          content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: it.data } });
        } else if (it.kind === 'pdf') {
          content.push({ type: 'text', text: `Document ${++d}: ${it.name} (${it.pages} ${it.pages === 1 ? 'page' : 'pages'})` });
          content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: it.data } });
        } else {
          content.push({ type: 'text', text: `Document ${++d}: ${it.name}` });
          content.push({ type: 'document', source: { type: 'text', media_type: 'text/plain', data: it.text } });
        }
      }
      content.push({ type: 'text', text: 'Context:\n' + JSON.stringify(ctx) });
      return content;
    }
    return { mapCourse, validate, merge, estimate, buildContent, plainText, realDay };
  })();

  // ───────────────────────── ingestion: local preparation (v2-ai §3.1) ─────────────────────────
  const MAX_FILES = 10, MAX_BLOCKS = 20, MAX_PDF_PAGES = 100, MAX_RAW = 20 * 1024 * 1024, PDF_NATIVE = 30, MAX_TEXT = 60000;
  async function loadPdfjs() {
    if (!pdfjs) {
      try {
        pdfjs = await import(PDFJS_URL);
        if (pdfjs.GlobalWorkerOptions) pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      } catch (_) { throw new AIError('offline', 'Couldn’t load the PDF reader. Check your connection.'); }
    }
    return pdfjs;
  }
  function b64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  async function readBytes(file) { return new Uint8Array(await file.arrayBuffer()); }
  async function prepPdf(file, bytes) {
    const lib = await loadPdfjs();
    let doc;
    try { doc = await lib.getDocument({ data: bytes.slice() }).promise; } catch (e) {
      if (e && (e.name === 'PasswordException' || /password/i.test(e.message || ''))) throw new AIError('badRequest', 'Password-protected PDFs can’t be read.');
      throw new AIError('badRequest', `Couldn’t open ${file.name}.`);
    }
    const pages = doc.numPages || 1;
    if (pages <= PDF_NATIVE) return { kind: 'pdf', name: file.name, pages, bytes: bytes.length, data: b64(bytes) };
    const parts = [];
    let chars = 0;
    for (let n = 1; n <= pages; n++) {
      const page = await doc.getPage(n);
      const tc = await page.getTextContent();
      const t = (tc.items || []).map((x) => x.str || '').join(' ');
      chars += t.length;
      parts.push(`\n\n[Page ${n}]\n` + t);
    }
    if (chars / pages < 200) throw new AIError('badRequest', 'This PDF is long and scanned. Upload the schedule pages as photos or a shorter PDF.');
    const text = parts.join('').slice(0, MAX_TEXT * 4);
    return { kind: 'pdftext', name: file.name, pages, bytes: bytes.length, text, chars: text.length };
  }
  async function prepImage(file) {
    const heic = /hei[cf]$/i.test(file.type || '') || /\.(heic|heif)$/i.test(file.name || '');
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (_) {
      throw new AIError('badRequest', heic ? 'This browser can’t open HEIC. Export as JPEG or use the Mac app.' : `Couldn’t open ${file.name}.`);
    }
    const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
    if (!blob) throw new AIError('badRequest', `Couldn’t prepare ${file.name}.`);
    const out = new Uint8Array(await blob.arrayBuffer());
    return { kind: 'image', name: file.name, w, h, bytes: out.length, data: b64(out) };
  }
  /* files/text → prepared items (+ fingerprint per item). Throws AIError with user copy. */
  async function prepare(input, onStatus) {
    const items = [];
    if (input.text != null) {
      const text = String(input.text).trim().slice(0, MAX_TEXT);
      if (!text) throw new AIError('badRequest', 'Paste some text first.');
      const bytes = utf8(text);
      items.push({ kind: 'text', name: 'Pasted text', text, chars: text.length, bytes: bytes.length, hash: fnvBytes(bytes.subarray(0, 1 << 20)) + '-' + bytes.length });
      return items;
    }
    const files = Array.from(input.files || []);
    if (files.length > MAX_FILES) throw new AIError('badRequest', 'Add up to 10 files at a time.');
    let i = 0;
    for (const f of files) {
      i++;
      if (onStatus) onStatus(`Preparing ${files.length === 1 ? f.name : `${i} of ${files.length} files`}…`);
      const bytes = await readBytes(f);
      const hash = fnvBytes(bytes.subarray(0, 1 << 20)) + '-' + bytes.length;
      const isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '');
      const isImg = /^image\//.test(f.type || '') || /\.(jpe?g|png|gif|webp|heic|heif)$/i.test(f.name || '');
      let it;
      if (isPdf) it = await prepPdf(f, bytes);
      else if (isImg) it = await prepImage(f);
      else if (/^text\//.test(f.type || '') || /\.(txt|md|csv)$/i.test(f.name || '')) {
        const text = new TextDecoder().decode(bytes).trim().slice(0, MAX_TEXT);
        it = { kind: 'text', name: f.name, text, chars: text.length };
      } else throw new AIError('badRequest', `${f.name} isn’t a PDF, a photo or text.`);
      it.hash = hash;
      it.rawBytes = bytes.length;
      items.push(it);
    }
    return items;
  }
  /* Splits prepared items into requests that respect the per-request caps (§3.1). */
  function batches(items) {
    const out = [];
    let cur = [], pages = 0, raw = 0;
    for (const it of items) {
      const p = it.kind === 'pdf' ? it.pages : 0, r = it.rawBytes || it.bytes || 0;
      if (cur.length && (cur.length >= MAX_BLOCKS || pages + p > MAX_PDF_PAGES || raw + r > MAX_RAW)) { out.push(cur); cur = []; pages = 0; raw = 0; }
      cur.push(it); pages += p; raw += r;
    }
    if (cur.length) out.push(cur);
    return out;
  }

  // ───────────────────────── ingestion: the flow behind the Course sheet ─────────────────────────
  const fmtUSD = (x) => (x < 0.01 ? '<$0.01' : '$' + x.toFixed(2));
  function contextFor(draft, courses) {
    const d = new Date();
    let tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) {}
    const existing = [];
    if (draft && (draft.code || draft.name)) existing.push({ code: draft.code || '', name: draft.name || '' });
    for (const c of courses || []) if (!c.archived && (!draft || c.id !== draft.id)) existing.push({ code: c.code || '', name: c.name || '' });
    return { today: CalCore.dayKey(d), weekday: new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(d), timeZone: tz,
      existingCourses: existing.slice(0, 20), studentHint: '' };
  }
  function pickCourse(list, draft) {
    if (!list.length) return null;
    if (draft) {
      const code = String(draft.code || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const name = String(draft.name || '').toLowerCase();
      const m = list.find((c) => code && String(c.code || '').toLowerCase().replace(/[^a-z0-9]/g, '') === code) ||
        list.find((c) => name && String(c.name || '').toLowerCase() === name);
      if (m) return m;
    }
    return list[0];
  }
  async function ingestFlow(input, ui) {
    let cancelled = false;
    const cancelFn = () => { cancelled = true; cancel(); ui.clear(); };
    const status = (s) => { if (!cancelled && ui.alive()) ui.set({ status: s, error: false, confirm: null, cancel: cancelFn, review: null }); };
    const fail = (e) => { if (cancelled || !ui.alive()) return; const err = AIError.from(e, sdk); ui.set({ status: err.message, error: true, confirm: null, review: null }); };
    try {
      const draft = ui.course();
      status('Preparing…');
      let items = await prepare(input, status);
      const known = new Map(((draft && draft.sources) || []).map((s) => [s.hash, s]));
      const dup = items.filter((it) => known.has(it.hash));
      items = items.filter((it) => !known.has(it.hash));
      if (!items.length) {
        const s = known.get(dup[0].hash);
        ui.set({ status: `Already read on ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(s.addedAt))}`, error: true });
        return;
      }
      await loadContract();
      const est = Ingest.estimate(items);
      const tier = Store.settings().coachTier === 'economy' ? 'economy' : 'best';
      let useTier = tier;
      if (tier === 'best' && (est.best > 0.25 || est.pages > 10)) {
        useTier = await new Promise((resolve) => {
          ui.set({ status: `Reading ${items.length === 1 ? '1 file' : items.length + ' files'} · about ${fmtUSD(est.best)} with Best · ${fmtUSD(est.economy)} with Economy`,
            error: false, review: null, cancel: null,
            confirm: [{ label: 'Use Economy', onClick: () => resolve('economy') }, { label: 'Read with Best', primary: true, onClick: () => resolve('best') },
              { label: 'Cancel', onClick: () => resolve(null) }] });
        });
        if (!useTier) { ui.clear(); return; }
      }
      const ctx = contextFor(draft, ui.existing());
      const label = items.length === 1 ? (items[0].kind === 'image' ? 'photo' : items[0].kind === 'text' ? 'text' : 'syllabus') : 'files';
      const results = [];
      const runBatch = async (batch, splitOnce) => {
        try {
          const r = await run('ingest', Ingest.buildContent(batch, ctx), { tier: useTier,
            onProgress: (n) => status(`Reading ${label}… ${n.toLocaleString()} characters`) });
          results.push(r.data);
        } catch (e) {
          if (e && e.code === 'truncated' && splitOnce && batch.length > 1) {      // max_tokens → retry once, split in two
            const half = Math.ceil(batch.length / 2);
            await runBatch(batch.slice(0, half), false);
            await runBatch(batch.slice(half), false);
            return;
          }
          throw e;
        }
      };
      status(`Reading ${label}…`);
      for (const b of batches(items)) await runBatch(b, true);
      if (cancelled || !ui.alive()) return;
      const source = items.every((it) => it.kind === 'image') ? 'image' : items.every((it) => it.kind === 'text') ? 'text' : 'syllabus';
      const all = [];
      const notes = [];
      for (const data of results) {
        for (const raw of (data && data.courses) || []) all.push(Ingest.mapCourse(raw, { uid: Store.uid, source }));
        if (data && data.notes) notes.push(Ingest.plainText(data.notes, 600));
      }
      let incoming = pickCourse(all, draft);
      if (!incoming) { ui.set({ status: 'No course details were found in these files. Add items by hand, or try another file.', error: true }); return; }
      for (const extra of all.filter((c) => c !== incoming && ((c.code && c.code === incoming.code) || (c.name && c.name === incoming.name)))) {
        incoming.assessments = incoming.assessments.concat(extra.assessments);
        incoming.meetingTimes = incoming.meetingTimes.concat(extra.meetingTimes).slice(0, 12);
      }
      const v = Ingest.validate(incoming);
      incoming = v.course;
      const now = new Date().toISOString();
      incoming.sources = items.map((it) => ({ id: Store.uid(), name: Ingest.plainText(it.name, 120), kind: it.kind === 'pdftext' ? 'pdf' : it.kind,
        pages: it.pages || null, bytes: it.rawBytes || it.bytes || 0, hash: it.hash, addedAt: now }));
      const m = Ingest.merge(draft, incoming);
      const low = m.course.assessments.filter((a) => a.confidence !== 'high').length;
      const others = all.filter((c) => c !== incoming && !((c.code && c.code === incoming.code) || (c.name && c.name === incoming.name))).map((c) => c.code || c.name).filter(Boolean);
      const parts = [];
      if (m.course.meetingTimes.length) parts.push(`${m.course.meetingTimes.length} meeting ${m.course.meetingTimes.length === 1 ? 'time' : 'times'}`);
      parts.push(`${m.course.assessments.length} graded ${m.course.assessments.length === 1 ? 'item' : 'items'}`);
      if (low) parts.push(`${low} to double-check`);
      const md = (k) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10)));
      const diff = [];
      if (draft && (draft.assessments || []).length) {
        diff.push(`${m.added} new`);
        if (m.changed.length) diff.push(`${m.changed.length} date ${m.changed.length === 1 ? 'changed' : 'changes'}: ` + m.changed.slice(0, 3).map((x) => `${x.title} ${md(x.from)} → ${md(x.to)}`).join(', '));
      }
      if (others.length) notes.push(`Also found: ${others.join(', ')} — add it as its own course to keep it separate.`);
      ui.set({ status: null, error: false, confirm: null, cancel: null,
        review: { course: m.course, summaryLine: parts.join(', '), diffLine: diff.join(' · ') || null, notes: notes.join(' ') || null, weightWarning: v.weightWarning } });
    } catch (e) {
      fail(e);
    }
  }

  // ───────────────────────── Study coach card (v2-ai §8.4) ─────────────────────────
  const WARNING = 'Anyone who can use this browser profile, and any extension with access to this site, can read the key. Use a key from a separate Anthropic workspace with a low monthly spend limit (Console › Workspaces › Limits). Remove it here any time.';
  let testMsg = null;
  let openSetupOnce = false;
  /* "Set up Study coach…": Settings › Calendar & Accounts with the card's More open and the key field focused. */
  function openSetup() {
    openSetupOnce = true;
    try { Settings.open('calendar', 'pf-coach-card'); } catch (_) {}
    const card = document.getElementById('pf-coach-card');
    const d = card && card.querySelector('details.pf-ai-optional, details');
    if (d) { d.open = true; openSetupOnce = false; }
    const k = card && card.querySelector('.pf-key-input');
    if (k) try { k.focus(); k.scrollIntoView({ block: 'center' }); } catch (_) {}
  }
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.appendChild(typeof kid === 'object' ? kid : document.createTextNode(String(kid)));
    return el;
  }
  /* The optional key panel inside Settings › Planner & courses › "Optional: add an AI key for syllabus reading".
     Nothing here is needed for planning; the key only lets a course's "Syllabus files" tab read files. */
  function renderKeyPanel(el, opts = {}) {
    const s = Store.settings();
    const rerender = () => { if (opts.rerender) opts.rerender(); else { el.textContent = ''; renderKeyPanel(el, opts); } };
    const connected = hasKey();
    el.appendChild(h('p', { class: 'pf-muted', text: 'Optional. With your own Anthropic API key, a course’s “Syllabus files” tab can read a syllabus PDF, photo or pasted text and fill in its class times and graded items for you to check.' }));
    const keyIn = h('input', { class: 'pf-input pf-key-input', type: 'password', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off',
      placeholder: connected ? maskedKey() : 'sk-ant-…', 'aria-label': 'Anthropic API key' });
    const remember = h('input', { type: 'checkbox', id: 'pf-coach-remember' });
    remember.checked = remembered();
    const warnOK = h('input', { type: 'checkbox', id: 'pf-coach-warnok' });
    let warnAccepted = false;
    try { warnAccepted = localStorage.getItem(pfKey(WARN_STORE)) === '1'; } catch (_) {}
    warnOK.checked = warnAccepted;
    const warnBox = h('div', { class: 'pf-key-warn' }, h('p', { text: WARNING }),
      h('label', { class: 'pf-check-row' }, warnOK, h('span', { text: 'I understand' })));
    warnBox.hidden = !remember.checked || warnAccepted;
    remember.addEventListener('change', () => {
      warnBox.hidden = !remember.checked || warnOK.checked;
      if (!remember.checked && remembered()) { setKey(apiKey(), false); rerender(); }
    });
    const msg = h('span', { class: 'pf-key-msg', role: 'status', text: testMsg || (connected ? (remembered() ? 'Remembered on this device' : 'Key kept until you close this tab') : '') });
    const save = async () => {
      const v = keyIn.value.trim() || apiKey();
      if (!v) { msg.textContent = 'Paste your key first'; return; }
      if (remember.checked && !warnOK.checked && !warnAccepted) { warnBox.hidden = false; msg.textContent = 'Tick “I understand” to remember the key'; return; }
      if (remember.checked && warnOK.checked) { try { localStorage.setItem(pfKey(WARN_STORE), '1'); } catch (_) {} }
      setKey(v, remember.checked);
      keyIn.value = '';
      msg.textContent = 'Testing…';
      const r = await testKey(v);
      if (r.ok) {
        testMsg = r.best ? 'Key works' : 'Key works · this key can’t use the Best model, so Economy is on';
        if (!r.best) Store.setSetting('coachTier', 'economy');
        if (!Store.settings().coachEnabled) Store.setSetting('coachEnabled', true);
      } else {
        testMsg = r.why === 'rejected' ? 'That key was rejected' : r.why === 'noModels' ? 'This key can’t use the models Pure Focus needs' :
          'Couldn’t reach Anthropic. Check your connection and press Test again.';
        if (r.why === 'rejected') { removeKey(); Store.setSetting('coachEnabled', false); }
      }
      rerender();
    };
    el.append(
      h('div', { class: 'pf-overline', text: 'Anthropic API key' }),
      h('div', { class: 'pf-key-row' }, keyIn,
        h('button', { class: 'btn btn-sm', type: 'button', onclick: save }, connected && !keyIn.value ? 'Test' : 'Save'),
        connected ? h('button', { class: 'btn btn-sm btn-quiet-danger', type: 'button', onclick: () => { removeKey(); testMsg = 'Key removed'; Store.setSetting('coachEnabled', false); rerender(); } }, 'Remove') : null),
      h('label', { class: 'pf-check-row' }, remember, h('span', { text: 'Remember on this device' })),
      warnBox, msg);
    if (connected) {
      const seg = h('div', { class: 'segmented pf-seg', role: 'radiogroup', 'aria-label': 'Reading quality' },
        [['best', 'Best'], ['economy', 'Economy']].map(([k, t]) => h('button', { class: 'seg-btn' + (s.coachTier === k ? ' is-active' : ''), type: 'button', role: 'radio',
          'aria-checked': String(s.coachTier === k), onclick: () => { Store.setSetting('coachTier', k); rerender(); } }, t)));
      el.append(h('div', { class: 'pf-overline', text: 'Quality' }), seg,
        h('span', { class: 'pf-field-hint', text: 'Best ≈ $0.25 per syllabus · Economy ≈ $0.01 (charged to your Anthropic account)' }));
      const u = Usage.get();
      const b = Usage.budget();
      const budgetIn = h('input', { class: 'pf-input pf-w-num', type: 'number', min: '1', max: '50', step: '1', value: String(b), 'aria-label': 'Monthly budget in dollars',
        onchange: (e) => Store.setSetting('coachMonthlyBudgetUSD', Math.max(1, Math.min(50, Math.round(+e.target.value || 5)))) });
      el.append(h('div', { class: 'pf-overline', text: 'Monthly limit' }),
        h('div', { class: 'pf-budget-row' }, h('span', { text: '$' }), budgetIn,
          h('span', { class: 'pf-muted', text: `This month: ${fmtUSD(u.usd)} of $${b} · ${u.calls} ${u.calls === 1 ? 'request' : 'requests'}` })),
        h('span', { class: 'pf-budget-bar' }, h('span', { class: 'pf-budget-fill', style: `width:${Math.min(100, Math.round(100 * u.usd / b))}%` })));
    }
    el.append(h('p', { class: 'pf-privacy', text: opts.privacy || '' }));
  }
  /* Back-compat: the whole card (older callers). */
  function renderCard(el, opts = {}) {
    el.textContent = '';
    const body = h('div', { class: 'settings-more-body pf-coach-more' });
    renderKeyPanel(body, { ...opts, rerender: () => renderCard(el, opts) });
    el.appendChild(body);
  }

  return {
    setKey, removeKey, hasKey, remembered, maskedKey, testKey, run, cancel, busy, loadContract, ingestFlow, renderCard, renderKeyPanel, openSetup,
    PDFJS_URL, SDK_URL, Ingest,
    contractHash: () => contractHash,
    _test: { useSDK: (m) => { sdk = m; client = null; }, usePdfjs: (m) => { pdfjs = m; }, prepare, batches, buildParams, contextFor },
  };
})();
