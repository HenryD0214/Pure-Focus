/* v2-sound-reference.js — PFSound: the pure, shared rules of the v2 player and the
   seamless scene loop (SOUND_VERSION 1). No DOM, no WebAudio, no timers: both platforms
   port these functions 1:1 and must reproduce v2-sound-reference.test.js.

   Web:  copy verbatim to WEB/js/soundcore.js (global PFSound), load before audio.js and scenes.js.
   Mac:  PureFocusCore/Core/SoundCore.swift, `enum SoundCore` with the same names; reuse
         Engagement.fnv1a32 / xorshift32 (identical algorithms, see engagement-reference.js).
   Run:  $JSC v2-sound-reference.js v2-sound-reference.test.js   → "OK n/n"
*/
const PFSound = (() => {
  'use strict';
  const SOUND_VERSION = 1;

  // ── small math ──
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const clamp01 = (x) => clamp(Number(x) || 0, 0, 1);
  const round1 = (x) => Math.round(x * 10) / 10;
  const round2 = (x) => Math.round(x * 100) / 100;
  const round4 = (x) => Math.round(x * 10000) / 10000;

  function utf8(str) {
    const s = unescape(encodeURIComponent(String(str)));
    const out = new Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  // Identical to Engagement.fnv1a32 / xorshift32 (engagement-reference.js).
  function fnv1a32(str) {
    let h = 0x811c9dc5;
    const bytes = utf8(str);
    for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
  }
  function xorshift32(seed) {
    let x = (seed >>> 0) || 0x9e3779b9;
    return function next() { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
  }
  /** A deterministic uniform number in [0, 1) for a string key. */
  function unit(key) { return xorshift32(fnv1a32(key))() / 4294967296; }

  // ── volume and gain ──
  /** Settings sliders (musicVolume, ambienceVolume) are perceptual positions 0…1; output amplitude = v². */
  function sliderToGain(v) { const x = clamp01(v); return x * x; }
  /** One-time migration of a v1 linear volume (element.volume) to a v2 slider: same loudness. */
  function gainToSlider(g) { return round4(Math.sqrt(clamp01(g))); }
  function dbToGain(db) { return Math.pow(10, db / 20); }
  function gainToDb(g) { return g > 0 ? 20 * Math.log10(g) : -Infinity; }

  /** dB applied to a deck: catalogue normalisation + genre focus trim (+ optional personal trim). */
  function deckGainDb(track, genre, opts) {
    const o = opts || {};
    const norm = o.normalize === false ? 0 : Number(track && track.gainDb) || 0;
    const trim = o.normalize === false ? 0 : Number(genre && genre.trimDb) || 0;
    const personal = Number(o.personalTrimDb) || 0;
    return round1(clamp(norm + trim + personal, -24, 12));
  }
  /** Linear gain from deck input to speakers before ducking/mute: deck dB × slider². */
  function outputGain(track, genre, slider, opts) {
    return round4(dbToGain(deckGainDb(track, genre, opts)) * sliderToGain(slider));
  }

  // ── crossfades ──
  /**
   * When to start the next track and how long both overlap.
   * cur/next: catalogue tracks {durationSec, inSec, outSec, tailFadeSec}; genre: {crossfadeSec}.
   * crossfadeSec 0 → gapless (next starts exactly at cur.outSec, no overlap).
   * Otherwise the overlap follows the track's own fade-out: max(base, min(tailFade, base + 3)),
   * clamped to [1, min(8, 25 % of either track)].
   */
  function crossfadePlan(cur, next, genre) {
    const dur = Number(cur.durationSec) || 0;
    const outSec = clamp(cur.outSec == null ? dur : Number(cur.outSec), Math.min(1, dur), dur);
    const nd = Number(next.durationSec) || 0;
    const nextIn = clamp(Number(next.inSec) || 0, 0, Math.max(0, nd - 1));
    const base = genre && genre.crossfadeSec != null ? Number(genre.crossfadeSec) : 3;
    if (!base) return { gapless: true, startAt: round2(outSec), overlap: 0, nextIn: round2(nextIn) };
    const want = Math.max(base, Math.min(Number(cur.tailFadeSec) || 0, base + 3));
    const overlap = round2(clamp(want, 1, Math.min(8, 0.25 * dur, 0.25 * nd)));
    return { gapless: false, startAt: round2(outSec - overlap), overlap, nextIn: round2(nextIn) };
  }
  /** Equal-power gain at fraction t∈[0,1] of a crossfade: out = cos(tπ/2), in = sin(tπ/2). */
  function equalPower(t) {
    const x = clamp(t, 0, 1) * Math.PI / 2;
    return { out: round4(Math.cos(x)), in: round4(Math.sin(x)) };
  }
  /** n samples (n ≥ 2) of the incoming (fadeIn=true) or outgoing curve, for setValueCurveAtTime. */
  function equalPowerCurve(n, fadeIn) {
    const a = [];
    for (let i = 0; i < n; i++) { const p = equalPower(i / (n - 1)); a.push(fadeIn ? p.in : p.out); }
    return a;
  }
  /** Short fades used by transport (smooth start/pause/seek), in seconds. */
  const FADES = Object.freeze({ start: 2.4, resume: 0.8, pause: 1.2, stop: 1.2, seekOut: 0.12, seekIn: 0.18, skip: 0.6 });

  // ── ducking (alarms, celebration fx, guard nudges, previews) ──
  const DUCK = Object.freeze({
    alarm:   { depthDb: -12, attackMs: 120, releaseMs: 900 },
    fx:      { depthDb: -6,  attackMs: 60,  releaseMs: 500 },
    nudge:   { depthDb: -6,  attackMs: 60,  releaseMs: 500 },
    preview: { depthDb: -9,  attackMs: 120, releaseMs: 600 },
  });
  /** Duck gain (linear) at tMs after the trigger for a sound lasting holdMs. Linear in dB. */
  function duckGainAt(kind, tMs, holdMs) {
    const d = DUCK[kind] || DUCK.fx;
    const hold = Math.max(0, Number(holdMs) || 0) + 300;
    let db;
    if (tMs <= 0) db = 0;
    else if (tMs < d.attackMs) db = d.depthDb * (tMs / d.attackMs);
    else if (tMs < d.attackMs + hold) db = d.depthDb;
    else if (tMs < d.attackMs + hold + d.releaseMs) db = d.depthDb * (1 - (tMs - d.attackMs - hold) / d.releaseMs);
    else db = 0;
    return round4(dbToGain(db));
  }
  /** Several overlapping ducks combine by taking the deepest (smallest gain). */
  function combineDucks(gains) { return gains.length ? Math.min(...gains) : 1; }

  // ── stations (shuffle by mood) ──
  /**
   * Does a track belong to a station? filter: {genres?, energyMin?, energyMax?, moodsAny?}.
   * A plain genre "station" is {genres:[genre]}.
   */
  function inStation(track, filter) {
    const f = filter || {};
    if (f.genres && f.genres.length && f.genres.indexOf(track.genre) < 0) return false;
    if (f.energyMin != null && track.energy < f.energyMin) return false;
    if (f.energyMax != null && track.energy > f.energyMax) return false;
    if (f.moodsAny && f.moodsAny.length && !(track.moods || []).some((m) => f.moodsAny.indexOf(m) >= 0)) return false;
    return true;
  }
  function stationPool(tracks, filter) {
    return tracks.filter((t) => inStation(t, filter)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  /**
   * Weighted, deterministic shuffle step.
   * state: {history: [ids, newest first], liked: [ids], plays: {id: n}, earlySkips: {id: n (last 14 days)},
   *         counter: n (increments per pick), dayKey: "YYYY-MM-DD"}
   * Returns {id, weights} (weights in pool order, rounded) or null for an empty pool.
   */
  function nextTrack(pool, state, stationId) {
    if (!pool.length) return null;
    const st = state || {};
    const history = st.history || [];
    const liked = new Set((st.liked || []).map((s) => String(s).toLowerCase()));
    const plays = st.plays || {};
    const skips = st.earlySkips || {};
    const prevId = history[0];
    const prev = pool.find((t) => t.id === prevId) || (st.prevTrack || null);
    const recentN = Math.min(12, Math.floor(pool.length / 2));
    const recent = new Set(history.slice(0, recentN));
    const w = pool.map((t) => {
      if (recent.has(t.id)) return 0;
      let x = 1;
      if (liked.has(t.id)) x *= 2;
      if (prev && t.artist === prev.artist) x *= 0.35;
      if (prev && Math.abs((t.energy || 3) - (prev.energy || 3)) >= 2) x *= 0.25;
      if ((skips[t.id] || 0) >= 2) x *= 0.3;
      if (!plays[t.id]) x *= 1.3;
      return x;
    });
    const total = w.reduce((a, b) => a + b, 0);
    if (total <= 0) {
      // Everything was played recently: take the one heard longest ago (or never).
      let best = pool[0], bestAge = -1;
      for (const t of pool) {
        const i = history.indexOf(t.id);
        const age = i < 0 ? Infinity : i;
        if (age > bestAge) { best = t; bestAge = age; }
      }
      return { id: best.id, weights: w.map(round4) };
    }
    const r = unit('pf-station-v1:' + stationId + ':' + (st.dayKey || '') + ':' + (st.counter || 0)) * total;
    let acc = 0;
    for (let i = 0; i < pool.length; i++) {
      acc += w[i];
      if (r < acc && w[i] > 0) return { id: pool[i].id, weights: w.map(round4) };
    }
    const last = w.map((x, i) => (x > 0 ? i : -1)).filter((i) => i >= 0).pop();
    return { id: pool[last].id, weights: w.map(round4) };
  }
  /** A skip is "early" when the user skipped within the first 30 s of the track. */
  function isEarlySkip(playedSec) { return playedSec < 30; }

  /** The genre written to a logged session's `music` field: most seconds played; ties → first seen. */
  function dominantGenre(log) {
    const sum = new Map();
    for (const e of log || []) sum.set(e.genre, (sum.get(e.genre) || 0) + (Number(e.seconds) || 0));
    let best = null, bestS = 0, total = 0;
    for (const [g, s] of sum) { total += s; if (s > bestS) { best = g; bestS = s; } }
    return total >= 30 ? best : null;
  }

  // ── seamless scene loops ──
  const LOOP_FADE = Object.freeze({ excellent: 1.0, good: 1.5, fair: 2.2, unverified: 1.5 });
  const LOOP_LEAD = 0.35;   // start the standby this long before its fade, so its first frame is on screen
  /** {loopIn, loopOut, fade, lead, jitterMax} for a scenes.json entry (optional loopIn/loopOut/loopFade). */
  function sceneLoopPlan(scene) {
    const d = Number(scene.durationSec) || 0;
    const loopIn = clamp(Number(scene.loopIn) || 0, 0, Math.max(0, d - 2));
    const loopOut = clamp(scene.loopOut == null ? d - 0.1 : Number(scene.loopOut), loopIn + 2, d);
    const span = loopOut - loopIn;
    const base = scene.loopFade != null ? Number(scene.loopFade) : (LOOP_FADE[scene.loopQuality] || 1.5);
    const fade = round2(clamp(base, 0.6, 0.22 * span));
    return { loopIn: round2(loopIn), loopOut: round2(loopOut), fade, lead: LOOP_LEAD, jitterMax: round2(Math.min(2, 0.12 * span)) };
  }
  /** Where pass n (0 = first) starts. Pass 0 starts at loopIn; later passes jitter forward a little. */
  function passInPoint(scene, pass) {
    const p = sceneLoopPlan(scene);
    if (!pass) return p.loopIn;
    return round2(p.loopIn + unit('pf-loop-v1:' + scene.id + ':' + pass) * p.jitterMax);
  }
  /** Media time of the active pass at which the standby must start playing (fade starts on its first frame). */
  function standbyStartAt(scene) {
    const p = sceneLoopPlan(scene);
    return round2(p.loopOut - p.fade - p.lead);
  }
  /**
   * Slow "drift" transform at time t (s, wall clock since the scene appeared) so repeated passes never
   * line up on screen. Periods 97/113/131 s are co-prime with every clip length, scale stays in
   * [1.03, 1.06] and |x|, |y| ≤ 1.2 % so the video always covers the stage ((scale − 1) / 2 ≥ 1.5 %).
   */
  function driftAt(t) {
    const s = 1.045 + 0.015 * Math.sin(2 * Math.PI * t / 97);
    const x = 0.012 * Math.sin(2 * Math.PI * t / 131);
    const y = 0.008 * Math.cos(2 * Math.PI * t / 113);
    return { scale: round4(s), x: round4(x), y: round4(y) };   // x, y as fractions of the stage size
  }

  // ── ambience: random-segment crossfade looping (no audible repeat of a short loop) ──
  /**
   * Segment k of an ambience bed: play `length` s of the decoded buffer from `offset`, overlapping the
   * next segment by `fade` s (equal-power). Segment k+1 starts `length − fade` s after segment k.
   * sessionSeed: any string that changes per playback start (e.g. the start ISO time).
   */
  function ambienceSegment(ambId, index, sessionSeed, bufferSec) {
    const key = 'pf-amb-v1:' + ambId + ':' + sessionSeed + ':' + index;
    const len = round2(Math.min(bufferSec, 5.5 + 3 * unit(key + ':len')));
    const floor2 = (x) => Math.floor(x * 100 + 1e-9) / 100;   // floor, so offset + length ≤ bufferSec
    const offset = floor2(Math.max(0, (bufferSec - len) * unit(key + ':off')));
    return { offset, length: len, fade: floor2(Math.min(2, len / 3)) };
  }

  return {
    SOUND_VERSION, FADES, DUCK, LOOP_FADE, LOOP_LEAD,
    ambienceSegment,
    fnv1a32, xorshift32, unit,
    sliderToGain, gainToSlider, dbToGain, gainToDb, deckGainDb, outputGain,
    crossfadePlan, equalPower, equalPowerCurve,
    duckGainAt, combineDucks,
    inStation, stationPool, nextTrack, isEarlySkip, dominantGenre,
    sceneLoopPlan, passInPoint, standbyStartAt, driftAt,
  };
})();
