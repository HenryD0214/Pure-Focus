/* ═══════════════════════════════════════════════════════════════════════
   player.js — now-playing pill, player card, equalisers, Settings › Sounds (owner: W5)
   v2-sound §6 (placement, measurements, motion) on top of the Audio v2 engine.

   const Player = {
     init()               mounts the pill into #player-pill-root, registers Settings › Sounds
     mountPill(el)        the now-playing pill (52 h; shown only while music plays — or while it is
                          paused by hand during a running focus session, so ⏯ stays reachable)
     mountCard(el)        the player card (360 × 256); also embedded at the top of the Ambience
                          popover's Sound tab (js/scenes.js)
     openCard(anchor)     the player card as a popover anchored to `anchor`
     attachEq(el, opts)   drive a 3-bar equaliser (three child <i>) from Audio.level()
     closeCard()
   }
   One requestAnimationFrame loop drives every visible equaliser (≤ 30 fps; 15 fps and half
   amplitude in quiet focus); it stops when nothing is visible, nothing plays or the tab hides.
   Remote/catalogue strings render with textContent only.
   ═══════════════════════════════════════════════════════════════════════ */

const Player = (() => {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';

  // ── tiny DOM helpers (no innerHTML) ──
  function el(tag, cls, attrs) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'text') n.textContent = String(v);
        else n.setAttribute(k, v === true ? '' : String(v));
      }
    }
    return n;
  }
  function svg(viewBox, paths, cls) {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', viewBox);
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    if (cls) s.setAttribute('class', cls);
    for (const p of paths) {
      const e = document.createElementNS(NS, p.tag || 'path');
      for (const [k, v] of Object.entries(p)) if (k !== 'tag') e.setAttribute(k, v);
      s.appendChild(e);
    }
    return s;
  }
  const ROUND = { 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  const I = {
    play: () => svg('0 0 20 20', [{ d: 'M6.6 4.3c0-.8.9-1.3 1.6-.9l8 5c.7.4.7 1.4 0 1.8l-8 5c-.7.4-1.6-.1-1.6-.9z', fill: 'currentColor' }], 'pf-i-play'),
    pause: () => svg('0 0 20 20', [{ tag: 'rect', x: '5', y: '4', width: '3.4', height: '12', rx: '1.2', fill: 'currentColor' }, { tag: 'rect', x: '11.6', y: '4', width: '3.4', height: '12', rx: '1.2', fill: 'currentColor' }], 'pf-i-pause'),
    next: () => svg('0 0 20 20', [{ d: 'M4.5 5.2c0-.7.8-1.1 1.4-.7l6.6 4.8c.5.4.5 1.1 0 1.5l-6.6 4.8c-.6.4-1.4 0-1.4-.7z', fill: 'currentColor' }, { d: 'M15 4.6v10.8', stroke: 'currentColor', 'stroke-width': '2', fill: 'none', ...ROUND }]),
    prev: () => svg('0 0 20 20', [{ d: 'M15.5 5.2c0-.7-.8-1.1-1.4-.7L7.5 9.3c-.5.4-.5 1.1 0 1.5l6.6 4.8c.6.4 1.4 0 1.4-.7z', fill: 'currentColor' }, { d: 'M5 4.6v10.8', stroke: 'currentColor', 'stroke-width': '2', fill: 'none', ...ROUND }]),
    heart: () => svg('0 0 20 20', [{ d: 'M10 16.3s-6.2-3.7-6.2-8.2A3.4 3.4 0 0 1 10 6.3a3.4 3.4 0 0 1 6.2 1.8c0 4.5-6.2 8.2-6.2 8.2z', stroke: 'currentColor', 'stroke-width': '1.6', fill: 'var(--pf-heart-fill, none)', ...ROUND }]),
    speaker: () => svg('0 0 20 20', [{ d: 'M3.5 8h2.6L10 4.8v10.4L6.1 12H3.5z', fill: 'currentColor' }, { d: 'M13 7.4a3.6 3.6 0 0 1 0 5.2M15.2 5.4a6.4 6.4 0 0 1 0 9.2', stroke: 'currentColor', 'stroke-width': '1.5', fill: 'none', ...ROUND }]),
    chevron: () => svg('0 0 12 12', [{ d: 'M3 4.6 6 7.6l3-3', stroke: 'currentColor', 'stroke-width': '1.6', fill: 'none', ...ROUND }]),
    preview: () => svg('0 0 16 16', [{ d: 'M5.4 3.6c0-.6.7-1 1.2-.7l5.6 3.7c.5.3.5 1 0 1.3l-5.6 3.7c-.5.3-1.2 0-1.2-.7z', fill: 'currentColor' }]),
    stop: () => svg('0 0 16 16', [{ tag: 'rect', x: '4.2', y: '4.2', width: '7.6', height: '7.6', rx: '1.6', fill: 'currentColor' }]),
    alert: () => svg('0 0 20 20', [{ d: 'M10 3.2l7.4 13H2.6z', stroke: 'currentColor', 'stroke-width': '1.6', fill: 'none', ...ROUND }, { d: 'M10 8.2v3.6', stroke: 'currentColor', 'stroke-width': '1.7', fill: 'none', ...ROUND }, { tag: 'circle', cx: '10', cy: '14', r: '1', fill: 'currentColor' }], 'pf-i-alert'),
    note: () => svg('0 0 20 20', [{ d: 'M8 14.6V5.2l8-1.6v9.2', stroke: 'currentColor', 'stroke-width': '1.6', fill: 'none', ...ROUND }, { tag: 'circle', cx: '6', cy: '14.8', r: '2', fill: 'currentColor' }, { tag: 'circle', cx: '14', cy: '13', r: '2', fill: 'currentColor' }]),
  };

  const S = () => { try { return Store.settings(); } catch (_) { return {}; } };
  const has = (name) => typeof window[name] !== 'undefined' || (typeof globalThis !== 'undefined' && name in globalThis);
  function fmt(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  function safeHttps(u) { return typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/.test(u) ? u : ''; }
  function reduceMotion() {
    return document.body.classList.contains('reduce-motion') ||
      !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  function focusRunning() { try { return Timer.isRunning() && Timer.mode() === 'focus'; } catch (_) { return false; } }
  function artFor(track) {
    const g = track && Audio.genreInfo ? Audio.genreInfo(track.genre) : null;
    const a = (g && Array.isArray(g.art) && g.art.length === 2) ? g.art : ['#6b7280', '#1f2937'];
    const ok = (c) => (/^#[0-9a-f]{3,8}$/i.test(c) ? c : '#555');
    return [ok(a[0]), ok(a[1])];
  }
  function sourceTitle() {
    try { const i = Audio.sourceInfo(); return i.kind === 'off' ? '' : i.title; } catch (_) { return ''; }
  }
  function isCcBy(track) { return !!track && /CC BY/i.test(track.licence || ''); }

  // ── equalisers (one rAF loop) ──

  const eqs = new Set();   // {bars, visible, io, scale}
  let rafId = 0;
  let lastFrame = 0;
  let quiet = false;

  function attachEq(container, opts) {
    const bars = Array.from(container.querySelectorAll('i'));
    if (bars.length !== 3) return () => {};
    const e = { bars, visible: false, container, off: false, h: [2, 2, 2], opts: opts || {} };
    if ('IntersectionObserver' in window) {
      e.io = new IntersectionObserver((list) => { for (const x of list) e.visible = x.isIntersecting; kick(); });
      e.io.observe(container);
    } else e.visible = true;
    eqs.add(e);
    paintStatic(e);
    return () => { eqs.delete(e); if (e.io) e.io.disconnect(); };
  }

  function paintBars(e, hs) {
    for (let i = 0; i < 3; i++) {
      const h = Math.max(2, Math.min(12, hs[i]));
      if (Math.abs(h - e.h[i]) < 0.05) continue;
      e.h[i] = h;
      e.bars[i].style.transform = `scaleY(${(h / 12).toFixed(3)})`;
    }
  }
  function paintStatic(e) {
    const playing = Audio.isMusicPlaying && Audio.isMusicPlaying();
    paintBars(e, playing && reduceMotion() ? [2, 6, 4] : [2, 2, 2]);
  }

  function wantLoop() {
    if (document.hidden || reduceMotion() || !Audio.isMusicPlaying()) return false;
    for (const e of eqs) if (e.visible) return true;
    return false;
  }

  function kick() {
    if (rafId || !wantLoop()) { if (!rafId) eqs.forEach(paintStatic); return; }
    rafId = requestAnimationFrame(frame);
  }

  function frame(now) {
    rafId = 0;
    if (!wantLoop()) { eqs.forEach(paintStatic); return; }
    const minDt = quiet ? 1000 / 15 : 1000 / 30;
    if (now - lastFrame >= minDt - 2) {
      lastFrame = now;
      const lv = Audio.level();
      const amp = quiet ? 0.5 : 1;
      const hs = lv.bands.map((y) => 2 + 10 * y * amp);
      for (const e of eqs) if (e.visible) paintBars(e, hs);
    }
    rafId = requestAnimationFrame(frame);
  }

  // ── title swap (old up 8 + fade, new from y + 8) ──

  // ── the Focus music bar: [art · title / artist · station | ▶ | ⏭] + one status line ──
  // Always on show under the timer (Liquid Glass over a scene, css/glass.css). The title opens the
  // player card (stations, tracks, volume). The Background button goes to the page's top-right
  // corner (#scene-corner-root) when it has one, else it leads the bar.

  let dock = null;

  function dockHost() {
    let host = document.getElementById('ambience-dock-root');
    if (host) return host;
    // Interim: the shell hasn't added the mount yet — make one under the timer controls.
    const stage = document.querySelector('#view-focus .timer-card');
    if (!stage) return null;
    host = el('div', 'pf-dock-temp', { id: 'pf-dock-temp' });
    const after = stage.querySelector('.timer-footer') || stage.querySelector('.transport');
    if (after && after.parentNode === stage) after.after(host); else stage.appendChild(host);
    return host;
  }

  function mountDock() {
    const host = dockHost();
    if (!host || dock) return;
    const root = el('div', 'pf-dock', { role: 'group', 'aria-label': 'Music' });
    if (typeof Scenes !== 'undefined' && Scenes.dockButton) {
      const corner = document.getElementById('scene-corner-root');
      const sb = Scenes.dockButton();
      if (corner) { sb.classList.add('corner-btn'); corner.textContent = ''; corner.appendChild(sb); } else root.append(sb);
    }

    const bar = el('div', 'pf-dock-seg pf-dock-music pf-np');
    const btn = el('button', 'pf-dock-btn pf-np-main', { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' });
    const { art, eq } = makeArt('pf-art--np');
    const noteIc = I.note(); noteIc.classList.add('pf-np-note');
    art.append(noteIc);
    const text = el('span', 'pf-pill-text pf-np-text');
    btn.append(art, text);
    const pp = el('button', 'pf-dock-pp pf-np-pp', { type: 'button' });
    const spin = el('span', 'pf-dock-spin', { 'aria-hidden': 'true' });
    pp.append(I.play(), I.pause(), I.alert(), spin);
    const next = el('button', 'pf-ctl pf-np-next', { type: 'button', 'aria-label': 'Next track', title: 'Next track' });
    next.append(I.next());
    const prog = el('span', 'pf-pill-progress pf-np-progress', { 'aria-hidden': 'true' });
    const fill = el('span', 'pf-pill-fill');
    prog.append(fill);
    bar.append(btn, pp, next, prog);

    const msg = el('div', 'pf-dock-msg', { role: 'status', 'aria-live': 'polite', hidden: true });
    const msgText = el('span');
    const retry = el('button', 'pf-dock-retry', { type: 'button', text: 'Retry', title: 'Try playing the music again' });
    msg.append(msgText, retry);

    root.append(bar, msg);
    host.textContent = '';
    host.appendChild(root);
    document.documentElement.classList.add('pf-dock-on');
    dock = { host, root, seg: bar, btn, art, text, pp, next, fill, msg, msgText, retry, eq };
    attachEq(eq);

    btn.addEventListener('click', () => (popover && popover.anchor === btn ? closeCard() : openCard(btn)));
    pp.addEventListener('click', () => playPause());
    next.addEventListener('click', () => { Audio.unlock(); Audio.nextMusic(); });
    retry.addEventListener('click', () => { Audio.unlock(); Audio.retryMusic(); });
    renderDock(false);
  }

  function renderDock(animate) {
    if (!dock) return;
    const t = Audio.currentTrack();
    const st = Audio.musicStatus ? Audio.musicStatus() : { state: Audio.isMusicPlaying() ? 'playing' : 'idle', message: '' };
    const playing = Audio.isMusicPlaying();
    const src = sourceTitle();
    // What the bar says: the track (artist · station); a chosen station before its first track;
    // or, with music off, what ▶ will start.
    let l1, l2;
    if (t) { l1 = t.title || 'Untitled'; l2 = [t.artist, src].filter(Boolean).join(' · '); }
    else if (src) { l1 = src; l2 = playing ? 'Starting…' : 'Press play to start'; }
    else { l1 = 'Music off'; l2 = 'Press play for the Flow station'; }
    swapText(dock.text, [l1, l2], animate);
    setArt(dock.art, t, animate);
    dock.seg.classList.toggle('is-off', !t && !src);
    dock.next.disabled = !t;
    const what = t ? `${t.title || 'Untitled'}${t.artist ? ` — ${t.artist}` : ''}` : '';
    dock.btn.title = src
      ? `${what ? `${playing ? 'Playing' : 'Paused'}: ${what} · ` : ''}${src}. Click for stations, tracks and volume.`
      : 'Music is off. Click to pick a station, or press ▶ to start Flow.';
    dock.btn.setAttribute('aria-label', `Music: ${src || 'Off'}${what ? `, ${what}` : ''}. Open the music player`);
    dock.seg.classList.toggle('is-playing', playing && st.state === 'playing');
    const pp = dock.pp;
    const loading = st.state === 'loading';
    const error = st.state === 'error';
    pp.classList.toggle('is-loading', loading);
    pp.classList.toggle('is-error', error);
    pp.classList.toggle('is-playing', playing && !loading);
    const label = error ? 'Music couldn’t play — click to retry'
      : loading ? 'Loading music… (click to cancel)'
        : playing ? 'Pause music' : (src ? `Play ${src}` : 'Play music (Flow station)');
    pp.setAttribute('aria-label', label);
    pp.title = label;
    const showMsg = error || st.state === 'blocked';
    dock.msg.hidden = !showMsg;
    dock.msgText.textContent = showMsg ? (st.message || (error ? 'Music couldn’t play.' : '')) : '';
    dock.retry.hidden = !error;
    if (!t) renderDockProgress(0);
  }

  function renderDockProgress(p) {
    if (!dock) return;
    dock.fill.style.transform = `scaleX(${Math.max(0, Math.min(1, Number(p) || 0)).toFixed(4)})`;
  }

  function swapText(host, lines, animate) {
    const cur = host.querySelector('.pf-swap:not(.is-out)');
    const sig = lines.join('\u0001');
    if (cur && cur.dataset.sig === sig) return;
    const next = el('span', 'pf-swap');
    next.dataset.sig = sig;
    lines.forEach((t, i) => next.appendChild(el('span', i === 0 ? 'pf-l1' : 'pf-l2', { text: t })));
    if (cur && animate && !reduceMotion()) {
      cur.classList.add('is-out');
      next.classList.add('is-in');
      host.appendChild(next);
      void next.offsetWidth;
      next.classList.remove('is-in');
      setTimeout(() => cur.remove(), 200);
    } else {
      host.querySelectorAll('.pf-swap').forEach((n) => n.remove());
      host.appendChild(next);
    }
  }

  function setArt(art, track, animate) {
    const [a, b] = artFor(track);
    const key = `${a}${b}`;
    if (art.dataset.key === key) return;
    art.dataset.key = key;
    const top = art.querySelector('.pf-art-fade');
    if (top && animate && !reduceMotion()) {
      top.style.background = `linear-gradient(135deg, ${a}, ${b})`;
      top.classList.add('is-on');
      setTimeout(() => { art.style.setProperty('--pf-art', `linear-gradient(135deg, ${a}, ${b})`); top.classList.remove('is-on'); }, 320);
    } else {
      art.style.setProperty('--pf-art', `linear-gradient(135deg, ${a}, ${b})`);
    }
  }

  function makeArt(cls) {
    const art = el('span', `pf-art ${cls || ''}`.trim(), { 'aria-hidden': 'true' });
    art.append(el('span', 'pf-art-fade'), el('span', 'pf-art-ring'));
    const eq = el('span', 'pf-eq');
    eq.append(el('i'), el('i'), el('i'));
    art.append(eq);
    return { art, eq };
  }

  function playPauseButton(cls, size) {
    const b = el('button', `pf-ctl pf-pp ${cls || ''}`.trim(), { type: 'button', 'aria-label': 'Play music' });
    b.style.setProperty('--pf-size', `${size}px`);
    b.append(I.play(), I.pause());
    return b;
  }
  function syncPP(b, playing) {
    b.classList.toggle('is-playing', !!playing);
    b.setAttribute('aria-label', playing ? 'Pause music' : 'Play music');
  }

  // ── the pill ──

  let pill = null;

  function mountPill(host) {
    if (!host || pill) return;
    const wrap = el('div', 'pf-pill-wrap');
    const root = el('div', 'pf-pill', { role: 'group', 'aria-label': 'Now playing' });
    const main = el('button', 'pf-pill-main', { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' });
    const { art, eq } = makeArt('pf-art--pill');
    const text = el('span', 'pf-pill-text');
    main.append(art, text);
    const like = el('button', 'pf-ctl pf-like', { type: 'button', 'aria-pressed': 'false', 'aria-label': 'Like this track' });
    like.append(I.heart());
    const pp = playPauseButton('pf-pill-pp', 32);
    const next = el('button', 'pf-ctl pf-pill-next', { type: 'button', 'aria-label': 'Next track' });
    next.append(I.next());
    const prog = el('span', 'pf-pill-progress', { 'aria-hidden': 'true' });
    const fill = el('span', 'pf-pill-fill');
    prog.append(fill);
    root.append(main, like, pp, next, prog);
    const inner = el('div', 'pf-pill-inner');
    inner.append(root);
    wrap.append(inner);
    wrap.hidden = true;
    host.appendChild(wrap);
    pill = { host, wrap, root, main, art, eq, text, like, pp, next, fill, shown: false, hideTimer: 0 };
    attachEq(eq);

    main.addEventListener('click', () => (popover && popover.anchor === pill.main ? closeCard() : openCard(pill.main)));
    pp.addEventListener('click', () => { Audio.unlock(); Audio.toggleMusic(); });
    next.addEventListener('click', () => Audio.nextMusic());
    like.addEventListener('click', () => { const t = Audio.currentTrack(); if (t) Audio.like(t.id, !Audio.isLiked(t.id)); });
    renderPill(false);
  }

  function pillWanted() {
    const t = Audio.currentTrack();
    if (!t) return false;
    if (Audio.isMusicPlaying()) return true;
    // Paused by hand during a running focus session: keep ⏯ reachable.
    return focusRunning() && pausedByHand;
  }

  function renderPill(animate) {
    if (!pill) return;
    const t = Audio.currentTrack();
    const want = pillWanted();
    if (want && !pill.shown) {
      pill.shown = true;
      clearTimeout(pill.hideTimer);
      pill.wrap.hidden = false;
      pill.wrap.classList.remove('is-leaving');
      void pill.wrap.offsetWidth;
      pill.wrap.classList.add('is-shown');
    } else if (!want && pill.shown) {
      pill.shown = false;
      pill.wrap.classList.remove('is-shown');
      pill.wrap.classList.add('is-leaving');
      clearTimeout(pill.hideTimer);
      pill.hideTimer = setTimeout(() => { if (!pill.shown) { pill.wrap.hidden = true; pill.wrap.classList.remove('is-leaving'); } }, 620);
      if (popover && popover.anchor === pill.main) closeCard();
    } else if (!want) {
      pill.wrap.hidden = true;
    }
    if (!t) return;
    const meta = [t.artist, sourceTitle()].filter(Boolean).join(' · ');
    swapText(pill.text, [t.title || 'Untitled', meta], animate);
    pill.main.setAttribute('aria-label', `Open player: ${t.title || 'Untitled'}${t.artist ? `, ${t.artist}` : ''}`);
    pill.main.title = t.title || '';
    setArt(pill.art, t, animate);
    syncPP(pill.pp, Audio.isMusicPlaying());
    const liked = Audio.isLiked(t.id);
    pill.like.setAttribute('aria-pressed', String(liked));
    pill.like.setAttribute('aria-label', liked ? 'Unlike this track' : 'Like this track');
    pill.root.classList.toggle('is-liked', liked);
  }

  function renderPillProgress(p) {
    if (!pill || !pill.shown) return;
    pill.fill.style.transform = `scaleX(${Math.max(0, Math.min(1, p)).toFixed(4)})`;
  }

  // Quiet mode (SPEC-V2 §5.1) is the shell's: app.js sets body.is-quiet while focus runs and
  // body.is-idle after 3 s without the pointer; styles.css dims #player-pill-root to 55 %.
  // Here it only slows the equaliser to 15 fps at half amplitude.
  function syncQuiet() {
    const b = document.body.classList;
    const q = b.contains('is-quiet') && b.contains('is-idle');
    if (q !== quiet) { quiet = q; kick(); }
  }

  // ── the card ──

  const cards = new Set();

  function mountCard(host, opts) {
    if (!host) return null;
    const o = opts || {};
    const root = el('div', `pf-card${o.embedded ? ' pf-card--embedded' : ''}`, { role: 'group', 'aria-label': 'Music player', tabindex: '-1' });

    const head = el('div', 'pf-card-head');
    const { art, eq } = makeArt('pf-art--card');
    const titles = el('div', 'pf-card-titles');
    const like = el('button', 'pf-ctl pf-like pf-like--card', { type: 'button', 'aria-pressed': 'false', 'aria-label': 'Like this track' });
    like.append(I.heart());
    // "Not for focus": this track never plays again (a wrong genre, too busy, too loud…)
    const ban = el('button', 'pf-ctl pf-ban', { type: 'button', 'aria-label': 'Don’t play this track again', title: 'Don’t play this again — it leaves every station' });
    ban.append(svg('0 0 20 20', [{ tag: 'circle', cx: '10', cy: '10', r: '6.6', stroke: 'currentColor', 'stroke-width': '1.6', fill: 'none' }, { d: 'M5.4 14.6 14.6 5.4', stroke: 'currentColor', 'stroke-width': '1.6', fill: 'none', ...ROUND }]));
    head.append(art, titles, ban, like);

    const seek = el('div', 'pf-seek');
    const track = el('div', 'pf-seek-track', { role: 'slider', tabindex: '0', 'aria-label': 'Seek', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' });
    const sfill = el('span', 'pf-seek-fill');
    const thumb = el('span', 'pf-seek-thumb');
    const bubble = el('span', 'pf-seek-bubble', { 'aria-hidden': 'true' });
    track.append(sfill, thumb, bubble);
    const times = el('div', 'pf-seek-times');
    const tEl = el('span', 'pf-time', { text: '0:00' });
    const tRem = el('span', 'pf-time', { text: '-0:00' });
    times.append(tEl, tRem);
    seek.append(track, times);

    const transport = el('div', 'pf-transport');
    const srcBtn = el('button', 'pf-source', { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' });
    const srcLabel = el('span', 'pf-source-label');
    srcBtn.append(srcLabel, I.chevron());
    const tc = el('div', 'pf-tc');
    const prev = el('button', 'pf-ctl pf-prev', { type: 'button', 'aria-label': 'Previous track' });
    prev.append(I.prev());
    const pp = playPauseButton('pf-card-pp', 44);
    const next = el('button', 'pf-ctl pf-next', { type: 'button', 'aria-label': 'Next track' });
    next.append(I.next());
    tc.append(prev, pp, next);
    const vol = el('label', 'pf-vol');
    const vr = el('input', 'pf-vol-range', { type: 'range', min: '0', max: '100', step: '1', 'aria-label': 'Music volume' });
    vol.append(I.speaker(), vr);
    transport.append(srcBtn, tc, vol);

    const stationsRow = el('div', 'pf-stations', { role: 'group', 'aria-label': 'Stations' });

    const foot = el('div', 'pf-card-foot');
    const upnext = el('span', 'pf-upnext');
    const credit = el('button', 'pf-credit', { type: 'button' });
    foot.append(upnext, credit);

    const menu = el('div', 'pf-menu', { role: 'menu', hidden: true, 'aria-label': 'Music source' });

    root.append(head, seek, transport, stationsRow, foot, menu);
    host.appendChild(root);

    const c = { root, art, eq, titles, like, track, sfill, thumb, bubble, tEl, tRem, srcBtn, srcLabel, prev, pp, next, vr, stationsRow,
      upnext, credit, menu, dragging: false, chipsSig: '', embedded: !!o.embedded };
    cards.add(c);
    attachEq(eq);

    pp.addEventListener('click', () => playPause());
    prev.addEventListener('click', () => Audio.previousMusic());
    next.addEventListener('click', () => Audio.nextMusic());
    like.addEventListener('click', () => { const t = Audio.currentTrack(); if (t) Audio.like(t.id, !Audio.isLiked(t.id)); });
    ban.addEventListener('click', () => {
      const t = Audio.currentTrack();
      if (!t || !Audio.hide) return;
      Audio.hide(t.id, true);
      try { App.toast(`Won’t play “${t.title}” again`); } catch (_) {}
    });
    vr.addEventListener('input', () => {
      const v = Number(vr.value) / 100;
      try { Store.setSetting('musicVolume', v); } catch (_) {}
      Audio.setMusicVolume(v);
      paintRange(vr);
    });
    credit.addEventListener('click', () => openCredits());
    srcBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(c); });
    wireSeek(c);
    root.addEventListener('keydown', (e) => onCardKey(e, c));
    renderCard(c, false);
    return { el: root, destroy: () => { cards.delete(c); root.remove(); } };
  }

  function defaultSource() {
    const st = Audio.stations();
    if (st.length) return `station:${st.find((x) => x.id === 'flow') ? 'flow' : st[0].id}`;
    const g = Audio.genres();
    if (g.length) return g[0].name;
    return 'station:flow';    // the library is still loading: Audio queues the play until it lands
  }

  // ▶ / ❚❚ everywhere (dock, card): first click always plays — inside the gesture (Safari).
  function playPause() {
    Audio.unlock();
    if (!Audio.source()) Audio.setSource(defaultSource());
    Audio.toggleMusic();
  }

  function paintRange(r) { r.style.setProperty('--fill', `${r.value}%`); }

  function chipSources() {
    const st = Audio.stations();
    if (st.length) return st.map((s) => ({ id: `station:${s.id}`, title: s.title, sub: s.subtitle }));
    return Audio.genres().map((g) => ({ id: g.name, title: g.title, sub: `${g.tracks.length} tracks` }));
  }

  function renderChips(c) {
    const list = chipSources();
    const sig = list.map((x) => x.id).join('|');
    if (sig !== c.chipsSig) {
      c.chipsSig = sig;
      c.stationsRow.textContent = '';
      for (const s of list) {
        const b = el('button', 'pf-chip', { type: 'button', 'data-id': s.id, title: s.sub || s.title, 'aria-pressed': 'false', text: s.title });
        b.addEventListener('click', () => {
          Audio.unlock();
          Audio.setSource(s.id);
          if (!Audio.isMusicPlaying()) Audio.playMusic(null);
        });
        c.stationsRow.appendChild(b);
      }
    }
    const cur = Audio.source();
    c.stationsRow.querySelectorAll('.pf-chip').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === cur)));
  }

  function renderCard(c, animate) {
    const t = Audio.currentTrack();
    const playing = Audio.isMusicPlaying();
    c.root.classList.toggle('is-empty', !t);
    if (t) {
      swapText(c.titles, [t.title || 'Untitled', t.artist || ''], animate);
      setArt(c.art, t, animate);
    } else {
      const src = Audio.source();
      swapText(c.titles, [src ? 'Ready when you are' : 'Music is off', src ? `${sourceTitle()} · starts with your next focus` : 'Pick a station to start'], false);
      setArt(c.art, null, false);
    }
    syncPP(c.pp, playing);
    c.pp.disabled = false;
    const st = Audio.musicStatus ? Audio.musicStatus().state : '';
    c.pp.classList.toggle('is-loading', st === 'loading');
    c.prev.disabled = !t;
    c.next.disabled = !t;
    c.like.disabled = !t;
    const liked = !!t && Audio.isLiked(t.id);
    c.like.setAttribute('aria-pressed', String(liked));
    c.like.setAttribute('aria-label', liked ? 'Unlike this track' : 'Like this track');
    c.root.classList.toggle('is-liked', liked);
    c.srcLabel.textContent = sourceTitle() || 'Off';
    if (document.activeElement !== c.vr) { c.vr.value = String(Math.round((Number(S().musicVolume) || 0) * 100)); paintRange(c.vr); }
    renderChips(c);
    // Footer: "Up next" only here (never on the stage) and the licence credit.
    const n = t ? Audio.upNext() : null;
    c.upnext.textContent = n && t && n.id !== t.id ? `Up next · ${n.title}${n.artist ? ` — ${n.artist}` : ''}` : '';
    c.upnext.title = c.upnext.textContent;
    if (t && isCcBy(t)) {
      c.credit.textContent = `${t.artist || 'Kevin MacLeod'} · CC BY 4.0`;
      c.credit.title = t.credit || '';
    } else {
      c.credit.textContent = 'Credits';
      c.credit.title = 'Music credits and licences';
    }
    renderCardProgress(c);
  }

  function renderCardProgress(c) {
    if (c.dragging) return;
    const d = Audio.musicDuration(), e = Audio.musicElapsed();
    const p = d ? Math.min(1, e / d) : 0;
    c.sfill.style.transform = `scaleX(${p.toFixed(4)})`;
    c.thumb.style.left = `${(p * 100).toFixed(2)}%`;
    c.track.setAttribute('aria-valuenow', String(Math.round(p * 100)));
    c.track.setAttribute('aria-valuetext', `${fmt(e)} of ${fmt(d)}`);
    c.tEl.textContent = fmt(e);
    c.tRem.textContent = `-${fmt(Math.max(0, d - e))}`;
  }

  function wireSeek(c) {
    const frac = (x) => { const r = c.track.getBoundingClientRect(); return Math.min(1, Math.max(0, (x - r.left) / Math.max(1, r.width))); };
    const show = (f) => {
      const d = Audio.musicDuration();
      c.sfill.style.transform = `scaleX(${f.toFixed(4)})`;
      c.thumb.style.left = `${(f * 100).toFixed(2)}%`;
      c.bubble.style.left = `${(f * 100).toFixed(2)}%`;
      c.bubble.textContent = fmt(f * d);
    };
    c.track.addEventListener('pointerdown', (e) => {
      if (!Audio.currentTrack()) return;
      c.dragging = true;
      c.root.classList.add('is-dragging');
      try { c.track.setPointerCapture(e.pointerId); } catch (_) {}
      show(frac(e.clientX));
    });
    c.track.addEventListener('pointermove', (e) => { if (c.dragging) show(frac(e.clientX)); });
    const end = (e) => {
      if (!c.dragging) return;
      c.dragging = false;
      c.root.classList.remove('is-dragging');
      const f = frac(e.clientX);
      Audio.seekMusic(f * Audio.musicDuration());
    };
    c.track.addEventListener('pointerup', end);
    c.track.addEventListener('pointercancel', () => { c.dragging = false; c.root.classList.remove('is-dragging'); renderCardProgress(c); });
    c.track.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (e.shiftKey) return;     // ⇧←/⇧→ = previous / next (card handler)
      e.preventDefault();
      e.stopPropagation();
      Audio.seekMusic(Audio.musicElapsed() + (e.key === 'ArrowRight' ? 5 : -5));
    });
  }

  function onCardKey(e, c) {
    if (e.target && e.target.closest && e.target.closest('input, select, textarea, .pf-menu')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (k === ' ' || e.code === 'Space') {
      if (e.target && e.target.closest && e.target.closest('button')) return;   // a focused button handles Space itself
      e.preventDefault(); e.stopPropagation(); Audio.toggleMusic();
    } else if ((k === 'ArrowRight' || k === 'ArrowLeft') && e.shiftKey) {
      e.preventDefault(); e.stopPropagation(); if (k === 'ArrowRight') Audio.nextMusic(); else Audio.previousMusic();
    } else if ((k === 'ArrowRight' || k === 'ArrowLeft') && !(e.target && e.target.closest && e.target.closest('.pf-stations'))) {
      e.preventDefault(); e.stopPropagation(); Audio.seekMusic(Audio.musicElapsed() + (k === 'ArrowRight' ? 5 : -5));
    } else if (k === 'l' || k === 'L') {
      const t = Audio.currentTrack();
      if (t) { e.preventDefault(); e.stopPropagation(); Audio.like(t.id, !Audio.isLiked(t.id)); }
    } else if (k === 'Escape' && !c.menu.hidden) {
      e.preventDefault(); e.stopPropagation(); closeMenu(c, true);
    }
  }

  // Source menu: 5 stations │ 9 genres with counts │ Off.
  function toggleMenu(c) {
    if (!c.menu.hidden) { closeMenu(c, true); return; }
    c.menu.textContent = '';
    const cur = Audio.source();
    const add = (id, label, count) => {
      const b = el('button', 'pf-menu-item', { type: 'button', role: 'menuitemradio', 'aria-checked': String(id === cur) });
      b.append(el('span', 'pf-menu-label', { text: label }));
      if (count != null) b.append(el('span', 'pf-menu-count', { text: String(count) }));
      b.addEventListener('click', () => {
        closeMenu(c, true);
        Audio.unlock();
        Audio.setSource(id);
        if (id && !Audio.isMusicPlaying()) Audio.playMusic(null);
      });
      c.menu.appendChild(b);
    };
    const st = Audio.stations();
    if (st.length) {
      c.menu.appendChild(el('div', 'pf-menu-head', { text: 'Stations' }));
      st.forEach((s) => add(`station:${s.id}`, s.title, null));
      c.menu.appendChild(el('div', 'pf-menu-sep', { role: 'separator' }));
    }
    c.menu.appendChild(el('div', 'pf-menu-head', { text: 'Genres' }));
    Audio.genres().forEach((g) => add(g.name, g.title, g.tracks.length));
    c.menu.appendChild(el('div', 'pf-menu-sep', { role: 'separator' }));
    add('', 'Off', null);
    c.menu.hidden = false;
    c.srcBtn.setAttribute('aria-expanded', 'true');
    const first = c.menu.querySelector('[aria-checked="true"]') || c.menu.querySelector('.pf-menu-item');
    if (first) first.focus({ preventScroll: true });
    const onDoc = (e) => { if (!c.menu.contains(e.target) && e.target !== c.srcBtn) closeMenu(c, false); };
    c.menuDoc = onDoc;
    document.addEventListener('pointerdown', onDoc, true);
    c.menu.onkeydown = (e) => {
      const items = Array.from(c.menu.querySelectorAll('.pf-menu-item'));
      const i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const j = (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[j].focus();
      } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(c, true); }
    };
  }
  function closeMenu(c, refocus) {
    if (c.menu.hidden) return;
    c.menu.hidden = true;
    c.srcBtn.setAttribute('aria-expanded', 'false');
    if (c.menuDoc) document.removeEventListener('pointerdown', c.menuDoc, true);
    if (refocus) c.srcBtn.focus({ preventScroll: true });
  }

  // ── the card as a popover ──

  let popover = null;   // {wrap, card, anchor}

  function openCard(anchor) {
    closeCard(true);
    const wrap = el('div', 'pf-card-pop', { role: 'dialog', 'aria-label': 'Music player' });
    const arrow = el('span', 'pf-card-arrow', { 'aria-hidden': 'true' });
    document.body.appendChild(wrap);
    const card = mountCard(wrap);
    wrap.appendChild(arrow);
    popover = { wrap, card, anchor: anchor || null, arrow };
    if (anchor) anchor.setAttribute('aria-expanded', 'true');
    position();
    void wrap.offsetWidth;
    wrap.classList.add('is-open');
    const focusTarget = wrap.querySelector('.pf-card-pp');
    if (focusTarget) focusTarget.focus({ preventScroll: true });
    document.addEventListener('pointerdown', onDocPointer, true);
    document.addEventListener('keydown', onDocKey, true);
    window.addEventListener('resize', position);
    return card;
  }

  function position() {
    if (!popover) return;
    const { wrap, anchor, arrow } = popover;
    const sheet = window.innerWidth <= 600;
    wrap.classList.toggle('is-sheet', sheet);
    if (sheet || !anchor) { wrap.style.left = ''; wrap.style.top = ''; return; }
    const r = anchor.getBoundingClientRect();
    const w = wrap.offsetWidth || 360, h = wrap.offsetHeight || 256;
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(12, Math.min(window.innerWidth - w - 12, left));
    const above = r.top - h - 14 >= 8;
    const top = Math.max(8, Math.min(window.innerHeight - h - 8, above ? r.top - h - 12 : r.bottom + 12));
    wrap.style.left = `${Math.round(left)}px`;
    wrap.style.top = `${Math.round(top)}px`;
    wrap.classList.toggle('is-below', !above);
    arrow.style.left = `${Math.round(Math.max(18, Math.min(w - 18, r.left + r.width / 2 - left)))}px`;
  }

  function onDocPointer(e) {
    if (!popover) return;
    if (popover.wrap.contains(e.target) || (popover.anchor && popover.anchor.contains(e.target))) return;
    closeCard();
  }
  function onDocKey(e) {
    if (e.key === 'Escape' && popover) {
      if (popover.wrap.querySelector('.pf-menu:not([hidden])')) return;
      e.preventDefault(); e.stopPropagation();
      const a = popover.anchor;
      closeCard();
      if (a) a.focus({ preventScroll: true });
    }
  }

  function closeCard(now) {
    if (!popover) return;
    const p = popover;
    popover = null;
    document.removeEventListener('pointerdown', onDocPointer, true);
    document.removeEventListener('keydown', onDocKey, true);
    window.removeEventListener('resize', position);
    if (p.anchor) p.anchor.setAttribute('aria-expanded', 'false');
    p.wrap.classList.remove('is-open');
    const done = () => { if (p.card) p.card.destroy(); p.wrap.remove(); };
    if (now || reduceMotion()) done(); else setTimeout(done, 200);
  }

  function openCredits() {
    closeCard(true);
    try { if (typeof Scenes !== 'undefined' && Scenes.close) Scenes.close(); } catch (_) {}
    try {
      if (typeof Settings !== 'undefined' && Settings.open) {
        Settings.open('sounds');
        const more = document.getElementById('snd-more');
        if (more) more.open = true;
        renderMore();
        const cr = document.getElementById('snd-credits');
        if (cr) { cr.scrollIntoView({ block: 'start' }); cr.focus({ preventScroll: true }); }
      }
    } catch (_) {}
  }

  // ── Settings › Sounds (v2-sound §6.4: 6 controls at T0; More holds the rest) ──

  let soundsEl = null;
  const sc = {};   // sounds-section controls

  function row(label, sub, ctl, id) {
    const r = el('div', 'snd-row');
    const l = el('div', 'snd-label');
    l.append(el(id ? 'label' : 'span', 'snd-title', { text: label, for: id || null }));
    if (sub) l.append(el('span', 'snd-sub', { text: sub }));
    r.append(l, ctl);
    return r;
  }

  function volume(id, key, apply) {
    const w = el('div', 'snd-vol');
    const r = el('input', 'snd-range', { type: 'range', id, min: '0', max: '100', step: '1', 'aria-label': 'Volume' });
    const v = el('span', 'snd-vol-value');
    r.addEventListener('input', () => {
      const x = Number(r.value) / 100;
      try { Store.setSetting(key, x); } catch (_) {}
      if (apply) apply(x);
      v.textContent = `${r.value}%`;
      paintRange(r);
    });
    w.append(r, v);
    return { w, r, v, key };
  }

  function selectFrom(id, options, groups) {
    const s = el('select', 'select snd-select', { id });
    if (groups) {
      for (const g of groups) {
        if (!g.options.length) continue;
        if (!g.label) { g.options.forEach((o) => s.append(el('option', '', { value: o[0], text: o[1] }))); continue; }
        const og = el('optgroup', '', { label: g.label });
        g.options.forEach((o) => og.append(el('option', '', { value: o[0], text: o[1] })));
        s.append(og);
      }
    } else options.forEach((o) => s.append(el('option', '', { value: o[0], text: o[1] })));
    return s;
  }

  function musicOptions() {
    return [
      { label: '', options: [['', 'Off']] },
      { label: 'Stations', options: Audio.stations().map((x) => [`station:${x.id}`, x.title]) },
      { label: 'Genres', options: Audio.genres().map((g) => [g.name, `${g.title} · ${g.tracks.length}`]) },
    ];
  }

  function renderSoundsSection(host) {
    soundsEl = host;
    host.textContent = '';
    const card = el('div', 'glass card settings-card snd');

    // 1. Alarm (picker + ▶ preview) and alarm volume
    const alarmSel = selectFrom('snd-alarm', Store.ALARMS.map((a) => [a.id, a.name]));
    const alarmPrev = el('button', 'icon-btn small snd-preview', { type: 'button', 'aria-label': 'Preview the alarm', title: 'Preview' });
    alarmPrev.append(I.preview());
    const alarmVol = volume('snd-alarm-vol', 'alarmVolume', null);
    alarmVol.r.addEventListener('change', () => Audio.previewAlarm(Store.settings().selectedAlarm));
    const alarmCtl = el('div', 'snd-ctl');
    alarmCtl.append(el('div', 'snd-pick', {}), alarmVol.w);
    alarmCtl.firstChild.append(alarmSel, alarmPrev);
    alarmSel.addEventListener('change', () => { Store.setSetting('selectedAlarm', alarmSel.value); Audio.previewAlarm(alarmSel.value); });
    alarmPrev.addEventListener('click', () => Audio.previewAlarm(alarmSel.value));

    // 2. Ambience and volume
    const ambSel = selectFrom('snd-amb', Store.AMBIENCES.map((a) => [a.id, a.name]));
    const ambVol = volume('snd-amb-vol', 'ambienceVolume', (x) => Audio.setAmbienceVolume(x));
    const ambCtl = el('div', 'snd-ctl');
    ambCtl.append(el('div', 'snd-pick'), ambVol.w);
    ambCtl.firstChild.append(ambSel);
    ambSel.addEventListener('change', () => {
      Store.setSetting('selectedAmbience', ambSel.value);
      if (ambSel.value === 'none') Audio.stopAmbience();
      else if (focusRunning()) Audio.startAmbience();
      else Audio.previewAmbience(ambSel.value);
    });

    // 3. Music (Off · station · genre) and volume
    const musSel = selectFrom('snd-music', null, musicOptions());
    const musVol = volume('snd-music-vol', 'musicVolume', (x) => Audio.setMusicVolume(x));
    const musCtl = el('div', 'snd-ctl');
    musCtl.append(el('div', 'snd-pick'), musVol.w);
    musCtl.firstChild.append(musSel);
    musSel.addEventListener('change', () => Audio.setSource(musSel.value));

    // 4. Even out volume
    const normT = el('label', 'toggle snd-toggle');
    const normIn = el('input', '', { type: 'checkbox', id: 'snd-normalize' });
    normT.append(normIn, el('span', 'switch'));
    normIn.addEventListener('change', () => Store.setSetting('musicNormalize', normIn.checked));

    // 5. Crossfade Auto · Off
    const xf = el('div', 'segmented snd-seg', { role: 'radiogroup', 'aria-label': 'Crossfade' });
    const xfBtns = [['auto', 'Auto'], ['off', 'Off']].map(([v, t]) => {
      const b = el('button', 'seg-btn', { type: 'button', role: 'radio', 'data-v': v, text: t });
      b.addEventListener('click', () => Store.setSetting('musicCrossfade', v));
      xf.append(b);
      return b;
    });

    // 6. Ticking
    const tickT = el('label', 'toggle snd-toggle');
    const tickIn = el('input', '', { type: 'checkbox', id: 'snd-ticking' });
    tickT.append(tickIn, el('span', 'switch'));
    tickIn.addEventListener('change', () => {
      Store.setSetting('tickingEnabled', tickIn.checked);
      if (focusRunning() && tickIn.checked) Audio.startTicking(); else if (!tickIn.checked) Audio.stopTicking();
    });

    card.append(
      row('Alarm', 'Rings when a session ends', alarmCtl, 'snd-alarm'),
      row('Ambience', 'A soft bed under your focus', ambCtl, 'snd-amb'),
      row('Music', 'Balanced for focus', musCtl, 'snd-music'),
      row('Even out volume', 'Plays every track at the same loudness', normT, 'snd-normalize'),
      row('Crossfade', 'Blend each track into the next. Off plays them back to back', xf, null),
      row('Ticking', 'A quiet tick each second while you focus', tickT, 'snd-ticking'),
    );
    // tracks you've hidden with ⊘ in the player
    const hiddenBtn = el('button', 'btn btn-glass btn-sm', { type: 'button' });
    const hiddenRow = row('Hidden tracks', 'Tracks you chose not to hear again', hiddenBtn, null);
    hiddenBtn.addEventListener('click', () => {
      for (const t of (Audio.hiddenTracks ? Audio.hiddenTracks() : [])) Audio.hide(t.id, false);
      syncSounds();
    });
    card.append(hiddenRow);

    // More: library with 8 s previews, credits, clear history & likes.
    const more = el('details', 'settings-more snd-more', { id: 'snd-more' });
    more.append(el('summary', '', { text: 'More' }));
    const body = el('div', 'settings-more-body snd-more-body');
    more.append(body);
    more.addEventListener('toggle', () => { if (more.open) renderMore(); });
    card.append(more);
    host.append(card);

    Object.assign(sc, { alarmSel, alarmVol, ambSel, ambVol, musSel, musVol, normIn, xfBtns, tickIn, more, body, musSig: '', hiddenBtn, hiddenRow });
    syncSounds();
  }

  function syncSounds() {
    if (!soundsEl || !sc.alarmSel) return;
    const s = S();
    if (sc.hiddenBtn) {
      const n = Audio.hiddenTracks ? Audio.hiddenTracks().length : 0;
      sc.hiddenRow.hidden = n === 0;
      sc.hiddenBtn.textContent = `Bring back ${n} track${n === 1 ? '' : 's'}`;
    }
    const set = (sel, v) => { if (document.activeElement !== sel && sel.value !== v) sel.value = v; };
    set(sc.alarmSel, s.selectedAlarm || 'bowl');
    set(sc.ambSel, s.selectedAmbience || 'none');
    const sig = Audio.stations().length + ':' + Audio.genres().map((g) => g.name + g.tracks.length).join(',');
    if (sig !== sc.musSig) {
      sc.musSig = sig;
      const fresh = selectFrom('snd-music', null, musicOptions());
      sc.musSel.textContent = '';
      Array.from(fresh.childNodes).forEach((n) => sc.musSel.appendChild(n));
    }
    const src = Audio.source();
    if (!Array.from(sc.musSel.options).some((o) => o.value === src) && src) {
      sc.musSel.append(el('option', '', { value: src, text: sourceTitle() || src }));
    }
    set(sc.musSel, src);
    for (const v of [sc.alarmVol, sc.ambVol, sc.musVol]) {
      if (document.activeElement !== v.r) v.r.value = String(Math.round((Number(s[v.key]) || 0) * 100));
      v.v.textContent = `${v.r.value}%`;
      paintRange(v.r);
    }
    sc.normIn.checked = s.musicNormalize !== false;
    sc.xfBtns.forEach((b) => {
      const on = (s.musicCrossfade || 'auto') === b.dataset.v;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-checked', String(on));
    });
    sc.tickIn.checked = !!s.tickingEnabled;
    if (sc.more && sc.more.open) syncLibrary();
  }

  // ── More: library, credits, clear ──

  let libQuery = '';
  let moreBuilt = false;

  function renderMore() {
    if (!sc.body) return;
    if (!moreBuilt || sc.body.dataset.sig !== String(Audio.tracks().length)) {
      moreBuilt = true;
      sc.body.dataset.sig = String(Audio.tracks().length);
      sc.body.textContent = '';
      // Library
      const lib = el('section', 'snd-lib', { 'aria-labelledby': 'snd-lib-title' });
      const head = el('div', 'snd-sub-head');
      head.append(el('h4', 'snd-h', { id: 'snd-lib-title', text: 'Music library' }));
      const search = el('input', 'text-input snd-search', { type: 'search', placeholder: 'Search tracks or artists', 'aria-label': 'Search the music library', autocomplete: 'off' });
      search.value = libQuery;
      search.addEventListener('input', () => { libQuery = search.value; syncLibrary(); });
      head.append(search);
      const list = el('div', 'snd-lib-list');
      lib.append(head, el('p', 'snd-note', { text: '▶ plays an 8-second preview; your music dips while it plays.' }), list);
      // Credits
      const cred = el('section', 'snd-credits', { id: 'snd-credits', tabindex: '-1', 'aria-labelledby': 'snd-credits-title' });
      cred.append(el('h4', 'snd-h', { id: 'snd-credits-title', text: 'Credits' }));
      const groups = new Map();
      for (const c of Audio.credits()) {
        const k = c.licence || 'Other';
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(c);
      }
      if (!groups.size) cred.append(el('p', 'snd-note', { text: 'Credits appear once the music library has loaded.' }));
      for (const [lic, items] of groups) {
        const g = el('div', 'snd-credit-group');
        const licUrl = safeHttps(items[0] && items[0].licenceUrl);
        const gh = el('div', 'snd-credit-licence');
        gh.append(el('span', '', { text: `${lic} · ${items.length} ${items.length === 1 ? 'track' : 'tracks'}` }));
        if (licUrl) gh.append(el('a', 'snd-link', { href: licUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Licence' }));
        g.append(gh);
        const ul = el('ul', 'snd-credit-list');
        for (const c of items) {
          const li = el('li');
          li.append(el('span', 'snd-credit-line', { text: c.credit || `"${c.title}" ${c.artist}` }));
          const page = safeHttps(c.pageUrl);
          if (page) li.append(el('a', 'snd-link', { href: page, target: '_blank', rel: 'noopener noreferrer', text: 'Source', 'aria-label': `Source of ${c.title}` }));
          ul.append(li);
        }
        g.append(ul);
        cred.append(g);
      }
      cred.append(el('p', 'snd-note', { text: 'Every track is free to use: Creative Commons Attribution, CC0 or public domain. Videos come from Mixkit.' }));
      // Clear
      const clr = el('div', 'snd-clear');
      const btn = el('button', 'btn btn-sm snd-clear-btn', { type: 'button', text: 'Clear listening history & likes' });
      let armed = 0;
      btn.addEventListener('click', () => {
        if (!armed) {
          btn.textContent = 'Click again to clear';
          armed = setTimeout(() => { armed = 0; btn.textContent = 'Clear listening history & likes'; }, 3000);
          return;
        }
        clearTimeout(armed); armed = 0;
        Audio.clearHistory();
        btn.textContent = 'Cleared';
        setTimeout(() => { btn.textContent = 'Clear listening history & likes'; }, 1600);
      });
      clr.append(btn, el('span', 'snd-note', { text: 'Your stations forget what you played and liked on this device.' }));
      sc.body.append(lib, cred, clr);
      sc.list = list;
    }
    syncLibrary();
  }

  function syncLibrary() {
    const list = sc.list;
    if (!list) return;
    const q = libQuery.trim().toLowerCase();
    const previewing = Audio.previewing ? Audio.previewing() : null;
    const cur = Audio.currentTrack();
    list.textContent = '';
    let shown = 0;
    for (const g of Audio.genres()) {
      const items = g.tracks.filter((t) => !q || `${t.title} ${t.artist} ${g.title}`.toLowerCase().includes(q));
      if (!items.length) continue;
      const grp = el('div', 'snd-lib-genre');
      const gh = el('div', 'snd-lib-ghead');
      const sw = el('span', 'snd-lib-swatch', { 'aria-hidden': 'true' });
      const [a, b] = artFor(items[0]);
      sw.style.background = `linear-gradient(135deg, ${a}, ${b})`;
      gh.append(sw, el('span', 'snd-lib-gtitle', { text: g.title }), el('span', 'snd-lib-count', { text: String(items.length) }));
      grp.append(gh);
      for (const t of items) {
        const r = el('div', 'snd-track');
        const isPrev = previewing && previewing.id === t.id;
        const p = el('button', 'icon-btn small snd-track-play', { type: 'button', 'aria-label': isPrev ? `Stop preview of ${t.title}` : `Preview ${t.title}` });
        p.append(isPrev ? I.stop() : I.preview());
        p.addEventListener('click', () => {
          if (Audio.previewing && Audio.previewing() && Audio.previewing().id === t.id) Audio.stopPreview(false);
          else Audio.previewMusic(t.id);
        });
        const txt = el('span', 'snd-track-text');
        txt.append(el('span', 'snd-track-title', { text: t.title }), el('span', 'snd-track-artist', { text: t.artist || '' }));
        const liked = Audio.isLiked(t.id);
        const lk = el('button', 'pf-ctl pf-like snd-track-like', { type: 'button', 'aria-pressed': String(liked), 'aria-label': liked ? `Unlike ${t.title}` : `Like ${t.title}` });
        lk.append(I.heart());
        lk.addEventListener('click', () => Audio.like(t.id, !Audio.isLiked(t.id)));
        r.classList.toggle('is-liked', liked);
        r.classList.toggle('is-current', !!cur && cur.id === t.id);
        r.append(p, txt, el('span', 'snd-track-dur', { text: fmt(t.durationSec || t.duration) }), lk);
        grp.append(r);
        shown += 1;
      }
      list.append(grp);
    }
    if (!shown) list.append(el('p', 'snd-note', { text: q ? 'No tracks match.' : 'The library is loading…' }));
  }

  // ── wiring ──

  let pausedByHand = false;
  let inited = false;

  function onMusic() {
    // Music paused while focus keeps running = paused by hand (keep the pill reachable).
    if (Audio.isMusicPlaying()) pausedByHand = false;
    else if (Audio.currentTrack() && focusRunning()) pausedByHand = true;
    renderPill(true);
    renderDock(true);
    cards.forEach((c) => renderCard(c, true));
    syncSounds();
    kick();
  }

  function init() {
    if (inited) return;
    inited = true;
    document.documentElement.classList.add('pf-player-v2');   // hides the v1 now-playing bar (player.css)
    try { mountDock(); } catch (err) { console.error('Player: dock failed', err); }
    if (!dock) mountPill(document.getElementById('player-pill-root'));
    try {
      if (typeof Settings !== 'undefined' && Settings.registerSection) {
        Settings.registerSection({ id: 'sounds', title: 'Sounds', order: 2, render: renderSoundsSection });
      }
    } catch (err) { console.error('Player: Settings › Sounds failed', err); }
    try {
      Store.on('music', onMusic);
      Store.on('music:progress', (p) => {
        const prog = p && Number.isFinite(p.progress) ? p.progress : Audio.musicProgress();
        renderPillProgress(prog);
        renderDockProgress(prog);
        cards.forEach(renderCardProgress);
      });
      Store.on('music:upnext', () => cards.forEach((c) => renderCard(c, false)));
      Store.on('music:preview', () => { if (sc.more && sc.more.open) syncLibrary(); });
      Store.on('change', (kind) => {
        if (kind === 'settings' || kind === 'bulk' || kind === 'remote' || kind === 'reset') {
          syncSounds();
          cards.forEach((c) => renderCard(c, false));
        }
      });
    } catch (_) {}
    try {
      if (typeof Timer !== 'undefined' && Timer.on) {
        const refresh = () => { pausedByHand = false; renderPill(true); };
        Timer.on('start', refresh);
        Timer.on('resume', refresh);
        Timer.on('pause', refresh);
        Timer.on('stop', refresh);
      }
    } catch (_) {}
    new MutationObserver(syncQuiet).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    document.addEventListener('visibilitychange', kick);
    try {
      const mq = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
      if (mq && mq.addEventListener) mq.addEventListener('change', kick);
    } catch (_) {}
    onMusic();
  }

  return { init, mountPill, mountCard, openCard, closeCard, attachEq, playPause, _state: () => ({ pill: pill && pill.shown, dock: !!dock, quiet, cards: cards.size, popover: !!popover, loop: !!rafId }) };
})();
