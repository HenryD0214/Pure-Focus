const AuthGate = (() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const gate = $('auth-gate');
  if (!gate) return {};

  const els = {
    checking: $('auth-checking'),
    checkingText: $('auth-checking-text'),
    retry: $('auth-retry'),
    ready: $('auth-ready'),
    eyebrow: $('auth-eyebrow'),
    title: $('auth-title'),
    lead: $('auth-lead'),
    google: $('auth-google'),
    form: $('auth-form'),
    email: $('auth-email'),
    name: $('auth-name'),
    nameField: $('auth-name-field'),
    password: $('auth-password'),
    remember: $('auth-remember'),
    forgot: $('auth-forgot'),
    submit: $('auth-submit'),
    status: $('auth-status'),
    switchCopy: $('auth-switch-copy'),
    switch: $('auth-switch'),
  };

  let mode = 'signin';
  let busy = false;
  let readyShown = false;
  let setupNoticed = false;

  const params = new URLSearchParams(location.search);
  const oauthFailed = params.has('error') || params.has('error_code');
  const oauthCancelled = /access_denied|cancel+ed/i.test(
    String(params.get('error_description') || '') + ' ' + String(params.get('error') || ''));

  function lock() {
    document.documentElement.classList.add('auth-locked');
    if (!gate.open) {
      try { gate.showModal(); } catch (_) { gate.setAttribute('open', ''); }
    }
  }

  function unlock() {
    document.documentElement.classList.remove('auth-locked');
    if (gate.open) { try { gate.close(); } catch (_) {} }
  }

  function setStatus(message, kind) {
    els.status.textContent = message || '';
    if (kind) els.status.dataset.kind = kind;
    else delete els.status.dataset.kind;
  }

  function submitLabel() {
    return mode === 'signup' ? 'Create account' : 'Sign in';
  }

  function setBusy(on) {
    busy = on;
    for (const el of [els.email, els.name, els.password, els.remember, els.forgot, els.google, els.submit, els.switch]) {
      if (el) el.disabled = on;
    }
    els.submit.textContent = on
      ? (mode === 'signup' ? 'Creating account…' : 'Signing in…')
      : submitLabel();
  }

  function fatal(message) {
    els.ready.hidden = true;
    els.checking.hidden = false;
    els.checking.classList.add('is-error');
    els.checkingText.textContent = message;
    els.retry.hidden = false;
  }

  function setMode(next) {
    mode = next === 'signup' ? 'signup' : 'signin';
    const signup = mode === 'signup';
    els.eyebrow.textContent = signup ? 'Get started' : 'Welcome back';
    els.title.textContent = signup ? 'Create your account.' : 'Sign in to focus.';
    els.lead.textContent = signup
      ? 'One account keeps your timer, tasks and sessions together, on every device.'
      : 'Your timer, tasks and sessions, synced across your devices.';
    els.nameField.hidden = !signup;
    els.password.autocomplete = signup ? 'new-password' : 'current-password';
    els.password.placeholder = signup ? 'At least 8 characters' : 'Your password';
    els.forgot.hidden = signup;
    els.submit.textContent = signup ? 'Create account' : 'Sign in';
    els.switchCopy.textContent = signup ? 'Already have an account?' : 'New to Pure Focus?';
    els.switch.textContent = signup ? 'Sign in' : 'Create an account';
    setStatus('');
  }

  function showReady() {
    if (readyShown) return;
    readyShown = true;
    els.checking.hidden = true;
    els.ready.hidden = false;
    if (oauthFailed) setStatus(oauthCancelled ? 'Google sign-in was cancelled.' : 'Google sign-in didn’t finish. Try again.', 'error');
    if (window.matchMedia && window.matchMedia('(min-width: 760px)').matches) {
      try { els.email.focus({ preventScroll: true }); } catch (_) {}
    }
  }

  function signedIn() {
    readyShown = false;
    setBusy(false);
    unlock();
    setTimeout(noticeSetup, 1500);
  }

  function signedOut() {
    readyShown = false;
    setBusy(false);
    setMode('signin');
    lock();
    els.checking.hidden = true;
    els.checking.classList.remove('is-error');
    els.retry.hidden = true;
    els.ready.hidden = false;
    showReady();
  }

  function noticeSetup(attempt) {
    if (setupNoticed) return;
    try { if (sessionStorage.getItem('pf.syncSetupNoticed') === '1') return; } catch (_) {}
    const st = (() => { try { return Cloud.status(); } catch (_) { return null; } })();
    if (!st || st.attention !== 'setupSQL') return;
    if (typeof App === 'undefined' || !App.toast) {
      if ((attempt || 0) < 8) setTimeout(() => noticeSetup((attempt || 0) + 1), 500);
      return;
    }
    setupNoticed = true;
    try { sessionStorage.setItem('pf.syncSetupNoticed', '1'); } catch (_) {}
    try {
      App.toast('Sync setup needed: run the database script once (Settings › Calendar & Accounts).');
    } catch (_) {}
  }

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    const email = els.email.value.trim();
    const password = els.password.value;
    if (!email || !els.email.checkValidity()) {
      setStatus('Enter a valid email address.', 'error');
      try { els.email.focus(); } catch (_) {}
      return;
    }
    if (!password) {
      setStatus('Enter your password.', 'error');
      try { els.password.focus(); } catch (_) {}
      return;
    }
    if (mode === 'signup' && password.length < 8) {
      setStatus('Use at least 8 characters.', 'error');
      try { els.password.focus(); } catch (_) {}
      return;
    }
    setStatus('');
    setBusy(true);
    try {
      if (mode === 'signup') {
        const r = await Cloud.signUp(email, password, els.name.value.trim(), { remember: els.remember.checked });
        if (r && r.status === 'confirmEmail') {
          setBusy(false);
          setMode('signin');
          els.email.value = email;
          els.password.value = '';
          setStatus('Check your inbox to confirm your account, then sign in.', 'ok');
          try { els.password.focus(); } catch (_) {}
          return;
        }
      } else {
        await Cloud.signInWithEmail(email, password, { remember: els.remember.checked });
      }
      if (Cloud.isSignedIn()) signedIn();
    } catch (err) {
      setBusy(false);
      setStatus(Cloud.authCopy(err), 'error');
    }
  }

  async function google() {
    if (busy) return;
    setStatus('');
    setBusy(true);
    els.submit.textContent = submitLabel();
    setStatus('Opening Google…');
    try {
      await Cloud.signInWithGoogle();
      if (Cloud.isSignedIn()) { signedIn(); return; }
      setTimeout(() => {
        if (Cloud.isSignedIn()) return;
        setBusy(false);
        setStatus('Google sign-in didn’t finish. Try again.', 'error');
      }, 3000);
    } catch (err) {
      setBusy(false);
      setStatus(Cloud.authCopy(err), 'error');
    }
  }

  async function forgot() {
    if (busy) return;
    const email = els.email.value.trim();
    if (!email || !els.email.checkValidity()) {
      setStatus('Enter your email first.', 'error');
      try { els.email.focus(); } catch (_) {}
      return;
    }
    setStatus('');
    setBusy(true);
    els.submit.textContent = submitLabel();
    setStatus('Sending a reset link…');
    try {
      await Cloud.resetPassword(email);
      setBusy(false);
      setStatus('Check your inbox for a reset link.', 'ok');
    } catch (err) {
      setBusy(false);
      setStatus(Cloud.authCopy(err), 'error');
    }
  }

  gate.addEventListener('cancel', (e) => e.preventDefault());
  gate.addEventListener('close', () => {
    if (document.documentElement.classList.contains('auth-locked')) {
      setTimeout(() => { try { gate.showModal(); } catch (_) {} }, 0);
    }
  });

  els.retry.addEventListener('click', () => location.reload());
  els.form.addEventListener('submit', submit);
  els.google.addEventListener('click', google);
  els.forgot.addEventListener('click', forgot);
  els.switch.addEventListener('click', () => setMode(mode === 'signup' ? 'signin' : 'signup'));

  lock();

  (async function init() {
    if (typeof Cloud === 'undefined') {
      fatal('Sign-in is unavailable right now. Reload the page to try again.');
      return;
    }
    Cloud.on('user', (u) => { if (u) signedIn(); else signedOut(); });
    Cloud.on('status', (st) => { if (Cloud.isSignedIn() && st && st.attention === 'setupSQL') noticeSetup(); });

    try {
      await Promise.race([Cloud.init(), new Promise((resolve) => setTimeout(resolve, 15000))]);
    } catch (_) {}

    if (Cloud.isSignedIn()) { signedIn(); return; }
    if (!Cloud.isConfigured()) {
      fatal('Sign-in isn’t set up on this site yet.');
      return;
    }
    const st = (() => { try { return Cloud.status(); } catch (_) { return null; } })();
    if (st && st.state === 'attention' && st.attention === 'unreachable') {
      fatal('Can’t reach the sign-in service. Check your connection, then try again.');
      return;
    }
    if (st && st.state === 'attention' && st.attention === 'key') {
      fatal('Sign-in is unavailable: this site’s key was rejected.');
      return;
    }
    if (st && st.state === 'connecting') {
      fatal('The sign-in service is taking too long. Try again in a moment.');
      return;
    }
    showReady();
  })();

  return { show: lock, hide: unlock };
})();
