/* ═══════════════════════════════════════════════════════════════════════
   store.js — data layer (owner: W1)
   Mirrors the macOS app's model: tasks, subtasks, templates, sessions,
   settings, calendar blocks, calendar state and courses, persisted to
   localStorage under Profile.dataKey() (guest: 'purefocus.v1').

   Stored shape (schemaVersion 2, additive):
     { schemaVersion, tasks, templates, sessions, activeTaskID, customCategories,
       settings, blocks, calendar, courses, migrations }

   Events (Store.on): the specific kinds
     tasks · sessions · settings · templates · blocks · calendar · courses · reset
   each followed by  'change' (payload = the kind). Store.bulk(fn) and
   Store.applyCloud() write once: a single-kind bulk looks like a normal
   commit; a multi-kind bulk emits each kind's specific event once, then
   'bulk' (payload = [kinds]), then ONE 'change' with payload 'bulk'. Cloud changes emit 'remote' (payload =
   [kinds]) then 'change' with payload 'remote' (never celebrated live).
   'attention' ('storage') fires when even the dropped caches can't make room.
   Non-data events on the same bus: music · music:progress · focus:completed.
   ═══════════════════════════════════════════════════════════════════════ */

const Store = (() => {
  const SCHEMA_VERSION = 2;

  function dataKey() {
    try { if (typeof Profile !== 'undefined' && Profile && Profile.dataKey) return Profile.dataKey(); } catch (_) {}
    return 'purefocus.v1';
  }
  function cacheKey(base) {
    try { if (typeof Profile !== 'undefined' && Profile && Profile.key) return Profile.key(base); } catch (_) {}
    return base;
  }

  // ── catalogues ──

  // v1 shape {id,name,accent,focus,break,longBreak}; the 14 v2 presets come from
  // js/themes.js (PF_THEMES, verbatim v2-themes.json). W6 applies the full tokens.
  const THEMES_V1 = [
    { id: 'ember',    name: 'Ember',    accent: '#ff6b35', focus: '#e8482b', break: '#2aa198', longBreak: '#7c5cbf' },
    { id: 'ocean',    name: 'Ocean',    accent: '#4da8da', focus: '#2e6fbd', break: '#3dba8b', longBreak: '#8b5cf6' },
    { id: 'forest',   name: 'Forest',   accent: '#5ab552', focus: '#3e8e41', break: '#8b6f47', longBreak: '#5b8a72' },
    { id: 'lavender', name: 'Lavender', accent: '#9b7ede', focus: '#7c5cbf', break: '#5c8dcc', longBreak: '#a78bfa' },
    { id: 'rose',     name: 'Rose',     accent: '#e86a92', focus: '#d64c6f', break: '#6c9bd1', longBreak: '#b07cc7' },
    { id: 'graphite', name: 'Graphite', accent: '#9aa0a6', focus: '#6e747a', break: '#5a7d8c', longBreak: '#7a6f9e' },
  ];
  const THEMES = (() => {
    try {
      if (typeof PF_THEMES !== 'undefined' && PF_THEMES && Array.isArray(PF_THEMES.themes) && PF_THEMES.themes.length) {
        return PF_THEMES.themes.map((t) => ({
          id: t.id, name: t.name, accent: t.accent, focus: t.focus, break: t.break, longBreak: t.longBreak,
        }));
      }
    } catch (_) { /* fall through */ }
    return THEMES_V1;
  })();
  const THEME_IDS = THEMES.map((t) => t.id);

  const ALARMS = [
    { id: 'bowl',    name: 'Singing Bowl', file: 'alarm_bowl.wav' },
    { id: 'bell',    name: 'Temple Bell',  file: 'alarm_bell.wav' },
    { id: 'marimba', name: 'Marimba',      file: 'alarm_marimba.wav' },
    { id: 'chime',   name: 'Glass Chime',  file: 'alarm_chime.wav' },
    { id: 'soft',    name: 'Soft Mallet',  file: 'alarm_soft.wav' },
    { id: 'digital', name: 'Digital Ping', file: 'alarm_digital.wav' },
  ];

  const AMBIENCES = [
    { id: 'none',   name: 'Off',         file: null },
    { id: 'white',  name: 'White Noise', file: 'amb_white.wav' },
    { id: 'brown',  name: 'Brown Noise', file: 'amb_brown.wav' },
    { id: 'rain',   name: 'Rain',        file: 'amb_rain.wav' },
    { id: 'ocean',  name: 'Ocean',       file: 'amb_ocean.wav' },
    { id: 'forest', name: 'Forest',      file: 'amb_forest.wav' },
    { id: 'cafe',   name: 'Café',        file: 'amb_cafe.wav' },
  ];

  const MODES = {
    focus:      { id: 'focus',      title: 'Focus',       message: 'Time to focus!',   symbol: 'flame' },
    shortBreak: { id: 'shortBreak', title: 'Short Break', message: 'Take a break ☕',   symbol: 'cup' },
    longBreak:  { id: 'longBreak',  title: 'Long Break',  message: 'Long break 🌿',    symbol: 'leaf' },
  };

  // Eight slots, handed out in order. The three built-ins take the first three; a new
  // type of work gets the next free slot and the list wraps after eight.
  const CATEGORY_PALETTE = ['#4da8da', '#9b7ede', '#5ab552', '#e0a437', '#d55181', '#2aa198', '#e66767', '#9085e9'];
  const CATEGORY_COLORS = {
    Work: CATEGORY_PALETTE[0],
    Study: CATEGORY_PALETTE[1],
    Chores: CATEGORY_PALETTE[2],
  };

  // SPEC-V2 §4.6 catalogues used for clamping. Keep in step with Guard's chips and
  // InsightsCore.FACTORS / Insights' labels (one id set, three readers).
  const FACTOR_IDS = ['phoneAway', 'friends', 'notes.handwritten', 'notes.typed', 'notes.flashcards', 'notes.practice',
    'slept', 'caffeine', 'exercise',
    'quiet', 'library', 'home', 'comfortable', 'water', 'meal', 'breaks', 'plan', 'deadline', 'studyBuddy', 'morning', 'evening'];
  const INSIGHT_CARDS = ['fingerprint', 'kpis', 'planVsFocus', 'startDelay', 'bestWindows', 'byCourse', 'helps', 'estimates',
    'zone', 'distractions', 'breaks', 'deepWork', 'ratingTrend', 'works'];
  const DRIFT_SIGNALS = ['input', 'idleAPI', 'visibility', 'apps', 'tabs', 'ext', 'block', 'import'];

  const DEFAULT_TEMPLATES = [
    { id: 'tpl-review-lecture', title: 'Review lecture notes', estimate: 2 },
    { id: 'tpl-problem-set',   title: 'Problem set',           estimate: 4 },
    { id: 'tpl-read-chapter',   title: 'Read textbook chapter', estimate: 3 },
  ];

  const DEFAULT_SETTINGS = {
    focusMinutes: 25,
    shortBreakMinutes: 5,
    longBreakMinutes: 15,
    longBreakInterval: 4,
    autoStartBreaks: false,
    autoStartFocus: false,
    tickingEnabled: false,
    alarmVolume: 0.8,
    ambienceVolume: 0.6,      // v2-sound: slider position (amplitude = v²)
    selectedAlarm: 'bell',
    selectedAmbience: 'none',
    selectedMusic: '',        // genre id · 'station:<id>' · ''
    musicVolume: 0.7,         // v2-sound: slider position (amplitude = v²)
    themeID: 'ember',
    sceneID: '',
    sceneDim: -1,
    sceneQuality: 'auto',
    dailyGoalMinutes: 120,
    showCompletedTasks: false,
    auroraIntensity: 0.6,
    reduceMotion: false,
    tickVolume: 0.3,
    switchToBreakSound: true,
    colorScheme: 'system',     // 'dark' | 'light' | 'system'
    engagementMode: 'full',   // rewards layer: 'full' | 'calm' | 'off'
    celebrations: 'full',     // reward moments: 'full' | 'subtle' | 'off'
    celebrationSounds: true,
    // ── sound v2 (v2-sound §8) ──
    musicNormalize: true,
    musicCrossfade: 'auto',   // 'auto' | 'off'
    audioV2Migrated: true,    // new installs; existing stores load it as false (W5's 'audio-v2' migration)
    // ── focus guard (v2-guard §2.1; web keys) ──
    guardEnabled: false,
    guardIdle: true,
    guardIdleSeconds: 120,
    guardIdleAPI: false,
    guardNudge: true,
    guardNudgeAfter: 120,
    guardNudgeSound: true,
    guardNotify: false,
    guardAutoPause: false,
    guardAutoPauseAfter: 300,
    guardList: [],
    blockEnabled: false,
    blockPasses: 3,
    blockDuringBreaks: false,
    factorsPrompt: 'daily',   // 'every' | 'daily' | 'off'
    insightsHidden: [],
    // ── study coach (v2-ai §2.3) ──
    coachEnabled: false,
    coachTier: 'best',        // 'best' | 'economy'
    coachConnection: 'auto',  // 'auto' | 'ownKey' | 'cloud'
    coachMonthlyBudgetUSD: 5,
    coachRealisticDays: true,
    coachSendEventTitles: false,
  };

  // SPEC §1.2.4 CalendarState + SPEC-V2 §4.3 / v2-calendar §3.2 / v2-ai §2.2 additions.
  const DEFAULT_CAL_PREFS = {
    lastView: 'week',
    weekStartsOn: null,
    showWeekends: true,
    hourHeight: 56,
    planDayStart: 480,
    planDayEnd: 1320,
    eventBuffer: 5,
    maxPlannedFocus: 300,
    showPlanPanel: true,
    blockReminders: true,
    reminderLead: 0,
    showSessionTraces: true,
    google: { email: null, connectedAt: null, grantedScopes: [] },
    collapsedGroups: [],
    collapsedSections: [],
    promoteAssignments: true,
    assignmentHorizonDays: 2,
    planRangeDays: 7,
    showNextEventInUpNext: true,
    weekPlan: [],
    showLocalBlocks: true,
    showDueTasks: true,
    assignmentDone: {},      // assignment id (lowercase) → true (done) | false (explicitly open)
  };

  // New task fields (SPEC §1.2.1 + SPEC-V2 §4.3); every one defaults to null.
  const TASK_FIELDS = ['dueDate', 'notes', 'externalSource', 'externalID', 'externalListID', 'externalUpdatedAt',
    'dueAt', 'course', 'courseKey', 'points', 'url', 'courseID', 'assessmentID', 'planParts',
    'completedAt', 'externalDoneSuppressed'];

  // ── state ──

  function emptyState() {
    return {
      tasks: [],
      templates: DEFAULT_TEMPLATES.map((t) => ({ ...t })),
      sessions: [],
      activeTaskID: null,
      customCategories: [],
      settings: { ...DEFAULT_SETTINGS, guardList: [], insightsHidden: [] },
      blocks: [],
      calendar: normalizeCalendar(null),
      courses: [],
      migrations: {},
    };
  }

  let state = null;   // set by load()
  let loadedKey = null;   // the key `state` was loaded from: writes go there, even mid profile switch
  let storageAttention = false;
  let unreadable = false;       // the saved store couldn't be parsed at load (a copy sits at <key>.corrupt)

  const listeners = new Map();

  function on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event).delete(fn);
  }

  function emit(event, payload) {
    const set = listeners.get(event);
    if (set) for (const fn of Array.from(set)) fn(payload);
  }

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  const sameID = (a, b) => a != null && b != null && String(a).toLowerCase() === String(b).toLowerCase();
  const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
  const isDayKey = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const strOrNull = (v, max) => (typeof v === 'string' && v.trim() ? (max ? v.slice(0, max) : v) : null);

  // ── clamps ──

  function oneOf(v, list, dflt) { return list.includes(v) ? v : dflt; }
  function unit(v, dflt) {
    let n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    if (n > 1) n = Math.min(1, n / 100);    // older builds saved sliders as 0–100
    return Math.max(0, n);
  }
  function intIn(v, lo, hi, dflt) {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, Math.round(n)));
  }

  function normalizeGuardList(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    const seen = new Set();
    for (const it of list) {
      if (!isObj(it)) continue;
      if (!['app', 'domain', 'url'].includes(it.kind)) continue;
      const value = typeof it.value === 'string' ? it.value.trim() : '';
      if (!value) continue;
      const id = typeof it.id === 'string' && it.id ? it.id : it.kind + ':' + value;
      if (seen.has(id.toLowerCase())) continue;
      seen.add(id.toLowerCase());
      out.push({ ...it, id, value, name: typeof it.name === 'string' && it.name ? it.name.slice(0, 80) : value, block: it.block !== false });
      if (out.length >= 200) break;
    }
    return out;
  }

  const SETTING_CLAMPS = {
    alarmVolume: (v) => unit(v, DEFAULT_SETTINGS.alarmVolume),
    ambienceVolume: (v) => unit(v, DEFAULT_SETTINGS.ambienceVolume),
    musicVolume: (v) => unit(v, DEFAULT_SETTINGS.musicVolume),
    auroraIntensity: (v) => unit(v, DEFAULT_SETTINGS.auroraIntensity),
    tickVolume: (v) => unit(v, DEFAULT_SETTINGS.tickVolume),
    dailyGoalMinutes: (v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return DEFAULT_SETTINGS.dailyGoalMinutes;
      if (n <= 0) return 0;
      return Math.min(480, Math.max(15, Math.round(n / 15) * 15));
    },
    themeID: (v) => oneOf(v, THEME_IDS, 'ember'),
    colorScheme: (v) => oneOf(v, ['dark', 'light', 'system'], 'system'),
    engagementMode: (v) => oneOf(v, ['full', 'calm', 'off'], 'full'),
    celebrations: (v) => oneOf(v, ['full', 'subtle', 'off'], 'full'),
    selectedMusic: (v) => (typeof v === 'string' ? v : ''),
    musicCrossfade: (v) => oneOf(v, ['auto', 'off'], 'auto'),
    sceneID: (v) => (typeof v === 'string' && /^[a-z0-9-]*$/.test(v) ? v : ''),
    sceneDim: (v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return -1;
      return n < 0 ? -1 : Math.min(0.8, n);
    },
    sceneQuality: (v) => oneOf(v, ['auto', '1080p', '4k', 'still'], 'auto'),
    guardIdleSeconds: (v) => oneOf(Number(v), [60, 120, 180, 300], 120),
    guardNudgeAfter: (v) => oneOf(Number(v), [60, 120, 180, 300], 120),
    guardAutoPauseAfter: (v) => oneOf(Number(v), [180, 300, 600], 300),
    guardList: normalizeGuardList,
    blockPasses: (v) => intIn(v, 0, 5, 3),
    factorsPrompt: (v) => oneOf(v, ['every', 'daily', 'off'], 'daily'),
    insightsHidden: (v) => (Array.isArray(v) ? Array.from(new Set(v.filter((x) => INSIGHT_CARDS.includes(x)))) : []),
    coachTier: (v) => oneOf(v, ['best', 'economy'], 'best'),
    coachConnection: (v) => oneOf(v, ['auto', 'ownKey', 'cloud'], 'auto'),
    coachMonthlyBudgetUSD: (v) => intIn(v, 1, 50, 5),
  };
  const BOOL_SETTINGS = ['autoStartBreaks', 'autoStartFocus', 'tickingEnabled', 'showCompletedTasks', 'reduceMotion',
    'switchToBreakSound', 'celebrationSounds', 'musicNormalize', 'audioV2Migrated', 'guardEnabled', 'guardIdle',
    'guardIdleAPI', 'guardNudge', 'guardNudgeSound', 'guardNotify', 'guardAutoPause', 'blockEnabled', 'blockDuringBreaks',
    'coachEnabled', 'coachRealisticDays', 'coachSendEventTitles'];

  function clampSetting(key, value) {
    if (SETTING_CLAMPS[key]) return SETTING_CLAMPS[key](value);
    if (BOOL_SETTINGS.includes(key)) return typeof value === 'boolean' ? value : !!value;
    return value;
  }

  function sanitizeSettings(raw) {
    const s = { ...DEFAULT_SETTINGS, guardList: [], insightsHidden: [], ...(isObj(raw) ? raw : {}) };
    for (const k of Object.keys(SETTING_CLAMPS)) s[k] = clampSetting(k, s[k]);
    for (const k of BOOL_SETTINGS) if (typeof s[k] !== 'boolean') s[k] = s[k] === undefined ? DEFAULT_SETTINGS[k] : !!s[k];
    return s;
  }

  // ── model normalisers (lenient: unknown fields are kept) ──

  function normalizeFeed(f) {
    if (!isObj(f) || typeof f.id !== 'string' || !f.id) return null;
    return {
      ...f,
      provider: typeof f.provider === 'string' && f.provider ? f.provider : (f.source === 'google' ? 'google' : 'ics'),
      groupKey: f.groupKey ?? null,
      blocksTime: f.blocksTime !== false,
      itemRole: ['auto', 'events', 'dueDates'].includes(f.itemRole) ? f.itemRole : 'auto',
      displayName: f.displayName ?? null,
      userColorHex: f.userColorHex ?? null,
      refreshMinutes: Number.isFinite(f.refreshMinutes) ? f.refreshMinutes : null,
      urlMask: f.urlMask ?? null,
      canvasHost: f.canvasHost ?? null,
    };
  }

  const strList = (v, cap) => {
    const out = Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
    return cap && out.length > cap ? out.slice(out.length - cap) : out;   // FIFO: keep the newest
  };

  /* assignment id (lowercase) → boolean. Kept small: at most 500 remembered ticks. */
  function normalizeAssignmentDone(v) {
    const out = {};
    if (!isObj(v)) return out;
    for (const [k, val] of Object.entries(v)) {
      if (typeof k !== 'string' || !k || typeof val !== 'boolean') continue;
      out[k.toLowerCase()] = val;
      if (Object.keys(out).length >= 500) break;
    }
    return out;
  }

  function normalizeCalendar(c) {
    const src = isObj(c) ? c : {};
    const p = isObj(src.prefs) ? src.prefs : {};
    const prefs = { ...DEFAULT_CAL_PREFS, ...p };
    prefs.google = { ...DEFAULT_CAL_PREFS.google, ...(isObj(p.google) ? p.google : {}) };
    prefs.collapsedGroups = strList(p.collapsedGroups);
    prefs.collapsedSections = strList(p.collapsedSections);
    prefs.weekPlan = Array.isArray(p.weekPlan) ? p.weekPlan.filter(isObj).slice(0, 7) : [];
    prefs.assignmentDone = normalizeAssignmentDone(p.assignmentDone);
    prefs.assignmentHorizonDays = oneOf(Number(prefs.assignmentHorizonDays), [1, 2, 3, 7], 2);
    prefs.planRangeDays = intIn(prefs.planRangeDays, 3, 14, 7);
    prefs.hourHeight = intIn(prefs.hourHeight, 40, 112, 56);
    for (const k of ['showWeekends', 'showPlanPanel', 'blockReminders', 'showSessionTraces', 'promoteAssignments',
      'showNextEventInUpNext', 'showLocalBlocks', 'showDueTasks']) {
      if (typeof prefs[k] !== 'boolean') prefs[k] = DEFAULT_CAL_PREFS[k];
    }
    return {
      ...src,
      prefs,
      feeds: Array.isArray(src.feeds) ? src.feeds.map(normalizeFeed).filter(Boolean) : [],
      taskLists: Array.isArray(src.taskLists) ? src.taskLists.filter((l) => isObj(l) && typeof l.id === 'string') : [],
      dismissedAssignments: strList(src.dismissedAssignments, 500),
      dismissedCourseKeys: strList(src.dismissedCourseKeys, 200),
    };
  }

  function normalizeBlock(b) {
    if (!isObj(b) || typeof b.id !== 'string' || !b.id) return null;
    if (typeof b.title !== 'string' || typeof b.start !== 'string' || typeof b.end !== 'string') return null;
    if (b.readOnly) return null;   // imported items live in the cache, never in the user file (SPEC §1.2.3 #4)
    return b;
  }

  function normalizeCourse(c) {
    if (!isObj(c) || typeof c.id !== 'string' || !c.id) return null;
    if (typeof c.name !== 'string' || !c.name.trim()) return null;
    return c;
  }

  function normalizeMigrations(m) {
    if (Array.isArray(m)) return Object.fromEntries(m.filter((x) => typeof x === 'string').map((id) => [id, null]));
    if (isObj(m)) return { ...m };
    return {};
  }

  function normalizeDrift(d) {
    if (!isObj(d)) return null;
    const n = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0);
    const top = Array.isArray(d.top) ? d.top.filter((x) => isObj(x) && typeof x.key === 'string')
      .map((x) => ({ key: x.key, name: typeof x.name === 'string' ? x.name : x.key, sec: n(x.sec) })).slice(0, 3) : [];
    const ratio = Number(d.focusRatio);
    return {
      ...d,
      v: 1,
      signals: Array.isArray(d.signals) ? Array.from(new Set(d.signals.filter((x) => DRIFT_SIGNALS.includes(x)))).sort() : [],
      activeSec: n(d.activeSec), idleSec: n(d.idleSec), distractSec: n(d.distractSec), awaySec: n(d.awaySec),
      switchCount: n(d.switchCount), distractCount: n(d.distractCount), nudges: n(d.nudges), nudgeReturns: n(d.nudgeReturns),
      autoPaused: n(d.autoPaused), blockedHits: n(d.blockedHits), escapes: n(d.escapes), offline: !!d.offline,
      top,
      focusRatio: Number.isFinite(ratio) ? Math.min(1, Math.max(0, Math.round(ratio * 1000) / 1000)) : 0,
    };
  }

  function normalizeFactors(f) {
    if (f == null) return null;
    if (!Array.isArray(f)) return null;
    return FACTOR_IDS.filter((id) => f.includes(id));   // unknown ids dropped; display order
  }

  /* Locations are a small, order-preserving set: trim, drop blanks and duplicates
     (case-insensitive), and keep the first six. `location` stays the first one so
     older readers (CSV, cloud snapshots, the calendar) keep working unchanged. */
  const MAX_LOCATIONS = 6;
  function cleanLocations(v) {
    const out = [];
    const list = Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]);
    for (const raw of list) {
      const s = String(raw == null ? '' : raw).trim().slice(0, 60);
      if (!s || out.some((x) => x.toLowerCase() === s.toLowerCase())) continue;
      out.push(s);
      if (out.length >= MAX_LOCATIONS) break;
    }
    return out;
  }
  function locationsOf(record) {
    if (!record) return [];
    return cleanLocations(Array.isArray(record.locations) && record.locations.length ? record.locations : record.location);
  }

  // ── persistence ──

  // A store we can't read is about to be replaced by an empty one: keep the text and say so.
  function keepUnreadable(raw) {
    try { localStorage.setItem(dataKey() + '.corrupt', raw); } catch (_) {}
    unreadable = true;
  }

  function parseStored(raw) {
    const fresh = emptyState();
    if (!raw) return fresh;
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) { keepUnreadable(raw); return fresh; }
    if (!isObj(parsed)) return fresh;
    const s = fresh;
    // Old stores have only `location`; give every record the same array shape so
    // the task list, Reports and Insights can read several places per session.
    const withLocations = (x) => {
      const locs = locationsOf(x);
      return { ...x, locations: locs, location: locs[0] || null };
    };
    s.tasks = Array.isArray(parsed.tasks) ? parsed.tasks.filter(isObj).map(withLocations) : [];
    s.templates = Array.isArray(parsed.templates) ? parsed.templates : DEFAULT_TEMPLATES.map((t) => ({ ...t }));
    s.sessions = Array.isArray(parsed.sessions) ? parsed.sessions.filter(isObj).map(withLocations) : [];
    s.customCategories = Array.isArray(parsed.customCategories) ? parsed.customCategories : [];
    s.activeTaskID = parsed.activeTaskID ?? null;
    const rawSettings = isObj(parsed.settings) ? parsed.settings : {};
    s.settings = sanitizeSettings(rawSettings);
    // A store written before sound v2 still holds linear volumes: W5's one-time
    // 'audio-v2' migration (√ of the old values) must run for it.
    if (isObj(parsed.settings) && !Object.prototype.hasOwnProperty.call(rawSettings, 'audioV2Migrated')) {
      s.settings.audioV2Migrated = false;
    }
    s.blocks = Array.isArray(parsed.blocks) ? parsed.blocks.map(normalizeBlock).filter(Boolean) : [];
    s.calendar = normalizeCalendar(parsed.calendar);
    s.courses = Array.isArray(parsed.courses) ? parsed.courses.map(normalizeCourse).filter(Boolean) : [];
    s.migrations = normalizeMigrations(parsed.migrations);
    return s;
  }

  function load() {
    let raw = null;
    loadedKey = dataKey();
    try { raw = localStorage.getItem(loadedKey); } catch (_) { raw = null; }
    state = parseStored(raw);
    if (!state.activeTaskID) {
      const first = state.tasks.find((t) => !t.isDone);
      if (first) state.activeTaskID = first.id;
    }
  }

  function serialize() {
    return JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      tasks: state.tasks,
      templates: state.templates,
      sessions: state.sessions,
      activeTaskID: state.activeTaskID,
      customCategories: state.customCategories,
      settings: state.settings,
      blocks: state.blocks,
      calendar: state.calendar,
      courses: state.courses,
      migrations: state.migrations,
    });
  }

  function isQuota(err) {
    return !!err && (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED' || err.code === 22 || err.code === 1014);
  }

  /* Writes key=value; on a quota error drops the disposable caches in order
     (calcache, then assignments) and retries. Never drops user data or the
     cloud ledger. Returns true when written. */
  function safeSet(key, value) {
    const drops = ['purefocus.calcache.v1', 'purefocus.assignments.v1'];
    for (let attempt = 0; attempt <= drops.length; attempt++) {
      try {
        localStorage.setItem(key, value);
        if (storageAttention) { storageAttention = false; emit('attention', null); }
        return true;
      } catch (err) {
        if (!isQuota(err)) return false;    // storage unavailable: keep working in memory
        if (attempt < drops.length) {
          try { localStorage.removeItem(cacheKey(drops[attempt])); } catch (_) {}
          continue;
        }
        storageAttention = true;
        emit('attention', 'storage');
        return false;
      }
    }
    return false;
  }

  let saveTimer = null;

  function writeNow() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    return safeSet(loadedKey || dataKey(), serialize());
  }

  function persist() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; writeNow(); }, 120);
  }

  function flush() { if (saveTimer) writeNow(); }

  // ── commit / bulk ──

  let bulkDepth = 0;
  let bulkKinds = null;   // ordered kinds touched inside the outermost bulk

  function commit(event, payload) {
    if (bulkDepth > 0) {
      if (!bulkKinds.includes(event)) bulkKinds.push(event);
      return;
    }
    persist();
    emit(event, payload);
    emit('change', event);
  }

  /* Runs fn() with every store write batched: one persist and ONE 'change'
     event at the end (see the header). Nested calls join the outer batch.
     Returns fn's result. If fn throws, the writes it made stay in memory and
     are persisted; callers that need all-or-nothing use migrate(). */
  function bulk(fn) {
    if (bulkDepth === 0) bulkKinds = [];
    bulkDepth++;
    try {
      return fn();
    } finally {
      bulkDepth--;
      if (bulkDepth === 0) finishBulk();
    }
  }

  function finishBulk() {
    const kinds = bulkKinds || [];
    bulkKinds = null;
    if (!kinds.length) return;
    persist();
    if (kinds.length === 1) {
      emit(kinds[0]);
      emit('change', kinds[0]);
      return;
    }
    for (const k of kinds) emit(k);   // the specific events, once each
    emit('bulk', kinds.slice());
    emit('change', 'bulk');
  }

  /* Runs fn() once per profile store: recorded in state.migrations[id] (ISO
     time) only when fn returns without throwing. Failure-safe: a throw rolls
     the in-memory state back to before fn, nothing is recorded or announced,
     and it retries on the next load. Returns true when it ran now. fn may use
     any Store API; its writes are batched like bulk(). */
  function migrate(id, fn) {
    const key = String(id || '');
    if (!key || typeof fn !== 'function' || !state) return false;
    if (Object.prototype.hasOwnProperty.call(state.migrations, key)) return false;
    const snapshot = serialize();
    const outer = bulkDepth > 0;
    if (!outer) bulkKinds = [];
    bulkDepth++;
    let ok = false;
    try { fn(); ok = true; } catch (err) {
      console.error('Store.migrate(' + key + ') failed; it will retry on the next load', err);
    }
    if (!ok) {
      state = parseStored(snapshot);
      bulkDepth--;
      if (!outer) bulkKinds = null;
      return false;
    }
    state.migrations[key] = new Date().toISOString();
    if (!bulkKinds.includes('settings')) bulkKinds.push('settings');
    bulkDepth--;
    if (!outer) finishBulk();
    return true;
  }

  function migrations() { return { ...state.migrations }; }

  // ── tasks ──

  function tasks() { return state.tasks; }

  function visibleTasks() {
    const showDone = state.settings.showCompletedTasks;
    return state.tasks.filter((t) => showDone || !t.isDone);
  }

  function activeTask() {
    const t = state.tasks.find((x) => x.id === state.activeTaskID);
    return t && !t.isDone ? t : null;
  }

  function cleanSubtasks(list) {
    return (Array.isArray(list) ? list : []).filter(isObj).map((s) => ({
      ...s, id: s.id || uid(), title: s.title, isDone: !!s.isDone,
    }));
  }

  function cleanPlanParts(v) {
    if (!Array.isArray(v)) return null;
    return v.filter(isObj).slice(0, 6).map((p) => ({
      label: String(p.label || '').slice(0, 40),
      pomodoros: Math.max(1, Math.round(Number(p.pomodoros) || 1)),
      earliest: isDayKey(p.earliest) ? p.earliest : null,
      doBy: isDayKey(p.doBy) ? p.doBy : null,
    }));
  }

  // Sanitises the §4.3 / SPEC §1.2.1 task fields present in `f`; unknown fields pass through.
  function cleanTaskFields(f) {
    const out = {};
    for (const [k, v] of Object.entries(f)) {
      switch (k) {
        case 'dueDate': out[k] = isDayKey(v) ? v : null; break;
        case 'notes': out[k] = typeof v === 'string' && v ? v.slice(0, 2000) : null; break;
        case 'course': out[k] = strOrNull(v, 40); break;
        case 'url': out[k] = typeof v === 'string' && /^https:\/\//i.test(v) ? v : null; break;
        case 'points': out[k] = v == null || !Number.isFinite(Number(v)) ? null : Number(v); break;
        case 'planParts': out[k] = cleanPlanParts(v); break;
        case 'dueAt': case 'externalUpdatedAt':
          out[k] = typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : (v instanceof Date ? v.toISOString() : null); break;
        case 'externalSource': case 'externalID': case 'externalListID': case 'courseKey': case 'courseID': case 'assessmentID':
          out[k] = v == null || v === '' ? null : String(v); break;
        default: out[k] = v;
      }
    }
    return out;
  }

  /* addTask(fields, {append}) — fields: title (required), estimate, category,
     location, subtasks, plus every SPEC §1.2.1 / SPEC-V2 §4.3 field (null by
     default) and any other field (kept as given). `id` may be supplied
     (deterministic import ids, E23); a duplicate id (case-insensitive) returns
     null. `append: true` adds at the end instead of the top (imports). */
  function addTask(fields, { append = false } = {}) {
    const f = isObj(fields) ? fields : {};
    const trimmed = (typeof f.title === 'string' ? f.title : '').trim();
    if (!trimmed) return null;
    if (f.id != null && state.tasks.some((t) => sameID(t.id, f.id))) return null;
    const { title, estimate = 1, category = null, location = null, locations = null, subtasks = [], id, completedPomodoros, isDone, createdAt, ...rest } = f;
    const base = {};
    for (const k of TASK_FIELDS) base[k] = null;
    const est = clamp(estimate, 1, 12);
    const locs = cleanLocations(Array.isArray(locations) && locations.length ? locations : location);
    const task = {
      ...base,
      ...cleanTaskFields(rest),
      id: id != null && String(id) ? String(id) : uid(),
      title: trimmed,
      estimate: est,
      completedPomodoros: Math.min(99, Math.max(0, Math.round(Number(completedPomodoros) || 0))),
      isDone: !!isDone,
      createdAt: typeof createdAt === 'string' && Number.isFinite(Date.parse(createdAt)) ? createdAt : new Date().toISOString(),
      location: locs[0] || null,
      locations: locs,
      category: category || null,
      subtasks: cleanSubtasks(subtasks).map((s) => ({ ...s, id: uid() })),
    };
    if (append) state.tasks.push(task);
    else state.tasks.unshift(task);
    if (!state.activeTaskID && !task.isDone) state.activeTaskID = task.id;
    commit('tasks');
    return task;
  }

  /* updateTask(id, patch) — spread-preserving: fields not in `patch` are kept;
     §4.3 fields are sanitised; other fields are assigned as given (never `id`).
     Changing the estimate or the due date clears planParts unless the patch
     sets them (v2-ai §2.2). */
  function updateTask(id, patch) {
    const idx = state.tasks.findIndex((t) => sameID(t.id, id));
    if (idx === -1) return;
    const t = state.tasks[idx];
    const p = isObj(patch) ? patch : {};
    const { title, estimate, category, location, locations, subtasks, id: _ignored, ...rest } = p;
    const before = { estimate: t.estimate, dueDate: t.dueDate };
    if (typeof title === 'string' && title.trim()) t.title = title.trim();
    if (estimate != null) t.estimate = clamp(estimate, 1, 12);
    if (category !== undefined) t.category = category || null;
    let locationsChanged = false;
    if (Array.isArray(locations)) {
      t.locations = cleanLocations(locations);
      t.location = t.locations[0] || null;
      locationsChanged = true;
    } else if (location !== undefined) {
      t.locations = cleanLocations(location);
      t.location = t.locations[0] || null;
      locationsChanged = true;
    }
    // Set a task's type of work or locations after you've focused on it, and its earlier sessions
    // that have none take it too — so Reports and the fingerprint can use them.
    let touched = false;
    if ((category !== undefined && t.category) || (locationsChanged && t.locations.length)) {
      for (const x of state.sessions) {
        if (!sameID(x.taskID, t.id) || x.mode !== 'focus') continue;
        if (category !== undefined && t.category && !x.category) { x.category = t.category; touched = true; }
        if (locationsChanged && t.locations.length && !locationsOf(x).length) {
          x.locations = t.locations.slice();
          x.location = x.locations[0];
          touched = true;
        }
      }
    }
    if (Array.isArray(subtasks)) {
      t.subtasks = subtasks.map((s) => ({ ...s, id: s.id || uid(), title: s.title, isDone: !!s.isDone }));
    }
    Object.assign(t, cleanTaskFields(rest));
    const replanned = t.estimate !== before.estimate || (('dueDate' in rest) && t.dueDate !== before.dueDate);
    if (replanned && !('planParts' in rest) && t.planParts) t.planParts = null;
    if (t.isDone && state.activeTaskID === t.id) {
      const next = state.tasks.find((x) => !x.isDone);
      state.activeTaskID = next ? next.id : null;
    }
    commit('tasks');
    if (touched) commit('sessions');
  }

  function toggleTaskDone(id) {
    const t = state.tasks.find((x) => x.id === id);
    if (!t) return;
    t.isDone = !t.isDone;
    // Every completion path (task list, calendar checkbox, Canvas "submitted") stamps the
    // same time; unchecking clears it. Completed history is therefore sortable and datable.
    t.completedAt = t.isDone ? new Date().toISOString() : null;
    if (t.isDone && t.planParts) t.planParts = null;
    if (t.isDone && state.activeTaskID === id) {
      const next = state.tasks.find((x) => !x.isDone);
      state.activeTaskID = next ? next.id : null;
    }
    commit('tasks');
  }

  function deleteTask(id) {
    state.tasks = state.tasks.filter((t) => t.id !== id);
    if (state.activeTaskID === id) {
      const next = state.tasks.find((x) => !x.isDone);
      state.activeTaskID = next ? next.id : null;
    }
    commit('tasks');
  }

  function setActiveTask(id) {
    const t = state.tasks.find((x) => x.id === id);
    if (!t || t.isDone) return;
    state.activeTaskID = id;
    commit('tasks');
  }

  function incrementPomodoro(id) {
    const t = state.tasks.find((x) => x.id === id);
    if (!t) return;
    // not capped at the estimate: a task that takes more sessions than you guessed keeps the real count
    t.completedPomodoros = Math.min(99, (t.completedPomodoros || 0) + 1);
    commit('tasks');
  }

  function toggleSubtask(taskId, subtaskId) {
    const t = state.tasks.find((x) => x.id === taskId);
    if (!t) return;
    const s = t.subtasks.find((x) => x.id === subtaskId);
    if (!s) return;
    s.isDone = !s.isDone;
    commit('tasks');
  }

  function reorderTasks(fromIndex, toIndex) {
    const list = visibleTasks();
    if (fromIndex < 0 || fromIndex >= list.length) return;
    const moved = list[fromIndex];
    // Reorder within the visible list, then splice it back over the visible
    // positions of the full list so hidden (completed) tasks keep their place.
    const visibleIds = list.map((t) => t.id);
    visibleIds.splice(fromIndex, 1);
    visibleIds.splice(toIndex, 0, moved.id);
    let vi = 0;
    state.tasks = state.tasks.map((t) => {
      if (!visibleIds.includes(t.id)) return t;
      const nextId = visibleIds[vi++];
      return state.tasks.find((x) => x.id === nextId);
    });
    commit('tasks');
  }

  // ── templates ──

  function templates() { return state.templates; }

  function addTemplate(title, estimate = 1) {
    const trimmed = (title || '').trim();
    if (!trimmed) return null;
    const tpl = { id: uid(), title: trimmed, estimate: clamp(estimate, 1, 12) };
    state.templates.push(tpl);
    commit('templates');
    return tpl;
  }

  function deleteTemplate(id) {
    state.templates = state.templates.filter((t) => t.id !== id);
    commit('templates');
  }

  // ── categories & locations ──

  function categories() {
    return ['Work', 'Study', 'Chores', ...state.customCategories];
  }

  function addCategory(name) {
    const trimmed = (name || '').trim();
    if (!trimmed) return null;
    const existing = categories().find((c) => c.toLowerCase() === trimmed.toLowerCase());
    if (existing) return existing;
    state.customCategories.push(trimmed);
    commit('settings');
    return trimmed;
  }

  function locations() {
    const seen = [];
    for (const t of state.tasks) {
      for (const loc of locationsOf(t)) {
        if (!seen.some((x) => x.toLowerCase() === loc.toLowerCase())) seen.push(loc);
      }
    }
    return seen;
  }

  function categoryColor(name) {
    if (!name) return 'var(--accent)';
    const key = Object.keys(CATEGORY_COLORS).find((k) => k.toLowerCase() === name.toLowerCase());
    if (key) return CATEGORY_COLORS[key];
    const custom = state.customCategories.findIndex((c) => c.toLowerCase() === String(name).trim().toLowerCase());
    if (custom >= 0) {
      return CATEGORY_PALETTE[(custom + Object.keys(CATEGORY_COLORS).length) % CATEGORY_PALETTE.length];
    }
    return 'var(--accent)';
  }

  // ── sessions ──

  function sessions() { return state.sessions; }

  /* logSession — `goalMinutes` defaults to the current daily goal (SPEC §1.2.2);
     `drift` (v2-guard §2.3) and `factors` (§2.4) default to null; `music` is
     the session's genre as given by the timer (its extras carry
     Audio.sessionMusicGenre() once W5 lands). Any extra field is kept. */
  function logSession({
    start, end, mode, task, scheduledMinutes = null, minutes = null,
    ambience = null, alarm = null, music = null, goalMinutes, drift = null, factors = null, ...extra
  }) {
    const actual = minutes != null ? minutes : (new Date(end) - new Date(start)) / 60000;
    const locs = locationsOf(task);
    const session = {
      ...extra,
      id: uid(),
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      minutes: Math.max(0.1, actual),
      scheduledMinutes,
      mode,
      taskID: task ? task.id : null,
      taskTitle: task ? task.title : null,
      focusRating: null,
      location: locs[0] || null,
      locations: locs,
      category: task ? task.category : null,
      ambience,
      alarm,
      music: music || null,
      drift: normalizeDrift(drift),
      factors: normalizeFactors(factors),
    };
    // Snapshot the daily goal in effect, so the rewards engine scores each
    // past day against the goal the user had then, not today's setting.
    const goal = Number(goalMinutes != null ? goalMinutes : state.settings.dailyGoalMinutes);
    if (Number.isFinite(goal)) session.goalMinutes = goal;
    state.sessions.push(session);
    commit('sessions');
    return session;
  }

  /* repairSessionData() — one-time repair (2026-10-29) of sessions recorded before the timer fixes:
     · a run that finished while the tab slept was logged with the sleep counted as focus (a 5-minute
       break logged as 12.6 minutes): minutes never exceed the run's scheduled length;
     · the type of work and location are copied from the session's task where the session has none.
     Nothing is deleted. Run once per profile through Store.migrate. */
  function repairSessionData() {
    const tasks = new Map(state.tasks.map((t) => [String(t.id).toLowerCase(), t]));
    for (const x of state.sessions) {
      const sched = Number(x.scheduledMinutes);
      if (Number.isFinite(sched) && sched > 0 && Number(x.minutes) > sched + 0.05) x.minutes = sched;
      if (x.mode === 'focus' && x.taskID) {
        const t = tasks.get(String(x.taskID).toLowerCase());
        if (t && t.category && !x.category) x.category = t.category;
        if (t && !locationsOf(x).length) {
          const locs = locationsOf(t);
          if (locs.length) { x.locations = locs; x.location = locs[0]; }
        }
      }
    }
    commit('sessions');
  }

  function rateSession(id, rating) {
    const s = state.sessions.find((x) => x.id === id);
    if (!s) return;
    s.focusRating = clamp(rating, 1, 10);
    commit('sessions');
  }

  /* setSessionFactors(id, factors) — focus-factor check-in (v2-guard §2.4):
     an array of SPEC-V2 §4.6 factor ids ([] = "None of these") or null.
     Unknown ids are dropped; the rating is never touched. */
  function setSessionFactors(id, factors) {
    const s = state.sessions.find((x) => sameID(x.id, id));
    if (!s) return false;
    s.factors = normalizeFactors(factors);
    commit('sessions');
    return true;
  }

  /* updateSessionLocations(id, locations) — where this session happened. Several
     places are allowed; `location` mirrors the first for older readers. */
  function updateSessionLocations(id, locations) {
    const s = state.sessions.find((x) => sameID(x.id, id));
    if (!s) return false;
    const locs = cleanLocations(locations);
    s.locations = locs;
    s.location = locs[0] || null;
    commit('sessions');
    return true;
  }

  // ── settings ──

  function settings() { return state.settings; }

  function setSetting(key, value) {
    state.settings[key] = clampSetting(key, value);
    commit('settings');
  }

  function theme() {
    return THEMES.find((t) => t.id === state.settings.themeID) || THEMES[0];
  }

  // ── calendar blocks (SPEC §1.2.3; local blocks only — imported events live in the cache) ──

  function blocks() { return state.blocks; }

  /* setBlocks(list) replaces every local block (W2 enforces the invariants).
     Read-only (imported) items are dropped: they never enter the user file. */
  function setBlocks(list) {
    state.blocks = (Array.isArray(list) ? list : []).map(normalizeBlock).filter(Boolean);
    commit('blocks');
  }

  // ── calendar state (SPEC §1.2.4 + SPEC-V2 §4.3) ──

  function calendar() { return state.calendar; }

  /* updateCalendar(patch): `prefs` (and `prefs.google`) merge shallowly; every
     other key (feeds, taskLists, dismissedAssignments, dismissedCourseKeys, …)
     replaces. The result is normalised (FIFO caps 500 / 200). */
  function updateCalendar(patch) {
    if (!isObj(patch)) return;
    const cur = state.calendar;
    const next = { ...cur, ...patch };
    if (isObj(patch.prefs)) {
      next.prefs = { ...cur.prefs, ...patch.prefs };
      if (isObj(patch.prefs.google)) next.prefs.google = { ...cur.prefs.google, ...patch.prefs.google };
    }
    state.calendar = normalizeCalendar(next);
    commit('calendar');
  }

  // ── courses (v2-ai §2.1) ──

  function courses() { return state.courses; }

  /* upsertCourse(c): insert or replace by id (case-insensitive). Stamps
     updatedAt (and createdAt when new). Returns the stored course or null. */
  function upsertCourse(c) {
    if (!isObj(c)) return null;
    const now = new Date().toISOString();
    const idx = state.courses.findIndex((x) => sameID(x.id, c.id));
    const prev = idx >= 0 ? state.courses[idx] : null;
    const course = normalizeCourse({
      ...c,
      id: c.id || uid(),
      createdAt: c.createdAt || (prev && prev.createdAt) || now,
      updatedAt: now,
    });
    if (!course) return null;
    if (idx >= 0) state.courses[idx] = course; else state.courses.push(course);
    commit('courses');
    return course;
  }

  function removeCourse(id) {
    const before = state.courses.length;
    state.courses = state.courses.filter((c) => !sameID(c.id, id));
    if (state.courses.length !== before) commit('courses');
  }

  // ── cloud (W1·B implements; v2-backend §5.9) ──

  // Record kinds and where they live (web): task → tasks · session → sessions · block → blocks
  // (local) · feed → calendar.feeds (google:/icsurl: only) · feedLink → pfKey('purefocus.feedurls.v1')
  // · taskList → calendar.taskLists · template → templates · category → customCategories ·
  // setting → settings (SYNCED_SETTINGS the web models) · calPrefs → calendar.prefs (CAL_PREF_KEYS)
  // · ack → pfKey('purefocus.ack') · course → courses · dismissal → calendar.dismissedAssignments.
  const CREF = () => (typeof CloudRef !== 'undefined' ? CloudRef : null);
  const FEEDURLS_BASE = 'purefocus.feedurls.v1';
  const ACK_BASE = 'purefocus.ack';
  const isSyncedFeed = (f) => !!f && typeof f.id === 'string' && /^(google|icsurl):/i.test(f.id);
  const isLocalBlock = (b) => !!b && (b.source == null || b.source === 'local');

  function readKeyJSON(base) {
    try { const raw = localStorage.getItem(cacheKey(base)); return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
  }
  function writeKeyJSON(base, value) {
    if (value == null) { try { localStorage.removeItem(cacheKey(base)); } catch (_) {} return true; }
    return safeSet(cacheKey(base), JSON.stringify(value));
  }
  function categoryRecordId(name) {
    const R = CREF();
    return R ? R.recordId('category', { name }) : 'c' + String(name).trim().toLowerCase();
  }
  function dismissalRecordId(assignmentID) {
    const R = CREF();
    return R ? R.recordId('dismissal', { id: assignmentID }) : 'd' + String(assignmentID).toLowerCase();
  }
  function syncedSettingKeys() {
    const R = CREF();
    const list = R ? R.C.SYNCED_SETTINGS : [];
    return list.filter((k) => Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, k));
  }
  function calPrefKeys() { const R = CREF(); return R ? R.C.CAL_PREF_KEYS.slice() : []; }

  /* cloudSnapshot({syncLinks}) → [{kind, id, data}] of every syncable LOCAL record (the
     sync core projects it to the wire form). `syncLinks: false` leaves feedLink out (the
     caller then also drops feedLink from its supported kinds, so nothing is tombstoned). */
  function cloudSnapshot(opts) {
    const o = opts || {};
    const out = [];
    const push = (kind, id, data) => { if (id != null && String(id)) out.push({ kind, id: String(id), data }); };
    for (const t of state.tasks) push('task', t.id, t);
    for (const s of state.sessions) push('session', s.id, s);
    for (const b of state.blocks) if (isLocalBlock(b)) push('block', b.id, b);
    const cal = state.calendar;
    for (const f of cal.feeds) if (isSyncedFeed(f)) push('feed', f.id, f);
    {
      const urls = readKeyJSON(FEEDURLS_BASE);
      if (urls && typeof urls === 'object') {
        for (const f of cal.feeds) {
          if (!isSyncedFeed(f)) continue;
          const v = urls[f.id];
          const url = typeof v === 'string' ? v : (v && typeof v.url === 'string' ? v.url : null);
          if (url) push('feedLink', f.id, { id: f.id, url });
        }
      }
    }
    for (const l of cal.taskLists) push('taskList', l.id, l);
    for (const t of state.templates) if (t && t.id != null) push('template', t.id, t);
    for (const name of state.customCategories) {
      if (typeof name === 'string' && name.trim()) push('category', categoryRecordId(name), { name: name.trim() });
    }
    for (const k of syncedSettingKeys()) push('setting', k, { key: k, value: state.settings[k] });
    const prefs = {};
    for (const k of calPrefKeys()) if (k in cal.prefs) prefs[k] = cal.prefs[k];
    push('calPrefs', 'main', prefs);
    const ack = readKeyJSON(ACK_BASE);
    if (ack && typeof ack === 'object') push('ack', 'main', ack);
    for (const c of state.courses) push('course', c.id, c);
    for (const a of cal.dismissedAssignments) push('dismissal', dismissalRecordId(a), { id: a });
    return out;
  }

  /* cloudGet(kind, id) → the LOCAL record of a kind by record id (case-insensitive), or null. */
  function cloudGet(kind, id) {
    const want = String(id).toLowerCase();
    for (const r of cloudSnapshot({ syncLinks: true })) {
      if (r.kind === kind && String(r.id).toLowerCase() === want) return r.data;
    }
    return null;
  }

  function upsertById(list, data, normalize) {
    const v = normalize ? normalize(data) : data;
    if (!v) return list;
    const i = list.findIndex((x) => x && sameID(x.id, v.id));
    if (i >= 0) list[i] = v; else list.push(v);
    return list;
  }
  const removeById = (list, id) => list.filter((x) => !(x && sameID(x.id, id)));

  function cleanRemoteTask(d) {
    if (!isObj(d) || d.id == null) return null;
    const est = clamp(d.estimate == null ? 1 : d.estimate, 1, 12);
    return {
      ...d,
      id: String(d.id),
      title: typeof d.title === 'string' && d.title.trim() ? d.title : 'Untitled task',
      estimate: est,
      completedPomodoros: Math.min(99, Math.max(0, Math.round(Number(d.completedPomodoros) || 0))),
      isDone: !!d.isDone,
      subtasks: Array.isArray(d.subtasks) ? d.subtasks.filter(isObj) : [],
    };
  }
  function cleanRemoteSession(d) {
    if (!isObj(d) || d.id == null || typeof d.start !== 'string' || typeof d.end !== 'string') return null;
    return { ...d, id: String(d.id) };
  }

  /* applyCloud(changes) — changes = [{kind, id, data|null}] (id = record id; data = the
     LOCAL form from CloudRef.fromWire; null = delete). One persist, then 'remote' (payload:
     the kinds touched) and one 'change' with payload 'remote'. Settings only for
     SYNCED_SETTINGS (clamped), calPrefs only CAL_PREF_KEYS, feedLink into feedurls, ack into
     its key. Never celebrates (listeners treat 'remote' as a silent catch-up). Returns the
     number of changes applied. */
  function applyCloud(changes) {
    if (!Array.isArray(changes) || !changes.length) return 0;
    const touched = new Set();
    let n = 0;
    let urls = null, ack;
    const synced = new Set(syncedSettingKeys());
    const prefKeys = new Set(calPrefKeys());
    for (const ch of changes) {
      if (!ch || typeof ch.kind !== 'string' || ch.id == null) continue;
      const id = String(ch.id);
      const d = ch.data == null ? null : ch.data;
      switch (ch.kind) {
        case 'task':
          state.tasks = d ? upsertById(state.tasks, d, cleanRemoteTask) : removeById(state.tasks, id);
          touched.add('tasks'); break;
        case 'session':
          state.sessions = d ? upsertById(state.sessions, d, cleanRemoteSession) : removeById(state.sessions, id);
          touched.add('sessions'); break;
        case 'block':
          state.blocks = d ? upsertById(state.blocks, d, normalizeBlock) : removeById(state.blocks, id);
          touched.add('blocks'); break;
        case 'course':
          state.courses = d ? upsertById(state.courses, d, normalizeCourse) : removeById(state.courses, id);
          touched.add('courses'); break;
        case 'template':
          state.templates = d ? upsertById(state.templates, d, (x) => (isObj(x) && x.id != null ? x : null)) : removeById(state.templates, id);
          touched.add('templates'); break;
        case 'feed': {
          const feeds = state.calendar.feeds.slice();
          state.calendar = normalizeCalendar({ ...state.calendar, feeds: d ? upsertById(feeds, d, normalizeFeed) : removeById(feeds, id) });
          touched.add('calendar'); break;
        }
        case 'taskList': {
          const lists = state.calendar.taskLists.slice();
          state.calendar = normalizeCalendar({ ...state.calendar,
            taskLists: d ? upsertById(lists, d, (x) => (isObj(x) && typeof x.id === 'string' ? x : null)) : removeById(lists, id) });
          touched.add('calendar'); break;
        }
        case 'feedLink': {
          if (urls === null) { const cur = readKeyJSON(FEEDURLS_BASE); urls = cur && typeof cur === 'object' ? { ...cur } : {}; }
          const fid = d && typeof d.id === 'string' ? d.id : null;
          if (d && fid && typeof d.url === 'string' && /^(https?|webcal):\/\//i.test(d.url)) urls[fid] = d.url;
          else if (!d) { for (const k of Object.keys(urls)) if (k.toLowerCase() === id.toLowerCase()) delete urls[k]; }
          touched.add('calendar'); break;
        }
        case 'category': {
          const name = d && typeof d.name === 'string' ? d.name.trim().slice(0, 60) : '';
          if (d && name) {
            const builtIn = ['work', 'study', 'chores'].includes(name.toLowerCase());
            if (!builtIn && !state.customCategories.some((c) => String(c).toLowerCase() === name.toLowerCase())) state.customCategories.push(name);
          } else if (!d) {
            state.customCategories = state.customCategories.filter((c) => categoryRecordId(c) !== id.toLowerCase());
          }
          touched.add('settings'); break;
        }
        case 'setting': {
          const k = d && typeof d.key === 'string' ? d.key : null;
          if (k && synced.has(k)) {
            const next = clampSetting(k, d.value);
            if (JSON.stringify(next) !== JSON.stringify(state.settings[k])) { state.settings[k] = next; touched.add('settings'); }
          }
          break;   // never tombstoned
        }
        case 'calPrefs': {
          if (!d) break;
          const patch = {};
          for (const k of Object.keys(d)) if (prefKeys.has(k)) patch[k] = d[k];
          state.calendar = normalizeCalendar({ ...state.calendar, prefs: { ...state.calendar.prefs, ...patch } });
          touched.add('calendar'); break;
        }
        case 'ack':
          if (d && isObj(d)) ack = d;
          break;
        case 'dismissal': {
          const cur = state.calendar.dismissedAssignments.slice();
          let next = cur;
          if (d && typeof d.id === 'string' && d.id) { if (!cur.some((x) => sameID(x, d.id))) next = cur.concat([d.id]); }
          else if (!d) next = cur.filter((x) => dismissalRecordId(x) !== id.toLowerCase());
          if (next !== cur) state.calendar = normalizeCalendar({ ...state.calendar, dismissedAssignments: next });
          touched.add('calendar'); break;
        }
        default: continue;   // a kind this build doesn't model
      }
      n++;
    }
    if (urls !== null) writeKeyJSON(FEEDURLS_BASE, urls);
    if (ack !== undefined) { writeKeyJSON(ACK_BASE, ack); touched.add('ack'); }
    if (state.activeTaskID && !state.tasks.some((t) => sameID(t.id, state.activeTaskID) && !t.isDone)) {
      const next = state.tasks.find((x) => !x.isDone);
      state.activeTaskID = next ? next.id : null;
    } else if (!state.activeTaskID) {
      const first = state.tasks.find((x) => !x.isDone);
      if (first) state.activeTaskID = first.id;
    }
    if (!n) return 0;
    writeNow();
    emit('remote', Array.from(touched));
    emit('change', 'remote');
    return n;
  }

  /* cloudDedupe(remoteRecords) — first cycle of a JOINING device (v2-backend §5.3): drops
     local templates equal to a remote one (lower(trim(title)) | estimate) and re-points
     sessions/blocks from locally imported duplicates to the cloud's task
     (CloudRef.externalTaskRemap), then deletes the duplicates. One write, 'remote' event.
     Returns {templates, tasks} removed. */
  function cloudDedupe(remote) {
    const R = CREF();
    if (!R || !Array.isArray(remote) || !remote.length) return { templates: 0, tasks: 0 };
    const sig = (t) => String((t && t.title) || '').trim().toLowerCase() + '|' + (t && t.estimate);
    const remoteIds = new Set(remote.filter((r) => r.kind === 'template').map((r) => String(r.id).toLowerCase()));
    const remoteSigs = new Set(remote.filter((r) => r.kind === 'template' && !r.deleted).map((r) => sig(r.data)));
    const before = state.templates.length;
    state.templates = state.templates.filter((t) => remoteIds.has(String(t.id).toLowerCase()) || !remoteSigs.has(sig(t)));
    const droppedTpl = before - state.templates.length;
    const remap = R.externalTaskRemap(state.tasks, remote);
    for (const { from, to } of remap) {
      for (const s of state.sessions) if (sameID(s.taskID, from)) s.taskID = to;
      for (const b of state.blocks) if (sameID(b.taskID, from)) b.taskID = to;
      if (sameID(state.activeTaskID, from)) state.activeTaskID = to;
    }
    if (remap.length) {
      const gone = new Set(remap.map((m) => m.from));
      state.tasks = state.tasks.filter((t) => !gone.has(String(t.id).toLowerCase()));
    }
    if (droppedTpl || remap.length) {
      writeNow();
      emit('remote', ['templates', 'tasks', 'sessions', 'blocks']);
      emit('change', 'remote');
    }
    return { templates: droppedTpl, tasks: remap.length };
  }

  /* mergeFrom(rawStoreJSON, {ackRaw}) — brings another store (the browser's guest data, E27
     "Merge") into the current one by id (SPEC §1.2.9): existing records win, an incoming
     rating fills a missing one; templates by title + estimate; categories by name; acks
     join. One write, 'reset' event (a catch-up, never a live celebration). */
  function mergeFrom(raw, opts) {
    const other = parseStored(raw);
    const add = (list, incoming, key) => {
      const seen = new Set(list.map((x) => String(key(x)).toLowerCase()));
      for (const x of incoming) { const k = String(key(x)).toLowerCase(); if (!seen.has(k)) { list.push(x); seen.add(k); } }
      return list;
    };
    add(state.tasks, other.tasks, (t) => t.id);
    const byId = new Map(state.sessions.map((s) => [String(s.id).toLowerCase(), s]));
    for (const s of other.sessions) {
      const mine = byId.get(String(s.id).toLowerCase());
      if (!mine) { state.sessions.push(s); byId.set(String(s.id).toLowerCase(), s); }
      else if (mine.focusRating == null && s.focusRating != null) mine.focusRating = s.focusRating;
    }
    add(state.templates, other.templates, (t) => String(t.title || '').trim().toLowerCase() + '|' + t.estimate);
    add(state.customCategories, other.customCategories, (c) => String(c).trim());
    add(state.blocks, other.blocks, (b) => b.id);
    add(state.courses, other.courses, (c) => c.id);
    const cal = state.calendar;
    state.calendar = normalizeCalendar({ ...cal, feeds: add(cal.feeds.slice(), other.calendar.feeds, (f) => f.id),
      dismissedAssignments: add(cal.dismissedAssignments.slice(), other.calendar.dismissedAssignments, (x) => x) });
    const R = CREF();
    if (opts && opts.ackRaw && R) {
      try { writeKeyJSON(ACK_BASE, R.mergeAck(readKeyJSON(ACK_BASE), JSON.parse(opts.ackRaw))); } catch (_) {}
    }
    if (!state.activeTaskID) { const first = state.tasks.find((t) => !t.isDone); if (first) state.activeTaskID = first.id; }
    writeNow();
    emit('reset');
    emit('change', 'reset');
    return true;
  }

  /* Another tab of this browser wrote our data key (v2-backend §5.8: with or without cloud).
     Reload, unless this tab has an unsaved edit (ours is written within 120 ms and the other
     tab reloads it in turn). Emits 'remote' (never celebrated: that tab already did). */
  function onStorage(ev) {
    if (!ev || ev.key !== (loadedKey || dataKey()) || ev.newValue == null || saveTimer) return;
    const prevActive = state.activeTaskID;
    state = parseStored(ev.newValue);
    if (!state.activeTaskID || !state.tasks.some((t) => t.id === state.activeTaskID)) {
      const keep = state.tasks.find((t) => t.id === prevActive && !t.isDone) || state.tasks.find((t) => !t.isDone);
      state.activeTaskID = keep ? keep.id : null;
    }
    emit('remote', ['tasks', 'sessions', 'settings', 'templates', 'blocks', 'calendar', 'courses']);
    emit('change', 'remote');
  }

  // ── bulk ──

  function resetAll() {
    const kept = state.migrations;   // one-time conversions stay done for this store
    state = emptyState();
    state.migrations = kept;
    commit('reset');
  }

  /* importData(payload, {keepActive}) replaces each collection present in
     payload (one 'reset' event). keepActive keeps the current active task
     when it still exists (CSV merge); otherwise the first open task. */
  function importData(payload, { keepActive = false } = {}) {
    if (!payload || typeof payload !== 'object') return false;
    const prevActive = state.activeTaskID;
    if (Array.isArray(payload.tasks)) state.tasks = payload.tasks;
    if (Array.isArray(payload.sessions)) state.sessions = payload.sessions;
    if (Array.isArray(payload.templates)) state.templates = payload.templates;
    if (Array.isArray(payload.customCategories)) state.customCategories = payload.customCategories;
    if (payload.settings) state.settings = sanitizeSettings(payload.settings);
    if (Array.isArray(payload.blocks)) state.blocks = payload.blocks.map(normalizeBlock).filter(Boolean);
    if (isObj(payload.calendar)) state.calendar = normalizeCalendar(payload.calendar);
    if (Array.isArray(payload.courses)) state.courses = payload.courses.map(normalizeCourse).filter(Boolean);
    if (payload.migrations) state.migrations = { ...normalizeMigrations(payload.migrations), ...state.migrations };
    const keep = keepActive && state.tasks.find((t) => t.id === prevActive && !t.isDone);
    const first = keep || state.tasks.find((t) => !t.isDone);
    state.activeTaskID = first ? first.id : null;
    commit('reset');
    return true;
  }

  function exportData() {
    return {
      schemaVersion: SCHEMA_VERSION,
      tasks: state.tasks,
      sessions: state.sessions,
      templates: state.templates,
      customCategories: state.customCategories,
      settings: state.settings,
      blocks: state.blocks,
      calendar: state.calendar,
      courses: state.courses,
      migrations: state.migrations,
    };
  }

  function clamp(n, lo, hi) {
    const v = Number(n);
    if (!Number.isFinite(v)) return lo;
    return Math.min(hi, Math.max(lo, Math.round(v)));
  }

  load();

  // A profile switch (W1·B sign-in/out) reloads from the new data key.
  try {
    if (typeof Profile !== 'undefined' && Profile && Profile.on) {
      Profile.on('change', () => { flush(); load(); emit('reset'); emit('change', 'reset'); });
    }
  } catch (_) {}
  try {
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    window.addEventListener('storage', onStorage);
  } catch (_) {}

  return {
    THEMES, ALARMS, AMBIENCES, MODES, CATEGORY_COLORS, DEFAULT_SETTINGS, FACTOR_IDS, INSIGHT_CARDS,
    on, emit, uid, clamp,
    tasks, visibleTasks, activeTask, addTask, updateTask, toggleTaskDone, deleteTask,
    setActiveTask, incrementPomodoro, toggleSubtask, reorderTasks,
    templates, addTemplate, deleteTemplate,
    categories, addCategory, locations, categoryColor,
    sessions, logSession, rateSession, setSessionFactors, updateSessionLocations, repairSessionData,
    settings, setSetting, theme,
    blocks, setBlocks, calendar, updateCalendar, courses, upsertCourse, removeCourse,
    bulk, migrate, migrations, cloudSnapshot, cloudGet, applyCloud, cloudDedupe, mergeFrom,
    resetAll, importData, exportData, persist, flush, safeSet,
    storageAttention: () => storageAttention,
    unreadable: () => unreadable,
  };
})();
