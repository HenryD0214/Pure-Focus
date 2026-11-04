/* ═══════════════════════════════════════════════════════════════════════
   declutter.js — the Focus page's "strip it back" button

   One round button in the Focus page's top-right corner, over the scene. Each click hides one more layer:
     0 → 1  timer + tasks only (sidebar, mode tabs, caption, progress row hidden; the music bar
            stays with the timer)
     1 → 2  timer only (with its music bar)
     2 → 3  scene only — with no scene (plain Aurora) a prompt offers a few to pick from
     3 → 0  everything back
   The level lives on <html data-declutter="1|2|3">; styles.css does the hiding. Esc also restores.
   Hiding the sidebar also takes the browser full screen (tabs, address bar, Dock); leaving full
   screen any other way (Esc, the browser's own control) brings everything back.
   Not persisted: a reload always shows the full page.

   Public API: Declutter.init(), Declutter.set(level), Declutter.level()
   ═══════════════════════════════════════════════════════════════════════ */

const Declutter = (() => {
  'use strict';

  const NEXT_LABEL = ['Hide extras', 'Timer only', 'Scene only', 'Show everything'];
  const NOW_LABEL = ['', 'Timer and tasks', 'Timer only', 'Scene only'];
  const PROMPT_SCENES = ['sunset-beach', 'rainy-window', 'misty-forest', 'northern-lights'];
  const CATALOGUE_URL = 'assets/scenes/scenes.json';

  let level = 0;
  let btn = null;
  let label = null;
  let flashTimer = 0;
  let tilesBuilt = false;
  let ownFullscreen = false;     // we entered it, so we leave it (never exit one the person chose)

  // ── browser full screen (Safari needs the webkit- names before 16.4; iPhone has none: no-op) ──
  function fsElement() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
  function enterFullscreen() {
    if (fsElement()) return;
    const el = document.documentElement;
    const fn = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!fn) return;
    ownFullscreen = true;
    try {
      const p = fn.call(el);
      if (p && p.catch) p.catch(() => { ownFullscreen = false; });
    } catch (_) { ownFullscreen = false; }
  }
  function exitFullscreen() {
    if (!ownFullscreen) return;
    ownFullscreen = false;
    if (!fsElement()) return;
    const fn = document.exitFullscreen || document.webkitExitFullscreen;
    try {
      const p = fn && fn.call(document);
      if (p && p.catch) p.catch(() => {});
    } catch (_) { /* ignore */ }
  }
  function onFullscreenChange() {
    syncTopbarHeight();
    if (!fsElement() && ownFullscreen) {
      ownFullscreen = false;
      if (level) { set(0); flash(); }
    }
  }

  function syncTopbarHeight() {
    const bar = document.querySelector('.topbar');
    if (bar) document.documentElement.style.setProperty('--topbar-h', bar.offsetHeight + 'px');
  }

  function set(n) {
    level = ((n % 4) + 4) % 4;
    const root = document.documentElement;
    if (level) root.dataset.declutter = String(level); else delete root.dataset.declutter;
    const next = NEXT_LABEL[level];
    btn.dataset.level = String(level);
    btn.title = next + (level ? ' (Esc shows everything)' : '');
    btn.setAttribute('aria-label', next);
    label.textContent = next;
    if (level) enterFullscreen(); else exitFullscreen();
    if (level === 3) buildTiles();
    // Anything open belongs to a layer that may have just gone; close it quietly.
    if (level && typeof Scenes !== 'undefined' && Scenes.close && level !== 3) Scenes.close();
  }

  function flash() {
    clearTimeout(flashTimer);
    btn.classList.add('is-flash');
    label.textContent = level ? NOW_LABEL[level] : 'Everything back';
    flashTimer = setTimeout(() => {
      btn.classList.remove('is-flash');
      label.textContent = NEXT_LABEL[level];
    }, 1400);
  }

  // The no-scene prompt: four calm scenes as poster tiles; a click sets the scene and the prompt
  // fades (styles.css shows it only while body lacks .has-scene).
  async function buildTiles() {
    if (tilesBuilt) return;
    tilesBuilt = true;
    const host = document.getElementById('scene-prompt-tiles');
    if (!host) return;
    let scenes = [];
    try {
      const res = await fetch(CATALOGUE_URL);
      const data = await res.json();
      scenes = Array.isArray(data.scenes) ? data.scenes : [];
    } catch (_) { tilesBuilt = false; return; }
    const pick = PROMPT_SCENES.map((id) => scenes.find((s) => s.id === id)).filter(Boolean);
    for (const s of pick) {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'scene-prompt-tile';
      tile.setAttribute('aria-label', 'Use the ' + s.title + ' scene');
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.src = s.posterSmall || s.poster || '';
      const name = document.createElement('span');
      name.className = 'scene-prompt-tile-name';
      name.textContent = s.title;
      tile.append(img, name);
      tile.addEventListener('click', () => { if (typeof Scenes !== 'undefined') Scenes.set(s.id); });
      host.appendChild(tile);
    }
  }

  function init() {
    btn = document.getElementById('declutter-btn');
    label = document.getElementById('declutter-label');
    if (!btn || !label) return;
    syncTopbarHeight();
    window.addEventListener('resize', syncTopbarHeight);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    set(0);
    btn.addEventListener('click', () => { set(level + 1); flash(); });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !level || e.defaultPrevented) return;
      set(0); flash();
    });
    const more = document.getElementById('scene-prompt-more');
    if (more) more.addEventListener('click', () => { if (typeof Scenes !== 'undefined') Scenes.openPicker(more); });
    const back = document.getElementById('scene-prompt-back');
    if (back) back.addEventListener('click', () => { set(0); flash(); btn.focus({ preventScroll: true }); });
  }

  return { init, set, level: () => level };
})();

Declutter.init();
