/* ═══════════════════════════════════════════════════════════════════════
   engagement.js — Pure Focus engagement engine (web), ENGINE_VERSION 1
   = spec/engagement-reference.js VERBATIM, plus the SPEC §1.3.7 plan-XP patch
   (identical to Engagement.swift): compute() takes an optional
     plan = { xpByDay: {dayKey: Int}, plannedBlocks, onPlan, clockworkDays }
   and the four planning achievements (blueprint, on_schedule, clockwork,
   master_planner) are appended. With `plan` absent every v1 vector passes
   unchanged (TOOLS/tests/engagement-plan.test.js: 87 v1 checks + parity).
   Global `Engagement`; rewards.js aliases it as PFEngagement.
   Pure and DOM-free:
     Engagement.compute({ sessions, tasks, now, dailyGoalMinutes, plan }) -> state
   Owner after the contracts pass: W6. Do not edit the engine rules: the
   macOS port must produce identical numbers (engagement-vectors.json).
   ═══════════════════════════════════════════════════════════════════════ */

const Engagement = (() => {
  'use strict';

  // ── constants (any change re-scores history: bump ENGINE_VERSION) ──
  const C = Object.freeze({
    ENGINE_VERSION: 1,
    DEFAULT_SCHED: 25,          // minutes, when scheduledMinutes is missing/invalid
    SCHED_MAX: 180,
    CREDIT_SLACK: 15,           // credited minutes <= scheduled + 15 (sleep/wake inflation guard)
    QUALIFY_MIN: 10,            // qualified if credited >= max(5, min(10, 0.8 * scheduled))
    QUALIFY_FLOOR: 5,
    QUALIFY_FRACTION: 0.8,
    COMPLETE_TOL_CM: 50,        // completed if actual >= scheduled - 0.5 min
    BAND_FULL_CM: 30000,        // first 300 min of a day: 10 XP/min
    BAND_HALF_CM: 48000,        // 300..480 min: 5 XP/min; beyond 480: 0
    CM_PER_XP_FULL: 10,
    CM_PER_XP_HALF: 20,
    COMPLETION_PER_MIN: 2,      // completion bonus = 2 XP per scheduled minute, cap 100
    COMPLETION_CAP: 100,
    REFLECTION_XP: 20,          // for giving ANY rating (never for the rating's value)
    GOLDEN_MOD: 10,             // 1 in 10 completed sessions is Golden (minute XP doubled)
    STREAK_TIERS: [[60, 25], [30, 20], [14, 15], [7, 10], [3, 5], [1, 0]], // [minDays, +%]
    REST_EVERY: 5,              // a rest day is earned every 5 active streak days
    REST_MAX: 2,
    COMBO_MIN_GAP: 3,           // minutes; gap >= 3 = a real break -> combo grows
    COMBO_MAX_GAP: 45,          // minutes; gap > 45 -> combo resets
    COMBO_STEP_PCT: 5,
    COMBO_CAP_PCT: 20,
    GOAL_FALLBACK: 120,         // goal for legacy days whose sessions carry no snapshot
    GOAL_BONUS_PER_MIN: 2,      // goal bonus = 2 XP per goal minute (cap 480 min)
    GOAL_BONUS_CAP_MIN: 480,
    QUEST_XP: Object.freeze({ easy: 40, medium: 70, stretch: 120 }),
    SWEEP_XP: 70,
    STREAK_MILESTONES: [3, 7, 14, 30, 50, 100, 150, 200, 365],
    // Cumulative XP to REACH level i+1 (index 0 = level 1). xpToNext(L) = round50(250 * L^1.6).
    // Shipped as literals so both platforms agree exactly (never recompute with pow()).
    LEVEL_CUM: [0,250,1000,2450,4750,8050,12450,18050,25000,33400,43350,54950,68250,83400,100450,
      119500,140600,163850,189350,217150,247300,279900,315050,352800,393200,436300,482200,530950,
      582650,637300,695000,755850,819850,887100,957600,1031450,1108700,1189450,1273700,1361550,
      1453000,1548150,1647050,1749750,1856300,1966750,2081150,2199550,2322000,2448550,2579250,
      2714150,2853300,2996800,3144650,3296900,3453600,3614800,3780550,3950900,4125900,4305550,
      4489950,4679150,4873150,5072050,5275850,5484600,5698350,5917200,6141100,6370150,6604400,
      6843850,7088600,7338650,7594050,7854850,8121100,8392850,8670100,8952900,9241350,9535450,
      9835200,10140700,10451950,10769050,11092000,11420800,11755550,12096300,12443050,12795850,
      13154750,13519750,13890900,14268300,14651900,15041800],
  });

  const TIERS = [
    { id: 'spark',   name: 'Spark',   from: 1,  symbol: 'sparkle',               emoji: '✨', colors: ['#FFD166', '#FF9F43'], ink: '#3A2400', tagline: 'Every deep session starts with a spark.' },
    { id: 'glow',    name: 'Glow',    from: 6,  symbol: 'lightbulb.fill',        emoji: '💡', colors: ['#FFB86B', '#FF6B6B'], ink: '#3A1010', tagline: 'Your focus is starting to glow.' },
    { id: 'lantern', name: 'Lantern', from: 11, symbol: 'lamp.desk.fill',        emoji: '🏮', colors: ['#FF8FAB', '#C77DFF'], ink: '#FFFFFF', tagline: 'A steady light you can work by.' },
    { id: 'beacon',  name: 'Beacon',  from: 16, symbol: 'light.beacon.max.fill', emoji: '🗼', colors: ['#8AB4FF', '#3D7BD9'], ink: '#FFFFFF', tagline: 'Consistency others could navigate by.' },
    { id: 'aurora',  name: 'Aurora',  from: 21, symbol: 'sun.horizon.fill',      emoji: '🌌', colors: ['#6EE7A8', '#4DA8DA', '#9B7EDE'], ink: '#FFFFFF', tagline: 'Rare, luminous, unmistakably yours.' },
    { id: 'zenith',  name: 'Zenith',  from: 26, symbol: 'sun.max.fill',          emoji: '☀️', colors: ['#FFF3B0', '#FFD166', '#FFFFFF'], ink: '#3A2400', tagline: 'Focus at its highest point.' },
  ];
  const ROMAN = ['I', 'II', 'III', 'IV', 'V'];

  // ── calendar helpers: LOCAL time, calendar arithmetic (DST-safe) ──
  const pad2 = (n) => (n < 10 ? '0' : '') + n;
  function dayKey(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function keyToDate(k) { return new Date(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10)); }
  function addDays(k, n) { const d = keyToDate(k); d.setDate(d.getDate() + n); return dayKey(d); }
  function daysBetween(a, b) { return Math.round((keyToDate(b) - keyToDate(a)) / 86400000); }
  function weekStartKey(k) { return addDays(k, -keyToDate(k).getDay()); } // Sunday, like the app's week row

  // ── deterministic hashing / PRNG (bit-identical in Swift with UInt32 &* / &<<) ──
  function utf8(str) {
    const out = [];
    for (const ch of str) {
      const c = ch.codePointAt(0);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }
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
  function isGoldenId(id) { return fnv1a32('pf-golden-v1:' + String(id).toLowerCase()) % C.GOLDEN_MOD === 0; }

  // ── per-session derivation ──
  function derive(s) {
    const start = new Date(s.start);
    const end = new Date(s.end);
    let sched = Number(s.scheduledMinutes);
    if (!(sched > 0)) sched = C.DEFAULT_SCHED;
    sched = Math.min(Math.max(sched, 1), C.SCHED_MAX);
    const rawCm = Math.floor(Math.max(0, Number(s.minutes) || 0) * 100 + 0.5);
    const cm = Math.min(rawCm, Math.floor((sched + C.CREDIT_SLACK) * 100 + 0.5));
    const thrCm = Math.floor(Math.max(C.QUALIFY_FLOOR, Math.min(C.QUALIFY_MIN, C.QUALIFY_FRACTION * sched)) * 100 + 0.5);
    const qualified = s.mode === 'focus' && cm >= thrCm;
    const completed = qualified && rawCm >= Math.floor(sched * 100 + 0.5) - C.COMPLETE_TOL_CM;
    const g = s.goalMinutes;
    return {
      id: String(s.id), idLower: String(s.id).toLowerCase(), start, end,
      startMs: start.getTime(), endMs: end.getTime(), key: dayKey(start), sched, rawCm, cm,
      qualified, completed, golden: completed && isGoldenId(s.id),
      rating: s.focusRating == null || s.focusRating === '' ? null : Number(s.focusRating),
      taskId: s.taskID ? String(s.taskID).toLowerCase() : null,
      category: s.category ? String(s.category).trim().toLowerCase() : '',
      location: (() => {
        const list = Array.isArray(s.locations) && s.locations.length ? s.locations : (s.location ? [s.location] : []);
        const first = list.map((x) => String(x == null ? '' : x).trim().toLowerCase()).find(Boolean);
        return first || '';
      })(),
      locations: (() => {
        const list = Array.isArray(s.locations) && s.locations.length ? s.locations : (s.location ? [s.location] : []);
        const out = [];
        for (const raw of list) {
          const v = String(raw == null ? '' : raw).trim().toLowerCase();
          if (v && !out.includes(v)) out.push(v);
        }
        return out;
      })(),
      ambience: s.ambience && s.ambience !== 'none' ? String(s.ambience) : null,
      music: s.music ? String(s.music) : null,
      goal: g == null || g === '' || !Number.isFinite(Number(g)) ? null : Number(g),
      combo: 0, xp: 0, parts: null,
    };
  }

  function streakPct(days) { for (const [min, pct] of C.STREAK_TIERS) if (days >= min) return pct; return 0; }

  /* XP for one session given the day's focus centi-minutes logged BEFORE it.
     Shared by compute() and previewSessionXP() so the live preview is exact. */
  function sessionXP(s, beforeCm, streakPctToday) {
    const c = s.cm;
    const full = Math.min(Math.max(0, Math.min(beforeCm + c, C.BAND_FULL_CM) - beforeCm), c);
    const half = Math.min(Math.max(0, Math.min(beforeCm + c, C.BAND_HALF_CM) - Math.max(beforeCm, C.BAND_FULL_CM)), c);
    const base = Math.floor(full / C.CM_PER_XP_FULL) + Math.floor(half / C.CM_PER_XP_HALF);
    const fatigue = beforeCm < C.BAND_FULL_CM ? 100 : beforeCm < C.BAND_HALF_CM ? 50 : 0;
    const w = Math.floor(c / 100);
    let completion = 0, golden = 0, reflection = 0;
    if (s.qualified) {
      if (s.completed) completion = Math.floor(Math.min(C.COMPLETION_PER_MIN * Math.min(w, Math.trunc(s.sched)), C.COMPLETION_CAP) * fatigue / 100);
      if (s.golden) golden = base;
      if (s.rating != null) reflection = Math.floor(C.REFLECTION_XP * fatigue / 100);
    }
    const comboPct = s.qualified ? Math.min(Math.max(s.combo - 1, 0) * C.COMBO_STEP_PCT, C.COMBO_CAP_PCT) : 0;
    const raw = base + completion + golden + reflection;
    const xp = Math.floor(raw * (100 + streakPctToday) * (100 + comboPct) / 10000);
    return { xp, base, completion, golden, reflection, streakPct: streakPctToday, comboPct, fatigue };
  }

  // ── quests ──
  const QUESTS = {
    easy: [
      { id: 'q_show_up',  family: 'sessions', title: 'Show up',        text: 'Complete 1 focus session',        symbol: 'play.circle.fill',      emoji: '▶️' },
      { id: 'q_reflect',  family: 'reflect',  title: 'Reflect',        text: 'Rate 1 session',                  symbol: 'star.bubble.fill',      emoji: '💭' },
      { id: 'q_progress', family: 'task',     title: 'Make progress',  text: 'Focus on a task from your list',  symbol: 'checklist',             emoji: '📋' },
      { id: 'q_mood',     family: 'sound',    title: 'Set the mood',   text: 'Focus with music or ambience on', symbol: 'headphones',            emoji: '🎧' },
    ],
    medium: [
      { id: 'q_chain3',   family: 'combo',    title: 'Chain it',       text: 'Reach a ×3 combo',                symbol: 'link',                  emoji: '🔗' },
      { id: 'q_block',    family: 'minutes',  title: 'Focus block',    text: 'Focus {X} minutes today',         symbol: 'clock.fill',            emoji: '⏱️' },
      { id: 'q_recharge', family: 'rest',     title: 'Recharge',       text: 'Take 2 real breaks between sessions', symbol: 'cup.and.saucer.fill', emoji: '☕' },
      { id: 'q_mindful',  family: 'reflect',  title: 'Mindful',        text: 'Rate 2 sessions',                 symbol: 'star.bubble.fill',      emoji: '💭' },
      { id: 'q_spread',   family: 'task',     title: 'Spread out',     text: 'Focus on 2 different tasks',      symbol: 'square.stack.3d.up.fill', emoji: '🗂️' },
      { id: 'q_clean',    family: 'clean',    title: 'Clean finishes', text: 'Complete 2 sessions without skipping', symbol: 'checkmark.circle.fill', emoji: '✅' },
    ],
    stretch: [
      { id: 'q_ring',     family: 'goal',     title: 'Close your ring', text: 'Hit your daily goal',            symbol: 'target',                emoji: '🎯' },
      { id: 'q_full_set', family: 'clean',    title: 'Full set',       text: 'Complete 4 sessions without skipping', symbol: 'square.grid.2x2.fill', emoji: '🍅' },
      { id: 'q_push',     family: 'minutes',  title: 'Personal push',  text: 'Focus {Y} minutes today',         symbol: 'flame.fill',            emoji: '🔥' },
      { id: 'q_flow',     family: 'combo',    title: 'Flow chain',     text: 'Reach a ×4 combo',                symbol: 'wind',                  emoji: '🌀' },
    ],
  };

  function medianFloor(vals) {
    const v = vals.slice().sort((a, b) => a - b);
    const n = v.length;
    return n % 2 ? v[(n - 1) / 2] : Math.floor((v[n / 2 - 1] + v[n / 2]) / 2);
  }

  /* Deterministic for a date + the history BEFORE that date. priorDays = up to 14
     most recent active days' info (oldest first). */
  function generateQuests(key, priorDays, goalEnabled) {
    const next = xorshift32(fnv1a32('pf-quests-v1:' + key));
    next(); // warm-up
    const baseline = priorDays.length >= 3 ? medianFloor(priorDays.map((d) => Math.floor(d.cm / 100))) : 50;
    const X = Math.min(Math.max(15 * Math.floor((3 * baseline + 30) / 60), 30), 120);   // ≈0.75×baseline, nearest 15
    const Y = Math.min(Math.max(15 * Math.floor((11 * baseline + 75) / 150), 60), 240); // ≈1.1×baseline, nearest 15
    const e = QUESTS.easy[next() % QUESTS.easy.length];
    const mPool = QUESTS.medium.filter((q) => q.family !== e.family);
    const m = mPool[next() % mPool.length];
    const sPool = QUESTS.stretch.filter((q) => q.family !== e.family && q.family !== m.family && (q.id !== 'q_ring' || goalEnabled));
    const s = sPool[next() % sPool.length];
    const TARGET = { q_show_up: 1, q_reflect: 1, q_progress: 1, q_mood: 1, q_chain3: 3, q_block: X, q_recharge: 2,
      q_mindful: 2, q_spread: 2, q_clean: 2, q_ring: 1, q_full_set: 4, q_push: Y, q_flow: 4 };
    const quests = [['easy', e], ['medium', m], ['stretch', s]].map(([tier, q]) => ({
      ...q, tier, text: q.text.replace('{X}', X).replace('{Y}', Y), target: TARGET[q.id], reward: C.QUEST_XP[tier],
    }));
    return { quests, baseline };
  }

  function questProgress(q, d) {
    if (!d) return 0;
    switch (q.id) {
      case 'q_show_up': return d.qualified;
      case 'q_reflect': case 'q_mindful': return d.rated;
      case 'q_progress': return d.taskSessions > 0 ? 1 : 0;
      case 'q_mood': return d.soundSessions > 0 ? 1 : 0;
      case 'q_chain3': case 'q_flow': return d.maxCombo;
      case 'q_block': case 'q_push': return Math.floor(d.cm / 100);
      case 'q_recharge': return d.breaks;
      case 'q_spread': return d.tasks.size;
      case 'q_clean': case 'q_full_set': return d.completed;
      case 'q_ring': return d.goalHit ? 1 : 0;
      default: return 0;
    }
  }

  // ── achievements (metric -> value; unlocked when value >= target) ──
  const ACHIEVEMENTS = [
    { id: 'first_light',     name: 'First Light',     rarity: 'common',    group: 'milestones',  metric: 'qualified',    target: 1,   symbol: 'sparkle',                emoji: '✨', text: 'Complete your first focus session.' },
    { id: 'ten_sessions',    name: 'Double Digits',   rarity: 'common',    group: 'milestones',  metric: 'qualified',    target: 10,  symbol: '10.circle.fill',         emoji: '🔟', text: 'Complete 10 focus sessions.' },
    { id: 'century',         name: 'Century',         rarity: 'rare',      group: 'milestones',  metric: 'qualified',    target: 100, symbol: 'rosette',                emoji: '🏵️', text: 'Complete 100 focus sessions.' },
    { id: 'ten_hours',       name: 'Ten-Hour Club',   rarity: 'uncommon',  group: 'milestones',  metric: 'hours',        target: 10,  symbol: 'hourglass',              emoji: '⏳', text: 'Focus for 10 hours in total.' },
    { id: 'deep_roots',      name: 'Deep Roots',      rarity: 'epic',      group: 'milestones',  metric: 'hours',        target: 100, symbol: 'tree.fill',              emoji: '🌳', text: 'Focus for 100 hours in total.' },
    { id: 'kindled',         name: 'Kindled',         rarity: 'common',    group: 'consistency', metric: 'streak',       target: 3,   symbol: 'flame',                  emoji: '🔥', text: 'Reach a 3-day streak.' },
    { id: 'week_of_fire',    name: 'Week of Fire',    rarity: 'uncommon',  group: 'consistency', metric: 'streak',       target: 7,   symbol: 'flame.fill',             emoji: '🔥', text: 'Reach a 7-day streak.' },
    { id: 'unbroken',        name: 'Unbroken',        rarity: 'epic',      group: 'consistency', metric: 'streak',       target: 30,  symbol: 'calendar.badge.checkmark', emoji: '📅', text: 'Reach a 30-day streak.' },
    { id: 'hundred_days',    name: 'Hundred Days',    rarity: 'legendary', group: 'consistency', metric: 'streak',       target: 100, symbol: 'crown.fill',             emoji: '👑', text: 'Reach a 100-day streak.' },
    { id: 'steady_rhythm',   name: 'Steady Rhythm',   rarity: 'rare',      group: 'consistency', metric: 'rhythmWeeks',  target: 4,   symbol: 'metronome.fill',         emoji: '🎼', text: 'Focus on 4+ days a week, 4 weeks in a row.' },
    { id: 'welcome_back',    name: 'Welcome Back',    rarity: 'uncommon',  group: 'consistency', metric: 'comeback',     target: 1,   symbol: 'leaf.arrow.circlepath',  emoji: '🌱', text: 'Come back after 7+ days away and finish a session.', secret: true },
    { id: 'ring_closer',     name: 'Ring Closer',     rarity: 'common',    group: 'goals',       metric: 'goalDays',     target: 1,   symbol: 'target',                 emoji: '🎯', text: 'Hit your daily goal.' },
    { id: 'perfect_week',    name: 'Perfect Week',    rarity: 'rare',      group: 'goals',       metric: 'goalRun',      target: 7,   symbol: 'checkmark.seal.fill',    emoji: '🏅', text: 'Hit your daily goal 7 days in a row.' },
    { id: 'full_set',        name: 'Full Set',        rarity: 'uncommon',  group: 'craft',       metric: 'maxCombo',     target: 4,   symbol: 'square.grid.2x2.fill',   emoji: '🍅', text: 'Chain 4 sessions with breaks in one combo.' },
    { id: 'deep_dive',       name: 'Deep Dive',       rarity: 'uncommon',  group: 'craft',       metric: 'deepDive',     target: 1,   symbol: 'water.waves',            emoji: '🌊', text: 'Complete a session scheduled for 50+ minutes.' },
    { id: 'golden_hour',     name: 'Golden Hour',     rarity: 'common',    group: 'craft',       metric: 'golden',       target: 1,   symbol: 'sparkles',               emoji: '🌟', text: 'Land a Golden Session.', secret: true },
    { id: 'reflective',      name: 'Reflective',      rarity: 'uncommon',  group: 'craft',       metric: 'rated',        target: 25,  symbol: 'star.bubble.fill',       emoji: '💭', text: 'Rate 25 sessions.' },
    { id: 'well_rested',     name: 'Well Rested',     rarity: 'uncommon',  group: 'balance',     metric: 'breaks',       target: 25,  symbol: 'cup.and.saucer.fill',    emoji: '☕', text: 'Take 25 real breaks between sessions.' },
    { id: 'early_bird',      name: 'Early Bird',      rarity: 'uncommon',  group: 'explore',     metric: 'early',        target: 5,   symbol: 'sunrise.fill',           emoji: '🌅', text: 'Start 5 sessions between 4 and 8 am.' },
    { id: 'night_owl',       name: 'Night Owl',       rarity: 'uncommon',  group: 'explore',     metric: 'night',        target: 5,   symbol: 'moon.stars.fill',        emoji: '🦉', text: 'Start 5 sessions between 8 pm and midnight.' },
    { id: 'nomad',           name: 'Nomad',           rarity: 'uncommon',  group: 'explore',     metric: 'spots',        target: 3,   symbol: 'map.fill',               emoji: '🗺️', text: 'Focus in 3 different focus spots.' },
    { id: 'soundscaper',     name: 'Soundscaper',     rarity: 'uncommon',  group: 'explore',     metric: 'sounds',       target: 4,   symbol: 'headphones',             emoji: '🎧', text: 'Focus with 4 different ambiences or music genres.' },
    { id: 'renaissance_day', name: 'Renaissance Day', rarity: 'uncommon',  group: 'explore',     metric: 'maxCatsDay',   target: 3,   symbol: 'paintpalette.fill',      emoji: '🎨', text: 'Focus on 3 different categories in one day.' },
    { id: 'finisher',        name: 'Finisher',        rarity: 'uncommon',  group: 'tasks',       metric: 'tasksDone',    target: 10,  symbol: 'checklist.checked',      emoji: '☑️', text: 'Finish 10 tasks you focused on.' },
    { id: 'on_the_money',    name: 'On the Money',    rarity: 'rare',      group: 'tasks',       metric: 'exactTasks',   target: 5,   symbol: 'scope',                  emoji: '📐', text: 'Finish 5 tasks in exactly the sessions you estimated.' },
    { id: 'pure_focus',      name: 'Pure Focus',      rarity: 'legendary', group: 'milestones',  metric: 'level',        target: 30,  symbol: 'circle.circle',          emoji: '💎', text: 'Reach level 30.' },
    // SPEC §1.3.7 plan extension: appended; v1 ids and order unchanged.
    { id: 'blueprint',       name: 'Blueprint',       rarity: 'common',    group: 'planning',    metric: 'plannedBlocks', target: 1,  symbol: 'calendar.badge.plus',    emoji: '🗓️', text: 'Put your first focus block on the calendar.' },
    { id: 'on_schedule',     name: 'On Schedule',     rarity: 'uncommon',  group: 'planning',    metric: 'onPlan',       target: 10,  symbol: 'calendar.badge.clock',   emoji: '⏰', text: 'Complete 10 sessions inside a calendar block.' },
    { id: 'clockwork',       name: 'Clockwork',       rarity: 'rare',      group: 'planning',    metric: 'clockworkDays', target: 3,  symbol: 'gearshape.2.fill',       emoji: '⚙️', text: 'Finish every focus block on 3 days with 3+ blocks.' },
    { id: 'master_planner',  name: 'Timekeeper',      rarity: 'epic',      group: 'planning',    metric: 'onPlan',       target: 100, symbol: 'calendar.circle.fill',   emoji: '📆', text: 'Complete 100 sessions inside a calendar block.' },
  ];
  const RARITY_ORDER = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4 };

  function levelFor(xp) {
    const T = C.LEVEL_CUM;
    let L = 1;
    while (L < T.length && xp >= T[L]) L++;
    const into = xp - T[L - 1];
    const need = L < T.length ? T[L] - T[L - 1] : 0;
    const tier = TIERS[Math.min(TIERS.length - 1, Math.floor((Math.min(L, 30) - 1) / 5))];
    const title = L >= 30 ? 'Pure Focus' : tier.name + ' ' + ROMAN[(L - 1) % 5];
    return { level: L, into, need, title, tier };
  }

  // ═════════════════════════ compute ═════════════════════════
  function compute({ sessions = [], tasks = [], now = new Date(), dailyGoalMinutes = 120, plan = null } = {}) {
    const todayKey = dayKey(now);
    const P = plan || null;                                   // SPEC §1.3.7
    const PX = (P && P.xpByDay && typeof P.xpByDay === 'object') ? P.xpByDay : {};

    // 1 — de-duplicate by case-insensitive id (re-imported CSVs; prefer the rated copy),
    //     then derive + sort focus sessions by (start, end, lowercase id)
    const uniq = new Map();
    for (const s of sessions) {
      if (!s || s.id == null) continue;
      const k = String(s.id).toLowerCase();
      const prev = uniq.get(k);
      if (!prev || (prev.focusRating == null && s.focusRating != null)) uniq.set(k, s);
    }
    const focus = Array.from(uniq.values()).filter((s) => s.mode === 'focus').map(derive)
      .filter((s) => Number.isFinite(s.startMs) && Number.isFinite(s.endMs))
      .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || (a.idLower < b.idLower ? -1 : a.idLower > b.idLower ? 1 : 0));

    // 2 — group by local day
    const byDay = new Map();
    for (const s of focus) { if (!byDay.has(s.key)) byDay.set(s.key, []); byDay.get(s.key).push(s); }
    const dayKeys = Array.from(byDay.keys()).sort();
    const active = dayKeys.filter((k) => byDay.get(k).some((s) => s.qualified));

    // 3 — streak replay with earned rest days
    const status = {};
    let streak = 0, bank = 0, longest = 0;
    if (active.length) {
      const activeSet = new Set(active);
      for (let k = active[0]; k <= todayKey; k = addDays(k, 1)) {
        if (activeSet.has(k)) {
          streak++;
          if (streak % C.REST_EVERY === 0) bank = Math.min(C.REST_MAX, bank + 1);
          if (streak > longest) longest = streak;
          status[k] = ['active', streak];
        } else if (k === todayKey) {
          status[k] = ['pending', streak];
        } else if (streak > 0 && bank > 0) {
          bank--; status[k] = ['rest', streak];
        } else {
          streak = 0; bank = 0; status[k] = ['missed', 0];
        }
      }
    }

    // 4 — per day: combos, XP (fatigue bands), goal
    const days = {};
    const bySource = { focus: 0, completion: 0, golden: 0, reflection: 0, goal: 0, quests: 0 };
    let totalXP = 0;
    for (const k of dayKeys) {
      const ss = byDay.get(k);
      const st = status[k] || ['none', 0];
      const spct = st[0] === 'active' ? streakPct(st[1]) : 0;
      let combo = 0, prevEnd = null, breaks = 0, maxCombo = 0;
      for (const s of ss) {
        if (!s.qualified) continue;
        if (prevEnd === null) combo = 1;
        else {
          const gap = (s.startMs - prevEnd) / 60000;
          if (gap > C.COMBO_MAX_GAP) combo = 1;
          else if (gap >= C.COMBO_MIN_GAP) { combo++; breaks++; }
          else combo = Math.max(1, combo); // back-to-back without a break: combo holds
        }
        s.combo = combo;
        if (combo > maxCombo) maxCombo = combo;
        prevEnd = s.endMs;
      }
      let before = 0, sessionXPTotal = 0;
      for (const s of ss) {
        const r = sessionXP(s, before, spct);
        s.parts = r; s.xp = r.xp; sessionXPTotal += r.xp;
        const mult = (100 + r.streakPct) * (100 + r.comboPct);
        bySource.focus += Math.floor(r.base * mult / 10000);
        bySource.completion += Math.floor(r.completion * mult / 10000);
        bySource.golden += Math.floor(r.golden * mult / 10000);
        bySource.reflection += Math.floor(r.reflection * mult / 10000);
        before += s.cm;
      }
      // Goal: each session carries the goal in effect when it was logged (goalMinutes snapshot).
      // The FIRST session whose running total reaches its own goal earns the bonus; never revoked.
      let cum = 0, goalHit = false, hitGoal = null, firstG = null, lastG = null;
      for (const s of ss) {
        cum += s.cm;
        const g = s.goal !== null ? s.goal : (k === todayKey ? dailyGoalMinutes : C.GOAL_FALLBACK);
        if (firstG === null) firstG = g;
        lastG = g;
        if (!goalHit && g > 0 && cum >= g * 100) { goalHit = true; hitGoal = g; }
      }
      const goalBonus = goalHit ? C.GOAL_BONUS_PER_MIN * Math.min(hitGoal, C.GOAL_BONUS_CAP_MIN) : 0;
      const q = ss.filter((s) => s.qualified);
      days[k] = {
        key: k, cm: before, goal: goalHit ? hitGoal : lastG, goalEnabled: firstG > 0, goalHit, goalBonus, sessionXP: sessionXPTotal,
        qualified: q.length, completed: q.filter((s) => s.completed).length,
        rated: q.filter((s) => s.rating != null).length,
        taskSessions: q.filter((s) => s.taskId).length,
        soundSessions: q.filter((s) => s.ambience || s.music).length,
        tasks: new Set(q.filter((s) => s.taskId).map((s) => s.taskId)),
        cats: new Set(q.filter((s) => s.category).map((s) => s.category)),
        maxCombo, breaks, streakStatus: st[0], streakCount: st[1],
        lastQualifiedEndMs: prevEnd, lastCombo: combo, planXP: 0,
      };
      totalXP += sessionXPTotal + goalBonus;
      bySource.goal += goalBonus;
    }

    // 5 — quests (each day depends only on history before it)
    const questDays = Array.from(new Set(dayKeys.concat([todayKey]))).sort();
    const quests = {};
    let ai = 0; // pointer into `active` (sorted)
    for (const k of questDays) {
      while (ai < active.length && active[ai] < k) ai++;
      const prior = active.slice(Math.max(0, ai - 14), ai).map((a) => days[a]);
      const d = days[k] || null;
      const goalEnabled = d ? d.goalEnabled : dailyGoalMinutes > 0;
      const { quests: list, baseline } = generateQuests(k, prior, goalEnabled);
      let earned = 0, all = true;
      for (const qq of list) {
        qq.progress = questProgress(qq, d);
        qq.done = qq.progress >= qq.target;
        if (qq.done) earned += qq.reward; else all = false;
      }
      if (all) earned += C.SWEEP_XP;
      quests[k] = { list, earned: d ? earned : 0, sweep: all, baseline };
      if (d) { totalXP += earned; bySource.quests += earned; }
    }

    // 5b — plan XP (SPEC §1.3.7; only when a plan is passed, so the v1 bySource stays exact)
    if (P) {
      let planTotal = 0;
      for (const [k, v] of Object.entries(PX)) {
        planTotal += Math.max(0, Math.floor(Number(v) || 0));
        if (days[k]) days[k].planXP = v;
      }
      totalXP += planTotal;
      bySource.plan = planTotal;
    }

    // 6 — level
    const lv = levelFor(totalXP);

    // 7 — achievement metrics
    const q = focus.filter((s) => s.qualified);
    const totalCm = focus.reduce((a, s) => a + s.cm, 0);
    const goalDayKeys = dayKeys.filter((k) => days[k].goalHit);
    let goalRunBest = 0, run = 0, prev = null;
    for (const k of goalDayKeys) { run = prev && daysBetween(prev, k) === 1 ? run + 1 : 1; goalRunBest = Math.max(goalRunBest, run); prev = k; }
    const weekCounts = new Map();
    for (const k of active) { const w = weekStartKey(k); weekCounts.set(w, (weekCounts.get(w) || 0) + 1); }
    const qualWeeks = Array.from(weekCounts.entries()).filter(([, n]) => n >= 4).map(([w]) => w).sort();
    let rhythmBest = 0; run = 0; prev = null;
    for (const w of qualWeeks) { run = prev && daysBetween(prev, w) === 7 ? run + 1 : 1; rhythmBest = Math.max(rhythmBest, run); prev = w; }
    let comeback = 0;
    for (let i = 1; i < active.length; i++) if (daysBetween(active[i - 1], active[i]) >= 8) comeback = 1;
    const spots = new Set();
    for (const s of q) {
      const list = Array.isArray(s.locations) && s.locations.length ? s.locations : (s.location ? [s.location] : []);
      for (const loc of list) if (loc) spots.add(loc);
    }
    const sounds = new Set();
    for (const s of q) { if (s.ambience) sounds.add('amb:' + s.ambience); if (s.music) sounds.add('mus:' + s.music); }
    const perTask = new Map();
    for (const s of q) if (s.taskId) perTask.set(s.taskId, (perTask.get(s.taskId) || 0) + 1);
    const doneTasks = tasks.filter((t) => t && t.isDone && (perTask.get(String(t.id).toLowerCase()) || 0) >= 1);
    const metrics = {
      qualified: q.length,
      hours: totalCm / 6000,
      streak: longest,
      rhythmWeeks: rhythmBest,
      comeback,
      goalDays: goalDayKeys.length,
      goalRun: goalRunBest,
      maxCombo: dayKeys.reduce((m, k) => Math.max(m, days[k].maxCombo), 0),
      deepDive: q.some((s) => s.completed && s.sched >= 50) ? 1 : 0,
      golden: q.filter((s) => s.golden).length,
      rated: q.filter((s) => s.rating != null).length,
      breaks: dayKeys.reduce((a, k) => a + days[k].breaks, 0),
      early: q.filter((s) => s.start.getHours() >= 4 && s.start.getHours() < 8).length,
      night: q.filter((s) => s.start.getHours() >= 20).length,
      spots: spots.size,
      sounds: sounds.size,
      maxCatsDay: dayKeys.reduce((m, k) => Math.max(m, days[k].cats.size), 0),
      tasksDone: doneTasks.length,
      exactTasks: doneTasks.filter((t) => perTask.get(String(t.id).toLowerCase()) === Number(t.estimate)).length,
      level: lv.level,
      plannedBlocks: P ? Number(P.plannedBlocks) || 0 : 0,
      onPlan: P ? Number(P.onPlan) || 0 : 0,
      clockworkDays: P ? Number(P.clockworkDays) || 0 : 0,
    };

    // 8 — today / HUD bits
    const todayInfo = days[todayKey] || null;
    const todayStatus = (status[todayKey] || ['none', 0])[0];
    const current = todayStatus === 'active' || todayStatus === 'pending' ? status[todayKey][1] : 0;
    const nowMs = now.getTime();
    const comboAlive = !!(todayInfo && todayInfo.lastQualifiedEndMs !== null && (nowMs - todayInfo.lastQualifiedEndMs) / 60000 <= C.COMBO_MAX_GAP);
    // "progress" metrics for the teaser use CURRENT values where a best-ever value would mislead
    let goalRunNow = 0;
    for (let k = goalDayKeys.includes(todayKey) ? todayKey : addDays(todayKey, -1); days[k] && days[k].goalHit; k = addDays(k, -1)) goalRunNow++;
    const progressValue = {
      ...metrics,
      streak: current,
      goalRun: goalRunNow,
      maxCombo: todayInfo ? todayInfo.maxCombo : 0,
      maxCatsDay: todayInfo ? todayInfo.cats.size : 0,
    };
    const achievements = ACHIEVEMENTS.map((a) => {
      const unlocked = a.metric === 'hours' ? totalCm >= a.target * 6000 : metrics[a.metric] >= a.target;
      const value = Math.min(progressValue[a.metric], a.target);
      // level progress counts from level 1, so a brand-new user's teaser is First Light, not Pure Focus
      const fraction = a.metric === 'level' ? (Math.min(value, a.target) - 1) / (a.target - 1) : value / a.target;
      return { ...a, unlocked, value, fraction };
    });
    const nextMilestone = C.STREAK_MILESTONES.find((m) => m > current) || null;

    return {
      engineVersion: C.ENGINE_VERSION, todayKey,
      xp: { total: totalXP, bySource, level: lv.level, title: lv.title, tier: lv.tier, into: lv.into, need: lv.need },
      streak: {
        current, longest, restBank: bank, todayStatus,
        atRisk: todayStatus === 'pending' && current > 0,
        multiplierPct: streakPct(todayStatus === 'pending' ? current + 1 : current),
        nextMilestone, byDay: status,
      },
      today: {
        key: todayKey,
        minutes: todayInfo ? todayInfo.cm / 100 : 0,
        goal: dailyGoalMinutes,              // the ring always shows the CURRENT goal setting
        goalBonus: todayInfo ? todayInfo.goalBonus : 0,
        goalHit: !!(todayInfo && todayInfo.goalHit),
        combo: comboAlive ? todayInfo.lastCombo : 0,
        comboExpiresAtMs: comboAlive ? todayInfo.lastQualifiedEndMs + C.COMBO_MAX_GAP * 60000 : null,
        info: todayInfo,
        quests: quests[todayKey],
        xp: (todayInfo ? todayInfo.sessionXP + todayInfo.goalBonus + quests[todayKey].earned : 0) + (P ? (PX[todayKey] || 0) : 0),
      },
      days, quests, sessions: focus, metrics, achievements,
      nextAchievement: pickNextAchievement(achievements),
    };
  }

  /* "≈ N sessions to Level L+1" — goal-gradient nudge for the HUD tooltip and the XP receipt. */
  function sessionsToNextLevel(state) {
    const recent = state.sessions.filter((s) => s.qualified).slice(-10);
    const avg = recent.length ? recent.reduce((a, s) => a + s.xp, 0) / recent.length : 300;
    const left = state.xp.need - state.xp.into;
    return state.xp.need > 0 ? Math.max(1, Math.ceil(left / Math.max(50, avg))) : null;
  }

  /* Personal bests BEFORE today (so "today beat your best" can be detected) and including today. */
  function personalBests(state) {
    const keys = Object.keys(state.days).sort();
    const prior = keys.filter((k) => k < state.todayKey);
    const best = (ks, f) => ks.reduce((m, k) => Math.max(m, f(state.days[k])), 0);
    const weekTotals = (ks) => {
      const w = new Map();
      for (const k of ks) { const wk = addDays(k, -new Date(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10)).getDay()); w.set(wk, (w.get(wk) || 0) + state.days[k].cm); }
      return Math.max(0, ...w.values());
    };
    return {
      activeDaysBeforeToday: prior.filter((k) => state.days[k].qualified > 0).length,
      before: { dayMinutes: best(prior, (d) => d.cm) / 100, daySessions: best(prior, (d) => d.qualified), combo: best(prior, (d) => d.maxCombo), weekMinutes: weekTotals(prior) / 100 },
      all: { dayMinutes: best(keys, (d) => d.cm) / 100, daySessions: best(keys, (d) => d.qualified), combo: best(keys, (d) => d.maxCombo), weekMinutes: weekTotals(keys) / 100, longestStreak: state.streak.longest },
    };
  }

  function pickNextAchievement(list) {
    const candidates = list.filter((a) => !a.unlocked && !a.secret && a.fraction > 0);
    candidates.sort((a, b) => b.fraction - a.fraction || RARITY_ORDER[a.rarity] - RARITY_ORDER[b.rarity]);
    return candidates[0] || list.find((a) => !a.unlocked && !a.secret) || null;
  }

  /* Live preview for the running focus session (drives the XP bar's ghost segment).
     Exact: it is the XP this session would earn if it ended now. */
  function previewSessionXP(state, { elapsedMinutes, scheduledMinutes, startMs, rated = false, assumeComplete = false }) {
    const t = state.today.info;
    const fake = derive({ id: 'preview', mode: 'focus', start: startMs, end: startMs + elapsedMinutes * 60000,
      minutes: assumeComplete ? scheduledMinutes : elapsedMinutes, scheduledMinutes, focusRating: rated ? 1 : null });
    fake.golden = false; // never spoil a Golden Session in advance
    if (fake.qualified) {
      if (!t || t.lastQualifiedEndMs === null) fake.combo = 1;
      else {
        const gap = (startMs - t.lastQualifiedEndMs) / 60000;
        fake.combo = gap > C.COMBO_MAX_GAP ? 1 : gap >= C.COMBO_MIN_GAP ? t.lastCombo + 1 : Math.max(1, t.lastCombo);
      }
    }
    const pending = state.streak.todayStatus === 'pending';
    const spct = streakPct(pending && fake.qualified ? state.streak.current + 1 : state.streak.todayStatus === 'active' ? state.streak.current : 0);
    return sessionXP(fake, t ? t.cm : 0, spct);
  }

  /* Celebration events: diff the previous computed state (in memory, null on launch) and the
     acknowledged state (persisted per device) against the new state. Order = presentation order. */
  const ACK0 = { v: 1, level: 0, achievements: [], streakMilestoneDay: null, goalDay: null, sweepDay: null,
    restNoticeDay: null, pbDay: null, welcomeDay: null };
  function diff(prev, next, ack) {
    const a = { ...ACK0, ...(ack || {}) };
    const ev = [];
    const T = next.todayKey;
    const today = next.today.info;
    if (prev) {
      const gained = next.xp.total - prev.xp.total;
      if (gained > 0) {
        const last = next.sessions.filter((s) => s.key === T).slice(-1)[0] || null;
        ev.push({ type: 'xp', amount: gained, session: last && { id: last.id, xp: last.xp, parts: last.parts, golden: last.golden } });
      }
      if (next.today.combo > prev.today.combo && next.today.combo >= 2) ev.push({ type: 'combo', combo: next.today.combo });
      const was = new Set(((prev.today.quests && prev.today.quests.list) || []).filter((x) => x.done).map((x) => x.id));
      for (const q of next.today.quests.list) if (q.done && !was.has(q.id)) ev.push({ type: 'quest', quest: q });
      if (next.streak.todayStatus === 'active' && next.streak.restBank > prev.streak.restBank) ev.push({ type: 'restEarned', bank: next.streak.restBank });
    }
    if (next.today.quests.sweep && today && a.sweepDay !== T) ev.push({ type: 'sweep', bonus: C.SWEEP_XP });
    if (next.today.goalHit && a.goalDay !== T) ev.push({ type: 'goal', minutes: next.today.minutes, goal: today ? today.goal : next.today.goal, bonus: next.today.goalBonus });
    if (a.level > 0 && next.xp.level > a.level) {
      ev.push({ type: 'levelUp', from: a.level, to: next.xp.level, title: next.xp.title, tier: next.xp.tier.id, tierUp: next.xp.tier.id !== tierOfLevel(a.level).id });
    }
    const seen = new Set(a.achievements);
    const fresh = next.achievements.filter((x) => x.unlocked && !seen.has(x.id));
    if (fresh.length) ev.push({ type: 'achievements', list: fresh });
    if (next.streak.todayStatus === 'active' && C.STREAK_MILESTONES.includes(next.streak.current) && a.streakMilestoneDay !== T) {
      ev.push({ type: 'streak', days: next.streak.current });
    }
    const y = next.streak.byDay[addDays(T, -1)];
    if (y && y[0] === 'rest' && a.restNoticeDay !== T) ev.push({ type: 'restUsed', streak: next.streak.current, bank: next.streak.restBank });
    if (today && today.qualified > 0 && a.pbDay !== T) {
      const pb = personalBests(next);
      if (pb.activeDaysBeforeToday >= 7 && next.today.minutes > pb.before.dayMinutes) ev.push({ type: 'personalBest', minutes: next.today.minutes, previous: pb.before.dayMinutes });
    }
    if (today && today.qualified > 0 && a.welcomeDay !== T) {
      const prevActive = Object.keys(next.days).filter((k) => k < T && next.days[k].qualified > 0).sort().pop();
      if (prevActive && daysBetween(prevActive, T) >= 8) ev.push({ type: 'welcomeBack', daysAway: daysBetween(prevActive, T) - 1 });
    }
    return ev;
  }
  function tierOfLevel(L) { return TIERS[Math.min(TIERS.length - 1, Math.floor((Math.min(Math.max(L, 1), 30) - 1) / 5))]; }

  /* Large jumps (first run, CSV import, account switch, sign-in merge) become ONE summary instead of a burst. */
  function isCatchUp(events, reason) {
    if (reason === 'launch-no-ack' || reason === 'import' || reason === 'account') return true;
    const lv = events.find((e) => e.type === 'levelUp');
    const ach = events.find((e) => e.type === 'achievements');
    return (lv && lv.to - lv.from >= 2) || (ach && ach.list.length >= 4);
  }

  /* Persist after presenting (or silently, for catch-up). Achievements latch: once seen, never re-locked. */
  function acknowledge(next, ack) {
    const a = { ...ACK0, ...(ack || {}) };
    const T = next.todayKey;
    const today = next.today.info;
    const y = next.streak.byDay[addDays(T, -1)];
    const pb = today && today.qualified > 0 ? personalBests(next) : null;
    return {
      v: 1,
      level: next.xp.level,
      achievements: Array.from(new Set(a.achievements.concat(next.achievements.filter((x) => x.unlocked).map((x) => x.id)))),
      streakMilestoneDay: next.streak.todayStatus === 'active' && C.STREAK_MILESTONES.includes(next.streak.current) ? T : a.streakMilestoneDay,
      goalDay: next.today.goalHit ? T : a.goalDay,
      sweepDay: next.today.quests.sweep && today ? T : a.sweepDay,
      restNoticeDay: y && y[0] === 'rest' ? T : a.restNoticeDay,
      pbDay: pb && pb.activeDaysBeforeToday >= 7 && next.today.minutes > pb.before.dayMinutes ? T : a.pbDay,
      welcomeDay: today && today.qualified > 0 ? T : a.welcomeDay,
    };
  }

  return {
    C, TIERS, QUESTS, ACHIEVEMENTS,
    compute, levelFor, previewSessionXP, diff, isCatchUp, acknowledge, sessionsToNextLevel, personalBests,
    dayKey, addDays, fnv1a32, xorshift32, isGoldenId, generateQuests,
  };
})();
