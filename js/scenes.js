/* ═══════════════════════════════════════════════════════════════════════
   scenes.js — background video "Scenes" (owner: W5; USER-HOTFIX-1 H2/H10, USER-HOTFIX-2 H13)

   Calm by design: the video is STILL framing (no zoom, drift or pan of our own), the poster
   shows at once, the smallest good rendition (Mixkit 720p) plays first (1080p / 4K only when
   picked in Quality), and the clip loops forever with ONE gentle crossfade between two
   <video> elements (the next pass fades in ~1.5 s before the end — no seam, no jump).
   Switching scenes fades through the new scene's poster; at most two <video> elements ever
   exist; video pauses when the tab is hidden or another page is open; Reduce Motion shows the
   poster only. A scene never forces the dark theme (light mode gets light frosted glass).

   Persisted in localStorage 'purefocus.scene' as {sceneId, quality, dim, poster}.
   sceneId '' = None (the animated Aurora). dim < 0 = the scene's own default.

   Public API: Scenes.init(), Scenes.set(id), Scenes.current()
   Extras:     Scenes.setQuality(q), Scenes.setDim(d), Scenes.retry(), Scenes.open(anchor?),
               Scenes.openPicker(anchor?), Scenes.close(), Scenes.list(), Scenes.state(),
               Scenes.dockButton() → the labeled "Background: …" button for the Focus dock
   Event:      document 'scenes:change' (detail {sceneId, title, mood, pairs})
   Every catalogue string reaches the DOM through textContent / setAttribute.
   ═══════════════════════════════════════════════════════════════════════ */

const Scenes = (() => {
  'use strict';

  const STORE_KEY = 'purefocus.scene';
  const CATALOGUE_URL = 'assets/scenes/scenes.json';
  const MIXKIT_ORIGIN = 'https://assets.mixkit.co/';
  const MIXKIT_LICENCE = 'https://mixkit.co/license/#videoFree';
  const DEFAULTS = Object.freeze({ sceneId: '', quality: 'auto', dim: -1, poster: '' });
  const QUALITY_OPTIONS = [
    ['auto', 'Standard · 720p, loads fast'],
    ['1080p', 'High · 1080p, large download'],
    ['4k', 'Highest · 4K, very large download'],
    ['still', 'Still image only'],
  ];
  // Clips with a moving camera loop with a visible ghost — kept out of the picker (H13: calm).
  const HIDDEN = new Set(['library']);
  const MIGRATE = { library: 'lofi-vinyl' };
  const FADE_SEC = { 'sea-of-clouds': 2.0, 'rainy-window': 1.2 };
  const COVER_IN_MS = 450;        // poster cover fade-in when switching scenes
  const COVER_WAIT_MS = 7000;     // reveal the poster anyway if a video is this slow
  const SLOW_NOTICE_MS = 10000;   // quiet toast if the video still has no frame
  const WATCH_MS = 1500;          // playback watchdog tick
  const FROZEN_TICKS = 4;         // ~6 s with no new frame while it should be playing → reload
  const LOAD_HANG_MS = 15000;     // a first frame this late → reload
  const RETRY_MAX_MS = 30000;     // reload / error retries back off to this, and never give up

  // ── state ──
  let inited = false;
  let catalogue = null;
  let catalogueFailed = false;
  let scenes = [];
  let byId = new Map();
  let prefs = loadPrefs();
  let root = null;
  let stage = null;
  let base = null;               // the current scene's poster, under the videos
  let cover = null;              // a poster over everything, used to fade between scenes
  let onFocusRoute = true;
  let reducedMQ = null;
  let lastMotion = true;
  let lastToast = 0;

  // UI
  let pickerBtn = null;          // interim button in #scene-picker-root (hidden by the dock)
  let anchorBtn = null;          // whatever opened the popover
  const dockBtns = new Set();
  let popover = null;
  let popSub = null;
  let popCloseTimer = 0;
  let nowChip = null;
  let clipCredit = null;
  const grids = new Set();
  const controlSets = [];
  const creditNodes = new Set();

  // ── persistence ──

  function normalise(p) {
    const out = { ...DEFAULTS };
    if (!p || typeof p !== 'object') return out;
    if (typeof p.sceneId === 'string') out.sceneId = MIGRATE[p.sceneId] || p.sceneId;
    if (p.quality === '720p') out.quality = 'auto';
    else if (QUALITY_OPTIONS.some(([id]) => id === p.quality)) out.quality = p.quality;
    if (p.dim !== null && p.dim !== undefined && p.dim !== '') {
      const d = Number(p.dim);
      if (Number.isFinite(d)) out.dim = d < 0 ? -1 : Math.min(0.8, d);
    }
    if (typeof p.poster === 'string' && /^https:\/\/[^\s"'<>]+$/.test(p.poster) && !MIGRATE[p.sceneId]) out.poster = p.poster;
    return out;
  }

  function loadPrefs() {
    try { return normalise(JSON.parse(localStorage.getItem(STORE_KEY) || 'null')); } catch (_) { return { ...DEFAULTS }; }
  }

  function savePrefs() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ sceneId: prefs.sceneId, quality: prefs.quality, dim: prefs.dim, poster: prefs.poster }));
    } catch (_) { /* private mode — the scene still works for this visit */ }
  }

  // ── tiny DOM helpers (no innerHTML anywhere) ──

  function el(tag, className, attrs) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'text') n.textContent = String(v);
        else n.setAttribute(k, v === true ? '' : String(v));
      }
    }
    return n;
  }

  const NS = 'http://www.w3.org/2000/svg';
  function icon(def, cls) {
    const [viewBox, parts] = def;
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', viewBox);
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    if (cls) s.setAttribute('class', cls);
    for (const p of parts) {
      const e = document.createElementNS(NS, p.tag || 'path');
      for (const [k, v] of Object.entries(p)) if (k !== 'tag') e.setAttribute(k, v);
      s.appendChild(e);
    }
    return s;
  }

  const STROKE = { fill: 'none', stroke: 'currentColor', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  const ICON_SCENE = ['0 0 20 20', [
    { tag: 'rect', x: '2.4', y: '3.8', width: '15.2', height: '12.4', rx: '3.2', ...STROKE, 'stroke-width': '1.6' },
    { d: 'M2.9 13.6l4.1-4.1 3.1 3 2.1-2.1 4.9 4.6', ...STROKE, 'stroke-width': '1.6' },
    { tag: 'circle', cx: '13.3', cy: '7.5', r: '1.45', fill: 'currentColor' },
  ]];
  const ICON_CHEVRON = ['0 0 12 12', [{ d: 'M3 4.6 6 7.6l3-3', ...STROKE, 'stroke-width': '1.6' }]];
  const ICON_CHECK = ['0 0 16 16', [{ d: 'M4 8.4l2.6 2.5L12 5.4', ...STROKE, 'stroke-width': '2.2' }]];
  const ICON_CLOSE = ['0 0 20 20', [{ d: 'M5.5 5.5l9 9m0-9-9 9', ...STROKE, 'stroke-width': '1.8' }]];
  const ICON_ALERT = ['0 0 16 16', [
    { d: 'M8 2.2l6.2 11H1.8z', ...STROKE, 'stroke-width': '1.5' },
    { d: 'M8 6.6v3', ...STROKE, 'stroke-width': '1.6' },
    { tag: 'circle', cx: '8', cy: '11.4', r: '.85', fill: 'currentColor' },
  ]];

  function safeHttps(url, fallback = '') {
    return typeof url === 'string' && /^https:\/\/[^\s"'<>]+$/.test(url) ? url : fallback;
  }

  function link(href, text) {
    return el('a', 'scene-link', { href, text, target: '_blank', rel: 'noopener noreferrer' });
  }

  // ── catalogue + URLs ──

  function baseUrl() {
    const cfgs = [
      typeof window.PF_CONFIG === 'object' ? window.PF_CONFIG : null,
      typeof Config === 'object' ? Config : null, // eslint-disable-line no-undef
    ];
    for (const c of cfgs) {
      const b = c && c.SCENE_BASE_URL;
      if (typeof b === 'string' && /^https?:\/\//.test(b)) return b.replace(/\/?$/, '/');
    }
    return '';
  }

  // Optional self-hosting: PF_CONFIG.SCENE_BASE_URL replaces the Mixkit prefix.
  function rebase(url) {
    const u = safeHttps(url);
    if (!u) return '';
    const b = baseUrl();
    return b && u.startsWith(MIXKIT_ORIGIN) ? b + u.slice(MIXKIT_ORIGIN.length) : u;
  }

  function validScene(s) {
    return s && typeof s.id === 'string' && /^[a-z0-9-]+$/.test(s.id) && typeof s.title === 'string' && safeHttps(s.poster);
  }

  function activeScene() {
    return catalogue ? byId.get(prefs.sceneId) || null : null;
  }

  function effectiveDim(scene) {
    if (prefs.dim >= 0) return prefs.dim;
    const d = scene && Number(scene.defaultDim);
    return Number.isFinite(d) ? d : 0.3;
  }

  // ── quality: the smallest good rendition unless the person picks more ──

  function connection() {
    return navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
  }

  function resolveQuality(q = prefs.quality) {
    if (q === 'auto') {
      const c = connection();
      if (c && c.saveData) return 'still';
      return '720p';
    }
    return q;
  }

  function videoUrl(scene, q) {
    const key = { '4k': 'url4k', '1080p': 'url1080', '720p': 'url720' }[q];
    return key ? rebase(scene[key]) || rebase(scene.url720) : '';
  }

  // ── motion + playback policy ──

  function motionAllowed() {
    if (reducedMQ && reducedMQ.matches) return false;
    return !document.body.classList.contains('reduce-motion');
  }

  function wantsVideo() { return motionAllowed() && resolveQuality() !== 'still'; }
  function shouldPlay() { return !document.hidden && onFocusRoute; }

  function notify(msg) {
    const now = Date.now();
    if (now - lastToast < 4000) return;
    lastToast = now;
    if (typeof App === 'object' && App && typeof App.toast === 'function') App.toast(msg);
  }

  // ═══════════════════  the background layer  ═══════════════════

  function buildRoot() {
    root = document.getElementById('scene-root');
    if (!root) {
      root = el('div', '', { id: 'scene-root', 'aria-hidden': 'true' });
      document.body.prepend(root);
    }
    root.classList.add('scene-root');
    root.textContent = '';
    stage = el('div', 'scene-stage');
    base = el('img', 'scene-poster', { alt: '', decoding: 'async', draggable: 'false' });
    cover = el('img', 'scene-cover', { alt: '', decoding: 'async', draggable: 'false' });
    base.addEventListener('load', () => base.classList.add('is-on'));
    base.addEventListener('error', () => base.classList.remove('is-on'));
    stage.append(base, cover);
    root.append(stage, el('div', 'scene-tint'), el('div', 'scene-dim'), el('div', 'scene-vignette'), el('div', 'scene-grain'));
  }

  /* The video engine. Two elements at most (A/B). One is "active" (visible, playing); the
     other is its loop partner: the same clip, loaded and parked at frame 0. ~1.5 s before
     the active one ends, the partner starts and fades in over it; then they swap roles. */
  const VE = {
    els: [], active: 0, url: '', sceneId: '', fade: 1.5, ready: false, fading: false,
    loopTimer: 0, fadeTimer: 0, partnerTimer: 0, slowTimer: 0, failedUrl: '', token: 0, onReady: null,
    startedAt: 0, fadeAt: 0, failedScene: '',
  };

  /* "Plays without fail": the watchdog notices a video that should be playing but isn't — paused by
     the browser, stalled on the network, frozen after a crossfade — and nudges or reloads it, backing
     off to RETRY_MAX_MS. Load errors retry the same way instead of settling on the still for good. */
  const WD = { lastT: -1, frozen: 0, restarts: 0, nextAt: 0, needGesture: false, gestureSince: 0, hinted: false, retryTimer: 0, retryN: 0 };

  // Autoplay refused (e.g. Safari Low Power Mode): the next click or key anywhere starts it.
  function clearGesture() {
    if (!WD.needGesture) return;
    WD.needGesture = false;
    for (const t of ['pointerdown', 'keydown', 'touchend']) document.removeEventListener(t, onGesture, true);
  }
  function onGesture() {
    if (!WD.needGesture) return;
    clearGesture();
    updatePlayback();
    // Unlock the loop partner inside this same gesture too (WebKit grants play() per element),
    // or the first loop would land on a frozen frame: play it for a moment, then park it.
    const b = partnerV();
    if (b && VE.url) {
      preparePartner();
      try {
        const p = b.play();
        if (p && p.then) p.then(() => { if (b !== activeV() && !VE.fading) { b.pause(); try { b.currentTime = 0; } catch (_) {} } }).catch(() => {});
      } catch (_) { /* ignore */ }
    }
  }
  function waitForGesture() {
    if (WD.needGesture) return;
    WD.needGesture = true;
    WD.gestureSince = Date.now();
    for (const t of ['pointerdown', 'keydown', 'touchend']) document.addEventListener(t, onGesture, true);
  }

  function playV(v) {
    try {
      const p = v.play();
      if (p && p.catch) p.catch((err) => { if (err && err.name === 'NotAllowedError') waitForGesture(); });
    } catch (_) { /* ignore */ }
  }

  function backoff(n) { return Math.min(RETRY_MAX_MS, 2000 * 2 ** Math.max(0, n - 1)); }

  // Reload the current clip from scratch (the scene's poster shows underneath meanwhile).
  function reloadVideo() {
    const now = Date.now();
    if (now < WD.nextAt || !VE.url) return;
    WD.restarts += 1;
    WD.nextAt = now + backoff(WD.restarts);
    WD.frozen = 0; WD.lastT = -1;
    startVideo(VE.url, VE.sceneId);
  }

  function watchdog() {
    if (!VE.url || !shouldPlay()) { WD.frozen = 0; WD.lastT = -1; return; }
    const a = activeV();
    if (!a || a.dataset.url !== VE.url) return;
    const now = Date.now();
    if (WD.needGesture) {
      // A refusal is often momentary (page not painted yet, window just shown): keep asking, and
      // only after a few seconds tell the person that one click will start it.
      if (a.paused) playV(a);
      if (!WD.hinted && now - WD.gestureSince > 4000) { WD.hinted = true; notify('Click anywhere to start the background video.'); }
      WD.frozen = 0; WD.lastT = -1;
      return;
    }
    if (VE.fading) {
      // a crossfade that never finished (timer throttled, partner never played): land it
      if (now - VE.fadeAt > VE.fade * 1000 + 3000) { clearTimeout(VE.fadeTimer); finishCrossfade(a, partnerV()); }
      return;
    }
    if (!VE.ready) {
      if (a.paused) playV(a);
      if (now - VE.startedAt > LOAD_HANG_MS) reloadVideo();
      return;
    }
    if (a.ended) { onEnded(a); return; }
    if (a.paused) { playV(a); WD.frozen += 1; }
    else if (Math.abs(a.currentTime - WD.lastT) < 0.01) WD.frozen += 1;
    else { WD.frozen = 0; WD.restarts = 0; WD.nextAt = 0; }
    WD.lastT = a.currentTime;
    if (!a.paused && WD.frozen === 2) armLoop();   // a lost loop timer
    if (WD.frozen >= FROZEN_TICKS) reloadVideo();
  }

  function scheduleRetry(url, sceneId) {
    clearTimeout(WD.retryTimer);
    WD.retryN += 1;
    WD.retryTimer = setTimeout(() => retryFailed(url, sceneId), backoff(WD.retryN));
  }
  function retryFailed(url, sceneId) {
    if (!url || VE.failedUrl !== url || shownSceneId !== sceneId) return;
    if (!shouldPlay()) { scheduleRetry(url, sceneId); return; }
    VE.failedUrl = '';
    startVideo(url, sceneId);
    refreshUI();
  }

  function makeVideo(i) {
    const v = document.createElement('video');
    v.className = 'scene-video';
    v.muted = true;
    v.defaultMuted = true;
    v.playsInline = true;
    for (const a of ['muted', 'playsinline', 'webkit-playsinline', 'disablepictureinpicture', 'disableremoteplayback']) v.setAttribute(a, '');
    v.setAttribute('aria-hidden', 'true');
    v.setAttribute('preload', 'auto');
    v.tabIndex = -1;
    v.dataset.i = String(i);
    v.addEventListener('playing', () => { if (v === activeV()) clearGesture(); onPlaying(v); });
    v.addEventListener('timeupdate', () => { if (v === activeV()) armLoop(); });
    v.addEventListener('ended', () => onEnded(v));
    v.addEventListener('error', () => onVideoError(v));
    stage.insertBefore(v, cover);
    return v;
  }

  function vids() {
    if (!VE.els.length) VE.els = [makeVideo(0), makeVideo(1)];
    return VE.els;
  }
  function activeV() { return VE.els[VE.active] || null; }
  function partnerV() { return VE.els[1 - VE.active] || null; }

  function clearTimers() {
    clearTimeout(VE.loopTimer); VE.loopTimer = 0;
    clearTimeout(VE.fadeTimer); VE.fadeTimer = 0;
    clearTimeout(VE.partnerTimer); VE.partnerTimer = 0;
    clearTimeout(VE.slowTimer); VE.slowTimer = 0;
  }

  // Instant (un-animated) visibility change for an element that is covered anyway.
  function snapOff(v) {
    v.classList.add('is-snap');
    v.classList.remove('is-on', 'is-top');
    void v.offsetWidth;
    v.classList.remove('is-snap');
  }

  function unload(v) {
    try { v.pause(); } catch (_) {}
    if (v.getAttribute('src')) {
      v.removeAttribute('src');
      try { v.load(); } catch (_) {}
    }
    v.dataset.url = '';
    snapOff(v);
  }

  function stopVideo() {
    clearTimers();
    VE.token += 1;
    VE.url = ''; VE.ready = false; VE.fading = false; VE.onReady = null;
    for (const v of VE.els) unload(v);
  }

  function startVideo(url, sceneId) {
    const vs = vids();
    clearTimers();
    VE.token += 1;
    const token = VE.token;
    VE.url = url; VE.sceneId = sceneId; VE.ready = false; VE.fading = false;
    VE.fade = FADE_SEC[sceneId] || 1.5;
    VE.active = 0;
    VE.startedAt = Date.now();
    for (const v of vs) unload(v);
    const a = vs[0];
    a.dataset.url = url;
    a.src = url;
    try { a.load(); } catch (_) {}
    if (shouldPlay()) playV(a);
    VE.slowTimer = setTimeout(() => {
      if (token === VE.token && !VE.ready && !document.hidden && onFocusRoute) notify('This background is taking a while — showing the still for now.');
    }, SLOW_NOTICE_MS);
  }

  function onPlaying(v) {
    if (v.dataset.url !== VE.url || !VE.url) return;
    if (v === activeV() && !VE.ready) {
      VE.ready = true;
      clearTimeout(VE.slowTimer);
      WD.retryN = 0;
      clearGesture();
      v.classList.add('is-on');
      if (VE.onReady) { const f = VE.onReady; VE.onReady = null; f(); }
      // The loop partner loads once the first pass is safely under way.
      const token = VE.token;
      VE.partnerTimer = setTimeout(() => { if (token === VE.token) preparePartner(); }, 2500);
      armLoop();
      refreshUI();
    }
  }

  function preparePartner() {
    const p = partnerV();
    if (!p || !VE.url || p.dataset.url === VE.url) return;
    p.dataset.url = VE.url;
    p.src = VE.url;
    try { p.load(); } catch (_) {}
  }

  function armLoop() {
    clearTimeout(VE.loopTimer); VE.loopTimer = 0;
    const a = activeV();
    if (!a || !VE.ready || VE.fading || !shouldPlay() || a.paused) return;
    const dur = a.duration;
    if (!isFinite(dur) || dur < 3) return;
    const lead = VE.fade + 0.3;
    const wait = (dur - a.currentTime - lead) / (a.playbackRate || 1);
    if (wait <= 0.05) { crossfade(); return; }
    VE.loopTimer = setTimeout(crossfade, wait * 1000);
  }

  function crossfade() {
    clearTimeout(VE.loopTimer); VE.loopTimer = 0;
    const a = activeV(), b = partnerV();
    if (!a || !b || VE.fading || !VE.ready || !shouldPlay()) return;
    if (b.dataset.url !== VE.url || b.readyState < 2 || b.error) { preparePartner(); return; }   // 'ended' restarts instead
    const dur = a.duration;
    if (isFinite(dur) && dur - a.currentTime > VE.fade + 0.6) { armLoop(); return; }    // woke early (seek/throttle)
    VE.fading = true;
    VE.fadeAt = Date.now();
    const token = VE.token;
    try { if (b.currentTime > 0.05) b.currentTime = 0; } catch (_) {}
    a.classList.remove('is-top');
    b.classList.add('is-top');
    b.style.setProperty('--scene-xf', `${VE.fade}s`);
    let begun = false;
    const begin = () => {
      if (begun || token !== VE.token) return;
      begun = true;
      b.classList.add('is-on');
      VE.fadeTimer = setTimeout(() => {
        if (token !== VE.token) return;
        finishCrossfade(a, b);
      }, VE.fade * 1000 + 120);
    };
    b.addEventListener('playing', begin, { once: true });
    playV(b);
    if (!b.paused && b.readyState >= 3) begin();
    setTimeout(begin, 400);   // never wait on a missing 'playing'
  }

  function finishCrossfade(a, b) {
    clearTimeout(VE.fadeTimer); VE.fadeTimer = 0;
    b.classList.add('is-on');
    VE.active = VE.els.indexOf(b);
    VE.fading = false;
    try { a.pause(); } catch (_) {}
    snapOff(a);
    try { a.currentTime = 0; } catch (_) {}   // parked at frame 0, ready for the next pass
    if (b.paused && shouldPlay()) playV(b);   // never land on a frozen frame
    armLoop();
  }

  function onEnded(v) {
    if (v !== activeV() || VE.fading) return;
    // No partner ready in time: restart this one (a cut, but never a stop).
    try { v.currentTime = 0; } catch (_) {}
    if (shouldPlay()) playV(v);
  }

  function onVideoError(v) {
    if (!v.dataset.url || v.dataset.url !== VE.url) return;
    if (v !== activeV()) { unload(v); return; }   // partner failed: 'ended' restarts the active one
    const url = VE.url, sceneId = VE.sceneId;
    stopVideo();
    VE.failedUrl = url;
    VE.failedScene = sceneId;
    if (VE.onReady) { const f = VE.onReady; VE.onReady = null; f(); }
    if (WD.retryN === 0) notify('Couldn’t load this background’s video — showing the still and trying again.');
    scheduleRetry(url, sceneId);
    hideCover();
    refreshUI();
  }

  function updatePlayback() {
    if (!root) return;
    root.classList.toggle('is-still', !onFocusRoute);
    const go = shouldPlay();
    if (!go) {
      clearTimeout(VE.loopTimer); VE.loopTimer = 0;
      if (VE.fading) {
        const a = activeV(), b = partnerV();
        clearTimeout(VE.fadeTimer);
        if (a && b) finishCrossfade(a, b);
        clearTimeout(VE.loopTimer); VE.loopTimer = 0;
      }
      for (const v of VE.els) { try { v.pause(); } catch (_) {} }
      return;
    }
    const a = activeV();
    if (a && VE.url && a.dataset.url === VE.url) {
      playV(a);
      if (VE.ready) armLoop();
    } else if (VE.failedUrl && !VE.url) {
      retryFailed(VE.failedUrl, VE.failedScene);
    }
  }

  // ── poster cover: scene switches fade through the new scene's still ──

  function hideCover() { cover.classList.remove('is-on'); }

  function withPoster(img, url, done) {
    let fired = false;
    const fire = () => { if (!fired) { fired = true; done(); } };
    if (!url) { fire(); return; }
    img.addEventListener('load', fire, { once: true });
    img.addEventListener('error', fire, { once: true });
    if (img.getAttribute('src') === url && img.complete) { fire(); return; }
    img.src = url;
    setTimeout(fire, 1500);
  }

  let showToken = 0;
  function showScene(scene, url) {
    const token = ++showToken;
    const posterUrl = rebase(scene.poster);
    const visible = VE.ready || (base.classList.contains('is-on') && base.getAttribute('src') !== posterUrl);
    if (!visible) {
      // First scene on this page: the poster appears at once, the video fades in over it.
      withPoster(base, posterUrl, () => {});
      if (url) startVideo(url, scene.id); else stopVideo();
      return;
    }
    withPoster(cover, posterUrl, () => {
      if (token !== showToken) return;
      cover.classList.add('is-on');
      setTimeout(() => {
        if (token !== showToken) return;
        stopVideo();
        base.src = posterUrl;
        if (!url) { setTimeout(() => { if (token === showToken) hideCover(); }, 150); return; }
        VE.onReady = () => { if (token === showToken) hideCover(); };
        startVideo(url, scene.id);
        setTimeout(() => { if (token === showToken) hideCover(); }, COVER_WAIT_MS);
      }, COVER_IN_MS);
    });
  }

  function syncScheme() {
    // A scene never forces dark (H3): the shell's light theme styles light glass over video.
    document.documentElement.classList.toggle('has-video', document.body.classList.contains('has-scene'));
    syncTone();
  }

  // ── tone: is the picture behind the glass dark? html[data-scene-tone="dark|light"] ──
  // Settings.applyTheme reads it: in Light over a dark scene the Focus page's glass turns clear with
  // white words (css/glass.css "scene-adapt"). Each catalogue scene carries `luma`, the median
  // brightness of its poster (sRGB 0–1); a scene without one is measured from its poster (CORS *).
  // Dim darkens it the way the black dim layer does, in linear light. Remembered for the first paint.
  const TONE_KEY = 'purefocus.ui.sceneTone';
  const DARK_BELOW = 0.28;
  const measured = new Map();          // poster url → median brightness (null when unreadable)
  const toLinear = (g) => (g <= 0.04045 ? g / 12.92 : Math.pow((g + 0.055) / 1.055, 2.4));
  const toGamma = (l) => (l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055);
  function measureLuma(url) {
    if (!url) return Promise.resolve(null);
    if (measured.has(url)) return Promise.resolve(measured.get(url));
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        let v = null;
        try {
          const c = document.createElement('canvas');
          c.width = 48; c.height = 27;
          const x = c.getContext('2d');
          x.drawImage(img, 0, 0, 48, 27);
          const d = x.getImageData(0, 0, 48, 27).data;
          const L = [];
          for (let i = 0; i < d.length; i += 4) L.push((0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255);
          L.sort((a, b) => a - b);
          v = L[L.length >> 1];
        } catch (_) { v = null; }          // unreadable (no CORS): no tone, the theme stays as chosen
        measured.set(url, v);
        resolve(v);
      };
      img.onerror = () => { measured.set(url, null); resolve(null); };
      img.src = url;
    });
  }
  let toneToken = 0;
  function setTone(tone) {
    const r = document.documentElement;
    try { if (tone) localStorage.setItem(TONE_KEY, tone); else localStorage.removeItem(TONE_KEY); } catch (_) {}
    if ((r.dataset.sceneTone || '') === tone) return;
    if (tone) r.dataset.sceneTone = tone; else delete r.dataset.sceneTone;
    try { if (typeof Settings !== 'undefined' && Settings.applyTheme) Settings.applyTheme(); } catch (_) {}
  }
  function syncTone() {
    if (!document.body.classList.contains('has-scene')) { toneToken += 1; setTone(''); return; }
    const scene = catalogue ? activeScene() : null;
    if (!scene) return;                  // the catalogue is still loading: keep the remembered tone
    const token = ++toneToken;
    const decide = (luma) => {
      if (token !== toneToken || luma == null) return;
      const seen = toGamma(toLinear(luma) * (1 - effectiveDim(scene)));
      setTone(seen < DARK_BELOW ? 'dark' : 'light');
    };
    const known = Number(scene.luma);
    if (Number.isFinite(known)) decide(known);
    else measureLuma(rebase(scene.posterSmall || scene.poster)).then(decide);
  }

  let shownSceneId = null;
  function render() {
    if (!root) return;
    if (!catalogue) {
      // Before the catalogue arrives, show the remembered poster straight away.
      const has = !!prefs.sceneId && !catalogueFailed;
      document.body.classList.toggle('has-scene', has);
      syncScheme();
      if (has && prefs.poster && !base.getAttribute('src')) base.src = rebase(prefs.poster);
      refreshUI();
      return;
    }

    const scene = activeScene();
    document.body.classList.toggle('has-scene', !!scene);
    syncScheme();

    if (!scene) {
      showToken += 1;
      stopVideo();
      shownSceneId = null;
      base.classList.remove('is-on');
      hideCover();
      refreshUI();
      return;
    }

    root.style.setProperty('--scene-dim', effectiveDim(scene).toFixed(3));
    let want = wantsVideo() ? videoUrl(scene, resolveQuality()) : '';
    if (want && want === VE.failedUrl) want = '';

    if (shownSceneId !== scene.id) {
      shownSceneId = scene.id;
      VE.failedUrl = '';
      want = wantsVideo() ? videoUrl(scene, resolveQuality()) : '';
      showScene(scene, want);
    } else if (want !== VE.url) {
      if (!want) stopVideo();
      else showScene(scene, want);   // quality change: through the poster
    }
    updatePlayback();
    refreshUI();
  }

  function emit() {
    const s = activeScene();
    const detail = s
      ? { sceneId: s.id, title: s.title, mood: s.mood, pairs: s.pairs ? { ...s.pairs } : null }
      : { sceneId: '', title: 'None (Aurora)', mood: null, pairs: null };
    try { document.dispatchEvent(new CustomEvent('scenes:change', { detail })); } catch (_) {}
  }

  // ── public setters ──

  function set(id) {
    const next = id === null || id === undefined || id === 'none' || id === 'aurora' ? '' : String(id);
    if (next && catalogue && !byId.has(next)) return false;
    const changed = next !== prefs.sceneId;
    prefs.sceneId = next;
    const s = next && byId.get(next);
    prefs.poster = s ? safeHttps(s.poster) : '';
    savePrefs();
    if (!changed) VE.failedUrl = '';   // a re-click retries
    render();
    if (changed) emit();
    return true;
  }

  function setQuality(q) {
    if (!QUALITY_OPTIONS.some(([id]) => id === q)) return false;
    prefs.quality = q;
    savePrefs();
    VE.failedUrl = '';
    render();
    return true;
  }

  function setDim(d) {
    const n = Number(d);
    if (!Number.isFinite(n)) return false;
    prefs.dim = n < 0 ? -1 : Math.max(0, Math.min(0.8, n));
    savePrefs();
    if (root) root.style.setProperty('--scene-dim', effectiveDim(activeScene()).toFixed(3));
    syncControls();
    syncTone();
    return true;
  }

  function retry() {
    VE.failedUrl = '';
    clearTimeout(WD.retryTimer); WD.retryN = 0; WD.restarts = 0; WD.nextAt = 0;
    const s = activeScene();
    if (s && wantsVideo()) showScene(s, videoUrl(s, resolveQuality()));
    refreshUI();
  }

  // ═══════════════════  picker UI  ═══════════════════

  function pickable() { return scenes.filter((s) => !HIDDEN.has(s.id) || s.id === prefs.sceneId); }

  function buildTile(scene) {
    const id = scene ? scene.id : '';
    const tile = el('button', 'scene-tile' + (scene ? '' : ' scene-tile--none'), {
      type: 'button',
      'data-id': id,
      'aria-pressed': 'false',
      'aria-label': scene ? `${scene.title} · ${scene.mood || 'Scene'}` : 'None — animated colours',
      title: scene ? `${scene.title} — ${scene.mood || 'video'} background` : 'No video: the soft animated colours of your theme',
    });

    const media = el('span', 'scene-tile-media', { 'aria-hidden': 'true' });
    if (scene) {
      const img = el('img', '', { alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
      img.addEventListener('load', () => tile.classList.add('is-loaded'), { once: true });
      img.addEventListener('error', () => tile.classList.add('is-broken'), { once: true });
      img.src = rebase(scene.posterSmall || scene.poster);
      media.append(img);
    } else {
      const aur = el('span', 'scene-mini-aurora');
      aur.append(el('span', 'b1'), el('span', 'b2'), el('span', 'b3'));
      media.append(aur);
    }

    const check = el('span', 'scene-tile-check', { 'aria-hidden': 'true' });
    check.append(icon(ICON_CHECK));
    const warn = el('span', 'scene-tile-warn', { 'aria-hidden': 'true', title: 'Video unavailable — showing the still' });
    warn.append(icon(ICON_ALERT));

    tile.append(
      media,
      el('span', 'scene-tile-shade', { 'aria-hidden': 'true' }),
      check,
      warn,
      el('span', 'scene-tile-title', { text: scene ? scene.title : 'No video' }),
    );
    tile.addEventListener('click', () => set(id));
    return tile;
  }

  function fillGrid(grid) {
    grid.textContent = '';
    grid.append(buildTile(null));
    for (const s of pickable()) grid.append(buildTile(s));
    if (!catalogue) {
      grid.append(el('p', 'scene-grid-note', { text: catalogueFailed ? 'Backgrounds couldn’t be loaded. Check your connection.' : 'Loading backgrounds…' }));
    }
    syncTiles(grid);
  }

  function buildGrid(cls) {
    const grid = el('div', cls, { role: 'group', 'aria-label': 'Background' });
    grid.addEventListener('keydown', onGridKey);
    grids.add(grid);
    fillGrid(grid);
    return grid;
  }

  function activeId() {
    const s = activeScene();
    return s ? s.id : '';
  }

  function syncTiles(grid) {
    const id = activeId();
    const failed = !!VE.failedUrl && !!id;
    let selected = null;
    for (const tile of grid.querySelectorAll('.scene-tile')) {
      const on = tile.dataset.id === id;
      tile.setAttribute('aria-pressed', String(on));
      tile.classList.toggle('is-failed', on && failed);
      tile.tabIndex = -1;
      if (on) selected = tile;
    }
    const focused = grid.contains(document.activeElement) && document.activeElement.classList.contains('scene-tile')
      ? document.activeElement : null;
    const t = focused || selected || grid.querySelector('.scene-tile');
    if (t) t.tabIndex = 0;
  }

  function onGridKey(e) {
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const grid = e.currentTarget;
    const tiles = Array.from(grid.querySelectorAll('.scene-tile'));
    const i = tiles.indexOf(document.activeElement);
    if (i < 0) return;
    const top = tiles[0].offsetTop;
    const cols = Math.max(1, tiles.filter((t) => t.offsetTop === top).length);
    let j = i;
    if (e.key === 'ArrowLeft') j = i - 1;
    else if (e.key === 'ArrowRight') j = i + 1;
    else if (e.key === 'ArrowUp') j = i - cols;
    else if (e.key === 'ArrowDown') j = i + cols;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = tiles.length - 1;
    j = Math.max(0, Math.min(tiles.length - 1, j));
    e.preventDefault();
    tiles.forEach((t) => { t.tabIndex = -1; });
    tiles[j].tabIndex = 0;
    tiles[j].focus();
    tiles[j].scrollIntoView({ block: 'nearest' });
  }

  // ── controls (quality + dim) ──

  function buildControls(variant) {
    const wrap = el('div', `scene-controls scene-controls--${variant}`);
    const qId = `scene-quality-${variant}`;
    const dId = `scene-dim-${variant}`;

    const qField = el('div', 'field scene-field');
    const qLabel = el('label', 'field-label', { for: qId, text: 'Video quality' });
    const select = el('select', 'select scene-select', { id: qId, title: 'Standard loads fastest and looks good behind the glass' });
    for (const [id, label] of QUALITY_OPTIONS) select.append(el('option', '', { value: id, text: label }));
    select.addEventListener('change', () => setQuality(select.value));
    qField.append(qLabel, select);

    const dField = el('div', 'field scene-field');
    const dLabel = el('label', 'field-label', { for: dId });
    const value = el('span', 'field-value');
    dLabel.append(document.createTextNode('Darken video'), value);
    const row = el('div', 'scene-dim-row');
    const range = el('input', 'scene-range', { type: 'range', id: dId, min: '0', max: '70', step: '1', 'aria-describedby': `${dId}-hint` });
    const auto = el('button', 'scene-auto-btn', { type: 'button', 'aria-pressed': 'true', title: 'Use the amount recommended for this background', text: 'Auto' });
    range.addEventListener('input', () => setDim(Number(range.value) / 100));
    auto.addEventListener('click', () => setDim(-1));
    row.append(range, auto);
    dField.append(dLabel, row, el('span', 'scene-sr', { id: `${dId}-hint`, text: 'How much the video is darkened behind the cards' }));

    wrap.append(qField, dField);
    controlSets.push({ select, range, value, auto });
    return wrap;
  }

  function syncControls() {
    const scene = activeScene();
    const dim = effectiveDim(scene);
    for (const c of controlSets) {
      c.select.value = prefs.quality;
      if (document.activeElement !== c.range) c.range.value = String(Math.round(dim * 100));
      c.range.style.setProperty('--fill', `${Math.round((dim * 100 / 70) * 100)}%`);
      c.value.textContent = `${Math.round(dim * 100)}%${prefs.dim < 0 ? ' · auto' : ''}`;
      c.auto.setAttribute('aria-pressed', String(prefs.dim < 0));
      c.range.disabled = !scene;
      c.auto.disabled = !scene;
    }
  }

  function buildCredit(cls) {
    const p = el('p', cls);
    creditNodes.add(p);
    fillCredit(p);
    return p;
  }

  function fillCredit(p) {
    p.textContent = '';
    const licence = safeHttps(catalogue && catalogue.licenseUrl, MIXKIT_LICENCE);
    p.append(
      document.createTextNode('Videos from '),
      link('https://mixkit.co/', 'Mixkit'),
      document.createTextNode(' · '),
      link(licence, 'Mixkit Free License'),
    );
  }

  // ── the popover ("Background"), anchored to the dock button that opened it ──

  function backgroundTitle() {
    const s = activeScene();
    if (s) return s.title;
    if (!catalogue && prefs.sceneId) return '…';
    return 'None';
  }

  // The labeled dock button: [▣ Background: Lofi Vinyl ▾]
  function dockButton() {
    const b = el('button', 'pf-dock-btn scene-dock-btn', {
      type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': 'scene-popover',
    });
    const val = el('span', 'pf-dock-v');
    b.append(icon(ICON_SCENE, 'pf-dock-ic'), el('span', 'pf-dock-k', { text: 'Background:' }), val, icon(ICON_CHEVRON, 'pf-dock-chev'));
    b._val = val;
    b.addEventListener('click', () => (isOpen() && anchorBtn === b ? closePicker(true) : openPicker(b)));
    dockBtns.add(b);
    syncDock();
    return b;
  }

  function syncDock() {
    const t = backgroundTitle();
    dockBtns.forEach((b) => {
      b._val.textContent = t;
      b.title = activeScene() ? `Background video: ${t}. Click to change it, its quality or how dark it is.` : 'Background: none. Click to pick a calm video background.';
      b.setAttribute('aria-label', `Background: ${t}. Change background`);
      b.classList.toggle('is-failed', !!VE.failedUrl && !!activeScene());
    });
  }

  function buildPicker(host) {
    const wrap = el('div', 'scene-picker');
    pickerBtn = el('button', 'icon-btn scene-picker-btn', {
      type: 'button', title: 'Background', 'aria-label': 'Background video',
      'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': 'scene-popover',
    });
    pickerBtn.append(icon(ICON_SCENE));
    pickerBtn.addEventListener('click', () => (isOpen() && anchorBtn === pickerBtn ? closePicker(true) : openPicker(pickerBtn)));
    wrap.append(pickerBtn);
    host.append(wrap);
  }

  function buildPopover() {
    popover = el('div', 'scene-popover', { id: 'scene-popover', role: 'dialog', 'aria-labelledby': 'scene-pop-title', hidden: true });

    const head = el('div', 'scene-pop-head');
    const titles = el('div', 'scene-pop-titles');
    popSub = el('p', 'scene-pop-sub');
    titles.append(el('h2', 'scene-pop-title', { id: 'scene-pop-title', text: 'Background' }), popSub);
    const close = el('button', 'icon-btn small scene-pop-close', { type: 'button', 'aria-label': 'Close', title: 'Close' });
    close.append(icon(ICON_CLOSE));
    close.addEventListener('click', () => closePicker(true));
    head.append(titles, close);

    const body = el('div', 'scene-pop-body');
    body.append(buildGrid('scene-grid scene-grid--pop'));

    const foot = el('div', 'scene-pop-foot');
    const note = el('p', 'scene-pop-note', { text: 'Videos play only on the Focus page, pause when this tab is hidden, and show a still image when Reduce motion is on.' });
    foot.append(buildControls('pop'), note, buildCredit('scene-credit'));

    popover.append(head, body, foot);
    popover.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); closePicker(true); }
    });
    document.body.appendChild(popover);
  }

  function isOpen() {
    return !!popover && !popover.hidden && popover.classList.contains('is-open');
  }

  function positionPopover() {
    if (!popover || popover.hidden || !anchorBtn) return;
    const sheet = window.innerWidth <= 600;
    popover.classList.toggle('is-sheet', sheet);
    if (sheet) { popover.style.top = ''; popover.style.left = ''; popover.style.right = ''; return; }
    const r = anchorBtn.getBoundingClientRect();
    const w = popover.offsetWidth;
    const h = popover.offsetHeight;
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(12, Math.min(window.innerWidth - w - 12, left));
    const below = r.bottom + 10 + h <= window.innerHeight - 8;
    const top = below ? r.bottom + 10 : Math.max(8, r.top - h - 10);
    popover.classList.toggle('is-above', !below);
    popover.style.right = '';
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
  }

  function onDocPointer(e) {
    if (!isOpen()) return;
    if (popover.contains(e.target) || (anchorBtn && anchorBtn.contains(e.target))) return;
    closePicker(false);
  }

  function onDocKey(e) {
    if (e.key === 'Escape' && isOpen()) { e.preventDefault(); closePicker(true); }
  }

  function openPicker(anchor) {
    const a = anchor instanceof Element ? anchor : ([...dockBtns].find((b) => b.isConnected && b.offsetParent) || pickerBtn);
    if (!a) {
      if (typeof Settings === 'object' && Settings && Settings.open) { try { Settings.open('look'); } catch (_) {} }
      return;
    }
    if (!popover) buildPopover();
    if (anchorBtn && anchorBtn !== a) anchorBtn.setAttribute('aria-expanded', 'false');
    anchorBtn = a;
    clearTimeout(popCloseTimer);
    refreshUI();
    popover.hidden = false;
    positionPopover();
    popover.classList.add('is-open');
    a.setAttribute('aria-expanded', 'true');
    a.classList.add('is-active');
    document.addEventListener('pointerdown', onDocPointer, true);
    document.addEventListener('keydown', onDocKey);
    const target = popover.querySelector('.scene-tile[aria-pressed="true"]') || popover.querySelector('.scene-tile');
    if (target) {
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'nearest' });
    }
  }

  function closePicker(returnFocus) {
    if (!popover || popover.hidden) return;
    popover.classList.remove('is-open');
    if (anchorBtn) { anchorBtn.setAttribute('aria-expanded', 'false'); anchorBtn.classList.remove('is-active'); }
    document.removeEventListener('pointerdown', onDocPointer, true);
    document.removeEventListener('keydown', onDocKey);
    clearTimeout(popCloseTimer);
    popCloseTimer = setTimeout(() => { if (!popover.classList.contains('is-open')) popover.hidden = true; }, 180);
    if (returnFocus && anchorBtn) anchorBtn.focus({ preventScroll: true });
  }

  // ── Settings › Look card ──

  function buildSettingsCard(host) {
    const card = el('section', 'glass card scene-settings', { 'aria-labelledby': 'scene-settings-title' });

    const header = el('div', 'card-header');
    const ic = el('span', 'card-icon', { 'aria-hidden': 'true' });
    ic.append(icon(ICON_SCENE));
    nowChip = el('span', 'scene-now-chip');
    header.append(ic, el('h2', 'card-title', { id: 'scene-settings-title', text: 'Background' }), el('div', 'header-spacer'), nowChip);

    const lede = el('p', 'scene-settings-lede', {
      text: 'A calm, looping video behind your timer. It plays on the Focus page, rests as a soft still on other pages, pauses when this tab is hidden, and shows a still image when Reduce motion is on. You can also change it from the Background button under the timer.',
    });

    const grid = buildGrid('scene-grid scene-grid--lg');

    const foot = el('div', 'scene-settings-foot');
    const credits = el('div', 'scene-settings-credits');
    clipCredit = el('p', 'scene-clip-credit');
    credits.append(clipCredit, buildCredit('scene-credit'));
    foot.append(buildControls('settings'), credits);

    card.append(header, lede, grid, foot);
    host.append(card);
  }

  // ── keep every piece of UI in step ──

  function refreshUI() {
    const s = activeScene();
    grids.forEach(syncTiles);
    syncControls();
    syncDock();
    if (pickerBtn) pickerBtn.title = s ? `Background · ${s.title}` : 'Background';
    if (popSub) popSub.textContent = s ? `${s.title} · ${s.mood || 'Video'}` : 'None · the animated colours of your theme';
    if (nowChip) {
      nowChip.textContent = s ? s.title : 'None';
      nowChip.classList.toggle('is-on', !!s);
    }
    if (clipCredit) {
      clipCredit.textContent = '';
      if (s) {
        clipCredit.append(document.createTextNode(`“${s.title}” — video by `));
        const by = typeof s.author === 'string' ? s.author.replace(/\s*\(@[^)]*\)\s*$/, '') : 'Mixkit';
        const authorUrl = safeHttps(s.authorUrl);
        clipCredit.append(authorUrl ? link(authorUrl, by) : document.createTextNode(by));
        const src = safeHttps(s.sourcePage);
        if (src) clipCredit.append(document.createTextNode(' · '), link(src, 'Source'));
      } else {
        clipCredit.append(document.createTextNode('No video: the soft animated colours of your theme. No download needed.'));
      }
      if (s && VE.failedUrl) {
        clipCredit.append(document.createTextNode(' · '));
        const r = el('button', 'scene-retry', { type: 'button', text: 'Retry video' });
        r.addEventListener('click', retry);
        clipCredit.append(r);
      }
    }
  }

  // ── catalogue ──

  async function loadCatalogue() {
    try {
      const res = await fetch(CATALOGUE_URL, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const list = (Array.isArray(data && data.scenes) ? data.scenes : []).filter(validScene);
      list.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
      catalogue = data;
      scenes = list;
      byId = new Map(list.map((s) => [s.id, s]));
      const s = byId.get(prefs.sceneId);
      if (s && safeHttps(s.poster) !== prefs.poster) { prefs.poster = safeHttps(s.poster); savePrefs(); }
    } catch (_) {
      catalogueFailed = true;
    }
    grids.forEach(fillGrid);
    creditNodes.forEach(fillCredit);
    render();
    if (catalogue && activeScene()) emit();
  }

  // ── init ──

  function init() {
    if (inited) return;
    inited = true;

    buildRoot();
    reducedMQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    lastMotion = motionAllowed();

    const onMotion = () => {
      const m = motionAllowed();
      if (m !== lastMotion) { lastMotion = m; render(); }
    };
    if (reducedMQ) {
      if (reducedMQ.addEventListener) reducedMQ.addEventListener('change', onMotion);
      else if (reducedMQ.addListener) reducedMQ.addListener(onMotion);
    }
    new MutationObserver(onMotion).observe(document.body, { attributes: true, attributeFilter: ['class'] });

    // Play on Focus; hold a soft, paused still on the other pages.
    const focusView = document.getElementById('view-focus');
    if (focusView) {
      const syncRoute = () => {
        const on = !focusView.hidden && focusView.classList.contains('is-active');
        if (on !== onFocusRoute) { onFocusRoute = on; updatePlayback(); }
      };
      new MutationObserver(syncRoute).observe(focusView, { attributes: true, attributeFilter: ['hidden', 'class'] });
      syncRoute();
    }

    document.addEventListener('visibilitychange', updatePlayback);
    window.addEventListener('pageshow', updatePlayback);
    window.addEventListener('focus', updatePlayback);
    window.addEventListener('online', () => { if (VE.failedUrl) retryFailed(VE.failedUrl, VE.failedScene); else if (VE.url && !VE.ready) reloadVideo(); });
    setInterval(watchdog, WATCH_MS);

    let resizeT = 0;
    window.addEventListener('resize', () => {
      positionPopover();
      clearTimeout(resizeT);
      resizeT = setTimeout(syncControls, 200);
    });

    // Another tab changed the background.
    window.addEventListener('storage', (e) => {
      if (e.key !== STORE_KEY) return;
      const before = prefs.sceneId;
      prefs = loadPrefs();
      render();
      if (before !== prefs.sceneId) emit();
    });

    // The Focus dock (#ambience-dock-root, Player) carries "Background: …"; the old icon-only
    // picker button is built only on pages without the dock.
    const pickerHost = document.getElementById('scene-picker-root');
    if (pickerHost && !document.getElementById('ambience-dock-root')) buildPicker(pickerHost);
    const settingsHost = document.getElementById('settings-scenes-root');
    if (settingsHost) buildSettingsCard(settingsHost);

    render();
    loadCatalogue();
  }

  function currentId() {
    if (!catalogue) return prefs.sceneId;
    return activeId();
  }

  return {
    init,
    set,
    current: currentId,
    setQuality,
    setDim,
    retry,
    open: openPicker,
    openPicker,                        // v2 name (Look › "Change background…")
    close: () => closePicker(false),
    dockButton,
    list: () => pickable().map((s) => ({ id: s.id, title: s.title, mood: s.mood })),
    state: () => {
      const a = activeV();
      return {
        sceneId: currentId(),
        quality: prefs.quality,
        dim: prefs.dim,
        effectiveDim: effectiveDim(activeScene()),
        resolvedQuality: resolveQuality(),
        videoUrl: VE.url,
        videoReady: VE.ready,
        fading: VE.fading,
        active: VE.active,
        videos: VE.els.filter((v) => v.getAttribute('src')).length,
        videoElements: root ? root.querySelectorAll('video').length : 0,
        t: a ? a.currentTime : 0,
        motion: motionAllowed(),
        playing: shouldPlay(),
        layers: VE.els.length,
      };
    },
  };
})();
