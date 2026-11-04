/* js/pro-modal.js — the Focus Pro popup.
   Same glass card, tokens and light/dark rules as the sign-in gate. Checkout and the
   billing portal are the existing Supabase Edge Functions (create-checkout / create-portal);
   no Stripe key ever reaches this file. */
const ProModal = (() => {
  'use strict';

  let dlg = null;
  let busy = false;
  let wired = false;
  const $ = (sel) => (dlg ? dlg.querySelector(sel) : null);
  const cash = (n) => '$' + Number(n || 0).toFixed(2);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const ICONS = {
    music: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V6l10-2v12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6.5" cy="18" r="2.5" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="16.5" cy="16" r="2.5" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>',
    insights: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V5M4 19h16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M7 15l3.2-4.2 2.8 2.2L19 6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    fingerprint: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4M14 13.12c0 2.38 0 6.38-1 8.88M17.29 21.02c.12-.6.43-2.3.5-3.02M2 12a10 10 0 0 1 18-6M2 16h.01M21.8 16c.2-2 .131-5.354 0-6M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2M8.65 22c.21-.66.45-1.32.57-2M9 6.8a6 6 0 0 1 9 5.2v2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    themes: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.65-.75 1.65-1.69 0-.44-.18-.83-.44-1.12-.29-.29-.44-.65-.44-1.13a1.64 1.64 0 0 1 1.67-1.67h2c3.05 0 5.56-2.5 5.56-5.55C22 6.01 17.46 2 12 2Z" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="7.6" cy="11.2" r="1.1" fill="currentColor"/><circle cx="10.2" cy="7.2" r="1.1" fill="currentColor"/><circle cx="14.8" cy="7.4" r="1.1" fill="currentColor"/><circle cx="17.4" cy="11.4" r="1.1" fill="currentColor"/></svg>',
  };
  function iconFor(key) {
    if (key === 'music_library') return ICONS.music;
    if (key === 'insights') return ICONS.insights;
    if (key === 'focus_fingerprint') return ICONS.fingerprint;
    if (key === 'themes') return ICONS.themes;
    return ICONS.insights;
  }

  function ensure() {
    if (dlg) return dlg;
    dlg = document.createElement('dialog');
    dlg.id = 'pro-modal';
    dlg.setAttribute('aria-labelledby', 'pro-modal-title');
    dlg.innerHTML =
      '<div class="pro-shell">' +
        '<div class="pro-card" role="document">' +
          '<button class="pro-close" type="button" aria-label="Close Focus Pro" data-pro-close>' +
            '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>' +
          '</button>' +
          '<div class="pro-brand">' +
            '<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="11" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-dasharray="52 17" transform="rotate(-90 16 16)"/><circle cx="6" cy="15.8" r="2.4" fill="currentColor"/></svg>' +
            '<span>Pure Focus</span>' +
          '</div>' +
          '<p class="pro-eyebrow">Focus Pro</p>' +
          '<h1 class="pro-title" id="pro-modal-title">Go deeper.</h1>' +
          '<p class="pro-lead">More music, every theme, Insights, the Focus Fingerprint and Breakdown — one secure payment.</p>' +
          '<div class="pro-body"></div>' +
          '<p class="pro-msg" role="status" aria-live="polite"></p>' +
          '<div class="pro-foot"><span>Secure payment by Stripe</span></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(dlg);

    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) close();
      if (e.target.closest('[data-pro-close]')) close();
      const plan = e.target.closest('[data-pro-plan]');
      if (plan) { e.preventDefault(); checkout(plan.dataset.proPlan); }
      if (e.target.closest('[data-pro-manage]')) { e.preventDefault(); manage(); }
      if (e.target.closest('[data-pro-signin]')) {
        e.preventDefault(); close();
        if (typeof AuthGate !== 'undefined' && AuthGate.show) AuthGate.show();
        else location.hash = 'signin';
      }
    });

    if (typeof Plan !== 'undefined' && Plan.onChange) Plan.onChange(() => { if (dlg && dlg.open) renderBody(); });
    wired = true;
    return dlg;
  }

  function open() {
    ensure();
    renderBody();
    if (!dlg.open) {
      try { dlg.showModal(); } catch (_) { dlg.setAttribute('open', ''); }
    }
    if (typeof Plan !== 'undefined' && Plan.refresh) Plan.refresh();
  }

  function close() { if (dlg && dlg.open) dlg.close(); }

  function setMsg(text, kind) {
    const m = $('.pro-msg'); if (!m) return;
    m.textContent = text || '';
    if (kind) m.dataset.kind = kind; else delete m.dataset.kind;
  }

  function setBusy(on) {
    busy = on;
    dlg.querySelectorAll('[data-pro-plan], [data-pro-manage]').forEach((b) => { b.disabled = !!on; });
  }

  /* Keep the click's user gesture: open a lightweight tab synchronously, then
     point it at Stripe when the session URL arrives. Some browsers/webviews
     ignore a top-level navigation that happens after an await. */
  function openBlankTab() {
    let w = null;
    try { w = window.open('', '_blank'); } catch (_) { return null; }
    if (!w) return null;
    try {
      w.document.write('<!doctype html><meta charset="utf-8"><title>Focus Pro checkout</title>' +
        '<style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#110c0d;color:#f3efe6;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:14px}' +
        '@media (prefers-color-scheme:light){body{background:#faf2ee;color:#1a1613}}</style>' +
        '<p>Opening secure checkout…</p>');
      w.document.close();
    } catch (_) {}
    return w;
  }
  function closeTab(w) { try { if (w && !w.closed) w.close(); } catch (_) {} }
  function goTo(url, win) {
    if (!win || win.closed) {
      try { window.location.assign(url); } catch (_) {}
      return;
    }
    try { win.location.replace(url); } catch (_) {}
    // Some webviews ignore navigation of a script-opened blank tab. If it is
    // still sitting on about:blank, drive the current tab instead so the
    // checkout always opens.
    setTimeout(() => {
      let blank = false;
      try { blank = win.closed || win.location.href === 'about:blank'; } catch (_) { return; }
      if (!blank) return;
      try { win.close(); } catch (_) {}
      try { window.location.assign(url); } catch (_) {}
    }, 1200);
  }
  function withTimeout(p, ms) {
    return Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
  }
  function setLinkMsg(text, url) {
    const m = $('.pro-msg'); if (!m) return;
    m.textContent = text + ' ';
    const a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.rel = 'noopener';
    a.textContent = 'Open secure checkout';
    m.appendChild(a);
    m.appendChild(document.createTextNode('.'));
  }

  function featureList() {
    const feats = (typeof ProConfig !== 'undefined' && ProConfig.FEATURES) ? ProConfig.FEATURES : [];
    return '<div class="pro-features">' + feats.map((f) =>
      '<div class="pro-feature"><span class="pro-feature-ic">' + iconFor(f.key) + '</span><span class="pro-feature-copy"><strong>' + esc(f.title) + '</strong><span>' + esc(f.desc) + '</span></span></div>'
    ).join('') + '</div>';
  }

  function renderBody() {
    const body = $('.pro-body');
    if (!body) return;
    const signedIn = typeof Cloud !== 'undefined' && Cloud.isSignedIn && Cloud.isSignedIn();
    const loading = typeof Plan === 'undefined' || Plan.loading;

    if (loading) {
      body.innerHTML = '<div class="pro-loading"><span class="pro-spinner" aria-hidden="true"></span><span>Checking your plan…</span></div>' + featureList();
      return;
    }
    if (!signedIn) {
      body.innerHTML = featureList() +
        '<div class="pro-active"><h3>Sign in to upgrade</h3><p>Focus Pro is tied to your account, so your plan follows you to every device.</p>' +
        '<button class="btn btn-primary btn-sm" type="button" data-pro-signin>Sign in</button></div>';
      return;
    }
    if (Plan.isPremium) {
      const end = Plan.currentPeriodEnd ? new Date(Plan.currentPeriodEnd).toLocaleDateString() : 'soon';
      const cancel = Plan.cancelAtPeriodEnd ? '<p><strong>Your plan ends on ' + esc(end) + '</strong></p>' : '<p>Renewal: <strong>' + esc(end) + '</strong></p>';
      body.innerHTML = featureList() +
        '<div class="pro-active"><h3>You’re on Focus Pro</h3><p>Plan: <strong>' + esc(Plan.plan || 'Focus Pro') + '</strong></p>' + cancel +
        '<button class="btn btn-secondary btn-sm" type="button" data-pro-manage>Manage billing</button></div>';
      return;
    }

    const P = (typeof ProConfig !== 'undefined' && ProConfig.PRICES) ? ProConfig.PRICES : { monthly: 6.49, yearly: 64.99, yearlyPct: 17, yearlySaved: 12.89 };
    const canceled = typeof Plan !== 'undefined' && Plan.cancelAtPeriodEnd;
    const canceledNote = canceled
      ? '<div class="pro-active pro-canceled"><h3>Your Focus Pro was canceled</h3><p>Pro features are off. Resubscribe below to turn them back on.</p></div>'
      : '';
    body.innerHTML = featureList() + canceledNote +
      '<div class="pro-plans">' +
        '<div class="pro-plan">' +
          '<p class="pro-plan-name">Monthly</p>' +
          '<p class="pro-price">' + cash(P.monthly) + ' <small>/month</small></p>' +
          '<p class="pro-plan-note">Billed monthly. Cancel anytime.</p>' +
          '<button class="btn btn-secondary btn-sm" type="button" data-pro-plan="monthly">Choose Monthly</button>' +
        '</div>' +
        '<div class="pro-plan is-best"><span class="pro-flag">Best value</span>' +
          '<p class="pro-plan-name">Yearly</p>' +
          '<p class="pro-price">' + cash(P.yearly) + ' <small>/year</small></p>' +
          '<p class="pro-save">Save ' + esc(P.yearlyPct) + '% (' + cash(P.yearlySaved) + '/yr)</p>' +
          '<p class="pro-plan-note">One payment for a full year.</p>' +
          '<button class="btn btn-primary btn-sm" type="button" data-pro-plan="yearly">Choose Yearly</button>' +
        '</div>' +
      '</div>';
  }

  async function checkout(name) {
    if (busy) return;
    if (typeof Cloud === 'undefined' || !Cloud.invokeFn) { setMsg('Checkout is unavailable right now.', 'error'); return; }
    if (!Cloud.isSignedIn || !Cloud.isSignedIn()) { setMsg('Sign in first.', 'error'); return; }
    const win = openBlankTab();
    setBusy(true);
    setMsg('Opening secure checkout…');
    try {
      const origin = window.location.origin || (location.protocol + '//' + location.host);
      const { data, code } = await withTimeout(Cloud.invokeFn('create-checkout', { plan: name, origin }), 25000);
      if (data && data.url) {
        goTo(data.url, win);
        setLinkMsg('Secure checkout is ready. If it didn’t open, use this link:', data.url);
        return;
      }
      closeTab(win);
      if (code === 'already_subscribed') { setBusy(false); await manage(); return; }
      setMsg(code === 'not_signed_in' ? 'Sign in first.' : 'Checkout could not start (' + (code || 'unknown') + '). Try again.', 'error');
    } catch (err) {
      closeTab(win);
      setMsg(err && err.message === 'timeout' ? 'Checkout is taking too long. Try again.' : 'Checkout could not start. Check your connection and try again.', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function manage() {
    if (busy) return;
    if (typeof Cloud === 'undefined' || !Cloud.invokeFn) return;
    const win = openBlankTab();
    setBusy(true);
    setMsg('Opening billing…');
    try {
      const origin = window.location.origin || (location.protocol + '//' + location.host);
      const { data, code } = await withTimeout(Cloud.invokeFn('create-portal', { origin }), 25000);
      if (data && data.url) {
        goTo(data.url, win);
        setLinkMsg('Billing is ready. If it didn’t open, use this link:', data.url);
        return;
      }
      closeTab(win);
      setMsg('Billing could not open (' + (code || 'unknown') + '). Try again.', 'error');
    } catch (err) {
      closeTab(win);
      setMsg(err && err.message === 'timeout' ? 'Billing is taking too long. Try again.' : 'Billing could not open. Check your connection and try again.', 'error');
    } finally {
      setBusy(false);
    }
  }

  // Any element with data-pro-open opens the popup.
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-pro-open]');
    if (!t) return;
    e.preventDefault();
    open();
  });

  window.openProModal = open;
  return { open, close };
})();
