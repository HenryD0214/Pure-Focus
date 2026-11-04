/* ═══════════════════════════════════════════════════════════════════════
   home.js — marketing homepage behaviour
   Live ring demo, hero scene video, scene gallery, theme preview,
   scroll reveals and the "your session is running" pill.
   All external strings (scenes.json, localStorage) go in via textContent
   or validated attributes — never innerHTML.
   ═══════════════════════════════════════════════════════════════════════ */

window.Home = (() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const reducedMotion = () => motionQuery.matches;

  const THEMES = {
    ember:    { name: 'Ember',    accent: '#ff6b35', focus: '#e8482b', brk: '#2aa198', long: '#7c5cbf' },
    ocean:    { name: 'Ocean',    accent: '#4da8da', focus: '#2e6fbd', brk: '#3dba8b', long: '#8b5cf6' },
    forest:   { name: 'Forest',   accent: '#5ab552', focus: '#3e8e41', brk: '#8b6f47', long: '#5b8a72' },
    lavender: { name: 'Lavender', accent: '#9b7ede', focus: '#7c5cbf', brk: '#5c8dcc', long: '#a78bfa' },
    rose:     { name: 'Rose',     accent: '#e86a92', focus: '#d64c6f', brk: '#6c9bd1', long: '#b07cc7' },
    graphite: { name: 'Graphite', accent: '#9aa0a6', focus: '#6e747a', brk: '#5a7d8c', long: '#7a6f9e' },
    midnight: { name: 'Midnight', accent: '#8c9bff', focus: '#5b6cff', brk: '#2ec4b6', long: '#c084fc' },
    mocha:    { name: 'Mocha',    accent: '#d9a273', focus: '#b8693f', brk: '#7fa99b', long: '#a38cb8' },
    pomodoro: { name: 'Pomodoro', accent: '#ff5a4e', focus: '#e5383b', brk: '#43aa6b', long: '#f2a541' },
    honey:    { name: 'Honey',    accent: '#ffb020', focus: '#f08c00', brk: '#3fa7b5', long: '#b983ff' },
    matcha:   { name: 'Matcha',   accent: '#a6c86e', focus: '#6f9e45', brk: '#d29e66', long: '#8fa3c8' },
    glacier:  { name: 'Glacier',  accent: '#6ee3f5', focus: '#1fa2d6', brk: '#62d2a2', long: '#93a5ff' },
    boreal:   { name: 'Boreal',   accent: '#45e0a0', focus: '#16a88a', brk: '#4f8ef7', long: '#a06bf0' },
    synthwave:{ name: 'Synthwave',accent: '#ff4fd8', focus: '#ee3a8c', brk: '#22d3ee', long: '#a78bfa' },
  };

  const MODE_LABEL = { focus: 'Focus', shortBreak: 'Short Break', longBreak: 'Long Break' };

  function readJSON(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }

  function fmt(sec) {
    const s = Math.max(0, Math.ceil(sec));
    const m = Math.floor(s / 60);
    return m + ':' + String(s % 60).padStart(2, '0');
  }

  // Only ever load media from the scene host we expect.
  function safeMediaURL(u) {
    if (typeof u !== 'string') return null;
    try {
      const url = new URL(u);
      return url.protocol === 'https:' && url.hostname === 'assets.mixkit.co' ? url.href : null;
    } catch (_) { return null; }
  }
  function safeLink(u) {
    if (typeof u !== 'string') return null;
    try {
      const url = new URL(u);
      return url.protocol === 'https:' && /(^|\.)mixkit\.co$/.test(url.hostname) ? url.href : null;
    } catch (_) { return null; }
  }

  // ─────────────────────────  THEME  ─────────────────────────

  function applyTheme(id) {
    const t = THEMES[id] || THEMES.ember;
    const root = document.documentElement.style;
    root.setProperty('--accent', t.accent);
    root.setProperty('--focus-tint', t.focus);
    root.setProperty('--break-tint', t.brk);
    root.setProperty('--longbreak-tint', t.long);
    const meta = $('meta[name="theme-color"]');
    $$('.swatch').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.theme === id)));
    const name = $('#theme-name');
    if (name) name.textContent = t.name;
    if (meta) meta.setAttribute('content', '#07070a');
  }

  function initTheme() {
    const data = readJSON('purefocus.v1');
    const saved = data && data.settings && data.settings.themeID;
    applyTheme(THEMES[saved] ? saved : 'ember');
    $$('.swatch').forEach((btn) => {
      btn.addEventListener('click', () => applyTheme(btn.dataset.theme));
    });
  }

  // ─────────────────────────  RETURNING VISITOR  ─────────────────────────

  function initReturning() {
    const data = readJSON('purefocus.v1');
    const returning = data && ((Array.isArray(data.sessions) && data.sessions.length) ||
                               (Array.isArray(data.tasks) && data.tasks.length));
    if (!returning) return;
    $$('[data-returning]').forEach((a) => { a.textContent = a.dataset.returning; });
  }

  function initResumePill() {
    const pill = $('#resume-pill');
    if (!pill) return;
    const run = readJSON('purefocus.running');
    if (!run || typeof run.endAt !== 'number' || run.endAt <= Date.now()) return;
    $('#resume-mode').textContent = (MODE_LABEL[run.mode] || 'Focus').toLowerCase() + ' session';
    const left = $('#resume-left');
    const tick = () => {
      const s = (run.endAt - Date.now()) / 1000;
      if (s <= 0) { pill.hidden = true; clearInterval(timer); return; }
      left.textContent = fmt(s);
    };
    const timer = setInterval(tick, 1000);
    tick();
    pill.hidden = false;
  }

  // ─────────────────────────  NAV  ─────────────────────────

  function initNav() {
    const nav = $('#nav');
    const onScroll = () => nav.classList.toggle('is-scrolled', window.scrollY > 8);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    if (!('IntersectionObserver' in window)) return;
    const links = new Map($$('.nav-links a').map((a) => [a.getAttribute('href').slice(1), a]));
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        const a = links.get(e.target.id);
        if (!a) return;
        if (e.isIntersecting) {
          links.forEach((l) => l.classList.remove('is-current'));
          a.classList.add('is-current');
        } else {
          a.classList.remove('is-current');
        }
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    links.forEach((_, id) => { const s = document.getElementById(id); if (s) io.observe(s); });
  }

  // ─────────────────────────  LIVE DEMO  ─────────────────────────

  const Demo = (() => {
    const LEN = { focus: 25 * 60, shortBreak: 5 * 60, longBreak: 15 * 60 };
    const INTERVAL = 4;
    const R = 124, C = 2 * Math.PI * R;

    let mode = 'focus';
    let total = LEN.focus;
    let remaining = 18 * 60 + 42;
    let round = 2;
    let running = false;
    let endAt = 0;
    let raf = 0, tickTimer = 0;
    let lastShown = '';
    let visible = true;

    let card, arc, head, timeEl, modeEl, roundEl, toggle, toggleLabel, cont;

    function draw() {
      const left = running ? Math.max(0, (endAt - Date.now()) / 1000) : remaining;
      const p = total ? left / total : 0;
      arc.style.strokeDashoffset = String(C * (1 - p));
      const a = p * 2 * Math.PI;
      head.setAttribute('cx', (140 + R * Math.sin(a)).toFixed(2));
      head.setAttribute('cy', (140 - R * Math.cos(a)).toFixed(2));
      const shown = fmt(left);
      if (shown !== lastShown) { timeEl.textContent = shown; lastShown = shown; }
      if (running && left <= 0) advance();
    }

    function loop() {
      draw();
      raf = running && visible && !reducedMotion() ? requestAnimationFrame(loop) : 0;
    }

    function schedule() {
      cancelAnimationFrame(raf); raf = 0;
      clearInterval(tickTimer); tickTimer = 0;
      if (!running) { draw(); return; }
      // Smooth ring when motion is welcome; a once-a-second step otherwise.
      if (!reducedMotion() && visible) raf = requestAnimationFrame(loop);
      tickTimer = setInterval(draw, reducedMotion() ? 1000 : 500);
    }

    function setMode(next, keepRunning) {
      mode = next;
      total = LEN[mode];
      remaining = total;
      if (running) endAt = Date.now() + remaining * 1000;
      if (!keepRunning) running = false;
      card.dataset.mode = mode;
      modeEl.textContent = MODE_LABEL[mode];
      roundEl.textContent = mode === 'focus' ? `Round ${round} of ${INTERVAL}` :
        mode === 'longBreak' ? 'Long break — well earned' : `Break after round ${round}`;
      $$('.mode-chip', card).forEach((c) => {
        const on = c.dataset.mode === mode;
        c.classList.toggle('is-active', on);
        c.setAttribute('aria-checked', String(on));
        c.tabIndex = on ? 0 : -1;
      });
      renderToggle();
      schedule();
    }

    function advance() {
      let next;
      if (mode === 'focus') next = round % INTERVAL === 0 ? 'longBreak' : 'shortBreak';
      else { round = mode === 'longBreak' ? 1 : round + 1; next = 'focus'; }
      setMode(next, true);
    }

    function start() {
      if (running) return;
      running = true;
      endAt = Date.now() + remaining * 1000;
      renderToggle();
      schedule();
    }
    function pause() {
      if (!running) return;
      remaining = Math.max(0, (endAt - Date.now()) / 1000);
      running = false;
      renderToggle();
      schedule();
    }
    function renderToggle() {
      toggle.setAttribute('aria-pressed', String(running));
      toggleLabel.textContent = running ? 'Pause' : 'Start';
    }
    function engaged() { if (cont) cont.hidden = false; }

    function init() {
      card = $('#demo');
      if (!card) return;
      arc = $('#demo-arc'); head = $('#demo-head');
      timeEl = $('#demo-time'); modeEl = $('#demo-mode'); roundEl = $('#demo-round');
      toggle = $('#demo-toggle'); toggleLabel = $('#demo-toggle-label'); cont = $('#demo-continue');

      arc.style.strokeDasharray = `${C} ${C}`;

      toggle.addEventListener('click', () => { running ? pause() : start(); engaged(); });
      $('#demo-reset').addEventListener('click', () => {
        remaining = total;
        if (running) endAt = Date.now() + remaining * 1000;
        schedule(); engaged();
      });
      $('#demo-skip').addEventListener('click', () => { advance(); engaged(); });

      const chips = $$('.mode-chip', card);
      chips.forEach((chip, i) => {
        chip.addEventListener('click', () => { setMode(chip.dataset.mode, true); engaged(); });
        chip.addEventListener('keydown', (e) => {
          const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
          if (!d) return;
          e.preventDefault();
          const n = chips[(i + d + chips.length) % chips.length];
          n.focus(); n.click();
        });
      });

      // Pause the animation loop while the card is off screen.
      if ('IntersectionObserver' in window) {
        new IntersectionObserver(([e]) => { visible = e.isIntersecting; schedule(); }).observe(card);
      }
      document.addEventListener('visibilitychange', () => { visible = !document.hidden; schedule(); });
      motionQuery.addEventListener && motionQuery.addEventListener('change', schedule);

      // Render the initial state (mid-session, round 2) then run it live.
      const keep = remaining;
      setMode('focus', false);
      remaining = keep;
      draw();
      start();
    }

    return { init };
  })();

  // ─────────────────────────  SCENES  ─────────────────────────

  const NUM_WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
    'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen', 'Twenty'];

  const Scenes = (() => {
    let scenes = [];
    let currentId = null;
    let heroVisible = true;
    const media = () => $('.hero-media');
    const video = () => $('#hero-video');
    const poster = () => $('#hero-poster');

    function saveData() {
      const c = navigator.connection;
      return !!(c && (c.saveData || /(^|-)2g$/.test(c.effectiveType || '')));
    }

    function setCredit(s) {
      const el = $('#clip-credits');
      if (!el) return;
      el.replaceChildren();
      const title = s.sourceTitle || s.title;
      const author = String(s.author || 'Mixkit').replace(/\s*\(@[^)]*\)\s*$/, '');
      el.append('Hero scene: ');
      const link = safeLink(s.sourcePage);
      if (link) {
        const a = document.createElement('a');
        a.href = link; a.rel = 'noopener'; a.target = '_blank';
        a.textContent = `“${title}”`;
        el.append(a);
      } else {
        el.append(`“${title}”`);
      }
      el.append(` by ${author} on Mixkit.`);
      el.hidden = false;
    }

    function show(id, { scroll = false } = {}) {
      const s = scenes.find((x) => x.id === id);
      if (!s) return;
      const posterURL = safeMediaURL(s.poster) || safeMediaURL(s.posterSmall);
      const videoURL = safeMediaURL(s.url720);       // lowest resolution offered
      const m = media(), v = video(), p = poster();
      const first = currentId === null;
      currentId = id;

      $$('.scene-dot').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === id)));
      $$('.scene-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === id)));
      setCredit(s);

      const swap = () => {
        if (posterURL && p.getAttribute('src') !== posterURL) p.src = posterURL;
        if (posterURL) v.poster = posterURL;
        v.classList.remove('is-playing');
        if (reducedMotion() || saveData() || !videoURL) {
          v.removeAttribute('src');
          try { v.load(); } catch (_) {}
        } else {
          v.muted = true; v.loop = true; v.playsInline = true; v.autoplay = true;
          v.preload = 'auto';
          v.src = videoURL;
          if (heroVisible) play();
        }
        m.classList.remove('is-swapping');
      };

      if (first || reducedMotion()) swap();
      else { m.classList.add('is-swapping'); setTimeout(swap, 380); }

      if (scroll) window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
    }

    function play() {
      const v = video();
      if (!v.getAttribute('src')) return;
      const pr = v.play();
      if (pr && pr.catch) pr.catch(() => {});
    }

    function buildDots(list) {
      const wrap = $('#scene-dots');
      if (!wrap) return;
      wrap.replaceChildren();
      list.forEach((s) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'scene-dot';
        b.dataset.id = s.id;
        b.setAttribute('aria-pressed', 'false');
        b.setAttribute('aria-label', `${s.title} scene`);
        b.title = s.title;
        const img = document.createElement('img');
        img.alt = '';
        img.decoding = 'async';
        const src = safeMediaURL(s.posterSmall) || safeMediaURL(s.poster);
        if (src) img.src = src;
        b.append(img);
        b.addEventListener('click', () => show(s.id));
        wrap.append(b);
      });
    }

    function buildTrack(list) {
      const track = $('#scene-track');
      if (!track) return;
      track.replaceChildren();
      list.forEach((s) => {
        const li = document.createElement('li');
        li.className = 'scene-card';
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'scene-btn';
        b.dataset.id = s.id;
        b.setAttribute('aria-pressed', 'false');
        b.setAttribute('aria-label', `${s.title} — ${s.mood}. Show behind the demo timer.`);

        const img = document.createElement('img');
        img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
        const src = safeMediaURL(s.posterSmall) || safeMediaURL(s.poster);
        if (src) img.src = src;

        const badge = document.createElement('span');
        badge.className = 'scene-badge';
        badge.textContent = Number(s.width4k) >= 3840 ? '4K' : 'HD';

        const meta = document.createElement('span');
        meta.className = 'scene-meta';
        const mood = document.createElement('span'); mood.className = 'scene-mood'; mood.textContent = s.mood;
        const title = document.createElement('span'); title.className = 'scene-title'; title.textContent = s.title;
        const hint = document.createElement('span'); hint.className = 'scene-hint'; hint.textContent = 'Preview behind the timer';
        meta.append(mood, title, hint);

        b.append(img, badge, meta);
        b.addEventListener('click', () => show(s.id, { scroll: true }));
        li.append(b);
        track.append(li);
      });
      updateTrackNav();
    }

    function updateTrackNav() {
      const t = $('#scene-track'), prev = $('#track-prev'), next = $('#track-next');
      if (!t || !prev || !next) return;
      prev.disabled = t.scrollLeft < 8;
      next.disabled = t.scrollLeft + t.clientWidth >= t.scrollWidth - 8;
    }

    function initTrackNav() {
      const t = $('#scene-track');
      if (!t) return;
      const step = (dir) => {
        const card = $('.scene-card', t);
        const w = card ? card.getBoundingClientRect().width + 18 : 320;
        t.scrollBy({ left: dir * w * Math.max(1, Math.floor(t.clientWidth / w) - 1), behavior: reducedMotion() ? 'auto' : 'smooth' });
      };
      $('#track-prev').addEventListener('click', () => step(-1));
      $('#track-next').addEventListener('click', () => step(1));
      t.addEventListener('scroll', updateTrackNav, { passive: true });
      window.addEventListener('resize', updateTrackNav);
      updateTrackNav();
    }

    function initVideoEvents() {
      const v = video();
      v.addEventListener('playing', () => v.classList.add('is-playing'));
      v.addEventListener('error', () => v.classList.remove('is-playing'));
      if ('IntersectionObserver' in window) {
        new IntersectionObserver(([e]) => {
          heroVisible = e.isIntersecting;
          if (heroVisible) play(); else v.pause();
        }).observe($('.hero'));
      }
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) v.pause(); else if (heroVisible) play();
      });
      if (motionQuery.addEventListener) {
        motionQuery.addEventListener('change', () => { if (currentId) { const id = currentId; currentId = null; show(id); } });
      }
    }

    async function init() {
      initTrackNav();
      initVideoEvents();
      let data;
      try {
        const res = await fetch('assets/scenes/scenes.json', { cache: 'force-cache' });
        if (!res.ok) throw new Error('scenes ' + res.status);
        data = await res.json();
      } catch (_) {
        // Keep the static poster; hide the controls that need the list.
        const sw = $('.scene-switch'); if (sw) sw.hidden = true;
        const sec = $('#scenes'); if (sec) sec.hidden = true;
        return;
      }
      scenes = (Array.isArray(data && data.scenes) ? data.scenes : [])
        .filter((s) => s && typeof s.id === 'string' && typeof s.title === 'string')
        .map((s) => ({ ...s, title: String(s.title), mood: String(s.mood || '') }))
        .sort((a, b) => (a.order || 99) - (b.order || 99));
      if (!scenes.length) return;

      const count = $('#scene-count');
      if (count) count.textContent = NUM_WORDS[scenes.length] || String(scenes.length);

      const heroes = scenes.filter((s) => s.hero);
      buildDots(heroes.length ? heroes : scenes.slice(0, 3));
      buildTrack(scenes);

      const firstHero = (heroes[0] || scenes[0]).id;
      // Let the poster paint first; start streaming once the page has loaded.
      const go = () => show(firstHero);
      if (document.readyState === 'complete') go();
      else window.addEventListener('load', go, { once: true });
    }

    return { init };
  })();

  // ─────────────────────────  REVEAL  ─────────────────────────

  function initReveal() {
    const items = $$('.reveal');
    // Stagger children of [data-stagger] groups.
    $$('[data-stagger]').forEach((group) => {
      $$('.reveal', group).forEach((el, i) => el.style.setProperty('--d', `${Math.min(i, 6) * 70}ms`));
    });
    if (reducedMotion() || !('IntersectionObserver' in window)) {
      items.forEach((el) => el.classList.add('is-in'));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        e.target.classList.add('is-in');
        io.unobserve(e.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    items.forEach((el) => io.observe(el));
    // Anything already above the fold on load (e.g. after a hash jump).
    requestAnimationFrame(() => {
      items.forEach((el) => {
        if (el.getBoundingClientRect().top < window.innerHeight) el.classList.add('is-in');
      });
    });
  }

  // ─────────────────────────  BOOT  ─────────────────────────

  function safe(fn, name) {
    try { const r = fn(); if (r && r.catch) r.catch((e) => console.warn('[home]', name, e)); }
    catch (e) { console.warn('[home]', name, e); }
  }

  function init() {
    safe(initReveal, 'reveal');
    safe(initTheme, 'theme');
    safe(initReturning, 'returning');
    safe(initResumePill, 'resume');
    safe(initNav, 'nav');
    safe(Demo.init, 'demo');
    safe(Scenes.init, 'scenes');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return { applyTheme };
})();
