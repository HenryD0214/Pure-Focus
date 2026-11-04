/* ═══════════════════════════════════════════════════════════════════════
   friends.js — friends board, self card, See all / Add friend (owner: W1; v2-backend §8.5–§9.8)

   const Friends = {
     init()               mounts the Friends card into Rewards.journeySlot('friends'), registers
                          Rewards.addReceiptSuffix ("Passed Ben", once a day, opted in) and
                          Rewards.registerHudRow ("#3 of 6 friends this week ›"), handles #friend/<code>
     render()             redraws the card from the board cache (never fetches by itself)
     openSeeAll()         the See all sheet (480): This week | Last week · Focus | XP, Manage, New code
     openAddFriend(code?) the Add friend sheet (400): your code + link, add by code or pasted link
   }
   States of the card (§9.3): local-only → "This week" self card + "Compete with friends · Set up sync";
   configured + signed out → self card + "Sign in to see friends"; signed in, not competing → self card
   + Compete (bordered, consent popover); competing, no friends → self card + invite line; competing →
   "Friends · this week" with you ± 2 (windowRows), Focus | XP, See all ›; offline → cached rows + "Updated …".
   Calm by design: no motion at rest (bars grow once when first seen), nothing during focus, never
   "X passed you", no notifications. Remote names render via textContent only.
   ═══════════════════════════════════════════════════════════════════════ */

const Friends = (() => {
  'use strict';

  const R = () => CloudRef;
  const UI = () => CloudUI;
  const h = (...a) => CloudUI.h(...a);
  const put = (...a) => CloudUI.put(...a);
  const METRIC_KEY = () => pfKey('purefocus.board.metric');
  const PASSED_KEY = () => pfKey('purefocus.board.passedDay');
  const PENDING_KEY = 'purefocus.friend.pending';

  let root = null;
  let grown = false;
  let observer = null;

  function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }
  function metric() { return lsGet(METRIC_KEY()) === 'xp' ? 'xp' : 'minutes'; }
  function focusRunning() {
    try { return typeof Timer !== 'undefined' && Timer.isRunning && Timer.isRunning() && Timer.mode && Timer.mode() === 'focus'; } catch (_) { return false; }
  }
  function toast(m, v) { try { App.toast(m, v); } catch (_) {} }

  function fmtMin(m) {
    m = Math.max(0, Math.round(m || 0));
    if (m < 60) return m + 'm';
    const hh = Math.floor(m / 60), r = m % 60;
    return hh + 'h' + (r ? ' ' + r + 'm' : '');
  }
  function fmtVal(row, met) { return met === 'xp' ? Math.round(row.xp).toLocaleString() : fmtMin(row.minutes); }
  function fmtCode(c) { return c ? c.slice(0, 4) + '-' + c.slice(4) : ''; }

  // ───────────────────────────── state ─────────────────────────────
  function boardState() {
    if (!Cloud.isConfigured()) return 'local';
    if (!Cloud.isSignedIn()) return 'signedOut';
    const p = Cloud.profile();
    if (!p || !p.lbOptIn) return 'notCompeting';
    const c = Cloud.cachedBoard();
    if (!c || c.week !== Cloud.currentWeek()) return 'loading';
    const others = c.rows.filter((r) => !r.isMe);
    if (!others.length && !(c.rows[0] && c.rows[0].hiddenFriends)) return 'noFriends';
    return 'board';
  }
  function meRow(rows) { return rows.find((r) => r.isMe) || null; }
  function ranked(rows, met) { return R().rankRows(rows, met === 'xp' ? 'xp' : 'minutes'); }

  // ───────────────────────────── self card (§9.4) ─────────────────────────────
  function selfCard() {
    let sc;
    try {
      const fm = Number(Store.settings().focusMinutes) || 25;
      sc = R().selfCompare(Store.sessions() || [], new Date(), { focusMinutes: fm });
    } catch (_) { return null; }
    const tw = sc.thisWeek.minutes, lw = sc.lastWeekSoFar.minutes;
    const max = Math.max(tw, lw, 1);
    const row = (label, val, cls) => h('div', { class: 'pfc-self-row' },
      h('span', { class: 'pfc-self-lab', text: label }),
      h('span', { class: 'pfc-self-bar ' + cls, role: 'presentation' }, h('span', { style: { width: (val > 0 ? Math.max(2, (val / max) * 100) : 0).toFixed(1) + '%' } })),
      h('span', { class: 'pfc-self-val', text: fmtMin(val) }));
    return h('div', { class: 'pfc-self' },
      row('This week', tw, 'is-this'),
      row('Last week by now', lw, 'is-last'),
      h('p', { class: 'pfc-self-copy' }, h('span', { text: sc.copy }),
        sc.bestWeek ? h('span', { class: 'pfc-chip' }, UI().icon('sparkles', 'pfc-ic pfc-ic-11'), 'Best week yet') : null));
  }

  // ───────────────────────────── board rows ─────────────────────────────
  function rowEl(r, max, met, opts) {
    const val = met === 'xp' ? r.xp : r.minutes;
    const pct = max > 0 ? Math.max(val > 0 ? 3 : 0, (val / max) * 100) : 0;
    const delta = met === 'minutes' && r.lastWeekMinutes != null ? r.minutes - r.lastWeekMinutes : 0;
    const name = r.isMe ? 'You' : r.displayName;
    const li = h('li', { class: 'pfc-fr-row' + (r.isMe ? ' is-me' : '') + (opts && opts.menu ? ' has-menu' : ''),
      'aria-label': `${r.rank}. ${name}, ${fmtVal(r, met)}${met === 'xp' ? ' XP' : ''}` },
    h('span', { class: 'pfc-fr-rank', text: String(r.rank) }),
    UI().avatar({ name: r.displayName, hue: r.avatarHue, size: 24 }),
    h('span', { class: 'pfc-fr-name', text: name }),
    h('span', { class: 'pfc-fr-bar', 'aria-hidden': 'true' }, h('span', { style: { width: pct.toFixed(1) + '%' } })),
    h('span', { class: 'pfc-fr-val', text: fmtVal(r, met) }),
    h('span', { class: 'pfc-fr-delta', text: delta > 0 ? '+' + fmtMin(delta) : '' }),      // gains only: never loss framing
    opts && opts.menu ? opts.menu(r) : null);
    return li;
  }
  function rowsList(rows, met, opts) {
    const max = Math.max(1, ...rows.map((r) => (met === 'xp' ? r.xp : r.minutes)));
    return h('ul', { class: 'pfc-fr-rows' }, rows.map((r) => rowEl(r, max, met, opts)));
  }
  function segmented(options, value, onPick, label) {
    return h('div', { class: 'pfc-seg', role: 'group', 'aria-label': label }, options.map(([v, t]) =>
      h('button', { type: 'button', 'aria-pressed': String(v === value), on: { click: () => onPick(v) } }, t)));
  }

  // ───────────────────────────── the card ─────────────────────────────
  function render() {
    if (!root) return;
    const state = boardState();
    const card = h('section', { class: 'pf-j-panel pfc-fr' + (grown ? '' : ' is-waiting'), 'aria-label': 'Friends this week', id: 'pfc-friends-card' });
    const met = metric();
    if (state === 'board') {
      const c = Cloud.cachedBoard();
      const rk = ranked(c.rows, met);
      const me = meRow(rk);
      const win = R().windowRows(rk, me ? me.userId : null);
      put(card, 
        h('div', { class: 'pfc-fr-head' },
          h('h3', { class: 'pfc-fr-title', text: 'Friends · this week' }),
          segmented([['minutes', 'Focus'], ['xp', 'XP']], met, (v) => { lsSet(METRIC_KEY(), v); render(); }, 'Board metric'),
          h('button', { type: 'button', class: 'pfc-textbtn pfc-fr-see', on: { click: openSeeAll } }, 'See all ›')),
        rowsList(win, met),
        footer(c, rk));
    } else {
      put(card, h('div', { class: 'pfc-fr-head' }, h('h3', { class: 'pfc-fr-title', text: 'This week' })));
      const self = selfCard();
      if (self) card.appendChild(self);
      card.appendChild(ctaFor(state));
    }
    root.replaceChildren(card);
    watchGrow(card);
  }

  function footer(c, rk) {
    const bits = [h('span', { text: 'Resets Monday' })];
    const hidden = (rk[0] && rk[0].hiddenFriends) || 0;
    if (hidden > 0) bits.push(h('span', { text: hidden === 1 ? '1 friend isn’t competing' : hidden + ' friends aren’t competing' }));
    if (new Date().getDay() === 1 && c.lastWeek && Array.isArray(c.lastWeek.rows) && c.lastWeek.rows.length > 1) {
      const lr = ranked(c.lastWeek.rows, 'minutes');
      const me = meRow(lr);
      if (me) bits.push(h('span', { text: 'Last week you finished #' + me.rank + ' of ' + lr.length }));
    }
    const age = Date.now() - c.fetchedAt;
    if (Cloud.status().state === 'offline' || age > 30 * 60000) bits.push(h('span', { text: 'Updated ' + CloudUI.ago(c.fetchedAt) }));
    const out = h('div', { class: 'pfc-fr-foot' });
    bits.forEach((b, i) => { if (i) out.appendChild(h('span', { 'aria-hidden': 'true', text: '·' })); out.appendChild(b); });
    return out;
  }

  function ctaFor(state) {
    const wrap = h('div', { class: 'pfc-fr-cta' });
    if (state === 'local') {
      wrap.classList.add('pfc-fr-foot');
      put(wrap, h('span', { text: 'Compete with friends' }), h('span', { 'aria-hidden': 'true', text: '·' }),
        h('button', { type: 'button', class: 'pfc-textbtn is-strong', on: { click: () => Cloud.openSheet('A') } }, 'Set up sync'));
    } else if (state === 'signedOut') {
      put(wrap, h('button', { type: 'button', class: 'pfc-textbtn', on: { click: () => Cloud.openSheet('B') } }, 'Sign in to see friends'));
    } else if (state === 'notCompeting') {
      const btn = h('button', { type: 'button', class: 'btn btn-sm' }, 'Compete with friends');
      btn.addEventListener('click', async () => {
        if (!Cloud.profile()) { toast('Still connecting. Try again in a moment.'); return; }
        const yes = await CloudUI.confirmCompete(btn);
        if (!yes) return;
        try { await Cloud.updateProfile({ lbOptIn: true }); await Cloud.board(null, { force: true }); } catch (_) { toast('Couldn’t turn that on. Try again.'); }
        render();
      });
      put(wrap, btn, h('span', { class: 'pf-dim', text: 'Weekly focus time and XP, shown only to friends you add.' }));
    } else if (state === 'noFriends') {
      const p = Cloud.profile();
      put(wrap, h('span', null, 'Invite a friend with your code ', h('span', { class: 'pfc-strong pfc-tab', text: fmtCode(p && p.friendCode) })),
        h('button', { type: 'button', class: 'pfc-textbtn', on: { click: () => CloudUI.copy(Cloud.shareLink(), 'Link copied') } }, 'Copy link'),
        h('button', { type: 'button', class: 'pfc-textbtn', on: { click: () => openAddFriend() } }, 'Add friend…'));
    } else {
      put(wrap, h('span', { class: 'pf-dim', text: 'Loading your friends…' }));
    }
    return wrap;
  }

  /* Bars grow once when the card first scrolls into view (400 ms; Reduce Motion: none). */
  function watchGrow(card) {
    if (observer) { observer.disconnect(); observer = null; }
    if (grown) return;
    if (typeof IntersectionObserver === 'undefined') { grown = true; card.classList.remove('is-waiting'); return; }
    observer = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      observer.disconnect(); observer = null;
      card.classList.replace('is-waiting', 'is-growing');
      grown = true;
      refreshIfStale();
    });
    observer.observe(card);
  }

  /* Journey opened (or the HUD popover): fetch the board at most once per 5 min. */
  function refreshIfStale() {
    if (!Cloud.isSignedIn()) return;
    const p = Cloud.profile();
    if (!p || !p.lbOptIn) return;
    Cloud.board().then(() => render()).catch(() => {});
  }

  // ───────────────────────────── See all (§9.5) ─────────────────────────────
  function openSeeAll() {
    let week = 'this', met = metric(), manage = false;
    CloudUI.sheet({ title: 'Friends', width: 480, build: (body) => {
      const list = h('div', { class: 'pfc-seeall-list' });
      const bar = h('div', { class: 'pfc-seeall-bar' });
      const foot = h('div', { class: 'pfc-sheet-foot' });
      const confirmHost = h('div');
      async function draw() {
        bar.replaceChildren(
          segmented([['this', 'This week'], ['last', 'Last week']], week, (v) => { week = v; draw(); }, 'Week'),
          segmented([['minutes', 'Focus'], ['xp', 'XP']], met, (v) => { met = v; lsSet(METRIC_KEY(), v); draw(); render(); }, 'Metric'));
        list.replaceChildren(h('p', { class: 'pfc-empty', text: 'Loading…' }));
        let rows = [];
        try {
          rows = week === 'this' ? await Cloud.board() : await Cloud.board(R().addDays(Cloud.currentWeek(), -7));
        } catch (_) { const c = Cloud.cachedBoard(); rows = c ? c.rows : []; }
        let friendsList = [];
        if (manage) { try { friendsList = await Cloud.friends(); } catch (_) { friendsList = []; } }
        const rk = ranked(rows, met);
        const menu = manage ? (r) => (r.isMe ? h('span') : removeButton(r, confirmHost, draw)) : null;
        list.replaceChildren(rk.length ? rowsList(rk, met, { menu }) : h('p', { class: 'pfc-empty', text: 'No one here yet.' }));
        if (manage) {
          const shown = new Set(rk.map((r) => r.userId));
          const others = friendsList.filter((f) => !shown.has(f.userId));
          if (others.length) {
            list.appendChild(h('p', { class: 'pfc-addf-label', text: 'Not competing' }));
            list.appendChild(h('ul', { class: 'pfc-fr-rows' }, others.map((f) => h('li', { class: 'pfc-fr-row has-menu' },
              h('span'), UI().avatar({ name: f.displayName, hue: f.avatarHue, size: 24 }), h('span', { class: 'pfc-fr-name', text: f.displayName }),
              h('span'), h('span'), h('span'), removeButton({ userId: f.userId, displayName: f.displayName }, confirmHost, draw)))));
          }
        }
        foot.replaceChildren();
        put(foot,
          h('button', { type: 'button', class: 'pfc-textbtn', 'aria-expanded': String(manage), on: { click: () => { manage = !manage; draw(); } } }, manage ? 'Done' : 'Manage ▸'),
          manage ? h('button', { type: 'button', class: 'pfc-textbtn', on: { click: () => newCode(confirmHost, draw) } }, 'New code') : null,
          h('span', { class: 'pfc-flex' }),
          h('button', { type: 'button', class: 'btn btn-sm', on: { click: () => openAddFriend() } }, 'Add friend…'));
      }
      const self = selfCard();
      put(body, self || h('span'), h('hr', { class: 'pfc-hair' }), bar, list, confirmHost, foot);
      draw();
    } });
  }
  function removeButton(r, host, after) {
    const b = h('button', { type: 'button', class: 'pfc-iconbtn', 'aria-label': 'Remove ' + r.displayName }, UI().icon('more'));
    b.addEventListener('click', () => {
      host.replaceChildren(confirmLine('Remove ' + r.displayName + '? You’ll both stop seeing each other.', 'Remove', async () => {
        await Cloud.removeFriend(r.userId); host.replaceChildren(); after(); render();
      }, host));
    });
    return b;
  }
  function newCode(host, after) {
    host.replaceChildren(confirmLine('Your old code stops working.', 'New code', async () => {
      await Cloud.regenerateCode(); host.replaceChildren(); after(); render(); toast('New code ready');
    }, host));
  }
  function confirmLine(text, label, run, host) {
    const yes = h('button', { type: 'button', class: 'btn btn-sm' }, label);
    yes.addEventListener('click', async () => { yes.disabled = true; try { await run(); } catch (_) { toast('That didn’t work. Try again.'); yes.disabled = false; } });
    const box = h('div', { class: 'pfc-confirm' }, h('p', { text }),
      h('div', { class: 'pfc-row-actions' }, h('button', { type: 'button', class: 'pfc-textbtn', on: { click: () => host.replaceChildren() } }, 'Cancel'), yes));
    setTimeout(() => yes.focus(), 0);
    return box;
  }

  // ───────────────────────────── Add friend (§9.5) ─────────────────────────────
  const ADD_COPY = {
    added: (n) => 'Added ' + n + '. You’ll see each other once you both compete.',
    already: () => 'You’re already friends.',
    bad_code: () => 'Codes look like K7Q2-M9XD.',
    no_such_code: () => 'No one has that code. Check it with your friend.',
    own_code: () => 'That’s your own code.',
    too_many_friends: () => 'You’ve reached 50 friends.',
    rate_limited: () => 'Too many tries. Try again in an hour.',
  };
  function openAddFriend(prefill) {
    if (!Cloud.isConfigured()) { openNoSync(); return; }
    if (!Cloud.isSignedIn()) {
      if (prefill) { try { sessionStorage.setItem(PENDING_KEY, prefill); } catch (_) {} }
      Cloud.openSheet('B');
      return;
    }
    CloudUI.sheet({ title: 'Add friend', width: 400, build: (body) => {
      const p = Cloud.profile();
      const result = h('div', { 'aria-live': 'polite' });
      const inp = h('input', { type: 'text', class: 'pfc-input', placeholder: 'XXXX-XXXX', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false',
        'aria-label': 'Friend code or link', maxlength: '200' });
      const add = h('button', { type: 'button', class: 'btn btn-sm pfc-btn-36' }, 'Add');
      const format = () => {
        const n = R().normalizeFriendCode(inp.value);
        if (n) { inp.value = fmtCode(n); return; }
        if (/#friend\//.test(inp.value) || inp.value.length > 12) return;
        const raw = inp.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8);
        inp.value = raw.length > 4 ? raw.slice(0, 4) + '-' + raw.slice(4) : raw;
      };
      inp.addEventListener('input', format);
      const go = async () => {
        result.replaceChildren();
        add.disabled = true;
        try {
          const r = await Cloud.addFriend(inp.value);
          const msg = (ADD_COPY[r.status] || ADD_COPY.no_such_code)((r.friend && r.friend.displayName) || 'your friend');
          result.appendChild(h('p', { class: 'pfc-line ' + (r.status === 'added' ? 'pfc-line--ok' : ''), text: msg }));
          if (r.status === 'added') { inp.value = ''; Cloud.board(null, { force: true }).then(render).catch(() => {}); render(); }
        } catch (e) { result.appendChild(h('p', { class: 'pfc-line', text: e && e.code === 'network' ? 'Can’t reach your project. Try again when you’re online.' : 'That didn’t work. Try again in a moment.' })); }
        add.disabled = false;
      };
      add.addEventListener('click', go);
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
      if (prefill) { inp.value = prefill; format(); }
      put(body, 
        h('div', { class: 'pfc-addf-sec' },
          h('span', { class: 'pfc-addf-label', text: 'Your code' }),
          h('span', { class: 'pfc-addf-code', text: p ? fmtCode(p.friendCode) : '…' }),
          h('div', { class: 'pfc-row-actions' },
            h('button', { type: 'button', class: 'pfc-textbtn', on: { click: () => CloudUI.copy(Cloud.shareLink(), 'Link copied') } }, 'Copy link'),
            h('button', { type: 'button', class: 'pfc-textbtn', on: { click: () => CloudUI.copy(p ? fmtCode(p.friendCode) : '', 'Code copied') } }, 'Copy code'))),
        h('hr', { class: 'pfc-hair' }),
        h('div', { class: 'pfc-addf-sec' },
          h('span', { class: 'pfc-addf-label', text: 'Add a friend' }),
          h('div', { class: 'pfc-addf-row' }, inp, add)),
        result,
        p && !p.lbOptIn ? h('p', { class: 'pfc-note pfc-small', text: 'You’ll see friends on your board once you turn on Compete with friends.' }) : null);
      setTimeout(() => { try { (prefill ? add : inp).focus(); } catch (_) {} }, 0);
    } });
  }
  function openNoSync() {
    CloudUI.sheet({ title: 'Compete with friends', width: 400, build: (body, api) => {
      put(body, h('p', { class: 'pfc-note', text: 'Your friend uses Pure Focus sync. Set up sync to compete.' }),
        h('div', { class: 'pfc-sheet-foot' },
          h('button', { type: 'button', class: 'pfc-textbtn', on: { click: () => api.close() } }, 'Not now'),
          h('button', { type: 'button', class: 'btn btn-sm', on: { click: () => { api.close(); Cloud.openSheet('A'); } } }, 'Set up sync')));
    } });
  }

  // ───────────────────────────── subtle pulls (§9.7) ─────────────────────────────
  /* XP receipt: "Passed Ben" (or "Passed Ben +1") at most once a day, only upward, only opted in. */
  function passedSuffix(sess) {
    try {
      if (!Cloud.isSignedIn()) return null;
      const p = Cloud.profile();
      if (!p || !p.lbOptIn) return null;
      const today = R().dayKey(new Date());
      if (lsGet(PASSED_KEY()) === today) return null;
      const c = Cloud.cachedBoard();
      if (!c || c.week !== Cloud.currentWeek() || c.rows.length < 2) return null;
      const me = meRow(c.rows);
      if (!me) return null;
      const sessions = Store.sessions() || [];
      const lastID = sess && sess.id ? String(sess.id).toLowerCase() : null;
      const latest = lastID ? sessions.find((s) => String(s.id).toLowerCase() === lastID) : sessions.filter((s) => s.mode === 'focus').slice(-1)[0];
      const without = latest ? sessions.filter((s) => s !== latest) : sessions;
      const nowMs = Date.now();
      const before = R().weekStats(without, c.week, { nowMs }).minutes;
      const after = R().weekStats(sessions, c.week, { nowMs }).minutes;
      if (after <= before) return null;
      // Friends' numbers come from the cached board (no network wait); yours from this device, before vs after.
      const rowsWith = (mins) => R().rankRows(c.rows.map((r) => (r.isMe ? { ...r, minutes: mins } : r)), 'minutes');
      const names = R().passedFriends(rowsWith(before), rowsWith(after), me.userId);
      if (!names.length) return null;
      lsSet(PASSED_KEY(), today);
      return 'Passed ' + names[0] + (names.length > 1 ? ' +' + (names.length - 1) : '');
    } catch (_) { return null; }
  }

  /* HUD badge popover: "#3 of 6 friends this week ›" (opted in, ≥ 1 friend; reads the cache). */
  function hudRow() {
    try {
      if (focusRunning() || !Cloud.isSignedIn()) return null;
      const p = Cloud.profile();
      const c = Cloud.cachedBoard();
      if (!p || !p.lbOptIn || !c || c.week !== Cloud.currentWeek() || c.rows.length < 2) return null;
      refreshIfStale();
      const rk = ranked(c.rows, 'minutes');
      const me = meRow(rk);
      if (!me) return null;
      return h('button', { type: 'button', class: 'pfc-hud-friends', on: { click: () => openJourney(true) } },
        '#' + me.rank + ' of ' + rk.length + ' friends this week ›');
    } catch (_) { return null; }
  }

  function openJourney(scroll) {
    try { App.showView('reports'); } catch (_) {}
    const tab = document.querySelector('#report-tab-switch .seg-btn[data-rtab="journey"]');
    if (tab && tab.getAttribute('aria-selected') !== 'true') tab.click();
    if (scroll) setTimeout(() => { const el = document.getElementById('pfc-friends-card'); if (el) el.scrollIntoView({ block: 'center', behavior: 'auto' }); }, 60);
  }

  // ───────────────────────────── routes (§9.8) ─────────────────────────────
  function route() {
    const m = (location.hash || '').match(/^#friend\/([0-9A-Za-z-]{4,20})$/);
    if (!m) return;
    const code = m[1];
    try { history.replaceState(null, '', location.pathname + location.search + '#reports/journey'); } catch (_) {}
    openJourney(true);
    openAddFriend(code);
  }
  function resumePending() {
    let code = null;
    try { code = sessionStorage.getItem(PENDING_KEY); sessionStorage.removeItem(PENDING_KEY); } catch (_) { code = null; }
    if (code && Cloud.isSignedIn()) setTimeout(() => openAddFriend(code), 400);
  }

  // ───────────────────────────── init ─────────────────────────────
  let inited = false;
  function init() {
    if (inited) return;
    inited = true;
    try {
      root = Rewards.journeySlot('friends');
      Rewards.addReceiptSuffix(passedSuffix);
      Rewards.registerHudRow(hudRow);
    } catch (err) { console.error('Friends: hooks failed', err); }
    render();
    Cloud.on('board', () => render());
    Cloud.on('profile', () => render());
    Cloud.on('user', (u) => { render(); if (u) resumePending(); });
    let lastState = boardState();
    Cloud.on('status', () => { const s = boardState(); if (s !== lastState) { lastState = s; render(); } });
    try {
      Store.on('change', (ev) => { if (['sessions', 'remote', 'reset', 'bulk'].includes(ev) && boardState() !== 'board') render(); });
    } catch (_) {}
    // Opening Reports › Journey refreshes a stale board (stale-while-revalidate).
    document.addEventListener('click', (e) => {
      const t = e.target && e.target.closest && e.target.closest('#report-tab-switch .seg-btn[data-rtab="journey"]');
      if (t) setTimeout(refreshIfStale, 0);
    });
    window.addEventListener('hashchange', route);
    if (/^#reports\/journey$/.test(location.hash || '')) setTimeout(() => openJourney(false), 0);
    setTimeout(route, 0);
  }

  return { init, render, openSeeAll, openAddFriend, _passedSuffix: passedSuffix, _hudRow: hudRow };
})();
