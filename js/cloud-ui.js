/* ═══════════════════════════════════════════════════════════════════════
   cloud-ui.js — Account card rows and the Sync sheet (owner: W1; v2-backend §9.1–§9.2, §9.6, §9.8)

   const CloudUI = {
     init()            registers the Account card (Settings › Calendar & Accounts, order 10):
                       Identity · Sync across devices · Compete with friends; handles #settings/accounts
     openSheet(state?) the Sync sheet: 'A' connect · 'A2' setup needed · 'B' sign in · 'C' signed in ·
                       'reset' set a new password · 'merge' bring guest data in (default: the state that fits)
     confirmCompete(anchor) → Promise<bool>   the opt-in consent popover (§9.6), shared with friends.js
     sheet({title, width, build, onClose}) / popover(anchor, build) / copy(text, toast) / avatar(...) / icon(name)
                       small UI helpers friends.js reuses (no innerHTML; remote strings via textContent)
   }
   Placement rules: no toolbar controls; nothing animates at rest; no red (attention is a neutral glyph);
   the sheet's one filled button is Connect (A) · Continue with Google (B) · Check again (A2).
   ═══════════════════════════════════════════════════════════════════════ */

const CloudUI = (() => {
  'use strict';

  // ───────────────────────────── DOM helpers ─────────────────────────────
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'on') { for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn); }
        else if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const c of kids.flat()) {
      if (c == null || c === false) continue;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return el;
  }
  /* Null-safe append (native Element.append would print "null" for optional children). */
  function put(parent, ...kids) {
    for (const c of kids.flat()) if (c != null && c !== false) parent.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return parent;
  }
  const ICONS = {
    sync: 'M3.5 9.2a6.5 6.5 0 0 1 11.4-3.6M16.5 10.8a6.5 6.5 0 0 1-11.4 3.6M15.4 2.8v3.2h-3.2M4.6 17.2V14h3.2',
    chevron: 'M8 5l5 5-5 5',
    more: 'M5 10h.01M10 10h.01M15 10h.01',
    personPlus: 'M8.2 9.3a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2.8 16.8c.7-2.9 2.8-4.4 5.4-4.4 1.2 0 2.3.3 3.2 1M15.2 11.6v5M12.7 14.1h5',
    alert: 'M10 17.2a7.2 7.2 0 1 0 0-14.4 7.2 7.2 0 0 0 0 14.4zM10 6.4v4.4M10 13.6h.01',
    check: 'M4.5 10.5l3.6 3.6L15.5 6.5',
    copy: 'M7.5 7.5h8v9h-8zM4.5 12.5v-9h8',
    external: 'M11.5 3.5h5v5M16.5 3.5l-7 7M14.5 11.5v3.3a1.7 1.7 0 0 1-1.7 1.7H5.2a1.7 1.7 0 0 1-1.7-1.7V7.2a1.7 1.7 0 0 1 1.7-1.7h3.3',
    pencil: 'M12.6 4.4l3 3L7.4 15.6H4.4v-3zM11 6l3 3',
    close: 'M5.5 5.5l9 9M14.5 5.5l-9 9',
    user: 'M10 9.8a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM3.8 16.6c.9-3 3.4-4.6 6.2-4.6s5.3 1.6 6.2 4.6',
    sparkles: 'M10 3l1.4 3.6L15 8l-3.6 1.4L10 13l-1.4-3.6L5 8l3.6-1.4zM15.5 13l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z',
  };
  function icon(name, cls) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('class', cls || 'pfc-ic');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.6');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', ICONS[name] || '');
    svg.appendChild(p);
    return svg;
  }
  function toast(msg, variant) { try { if (typeof App !== 'undefined' && App.toast) App.toast(msg, variant); } catch (_) {} }

  function initials(name) {
    const words = String(name || '?').replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
    const picks = words.length > 1 ? [words[0], words[words.length - 1]] : [words[0] || '?'];
    return picks.map((w) => Array.from(w)[0] || '').join('').toUpperCase() || '?';
  }
  function hueOf(str) { let x = 0x811c9dc5; for (const ch of String(str || '')) { x ^= ch.charCodeAt(0); x = Math.imul(x, 0x01000193) >>> 0; } return x % 360; }
  /* Avatar: the photo (https only) or initials on hsl(hue 55% 45%) (v2-backend §9.1). */
  function avatar({ name, hue, picture, size }) {
    const s = size || 36;
    const el = h('span', { class: 'pfc-av', 'aria-hidden': 'true', style: { width: s + 'px', height: s + 'px', fontSize: Math.round(s * 0.36) + 'px',
      background: `hsl(${Number.isFinite(hue) ? hue : hueOf(name)} 55% 45%)` } }, initials(name));
    if (picture && /^https:\/\//i.test(picture)) {
      const img = h('img', { alt: '', referrerpolicy: 'no-referrer', decoding: 'async', draggable: 'false' });
      img.addEventListener('error', () => img.remove());
      img.src = picture;
      el.appendChild(img);
    }
    return el;
  }
  function maskEmail(e) {
    const m = String(e || '').match(/^(.)([^@]*)@(.+)$/);
    return m ? m[1] + '…@' + m[3] : '';
  }
  function ago(ms) {
    if (!ms) return '';
    const min = Math.round((Date.now() - ms) / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return min + ' min ago';
    const hr = Math.round(min / 60);
    if (hr < 24) return hr + ' h ago';
    return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  function refShort(cfg) {
    if (!cfg) return '';
    if (cfg.provider === 'supabase') { const r = cfg.projectRef || ''; return 'project ' + r.slice(0, 4) + '…' + r.slice(-4); }
    return cfg.projectId;
  }
  function providerName(p) { return p === 'firebase' ? 'Firebase' : 'Supabase'; }

  async function copy(text, okMsg) {
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (_) {
      try {
        const ta = h('textarea', { style: { position: 'fixed', opacity: '0', top: '0', left: '0' } });
        ta.value = text; document.body.appendChild(ta); ta.select(); ok = document.execCommand('copy'); ta.remove();
      } catch (_) { ok = false; }
    }
    toast(ok ? okMsg : 'Couldn’t copy. Select and copy it by hand.', ok ? 'success' : '');
    return ok;
  }
  async function copyFile(path, okMsg) {
    try {
      const res = await fetch(path, { cache: 'no-cache' });
      if (!res.ok) throw new Error(String(res.status));
      return copy(await res.text(), okMsg);
    } catch (_) { toast('Couldn’t read ' + path + '. Open it from the site folder instead.'); return false; }
  }

  // ───────────────────────────── sheet + popover ─────────────────────────────
  let openSheetRef = null;
  /* sheet({title, width, build(body, api), onClose, label}) → api {el, body, close(), setTitle(t)} */
  function sheet({ title, width, build, onClose, label }) {
    if (openSheetRef) openSheetRef.close(true);
    const prevFocus = document.activeElement;
    const backdrop = h('div', { class: 'pfc-sheet-backdrop' });
    const titleEl = h('h2', { class: 'pfc-sheet-title', id: 'pfc-sheet-title', text: title || '' });
    const closeBtn = h('button', { type: 'button', class: 'pfc-sheet-x', 'aria-label': 'Close' }, icon('close'));
    const body = h('div', { class: 'pfc-sheet-body' });
    const el = h('div', { class: 'pfc-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'pfc-sheet-title',
      'aria-label': label || null, style: { width: `min(${width || 560}px, calc(100vw - 24px))` } },
    h('div', { class: 'pfc-sheet-head' }, titleEl, closeBtn), body);
    const api = {
      el, body,
      setTitle(t) { titleEl.textContent = t; },
      close(silent) {
        if (!el.isConnected) return;
        document.removeEventListener('keydown', onKey, true);
        el.remove(); backdrop.remove();
        if (openSheetRef === api) openSheetRef = null;
        if (!silent && typeof onClose === 'function') { try { onClose(); } catch (_) {} }
        if (prevFocus && prevFocus.isConnected && prevFocus.focus) { try { prevFocus.focus({ preventScroll: true }); } catch (_) {} }
      },
    };
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); api.close(); return; }
      if (e.key !== 'Tab') return;
      const f = Array.from(el.querySelectorAll('button, [href], input, textarea, select, summary, [tabindex]:not([tabindex="-1"])'))
        .filter((n) => !n.disabled && n.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    closeBtn.addEventListener('click', () => api.close());
    backdrop.addEventListener('pointerdown', () => api.close());
    document.addEventListener('keydown', onKey, true);
    document.body.append(backdrop, el);
    openSheetRef = api;
    build(body, api);
    const first = el.querySelector('[autofocus]') || el.querySelector('input, textarea') || closeBtn;
    try { first.focus({ preventScroll: true }); } catch (_) {}
    return api;
  }

  let openPop = null;
  /* popover(anchor, build(el, close), {width}) — anchored, closes on outside click / Esc. */
  function popover(anchor, build, opts) {
    if (openPop) openPop.close();
    const el = h('div', { class: 'pfc-pop', role: 'dialog', style: { width: ((opts && opts.width) || 320) + 'px' } });
    const close = () => {
      if (!el.isConnected) return;
      el.remove();
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('resize', close);
      if (openPop && openPop.el === el) openPop = null;
      if (anchor && anchor.isConnected && anchor.focus) { try { anchor.focus({ preventScroll: true }); } catch (_) {} }
    };
    const outside = (e) => { if (!el.contains(e.target) && !(anchor && anchor.contains(e.target))) close(); };
    const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
    build(el, close);
    document.body.appendChild(el);
    const r = anchor.getBoundingClientRect();
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    const w = el.offsetWidth, ht = el.offsetHeight;
    let left = Math.min(Math.max(12, r.left + r.width / 2 - w / 2), vw - w - 12);
    let top = r.bottom + 8;
    if (top + ht > vh - 12 && r.top - ht - 8 > 12) top = r.top - ht - 8;
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';
    setTimeout(() => {
      document.addEventListener('pointerdown', outside, true);
      document.addEventListener('keydown', key, true);
      window.addEventListener('resize', close);
    }, 0);
    const f = el.querySelector('button, input');
    if (f) try { f.focus({ preventScroll: true }); } catch (_) {}
    openPop = { el, close };
    return { el, close };
  }

  /* §9.6 opt-in consent: Not now (text) · Compete (bordered). Resolves true when the user competes. */
  function confirmCompete(anchor) {
    return new Promise((resolve) => {
      let answered = false;
      const pop = popover(anchor, (el, close) => {
        el.classList.add('pfc-consent');
        el.append(
          h('p', { class: 'pfc-consent-text', text: 'Friends you add will see your display name, weekly focus time, sessions, active days and XP. Never your tasks, notes, calendar, courses, apps or sites. You can stop any time.' }),
          h('div', { class: 'pfc-consent-actions' },
            h('button', { type: 'button', class: 'pfc-textbtn', on: { click: () => { answered = true; close(); resolve(false); } } }, 'Not now'),
            h('button', { type: 'button', class: 'btn btn-sm', on: { click: () => { answered = true; close(); resolve(true); } } }, 'Compete')));
      });
      const obs = new MutationObserver(() => { if (!pop.el.isConnected) { obs.disconnect(); if (!answered) resolve(false); } });
      obs.observe(document.body, { childList: true });
    });
  }

  // ───────────────────────────── Account card (§9.1) ─────────────────────────────
  let cardRoot = null;
  let editingName = false;

  function googleUser() { try { return typeof GoogleSync !== 'undefined' && GoogleSync.user ? GoogleSync.user() : null; } catch (_) { return null; } }

  function syncStatusText() {
    const s = Cloud.status();
    if (Cloud.siteError()) return { text: 'Needs attention', attention: true };
    switch (s.state) {
      case 'off': return { text: 'Not set up' };
      case 'needsSignIn': return { text: 'Sign in to sync' };
      case 'connecting': case 'syncing': return { text: 'Syncing…' };
      case 'upToDate': return { text: 'Up to date' + (s.lastSyncAt ? ' · ' + ago(s.lastSyncAt) : '') };
      case 'offline': return { text: 'Offline' + (s.pending ? ' · ' + s.pending + ' waiting' : '') };
      case 'attention': return { text: 'Needs attention', attention: true };
      default: return { text: '' };
    }
  }

  function identityRow() {
    const u = Cloud.user();
    const prof = Cloud.profile();
    const cur = Profile.current();
    const g = googleUser();
    let name, sub, picture = null, hue, trailing;
    if (u) {
      name = (prof && prof.displayName) || u.displayName || (cur && cur.name) || 'You';
      sub = 'Pure Focus cloud · ' + maskEmail(u.email);
      picture = u.picture || (cur && cur.picture);
      hue = prof ? prof.avatarHue : undefined;
      trailing = moreButton([{ label: 'Sign out', run: () => Cloud.signOut().then(() => toast('Signed out. Your data stays on this device.')) }]);
    } else if (cur) {
      name = cur.name || 'You';
      sub = Cloud.isConfigured() ? 'Signed out · data stays on this device' : 'This device · not syncing';
      picture = cur.picture;
      trailing = Cloud.isConfigured() ? signInButton()
        : moreButton([{ label: 'Switch to guest', run: () => { Profile.setCurrent(null); render(); } }]);
    } else if (g) {
      name = g.name || 'You';
      sub = 'Google · ' + maskEmail(g.email);
      picture = g.picture;
      trailing = Cloud.isConfigured() ? signInButton()
        : moreButton([{ label: 'Sign out of Google', run: () => { try { GoogleSync.signOut(); } catch (_) {} render(); } }]);
    } else {
      name = 'Guest';
      sub = 'Data stays on this device';
      const googleReady = (() => { try { return typeof GoogleSync !== 'undefined' && GoogleSync.isConfigured(); } catch (_) { return false; } })();
      trailing = Cloud.isConfigured() || googleReady ? signInButton() : null;
    }
    const guest = !u && !cur && !g;
    return h('div', { class: 'pfc-acct-row pfc-acct-id' },
      guest ? h('span', { class: 'pfc-av pfc-av--guest', 'aria-hidden': 'true', style: { width: '36px', height: '36px' } }, icon('user', 'pfc-ic pfc-ic-17'))
        : avatar({ name, hue, picture, size: 36 }),
      h('div', { class: 'pfc-acct-idtext' },
        h('span', { class: 'pfc-acct-name', text: name }),
        h('span', { class: 'pfc-acct-sub', text: sub })),
      trailing);
  }

  function signInButton() {
    const b = h('button', { type: 'button', class: 'btn btn-sm pfc-acct-signin' }, 'Sign in');
    b.addEventListener('click', () => {
      if (Cloud.isConfigured()) { openSheet('B'); return; }
      try { GoogleSync.signIn(b); } catch (_) { openSheet(); }
    });
    return b;
  }

  function moreButton(items) {
    const b = h('button', { type: 'button', class: 'pfc-iconbtn', 'aria-label': 'Account options', 'aria-haspopup': 'menu' }, icon('more'));
    b.addEventListener('click', () => popover(b, (el, close) => {
      el.classList.add('pfc-menu');
      el.setAttribute('role', 'menu');
      for (const it of items) {
        el.appendChild(h('button', { type: 'button', role: 'menuitem', class: 'pfc-menu-item', on: { click: () => { close(); it.run(); } } }, it.label));
      }
    }, { width: 200 }));
    return b;
  }

  function syncRow() {
    const st = syncStatusText();
    const row = h('button', { type: 'button', class: 'pfc-acct-row pfc-acct-sync', id: 'pfc-acct-sync' },
      icon('sync', 'pfc-ic pfc-ic-15'),
      h('span', { class: 'pfc-acct-label', text: 'Sync across devices' }),
      h('span', { class: 'pfc-flex' }),
      st.attention ? icon('alert', 'pfc-ic pfc-ic-13') : null,
      h('span', { class: 'pfc-acct-status', text: st.text }),
      icon('chevron', 'pfc-ic pfc-ic-11'));
    row.addEventListener('click', () => openSheet());
    return row;
  }

  function competeRows() {
    if (!Cloud.isSignedIn()) return null;
    const prof = Cloud.profile();
    const on = !!(prof && prof.lbOptIn);
    const input = h('input', { type: 'checkbox', role: 'switch', 'aria-label': 'Compete with friends' });
    input.checked = on;
    input.disabled = !prof;
    const sw = h('label', { class: 'toggle pfc-switch' }, input, h('span', { class: 'switch', 'aria-hidden': 'true' }));
    input.addEventListener('change', async () => {
      if (input.checked) {
        input.checked = false;
        const yes = await confirmCompete(sw);
        if (!yes) return;
        try { await Cloud.updateProfile({ lbOptIn: true }); toast('You’re competing with friends this week'); } catch (err) { toast('Couldn’t turn that on. Try again.'); }
      } else {
        try { await Cloud.updateProfile({ lbOptIn: false }); } catch (_) { toast('Couldn’t turn that off. Try again.'); }
      }
      render();
    });
    const head = h('div', { class: 'pfc-acct-row pfc-acct-compete' },
      sw,
      h('div', { class: 'pfc-acct-idtext' },
        h('span', { class: 'pfc-acct-label', text: 'Compete with friends' }),
        h('span', { class: 'pfc-acct-hint', text: 'Weekly focus time and XP, shown only to friends you add.' })));
    if (!on || !prof) return [head];
    const code = prof.friendCode ? prof.friendCode.slice(0, 4) + '-' + prof.friendCode.slice(4) : '';
    const nameEl = editingName ? nameEditor(prof) : h('button', { type: 'button', class: 'pfc-textbtn pfc-acct-shown', title: 'Change the name friends see',
      on: { click: () => { editingName = true; render(); } } }, 'Shown as ', h('span', { class: 'pfc-strong', text: prof.displayName }), icon('pencil', 'pfc-ic pfc-ic-11'));
    const subrow = h('div', { class: 'pfc-acct-subrow' },
      h('span', { class: 'pfc-acct-code' }, 'Code ', h('span', { class: 'pfc-strong pfc-tab', text: code })),
      h('button', { type: 'button', class: 'pfc-textbtn', on: { click: () => copy(Cloud.shareLink(), 'Link copied') } }, 'Copy link'),
      h('button', { type: 'button', class: 'pfc-textbtn', on: { click: () => { try { Friends.openAddFriend(); } catch (_) {} } } }, 'Add friend…'),
      h('span', { class: 'pfc-flex' }),
      nameEl);
    const caps = Cloud.provider() === 'supabase' ? 'Friends’ totals are checked by your cloud.' : 'Friends’ totals are computed on their own devices.';
    return [head, subrow, h('p', { class: 'pfc-acct-honest', text: caps })];
  }

  function nameEditor(prof) {
    const inp = h('input', { type: 'text', class: 'pfc-input pfc-input-sm', maxlength: '32', 'aria-label': 'Name friends see', value: prof.displayName });
    const save = async () => {
      const v = inp.value.trim().slice(0, 32);
      editingName = false;
      if (v && v !== prof.displayName) { try { await Cloud.updateProfile({ displayName: v }); } catch (_) { toast('Couldn’t rename. Try again.'); } }
      render();
    };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } if (e.key === 'Escape') { e.preventDefault(); editingName = false; render(); } });
    inp.addEventListener('blur', save);
    setTimeout(() => { try { inp.focus(); inp.select(); } catch (_) {} }, 0);
    return inp;
  }

  function render() {
    if (!cardRoot) return;
    const hadFocusId = document.activeElement && cardRoot.contains(document.activeElement) ? document.activeElement.id : null;
    const card = h('div', { class: 'glass card settings-card pfc-acct', role: 'group', 'aria-label': 'Account' },
      identityRow(), syncRow(), competeRows());
    cardRoot.replaceChildren(card);
    if (hadFocusId) { const f = document.getElementById(hadFocusId); if (f) try { f.focus({ preventScroll: true }); } catch (_) {} }
  }

  // ───────────────────────────── Sync sheet (§9.2) ─────────────────────────────
  let sheetApi = null;
  let sheetState = null;
  let sheetUpdate = null;      // state C: refreshes the status block in place

  function openSheet(state) {
    const s = state || Cloud.setupState();
    sheetState = s;
    const titles = { A: 'Sync & friends', A2: 'Sync & friends', B: 'Sign in', C: 'Sync & friends', reset: 'Set a new password', merge: 'Your guest data' };
    sheetUpdate = null;
    sheetApi = sheet({ title: titles[s] || 'Sync & friends', width: 560, build: (body, api) => buildState(s, body, api), onClose: () => { sheetApi = null; sheetState = null; sheetUpdate = null; } });
    return sheetApi;
  }
  function rerenderSheet(state) {
    if (!sheetApi || !sheetApi.el.isConnected) return;
    const s = state || Cloud.setupState();
    if (['reset', 'merge'].includes(sheetState) && !state) return;
    sheetState = s;
    const titles = { A: 'Sync & friends', A2: 'Sync & friends', B: 'Sign in', C: 'Sync & friends', reset: 'Set a new password', merge: 'Your guest data' };
    sheetApi.setTitle(titles[s] || 'Sync & friends');
    sheetUpdate = null;
    sheetApi.body.replaceChildren();
    buildState(s, sheetApi.body, sheetApi);
  }
  function buildState(s, body, api) {
    if (s === 'A') return stateConnect(body, api);
    if (s === 'A2') return stateSetup(body, api);
    if (s === 'B') return stateSignIn(body, api);
    if (s === 'reset') return stateReset(body, api);
    if (s === 'merge') return stateMerge(body, api);
    return stateSignedIn(body, api);
  }

  function footer(...kids) { return h('div', { class: 'pfc-sheet-foot' }, ...kids); }
  function note(text, cls) { return h('p', { class: 'pfc-note' + (cls ? ' ' + cls : ''), text }); }
  function line(kind, text) {
    return h('p', { class: 'pfc-line pfc-line--' + kind, role: kind === 'err' ? 'alert' : 'status' },
      kind === 'ok' ? icon('check', 'pfc-ic pfc-ic-13') : kind === 'err' ? icon('alert', 'pfc-ic pfc-ic-13') : null, h('span', { text }));
  }

  function steps(list) {
    return h('ol', { class: 'pfc-steps' }, list.map((parts, i) => h('li', null,
      h('span', { class: 'pfc-step-n', 'aria-hidden': 'true', text: String(i + 1) }), h('span', null, ...parts))));
  }
  function disclosure(title, content) {
    return h('details', { class: 'pfc-disc' }, h('summary', null, title), h('div', { class: 'pfc-disc-body' }, content));
  }
  function extLink(label, href) {
    return h('a', { class: 'pfc-textbtn pfc-ext', href, target: '_blank', rel: 'noopener noreferrer' }, label, icon('external', 'pfc-ic pfc-ic-11'));
  }
  const b = (t) => h('b', { text: t });
  function origin() { try { return location.origin; } catch (_) { return ''; } }

  function supabaseSteps() {
    return h('div', null, steps([
      ['At ', b('supabase.com'), ' create a new project (Free).'],
      ['Open ', b('SQL Editor › New query'), ', paste the setup SQL and press ', b('Run'), '. It ends with “Success. No rows returned”.'],
      ['In ', b('Project Settings › API Keys'), ' copy the ', b('Project URL'), ' and the ', b('publishable key'), ' (sb_publishable_…). Never the secret key.'],
      ['Paste both below. To set up the whole site instead, paste them into js/config.js (CLOUD).'],
      ['In ', b('Authentication › URL Configuration'), ' add ', h('code', { text: origin() + '/**' }), ' to Redirect URLs.'],
      ['Optional: turn on ', b('Authentication › Providers › Google'), ' so friends can sign in with Google.'],
    ]), h('div', { class: 'pfc-row-actions' },
      h('button', { type: 'button', class: 'btn btn-sm', on: { click: () => copyFile('backend/supabase.sql', 'Setup SQL copied') } }, icon('copy', 'pfc-ic pfc-ic-13'), 'Copy setup SQL'),
      extLink('Open Supabase', 'https://supabase.com/dashboard/projects')));
  }
  function firebaseSteps() {
    return h('div', null, steps([
      ['At ', b('console.firebase.google.com'), ' add a project.'],
      [b('Authentication'), ': enable Email/Password and Google; under Settings › Authorized domains add ', h('code', { text: (location.hostname || 'this site') }), '.'],
      [b('Firestore Database › Create database'), ': Standard edition, production mode.'],
      [b('Firestore › Rules'), ': paste the rules and press ', b('Publish'), '.'],
      [b('Project settings › Your apps › Web'), ': copy the whole firebaseConfig block and paste it below.'],
    ]), h('div', { class: 'pfc-row-actions' },
      h('button', { type: 'button', class: 'btn btn-sm', on: { click: () => copyFile('backend/firestore.rules', 'Rules copied') } }, icon('copy', 'pfc-ic pfc-ic-13'), 'Copy rules'),
      extLink('Open Firebase', 'https://console.firebase.google.com/')));
  }

  // State A — Connect
  function stateConnect(body, api) {
    const siteErr = Cloud.siteError();
    put(body, 
      note('Pure Focus works fully offline. Connect your own free Supabase or Firebase project to sync this browser and the Mac app, and to compete with friends.'),
      siteErr ? line('err', 'The CLOUD block in config.js isn’t recognised (' + Cloud.pasteCopy(siteErr) + ')') : null,
      h('div', { class: 'pfc-discs' },
        disclosure('How to get Supabase details', supabaseSteps()),
        disclosure('How to get Firebase details', firebaseSteps())));
    const ta = h('textarea', { class: 'pfc-paste', rows: '5', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', 'aria-label': 'Supabase or Firebase details',
      placeholder: 'Paste your Supabase URL and publishable key, your Firebase config, or a setup code (pfcloud1.…)' });
    const detect = h('div', { class: 'pfc-detect', 'aria-live': 'polite' });
    const connect = h('button', { type: 'button', class: 'btn btn-primary pfc-btn-36', disabled: true }, 'Connect');
    let timer = null, parsed = null;
    const update = () => {
      const r = CloudRef.parseCloudPaste(ta.value);
      parsed = r.ok ? r.config : null;
      connect.disabled = !parsed;
      detect.replaceChildren();
      if (r.ok) detect.appendChild(line('ok', providerName(r.config.provider) + ' · ' + refShort(r.config)));
      else if (r.error !== 'empty') detect.appendChild(line('err', Cloud.pasteCopy(r.error)));
    };
    ta.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(update, 150); });
    connect.addEventListener('click', () => {
      update();
      if (!parsed) return;
      const r = Cloud.setPaste(ta.value);
      ta.value = '';                     // never keep pasted text around
      if (!r.ok) { detect.replaceChildren(line('err', Cloud.pasteCopy(r.error))); return; }
      connect.disabled = true;
      connect.textContent = 'Connecting…';
      waitFor(() => Cloud.status().state !== 'connecting', 8000).then(() => rerenderSheet());
    });
    put(body, h('label', { class: 'pfc-field' }, ta), detect,
      footer(h('button', { type: 'button', class: 'pfc-textbtn', on: { click: () => api.close() } }, 'Cancel'), connect));
  }

  // State A2 — setup needed (§2.4)
  function stateSetup(body) {
    const cfg = Cloud.config();
    const at = Cloud.status().attention;
    const card = h('div', { class: 'pfc-setup' });
    if (at === 'setupSQL') {
      put(card, h('h3', { class: 'pfc-setup-title', text: 'Run the setup script' }),
        note('Your Supabase project is connected but doesn’t have Pure Focus’s tables yet. Copy the setup SQL, paste it into the SQL editor and press Run. It is safe to run again.'),
        h('div', { class: 'pfc-row-actions' },
          h('button', { type: 'button', class: 'btn btn-sm', on: { click: () => copyFile('backend/supabase.sql', 'Setup SQL copied') } }, icon('copy', 'pfc-ic pfc-ic-13'), 'Copy setup SQL'),
          extLink('Open SQL editor', 'https://supabase.com/dashboard/project/' + encodeURIComponent(cfg.projectRef || '') + '/sql/new')));
    } else if (at === 'rules') {
      put(card, h('h3', { class: 'pfc-setup-title', text: 'Publish the security rules' }),
        note('Firestore refused Pure Focus. Copy the rules, paste them into Firestore › Rules and press Publish.'),
        h('div', { class: 'pfc-row-actions' },
          h('button', { type: 'button', class: 'btn btn-sm', on: { click: () => copyFile('backend/firestore.rules', 'Rules copied') } }, icon('copy', 'pfc-ic pfc-ic-13'), 'Copy rules'),
          extLink('Open rules', 'https://console.firebase.google.com/project/' + encodeURIComponent(cfg.projectId || '') + '/firestore/rules')));
    } else {
      put(card, h('h3', { class: 'pfc-setup-title', text: 'Create the Firestore database' }),
        note('This Firebase project has no Firestore database yet. Create one (Standard edition, production mode), then publish the rules.'),
        h('div', { class: 'pfc-row-actions' },
          h('button', { type: 'button', class: 'btn btn-sm', on: { click: () => copyFile('backend/firestore.rules', 'Rules copied') } }, icon('copy', 'pfc-ic pfc-ic-13'), 'Copy rules'),
          extLink('Open Firestore', 'https://console.firebase.google.com/project/' + encodeURIComponent(cfg.projectId || '') + '/firestore')));
    }
    const result = h('div', { 'aria-live': 'polite' });
    const again = h('button', { type: 'button', class: 'btn btn-primary pfc-btn-36' }, 'Check again');
    again.addEventListener('click', async () => {
      again.disabled = true; again.textContent = 'Checking…';
      const s = await Cloud.checkSetup();
      if (Cloud.setupState() !== 'A2') { rerenderSheet(); return; }
      again.disabled = false; again.textContent = 'Check again';
      result.replaceChildren(line('err', s === 'unreachable' ? 'Can’t reach your project yet. Try again in a moment.' : 'Not yet. It can take a few seconds after you press Run or Publish.'));
    });
    put(body, card, result, configLine(), footer(changeProjectButton(), h('span', { class: 'pfc-flex' }), again));
  }

  function configLine() {
    const cfg = Cloud.config();
    if (!cfg) return null;
    const label = Cloud.isMock() ? 'Dev mock backend · ' + providerName(cfg.provider)
      : (Cloud.source() === 'site' ? 'Set up by this site · ' : 'This device · ') + providerName(cfg.provider) + ' · ' + refShort(cfg);
    return h('p', { class: 'pfc-cfgline', text: label });
  }
  function changeProjectButton() {
    if (Cloud.source() !== 'device') return null;
    return h('button', { type: 'button', class: 'pfc-textbtn', on: { click: () => { Cloud.clearConfig(); setTimeout(() => rerenderSheet('A'), 50); } } }, 'Use a different project');
  }

  // State B — sign in
  function stateSignIn(body, api) {
    const at = Cloud.status().attention;
    if (at === 'unreachable' || at === 'key') {
      put(body, line('err', at === 'key' ? 'That key was rejected. Check the publishable key (or the Firebase config) and connect again.'
        : 'Can’t reach your ' + providerName(Cloud.provider()) + ' project. Free Supabase projects pause after about a week without use; restore it in the dashboard.'));
    }
    let create = false;
    const err = h('div', { 'aria-live': 'polite' });
    const g = h('button', { type: 'button', class: 'btn btn-primary pfc-google' }, icon('personPlus', 'pfc-ic pfc-ic-17'), 'Continue with Google');
    g.addEventListener('click', async () => {
      err.replaceChildren();
      g.disabled = true;
      try {
        Cloud.setRememberSession(remember.checked);
        await Cloud.signInWithGoogle();
        if (Cloud.isSignedIn()) done();
      } catch (e) { const m = Cloud.authCopy(e); if (m) err.replaceChildren(line('err', m)); }
      g.disabled = false;
    });
    const name = h('input', { type: 'text', class: 'pfc-input', placeholder: 'Name', autocomplete: 'name', maxlength: '32', 'aria-label': 'Name' });
    const email = h('input', { type: 'email', class: 'pfc-input', placeholder: 'Email', autocomplete: 'email', 'aria-label': 'Email' });
    const pw = h('input', { type: 'password', class: 'pfc-input', placeholder: 'Password', autocomplete: 'current-password', 'aria-label': 'Password' });
    const nameWrap = h('div', { class: 'pfc-namewrap', hidden: true }, name);
    const submit = h('button', { type: 'submit', class: 'btn btn-sm pfc-btn-36' }, 'Sign in');
    const toggle = h('button', { type: 'button', class: 'pfc-textbtn' }, 'Create an account');
    const forgot = h('button', { type: 'button', class: 'pfc-textbtn pfc-small' }, 'Forgot password?');
    const remember = h('input', { type: 'checkbox' });
    remember.checked = Cloud.rememberSession();
    const setMode = () => {
      nameWrap.hidden = !create;
      submit.textContent = create ? 'Create account' : 'Sign in';
      toggle.textContent = create ? 'I have an account' : 'Create an account';
      pw.setAttribute('autocomplete', create ? 'new-password' : 'current-password');
      pw.placeholder = create ? 'Password (8+ characters)' : 'Password';
      forgot.hidden = create;
    };
    toggle.addEventListener('click', () => { create = !create; err.replaceChildren(); setMode(); (create ? name : email).focus(); });
    forgot.addEventListener('click', async () => {
      err.replaceChildren();
      if (!email.value.trim()) { err.replaceChildren(line('err', 'Enter your email first.')); email.focus(); return; }
      try { await Cloud.resetPassword(email.value); err.replaceChildren(line('ok', 'We sent a link. Open it in this browser to set a new password.')); }
      catch (e) { err.replaceChildren(line('err', Cloud.authCopy(e))); }
    });
    function done() { api.close(); toast('Signed in · syncing', 'success'); }
    const form = h('form', { class: 'pfc-auth', novalidate: true },
      nameWrap, email, pw,
      h('div', { class: 'pfc-auth-row' }, submit, toggle, h('span', { class: 'pfc-flex' }), forgot),
      h('label', { class: 'pfc-check' }, remember, h('span', { text: 'Keep me signed in' })));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.replaceChildren();
      if (!email.value.trim() || !pw.value) { err.replaceChildren(line('err', 'Enter your email and password.')); return; }
      if (create && pw.value.length < 8) { err.replaceChildren(line('err', 'Use at least 8 characters.')); return; }
      submit.disabled = true;
      try {
        if (create) {
          const r = await Cloud.signUp(email.value, pw.value, name.value, { remember: remember.checked });
          if (r.status === 'confirmEmail') { err.replaceChildren(line('ok', 'Check your inbox to confirm, then sign in.')); create = false; setMode(); }
          else done();
        } else {
          await Cloud.signInWithEmail(email.value, pw.value, { remember: remember.checked });
          done();
        }
      } catch (e2) { err.replaceChildren(line('err', Cloud.authCopy(e2) || 'That didn’t work. Try again in a moment.')); }
      finally { pw.value = ''; submit.disabled = false; }
    });
    const cur = Profile.current();
    if (cur && cur.email) email.value = cur.email;
    setMode();
    put(body, g, h('div', { class: 'pfc-or', 'aria-hidden': 'true' }, h('span', { text: 'or' })), form, err,
      Cloud.provider() === 'firebase' ? note('Use the same sign-in method on every device.', 'pfc-small') : null,
      configLine(), footer(changeProjectButton(), h('span', { class: 'pfc-flex' }), h('button', { type: 'button', class: 'pfc-textbtn', on: { click: () => api.close() } }, 'Cancel')));
  }

  // State C — signed in
  function stateSignedIn(body, api) {
    const u = Cloud.user();
    if (!u) { stateSignIn(body, api); return; }
    const prof = Cloud.profile();
    const head = h('div', { class: 'pfc-c-head' },
      avatar({ name: (prof && prof.displayName) || u.displayName || u.email, hue: prof ? prof.avatarHue : undefined, picture: u.picture, size: 28 }),
      h('div', { class: 'pfc-acct-idtext' }, h('span', { class: 'pfc-c-email', text: u.email || '' }), h('span', { class: 'pfc-acct-hint', text: 'Signed in' })));
    const bigEl = h('div', { class: 'pfc-c-big' });
    const whenEl = h('div', { class: 'pfc-c-when' });
    const countsEl = h('div', { class: 'pfc-c-counts' });
    const parkedEl = h('p', { class: 'pfc-line pfc-line--info', hidden: true });
    const statusBlock = h('div', { class: 'pfc-c-status', 'aria-live': 'polite' }, bigEl, whenEl, countsEl);
    const plural = (n, w) => n.toLocaleString() + ' ' + w + (n === 1 ? '' : 's');
    // Updated in place on every status change, so an open "More" or a half-typed confirmation survives.
    sheetUpdate = () => {
      const st = Cloud.status();
      bigEl.textContent = { upToDate: 'Up to date', syncing: 'Syncing…', connecting: 'Syncing…', offline: 'Offline', attention: 'Needs attention',
        needsSignIn: 'Sign in to sync' }[st.state] || 'Up to date';
      whenEl.textContent = st.state === 'offline' ? (st.pending ? st.pending + ' changes waiting · they sync when you’re back online' : 'Changes sync when you’re back online')
        : st.state === 'attention' ? attentionCopy(st.attention) : (st.lastSyncAt ? 'Last synced ' + ago(st.lastSyncAt) : 'Syncing for the first time…');
      const c = Cloud.counts();
      countsEl.textContent = [plural(c.sessions, 'session'), plural(c.tasks, 'task'), plural(c.blocks, 'calendar block'), plural(c.calendars, 'calendar'),
        plural(c.courses, 'course')].join(' · ');
      parkedEl.hidden = !(st.parked > 0);
      if (st.parked > 0) {
        parkedEl.replaceChildren(h('span', { text: st.parked + (st.parked === 1 ? ' item couldn’t sync · ' : ' items couldn’t sync · ') }),
          h('button', { type: 'button', class: 'pfc-textbtn', on: { click: async () => { await Cloud.retryParked(); if (sheetUpdate) sheetUpdate(); } } }, 'Retry'));
      }
    };
    sheetUpdate();
    const p = Cloud.prefs();
    const sw = (label, hint, on, fn) => {
      const input = h('input', { type: 'checkbox', role: 'switch', 'aria-label': label });
      input.checked = on;
      input.addEventListener('change', () => fn(input.checked));
      return h('div', { class: 'pfc-c-switch' },
        h('div', { class: 'pfc-acct-idtext' }, h('span', { class: 'pfc-acct-label', text: label }), h('span', { class: 'pfc-acct-hint', text: hint })),
        h('label', { class: 'toggle pfc-switch' }, input, h('span', { class: 'switch', 'aria-hidden': 'true' })));
    };
    const syncNow = h('button', { type: 'button', class: 'pfc-textbtn' }, 'Sync now');
    syncNow.addEventListener('click', async () => { syncNow.disabled = true; await Cloud.syncNow(); syncNow.disabled = false; if (sheetUpdate) sheetUpdate(); });
    const code = Cloud.setupCode();
    const actions = h('div', { class: 'pfc-row-actions pfc-c-actions' }, syncNow,
      code ? h('button', { type: 'button', class: 'pfc-textbtn', title: 'Paste it on your other device', on: { click: () => copy(code, 'Setup code copied · paste it on your other device') } }, 'Copy setup code') : null);
    const more = h('details', { class: 'pfc-disc pfc-c-more' }, h('summary', null, 'More'), h('div', { class: 'pfc-disc-body pfc-c-morebody' }, moreActions(api)));
    put(body, head, statusBlock, parkedEl,
      h('div', { class: 'pfc-c-switches' },
        sw('Sync calendar links', 'Your Canvas, Blackbaud and other calendar links work on every device. They’re private links, stored in your own cloud project.', p.syncLinks, (v) => Cloud.setSyncLinks(v)),
        sw('Sync focus insights', 'Apps, sites and check-in answers from Focus Guard.', p.syncInsights, (v) => Cloud.setSyncInsights(v))),
      actions, more, configLine());
  }
  function attentionCopy(a) {
    return ({
      signIn: 'Sign in again to keep syncing.',
      setupSQL: 'Run the setup script in your Supabase project.',
      rules: 'Publish the Firestore security rules.',
      database: 'Create the Firestore database.',
      key: 'The project rejected this key.',
      unreachable: 'Can’t reach your project. Free Supabase projects pause after about a week without use.',
      storage: 'This browser is out of space for Pure Focus. Export a CSV, then clear old imported calendars.',
    })[a] || 'Something needs a look.';
  }

  function moreActions(api) {
    const box = h('div', { class: 'pfc-c-moreacts' });
    const progress = h('p', { class: 'pfc-note pfc-small', 'aria-live': 'polite' });
    const signOut = h('button', { type: 'button', class: 'pfc-textbtn' }, 'Sign out on this device');
    signOut.addEventListener('click', async () => { await Cloud.signOut(); api.close(); toast('Signed out. Your data stays on this device.'); });
    const disc = h('button', { type: 'button', class: 'pfc-textbtn' }, 'Disconnect this project');
    disc.addEventListener('click', () => confirmBox(box, 'Stop syncing here? Your data stays on this device and in the cloud.', 'Disconnect', async () => {
      await Cloud.disconnect(); api.close(); toast('Sync is off on this device');
    }));
    const del = h('button', { type: 'button', class: 'pfc-textbtn pfc-quiet-danger' }, 'Delete my cloud data…');
    del.addEventListener('click', () => typedConfirm(box, progress, api));
    put(box, signOut, disc, del, progress);
    return box;
  }
  function confirmBox(host, text, label, run) {
    const old = host.querySelector('.pfc-confirm'); if (old) old.remove();
    const yes = h('button', { type: 'button', class: 'btn btn-sm' }, label);
    const box = h('div', { class: 'pfc-confirm' }, h('p', { text }),
      h('div', { class: 'pfc-row-actions' }, h('button', { type: 'button', class: 'pfc-textbtn', on: { click: () => box.remove() } }, 'Cancel'), yes));
    yes.addEventListener('click', async () => { yes.disabled = true; try { await run(); } catch (e) { box.replaceChildren(line('err', Cloud.authCopy(e))); } });
    host.appendChild(box);
    yes.focus();
  }
  /* Delete my cloud data (P1): type DELETE; progress line; option to delete the account too. */
  function typedConfirm(host, progress, api) {
    const old = host.querySelector('.pfc-confirm'); if (old) old.remove();
    const inp = h('input', { type: 'text', class: 'pfc-input pfc-input-sm', 'aria-label': 'Type DELETE to confirm', placeholder: 'DELETE', autocomplete: 'off' });
    const alsoAcct = h('input', { type: 'checkbox' });
    const go = h('button', { type: 'button', class: 'btn btn-sm btn-danger', disabled: true }, 'Delete');
    inp.addEventListener('input', () => { go.disabled = inp.value.trim() !== 'DELETE'; });
    const box = h('div', { class: 'pfc-confirm' },
      h('p', { text: 'This erases everything Pure Focus stored in your cloud project: synced tasks, sessions, calendar blocks, friends and your board entry. This device keeps its own copy. Type DELETE to confirm.' }),
      inp,
      h('label', { class: 'pfc-check' }, alsoAcct, h('span', { text: 'Also delete my sign-in' })),
      h('div', { class: 'pfc-row-actions' }, h('button', { type: 'button', class: 'pfc-textbtn', on: { click: () => box.remove() } }, 'Cancel'), go));
    go.addEventListener('click', async () => {
      go.disabled = true; inp.disabled = true;
      const onProgress = (done, total) => { progress.textContent = 'Deleting… ' + done.toLocaleString() + ' of ' + total.toLocaleString(); };
      try {
        if (alsoAcct.checked) {
          const removed = await Cloud.deleteAccount(onProgress);
          api.close();
          toast(removed ? 'Cloud data and sign-in deleted' : 'Data erased. Remove the sign-in in Authentication › Users.');
        } else {
          await Cloud.deleteCloudData(onProgress);
          api.close();
          toast('Cloud data deleted. Sync is off here; this device keeps its copy.');
        }
      } catch (e) { progress.textContent = ''; box.replaceChildren(line('err', Cloud.authCopy(e))); }
    });
    host.appendChild(box);
    inp.focus();
  }

  // Password recovery return (Supabase PASSWORD_RECOVERY)
  function stateReset(body, api) {
    const pw = h('input', { type: 'password', class: 'pfc-input', placeholder: 'New password (8+ characters)', autocomplete: 'new-password', 'aria-label': 'New password' });
    const msg = h('div', { 'aria-live': 'polite' });
    const save = h('button', { type: 'submit', class: 'btn btn-primary pfc-btn-36' }, 'Save password');
    const form = h('form', { class: 'pfc-auth', novalidate: true }, pw, msg, footer(h('button', { type: 'button', class: 'pfc-textbtn', on: { click: () => api.close() } }, 'Cancel'), save));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await Cloud.updatePassword(pw.value); api.close(); toast('Password updated', 'success'); }
      catch (err) { msg.replaceChildren(line('err', Cloud.authCopy(err))); }
      finally { pw.value = ''; }
    });
    put(body, note('Choose a new password for ' + ((Cloud.user() && Cloud.user().email) || 'your account') + '.'), form);
  }

  // E27 / v2-backend §3.3: both the guest and the account have data → ask once.
  function stateMerge(body, api) {
    const cur = Profile.current();
    const merge = h('button', { type: 'button', class: 'btn btn-primary pfc-btn-36' }, 'Merge');
    const keep = h('button', { type: 'button', class: 'pfc-textbtn' }, 'Keep separate');
    merge.addEventListener('click', () => {
      const g = Profile.guestRaw();
      if (g.store) Store.mergeFrom(g.store, { ackRaw: g.ack });
      Profile.clearGuest();
      if (cur) Profile.rememberGuestChoice(cur.sub, 'merged');
      api.close();
      toast('Guest data merged into your account', 'success');
      Cloud.syncNow();
    });
    keep.addEventListener('click', () => { if (cur) Profile.rememberGuestChoice(cur.sub, 'separate'); api.close(); });
    put(body, note('This browser has tasks and sessions from before you signed in. Bring them into your account? Items with the same id keep your account’s version.'),
      footer(keep, merge));
  }

  function waitFor(cond, ms) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => { if (cond() || Date.now() - t0 > ms) resolve(); else setTimeout(tick, 120); };
      tick();
    });
  }

  // ───────────────────────────── init ─────────────────────────────
  function route() {
    const hsh = (location.hash || '').slice(1);
    if (hsh === 'settings/accounts') {
      try { Settings.open('calendar', 'pfc-acct-sync'); } catch (_) {}
    }
  }

  let inited = false;
  function init() {
    if (inited) return;
    inited = true;
    try {
      Settings.registerCard('calendar', { id: 'account', order: 10, render: (el) => { cardRoot = el; render(); } });
    } catch (err) { console.error('CloudUI: account card failed', err); }
    // The sheet follows the setup state (A → B after Connect, B → C after sign-in, C → B after sign-out);
    // within a state it is only refreshed in place (state C), never rebuilt under the user's fingers.
    const follow = () => {
      render();
      if (!sheetApi || !['A', 'A2', 'B', 'C'].includes(sheetState)) return;
      const want = Cloud.setupState();
      if (want !== sheetState) rerenderSheet(want);
      else if (sheetUpdate) sheetUpdate();
    };
    Cloud.on('status', follow);
    Cloud.on('user', follow);
    Cloud.on('profile', () => render());
    try { Profile.on('change', () => render()); } catch (_) {}
    setInterval(() => { if (cardRoot && cardRoot.isConnected && Cloud.status().state === 'upToDate') render(); }, 60000);
    window.addEventListener('hashchange', route);
    route();
  }

  return { init, openSheet, confirmCompete, sheet, popover, copy, avatar, icon, h, put, maskEmail, ago, render };
})();
