/* ═══════════════════════════════════════════════════════════════════════
   audio.js — sound engine v2 (owner: W5; v2-sound §4.4, §5)

   Graph (one lazily created AudioContext, resumed inside user gestures):
     deckA/deckB <audio> → MediaElementSource → norm (track dB + genre trim)
                         → fade (transport / crossfade) ─┐
                                                        musicSum ─┬→ analyser (visualiser, before volume)
                                                                  └→ musicVol (v²) → musicDuck ─┐
     ambience bed: AudioBufferSource segments → seg gain → bed norm (dB)
                   → bed fade → ambVol (v²) → ambDuck ─────────────────────────┤
     one-shots (alarm, fx, tick, nudge): AudioBuffer → shot gain (dB × vol) ──┤
     previews: <audio> → MediaElementSource → preview gain ───────────────────┤
                                                    master (mute 0|1) ← sum ──┘
     master → limiter (−1 dBFS, ratio 20) → ceiling (0.891) → destination

   Rules (PFSound = js/soundcore.js, the verbatim reference): equal-power crossfades
   planned by PFSound.crossfadePlan (Classical / Crossfade Off: gapless with a 40 ms
   micro-fade), transport fades PFSound.FADES (2.4 s start swell, 1.2 s pause/stop,
   0.8 s resume, 0.6 s skip), ducking PFSound.duckGainAt, stations PFSound.nextTrack,
   the session genre PFSound.dominantGenre. No hard cuts; music never autoplays on load
   (a start without a user gesture waits for the first one).

   Public API (v2-sound §5.7; v1 names keep their meaning):
     loadCatalogue tracks genres trackById tracksOfGenre playAlarm previewAlarm startTicking
     stopTicking startAmbience pauseAmbience stopAmbience previewAmbience playMusic pauseMusic
     stopMusic toggleMusic nextMusic previousMusic previewMusic seekMusic musicElapsed
     musicDuration musicProgress currentTrack isMusicPlaying setMusicVolume setAmbienceVolume
     setEnabled isEnabled
     unlock stations source setSource upNext like isLiked level duck sessionMusicGenre credits playShot
     extras: genreInfo(id) sourceInfo(s) clearHistory() stopPreview() isLoading() catalogueVersion()
   Store bus events: 'music' {track, playing, source} · 'music:progress' {elapsed, duration, progress}
     (4 Hz while visible) · 'music:upnext' {track} · 'music:transition' {from, to, overlap} ·
     'music:preview' {track, playing}
   Debug: ?debugAudio=1 logs every transition (plan vs actual start) and the lowest
   music-bus RMS run during each crossfade (acceptance A5).
   ═══════════════════════════════════════════════════════════════════════ */

const Audio = (() => {
  'use strict';

  const SOUND_DIR = 'assets/sounds/';
  const MUSIC_DIR = 'assets/music/';
  const PLAYER_KEY = 'purefocus.player.v2';
  const FADES = PFSound.FADES;
  const GAPLESS_FADE = 0.04;        // web micro-fade for gapless (Classical / Crossfade Off)
  const PRELOAD_LEAD = 20;          // s before the crossfade the next deck loads
  const SAVE_EVERY_MS = 15000;
  const IDLE_SUSPEND_MS = 30000;    // suspend the AudioContext after 30 s of silence (energy)
  const DEBUG = (() => { try { return /[?&]debugAudio=1/.test(location.search); } catch (_) { return false; } })();

  // Measured fallbacks (v2-sound §3.3, §3.6) for when music.json isn't there yet.
  const DEFAULT_GENRES = [
    { id: 'Lofi', title: 'Lo-Fi Beats', crossfadeSec: 3, trimDb: -1.0, art: ['#F28C6B', '#7A4DD8'], symbol: 'headphones' },
    { id: 'Chill', title: 'Chillhop', crossfadeSec: 3, trimDb: -1.0, art: ['#2EC4B6', '#3A6EA5'], symbol: 'cup.and.saucer.fill' },
    { id: 'Jazz', title: 'Jazz Café', crossfadeSec: 3, trimDb: -1.5, art: ['#E0A458', '#6B2D5C'], symbol: 'music.quarternote.3' },
    { id: 'Piano', title: 'Piano', crossfadeSec: 2, trimDb: 0, art: ['#CBD5E1', '#475569'], symbol: 'pianokeys' },
    { id: 'Classical', title: 'Classical', crossfadeSec: 0, trimDb: 0, art: ['#E9D8A6', '#9B2226'], symbol: 'music.note' },
    { id: 'Ambient', title: 'Ambient', crossfadeSec: 4, trimDb: 0, art: ['#6D5DFC', '#0EA5E9'], symbol: 'sparkles' },
    { id: 'Nature', title: 'Nature & Acoustic', crossfadeSec: 3.5, trimDb: -0.5, art: ['#84CC16', '#0F766E'], symbol: 'leaf.fill' },
    { id: 'Synthwave', title: 'Synthwave', crossfadeSec: 2.5, trimDb: -2.0, art: ['#FF4D9D', '#4C1D95'], symbol: 'sun.horizon.fill' },
    { id: 'Deep', title: 'Deep Focus', crossfadeSec: 6, trimDb: 1.0, art: ['#1E3A8A', '#020617'], symbol: 'water.waves' },
  ];
  const AMB_GAIN_DB = { rain: -10.4, brown: -7.3, ocean: -4.3, forest: -6.9, cafe: -1.4, white: -15.3 };
  const ALARM_GAIN_DB = { bell: 0.0, bowl: 2.6, chime: -1.4, digital: 1.4, marimba: -0.9, soft: 4.7 };

  let enabled = true;

  const lc = (s) => String(s == null ? '' : s).toLowerCase();
  const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));
  const settings = () => { try { return Store.settings(); } catch (_) { return {}; } };
  const emit = (evt, payload) => { try { Store.emit(evt, payload); } catch (err) { console.error('audio: listener failed', err); } };
  const dlog = (...a) => { if (DEBUG) try { console.info('[audio]', ...a); } catch (_) {} };
  function todayKey(d) {
    const x = d || new Date();
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  }
  function timerFocusRunning() {
    try { return Timer.isRunning() && Timer.mode() === 'focus'; } catch (_) { return false; }
  }

  // ── music catalogue ──
  /* v2 (v2-sound §3.2): assets/music/music.json is the catalogue. Until the
     one-time import has run, fall back to the v1 attribution.json so the
     player keeps working. File paths are percent-encoded per segment. */
  let catalogue = [];
  let allTracks = [];
  let catalogueMeta = { genres: [], stations: [], ambience: [], alarms: [], version: 0 };
  let loading = false;
  let loaded = false;

  function encodePath(p) { return String(p || '').split('/').map(encodeURIComponent).join('/'); }

  async function fetchJSON(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function loadCatalogue() {
    loading = true;
    wireOnce();
    try {
      const doc = await fetchJSON(`${MUSIC_DIR}music.json`);
      if (!doc || !Array.isArray(doc.tracks)) throw new Error('bad music.json');
      catalogueMeta = {
        version: doc.version || 2,
        genres: Array.isArray(doc.genres) ? doc.genres : [],
        stations: Array.isArray(doc.stations) ? doc.stations : [],
        ambience: Array.isArray(doc.ambience) ? doc.ambience : [],
        alarms: Array.isArray(doc.alarms) ? doc.alarms : [],
      };
      catalogue = doc.tracks.filter((t) => t && t.id && t.file && t.genre).map((t) => Object.assign({}, t, {
        duration: Number(t.durationSec) || 0,
        src: `${MUSIC_DIR}${encodePath(t.file)}`,
      }));
      allTracks = catalogue.slice();
      afterCatalogue();
      return catalogue;
    } catch (_) { /* fall through to v1 */ }
    try {
      const list = await fetchJSON(`${MUSIC_DIR}attribution.json`);
      catalogueMeta = { genres: [], stations: [], ambience: [], alarms: [], version: 1 };
      catalogue = list.map((t) => ({
        id: t.id,
        genre: t.genre,
        title: t.title,
        artist: t.artist,
        file: t.file,
        duration: t.duration,
        durationSec: t.duration,
        src: `${MUSIC_DIR}${encodeURIComponent(t.genre)}/${encodeURIComponent(t.file)}`,
      }));
      allTracks = catalogue.slice();
    } catch (_) {
      catalogue = [];
    }
    afterCatalogue();
    return catalogue;
  }

  /* The free tier has its own copies under assets/music/free/ so the paid
     library is never requested on a free plan. Keep ids in sync with music.json. */
  const FREE_DIR = 'assets/music/free/';
  const FREE_TRACKS = [
    'hz-tranquil-mindscape', // Lofi
    'km-bossa-antigua',     // Jazz
    'km-deliberate-thought', // Ambient
    'km-dreamer',          // Piano
    'hz-kodama',           // Nature
    'kb-sound-poem',       // Jazz
  ];
  const FREE_FILES = {
    'hz-tranquil-mindscape': 'hz-tranquil-mindscape.m4a',
    'km-bossa-antigua': 'km-bossa-antigua.m4a',
    'km-deliberate-thought': 'km-deliberate-thought.m4a',
    'km-dreamer': 'km-dreamer.m4a',
    'hz-kodama': 'hz-kodama.m4a',
    'kb-sound-poem': 'kb-sound-poem.m4a',
  };

  function freeTrack(t) {
    const file = FREE_FILES[t.id];
    return file ? Object.assign({}, t, { src: `${FREE_DIR}${encodePath(file)}` }) : t;
  }

  function applyPlanFilter() {
    if (!allTracks.length) { catalogue = []; return; }
    const locked = typeof Plan !== 'undefined' && !Plan.loading && !Plan.isPremium;
    catalogue = locked
      ? allTracks.filter((t) => FREE_TRACKS.includes(t.id)).map(freeTrack)
      : allTracks.slice();
  }

  function afterCatalogue() {
    loading = false;
    loaded = true;
    applyPlanFilter();
    if (M.track) M.track = trackById(M.track.id) || M.track;
    // A focus run restored before the catalogue arrived gets its music now.
    if (M.pendingResume) {
      const pr = M.pendingResume;
      M.pendingResume = null;
      if (!catalogue.length) setStatus('error', 'The music library couldn’t load.');
      else if (pr.play || timerFocusRunning()) playMusic(pr.trackId || null);
    }
    emit('music', musicPayload());
  }

  function tracks() { return catalogue; }

  function genreInfo(id) {
    return catalogueMeta.genres.find((g) => g.id === id) || DEFAULT_GENRES.find((g) => g.id === id) ||
      { id, title: id, crossfadeSec: 3, trimDb: 0, art: ['#6b7280', '#1f2937'], symbol: 'music.note' };
  }

  function genres() {
    const map = new Map();
    for (const t of catalogue) {
      if (!map.has(t.genre)) map.set(t.genre, []);
      map.get(t.genre).push(t);
    }
    const order = (catalogueMeta.genres.length ? catalogueMeta.genres : DEFAULT_GENRES).map((g) => g.id);
    const rank = (n) => { const i = order.indexOf(n); return i < 0 ? 99 : i; };
    return [...map.entries()]
      .sort((a, b) => rank(a[0]) - rank(b[0]))
      .map(([name, list]) => {
        const g = genreInfo(name);
        return { name, title: g.title, art: g.art, symbol: g.symbol, crossfadeSec: g.crossfadeSec, tracks: list };
      });
  }

  function trackById(id) {
    if (id == null) return null;
    const k = lc(id);
    return catalogue.find((t) => lc(t.id) === k) || null;
  }

  function tracksOfGenre(genre) { return catalogue.filter((t) => t.genre === genre); }

  function stations() {
    return catalogueMeta.stations.map((s) => ({
      id: s.id, title: s.title, subtitle: s.subtitle || '',
      count: PFSound.stationPool(catalogue, s.filter || {}).length,
    }));
  }

  function sourceInfo(src) {
    const s = typeof src === 'string' ? src : source();
    if (!s) return { id: '', kind: 'off', title: 'Off', subtitle: '' };
    if (s.startsWith('station:')) {
      const id = s.slice(8);
      const st = catalogueMeta.stations.find((x) => x.id === id);
      return { id: s, kind: 'station', title: st ? st.title : id, subtitle: st ? st.subtitle || '' : '' };
    }
    const g = genreInfo(s);
    return { id: s, kind: 'genre', title: g.title, subtitle: '' };
  }

  // Tracks you've said not to play again are left out of every station and genre (unless that would
  // leave nothing to play).
  function poolFor(src) {
    if (!src) return [];
    let pool;
    if (src.startsWith('station:')) {
      const st = catalogueMeta.stations.find((x) => x.id === src.slice(8));
      pool = st ? PFSound.stationPool(catalogue, st.filter || {}) : [];
    } else pool = PFSound.stationPool(catalogue, { genres: [src] });
    const hidden = new Set((P.hidden || []).map(lc));
    const kept = pool.filter((t) => !hidden.has(lc(t.id)));
    return kept.length ? kept : pool;
  }

  function credits() {
    return catalogue.map((t) => ({
      id: t.id, title: t.title, artist: t.artist, genre: t.genre,
      licence: t.licence || '', licenceUrl: t.licenceUrl || '', credit: t.credit || '', pageUrl: t.pageUrl || '',
    }));
  }

  // ── player state (device-level; v2-sound §5.5) ──

  function emptyPlayerState() {
    return { v: 1, source: '', trackID: null, positionSec: 0, savedAt: null, history: [], plays: {}, earlySkips: {},
      liked: [], hidden: [], counter: 0, volByGenre: {} };
  }

  function loadPlayerState() {
    const out = emptyPlayerState();
    try {
      const raw = JSON.parse(localStorage.getItem(PLAYER_KEY) || 'null');
      if (raw && typeof raw === 'object') {
        if (typeof raw.source === 'string') out.source = raw.source;
        if (typeof raw.trackID === 'string') out.trackID = raw.trackID;
        if (Number.isFinite(raw.positionSec)) out.positionSec = Math.max(0, raw.positionSec);
        if (typeof raw.savedAt === 'string') out.savedAt = raw.savedAt;
        if (Array.isArray(raw.history)) out.history = raw.history.filter((x) => typeof x === 'string').slice(0, 30);
        if (raw.plays && typeof raw.plays === 'object') for (const [k, v] of Object.entries(raw.plays)) if (Number.isFinite(v)) out.plays[k] = v;
        if (raw.earlySkips && typeof raw.earlySkips === 'object') {
          for (const [k, v] of Object.entries(raw.earlySkips)) if (Array.isArray(v)) out.earlySkips[k] = v.filter((d) => typeof d === 'string');
        }
        if (Array.isArray(raw.liked)) out.liked = raw.liked.filter((x) => typeof x === 'string');
        if (Array.isArray(raw.hidden)) out.hidden = raw.hidden.filter((x) => typeof x === 'string');
        if (Number.isFinite(raw.counter)) out.counter = Math.max(0, Math.floor(raw.counter));
        if (raw.volByGenre && typeof raw.volByGenre === 'object') {
          for (const [k, v] of Object.entries(raw.volByGenre)) if (Number.isFinite(v)) out.volByGenre[k] = clamp01(v);
        }
      }
    } catch (_) { /* fresh state */ }
    pruneSkips(out);
    return out;
  }

  function pruneSkips(st) {
    const cutoff = todayKey(new Date(Date.now() - 14 * 86400000));
    for (const k of Object.keys(st.earlySkips)) {
      st.earlySkips[k] = st.earlySkips[k].filter((d) => d >= cutoff).slice(-20);
      if (!st.earlySkips[k].length) delete st.earlySkips[k];
    }
  }

  let P = emptyPlayerState();   // loaded in wireOnce (localStorage may throw in private modes)

  function savePlayerState() {
    if (M.track) {
      P.trackID = M.track.id;
      P.positionSec = Math.round(musicElapsed() * 10) / 10;
    }
    P.source = source();
    P.savedAt = new Date().toISOString();
    try { localStorage.setItem(PLAYER_KEY, JSON.stringify(P)); } catch (_) { /* quota / private mode */ }
  }

  function nextState() {
    const counts = {};
    for (const [k, v] of Object.entries(P.earlySkips)) counts[k] = v.length;
    return { history: P.history, liked: P.liked, plays: P.plays, earlySkips: counts, counter: P.counter, dayKey: todayKey() };
  }

  function pickFrom(src, excludeId) {
    const pool = poolFor(src);
    if (!pool.length) return null;
    // Never hand back the track that is already playing (a resumed track sits
    // outside the history, so the weighted pick can otherwise choose it again).
    const ex = excludeId != null ? excludeId : (M.track && M.track.id);
    let use = pool;
    if (ex && pool.length > 1) {
      const rest = pool.filter((t) => lc(t.id) !== lc(ex));
      if (rest.length) use = rest;
    }
    const r = PFSound.nextTrack(use, nextState(), src);
    P.counter += 1;
    return r ? trackById(r.id) : null;
  }

  function noteStarted(track) {
    if (!track) return;
    P.history = [track.id].concat(P.history.filter((x) => lc(x) !== lc(track.id))).slice(0, 30);
    P.plays[track.id] = (P.plays[track.id] || 0) + 1;
  }

  // ── the graph ──

  let ctx = null;
  let G = null;
  let gestureSeen = false;
  let idleTimer = 0;

  function AC() { return (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)) || null; }

  function hasActivation() {
    if (gestureSeen) return true;
    try { return !!(navigator.userActivation && navigator.userActivation.hasBeenActive); } catch (_) { return false; }
  }

  function gain(v) { const g = ctx.createGain(); g.gain.value = v; return g; }

  function ensureGraph() {
    if (G) return G;
    const C = AC();
    if (!C) return null;
    try { ctx = new C({ latencyHint: 'playback' }); } catch (_) {
      try { ctx = new C(); } catch (__) { ctx = null; return null; }
    }
    const s = settings();
    const g = {};
    g.master = gain(enabled ? 1 : 0);
    g.limiter = ctx.createDynamicsCompressor();
    g.limiter.threshold.value = -1;
    g.limiter.knee.value = 0;
    g.limiter.ratio.value = 20;
    g.limiter.attack.value = 0.002;
    g.limiter.release.value = 0.1;
    g.ceiling = gain(0.891);
    g.master.connect(g.limiter);
    g.limiter.connect(g.ceiling);
    g.ceiling.connect(ctx.destination);

    g.musicSum = gain(1);
    g.analyser = ctx.createAnalyser();
    g.analyser.fftSize = 1024;
    g.analyser.smoothingTimeConstant = 0;
    g.musicVol = gain(PFSound.sliderToGain(s.musicVolume));
    g.musicDuck = gain(1);
    g.musicSum.connect(g.analyser);
    g.musicSum.connect(g.musicVol);
    g.musicVol.connect(g.musicDuck);
    g.musicDuck.connect(g.master);

    g.ambVol = gain(PFSound.sliderToGain(s.ambienceVolume));
    g.ambDuck = gain(1);
    g.ambVol.connect(g.ambDuck);
    g.ambDuck.connect(g.master);
    G = g;
    for (const d of decks) wireDeck(d);
    try { ctx.addEventListener('statechange', () => dlog('context', ctx.state)); } catch (_) {}
    return G;
  }

  /* Plain mode (H12): when the WebAudio route for music proves silent (context never
     reaches 'running', or the analyser hears digital silence while the element plays),
     music switches to fresh, unrouted <audio> elements with element-volume fades.
     One-shots keep the graph. MG() = "music uses the graph". */
  let plain = false;
  function MG() { return !!G && !plain; }

  function wireDeck(d) {
    if (!G || plain || d.node) return;
    try {
      d.el.volume = 1;
      d.node = ctx.createMediaElementSource(d.el);
      d.norm = gain(d.normLin || 1);
      d.fade = gain(d.el.paused ? 0 : 1);
      d.node.connect(d.norm);
      d.norm.connect(d.fade);
      d.fade.connect(G.musicSum);
    } catch (err) { dlog('deck wiring failed', err); }
  }

  function resumeCtx() {
    if (!ctx) return;
    clearTimeout(idleTimer);
    if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
      try { const p = ctx.resume(); if (p && p.catch) p.catch(() => {}); } catch (_) {}
    }
  }

  /* Create / resume the AudioContext. Call inside user gestures (Start, ▶, chip clicks).
     Also primes the idle music decks so WebKit lets them start later from timers. */
  function unlock() {
    gestureSeen = true;
    ensureGraph();
    resumeCtx();
    // have the alarm in memory now: the connection may be gone by the time the session ends
    try {
      const def = Store.ALARMS.find((a) => a.id === settings().selectedAlarm) || Store.ALARMS[0];
      decode(`${SOUND_DIR}${def.file}`);
    } catch (_) {}
    for (const d of decks) {
      if (d.primed || d.track || !SILENT_WAV) continue;
      d.primed = true;
      try {
        d.el.src = SILENT_WAV;
        const p = d.el.play();
        if (p && p.then) p.then(() => { if (!d.track) d.el.pause(); }).catch(() => {});
      } catch (_) {}
    }
    if (pendingStart.music || pendingStart.amb) runPendingStart();
  }

  // Every user gesture may resume a suspended context and run a start that waited for one.
  let lastGesture = 0;
  function onGesture() {
    gestureSeen = true;
    lastGesture = Date.now();
    if (ctx && ctx.state !== 'running') resumeCtx();
    if (pendingStart.music || pendingStart.amb) runPendingStart();
  }

  function scheduleIdleSuspend() {
    clearTimeout(idleTimer);
    if (!ctx) return;
    idleTimer = setTimeout(() => {
      if (M.playing || bed || ticking || shotsLive > 0 || preview.el) return;
      if (ctx.state === 'running') { try { ctx.suspend(); } catch (_) {} }
    }, IDLE_SUSPEND_MS);
  }

  // A tiny silent WAV (8 samples, 8 kHz mono) used to prime the decks.
  const SILENT_WAV = (() => {
    try {
      const n = 8;
      const bytes = new Uint8Array(44 + n * 2);
      const dv = new DataView(bytes.buffer);
      const str = (o, s) => { for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i); };
      str(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
      dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, 8000, true);
      dv.setUint32(28, 16000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); str(36, 'data'); dv.setUint32(40, n * 2, true);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return 'data:audio/wav;base64,' + btoa(bin);
    } catch (_) { return ''; }
  })();

  // ── parameter automation (never jumps) ──

  function holdParam(p, t) {
    try {
      if (typeof p.cancelAndHoldAtTime === 'function') { p.cancelAndHoldAtTime(t); return; }
    } catch (_) { /* fall through */ }
    const v = p.value;
    try { p.cancelScheduledValues(t); } catch (_) {}
    try { p.setValueAtTime(v, t); } catch (_) {}
  }

  /* Ramp an AudioParam from its current value to `to` over `dur` seconds as a chain
     of short linear ramps (robust in every engine; no setValueCurve overlap errors).
     Shapes: eqIn (sin), eqOut (cos; equal-power pair), sine (single-deck ease), linear. */
  function rampParam(p, to, dur, shape, startAt) {
    if (!ctx || !p) return;
    const now = Math.max(ctx.currentTime, startAt || 0);
    holdParam(p, now);
    const from = p.value;
    if (!(dur > 0.005)) { try { p.linearRampToValueAtTime(to, now + 0.005); } catch (_) {} return; }
    const n = Math.max(4, Math.min(64, Math.ceil(dur / 0.02)));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      let v;
      if (shape === 'eqOut') v = to + (from - to) * Math.cos(t * Math.PI / 2);
      else if (shape === 'eqIn') v = from + (to - from) * Math.sin(t * Math.PI / 2);
      else if (shape === 'linear') v = from + (to - from) * t;
      else v = from + (to - from) * (1 - Math.cos(Math.PI * t)) / 2;
      try { p.linearRampToValueAtTime(Math.max(0, v), now + t * dur); } catch (_) {}
    }
  }

  function setParamNow(p, v) {
    if (!ctx || !p) return;
    holdParam(p, ctx.currentTime);
    try { p.linearRampToValueAtTime(v, ctx.currentTime + 0.01); } catch (_) { p.value = v; }
  }

  function smoothParam(p, v) {
    if (!ctx || !p) return;
    const now = ctx.currentTime;
    holdParam(p, now);
    try { p.setTargetAtTime(v, now, 0.03); } catch (_) { p.value = v; }
  }

  // ── decks ──

  function newDeckEl(d) {
    const el = document.createElement('audio');
    el.preload = 'auto';
    el.setAttribute('data-pf-deck', String(d.i));
    el.addEventListener('loadedmetadata', () => {
      if (d.el !== el) return;
      if (d.pendingSeek != null) { const t = d.pendingSeek; d.pendingSeek = null; try { el.currentTime = t; } catch (_) {} }
      if (d === activeDeck() && d.track) emitProgress(true);
    });
    el.addEventListener('ended', () => { if (d.el === el && d.track && d === activeDeck() && M.playing && !M.transition) onDeckEnded(); });
    el.addEventListener('error', () => {
      if (d.el !== el || !d.track || !el.getAttribute('src') || el.getAttribute('src') === SILENT_WAV) return;
      onDeckError(d);
    });
    el.addEventListener('playing', () => {
      if (d.el !== el) return;
      if (d === activeDeck() && M.playing && !M.deferred) { W.lastAdvance = Date.now(); setStatus('playing'); }
    });
    el.addEventListener('timeupdate', () => { if (d.el === el && d === activeDeck() && M.playing) armSchedule(); });
    return el;
  }

  function makeDeck(i) {
    const d = { i, el: null, node: null, norm: null, fade: null, normLin: 1, pf: 1, pfTimer: 0, track: null, primed: false, pendingSeek: null };
    d.el = newDeckEl(d);
    return d;
  }

  const decks = (typeof document !== 'undefined') ? [makeDeck(0), makeDeck(1)] : [];

  function activeDeck() { return decks[M.active]; }
  function otherDeck() { return decks[1 - M.active]; }

  function deckGainLin(track) {
    const s = settings();
    const g = track ? genreInfo(track.genre) : null;
    return PFSound.dbToGain(PFSound.deckGainDb(track || {}, g, { normalize: s.musicNormalize !== false }));
  }

  function loadDeck(d, track, atSec) {
    d.track = track;
    d.normLin = deckGainLin(track);
    if (d.norm) setParamNow(d.norm.gain, d.normLin);
    let want = track.src;
    try { want = new URL(track.src, location.href).href; } catch (_) {}
    if (d.el.src !== want) {
      d.el.src = track.src;
      d.el.preload = 'auto';
      d.pendingSeek = atSec > 0 ? atSec : null;
      try { d.el.load(); } catch (_) {}
    } else if (atSec != null) {
      seekEl(d, atSec);
    }
    if (!MG()) fallbackVolume(d);
  }

  function seekEl(d, t) {
    if (d.el.readyState >= 1) { try { d.el.currentTime = t; d.pendingSeek = null; } catch (_) { d.pendingSeek = t; } } else d.pendingSeek = t;
  }

  function playEl(d) {
    const el = d.el;
    try {
      const p = el.play();
      if (p && typeof p.catch === 'function') p.catch((err) => { dlog('play() rejected', err && err.name); if (d.el === el) onPlayRejected(d, err); });
    } catch (err) { onPlayRejected(d, err); }
  }

  function onPlayRejected(d, err) {
    if (err && err.name === 'AbortError') return;      // a newer src replaced this one
    if (d !== activeDeck() || !M.playing) return;
    if (err && err.name === 'NotAllowedError') {       // autoplay policy: wait for the next gesture
      pendingStart.music = true;
      M.deferred = true;
      stopProgress();
      setStatus('blocked', 'Click ▶ to start the music');
      emit('music', musicPayload());
      return;
    }
    // NotSupportedError & co: this file can't play here — treat it like a load error.
    onDeckError(d);
  }

  /* Without the graph (no WebAudio, or plain mode): element volume carries the level;
     d.pf (0…1) is the element-level fade, animated by volRamp. */
  function fallbackVolume(d) {
    if (MG()) return;
    const v = PFSound.sliderToGain(settings().musicVolume) * (d.normLin || 1) * (d.pf == null ? 1 : d.pf);
    try { d.el.volume = enabled ? clamp01(v) : 0; } catch (_) {}
  }

  function volRamp(d, to, sec) {
    clearInterval(d.pfTimer); d.pfTimer = 0;
    const from = d.pf == null ? 1 : d.pf;
    const dur = Math.max(0, Number(sec) || 0) * 1000;
    if (dur < 30) { d.pf = to; fallbackVolume(d); return; }
    const t0 = Date.now();
    d.pfTimer = setInterval(() => {
      const k = Math.min(1, (Date.now() - t0) / dur);
      d.pf = from + (to - from) * (1 - Math.cos(Math.PI * k)) / 2;
      fallbackVolume(d);
      if (k >= 1) { clearInterval(d.pfTimer); d.pfTimer = 0; }
    }, 40);
  }

  // Fade a deck's music level (graph gain or element volume).
  function deckFade(d, to, sec, shape, startAt) {
    if (MG() && d.fade) rampParam(d.fade.gain, to, sec, shape, startAt);
    else volRamp(d, to, sec);
  }

  // ── status (H12: the UI shows loading → playing, and errors never stay silent) ──

  const ST = { state: 'idle', message: '' };
  function setStatus(state, message) {
    const m = message || '';
    if (ST.state === state && ST.message === m) return;
    ST.state = state; ST.message = m;
    dlog('status', state, m);
    emit('music', musicPayload());
  }
  function musicStatus() { return { state: ST.state, message: ST.message }; }

  /* Watchdog (2 Hz while music should be audible): notices a stalled element, an element
     paused behind our back, a context that never runs, and a graph that stays silent.
     Recovery: reload the track where it was → next track → (3 failures) error + Retry. */
  const W = { timer: 0, lastT: -1, lastAdvance: 0, silentMs: 0, notRunningMs: 0, lastTick: 0, retried: '' };

  function startWatch() {
    W.lastAdvance = Date.now(); W.lastT = -1; W.silentMs = 0; W.notRunningMs = 0; W.lastTick = Date.now();
    if (!W.timer) W.timer = setInterval(watchTick, 500);
  }
  function stopWatch() { clearInterval(W.timer); W.timer = 0; }

  function watchTick() {
    const now = Date.now();
    const dt = Math.min(2000, now - W.lastTick);
    W.lastTick = now;
    if (!M.playing || M.deferred || !M.track) return;
    if (M.transition || M.seeking || M.delayed) { W.lastAdvance = now; return; }
    const d = activeDeck();
    const t = d.el.currentTime || 0;
    const advancing = !d.el.paused && Math.abs(t - W.lastT) > 0.04;
    W.lastT = t;
    if (advancing) {
      W.lastAdvance = now;
      if (M.errorRun && now - M.trackStartWall > 8000) M.errorRun = 0;
      if (ST.state !== 'playing') setStatus('playing');
      if (MG()) {
        if (ctx.state !== 'running') {
          W.notRunningMs += dt;
          resumeCtx();
          if (W.notRunningMs > 1600) { switchToPlain('context stays ' + ctx.state); return; }
        } else W.notRunningMs = 0;
        const fadeOn = d.fade && d.fade.gain.value > 0.5;
        if (ctx.state === 'running' && fadeOn && t > 1.5) {
          if (!(rmsDb() > -110)) W.silentMs += dt; else W.silentMs = 0;
          if (W.silentMs > 2600) { switchToPlain('graph is silent'); return; }
        }
      }
      return;
    }
    const stuck = now - W.lastAdvance;
    if (d.el.paused && !d.el.ended && stuck > 1200 && d.pendingSeek == null) playEl(d);   // paused behind our back
    if (stuck > 1500 && ST.state === 'playing') setStatus('loading');
    if (stuck > 9000) { W.lastAdvance = now; recoverActive('stalled'); }
  }

  // Reload the current track where it was once; after that, move on to the next one.
  function recoverActive(why) {
    if (!M.track) return;
    const d = activeDeck();
    const key = M.track.id;
    dlog('recover', why, key);
    if (W.retried !== key) {
      W.retried = key;
      const pos = d.pendingSeek != null ? d.pendingSeek : (d.el.currentTime || 0);
      try { d.el.pause(); } catch (_) {}
      d.el.removeAttribute('src');
      try { d.el.load(); } catch (_) {}
      setCurrent(M.track, pos, true);
      setStatus('loading');
      fadeInActive(FADES.resume);
      return;
    }
    skipAfterFailure();
  }

  function skipAfterFailure() {
    M.errorRun += 1;
    const bad = M.track;
    const pool = poolFor(source()).filter((t) => !bad || lc(t.id) !== lc(bad.id));
    if (M.errorRun > 3 || !pool.length) {
      const keep = M.track;
      pauseMusic();
      M.track = keep;
      setStatus('error', navigator.onLine === false ? 'You’re offline — music couldn’t load.' : 'Music couldn’t play.');
      return;
    }
    let n = pickFrom(source());
    if (!n || (bad && lc(n.id) === lc(bad.id))) n = pool[Math.floor(Math.random() * pool.length)];
    const run = M.errorRun;
    setCurrent(n, n.inSec || 0);
    M.errorRun = run;
    setStatus('loading');
    fadeInActive(FADES.resume);
    emit('music', musicPayload());
  }

  // Swap both decks for fresh, unrouted <audio> elements (see `plain`).
  function switchToPlain(why) {
    if (plain) return;
    plain = true;
    console.warn('audio: music switched to plain <audio> playback —', why);
    const t = M.track;
    const pos = musicElapsed();
    if (M.transition) finishTransition(true);
    for (const d of decks) {
      const old = d.el;
      try { old.pause(); } catch (_) {}
      try { if (d.node) d.node.disconnect(); } catch (_) {}
      try { if (d.fade) d.fade.disconnect(); } catch (_) {}
      old.removeAttribute('src');
      try { old.load(); } catch (_) {}
      d.node = null; d.norm = null; d.fade = null; d.pf = 0;
      d.track = null; d.pendingSeek = null;
      d.el = newDeckEl(d);
    }
    if (t && M.playing) {
      setCurrent(t, pos, true);
      fadeInActive(FADES.resume);
    }
  }

  // ── music state ──

  const M = {
    playing: false, deferred: false, track: null, active: 0, sourceId: '',
    next: null, plan: null, transition: null, preloaded: false,
    armTimer: 0, fineTimer: 0, pauseTimer: 0, stopTimer: 0, progressTimer: 0, saveAt: 0,
    trackStartWall: 0, back: [], pendingResume: null, pendingFade: null, pendingAmbFade: null,
    lastExplicit: 0, errorRun: 0, seekToken: 0, delayed: 0, armDue: 0, seeking: false, fineLast: 0,
  };
  const pendingStart = { music: false, amb: false };

  function musicPayload() {
    return { track: M.track, playing: isMusicPlaying(), source: source(), status: ST.state, message: ST.message };
  }

  function source() { const s = settings(); return typeof s.selectedMusic === 'string' ? s.selectedMusic : ''; }

  function setSource(s) {
    const v = typeof s === 'string' ? s : '';
    unlock();
    try { Store.setSetting('selectedMusic', v); } catch (_) { return; }
    applySourceChange(true);
  }

  function inPool(track, src) {
    if (!track || !src) return false;
    return poolFor(src).some((t) => lc(t.id) === lc(track.id));
  }

  function computeNext(force) {
    if (!M.track) { M.next = null; M.plan = null; return null; }
    // A planned track that is somehow the current one is not a valid "next"
    // (pool size > 1): recompute it instead of replaying the same song.
    const stale = M.next && lc(M.next.id) === lc(M.track.id) && poolFor(source() || M.sourceId).length > 1;
    if (!M.next || force || stale) {
      let n = pickFrom(source() || M.sourceId);
      if (!n) n = M.track;                               // single-track or emptied pool: replay
      M.next = n;
      M.plan = null;
      M.preloaded = false;
      emit('music:upnext', { track: M.next });
    }
    if (M.next && !M.plan) M.plan = planFor(M.track, M.next);
    return M.next;
  }

  function planFor(cur, next) {
    const d = activeDeck();
    const dur = Number(cur.durationSec) || (d && isFinite(d.el.duration) ? d.el.duration : 0) || Number(cur.duration) || 0;
    const c = { durationSec: dur, inSec: cur.inSec || 0, outSec: cur.outSec == null ? null : Number(cur.outSec), tailFadeSec: cur.tailFadeSec || 0 };
    const n = { durationSec: Number(next.durationSec) || Number(next.duration) || 60, inSec: next.inSec || 0 };
    const off = settings().musicCrossfade === 'off';
    const g = off ? { crossfadeSec: 0 } : genreInfo(cur.genre);
    const plan = PFSound.crossfadePlan(c, n, g);
    // A file shorter than the catalogue says: never plan past its real end.
    if (d && isFinite(d.el.duration) && d.el.duration > 1 && plan.startAt > d.el.duration - Math.max(plan.overlap, GAPLESS_FADE)) {
      plan.startAt = Math.max(0, d.el.duration - Math.max(plan.overlap, GAPLESS_FADE) - 0.05);
    }
    return plan;
  }

  function transitionStartAt(plan) {
    return plan.gapless ? Math.max(0, plan.startAt - GAPLESS_FADE / 2) : plan.startAt;
  }

  function clearSchedule() {
    clearTimeout(M.armTimer); M.armTimer = 0;
    clearTimeout(M.fineTimer); M.fineTimer = 0;
  }

  /* Preload the next track 20 s ahead, then start the crossfade so its gain ramps begin
     exactly at the plan's startAt on the audio clock. The incoming deck starts a moment
     early (silent) and positioned so it reaches nextIn when its fade begins. Triggers:
     a 20 ms timer chain (≤ 0.12 s ahead), or — when timers are throttled (hidden,
     muted tab) — the deck's own timeupdate events (≤ 0.32 s ahead). */
  const TRIGGER_FINE = 0.12;
  const TRIGGER_COARSE = 0.32;

  function armSchedule() {
    if (!M.playing || M.deferred || M.transition || M.delayed || M.seeking || !M.track) return;
    if (!computeNext()) return;
    const d = activeDeck();
    if (d.pendingSeek != null || d.el.readyState < 1) return;
    const pos = d.el.currentTime || 0;
    const startAt = transitionStartAt(M.plan);
    const lead = startAt - pos;
    if (!M.preloaded && lead <= PRELOAD_LEAD) preloadNext();
    if (lead <= TRIGGER_FINE || (lead <= TRIGGER_COARSE && (!M.fineTimer || Date.now() - M.fineLast > 80))) {
      triggerPlanned(pos, startAt);
      return;
    }
    if (M.fineTimer) return;
    const wait = (lead - TRIGGER_FINE - 0.4) * 1000;
    // Re-arm when the position jumped (seek, stall, throttled timers) since the timer was set.
    if (M.armTimer) {
      if (Math.abs(Date.now() + wait - M.armDue) < 250) return;
      clearTimeout(M.armTimer); M.armTimer = 0;
    }
    const fine = () => {
      M.fineTimer = 0;
      M.fineLast = Date.now();
      if (!M.playing || M.transition || M.seeking || !M.track || !M.plan) return;
      const p = activeDeck().el.currentTime || 0;
      const at = transitionStartAt(M.plan);
      if (at - p <= TRIGGER_FINE) triggerPlanned(p, at);
      else M.fineTimer = setTimeout(fine, 20);
    };
    if (wait > 0) { M.armDue = Date.now() + wait; M.armTimer = setTimeout(() => { M.armTimer = 0; fine(); }, wait); }
    else fine();
  }

  function triggerPlanned(pos, startAt) {
    clearSchedule();
    const lead = Math.max(0, startAt - pos);
    const plan = M.plan;
    const overlap = plan.gapless ? GAPLESS_FADE : plan.overlap;
    beginCrossfade(M.next, {
      overlap, atSec: Math.max(0, plan.nextIn - lead), reason: 'auto',
      rampAt: ctx ? ctx.currentTime + lead : null, planned: startAt, pos,
    });
  }

  function preloadNext() {
    if (!M.next || M.transition) return;
    const inc = otherDeck();
    let want = M.next.src;
    try { want = new URL(M.next.src, location.href).href; } catch (_) {}
    if (inc.track && lc(inc.track.id) === lc(M.next.id) && inc.el.src === want) { M.preloaded = true; return; }
    try { inc.el.pause(); } catch (_) {}
    if (inc.fade) setParamNow(inc.fade.gain, 0);
    loadDeck(inc, M.next, M.plan ? M.plan.nextIn : (M.next.inSec || 0));
    M.preloaded = true;
    dlog('preload', M.next.id);
  }

  /* Equal-power crossfade from the active deck into `track` on the other deck.
     The incoming deck starts first; both fades begin on its 'playing' event. */
  function beginCrossfade(track, opts) {
    if (!track) return;
    const o = opts || {};
    if (M.transition) {
      // A transition is still sounding: settle it in 50 ms, then start this one.
      finishTransition(true);
      clearTimeout(M.delayed);
      M.delayed = setTimeout(() => { M.delayed = 0; if (M.playing) beginCrossfade(track, opts); }, 80);
      return;
    }
    clearSchedule();
    const out = activeDeck();
    const inc = otherDeck();
    const overlap = Math.max(0.02, Number(o.overlap) || FADES.skip);
    let want = track.src;
    try { want = new URL(track.src, location.href).href; } catch (_) {}
    const sameDeckTrack = inc.track && lc(inc.track.id) === lc(track.id) && inc.el.src === want;
    if (!sameDeckTrack) loadDeck(inc, track, o.atSec != null ? o.atSec : (track.inSec || 0));
    else if (o.atSec != null && Math.abs((inc.el.currentTime || 0) - o.atSec) > 0.05) seekEl(inc, o.atSec);
    if (inc.fade) setParamNow(inc.fade.gain, 0);
    if (!MG()) { clearInterval(inc.pfTimer); inc.pf = 0; fallbackVolume(inc); }
    const from = M.track;
    const tr = { from, to: track, out, inc, overlap, started: false, swapped: false, midTimer: 0, endTimer: 0, guard: 0, reason: o.reason || 'auto' };
    M.transition = tr;
    if ((o.reason === 'auto' || o.reason === 'ended') && from) M.back.push(from.id);
    const go = () => {
      if (M.transition !== tr || tr.started) return;
      tr.started = true;
      clearTimeout(tr.guard);
      let delay = 0;
      if (MG()) {
        const now = ctx.currentTime;
        const t0 = o.rampAt != null ? Math.max(now, o.rampAt) : now;
        delay = t0 - now;
        rampParam(out.fade.gain, 0, overlap, 'eqOut', t0);
        rampParam(inc.fade.gain, 1, overlap, 'eqIn', t0);
        if (o.planned != null) {
          const actual = (out.el.currentTime || 0) + delay;
          dlog(`transition ${from ? from.id : '∅'} → ${track.id} · auto · plan ${o.planned.toFixed(2)} s · fades start ${actual.toFixed(2)} s · Δ ${Math.round((actual - o.planned) * 1000)} ms · overlap ${overlap.toFixed(2)} s`);
        }
      } else {
        volRamp(out, 0, overlap);
        volRamp(inc, 1, overlap);
      }
      if (o.planned == null) dlog(`transition ${from ? from.id : '∅'} → ${track.id} · ${tr.reason} · overlap ${overlap.toFixed(2)} s`);
      if (DEBUG) setTimeout(() => watchRms(overlap), delay * 1000);
      emit('music:transition', { from, to: track, overlap, delay });
      tr.midTimer = setTimeout(() => midpoint(tr), (delay + overlap / 2) * 1000);
      tr.endTimer = setTimeout(() => { if (M.transition === tr) finishTransition(false); }, (delay + overlap + 0.1) * 1000);
    };
    tr.go = go;
    if (!inc.el.paused && inc.el.readyState >= 3) go();
    else {
      inc.el.addEventListener('playing', go, { once: true });
      // Never hang: if the incoming deck can't start in 4 s, cross over when it has data,
      // else give up on it and keep the current track playing (no silence).
      tr.guard = setTimeout(() => {
        if (M.transition !== tr || tr.started) return;
        if (inc.el.readyState >= 2 && !inc.el.error) go(); else abandonTransition(tr, 'incoming deck did not start');
      }, 4000);
    }
    playEl(inc);
  }

  // The new track becomes "current" when it becomes louder (v2-sound §6.7).
  function midpoint(tr) {
    if (tr.swapped) return;
    tr.swapped = true;
    accrueLog();
    M.active = tr.inc.i;
    M.track = tr.to;
    M.trackStartWall = Date.now();
    M.next = null; M.plan = null; M.preloaded = false;
    M.errorRun = 0;
    noteStarted(tr.to);
    savePlayerState();
    emit('music', musicPayload());
    emitProgress(true);
  }

  function finishTransition(fast) {
    const tr = M.transition;
    if (!tr) return;
    clearTimeout(tr.midTimer); clearTimeout(tr.endTimer); clearTimeout(tr.guard);
    try { tr.inc.el.removeEventListener('playing', tr.go); } catch (_) {}
    if (!tr.swapped) midpoint(tr);
    if (fast) {
      deckFade(tr.out, 0, 0.05, 'linear');
      if (M.playing) deckFade(tr.inc, 1, 0.05, 'linear');
    }
    const out = tr.out;
    M.transition = null;
    const stopOut = () => {
      if (out === activeDeck() || (M.transition && M.transition.inc === out)) return;
      try { out.el.pause(); } catch (_) {}
    };
    if (fast) setTimeout(stopOut, 60); else stopOut();
    if (!fast) { computeNext(); armSchedule(); }
  }

  function onDeckEnded() {
    // End of file without a plan (e.g. a seek past startAt): start the next one right away.
    const n = computeNext() || pickFrom(source());
    if (!n) { stopMusic(); return; }
    beginCrossfade(n, { overlap: 0.3, atSec: n.inSec || 0, reason: 'ended' });
  }

  // The incoming deck failed: keep the current track sounding and plan another next.
  function abandonTransition(tr, why) {
    if (M.transition !== tr || tr.swapped) return;
    dlog('transition abandoned —', why, tr.to && tr.to.id);
    clearTimeout(tr.midTimer); clearTimeout(tr.endTimer); clearTimeout(tr.guard);
    try { tr.inc.el.removeEventListener('playing', tr.go); } catch (_) {}
    M.transition = null;
    try { tr.inc.el.pause(); } catch (_) {}
    deckFade(tr.inc, 0, 0.05, 'linear');
    if (M.playing) deckFade(tr.out, 1, 0.3, 'sine');
    tr.inc.track = null;
    M.next = null; M.plan = null; M.preloaded = false;
    const outAlive = !tr.out.el.ended && !tr.out.el.error && tr.out.el.getAttribute('src');
    if (!outAlive && M.playing) { skipAfterFailure(); return; }
    computeNext(true); armSchedule();
  }

  /* A deck failed to load/decode. The incoming deck of a crossfade → abandon that
     transition; the active deck → reload once at its position, then the next track. */
  function onDeckError(d) {
    dlog('deck error', d.track && d.track.id, d.el.error && d.el.error.code);
    if (M.transition && M.transition.inc === d && !M.transition.swapped) { abandonTransition(M.transition, 'load error'); return; }
    if (d !== activeDeck()) { d.track = null; if (M.preloaded) { M.preloaded = false; M.next = null; M.plan = null; } return; }
    if (!M.playing) { setStatus('error', 'This track couldn’t load.'); return; }
    if (M.deferred) return;
    setTimeout(() => { if (M.playing && activeDeck() === d) recoverActive('error'); }, 300);
  }

  // ── transport ──

  function takeFade(fallback) {
    const f = M.pendingFade;
    M.pendingFade = null;
    return f && Date.now() - f.at < 1500 ? f.sec : fallback;
  }

  function startProgress() {
    if (M.progressTimer) return;
    M.progressTimer = setInterval(() => {
      if (!M.playing) return;
      accrueLog();
      armSchedule();
      if (Date.now() - M.saveAt > SAVE_EVERY_MS) { M.saveAt = Date.now(); savePlayerState(); }
      emitProgress(false);
    }, 250);
  }

  function stopProgress() { clearInterval(M.progressTimer); M.progressTimer = 0; }

  let lastProgressEmit = 0;
  function emitProgress(force) {
    if (!force && typeof document !== 'undefined' && document.hidden) return;
    const now = Date.now();
    if (!force && now - lastProgressEmit < 200) return;
    lastProgressEmit = now;
    emit('music:progress', { elapsed: musicElapsed(), duration: musicDuration(), progress: musicProgress() });
  }

  /* Fade the active deck in from where it is (2.4 s swell on Focus start,
     0.8 s on resume and on ▶). */
  function fadeInActive(sec) {
    const d = activeDeck();
    clearTimeout(M.pauseTimer); M.pauseTimer = 0;
    clearTimeout(M.stopTimer); M.stopTimer = 0;
    deckFade(d, 1, sec, 'sine');
    playEl(d);
    startWatch();
  }

  function startPlayback(fadeSec) {
    M.playing = true;
    lastAccrue = Date.now();
    if (!hasActivation()) {           // never autoplay on load: wait for the first gesture
      M.deferred = true;
      pendingStart.music = true;
      setStatus('blocked', 'Click ▶ to start the music');
      emit('music', musicPayload());
      return;
    }
    M.deferred = false;
    ensureGraph();
    resumeCtx();
    const d = activeDeck();
    if (d.el.ended) { try { d.el.currentTime = 0; } catch (_) {} }
    setStatus(!d.el.paused && d.el.readyState >= 3 ? 'playing' : 'loading');
    fadeInActive(fadeSec);
    startProgress();
    armSchedule();
    emit('music', musicPayload());
    emitProgress(true);
  }

  function runPendingStart() {
    const wantMusic = pendingStart.music, wantAmb = pendingStart.amb;
    pendingStart.music = false; pendingStart.amb = false;
    if (wantMusic && M.playing && M.track) {
      M.deferred = false;
      lastAccrue = Date.now();
      ensureGraph(); resumeCtx();
      setStatus('loading');
      fadeInActive(FADES.start);
      startProgress(); armSchedule();
      emit('music', musicPayload());
    }
    if (wantAmb && timerFocusRunning()) startAmbience();
  }

  /* playMusic(trackId?) — with an id: play that track now (crossfade if something
     plays). Without: continue the current track, else resume the remembered track
     and position (continuity), else start the source's next pick. */
  function inGesture() {
    try {
      const ua = navigator.userActivation;
      return ua ? !!ua.isActive : Date.now() - lastGesture < 1000;     // Safari before 16.4 has no userActivation
    } catch (_) { return false; }
  }

  function playMusic(trackId) {
    if (inGesture()) unlock();           // Safari: create/resume the context inside the click
    const src = source();
    if (!src) { stopMusic(); return; }
    if (!loaded || (!catalogue.length && loading)) {
      // Pressed before music.json arrived: remember the request and play when it lands.
      M.pendingResume = { play: true, trackId: trackId || null };
      setStatus('loading');
      return;
    }
    if (!catalogue.length) { setStatus('error', 'The music library couldn’t load.'); return; }
    if (hasActivation()) { ensureGraph(); resumeCtx(); }
    M.sourceId = src;
    const audible = M.playing && !M.deferred && !!M.track;
    if (trackId) {
      M.lastExplicit = Date.now();
      const t = trackById(trackId);
      if (!t) return;
      if (M.track && lc(M.track.id) === lc(t.id)) {
        if (!M.playing) startPlayback(takeFade(FADES.resume));
        return;
      }
      takeFade(0);
      if (audible) { accrueLog(); beginCrossfade(t, { overlap: FADES.stop, atSec: t.inSec || 0, reason: 'pick' }); return; }
      setCurrent(t, t.inSec || 0);
      startPlayback(FADES.resume);
      return;
    }
    if (M.track && inPool(M.track, src)) {
      if (!M.playing || !deckRunning()) startPlayback(takeFade(FADES.resume));
      else takeFade(0);
      return;
    }
    // Continuity: the remembered track and position, when it belongs to this source.
    const remembered = P.trackID ? trackById(P.trackID) : null;
    if (remembered && inPool(remembered, src) && !audible) {
      const pos = Math.max(0, Math.min(Number(P.positionSec) || 0, (Number(remembered.durationSec) || 1e9) - 8));
      setCurrent(remembered, pos, true);
      startPlayback(takeFade(FADES.resume));
      return;
    }
    const t = pickFrom(src);
    if (!t) { stopMusic(); return; }
    if (audible) { takeFade(0); accrueLog(); beginCrossfade(t, { overlap: FADES.stop, atSec: t.inSec || 0, reason: 'source' }); return; }
    setCurrent(t, t.inSec || 0);
    startPlayback(takeFade(FADES.resume));
  }

  // Load a track into the active deck while nothing is audible.
  function setCurrent(t, atSec, resumed) {
    clearSchedule();
    clearTimeout(M.delayed); M.delayed = 0;
    if (M.transition) finishTransition(true);
    const d = activeDeck();
    if (d.fade) setParamNow(d.fade.gain, 0);
    if (!MG()) { clearInterval(d.pfTimer); d.pf = 0; }
    loadDeck(d, t, atSec);
    M.track = t;
    M.next = null; M.plan = null; M.preloaded = false;
    M.trackStartWall = Date.now();
    M.errorRun = 0;
    if (!resumed) noteStarted(t);
    savePlayerState();
  }

  function pauseMusic() {
    M.pendingResume = null;
    M.seeking = false; M.seekToken += 1;
    if (!M.track) { M.playing = false; stopWatch(); setStatus('idle'); emit('music', musicPayload()); return; }
    accrueLog();
    const wasAudible = M.playing && !M.deferred;
    M.playing = false;
    M.deferred = false;
    pendingStart.music = false;
    clearSchedule();
    clearTimeout(M.delayed); M.delayed = 0;
    stopProgress();
    if (M.transition) finishTransition(true);
    const d = activeDeck();
    stopWatch();
    setStatus('paused');
    if (wasAudible && (MG() ? d.fade : true)) {
      deckFade(d, 0, FADES.pause, 'sine');
      clearTimeout(M.pauseTimer);
      M.pauseTimer = setTimeout(() => {
        M.pauseTimer = 0;
        if (!M.playing) { try { d.el.pause(); } catch (_) {} scheduleIdleSuspend(); }
      }, FADES.pause * 1000 + 40);
    } else {
      try { d.el.pause(); } catch (_) {}
    }
    savePlayerState();
    emit('music', musicPayload());
  }

  function stopMusic() {
    accrueLog();
    M.seeking = false; M.seekToken += 1;
    const had = !!M.track;
    const wasAudible = M.playing && !M.deferred;
    if (had) savePlayerState();
    M.playing = false;
    M.deferred = false;
    pendingStart.music = false;
    M.pendingResume = null;
    clearSchedule();
    clearTimeout(M.delayed); M.delayed = 0;
    stopProgress();
    if (M.transition) finishTransition(true);
    M.track = null;
    M.next = null; M.plan = null; M.preloaded = false;
    clearTimeout(M.pauseTimer); M.pauseTimer = 0;
    const fade = wasAudible ? FADES.stop : 0.05;
    stopWatch();
    setStatus('idle');
    for (const d of decks) deckFade(d, 0, fade, 'sine');
    clearTimeout(M.stopTimer);
    M.stopTimer = setTimeout(() => {
      M.stopTimer = 0;
      if (M.track) return;
      for (const d of decks) {
        try { d.el.pause(); } catch (_) {}
        if (d.el.getAttribute('src')) { d.el.removeAttribute('src'); try { d.el.load(); } catch (_) {} }
        d.track = null;
        d.pendingSeek = null;
      }
      scheduleIdleSuspend();
    }, fade * 1000 + 60);
    emit('music', musicPayload());
    if (had) emit('music:upnext', { track: null });
  }

  function toggleMusic() {
    unlock();
    if (ST.state === 'error') { retryMusic(); return; }
    if (M.playing && !M.deferred) {
      if (deckRunning()) { pauseMusic(); return; }
      // The flags say "playing" but the element stopped behind our back (OS audio
      // route change, sleep/wake, a file that ended during a transition). Restart
      // it here instead of making the person reload the whole app.
      const d = activeDeck();
      if (M.track && (d.el.ended || d.el.error || !d.el.getAttribute('src'))) setCurrent(M.track, M.track.inSec || 0, true);
      M.deferred = false;
      pendingStart.music = false;
      setStatus('loading');
      fadeInActive(FADES.resume);
      startProgress(); armSchedule();
      emit('music', musicPayload());
      return;
    }
    if (!source()) return;
    playMusic(null);
  }

  // Retry after an error (the UI's "Retry"): reload the library if it never came, else the track.
  function retryMusic() {
    unlock();
    M.errorRun = 0; W.retried = '';
    if (!catalogue.length) {
      M.pendingResume = { play: true, trackId: null };
      setStatus('loading');
      loaded = false;
      loadCatalogue();
      return;
    }
    const t = M.track;
    if (t && inPool(t, source())) {
      const pos = musicElapsed();
      const d = activeDeck();
      try { d.el.pause(); } catch (_) {}
      d.el.removeAttribute('src');
      try { d.el.load(); } catch (_) {}
      setCurrent(t, pos, true);
      startPlayback(FADES.resume);
      return;
    }
    playMusic(null);
  }

  function recordSkip() {
    if (!M.track) return;
    const played = (Date.now() - (M.trackStartWall || Date.now())) / 1000;
    if (PFSound.isEarlySkip(played)) {
      const id = M.track.id;
      (P.earlySkips[id] = P.earlySkips[id] || []).push(todayKey());
      pruneSkips(P);
    }
  }

  function nextMusic() {
    unlock();
    if (!M.track) { playMusic(null); return; }
    recordSkip();
    accrueLog();
    const n = computeNext() || pickFrom(source());
    if (!n) return;
    M.back.push(M.track.id);
    if (M.playing && !M.deferred) {
      beginCrossfade(n, { overlap: FADES.skip, atSec: n.inSec || 0, reason: 'next' });
    } else {
      setCurrent(n, n.inSec || 0);
      emit('music', musicPayload());
      emitProgress(true);
    }
  }

  function previousMusic() {
    unlock();
    if (!M.track) return;
    // Like most players: after 3 s, ⏮ restarts the track instead of going back.
    if (musicElapsed() > 3) { seekMusic(M.track.inSec || 0); return; }
    let id = null;
    while (M.back.length && !id) { const x = M.back.pop(); if (x && lc(x) !== lc(M.track.id)) id = x; }
    if (!id) id = P.history.find((x) => lc(x) !== lc(M.track.id)) || null;
    const t = id ? trackById(id) : null;
    if (!t) { seekMusic(M.track.inSec || 0); return; }
    if (M.playing && !M.deferred) beginCrossfade(t, { overlap: FADES.skip, atSec: t.inSec || 0, reason: 'previous' });
    else { setCurrent(t, t.inSec || 0); emit('music', musicPayload()); emitProgress(true); }
  }

  function seekMusic(seconds) {
    if (!M.track) return;
    let t = Number(seconds);
    if (!isFinite(t)) return;
    if (M.transition) finishTransition(true);
    const d = activeDeck();
    const dur = musicDuration();
    t = dur > 0 ? Math.min(Math.max(0, dur - 0.25), Math.max(0, t)) : Math.max(0, t);
    clearSchedule();
    M.plan = null; M.preloaded = false;
    if (M.playing && !M.deferred && (!MG() || d.fade)) {
      deckFade(d, 0, FADES.seekOut, 'sine');
      const token = ++M.seekToken;
      M.seeking = true;
      setTimeout(() => {
        if (token !== M.seekToken) return;
        let done = false;
        const fin = () => {
          if (done || token !== M.seekToken) return;
          done = true;
          M.seeking = false;
          if (M.playing && activeDeck() === d) { deckFade(d, 1, FADES.seekIn, 'sine'); armSchedule(); }
        };
        d.el.addEventListener('seeked', fin, { once: true });
        seekEl(d, t);
        setTimeout(fin, 600);   // never stay silent if 'seeked' doesn't come
      }, FADES.seekOut * 1000);
    } else {
      seekEl(d, t);
    }
    emit('music:progress', { elapsed: t, duration: dur, progress: dur ? Math.min(1, t / dur) : 0 });
    emit('music', musicPayload());
  }

  function musicElapsed() {
    if (!M.track) return 0;
    const d = activeDeck();
    if (d.pendingSeek != null) return d.pendingSeek;
    return d.el.currentTime || 0;
  }
  function musicDuration() {
    if (!M.track) return 0;
    const d = activeDeck();
    return isFinite(d.el.duration) && d.el.duration > 0 ? d.el.duration : (Number(M.track.durationSec) || Number(M.track.duration) || 0);
  }
  function musicProgress() {
    const d = musicDuration();
    if (!d) return 0;
    return Math.min(1, Math.max(0, musicElapsed() / d));
  }

  function currentTrack() { return M.track; }
  function deckRunning() {
    if (!M.track || !M.playing || M.deferred) return false;
    const d = activeDeck();
    return !!d && !d.el.paused && !d.el.ended && !d.el.error;
  }
  function isMusicPlaying() { return !!M.track && M.playing && !M.deferred; }
  function upNext() { return M.track ? computeNext() : null; }

  function like(id, on) {
    const t = trackById(id);
    const key = t ? t.id : String(id || '');
    if (!key) return;
    P.liked = P.liked.filter((x) => lc(x) !== lc(key));
    if (on) P.liked.unshift(key);
    P.liked = P.liked.slice(0, 500);
    savePlayerState();
    emit('music', musicPayload());
  }
  function isLiked(id) { const k = lc(id); return !!k && P.liked.some((x) => lc(x) === k); }

  /* hide(id, on) — "Don't play this again": the track leaves every pool; hiding the one playing
     moves on to the next track. hidden() lists them (Settings › Sounds can bring them back). */
  function hide(id, on = true) {
    const t = trackById(id);
    const key = t ? t.id : String(id || '');
    if (!key) return;
    P.hidden = (P.hidden || []).filter((x) => lc(x) !== lc(key));
    if (on) { P.hidden.unshift(key); P.liked = P.liked.filter((x) => lc(x) !== lc(key)); }
    savePlayerState();
    if (on && M.track && lc(M.track.id) === lc(key)) nextMusic();
    else emit('music', musicPayload());
  }
  function isHidden(id) { const k = lc(id); return !!k && (P.hidden || []).some((x) => lc(x) === k); }
  function hiddenTracks() { return (P.hidden || []).map((id) => trackById(id)).filter(Boolean); }

  function clearHistory() {
    const keep = { source: P.source, trackID: P.trackID, positionSec: P.positionSec, volByGenre: P.volByGenre };
    P = Object.assign(emptyPlayerState(), keep);
    M.back = [];
    savePlayerState();
    emit('music', musicPayload());
  }

  function setMusicVolume(v) {
    if (MG()) smoothParam(G.musicVol.gain, PFSound.sliderToGain(v));
    else for (const d of decks) fallbackVolume(d);
  }

  function setAmbienceVolume(v) {
    if (G) smoothParam(G.ambVol.gain, PFSound.sliderToGain(v));
    else if (ambEl) ambEl.volume = clamp01(PFSound.sliderToGain(v) * PFSound.dbToGain(ambGainDb(ambEl.dataset.id)));
  }

  // React to settings written anywhere (Settings › Sounds, the popover, a remote device).
  let lastSettings = null;
  function onSettingsChange() {
    const s = settings();
    const prev = lastSettings || {};
    lastSettings = { musicVolume: s.musicVolume, ambienceVolume: s.ambienceVolume, musicNormalize: s.musicNormalize, musicCrossfade: s.musicCrossfade };
    if (!MG() && prev.musicVolume !== s.musicVolume) for (const d of decks) fallbackVolume(d);
    if (!G) return;
    if (prev.musicVolume !== s.musicVolume) smoothParam(G.musicVol.gain, PFSound.sliderToGain(s.musicVolume));
    if (prev.ambienceVolume !== s.ambienceVolume) smoothParam(G.ambVol.gain, PFSound.sliderToGain(s.ambienceVolume));
    if (prev.musicNormalize !== s.musicNormalize) {
      for (const d of decks) if (d.track && d.norm) { d.normLin = deckGainLin(d.track); rampParam(d.norm.gain, d.normLin, 0.3, 'sine'); }
    }
    if (prev.musicCrossfade !== s.musicCrossfade && !M.transition) { M.plan = null; clearSchedule(); armSchedule(); }
  }

  /* The source changed (Settings, the card's chips, a remote device). Off → stop;
     playing and the current track isn't in the new source → 1.2 s crossfade. */
  function applySourceChange(fromApi) {
    const src = source();
    if (src === M.sourceId && !fromApi) return;
    M.sourceId = src;
    if (!src) { if (M.track) stopMusic(); return; }
    M.next = null; M.plan = null; M.preloaded = false;
    if (M.track && !inPool(M.track, src)) {
      const t = pickFrom(src);
      if (t && M.playing && !M.deferred) { accrueLog(); beginCrossfade(t, { overlap: FADES.stop, atSec: t.inSec || 0, reason: 'source' }); }
      else if (t) setCurrent(t, t.inSec || 0);
    } else if (M.playing) {
      clearSchedule();
      computeNext(true);
      armSchedule();
    }
    emit('music', musicPayload());
  }

  // ── session genre log (v2-sound §5.6) ──

  let sessionLog = new Map();
  let lastAccrue = 0;

  function accrueLog() {
    const now = Date.now();
    if (M.playing && !M.deferred && M.track && lastAccrue) {
      const dt = Math.min(120, Math.max(0, (now - lastAccrue) / 1000));
      if (dt > 0) sessionLog.set(M.track.genre, (sessionLog.get(M.track.genre) || 0) + dt);
    }
    lastAccrue = now;
  }

  function resetSessionLog() { accrueLog(); sessionLog = new Map(); lastAccrue = Date.now(); }

  function sessionMusicStats() {
    accrueLog();
    const log = Array.from(sessionLog.entries()).map(([genre, seconds]) => ({ genre, seconds }));
    let seconds = 0;
    for (const e of log) seconds += Math.max(0, Number(e.seconds) || 0);
    return { genre: PFSound.dominantGenre(log) || '', seconds };
  }

  function sessionMusicGenre() { return sessionMusicStats().genre; }

  // ── one-shots (decoded once) ──

  const buffers = new Map();     // url → Promise<AudioBuffer|null>
  let shotsLive = 0;

  function decode(url) {
    if (!ensureGraph()) return Promise.resolve(null);
    if (buffers.has(url)) return buffers.get(url);
    const p = fetch(url).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
      .then((ab) => new Promise((resolve, reject) => {
        try {
          const q = ctx.decodeAudioData(ab, resolve, reject);
          if (q && q.then) q.then(resolve, reject);
        } catch (err) { reject(err); }
      }))
      .catch(() => { buffers.delete(url); return null; });
    buffers.set(url, p);
    return p;
  }

  function alarmGainDb(id) {
    const a = catalogueMeta.alarms.find((x) => x.id === id);
    if (a && Number.isFinite(a.gainDb)) return a.gainDb;
    return ALARM_GAIN_DB[id] || 0;
  }
  function ambGainDb(id) {
    const a = catalogueMeta.ambience.find((x) => x.id === id);
    if (a && Number.isFinite(a.gainDb)) return a.gainDb;
    return AMB_GAIN_DB[id] || 0;
  }

  /* Play a decoded one-shot at `lin` (linear: volume × catalogue dB), optionally
     ducking music and ambience for its duration. */
  function playBuffer(url, lin, duckKind) {
    if (!enabled) return Promise.resolve(false);
    if (!ensureGraph()) { fallbackOnce(url, lin); return Promise.resolve(true); }
    resumeCtx();
    return decode(url).then((buf) => {
      if (!buf || !enabled) return false;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = gain(Math.max(0, lin));
      src.connect(g);
      g.connect(G.master);
      shotsLive += 1;
      src.onended = () => { shotsLive = Math.max(0, shotsLive - 1); try { g.disconnect(); } catch (_) {} scheduleIdleSuspend(); };
      if (duckKind) duck(duckKind, buf.duration * 1000);
      src.start();
      return true;
    });
  }

  function fallbackOnce(url, lin) {
    if (!enabled) return;
    const el = document.createElement('audio');
    el.src = url;
    el.volume = clamp01(lin);
    el.play().catch(() => {});
  }

  /* playShot(id): 'fx_nudge', 'fx_levelup', … an alarm id or 'alarm_bell', or 'tick'.
     fx and nudge play at alarmVolume and duck the music −6 dB. */
  function playShot(id) {
    const s = settings();
    const key = String(id || '').replace(/\.wav$/i, '');
    if (!key || !/^[a-z0-9_-]+$/i.test(key)) return Promise.resolve(false);
    const alarm = (Store.ALARMS || []).find((a) => a.id === key || a.file === `${key}.wav`);
    if (alarm) return playBuffer(`${SOUND_DIR}${alarm.file}`, clamp01(s.alarmVolume) * PFSound.dbToGain(alarmGainDb(alarm.id)), 'alarm');
    if (key === 'tick') return playBuffer(`${SOUND_DIR}tick.wav`, clamp01(s.tickVolume), null);
    const kind = /nudge/.test(key) ? 'nudge' : 'fx';
    return playBuffer(`${SOUND_DIR}${key}.wav`, clamp01(s.alarmVolume == null ? 0.8 : s.alarmVolume), kind);
  }

  // ── alarm ──

  function playAlarm() {
    const s = settings();
    const def = Store.ALARMS.find((a) => a.id === s.selectedAlarm) || Store.ALARMS[0];
    playBuffer(`${SOUND_DIR}${def.file}`, clamp01(s.alarmVolume) * PFSound.dbToGain(alarmGainDb(def.id)), 'alarm');
  }

  function previewAlarm(id) {
    const def = Store.ALARMS.find((a) => a.id === id);
    if (!def) return;
    unlock();
    const s = settings();
    playBuffer(`${SOUND_DIR}${def.file}`, clamp01(s.alarmVolume == null ? 0.85 : s.alarmVolume) * PFSound.dbToGain(alarmGainDb(def.id)), 'alarm');
  }

  // ── ticking (never ducks) ──

  let ticking = null;
  let lastTickSecond = -1;

  function startTicking() {
    stopTicking();
    lastTickSecond = -1;
    ticking = setInterval(() => {
      const s = settings();
      if (!s.tickingEnabled || !enabled) return;
      let remaining = 0;
      try { remaining = Timer.remaining(); } catch (_) { return; }
      const whole = Math.ceil(remaining);
      if (whole !== lastTickSecond) {
        lastTickSecond = whole;
        playBuffer(`${SOUND_DIR}tick.wav`, clamp01(s.tickVolume), null);
      }
    }, 200);
  }

  function stopTicking() {
    if (ticking) { clearInterval(ticking); ticking = null; scheduleIdleSuspend(); }
  }

  // ── ambience: random-segment crossfade beds (v2-sound §5.10) ──
  /* Each bed plays an endless chain of segments of the decoded loop
     (PFSound.ambienceSegment: 5.5–8.5 s, equal-power overlaps ≤ 2 s), scheduled two
     segments ahead on the AudioContext clock by a 1 s tick: nothing repeats in order,
     no `loop` gap, no clicks. */
  let bed = null;            // the bed you hear: {id, norm, fade, buffer, k, nextAt, prevFade, nodes, timer, seed}
  let ambEl = null;          // fallback element (no WebAudio)
  let ambStartToken = 0;

  function ambId() { const s = settings(); return s.selectedAmbience || 'none'; }

  function startAmbience() {
    const def = Store.AMBIENCES.find((a) => a.id === ambId());
    if (!def || !def.file) { stopAmbience(); return; }
    if (!hasActivation()) { pendingStart.amb = true; return; }
    const fadeSec = M.pendingAmbFade && Date.now() - M.pendingAmbFade.at < 1500 ? M.pendingAmbFade.sec : FADES.resume;
    M.pendingAmbFade = null;
    if (!ensureGraph()) { fallbackAmbience(def); return; }
    resumeCtx();
    if (bed && bed.id === def.id && !bed.stopping) { rampParam(bed.fade.gain, 1, fadeSec, 'sine'); return; }
    if (bed) retireBed(bed, FADES.stop);
    const token = ++ambStartToken;
    const b = {
      id: def.id, norm: gain(PFSound.dbToGain(ambGainDb(def.id))), fade: gain(0), buffer: null, k: 0, nextAt: 0,
      prevFade: 0, nodes: [], timer: 0, seed: new Date().toISOString(), stopping: false,
    };
    b.norm.connect(b.fade);
    b.fade.connect(G.ambVol);
    bed = b;
    decode(`${SOUND_DIR}${def.file}`).then((buf) => {
      if (token !== ambStartToken || bed !== b || b.stopping || !buf) return;
      b.buffer = buf;
      b.nextAt = ctx.currentTime + 0.05;
      scheduleBed(b);
      b.timer = setInterval(() => scheduleBed(b), 1000);
      rampParam(b.fade.gain, 1, fadeSec, 'sine', b.nextAt);
    });
  }

  function scheduleBed(b) {
    if (!b.buffer || b.stopping) return;
    const horizon = ctx.currentTime + 2 * 8.5;
    const dur = b.buffer.duration;
    let guard = 0;
    if (b.nextAt < ctx.currentTime) b.nextAt = ctx.currentTime + 0.02;   // the clock ran ahead (suspended context)
    while (b.nextAt < horizon && guard++ < 8) {
      const seg = PFSound.ambienceSegment(b.id, b.k, b.seed, dur);
      const src = ctx.createBufferSource();
      src.buffer = b.buffer;
      const g = ctx.createGain();
      const start = b.nextAt;
      const end = start + seg.length;
      try {
        if (b.k > 0 && b.prevFade > 0) g.gain.setValueCurveAtTime(Float32Array.from(PFSound.equalPowerCurve(64, true)), start, b.prevFade);
        if (seg.fade > 0) g.gain.setValueCurveAtTime(Float32Array.from(PFSound.equalPowerCurve(64, false)), end - seg.fade, seg.fade);
      } catch (_) { /* overlapping curves on a pathological buffer: plays without the fade */ }
      src.connect(g);
      g.connect(b.norm);
      src.start(start, seg.offset, seg.length);
      const node = { src, g };
      src.onended = () => { try { g.disconnect(); } catch (_) {} b.nodes = b.nodes.filter((n) => n !== node); };
      b.nodes.push(node);
      b.prevFade = seg.fade;
      b.nextAt = start + seg.length - seg.fade;
      b.k += 1;
    }
  }

  function retireBed(b, fadeSec) {
    if (!b || b.stopping) return;
    b.stopping = true;
    clearInterval(b.timer);
    if (ctx) rampParam(b.fade.gain, 0, fadeSec, 'sine');
    setTimeout(() => {
      for (const n of b.nodes) { try { n.src.stop(); } catch (_) {} try { n.g.disconnect(); } catch (_) {} }
      b.nodes = [];
      try { b.fade.disconnect(); } catch (_) {}
      scheduleIdleSuspend();
    }, fadeSec * 1000 + 80);
  }

  function pauseAmbience() {
    pendingStart.amb = false;
    if (ambEl) ambEl.pause();
    if (bed) { const b = bed; bed = null; ambStartToken++; retireBed(b, FADES.pause); }
  }

  function stopAmbience() {
    pendingStart.amb = false;
    if (ambEl) { ambEl.pause(); ambEl.removeAttribute('src'); ambEl = null; }
    if (bed) { const b = bed; bed = null; ambStartToken++; retireBed(b, FADES.stop); }
  }

  function fallbackAmbience(def) {
    if (ambEl && ambEl.dataset.id === def.id) { ambEl.play().catch(() => {}); return; }
    if (ambEl) { ambEl.pause(); ambEl = null; }
    ambEl = document.createElement('audio');
    ambEl.src = `${SOUND_DIR}${def.file}`;
    ambEl.loop = true;
    ambEl.dataset.id = def.id;
    ambEl.volume = clamp01(PFSound.sliderToGain(settings().ambienceVolume) * PFSound.dbToGain(ambGainDb(def.id)));
    ambEl.play().catch(() => {});
  }

  function previewAmbience(id) {
    const def = Store.AMBIENCES.find((a) => a.id === id);
    if (!def || !def.file) return;
    unlock();
    if (!G) { fallbackOnce(`${SOUND_DIR}${def.file}`, 0.5); return; }
    decode(`${SOUND_DIR}${def.file}`).then((buf) => {
      if (!buf || !enabled) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const g = gain(0);
      src.connect(g);
      g.connect(G.ambVol);
      const now = ctx.currentTime;
      const lvl = PFSound.dbToGain(ambGainDb(def.id));
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(lvl, now + 0.4);
      g.gain.setValueAtTime(lvl, now + 5.2);
      g.gain.linearRampToValueAtTime(0, now + 6);
      shotsLive += 1;
      src.start(now);
      src.stop(now + 6.05);
      src.onended = () => { shotsLive = Math.max(0, shotsLive - 1); try { g.disconnect(); } catch (_) {} scheduleIdleSuspend(); };
    });
  }

  // ── previews (8 s; duck the music −9 dB) ──

  const preview = { el: null, node: null, gain: null, timer: 0, track: null };

  function previewMusic(trackId) {
    const t = trackById(trackId);
    if (!t) return;
    unlock();
    stopPreview(true);
    const el = document.createElement('audio');
    el.preload = 'auto';
    el.src = t.src;
    preview.el = el;
    preview.track = t;
    if (G) {
      try {
        preview.node = ctx.createMediaElementSource(el);
        preview.gain = gain(0);
        preview.node.connect(preview.gain);
        preview.gain.connect(G.master);
        const lvl = deckGainLin(t) * PFSound.sliderToGain(settings().musicVolume);
        const g = preview.gain;
        el.addEventListener('playing', () => { if (preview.el === el) rampParam(g.gain, lvl, 0.3, 'sine'); }, { once: true });
      } catch (_) { el.volume = 0.55; }
    } else {
      el.volume = clamp01(PFSound.sliderToGain(settings().musicVolume));
    }
    if (t.inSec) try { el.currentTime = t.inSec; } catch (_) {}
    el.play().catch(() => {});
    duck('preview', 8000);
    emit('music:preview', { track: t, playing: true });
    preview.timer = setTimeout(() => stopPreview(false), 8000);
  }

  function stopPreview(now) {
    clearTimeout(preview.timer);
    const el = preview.el, g = preview.gain, node = preview.node;
    if (!el) return;
    preview.el = null; preview.gain = null; preview.node = null; preview.track = null;
    const end = () => {
      try { el.pause(); } catch (_) {}
      el.removeAttribute('src');
      try { if (node) node.disconnect(); if (g) g.disconnect(); } catch (_) {}
      scheduleIdleSuspend();
    };
    if (g && !now) { rampParam(g.gain, 0, 0.6, 'sine'); setTimeout(end, 650); } else end();
    emit('music:preview', { track: null, playing: false });
  }

  // ── ducking (v2-sound §5.4) ──

  let ducks = [];

  function duck(kind, holdMs) {
    if (!G) return;
    const k = PFSound.DUCK[kind] ? kind : 'fx';
    const now = ctx.currentTime;
    const hold = Math.max(0, Number(holdMs) || 0);
    const endOf = (x) => x.t0 + (PFSound.DUCK[x.kind].attackMs + x.hold + 300 + PFSound.DUCK[x.kind].releaseMs) / 1000;
    ducks = ducks.filter((x) => endOf(x) > now);
    ducks.push({ kind: k, t0: now, hold });
    const end = Math.max(...ducks.map(endOf));
    const at = (t) => PFSound.combineDucks(ducks.map((x) => PFSound.duckGainAt(x.kind, (t - x.t0) * 1000, x.hold)));
    for (const p of [G.musicDuck.gain, G.ambDuck.gain]) {
      holdParam(p, now);
      let last = -1;
      for (let t = now + 0.02; t < end; t += 0.02) {
        const v = at(t);
        if (Math.abs(v - last) < 1e-4 && Math.abs(at(t + 0.02) - v) < 1e-4) continue;   // flat hold: skip points
        try { p.linearRampToValueAtTime(v, t); } catch (_) {}
        last = v;
      }
      try { p.linearRampToValueAtTime(1, end + 0.02); } catch (_) {}
    }
  }

  // ── level (visualiser, v2-sound §6.5) ──

  let freq = null, td = null, lastLevelAt = 0;
  const lv = { rms: 0, low: 0, mid: 0, high: 0 };

  function bandLevel(f0, f1, binHz) {
    const a = Math.max(1, Math.floor(f0 / binHz));
    const b = Math.min(freq.length - 1, Math.ceil(f1 / binHz));
    let sum = 0, n = 0;
    for (let i = a; i <= b; i++) { const db = freq[i]; if (isFinite(db)) sum += Math.pow(10, db / 10); n += 1; }
    if (!n || sum <= 0) return 0;
    return clamp01((10 * Math.log10(sum / n) + 70) / 50);
  }

  function rmsDb() {
    if (!G) return -Infinity;
    if (!td) td = new Float32Array(G.analyser.fftSize);
    G.analyser.getFloatTimeDomainData(td);
    let s = 0;
    for (let i = 0; i < td.length; i++) s += td[i] * td[i];
    const r = Math.sqrt(s / td.length);
    return r > 0 ? 20 * Math.log10(r) : -Infinity;
  }

  /* Pull-based and cheap: call from one rAF loop. {rms, bands:[low, mid, high]} 0…1,
     attack 60 ms / release 240 ms. */
  function level() {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const dt = lastLevelAt ? Math.min(0.5, Math.max(0.001, (now - lastLevelAt) / 1000)) : 0.016;
    lastLevelAt = now;
    let x = { rms: 0, low: 0, mid: 0, high: 0 };
    if (G && isMusicPlaying() && ctx.state === 'running') {
      if (!freq) freq = new Float32Array(G.analyser.frequencyBinCount);
      G.analyser.getFloatFrequencyData(freq);
      const binHz = ctx.sampleRate / G.analyser.fftSize;
      x = { rms: clamp01((rmsDb() + 70) / 50), low: bandLevel(40, 250, binHz), mid: bandLevel(250, 2000, binHz), high: bandLevel(2000, 8000, binHz) };
    }
    const up = 1 - Math.exp(-dt / 0.06), down = 1 - Math.exp(-dt / 0.24);
    for (const k of ['rms', 'low', 'mid', 'high']) lv[k] += (x[k] - lv[k]) * (x[k] > lv[k] ? up : down);
    return { rms: lv.rms, bands: [lv.low, lv.mid, lv.high] };
  }

  // Debug (A5): the longest run of music-bus RMS below −50 dBFS during a crossfade.
  let lastRmsReport = null;
  function watchRms(overlap) {
    if (!G) return;
    let below = 0, worst = 0, min = 0, last = Date.now();
    const until = Date.now() + (overlap + 1.0) * 1000;
    const iv = setInterval(() => {
      const db = rmsDb();
      const now = Date.now(), dt = Math.min(1000, now - last);
      last = now;
      min = Math.min(min, isFinite(db) ? db : -200);
      if (!(db > -50)) { below += dt; worst = Math.max(worst, below); } else below = 0;
      if (Date.now() > until) {
        clearInterval(iv);
        lastRmsReport = { minDb: Math.round(min * 10) / 10, longestBelowMs: worst };
        dlog(`crossfade rms: min ${lastRmsReport.minDb} dBFS · longest run < −50 dBFS ${worst} ms`);
      }
    }, 50);
  }

  // ── global mute ──

  function setEnabled(v) {
    enabled = !!v;
    if (G) {
      // Decks keep running so unmute is seamless (v2-sound §5.6).
      rampParam(G.master.gain, enabled ? 1 : 0, 0.15, 'linear');
      if (plain) for (const d of decks) fallbackVolume(d);
      if (!enabled) stopTicking();
      else if (timerFocusRunning()) { startTicking(); if (!bed) startAmbience(); }
      return;
    }
    if (!enabled) {
      stopTicking();
      if (ambEl) ambEl.pause();
      for (const d of decks) { try { d.el.pause(); } catch (_) {} }
    } else if (timerFocusRunning()) {
      startTicking();
      startAmbience();
      if (M.playing && M.track) playEl(activeDeck());
    }
  }

  function isEnabled() { return enabled; }

  // ── wiring (once, after the other modules exist) ──

  function migrateVolumes() {
    // One-time v2 volume migration: a v1 linear volume v becomes slider √v (same loudness).
    try {
      Store.migrate('audio-v2', () => {
        const s = Store.settings();
        if (!s.audioV2Migrated) {
          Store.setSetting('musicVolume', PFSound.gainToSlider(s.musicVolume));
          Store.setSetting('ambienceVolume', PFSound.gainToSlider(s.ambienceVolume));
        }
        Store.setSetting('audioV2Migrated', true);
      });
    } catch (err) { dlog('audio-v2 migration failed', err); }
  }

  let wired = false;
  function wireOnce() {
    if (wired) return;
    wired = true;
    P = loadPlayerState();
    migrateVolumes();
    M.sourceId = source();
    onSettingsChange();
    try {
      Store.on('change', (kind) => {
        if (kind !== 'settings' && kind !== 'bulk' && kind !== 'remote' && kind !== 'reset') return;
        if (kind === 'reset' || kind === 'remote') migrateVolumes();
        onSettingsChange();
        // Let an explicit playMusic(id) in the same task win over the generic source switch.
        if (source() !== M.sourceId) {
          const at = Date.now();
          setTimeout(() => { if (M.lastExplicit < at) applySourceChange(false); else M.sourceId = source(); }, 0);
        }
      });
    } catch (_) {}
    try {
      if (typeof Timer !== 'undefined' && Timer.on) {
        Timer.on('start', (p) => {
          if (!p || p.mode !== 'focus') return;
          resetSessionLog();
          M.pendingFade = { sec: FADES.start, at: Date.now() };
          M.pendingAmbFade = { sec: FADES.start, at: Date.now() };
        });
        Timer.on('resume', (p) => {
          if (!p || p.mode !== 'focus') return;
          M.pendingFade = { sec: FADES.resume, at: Date.now() };
          M.pendingAmbFade = { sec: FADES.resume, at: Date.now() };
        });
        Timer.addSessionExtra((c) => {
          if (!c || c.mode !== 'focus') return null;
          const stats = sessionMusicStats();
          const spent = Math.max(0, Number(c.minutes) || 0) * 60;
          // Only a session where music played for the majority of the focus time records a
          // genre. A few minutes of background music in a 50-minute session records nothing.
          const enough = spent > 0 && stats.seconds >= spent * 0.5;
          return { music: enough ? (stats.genre || null) : null };
        });
      }
    } catch (_) {}
    if (typeof document !== 'undefined') {
      document.addEventListener('pointerdown', onGesture, true);
      document.addEventListener('keydown', onGesture, true);
      // a touch pointerdown doesn't count as a user gesture on iOS: the end of the tap does
      document.addEventListener('touchend', onGesture, true);
      document.addEventListener('click', onGesture, true);
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) savePlayerState();
        else {
          resumeCtx();
          // Browsers may pause an <audio> element while the tab is hidden or after
          // the device wakes; resume it rather than waiting for a reload.
          if (M.playing && !M.deferred && M.track && activeDeck().el.paused && !activeDeck().el.ended) fadeInActive(FADES.resume);
          emitProgress(true);
        }
      });
    }
    if (typeof window !== 'undefined') window.addEventListener('pagehide', savePlayerState);
  }

  // Re-filter when the plan arrives or changes, without reloading music.json.
  if (typeof Plan !== 'undefined' && Plan.onChange) {
    Plan.onChange(() => { if (!loaded) return; applyPlanFilter(); emit('music', musicPayload()); });
  }

  return {
    // v2 (v2-sound §5.7)
    unlock, stations, source, setSource, upNext, musicStatus, retryMusic, like, isLiked, hide, isHidden, hiddenTracks, level, duck, sessionMusicGenre, sessionMusicStats, credits, playShot,
    // v1 names
    loadCatalogue, tracks, genres, trackById, tracksOfGenre,
    playAlarm, previewAlarm,
    startTicking, stopTicking,
    startAmbience, pauseAmbience, stopAmbience, previewAmbience,
    playMusic, pauseMusic, stopMusic, toggleMusic, nextMusic, previousMusic, previewMusic,
    seekMusic, musicElapsed, musicDuration, musicProgress,
    currentTrack, isMusicPlaying,
    setMusicVolume, setAmbienceVolume,
    setEnabled, isEnabled,
    // extras for the player UI
    genreInfo, sourceInfo, clearHistory, stopPreview,
    isLoading: () => loading,
    isPlain: () => plain,
    catalogueVersion: () => catalogueMeta.version,
    previewing: () => preview.track,
    // read-only debug view (tests, ?debugAudio=1)
    _debug: () => ({
      status: ST.state, plain, ctx: ctx ? ctx.state : 'none', ctxTime: ctx ? ctx.currentTime : 0, playing: M.playing, deferred: M.deferred, track: M.track && M.track.id,
      next: M.next && M.next.id, plan: M.plan ? Object.assign({}, M.plan) : null, active: M.active,
      transition: M.transition ? { from: M.transition.from && M.transition.from.id, to: M.transition.to.id, overlap: M.transition.overlap } : null,
      decks: decks.map((d) => ({ track: d.track && d.track.id, paused: d.el.paused, t: d.el.currentTime, fade: d.fade ? d.fade.gain.value : null, norm: d.normLin })),
      musicVol: G ? G.musicVol.gain.value : null, duck: G ? G.musicDuck.gain.value : null, master: G ? G.master.gain.value : null,
      bed: bed ? { id: bed.id, k: bed.k, nodes: bed.nodes.length } : null, log: Array.from(sessionLog.entries()),
      rms: lastRmsReport, rmsDb: G ? rmsDb() : null, player: JSON.parse(JSON.stringify(P)),
    }),
  };
})();
