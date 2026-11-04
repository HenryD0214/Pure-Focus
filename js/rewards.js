/* ═══════════════════════════════════════════════════════════════════════
   rewards.js — Pure Focus engagement layer (web)
   The engine is js/engagement.js (spec/engagement-reference.js verbatim plus
   the SPEC §1.3.7 plan patch; global `Engagement`). This file is the UI —
   HUD (#hud-root), Journey (#journey-root), celebrations — plus the v2 hooks:
   Rewards.setPlanProvider(fn), addReceiptSuffix(fn), registerHudRow(fn),
   journeySlot(name).
   ═══════════════════════════════════════════════════════════════════════ */

const PFEngagement = Engagement;

/* ═══════════════════════════════════════════════════════════════════════
   Rewards — the engagement UI (HUD, Journey, celebrations)
   Everything is derived from Store.sessions()/tasks() through PFEngagement,
   so it applies retroactively and matches the macOS app number-for-number.
   Public API: Rewards.init(), Rewards.state(), Rewards.refresh().
   ═══════════════════════════════════════════════════════════════════════ */


const Rewards = (() => {
  'use strict';

  const E = PFEngagement;
  const SVGNS = 'http://www.w3.org/2000/svg';
  const ACK_BASE = 'purefocus.ack';

  const RARITY = {
    common:    { name: 'Common',    a: '#A7B0BE', b: '#A7B0BE', text: '#5B6472' },
    uncommon:  { name: 'Uncommon',  a: '#3DBA8B', b: '#3DBA8B', text: '#1E8A63' },
    rare:      { name: 'Rare',      a: '#4DA8DA', b: '#4DA8DA', text: '#2672A8' },
    epic:      { name: 'Epic',      a: '#9B7EDE', b: '#9B7EDE', text: '#6C4FC0' },
    legendary: { name: 'Legendary', a: '#FFC857', b: '#FF8A3D', text: '#B8620F' },
  };
  const PURE_TIER = { id: 'pure', name: 'Pure Focus', emoji: '💎', colors: ['#FFF3B0', '#FFD166', '#FFFFFF'], ink: '#3A2400',
    tagline: 'Nothing left but the work and the calm.' };
  const STREAK_COPY = {
    3: '3 days in a row — a habit is kindling.',
    7: 'A full week. This is becoming who you are.',
    14: 'Two weeks of steady focus.',
    30: '30 days. Unbroken.',
    50: '50 days. Remarkable consistency.',
    100: '100 days of focus.',
    150: '150 days. Focus is part of you now.',
    200: '200 days of showing up.',
    365: 'A full year of focus.',
  };

  // ── state ──
  let st = null;              // last computed engine state
  let sig = '';               // memo signature of the last compute
  let basePrev = null;        // state at the last celebration check (diff baseline)
  let ui = null;              // HUD element refs
  let achFilter = 'all';
  let checkTimer = null;
  let pendingReason = null;
  let completionFlag = 0;     // timestamp of the last focus:completed
  let midnightTimer = null;
  let inited = false;

  // ── v2 hooks (SPEC-V2 §4.8; created by W1·A) ──
  // setPlanProvider(fn): fn() → {xpByDay, plannedBlocks, onPlan, clockworkDays} | null (W3, from CalCore.planScore)
  // addReceiptSuffix(fn): fn(engineSession) → string | null, appended to the XP receipt (W1·B "· Passed Ben")
  // registerHudRow(fn): fn() → Node | null, a row for the HUD badge popover (W1·B friends; W6 renders the popover)
  // journeySlot(name): a persistent element inside the Journey card ('friends' sits after the achievements)
  let planProvider = null;
  let pendingPlan = null;     // plan input read by signature(), reused by compute()
  const receiptSuffixes = [];
  const hudRows = [];
  const slots = new Map();
  function readPlan() {
    if (!planProvider) return null;
    try { const p = planProvider(); return p && typeof p === 'object' ? p : null; }
    catch (err) { console.warn('Rewards: plan provider failed', err); return null; }
  }
  function setPlanProvider(fn) {
    planProvider = typeof fn === 'function' ? fn : null;
    if (inited) { try { compute(true); render(); } catch (err) { console.error('Rewards: plan refresh failed', err); } }
  }
  function addReceiptSuffix(fn) {
    if (typeof fn !== 'function') return () => {};
    receiptSuffixes.push(fn);
    return () => { const i = receiptSuffixes.indexOf(fn); if (i >= 0) receiptSuffixes.splice(i, 1); };
  }
  function registerHudRow(fn) {
    if (typeof fn !== 'function') return () => {};
    hudRows.push(fn);
    return () => { const i = hudRows.indexOf(fn); if (i >= 0) hudRows.splice(i, 1); };
  }
  function journeySlot(name) {
    const key = String(name || '');
    if (!slots.has(key)) {
      const el = document.createElement('div');
      el.className = 'pf-journey-slot';
      el.dataset.slot = key;
      if (key === 'friends') el.id = 'friends-root';
      slots.set(key, el);
    }
    return slots.get(key);
  }

  // ── tiny DOM helpers (never innerHTML) ──
  function h(tag, props, ...kids) {
    const n = document.createElement(tag);
    if (props) applyProps(n, props);
    append(n, kids);
    return n;
  }
  function s(tag, props, ...kids) {
    const n = document.createElementNS(SVGNS, tag);
    if (props) applyProps(n, props, true);
    append(n, kids);
    return n;
  }
  function applyProps(n, props, isSvg) {
    for (const k of Object.keys(props)) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') { if (isSvg) n.setAttribute('class', v); else n.className = v; }
      else if (k === 'text') n.textContent = String(v);
      else if (k === 'style') { for (const p of Object.keys(v)) n.style.setProperty(p, v[p]); }
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : String(v));
    }
  }
  function append(n, kids) {
    for (const c of kids.flat(Infinity)) {
      if (c == null || c === false) continue;
      n.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
    }
  }

  // ── formatting ──
  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  function fmtMin(m) {
    m = Math.round(m);
    if (m < 60) return m + 'm';
    const hh = Math.floor(m / 60), mm = m % 60;
    return mm ? hh + 'h ' + mm + 'm' : hh + 'h';
  }
  function fmtShortDate(k) {
    const d = new Date(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10));
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }
  function tierFor(level) {
    if (level >= 30) return PURE_TIER;
    return E.TIERS[Math.min(E.TIERS.length - 1, Math.floor((Math.max(1, level) - 1) / 5))];
  }
  function gradientOf(colors) {
    return 'linear-gradient(135deg, ' + colors.join(', ') + ')';
  }

  // ── environment ──
  function settings() { try { return Store.settings() || {}; } catch (_) { return {}; } }
  function engagementMode() { const m = settings().engagementMode; return m === 'calm' || m === 'off' ? m : 'full'; }
  function celebrationStyle() {
    const c = settings().celebrations;
    if (c === 'off') return 'off';
    if (c === 'subtle' || reducedMotion()) return 'subtle';
    return 'full';
  }
  function reducedMotion() {
    if (document.body && document.body.classList.contains('reduce-motion')) return true;
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (_) { return false; }
  }
  function focusRunning() {
    try { return typeof Timer !== 'undefined' && Timer.isRunning && Timer.isRunning() && Timer.mode && Timer.mode() === 'focus'; }
    catch (_) { return false; }
  }
  function ackKey() {
    try { if (typeof Profile !== 'undefined' && Profile && typeof Profile.key === 'function') return Profile.key(ACK_BASE); } catch (_) {}
    return ACK_BASE;
  }
  function loadAck() {
    try { const raw = localStorage.getItem(ackKey()); return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
  }
  function saveAck(a) {
    try { localStorage.setItem(ackKey(), JSON.stringify(a)); } catch (_) {}
  }

  // ── compute (memoised on a cheap signature) ──
  function goalSetting() {
    const g = Number(settings().dailyGoalMinutes);
    return Number.isFinite(g) && g >= 0 ? g : 120;
  }
  function signature() {
    const ss = Store.sessions() || [];
    const ts = Store.tasks() || [];
    let rated = 0, mins = 0;
    for (const x of ss) { if (x && x.focusRating != null) rated++; if (x) mins += Number(x.minutes) || 0; }
    let done = 0;
    for (const t of ts) if (t && t.isDone) done++;
    const last = ss.length ? ss[ss.length - 1] : null;
    pendingPlan = readPlan();
    return [ss.length, last && last.id, rated, Math.round(mins * 100), ts.length, done, goalSetting(),
      E.dayKey(new Date()), engagementMode(), pendingPlan ? JSON.stringify(pendingPlan) : ''].join('|');
  }
  function compute(force) {
    const nextSig = signature();
    if (!force && st && nextSig === sig) return false;
    sig = nextSig;
    st = E.compute({ sessions: Store.sessions() || [], tasks: Store.tasks() || [], now: new Date(), dailyGoalMinutes: goalSetting(),
      plan: pendingPlan || null });
    st.sessionsToNext = E.sessionsToNextLevel(st);
    return true;
  }

  // ═════════════════════════ icons ═════════════════════════
  const FLAME = 'M8 1.5c.6 2-1.2 2.8-1.2 4.2 0 .8.5 1.3 1.1 1.3.7 0 1.1-.6 1.1-1.4 1.5 1.2 2.4 2.7 2.4 4.3A3.4 3.4 0 0 1 8 14a3.4 3.4 0 0 1-3.4-4.1C4.6 7 8 5.6 8 1.5Z';
  const FLAME_CORE = 'M8 8.3c.9.8 1.5 1.7 1.5 2.6A1.5 1.5 0 0 1 8 12.4a1.5 1.5 0 0 1-1.5-1.5c0-1.1.9-1.8 1.5-2.6Z';
  const MOON = 'M10.6 2.2a5.6 5.6 0 1 0 3.2 9.9A6.2 6.2 0 0 1 10.6 2.2Z';
  let gradSeq = 0;
  function flameIcon(cls, days) {
    const id = 'pf-flame-g' + (++gradSeq);
    const kids = [
      s('defs', null, s('linearGradient', { id, x1: '0', y1: '0', x2: '0', y2: '1' },
        s('stop', { offset: '0', 'stop-color': '#FF9F0A' }), s('stop', { offset: '1', 'stop-color': '#FF453A' }))),
      s('path', { class: 'pf-flame-body', d: FLAME, fill: 'url(#' + id + ')', stroke: 'url(#' + id + ')', 'stroke-width': '1.1', 'stroke-linejoin': 'round' }),
    ];
    if (days >= 7) kids.push(s('path', { class: 'pf-flame-core', d: FLAME_CORE, fill: '#fff' }));
    return s('svg', { class: cls, viewBox: '0 0 16 16', 'aria-hidden': 'true' }, kids);
  }
  function moonIcon(cls) {
    return s('svg', { class: cls, viewBox: '0 0 16 16', 'aria-hidden': 'true' }, s('path', { d: MOON, fill: 'currentColor' }));
  }
  function checkIcon(cls) {
    return s('svg', { class: cls, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
      s('path', { d: 'M3.8 8.4 6.7 11.2 12.3 5', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  }
  function ringIcon(cls, size, stroke, frac, hit) {
    const r = (size - stroke) / 2, c = 2 * Math.PI * r, cx = size / 2;
    const f1 = Math.min(1, Math.max(0, frac)), f2 = Math.min(1, Math.max(0, frac - 1));
    const svg = s('svg', { class: cls + (hit ? ' is-hit' : ''), viewBox: '0 0 ' + size + ' ' + size, 'aria-hidden': 'true' },
      s('circle', { class: 'pf-ring-track', cx, cy: cx, r, fill: 'none', 'stroke-width': stroke }),
      s('circle', { class: 'pf-ring-fill', cx, cy: cx, r, fill: 'none', 'stroke-width': stroke, 'stroke-linecap': 'round',
        'stroke-dasharray': c.toFixed(2), 'stroke-dashoffset': (c * (1 - f1)).toFixed(2), transform: 'rotate(-90 ' + cx + ' ' + cx + ')' }),
      f2 > 0 ? s('circle', { class: 'pf-ring-lap', cx, cy: cx, r, fill: 'none', 'stroke-width': stroke, 'stroke-linecap': 'round',
        'stroke-dasharray': c.toFixed(2), 'stroke-dashoffset': (c * (1 - f2)).toFixed(2), transform: 'rotate(-90 ' + cx + ' ' + cx + ')' }) : null);
    return svg;
  }
  function setRing(svg, size, stroke, frac, hit) {
    const fresh = ringIcon(svg.getAttribute('class').replace(' is-hit', ''), size, stroke, frac, hit);
    svg.replaceWith(fresh);
    return fresh;
  }
  function badge(level, cls) {
    const tier = tierFor(level);
    return h('span', { class: 'pf-badge ' + (cls || ''), 'data-tier': tier.id,
      style: { '--pf-tier-bg': gradientOf(tier.colors), '--pf-tier-ink': tier.ink, '--pf-tier-c1': tier.colors[0], '--pf-tier-c2': tier.colors[1] } },
      h('span', { class: 'pf-badge-num', text: String(level) }));
  }
  function medallion(a, size, opts) {
    const o = opts || {};
    const r = RARITY[a.rarity] || RARITY.common;
    const locked = !a.unlocked && !o.forceUnlocked;
    const secret = locked && a.secret;
    const sz = size, sw = 2.5, rad = (sz - sw) / 2, c = 2 * Math.PI * rad;
    const node = h('span', { class: 'pf-medal pf-medal--' + a.rarity + (locked ? ' is-locked' : ' is-unlocked') + (secret ? ' is-secret' : ''),
      style: { '--pf-r-a': r.a, '--pf-r-b': r.b, width: sz + 'px', height: sz + 'px' } });
    const gid = 'pf-rg' + (++gradSeq);
    const svg = s('svg', { class: 'pf-medal-ring', viewBox: '0 0 ' + sz + ' ' + sz, 'aria-hidden': 'true' },
      s('defs', null, s('linearGradient', { id: gid, x1: '0', y1: '0', x2: '1', y2: '1' },
        s('stop', { offset: '0', 'stop-color': r.a }), s('stop', { offset: '1', 'stop-color': r.b }))),
      s('circle', { class: 'pf-medal-track', cx: sz / 2, cy: sz / 2, r: rad, fill: 'none', 'stroke-width': sw }),
      (locked && !secret && a.fraction > 0) || !locked
        ? s('circle', { class: 'pf-medal-arc', cx: sz / 2, cy: sz / 2, r: rad, fill: 'none', 'stroke-width': sw, 'stroke-linecap': 'round',
          stroke: 'url(#' + gid + ')', 'stroke-dasharray': c.toFixed(2),
          'stroke-dashoffset': (locked ? c * (1 - Math.min(1, a.fraction)) : 0).toFixed(2), transform: 'rotate(-90 ' + sz / 2 + ' ' + sz / 2 + ')' })
        : null);
    node.appendChild(svg);
    node.appendChild(h('span', { class: 'pf-medal-glyph', style: { 'font-size': Math.round(sz * 0.43) + 'px' }, text: secret ? '?' : a.emoji }));
    return node;
  }

  // ═════════════════════════ HUD ═════════════════════════
  // The momentum chip (USER-HOTFIX-1 H4): a labeled chip on the Focus page, e.g.
  // "🔥 3-day streak · Level 2 · ◔ 45 / 120 min ›". It opens the progress popover, which
  // explains every number ("What do these mean?") and links to Reports › Journey.
  function buildHud(root) {
    root.replaceChildren();
    const refs = {};
    refs.badge = badge(1, 'pf-hud-badge');
    refs.title = h('span', { class: 'pf-hud-title' });
    refs.fill = h('span', { class: 'pf-hud-fill' });
    refs.bar = h('span', { class: 'pf-hud-bar' }, refs.fill);
    refs.levelLbl = h('span', { class: 'pf-hud-lbl pf-hud-level-lbl' });
    refs.level = h('span', { class: 'pf-hud-level' }, refs.badge, h('span', { class: 'pf-hud-xp' }, refs.title, refs.bar), refs.levelLbl);
    refs.flame = flameIcon('pf-hud-flame', 0);
    refs.count = h('span', { class: 'pf-hud-count' });
    refs.streakLbl = h('span', { class: 'pf-hud-lbl pf-hud-streak-lbl' });
    refs.moons = h('span', { class: 'pf-hud-moons' });
    refs.streak = h('span', { class: 'pf-hud-streak' }, refs.flame, refs.count, refs.streakLbl, refs.moons);
    refs.ring = ringIcon('pf-hud-ring', 22, 3, 0, false);
    refs.ringCheck = checkIcon('pf-hud-ring-check');
    refs.goalLbl = h('span', { class: 'pf-hud-lbl pf-hud-goal-lbl' });
    refs.goal = h('span', { class: 'pf-hud-goal' }, h('span', { class: 'pf-hud-goal-ring' }, refs.ring, refs.ringCheck), refs.goalLbl);
    refs.sep1 = h('span', { class: 'pf-hud-sep pf-hud-sep1', 'aria-hidden': 'true' });
    refs.sep2 = h('span', { class: 'pf-hud-sep pf-hud-sep2', 'aria-hidden': 'true' });
    refs.chev = h('span', { class: 'pf-hud-chev', 'aria-hidden': 'true', text: '›' });
    refs.btn = h('button', { class: 'pf-hud pf-hud--chip', type: 'button', 'aria-describedby': 'pf-hud-tip', 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
      'aria-controls': 'pf-hud-pop', title: 'Your progress — click for details and what each number means', onclick: () => toggleHudPop() },
      refs.streak, refs.sep1, refs.level, refs.sep2, refs.goal, refs.chev);
    refs.tip = h('div', { class: 'pf-hud-tip', id: 'pf-hud-tip', role: 'tooltip' });
    refs.wrap = h('div', { class: 'pf-hud-wrap pf-hud-wrap--stage' }, refs.btn, refs.tip);
    root.appendChild(refs.wrap);
    return refs;
  }

  function renderHud() {
    const root = document.getElementById('hud-root');
    if (!root || !st) return;
    if (!ui || !root.contains(ui.wrap)) ui = buildHud(root);
    const mode = engagementMode();
    ui.wrap.hidden = mode === 'off';
    ui.wrap.classList.toggle('is-calm', mode === 'calm');
    const x = st.xp, sk = st.streak, t = st.today;

    // level + XP
    const nb = badge(x.level, 'pf-hud-badge');
    ui.badge.replaceWith(nb); ui.badge = nb;
    ui.title.textContent = x.level >= 30 ? 'Pure Focus' : x.title;
    const frac = x.need > 0 ? x.into / x.need : 1;
    ui.fill.style.width = (Math.max(0.03, Math.min(1, frac)) * 100).toFixed(2) + '%';

    // streak
    const nf = flameIcon('pf-hud-flame', sk.current);
    ui.flame.replaceWith(nf); ui.flame = nf;
    ui.count.textContent = '';
    ui.streakLbl.textContent = sk.current > 0 ? sk.current + '-day streak' : 'No streak yet';
    ui.levelLbl.textContent = 'Level ' + x.level;
    ui.streak.className = 'pf-hud-streak ' + streakStateClass();
    ui.moons.replaceChildren(...Array.from({ length: sk.restBank }, () => moonIcon('pf-hud-moon')));
    if (sk.restBank > 0) {
      const restTxt = sk.restBank + (sk.restBank === 1 ? ' rest day' : ' rest days') + ' saved — a missed day won’t break your streak';
      ui.moons.setAttribute('role', 'img'); ui.moons.setAttribute('aria-label', restTxt); ui.moons.title = restTxt;
    } else { ui.moons.removeAttribute('role'); ui.moons.removeAttribute('aria-label'); ui.moons.removeAttribute('title'); }

    // goal ring
    const goal = t.goal;
    ui.goal.hidden = !(goal > 0);
    ui.sep2.hidden = !(goal > 0);
    ui.ring = setRing(ui.ring, 22, 3, goal > 0 ? t.minutes / goal : 0, t.goalHit);
    ui.ringCheck.style.opacity = t.goalHit ? '1' : '0';
    ui.goalLbl.textContent = goal > 0 ? (t.goalHit ? 'Daily goal met' : fmtMin(t.minutes) + ' of ' + fmtMin(goal) + ' today') : '';

    // tooltip + accessible label
    const tipLines = [];
    const nextL = x.level + 1;
    const lvLine = x.need > 0
      ? fmt(x.into) + ' / ' + fmt(x.need) + ' XP to Level ' + nextL
      : fmt(x.total) + ' XP · max level';
    const sessLine = st.sessionsToNext ? '≈ ' + st.sessionsToNext + ' session' + (st.sessionsToNext === 1 ? '' : 's') + ' to Level ' + nextL : '';
    const stLine = streakCopy();
    const goalLine = goal > 0
      ? (t.goalHit ? 'Goal met · ' + fmtMin(t.minutes) + ' of ' + fmtMin(goal) : fmtMin(t.minutes) + ' / ' + fmtMin(goal) + ' today')
      : '';
    const qDone = t.quests.list.filter((q) => q.done).length;
    ui.tip.replaceChildren(
      mode === 'full' ? h('div', { class: 'pf-tip-row pf-tip-head' }, h('strong', { text: 'Level ' + x.level }), h('span', { text: ' · ' + (x.level >= 30 ? 'Pure Focus' : x.title) })) : null,
      mode === 'full' ? h('div', { class: 'pf-tip-row pf-tip-xp', text: lvLine }) : null,
      mode === 'full' && sessLine ? h('div', { class: 'pf-tip-row pf-tip-muted', text: sessLine }) : null,
      h('div', { class: 'pf-tip-row' }, flameIcon('pf-tip-ico', sk.current), h('span', { text: stLine })),
      goalLine ? h('div', { class: 'pf-tip-row' }, ringIcon('pf-tip-ico pf-tip-ring', 14, 2.2, t.minutes / goal, t.goalHit), h('span', { text: goalLine })) : null,
      mode === 'full' ? h('div', { class: 'pf-tip-row pf-tip-muted', text: 'Quests ' + qDone + '/3 · click for details' }) : null,
    );
    const label = (mode === 'full' ? 'Level ' + x.level + ', ' + x.title + '. ' + fmt(x.into) + ' of ' + fmt(x.need) + ' XP. ' + (sessLine ? sessLine.replace('≈', 'About') + '. ' : '') : '')
      + stLine + '. ' + (goalLine ? goalLine + '. ' : '') + 'Show details.';
    ui.btn.setAttribute('aria-label', label);
    if (hudPop) renderHudPop();
  }

  // ── the sidebar's goal card (#side-goal-root): today's ring "45m / 2h · Today's goal", then
  // "Quests ••• 1/3 ›" (Full motivation only). A click opens the Journey in Reports. ──
  let side = null;
  function renderSideGoal() {
    const root = document.getElementById('side-goal-root');
    if (!root || !st) return;
    const mode = engagementMode();
    const t = st.today;
    const goal = t.goal;
    if (!side || !root.contains(side.btn)) {
      side = {};
      side.ring = ringIcon('pf-sg-ring', 34, 3.4, 0, false);
      side.check = checkIcon('pf-sg-check');
      side.big = h('span', { class: 'pf-sg-big' });
      side.sub = h('span', { class: 'pf-sg-sub' });
      side.dots = h('span', { class: 'pf-sg-dots', 'aria-hidden': 'true' });
      side.qCount = h('span', { class: 'pf-sg-qcount' });
      side.quests = h('span', { class: 'pf-sg-quests' }, h('span', { class: 'pf-sg-qlbl', text: 'Quests' }), side.dots, side.qCount,
        h('span', { class: 'pf-sg-chev', 'aria-hidden': 'true', text: '›' }));
      side.goal = h('span', { class: 'pf-sg-goal' },
        h('span', { class: 'pf-sg-ringwrap' }, side.ring, side.check),
        h('span', { class: 'pf-sg-text' }, side.big, side.sub));
      side.btn = h('button', { class: 'pf-sg', type: 'button', onclick: () => openJourney() }, side.goal, side.quests);
      root.replaceChildren(side.btn);
    }
    const hasGoal = goal > 0;
    side.ring = setRing(side.ring, 34, 3.4, hasGoal ? t.minutes / goal : 0, t.goalHit);
    side.check.style.opacity = t.goalHit ? '1' : '0';
    side.big.textContent = hasGoal ? fmtMin(t.minutes) + ' / ' + fmtMin(goal) : fmtMin(t.minutes);
    side.sub.textContent = !hasGoal ? 'Focused today' : t.goalHit ? 'Goal met today' : "Today's goal";
    const showQuests = mode === 'full' && t.quests && Array.isArray(t.quests.list);
    side.quests.hidden = !showQuests;
    let qDone = 0;
    if (showQuests) {
      const list = t.quests.list.slice(0, 3);
      qDone = list.filter((q) => q.done).length;
      side.dots.replaceChildren(...list.map((q) => h('i', { class: q.done ? 'is-done' : '' })));
      side.qCount.textContent = qDone + '/' + list.length;
    }
    const label = (hasGoal ? fmtMin(t.minutes) + ' of your ' + fmtMin(goal) + ' goal today' + (t.goalHit ? ', goal met' : '') : fmtMin(t.minutes) + ' focused today')
      + (showQuests ? '. Quests ' + qDone + ' of 3 done' : '') + '. Open your Journey';
    side.btn.setAttribute('aria-label', label);
    side.btn.title = hasGoal ? 'Your daily focus goal' + (showQuests ? ' and today’s quests' : '') + ' — click for your Journey' : 'Click for your Journey';
  }

  // ── badge popover (SPEC-V2 §5.8): level + XP, goal and streak, quests + sweep dots, the next
  // achievement, registered rows (W1·B friends rank), and a way into the Journey. ──
  let hudPop = null;
  function onPopOutside(e) {
    if (hudPop && ui && !ui.wrap.contains(e.target) && !hudPop.contains(e.target)) closeHudPop(false);
  }
  function onPopKey(e) {
    if (!hudPop) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeHudPop(true); }
    else if (e.key === 'Tab') {
      setTimeout(() => { if (hudPop && ui && !ui.wrap.contains(document.activeElement) && !hudPop.contains(document.activeElement)) closeHudPop(false); }, 0);
    }
  }
  function closeHudPop(refocus) {
    if (!hudPop) return;
    hudPop.remove();
    hudPop = null;
    if (ui) { ui.btn.setAttribute('aria-expanded', 'false'); ui.wrap.classList.remove('is-open'); if (refocus) ui.btn.focus(); }
    document.removeEventListener('pointerdown', onPopOutside, true);
    document.removeEventListener('keydown', onPopKey, true);
    window.removeEventListener('resize', placeHudPop);
  }
  // It sits on <body>, not in the chip: the tasks panel clips anything inside it.
  function placeHudPop() {
    if (!hudPop || !ui) return;
    if (window.innerWidth <= 700) { hudPop.style.left = ''; hudPop.style.top = ''; return; }   // the bottom sheet
    const r = ui.btn.getBoundingClientRect();
    const left = Math.max(12, Math.min(window.innerWidth - hudPop.offsetWidth - 12, r.left));
    const top = Math.max(12, Math.min(window.innerHeight - hudPop.offsetHeight - 12, r.bottom + 8));
    hudPop.style.left = `${Math.round(left)}px`;
    hudPop.style.top = `${Math.round(top)}px`;
  }
  function toggleHudPop(force) {
    if (!ui || !st) return;
    const open = typeof force === 'boolean' ? force : !hudPop;
    if (!open) { closeHudPop(true); return; }
    if (hudPop) return;
    hudPop = h('div', { class: 'pf-hud-pop', id: 'pf-hud-pop', role: 'dialog', 'aria-label': 'Your progress', tabindex: '-1' });
    document.body.appendChild(hudPop);
    ui.wrap.classList.add('is-open');
    ui.btn.setAttribute('aria-expanded', 'true');
    renderHudPop();
    try { hudPop.focus({ preventScroll: true }); } catch (_) {}
    document.addEventListener('pointerdown', onPopOutside, true);
    document.addEventListener('keydown', onPopKey, true);
    window.addEventListener('resize', placeHudPop);
  }
  function renderHudPop() {
    if (!hudPop || !st) return;
    const mode = engagementMode();
    const x = st.xp, sk = st.streak, t = st.today;
    const kids = [];
    if (mode === 'full') {
      const frac = x.need > 0 ? x.into / x.need : 1;
      const stn = st.sessionsToNext;
      kids.push(h('div', { class: 'pf-pop-level' },
        badge(x.level, 'pf-pop-badge'),
        h('div', { class: 'pf-pop-level-text' },
          h('div', { class: 'pf-pop-title' }, h('strong', { text: 'Level ' + x.level }), h('span', { class: 'pf-dim', text: ' · ' + (x.level >= 30 ? 'Pure Focus' : x.title) })),
          h('div', { class: 'pf-bar pf-bar--pop', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(x.need), 'aria-valuenow': String(x.into), 'aria-label': 'Experience toward the next level' },
            h('span', { class: 'pf-bar-fill', style: { width: (Math.max(0.02, Math.min(1, frac)) * 100).toFixed(2) + '%' } })),
          h('div', { class: 'pf-pop-sub' },
            h('span', { text: x.need > 0 ? fmt(x.into) + ' / ' + fmt(x.need) + ' XP' : fmt(x.total) + ' XP' }),
            // Goal gradient: "≈ N sessions to Level L+1" only when N ≤ 3 (SPEC-V2 §5.1).
            stn && stn <= 3 ? h('span', { class: 'pf-pop-near', text: '≈ ' + stn + ' session' + (stn === 1 ? '' : 's') + ' to Level ' + (x.level + 1) }) : null))));
    }
    const goal = t.goal;
    kids.push(h('div', { class: 'pf-pop-row' },
      goal > 0 ? ringIcon('pf-pop-ring', 30, 3.5, t.minutes / goal, t.goalHit) : null,
      h('div', { class: 'pf-pop-row-text' },
        h('span', { class: 'pf-pop-strong', text: goal > 0 ? fmtMin(t.minutes) + ' / ' + fmtMin(goal) : fmtMin(t.minutes) + ' today' }),
        h('span', { class: 'pf-dim', text: goal > 0 ? (t.goalHit ? 'Daily goal met' : 'Daily goal') : 'Daily goal is off' })),
      h('span', { class: 'pf-sec-spacer' }),
      h('span', { class: 'pf-pop-streak ' + streakStateClass() }, flameIcon('pf-pop-flame', sk.current), h('span', { class: 'pf-pop-strong', text: sk.current > 0 ? sk.current + '-day streak' : 'No streak yet' }))));
    if (mode === 'full') {
      const tq = t.quests;
      const done = tq.list.filter((q) => q.done).length;
      const dots = [];
      for (let i = 6; i >= 0; i--) {
        const k = E.addDays(st.todayKey, -i);
        const q = st.quests[k];
        const has = !!st.days[k];
        const n = has && q ? q.list.filter((y) => y.done).length : 0;
        dots.push(h('span', { class: 'pf-sweep-dot' + (has && q && q.sweep ? ' is-sweep' : n > 0 ? ' is-some' : ''), title: fmtShortDate(k) + ' · ' + n + '/3 quests' }));
      }
      kids.push(h('div', { class: 'pf-pop-sec' },
        h('div', { class: 'pf-pop-sec-head' }, h('span', { text: "Today's quests" }), h('span', { class: 'pf-count-chip', text: done + '/3' }),
          h('span', { class: 'pf-sec-spacer' }), h('span', { class: 'pf-sweep-dots', 'aria-label': 'Quests over the last 7 days', title: 'Your last 7 days of quests: bright = all three done, faint = some, empty = none' }, dots)),
        tq.list.map((q) => h('div', { class: 'pf-pop-quest' + (q.done ? ' is-done' : '') },
          h('span', { class: 'pf-pop-quest-emoji', 'aria-hidden': 'true', text: q.emoji }),
          h('span', { class: 'pf-pop-quest-title', text: q.title }),
          q.done ? h('span', { class: 'pf-pop-quest-check' }, checkIcon('pf-pop-check')) : h('span', { class: 'pf-pop-quest-prog', text: questProgressText(q) })))));
      const nx = st.nextAchievement;
      if (nx) kids.push(h('div', { class: 'pf-pop-row pf-pop-next' }, medallion(nx, 30),
        h('div', { class: 'pf-pop-row-text' }, h('span', { class: 'pf-dim', text: 'Next achievement' }), h('span', { class: 'pf-pop-strong', text: nx.name + ' · ' + achValueText(nx) }))));
    }
    for (const fn of hudRows) {
      try { const node = fn(); if (node instanceof Node) kids.push(h('div', { class: 'pf-pop-extra' }, node)); } catch (_) { /* a row never breaks the popover */ }
    }
    kids.push(h('button', { class: 'pf-pop-link pf-pop-explain', type: 'button', onclick: () => { closeHudPop(false); openExplainer(null, ui && ui.btn); } },
      h('span', { class: 'pf-q', 'aria-hidden': 'true', text: '?' }), 'What do these mean?'));
    kids.push(h('button', { class: 'pf-pop-link', type: 'button', onclick: () => {
      closeHudPop(false);
      try {
        App.showView('reports');
        const b = document.querySelector('#report-tab-switch .seg-btn[data-rtab="journey"]');
        if (b) b.click();
        window.scrollTo({ top: 0, behavior: 'auto' });
      } catch (_) { /* reports are optional */ }
    } }, mode === 'full' ? 'Open your Journey' : 'Open Reports', h('span', { 'aria-hidden': 'true', text: ' ›' })));
    hudPop.replaceChildren(...kids);
    placeHudPop();
  }

  // ── "What's this?" explainer (USER-HOTFIX-1 H4): one small sheet, plain language, every reward term. ──
  const EXPLAIN = [
    { id: 'level', icon: '⭐', title: 'Level & XP',
      text: 'XP (experience points) are points you earn by focusing — about 10 for every focused minute, plus a little for finishing and rating sessions. Collect enough XP and your Level goes up. Levels only measure how much focus you have put in; they never go down.' },
    { id: 'streak', icon: '🔥', title: 'Streak',
      text: 'How many days in a row you have focused. A day counts once you finish one focus session of about 10 minutes or more. Skip a day and the streak starts over — unless you have a rest day saved.' },
    { id: 'rest', icon: '🌙', title: 'Rest days',
      text: 'Every 5 days of streak you earn a rest day (you can hold 2). If you miss a day, a rest day is used automatically so your streak survives. Shown as small moons next to your streak.' },
    { id: 'goal', icon: '⭕', title: 'Daily goal ring',
      text: 'The ring fills as you focus today. A full ring means you reached your daily focus goal. Change the goal in Settings › Timer & Tasks.' },
    { id: 'tiers', icon: '✨', title: 'Ranks (Spark, Glow, Lantern…)',
      text: 'Every 5 levels you move up a rank: Spark (levels 1–5), Glow (6–10), Lantern (11–15), Beacon (16–20), Aurora (21–25), Zenith (26+). The number after the name — like Glow III — is your step inside that rank (I to V).' },
    { id: 'bonus', icon: '➕', title: 'Streak bonus (+% XP)',
      text: 'A longer streak makes each session worth a bit more: +5% XP from 3 days, +10% from 7, +15% from 14, +20% from 30 and +25% from 60 days.' },
    { id: 'combo', icon: '🔗', title: 'Combo (×2, ×3…)',
      text: 'Sessions done one after another with a short break (3 to 45 minutes) between them form a combo. Your second session in a row is ×2, the third ×3, and so on. Each step adds 5% XP, up to +20%. A gap longer than 45 minutes starts over at ×1.' },
    { id: 'golden', icon: '🌟', title: 'Golden session',
      text: 'About 1 in 10 finished sessions is picked at random to be Golden: its minute XP is doubled. Nothing to do — it is a small surprise.' },
    { id: 'quests', icon: '🎯', title: 'Quests',
      text: 'Three small challenges each day, like “finish 2 sessions”. Each one gives bonus XP, and doing all three gives a little extra. New ones arrive every morning. The row of 7 dots shows the last 7 days: a bright dot = all three done, a faint dot = some done, an empty dot = none.' },
    { id: 'achievements', icon: '🏅', title: 'Achievements',
      text: 'Badges for milestones, such as your first 10-hour week. See them all, and how close you are, in Reports › Journey.' },
  ];
  let explainEl = null;
  let explainReturn = null;
  function closeExplainer() {
    if (!explainEl) return;
    explainEl.remove(); explainEl = null;
    document.removeEventListener('keydown', onExplainKey, true);
    if (explainReturn && explainReturn.isConnected) try { explainReturn.focus({ preventScroll: true }); } catch (_) {}
    explainReturn = null;
  }
  function onExplainKey(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeExplainer(); } }
  function openExplainer(topic, returnTo) {
    closeExplainer();
    explainReturn = returnTo || document.activeElement;
    const mode = engagementMode();
    const items = EXPLAIN.filter((x) => mode === 'full' || !['level', 'tiers', 'bonus', 'combo', 'golden', 'quests', 'achievements'].includes(x.id));
    const close = h('button', { class: 'icon-btn small pf-explain-close', type: 'button', 'aria-label': 'Close', title: 'Close (Esc)', onclick: () => closeExplainer() });
    close.appendChild(s('svg', { viewBox: '0 0 20 20', 'aria-hidden': 'true' }, s('path', { d: 'M5.5 5.5l9 9m0-9-9 9', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round' })));
    const card = h('div', { class: 'pf-explain', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'pf-explain-title', tabindex: '-1' },
      h('div', { class: 'pf-explain-head' },
        h('h2', { class: 'pf-explain-title', id: 'pf-explain-title', text: 'What these mean' }), close),
      h('p', { class: 'pf-explain-lead', text: 'Rewards are optional encouragement. Turn them down or off in Settings › Rewards.' }),
      h('dl', { class: 'pf-explain-list' }, items.map((x) => h('div', { class: 'pf-explain-item' + (x.id === topic ? ' is-topic' : ''), 'data-topic': x.id },
        h('dt', null, h('span', { class: 'pf-explain-ico', 'aria-hidden': 'true', text: x.icon }), h('span', { text: x.title })),
        h('dd', { text: x.text })))),
      h('div', { class: 'pf-explain-foot' },
        h('button', { class: 'btn btn-glass btn-sm', type: 'button', onclick: () => { closeExplainer(); openJourney(); } }, 'Open your Journey'),
        h('button', { class: 'btn btn-glass btn-sm', type: 'button', onclick: () => closeExplainer() }, 'Got it')));
    explainEl = h('div', { class: 'pf-explain-backdrop', onclick: (e) => { if (e.target === explainEl) closeExplainer(); } }, card);
    document.body.appendChild(explainEl);
    document.addEventListener('keydown', onExplainKey, true);
    const t = topic && card.querySelector('[data-topic="' + topic + '"]');
    try { (t || card).scrollIntoView({ block: 'nearest' }); card.focus({ preventScroll: true }); } catch (_) {}
  }
  function openJourney() {
    try {
      App.showView('reports');
      const b = document.querySelector('#report-tab-switch .seg-btn[data-rtab="journey"]');
      if (b) b.click();
      window.scrollTo({ top: 0, behavior: 'auto' });
    } catch (_) { /* reports are optional */ }
  }

  function streakStateClass() {
    const sk = st.streak;
    if (sk.current === 0) return 'is-zero';
    if (sk.todayStatus === 'active') return 'is-active' + (sk.current >= 30 ? ' is-halo' : '');
    return new Date().getHours() >= 18 ? 'is-risk' : 'is-pending';
  }
  function streakCopy() {
    const sk = st.streak;
    if (sk.current === 0) return sk.longest > 0 ? 'New streak, fresh start — one session today begins it' : 'Start a streak today';
    if (sk.todayStatus === 'active') return sk.current + '-day streak' + (sk.multiplierPct ? ' · +' + sk.multiplierPct + '% XP' : '');
    return sk.current + '-day streak · ' + (new Date().getHours() >= 18 ? 'one session keeps it alive' : 'one session keeps it going');
  }

  // ═════════════════════════ Journey ═════════════════════════
  // Journey lives only inside its own Reports tab (v2-themes T13, SPEC-V2 §5.6): Rewards
  // registers it with Reports.registerTab. Order: tier hero → streak → today's quests →
  // achievements "Next up" (3) + "All 30 ›" → Friends slot → lifetime stats.
  let journeyHost = null;
  let achAllOpen = false;
  function renderJourney() {
    const root = journeyHost;
    if (!root || !st) return;
    const mode = engagementMode();
    if (mode === 'off') {
      root.replaceChildren(h('section', { class: 'pf-journey glass pf-j-off' },
        h('p', { class: 'pf-dim', text: 'Rewards are off. Your focus history is still kept — turn them back on in Settings › Rewards.' })));
      return;
    }
    const card = h('section', { class: 'pf-journey glass', 'aria-label': 'Your focus journey' },
      h('div', { class: 'pf-j-help' }, h('button', { class: 'link-btn pf-pop-explain', type: 'button', onclick: (e) => openExplainer(null, e.currentTarget) },
        h('span', { class: 'pf-q', 'aria-hidden': 'true', text: '?' }), 'What do level, streak and quests mean?')),
      h('div', { class: 'pf-j-top' + (mode === 'calm' ? ' is-calm' : '') },
        mode === 'full' ? heroCard() : goalCard(),
        streakCard()),
      mode === 'full' ? questsCard() : null,
      mode === 'full' ? achievementsCard() : null,
      journeySlot('friends'),
      mode === 'full' ? lifetimeCard() : null);
    root.replaceChildren(card);
  }
  function registerJourneyTab() {
    try {
      if (typeof Reports === 'undefined' || !Reports || typeof Reports.registerTab !== 'function') return;
      Reports.registerTab({ id: 'journey', title: 'Journey', order: 4, render: (el) => { journeyHost = el; renderJourney(); } });
    } catch (err) { console.error('Rewards: Journey tab failed', err); }
  }

  function heroCard() {
    const x = st.xp, tier = tierFor(x.level);
    const frac = x.need > 0 ? x.into / x.need : 1;
    const nextTier = E.TIERS.find((t) => t.from > x.level);
    const stn = st.sessionsToNext;
    return h('div', { class: 'pf-j-panel pf-j-hero', style: { '--pf-tier-c1': tier.colors[0], '--pf-tier-c2': tier.colors[1] } },
      h('div', { class: 'pf-hero-row' },
        h('div', { class: 'pf-hero-badge-wrap' }, badge(x.level, 'pf-hero-badge'), h('span', { class: 'pf-hero-emoji', 'aria-hidden': 'true', text: tier.emoji })),
        h('div', { class: 'pf-hero-text' },
          h('div', { class: 'pf-overline', text: 'Level ' + x.level }),
          h('div', { class: 'pf-hero-title', text: x.level >= 30 ? 'Pure Focus' : x.title }),
          h('div', { class: 'pf-hero-tag', text: tier.tagline }))),
      h('div', { class: 'pf-hero-xp' },
        h('div', { class: 'pf-hero-xp-nums' },
          h('span', null, h('strong', { text: fmt(x.into) }), h('span', { class: 'pf-dim', text: ' / ' + fmt(x.need) + ' XP' })),
          h('span', { class: 'pf-dim', text: x.need > 0 ? 'Level ' + (x.level + 1) : 'Max level' })),
        h('div', { class: 'pf-bar pf-bar--hero', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(x.need), 'aria-valuenow': String(x.into),
          'aria-label': 'Experience toward the next level' },
          h('span', { class: 'pf-bar-fill', style: { width: (Math.max(0.02, Math.min(1, frac)) * 100).toFixed(2) + '%' } }))),
      h('div', { class: 'pf-hero-foot' },
        stn ? h('span', { class: 'pf-pill-note' }, h('span', { class: 'pf-accent', text: '≈ ' + stn }), ' session' + (stn === 1 ? '' : 's') + ' to Level ' + (x.level + 1)) : null,
        nextTier ? h('span', { class: 'pf-dim', text: 'Next tier: ' + nextTier.name + ' at Level ' + nextTier.from }) : null),
      tierPath(x.level));
  }
  function lifetimeCard() {
    const x = st.xp;
    const lifetimeH = st.metrics.hours;
    return h('div', { class: 'pf-j-section pf-lifetime' },
      h('div', { class: 'pf-sec-head' }, h('h3', { class: 'pf-sec-title', text: 'Lifetime' })),
      h('div', { class: 'pf-hero-stats' },
        stat(fmt(x.total), 'XP earned'),
        stat(lifetimeH >= 10 ? String(Math.round(lifetimeH)) + 'h' : fmtMin(lifetimeH * 60), 'focused'),
        stat(fmt(st.metrics.qualified), 'sessions'),
        stat(String(st.achievements.filter((a) => a.unlocked).length) + '/' + st.achievements.length, 'achievements')));
  }
  function stat(v, label) {
    return h('div', { class: 'pf-stat' }, h('div', { class: 'pf-stat-v', text: v }), h('div', { class: 'pf-stat-l', text: label }));
  }
  function tierPath(level) {
    const segs = E.TIERS.map((t, i) => {
      const nodes = [];
      for (let k = 0; k < 5; k++) {
        const L = t.from + k;
        nodes.push(h('span', { class: 'pf-tp-node' + (L <= level ? ' is-on' : '') + (L === Math.min(level, 30) ? ' is-current' : ''), title: 'Level ' + L }));
      }
      return h('div', { class: 'pf-tp-seg' + (level >= t.from ? ' is-reached' : ''), style: { '--pf-tier-bg': gradientOf(t.colors), '--pf-tier-c1': t.colors[0] },
        title: t.name + ' · Levels ' + t.from + '–' + (i === E.TIERS.length - 1 ? '30+' : t.from + 4) },
        h('span', { class: 'pf-tp-label', text: t.name }), h('div', { class: 'pf-tp-nodes' }, nodes));
    });
    return h('div', { class: 'pf-tierpath', 'aria-hidden': 'true' }, segs);
  }

  function goalCard() {
    const t = st.today;
    return h('div', { class: 'pf-j-panel pf-j-goal' },
      h('div', { class: 'pf-overline', text: 'Today' }),
      h('div', { class: 'pf-goal-row' },
        ringIcon('pf-goal-big', 72, 7, t.goal > 0 ? t.minutes / t.goal : 0, t.goalHit),
        h('div', null,
          h('div', { class: 'pf-hero-title', text: fmtMin(t.minutes) }),
          h('div', { class: 'pf-dim', text: t.goal > 0 ? (t.goalHit ? 'Goal met — anything more is a bonus' : 'of your ' + fmtMin(t.goal) + ' goal') : 'Daily goal is off' }))));
  }

  function streakCard() {
    const sk = st.streak;
    const cls = streakStateClass();
    return h('div', { class: 'pf-j-panel pf-j-streak' },
      h('div', { class: 'pf-streak-head' },
        h('div', { class: 'pf-streak-flame-wrap ' + cls }, flameIcon('pf-streak-flame', sk.current)),
        h('div', null,
          h('div', { class: 'pf-streak-num' }, h('span', { text: String(sk.current) }), h('span', { class: 'pf-streak-unit', text: sk.current === 1 ? ' day streak' : ' day streak' })),
          h('div', { class: 'pf-dim pf-streak-sub', text: streakSub() })),
        h('div', { class: 'pf-streak-side' },
          sideStat(String(sk.longest), 'best'),
          sideStat(String(sk.restBank), sk.restBank === 1 ? 'rest day' : 'rest days', true))),
      heatmap(),
      h('div', { class: 'pf-hm-legend' },
        h('span', { class: 'pf-dim', text: 'Less' }),
        [1, 2, 3, 4].map((l) => h('span', { class: 'pf-hm-cell pf-hm-l' + l, 'aria-hidden': 'true' })),
        h('span', { class: 'pf-dim', text: 'More' }),
        h('span', { class: 'pf-hm-legend-gap' }),
        h('span', { class: 'pf-hm-cell is-rest', 'aria-hidden': 'true' }, moonIcon('pf-hm-moon')),
        h('span', { class: 'pf-dim', text: 'Rest day' })));
  }
  function sideStat(v, label, moon) {
    return h('div', { class: 'pf-side-stat' }, h('div', { class: 'pf-side-v' }, moon ? moonIcon('pf-side-moon') : null, h('span', { text: v })), h('div', { class: 'pf-side-l', text: label }));
  }
  function streakSub() {
    const sk = st.streak;
    if (sk.current === 0) return sk.longest > 0 ? 'New streak, fresh start — one session today begins it.' : 'One focus session today starts your streak.';
    const bits = [];
    if (sk.todayStatus === 'pending') bits.push(new Date().getHours() >= 18 ? 'One session keeps it alive' : 'One session today keeps it going');
    else bits.push('Today counted');
    if (sk.multiplierPct) bits.push('+' + sk.multiplierPct + '% XP');
    if (sk.nextMilestone) bits.push('next milestone ' + sk.nextMilestone);
    return bits.join(' · ');
  }
  function heatmap() {
    const today = st.todayKey;
    const thisWeek = E.addDays(today, -new Date(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10)).getDay());
    const first = E.addDays(thisWeek, -7 * 11);
    const goal = st.today.goal > 0 ? st.today.goal : 120;
    const cols = [];
    const months = [];
    let lastMonth = null;
    for (let w = 0; w < 12; w++) {
      const wk = E.addDays(first, w * 7);
      const cells = [];
      for (let d = 0; d < 7; d++) {
        const k = E.addDays(wk, d);
        const m = +k.slice(5, 7);
        if (d === 0) {
          const end = E.addDays(wk, 6);
          const mEnd = +end.slice(5, 7);
          const label = w === 0 || mEnd !== lastMonth ? new Date(+end.slice(0, 4), mEnd - 1, 1).toLocaleDateString('en-US', { month: 'short' }) : '';
          months.push(label);
          lastMonth = mEnd;
        }
        void m;
        if (k > today) { cells.push(h('span', { class: 'pf-hm-cell is-future', 'aria-hidden': 'true' })); continue; }
        const status = (st.streak.byDay[k] || ['none', 0])[0];
        const day = st.days[k];
        const mins = day ? day.cm / 100 : 0;
        let cls = 'pf-hm-cell';
        let desc = fmtShortDate(k) + ' · ';
        if (status === 'active') {
          const lvl = mins >= goal ? 4 : mins >= goal * 0.6 ? 3 : mins >= goal * 0.3 ? 2 : 1;
          cls += ' pf-hm-l' + lvl; desc += fmtMin(mins) + ' focused';
        } else if (status === 'rest') { cls += ' is-rest'; desc += 'rest day — streak safe'; }
        else if (mins > 0) { cls += ' is-partial'; desc += fmtMin(mins) + ' (short sessions)'; }
        else desc += k === today ? 'today' : 'no focus';
        if (k === today) cls += ' is-today';
        cells.push(h('span', { class: cls, title: desc }, status === 'rest' ? moonIcon('pf-hm-moon') : null));
      }
      cols.push(h('div', { class: 'pf-hm-col' }, cells));
    }
    const dayLabels = h('div', { class: 'pf-hm-days', 'aria-hidden': 'true' }, ['', 'M', '', 'W', '', 'F', ''].map((t) => h('span', { text: t })));
    return h('div', { class: 'pf-hm', role: 'img', 'aria-label': 'Focus calendar for the last 12 weeks' },
      h('div', { class: 'pf-hm-months', 'aria-hidden': 'true' }, h('span', { class: 'pf-hm-days-gap' }), months.map((t) => h('span', { text: t }))),
      h('div', { class: 'pf-hm-body' }, dayLabels, h('div', { class: 'pf-hm-grid' }, cols)));
  }

  function questProgressText(q) {
    const p = Math.min(q.progress, q.target);
    if (q.id === 'q_block' || q.id === 'q_push') return p + ' / ' + q.target + ' min';
    if (q.id === 'q_chain3' || q.id === 'q_flow') return '×' + Math.max(p, 0) + ' / ×' + q.target;
    return p + ' / ' + q.target;
  }
  function questsCard() {
    const tq = st.today.quests;
    const done = tq.list.filter((q) => q.done).length;
    // last 7 days' sweep dots
    const dots = [];
    for (let i = 6; i >= 0; i--) {
      const k = E.addDays(st.todayKey, -i);
      const q = st.quests[k];
      const has = !!st.days[k];
      const n = has && q ? q.list.filter((x) => x.done).length : 0;
      dots.push(h('span', { class: 'pf-sweep-dot' + (has && q && q.sweep ? ' is-sweep' : n > 0 ? ' is-some' : ''), title: fmtShortDate(k) + ' · ' + n + '/3 quests' }));
    }
    return h('div', { class: 'pf-j-section' },
      h('div', { class: 'pf-sec-head' },
        h('h3', { class: 'pf-sec-title', text: "Today's quests" }),
        h('span', { class: 'pf-count-chip' + (done === 3 ? ' is-done' : ''), text: done + '/3' }),
        h('span', { class: 'pf-sec-spacer' }),
        h('span', { class: 'pf-sweep-dots', 'aria-label': 'Quests over the last 7 days', title: 'Your last 7 days of quests: bright = all three done, faint = some, empty = none' }, dots),
        h('span', { class: 'pf-dim pf-sec-note', text: tq.sweep ? 'Daily sweep · +' + E.C.SWEEP_XP + ' XP earned' : 'Finish all three for +' + E.C.SWEEP_XP + ' XP · fresh at midnight' })),
      h('div', { class: 'pf-quests' }, tq.list.map((q) => {
        const frac = Math.min(1, q.progress / q.target);
        return h('div', { class: 'pf-quest pf-quest--' + q.tier + (q.done ? ' is-done' : '') },
          h('div', { class: 'pf-quest-top' },
            h('span', { class: 'pf-quest-emoji', 'aria-hidden': 'true', text: q.emoji }),
            h('span', { class: 'pf-quest-tier', text: q.tier === 'stretch' ? 'Stretch' : q.tier === 'medium' ? 'Medium' : 'Easy' }),
            h('span', { class: 'pf-sec-spacer' }),
            q.done ? h('span', { class: 'pf-quest-check' }, checkIcon('pf-quest-check-ico')) : h('span', { class: 'pf-quest-reward', text: '+' + q.reward + ' XP' })),
          h('div', { class: 'pf-quest-title', text: q.title }),
          h('div', { class: 'pf-quest-text', text: q.text }),
          h('div', { class: 'pf-quest-prog' },
            h('div', { class: 'pf-bar pf-bar--quest' }, h('span', { class: 'pf-bar-fill', style: { width: (frac * 100).toFixed(1) + '%' } })),
            h('span', { class: 'pf-quest-num', text: q.done ? 'Done · +' + q.reward + ' XP' : questProgressText(q) })));
      })));
  }

  function achValueText(a) {
    if (a.metric === 'hours') return (Math.floor(a.value * 10) / 10).toLocaleString('en-US') + ' / ' + a.target + ' h';
    if (a.metric === 'level') return 'Level ' + a.value + ' / ' + a.target;
    return fmt(a.value) + ' / ' + fmt(a.target);
  }
  function achievementsCard() {
    const list = st.achievements;
    const unlocked = list.filter((a) => a.unlocked).length;
    // "Next up": the three closest locked, non-secret achievements.
    const next = list.filter((a) => !a.unlocked && !a.secret).sort((a, b) => (b.fraction || 0) - (a.fraction || 0)).slice(0, 3);
    const filtered = list.filter((a) => achFilter === 'all' ? true : achFilter === 'unlocked' ? a.unlocked : !a.unlocked && !a.secret && a.fraction > 0);
    const toggle = h('button', { class: 'pf-all-btn', type: 'button', 'aria-expanded': String(achAllOpen), 'aria-controls': 'pf-ach-all',
      onclick: () => { achAllOpen = !achAllOpen; renderJourney(); const b = document.querySelector('.pf-all-btn'); if (b) b.focus(); } },
      achAllOpen ? 'Show less' : 'All ' + list.length, h('span', { class: 'pf-all-chev', 'aria-hidden': 'true', text: '›' }));
    const seg = h('div', { class: 'segmented pf-ach-filter', role: 'tablist', 'aria-label': 'Filter achievements' },
      [['all', 'All'], ['unlocked', 'Unlocked'], ['progress', 'In progress']].map(([id, label]) =>
        h('button', { class: 'seg-btn' + (achFilter === id ? ' is-active' : ''), role: 'tab', type: 'button', 'aria-selected': String(achFilter === id),
          onclick: () => { achFilter = id; renderJourney(); const f = document.querySelector('.pf-ach-filter .is-active'); if (f) f.focus(); }, text: label })));
    return h('div', { class: 'pf-j-section' },
      h('div', { class: 'pf-sec-head' },
        h('h3', { class: 'pf-sec-title', text: 'Achievements' }),
        h('span', { class: 'pf-count-chip', text: unlocked + '/' + list.length }),
        h('span', { class: 'pf-sec-spacer' }),
        toggle),
      !achAllOpen
        ? (next.length ? h('div', { class: 'pf-ach-grid pf-ach-next', 'aria-label': 'Next up' }, next.map(achTile))
          : h('div', { class: 'pf-dim pf-empty', text: 'Every achievement in reach is yours. More appear as you go.' }))
        : h('div', { class: 'pf-ach-all', id: 'pf-ach-all' },
          seg,
          filtered.length
            ? h('div', { class: 'pf-ach-grid' }, filtered.map(achTile))
            : h('div', { class: 'pf-dim pf-empty', text: 'Nothing here yet — every session moves something forward.' })));
  }
  function achTile(a) {
    const secret = a.secret && !a.unlocked;
    const r = RARITY[a.rarity] || RARITY.common;
    return h('div', { class: 'pf-ach' + (a.unlocked ? ' is-unlocked' : ' is-locked') + (secret ? ' is-secret' : '') + ' pf-ach--' + a.rarity,
      style: { '--pf-r-a': r.a, '--pf-r-b': r.b, '--pf-r-text': r.text },
      title: secret ? 'Some achievements are secret — keep going.' : a.name + ' — ' + a.text },
      medallion(a, 56),
      h('div', { class: 'pf-ach-body' },
        h('div', { class: 'pf-ach-name', text: secret ? 'Secret' : a.name }),
        h('div', { class: 'pf-ach-text', text: secret ? 'Some achievements are secret — keep going.' : a.text }),
        a.unlocked
          ? h('div', { class: 'pf-ach-rarity', text: r.name })
          : secret ? null : h('div', { class: 'pf-ach-prog' },
            h('div', { class: 'pf-bar pf-bar--ach' }, h('span', { class: 'pf-bar-fill', style: { width: (Math.min(1, Math.max(0, a.fraction)) * 100).toFixed(1) + '%' } })),
            h('span', { class: 'pf-ach-num', text: achValueText(a) }))));
  }

  // ═════════════════════════ celebrations ═════════════════════════
  const queue = [];
  const GAP_MS = 1200;        // at least 1.2 s between celebratory moments (T7)
  let busy = false;
  let fxLayer = null, liveRegion = null;
  const myToasts = [];

  function layer() {
    if (!fxLayer || !document.body.contains(fxLayer)) {
      fxLayer = h('div', { class: 'pf-fx', 'aria-hidden': 'true' });
      document.body.appendChild(fxLayer);
    }
    return fxLayer;
  }
  function announce(text) {
    if (!liveRegion || !document.body.contains(liveRegion)) {
      liveRegion = h('div', { class: 'pf-sr', 'aria-live': 'polite', role: 'status' });
      document.body.appendChild(liveRegion);
    }
    liveRegion.textContent = '';
    setTimeout(() => { liveRegion.textContent = text; }, 30);
  }

  function enqueue(steps) {
    for (const x of steps) queue.push(x);
    pump();
  }
  function pump() {
    if (busy) return;
    if (!queue.length) return;
    if (focusRunning()) { setTimeout(pump, 1000); return; }
    const step = queue.shift();
    busy = true;
    // one popup at a time: a tip (coach mark) that is up steps aside and comes back afterwards
    try { if (typeof CoachMarks !== 'undefined' && CoachMarks.yieldNow) CoachMarks.yieldNow(); } catch (_) { /* optional */ }
    let finished = false;
    const done = () => { if (finished) return; finished = true; setTimeout(() => { busy = false; pump(); }, GAP_MS); };
    try { step(done); } catch (err) { console.error(err); done(); }
    setTimeout(done, 6000); // never wedge the queue
  }

  // Rich toast in the shared stack (announced by its aria-live region).
  function richToast({ icon, over, title, sub, variant, life, onLeave }) {
    const stack = document.getElementById('toast-stack') || layer();
    while (myToasts.length >= 1) dropToast(myToasts[0]);   // one celebratory moment at a time (T7)
    const node = h('div', { class: 'pf-toast celebrate-toast' + (variant ? ' pf-toast--' + variant : ''), role: 'status' },
      icon ? h('span', { class: 'pf-toast-icon' }, icon) : null,
      h('span', { class: 'pf-toast-text' },
        over ? h('span', { class: 'pf-toast-over', text: over }) : null,
        h('span', { class: 'pf-toast-title', text: title }),
        sub ? h('span', { class: 'pf-toast-sub', text: sub }) : null));
    stack.appendChild(node);
    myToasts.push(node);
    node._onLeave = typeof onLeave === 'function' ? onLeave : null;
    node._t = setTimeout(() => dropToast(node), life || 3200);
    return node;
  }
  function dropToast(node) {
    const i = myToasts.indexOf(node);
    if (i >= 0) myToasts.splice(i, 1);
    clearTimeout(node._t);
    if (node._onLeave) { const f = node._onLeave; node._onLeave = null; try { f(); } catch (_) {} }
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), 320);
  }

  function originRect(preferRing) {
    const ring = document.querySelector('#view-focus:not([hidden]) .ring-wrap');
    if (preferRing && ring && ring.getClientRects().length) return ring.getBoundingClientRect();
    const hud = document.querySelector('#hud-root .pf-hud');
    if (hud && hud.getClientRects().length) return hud.getBoundingClientRect();
    if (ring && ring.getClientRects().length) return ring.getBoundingClientRect();
    return { left: innerWidth / 2 - 1, top: innerHeight / 2 - 1, width: 2, height: 2, bottom: innerHeight / 2 + 1 };
  }

  function confetti(x, y, count, spread) {
    if (reducedMotion()) return;
    const root = layer();
    const cs = getComputedStyle(document.documentElement);
    const v = (n, f) => (cs.getPropertyValue(n).trim() || f);
    const colors = [v('--focus-tint', '#e8482b'), v('--break-tint', '#2aa198'), v('--longbreak-tint', '#7c5cbf'), v('--accent', '#ff6b35'), '#FFD166'];
    for (let i = 0; i < count; i++) {
      const p = h('span', { class: 'pf-confetti', style: { left: x + 'px', top: y + 'px', background: colors[i % colors.length],
        width: (6 + (i % 3) * 2) + 'px', height: (i % 2 ? 10 : 6) + 'px' } });
      root.appendChild(p);
      const ang = (Math.PI * 2 * i) / count + Math.random() * 0.6;
      const dist = spread * (0.55 + Math.random() * 0.6);
      const dx = Math.cos(ang) * dist, dy = Math.sin(ang) * dist * 0.8 - spread * 0.25;
      const anim = p.animate([
        { transform: 'translate(-50%,-50%) rotate(0deg)', opacity: 1 },
        { transform: 'translate(calc(-50% + ' + dx.toFixed(1) + 'px), calc(-50% + ' + dy.toFixed(1) + 'px)) rotate(' + ((Math.random() * 540 - 270) | 0) + 'deg)', opacity: 1, offset: 0.7 },
        { transform: 'translate(calc(-50% + ' + (dx * 1.08).toFixed(1) + 'px), calc(-50% + ' + (dy + spread * 0.35).toFixed(1) + 'px)) rotate(' + ((Math.random() * 720 - 360) | 0) + 'deg)', opacity: 0 },
      ], { duration: 1100 + Math.random() * 400, easing: 'cubic-bezier(.15,.7,.3,1)' });
      anim.onfinish = () => p.remove();
      setTimeout(() => p.remove(), 1800);
    }
  }

  function receiptOf(sess) {
    if (!sess || !sess.parts) return '';
    const p = sess.parts;
    const bits = ['Focus ' + p.base];
    if (p.completion) bits.push('Finish ' + p.completion);
    if (p.golden) bits.push('Golden session +' + p.golden);
    if (p.reflection) bits.push('Rated ' + p.reflection);
    if (p.streakPct) bits.push('🔥 +' + p.streakPct + '%');
    if (p.comboPct) bits.push('×' + (p.comboPct / 5 + 1) + ' combo');
    for (const fn of receiptSuffixes) {
      try { const extra = fn(sess); if (extra) bits.push(String(extra)); } catch (_) { /* a suffix never breaks the receipt */ }
    }
    return bits.join(' · ');
  }

  // The XP receipt sits in the Focus caption row for 4 s (SPEC-V2 §5.3), in place of the
  // beads and "ends" time; the shield chip stays at its end. → false when Focus isn't showing.
  let receiptTimer = 0;
  function showReceipt(text) {
    const footer = document.querySelector('#view-focus:not([hidden]) .timer-footer');
    if (!footer || !footer.getClientRects().length || !text) return false;
    let el = footer.querySelector('.xp-receipt');
    if (!el) {
      el = h('span', { class: 'xp-receipt', role: 'status' });
      const chip = footer.querySelector('#guard-chip-root');
      if (chip) chip.before(el); else footer.appendChild(el);
    }
    el.textContent = text;
    footer.classList.add('has-receipt');
    clearTimeout(receiptTimer);
    receiptTimer = setTimeout(() => footer.classList.remove('has-receipt'), 4000);
    return true;
  }

  function xpStep(ev, fromCompletion, style) {
    return (done) => {
      const golden = !!(fromCompletion && ev.session && ev.session.golden);
      const receipt = fromCompletion ? receiptOf(ev.session) : (ev.amount <= 25 ? 'for reflecting' : '');
      const label = (golden ? '✦ ' : '') + '+' + fmt(ev.amount) + ' XP';
      announce(label + (receipt ? ', ' + receipt : ''));
      const inCaption = fromCompletion && showReceipt((golden ? 'Golden · ' : '') + receipt);
      if (style === 'subtle') {
        richToast({ icon: badge(st.xp.level, 'pf-toast-badge'), title: label, sub: golden ? 'Golden session — minute XP doubled' : (inCaption ? '' : receipt), variant: golden ? 'golden' : 'xp', life: 2400, onLeave: done });
        return;
      }
      const r = originRect(fromCompletion);
      const sub = inCaption ? '' : golden ? 'Golden session — minute XP doubled' : receipt;
      const chip = h('div', { class: 'pf-xp-chip celebrate-chip' + (golden ? ' is-golden' : '') + (fromCompletion ? '' : ' is-mini') },
        h('span', { class: 'pf-xp-chip-main', text: label }),
        sub ? h('span', { class: 'pf-xp-chip-sub', text: sub }) : null);
      const cx = r.left + r.width / 2;
      const cy = fromCompletion && r.height > 100 ? r.top + r.height * 0.3 : r.bottom + 14;
      chip.style.left = cx + 'px';
      chip.style.top = cy + 'px';
      layer().appendChild(chip);
      const rise = fromCompletion ? -70 : 26;
      chip.animate([
        { transform: 'translate(-50%, 0) scale(.6)', opacity: 0 },
        { transform: 'translate(-50%, ' + rise * 0.35 + 'px) scale(1.06)', opacity: 1, offset: 0.22 },
        { transform: 'translate(-50%, ' + rise * 0.7 + 'px) scale(1)', opacity: 1, offset: 0.75 },
        { transform: 'translate(-50%, ' + rise + 'px) scale(.96)', opacity: 0 },
      ], { duration: fromCompletion ? 2300 : 1600, easing: 'cubic-bezier(.2,.8,.25,1)', fill: 'forwards' });
      setTimeout(() => chip.remove(), 2500);
      setTimeout(() => { bumpHud(); }, 900);
      setTimeout(done, fromCompletion ? 1500 : 1000);
    };
  }
  function bumpHud() {
    if (!ui || reducedMotion()) return;
    ui.btn.classList.remove('is-bump');
    void ui.btn.offsetWidth;
    ui.btn.classList.add('is-bump');
    setTimeout(() => ui && ui.btn.classList.remove('is-bump'), 800);
  }
  function toastStep(opts) {
    const step = (done) => {
      const sub = step.also && step.also.length ? [opts.sub, 'Also ' + step.also.join(' · ')].filter(Boolean).join(' — ') : opts.sub;
      announce([opts.over, opts.title, sub].filter(Boolean).join('. '));
      richToast({ ...opts, sub, onLeave: done });
    };
    return step;
  }
  function goalStep(ev, style) {
    const step = (done) => {
      goalStepAlso = step.also || [];
      const sub = 'Anything more is a bonus — remember to rest.';
      const title = 'Goal met · ' + fmtMin(ev.minutes) + (ev.bonus ? ' · +' + fmt(ev.bonus) + ' XP' : '');
      announce(title);
      if (style === 'full') {
        const ringEl = document.querySelector('#hud-root .pf-hud-goal');
        const r = ringEl && ringEl.getClientRects().length ? ringEl.getBoundingClientRect() : originRect(true);
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const burst = h('div', { class: 'pf-goal-burst', style: { left: x + 'px', top: y + 'px' } });
        layer().appendChild(burst);
        setTimeout(() => burst.remove(), 1400);
        confetti(x, y, 34, 150);
        const ring = document.querySelector('#view-focus:not([hidden]) .ring-wrap');
        if (ring && ring.getClientRects().length) {
          const rr = ring.getBoundingClientRect();
          const sweep = h('div', { class: 'pf-ring-sweep', style: { left: rr.left + 'px', top: rr.top + 'px', width: rr.width + 'px', height: rr.height + 'px' } });
          layer().appendChild(sweep);
          setTimeout(() => sweep.remove(), 1300);
        }
      }
      const also = goalStepAlso.length ? ' — Also ' + goalStepAlso.join(' · ') : '';
      richToast({ icon: ringIcon('pf-toast-ring', 30, 3.5, 1, true), over: 'Daily goal', title, sub: sub + also, variant: 'goal', life: 3200, onLeave: done });
    };
    return step;
  }
  let goalStepAlso = [];
  function levelStep(ev, style) {
    const step = (done) => {
      const also = step.also && step.also.length ? 'Also ' + step.also.join(' · ') : '';
      const tier = tierFor(ev.to);
      const tierUp = ev.tierUp;
      const sessions = st.sessionsToNext;
      const line2 = tierUp ? 'New tier · ' + tier.name + ' — ' + tier.tagline
        : sessions ? '≈ ' + sessions + ' session' + (sessions === 1 ? '' : 's') + ' to Level ' + (ev.to + 1) : tier.tagline;
      announce('Level up. Level ' + ev.to + ', ' + ev.title + '. ' + line2);
      if (style !== 'full') {
        richToast({ icon: badge(ev.to, 'pf-toast-badge'), over: 'Level up', title: 'Level ' + ev.to + ' · ' + ev.title, sub: [line2, also].filter(Boolean).join(' — '), variant: 'level', life: 3200, onLeave: done });
        return;
      }
      let closed = false;
      const ov = h('div', { class: 'pf-levelup celebrate-banner' + (tierUp ? ' is-tierup' : ''), role: 'dialog', 'aria-modal': 'false', 'aria-label': 'Level up',
        style: { '--pf-tier-bg': gradientOf(tier.colors), '--pf-tier-c1': tier.colors[0], '--pf-tier-c2': tier.colors[1], '--pf-tier-ink': tier.ink } },
        h('div', { class: 'pf-lu-scrim' }),
        h('div', { class: 'pf-lu-stage' },
          h('div', { class: 'pf-lu-rays', 'aria-hidden': 'true' }),
          h('div', { class: 'pf-lu-over', text: tierUp ? 'New tier' : 'Level up' }),
          h('div', { class: 'pf-lu-badge-wrap' }, badge(ev.to, 'pf-lu-badge'), h('span', { class: 'pf-lu-emoji', 'aria-hidden': 'true', text: tier.emoji })),
          h('div', { class: 'pf-lu-title' }, h('span', { text: 'Level ' + ev.to }), h('span', { class: 'pf-lu-dot', text: ' · ' }), h('span', { class: 'pf-lu-name', text: ev.title })),
          h('div', { class: 'pf-lu-sub', text: line2 }),
          also ? h('div', { class: 'pf-lu-also', text: also }) : null,
          h('div', { class: 'pf-lu-hint', text: 'Click to continue' })));
      const close = () => {
        if (closed) return; closed = true;
        document.removeEventListener('keydown', onKey, true);
        ov.classList.add('is-leaving');
        done();                       // the 1.2 s gap starts as the banner leaves
        setTimeout(() => ov.remove(), 320);
      };
      const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
      ov.addEventListener('click', close);
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(ov);
      void ov.offsetWidth; // flush styles so the entrance transition runs (no rAF: robust in throttled views)
      ov.classList.add('is-in');
      const st0 = ov.querySelector('.pf-lu-stage');
      const br = st0.getBoundingClientRect();
      setTimeout(() => confetti(br.left + br.width / 2, br.top + br.height * 0.38, tierUp ? 64 : 46, tierUp ? 300 : 240), 160);
      setTimeout(close, tierUp ? 2600 : 2400);
    };
    return step;
  }
  function achievementsStep(list, style) {
    const steps = [];
    const rarest = (a, b) => ['common', 'uncommon', 'rare', 'epic', 'legendary'].indexOf(b.rarity) - ['common', 'uncommon', 'rare', 'epic', 'legendary'].indexOf(a.rarity);
    if (list.length >= 2) {
      const sorted = list.slice().sort(rarest);
      steps.push(toastStep({
        icon: h('span', { class: 'pf-medal-stack' }, sorted.slice(0, 3).map((a) => medallion(a, 40, { forceUnlocked: true }))),
        over: list.length + ' achievements unlocked',
        title: sorted.slice(0, 3).map((a) => a.name).join(' · ') + (list.length > 3 ? ' +' + (list.length - 3) : ''),
        sub: 'See them in your Journey', variant: 'ach', life: 3200,
      }));
    } else {
      for (const a of list) {
        const r = RARITY[a.rarity] || RARITY.common;
        steps.push(toastStep({ icon: medallion(a, 40, { forceUnlocked: true }), over: 'Achievement unlocked', title: a.name, sub: r.name + ' · ' + a.text,
          variant: 'ach' + (style === 'full' && ['rare', 'epic', 'legendary'].includes(a.rarity) ? ' pf-toast--shimmer' : ''), life: 3200 }));
      }
    }
    return steps;
  }

  // ── One celebration slot (v2-themes T7, SPEC-V2 E16) ──
  // A batch becomes at most two moments: the "+XP" capsule (its receipt goes to the caption)
  // and ONE more — the highest-priority event — whose card names the rest ("Also …").
  // Moments never overlap, 1.2 s apart, the batch ends within 6 s, nothing while focus runs.
  const PRIORITY = ['levelUp', 'goal', 'achievements', 'streak', 'sweep', 'personalBest', 'quest', 'restEarned', 'restUsed', 'welcomeBack'];
  function alsoLabel(ev) {
    switch (ev.type) {
      case 'levelUp': return 'Level ' + ev.to;
      case 'goal': return 'daily goal met';
      case 'achievements': return ev.list.length === 1 ? ev.list[0].name : ev.list.length + ' achievements';
      case 'streak': return ev.days + '-day streak';
      case 'sweep': return 'daily sweep';
      case 'personalBest': return 'a personal best';
      case 'quest': return 'quest done';
      case 'restEarned': return 'rest day earned';
      default: return '';
    }
  }
  function stepFor(ev, style) {
    switch (ev.type) {
      case 'quest':
        return toastStep({ icon: h('span', { class: 'pf-toast-emoji', text: ev.quest.emoji }), over: 'Quest complete',
          title: ev.quest.title + ' · +' + ev.quest.reward + ' XP', sub: ev.quest.text, variant: 'quest' });
      case 'sweep':
        return toastStep({ icon: h('span', { class: 'pf-toast-emoji', text: '🏆' }), over: 'Daily sweep', title: 'All three quests · +' + ev.bonus + ' XP',
          sub: 'Fresh quests at midnight', variant: 'quest' });
      case 'goal': return goalStep(ev, style);
      case 'levelUp': return levelStep(ev, style);
      case 'achievements': return achievementsStep(ev.list, style)[0];
      case 'streak':
        return toastStep({ icon: flameIcon('pf-toast-flame' + (style === 'full' ? ' is-bounce' : ''), ev.days), over: ev.days + '-day streak',
          title: STREAK_COPY[ev.days] || ev.days + ' days in a row.', variant: 'streak' });
      case 'restEarned':
        return toastStep({ icon: moonIcon('pf-toast-moon'), over: 'Rest day earned', title: 'Miss a day and your streak stays safe',
          sub: ev.bank + ' of 2 saved', variant: 'rest' });
      case 'restUsed':
        return toastStep({ icon: moonIcon('pf-toast-moon'), over: 'Rest day', title: 'Yesterday was a rest day — your ' + ev.streak + '-day streak is safe.', variant: 'rest' });
      case 'personalBest':
        return toastStep({ icon: h('span', { class: 'pf-toast-emoji', text: '🏆' }), over: 'New personal best', title: fmtMin(ev.minutes) + ' in a day',
          sub: 'Previous best ' + fmtMin(ev.previous), variant: 'quest' });
      case 'welcomeBack':
        return toastStep({ icon: h('span', { class: 'pf-toast-emoji', text: '🌱' }), over: 'Welcome back', title: 'Your journey picks up right where you left it.', variant: 'rest' });
      default: return null;   // combo is shown inside the XP receipt
    }
  }
  function stepsFor(events, fromCompletion) {
    const style = celebrationStyle();
    const mode = engagementMode();
    if (style === 'off' || mode === 'off') return [];
    const calmOk = new Set(['goal', 'streak', 'restEarned', 'restUsed', 'welcomeBack']);
    const allowed = events.filter((ev) => ev && (mode !== 'calm' || calmOk.has(ev.type)));
    const steps = [];
    const xp = allowed.find((ev) => ev.type === 'xp');
    if (xp) steps.push(xpStep(xp, fromCompletion, style));
    const rest = allowed.filter((ev) => PRIORITY.includes(ev.type))
      .sort((a, b) => PRIORITY.indexOf(a.type) - PRIORITY.indexOf(b.type));
    if (rest.length) {
      const top = stepFor(rest[0], style);
      if (top) {
        top.also = rest.slice(1).map(alsoLabel).filter(Boolean);
        steps.push(top);
      }
    }
    return steps;
  }

  function catchUpStep(next) {
    const n = next.achievements.filter((a) => a.unlocked).length;
    if (next.xp.level < 2 && n === 0) return null;
    return toastStep({ icon: badge(next.xp.level, 'pf-toast-badge'), over: 'Your journey so far',
      title: 'Your history already earned you Level ' + next.xp.level + ' · ' + n + ' achievement' + (n === 1 ? '' : 's'),
      sub: 'Open Reports to see your Journey', variant: 'level', life: 4600 }, 1600);
  }

  // Diff the baseline against the fresh state, present, and acknowledge.
  function check(reason) {
    if (!st) return;
    if (focusRunning()) { pendingReason = pendingReason || reason; scheduleCheck(1000); return; }
    const ack = loadAck();
    const next = st;
    const prev = reason === 'launch' || reason === 'launch-no-ack' ? null : basePrev;
    const fromCompletion = Date.now() - completionFlag < 4000;
    let events = E.diff(prev, next, ack);
    const r = !ack ? 'launch-no-ack' : reason;
    if (events.length) {
      if (E.isCatchUp(events, r)) {
        if (r === 'launch-no-ack' || r === 'import' || r === 'account') {
          const step = r === 'launch-no-ack' && celebrationStyle() !== 'off' && engagementMode() === 'full' ? catchUpStep(next) : null;
          if (step) enqueue([step]);
        } else {
          // big jump (≥2 levels / ≥4 achievements): one XP chip, one level moment, one combined toast
          const lv = events.find((e) => e.type === 'levelUp');
          const ach = events.find((e) => e.type === 'achievements');
          const xp = events.find((e) => e.type === 'xp');
          enqueue(stepsFor([xp, lv, ach].filter(Boolean), fromCompletion));
        }
      } else {
        enqueue(stepsFor(events, fromCompletion));
      }
    }
    saveAck(E.acknowledge(next, ack));
    basePrev = next;
    if (fromCompletion) completionFlag = 0;
  }
  function scheduleCheck(ms, reason) {
    if (reason) pendingReason = reason === 'import' || pendingReason === 'import' ? 'import' : reason;
    clearTimeout(checkTimer);
    checkTimer = setTimeout(() => { const rr = pendingReason || 'change'; pendingReason = null; check(rr); }, ms);
  }

  // ═════════════════════════ lifecycle ═════════════════════════
  function render() { renderHud(); renderSideGoal(); renderJourney(); }

  function refresh(opts) {
    if (!inited) return st;
    const changed = compute(!!(opts && opts.force));
    if (changed) render();
    scheduleCheck(opts && opts.immediate ? 0 : 250, opts && opts.reason);
    return st;
  }

  function scheduleMidnight() {
    clearTimeout(midnightTimer);
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
    midnightTimer = setTimeout(() => { refresh({ reason: 'day' }); scheduleMidnight(); }, Math.min(next - now, 2147483000));
  }

  function init() {
    if (inited) return;
    inited = true;
    try {
      compute(true);
      registerJourneyTab();
      render();
    } catch (err) { console.error('Rewards: initial render failed', err); }
    const ex = document.getElementById('rewards-explain');
    if (ex) ex.addEventListener('click', () => openExplainer(null, ex));

    Store.on('change', (ev) => {
      if (ev === 'remote') {
        // Synced changes from another device never celebrate live (SPEC-V2 E16): redraw, then acknowledge silently.
        if (compute(false)) { render(); if (!focusRunning()) { saveAck(E.acknowledge(st, loadAck())); basePrev = st; } }
        return;
      }
      if (ev === 'sessions' || ev === 'tasks' || ev === 'settings' || ev === 'reset' || ev === 'blocks' || ev === 'bulk') {
        const changed = compute(false);
        if (changed) render();
        else if (ev === 'settings') { renderHud(); renderSideGoal(); } // e.g. colour scheme / mode flips are cheap to redraw
        if (changed) scheduleCheck(250, ev === 'reset' ? 'import' : 'change');
      }
    });
    Store.on('focus:completed', () => {
      completionFlag = Date.now();
      compute(false);
      render();
      scheduleCheck(380, 'change');
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh({ reason: 'day' }); });
    window.addEventListener('pageshow', () => refresh({ reason: 'day' }));
    scheduleMidnight();
    // Present anything not yet acknowledged (or silently catch up a first run) once the app has settled.
    setTimeout(() => check(loadAck() ? 'launch' : 'launch-no-ack'), 900);
  }

  function state() { return st; }

  // Test hooks (W6 selftest): present synthetic engine events; peek at the queue.
  function _present(events, fromCompletion) { enqueue(stepsFor(events || [], !!fromCompletion)); }
  function _debug() { return { queue: queue.length, busy, toasts: myToasts.length }; }
  function celebrating() { return busy || queue.length > 0 || myToasts.length > 0; }

  return { init, state, refresh, setPlanProvider, addReceiptSuffix, registerHudRow, journeySlot, explain: openExplainer, celebrating, _present, _debug };
})();
