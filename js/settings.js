/* ═══════════════════════════════════════════════════════════════════════
   settings.js — the Settings view
   Durations, sounds, music, theme, appearance and data import/export.
   ═══════════════════════════════════════════════════════════════════════ */

const Settings = (() => {
  const $ = (sel) => document.querySelector(sel);

  // ── the 7-section layout + section / card registry (SPEC-V2 §4.8, §5.7) ──
  // app.html holds seven .settings-group containers (timer · sounds · look · rewards · guard ·
  // calendar · data), each with a heading and a body. Built-in cards carry
  // data-settings-section="<id>" and data-order. The shell draws every group heading;
  // owners fill the body:
  //   registerSection({id, title, order, render(el)}) → unregister. A built-in id hides that
  //     group's built-in cards (kept in the DOM so their controls still work) and mounts
  //     <section class="settings-section" data-section-id> at the top of the group body; a new
  //     id gets its own group (heading = title) placed by order. render(el) fills the body —
  //     don't draw a section heading (a first <h2>/<h3> repeating the title is hidden).
  //   registerCard(sectionID, {id, order, render(el)}) → unregister. The card slot joins the
  //     group body by order (default 50; built-ins: Calendar & Accounts calendars 20, Google 90).
  //   open(sectionID, focusID?) shows Settings, scrolls the group into view, focuses #focusID.
  // A group with nothing visible in it (Focus Guard until W4 registers) stays hidden, and the
  // sticky chip index lists only the visible groups.
  const SECTION_ORDER = { timer: 1, sounds: 2, look: 3, rewards: 4, guard: 5, calendar: 6, data: 7 };
  const sections = new Map();   // id → {spec, el}
  const cards = new Map();      // sectionID → Map(cardID → {spec, el, rendered})
  let registryReady = false;

  function wrap() { return document.querySelector('#view-settings .settings-wrap'); }
  function builtIns(id) { return Array.from(document.querySelectorAll(`#view-settings [data-settings-section="${id}"]`)); }
  function orderOf(spec) { return Number.isFinite(spec.order) ? spec.order : (SECTION_ORDER[spec.id] || 99); }
  function safeRender(fn, el, what) {
    try { fn(el); } catch (err) { console.error(`Settings: ${what} failed to render`, err); }
  }
  function groupEl(id) { const w = wrap(); return w ? w.querySelector(`.settings-group[data-group="${id}"]`) : null; }
  function groupOrder(g) { const o = Number(g.dataset.order); return Number.isFinite(o) && g.dataset.order !== '' ? o : (SECTION_ORDER[g.dataset.group] || 99); }
  function bodyOf(g) { return g.querySelector('.settings-group-body'); }
  function itemOrder(n) { const v = Number(n.dataset.order); return n.dataset.order !== undefined && Number.isFinite(v) ? v : 50; }
  function titleOf(g) { const t = g.querySelector('.settings-group-title'); return t ? t.textContent.trim() : ''; }

  function ensureGroup(id, title, order) {
    let g = groupEl(id);
    if (g) return g;
    const host = wrap();
    if (!host) return null;
    g = document.createElement('section');
    g.className = 'settings-group';
    g.dataset.group = id;
    g.dataset.order = String(order);
    const head = document.createElement('header');
    head.className = 'settings-group-head';
    const h = document.createElement('h2');
    h.className = 'settings-group-title';
    h.id = `sg-${id}`;
    h.textContent = title || id;
    head.appendChild(h);
    const body = document.createElement('div');
    body.className = 'settings-group-body';
    g.append(head, body);
    g.setAttribute('aria-labelledby', h.id);
    const next = Array.from(host.querySelectorAll('.settings-group')).find((x) => groupOrder(x) > order);
    if (next) next.before(g); else host.appendChild(g);
    return g;
  }

  // Insert `node` into `body` before the first sibling with a larger order (DOM order = visual order).
  function place(body, node, order) {
    node.dataset.order = String(order);
    const next = Array.from(body.children).find((c) => c !== node && itemOrder(c) > order);
    if (next) next.before(node); else body.appendChild(node);
  }

  function syncGroup(g) {
    if (!g) return;
    const body = bodyOf(g);
    const any = !!body && Array.from(body.children).some((c) => !c.hidden);
    if (g.hidden === any) g.hidden = !any;
    renderIndex();
  }

  function hideRepeatedTitle(el, g) {
    const first = el.firstElementChild;
    if (first && /^H[1-4]$/.test(first.tagName) && first.textContent.trim().toLowerCase() === titleOf(g).toLowerCase()) {
      first.hidden = true;
    }
  }

  function mountSection(id) {
    const entry = sections.get(id);
    if (!entry || !wrap()) return;
    const g = ensureGroup(id, entry.spec.title, orderOf(entry.spec));
    if (!g) return;
    if (!entry.el) {
      entry.el = document.createElement('section');
      entry.el.className = 'settings-section';
      entry.el.dataset.sectionId = id;
      if (entry.spec.title) entry.el.setAttribute('aria-label', entry.spec.title);
    }
    builtIns(id).forEach((n) => { n.hidden = true; n.dataset.replaced = 'true'; });
    place(bodyOf(g), entry.el, 5);
    entry.el.textContent = '';
    if (typeof entry.spec.render === 'function') safeRender(entry.spec.render, entry.el, `section "${id}"`);
    hideRepeatedTitle(entry.el, g);
    mountCards(id);
    syncGroup(g);
  }

  function mountCards(sectionID) {
    const list = cards.get(sectionID);
    if (!list || !list.size || !wrap()) return;
    const sec = sections.get(sectionID);
    const g = ensureGroup(sectionID, sec ? sec.spec.title : sectionID, sec ? orderOf(sec.spec) : (SECTION_ORDER[sectionID] || 99));
    if (!g) return;
    const sorted = Array.from(list.values()).sort((a, b) => (a.spec.order ?? 50) - (b.spec.order ?? 50));
    for (const c of sorted) {
      if (!c.el) {
        c.el = document.createElement('div');
        c.el.className = 'settings-card-slot';
        c.el.dataset.cardId = c.spec.id;
        c.el.dataset.settingsCard = sectionID;
      }
      place(bodyOf(g), c.el, Number.isFinite(c.spec.order) ? c.spec.order : 50);
      if (!c.rendered) { c.rendered = true; if (typeof c.spec.render === 'function') safeRender(c.spec.render, c.el, `card "${c.spec.id}"`); }
    }
    syncGroup(g);
  }

  function registerSection(spec) {
    if (!spec || typeof spec.id !== 'string' || !spec.id) return () => {};
    const prev = sections.get(spec.id);
    if (prev && prev.el) prev.el.remove();
    const entry = { spec, el: null };
    sections.set(spec.id, entry);
    if (registryReady) mountSection(spec.id);
    return () => {
      if (sections.get(spec.id) !== entry) return;
      sections.delete(spec.id);
      if (entry.el) entry.el.remove();
      builtIns(spec.id).forEach((n) => { if (n.dataset.replaced) { n.hidden = false; delete n.dataset.replaced; } });
      syncGroup(groupEl(spec.id));
    };
  }

  function registerCard(sectionID, spec) {
    if (!sectionID || !spec || typeof spec.id !== 'string' || !spec.id) return () => {};
    if (!cards.has(sectionID)) cards.set(sectionID, new Map());
    const list = cards.get(sectionID);
    const prev = list.get(spec.id);
    if (prev && prev.el) prev.el.remove();
    const entry = { spec, el: null, rendered: false };
    list.set(spec.id, entry);
    if (registryReady) mountCards(sectionID);
    return () => {
      if (list.get(spec.id) !== entry) return;
      list.delete(spec.id);
      if (entry.el) entry.el.remove();
      syncGroup(groupEl(sectionID));
    };
  }

  function open(sectionID, focusID) {
    try { App.showView('settings'); } catch (_) {}
    const g = groupEl(sectionID);
    const target = (g && !g.hidden) ? g : document.querySelector(`[data-card-id="${sectionID}"]`);
    if (!target) return false;
    try { target.scrollIntoView({ block: 'start', behavior: 'auto' }); } catch (_) {}
    if (focusID) {
      const f = document.getElementById(focusID);
      if (f) try { f.focus({ preventScroll: false }); } catch (_) {}
    }
    markIndex(sectionID);
    return true;
  }

  // ── sticky chip index ──

  let indexBuilt = '';
  function renderIndex() {
    const nav = $('#settings-index');
    const host = wrap();
    if (!nav || !host) return;
    const groups = Array.from(host.querySelectorAll('.settings-group')).filter((g) => !g.hidden);
    const sig = groups.map((g) => `${g.dataset.group}:${titleOf(g)}`).join('|');
    if (sig === indexBuilt) return;
    indexBuilt = sig;
    nav.textContent = '';
    for (const g of groups) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'settings-chip';
      b.dataset.target = g.dataset.group;
      b.textContent = titleOf(g);
      b.addEventListener('click', () => {
        const smooth = !document.body.classList.contains('reduce-motion') &&
          !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        try { g.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' }); } catch (_) { g.scrollIntoView(); }
        markIndex(g.dataset.group);
      });
      nav.appendChild(b);
    }
    syncIndexFromScroll();
  }

  function markIndex(id) {
    const nav = $('#settings-index');
    if (!nav) return;
    nav.querySelectorAll('.settings-chip').forEach((b) => {
      const on = b.dataset.target === id;
      b.classList.toggle('is-active', on);
      if (on) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
      if (on && nav.scrollWidth > nav.clientWidth) {
        const l = b.offsetLeft - 12;
        if (l < nav.scrollLeft || b.offsetLeft + b.offsetWidth > nav.scrollLeft + nav.clientWidth) nav.scrollLeft = Math.max(0, l);
      }
    });
  }

  let scrollRaf = 0;
  function syncIndexFromScroll() {
    const view = document.getElementById('view-settings');
    const host = wrap();
    if (!view || view.hidden || !host) return;
    const nav = $('#settings-index');
    const line = (nav ? nav.getBoundingClientRect().bottom : 120) + 24;
    const groups = Array.from(host.querySelectorAll('.settings-group')).filter((g) => !g.hidden);
    let current = groups[0];
    for (const g of groups) if (g.getBoundingClientRect().top <= line) current = g;
    // At the very bottom the last group wins even if it is short.
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) current = groups[groups.length - 1];
    if (current) markIndex(current.dataset.group);
  }

  // Called by App.showView('settings').
  function onShow() {
    renderIndex();
    requestAnimationFrame(syncIndexFromScroll);
    syncIndexFromScroll();
  }

  function initRegistry() {
    registryReady = true;
    Array.from(sections.keys()).forEach(mountSection);
    Array.from(cards.keys()).forEach((id) => { if (!sections.has(id)) mountCards(id); });
    document.querySelectorAll('#view-settings .settings-group').forEach((g) => syncGroup(g));
    renderIndex();
    window.addEventListener('scroll', () => {
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; syncIndexFromScroll(); });
    }, { passive: true });
    // The chip index sticks under the top bar, whose height changes on phones.
    const bar = document.querySelector('.topbar');
    const setBar = () => { if (bar) document.documentElement.style.setProperty('--topbar-h', `${Math.round(bar.getBoundingClientRect().height)}px`); };
    setBar();
    try { if (bar && typeof ResizeObserver !== 'undefined') new ResizeObserver(setBar).observe(bar); } catch (_) { window.addEventListener('resize', setBar); }
  }

  // ── theme (v2-themes §8.1.5) ──
  // The tokens live in css/themes.css (one rule per theme × scheme). Applying a theme
  // only sets html[data-pf-theme] / html[data-theme] and the --aurora intensity; no
  // colour is written inline. A video scene no longer forces dark (USER-HOTFIX-1 H3):
  // in Light the video is washed lighter and the glass turns light (styles.css "Light over video").

  let previewID = null;

  function effectiveScheme() {
    const s = Store.settings().colorScheme;
    if (s === 'system') {
      try { return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'; } catch (_) { return 'dark'; }
    }
    return s === 'light' ? 'light' : 'dark';
  }

  function setData(el, key, value) { if (el.dataset[key] !== value) el.dataset[key] = value; }

  function refreshCharts() {
    try {
      if (typeof Charts !== 'undefined' && Charts && typeof Charts.refresh === 'function') { Charts.refresh(); return; }
    } catch (_) { /* charts are optional */ }
    try {
      const view = document.getElementById('view-reports');
      if (view && !view.hidden && typeof Reports !== 'undefined') Reports.render();
    } catch (_) { /* reports re-render on their next show */ }
  }

  // Light over a dark scene, on the Focus page: the page borrows the dark words and controls and
  // css/glass.css turns its glass clear (html.scene-adapt), so the panels blend into the picture
  // instead of sitting on it as white slabs. html[data-scheme-pref] keeps the person's own choice.
  function adaptsToScene(scheme) {
    const root = document.documentElement;
    return scheme === 'light' && root.dataset.view === 'focus' && root.dataset.sceneTone === 'dark';
  }

  /* Free accounts can use Ember only. A previously saved premium theme stays in
     settings (never erased), but it is not applied until the plan is Pro again. */
  function themeLocked(id) {
    return !!id && id !== 'ember' && typeof Plan !== 'undefined' && !Plan.loading && !Plan.isPremium;
  }
  function effectiveThemeID(id) { return themeLocked(id) ? 'ember' : id; }

  function applyTheme() {
    const s = Store.settings();
    const root = document.documentElement;
    // v1 wrote these inline; inline values would outrank css/themes.css.
    for (const p of ['--accent', '--focus-tint', '--break-tint', '--longbreak-tint', '--mode-tint']) root.style.removeProperty(p);
    const before = `${root.dataset.pfTheme}|${root.dataset.theme}`;
    setData(root, 'pfTheme', effectiveThemeID(previewID || Store.theme().id));
    const scheme = effectiveScheme();
    const adapt = adaptsToScene(scheme);
    setData(root, 'schemePref', scheme);
    setData(root, 'theme', adapt ? 'dark' : scheme);
    root.classList.toggle('scene-adapt', adapt);
    const aurora = String(s.auroraIntensity);
    if (root.style.getPropertyValue('--aurora') !== aurora) root.style.setProperty('--aurora', aurora);
    document.body.classList.toggle('reduce-motion', !!s.reduceMotion);
    if (before !== `${root.dataset.pfTheme}|${root.dataset.theme}`) refreshCharts();
    if (renderedThemeKey !== null && renderedThemeKey !== `${s.themeID}|${root.dataset.theme}`) renderThemes();
  }

  /* Theme preview (hold-to-preview, P1): swaps only data-pf-theme; null restores. */
  function previewTheme(id) {
    if (themeLocked(id)) return;   // no free preview of a locked theme
    previewID = id && Store.THEMES.some((t) => t.id === id) ? id : null;
    applyTheme();
  }

  function initThemeWatchers() {
    // Appearance "Auto" follows the OS live.
    try {
      const mq = window.matchMedia('(prefers-color-scheme: light)');
      const onScheme = () => { if (Store.settings().colorScheme === 'system') applyTheme(); };
      if (mq.addEventListener) mq.addEventListener('change', onScheme); else if (mq.addListener) mq.addListener(onScheme);
    } catch (_) { /* no matchMedia: Auto stays dark */ }
    // When a video scene ends, the chosen scheme comes back.
    try {
      const root = document.documentElement;
      let hadVideo = root.classList.contains('has-video');
      new MutationObserver(() => {
        const has = root.classList.contains('has-video');
        if (has !== hadVideo) { hadVideo = has; applyTheme(); }
      }).observe(root, { attributes: true, attributeFilter: ['class'] });
    } catch (_) { /* scenes.js restores the scheme itself */ }
  }

  // ── theme picker (v2-themes §3.7): 88 × 72 tiles, a mini three-light aurora over the
  // theme's page in the current scheme, a 26 px ring in graphic.focus and the name. All 14
  // are open in P0 (the unlock ladder is P1). The selected tile has an accent ring + ✓. ──

  function hexToRgba(hex, alpha) {
    const h = String(hex || '').replace('#', '');
    if (!/^[0-9a-f]{6}$/i.test(h)) return `rgba(0,0,0,${alpha})`;
    const n = parseInt(h, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
  }

  function themeCatalogue() {
    try {
      if (typeof PF_THEMES !== 'undefined' && PF_THEMES && Array.isArray(PF_THEMES.themes)) {
        return PF_THEMES.themes.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
      }
    } catch (_) { /* fall back to the store's v1 list */ }
    return Store.THEMES.map((t, i) => ({ ...t, order: i + 1, auroraB: t.accent, auroraC: t.longBreak }));
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function tileRing(color) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 26 26');
    svg.setAttribute('class', 'tt-ring');
    svg.setAttribute('aria-hidden', 'true');
    const track = document.createElementNS(SVG_NS, 'circle');
    track.setAttribute('cx', '13'); track.setAttribute('cy', '13'); track.setAttribute('r', '10.5');
    track.setAttribute('fill', 'none'); track.setAttribute('stroke-width', '3'); track.setAttribute('class', 'tt-ring-track');
    const arc = document.createElementNS(SVG_NS, 'circle');
    arc.setAttribute('cx', '13'); arc.setAttribute('cy', '13'); arc.setAttribute('r', '10.5');
    arc.setAttribute('fill', 'none'); arc.setAttribute('stroke-width', '3'); arc.setAttribute('stroke-linecap', 'round');
    arc.setAttribute('stroke', color); arc.setAttribute('stroke-opacity', '0.7');
    arc.setAttribute('stroke-dasharray', '46 66'); arc.setAttribute('transform', 'rotate(-90 13 13)');
    svg.append(track, arc);
    return svg;
  }

  let renderedThemeKey = null;
  function renderThemes() {
    const grid = $('#theme-grid');
    if (!grid) return;
    const current = effectiveThemeID(Store.settings().themeID);
    const scheme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
    renderedThemeKey = `${current}|${document.documentElement.dataset.theme}`;
    const k = scheme === 'light' ? 0.55 : 1;
    const hadFocus = grid.contains(document.activeElement) ? document.activeElement.dataset.themeId : null;
    grid.textContent = '';

    for (const t of themeCatalogue()) {
      const sc = (t[scheme] || t.dark || {});
      const gain = Number.isFinite(sc.auroraGain) ? sc.auroraGain : 1;
      const on = t.id === current;
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'theme-tile' + (on ? ' is-active' : '');
      tile.dataset.themeId = t.id;
      tile.setAttribute('role', 'radio');
      tile.setAttribute('aria-checked', String(on));
      tile.tabIndex = on ? 0 : -1;
      if (t.tagline) tile.title = `${t.name} · ${t.tagline}`;
      tile.style.setProperty('--tt-page', sc.page || (scheme === 'light' ? '#F9F9F7' : '#110C0D'));
      tile.style.setProperty('--tt-a', hexToRgba(t.focus, 0.75 * gain * k));
      tile.style.setProperty('--tt-b', hexToRgba(t.auroraB || t.accent, 0.58 * gain * k));
      tile.style.setProperty('--tt-c', hexToRgba(t.auroraC || t.longBreak, 0.46 * gain * k));

      const art = document.createElement('span');
      art.className = 'tt-art';
      art.appendChild(tileRing((sc.graphic && sc.graphic.focus) || t.focus));
      const name = document.createElement('span');
      name.className = 'tt-name';
      name.textContent = t.name;
      tile.append(art, name);
      if (on) {
        const check = document.createElement('span');
        check.className = 'tt-check';
        check.setAttribute('aria-hidden', 'true');
        tile.appendChild(check);
      }
      const ready = typeof Plan !== 'undefined' && !Plan.loading;
      const premium = typeof Plan !== 'undefined' && !!Plan.isPremium;
      const locked = ready && !premium && t.id !== 'ember';
      if (locked) {
        tile.classList.add('is-locked');
        tile.setAttribute('aria-disabled', 'true');
        tile.title = `${t.name} — Focus Pro`;
        const lock = document.createElement('span');
        lock.className = 'tt-lock';
        lock.setAttribute('aria-hidden', 'true');
        lock.innerHTML = '<svg viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="2.6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8.4 10V7.6a3.6 3.6 0 0 1 7.2 0V10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
        tile.appendChild(lock);
      }
      tile.addEventListener('click', () => {
        if (locked) {
          if (typeof ProModal !== 'undefined' && ProModal.open) ProModal.open();
          else if (typeof PremiumGate !== 'undefined') PremiumGate.openPro();
          return;
        }
        chooseTheme(t.id);
      });
      grid.appendChild(tile);
    }
    if (hadFocus) {
      const f = grid.querySelector(`[data-theme-id="${hadFocus}"]`);
      if (f) f.focus();
    }
  }

  function chooseTheme(id) {
    if (themeLocked(id)) {
      if (typeof ProModal !== 'undefined' && ProModal.open) ProModal.open();
      else if (typeof PremiumGate !== 'undefined') PremiumGate.openPro();
      return;
    }
    if (Store.settings().themeID !== id) Store.setSetting('themeID', id);
    applyTheme();
    renderThemes();
    // The mode chips carry their own --mode-tint, so they repaint for the new theme.
    Timer.render();
  }

  function bindThemeGrid() {
    const grid = $('#theme-grid');
    if (!grid) return;
    // Arrow keys move the choice, as in a native radio group (grid-aware).
    grid.addEventListener('keydown', (e) => {
      const tiles = Array.from(grid.querySelectorAll('.theme-tile'));
      const i = tiles.indexOf(document.activeElement);
      if (i < 0) return;
      const cols = Math.max(1, Math.round(grid.clientWidth / (tiles[0].getBoundingClientRect().width + 10)));
      const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
      if (!step) return;
      e.preventDefault();
      const next = tiles[Math.max(0, Math.min(tiles.length - 1, i + step))];
      const id = next.dataset.themeId;
      chooseTheme(id);
      const tile = grid.querySelector(`[data-theme-id="${id}"]`);     // the grid was rebuilt
      if (tile) tile.focus();
    });
  }

  // ── Look: the current scene preview + "Change scene…" (the shared picker; no grid here) ──

  let sceneCatalogue = null;
  function safePoster(u) {
    try { const url = new URL(u); return url.protocol === 'https:' && url.hostname === 'assets.mixkit.co' ? url.href : null; } catch (_) { return null; }
  }
  function loadSceneCatalogue() {
    if (sceneCatalogue) return Promise.resolve(sceneCatalogue);
    return fetch('assets/scenes/scenes.json', { cache: 'force-cache' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { sceneCatalogue = d && Array.isArray(d.scenes) ? d.scenes : []; return sceneCatalogue; })
      .catch(() => { sceneCatalogue = []; return sceneCatalogue; });
  }

  function renderScenePreview(detail) {
    const art = $('#look-scene-art');
    const title = $('#look-scene-title');
    const label = document.querySelector('#look-scene .scene-preview-label');
    if (!art || !title) return;
    if (label) label.textContent = 'Background';
    let id = detail && typeof detail.sceneId === 'string' ? detail.sceneId : null;
    if (id === null) { try { id = Scenes.current() || ''; } catch (_) { id = ''; } }
    if (!id || id === 'none' || id === 'aurora') {
      art.textContent = '';
      art.classList.add('is-aurora');
      title.textContent = 'Aurora';
      if (label) label.textContent = 'Background · drawn in your theme colours';
      return;
    }
    art.classList.remove('is-aurora');
    title.textContent = (detail && detail.title) || id;
    loadSceneCatalogue().then((list) => {
      const sc = list.find((x) => x && x.id === id);
      if (!sc) return;
      title.textContent = sc.title;
      if (label && sc.mood) label.textContent = `Background · ${sc.mood}`;
      const src = safePoster(sc.posterSmall || sc.poster);
      art.textContent = '';
      if (src) {
        const img = document.createElement('img');
        img.alt = '';
        img.decoding = 'async';
        img.loading = 'lazy';
        img.src = src;
        art.appendChild(img);
      }
    });
  }

  // ── sounds ──

  function renderAlarms() {
    const grid = $('#alarm-grid');
    grid.textContent = '';
    const current = Store.settings().selectedAlarm;

    for (const a of Store.ALARMS) {
      const chip = document.createElement('button');
      chip.className = 'sound-chip';
      chip.type = 'button';
      if (a.id === current) chip.classList.add('is-active');
      chip.setAttribute('aria-pressed', String(a.id === current));

      const dot = document.createElement('span');
      dot.className = 'sc-dot';
      const label = document.createElement('span');
      label.textContent = a.name;

      chip.append(dot, label);
      chip.addEventListener('click', () => {
        Store.setSetting('selectedAlarm', a.id);
        Audio.previewAlarm(a.id);
        renderAlarms();
      });

      grid.appendChild(chip);
    }
  }

  function renderAmbiences() {
    const grid = $('#ambience-grid');
    grid.textContent = '';
    const current = Store.settings().selectedAmbience;

    for (const a of Store.AMBIENCES) {
      const chip = document.createElement('button');
      chip.className = 'sound-chip';
      chip.type = 'button';
      if (a.id === current) chip.classList.add('is-active');
      chip.setAttribute('aria-pressed', String(a.id === current));

      const dot = document.createElement('span');
      dot.className = 'sc-dot';
      const label = document.createElement('span');
      label.textContent = a.name;

      chip.append(dot, label);
      chip.addEventListener('click', () => {
        Store.setSetting('selectedAmbience', a.id);
        if (a.id === 'none') Audio.stopAmbience();
        else if (Timer.isRunning() && Timer.mode() === 'focus') Audio.startAmbience();
        renderAmbiences();
      });

      grid.appendChild(chip);
    }
  }

  // ── music ──

  let musicQuery = '';
  let shuffleOn = false;

  function renderGenres() {
    const list = $('#genre-list');
    list.textContent = '';
    const genres = Audio.genres();
    const current = Store.settings().selectedMusic;
    const q = musicQuery.trim().toLowerCase();

    if (!genres.length) {
      const p = document.createElement('p');
      p.className = 'muted-note';
      p.textContent = 'The music library could not be loaded.';
      list.appendChild(p);
      return;
    }

    let visible = 0;
    for (const g of genres) {
      const matching = q
        ? g.tracks.filter((t) => t.title.toLowerCase().includes(q) || (t.artist || '').toLowerCase().includes(q))
        : g.tracks;
      if (!matching.length) continue;
      visible += matching.length;

      const block = document.createElement('div');
      block.className = 'genre-block';
      /* Keep a genre open while searching so matches are visible at a glance. */
      if (q) block.classList.add('is-open');

      const head = document.createElement('button');
      head.className = 'genre-head';
      head.type = 'button';
      head.setAttribute('aria-expanded', 'false');

      const chevron = document.createElement('span');
      chevron.className = 'genre-chevron';
      chevron.textContent = '›';

      const name = document.createElement('span');
      name.textContent = g.title;

      if (current === g.name) {
        const dot = document.createElement('span');
        dot.className = 'genre-active-dot';
        dot.title = 'Looping this genre';
        name.appendChild(dot);
      }

      const count = document.createElement('span');
      count.className = 'genre-count';
      count.textContent = `${matching.length}`;

      head.append(chevron, name, count);

      const tracks = document.createElement('div');
      tracks.className = 'genre-tracks';

      for (const t of matching) {
        const row = document.createElement('button');
        row.className = 'track-row';
        row.type = 'button';

        const cur = Audio.currentTrack();
        const playing = cur && cur.id === t.id && Audio.isMusicPlaying();
        if (cur && cur.id === t.id) row.classList.add('is-active');

        if (playing) {
          const eq = document.createElement('span');
          eq.className = 'track-eq';
          eq.innerHTML = '<span></span><span></span><span></span>';
          row.appendChild(eq);
        }

        const trackName = document.createElement('span');
        trackName.className = 'track-name';
        trackName.textContent = t.title;

        const artist = document.createElement('span');
        artist.className = 'track-artist';
        artist.textContent = t.duration ? `${t.artist} · ${fmtDuration(t.duration)}` : t.artist;

        row.append(trackName, artist);

        row.addEventListener('click', () => {
          // Choosing a track also picks its genre, so the session log
          // records the genre just like the app does.
          Store.setSetting('selectedMusic', g.name);
          if (Timer.isRunning() && Timer.mode() === 'focus') Audio.playMusic(t.id);
          else Audio.previewMusic(t.id);
          renderGenres();
          renderNowPlayingBar();
        });

        tracks.appendChild(row);
      }

      head.addEventListener('click', () => {
        const open = !block.classList.contains('is-open');
        block.classList.toggle('is-open', open);
        head.setAttribute('aria-expanded', String(open));
      });

      block.append(head, tracks);
      list.appendChild(block);
    }

    if (!visible) {
      const p = document.createElement('p');
      p.className = 'muted-note';
      p.textContent = `No tracks match “${musicQuery.trim()}”.`;
      list.appendChild(p);
    }

    const countEl = $('#music-count');
    if (countEl) {
      const total = Audio.tracks().length;
      countEl.textContent = q ? `${visible} of ${total} tracks` : `${total} tracks · ${genres.length} genres`;
    }

    // The genre chips themselves choose the looping genre.
    const chips = $('#genre-chips');
    if (chips) {
      chips.textContent = '';

      const off = document.createElement('button');
      off.className = 'sound-chip';
      off.type = 'button';
      if (!current) off.classList.add('is-active');
      off.setAttribute('aria-pressed', String(!current));
      const offDot = document.createElement('span');
      offDot.className = 'sc-dot';
      const offLabel = document.createElement('span');
      offLabel.textContent = 'Off';
      off.append(offDot, offLabel);
      off.addEventListener('click', () => {
        Store.setSetting('selectedMusic', '');
        Audio.stopMusic();
        renderGenres();
        renderNowPlayingBar();
      });
      chips.appendChild(off);

      for (const g of genres) {
        const chip = document.createElement('button');
        chip.className = 'sound-chip';
        chip.type = 'button';
        if (current === g.name) chip.classList.add('is-active');
        chip.setAttribute('aria-pressed', String(current === g.name));

        const dot = document.createElement('span');
        dot.className = 'sc-dot';
        const label = document.createElement('span');
        label.textContent = g.title;
        chip.append(dot, label);

        chip.addEventListener('click', () => {
          Store.setSetting('selectedMusic', g.name);
          const first = shuffleOn ? pickShuffled(g.tracks).id : g.tracks[0].id;
          if (Timer.isRunning() && Timer.mode() === 'focus') Audio.playMusic(first);
          else Audio.previewMusic(first);
          renderGenres();
          renderNowPlayingBar();
        });

        chips.appendChild(chip);
      }
    }
  }

  function pickShuffled(tracks) {
    if (!tracks.length) return null;
    return tracks[Math.floor(Math.random() * tracks.length)];
  }

  function fmtDuration(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function renderNowPlayingBar() {
    const track = Audio.currentTrack();
    const bar = $('#now-playing');
    if (!track) { bar.hidden = true; document.body.classList.remove('music-playing'); }
    else {
      bar.hidden = false;
      $('#np-title').textContent = track.title;
      $('#np-meta').textContent = track.artist ? `${track.artist} · ${track.genre}` : track.genre;
      Timer.renderNowPlayingProgress();
    }
    renderMiniPlayer();
  }

  /* Settings v an inline player mirroring the Focus-view now-playing bar. */
  function renderMiniPlayer() {
    const track = Audio.currentTrack();
    const titleEl = $('#mp-title');
    if (!titleEl) return;
    const playing = Audio.isMusicPlaying();

    if (!track) {
      $('#mp-title').textContent = 'Nothing playing';
      $('#mp-meta').textContent = 'Choose a genre or track below';
      $('#mp-play').textContent = 'Play';
      document.querySelector('.mini-player').classList.remove('is-playing');
      return;
    }

    $('#mp-title').textContent = track.title;
    $('#mp-meta').textContent = track.artist ? `${track.artist} · ${track.genre}` : track.genre;
    $('#mp-play').textContent = playing ? 'Pause' : 'Play';
    document.querySelector('.mini-player').classList.toggle('is-playing', playing);
  }

  function renderMiniPlayerProgress() {
    const fill = $('#mp-fill');
    if (!fill || !Audio.currentTrack()) return;
    const elapsed = Audio.musicElapsed();
    const duration = Audio.musicDuration();
    const pct = duration > 0 ? Math.min(1, elapsed / duration) * 100 : 0;
    fill.style.width = `${pct}%`;
    $('#mp-elapsed').textContent = fmtDuration(elapsed);
    $('#mp-duration').textContent = fmtDuration(duration);
  }

  // ── rewards preferences ──

  const CHOICES = {
    engagementMode: {
      values: ['full', 'calm', 'off'],
      hint: {
        full: 'XP, levels, quests and streaks on the Focus page and in Reports › Journey.',
        calm: 'Just your streak and daily goal. No XP, levels or quests.',
        off: 'No rewards anywhere. Your focus history is still kept.',
      },
      hintId: 'hint-engagement',
    },
    colorScheme: {
      values: ['light', 'dark', 'system'],
      hint: {
        light: 'Bright and airy. Over a video background, panels turn to light frosted glass.',
        dark: 'Easy on the eyes at night. Also in the account menu (top right).',
        system: 'Follows your computer’s Light or Dark setting.',
      },
      hintId: 'hint-scheme',
      after: () => { applyTheme(); renderThemes(); Timer.render(); },
    },
    celebrations: {
      values: ['full', 'subtle', 'off'],
      hint: {
        full: 'Confetti, XP chips and level-up moments when you earn them.',
        subtle: 'A quiet toast instead of confetti and full-screen moments.',
        off: 'No pop-ups. Progress still updates in the background.',
      },
      hintId: 'hint-celebrations',
    },
  };

  function choiceValue(key) {
    const def = CHOICES[key];
    const v = Store.settings()[key];
    return def.values.includes(v) ? v : def.values[0];
  }

  function syncChoice(group) {
    const key = group.dataset.setting;
    const def = CHOICES[key];
    if (!def) return;
    const value = choiceValue(key);
    group.querySelectorAll('.seg-btn').forEach((b) => {
      const on = b.dataset.value === value;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    const hint = def.hintId ? $(`#${def.hintId}`) : null;
    if (hint) hint.textContent = def.hint[value] || '';
    // Calm and Off have no XP moments to style, so the celebration choice
    // only matters in Full; dim it rather than hide it.
    if (key === 'celebrations') {
      const row = group.closest('.pref-row');
      if (row) row.classList.toggle('is-muted', choiceValue('engagementMode') === 'off');
    }
  }

  function syncChoices() {
    document.querySelectorAll('.segmented[data-setting]').forEach(syncChoice);
  }

  function bindChoices() {
    document.querySelectorAll('.segmented[data-setting]').forEach((group) => {
      const key = group.dataset.setting;
      const def = CHOICES[key];
      if (!def) return;
      const choose = (value) => {
        if (!def.values.includes(value) || value === choiceValue(key)) return;
        Store.setSetting(key, value);
        syncChoices();
        if (def.after) { def.after(value); return; }
        if (typeof Rewards !== 'undefined' && Rewards && typeof Rewards.refresh === 'function') {
          try { Rewards.refresh({ force: true }); } catch (_) { /* rewards UI is optional */ }
        }
      };
      group.addEventListener('click', (e) => {
        const btn = e.target.closest('.seg-btn');
        if (btn && group.contains(btn)) choose(btn.dataset.value);
      });
      // Arrow keys move the choice, as in a native radio group.
      group.addEventListener('keydown', (e) => {
        const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1
          : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        const i = def.values.indexOf(choiceValue(key));
        const next = def.values[(i + step + def.values.length) % def.values.length];
        choose(next);
        const btn = group.querySelector(`.seg-btn[data-value="${next}"]`);
        if (btn) btn.focus();
      });
    });
  }

  // ── controls ──

  // `scale` converts the slider's value into the stored one: volumes and the
  // aurora intensity are stored as 0–1 (Audio and applyTheme read them that
  // way) but shown as 0–100 %.
  function bindRange(id, key, labelId, format, onChange, scale = 1) {
    const input = $(`#${id}`);
    const label = $(`#${labelId}`);
    if (!input) return;

    const apply = () => {
      const value = Number(input.value);
      Store.setSetting(key, value * scale);
      if (label) label.textContent = format(value);
      if (onChange) onChange(value);
    };

    input.addEventListener('input', apply);
    return apply;
  }

  function syncControls() {
    const s = Store.settings();

    const set = (id, value) => { const n = $(`#${id}`); if (n) n.value = String(value); };
    const check = (id, value) => { const n = $(`#${id}`); if (n) n.checked = !!value; };
    const label = (id, text) => { const n = $(`#${id}`); if (n) n.textContent = text; };

    set('s-focus', s.focusMinutes);
    label('v-focus', `${s.focusMinutes} min`);
    set('s-short', s.shortBreakMinutes);
    label('v-short', `${s.shortBreakMinutes} min`);
    set('s-long', s.longBreakMinutes);
    label('v-long', `${s.longBreakMinutes} min`);
    set('s-interval', s.longBreakInterval);
    label('v-interval', String(s.longBreakInterval));
    set('s-goal', s.dailyGoalMinutes);
    label('v-goal', `${s.dailyGoalMinutes} min`);

    set('s-alarmvol', Math.round(s.alarmVolume * 100));
    label('v-alarmvol', `${Math.round(s.alarmVolume * 100)}%`);
    set('s-ambvol', Math.round(s.ambienceVolume * 100));
    label('v-ambvol', `${Math.round(s.ambienceVolume * 100)}%`);
    set('s-musicvol', Math.round(s.musicVolume * 100));
    label('v-musicvol', `${Math.round(s.musicVolume * 100)}%`);

    set('s-aurora', Math.round(s.auroraIntensity * 100));
    label('v-aurora', `${Math.round(s.auroraIntensity * 100)}%`);

    check('s-autobreak', s.autoStartBreaks);
    check('s-autofocus', s.autoStartFocus);
    check('s-ticking', s.tickingEnabled);
    check('s-switchsound', s.switchToBreakSound);
    check('s-reduce', s.reduceMotion);
    check('s-showdone', s.showCompletedTasks);
    check('s-celebsounds', s.celebrationSounds !== false);

    syncChoices();
    applyTheme();   // a synced or imported theme/scheme change paints at once
  }

  // ── CSV (js/csv.js: the 27-column v2 format, merge-by-id import) ──

  function exportCSV() { return Csv.export(); }

  function downloadCSV() {
    Csv.download();
    App.toast('CSV exported');
  }

  function importCSVFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const r = Csv.importText(String(reader.result));
        if (!r.tasks && !r.sessions && !r.ratings) {
          App.toast('That file had no new Pure Focus records in it');
          return;
        }
        const parts = [[r.tasks, 'task'], [r.sessions, 'session'], [r.ratings, 'rating']].filter(([n]) => n).map(([n, w]) => `${n} ${w}${n === 1 ? '' : 's'}`);
        App.toast(`Imported ${parts.join(', ')}`);
      } catch (err) {
        App.toast('Could not read that CSV file');
      }
    };
    reader.readAsText(file);
  }

  // ── init ──

  function init() {
    applyTheme();
    initThemeWatchers();

    bindRange('s-focus', 'focusMinutes', 'v-focus', (v) => `${v} min`, () => Timer.syncDuration());
    bindRange('s-short', 'shortBreakMinutes', 'v-short', (v) => `${v} min`, () => Timer.syncDuration());
    bindRange('s-long', 'longBreakMinutes', 'v-long', (v) => `${v} min`, () => Timer.syncDuration());
    bindRange('s-interval', 'longBreakInterval', 'v-interval', (v) => String(v));
    bindRange('s-goal', 'dailyGoalMinutes', 'v-goal', (v) => `${v} min`);
    bindRange('s-alarmvol', 'alarmVolume', 'v-alarmvol', (v) => `${v}%`, null, 0.01);
    bindRange('s-ambvol', 'ambienceVolume', 'v-ambvol', (v) => `${v}%`, (v) => Audio.setAmbienceVolume(v / 100), 0.01);
    bindRange('s-musicvol', 'musicVolume', 'v-musicvol', (v) => `${v}%`, (v) => Audio.setMusicVolume(v / 100), 0.01);
    bindRange('s-aurora', 'auroraIntensity', 'v-aurora', (v) => `${v}%`, () => applyTheme(), 0.01);

    const toggle = (id, key, after) => {
      const el = $(`#${id}`);
      if (!el) return;
      el.addEventListener('change', () => {
        Store.setSetting(key, el.checked);
        if (after) after(el.checked);
      });
    };

    toggle('s-autobreak', 'autoStartBreaks');
    toggle('s-autofocus', 'autoStartFocus');
    toggle('s-ticking', 'tickingEnabled', () => {
      if (Timer.isRunning() && Timer.mode() === 'focus') Audio.startTicking();
      else Audio.stopTicking();
    });
    toggle('s-switchsound', 'switchToBreakSound');
    toggle('s-reduce', 'reduceMotion', () => applyTheme());
    toggle('s-showdone', 'showCompletedTasks', () => Tasks.render());
    toggle('s-celebsounds', 'celebrationSounds');

    bindChoices();

    // Data actions
    $('#export-csv').addEventListener('click', downloadCSV);
    $('#export-csv-2').addEventListener('click', downloadCSV);

    const fileInput = $('#import-file');
    $('#import-csv').addEventListener('click', () => fileInput.click());
    $('#import-csv-2').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files[0]) importCSVFile(fileInput.files[0]);
      fileInput.value = '';
    });

    // Import .ics goes through the calendar feeds module (W2: Feeds.importFiles).
    const icsInput = $('#import-ics-file');
    const icsBtn = $('#import-ics-2');
    if (icsBtn && icsInput) {
      icsBtn.addEventListener('click', () => icsInput.click());
      icsInput.addEventListener('change', async () => {
        const files = icsInput.files ? Array.from(icsInput.files) : [];
        icsInput.value = '';
        if (!files.length) return;
        try {
          const r = (typeof Feeds !== 'undefined' && Feeds && typeof Feeds.importFiles === 'function') ? await Feeds.importFiles(files) : null;
          const n = r && Number(r.events) ? Number(r.events) : 0;
          if (n) App.toast(`Imported ${n} event${n === 1 ? '' : 's'}`);
          else if (!r || !(r.feeds || r.assignments)) App.toast('No events found in that file');
        } catch (_) {
          App.toast('Couldn’t read that file — is it an .ics calendar?');
        }
      });
    }

    // Reset all data… asks once, inline (no browser dialog).
    const resetBtn = $('#reset-data');
    const confirmRow = $('#reset-confirm');
    const closeConfirm = () => { if (confirmRow) confirmRow.hidden = true; if (resetBtn) resetBtn.setAttribute('aria-expanded', 'false'); };
    resetBtn.addEventListener('click', () => {
      if (!confirmRow) return;
      const open = confirmRow.hidden;
      confirmRow.hidden = !open;
      resetBtn.setAttribute('aria-expanded', String(open));
      if (open) { const c = $('#reset-cancel'); if (c) c.focus(); }
    });
    if ($('#reset-cancel')) $('#reset-cancel').addEventListener('click', () => { closeConfirm(); resetBtn.focus(); });
    if ($('#reset-go')) $('#reset-go').addEventListener('click', () => {
      closeConfirm();
      Store.resetAll();
      syncControls();
      renderThemes();
      renderAlarms();
      renderAmbiences();
      applyTheme();
      Timer.reset();
      App.toast('All data cleared');
    });

    // Look: the scene preview follows the picker.
    const change = $('#look-scene-change');
    if (change) change.addEventListener('click', () => {
      try { (Scenes.openPicker || Scenes.open)(change); } catch (_) { /* scenes are optional */ }
    });
    document.addEventListener('scenes:change', (e) => renderScenePreview(e.detail || null));
    renderScenePreview(null);
    bindThemeGrid();

    // Music transport
    $('#np-prev').addEventListener('click', () => { Audio.previousMusic(); });
    $('#np-next').addEventListener('click', () => { Audio.nextMusic(); });
    $('#np-play').addEventListener('click', () => { Audio.toggleMusic(); });
    initSeek();
    initMusicTools();

    syncControls();
    renderThemes();
    if (typeof Plan !== 'undefined' && Plan.onChange) Plan.onChange(() => { applyTheme(); renderThemes(); });
    renderAlarms();
    renderAmbiences();
    initRegistry();
  }

  /* The library's search box, shuffle toggle and the settings mini-player. */
  function initMusicTools() {
    const search = $('#music-search');
    if (search) {
      search.addEventListener('input', () => {
        musicQuery = search.value || '';
        renderGenres();
      });
    }

    const shuffle = $('#music-shuffle');
    if (shuffle) {
      shuffle.addEventListener('click', () => {
        shuffleOn = !shuffleOn;
        shuffle.setAttribute('aria-pressed', String(shuffleOn));
        shuffle.classList.toggle('is-active', shuffleOn);
        const g = Audio.genres().find((x) => x.name === Store.settings().selectedMusic);
        if (g) {
          const t = shuffleOn ? pickShuffled(g.tracks) : g.tracks[0];
          if (Timer.isRunning() && Timer.mode() === 'focus') Audio.playMusic(t.id);
          else Audio.previewMusic(t.id);
          renderGenres();
          renderNowPlayingBar();
        }
      });
    }

    const prev = $('#mp-prev');
    const next = $('#mp-next');
    const play = $('#mp-play');
    if (prev) prev.addEventListener('click', () => Audio.previousMusic());
    if (next) next.addEventListener('click', () => Audio.nextMusic());
    if (play) {
      play.addEventListener('click', () => {
        if (!Audio.currentTrack()) {
          const g = Store.settings().selectedMusic;
          if (g) Audio.playMusic(null);
        } else {
          Audio.toggleMusic();
        }
      });
    }
  }

  /* The seek bar supports both pointer dragging and keyboard nudges, and
     previews its position live while dragging without committing a seek on
     every pixel — the real seek happens on pointer-up. */
  function initSeek() {
    const seek = $('#np-seek');
    if (!seek) return;

    let dragging = false;
    let previewPct = 0;

    const pctFromEvent = (e) => {
      const r = seek.getBoundingClientRect();
      if (!r.width) return 0;
      return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    };

    const paint = (pct) => {
      const p = pct * 100;
      $('#np-seek-fill').style.width = `${p}%`;
      $('#np-seek-thumb').style.left = `${p}%`;
    };

    const commit = (pct) => {
      const d = Audio.musicDuration();
      if (d > 0) Audio.seekMusic(pct * d);
      Timer.renderNowPlayingProgress();
    };

    seek.addEventListener('pointerdown', (e) => {
      if (!Audio.currentTrack()) return;
      dragging = true;
      seek.classList.add('is-dragging');
      seek.setPointerCapture(e.pointerId);
      previewPct = pctFromEvent(e);
      paint(previewPct);
    });

    seek.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      previewPct = pctFromEvent(e);
      paint(previewPct);
    });

    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      seek.classList.remove('is-dragging');
      try { seek.releasePointerCapture(e.pointerId); } catch (_) {}
      commit(previewPct);
    };
    seek.addEventListener('pointerup', end);
    seek.addEventListener('pointercancel', end);

    seek.addEventListener('keydown', (e) => {
      if (!Audio.currentTrack()) return;
      const step = e.shiftKey ? 30 : 5;
      if (e.key === 'ArrowRight') { e.preventDefault(); commit(Audio.musicProgress() + step / Math.max(1, Audio.musicDuration())); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); commit(Audio.musicProgress() - step / Math.max(1, Audio.musicDuration())); }
    });
  }

  function renderMusic() { renderGenres(); }

  return { init, applyTheme, previewTheme, effectiveScheme, renderThemes, renderAlarms, renderAmbiences, renderGenres, renderNowPlayingBar, renderMiniPlayer, renderMiniPlayerProgress, syncControls, exportCSV,
    registerSection, registerCard, open, onShow };
})();
